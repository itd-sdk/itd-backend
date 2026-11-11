import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import type { Cookie } from 'elysia'
import { config } from '../../config'
import { db } from '../../db/client'
import { accounts } from '../../db/schema'
import { ApiError, badRequest, conflict } from '../../lib/errors'
import { randomToken } from '../../lib/crypto'
import { hashPassword, isValidPassword, verifyPassword } from '../../lib/password'
import { findChatUsername, normalizePhone, requirePhoneChat } from '../../lib/telegram'
import { contextPlugin } from '../../plugins/context'
import { redis, rk } from '../../redis'
import { enforceActionLimit } from '../../services/rate-limit'
import {
  assertNotBanned,
  type ClientContext,
  createSession,
  describeClient,
  dropFlow,
  type Flow,
  findAccount,
  findAccountByPhone,
  findAccountByTelegram,
  liftExpiredBan,
  loadFlow,
  revokeAllSessions,
  saveFlow,
  setAuthCookies,
  startFlow
} from './service'

/*
 * Sign-in and sign-up by phone (the web client's «Регистрация» and «Войти по номеру телефона»).
 * The number must have been shared with the Telegram bot; the code goes to that Telegram. After the code:
 *   - the account with this phone signs in (its password is asked when it has one: step "password");
 *   - otherwise the account of that Telegram username gets the phone and signs in the same way;
 *   - otherwise a new account is created for that Telegram, without a password (it can be set in the settings).
 */

const CONSENT_TTL_SECONDS = 10 * 60
const PROTOCOL_VERSION = 2
const DELIVERY = { type: 'push', channel: 'push', codeLength: 6 } as const
const consentKey = (token: string) => rk('consent', token)
type Cookies = Record<string, Cookie<unknown>>

/** The consent line under the phone form: it links the «О проекте» page served by the legal module */
function consentBundle(flow: string) {
  return {
    flow,
    submitLabel: 'Получить код',
    text: [
      { text: 'Нажимая «Получить код», вы подтверждаете, что прочитали ' },
      { text: 'информацию о проекте', document: 'privacy' },
      { text: '. Это неофициальная копия ИТД для тестов.' }
    ],
    documents: [{ slug: 'privacy', title: 'Политика конфиденциальности', url: '/legal/privacy' }]
  }
}

async function signIn(account: { id: string; roles: string[] | null }, client: ClientContext, cookie: Cookies) {
  const { accessToken, refreshToken } = await createSession(account as Parameters<typeof createSession>[0], client)
  setAuthCookies(cookie, refreshToken)
  return { accessToken, expiresIn: config.auth.accessTokenTtl }
}

/** The code was right: find or create the account, then sign in or ask for its password */
export async function verifyPhoneEntry(flowToken: string, flow: Flow, client: ClientContext, cookie: Cookies) {
  const phone = flow.phone!
  let account = await findAccountByPhone(phone)
  if (!account) {
    const username = await findChatUsername(flow.chatId!)
    const byTelegram = username ? await findAccountByTelegram(username) : null
    if (byTelegram && byTelegram.phone) throw conflict('Этот Telegram уже привязан к аккаунту с другим номером. Войдите по нику', 'IDENTIFIER_TAKEN')
    if (byTelegram) {
      // the same person: the code went to the Telegram of that account
      await db.update(accounts).set({ phone, updatedAt: new Date() }).where(eq(accounts.id, byTelegram.id))
      account = { ...byTelegram, phone }
    } else {
      if (!username) {
        throw badRequest('Задайте имя пользователя в настройках Telegram, отправьте боту /start и попробуйте снова', 'TELEGRAM_USERNAME_REQUIRED')
      }
      ;[account] = await db
        .insert(accounts)
        .values({ telegram: username, telegramChatId: flow.chatId, phone, passwordHash: '', verifiedAt: new Date() })
        .returning()
    }
  }
  await liftExpiredBan(account!)
  assertNotBanned(account!)
  if (account!.passwordHash) {
    Object.assign(flow, { verified: true, accountId: account!.id, attempts: 0 })
    await saveFlow(flowToken, flow)
    return { step: 'password', flowToken }
  }
  await dropFlow(flowToken)
  return signIn(account!, client, cookie)
}

async function loadVerified(flowToken: string, phone: string) {
  const flow = await loadFlow(flowToken, phone)
  if (flow.purpose !== 'phone_entry' || !flow.verified || !flow.accountId) throw badRequest('Session expired. Start again', 'INVALID_FLOW_TOKEN')
  const account = await findAccount(flow.accountId)
  if (!account) throw badRequest('Session expired. Start again', 'INVALID_FLOW_TOKEN')
  return { flow, account }
}

const PhoneFlow = { phone: t.String({ maxLength: 32 }), flowToken: t.String({ maxLength: 128 }) }

// openitd has no captcha: the client's captcha frame gets a page that answers with a token at once
const CAPTCHA_WIDGET = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Проверка</title></head>
<body style="margin:0;height:65px;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#8e8e93">Проверка не нужна
<script>
var send = function (message) { parent.postMessage(message, location.origin) }
send({ type: 'size', height: 65 })
send({ type: 'token', token: 'captcha-disabled' })
</script></body></html>`

// mounted inside authModule, which adds the /v1/auth prefix
export const phoneEntryModule = new Elysia({ tags: ['Auth'] })
  .use(contextPlugin)
  .derive(({ ip, country, deviceId, userAgent }) => ({ phoneClient: { ip, country, deviceId, userAgent } }))

  .get('/captcha/page', () => ({ provider: 'openitd', url: '/api/v1/auth/captcha/widget' }), {
    detail: { summary: 'Captcha frame for the web client (openitd: none, the frame answers at once)' }
  })
  .get('/captcha/widget', () => new Response(CAPTCHA_WIDGET, { headers: { 'content-type': 'text/html; charset=utf-8' } }), {
    detail: { hide: true }
  })

  .get(
    '/consent',
    async ({ query }) => {
      const contextToken = randomToken(24)
      await redis.set(consentKey(contextToken), query.flow, 'EX', CONSENT_TTL_SECONDS)
      return { protocolVersion: PROTOCOL_VERSION, contextToken, expiresAt: Date.now() + CONSENT_TTL_SECONDS * 1000, bundle: consentBundle(query.flow) }
    },
    { query: t.Object({ flow: t.String({ maxLength: 64 }) }), detail: { summary: 'Consent text shown under the phone form' } }
  )

  .post(
    '/phone/start',
    async ({ body, phoneClient }) => {
      const phone = normalizePhone(body.phone)
      if (!phone) throw badRequest('Проверьте номер телефона', 'INVALID_PHONE')
      // the consent the user saw: one use, not expired
      const consented = body.legal?.contextToken ? await redis.getdel(consentKey(body.legal.contextToken)) : null
      if (!consented) throw badRequest('Документы обновились', 'LEGAL_CONTEXT_EXPIRED')
      await enforceActionLimit('otp', phoneClient.ip)
      const chatId = await requirePhoneChat(phone)
      const existing = await findAccountByPhone(phone)
      const { flowToken, otp } = await startFlow({
        purpose: 'phone_entry',
        telegram: existing?.telegram ?? '',
        phone,
        chatId,
        device: describeClient(phoneClient),
        accountId: existing?.id ?? null,
        passwordHash: null
      })
      return {
        flowToken,
        delivery: DELIVERY,
        retryIn: config.auth.otpResendCooldown,
        expiresIn: config.auth.otpTtl,
        ...(config.auth.exposeOtp ? { otp } : {})
      }
    },
    {
      body: t.Object({
        phone: t.String({ maxLength: 32 }),
        captcha: t.Optional(t.Unknown({ description: 'Captcha answer, ignored (openitd has no captcha)' })),
        legal: t.Optional(t.Object({ protocolVersion: t.Optional(t.Integer()), contextToken: t.String({ maxLength: 128 }) }))
      }),
      detail: { summary: 'Sign in or up by phone: the code goes to the Telegram that shared the number' }
    }
  )

  .post(
    '/phone/password',
    async ({ body, phoneClient, cookie }) => {
      const { flow, account } = await loadVerified(body.flowToken, body.phone)
      if (flow.attempts >= config.auth.otpMaxAttempts) {
        await dropFlow(body.flowToken)
        throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Слишком много попыток. Попробуйте позже')
      }
      if (!(await verifyPassword(body.password, account.passwordHash))) {
        flow.attempts++
        await saveFlow(body.flowToken, flow)
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный пароль')
      }
      await dropFlow(body.flowToken)
      return signIn(account, phoneClient, cookie)
    },
    { body: t.Object({ ...PhoneFlow, password: t.String({ maxLength: 256 }) }), detail: { summary: 'The password step of the phone sign-in' } }
  )

  .post(
    '/phone/reset-password',
    async ({ body, phoneClient, cookie }) => {
      const { account } = await loadVerified(body.flowToken, body.phone)
      if (!isValidPassword(body.newPassword)) throw badRequest('Password must be 8-128 printable ASCII characters', 'INVALID_PASSWORD')
      await db
        .update(accounts)
        .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
      await revokeAllSessions(account.id, { reason: 'password_reset' })
      await dropFlow(body.flowToken)
      return signIn(account, phoneClient, cookie)
    },
    {
      body: t.Object({ ...PhoneFlow, newPassword: t.String({ maxLength: 256 }) }),
      detail: { summary: 'A new password after the phone code (the code already proved the phone)' }
    }
  )
