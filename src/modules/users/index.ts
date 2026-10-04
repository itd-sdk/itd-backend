import { and, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../../config'
import { db } from '../../db/client'
import { accounts, type AccessType, blocks, files, followRequests, follows, notificationSettings, pins, userPins, users } from '../../db/schema'
import { ApiError, badRequest, conflict, forbidden, notFound, validationError } from '../../lib/errors'
import { isReservedUsername, isSingleEmoji, validateDisplayName, validateUsername } from '../../lib/text'
import { addDays, iso } from '../../lib/time'
import { authPlugin, canRestore, loadProfile, readAuth } from '../../plugins/auth'
import { redis, rk } from '../../redis'
import {
  AccessTypeModel,
  MeModel,
  PageQuery,
  PinModel,
  PrivacyModel,
  SuccessModel,
  UserListItemModel,
  UserProfileModel,
  UsersPageModel,
  Uuid
} from '../../schemas'
import { getPresence } from '../../services/presence'
import { loadRelation, loadUserRecord, presentMe, presentProfile, requireTargetUser, targetBannedError, findUserByIdentifier } from '../../services/users'
import {
  acceptAllFollowRequests,
  acceptFollowRequest,
  block,
  follow,
  listConnections,
  rejectFollowRequest,
  renderUserPage,
  unblock,
  unfollow
} from './service'

const IdentifierParams = t.Object({ id: t.String({ maxLength: 512, description: 'User id, username or @username' }) })
const FollowResult = t.Object({ following: t.Boolean(), status: t.String(), followersCount: t.Integer() })

async function renderMe(userId: string) {
  const [record, [account]] = await Promise.all([loadUserRecord(userId), db.select().from(accounts).where(eq(accounts.id, userId)).limit(1)])
  if (!record || !account) throw notFound('Profile not found', 'PROFILE_NOT_FOUND')
  return presentMe(record, { telegram: account.telegram, roles: account.roles })
}

async function assertUsernameAvailable(username: string, exceptUserId?: string) {
  const error = validateUsername(username)
  if (error) throw validationError(error, 'username')
  if (isReservedUsername(username)) throw badRequest('This username is reserved by the system', 'USERNAME_RESERVED')
  const conditions = [sql`lower(${users.username}) = ${username.toLowerCase()}`]
  if (exceptUserId) conditions.push(ne(users.id, exceptUserId))
  const [taken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(...conditions))
    .limit(1)
  if (taken) throw new ApiError(409, 'USERNAME_TAKEN', 'Username is already taken')
}

function assertDisplayName(value: string) {
  const error = validateDisplayName(value)
  if (error) throw validationError(error, 'displayName')
  return value.trim()
}

function assertAvatar(value: string) {
  if (!value) throw validationError('Avatar cannot be empty', 'avatar')
  if (!isSingleEmoji(value)) throw validationError('Avatar must be a single valid emoji', 'avatar')
  return value
}

function presentPrivacy(user: { isPrivate: boolean; wallAccess: AccessType; likesVisibility: AccessType; messageAccess: AccessType; showLastSeen: boolean }) {
  return {
    isPrivate: user.isPrivate,
    wallAccess: user.wallAccess,
    likesVisibility: user.likesVisibility,
    messageAccess: user.messageAccess,
    showLastSeen: user.showLastSeen
  }
}

export const usersModule = new Elysia({ tags: ['Users'] })
  .use(authPlugin)

  // ------------------------------------------------------------ own profile

  .get(
    '/profile',
    async ({ request }) => {
      const auth = await readAuth(request, false)
      if (!auth) return { authenticated: false, user: null, banned: false, deleted: false, canRestore: false, profileRequired: false, userId: null, roles: null }
      const [profile, [account]] = await Promise.all([loadProfile(auth.accountId), db.select().from(accounts).where(eq(accounts.id, auth.accountId)).limit(1)])
      const roles = account?.roles ?? auth.roles
      return {
        authenticated: true,
        user: profile
          ? {
              id: profile.id,
              username: profile.username,
              displayName: profile.displayName,
              avatar: profile.avatar,
              verified: profile.verified,
              bio: profile.bio,
              isPhoneVerified: profile.phoneVerified,
              roles
            }
          : null,
        banned: !!account?.bannedAt,
        deleted: !!profile?.deletedAt,
        canRestore: profile?.deletedAt ? canRestore(profile) : false,
        profileRequired: !profile,
        userId: auth.accountId,
        roles,
        ...(profile ? {} : { message: 'Profile not found. Please create your profile first.' })
      }
    },
    { detail: { summary: 'Authentication state of the caller (works without a token)' } }
  )

  .get(
    '/users/check-username',
    async ({ query }) => {
      const username = query.username.trim()
      if (validateUsername(username) || isReservedUsername(username)) return { available: false }
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
        .limit(1)
      return { available: !taken }
    },
    { query: t.Object({ username: t.String({ maxLength: 64 }) }), response: t.Object({ available: t.Boolean() }) }
  )

  .post(
    '/users/profile',
    async ({ body, auth, set }) => {
      if (await loadProfile(auth.accountId)) throw conflict('Profile already exists', 'PROFILE_EXISTS')
      const username = body.username.trim()
      await assertUsernameAvailable(username)
      const displayName = assertDisplayName(body.displayName)
      const avatar = assertAvatar(body.avatar)
      await db.transaction(async (tx) => {
        await tx.insert(users).values({ id: auth.accountId, username, displayName, avatar, bio: body.bio?.trim() || null })
        await tx.insert(notificationSettings).values({ userId: auth.accountId }).onConflictDoNothing()
      })
      set.status = 201
      return renderMe(auth.accountId)
    },
    {
      account: true,
      body: t.Object({
        username: t.String({ maxLength: 64 }),
        displayName: t.String({ maxLength: 128 }),
        avatar: t.String({ maxLength: 64, description: 'Single emoji, also defines the clan' }),
        bio: t.Optional(t.String({ maxLength: config.content.bioMaxLength }))
      }),
      response: { 201: MeModel },
      detail: { summary: 'Create the profile after registration' }
    }
  )

  .get(
    '/users/me',
    async ({ auth }) => {
      const profile = await loadProfile(auth.accountId)
      if (!profile) throw notFound('Profile not found. Please create your profile first.', 'PROFILE_NOT_FOUND')
      return renderMe(auth.accountId)
    },
    { account: true, response: MeModel, detail: { summary: 'Current user (deleted accounts come with isDeleted / canRestore)' } }
  )

  .put(
    '/users/me',
    async ({ body, me }) => {
      const update: Partial<typeof users.$inferInsert> = { updatedAt: new Date() }
      if (body.username !== undefined && body.username.trim() !== me.username) {
        update.username = body.username.trim()
        await assertUsernameAvailable(update.username, me.id)
      }
      if (body.displayName !== undefined) update.displayName = assertDisplayName(body.displayName)
      if (body.bio !== undefined) {
        if (body.bio.length > config.content.bioMaxLength) throw validationError('Bio too long', 'bio')
        update.bio = body.bio.trim() || null
      }
      if (body.avatar !== undefined) update.avatar = assertAvatar(body.avatar)
      if (body.bannerId !== undefined) {
        if (body.bannerId === null) update.bannerFileId = null
        else {
          const [file] = await db
            .select()
            .from(files)
            .where(and(eq(files.id, body.bannerId), isNull(files.deletedAt)))
            .limit(1)
          if (!file) throw notFound('Banner file not found')
          if (file.ownerId !== me.id) throw forbidden('You can only use your own files as banner')
          if (file.kind !== 'image') throw validationError('Banner must be an image', 'bannerId')
          if (file.mimeType === 'image/gif' && !me.verified) throw forbidden('GIF banners are available only for verified users', 'GIF_REQUIRES_VERIFICATION')
          update.bannerFileId = file.id
        }
      }
      await db.update(users).set(update).where(eq(users.id, me.id))
      return renderMe(me.id)
    },
    {
      user: true,
      body: t.Object({
        username: t.Optional(t.String({ maxLength: 64 })),
        displayName: t.Optional(t.String({ maxLength: 128 })),
        bio: t.Optional(t.String({ maxLength: 2000 })),
        avatar: t.Optional(t.String({ maxLength: 64 })),
        bannerId: t.Optional(t.Nullable(Uuid))
      }),
      response: MeModel,
      detail: { summary: 'Update profile fields' }
    }
  )

  .delete(
    '/users/me',
    async ({ auth }) => {
      const profile = await loadProfile(auth.accountId)
      if (!profile) throw notFound('Profile not found', 'PROFILE_NOT_FOUND')
      if (profile.deletedAt) throw conflict('Account already deleted', 'ALREADY_DELETED')
      const restoreDeadline = addDays(new Date(), config.auth.accountRestoreDays)
      await db.update(users).set({ deletedAt: new Date(), restoreDeadline, updatedAt: new Date() }).where(eq(users.id, profile.id))
      return { success: true, restoreDeadline: restoreDeadline.toISOString() }
    },
    {
      account: true,
      response: t.Object({ success: t.Boolean(), restoreDeadline: t.String() }),
      detail: { summary: 'Delete the account (restorable until restoreDeadline)' }
    }
  )

  .post(
    '/users/me/restore',
    async ({ auth }) => {
      const profile = await loadProfile(auth.accountId)
      if (!profile) throw notFound('Profile not found', 'PROFILE_NOT_FOUND')
      if (!profile.deletedAt) throw conflict('Account is not deleted', 'NOT_DELETED')
      if (!canRestore(profile)) throw forbidden('Restore period has expired', 'RESTORE_EXPIRED')
      await db.update(users).set({ deletedAt: null, restoreDeadline: null, updatedAt: new Date() }).where(eq(users.id, profile.id))
      return { success: true }
    },
    { account: true, response: SuccessModel, detail: { summary: 'Restore a deleted account' } }
  )

  // ------------------------------------------------------------ privacy

  .get('/users/me/privacy', ({ me }) => presentPrivacy(me), { user: true, response: PrivacyModel })

  .put(
    '/users/me/privacy',
    async ({ body, me }) => {
      const update: Partial<typeof users.$inferInsert> = { updatedAt: new Date() }
      if (body.isPrivate !== undefined) update.isPrivate = body.isPrivate
      const wall = body.wallAccess ?? body.whoCanPostOnWall
      const likes = body.likesVisibility ?? body.whoCanSeeMyPostReactions
      const messages = body.messageAccess ?? body.whoCanMessageMe
      if (wall) update.wallAccess = wall
      if (likes) update.likesVisibility = likes
      if (messages) update.messageAccess = messages
      if (body.showLastSeen !== undefined) update.showLastSeen = body.showLastSeen

      const [updated] = await db.update(users).set(update).where(eq(users.id, me.id)).returning()
      if (me.isPrivate && updated!.isPrivate === false) await acceptAllFollowRequests(updated!)
      return presentPrivacy(updated!)
    },
    {
      user: true,
      body: t.Object({
        isPrivate: t.Optional(t.Boolean()),
        wallAccess: t.Optional(AccessTypeModel),
        likesVisibility: t.Optional(AccessTypeModel),
        messageAccess: t.Optional(AccessTypeModel),
        showLastSeen: t.Optional(t.Boolean()),
        whoCanPostOnWall: t.Optional(AccessTypeModel),
        whoCanSeeMyPostReactions: t.Optional(AccessTypeModel),
        whoCanMessageMe: t.Optional(AccessTypeModel)
      }),
      response: PrivacyModel
    }
  )

  // ------------------------------------------------------------ pins

  .get(
    '/users/me/pins',
    async ({ me }) => {
      const rows = await db
        .select({ slug: pins.slug, name: pins.name, description: pins.description, url: pins.url, grantedAt: userPins.grantedAt })
        .from(userPins)
        .innerJoin(pins, eq(pins.slug, userPins.pinSlug))
        .where(eq(userPins.userId, me.id))
        .orderBy(desc(userPins.grantedAt))
      return { data: { pins: rows.map((p) => ({ ...p, grantedAt: iso(p.grantedAt) })), activePin: me.activePinSlug } }
    },
    { user: true, response: t.Object({ data: t.Object({ pins: t.Array(PinModel), activePin: t.Nullable(t.String()) }) }) }
  )

  .put(
    '/users/me/pin',
    async ({ body, me }) => {
      const [owned] = await db
        .select()
        .from(userPins)
        .where(and(eq(userPins.userId, me.id), eq(userPins.pinSlug, body.slug)))
        .limit(1)
      if (!owned) throw forbidden('You do not own this pin', 'PIN_NOT_OWNED')
      await db.update(users).set({ activePinSlug: body.slug }).where(eq(users.id, me.id))
      return { success: true, activePin: body.slug }
    },
    { user: true, body: t.Object({ slug: t.String({ maxLength: 64 }) }), response: t.Object({ success: t.Boolean(), activePin: t.String() }) }
  )

  .delete(
    '/users/me/pin',
    async ({ me }) => {
      await db.update(users).set({ activePinSlug: null }).where(eq(users.id, me.id))
      return { success: true }
    },
    { user: true, response: SuccessModel }
  )

  // ------------------------------------------------------------ blocks & follow requests

  .get(
    '/users/me/blocked',
    async ({ me, query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 20
      const where = and(eq(blocks.blockerId, me.id), isNull(users.deletedAt))
      const [rows, [total]] = await Promise.all([
        db
          .select({ id: users.id, blockedAt: blocks.createdAt })
          .from(blocks)
          .innerJoin(users, eq(users.id, blocks.blockedId))
          .where(where)
          .orderBy(desc(blocks.createdAt))
          .limit(limit)
          .offset((page - 1) * limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(blocks)
          .innerJoin(users, eq(users.id, blocks.blockedId))
          .where(where)
      ])
      return renderUserPage(
        rows.map((r) => r.id),
        me.id,
        page,
        limit,
        total?.count ?? 0,
        new Map(rows.map((r) => [r.id, r.blockedAt]))
      )
    },
    { user: true, query: PageQuery, response: UsersPageModel, detail: { summary: 'Users I blocked' } }
  )

  .get(
    '/users/me/follow-requests',
    async ({ me, query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 20
      const where = and(eq(followRequests.targetId, me.id), isNull(users.deletedAt))
      const [rows, [total]] = await Promise.all([
        db
          .select({ id: users.id })
          .from(followRequests)
          .innerJoin(users, eq(users.id, followRequests.requesterId))
          .where(where)
          .orderBy(desc(followRequests.createdAt))
          .limit(limit)
          .offset((page - 1) * limit),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(followRequests)
          .innerJoin(users, eq(users.id, followRequests.requesterId))
          .where(where)
      ])
      return renderUserPage(
        rows.map((r) => r.id),
        me.id,
        page,
        limit,
        total?.count ?? 0
      )
    },
    { user: true, query: PageQuery, response: UsersPageModel, detail: { summary: 'Pending follow requests (private accounts)' } }
  )

  .post('/users/me/follow-requests/:userId/accept', ({ me, params }) => acceptFollowRequest(me, params.userId), {
    user: true,
    params: t.Object({ userId: Uuid }),
    detail: { summary: 'Accept a follow request' }
  })

  .delete('/users/me/follow-requests/:userId', ({ me, params }) => rejectFollowRequest(me, params.userId), {
    user: true,
    params: t.Object({ userId: Uuid }),
    response: SuccessModel,
    detail: { summary: 'Reject a follow request' }
  })

  .post(
    '/users/follow-status',
    async ({ body, me }) => {
      const ids = [...new Set(body.userIds)]
      const rows = ids.length
        ? await db
            .select({ id: follows.followingId })
            .from(follows)
            .where(and(eq(follows.followerId, me.id), inArray(follows.followingId, ids)))
        : []
      const following = new Set(rows.map((r) => r.id))
      return { data: Object.fromEntries(ids.map((id) => [id, following.has(id)])) }
    },
    {
      user: true,
      body: t.Object({ userIds: t.Array(Uuid, { maxItems: 100 }) }),
      response: t.Object({ data: t.Record(t.String(), t.Boolean()) }),
      detail: { summary: 'Whether I follow each of the given users' }
    }
  )

  // ------------------------------------------------------------ discovery

  .get(
    '/users/stats/top-clans',
    async () => {
      const cacheKey = rk('cache', 'top-clans')
      const cached = await redis.get(cacheKey)
      if (cached) return JSON.parse(cached)
      const rows = await db
        .select({ avatar: users.avatar, memberCount: sql<number>`count(*)::int` })
        .from(users)
        .where(and(isNull(users.deletedAt), eq(users.isBanned, false)))
        .groupBy(users.avatar)
        .orderBy(desc(sql`count(*)`))
        .limit(20)
      const result = { clans: rows }
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 300)
      return result
    },
    {
      response: t.Object({ clans: t.Array(t.Object({ avatar: t.String(), memberCount: t.Integer() })) }),
      detail: { summary: 'Largest clans (users grouped by emoji avatar)' }
    }
  )

  .get(
    '/users/suggestions/who-to-follow',
    async ({ me }) => {
      const notFollowed = (column: SQL) =>
        sql`${column} <> ${me.id}
          and not exists (select 1 from ${follows} f3 where f3.follower_id = ${me.id} and f3.following_id = ${column})
          and not exists (select 1 from ${blocks} b where (b.blocker_id = ${me.id} and b.blocked_id = ${column}) or (b.blocker_id = ${column} and b.blocked_id = ${me.id}))`

      const friendsOfFriends = await db.execute<{ id: string }>(sql`
        select u.id from ${follows} f1
        join ${follows} f2 on f2.follower_id = f1.following_id
        join ${users} u on u.id = f2.following_id
        where f1.follower_id = ${me.id} and u.deleted_at is null and not u.is_banned and ${notFollowed(sql.raw('u.id'))}
        group by u.id, u.followers_count
        order by count(*) desc, u.followers_count desc
        limit 10
      `)
      const ids = friendsOfFriends.map((r) => r.id)
      if (ids.length < 10) {
        const popular = await db
          .select({ id: users.id })
          .from(users)
          .where(and(isNull(users.deletedAt), eq(users.isBanned, false), notFollowed(sql`${users.id}`), ids.length ? sql`${users.id} <> all(${sql.param(ids)}::uuid[])` : undefined))
          .orderBy(desc(users.followersCount), desc(users.createdAt))
          .limit(10 - ids.length)
        ids.push(...popular.map((p) => p.id))
      }
      const page = await renderUserPage(ids, me.id, 1, ids.length || 1, ids.length)
      return { users: page.data.users }
    },
    { user: true, response: t.Object({ users: t.Array(UserListItemModel) }), detail: { summary: 'Follow suggestions' } }
  )

  // ------------------------------------------------------------ other users

  .get(
    '/users/:id',
    async ({ params, me }) => {
      const user = await findUserByIdentifier(params.id)
      if (!user || (user.deletedAt && user.id !== me?.id)) throw notFound('User not found')
      if (user.isBanned) throw targetBannedError()
      const viewerId = me?.id ?? null
      const [relation, presence] = await Promise.all([loadRelation(viewerId, user.id), getPresence([user])])
      return presentProfile(user, viewerId, relation, presence.get(user.id))
    },
    { optionalUser: true, params: IdentifierParams, response: UserProfileModel, detail: { summary: 'User profile by id or username' } }
  )

  .post('/users/:id/follow', async ({ params, me }) => follow(me, await requireTargetUser(params.id, me)), {
    user: true,
    params: IdentifierParams,
    response: FollowResult,
    detail: { summary: 'Follow (or request to follow a private account)' }
  })

  .delete('/users/:id/follow', async ({ params, me }) => unfollow(me, await requireTargetUser(params.id, me)), {
    user: true,
    params: IdentifierParams,
    response: FollowResult,
    detail: { summary: 'Unfollow or cancel a follow request' }
  })

  .get(
    '/users/:id/followers',
    async ({ params, query, me }) => listConnections(await requireTargetUser(params.id, me), 'followers', me?.id ?? null, query.page ?? 1, query.limit ?? 20),
    { optionalUser: true, params: IdentifierParams, query: PageQuery, response: UsersPageModel }
  )

  .get(
    '/users/:id/following',
    async ({ params, query, me }) => listConnections(await requireTargetUser(params.id, me), 'following', me?.id ?? null, query.page ?? 1, query.limit ?? 20),
    { optionalUser: true, params: IdentifierParams, query: PageQuery, response: UsersPageModel }
  )

  .post('/users/:id/block', async ({ params, me }) => block(me, await requireTargetUser(params.id, me)), {
    user: true,
    params: IdentifierParams,
    response: t.Object({ success: t.Boolean(), blockedAt: t.String() })
  })

  .delete('/users/:id/block', async ({ params, me }) => unblock(me, await requireTargetUser(params.id, me)), {
    user: true,
    params: IdentifierParams,
    response: SuccessModel
  })
