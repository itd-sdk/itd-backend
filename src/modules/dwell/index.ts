import { gunzipSync, inflateRawSync, inflateSync } from 'node:zlib'
import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { posts, postViews } from '../../db/schema'
import { badRequest } from '../../lib/errors'
import { readViewToken } from '../../lib/view-token'
import { authPlugin } from '../../plugins/auth'
import { redis, rk } from '../../redis'
import { bumpCounter } from '../../services/post-stats'

const MIN_VIEW_MS = 250
const MAX_BODY = 256 * 1024

/** The web client deflates large batches (Content-Encoding: deflate) */
async function parseBatch({ request }: { request: Request }) {
  const raw = Buffer.from(await request.arrayBuffer())
  if (raw.length > MAX_BODY) throw badRequest('Batch is too large')
  const encoding = request.headers.get('content-encoding')?.toLowerCase()
  let text: string
  try {
    if (encoding === 'deflate') {
      try {
        text = inflateSync(raw).toString('utf8')
      } catch {
        text = inflateRawSync(raw).toString('utf8')
      }
    } else if (encoding === 'gzip') text = gunzipSync(raw).toString('utf8')
    else text = raw.toString('utf8')
    return text ? JSON.parse(text) : {}
  } catch {
    throw badRequest('Invalid batch body')
  }
}

const ViewEvent = t.Object(
  {
    v: t.String({ maxLength: 256 }),
    md: t.Optional(t.Number()),
    et: t.Optional(t.Number()),
    xt: t.Optional(t.Number()),
    r: t.Optional(t.Number()),
    s: t.Optional(t.Number()),
    sc: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
    b: t.Optional(t.Union([t.Number(), t.Boolean()]))
  },
  { additionalProperties: true }
)

const InteractionEvent = t.Object(
  {
    v: t.String({ maxLength: 256 }),
    s: t.Optional(t.Number()),
    t: t.Number(),
    ai: t.String({ maxLength: 64 }),
    mi: t.Optional(t.Nullable(t.Number())),
    pm: t.Optional(t.Number()),
    dm: t.Optional(t.Number())
  },
  { additionalProperties: true }
)

const noContent = () => new Response(null, { status: 204 })

/** Records unique views; the author's own views mark the post as viewed but are not counted */
async function recordViews(userId: string, postIds: string[]) {
  if (postIds.length === 0) return
  const counted = await db.execute<{ id: string }>(sql`
    with inserted as (
      insert into ${postViews} (post_id, user_id)
      select p.id, ${userId}::uuid from ${posts} p where p.id = any(${sql.param(postIds)}::uuid[]) and p.deleted_at is null
      on conflict do nothing
      returning post_id
    )
    update ${posts} set views_count = views_count + 1
    where id in (select post_id from inserted) and author_id <> ${userId}
    returning id
  `)
  for (const row of counted) await bumpCounter(row.id, 'viewsCount', 1)
}

export const dwellModule = new Elysia({ prefix: '/v1', tags: ['Dwell'] })
  .use(authPlugin)
  .post(
    '/i',
    async ({ body, me }) => {
      if (!me) return noContent()
      const postIds = new Set<string>()
      for (const event of body.e) {
        const token = readViewToken(event.v)
        if (!token || token.viewerId !== me.id) continue
        if ((event.md ?? 0) < MIN_VIEW_MS) continue
        postIds.add(token.postId)
      }
      await recordViews(me.id, [...postIds])
      return noContent()
    },
    {
      optionalUser: true,
      parse: parseBatch,
      body: t.Object({ sid: t.Optional(t.String({ maxLength: 64 })), e: t.Array(ViewEvent, { maxItems: 200 }) }),
      detail: { summary: 'Post view (dwell) events; `v` is the post `vs` token' }
    }
  )
  .post(
    '/x',
    async ({ body, me }) => {
      if (!me) return noContent()
      const pipeline = redis.pipeline()
      for (const event of body.e) {
        const token = readViewToken(event.v)
        if (!token || token.viewerId !== me.id) continue
        const key = rk('interactions', token.postId)
        if (event.t === 1) pipeline.hincrby(key, `photo_open:${event.ai}`, 1)
        else if (event.t === 2) pipeline.hincrby(key, `video_ms:${event.ai}`, Math.max(0, Math.round(event.pm ?? 0)))
        pipeline.expire(key, 60 * 60 * 24 * 30)
      }
      await pipeline.exec()
      return noContent()
    },
    {
      optionalUser: true,
      parse: parseBatch,
      body: t.Object({ sid: t.Optional(t.String({ maxLength: 64 })), e: t.Array(InteractionEvent, { maxItems: 200 }) }),
      detail: { summary: 'Attachment interactions: photo opens (t=1), video progress (t=2)' }
    }
  )
