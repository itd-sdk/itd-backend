import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { config } from '../../config'
import { db } from '../../db/client'
import { follows, hashtags, pollOptions, polls, pollVotes, postAttachments, postHashtags, postLikes, posts, users } from '../../db/schema'
import { ApiError, badRequest, conflict, forbidden, notFound, validationError } from '../../lib/errors'
import { decodeKeyset, encodeKeyset, parseOffset } from '../../lib/cursor'
import type { SpanInput } from '../../lib/text'
import type { Me } from '../../plugins/auth'
import { prepareContent, resolveAttachments } from '../../services/content'
import { popularPage } from '../../services/feed'
import { adjustHashtagCounts, attachHashtags, detachHashtags } from '../../services/hashtags'
import { notify } from '../../services/notifications'
import { bumpCounter, dropCounters, getCounters, setDominantEmoji } from '../../services/post-stats'
import { findPost, loadPolls, type PostRow, presentPost, presentPosts, requireVisiblePost, visibleAuthorCondition } from '../../services/posts'
import { enforceActionLimit } from '../../services/rate-limit'
import { canSeeContent, hasAccess, loadRelation, loadUserRecord, type UserRecord } from '../../services/users'

export type PollInput = { question: string; options: { text: string }[]; multipleChoice?: boolean; multiple?: boolean }
export type CreatePostInput = {
  content?: string
  spans?: SpanInput[]
  wallRecipientId?: string | null
  attachmentIds?: string[]
  poll?: PollInput | null
}

const postNotFound = () => notFound('Post not found')

function validatePoll(poll: PollInput) {
  const question = poll.question.trim()
  if (!question) throw validationError('Poll question cannot be empty', 'poll.question')
  const options = poll.options.map((o) => o.text.trim())
  if (options.length < 2 || options.length > 10) throw validationError('Poll must have from 2 to 10 options', 'poll.options')
  if (options.some((o) => !o)) throw validationError('Poll option cannot be empty', 'poll.options')
  return { question, options, multipleChoice: poll.multipleChoice ?? poll.multiple ?? false }
}

// ---------------------------------------------------------------- create / edit / delete

export async function createPost(me: Me, input: CreatePostInput) {
  const content = input.content ?? ''
  const attachmentIds = input.attachmentIds ?? []
  if (!content.trim() && attachmentIds.length === 0 && !input.poll) throw validationError('Content, attachments or poll required', 'content')
  await enforceActionLimit('post', me.id)

  const prepared = await prepareContent(content, input.spans, { maxLength: config.content.postMaxLength, kind: 'Post' })
  const attachments = await resolveAttachments(me.id, attachmentIds, config.content.maxAttachments)
  const poll = input.poll ? validatePoll(input.poll) : null

  let wallRecipient: UserRecord | null = null
  if (input.wallRecipientId) {
    if (input.wallRecipientId === me.id) throw badRequest('Cannot write on your own wall')
    wallRecipient = await loadUserRecord(input.wallRecipientId)
    if (!wallRecipient || wallRecipient.deletedAt || wallRecipient.isBanned) throw notFound('Wall recipient not found')
    const relation = await loadRelation(me.id, wallRecipient.id)
    if (relation.blockedAt || relation.blockedBy) throw forbidden('Cannot write on this wall')
    if (!hasAccess(wallRecipient.wallAccess, relation, false)) throw forbidden('You do not have permission to write on this wall')
  }

  const now = new Date()
  const post = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(posts)
      .values({ authorId: me.id, wallRecipientId: wallRecipient?.id ?? null, content, spans: prepared.spans, createdAt: now })
      .returning()
    if (attachments.length) {
      await tx.insert(postAttachments).values(attachments.map((file, position) => ({ postId: row!.id, fileId: file.id, position })))
    }
    if (poll) {
      const [pollRow] = await tx.insert(polls).values({ postId: row!.id, question: poll.question, multipleChoice: poll.multipleChoice, createdAt: now }).returning()
      await tx.insert(pollOptions).values(poll.options.map((text, position) => ({ pollId: pollRow!.id, text, position })))
    }
    await attachHashtags(tx, row!.id, prepared.hashtags, now)
    if (!wallRecipient) await tx.update(users).set({ postsCount: sql`${users.postsCount} + 1` }).where(eq(users.id, me.id))
    return row!
  })

  if (wallRecipient) {
    await notify({ recipientId: wallRecipient.id, actorId: me.id, type: 'wall_post', targetType: 'post', targetId: post.id, preview: content, dedupeKey: `wall_post:${post.id}` })
  }
  for (const userId of prepared.mentionedUserIds) {
    if (userId === wallRecipient?.id) continue
    await notify({ recipientId: userId, actorId: me.id, type: 'mention', targetType: 'post', targetId: post.id, preview: content, dedupeKey: `mention:${post.id}` })
  }
  return presentPost(post, me.id)
}

export async function editPost(me: Me, postId: string, input: { content: string; spans?: SpanInput[] }) {
  const post = await findPost(postId)
  if (!post || post.deletedAt) throw postNotFound()
  if (post.authorId !== me.id) throw forbidden('Not allowed to edit this post')
  if (Date.now() - post.createdAt.getTime() > config.content.editWindowHours * 3600_000) {
    throw new ApiError(403, 'EDIT_WINDOW_EXPIRED', `Editing is allowed only within ${config.content.editWindowHours} hours after posting`)
  }
  const [attached] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(postAttachments)
    .where(eq(postAttachments.postId, postId))
  const [poll] = await db.select({ id: polls.id }).from(polls).where(eq(polls.postId, postId)).limit(1)
  if (!input.content.trim() && !attached?.count && !poll && !post.originalPostId) throw validationError('Content cannot be empty', 'content')

  const prepared = await prepareContent(input.content, input.spans, { maxLength: config.content.postMaxLength, kind: 'Post' })
  const previouslyMentioned = new Set(post.spans.filter((s) => s.type === 'mention').map((s) => s.tag))
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx.update(posts).set({ content: input.content, spans: prepared.spans, editedAt: now }).where(eq(posts.id, postId))
    await detachHashtags(tx, postId)
    await attachHashtags(tx, postId, prepared.hashtags, post.createdAt)
  })

  const mentionedNow = prepared.spans.filter((s) => s.type === 'mention' && !previouslyMentioned.has(s.tag))
  if (mentionedNow.length) {
    for (const userId of prepared.mentionedUserIds) {
      await notify({ recipientId: userId, actorId: me.id, type: 'mention', targetType: 'post', targetId: postId, preview: input.content, dedupeKey: `mention:${postId}` })
    }
  }
  return { id: postId, content: input.content, spans: prepared.spans, updatedAt: now.toISOString(), editedAt: now.toISOString() }
}

/** Soft delete + counter bookkeeping; shared by delete and un-repost */
async function softDelete(post: PostRow, actorId: string) {
  const deleted = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(posts)
      .set({ deletedAt: new Date(), deletedBy: actorId })
      .where(and(eq(posts.id, post.id), isNull(posts.deletedAt)))
      .returning()
    if (!row) return false
    if (!post.wallRecipientId) {
      await tx
        .update(users)
        .set({ postsCount: sql`greatest(${users.postsCount} - 1, 0)` })
        .where(eq(users.id, post.authorId))
    }
    if (post.originalPostId) {
      await tx
        .update(posts)
        .set({ repostsCount: sql`greatest(${posts.repostsCount} - 1, 0)` })
        .where(eq(posts.id, post.originalPostId))
    }
    await adjustHashtagCounts(tx, post.id, -1)
    await tx.update(users).set({ pinnedPostId: null }).where(eq(users.pinnedPostId, post.id))
    return true
  })
  if (deleted) {
    await dropCounters(post.id)
    if (post.originalPostId) await bumpCounter(post.originalPostId, 'repostsCount', -1)
  }
  return deleted
}

export async function deletePost(me: Me, postId: string, isAdmin: boolean) {
  const post = await findPost(postId)
  if (!post || post.deletedAt) throw postNotFound()
  if (post.authorId !== me.id && post.wallRecipientId !== me.id && !isAdmin) throw forbidden('Not allowed to delete this post')
  await softDelete(post, me.id)
  return { success: true }
}

export async function restorePost(me: Me, postId: string) {
  const post = await findPost(postId)
  if (!post) throw postNotFound()
  if (post.authorId !== me.id && post.wallRecipientId !== me.id) throw forbidden('Not allowed to restore this post')
  if (!post.deletedAt) throw conflict('Post is not deleted', 'NOT_DELETED')
  if (post.deletedBy && post.deletedBy !== me.id && post.deletedBy !== post.authorId && post.deletedBy !== post.wallRecipientId) {
    throw forbidden('Not allowed to restore this post')
  }
  if (Date.now() - post.deletedAt.getTime() > config.content.restoreWindowDays * 86400_000) throw forbidden('Restore period has expired', 'RESTORE_EXPIRED')

  await db.transaction(async (tx) => {
    await tx.update(posts).set({ deletedAt: null, deletedBy: null }).where(eq(posts.id, postId))
    if (!post.wallRecipientId) await tx.update(users).set({ postsCount: sql`${users.postsCount} + 1` }).where(eq(users.id, post.authorId))
    if (post.originalPostId) await tx.update(posts).set({ repostsCount: sql`${posts.repostsCount} + 1` }).where(eq(posts.id, post.originalPostId))
    await adjustHashtagCounts(tx, postId, 1)
  })
  if (post.originalPostId) await bumpCounter(post.originalPostId, 'repostsCount', 1)
  return { success: true }
}

// ---------------------------------------------------------------- likes

async function refreshDominantEmoji(postId: string) {
  const rows = await db.execute<{ clan: string; n: number }>(sql`
    select clan, count(*)::int as n from ${postLikes} where post_id = ${postId} group by clan order by n desc limit 2
  `)
  const [top, second] = rows
  const dominant = top && top.n >= config.content.dominantEmojiMinLikes && (!second || top.n > second.n) ? top.clan : null
  const [updated] = await db
    .update(posts)
    .set({ dominantEmoji: dominant })
    .where(and(eq(posts.id, postId), sql`${posts.dominantEmoji} is distinct from ${dominant}`))
    .returning({ id: posts.id })
  if (updated) await setDominantEmoji(postId, dominant)
}

export async function likePost(me: Me, postId: string) {
  const post = await requireVisiblePost(postId, me.id)
  await enforceActionLimit('like', me.id)
  const result = await db.transaction(async (tx) => {
    const inserted = await tx.insert(postLikes).values({ userId: me.id, postId, clan: me.avatar }).onConflictDoNothing().returning()
    if (inserted.length === 0) {
      const [row] = await tx.select({ likesCount: posts.likesCount }).from(posts).where(eq(posts.id, postId))
      return { created: false, likesCount: row!.likesCount }
    }
    const [row] = await tx
      .update(posts)
      .set({ likesCount: sql`${posts.likesCount} + 1` })
      .where(eq(posts.id, postId))
      .returning({ likesCount: posts.likesCount })
    return { created: true, likesCount: row!.likesCount }
  })
  if (result.created) {
    await bumpCounter(postId, 'likesCount', 1)
    await refreshDominantEmoji(postId)
    await notify({
      recipientId: post.authorId,
      actorId: me.id,
      type: 'like',
      targetType: 'post',
      targetId: postId,
      preview: post.content,
      dedupeKey: `like:${postId}:${me.id}`
    })
  }
  return { liked: true, likesCount: result.likesCount }
}

export async function unlikePost(me: Me, postId: string) {
  const post = await findPost(postId)
  if (!post || post.deletedAt) throw postNotFound()
  const result = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(postLikes)
      .where(and(eq(postLikes.userId, me.id), eq(postLikes.postId, postId)))
      .returning()
    if (removed.length === 0) {
      const [row] = await tx.select({ likesCount: posts.likesCount }).from(posts).where(eq(posts.id, postId))
      return { removed: false, likesCount: row!.likesCount }
    }
    const [row] = await tx
      .update(posts)
      .set({ likesCount: sql`greatest(${posts.likesCount} - 1, 0)` })
      .where(eq(posts.id, postId))
      .returning({ likesCount: posts.likesCount })
    return { removed: true, likesCount: row!.likesCount }
  })
  if (result.removed) {
    await bumpCounter(postId, 'likesCount', -1)
    await refreshDominantEmoji(postId)
  }
  return { liked: false, likesCount: result.likesCount }
}

// ---------------------------------------------------------------- reposts

export async function repost(me: Me, postId: string, content: string | null | undefined) {
  const target = await requireVisiblePost(postId, me.id)
  const original = target.originalPostId ? await requireVisiblePost(target.originalPostId, me.id) : target
  if (original.authorId === me.id) throw badRequest('Cannot repost your own post')
  const author = await loadUserRecord(original.authorId)
  if (author?.isPrivate) throw forbidden('Cannot repost posts of a private account')
  await enforceActionLimit('repost', me.id)

  const text = content ?? ''
  const prepared = await prepareContent(text, [], { maxLength: config.content.postMaxLength, kind: 'Post' })
  const [existing] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.authorId, me.id), eq(posts.originalPostId, original.id), isNull(posts.deletedAt)))
    .limit(1)
  if (existing) throw conflict('Post already reposted')

  const now = new Date()
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(posts)
      .values({ authorId: me.id, originalPostId: original.id, content: text, spans: prepared.spans, createdAt: now })
      .returning()
    await tx
      .update(posts)
      .set({ repostsCount: sql`${posts.repostsCount} + 1` })
      .where(eq(posts.id, original.id))
    await tx.update(users).set({ postsCount: sql`${users.postsCount} + 1` }).where(eq(users.id, me.id))
    await attachHashtags(tx, created!.id, prepared.hashtags, now)
    return created!
  })
  await bumpCounter(original.id, 'repostsCount', 1)
  await notify({
    recipientId: original.authorId,
    actorId: me.id,
    type: 'repost',
    targetType: 'post',
    targetId: original.id,
    subjectType: 'post',
    subjectId: row.id,
    preview: original.content,
    dedupeKey: `repost:${original.id}:${me.id}`
  })
  return presentPost(row, me.id)
}

export async function unrepost(me: Me, postId: string) {
  const target = await findPost(postId)
  if (!target) throw postNotFound()
  const originalId = target.originalPostId ?? target.id
  const [mine] = await db
    .select()
    .from(posts)
    .where(and(eq(posts.authorId, me.id), eq(posts.originalPostId, originalId), isNull(posts.deletedAt)))
    .limit(1)
  if (!mine) throw notFound('Repost not found')
  await softDelete(mine, me.id)
  const [original] = await db.select({ repostsCount: posts.repostsCount }).from(posts).where(eq(posts.id, originalId))
  return { success: true, repostsCount: original?.repostsCount ?? 0 }
}

// ---------------------------------------------------------------- pin

export async function pinPost(me: Me, postId: string) {
  const post = await findPost(postId)
  if (!post || post.deletedAt) throw postNotFound()
  const ownWallPost = post.authorId === me.id && !post.wallRecipientId
  if (!ownWallPost && post.wallRecipientId !== me.id) throw forbidden('Can only pin your own posts or posts on your wall')
  await db.update(users).set({ pinnedPostId: postId }).where(eq(users.id, me.id))
  return { success: true, pinnedPostId: postId }
}

export async function unpinPost(me: Me, postId: string) {
  if (me.pinnedPostId !== postId) throw new ApiError(404, 'NOT_PINNED', 'This post is not pinned')
  await db.update(users).set({ pinnedPostId: null }).where(eq(users.id, me.id))
  return { success: true }
}

// ---------------------------------------------------------------- polls

export async function vote(me: Me, postId: string, optionIds: string[]) {
  await requireVisiblePost(postId, me.id)
  const [poll] = await db.select().from(polls).where(eq(polls.postId, postId)).limit(1)
  if (!poll) throw new ApiError(404, 'NOT_FOUND', 'Опрос не найден')
  const unique = [...new Set(optionIds)]
  if (unique.length === 0) throw validationError('Choose at least one option', 'optionIds')
  const options = await db.select({ id: pollOptions.id }).from(pollOptions).where(eq(pollOptions.pollId, poll.id))
  const valid = new Set(options.map((o) => o.id))
  if (unique.some((id) => !valid.has(id))) throw badRequest('Один или несколько вариантов не принадлежат этому опросу')
  if (!poll.multipleChoice && unique.length > 1) throw badRequest('В этом опросе можно выбрать только один вариант')
  await enforceActionLimit('vote', me.id)

  await db.transaction(async (tx) => {
    const [already] = await tx
      .select({ optionId: pollVotes.optionId })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, me.id)))
      .limit(1)
    if (already) throw conflict('Вы уже проголосовали в этом опросе', 'ALREADY_VOTED')
    await tx.insert(pollVotes).values(unique.map((optionId) => ({ pollId: poll.id, optionId, userId: me.id })))
    await tx
      .update(pollOptions)
      .set({ votesCount: sql`${pollOptions.votesCount} + 1` })
      .where(inArray(pollOptions.id, unique))
    await tx
      .update(polls)
      .set({ totalVotes: sql`${polls.totalVotes} + 1` })
      .where(eq(polls.id, poll.id))
  })
  return { success: true, data: (await loadPolls([postId], me.id)).get(postId)! }
}

// ---------------------------------------------------------------- stats

export async function postStats(viewerId: string | null, ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 100)
  const visible = unique.length
    ? await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(inArray(posts.id, unique), isNull(posts.deletedAt)))
    : []
  const visibleIds = visible.map((v) => v.id)
  const [counters, liked, reposted] = await Promise.all([
    getCounters(visibleIds),
    viewerId && visibleIds.length
      ? db
          .select({ id: postLikes.postId })
          .from(postLikes)
          .where(and(eq(postLikes.userId, viewerId), inArray(postLikes.postId, visibleIds)))
      : Promise.resolve([]),
    viewerId && visibleIds.length
      ? db
          .select({ id: posts.originalPostId })
          .from(posts)
          .where(and(eq(posts.authorId, viewerId), inArray(posts.originalPostId, visibleIds), isNull(posts.deletedAt)))
      : Promise.resolve([])
  ])
  const likedSet = new Set(liked.map((l) => l.id))
  const repostedSet = new Set(reposted.map((r) => r.id))
  return {
    posts: visibleIds
      .filter((id) => counters.has(id))
      .map((id) => ({ id, ...counters.get(id)!, isLiked: likedSet.has(id), isReposted: repostedSet.has(id) }))
  }
}

// ---------------------------------------------------------------- feeds

type Page = { rows: PostRow[]; hasMore: boolean; nextCursor: string | null }

async function keysetPage(where: SQL | undefined, cursor: string | undefined, limit: number): Promise<Page> {
  const key = decodeKeyset(cursor)
  const condition = key ? and(where, sql`(${posts.createdAt}, ${posts.id}) < (${key.t.toISOString()}::timestamptz, ${key.id}::uuid)`) : where
  const rows = await db
    .select()
    .from(posts)
    .where(condition)
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return { rows: page, hasMore, nextCursor: hasMore && last ? encodeKeyset({ t: last.createdAt, id: last.id }) : null }
}

export async function renderPage(page: Page, viewerId: string | null, prepend: PostRow[] = []) {
  return {
    data: {
      posts: await presentPosts([...prepend, ...page.rows], viewerId),
      pagination: { nextCursor: page.nextCursor, hasMore: page.hasMore }
    }
  }
}

export async function feed(viewer: Me | null, tab: 'popular' | 'following' | 'clan', cursor: string | undefined, limit: number) {
  if (tab === 'popular' || !viewer) return renderPage(await popularPage(viewer?.id ?? null, cursor, limit), viewer?.id ?? null)

  const base = and(isNull(posts.deletedAt), isNull(posts.wallRecipientId), visibleAuthorCondition(viewer.id))
  if (tab === 'following') {
    const followed = or(
      eq(posts.authorId, viewer.id),
      sql`${posts.authorId} in (select ${follows.followingId} from ${follows} where ${follows.followerId} = ${viewer.id})`
    )
    return renderPage(await keysetPage(and(base, followed), cursor, limit), viewer.id)
  }
  const sameClan = sql`${posts.authorId} in (select ${users.id} from ${users} where ${users.avatar} = ${viewer.avatar})`
  return renderPage(await keysetPage(and(base, sameClan), cursor, limit), viewer.id)
}

export async function userWall(
  target: UserRecord,
  viewer: Me | null,
  options: { cursor?: string; limit: number; sort: 'new' | 'popular'; pinnedPostId?: string }
) {
  const viewerId = viewer?.id ?? null
  if (viewerId !== target.id) {
    const relation = viewerId ? await loadRelation(viewerId, target.id) : undefined
    if (relation && (relation.blockedAt || relation.blockedBy)) throw forbidden('User blocked', 'BLOCKED')
    if (!canSeeContent(target, viewerId, relation)) throw forbidden('This account is private', 'PRIVATE_ACCOUNT')
  }

  const onWall = or(and(eq(posts.authorId, target.id), isNull(posts.wallRecipientId)), eq(posts.wallRecipientId, target.id))
  const pinnedId = options.sort === 'new' && options.pinnedPostId && options.pinnedPostId === target.pinnedPostId ? options.pinnedPostId : null
  const base = and(isNull(posts.deletedAt), onWall, visibleAuthorCondition(viewerId), pinnedId ? sql`${posts.id} <> ${pinnedId}` : undefined)

  if (options.sort === 'popular') {
    const offset = parseOffset(options.cursor)
    const rows = await db
      .select()
      .from(posts)
      .where(base)
      .orderBy(desc(posts.likesCount), desc(posts.createdAt), desc(posts.id))
      .limit(options.limit + 1)
      .offset(offset)
    const hasMore = rows.length > options.limit
    const page = rows.slice(0, options.limit)
    return renderPage({ rows: page, hasMore, nextCursor: hasMore ? String(offset + page.length) : null }, viewerId)
  }

  const page = await keysetPage(base, options.cursor, options.limit)
  let prepend: PostRow[] = []
  if (pinnedId && !decodeKeyset(options.cursor)) {
    const pinned = await findPost(pinnedId)
    if (pinned && !pinned.deletedAt) prepend = [pinned]
  }
  return renderPage(page, viewerId, prepend)
}

export async function likedPosts(target: UserRecord, viewer: Me | null, cursor: string | undefined, limit: number) {
  const viewerId = viewer?.id ?? null
  const relation = viewerId ? await loadRelation(viewerId, target.id) : undefined
  const empty = { data: { posts: [], pagination: { nextCursor: null, hasMore: false } } }
  if (!hasAccess(target.likesVisibility, relation, viewerId === target.id) || !canSeeContent(target, viewerId, relation)) return empty

  const key = decodeKeyset(cursor)
  const rows = await db
    .select({ post: posts, likedAt: postLikes.createdAt })
    .from(postLikes)
    .innerJoin(posts, eq(posts.id, postLikes.postId))
    .where(
      and(
        eq(postLikes.userId, target.id),
        isNull(posts.deletedAt),
        visibleAuthorCondition(viewerId),
        key ? sql`(${postLikes.createdAt}, ${postLikes.postId}) < (${key.t.toISOString()}::timestamptz, ${key.id}::uuid)` : undefined
      )
    )
    .orderBy(desc(postLikes.createdAt), desc(postLikes.postId))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return renderPage(
    { rows: page.map((r) => r.post), hasMore, nextCursor: hasMore && last ? encodeKeyset({ t: last.likedAt, id: last.post.id }) : null },
    viewerId
  )
}

export async function hashtagPosts(name: string, viewer: Me | null, cursor: string | undefined, limit: number) {
  const [tag] = await db.select().from(hashtags).where(eq(hashtags.name, name)).limit(1)
  if (!tag) return { data: { hashtag: null, posts: [], pagination: { nextCursor: null, hasMore: false } } }
  const viewerId = viewer?.id ?? null
  const key = decodeKeyset(cursor)
  const rows = await db
    .select({ post: posts, taggedAt: postHashtags.createdAt })
    .from(postHashtags)
    .innerJoin(posts, eq(posts.id, postHashtags.postId))
    .where(
      and(
        eq(postHashtags.hashtagId, tag.id),
        isNull(posts.deletedAt),
        visibleAuthorCondition(viewerId),
        key ? sql`(${postHashtags.createdAt}, ${postHashtags.postId}) < (${key.t.toISOString()}::timestamptz, ${key.id}::uuid)` : undefined
      )
    )
    .orderBy(desc(postHashtags.createdAt), desc(postHashtags.postId))
    .limit(limit + 1)
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const rendered = await renderPage(
    { rows: page.map((r) => r.post), hasMore, nextCursor: hasMore && last ? encodeKeyset({ t: last.taggedAt, id: last.post.id }) : null },
    viewerId
  )
  return { data: { hashtag: { id: tag.id, name: tag.name, postsCount: tag.postsCount }, ...rendered.data } }
}
