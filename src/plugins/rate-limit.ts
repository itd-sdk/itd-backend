import { Elysia } from 'elysia'
import { config } from '../config'
import { errorMeta, logger } from '../lib/logger'
import { consumeEndpointLimit, tooManyRequests } from '../services/rate-limit'
import { contextPlugin } from './context'

type Rule = { method?: string; pattern: RegExp; limit: number }

// Requests per minute per IP. Endpoints sharing a limit value share one bucket.
const RULES: Rule[] = [
  { method: 'GET', pattern: /^\/api\/hashtags\/trending/, limit: 13 },
  { pattern: /^\/api\/v1\/auth\/(sign-in|sign-up|verify-otp|resend-otp|forgot-password|reset-password|change-password)/, limit: 20 },
  { pattern: /^\/api\/v1\/auth\/qr/, limit: 30 },
  { pattern: /^\/api\/search/, limit: 30 },
  { pattern: /^\/api\/files/, limit: 30 },
  { pattern: /^\/api\/users/, limit: 40 },
  { pattern: /^\/api\/notifications/, limit: 60 },
  { pattern: /^\/api\/v1\/auth/, limit: 60 },
  { pattern: /^\/api\/(posts|hashtags|comments)/, limit: 150 },
  { pattern: /^\/api\/v1\/(i|x)$/, limit: 300 }
]
const DEFAULT_LIMIT = 100

export function limitFor(method: string, route: string) {
  return RULES.find((rule) => (!rule.method || rule.method === method) && rule.pattern.test(route))?.limit ?? DEFAULT_LIMIT
}

export const rateLimitPlugin = new Elysia({ name: 'rate-limit' })
  .use(contextPlugin)
  .onTransform({ as: 'global' }, async ({ request, route, set, ip }) => {
    if (!config.rateLimit.enabled || !route?.startsWith('/api/')) return
    if (route === '/api/notifications/stream') return

    let result
    try {
      result = await consumeEndpointLimit(ip, limitFor(request.method, route))
    } catch (error) {
      // fail open: an unavailable limiter must not take the API down
      logger.warn('rate limiter unavailable', errorMeta(error))
      return
    }
    set.headers['x-ratelimit-limit'] = String(result.limit)
    set.headers['x-ratelimit-remaining'] = String(result.remaining)
    if (!result.allowed) throw tooManyRequests(result.retryAfterMs)
  })
