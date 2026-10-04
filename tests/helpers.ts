import { sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import { config } from '../src/config'
import { db } from '../src/db/client'
import { seedReferenceData } from '../src/db/seed'
import { redis, rk } from '../src/redis'

export const app = createApp()

type Options = { body?: unknown; token?: string; headers?: Record<string, string>; form?: FormData; cookie?: string; raw?: RequestInit['body'] }
export type ApiResponse<T = any> = { status: number; body: T; headers: Headers; cookies: Record<string, string> }

let ipCounter = 1
/** Every test file gets its own client ip so per-ip endpoint limits do not leak between files */
const fileIp = `10.0.${Math.floor(Math.random() * 250)}.${(ipCounter++ % 250) + 1}`

export async function api<T = any>(method: string, path: string, options: Options = {}): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { 'x-forwarded-for': fileIp, ...options.headers }
  let body: RequestInit['body'] | undefined
  if (options.form) body = options.form
  else if (options.raw !== undefined) body = options.raw
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] ??= 'application/json'
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (options.cookie) headers.cookie = options.cookie
  const res = await app.handle(new Request(`http://localhost/api${path}`, { method, headers, body }))
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  const cookies: Record<string, string> = {}
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';')
    const index = pair!.indexOf('=')
    cookies[pair!.slice(0, index)] = pair!.slice(index + 1)
  }
  return { status: res.status, body: parsed, headers: res.headers, cookies }
}

export async function resetState() {
  const tables = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`)
  if (tables.length) await db.execute(sql.raw(`truncate table ${tables.map((t) => `"${t.tablename}"`).join(', ')} restart identity cascade`))
  const keys = await redis.keys(`${config.redisPrefix}*`)
  if (keys.length) await redis.del(...keys)
  await seedReferenceData()
}

let chatCounter = 1000
/** What the Telegram bot does on /start: remembers the chat of a username */
export async function pressStart(telegram: string, chatId = String(++chatCounter)) {
  await redis.hset(rk('tg', 'chats'), telegram.toLowerCase(), chatId)
  return chatId
}

/** Messages queued for the bot */
export async function botOutbox() {
  const items = await redis.lrange(rk('tg', 'outbox'), 0, -1)
  return items.map((item) => JSON.parse(item) as { chatId: string; text: string; expiresAt: number })
}

let userCounter = 0
export type TestUser = { token: string; refresh: string; id: string; username: string; telegram: string; password: string; avatar: string }

/** Registers (with a Telegram code) and creates a profile */
export async function createUser(options: { name?: string; avatar?: string; userAgent?: string } = {}): Promise<TestUser> {
  userCounter++
  const name = options.name ?? `user${userCounter}${Math.random().toString(36).slice(2, 6)}`
  const telegram = name.toLowerCase()
  const password = 'correct-horse-battery'
  const headers = options.userAgent ? { 'user-agent': options.userAgent } : undefined
  await pressStart(telegram)
  const signUp = await api('POST', '/v1/auth/sign-up', { body: { telegram, password }, headers })
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${JSON.stringify(signUp.body)}`)
  const verified = await api('POST', '/v1/auth/verify-otp', { body: { telegram, otp: signUp.body.otp, flowToken: signUp.body.flowToken }, headers })
  if (verified.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verified.body)}`)
  const token = verified.body.accessToken
  const avatar = options.avatar ?? '🐱'
  const profile = await api('POST', '/users/profile', { token, body: { username: name, displayName: name, avatar } })
  if (profile.status !== 201) throw new Error(`profile failed: ${JSON.stringify(profile.body)}`)
  return { token, refresh: verified.cookies.refresh_token!, id: profile.body.id, username: name, telegram, password, avatar }
}

export async function createPost(user: TestUser, body: Record<string, unknown> | string) {
  const res = await api('POST', '/posts', { token: user.token, body: typeof body === 'string' ? { content: body } : body })
  if (res.status !== 201) throw new Error(`post failed: ${JSON.stringify(res.body)}`)
  return res.body
}

export const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082',
  'hex'
)

export function uploadForm(bytes: Uint8Array, name: string, type = 'application/octet-stream') {
  const form = new FormData()
  form.append('file', new File([bytes], name, { type }))
  return form
}
