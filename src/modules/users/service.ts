import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../db/client'
import { blocks, followRequests, follows, users } from '../../db/schema'
import { badRequest, conflict, forbidden } from '../../lib/errors'
import type { Me } from '../../plugins/auth'
import { notify, removeNotifications } from '../../services/notifications'
import { enforceActionLimit } from '../../services/rate-limit'
import { canSeeContent, isBlockedBetween, loadRelation, loadRelations, loadUserRecords, presentListItem, type UserRecord } from '../../services/users'

async function adjustFollowCounters(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], followerId: string, followingId: string, delta: 1 | -1) {
  await tx
    .update(users)
    .set({ followingCount: sql`greatest(${users.followingCount} + ${delta}, 0)` })
    .where(eq(users.id, followerId))
  const [row] = await tx
    .update(users)
    .set({ followersCount: sql`greatest(${users.followersCount} + ${delta}, 0)` })
    .where(eq(users.id, followingId))
    .returning({ followersCount: users.followersCount })
  return row?.followersCount ?? 0
}

async function followersCountOf(userId: string) {
  const [row] = await db.select({ count: users.followersCount }).from(users).where(eq(users.id, userId))
  return row?.count ?? 0
}

export async function follow(me: Me, target: UserRecord) {
  if (target.id === me.id) throw badRequest('Cannot follow yourself')
  await enforceActionLimit('follow', me.id)
  if (await isBlockedBetween(me.id, target.id)) throw forbidden('User blocked', 'BLOCKED')

  const relation = await loadRelation(me.id, target.id)
  if (relation.following) throw conflict('Already following this user')

  if (target.isPrivate) {
    if (relation.requested) throw conflict('Follow request already sent')
    await db.insert(followRequests).values({ requesterId: me.id, targetId: target.id }).onConflictDoNothing()
    await notify({ recipientId: target.id, actorId: me.id, type: 'follow_request', dedupeKey: `follow_request:${me.id}` })
    return { following: false, status: 'requested' as const, followersCount: target.followersCount }
  }

  const followersCount = await db.transaction(async (tx) => {
    const inserted = await tx.insert(follows).values({ followerId: me.id, followingId: target.id }).onConflictDoNothing().returning()
    if (inserted.length === 0) throw conflict('Already following this user')
    return adjustFollowCounters(tx, me.id, target.id, 1)
  })
  await notify({ recipientId: target.id, actorId: me.id, type: 'follow', dedupeKey: `follow:${me.id}` })
  return { following: true, status: 'following' as const, followersCount }
}

export async function unfollow(me: Me, target: UserRecord) {
  const followersCount = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(follows)
      .where(and(eq(follows.followerId, me.id), eq(follows.followingId, target.id)))
      .returning()
    await tx.delete(followRequests).where(and(eq(followRequests.requesterId, me.id), eq(followRequests.targetId, target.id)))
    if (removed.length === 0) return null
    return adjustFollowCounters(tx, me.id, target.id, -1)
  })
  await removeNotifications({ recipientId: target.id, actorId: me.id, type: 'follow_request' })
  return { following: false, status: 'none' as const, followersCount: followersCount ?? (await followersCountOf(target.id)) }
}

/** Removes both follow directions and pending requests between two users (used by blocking) */
async function severRelations(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], a: string, b: string) {
  for (const [follower, following] of [
    [a, b],
    [b, a]
  ] as const) {
    const removed = await tx
      .delete(follows)
      .where(and(eq(follows.followerId, follower), eq(follows.followingId, following)))
      .returning()
    if (removed.length) await adjustFollowCounters(tx, follower, following, -1)
  }
  await tx
    .delete(followRequests)
    .where(
      sql`(${followRequests.requesterId} = ${a} and ${followRequests.targetId} = ${b}) or (${followRequests.requesterId} = ${b} and ${followRequests.targetId} = ${a})`
    )
}

export async function block(me: Me, target: UserRecord) {
  if (target.id === me.id) throw badRequest('Cannot block yourself')
  const blockedAt = await db.transaction(async (tx) => {
    const [row] = await tx.insert(blocks).values({ blockerId: me.id, blockedId: target.id }).onConflictDoNothing().returning()
    if (!row) throw conflict('User already blocked')
    await severRelations(tx, me.id, target.id)
    // a pinned post on the other user's wall is no longer welcome
    await tx.execute(
      sql`update ${users} set pinned_post_id = null where id = ${me.id} and pinned_post_id in (select id from posts where author_id = ${target.id})`
    )
    return row.createdAt
  })
  return { success: true, blockedAt: blockedAt.toISOString() }
}

export async function unblock(me: Me, target: UserRecord) {
  const removed = await db
    .delete(blocks)
    .where(and(eq(blocks.blockerId, me.id), eq(blocks.blockedId, target.id)))
    .returning()
  if (removed.length === 0) throw conflict('User is not blocked')
  return { success: true }
}

export async function acceptFollowRequest(me: Me, requesterId: string) {
  const followersCount = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(followRequests)
      .where(and(eq(followRequests.requesterId, requesterId), eq(followRequests.targetId, me.id)))
      .returning()
    if (removed.length === 0) throw badRequest('Follow request not found', 'NOT_FOUND')
    const inserted = await tx.insert(follows).values({ followerId: requesterId, followingId: me.id }).onConflictDoNothing().returning()
    return inserted.length ? adjustFollowCounters(tx, requesterId, me.id, 1) : null
  })
  await removeNotifications({ recipientId: me.id, actorId: requesterId, type: 'follow_request' })
  await notify({ recipientId: requesterId, actorId: me.id, type: 'follow_accepted', dedupeKey: `follow_accepted:${me.id}` })
  return { success: true, followersCount: followersCount ?? (await followersCountOf(me.id)) }
}

export async function rejectFollowRequest(me: Me, requesterId: string) {
  await db.delete(followRequests).where(and(eq(followRequests.requesterId, requesterId), eq(followRequests.targetId, me.id)))
  await removeNotifications({ recipientId: me.id, actorId: requesterId, type: 'follow_request' })
  return { success: true }
}

/** Accepts every pending request (account switched from private to public) */
export async function acceptAllFollowRequests(me: Me) {
  const pending = await db.select({ requesterId: followRequests.requesterId }).from(followRequests).where(eq(followRequests.targetId, me.id))
  for (const request of pending) await acceptFollowRequest(me, request.requesterId).catch(() => null)
}

// ---------------------------------------------------------------- lists

type ListKind = 'followers' | 'following'

export async function listConnections(target: UserRecord, kind: ListKind, viewerId: string | null, page: number, limit: number) {
  if (viewerId !== target.id) {
    const relation = viewerId ? await loadRelation(viewerId, target.id) : undefined
    if (relation && (relation.blockedAt || relation.blockedBy)) throw forbidden('User blocked', 'BLOCKED')
    if (!canSeeContent(target, viewerId, relation)) throw forbidden('This account is private', 'PRIVATE_ACCOUNT')
  }
  const joinColumn = kind === 'followers' ? follows.followerId : follows.followingId
  const filterColumn = kind === 'followers' ? follows.followingId : follows.followerId
  const where = and(eq(filterColumn, target.id), isNull(users.deletedAt), eq(users.isBanned, false))

  const [rows, [total]] = await Promise.all([
    db
      .select({ id: users.id })
      .from(follows)
      .innerJoin(users, eq(users.id, joinColumn))
      .where(where)
      .orderBy(desc(follows.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(follows)
      .innerJoin(users, eq(users.id, joinColumn))
      .where(where)
  ])
  return renderUserPage(
    rows.map((r) => r.id),
    viewerId,
    page,
    limit,
    total?.count ?? 0
  )
}

export async function renderUserPage(ids: string[], viewerId: string | null, page: number, limit: number, total: number, blockedAt?: Map<string, Date>) {
  const [records, relations] = await Promise.all([loadUserRecords(ids), loadRelations(viewerId, ids)])
  const usersList = ids
    .map((id) => records.get(id))
    .filter((u): u is UserRecord => !!u)
    .map((u) => presentListItem(u, relations.get(u.id), blockedAt ? { blockedAt: blockedAt.get(u.id) ?? null } : {}))
  return { data: { users: usersList, pagination: { page, limit, total, hasMore: page * limit < total } } }
}
