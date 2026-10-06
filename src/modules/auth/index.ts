import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { db } from '../../db/client'
import { accounts, sessions } from '../../db/schema'
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors'
import { hashPassword, isValidPassword, verifyPassword } from '../../lib/password'
import { sseResponse } from '../../lib/sse'
import { assertTelegram, normalizeTelegram, requireTelegramChat } from '../../lib/telegram'
import { authPlugin, readAuth } from '../../plugins/auth'
import { contextPlugin } from '../../plugins/context'
import { enforceActionLimit } from '../../services/rate-limit'
import { qrChannel, subscribe } from '../../services/realtime'
import { SessionModel, SuccessModel, Uuid } from '../../schemas'
import { assertClaim, consumeQr, decideQr, loadQr, qrTtlMs, scanQr, startQr } from './qr'
import {
  assertNotBanned,
  checkOtp,
  clearAuthCookies,
  createSession,
  describeClient,
  dropFlow,
  findAccount,
  findAccountByTelegram,
  findSessionByRefreshToken,
  liftExpiredBan,
  listActiveSessions,
  loadFlow,
  presentSession,
  readRefreshCookie,
  refreshSession,
  resendOtp,
  revokeAllSessions,
  revokeSession,
  rolesOf,
  saveFlow,
  setAuthCookies,
  startFlow
} from './service'

const TokenModel = t.Object({
  accessToken: t.Optional(t.String()),
  token: t.Optional(t.String()),
  expiresIn: t.Optional(t.Integer()),
  flowToken: t.Optional(t.String()),
  nextStep: t.Optional(t.String()),
  otp: t.Optional(t.String({ description: 'Only in development (DEV_EXPOSE_OTP=true)' }))
})

// the web client and itd-sdk send the login as `email`; it holds a Telegram username here
const Login = {
  telegram: t.Optional(t.String({ maxLength: 64, description: 'Telegram username: nick, @nick or t.me/nick' })),
  email: t.Optional(t.String({ maxLength: 64, description: 'Alias of telegram (field name used by the web client)' }))
}
const Credentials = t.Object({ ...Login, password: t.String({ maxLength: 256 }) })

function loginOf(body: { telegram?: string; email?: string }) {
  const telegram = normalizeTelegram(body.telegram ?? body.email ?? '')
  assertTelegram(telegram)
  return telegram
}

// comparing against a dummy hash keeps sign-in timing similar for unknown accounts
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()))
const INVALID_CREDENTIALS = () => new ApiError(401, 'INVALID_CREDENTIALS', 'Неверный ник Telegram или пароль')
const ALREADY_REGISTERED = () => conflict('Этот Telegram уже зарегистрирован', 'ENTITY_ALREADY_EXISTS')

const flowResponse = (flowToken: string, nextStep: string, otp: string) => ({
  flowToken,
  nextStep,
  expiresIn: config.auth.otpTtl,
  ...(config.auth.exposeOtp ? { otp } : {})
})

export const authModule = new Elysia({ prefix: '/v1/auth', tags: ['Auth'] })
  .use(contextPlugin)
  .use(authPlugin)
  .derive(({ ip, country, deviceId, userAgent }) => ({ client: { ip, country, deviceId, userAgent } }))

  .post(
    '/sign-up',
    async ({ body, client, cookie, set }) => {
      const telegram = loginOf(body)
      if (!isValidPassword(body.password)) throw badRequest('Password must be 10-128 printable ASCII characters', 'INVALID_PASSWORD')
      await enforceActionLimit('sign_in', client.ip)
      if (await findAccountByTelegram(telegram)) throw ALREADY_REGISTERED()

      const passwordHash = await hashPassword(body.password)
      if (!config.auth.telegramVerification) {
        const [account] = await db.insert(accounts).values({ telegram, passwordHash, verifiedAt: new Date() }).returning()
        const { accessToken, refreshToken } = await createSession(account!, client)
        setAuthCookies(cookie, refreshToken)
        set.status = 201
        return { accessToken, expiresIn: config.auth.accessTokenTtl }
      }
      const chatId = await requireTelegramChat(telegram)
      const { flowToken, otp } = await startFlow({ purpose: 'signup', telegram, chatId, device: describeClient(client), accountId: null, passwordHash })
      return flowResponse(flowToken, 'verify_email', otp)
    },
    {
      body: Credentials,
      response: { 200: TokenModel, 201: TokenModel },
      detail: { summary: 'Register with a Telegram username and password; the code comes from the Telegram bot' }
    }
  )

  .post(
    '/sign-in',
    async ({ body, client, cookie }) => {
      const telegram = loginOf(body)
      await enforceActionLimit('sign_in', `${client.ip}:${telegram}`)

      const account = await findAccountByTelegram(telegram)
      const valid = await verifyPassword(body.password, account?.passwordHash ?? (await getDummyHash()))
      if (!account || !valid) throw INVALID_CREDENTIALS()
      await liftExpiredBan(account)
      assertNotBanned(account)

      if (config.auth.telegramVerification && (config.auth.loginCode || !account.verifiedAt)) {
        const chatId = account.telegramChatId ?? (await requireTelegramChat(telegram))
        const { flowToken, otp } = await startFlow({ purpose: 'login', telegram, chatId, device: describeClient(client), accountId: account.id, passwordHash: null })
        return flowResponse(flowToken, 'verify_email', otp)
      }
      const { accessToken, refreshToken } = await createSession(account, client)
      setAuthCookies(cookie, refreshToken)
      return { accessToken, expiresIn: config.auth.accessTokenTtl }
    },
    { body: Credentials, response: TokenModel, detail: { summary: 'Sign in; with LOGIN_CODE a Telegram code is required, otherwise sets the refresh_token cookie' } }
  )

  .post(
    '/verify-otp',
    async ({ body, client, cookie }) => {
      const flow = await loadFlow(body.flowToken, body.telegram ?? body.email)
      await checkOtp(body.flowToken, flow, body.otp)

      if (flow.purpose === 'reset') {
        flow.verified = true
        await saveFlow(body.flowToken, flow)
        return { flowToken: body.flowToken, nextStep: 'reset_password' }
      }

      let account = flow.accountId ? await findAccount(flow.accountId) : await findAccountByTelegram(flow.telegram)
      if (flow.purpose === 'signup') {
        if (account) throw ALREADY_REGISTERED()
        ;[account] = await db
          .insert(accounts)
          .values({ telegram: flow.telegram, telegramChatId: flow.chatId, passwordHash: flow.passwordHash!, verifiedAt: new Date() })
          .returning()
      } else {
        if (!account) throw badRequest('Account not found', 'ACCOUNT_NOT_FOUND')
        assertNotBanned(account)
        await db
          .update(accounts)
          .set({ verifiedAt: account.verifiedAt ?? new Date(), telegramChatId: account.telegramChatId ?? flow.chatId })
          .where(eq(accounts.id, account.id))
      }
      await dropFlow(body.flowToken)
      const { accessToken, refreshToken } = await createSession(account!, client)
      setAuthCookies(cookie, refreshToken)
      return { accessToken, expiresIn: config.auth.accessTokenTtl }
    },
    {
      body: t.Object({
        flowToken: t.String({ maxLength: 128 }),
        otp: t.String({ maxLength: 16 }),
        ...Login,
        password: t.Optional(t.String({ maxLength: 256 }))
      }),
      response: TokenModel,
      detail: { summary: 'Confirm a Telegram code (sign-up, sign-in, password reset)' }
    }
  )

  .post(
    '/resend-otp',
    async ({ body }) => {
      const flow = await loadFlow(body.flowToken, body.telegram ?? body.email)
      const otp = await resendOtp(body.flowToken, flow)
      return { success: true, expiresIn: config.auth.otpTtl, ...(config.auth.exposeOtp ? { otp } : {}) }
    },
    {
      body: t.Object({ flowToken: t.String({ maxLength: 128 }), ...Login }),
      detail: { summary: 'Send the code again' }
    }
  )

  .post(
    '/forgot-password',
    async ({ body, client }) => {
      const telegram = loginOf(body)
      await enforceActionLimit('otp', client.ip)
      const account = await findAccountByTelegram(telegram)
      // the bot check does not depend on the account, so unknown and existing accounts look the same
      const chatId = account?.telegramChatId ?? (await requireTelegramChat(telegram))
      const { flowToken, otp } = await startFlow({
        purpose: 'reset',
        telegram,
        chatId: account ? chatId : null,
        device: describeClient(client),
        accountId: account?.id ?? null,
        passwordHash: null
      })
      return flowResponse(flowToken, 'verify_otp', account ? otp : '')
    },
    {
      body: t.Object(Login),
      response: TokenModel,
      detail: { summary: 'Start password recovery (the code comes from the Telegram bot)' }
    }
  )

  .post(
    '/reset-password',
    async ({ body }) => {
      const flow = await loadFlow(body.flowToken, body.telegram ?? body.email)
      if (flow.purpose !== 'reset') throw badRequest('Invalid flow', 'INVALID_FLOW_TOKEN')
      if (!flow.verified) await checkOtp(body.flowToken!, flow, body.otp)
      if (!flow.accountId) throw badRequest('Invalid code', 'INVALID_OTP')
      if (!isValidPassword(body.newPassword)) throw badRequest('Password must be 10-128 printable ASCII characters', 'INVALID_PASSWORD')

      await db
        .update(accounts)
        .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(accounts.id, flow.accountId))
      await revokeAllSessions(flow.accountId, { reason: 'password_reset' })
      await dropFlow(body.flowToken!)
      return { success: true }
    },
    {
      body: t.Object({
        flowToken: t.String({ maxLength: 128 }),
        newPassword: t.String({ maxLength: 256 }),
        otp: t.Optional(t.String({ maxLength: 16 })),
        ...Login
      }),
      response: SuccessModel,
      detail: { summary: 'Set a new password after code confirmation' }
    }
  )

  .post(
    '/change-password',
    async ({ body, auth }) => {
      const account = await findAccount(auth.accountId)
      if (!account) throw unauthorized('Account not found')
      // the SDK sends oldPassword, the web client currentPassword
      const oldPassword = body.oldPassword ?? body.currentPassword
      if (oldPassword === undefined) throw badRequest('Old password is required', 'VALIDATION_ERROR')
      if (!isValidPassword(body.newPassword)) throw badRequest('Password must be 10-128 printable ASCII characters', 'INVALID_PASSWORD')
      if (body.newPassword === oldPassword) throw badRequest('New password must differ from the old one', 'SAME_PASSWORD')
      if (!(await verifyPassword(oldPassword, account.passwordHash))) throw badRequest('Old password is incorrect', 'INVALID_OLD_PASSWORD')

      await db
        .update(accounts)
        .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
      const revokedCount = await revokeAllSessions(account.id, { except: auth.sessionId, reason: 'password_changed' })
      return { success: true, revokedCount }
    },
    {
      account: true,
      body: t.Object({
        oldPassword: t.Optional(t.String({ maxLength: 256 })),
        currentPassword: t.Optional(t.String({ maxLength: 256 })),
        newPassword: t.String({ maxLength: 256 })
      }),
      detail: { summary: 'Change password (other sessions are revoked)' }
    }
  )

  .post(
    '/refresh',
    async ({ body, cookie, client }) => {
      const result = await refreshSession(readRefreshCookie(cookie, body), client)
      if (result.refreshToken) setAuthCookies(cookie, result.refreshToken)
      return { accessToken: result.accessToken, expiresIn: config.auth.accessTokenTtl }
    },
    {
      body: t.Optional(t.Object({ refreshToken: t.Optional(t.String({ maxLength: 512 })) })),
      response: TokenModel,
      detail: { summary: 'Exchange the refresh_token cookie for a new access token (the cookie is rotated)' }
    }
  )

  .post(
    '/logout',
    async ({ cookie, request, body }) => {
      const session = await findSessionByRefreshToken(readRefreshCookie(cookie, body))
      if (session) await revokeSession(session.id)
      else {
        const auth = await readAuth(request, false).catch(() => null)
        if (auth) await revokeSession(auth.sessionId)
      }
      clearAuthCookies(cookie)
      return { success: true }
    },
    { body: t.Optional(t.Object({ refreshToken: t.Optional(t.String({ maxLength: 512 })) })), response: SuccessModel, detail: { summary: 'Log out the current session' } }
  )

  .post(
    '/logout-all',
    async ({ cookie, request, body }) => {
      const session = await findSessionByRefreshToken(readRefreshCookie(cookie, body))
      const accountId = session?.accountId ?? (await readAuth(request, false).catch(() => null))?.accountId
      if (!accountId) throw unauthorized('Authorization required')
      const revokedCount = await revokeAllSessions(accountId)
      clearAuthCookies(cookie)
      return { success: true, revokedCount }
    },
    { body: t.Optional(t.Object({ refreshToken: t.Optional(t.String({ maxLength: 512 })) })), detail: { summary: 'Log out everywhere' } }
  )

  // ------------------------------------------------------------ sessions

  .get(
    '/sessions',
    async ({ auth }) => {
      const list = await listActiveSessions(auth.accountId)
      return { sessions: list.map((session) => presentSession(session, auth.sessionId)) }
    },
    { account: true, response: t.Object({ sessions: t.Array(SessionModel) }), detail: { summary: 'Active sessions of the account' } }
  )

  .delete(
    '/sessions/:id',
    async ({ auth, params }) => {
      const [session] = await db.select({ accountId: sessions.accountId }).from(sessions).where(eq(sessions.id, params.id)).limit(1)
      if (!session || session.accountId !== auth.accountId) throw notFound('Session not found', 'SESSION_NOT_FOUND')
      await revokeSession(params.id, 'revoked_by_user')
      return { success: true }
    },
    { account: true, params: t.Object({ id: Uuid }), response: SuccessModel, detail: { summary: 'Revoke one session' } }
  )

  .delete(
    '/sessions',
    async ({ auth }) => ({ success: true, revokedCount: await revokeAllSessions(auth.accountId, { except: auth.sessionId, reason: 'revoked_by_user' }) }),
    { account: true, response: t.Object({ success: t.Boolean(), revokedCount: t.Integer() }), detail: { summary: 'Revoke all sessions except the current one' } }
  )

  // ------------------------------------------------------------ QR login

  .post('/qr/start', async ({ client }) => startQr(client), {
    response: t.Object({ qrId: t.String(), payload: t.String(), claimToken: t.String(), expiresIn: t.Integer() }),
    detail: { summary: 'Create a QR login request (shown on the new device)' }
  })

  .post(
    '/qr/stream',
    async ({ body, request, server }) => {
      const state = await loadQr(body.qrId)
      assertClaim(state, body.claimToken)
      server?.timeout(request, 0)
      return sseResponse(request, async (sink) => {
        sink.send({ status: state.status })
        if (state.status === 'approved' || state.status === 'rejected') {
          sink.close()
          return
        }
        const unsubscribe = await subscribe(qrChannel(body.qrId), (message) => {
          const status = (message.data as { status: string }).status
          sink.send({ status })
          if (status === 'approved' || status === 'rejected') sink.close()
        })
        const expiry = setTimeout(() => {
          sink.send({ status: 'expired' })
          sink.close()
        }, await qrTtlMs(body.qrId))
        return () => {
          clearTimeout(expiry)
          unsubscribe()
        }
      })
    },
    {
      body: t.Object({ qrId: t.String({ maxLength: 64 }), claimToken: t.String({ maxLength: 128 }) }),
      detail: { summary: 'Server-sent events with QR status: pending → scanned → approved | rejected | expired' }
    }
  )

  .post(
    '/qr/claim',
    async ({ body, cookie, client }) => {
      const state = await loadQr(body.qrId)
      assertClaim(state, body.claimToken)
      if (state.status !== 'approved' || !state.accountId) throw new ApiError(409, 'QR_NOT_APPROVED', 'QR code is not approved yet')
      const account = await findAccount(state.accountId)
      if (!account) throw notFound('Account not found', 'ACCOUNT_NOT_FOUND')
      assertNotBanned(account)
      await consumeQr(body.qrId)
      const { accessToken, refreshToken } = await createSession({ id: account.id, roles: rolesOf(account) }, client)
      setAuthCookies(cookie, refreshToken)
      return { accessToken, expiresIn: config.auth.accessTokenTtl }
    },
    {
      body: t.Object({ qrId: t.String({ maxLength: 64 }), claimToken: t.String({ maxLength: 128 }) }),
      response: TokenModel,
      detail: { summary: 'Exchange an approved QR request for a session' }
    }
  )

  .post('/qr/scan', async ({ body, auth }) => ({ success: true, requester: await scanQr(body.qrId, auth.accountId) }), {
    account: true,
    body: t.Object({ qrId: t.String({ maxLength: 64 }) }),
    detail: { summary: 'Mark a QR request as scanned (signed-in device)' }
  })

  .post(
    '/qr/approve',
    async ({ body, auth }) => {
      const [session] = await db.select({ deviceType: sessions.deviceType }).from(sessions).where(eq(sessions.id, auth.sessionId)).limit(1)
      await decideQr(body.qrId, auth.accountId, session?.deviceType ?? 'desktop', true)
      return { success: true }
    },
    { account: true, body: t.Object({ qrId: t.String({ maxLength: 64 }) }), response: SuccessModel, detail: { summary: 'Approve a QR login (mobile sessions only)' } }
  )

  .post(
    '/qr/reject',
    async ({ body, auth }) => {
      await decideQr(body.qrId, auth.accountId, 'mobile', false)
      return { success: true }
    },
    { account: true, body: t.Object({ qrId: t.String({ maxLength: 64 }) }), response: SuccessModel, detail: { summary: 'Reject a QR login' } }
  )
