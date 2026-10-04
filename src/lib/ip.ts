import { config } from '../config'

/** Normalizes IPv4-mapped / loopback IPv6 so clients that expect IPv4 keep working */
export function normalizeIp(ip: string | null | undefined) {
  if (!ip) return '127.0.0.1'
  const trimmed = ip.trim()
  if (trimmed === '::1' || trimmed === '::') return '127.0.0.1'
  const mapped = trimmed.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  return mapped ? mapped[1]! : trimmed
}

export function resolveClientIp(headers: Headers, socketIp: string | null | undefined) {
  if (config.trustProxy) {
    const forwarded = headers.get('cf-connecting-ip') ?? headers.get('x-real-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]
    if (forwarded) return normalizeIp(forwarded)
  }
  return normalizeIp(socketIp)
}

export function resolveCountry(headers: Headers) {
  if (!config.trustProxy) return null
  const country = headers.get('cf-ipcountry') ?? headers.get('x-country-code')
  return country && /^[A-Z]{2}$/i.test(country) && country.toUpperCase() !== 'XX' ? country.toUpperCase() : null
}
