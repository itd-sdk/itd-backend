import { config } from '../../config'
import { ApiError, badRequest, notFound } from '../../lib/errors'
import { randomToken, safeEqual, sha256 } from '../../lib/crypto'
import { parseUserAgent } from '../../lib/useragent'
import { redis, rk } from '../../redis'
import { publish, qrChannel } from '../../services/realtime'
import type { ClientContext } from './service'

export type QrStatus = 'pending' | 'scanned' | 'approved' | 'rejected' | 'expired'

export type QrState = {
  status: QrStatus
  claimHash: string
  requester: ClientContext
  scannedBy: string | null
  accountId: string | null
  createdAt: number
}

const qrKey = (id: string) => rk('qr', id)

export async function startQr(requester: ClientContext) {
  const qrId = crypto.randomUUID()
  const claimToken = randomToken(32)
  const state: QrState = { status: 'pending', claimHash: sha256(claimToken), requester, scannedBy: null, accountId: null, createdAt: Date.now() }
  await redis.set(qrKey(qrId), JSON.stringify(state), 'EX', config.auth.qrTtl)
  return { qrId, claimToken, payload: `${config.publicUrl}/qr-login/${qrId}`, expiresIn: config.auth.qrTtl }
}

export async function loadQr(qrId: string) {
  const raw = await redis.get(qrKey(qrId))
  if (!raw) throw notFound('QR code not found or expired', 'QR_NOT_FOUND')
  return JSON.parse(raw) as QrState
}

export async function qrTtlMs(qrId: string) {
  return Math.max(0, await redis.pttl(qrKey(qrId)))
}

export function assertClaim(state: QrState, claimToken: string | undefined) {
  if (!claimToken || !safeEqual(sha256(claimToken), state.claimHash)) throw badRequest('Invalid claim token', 'QR_INVALID_CLAIM')
}

async function updateQr(qrId: string, state: QrState) {
  const ttl = await redis.pttl(qrKey(qrId))
  if (ttl <= 0) throw notFound('QR code not found or expired', 'QR_NOT_FOUND')
  await redis.set(qrKey(qrId), JSON.stringify(state), 'PX', ttl)
  await publish(qrChannel(qrId), 'status', { status: state.status })
}

export async function scanQr(qrId: string, accountId: string) {
  const state = await loadQr(qrId)
  if (state.status !== 'pending' && state.status !== 'scanned') throw new ApiError(409, 'QR_ALREADY_USED', 'QR code already used')
  state.status = 'scanned'
  state.scannedBy = accountId
  await updateQr(qrId, state)
  const device = parseUserAgent(state.requester.userAgent)
  return { ...device, ipAddress: state.requester.ip, ipCountry: state.requester.country }
}

export async function decideQr(qrId: string, accountId: string, approverDevice: 'desktop' | 'mobile', approve: boolean) {
  const state = await loadQr(qrId)
  if (approve && config.auth.qrRequireMobileApprover && approverDevice !== 'mobile') {
    throw new ApiError(403, 'QR_APPROVER_NOT_ALLOWED', 'QR approving is allowed only from mobile devices')
  }
  if (state.status !== 'pending' && state.status !== 'scanned') throw new ApiError(409, 'QR_ALREADY_USED', 'QR code already used')
  if (state.scannedBy && state.scannedBy !== accountId) throw new ApiError(409, 'QR_ALREADY_USED', 'QR code scanned by another account')
  state.status = approve ? 'approved' : 'rejected'
  state.accountId = approve ? accountId : null
  await updateQr(qrId, state)
}

export async function consumeQr(qrId: string) {
  await redis.del(qrKey(qrId))
}
