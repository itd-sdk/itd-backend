import { inArray } from 'drizzle-orm'
import { db } from '../db/client'
import { posts } from '../db/schema'
import { redis, rk } from '../redis'

// Hot counters for /posts/stats (clients poll it every few seconds for visible posts)
const TTL_SECONDS = 60
const key = (postId: string) => rk('ps', postId)

export type PostCounters = { likesCount: number; commentsCount: number; repostsCount: number; viewsCount: number; dominantEmoji: string | null }

const FIELD = { likesCount: 'l', commentsCount: 'c', repostsCount: 'r', viewsCount: 'v' } as const
export type CounterField = keyof typeof FIELD

redis.defineCommand('itdIncrIfExists', {
  numberOfKeys: 1,
  lua: `if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('HINCRBY', KEYS[1], ARGV[1], ARGV[2]) end return nil`
})
redis.defineCommand('itdSetIfExists', {
  numberOfKeys: 1,
  lua: `if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) end return nil`
})
type StatsRedis = typeof redis & {
  itdIncrIfExists(key: string, field: string, delta: number): Promise<number | null>
  itdSetIfExists(key: string, field: string, value: string): Promise<null>
}
const statsRedis = redis as StatsRedis

export async function getCounters(ids: string[]): Promise<Map<string, PostCounters>> {
  const result = new Map<string, PostCounters>()
  if (ids.length === 0) return result

  const pipeline = redis.pipeline()
  for (const id of ids) pipeline.hgetall(key(id))
  const cached = (await pipeline.exec()) ?? []
  const misses: string[] = []
  ids.forEach((id, index) => {
    const hash = cached[index]?.[1] as Record<string, string> | undefined
    if (hash && hash.l !== undefined) {
      result.set(id, {
        likesCount: Number(hash.l),
        commentsCount: Number(hash.c),
        repostsCount: Number(hash.r),
        viewsCount: Number(hash.v),
        dominantEmoji: hash.d || null
      })
    } else misses.push(id)
  })

  if (misses.length) {
    const rows = await db
      .select({
        id: posts.id,
        likesCount: posts.likesCount,
        commentsCount: posts.commentsCount,
        repostsCount: posts.repostsCount,
        viewsCount: posts.viewsCount,
        dominantEmoji: posts.dominantEmoji
      })
      .from(posts)
      .where(inArray(posts.id, misses))
    const write = redis.pipeline()
    for (const row of rows) {
      const { id, ...counters } = row
      result.set(id, counters)
      write.hset(key(id), { l: row.likesCount, c: row.commentsCount, r: row.repostsCount, v: row.viewsCount, d: row.dominantEmoji ?? '' })
      write.expire(key(id), TTL_SECONDS)
    }
    await write.exec()
  }
  return result
}

export async function bumpCounter(postId: string, field: CounterField, delta: number) {
  await statsRedis.itdIncrIfExists(key(postId), FIELD[field], delta).catch(() => null)
}

export async function setDominantEmoji(postId: string, emoji: string | null) {
  await statsRedis.itdSetIfExists(key(postId), 'd', emoji ?? '').catch(() => null)
}

export async function dropCounters(postId: string) {
  await redis.del(key(postId)).catch(() => 0)
}
