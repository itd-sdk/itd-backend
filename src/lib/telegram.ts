import { config } from '../config'
import { redis, rk } from '../redis'
import { badRequest } from './errors'
import { logger } from './logger'

/*
 * Contract with the bot (deploy/telegram-bot/bot.py), both sides share REDIS_URL and REDIS_PREFIX:
 *   <prefix>tg:chats   hash  username (lowercase, no @) -> chat id, written by the bot on /start
 *   <prefix>tg:outbox  list  JSON {chatId, text, expiresAt}, pushed here and popped (BLPOP) by the bot
 */
const CHATS = () => rk('tg', 'chats')
const OUTBOX = () => rk('tg', 'outbox')

const USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/

/** Accepts "nick", "@nick" or a t.me link; returns the lowercase username without @ */
export function normalizeTelegram(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//, '')
    .replace(/^@/, '')
}

export function assertTelegram(username: string) {
  if (!USERNAME_RE.test(username)) throw badRequest('Введите ник в Telegram, например @durov', 'INVALID_TELEGRAM')
}

export const botMention = () => `@${config.telegram.botUsername}`

/** Chat id of a user who pressed /start in the bot */
export async function findTelegramChat(username: string) {
  return redis.hget(CHATS(), username)
}

export async function requireTelegramChat(username: string) {
  const chatId = await findTelegramChat(username)
  if (!chatId) {
    throw badRequest(`Откройте Telegram-бота ${botMention()}, нажмите «Старт» и попробуйте снова`, 'TELEGRAM_NOT_STARTED')
  }
  return chatId
}

export async function sendTelegram(chatId: string, text: string, ttlSeconds: number) {
  await redis.rpush(OUTBOX(), JSON.stringify({ chatId, text, expiresAt: Date.now() + ttlSeconds * 1000 }))
  logger.info('telegram message queued', { chatId, ...(config.auth.exposeOtp ? { text } : {}) })
}

const escapeHtml = (value: string) => value.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)

export function otpMessage(code: string, purpose: 'signup' | 'login' | 'reset', device?: string | null) {
  const action = { signup: 'регистрации в ИТД', login: 'входа в ИТД', reset: 'восстановления пароля в ИТД' }[purpose]
  const minutes = Math.round(config.auth.otpTtl / 60)
  const lines = [`<b>${code}</b> — код для ${action}.`, '', `Код действует ${minutes} мин. Никому его не сообщайте.`]
  if (device) lines.push(`Устройство: ${escapeHtml(device)}`)
  lines.push('Если это были не вы, просто проигнорируйте сообщение.')
  return lines.join('\n')
}
