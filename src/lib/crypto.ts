import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** Refresh token as the official server issues it: 64 lowercase hex characters */
export const randomHexToken = (bytes = 32) => randomBytes(bytes).toString('hex')

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export const hmac = (secret: string, value: string | Buffer) => createHmac('sha256', secret).update(value).digest()

export function safeEqual(a: string | Buffer, b: string | Buffer) {
  const left = typeof a === 'string' ? Buffer.from(a) : a
  const right = typeof b === 'string' ? Buffer.from(b) : b
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Numeric one-time code, e.g. "042317" */
export const randomOtp = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0')

/** Short content hash: red pens and correctors are bound to the text they were applied to */
export const contentRevision = (content: string) => sha256(content)
