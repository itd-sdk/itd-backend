import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { db } from '../../db/client'
import { accounts, contactChanges, sessions } from '../../db/schema'
import { ApiError, badRequest, conflict, notFound } from '../../lib/errors'
import { randomOtp, randomToken, safeEqual, sha256 } from '../../lib/crypto'
import { hashPassword, isValidPassword, verifyPassword } from '../../lib/password'
import {
  assertTelegram,
  findPhoneChat,
  findTelegramChat,
  normalizePhone,
  normalizeTelegram,
  otpMessage,
  requirePhoneChat,
  requireTelegramChat,
  sendTelegram
} from '../../lib/telegram'
import { logger } from '../../lib/logger'
import { authPlugin } from '../../plugins/auth'
import { contextPlugin } from '../../plugins/context'
import { redis, rk } from '../../redis'
import { enforceActionLimit } from '../../services/rate-limit'
import { describeClient, dropFlow, type Flow, findAccount, findAccountByPhone, findAccountByTelegram, startFlow } from './service'

/*
 * Ways to sign in, as the web client's «Безопасность» settings show them: the phone, the "email" (here the
 * Telegram username, the main login) and the password. Codes always go through the Telegram bot: a phone is
 * proven by the Telegram account that shared it with the bot («Поделиться номером»).
 *
 * A change of the phone or the Telegram is confirmed twice: a code on the new one, then a proof that the owner
 * asked for it (the password, a code on the current Telegram or phone) or a WAIT_DAYS delay.
 */

const WAIT_DAYS = 7
const COOLDOWN_MS = 24 * 60 * 60_000
const CHANGE_TTL_SECONDS = 30 * 60
// the web client accepts sms, calls and "push"; a Telegram message is the push here
const DELIVERY = { type: 'push', channel: 'push', codeLength: 6 } as const
// phone formats the web client can enter
const REGIONS = ['ru', 'by', 'kz', 'am', 'az', 'kg', 'md', 'tj', 'tm', 'uz', 'ge', 'ua']

type Kind = 'telegram' | 'phone'
type Proof = 'password' | 'email_code' | 'phone_code'
type Change = {
  accountId: string
  kind: Kind
  value: string
  chatId: string
  proofs: Proof[]
  proofMethod?: Proof | null
  proofHash?: string | null
  proofAttempts?: number
  proofSentAt?: number
}

const changeKey = (token: string) => rk('contact-change', token)
const telegramLabel = (username: string) => `@${username}`
// the client calls the Telegram "email": kinds and errors keep the client's names
const clientKind = (kind: Kind) => (kind === 'telegram' ? 'email' : 'phone')

export const isContactFlow = (flow: Flow) => flow.purpose === 'attach_phone' || flow.purpose === 'change_phone' || flow.purpose === 'change_telegram'

/** Delivery info the client expects with a phone code */
export function contactDelivery(flow: Flow) {
  if (!isContactFlow(flow) && flow.purpose !== 'phone_entry') return {}
  return { delivery: DELIVERY, retryIn: Math.max(0, Math.ceil(config.auth.otpResendCooldown - (Date.now() - flow.sentAt) / 1000)) }
}

const requireLoaded = async (accountId: string) => {
  const account = await findAccount(accountId)
  if (!account) throw notFound('Account not found', 'NOT_FOUND')
  return account
}

async function assertFree(kind: Kind, value: string, accountId: string) {
  const owner = kind === 'telegram' ? await findAccountByTelegram(value) : await findAccountByPhone(value)
  if (owner && owner.id !== accountId) {
    throw conflict(kind === 'telegram' ? 'Этот Telegram уже привязан к другому аккаунту' : 'Этот номер уже привязан к другому аккаунту', 'IDENTIFIER_TAKEN')
  }
}

/** A new change waits for the previous one, and for a day after a cancelled one */
async function assertCanChange(accountId: string, kind: Kind) {
  const [open] = await db
    .select({ id: contactChanges.id })
    .from(contactChanges)
    .where(and(eq(contactChanges.accountId, accountId), isNull(contactChanges.canceledAt), isNull(contactChanges.appliedAt)))
    .limit(1)
  if (open) throw conflict('Смена уже ждёт подтверждения', 'CHANGE_PENDING')
  const [recent] = await db
    .select({ id: contactChanges.id })
    .from(contactChanges)
    .where(and(eq(contactChanges.accountId, accountId), eq(contactChanges.kind, kind), gt(contactChanges.canceledAt, new Date(Date.now() - COOLDOWN_MS))))
    .limit(1)
  if (recent) throw new ApiError(429, 'CHANGE_COOLDOWN', 'Новую смену можно начать через сутки после отмены')
}

async function applyChange(accountId: string, kind: Kind, value: string, chatId: string | null) {
  await assertFree(kind, value, accountId)
  const before = await requireLoaded(accountId)
  await db
    .update(accounts)
    .set(kind === 'telegram' ? { telegram: value, telegramChatId: chatId, updatedAt: new Date() } : { phone: value, updatedAt: new Date() })
    .where(eq(accounts.id, accountId))
  // the previous Telegram learns about it: a change it did not ask for is visible at once
  if (kind === 'telegram' && before.telegramChatId && before.telegramChatId !== chatId) {
    await sendTelegram(before.telegramChatId, `Telegram вашего аккаунта ИТД сменён на ${telegramLabel(value)}. Если это были не вы, войдите и смените пароль.`, 7 * 86400)
  }
}

/** Applies changes whose delay is over (the job, and on read so the settings never show a stale state) */
export async function applyDueChanges(accountId?: string) {
  const due = await db
    .select()
    .from(contactChanges)
    .where(
      and(
        isNull(contactChanges.canceledAt),
        isNull(contactChanges.appliedAt),
        lte(contactChanges.appliesAt, new Date()),
        accountId ? eq(contactChanges.accountId, accountId) : undefined
      )
    )
  for (const change of due) {
    try {
      await applyChange(change.accountId, change.kind, change.newValue, change.newChatId)
      await db.update(contactChanges).set({ appliedAt: new Date() }).where(eq(contactChanges.id, change.id))
    } catch (error) {
      // taken in the meantime: the request is dropped
      logger.warn('contact change not applied', { id: change.id, error: (error as Error).message })
      await db.update(contactChanges).set({ canceledAt: new Date() }).where(eq(contactChanges.id, change.id))
    }
  }
  return due.length
}

async function loadChange(token: string, accountId: string) {
  const raw = await redis.get(changeKey(token))
  const change = raw ? (JSON.parse(raw) as Change) : null
  if (!change || change.accountId !== accountId) throw badRequest('Время на подтверждение вышло. Начните смену заново', 'INVALID_CHANGE_TOKEN')
  return change
}

async function saveChange(token: string, change: Change) {
  const ttl = await redis.ttl(changeKey(token))
  await redis.set(changeKey(token), JSON.stringify(change), 'EX', Math.max(ttl, 1))
}

/** The code on the new phone / Telegram is right: attach it, or open the proof step of a change */
export async function verifyContactFlow(flowToken: string, flow: Flow) {
  const account = await requireLoaded(flow.accountId!)
  await dropFlow(flowToken)
  if (flow.purpose === 'attach_phone') {
    await assertFree('phone', flow.phone!, account.id)
    await db.update(accounts).set({ phone: flow.phone!, updatedAt: new Date() }).where(eq(accounts.id, account.id))
    return { success: true }
  }
  const kind: Kind = flow.purpose === 'change_phone' ? 'phone' : 'telegram'
  const proofs: Proof[] = [...(account.passwordHash ? (['password'] as const) : []), 'email_code', ...(account.phone ? (['phone_code'] as const) : [])]
  const changeToken = randomToken(24)
  const change: Change = { accountId: account.id, kind, value: kind === 'phone' ? flow.phone! : flow.newTelegram!, chatId: flow.chatId!, proofs }
  await redis.set(changeKey(changeToken), JSON.stringify(change), 'EX', CHANGE_TTL_SECONDS)
  return { success: true, mode: 'change', changeToken, proofs, waitDays: WAIT_DAYS }
}

const flowAnswer = (flowToken: string, otp: string) => ({
  flowToken,
  delivery: DELIVERY,
  retryIn: config.auth.otpResendCooldown,
  expiresIn: config.auth.otpTtl,
  ...(config.auth.exposeOtp ? { otp } : {})
})

function phoneOf(value: string | undefined) {
  const phone = normalizePhone(value ?? '')
  if (!phone) throw badRequest('Проверьте номер телефона', 'INVALID_PHONE')
  return phone
}

const ChangeToken = t.String({ maxLength: 64 })

// mounted inside authModule, which adds the /v1/auth prefix
export const contactsModule = new Elysia({ tags: ['Auth'] })
  .use(contextPlugin)
  .use(authPlugin)

  .get('/phone/config', () => ({ regions: REGIONS.map((region) => ({ region: region.toUpperCase() })) }), {
    detail: { summary: 'Phone regions the settings accept' }
  })

  .get(
    '/methods',
    async ({ auth }) => {
      await applyDueChanges(auth.accountId)
      const account = await requireLoaded(auth.accountId)
      return { phone: account.phone, email: telegramLabel(account.telegram), telegram: account.telegram, hasPassword: !!account.passwordHash }
    },
    { account: true, detail: { summary: 'Ways to sign in: phone, Telegram (as `email`) and password' } }
  )

  .post(
    '/phone/attach',
    async ({ body, auth, userAgent, ip }) => {
      const phone = phoneOf(body.phone)
      await enforceActionLimit('otp', auth.accountId)
      const account = await requireLoaded(auth.accountId)
      if (account.phone) throw conflict('К аккаунту уже привязан номер', 'ALREADY_ATTACHED')
      await assertFree('phone', phone, account.id)
      const chatId = await requirePhoneChat(phone)
      const device = describeClient({ ip, country: null, deviceId: null, userAgent })
      const { flowToken, otp } = await startFlow({ purpose: 'attach_phone', telegram: account.telegram, phone, chatId, device, accountId: account.id, passwordHash: null })
      return flowAnswer(flowToken, otp)
    },
    {
      account: true,
      body: t.Object({ phone: t.String({ maxLength: 32 }), captcha: t.Optional(t.String({ maxLength: 4096 })) }),
      detail: { summary: 'Attach a phone; the code goes to the Telegram that shared the number with the bot' }
    }
  )

  // the official server re-checks the profile here; a phone attached in openitd needs nothing more
  .post('/phone/sync', () => ({ success: true }), { account: true })

  .post(
    '/phone/change',
    async ({ body, auth, userAgent, ip }) => {
      const phone = phoneOf(body.phone)
      await enforceActionLimit('otp', auth.accountId)
      const account = await requireLoaded(auth.accountId)
      if (!account.phone) throw badRequest('Сначала привяжите номер', 'NOT_ATTACHED')
      if (account.phone === phone) throw badRequest('Это ваш текущий номер', 'SAME_PHONE')
      await assertFree('phone', phone, account.id)
      await assertCanChange(account.id, 'phone')
      const chatId = await requirePhoneChat(phone)
      const device = describeClient({ ip, country: null, deviceId: null, userAgent })
      const { flowToken, otp } = await startFlow({ purpose: 'change_phone', telegram: account.telegram, phone, chatId, device, accountId: account.id, passwordHash: null })
      return flowAnswer(flowToken, otp)
    },
    {
      account: true,
      body: t.Object({ phone: t.String({ maxLength: 32 }), captcha: t.Optional(t.String({ maxLength: 4096 })) }),
      detail: { summary: 'Start a phone change (code to the new number’s Telegram)' }
    }
  )

  .post(
    '/email/change',
    async ({ body, auth, userAgent, ip }) => {
      const telegram = normalizeTelegram(body.email)
      assertTelegram(telegram)
      await enforceActionLimit('otp', auth.accountId)
      const account = await requireLoaded(auth.accountId)
      if (account.telegram === telegram) throw badRequest('Это ваш текущий Telegram', 'SAME_EMAIL')
      if (await findAccountByTelegram(telegram)) throw conflict('Этот Telegram уже привязан к другому аккаунту', 'EMAIL_TAKEN')
      await assertCanChange(account.id, 'telegram')
      const chatId = await requireTelegramChat(telegram)
      const device = describeClient({ ip, country: null, deviceId: null, userAgent })
      const { flowToken, otp } = await startFlow({
        purpose: 'change_telegram',
        telegram: account.telegram,
        newTelegram: telegram,
        chatId,
        device,
        accountId: account.id,
        passwordHash: null
      })
      return { flowToken, expiresIn: config.auth.otpTtl, ...(config.auth.exposeOtp ? { otp } : {}) }
    },
    {
      account: true,
      body: t.Object({ email: t.String({ maxLength: 64, description: 'The new Telegram username (the client calls it email)' }) }),
      detail: { summary: 'Start a Telegram change (code to the new Telegram)' }
    }
  )

  // every openitd account has a Telegram from the start
  .post('/email/attach', () => {
    throw conflict('К аккаунту уже привязан Telegram', 'ALREADY_ATTACHED')
  }, { account: true })

  // accounts created by phone start without a password
  .post(
    '/set-password',
    async ({ body, auth }) => {
      const account = await requireLoaded(auth.accountId)
      if (account.passwordHash) throw conflict('Пароль уже создан, его можно сменить', 'PASSWORD_ALREADY_SET')
      if (!isValidPassword(body.password)) throw badRequest('Password must be 8-128 printable ASCII characters', 'INVALID_PASSWORD')
      await db
        .update(accounts)
        .set({ passwordHash: await hashPassword(body.password), passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
      return { success: true }
    },
    { account: true, body: t.Object({ password: t.String({ maxLength: 256 }) }), detail: { summary: 'Create the first password' } }
  )

  .post(
    '/change/proof',
    async ({ body, auth }) => {
      const change = await loadChange(body.changeToken, auth.accountId)
      const method = body.method as Proof
      if (!change.proofs.includes(method) || method === 'password') throw badRequest('Этот способ сейчас недоступен', 'PROOF_NOT_AVAILABLE')
      if (change.proofSentAt && Date.now() - change.proofSentAt < config.auth.otpResendCooldown * 1000) {
        throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Подождите перед повторной отправкой кода', {
          retryIn: Math.ceil(config.auth.otpResendCooldown - (Date.now() - change.proofSentAt) / 1000)
        })
      }
      const account = await requireLoaded(auth.accountId)
      const chatId =
        method === 'email_code'
          ? (account.telegramChatId ?? (await findTelegramChat(account.telegram)))
          : account.phone
            ? await findPhoneChat(account.phone)
            : null
      if (!chatId) throw badRequest('Этот способ сейчас недоступен', 'PROOF_NOT_AVAILABLE')
      const otp = randomOtp()
      Object.assign(change, { proofMethod: method, proofHash: sha256(`${body.changeToken}:${otp}`), proofAttempts: 0, proofSentAt: Date.now() })
      await saveChange(body.changeToken, change)
      await sendTelegram(chatId, otpMessage(otp, 'proof'), config.auth.otpTtl)
      return {
        sentTo: method === 'email_code' ? telegramLabel(account.telegram) : account.phone,
        delivery: DELIVERY,
        ...(config.auth.exposeOtp ? { otp } : {})
      }
    },
    {
      account: true,
      body: t.Object({ changeToken: ChangeToken, method: t.String({ maxLength: 32 }) }),
      detail: { summary: 'Send a code to the current Telegram or phone to prove the change' }
    }
  )

  .post(
    '/change/confirm',
    async ({ body, auth }) => {
      const change = await loadChange(body.changeToken, auth.accountId)
      const account = await requireLoaded(auth.accountId)
      if (body.password !== undefined) {
        if (!(await verifyPassword(body.password, account.passwordHash))) throw badRequest('Неверный пароль', 'INVALID_PASSWORD')
      } else {
        if (!change.proofHash) throw badRequest('Сначала запросите код', 'NO_PROOF_REQUESTED')
        if ((change.proofAttempts ?? 0) >= config.auth.otpMaxAttempts) {
          await redis.del(changeKey(body.changeToken))
          throw badRequest('Время на подтверждение вышло. Начните смену заново', 'INVALID_CHANGE_TOKEN')
        }
        if (!body.code || !safeEqual(sha256(`${body.changeToken}:${body.code}`), change.proofHash)) {
          change.proofAttempts = (change.proofAttempts ?? 0) + 1
          await saveChange(body.changeToken, change)
          throw badRequest('Неверный код', 'OTP_INVALID')
        }
      }
      await redis.del(changeKey(body.changeToken))
      await applyChange(account.id, change.kind, change.value, change.kind === 'telegram' ? change.chatId : account.telegramChatId)
      return { success: true }
    },
    {
      account: true,
      body: t.Object({ changeToken: ChangeToken, password: t.Optional(t.String({ maxLength: 256 })), code: t.Optional(t.String({ maxLength: 16 })) }),
      detail: { summary: 'Prove the change with the password or the code, and apply it now' }
    }
  )

  .post(
    '/change/wait',
    async ({ body, auth }) => {
      const change = await loadChange(body.changeToken, auth.accountId)
      const account = await requireLoaded(auth.accountId)
      await assertCanChange(account.id, change.kind)
      const appliesAt = new Date(Date.now() + WAIT_DAYS * 86400_000)
      await db.insert(contactChanges).values({
        accountId: account.id,
        kind: change.kind,
        newValue: change.value,
        newChatId: change.kind === 'telegram' ? change.chatId : null,
        appliesAt
      })
      await redis.del(changeKey(body.changeToken))
      if (account.telegramChatId) {
        const what = change.kind === 'telegram' ? `Telegram на ${telegramLabel(change.value)}` : `номер на ${change.value}`
        await sendTelegram(
          account.telegramChatId,
          `Запрошена смена: ${what}. Она применится через ${WAIT_DAYS} дней. Если это были не вы, отмените её в настройках («Безопасность») и смените пароль.`,
          WAIT_DAYS * 86400
        )
      }
      return { success: true, appliesAt: appliesAt.toISOString() }
    },
    {
      account: true,
      body: t.Object({ changeToken: ChangeToken }),
      detail: { summary: `Apply the change after ${WAIT_DAYS} days without a proof` }
    }
  )

  .get(
    '/change/pending',
    async ({ auth }) => {
      await applyDueChanges(auth.accountId)
      const rows = await db
        .select()
        .from(contactChanges)
        .where(and(eq(contactChanges.accountId, auth.accountId), isNull(contactChanges.canceledAt), isNull(contactChanges.appliedAt)))
        .orderBy(desc(contactChanges.createdAt))
      return {
        requests: rows.map((row) => ({
          id: row.id,
          kind: clientKind(row.kind),
          newIdentifier: row.kind === 'telegram' ? telegramLabel(row.newValue) : row.newValue,
          appliesAt: row.appliesAt.toISOString(),
          createdAt: row.createdAt.toISOString()
        }))
      }
    },
    { account: true, detail: { summary: 'Changes waiting for their delay' } }
  )

  .delete(
    '/change/pending/:id',
    async ({ params, auth }) => {
      const [row] = await db
        .select()
        .from(contactChanges)
        .where(and(eq(contactChanges.id, params.id), eq(contactChanges.accountId, auth.accountId), isNull(contactChanges.canceledAt), isNull(contactChanges.appliedAt)))
        .limit(1)
      if (!row) throw notFound('Заявка уже не действует', 'NOT_FOUND')
      // a session opened after the request (possibly by whoever made it) cannot cancel it
      const [session] = await db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, auth.sessionId)).limit(1)
      if (!session || session.createdAt.getTime() > row.createdAt.getTime()) {
        throw new ApiError(403, 'SESSION_TOO_NEW', 'Отменить заявку можно с устройства, на котором вход выполнен раньше, чем её подали')
      }
      await db.update(contactChanges).set({ canceledAt: new Date() }).where(eq(contactChanges.id, row.id))
      return { success: true }
    },
    { account: true, params: t.Object({ id: t.String({ format: 'uuid' }) }), detail: { summary: 'Cancel a waiting change' } }
  )

