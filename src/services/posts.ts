import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { files, pollOptions, polls, pollVotes, postAttachments, postLikes, posts, postViews, users } from '../db/schema'
import { forbidden, notFound } from '../lib/errors'
import { iso } from '../lib/time'
import { issueViewToken } from '../lib/view-token'
import { eventActive, toolState } from '../modules/event/service'
import { canSeeContent, loadBriefs, loadRelation, loadRelations, type Relation, type UserRecord } from './users'

export type PostRow = typeof posts.$inferSelect
export type FileRow = typeof files.$inferSelect

export function presentAttachment(file: FileRow, order: number) {
  return {
    id: file.id,
    type: file.kind,
    url: file.url,
    thumbnailUrl: file.thumbnailUrl,
    width: file.width,
    height: file.height,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
    duration: file.duration,
    order
  }
}
export type AttachmentView = ReturnType<typeof presentAttachment>

async function loadPostAttachments(postIds: string[]) {
  const map = new Map<string, AttachmentView[]>()
  if (postIds.length === 0) return map
  const rows = await db
    .select({ postId: postAttachments.postId, position: postAttachments.position, file: files })
    .from(postAttachments)
    .innerJoin(files, eq(files.id, postAttachments.fileId))
    .where(inArray(postAttachments.postId, postIds))
    .orderBy(asc(postAttachments.position))
  for (const row of rows) {
    const list = map.get(row.postId) ?? []
    list.push(presentAttachment(row.file, row.position))
    map.set(row.postId, list)
  }
  return map
}

export async function loadPolls(postIds: string[], viewerId: string | null) {
  const map = new Map<string, PollView>()
  if (postIds.length === 0) return map
  const pollRows = await db.select().from(polls).where(inArray(polls.postId, postIds))
  if (pollRows.length === 0) return map
  const pollIds = pollRows.map((p) => p.id)
  const [options, votes] = await Promise.all([
    db.select().from(pollOptions).where(inArray(pollOptions.pollId, pollIds)).orderBy(asc(pollOptions.position)),
    viewerId
      ? db
          .select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId })
          .from(pollVotes)
          .where(and(inArray(pollVotes.pollId, pollIds), eq(pollVotes.userId, viewerId)))
      : Promise.resolve([])
  ])
  for (const poll of pollRows) {
    const voted = votes.filter((v) => v.pollId === poll.id).map((v) => v.optionId)
    map.set(poll.postId, {
      id: poll.id,
      postId: poll.postId,
      createdAt: poll.createdAt.toISOString(),
      question: poll.question,
      options: options
        .filter((o) => o.pollId === poll.id)
        .map((o) => ({ id: o.id, text: o.text, votesCount: o.votesCount, position: o.position })),
      multipleChoice: poll.multipleChoice,
      hasVoted: voted.length > 0,
      votedOptionIds: voted,
      totalVotes: poll.totalVotes
    })
  }
  return map
}

export type PollView = {
  id: string
  postId: string
  createdAt: string
  question: string
  options: { id: string; text: string; votesCount: number; position: number }[]
  multipleChoice: boolean
  hasVoted: boolean
  votedOptionIds: string[]
  totalVotes: number
}

async function loadViewerState(postIds: string[], viewerId: string | null) {
  const state = { liked: new Set<string>(), reposted: new Set<string>(), viewed: new Set<string>() }
  if (!viewerId || postIds.length === 0) return state
  const [likes, reposts, views] = await Promise.all([
    db
      .select({ id: postLikes.postId })
      .from(postLikes)
      .where(and(eq(postLikes.userId, viewerId), inArray(postLikes.postId, postIds))),
    db
      .select({ id: posts.originalPostId })
      .from(posts)
      .where(and(eq(posts.authorId, viewerId), inArray(posts.originalPostId, postIds), isNull(posts.deletedAt))),
    db
      .select({ id: postViews.postId })
      .from(postViews)
      .where(and(eq(postViews.userId, viewerId), inArray(postViews.postId, postIds)))
  ])
  for (const row of likes) state.liked.add(row.id)
  for (const row of reposts) if (row.id) state.reposted.add(row.id)
  for (const row of views) state.viewed.add(row.id)
  return state
}

const visibleAuthor = (record: UserRecord | undefined) => !!record && !record.deletedAt && !record.isBanned

/** Renders posts for a viewer: authors, attachments, polls, reposted originals and viewer flags */
export async function presentPosts(rows: PostRow[], viewerId: string | null) {
  if (rows.length === 0) return []

  const originalIds = [...new Set(rows.map((r) => r.originalPostId).filter((id): id is string => !!id))]
  const originals = originalIds.length ? await db.select().from(posts).where(and(inArray(posts.id, originalIds), isNull(posts.deletedAt))) : []

  const all = [...rows, ...originals]
  const postIds = [...new Set(all.map((p) => p.id))]
  const userIds = all.flatMap((p) => (p.wallRecipientId ? [p.authorId, p.wallRecipientId] : [p.authorId]))

  // the web client enables red pens and correctors from these per-post states
  const withTools = eventActive()
  const [{ records, briefs }, attachments, pollMap, state, correctors, redPens] = await Promise.all([
    loadBriefs(userIds),
    loadPostAttachments(postIds),
    loadPolls(postIds, viewerId),
    loadViewerState(postIds, viewerId),
    withTools ? toolState(viewerId, 'corrector', postIds) : null,
    withTools ? toolState(viewerId, 'red_pen', postIds) : null
  ])

  const render = (post: PostRow) => {
    const owner = records.get(post.wallRecipientId ?? post.authorId)
    return {
      id: post.id,
      author: briefs.get(post.authorId)!,
      createdAt: post.createdAt.toISOString(),
      content: post.content,
      spans: post.spans,
      attachments: attachments.get(post.id) ?? [],
      poll: pollMap.get(post.id) ?? null,
      likesCount: post.likesCount,
      commentsCount: post.commentsCount,
      repostsCount: post.repostsCount,
      viewsCount: post.viewsCount,
      editedAt: iso(post.editedAt),
      isLiked: state.liked.has(post.id),
      isReposted: state.reposted.has(post.id),
      isViewed: state.viewed.has(post.id),
      isOwner: viewerId === post.authorId,
      isPinned: owner?.pinnedPostId === post.id,
      dominantEmoji: post.dominantEmoji,
      notebook: post.notebookStyle ? { style: post.notebookStyle } : null,
      corrector: correctors?.data[post.id] ?? null,
      redPen: redPens?.data[post.id] ?? null,
      wallRecipientId: post.wallRecipientId,
      wallRecipient: post.wallRecipientId ? (briefs.get(post.wallRecipientId) ?? null) : null,
      vs: issueViewToken(post.id, viewerId)
    }
  }

  // an original stays hidden when its author went private and the viewer does not follow them
  const privateAuthors = originals.map((o) => records.get(o.authorId)).filter((r): r is UserRecord => !!r?.isPrivate && r.id !== viewerId)
  const relations = privateAuthors.length ? await loadRelations(viewerId, privateAuthors.map((r) => r.id)) : new Map<string, Relation>()
  const renderedOriginals = new Map(
    originals
      .filter((o) => visibleAuthor(records.get(o.authorId)) && canSeeContent(records.get(o.authorId)!, viewerId, relations.get(o.authorId)))
      .map((o) => [o.id, render(o)])
  )
  return rows
    .filter((row) => briefs.has(row.authorId))
    .map((row) => ({ ...render(row), originalPost: row.originalPostId ? (renderedOriginals.get(row.originalPostId) ?? null) : null }))
}

export type PostView = Awaited<ReturnType<typeof presentPosts>>[number]

export async function presentPost(row: PostRow, viewerId: string | null) {
  const [post] = await presentPosts([row], viewerId)
  return post!
}

export async function findPost(id: string) {
  const [row] = await db.select().from(posts).where(eq(posts.id, id)).limit(1)
  return row ?? null
}

/** Loads a post the viewer may see; deleted posts and hidden authors are reported as not found */
export async function requireVisiblePost(id: string, viewerId: string | null) {
  const [row] = await db
    .select({ post: posts, author: { id: users.id, isPrivate: users.isPrivate, deletedAt: users.deletedAt, isBanned: users.isBanned } })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorId))
    .where(eq(posts.id, id))
    .limit(1)
  if (!row || row.post.deletedAt || row.author.deletedAt || row.author.isBanned) throw notFound('Post not found')

  const relation = viewerId ? await loadRelation(viewerId, row.author.id) : undefined
  if (relation && (relation.blockedAt || relation.blockedBy)) throw forbidden('User blocked', 'BLOCKED')
  if (!canSeeContent(row.author, viewerId, relation)) throw forbidden('This account is private', 'PRIVATE_ACCOUNT')
  return row.post
}

/** SQL condition: author is visible to the viewer (not deleted/banned, not blocked, private only for followers) */
export function visibleAuthorCondition(viewerId: string | null, authorColumn = posts.authorId) {
  if (!viewerId) {
    return sql`exists (select 1 from ${users} vu where vu.id = ${authorColumn} and vu.deleted_at is null and not vu.is_banned and not vu.is_private)`
  }
  return sql`exists (
    select 1 from ${users} vu where vu.id = ${authorColumn} and vu.deleted_at is null and not vu.is_banned
      and (not vu.is_private or vu.id = ${viewerId} or exists (select 1 from follows vf where vf.follower_id = ${viewerId} and vf.following_id = vu.id))
  ) and not exists (
    select 1 from blocks vb where (vb.blocker_id = ${viewerId} and vb.blocked_id = ${authorColumn}) or (vb.blocker_id = ${authorColumn} and vb.blocked_id = ${viewerId})
  )`
}
