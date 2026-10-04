import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { db } from '../db/client'
import { accounts, type Role, users } from '../db/schema'
import { ApiError, forbidden, tokenError, unauthorized } from '../lib/errors'
import { type AccessClaims, TokenVerificationError, verifyAccessToken } from '../lib/jwt'
import { iso } from '../lib/time'
import { touchPresence } from '../services/presence'
import { isSessionRevoked } from '../services/session-store'

export type AuthInfo = { accountId: string; sessionId: string; roles: Role[]; claims: AccessClaims }
export type Me = typeof users.$inferSelect

const bearer = { security: [{ bearerAuth: [] }] }

const TOKEN_ERRORS = {
  expired: 'token expired',
  invalid_signature: 'invalid signature',
  malformed: 'invalid token',
  unsupported_alg: 'Unsupported token algorithm'
} as const

/**
 * Reads the bearer token. A missing header is anonymous (or 401 when required);
 * a present but bad token is always rejected so clients refresh it.
 */
export async function readAuth(request: Request, required: boolean): Promise<AuthInfo | null> {
  const header = request.headers.get('authorization')
  if (!header) {
    if (required) throw unauthorized('Authorization required')
    return null
  }
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) throw tokenError('invalid token')

  let claims: AccessClaims
  try {
    claims = verifyAccessToken(token)
  } catch (error) {
    if (error instanceof TokenVerificationError) throw tokenError(TOKEN_ERRORS[error.reason])
    throw error
  }
  if (await isSessionRevoked(claims.sid)) throw tokenError('invalid token')
  return { accountId: claims.sub, sessionId: claims.sid, roles: claims.roles ?? ['user'], claims }
}

export async function loadProfile(accountId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, accountId)).limit(1)
  return row ?? null
}

export const canRestore = (me: Pick<Me, 'restoreDeadline'>) => !me.restoreDeadline || me.restoreDeadline.getTime() > Date.now()

export function accountDeletedError(me: Me) {
  return new ApiError(403, 'ACCOUNT_DELETED', 'Account has been deleted', { canRestore: canRestore(me), restoreDeadline: iso(me.restoreDeadline) })
}

function requireActiveProfile(me: Me | null): Me {
  if (!me) throw forbidden('No profile. Please create your profile first', 'PROFILE_REQUIRED')
  if (me.deletedAt) throw accountDeletedError(me)
  return me
}

export const authPlugin = new Elysia({ name: 'auth' }).macro({
  /** Valid access token; profile is not required (auth flows, sessions, profile creation) */
  account: {
    detail: bearer,
    async resolve({ request }) {
      const auth = (await readAuth(request, true))!
      void touchPresence(auth.accountId)
      return { auth }
    }
  },
  /** Valid access token and an active (created, not deleted) profile */
  user: {
    detail: bearer,
    async resolve({ request }) {
      const auth = (await readAuth(request, true))!
      const me = requireActiveProfile(await loadProfile(auth.accountId))
      void touchPresence(me.id)
      return { auth, me }
    }
  },
  /** Anonymous access allowed; resolves the viewer when a token is sent */
  optionalUser: {
    async resolve({ request }) {
      const auth = await readAuth(request, false)
      let me: Me | null = null
      if (auth) {
        const row = await loadProfile(auth.accountId)
        if (row && !row.deletedAt) {
          me = row
          void touchPresence(row.id)
        }
      }
      return { auth, me }
    }
  },
  admin: {
    detail: bearer,
    async resolve({ request }) {
      const auth = (await readAuth(request, true))!
      // roles are re-read from the database so a revoked admin loses access immediately
      const [account] = await db.select({ roles: accounts.roles }).from(accounts).where(eq(accounts.id, auth.accountId)).limit(1)
      if (!auth.roles.includes('admin') || !account?.roles.includes('admin')) throw forbidden('Admin access required')
      const me = requireActiveProfile(await loadProfile(auth.accountId))
      return { auth, me }
    }
  }
})
