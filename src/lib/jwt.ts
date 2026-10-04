import { v4 as uuidv4 } from 'uuid'
import { config } from '../config'
import type { Role } from '../db/schema'
import { hmac, safeEqual } from './crypto'

export type AccessClaims = {
  sub: string
  sid: string
  roles: Role[]
  isActive: boolean
  iss: string
  iat: number
  exp: number
  jti: string
}

export type TokenFailure = 'expired' | 'invalid_signature' | 'malformed' | 'unsupported_alg'

export class TokenVerificationError extends Error {
  constructor(public reason: TokenFailure) {
    super(reason)
  }
}

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url')
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))

export function signAccessToken(input: { userId: string; sessionId: string; roles: Role[] }, now = Date.now()) {
  const iat = Math.floor(now / 1000)
  const claims: AccessClaims = {
    sub: input.userId,
    sid: input.sessionId,
    roles: input.roles,
    isActive: true,
    iss: config.auth.jwtIssuer,
    iat,
    exp: iat + config.auth.accessTokenTtl,
    jti: uuidv4()
  }
  const body = `${HEADER}.${b64(JSON.stringify(claims))}`
  const signature = hmac(config.auth.jwtSecret, body).toString('base64url')
  return { token: `${body}.${signature}`, claims }
}

export function verifyAccessToken(token: string, now = Date.now()): AccessClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new TokenVerificationError('malformed')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  let header: { alg?: string }
  let claims: AccessClaims
  try {
    header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  } catch {
    throw new TokenVerificationError('malformed')
  }
  if (header.alg !== 'HS256') throw new TokenVerificationError('unsupported_alg')

  const expected = hmac(config.auth.jwtSecret, `${headerPart}.${payloadPart}`)
  if (!safeEqual(expected, Buffer.from(signaturePart, 'base64url'))) throw new TokenVerificationError('invalid_signature')

  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') {
    throw new TokenVerificationError('malformed')
  }
  if (claims.exp * 1000 <= now) throw new TokenVerificationError('expired')
  return claims
}
