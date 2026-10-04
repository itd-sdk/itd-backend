import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { validate as isUuid } from 'uuid'
import { db, type Executor } from '../db/client'
import { type AccessType, blocks, eventNicknames, eventWallets, files, followRequests, follows, pins, subscriptions, userPins, users } from '../db/schema'
import { ApiError, notFound, uriTooLong } from '../lib/errors'
import { iso, lastSeenFrom } from '../lib/time'
import type { Me } from '../plugins/auth'
import { getPresence, type Presence } from './presence'

const avatarFile = alias(files, 'avatar_file')
const bannerFile = alias(files, 'banner_file')

export type PinView = { slug: string; name: string; description: string; url: string | null; grantedAt: string | null }
export type NicknameView = { id: string; label: string; styleKey: string; eventId: string; expiresAt: string; stateVersion: number }

export type UserRecord = Me & {
  avatarUrl: string | null
  bannerUrl: string | null
  pin: PinView | null
  subscriptionExpiresAt: Date | null
  subscriptionAutoRenewal: boolean
  nickname: NicknameView | null
}

export const isSubscriptionActive = (expiresAt: Date | null | undefined) => !!expiresAt && expiresAt.getTime() > Date.now()

/** Loads users with everything needed to render them (pin, picture avatar, banner, subscription, nickname) */
export async function loadUserRecords(ids: string[], executor: Executor = db): Promise<Map<string, UserRecord>> {
  const unique = [...new Set(ids.filter(Boolean))]
  const result = new Map<string, UserRecord>()
  if (unique.length === 0) return result

  const rows = await executor
    .select({
      user: users,
      avatarUrl: avatarFile.url,
      bannerUrl: bannerFile.url,
      pinSlug: pins.slug,
      pinName: pins.name,
      pinDescription: pins.description,
      pinUrl: pins.url,
      pinGrantedAt: userPins.grantedAt,
      subscriptionExpiresAt: subscriptions.expiresAt,
      subscriptionAutoRenewal: subscriptions.autoRenewal,
      nicknameId: eventNicknames.id,
      nicknameLabel: eventNicknames.label,
      nicknameStyle: eventNicknames.styleKey,
      nicknameEvent: eventNicknames.eventId,
      nicknameExpiresAt: eventNicknames.expiresAt
    })
    .from(users)
    .leftJoin(avatarFile, and(eq(avatarFile.id, users.avatarFileId), isNull(avatarFile.deletedAt)))
    .leftJoin(bannerFile, and(eq(bannerFile.id, users.bannerFileId), isNull(bannerFile.deletedAt)))
    .leftJoin(pins, eq(pins.slug, users.activePinSlug))
    .leftJoin(userPins, and(eq(userPins.userId, users.id), eq(userPins.pinSlug, users.activePinSlug)))
    .leftJoin(subscriptions, eq(subscriptions.userId, users.id))
    .leftJoin(eventWallets, eq(eventWallets.userId, users.id))
    .leftJoin(eventNicknames, and(eq(eventNicknames.id, eventWallets.activeNicknameId), gt(eventNicknames.expiresAt, sql`now()`)))
    .where(inArray(users.id, unique))

  for (const row of rows) {
    result.set(row.user.id, {
      ...row.user,
      avatarUrl: row.avatarUrl,
      bannerUrl: row.bannerUrl,
      pin: row.pinSlug
        ? { slug: row.pinSlug, name: row.pinName!, description: row.pinDescription ?? '', url: row.pinUrl, grantedAt: iso(row.pinGrantedAt) }
        : null,
      subscriptionExpiresAt: row.subscriptionExpiresAt,
      subscriptionAutoRenewal: row.subscriptionAutoRenewal ?? true,
      nickname: row.nicknameId
        ? {
            id: row.nicknameId,
            label: row.nicknameLabel!,
            styleKey: row.nicknameStyle!,
            eventId: row.nicknameEvent!,
            expiresAt: row.nicknameExpiresAt!.toISOString(),
            stateVersion: 0
          }
        : null
    })
  }
  return result
}

export async function loadUserRecord(id: string, executor: Executor = db) {
  return (await loadUserRecords([id], executor)).get(id) ?? null
}

/** Accepts a uuid, a username or "@username" */
export async function findUserByIdentifier(identifier: string): Promise<UserRecord | null> {
  const value = decodeURIComponent(identifier).replace(/^@/, '').trim()
  if (value.length > 64) throw uriTooLong('Username is too long')
  if (!value) return null
  if (isUuid(value)) return loadUserRecord(value)
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${value.toLowerCase()}`)
    .limit(1)
  return row ? loadUserRecord(row.id) : null
}

export const targetBannedError = () => new ApiError(403, 'USER_BANNED', 'Этот аккаунт заблокирован')

/** Resolves a user that other people may interact with (exists, not deleted, not banned) */
export async function requireTargetUser(identifier: string, me?: { id: string } | null) {
  const user = await findUserByIdentifier(identifier)
  if (!user || (user.deletedAt && user.id !== me?.id)) throw notFound('User not found')
  if (user.isBanned) throw targetBannedError()
  return user
}

// ---------------------------------------------------------------- relations

export type Relation = {
  following: boolean
  followedBy: boolean
  blockedAt: Date | null
  blockedBy: boolean
  requested: boolean
  requestIn: boolean
}

const EMPTY_RELATION: Relation = { following: false, followedBy: false, blockedAt: null, blockedBy: false, requested: false, requestIn: false }

export async function loadRelations(viewerId: string | null | undefined, ids: string[], executor: Executor = db): Promise<Map<string, Relation>> {
  const map = new Map<string, Relation>()
  const targets = [...new Set(ids)].filter((id) => id && id !== viewerId)
  for (const id of ids) map.set(id, { ...EMPTY_RELATION })
  if (!viewerId || targets.length === 0) return map

  const list = sql.param(targets)
  const rows = await executor.execute<{ kind: string; uid: string; at: Date }>(sql`
    select 'following' as kind, following_id as uid, created_at as at from ${follows} where follower_id = ${viewerId} and following_id = any(${list}::uuid[])
    union all select 'followed_by', follower_id, created_at from ${follows} where following_id = ${viewerId} and follower_id = any(${list}::uuid[])
    union all select 'blocking', blocked_id, created_at from ${blocks} where blocker_id = ${viewerId} and blocked_id = any(${list}::uuid[])
    union all select 'blocked_by', blocker_id, created_at from ${blocks} where blocked_id = ${viewerId} and blocker_id = any(${list}::uuid[])
    union all select 'requested', target_id, created_at from ${followRequests} where requester_id = ${viewerId} and target_id = any(${list}::uuid[])
    union all select 'request_in', requester_id, created_at from ${followRequests} where target_id = ${viewerId} and requester_id = any(${list}::uuid[])
  `)
  for (const row of rows) {
    const relation = map.get(row.uid)!
    if (row.kind === 'following') relation.following = true
    else if (row.kind === 'followed_by') relation.followedBy = true
    else if (row.kind === 'blocking') relation.blockedAt = new Date(row.at)
    else if (row.kind === 'blocked_by') relation.blockedBy = true
    else if (row.kind === 'requested') relation.requested = true
    else if (row.kind === 'request_in') relation.requestIn = true
  }
  return map
}

export async function loadRelation(viewerId: string | null | undefined, targetId: string, executor: Executor = db) {
  return (await loadRelations(viewerId, [targetId], executor)).get(targetId) ?? { ...EMPTY_RELATION }
}

export async function isBlockedBetween(a: string, b: string, executor: Executor = db) {
  if (a === b) return false
  const rows = await executor
    .select({ one: sql`1` })
    .from(blocks)
    .where(sql`(${blocks.blockerId} = ${a} and ${blocks.blockedId} = ${b}) or (${blocks.blockerId} = ${b} and ${blocks.blockedId} = ${a})`)
    .limit(1)
  return rows.length > 0
}

/** Access check for wall posts / liked posts / messages from the viewer's side */
export function hasAccess(access: AccessType, relation: Relation | undefined, isSelf: boolean) {
  if (isSelf) return true
  if (!relation || relation.blockedAt || relation.blockedBy) return false
  switch (access) {
    case 'everyone':
      return true
    case 'followers':
      return relation.following
    case 'mutual':
      return relation.following && relation.followedBy
    default:
      return false
  }
}

/** Private accounts show content only to followers */
export function canSeeContent(author: Pick<Me, 'id' | 'isPrivate'>, viewerId: string | null | undefined, relation?: Relation) {
  if (author.id === viewerId) return true
  if (relation && (relation.blockedAt || relation.blockedBy)) return false
  return !author.isPrivate || !!relation?.following
}

// ---------------------------------------------------------------- presenters

export function presentBrief(user: UserRecord) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatarUrl ?? user.avatar,
    clanAvatar: user.avatar,
    verified: user.verified,
    hasNuksta: isSubscriptionActive(user.subscriptionExpiresAt),
    pin: user.pin,
    activeNickname: user.nickname
  }
}

export type UserBrief = ReturnType<typeof presentBrief>

export function presentListItem(user: UserRecord, relation?: Relation, extra: { blockedAt?: Date | null } = {}) {
  return {
    ...presentBrief(user),
    bio: user.bio,
    isPrivate: user.isPrivate,
    isFollowing: relation?.following ?? false,
    isFollowedBy: relation?.followedBy ?? false,
    followersCount: user.followersCount,
    ...(extra.blockedAt !== undefined ? { blockedAt: iso(extra.blockedAt) } : {})
  }
}

export function presentProfile(user: UserRecord, viewerId: string | null, relation: Relation | undefined, presence: Presence | undefined) {
  const isSelf = viewerId === user.id
  const rel = relation ?? EMPTY_RELATION
  const blocked = !isSelf && (!!rel.blockedAt || rel.blockedBy)
  const showPresence = !blocked && (user.showLastSeen || isSelf)
  const online = showPresence && !!presence?.online

  return {
    ...presentBrief(user),
    banner: blocked ? null : user.bannerUrl,
    bio: blocked ? null : user.bio,
    isFollowing: rel.following,
    isFollowedBy: rel.followedBy,
    hasOutgoingRequest: rel.requested,
    hasIncomingRequest: rel.requestIn,
    isBlockedByMe: !!rel.blockedAt,
    isBlockedByThem: rel.blockedBy && !rel.blockedAt,
    blockedAt: iso(rel.blockedAt),
    followersCount: blocked ? null : user.followersCount,
    followingCount: blocked ? null : user.followingCount,
    postsCount: blocked ? null : user.postsCount,
    wallAccess: blocked ? null : user.wallAccess,
    likesVisibility: blocked ? null : user.likesVisibility,
    isPrivate: blocked ? null : user.isPrivate,
    canMessage: !blocked && hasAccess(user.messageAccess, rel, isSelf),
    canPostOnWall: !isSelf && !blocked && !!viewerId && hasAccess(user.wallAccess, rel, false),
    canSeeLikes: hasAccess(user.likesVisibility, rel, isSelf),
    lastSeen: showPresence ? (online ? { unit: 'just_now' as const, value: null } : lastSeenFrom(presence?.lastSeenAt ?? user.lastSeenAt)) : null,
    online,
    pinnedPostId: blocked ? null : user.pinnedPostId,
    createdAt: blocked ? null : iso(user.createdAt)
  }
}

export async function presentProfiles(list: UserRecord[], viewerId: string | null) {
  const [relations, presence] = await Promise.all([
    loadRelations(
      viewerId,
      list.map((u) => u.id)
    ),
    getPresence(list)
  ])
  return list.map((user) => presentProfile(user, viewerId, relations.get(user.id), presence.get(user.id)))
}

export function presentMe(user: UserRecord, account: { telegram: string; roles: string[] }) {
  return {
    ...presentBrief(user),
    banner: user.bannerUrl,
    bio: user.bio,
    // the web client shows `email` in settings
    email: `@${account.telegram}`,
    telegram: account.telegram,
    roles: account.roles,
    wallAccess: user.wallAccess,
    likesVisibility: user.likesVisibility,
    messageAccess: user.messageAccess,
    isPrivate: user.isPrivate,
    showLastSeen: user.showLastSeen,
    isPhoneVerified: user.phoneVerified,
    subscription: {
      isActive: isSubscriptionActive(user.subscriptionExpiresAt),
      expiresAt: iso(user.subscriptionExpiresAt),
      autoRenewal: user.subscriptionAutoRenewal
    },
    followersCount: user.followersCount,
    followingCount: user.followingCount,
    postsCount: user.postsCount,
    pinnedPostId: user.pinnedPostId,
    createdAt: user.createdAt.toISOString(),
    isDeleted: !!user.deletedAt,
    ...(user.deletedAt ? { canRestore: !user.restoreDeadline || user.restoreDeadline.getTime() > Date.now(), restoreDeadline: iso(user.restoreDeadline) } : {})
  }
}

export async function loadBriefs(ids: string[], executor: Executor = db) {
  const records = await loadUserRecords(ids, executor)
  const briefs = new Map<string, UserBrief>()
  for (const [id, record] of records) briefs.set(id, presentBrief(record))
  return { records, briefs }
}
