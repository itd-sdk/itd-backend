import { config } from '../config'
import { ApiError, rateLimited } from '../lib/errors'
import { randomToken } from '../lib/crypto'
import { redis, rk } from '../redis'

const TOKEN_BUCKET = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then tokens = capacity; ts = now end
tokens = math.min(capacity, tokens + math.max(0, now - ts) * rate)
local allowed = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], ARGV[4])
local retry = 0
if allowed == 0 then retry = math.ceil((1 - tokens) / rate) end
return {allowed, math.floor(tokens), retry}
`

const SLIDING_WINDOW = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - 60000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, now - 3600000)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, math.ceil((tonumber(oldest[2]) + 60000 - now) / 1000)}
end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[3]) then
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {0, math.ceil((tonumber(oldest[2]) + 3600000 - now) / 1000)}
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('ZADD', KEYS[2], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], 60000)
redis.call('PEXPIRE', KEYS[2], 3600000)
return {1, 0}
`

redis.defineCommand('itdTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET })
redis.defineCommand('itdSlidingWindow', { numberOfKeys: 2, lua: SLIDING_WINDOW })

type LimiterRedis = typeof redis & {
  itdTokenBucket(key: string, capacity: number, ratePerMs: number, now: number, ttlMs: number): Promise<[number, number, number]>
  itdSlidingWindow(minuteKey: string, hourKey: string, now: number, perMinute: number, perHour: number, member: string): Promise<[number, number]>
}
const limiterRedis = redis as LimiterRedis

const scale = (value: number) => Math.max(1, Math.round(value * config.rateLimit.multiplier))

export type EndpointLimitResult = { allowed: boolean; limit: number; remaining: number; retryAfterMs: number }

/**
 * Per-IP endpoint limit. Endpoints with the same limit share one bucket,
 * matching the `x-ratelimit-limit` / `x-ratelimit-remaining` semantics of the official API.
 */
export async function consumeEndpointLimit(ip: string, limit: number): Promise<EndpointLimitResult> {
  const capacity = scale(limit)
  const [allowed, remaining, retryAfterMs] = await limiterRedis.itdTokenBucket(rk('rl', 'ip', capacity, ip), capacity, capacity / 60_000, Date.now(), 120_000)
  return { allowed: allowed === 1, limit: capacity, remaining, retryAfterMs }
}

export type ActionName = 'like' | 'comment' | 'follow' | 'repost' | 'post' | 'search' | 'report' | 'upload' | 'sign_in' | 'otp' | 'vote'

const ACTIONS: Record<ActionName, { perMinute: number; perHour: number; message: string }> = {
  like: { perMinute: 30, perHour: 200, message: 'Слишком много лайков. Повторите позже.' },
  comment: { perMinute: 5, perHour: 75, message: 'Слишком много комментариев. Повторите позже.' },
  follow: { perMinute: 5, perHour: 20, message: 'Слишком много подписок. Повторите позже.' },
  repost: { perMinute: 5, perHour: 25, message: 'Слишком много репостов. Повторите позже.' },
  post: { perMinute: 5, perHour: 25, message: 'Слишком много постов. Повторите позже.' },
  search: { perMinute: 30, perHour: 600, message: 'Слишком много поисковых запросов. Повторите позже.' },
  report: { perMinute: 5, perHour: 30, message: 'Слишком много жалоб. Повторите позже.' },
  upload: { perMinute: 20, perHour: 200, message: 'Слишком много загрузок. Повторите позже.' },
  vote: { perMinute: 20, perHour: 200, message: 'Слишком много голосов. Повторите позже.' },
  sign_in: { perMinute: 10, perHour: 60, message: 'Слишком много попыток входа. Повторите позже.' },
  otp: { perMinute: 3, perHour: 20, message: 'Слишком много запросов кода. Повторите позже.' }
}

/** Per-account (or per-ip for auth) action limits, minute + hour sliding windows */
export async function enforceActionLimit(action: ActionName, subject: string) {
  if (!config.rateLimit.enabled) return
  const rule = ACTIONS[action]
  const now = Date.now()
  const [allowed, retryAfter] = await limiterRedis.itdSlidingWindow(
    rk('rl', 'act', action, 'm', subject),
    rk('rl', 'act', action, 'h', subject),
    now,
    scale(rule.perMinute),
    scale(rule.perHour),
    `${now}-${randomToken(6)}`
  )
  if (allowed !== 1) throw rateLimited(rule.message, Math.max(1, retryAfter))
}

export const tooManyRequests = (retryAfterMs: number) =>
  new ApiError(429, null, 'Too Many Requests', {}, { error: 'Too Many Requests' }, { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) })
