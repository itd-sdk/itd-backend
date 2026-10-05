import { beforeAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/client'
import { userPins } from '../src/db/schema'
import { api, createPost, createUser, pressStart, resetState } from './helpers'

beforeAll(resetState)

async function registerWithoutProfile(telegram: string) {
  await pressStart(telegram)
  const signUp = await api('POST', '/v1/auth/sign-up', { body: { telegram, password: 'correct-horse-battery' } })
  const { otp, flowToken } = signUp.body
  return (await api('POST', '/v1/auth/verify-otp', { body: { telegram, otp, flowToken } })).body.accessToken as string
}

describe('profile creation', () => {
  test('profile is required after registration', async () => {
    const token = await registerWithoutProfile('fresh_user')
    const me = await api('GET', '/users/me', { token })
    expect(me.status).toBe(404)
    expect(me.body.error.code).toBe('PROFILE_NOT_FOUND')
    expect((await api('GET', '/profile', { token })).body).toMatchObject({ authenticated: true, profileRequired: true, user: null })
    expect((await api('GET', '/posts?tab=following', { token })).body.error?.code).toBeUndefined()
    expect((await api('POST', '/posts', { token, body: { content: 'hi' } })).body.error.code).toBe('PROFILE_REQUIRED')
    expect((await api('GET', '/profile')).body.authenticated).toBe(false)
  })

  test('validates username, display name and emoji avatar', async () => {
    const token = await registerWithoutProfile('validate_user')
    const create = (body: Record<string, string>) => api('POST', '/users/profile', { token, body: { username: 'valid_name', displayName: 'Name', avatar: '🦊', ...body } })
    expect((await create({ username: '1abc' })).body.error.code).toBe('VALIDATION_ERROR')
    expect((await create({ username: 'admin' })).body.error.code).toBe('USERNAME_RESERVED')
    expect((await create({ avatar: 'ab' })).body.error.message).toBe('Avatar must be a single valid emoji')
    expect((await create({ displayName: '   ' })).body.error.message).toBe('Display name cannot be empty')
    const ok = await create({})
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ username: 'valid_name', avatar: '🦊', clanAvatar: '🦊', followersCount: 0, isDeleted: false })
    expect(ok.body.subscription).toEqual({ isActive: true, expiresAt: null, autoRenewal: false })
    expect(ok.body.hasNuksta).toBeUndefined()
    expect((await create({ username: 'other_name' })).body.error.code).toBe('PROFILE_EXISTS')

    const another = await registerWithoutProfile('another_user')
    const taken = await api('POST', '/users/profile', { token: another, body: { username: 'VALID_NAME', displayName: 'X', avatar: '🦊' } })
    expect(taken.status).toBe(409)
    expect(taken.body.error.code).toBe('USERNAME_TAKEN')
    expect((await api('GET', '/users/check-username?username=Valid_Name')).body).toEqual({ available: false })
    expect((await api('GET', '/users/check-username?username=free_name')).body).toEqual({ available: true })
  })
})

describe('profiles & privacy', () => {
  test('me, profile by username/id, update', async () => {
    const alice = await createUser({ avatar: '🦊' })
    const bob = await createUser()
    const byName = await api('GET', `/users/${alice.username}`, { token: bob.token })
    const byId = await api('GET', `/users/${alice.id}`)
    const byAt = await api('GET', `/users/@${alice.username.toUpperCase()}`)
    expect(byName.body.id).toBe(alice.id)
    expect(byId.body.username).toBe(alice.username)
    expect(byAt.body.id).toBe(alice.id)
    expect(byName.body).toMatchObject({ isFollowing: false, isBlockedByMe: false, wallAccess: 'everyone', online: true })

    const updated = await api('PUT', '/users/me', { token: alice.token, body: { bio: 'Привет!', displayName: 'Алиса', avatar: '🐺' } })
    expect(updated.body).toMatchObject({ bio: 'Привет!', displayName: 'Алиса', clanAvatar: '🐺' })
    expect((await api('PUT', '/users/me', { token: alice.token, body: { bio: 'x'.repeat(600) } })).body.error.message).toBe('Bio too long')
    expect((await api('GET', '/users/nobody_here')).status).toBe(404)
    expect((await api('GET', `/users/${'a'.repeat(100)}`)).status).toBe(414)
  })

  test('privacy settings (both naming styles) and hidden last seen', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const updated = await api('PUT', '/users/me/privacy', { token: alice.token, body: { whoCanPostOnWall: 'followers', likesVisibility: 'nobody', showLastSeen: false } })
    expect(updated.body).toEqual({ isPrivate: false, wallAccess: 'followers', likesVisibility: 'nobody', messageAccess: 'everyone', showLastSeen: false })
    const seen = await api('GET', `/users/${alice.username}`, { token: bob.token })
    expect(seen.body).toMatchObject({ lastSeen: null, online: false, wallAccess: 'followers', likesVisibility: 'nobody' })
    // fields the official API does not have
    for (const field of ['canPostOnWall', 'canSeeLikes', 'hasOutgoingRequest', 'hasIncomingRequest']) expect(seen.body).not.toHaveProperty(field)
    expect((await api('PUT', '/users/me/privacy', { token: alice.token, body: { wallAccess: 'sometimes' } })).status).toBe(422)
  })
})

describe('follows', () => {
  test('follow / unfollow keep counters and statuses', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const follow = await api('POST', `/users/${bob.username}/follow`, { token: alice.token })
    expect(follow.body).toEqual({ following: true, status: 'following', followersCount: 1 })
    expect((await api('POST', `/users/${bob.username}/follow`, { token: alice.token })).status).toBe(409)
    expect((await api('POST', `/users/${alice.username}/follow`, { token: alice.token })).body.error.message).toBe('Cannot follow yourself')

    const status = await api('POST', '/users/follow-status', { token: alice.token, body: { userIds: [bob.id, alice.id] } })
    expect(status.body.data).toEqual({ [bob.id]: true, [alice.id]: false })
    const profile = await api('GET', `/users/${alice.username}`, { token: bob.token })
    expect(profile.body).toMatchObject({ isFollowedBy: true, followingCount: 1 })

    const followers = await api('GET', `/users/${bob.username}/followers`)
    expect(followers.body.data.users.map((u: any) => u.id)).toEqual([alice.id])
    expect(followers.body.data.pagination).toEqual({ page: 1, limit: 20, total: 1, hasMore: false })

    const unfollow = await api('DELETE', `/users/${bob.username}/follow`, { token: alice.token })
    expect(unfollow.body).toMatchObject({ following: false, followersCount: 0 })
    expect((await api('GET', `/users/${alice.username}`)).body.followingCount).toBe(0)
  })

  test('private accounts use follow requests', async () => {
    const owner = await createUser()
    const fan = await createUser()
    await api('PUT', '/users/me/privacy', { token: owner.token, body: { isPrivate: true } })
    await createPost(owner, 'секрет')

    expect((await api('GET', `/posts/user/${owner.username}`, { token: fan.token })).body.error.code).toBe('PRIVATE_ACCOUNT')
    const request = await api('POST', `/users/${owner.username}/follow`, { token: fan.token })
    expect(request.body).toMatchObject({ following: false, status: 'requested' })

    const pending = await api('GET', '/users/me/follow-requests', { token: owner.token })
    expect(pending.body.data.users.map((u: any) => u.id)).toEqual([fan.id])
    const accept = await api('POST', `/users/me/follow-requests/${fan.id}/accept`, { token: owner.token })
    expect(accept.body).toMatchObject({ success: true, followersCount: 1 })
    expect((await api('GET', `/posts/user/${owner.username}`, { token: fan.token })).body.data.posts).toHaveLength(1)

    const types = (await api('GET', '/notifications', { token: fan.token })).body.notifications.map((n: any) => n.type)
    expect(types).toContain('follow_accepted')
  })

  test('pagination of followers', async () => {
    const star = await createUser()
    const fans = await Promise.all(Array.from({ length: 5 }, () => createUser()))
    for (const fan of fans) await api('POST', `/users/${star.id}/follow`, { token: fan.token })
    const page1 = await api('GET', `/users/${star.id}/followers?page=1&limit=2`)
    const page3 = await api('GET', `/users/${star.id}/followers?page=3&limit=2`)
    expect(page1.body.data.users).toHaveLength(2)
    expect(page1.body.data.pagination).toEqual({ page: 1, limit: 2, total: 5, hasMore: true })
    expect(page3.body.data.pagination.hasMore).toBe(false)
    expect(page3.body.data.users).toHaveLength(1)
  })
})

describe('blocks', () => {
  test('blocking removes follows and hides interaction', async () => {
    const alice = await createUser()
    const bob = await createUser()
    await api('POST', `/users/${bob.username}/follow`, { token: alice.token })
    await api('POST', `/users/${alice.username}/follow`, { token: bob.token })
    const post = await createPost(bob, 'пост боба')

    const block = await api('POST', `/users/${bob.username}/block`, { token: alice.token })
    expect(block.body.success).toBe(true)
    expect((await api('POST', `/users/${bob.username}/block`, { token: alice.token })).body.error).toEqual({ code: 'CONFLICT', message: 'User already blocked' })

    const seenByBob = await api('GET', `/users/${alice.username}`, { token: bob.token })
    expect(seenByBob.body).toMatchObject({ isBlockedByThem: true, followersCount: null, isFollowing: false })
    expect((await api('POST', `/users/${alice.username}/follow`, { token: bob.token })).body.error.code).toBe('BLOCKED')
    expect((await api('POST', `/posts/${post.id}/like`, { token: alice.token })).body.error.code).toBe('BLOCKED')

    const blocked = await api('GET', '/users/me/blocked', { token: alice.token })
    expect(blocked.body.data.users[0]).toMatchObject({ id: bob.id })
    expect(blocked.body.data.users[0].blockedAt).toBeString()

    expect((await api('DELETE', `/users/${bob.username}/block`, { token: alice.token })).body.success).toBe(true)
    expect((await api('DELETE', `/users/${bob.username}/block`, { token: alice.token })).body.error.message).toBe('User is not blocked')
    expect((await api('GET', `/users/${bob.username}`)).body.followersCount).toBe(0)
  })
})

describe('pins, discovery, deletion', () => {
  test('pins can be activated only when owned', async () => {
    const user = await createUser()
    expect((await api('PUT', '/users/me/pin', { token: user.token, body: { slug: 'early' } })).body.error.code).toBe('PIN_NOT_OWNED')
    await db.insert(userPins).values({ userId: user.id, pinSlug: 'early' })
    const pins = await api('GET', '/users/me/pins', { token: user.token })
    expect(pins.body.data.pins.map((p: any) => p.slug)).toEqual(['early'])
    expect((await api('PUT', '/users/me/pin', { token: user.token, body: { slug: 'early' } })).body.success).toBe(true)
    expect((await api('GET', `/users/${user.username}`)).body.pin).toMatchObject({ slug: 'early', name: 'Первопроходец' })
    await api('DELETE', '/users/me/pin', { token: user.token })
    expect((await api('GET', `/users/${user.username}`)).body.pin).toBeNull()
    await db.delete(userPins).where(eq(userPins.userId, user.id))
  })

  test('top clans and suggestions', async () => {
    const a = await createUser({ avatar: '🐸' })
    const b = await createUser({ avatar: '🐸' })
    const c = await createUser({ avatar: '🐸' })
    await api('POST', `/users/${b.id}/follow`, { token: a.token })
    await api('POST', `/users/${c.id}/follow`, { token: b.token })
    const clans = await api('GET', '/users/stats/top-clans')
    expect(clans.body.clans.find((clan: any) => clan.avatar === '🐸').memberCount).toBeGreaterThanOrEqual(3)
    const suggestions = await api('GET', '/users/suggestions/who-to-follow', { token: a.token })
    expect(suggestions.body.users[0].id).toBe(c.id)
    expect(suggestions.body.users.some((u: any) => u.id === b.id || u.id === a.id)).toBe(false)
  })

  test('account deletion can be restored', async () => {
    const user = await createUser()
    const other = await createUser()
    const deleted = await api('DELETE', '/users/me', { token: user.token })
    expect(deleted.body.success).toBe(true)
    expect(new Date(deleted.body.restoreDeadline).getTime()).toBeGreaterThan(Date.now() + 29 * 86400_000)

    const me = await api('GET', '/users/me', { token: user.token })
    expect(me.body).toMatchObject({ isDeleted: true, canRestore: true })
    expect((await api('DELETE', '/users/me', { token: user.token })).body.error.code).toBe('ALREADY_DELETED')
    const blockedAction = await api('POST', '/posts', { token: user.token, body: { content: 'hi' } })
    expect(blockedAction.body.error).toMatchObject({ code: 'ACCOUNT_DELETED', canRestore: true })
    expect((await api('GET', `/users/${user.username}`, { token: other.token })).status).toBe(404)

    expect((await api('POST', '/users/me/restore', { token: user.token })).body).toEqual({ success: true })
    expect((await api('POST', '/users/me/restore', { token: user.token })).body.error.code).toBe('NOT_DELETED')
    expect((await api('GET', `/users/${user.username}`, { token: other.token })).status).toBe(200)
  })
})
