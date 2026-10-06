import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { Cookie } from 'elysia'
import { config } from '../../config'
import { db, type Executor } from '../../db/client'
import { accounts, type Role, sessions, users } from '../../db/schema'
import { ApiError, badRequest, unauthorized } from '../../lib/errors'
import { randomHexToken, randomOtp, randomToken, safeEqual, sha256 } from '../../lib/crypto'
import { signAccessToken } from '../../lib/jwt'
import { normalizeTelegram, otpMessage, sendTelegram } from '../../lib/telegram'
import { addDays, iso } from '../../lib/time'
import { parseUserAgent } from '../../lib/useragent'
import { redis, rk } from '../../redis'
import { markSessionsRevoked } from '../../services/session-store'

export type ClientContext = { ip: string; country: string | null; deviceId: string | null; userAgent: string | null }
export type AccountRow = typeof accounts.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
type Cookies = Record<string, Cookie<unknown>>

const REFRESH_GRACE_SECONDS = 30

// ---------------------------------------------------------------- validation helpers

export function assertNotBanned(account: AccountRow) {
  if (!account.bannedAt) return
  if (account.bannedUntil && account.bannedUntil.getTime() <= Date.now()) return
  if (account.bannedUntil) {
    throw new ApiError(403, 'ACCOUNT_DEACTIVATED', 'Account has been temporarily deactivated', { until: iso(account.bannedUntil), reason: account.banReason })
  }
  throw new ApiError(403, 'ACCOUNT_BANNED', 'Account has been deactivated', { reason: account.banReason })
}

export async function findAccountByTelegram(telegram: string, executor: Executor = db) {
  const [row] = await executor.select().from(accounts).where(eq(accounts.telegram, telegram)).limit(1)
  return row ?? null
}

export async function findAccount(id: string, executor: Executor = db) {
  const [row] = await executor.select().from(accounts).where(eq(accounts.id, id)).limit(1)
  return row ?? null
}

/** Lifts an expired temporary ban */
export async function liftExpiredBan(account: AccountRow) {
  if (account.bannedAt && account.bannedUntil && account.bannedUntil.getTime() <= Date.now()) {
    await db.transaction(async (tx) => {
      await tx.update(accounts).set({ bannedAt: null, bannedUntil: null, banReason: null }).where(eq(accounts.id, account.id))
      await tx.update(users).set({ isBanned: false }).where(eq(users.id, account.id))
    })
    account.bannedAt = null
    account.bannedUntil = null
  }
}

// ---------------------------------------------------------------- sessions

export async function createSession(account: Pick<AccountRow, 'id' | 'roles'>, ctx: ClientContext, executor: Executor = db) {
  const refreshToken = randomHexToken()
  const device = parseUserAgent(ctx.userAgent)
  const [session] = await executor
    .insert(sessions)
    .values({
      accountId: account.id,
      tokenHash: sha256(refreshToken),
      deviceId: ctx.deviceId,
      userAgent: ctx.userAgent,
      ipAddress: ctx.ip,
      ipCountry: ctx.country,
      ...device,
      expiresAt: addDays(new Date(), config.auth.refreshTokenTtlDays)
    })
    .returning()
  const { token: accessToken } = signAccessToken({ userId: account.id, sessionId: session!.id, roles: account.roles })
  return { accessToken, refreshToken, session: session! }
}

const sessionError = (code: 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'SESSION_REVOKED' | 'REFRESH_TOKEN_MISSING', message: string) =>
  new ApiError(401, code, message)

/** Exchanges a refresh token for a new access token, rotating the refresh token */
export async function refreshSession(refreshToken: string | undefined, ctx: ClientContext) {
  if (!refreshToken) throw sessionError('REFRESH_TOKEN_MISSING', 'Refresh token is missing')
  const hash = sha256(refreshToken)

  let [session] = await db.select().from(sessions).where(eq(sessions.tokenHash, hash)).limit(1)
  let rotate = true
  if (!session) {
    // a concurrent refresh may have just rotated this token: honour it briefly without rotating again
    const graceSessionId = await redis.get(rk('sess', 'grace', hash))
    if (graceSessionId) {
      ;[session] = await db.select().from(sessions).where(eq(sessions.id, graceSessionId)).limit(1)
      rotate = false
    }
  }
  if (!session) throw sessionError('SESSION_NOT_FOUND', 'Session not found')
  if (session.revokedAt) throw sessionError('SESSION_REVOKED', 'Session has been revoked')
  if (session.expiresAt.getTime() <= Date.now()) throw sessionError('SESSION_EXPIRED', 'Session expired')

  const account = await findAccount(session.accountId)
  if (!account) throw sessionError('SESSION_NOT_FOUND', 'Session not found')
  await liftExpiredBan(account)
  assertNotBanned(account)

  let nextToken: string | null = null
  if (rotate) {
    // grace first, then a compare-and-swap: of two concurrent refreshes only one rotates, the other keeps its cookie
    await redis.set(rk('sess', 'grace', hash), session.id, 'EX', REFRESH_GRACE_SECONDS)
    const candidate = randomHexToken()
    const rotated = await db
      .update(sessions)
      .set({
        tokenHash: sha256(candidate),
        lastUsedAt: new Date(),
        expiresAt: addDays(new Date(), config.auth.refreshTokenTtlDays),
        ipAddress: ctx.ip,
        ipCountry: ctx.country ?? session.ipCountry
      })
      .where(and(eq(sessions.id, session.id), eq(sessions.tokenHash, hash)))
      .returning({ id: sessions.id })
    if (rotated.length) nextToken = candidate
  }
  const { token: accessToken } = signAccessToken({ userId: account.id, sessionId: session.id, roles: account.roles })
  return { accessToken, refreshToken: nextToken, session, account }
}

export async function findSessionByRefreshToken(refreshToken: string | undefined) {
  if (!refreshToken) return null
  const [session] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256(refreshToken)))
    .limit(1)
  return session ?? null
}

export async function revokeSession(sessionId: string, reason = 'logout') {
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: reason })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id })
  await markSessionsRevoked(revoked.map((s) => s.id))
  return revoked.length
}

export async function revokeAllSessions(accountId: string, options: { except?: string; reason?: string } = {}) {
  const conditions = [eq(sessions.accountId, accountId), isNull(sessions.revokedAt)]
  if (options.except) conditions.push(ne(sessions.id, options.except))
  const revoked = await db
    .update(sessions)
    .set({ revokedAt: new Date(), revokeReason: options.reason ?? 'logout_all' })
    .where(and(...conditions))
    .returning({ id: sessions.id })
  await markSessionsRevoked(revoked.map((s) => s.id))
  return revoked.length
}

export async function listActiveSessions(accountId: string) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
    .orderBy(desc(sessions.lastUsedAt))
}

export function presentSession(session: SessionRow, currentSessionId: string | null) {
  return {
    id: session.id,
    isCurrent: session.id === currentSessionId,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    ipAddress: session.ipAddress ?? '0.0.0.0',
    ipCountry: session.ipCountry,
    ipCity: session.ipCity,
    deviceType: session.deviceType,
    osName: session.osName,
    osVersion: session.osVersion,
    deviceModel: session.deviceModel,
    clientName: session.clientName,
    clientVersion: session.clientVersion
  }
}

// ---------------------------------------------------------------- cookies

export function setAuthCookies(cookie: Cookies, refreshToken: string) {
  const common = {
    path: '/',
    sameSite: 'lax' as const,
    secure: config.auth.cookieSecure,
    domain: config.auth.cookieDomain,
    maxAge: config.auth.refreshTokenTtlDays * 24 * 60 * 60
  }
  cookie[config.auth.refreshCookieName]!.set({ ...common, value: refreshToken, httpOnly: true })
  cookie.is_auth!.set({ ...common, value: '1', httpOnly: false })
}

export function clearAuthCookies(cookie: Cookies) {
  const options = { path: '/', domain: config.auth.cookieDomain }
  cookie[config.auth.refreshCookieName]!.set({ ...options, value: '', maxAge: 0, expires: new Date(0), httpOnly: true })
  cookie.is_auth!.set({ ...options, value: '', maxAge: 0, expires: new Date(0) })
}

export function readRefreshCookie(cookie: Cookies, body?: unknown) {
  const fromCookie = cookie[config.auth.refreshCookieName]?.value
  if (typeof fromCookie === 'string' && fromCookie) return fromCookie
  const fromBody = (body as { refreshToken?: unknown } | undefined)?.refreshToken
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined
}

// ---------------------------------------------------------------- one-time code flows

export type FlowPurpose = 'signup' | 'login' | 'reset'
export type Flow = {
  purpose: FlowPurpose
  telegram: string
  // where the code goes; null for password resets of unknown accounts (nothing is sent)
  chatId: string | null
  device: string | null
  accountId: string | null
  passwordHash: string | null
  otpHash: string
  attempts: number
  verified: boolean
  sentAt: number
}

const flowKey = (token: string) => rk('flow', token)

export async function startFlow(input: Omit<Flow, 'otpHash' | 'attempts' | 'verified' | 'sentAt'>) {
  const flowToken = randomToken(24)
  const otp = randomOtp()
  const flow: Flow = { ...input, otpHash: sha256(`${flowToken}:${otp}`), attempts: 0, verified: false, sentAt: Date.now() }
  await redis.set(flowKey(flowToken), JSON.stringify(flow), 'EX', config.auth.otpTtl)
  if (input.chatId) await sendTelegram(input.chatId, otpMessage(otp, input.purpose, input.device), config.auth.otpTtl)
  return { flowToken, otp }
}

export async function loadFlow(flowToken: string | undefined, telegram?: string) {
  if (!flowToken) throw badRequest('Flow token is missing', 'INVALID_FLOW_TOKEN')
  const raw = await redis.get(flowKey(flowToken))
  if (!raw) throw badRequest('Session expired. Start again', 'INVALID_FLOW_TOKEN')
  const flow = JSON.parse(raw) as Flow
  if (telegram && normalizeTelegram(telegram) !== flow.telegram) throw badRequest('Telegram does not match', 'INVALID_FLOW_TOKEN')
  return flow
}

export async function saveFlow(flowToken: string, flow: Flow) {
  const ttl = await redis.ttl(flowKey(flowToken))
  await redis.set(flowKey(flowToken), JSON.stringify(flow), 'EX', Math.max(ttl, 1))
}

export async function dropFlow(flowToken: string) {
  await redis.del(flowKey(flowToken))
}

/** Checks a one-time code; wrong attempts are counted and the flow dies after too many */
export async function checkOtp(flowToken: string, flow: Flow, otp: string | undefined) {
  if (!otp || !/^\d{4,8}$/.test(otp)) throw badRequest('Invalid code format', 'INVALID_OTP_FORMAT')
  if (flow.attempts >= config.auth.otpMaxAttempts) {
    await dropFlow(flowToken)
    throw badRequest('Too many attempts. Start again', 'OTP_ATTEMPTS_EXCEEDED')
  }
  if (!safeEqual(sha256(`${flowToken}:${otp}`), flow.otpHash)) {
    flow.attempts++
    await saveFlow(flowToken, flow)
    throw badRequest('Invalid code', 'INVALID_OTP')
  }
}

export async function resendOtp(flowToken: string, flow: Flow) {
  const cooldown = config.auth.otpResendCooldown * 1000 - (Date.now() - flow.sentAt)
  if (cooldown > 0) {
    throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Подождите перед повторной отправкой кода', { retryAfter: Math.ceil(cooldown / 1000) })
  }
  const otp = randomOtp()
  flow.otpHash = sha256(`${flowToken}:${otp}`)
  flow.attempts = 0
  flow.sentAt = Date.now()
  await saveFlow(flowToken, flow)
  if (flow.chatId) await sendTelegram(flow.chatId, otpMessage(otp, flow.purpose, flow.device), config.auth.otpTtl)
  return otp
}

export const rolesOf = (account: Pick<AccountRow, 'roles'>): Role[] => (account.roles?.length ? account.roles : ['user'])

export function requireAccount<T>(value: T | null | undefined): T {
  if (!value) throw unauthorized('Account not found')
  return value
}

/** "Chrome · Windows 10, 203.0.113.7" for the code message */
export function describeClient(ctx: ClientContext) {
  const device = parseUserAgent(ctx.userAgent)
  const os = device.osName === 'Unknown' ? null : [device.osName, device.osVersion].filter(Boolean).join(' ')
  const name = [device.clientName, os].filter(Boolean).join(' · ')
  return [name, ctx.ip].filter(Boolean).join(', ') || null
}
