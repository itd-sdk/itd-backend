import { eq, inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { users } from '../db/schema'
import { errorMeta, logger } from '../lib/logger'
import { ONLINE_WINDOW_MS } from '../lib/time'
import { redis, rk } from '../redis'

const PERSIST_EVERY_SECONDS = 300

/** Marks the user as active; persisted to Postgres at most once per 5 minutes */
export async function touchPresence(userId: string) {
  const now = Date.now()
  try {
    const [, persist] = await Promise.all([
      redis.set(rk('lastseen', userId), now, 'EX', 60 * 60 * 24 * 31),
      redis.set(rk('lastseen', 'persist', userId), 1, 'EX', PERSIST_EVERY_SECONDS, 'NX')
    ])
    if (persist === 'OK') {
      await db.update(users).set({ lastSeenAt: new Date(now) }).where(eq(users.id, userId))
    }
  } catch (error) {
    logger.warn('presence update failed', errorMeta(error))
  }
}

export async function connectionOpened(userId: string) {
  await redis.multi().incr(rk('online', userId)).expire(rk('online', userId), 3600).exec()
  await touchPresence(userId)
}

export async function connectionClosed(userId: string) {
  const left = await redis.decr(rk('online', userId))
  if (left <= 0) await redis.del(rk('online', userId))
  await touchPresence(userId)
}

export type Presence = { lastSeenAt: Date | null; online: boolean }

export async function getPresence(rows: { id: string; lastSeenAt: Date | null }[]): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>()
  if (rows.length === 0) return result
  const keys = rows.flatMap((row) => [rk('lastseen', row.id), rk('online', row.id)])
  const values = await redis.mget(keys)
  const now = Date.now()
  rows.forEach((row, index) => {
    const cached = Number(values[index * 2])
    const connections = Number(values[index * 2 + 1] ?? 0)
    const lastSeenAt = Number.isFinite(cached) && cached > 0 ? new Date(cached) : row.lastSeenAt
    const online = connections > 0 || (lastSeenAt !== null && now - lastSeenAt.getTime() < ONLINE_WINDOW_MS)
    result.set(row.id, { lastSeenAt, online })
  })
  return result
}

export async function loadLastSeenRows(ids: string[]) {
  if (ids.length === 0) return []
  return db.select({ id: users.id, lastSeenAt: users.lastSeenAt }).from(users).where(inArray(users.id, ids))
}
