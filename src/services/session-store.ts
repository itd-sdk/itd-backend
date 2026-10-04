import { config } from '../config'
import { redis, rk } from '../redis'

/** Access tokens are stateless JWTs; revoked session ids are remembered until their tokens expire */
export async function markSessionsRevoked(sessionIds: string[]) {
  if (sessionIds.length === 0) return
  const pipeline = redis.pipeline()
  for (const id of sessionIds) pipeline.set(rk('sess', 'revoked', id), 1, 'EX', config.auth.accessTokenTtl + 60)
  await pipeline.exec()
}

export async function isSessionRevoked(sessionId: string) {
  return (await redis.exists(rk('sess', 'revoked', sessionId))) === 1
}
