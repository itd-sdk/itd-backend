import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { authPlugin } from '../../plugins/auth'
import { CommentBaseModel, CommentModel, Enum, PagePaginationModel, SpanModel, SuccessModel, Uuid } from '../../schemas'
import { requireVisiblePost } from '../../services/posts'
import { createComment, createReply, deleteComment, editComment, likeComment, listComments, listReplies, restoreComment, unlikeComment } from './service'

const IdParams = t.Object({ id: Uuid })
const LikeResult = t.Object({ liked: t.Boolean(), likesCount: t.Integer() })
const CommentBody = t.Object({
  content: t.Optional(t.String({ maxLength: config.content.commentMaxLength * 2 })),
  attachmentIds: t.Optional(t.Array(Uuid, { maxItems: 10 }))
})

export const commentsModule = new Elysia({ tags: ['Comments'] })
  .use(authPlugin)

  .get(
    '/posts/:id/comments',
    async ({ params, query, me }) => {
      const post = await requireVisiblePost(params.id, me?.id ?? null)
      return { data: await listComments(post, me?.id ?? null, { cursor: query.cursor, limit: query.limit ?? 20, sort: query.sort }) }
    },
    {
      optionalUser: true,
      params: IdParams,
      query: t.Object({
        cursor: t.Optional(t.String({ maxLength: 32, description: 'Offset returned as nextCursor (starts at 0)' })),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
        sort: t.Optional(Enum(['popular', 'new', 'newest', 'old', 'oldest']))
      }),
      response: t.Object({
        data: t.Object({ comments: t.Array(CommentModel), total: t.Integer(), hasMore: t.Boolean(), nextCursor: t.Nullable(t.Integer()) })
      }),
      detail: { summary: 'Top-level comments of a post with a preview of replies' }
    }
  )

  .post(
    '/posts/:id/comments',
    async ({ params, body, me, set }) => {
      set.status = 201
      return createComment(me, params.id, body)
    },
    { user: true, params: IdParams, body: CommentBody, response: { 201: CommentModel }, detail: { summary: 'Comment a post' } }
  )

  .post(
    '/comments/:id/replies',
    async ({ params, body, me, set }) => {
      set.status = 201
      return createReply(me, params.id, body)
    },
    {
      user: true,
      params: IdParams,
      body: t.Object({ ...CommentBody.properties, replyToUserId: t.Optional(t.Nullable(Uuid)) }),
      response: { 201: CommentModel },
      detail: { summary: 'Reply to a comment (replies are attached to the top-level comment)' }
    }
  )

  .get(
    '/comments/:id/replies',
    ({ params, query, me }) => listReplies(params.id, me?.id ?? null, { page: query.page ?? 1, limit: query.limit ?? 50, cursor: query.cursor }),
    {
      optionalUser: true,
      params: IdParams,
      query: t.Object({
        page: t.Optional(t.Integer({ minimum: 1 })),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        cursor: t.Optional(t.String({ maxLength: 128 }))
      }),
      response: t.Object({
        data: t.Object({ replies: t.Array(CommentBaseModel), pagination: PagePaginationModel, nextCursor: t.Nullable(t.String()) })
      }),
      detail: { summary: 'Replies of a comment, oldest first (page or cursor pagination)' }
    }
  )

  .post('/comments/:id/like', ({ params, me }) => likeComment(me, params.id), { user: true, params: IdParams, response: LikeResult })
  .delete('/comments/:id/like', ({ params, me }) => unlikeComment(me, params.id), { user: true, params: IdParams, response: LikeResult })

  .patch('/comments/:id', ({ params, body, me }) => editComment(me, params.id, body.content), {
    user: true,
    params: IdParams,
    body: t.Object({ content: t.String({ maxLength: config.content.commentMaxLength * 2 }) }),
    response: t.Object({ id: Uuid, content: t.String(), spans: t.Array(SpanModel), editedAt: t.String() })
  })

  .delete('/comments/:id', ({ params, me, auth }) => deleteComment(me, params.id, auth.roles.includes('admin')), {
    user: true,
    params: IdParams,
    response: SuccessModel,
    detail: { summary: 'Delete a comment (author, post owner or admin)' }
  })

  .post('/comments/:id/restore', ({ params, me }) => restoreComment(me, params.id), { user: true, params: IdParams, response: SuccessModel })
