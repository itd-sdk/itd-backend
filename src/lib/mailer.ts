import { logger } from './logger'

export type Mail = { to: string; subject: string; text: string }

/**
 * Outgoing mail transport. The default implementation logs messages, which is enough for local
 * development (OTP codes show up in the server log). Plug a real provider in `send`.
 */
export const mailer = {
  async send(mail: Mail) {
    logger.info('mail', { to: mail.to, subject: mail.subject, text: mail.text })
  }
}

export function otpMail(to: string, code: string, purpose: 'signup' | 'login' | 'reset'): Mail {
  const subject = purpose === 'reset' ? 'Восстановление пароля в ИТД' : 'Код подтверждения ИТД'
  return { to, subject, text: `Ваш код: ${code}. Он действует 15 минут.` }
}
