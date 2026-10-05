import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { authPlugin } from '../../plugins/auth'
import { Enum, PollModel, PostModel, PostsPageModel, PostStatsModel, PostWithCommentsModel, SpanInputModel, SpanModel, SuccessModel, Uuid } from '../../schemas'
import { presentPost, requireVisiblePost } from '../../services/posts'
import { requireTargetUser } from '../../services/users'
import { listComments } from '../comments/service'
import {
  createPost,
  deletePost,
  editPost,
  feed,
  likedPosts,
  likePost,
  pinPost,
  postStats,
  repost,
  restorePost,
  unlikePost,
  unpinPost,
  unrepost,
  userWall,
  vote
} from './service'

const IdParams = t.Object({ id: Uuid })
const LikeResult = t.Object({ liked: t.Boolean(), likesCount: t.Integer() })
const PageLimit = t.Optional(t.Integer({ minimum: 1, maximum: 50 }))
const Cursor = t.Optional(t.String({ maxLength: 256 }))

const PollInput = t.Object({
  question: t.String({ maxLength: 255 }),
  options: t.Array(t.Object({ text: t.String({ maxLength: 100 }) }), { minItems: 2, maxItems: 10 }),
  multipleChoice: t.Optional(t.Boolean()),
  multiple: t.Optional(t.Boolean())
})

export const postsModule = new Elysia({ tags: ['Posts'] })
  .use(authPlugin)

  .get('/posts', ({ query, me }) => feed(me, query.tab ?? 'popular', query.cursor, query.limit ?? 20), {
    optionalUser: true,
    query: t.Object({
      cursor: Cursor,
      limit: PageLimit,
      tab: t.Optional(t.Union([t.Literal('popular'), t.Literal('following'), t.Literal('clan')]))
    }),
    response: PostsPageModel,
    detail: { summary: 'Feed: popular (ranked), following, clan (same emoji avatar)' }
  })

  .post(
    '/posts',
    async ({ body, me, set }) => {
      set.status = 201
      return createPost(me, body)
    },
    {
      user: true,
      body: t.Object({
        content: t.Optional(t.String({ maxLength: config.content.postMaxLength * 2 })),
        spans: t.Optional(t.Array(SpanInputModel, { maxItems: 200 })),
        wallRecipientId: t.Optional(t.Nullable(Uuid)),
        attachmentIds: t.Optional(t.Array(Uuid, { maxItems: 20 })),
        poll: t.Optional(t.Nullable(PollInput)),
        // event post notebook, consumes one from the wallet
        notebook: t.Optional(t.Nullable(t.Object({ eventId: t.Optional(t.String()), style: Enum(['grid', 'ruled']), operationId: t.Optional(t.String()) })))
      }),
      response: { 201: PostModel },
      detail: { summary: 'Create a post (optionally on another user wall, with attachments or a poll)' }
    }
  )

  .post('/posts/stats', ({ body, me }) => postStats(me?.id ?? null, body.ids), {
    optionalUser: true,
    body: t.Object({ ids: t.Array(Uuid, { maxItems: 100 }) }),
    response: t.Object({ posts: t.Array(PostStatsModel) }),
    detail: { summary: 'Live counters for visible posts (served from the Redis cache)' }
  })

  .get(
    '/posts/user/:id',
    async ({ params, query, me }) =>
      userWall(await requireTargetUser(params.id, me), me, {
        cursor: query.cursor,
        limit: query.limit ?? 20,
        sort: query.sort ?? 'new',
        pinnedPostId: query.pinnedPostId
      }),
    {
      optionalUser: true,
      params: t.Object({ id: t.String({ maxLength: 512 }) }),
      query: t.Object({
        cursor: Cursor,
        limit: PageLimit,
        sort: t.Optional(t.Union([t.Literal('new'), t.Literal('popular')])),
        pinnedPostId: t.Optional(Uuid)
      }),
      response: PostsPageModel,
      detail: { summary: 'User wall: own posts, reposts and posts by others on the wall (pinned post first when pinnedPostId is passed)' }
    }
  )

  .get('/posts/user/:id/liked', async ({ params, query, me }) => likedPosts(await requireTargetUser(params.id, me), me, query.cursor, query.limit ?? 20), {
    optionalUser: true,
    params: t.Object({ id: t.String({ maxLength: 512 }) }),
    query: t.Object({ cursor: Cursor, limit: PageLimit }),
    response: PostsPageModel,
    detail: { summary: 'Posts liked by a user (respects likesVisibility, empty when hidden)' }
  })

  .get(
    '/posts/:id',
    async ({ params, me }) => {
      const viewerId = me?.id ?? null
      const row = await requireVisiblePost(params.id, viewerId)
      const [post, comments] = await Promise.all([presentPost(row, viewerId), listComments(row, viewerId, { limit: 20, sort: 'popular' })])
      return { data: { ...post, comments: comments.comments } }
    },
    { optionalUser: true, params: IdParams, response: t.Object({ data: PostWithCommentsModel }), detail: { summary: 'Single post with first comments' } }
  )

  .put('/posts/:id', ({ params, body, me }) => editPost(me, params.id, body), {
    user: true,
    params: IdParams,
    body: t.Object({
      content: t.String({ maxLength: config.content.postMaxLength * 2 }),
      spans: t.Optional(t.Array(SpanInputModel, { maxItems: 200 }))
    }),
    response: t.Object({ id: Uuid, content: t.String(), spans: t.Array(SpanModel), updatedAt: t.String(), editedAt: t.String() }),
    detail: { summary: 'Edit a post (first 48 hours)' }
  })

  .delete('/posts/:id', ({ params, me, auth }) => deletePost(me, params.id, auth.roles.includes('admin')), {
    user: true,
    params: IdParams,
    response: SuccessModel,
    detail: { summary: 'Delete a post (author, wall owner or admin); can be restored' }
  })

  .post('/posts/:id/restore', ({ params, me }) => restorePost(me, params.id), { user: true, params: IdParams, response: SuccessModel })

  .post('/posts/:id/pin', ({ params, me }) => pinPost(me, params.id), {
    user: true,
    params: IdParams,
    response: t.Object({ success: t.Boolean(), pinnedPostId: Uuid })
  })
  .delete('/posts/:id/pin', ({ params, me }) => unpinPost(me, params.id), { user: true, params: IdParams, response: SuccessModel })

  .post(
    '/posts/:id/repost',
    async ({ params, body, me, set }) => {
      set.status = 201
      return repost(me, params.id, body?.content)
    },
    {
      user: true,
      params: IdParams,
      body: t.Optional(t.Object({ content: t.Optional(t.Nullable(t.String({ maxLength: config.content.postMaxLength * 2 }))) })),
      response: { 201: PostModel },
      detail: { summary: 'Repost (optionally with a comment)' }
    }
  )
  .delete('/posts/:id/repost', ({ params, me }) => unrepost(me, params.id), {
    user: true,
    params: IdParams,
    response: t.Object({ success: t.Boolean(), repostsCount: t.Integer() })
  })

  .post('/posts/:id/like', ({ params, me }) => likePost(me, params.id), { user: true, params: IdParams, response: LikeResult })
  .delete('/posts/:id/like', ({ params, me }) => unlikePost(me, params.id), { user: true, params: IdParams, response: LikeResult })

  .post('/posts/:id/poll/vote', ({ params, body, me }) => vote(me, params.id, body.optionIds), {
    user: true,
    params: IdParams,
    body: t.Object({ optionIds: t.Array(Uuid, { minItems: 1, maxItems: 10 }) }),
    response: t.Object({ success: t.Boolean(), data: PollModel })
  })
