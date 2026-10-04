import { desc, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { hashtags, postHashtags, posts } from '../../db/schema'
import { uriTooLong } from '../../lib/errors'
import { normalizeHashtag } from '../../lib/text'
import { authPlugin } from '../../plugins/auth'
import { redis, rk } from '../../redis'
import { CursorPaginationModel, HashtagModel, PostModel } from '../../schemas'
import { hashtagPosts } from '../posts/service'

const TRENDING_TTL = 60

async function trending(limit: number) {
  const cacheKey = rk('cache', 'trending', limit)
  const cached = await redis.get(cacheKey)
  if (cached) return JSON.parse(cached) as { id: string; name: string; postsCount: number }[]

  // tags used most in the last 24 hours, then all-time popular ones to fill the list
  const recent = await db.execute<{ id: string; name: string; posts_count: number }>(sql`
    select h.id, h.name, h.posts_count from ${postHashtags} ph
    join ${hashtags} h on h.id = ph.hashtag_id
    join ${posts} p on p.id = ph.post_id and p.deleted_at is null
    where ph.created_at > now() - interval '24 hours' and h.posts_count > 0
    group by h.id order by count(*) desc, h.posts_count desc limit ${limit}
  `)
  const result = recent.map((r) => ({ id: r.id, name: r.name, postsCount: r.posts_count }))
  if (result.length < limit) {
    const seen = new Set(result.map((r) => r.id))
    const popular = await db
      .select({ id: hashtags.id, name: hashtags.name, postsCount: hashtags.postsCount })
      .from(hashtags)
      .where(sql`${hashtags.postsCount} > 0`)
      .orderBy(desc(hashtags.postsCount), desc(hashtags.lastUsedAt))
      .limit(limit * 2)
    for (const tag of popular) if (result.length < limit && !seen.has(tag.id)) result.push(tag)
  }
  await redis.set(cacheKey, JSON.stringify(result), 'EX', TRENDING_TTL)
  return result
}

export const hashtagsModule = new Elysia({ tags: ['Hashtags'] })
  .use(authPlugin)
  .get('/hashtags/trending', async ({ query }) => ({ data: { hashtags: await trending(query.limit ?? 10) } }), {
    query: t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })) }),
    response: t.Object({ data: t.Object({ hashtags: t.Array(HashtagModel) }) }),
    detail: { summary: 'Trending hashtags' }
  })
  .get(
    '/hashtags/:hashtag/posts',
    async ({ params, query, me }) => {
      const name = normalizeHashtag(decodeURIComponent(params.hashtag))
      if (name.length > 64) throw uriTooLong('Hashtag is too long')
      return hashtagPosts(name, me, query.cursor, query.limit ?? 20)
    },
    {
      optionalUser: true,
      params: t.Object({ hashtag: t.String({ maxLength: 1024 }) }),
      query: t.Object({ cursor: t.Optional(t.String({ maxLength: 256 })), limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })) }),
      response: t.Object({
        data: t.Object({ hashtag: t.Nullable(HashtagModel), posts: t.Array(PostModel), pagination: CursorPaginationModel })
      }),
      detail: { summary: 'Posts with a hashtag (hashtag is null when it does not exist)' }
    }
  )
