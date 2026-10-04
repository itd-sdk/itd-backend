import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { commentAttachments, commentLikes, comments, files } from '../db/schema'
import { iso } from '../lib/time'
import { type AttachmentView, presentAttachment } from './posts'
import { loadBriefs } from './users'

export type CommentRow = typeof comments.$inferSelect

const REPLIES_PREVIEW = 3

async function loadCommentAttachments(ids: string[]) {
  const map = new Map<string, AttachmentView[]>()
  if (ids.length === 0) return map
  const rows = await db
    .select({ commentId: commentAttachments.commentId, position: commentAttachments.position, file: files })
    .from(commentAttachments)
    .innerJoin(files, eq(files.id, commentAttachments.fileId))
    .where(inArray(commentAttachments.commentId, ids))
    .orderBy(asc(commentAttachments.position))
  for (const row of rows) {
    const list = map.get(row.commentId) ?? []
    list.push(presentAttachment(row.file, row.position))
    map.set(row.commentId, list)
  }
  return map
}

/** First replies of each root comment (visible authors only) */
async function loadReplyPreviews(rootIds: string[]) {
  if (rootIds.length === 0) return [] as CommentRow[]
  const rows = await db.execute<{ id: string }>(sql`
    select id from (
      select c.id, row_number() over (partition by c.root_id order by c.created_at asc, c.id asc) as rn
      from ${comments} c join users u on u.id = c.author_id
      where c.root_id = any(${sql.param(rootIds)}::uuid[]) and c.deleted_at is null and u.deleted_at is null and not u.is_banned
    ) ranked where rn <= ${REPLIES_PREVIEW}
  `)
  if (rows.length === 0) return []
  return db
    .select()
    .from(comments)
    .where(
      inArray(
        comments.id,
        rows.map((r) => r.id)
      )
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
}

export async function presentComments(rows: CommentRow[], viewerId: string | null, options: { withReplies?: boolean } = {}) {
  if (rows.length === 0) return []
  const replies = options.withReplies ? await loadReplyPreviews(rows.filter((r) => !r.rootId && r.repliesCount > 0).map((r) => r.id)) : []
  const all = [...rows, ...replies]
  const ids = all.map((c) => c.id)

  const [{ briefs }, attachments, liked] = await Promise.all([
    loadBriefs(all.flatMap((c) => (c.replyToUserId ? [c.authorId, c.replyToUserId] : [c.authorId]))),
    loadCommentAttachments(ids),
    viewerId
      ? db
          .select({ id: commentLikes.commentId })
          .from(commentLikes)
          .where(and(eq(commentLikes.userId, viewerId), inArray(commentLikes.commentId, ids)))
      : Promise.resolve([])
  ])
  const likedSet = new Set(liked.map((l) => l.id))

  const render = (comment: CommentRow) => ({
    id: comment.id,
    postId: comment.postId,
    rootId: comment.rootId,
    content: comment.content,
    spans: comment.spans,
    createdAt: comment.createdAt.toISOString(),
    editedAt: iso(comment.editedAt),
    author: briefs.get(comment.authorId)!,
    likesCount: comment.likesCount,
    repliesCount: comment.repliesCount,
    isLiked: likedSet.has(comment.id),
    attachments: attachments.get(comment.id) ?? [],
    replyTo: comment.replyToUserId ? (briefs.get(comment.replyToUserId) ?? null) : null
  })

  return rows
    .filter((c) => briefs.has(c.authorId))
    .map((comment) => ({
      ...render(comment),
      replies: replies.filter((r) => r.rootId === comment.id && briefs.has(r.authorId)).map(render)
    }))
}

export type CommentView = Awaited<ReturnType<typeof presentComments>>[number]
