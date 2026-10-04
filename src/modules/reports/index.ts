import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { comments, posts, reports, users } from '../../db/schema'
import { ApiError, badRequest, notFound } from '../../lib/errors'
import { authPlugin } from '../../plugins/auth'
import { Enum, Uuid } from '../../schemas'
import { enforceActionLimit } from '../../services/rate-limit'

const TARGET_MISSING = { post: 'Пост не найден', comment: 'Комментарий не найден', user: 'Пользователь не найден' } as const

async function targetOwner(type: 'post' | 'comment' | 'user', id: string) {
  if (type === 'post') {
    const [row] = await db.select({ owner: posts.authorId, deletedAt: posts.deletedAt }).from(posts).where(eq(posts.id, id))
    return row && !row.deletedAt ? row.owner : null
  }
  if (type === 'comment') {
    const [row] = await db.select({ owner: comments.authorId, deletedAt: comments.deletedAt }).from(comments).where(eq(comments.id, id))
    return row && !row.deletedAt ? row.owner : null
  }
  const [row] = await db.select({ owner: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, id))
  return row && !row.deletedAt ? row.owner : null
}

export const reportsModule = new Elysia({ tags: ['Reports'] })
  .use(authPlugin)
  .post(
    '/reports',
    async ({ body, me, set }) => {
      const owner = await targetOwner(body.targetType, body.targetId)
      if (!owner) throw notFound(TARGET_MISSING[body.targetType])
      if (owner === me.id) throw badRequest('Нельзя пожаловаться на свой контент', 'CANNOT_REPORT_SELF')
      await enforceActionLimit('report', me.id)
      const [row] = await db
        .insert(reports)
        .values({ reporterId: me.id, targetType: body.targetType, targetId: body.targetId, reason: body.reason ?? 'other', description: body.description?.trim() ?? '' })
        .onConflictDoNothing()
        .returning()
      if (!row) throw new ApiError(409, 'CONFLICT', 'Вы уже отправляли жалобу на этот контент')
      set.status = 201
      return { success: true, data: { id: row.id, createdAt: row.createdAt.toISOString() } }
    },
    {
      user: true,
      body: t.Object({
        targetId: Uuid,
        targetType: Enum(['post', 'user', 'comment']),
        reason: t.Optional(Enum(['spam', 'violence', 'hate', 'adult', 'fraud', 'other'])),
        description: t.Optional(t.String({ maxLength: 1000 }))
      }),
      response: { 201: t.Object({ success: t.Boolean(), data: t.Object({ id: Uuid, createdAt: t.String() }) }) },
      detail: { summary: 'Report a post, comment or user' }
    }
  )
