import { and, inArray, isNull, sql } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import { posts } from '../db/schema'
import { randomToken } from '../lib/crypto'
import { redis, rk } from '../redis'
import { type PostRow, visibleAuthorCondition } from './posts'

// The popular feed is ranked globally and stored as versioned snapshots in Redis, so that
// pagination stays stable while scores keep changing. Cursor format: "<version>.<offset>".
const CURRENT_KEY = rk('feed', 'popular', 'current')
const LOCK_KEY = rk('lock', 'feed', 'popular')
const listKey = (version: string) => rk('feed', 'popular', version)
const SNAPSHOT_TTL = 60 * 60
const SNAPSHOT_SIZE = 1000
const SENTINEL = '#'

async function rank(windowDays: number | null) {
  const rows = await db.execute<{ id: string }>(sql`
    select p.id from ${posts} p join users u on u.id = p.author_id
    where p.deleted_at is null and p.wall_recipient_id is null and p.original_post_id is null
      and u.deleted_at is null and not u.is_banned and not u.is_private
      ${windowDays ? sql`and p.created_at > now() - make_interval(days => ${windowDays})` : sql``}
    order by (p.likes_count + 2 * p.comments_count + 3 * p.reposts_count + p.views_count / 20.0 + 1)
      / power(extract(epoch from (now() - p.created_at)) / 3600 + 2, 1.5) desc, p.created_at desc
    limit ${SNAPSHOT_SIZE}
  `)
  return rows.map((r) => r.id)
}

async function buildSnapshot() {
  let ids = await rank(config.content.popularWindowDays)
  // small communities: fall back to all-time ranking so the feed is never empty
  if (ids.length < 50) ids = await rank(null)
  const version = Date.now().toString(36) + randomToken(3).replace(/[^a-zA-Z0-9]/g, 'x')
  await redis
    .multi()
    .rpush(listKey(version), SENTINEL, ...ids)
    .expire(listKey(version), SNAPSHOT_TTL)
    .set(CURRENT_KEY, JSON.stringify({ version, builtAt: Date.now() }))
    .exec()
  return version
}

async function currentVersion() {
  const raw = await redis.get(CURRENT_KEY)
  const current = raw ? (JSON.parse(raw) as { version: string; builtAt: number }) : null
  const usable = current ? (await redis.exists(listKey(current.version))) === 1 : false
  if (current && usable && Date.now() - current.builtAt < config.content.popularRebuildSeconds * 1000) return current.version

  const locked = await redis.set(LOCK_KEY, '1', 'EX', 30, 'NX')
  if (!locked && current && usable) return current.version // another request is rebuilding: serve the previous snapshot
  try {
    return await buildSnapshot()
  } finally {
    if (locked) await redis.del(LOCK_KEY)
  }
}

export async function popularPage(viewerId: string | null, cursor: string | undefined, limit: number) {
  let version: string | undefined
  let offset = 0
  const match = cursor?.match(/^([a-zA-Z0-9]+)\.(\d+)$/)
  if (match) {
    version = match[1]
    offset = Number(match[2])
  }
  if (!version || (await redis.exists(listKey(version))) === 0) version = await currentVersion()

  const total = (await redis.llen(listKey(version))) - 1
  const collected: PostRow[] = []
  let position = offset
  while (collected.length < limit && position < total) {
    const batch = await redis.lrange(listKey(version), position + 1, position + limit * 2)
    if (batch.length === 0) break
    const rows = await db
      .select()
      .from(posts)
      .where(and(inArray(posts.id, batch), isNull(posts.deletedAt), visibleAuthorCondition(viewerId)))
    const byId = new Map(rows.map((row) => [row.id, row]))
    for (const id of batch) {
      position++
      const row = byId.get(id)
      if (row) collected.push(row)
      if (collected.length >= limit) break
    }
  }
  const hasMore = position < total
  return { rows: collected, hasMore, nextCursor: hasMore ? `${version}.${position}` : null }
}

export async function invalidatePopularFeed() {
  await redis.del(CURRENT_KEY)
}
