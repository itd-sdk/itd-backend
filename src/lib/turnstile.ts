import { config } from '../config'
import { errorMeta, logger } from './logger'

/** Verifies a Cloudflare Turnstile token. Without TURNSTILE_SECRET captcha checks are disabled. */
export async function verifyTurnstile(token: string | undefined, ip: string) {
  const secret = config.auth.turnstileSecret
  if (!secret) return true
  if (!token) return false
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret, response: token, remoteip: ip })
    })
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch (error) {
    logger.error('turnstile verification failed', errorMeta(error))
    return false
  }
}
