import { beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { config } from '../src/config'
import { db } from '../src/db/client'
import { contactChanges } from '../src/db/schema'
import { redis, rk } from '../src/redis'
import { api, botOutbox, createUser, pressStart, resetState, type TestUser } from './helpers'

beforeAll(resetState)

let chatCounter = 5000
/** What the bot does when a user shares their own contact */
async function sharePhone(phone: string, chatId = String(++chatCounter)) {
  await redis.hset(rk('tg', 'phones'), phone, chatId)
  return chatId
}

let phoneCounter = 1000000
const newPhone = () => `+7999${String(++phoneCounter).padStart(7, '0')}`

const auth = (user: TestUser) => ({ token: user.token })

async function attachPhone(user: TestUser, phone: string) {
  await sharePhone(phone)
  const start = await api('POST', '/v1/auth/phone/attach', { ...auth(user), body: { phone, captcha: 'captcha-disabled' } })
  return api('POST', '/v1/auth/verify-otp', { ...auth(user), body: { phone, otp: start.body.otp, flowToken: start.body.flowToken } })
}

describe('phone through the Telegram bot', () => {
  test('attach a phone shared with the bot', async () => {
    const user = await createUser()
    const methods = await api('GET', '/v1/auth/methods', auth(user))
    expect(methods.body).toEqual({ phone: null, email: `@${user.telegram}`, telegram: user.telegram, hasPassword: true })
    expect((await api('GET', '/v1/auth/phone/config')).body.regions).toContainEqual({ region: 'RU' })

    const phone = newPhone()
    const unshared = await api('POST', '/v1/auth/phone/attach', { ...auth(user), body: { phone, captcha: 'x' } })
    expect(unshared.body.error.code).toBe('PHONE_NOT_SHARED')

    const chatId = await sharePhone(phone)
    // the settings send +7 and the digits; other spellings of the same number work too
    const start = await api('POST', '/v1/auth/phone/attach', { ...auth(user), body: { phone: phone.replace('+7', '8 '), captcha: 'x' } })
    expect(start.body.flowToken).toHaveLength(32)
    expect(start.body).toMatchObject({ delivery: { type: 'push', codeLength: 6 }, retryIn: expect.any(Number) })
    expect((await botOutbox()).at(-1)).toMatchObject({ chatId, text: expect.stringContaining('привязки номера') })

    const resent = await api('POST', '/v1/auth/resend-otp', { ...auth(user), body: { phone, flowToken: start.body.flowToken } })
    expect(resent.status).toBe(429)
    const verified = await api('POST', '/v1/auth/verify-otp', { ...auth(user), body: { phone, otp: start.body.otp, flowToken: start.body.flowToken } })
    expect(verified.body).toEqual({ success: true })
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBe(phone)
    expect((await api('POST', '/v1/auth/phone/sync', { ...auth(user), body: {} })).body).toEqual({ success: true })

    const again = await api('POST', '/v1/auth/phone/attach', { ...auth(user), body: { phone, captcha: 'x' } })
    expect(again.body.error.code).toBe('ALREADY_ATTACHED')
    const other = await createUser()
    expect((await api('POST', '/v1/auth/phone/attach', { ...auth(other), body: { phone, captcha: 'x' } })).body.error.code).toBe('IDENTIFIER_TAKEN')
  })

  test('sign in and recover the password with the phone', async () => {
    const user = await createUser()
    const phone = newPhone()
    expect((await attachPhone(user, phone)).body.success).toBe(true)
    const phoneChat = await redis.hget(rk('tg', 'phones'), phone)

    const typed = `8 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8, 10)}-${phone.slice(10)}`
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: typed, password: user.password } })).body.accessToken).toBeString()
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: phone, password: 'wrong-password-1' } })).body.error.code).toBe('INVALID_CREDENTIALS')

    // with sign-in codes the code goes to the Telegram that shared the number
    config.auth.loginCode = true
    try {
      const start = await api('POST', '/v1/auth/sign-in', { body: { email: phone, password: user.password } })
      expect((await botOutbox()).at(-1)!.chatId).toBe(phoneChat!)
      const done = await api('POST', '/v1/auth/verify-otp', { body: { email: typed, otp: start.body.otp, flowToken: start.body.flowToken } })
      expect(done.body.accessToken).toBeString()
    } finally {
      config.auth.loginCode = false
    }

    const forgot = await api('POST', '/v1/auth/forgot-password', { body: { email: phone } })
    const reset = await api('POST', '/v1/auth/reset-password', {
      body: { email: phone, otp: forgot.body.otp, flowToken: forgot.body.flowToken, newPassword: 'brand-new-password' }
    })
    expect(reset.body).toEqual({ success: true })
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: phone, password: 'brand-new-password' } })).status).toBe(200)
    // registration still needs a Telegram nick
    expect((await api('POST', '/v1/auth/sign-up', { body: { email: newPhone(), password: 'brand-new-password' } })).body.error.code).toBe('INVALID_TELEGRAM')
  })
})

describe('changing the Telegram or the phone', () => {
  test('a new Telegram, proven with a code on the current one', async () => {
    const user = await createUser()
    const oldChat = await redis.hget(rk('tg', 'chats'), user.telegram)
    const next = `next${user.telegram}`.slice(0, 30)
    const change = (email: string) => api('POST', '/v1/auth/email/change', { ...auth(user), body: { email } })

    expect((await change(`@${user.telegram}`)).body.error.code).toBe('SAME_EMAIL')
    expect((await change(`@${next}`)).body.error.code).toBe('TELEGRAM_NOT_STARTED')
    const newChat = await pressStart(next)
    const start = await change(`@${next}`)
    expect(start.body.flowToken).toHaveLength(32)
    expect((await botOutbox()).at(-1)).toMatchObject({ chatId: newChat, text: expect.stringContaining('смены Telegram') })

    const verified = await api('POST', '/v1/auth/verify-otp', { ...auth(user), body: { email: `@${next}`, otp: start.body.otp, flowToken: start.body.flowToken } })
    expect(verified.body).toMatchObject({ mode: 'change', proofs: ['password', 'email_code'], waitDays: 7 })
    const changeToken = verified.body.changeToken
    const confirm = (body: object) => api('POST', '/v1/auth/change/confirm', { ...auth(user), body: { changeToken, ...body } })

    expect((await confirm({ password: 'wrong-password-1' })).body.error.code).toBe('INVALID_PASSWORD')
    expect((await confirm({ code: '123456' })).body.error.code).toBe('NO_PROOF_REQUESTED')
    const phoneProof = await api('POST', '/v1/auth/change/proof', { ...auth(user), body: { changeToken, method: 'phone_code' } })
    expect(phoneProof.body.error.code).toBe('PROOF_NOT_AVAILABLE')
    const proof = await api('POST', '/v1/auth/change/proof', { ...auth(user), body: { changeToken, method: 'email_code' } })
    expect(proof.body).toMatchObject({ sentTo: `@${user.telegram}`, delivery: { type: 'push', codeLength: 6 } })
    expect((await botOutbox()).at(-1)!.chatId).toBe(oldChat!)
    expect((await confirm({ code: proof.body.otp })).body).toEqual({ success: true })

    expect((await api('GET', '/v1/auth/methods', auth(user))).body).toMatchObject({ email: `@${next}`, telegram: next })
    // the old Telegram is told, the new one is the login now
    expect((await botOutbox()).at(-1)).toMatchObject({ chatId: oldChat, text: expect.stringContaining(`@${next}`) })
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: `@${next}`, password: user.password } })).status).toBe(200)
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: `@${user.telegram}`, password: user.password } })).status).toBe(401)
    expect((await confirm({ password: user.password })).body.error.code).toBe('INVALID_CHANGE_TOKEN')
  })

  test('a new phone after the delay, with pending requests and cancelling', async () => {
    const user = await createUser()
    const first = newPhone()
    await attachPhone(user, first)
    const second = newPhone()
    await sharePhone(second)

    const start = await api('POST', '/v1/auth/phone/change', { ...auth(user), body: { phone: second, captcha: 'x' } })
    const verified = await api('POST', '/v1/auth/verify-otp', { ...auth(user), body: { phone: second, otp: start.body.otp, flowToken: start.body.flowToken } })
    expect(verified.body.proofs).toEqual(['password', 'email_code', 'phone_code'])
    const waited = await api('POST', '/v1/auth/change/wait', { ...auth(user), body: { changeToken: verified.body.changeToken } })
    expect(new Date(waited.body.appliesAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000)

    const pending = (await api('GET', '/v1/auth/change/pending', auth(user))).body.requests
    expect(pending).toMatchObject([{ kind: 'phone', newIdentifier: second }])
    expect((await api('POST', '/v1/auth/phone/change', { ...auth(user), body: { phone: newPhone(), captcha: 'x' } })).body.error.code).toBe('CHANGE_PENDING')

    // a session opened after the request cannot cancel it
    const fresh = await api('POST', '/v1/auth/sign-in', { body: { email: user.telegram, password: user.password } })
    expect((await api('DELETE', `/v1/auth/change/pending/${pending[0].id}`, { token: fresh.body.accessToken })).body.error.code).toBe('SESSION_TOO_NEW')

    // the delay is over: the next read applies it
    await db.update(contactChanges).set({ appliesAt: sql`now() - interval '1 second'` }).where(eq(contactChanges.id, pending[0].id))
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBe(second)
    expect((await api('GET', '/v1/auth/change/pending', auth(user))).body.requests).toEqual([])

    // a cancelled request blocks a new one for a day
    const third = newPhone()
    await sharePhone(third)
    const again = await api('POST', '/v1/auth/phone/change', { ...auth(user), body: { phone: third, captcha: 'x' } })
    const token = (await api('POST', '/v1/auth/verify-otp', { ...auth(user), body: { phone: third, otp: again.body.otp, flowToken: again.body.flowToken } })).body.changeToken
    await api('POST', '/v1/auth/change/wait', { ...auth(user), body: { changeToken: token } })
    const id = (await api('GET', '/v1/auth/change/pending', auth(user))).body.requests[0].id
    expect((await api('DELETE', `/v1/auth/change/pending/${id}`, auth(user))).body).toEqual({ success: true })
    const blocked = await api('POST', '/v1/auth/phone/change', { ...auth(user), body: { phone: third, captcha: 'x' } })
    expect(blocked.body.error.code).toBe('CHANGE_COOLDOWN')
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBe(second)
  })
})

describe('sign-in and sign-up by phone', () => {
  const consent = async () => (await api('GET', '/v1/auth/consent?flow=phone_entry')).body
  const start = async (phone: string) => {
    const { contextToken, protocolVersion } = await consent()
    return api('POST', '/v1/auth/phone/start', { body: { phone, captcha: 'captcha-disabled', legal: { protocolVersion, contextToken } } })
  }
  const verify = (phone: string, started: { body: any }) =>
    api('POST', '/v1/auth/verify-otp', { body: { phone, flowToken: started.body.flowToken, otp: started.body.otp } })

  test('the consent links the page about this copy', async () => {
    const body = await consent()
    expect(body).toMatchObject({ protocolVersion: 2, bundle: { flow: 'phone_entry', submitLabel: 'Получить код', documents: [{ slug: 'privacy', url: '/legal/privacy' }] } })
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    // a consent is used once
    const phone = newPhone()
    await sharePhone(phone)
    const legal = { protocolVersion: 2, contextToken: body.contextToken }
    expect((await api('POST', '/v1/auth/phone/start', { body: { phone, legal } })).status).toBe(200)
    expect((await api('POST', '/v1/auth/phone/start', { body: { phone, legal } })).body.error.code).toBe('LEGAL_CONTEXT_EXPIRED')
  })

  test('a new number creates an account for the Telegram that shared it', async () => {
    const phone = newPhone()
    expect((await start(phone)).body.error.code).toBe('PHONE_NOT_SHARED')
    const chatId = await sharePhone(phone)
    const username = `phone${phoneCounter}`
    await redis.hset(rk('tg', 'usernames'), chatId, username)

    const started = await start(phone)
    expect(started.body).toMatchObject({ delivery: { type: 'push', codeLength: 6 } })
    expect(started.body.flowToken).toHaveLength(32)
    expect((await botOutbox()).at(-1)).toMatchObject({ chatId, text: expect.stringContaining('по номеру телефона') })
    const signedUp = await verify(phone, started)
    expect(signedUp.body.accessToken).toBeString()
    expect(signedUp.cookies.refresh_token).toMatch(/^[0-9a-f]{64}$/)

    const token = signedUp.body.accessToken
    expect((await api('GET', '/v1/auth/methods', { token })).body).toEqual({ phone, email: `@${username}`, telegram: username, hasPassword: false })
    // no password yet: the password form does not let in, setting one does
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: phone, password: 'anything-1' } })).status).toBe(401)
    expect((await api('POST', '/v1/auth/set-password', { token, body: { password: 'first-pass-1' } })).body).toEqual({ success: true })
    expect((await api('POST', '/v1/auth/set-password', { token, body: { password: 'second-pass-1' } })).body.error.code).toBe('PASSWORD_ALREADY_SET')

    // the next time the password is asked after the code
    const again = await verify(phone, await start(phone))
    // read before toMatchObject: its asymmetric matchers get written into the received object
    const flowToken = again.body.flowToken
    expect(again.body).toMatchObject({ step: 'password', flowToken: expect.any(String) })
    const password = (value: string) => api('POST', '/v1/auth/phone/password', { body: { phone, flowToken, password: value } })
    expect((await password('wrong-pass-1')).body.error.code).toBe('INVALID_CREDENTIALS')
    expect((await password('first-pass-1')).body.accessToken).toBeString()
  })

  test('an existing Telegram account gets the number; the password can be reset by phone', async () => {
    const user = await createUser()
    const phone = newPhone()
    const chatId = await sharePhone(phone)
    await redis.hset(rk('tg', 'usernames'), chatId, user.telegram)

    const verified = await verify(phone, await start(phone))
    expect(verified.body.step).toBe('password')
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBe(phone)

    const reset = await api('POST', '/v1/auth/phone/reset-password', { body: { phone, flowToken: verified.body.flowToken, newPassword: 'reset-by-phone-1' } })
    expect(reset.body.accessToken).toBeString()
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: user.telegram, password: 'reset-by-phone-1' } })).status).toBe(200)
  })

  test('without a Telegram username there is nothing to name the account after', async () => {
    const phone = newPhone()
    await sharePhone(phone)
    expect((await verify(phone, await start(phone))).body.error.code).toBe('TELEGRAM_USERNAME_REQUIRED')
  })
})

describe('legal pages', () => {
  test('the privacy page is the page about this copy', async () => {
    const list = (await api('GET', '/legal-documents?scope=social')).body.documents
    expect(list).toMatchObject([{ slug: 'privacy', title: 'Политика конфиденциальности', url: '/legal/privacy' }])
    const document = (await api('GET', '/legal-documents/social/privacy')).body.document
    expect(document).toMatchObject({ version: '1', documentDate: '2026-10-06', current: true })
    expect(document.blocks.map((b: any) => b.text).filter(Boolean)).toContain('6. Сведения о разработке')
    expect((await api('GET', '/legal-documents/social/privacy/versions')).body.versions).toMatchObject([{ version: '1', current: true }])
    expect((await api('GET', '/legal-documents/social/privacy/versions/1')).body.document.slug).toBe('privacy')
    expect((await api('GET', '/legal-documents/social/terms')).status).toBe(404)
  })
})

describe('a number shared with the bot (/phone)', () => {
  /** What the bot stores when the user shares their own contact */
  async function shareFromChat(chatId: string, phone: string) {
    await redis.hset(rk('tg', 'phones'), phone, chatId)
    await redis.hset(rk('tg', 'chatphones'), chatId, phone)
  }

  test('attaches to the account of that Telegram without a code', async () => {
    const user = await createUser()
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBeNull()
    const chatId = (await redis.hget(rk('tg', 'chats'), user.telegram))!
    const phone = newPhone()
    await shareFromChat(chatId, phone)
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBe(phone)

    // signing in by the number works straight away for another account too
    const other = await createUser()
    const otherPhone = newPhone()
    await shareFromChat((await redis.hget(rk('tg', 'chats'), other.telegram))!, otherPhone)
    expect((await api('POST', '/v1/auth/sign-in', { body: { email: otherPhone, password: other.password } })).status).toBe(200)
  })

  test('a number taken by another account is not moved', async () => {
    const owner = await createUser()
    const phone = newPhone()
    await attachPhone(owner, phone)
    const user = await createUser()
    await shareFromChat((await redis.hget(rk('tg', 'chats'), user.telegram))!, phone)
    expect((await api('GET', '/v1/auth/methods', auth(user))).body.phone).toBeNull()
    expect((await api('GET', '/v1/auth/methods', auth(owner))).body.phone).toBe(phone)
  })
})
