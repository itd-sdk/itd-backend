import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db } from '../../db/client'
import { commentAttachments, commentLikes, comments, posts } from '../../db/schema'
import { conflict, forbidden, notFound, validationError } from '../../lib/errors'
import { decodeKeyset, encodeKeyset, parseOffset } from '../../lib/cursor'
import type { Me } from '../../plugins/auth'
import { type CommentRow, presentComments } from '../../services/comments'
import { prepareContent, resolveAttachments } from '../../services/content'
import { notify } from '../../services/notifications'
import { bumpCounter } from '../../services/post-stats'
import { type PostRow, requireVisiblePost } from '../../services/posts'
import { enforceActionLimit } from '../../services/rate-limit'
import { loadUserRecord } from '../../services/users'

const MAX_COMMENT_ATTACHMENTS = 4
const commentNotFound = () => notFound('Comment not found')

/** Hides comments of deleted / banned authors and of users in a block relation with the viewer */
function visibleCommentAuthor(viewerId: string | null) {
  const base = sql`exists (select 1 from users cu where cu.id = ${comments.authorId} and cu.deleted_at is null and not cu.is_banned)`
  if (!viewerId) return base
  return sql`${base} and not exists (
    select 1 from blocks cb where (cb.blocker_id = ${viewerId} and cb.blocked_id = ${comments.authorId}) or (cb.blocker_id = ${comments.authorId} and cb.blocked_id = ${viewerId})
  )`
}

export type CommentSort = 'popular' | 'new' | 'newest' | 'old' | 'oldest'

export async function listComments(post: PostRow, viewerId: string | null, options: { cursor?: string | number; limit: number; sort?: CommentSort }) {
  const where = and(eq(comments.postId, post.id), isNull(comments.rootId), isNull(comments.deletedAt), visibleCommentAuthor(viewerId))
  const order =
    options.sort === 'new' || options.sort === 'newest'
      ? [desc(comments.createdAt), desc(comments.id)]
      : options.sort === 'old' || options.sort === 'oldest'
        ? [asc(comments.createdAt), asc(comments.id)]
        : [desc(comments.likesCount), desc(comments.repliesCount), desc(comments.createdAt), desc(comments.id)]
  const offset = parseOffset(options.cursor)

  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(comments)
      .where(where)
      .orderBy(...order)
      .limit(options.limit + 1)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(comments).where(where)
  ])
  const hasMore = rows.length > options.limit
  const page = rows.slice(0, options.limit)
  return {
    comments: await presentComments(page, viewerId, { withReplies: true }),
    total: total?.count ?? 0,
    hasMore,
    nextCursor: hasMore ? offset + page.length : null
  }
}

async function findComment(id: string) {
  const [row] = await db.select().from(comments).where(eq(comments.id, id)).limit(1)
  return row ?? null
}

async function insertComment(me: Me, post: PostRow, values: { content: string; spans: CommentRow['spans']; rootId: string | null; replyToUserId: string | null }, fileIds: string[]) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(comments)
      .values({ postId: post.id, authorId: me.id, ...values })
      .returning()
    if (fileIds.length) await tx.insert(commentAttachments).values(fileIds.map((fileId, position) => ({ commentId: row!.id, fileId, position })))
    await tx
      .update(posts)
      .set({ commentsCount: sql`${posts.commentsCount} + 1` })
      .where(eq(posts.id, post.id))
    if (values.rootId) {
      await tx
        .update(comments)
        .set({ repliesCount: sql`${comments.repliesCount} + 1` })
        .where(eq(comments.id, values.rootId))
    }
    return row!
  })
}

export async function createComment(me: Me, postId: string, input: { content?: string; attachmentIds?: string[] }) {
  const post = await requireVisiblePost(postId, me.id)
  const content = input.content ?? ''
  const attachmentIds = input.attachmentIds ?? []
  if (!content.trim() && attachmentIds.length === 0) throw validationError('Content or attachments required', 'content')
  await enforceActionLimit('comment', me.id)
  const prepared = await prepareContent(content, [], { maxLength: config.content.commentMaxLength, kind: 'Comment' })
  const files = await resolveAttachments(me.id, attachmentIds, MAX_COMMENT_ATTACHMENTS)

  const row = await insertComment(
    me,
    post,
    { content, spans: prepared.spans, rootId: null, replyToUserId: null },
    files.map((f) => f.id)
  )
  await bumpCounter(post.id, 'commentsCount', 1)

  await notify({ recipientId: post.authorId, actorId: me.id, type: 'comment', targetType: 'post', targetId: post.id, subjectType: 'comment', subjectId: row.id, preview: content, dedupeKey: `comment:${row.id}` })
  for (const userId of prepared.mentionedUserIds) {
    if (userId === post.authorId) continue
    await notify({ recipientId: userId, actorId: me.id, type: 'comment_mention', targetType: 'post', targetId: post.id, subjectType: 'comment', subjectId: row.id, preview: content, dedupeKey: `comment_mention:${row.id}` })
  }
  const [presented] = await presentComments([row], me.id)
  return presented!
}

export async function createReply(me: Me, commentId: string, input: { content?: string; replyToUserId?: string | null; attachmentIds?: string[] }) {
  const parent = await findComment(commentId)
  if (!parent || parent.deletedAt) throw commentNotFound()
  const root = parent.rootId ? await findComment(parent.rootId) : parent
  if (!root || root.deletedAt) throw commentNotFound()
  const post = await requireVisiblePost(root.postId, me.id)

  const replyToUserId = input.replyToUserId ?? parent.authorId
  const replyTo = await loadUserRecord(replyToUserId)
  if (!replyTo || replyTo.deletedAt) throw notFound('User not found')

  const content = input.content ?? ''
  const attachmentIds = input.attachmentIds ?? []
  if (!content.trim() && attachmentIds.length === 0) throw validationError('Content or attachments required', 'content')
  await enforceActionLimit('comment', me.id)
  const prepared = await prepareContent(content, [], { maxLength: config.content.commentMaxLength, kind: 'Reply' })
  const files = await resolveAttachments(me.id, attachmentIds, MAX_COMMENT_ATTACHMENTS)

  const row = await insertComment(
    me,
    post,
    { content, spans: prepared.spans, rootId: root.id, replyToUserId },
    files.map((f) => f.id)
  )
  await bumpCounter(post.id, 'commentsCount', 1)

  await notify({ recipientId: replyToUserId, actorId: me.id, type: 'reply', targetType: 'post', targetId: post.id, subjectType: 'comment', subjectId: row.id, preview: content, dedupeKey: `reply:${row.id}` })
  for (const userId of prepared.mentionedUserIds) {
    if (userId === replyToUserId) continue
    await notify({ recipientId: userId, actorId: me.id, type: 'comment_mention', targetType: 'post', targetId: post.id, subjectType: 'comment', subjectId: row.id, preview: content, dedupeKey: `comment_mention:${row.id}` })
  }
  const [presented] = await presentComments([row], me.id)
  return presented!
}

export async function listReplies(commentId: string, viewerId: string | null, options: { page: number; limit: number; cursor?: string }) {
  const root = await findComment(commentId)
  if (!root || root.deletedAt) throw commentNotFound()
  await requireVisiblePost(root.postId, viewerId)

  const key = decodeKeyset(options.cursor)
  const where = and(eq(comments.rootId, root.id), isNull(comments.deletedAt), visibleCommentAuthor(viewerId))
  const query = db
    .select()
    .from(comments)
    .where(key ? and(where, sql`(${comments.createdAt}, ${comments.id}) > (${key.t.toISOString()}::timestamptz, ${key.id}::uuid)`) : where)
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(options.limit + 1)
  const [rows, [total]] = await Promise.all([
    key ? query : query.offset((options.page - 1) * options.limit),
    db.select({ count: sql<number>`count(*)::int` }).from(comments).where(where)
  ])
  const hasMore = rows.length > options.limit
  const page = rows.slice(0, options.limit)
  const last = page.at(-1)
  const replies = (await presentComments(page, viewerId)).map(({ replies: _, ...reply }) => reply)
  return {
    data: {
      replies,
      pagination: { page: options.page, limit: options.limit, total: total?.count ?? 0, hasMore },
      nextCursor: hasMore && last ? encodeKeyset({ t: last.createdAt, id: last.id }) : null
    }
  }
}

export async function likeComment(me: Me, commentId: string) {
  const comment = await findComment(commentId)
  if (!comment || comment.deletedAt) throw commentNotFound()
  await requireVisiblePost(comment.postId, me.id)
  await enforceActionLimit('like', me.id)
  const result = await db.transaction(async (tx) => {
    const inserted = await tx.insert(commentLikes).values({ userId: me.id, commentId }).onConflictDoNothing().returning()
    const [row] = inserted.length
      ? await tx
          .update(comments)
          .set({ likesCount: sql`${comments.likesCount} + 1` })
          .where(eq(comments.id, commentId))
          .returning({ likesCount: comments.likesCount })
      : await tx.select({ likesCount: comments.likesCount }).from(comments).where(eq(comments.id, commentId))
    return { created: inserted.length > 0, likesCount: row!.likesCount }
  })
  if (result.created) {
    await notify({
      recipientId: comment.authorId,
      actorId: me.id,
      type: 'comment_like',
      targetType: 'post',
      targetId: comment.postId,
      subjectType: 'comment',
      subjectId: comment.id,
      preview: comment.content,
      dedupeKey: `comment_like:${comment.id}:${me.id}`
    })
  }
  return { liked: true, likesCount: result.likesCount }
}

export async function unlikeComment(me: Me, commentId: string) {
  const comment = await findComment(commentId)
  if (!comment || comment.deletedAt) throw commentNotFound()
  const likesCount = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(commentLikes)
      .where(and(eq(commentLikes.userId, me.id), eq(commentLikes.commentId, commentId)))
      .returning()
    const [row] = removed.length
      ? await tx
          .update(comments)
          .set({ likesCount: sql`greatest(${comments.likesCount} - 1, 0)` })
          .where(eq(comments.id, commentId))
          .returning({ likesCount: comments.likesCount })
      : await tx.select({ likesCount: comments.likesCount }).from(comments).where(eq(comments.id, commentId))
    return row!.likesCount
  })
  return { liked: false, likesCount }
}

/** Number of post comments a (soft) delete/restore of this comment hides/shows */
const weight = (comment: CommentRow) => (comment.rootId ? 1 : 1 + comment.repliesCount)

async function applyVisibility(comment: CommentRow, deleted: boolean) {
  // replies of a deleted root are already excluded from the post counter
  const root = comment.rootId ? await findComment(comment.rootId) : null
  const delta = root?.deletedAt ? 0 : deleted ? -weight(comment) : weight(comment)
  await db.transaction(async (tx) => {
    await tx
      .update(comments)
      .set({ deletedAt: deleted ? new Date() : null })
      .where(eq(comments.id, comment.id))
    if (delta !== 0) {
      await tx
        .update(posts)
        .set({ commentsCount: sql`greatest(${posts.commentsCount} + ${delta}, 0)` })
        .where(eq(posts.id, comment.postId))
    }
    if (comment.rootId) {
      await tx
        .update(comments)
        .set({ repliesCount: sql`greatest(${comments.repliesCount} + ${deleted ? -1 : 1}, 0)` })
        .where(eq(comments.id, comment.rootId))
    }
  })
  if (delta !== 0) await bumpCounter(comment.postId, 'commentsCount', delta)
}

async function canModerate(me: Me, comment: CommentRow, isAdmin: boolean) {
  if (isAdmin || comment.authorId === me.id) return true
  const [post] = await db.select({ authorId: posts.authorId, wallRecipientId: posts.wallRecipientId }).from(posts).where(eq(posts.id, comment.postId))
  return post?.authorId === me.id || post?.wallRecipientId === me.id
}

export async function deleteComment(me: Me, commentId: string, isAdmin: boolean) {
  const comment = await findComment(commentId)
  if (!comment) throw commentNotFound()
  if (!(await canModerate(me, comment, isAdmin))) throw forbidden('Not allowed to delete this comment')
  if (comment.deletedAt) throw conflict('Comment already deleted', 'ALREADY_DELETED')
  await applyVisibility(comment, true)
  return { success: true }
}

export async function restoreComment(me: Me, commentId: string) {
  const comment = await findComment(commentId)
  if (!comment) throw commentNotFound()
  if (!(await canModerate(me, comment, false))) throw forbidden('Not allowed to restore this comment')
  if (!comment.deletedAt) throw conflict('Comment is not deleted', 'NOT_DELETED')
  if (Date.now() - comment.deletedAt.getTime() > config.content.restoreWindowDays * 86400_000) throw forbidden('Restore period has expired', 'RESTORE_EXPIRED')
  await applyVisibility(comment, false)
  return { success: true }
}

export async function editComment(me: Me, commentId: string, content: string) {
  const comment = await findComment(commentId)
  if (!comment || comment.deletedAt) throw commentNotFound()
  if (comment.authorId !== me.id) throw forbidden('Not allowed to edit this comment')
  const [attached] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(commentAttachments)
    .where(eq(commentAttachments.commentId, commentId))
  if (!content.trim() && !attached?.count) throw validationError('Content cannot be empty', 'content')
  const prepared = await prepareContent(content, [], { maxLength: config.content.commentMaxLength, kind: comment.rootId ? 'Reply' : 'Comment' })
  const editedAt = new Date()
  await db.update(comments).set({ content, spans: prepared.spans, editedAt }).where(eq(comments.id, commentId))
  return { id: commentId, content, spans: prepared.spans, editedAt: editedAt.toISOString() }
}
