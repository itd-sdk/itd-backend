import { Elysia } from 'elysia'
import { resolveClientIp, resolveCountry } from '../lib/ip'

/** Request metadata shared by all modules: client ip, device id, user agent */
export const contextPlugin = new Elysia({ name: 'context' }).derive({ as: 'global' }, ({ request, server }) => {
  const headers = request.headers
  return {
    ip: resolveClientIp(headers, server?.requestIP(request)?.address),
    country: resolveCountry(headers),
    deviceId: headers.get('x-device-id')?.slice(0, 128) ?? null,
    userAgent: headers.get('user-agent')?.slice(0, 512) ?? null
  }
})
