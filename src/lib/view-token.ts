import { config } from '../config'
import { hmac, safeEqual } from './crypto'

// "vs" token attached to every post: lets /v1/i attribute dwell events to (post, viewer) without trusting the client
const secret = hmac(config.auth.jwtSecret, 'view-session').toString('hex')
const ZERO = '00000000000000000000000000000000'

const uuidToBytes = (id: string | null) => Buffer.from((id ?? ZERO).replaceAll('-', ''), 'hex')
const bytesToUuid = (bytes: Buffer) => {
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function issueViewToken(postId: string, viewerId: string | null, now = Date.now()) {
  const payload = Buffer.alloc(36)
  uuidToBytes(postId).copy(payload, 0)
  uuidToBytes(viewerId).copy(payload, 16)
  payload.writeUInt32BE(Math.floor(now / 1000), 32)
  const signature = hmac(secret, payload).subarray(0, 12)
  return `${payload.toString('base64url')}.${signature.toString('base64url')}`
}

export function readViewToken(token: string) {
  const [payloadPart, signaturePart] = token.split('.')
  if (!payloadPart || !signaturePart) return null
  const payload = Buffer.from(payloadPart, 'base64url')
  if (payload.length !== 36) return null
  if (!safeEqual(hmac(secret, payload).subarray(0, 12), Buffer.from(signaturePart, 'base64url'))) return null
  const viewer = payload.subarray(16, 32)
  return {
    postId: bytesToUuid(payload.subarray(0, 16)),
    viewerId: viewer.equals(Buffer.alloc(16)) ? null : bytesToUuid(viewer),
    issuedAt: payload.readUInt32BE(32) * 1000
  }
}
