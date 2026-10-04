import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { db } from '../../db/client'
import { accounts, sessions } from '../../db/schema'
import { ApiError, badRequest, conflict, notFound, unauthorized } from '../../lib/errors'
import { hashPassword, isValidPassword, verifyPassword } from '../../lib/password'
import { sseResponse } from '../../lib/sse'
import { verifyTurnstile } from '../../lib/turnstile'
import { authPlugin, readAuth } from '../../plugins/auth'
import { contextPlugin } from '../../plugins/context'
import { enforceActionLimit } from '../../services/rate-limit'
import { qrChannel, subscribe } from '../../services/realtime'
import { SessionModel, SuccessModel, Uuid } from '../../schemas'
import { assertClaim, consumeQr, decideQr, loadQr, qrTtlMs, scanQr, startQr } from './qr'
import {
  assertEmailAllowed,
  assertNotBanned,
  checkOtp,
  clearAuthCookies,
  createSession,
  dropFlow,
  findAccount,
  findAccountByEmail,
  findSessionByRefreshToken,
  liftExpiredBan,
  listActiveSessions,
  loadFlow,
  normalizeEmail,
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

const Credentials = t.Object({
  email: t.String({ maxLength: 254 }),
  password: t.String({ maxLength: 256 }),
  turnstileToken: t.Optional(t.String({ maxLength: 4096 })),
  token: t.Optional(t.String({ maxLength: 4096 }))
})

// comparing against a dummy hash keeps sign-in timing similar for unknown emails
let dummyHash: Promise<string> | undefined
const getDummyHash = () => (dummyHash ??= hashPassword(crypto.randomUUID()))
const INVALID_CREDENTIALS = () => new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')

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

  .get(
    '/captcha/provider',
    () => ({
      provider: config.auth.turnstileSecret ? 'cloudflare' : 'none',
      siteKey: config.auth.turnstileSiteKey ?? null,
      tokenField: 'turnstileToken'
    }),
    { detail: { summary: 'Captcha provider used by sign-in / sign-up' } }
  )

  .post(
    '/sign-up',
    async ({ body, client, cookie, set }) => {
      const email = normalizeEmail(body.email)
      assertEmailAllowed(email)
      if (!isValidPassword(body.password)) throw badRequest('Password must be 10-128 printable ASCII characters', 'INVALID_PASSWORD')
      await enforceActionLimit('sign_in', client.ip)
      if (!(await verifyTurnstile(body.turnstileToken ?? body.token, client.ip))) throw badRequest('Captcha verification failed', 'TURNSTILE_VERIFICATION_FAILED')
      if (await findAccountByEmail(email)) throw conflict('Email is already registered')

      const passwordHash = await hashPassword(body.password)
      if (!config.auth.emailVerification) {
        const [account] = await db.insert(accounts).values({ email, passwordHash, emailVerifiedAt: new Date() }).returning()
        const { accessToken, refreshToken } = await createSession(account!, client)
        setAuthCookies(cookie, refreshToken)
        set.status = 201
        return { accessToken, expiresIn: config.auth.accessTokenTtl }
      }
      const { flowToken, otp } = await startFlow({ purpose: 'signup', email, accountId: null, passwordHash })
      return flowResponse(flowToken, 'verify_email', otp)
    },
    { body: Credentials, response: { 200: TokenModel, 201: TokenModel }, detail: { summary: 'Register with email and password' } }
  )

  .post(
    '/sign-in',
    async ({ body, client, cookie }) => {
      const email = normalizeEmail(body.email)
      assertEmailAllowed(email)
      await enforceActionLimit('sign_in', `${client.ip}:${email}`)
      if (!(await verifyTurnstile(body.turnstileToken ?? body.token, client.ip))) throw badRequest('Captcha verification failed', 'TURNSTILE_VERIFICATION_FAILED')

      const account = await findAccountByEmail(email)
      const valid = await verifyPassword(body.password, account?.passwordHash ?? (await getDummyHash()))
      if (!account || !valid) throw INVALID_CREDENTIALS()
      await liftExpiredBan(account)
      assertNotBanned(account)

      if (config.auth.emailVerification && !account.emailVerifiedAt) {
        const { flowToken, otp } = await startFlow({ purpose: 'login', email, accountId: account.id, passwordHash: null })
        return flowResponse(flowToken, 'verify_email', otp)
      }
      const { accessToken, refreshToken } = await createSession(account, client)
      setAuthCookies(cookie, refreshToken)
      return { accessToken, expiresIn: config.auth.accessTokenTtl }
    },
    { body: Credentials, response: TokenModel, detail: { summary: 'Sign in; sets the refresh_token cookie' } }
  )

  .post(
    '/verify-otp',
    async ({ body, client, cookie }) => {
      const flow = await loadFlow(body.flowToken, body.email)
      await checkOtp(body.flowToken, flow, body.otp)

      if (flow.purpose === 'reset') {
        flow.verified = true
        await saveFlow(body.flowToken, flow)
        return { flowToken: body.flowToken, nextStep: 'reset_password' }
      }

      let account = flow.accountId ? await findAccount(flow.accountId) : await findAccountByEmail(flow.email)
      if (flow.purpose === 'signup') {
        if (account) throw conflict('Email is already registered')
        ;[account] = await db
          .insert(accounts)
          .values({ email: flow.email, passwordHash: flow.passwordHash!, emailVerifiedAt: new Date() })
          .returning()
      } else {
        if (!account) throw badRequest('Account not found', 'ACCOUNT_NOT_FOUND')
        assertNotBanned(account)
        await db.update(accounts).set({ emailVerifiedAt: new Date() }).where(eq(accounts.id, account.id))
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
        email: t.Optional(t.String({ maxLength: 254 })),
        password: t.Optional(t.String({ maxLength: 256 }))
      }),
      response: TokenModel,
      detail: { summary: 'Confirm a one-time code (sign-up, unverified sign-in, password reset)' }
    }
  )

  .post(
    '/resend-otp',
    async ({ body }) => {
      const flow = await loadFlow(body.flowToken, body.email)
      const otp = await resendOtp(body.flowToken, flow)
      return { success: true, expiresIn: config.auth.otpTtl, ...(config.auth.exposeOtp ? { otp } : {}) }
    },
    {
      body: t.Object({ flowToken: t.String({ maxLength: 128 }), email: t.Optional(t.String({ maxLength: 254 })) }),
      detail: { summary: 'Send the one-time code again' }
    }
  )

  .post(
    '/forgot-password',
    async ({ body, client }) => {
      const email = normalizeEmail(body.email)
      assertEmailAllowed(email)
      await enforceActionLimit('otp', client.ip)
      if (!(await verifyTurnstile(body.turnstileToken ?? body.token, client.ip))) throw badRequest('Captcha verification failed', 'TURNSTILE_VERIFICATION_FAILED')
      const account = await findAccountByEmail(email)
      // same answer for unknown emails: no account enumeration
      const { flowToken, otp } = await startFlow({ purpose: 'reset', email, accountId: account?.id ?? null, passwordHash: null }, !!account)
      return flowResponse(flowToken, 'verify_otp', account ? otp : '')
    },
    {
      body: t.Object({ email: t.String({ maxLength: 254 }), turnstileToken: t.Optional(t.String()), token: t.Optional(t.String()) }),
      response: TokenModel,
      detail: { summary: 'Start password recovery (sends a code by email)' }
    }
  )

  .post(
    '/reset-password',
    async ({ body }) => {
      const flow = await loadFlow(body.flowToken, body.email)
      if (flow.purpose !== 'reset') throw badRequest('Invalid flow', 'INVALID_FLOW_TOKEN')
      if (!flow.verified) await checkOtp(body.flowToken!, flow, body.otp)
      if (!flow.accountId) throw badRequest('Invalid code', 'INVALID_OTP')
      if (!isValidPassword(body.newPassword)) throw badRequest('Password must be 10-128 printable ASCII characters', 'INVALID_PASSWORD')

      await db
        .update(accounts)
        .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), emailVerifiedAt: new Date(), updatedAt: new Date() })
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
        email: t.Optional(t.String({ maxLength: 254 }))
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
      if (!isValidPassword(body.newPassword)) throw badRequest('Password must be 10-128 printable ASCII characters', 'INVALID_PASSWORD')
      if (body.newPassword === body.oldPassword) throw badRequest('New password must differ from the old one', 'SAME_PASSWORD')
      if (!(await verifyPassword(body.oldPassword, account.passwordHash))) throw badRequest('Old password is incorrect', 'INVALID_OLD_PASSWORD')

      await db
        .update(accounts)
        .set({ passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date(), updatedAt: new Date() })
        .where(eq(accounts.id, account.id))
      const revokedCount = await revokeAllSessions(account.id, { except: auth.sessionId, reason: 'password_changed' })
      return { success: true, revokedCount }
    },
    {
      account: true,
      body: t.Object({ oldPassword: t.String({ maxLength: 256 }), newPassword: t.String({ maxLength: 256 }) }),
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
