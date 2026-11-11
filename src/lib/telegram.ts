import { config } from '../config'
import { redis, rk } from '../redis'
import { badRequest } from './errors'
import { logger } from './logger'

/*
 * Contract with the bot (deploy/telegram-bot/bot.py), both sides share REDIS_URL and REDIS_PREFIX:
 *   <prefix>tg:chats   hash  username (lowercase, no @) -> chat id, written by the bot on /start
 *   <prefix>tg:usernames hash chat id -> username
 *   <prefix>tg:outbox  list  JSON {chatId, text, expiresAt}, pushed here and popped (BLPOP) by the bot
 *   <prefix>tg:phones  hash  phone (+digits) -> chat id, written by the bot when a user shares their own contact
 *   <prefix>tg:chatphones hash chat id -> phone
 */
const CHATS = () => rk('tg', 'chats')
const OUTBOX = () => rk('tg', 'outbox')
const PHONES = () => rk('tg', 'phones')
const USERNAMES = () => rk('tg', 'usernames')
const CHAT_PHONES = () => rk('tg', 'chatphones')

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

/** "+7 (999) 123-45-67", "89991234567" or "79991234567" -> "+79991234567"; null when it is not a phone number */
export function normalizePhone(value: string) {
  const compact = value.trim().replace(/[\s()-]/g, '')
  if (!/^\+?\d{10,15}$/.test(compact)) return null
  let digits = compact.replace(/^\+/, '')
  // a Russian number typed with the trunk prefix 8
  if (!compact.startsWith('+') && digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`
  return `+${digits}`
}

/** Chat of the Telegram account that shared this number with the bot */
export async function findPhoneChat(phone: string) {
  return redis.hget(PHONES(), phone)
}

/** The number a chat shared with the bot */
export async function findChatPhone(chatId: string) {
  return redis.hget(CHAT_PHONES(), chatId)
}

/** Telegram username of a chat (null when the account has none) */
export async function findChatUsername(chatId: string) {
  return redis.hget(USERNAMES(), chatId)
}

export async function requirePhoneChat(phone: string) {
  const chatId = await findPhoneChat(phone)
  if (!chatId) {
    throw badRequest(`Откройте Telegram-бота ${botMention()} и нажмите «Поделиться номером» с этим номером`, 'PHONE_NOT_SHARED')
  }
  return chatId
}

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

export type OtpPurpose = 'signup' | 'login' | 'reset' | 'phone_entry' | 'attach_phone' | 'change_phone' | 'change_telegram' | 'proof'

export function otpMessage(code: string, purpose: OtpPurpose, device?: string | null) {
  const action = {
    signup: 'регистрации в ИТД',
    login: 'входа в ИТД',
    reset: 'восстановления пароля в ИТД',
    phone_entry: 'входа в ИТД по номеру телефона',
    attach_phone: 'привязки номера к аккаунту ИТД',
    change_phone: 'смены номера в ИТД',
    change_telegram: 'смены Telegram в ИТД',
    proof: 'подтверждения смены Telegram или номера в ИТД'
  }[purpose]
  const minutes = Math.round(config.auth.otpTtl / 60)
  const lines = [`<b>${code}</b> — код для ${action}.`, '', `Код действует ${minutes} мин. Никому его не сообщайте.`]
  if (device) lines.push(`Устройство: ${escapeHtml(device)}`)
  lines.push('Если это были не вы, просто проигнорируйте сообщение.')
  return lines.join('\n')
}
