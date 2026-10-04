import { beforeAll, describe, expect, test } from 'bun:test'
import { signAccessToken } from '../src/lib/jwt'
import { config } from '../src/config'
import { api, botOutbox, createUser, pressStart, resetState } from './helpers'

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36'
const PASSWORD = 'correct-horse-battery'

beforeAll(resetState)

describe('sign-up', () => {
  test('requires a code from the Telegram bot', async () => {
    const early = await api('POST', '/v1/auth/sign-up', { body: { telegram: '@New_User', password: PASSWORD } })
    expect(early.status).toBe(400)
    expect(early.body.error.code).toBe('TELEGRAM_NOT_STARTED')
    expect(early.body.error.message).toContain('@openitd_bot')

    const chatId = await pressStart('new_user')
    const signUp = await api('POST', '/v1/auth/sign-up', { body: { telegram: '@New_User', password: PASSWORD } })
    // values are read before asymmetric matchers: bun's toMatchObject may write them into the received object
    const { flowToken, otp } = signUp.body
    expect(signUp.status).toBe(200)
    expect(signUp.body.nextStep).toBe('verify_email')
    expect(flowToken).toBeString()
    expect(otp).toMatch(/^\d{6}$/)
    const [message] = (await botOutbox()).filter((m) => m.chatId === chatId)
    expect(message!.text).toContain(`<b>${otp}</b>`)
    expect(message!.expiresAt).toBeGreaterThan(Date.now())

    const wrong = await api('POST', '/v1/auth/verify-otp', { body: { telegram: 'new_user', otp: '000000', flowToken } })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.code).toBe('INVALID_OTP')

    const ok = await api('POST', '/v1/auth/verify-otp', { body: { telegram: 'https://t.me/new_user', otp, flowToken } })
    expect(ok.status).toBe(200)
    expect(ok.body.accessToken).toBeString()
    expect(ok.cookies.refresh_token).toBeString()
    expect(ok.cookies.is_auth).toBe('1')

    const again = await api('POST', '/v1/auth/sign-up', { body: { telegram: 'new_user', password: PASSWORD } })
    expect(again.status).toBe(409)
  })

  test('the web client sends the Telegram username as `email`', async () => {
    await pressStart('web_client')
    const signUp = await api('POST', '/v1/auth/sign-up', { body: { email: '@web_client', password: PASSWORD } })
    const ok = await api('POST', '/v1/auth/verify-otp', { body: { email: '@web_client', password: PASSWORD, otp: signUp.body.otp, flowToken: signUp.body.flowToken } })
    expect(ok.status).toBe(200)
    await api('POST', '/users/profile', { token: ok.body.accessToken, body: { username: 'webclient', displayName: 'Web', avatar: '🐱' } })
    const me = await api('GET', '/users/me', { token: ok.body.accessToken })
    expect(me.body).toMatchObject({ email: '@web_client', telegram: 'web_client' })
  })

  test('validates the username and password', async () => {
    for (const telegram of ['abc', 'a@b.co', '1abcde', 'with space'])
      expect((await api('POST', '/v1/auth/sign-up', { body: { telegram, password: PASSWORD } })).body.error.code).toBe('INVALID_TELEGRAM')
    expect((await api('POST', '/v1/auth/sign-up', { body: { telegram: 'valid_nick', password: 'short' } })).body.error.code).toBe('INVALID_PASSWORD')
  })

  test('code attempts are limited', async () => {
    await pressStart('brute_force')
    const signUp = await api('POST', '/v1/auth/sign-up', { body: { telegram: 'brute_force', password: PASSWORD } })
    for (let i = 0; i < 5; i++) await api('POST', '/v1/auth/verify-otp', { body: { otp: '111111', flowToken: signUp.body.flowToken } })
    const locked = await api('POST', '/v1/auth/verify-otp', { body: { otp: signUp.body.otp, flowToken: signUp.body.flowToken } })
    expect(locked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED')
  })
})

describe('sign-in with LOGIN_CODE', () => {
  test('every sign-in is confirmed by a code sent to the chat of the account', async () => {
    const user = await createUser()
    config.auth.loginCode = true
    try {
      // the username now points to another chat: the code still goes to the chat that confirmed the account
      const chatOfAccount = (await botOutbox()).at(-1)!.chatId
      await pressStart(user.telegram, '999999')
      const signIn = await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: PASSWORD }, headers: { 'user-agent': ANDROID } })
      expect(signIn.body.nextStep).toBe('verify_email')
      expect(signIn.body.accessToken).toBeUndefined()
      const message = (await botOutbox()).at(-1)!
      expect(message.chatId).toBe(chatOfAccount)
      expect(message.text).toContain('код для входа')
      expect(message.text).toContain('Android 14')

      const ok = await api('POST', '/v1/auth/verify-otp', { body: { telegram: user.telegram, otp: signIn.body.otp, flowToken: signIn.body.flowToken } })
      expect(ok.status).toBe(200)
      expect((await api('GET', '/users/me', { token: ok.body.accessToken })).body.id).toBe(user.id)
      // wrong password never reaches the bot
      expect((await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: 'wrong-password' } })).body.error.code).toBe('INVALID_CREDENTIALS')
    } finally {
      config.auth.loginCode = false
    }
  })
})

describe('sign-in & tokens', () => {
  test('sign-in issues tokens; wrong password is INVALID_CREDENTIALS', async () => {
    const user = await createUser()
    const ok = await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: PASSWORD } })
    expect(ok.status).toBe(200)
    expect(ok.body.accessToken.split('.')).toHaveLength(3)
    const payload = JSON.parse(Buffer.from(ok.body.accessToken.split('.')[1], 'base64url').toString())
    expect(payload).toMatchObject({ sub: user.id, roles: ['user'], isActive: true, iss: 'auth-service' })
    expect(payload.exp - payload.iat).toBe(900)

    const bad = await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: 'wrong-password' } })
    expect(bad.status).toBe(401)
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS')
    const unknown = await api('POST', '/v1/auth/sign-in', { body: { telegram: 'ghost_user', password: PASSWORD } })
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS')
  })

  test('token errors use the legacy string format the SDK understands', async () => {
    const user = await createUser()
    const expired = signAccessToken({ userId: user.id, sessionId: crypto.randomUUID(), roles: ['user'] }, Date.now() - 3600_000).token
    expect((await api('GET', '/users/me', { token: expired })).body).toEqual({ error: 'token expired', message: 'Invalid or expired token' })
    expect((await api('GET', '/users/me', { token: user.token.slice(0, -3) + 'abc' })).body.error).toBe('invalid signature')
    expect((await api('GET', '/users/me', { token: 'garbage' })).body.error).toBe('invalid token')
    const missing = await api('GET', '/users/me')
    expect(missing.status).toBe(401)
    expect(missing.body.error.code).toBe('UNAUTHORIZED')
  })

  test('refresh rotates the cookie with a short grace period for the old one', async () => {
    const user = await createUser()
    const first = await api('POST', '/v1/auth/refresh', { cookie: `refresh_token=${user.refresh}` })
    expect(first.status).toBe(200)
    expect(first.cookies.refresh_token).toBeString()
    expect(first.cookies.refresh_token).not.toBe(user.refresh)

    // concurrent request with the previous token still succeeds, without another rotation
    const grace = await api('POST', '/v1/auth/refresh', { cookie: `refresh_token=${user.refresh}` })
    expect(grace.status).toBe(200)
    expect(grace.cookies.refresh_token).toBeUndefined()

    const next = await api('POST', '/v1/auth/refresh', { cookie: `refresh_token=${first.cookies.refresh_token}` })
    expect(next.status).toBe(200)
    expect((await api('POST', '/v1/auth/refresh', { cookie: 'refresh_token=unknown' })).body.error.code).toBe('SESSION_NOT_FOUND')
    expect((await api('POST', '/v1/auth/refresh')).body.error.code).toBe('REFRESH_TOKEN_MISSING')
  })

  test('parallel refreshes with one token rotate it once', async () => {
    const user = await createUser()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api('POST', '/v1/auth/refresh', { cookie: `refresh_token=${user.refresh}` }))
    )
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    const issued = results.map((r) => r.cookies.refresh_token).filter(Boolean)
    expect(issued).toHaveLength(1)
    expect((await api('POST', '/v1/auth/refresh', { cookie: `refresh_token=${issued[0]}` })).status).toBe(200)
  })

  test('logout revokes the session and its access tokens', async () => {
    const user = await createUser()
    expect((await api('GET', '/users/me', { token: user.token })).status).toBe(200)
    const out = await api('POST', '/v1/auth/logout', { cookie: `refresh_token=${user.refresh}` })
    expect(out.body).toEqual({ success: true })
    expect(out.cookies.refresh_token).toBe('')
    expect((await api('GET', '/users/me', { token: user.token })).body.error).toBe('invalid token')
    expect((await api('POST', '/v1/auth/refresh', { cookie: `refresh_token=${user.refresh}` })).body.error.code).toBe('SESSION_REVOKED')
  })
})

describe('sessions', () => {
  test('lists devices and revokes the others', async () => {
    const user = await createUser({ userAgent: ANDROID })
    const desktop = await api('POST', '/v1/auth/sign-in', {
      body: { telegram: user.telegram, password: PASSWORD },
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36', 'x-forwarded-for': '::ffff:192.0.2.10' }
    })
    const list = await api('GET', '/v1/auth/sessions', { token: desktop.body.accessToken })
    expect(list.body.sessions).toHaveLength(2)
    const current = list.body.sessions.find((s: any) => s.isCurrent)
    expect(current).toMatchObject({ deviceType: 'desktop', osName: 'Windows', osVersion: 10, clientName: 'Chrome', ipAddress: '192.0.2.10' })
    expect(list.body.sessions.find((s: any) => !s.isCurrent)).toMatchObject({ deviceType: 'mobile', osName: 'Android' })

    const revoked = await api('DELETE', '/v1/auth/sessions', { token: desktop.body.accessToken })
    expect(revoked.body).toEqual({ success: true, revokedCount: 1 })
    expect((await api('GET', '/users/me', { token: user.token })).status).toBe(401)
    expect((await api('DELETE', `/v1/auth/sessions/${crypto.randomUUID()}`, { token: desktop.body.accessToken })).status).toBe(404)
  })
})

describe('passwords', () => {
  test('change-password validates and revokes other sessions', async () => {
    const user = await createUser()
    const other = await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: PASSWORD } })
    const change = (oldPassword: string, newPassword: string) => api('POST', '/v1/auth/change-password', { token: user.token, body: { oldPassword, newPassword } })
    expect((await change(PASSWORD, PASSWORD)).body.error.code).toBe('SAME_PASSWORD')
    expect((await change('wrong-old-password', 'brand-new-password')).body.error.code).toBe('INVALID_OLD_PASSWORD')
    expect((await change(PASSWORD, 'short')).body.error.code).toBe('INVALID_PASSWORD')
    expect((await change(PASSWORD, 'brand-new-password')).body).toEqual({ success: true, revokedCount: 1 })
    expect((await api('GET', '/users/me', { token: other.body.accessToken })).status).toBe(401)
    expect((await api('GET', '/users/me', { token: user.token })).status).toBe(200)
    expect((await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: 'brand-new-password' } })).status).toBe(200)
  })

  test('forgot + reset password with a code', async () => {
    const user = await createUser()
    const forgot = await api('POST', '/v1/auth/forgot-password', { body: { telegram: user.telegram } })
    expect(forgot.body.nextStep).toBe('verify_otp')
    const verified = await api('POST', '/v1/auth/verify-otp', { body: { telegram: user.telegram, otp: forgot.body.otp, flowToken: forgot.body.flowToken } })
    expect(verified.body.nextStep).toBe('reset_password')
    const reset = await api('POST', '/v1/auth/reset-password', { body: { telegram: user.telegram, flowToken: forgot.body.flowToken, newPassword: 'recovered-password' } })
    expect(reset.body).toEqual({ success: true })
    expect((await api('GET', '/users/me', { token: user.token })).status).toBe(401)
    expect((await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: 'recovered-password' } })).status).toBe(200)

    // unknown accounts look the same once the username has started the bot
    expect((await api('POST', '/v1/auth/forgot-password', { body: { telegram: 'nobody_here' } })).body.error.code).toBe('TELEGRAM_NOT_STARTED')
    await pressStart('nobody_here')
    const sent = (await botOutbox()).length
    const unknown = await api('POST', '/v1/auth/forgot-password', { body: { telegram: 'nobody_here' } })
    expect(unknown.status).toBe(200)
    expect(unknown.body.flowToken).toBeString()
    expect(await botOutbox()).toHaveLength(sent)
  })
})

describe('QR login', () => {
  test('mobile session approves a new device', async () => {
    const user = await createUser({ userAgent: ANDROID })
    const start = await api('POST', '/v1/auth/qr/start')
    const { qrId, claimToken } = start.body
    expect(qrId).toBeString()
    expect(claimToken).toBeString()
    expect(start.body.expiresIn).toBe(90)

    expect((await api('POST', '/v1/auth/qr/claim', { body: { qrId, claimToken } })).body.error.code).toBe('QR_NOT_APPROVED')
    expect((await api('POST', '/v1/auth/qr/scan', { token: user.token, body: { qrId } })).body.success).toBe(true)

    const desktop = await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: PASSWORD } })
    expect((await api('POST', '/v1/auth/qr/approve', { token: desktop.body.accessToken, body: { qrId } })).body.error.code).toBe('QR_APPROVER_NOT_ALLOWED')
    expect((await api('POST', '/v1/auth/qr/approve', { token: user.token, body: { qrId } })).body).toEqual({ success: true })

    expect((await api('POST', '/v1/auth/qr/claim', { body: { qrId, claimToken: 'wrong' } })).body.error.code).toBe('QR_INVALID_CLAIM')
    const claim = await api('POST', '/v1/auth/qr/claim', { body: { qrId, claimToken } })
    expect(claim.body.accessToken).toBeString()
    expect(claim.cookies.refresh_token).toBeString()
    expect((await api('GET', '/users/me', { token: claim.body.accessToken })).body.id).toBe(user.id)
    expect((await api('POST', '/v1/auth/qr/claim', { body: { qrId, claimToken } })).status).toBe(404)
  })
})
