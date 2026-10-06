import { broadcastChannel, subscribe } from '../src/services/realtime'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { eq, sql } from 'drizzle-orm'
import { config } from '../src/config'
import { db } from '../src/db/client'
import { accounts, follows, posts, users } from '../src/db/schema'
import { liftExpiredBans, purgeAccount } from '../src/jobs'
import { api, app, createPost, createUser, PNG_1x1, resetState, type TestUser, uploadForm } from './helpers'

beforeAll(resetState)

async function makeAdmin(user: TestUser) {
  await db.update(accounts).set({ roles: ['user', 'admin'] }).where(eq(accounts.id, user.id))
  const signIn = await api('POST', '/v1/auth/sign-in', { body: { telegram: user.telegram, password: user.password } })
  return signIn.body.accessToken as string
}

describe('error format', () => {
  test('unknown route, bad json and validation details', async () => {
    expect((await api('GET', '/nope')).body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
    const user = await createUser()
    const badJson = await api('POST', '/posts', { token: user.token, raw: '{oops', headers: { 'content-type': 'application/json' } })
    expect(badJson.status).toBe(400)
    const invalid = await api('GET', '/posts?limit=500')
    expect(invalid.status).toBe(422)
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR')
    expect(invalid.body.error.violations[0].message).toBeString()
    expect((await api('GET', '/posts/not-a-uuid')).status).toBe(422)
  })

  test('health and OpenAPI document', async () => {
    const health = await app.handle(new Request('http://localhost/health'))
    expect(await health.json()).toEqual({ status: 'ok', postgres: true, redis: true })
    const doc = (await (await app.handle(new Request('http://localhost/swagger/json'))).json()) as any
    expect(Object.keys(doc.paths).length).toBeGreaterThan(100)
    expect(doc.paths['/api/posts'].get).toBeDefined()
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer')
  })
})

describe('rate limits', () => {
  const original = config.rateLimit.multiplier
  afterEach(() => {
    config.rateLimit.multiplier = original
  })

  test('per-ip endpoint limits expose headers and answer like the official API', async () => {
    config.rateLimit.multiplier = 1
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    const first = await api('GET', '/hashtags/trending', { headers: ip })
    expect(first.headers.get('x-ratelimit-limit')).toBe('13')
    expect(first.headers.get('x-ratelimit-remaining')).toBe('12')
    for (let i = 0; i < 12; i++) await api('GET', '/hashtags/trending', { headers: ip })
    const limited = await api('GET', '/hashtags/trending', { headers: ip })
    expect(limited.status).toBe(429)
    expect(limited.body).toEqual({ error: 'Too Many Requests' })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // other limits use separate buckets
    expect((await api('GET', '/platform/version', { headers: ip })).status).toBe(200)
  })

  test('per-account action limits return retryAfter', async () => {
    const liker = await createUser()
    const authors = await Promise.all(Array.from({ length: 4 }, () => createUser()))
    const targets = []
    for (const author of authors) targets.push(await createPost(author, 'для лайков'))
    config.rateLimit.multiplier = 0.1 // 3 likes per minute
    const results = []
    for (const post of targets) results.push(await api('POST', `/posts/${post.id}/like`, { token: liker.token }))
    expect(results.slice(0, 3).every((r) => r.status === 200)).toBe(true)
    const limited = results.at(-1)!
    expect(limited.status).toBe(429)
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMIT_EXCEEDED', message: 'Слишком много лайков. Повторите позже.' })
    expect(limited.body.error.retryAfter).toBeGreaterThan(0)
  })
})

describe('files, reports, platform', () => {
  test('uploads are served with range support and can be deleted when unused', async () => {
    const user = await createUser()
    const upload = await api('POST', '/files/upload', { token: user.token, form: uploadForm(PNG_1x1, 'dot.png') })
    const path = new URL(upload.body.url).pathname
    const full = await app.handle(new Request(`http://localhost${path}`))
    expect(full.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await full.arrayBuffer()).equals(PNG_1x1)).toBe(true)
    const partial = await app.handle(new Request(`http://localhost${path}`, { headers: { range: 'bytes=0-7' } }))
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe(`bytes 0-7/${PNG_1x1.length}`)

    const other = await createUser()
    expect((await api('DELETE', `/files/${upload.body.id}`, { token: other.token })).status).toBe(403)
    expect((await api('DELETE', `/files/${upload.body.id}`, { token: user.token })).body.success).toBe(true)
    expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(404)
  })

  test('reports', async () => {
    const author = await createUser()
    const reporter = await createUser()
    const post = await createPost(author, 'спорный пост')
    const report = await api('POST', '/reports', { token: reporter.token, body: { targetId: post.id, targetType: 'post', reason: 'spam', description: 'реклама' } })
    expect(report.status).toBe(201)
    expect(report.body.data.id).toBeString()
    const again = await api('POST', '/reports', { token: reporter.token, body: { targetId: post.id, targetType: 'post' } })
    expect(again.body.error.message).toBe('Вы уже отправляли жалобу на этот контент')
    const missing = await api('POST', '/reports', { token: reporter.token, body: { targetId: crypto.randomUUID(), targetType: 'comment' } })
    expect(missing.body.error.message).toContain('не найден')
    expect((await api('POST', '/reports', { token: author.token, body: { targetId: post.id, targetType: 'post' } })).status).toBe(400)
  })

  test('platform content', async () => {
    expect((await api('GET', '/platform/version')).body.android).toMatchObject({ minVersion: '1.0.0', latestVersion: '1.4.2' })
    // the changelog starts empty: no demo entries
    expect((await api('GET', '/platform/changelog')).body.data).toEqual([])
    expect((await api('GET', '/platform/announcements')).body.announcements[0]).toMatchObject({ id: 'welcome', buttons: [{ action: { type: 'dismiss' } }] })
  })

  test('changelog edited by an admin', async () => {
    const admin = await makeAdmin(await createUser())
    const entry = { version: '9.9.9', changes: ['Первая правка'] }
    expect((await api('POST', '/admin/changelog', { token: admin, body: entry })).status).toBe(200)
    await api('POST', '/admin/changelog', { token: admin, body: { ...entry, date: '1 января', changes: ['Исправлено'] } })
    const listed = (await api('GET', '/platform/changelog')).body.data.find((e: { version: string }) => e.version === '9.9.9')
    expect(listed).toMatchObject({ date: '1 января', changes: ['Исправлено'] })
    expect((await api('DELETE', '/admin/changelog/9.9.9', { token: admin })).status).toBe(200)
    expect((await api('DELETE', '/admin/changelog/9.9.9', { token: admin })).status).toBe(404)
    expect((await api('GET', '/platform/changelog')).body.data.some((e: { version: string }) => e.version === '9.9.9')).toBe(false)

    // highest version first, whatever the order they were added in
    for (const version of ['0.10.0', '0.2.0', '0.9.1']) await api('POST', '/admin/changelog', { token: admin, body: { version, changes: ['x'] } })
    expect((await api('GET', '/platform/changelog')).body.data.map((e: { version: string }) => e.version)).toEqual(['0.10.0', '0.9.1', '0.2.0'])
  })
})

describe('verification, dwell, admin', () => {
  test('verification request reviewed by an admin', async () => {
    const user = await createUser()
    const submit = await api('POST', '/verification/submit', { token: user.token, body: { videoUrl: 'https://cdn.example.com/v.mp4' } })
    expect(submit.status).toBe(201)
    expect(submit.body.request).toMatchObject({ status: 'pending', userId: user.id })
    expect((await api('POST', '/verification/submit', { token: user.token, body: { videoUrl: 'https://cdn.example.com/v.mp4' } })).status).toBe(409)

    const admin = await makeAdmin(await createUser())
    expect((await api('GET', '/admin/verification', { token: user.token })).status).toBe(403)
    const pending = await api('GET', '/admin/verification', { token: admin })
    expect(pending.body.requests.map((r: any) => r.id)).toContain(submit.body.request.id)
    expect((await api('POST', `/admin/verification/${submit.body.request.id}/approve`, { token: admin })).body.request.status).toBe('approved')
    expect((await api('GET', `/users/${user.username}`)).body.verified).toBe(true)
    expect((await api('GET', '/verification/status', { token: user.token })).body.request.status).toBe('approved')
  })

  test('dwell views are unique per viewer, ignore the author and accept deflate bodies', async () => {
    const author = await createUser()
    const viewer = await createUser()
    const post = await createPost(author, 'смотрите')
    const seen = (await api('GET', `/posts/${post.id}`, { token: viewer.token })).body.data
    const event = { v: seen.vs, md: 1200, et: Date.now() - 1200, xt: Date.now(), r: 0, s: 6 }

    expect((await api('POST', '/v1/i', { token: viewer.token, body: { sid: crypto.randomUUID(), e: [event, event] } })).status).toBe(204)
    const deflated = deflateSync(Buffer.from(JSON.stringify({ sid: crypto.randomUUID(), e: [event] })))
    const compressed = await api('POST', '/v1/i', { token: viewer.token, raw: deflated, headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' } })
    expect(compressed.status).toBe(204)
    // somebody else's view token is ignored, the author's own view is not counted
    await api('POST', '/v1/i', { token: author.token, body: { e: [event] } })
    const own = (await api('GET', `/posts/${post.id}`, { token: author.token })).body.data
    await api('POST', '/v1/i', { token: author.token, body: { e: [{ ...event, v: own.vs }] } })

    const after = (await api('GET', `/posts/${post.id}`, { token: viewer.token })).body.data
    expect(after).toMatchObject({ viewsCount: 1, isViewed: true })
    expect((await api('GET', `/posts/${post.id}`, { token: author.token })).body.data.isViewed).toBe(true)
    expect((await api('POST', '/v1/x', { token: viewer.token, body: { e: [{ v: seen.vs, s: 6, t: 1, ai: crypto.randomUUID(), mi: 0 }] } })).status).toBe(204)
  })

  test('bans block sign-in and hide the profile', async () => {
    const admin = await makeAdmin(await createUser())
    const victim = await createUser()
    const ban = await api('POST', `/admin/users/${victim.username}/ban`, { token: admin, body: { reason: 'спам' } })
    expect(ban.body).toEqual({ success: true, revokedSessions: 1 })
    expect((await api('GET', '/users/me', { token: victim.token })).status).toBe(401)
    const signIn = await api('POST', '/v1/auth/sign-in', { body: { telegram: victim.telegram, password: victim.password } })
    expect(signIn.body.error).toMatchObject({ code: 'ACCOUNT_BANNED', reason: 'спам' })
    expect((await api('GET', `/users/${victim.username}`)).body.error.message).toBe('Этот аккаунт заблокирован')

    await api('POST', `/admin/users/${victim.username}/ban`, { token: admin, body: { until: new Date(Date.now() + 3600_000).toISOString() } })
    expect((await api('POST', '/v1/auth/sign-in', { body: { telegram: victim.telegram, password: victim.password } })).body.error.code).toBe('ACCOUNT_DEACTIVATED')
    await db.update(accounts).set({ bannedUntil: sql`now() - interval '1 second'` }).where(eq(accounts.id, victim.id))
    expect(await liftExpiredBans()).toBe(1)
    expect((await api('POST', '/v1/auth/sign-in', { body: { telegram: victim.telegram, password: victim.password } })).status).toBe(200)
    expect((await api('GET', `/users/${victim.username}`)).status).toBe(200)
  })
})

describe('account purge', () => {
  test('purging an account fixes counters of other users', async () => {
    const leaving = await createUser()
    const staying = await createUser()
    const post = await createPost(staying, 'останется')
    await api('POST', `/users/${staying.id}/follow`, { token: leaving.token })
    await api('POST', `/posts/${post.id}/like`, { token: leaving.token })
    await api('POST', `/posts/${post.id}/comments`, { token: leaving.token, body: { content: 'пока' } })
    await api('POST', `/posts/${post.id}/repost`, { token: leaving.token })

    await purgeAccount(leaving.id)
    const [row] = await db.select().from(posts).where(eq(posts.id, post.id))
    expect(row).toMatchObject({ likesCount: 0, commentsCount: 0, repostsCount: 0 })
    const [profile] = await db.select().from(users).where(eq(users.id, staying.id))
    expect(profile!.followersCount).toBe(0)
    expect(await db.select().from(follows).where(eq(follows.followingId, staying.id))).toHaveLength(0)
    expect((await api('GET', '/users/me', { token: leaving.token })).status).toBe(401)
  })
})

describe('event items (free stub shop)', () => {
  const free = (user: TestUser, key: string, amount: number) => api('POST', `/v1/aliceai/free/${key}`, { token: user.token, body: { amount } })
  const item = (state: any, key: string) => state.items.find((i: any) => i.key === key)

  test('every item can be granted and taken back', async () => {
    const user = await createUser()
    const initial = (await api('GET', '/v1/aliceai/free', { token: user.token })).body
    expect(initial.enabled).toBe(true)
    expect(initial.items.map((i: any) => i.key)).toEqual([
      'notebook_grid', 'notebook_ruled', 'pin_aliceai', 'red_pen', 'corrector', 'sticker', 'eraser', 'balloon', 'bell', 'aura_analyzer', 'nickname', 'whoopee_cushion', 'window', 'chalk', 'curtains_fund', 'clan_image'
    ])
    for (const i of initial.items) {
      if (i.resetOnly) continue
      const granted = (await free(user, i.key, i.once ? 1 : 3)).body
      expect(item(granted, i.key).count).toBe(i.once ? 1 : 3)
      // granting a one-off again keeps one
      if (i.once) expect(item((await free(user, i.key, 1)).body, i.key).count).toBe(1)
      const back = (await free(user, i.key, i.once ? -1 : -2)).body
      expect(item(back, i.key).count).toBe(i.once ? 0 : 1)
    }
    expect((await free(user, 'nope', 1)).body.error.code).toBe('ITEM_NOT_FOUND')
    expect((await free(user, 'sticker', 5000)).body.error.code).toBe('VALIDATION_ERROR')

    // granted things show up where the web client reads them
    const inventory = (await api('GET', '/v1/aliceai/inventory', { token: user.token })).body.items
    // only backpack items: the bell, aura analyzer and clan picture are left at 0 here, but are never listed anyway
    expect(inventory.map((i: any) => i.kind).sort()).toEqual(['eraser', 'stain', 'sticker', 'whoopee_cushion', 'window'])
    expect(inventory.find((i: any) => i.kind === 'sticker').asset).toStartWith('sticker_')
    expect((await api('GET', '/red-pens/inventory', { token: user.token })).body.data.events[0].balance).toBe(1)
    expect((await api('GET', '/post-notebooks/inventory', { token: user.token })).body.data).toMatchObject({ applicationsEnabled: true, balance: { grid: 1, ruled: 1 } })
  })

  test('chalk goes to curtains, the collected fund can be reset', async () => {
    const user = await createUser()
    const friend = await createUser()
    expect(item((await free(user, 'chalk', 30)).body, 'chalk').count).toBe(30)
    const donate = (from: TestUser, to: TestUser, amount: number) =>
      api('POST', `/v1/aliceai/profiles/${to.id}/curtains/donations`, { token: from.token, body: { amount } })
    expect((await donate(user, user, 10)).body).toMatchObject({ fund: 10, balance: 20 })
    await free(friend, 'chalk', 5)
    await donate(friend, user, 5)
    const state = (await api('GET', '/v1/aliceai/free', { token: user.token })).body
    expect(item(state, 'chalk').count).toBe(20)
    expect(item(state, 'curtains_fund')).toMatchObject({ count: 15, resetOnly: true })
    expect((await free(user, 'curtains_fund', 1)).body.error.code).toBe('VALIDATION_ERROR')
    expect(item((await free(user, 'curtains_fund', -15)).body, 'curtains_fund').count).toBe(0)
    expect((await api('GET', `/v1/aliceai/profiles/${user.id}`, { token: user.token })).body.curtains.fund).toBe(0)

    // collected, claimed and closed curtains: the full reset takes them away
    await free(user, 'chalk', 100)
    await donate(user, user, 100)
    expect((await api('POST', `/v1/aliceai/profiles/${user.id}/curtains/claim`, { token: user.token })).body.hasCurtains).toBe(true)
    await api('PUT', `/v1/aliceai/profiles/${user.id}/curtains`, { token: user.token, body: { closed: true } })
    const full = item((await api('GET', '/v1/aliceai/free', { token: user.token })).body, 'curtains_fund')
    expect(full).toMatchObject({ count: 100, owned: true, note: 'шторы есть' })
    const reset = item((await free(user, 'curtains_fund', -1000)).body, 'curtains_fund')
    expect(reset).toMatchObject({ count: 0, owned: false })
    expect((await api('GET', `/v1/aliceai/profiles/${user.id}`, { token: user.token })).body.curtains).toMatchObject({ fund: 0, hasCurtains: false, closed: false })
  })

  test('one-off purchases stay out of the backpack', async () => {
    const user = await createUser()
    for (const key of ['bell', 'aura_analyzer', 'clan_image', 'eraser']) await free(user, key, 1)
    const inventory = (await api('GET', '/v1/aliceai/inventory', { token: user.token })).body.items
    expect(inventory.map((i: any) => i.kind)).toEqual(['eraser'])
  })

  test('pin, nickname and aura', async () => {
    const user = await createUser()
    await free(user, 'pin_aliceai', 1)
    expect((await api('PUT', '/users/me/pin', { token: user.token, body: { slug: 'aliceai' } })).body.success).toBe(true)
    expect((await api('GET', `/users/${user.username}`)).body.pin).toMatchObject({ slug: 'aliceai', url: '/public/events/aliceai/pin-aliceai.svg' })
    await free(user, 'pin_aliceai', -1)
    expect((await api('GET', `/users/${user.username}`)).body.pin).toBeNull()

    const nick = item((await free(user, 'nickname', 1)).body, 'nickname').note
    const mine = (await api('GET', '/v1/aliceai/nicknames', { token: user.token })).body
    expect(mine).toMatchObject({ owned: [nick], active: nick })
    expect((await api('PUT', '/v1/aliceai/nicknames/active', { token: user.token, body: { form: null } })).body).toEqual({ nickname: null })
    expect((await api('PUT', '/v1/aliceai/nicknames/active', { token: user.token, body: { form: nick } })).body).toEqual({ nickname: nick })
    const shown = (await api('GET', `/event-nicknames?ids=${user.id}`)).body.data[user.id]
    // the web client draws the grey gradient only for this style
    expect(shown).toMatchObject({ label: nick, eventId: 'aliceai', stateVersion: 0, styleKey: 'school_gold' })

    await free(user, 'aura_analyzer', 1)
    const aura = (await api('GET', `/v1/aliceai/profiles/${user.id}`, { token: user.token })).body.aura
    expect(aura).toBeGreaterThanOrEqual(0)
    expect(aura).toBeLessThanOrEqual(100)
  })

  test('the bell rings for everyone online', async () => {
    const user = await createUser()
    const heard: any[] = []
    const off = await subscribe(broadcastChannel(), (message) => heard.push(message))
    await free(user, 'bell', 1)
    for (let i = 0; i < 20 && !heard.length; i++) await Bun.sleep(25)
    off()
    expect(heard[0]).toMatchObject({ event: 'alice.bell', data: { buyerUsername: user.username } })
  })

  test('notebook posts, sticker, balloon, cushion and curtains answer in the client format', async () => {
    const owner = await createUser()
    const guest = await createUser()
    expect((await api('POST', '/posts', { token: owner.token, body: { content: 'тетрадь', notebook: { style: 'grid' } } })).body.error.code).toBe('NO_POST_NOTEBOOKS')
    await free(owner, 'notebook_grid', 1)
    const post = await api('POST', '/posts', { token: owner.token, body: { content: 'тетрадь', notebook: { eventId: 'aliceai', style: 'grid', operationId: crypto.randomUUID() } } })
    expect(post.status).toBe(201)
    expect(post.body.notebook).toEqual({ style: 'grid' })
    expect(post.body.redPen.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(post.body).not.toHaveProperty('revision')
    expect((await api('GET', '/post-notebooks/inventory', { token: owner.token })).body.data.balance.grid).toBe(0)

    await free(guest, 'sticker', 1)
    await free(guest, 'balloon', 1)
    await free(guest, 'whoopee_cushion', 1)
    const items = (await api('GET', '/v1/aliceai/inventory', { token: guest.token })).body.items
    const id = (kind: string) => items.find((i: any) => i.kind === kind).id
    const placed = await api('POST', `/v1/aliceai/profiles/${owner.id}/placements`, { token: guest.token, body: { inventoryItemId: id('sticker'), x: 0.3, y: 0.4, size: 0.16, angle: 0 } })
    expect(placed.body).toMatchObject({ rev: expect.any(Number), placement: { kind: 'sticker', x: 0.3, y: 0.4 }, evicted: [] })
    const balloon = await api('POST', `/v1/aliceai/profiles/${owner.id}/balloons`, {
      token: guest.token,
      body: { inventoryItemId: id('stain'), x: 0.5, y: 0.5, anchorKind: 'post', anchorId: post.body.id }
    })
    expect(balloon.body.balloon).toMatchObject({ anchor: { kind: 'post', id: post.body.id } })

    await api('POST', `/v1/aliceai/profiles/${owner.id}/cushion`, { token: guest.token, body: { inventoryItemId: id('whoopee_cushion'), x: 0.2, y: 0.2, anchorKind: 'profile_header', anchorId: null } })
    expect((await api('POST', `/v1/aliceai/profiles/${owner.id}/cushion/claim`, { token: guest.token })).body.show).toBe(false)
    expect((await api('POST', `/v1/aliceai/profiles/${owner.id}/cushion/claim`, { token: owner.token })).body).toMatchObject({ show: true, x: 0.2 })
    expect((await api('POST', `/v1/aliceai/profiles/${owner.id}/cushion/claim`, { token: owner.token })).body.show).toBe(false)

    const corrector = (await api('GET', `/correctors/state?ids=${post.body.id}`, { token: guest.token })).body.data[post.body.id]
    expect(corrector).toMatchObject({ revision: post.body.redPen.revision, serverTime: expect.any(String), events: [{ id: 'aliceai', used: 0 }] })
  })
})

describe('pins', () => {
  test('admin creates a pin with a picture and grants it', async () => {
    const admin = await makeAdmin(await createUser())
    const user = await createUser()
    const pin = { slug: 'founder', name: 'Основатель', description: 'Запустил сервер', url: '/uploads/founder.png' }
    expect((await api('POST', '/admin/pins', { token: admin, body: pin })).body.success).toBe(true)
    expect((await api('POST', `/admin/users/${user.username}/pins`, { token: admin, body: { slug: 'founder' } })).body.success).toBe(true)
    expect((await api('PUT', '/users/me/pin', { token: user.token, body: { slug: 'founder' } })).body.success).toBe(true)
    expect((await api('GET', `/users/${user.username}`)).body.pin).toMatchObject({ slug: 'founder', url: '/uploads/founder.png' })
    expect((await api('GET', '/admin/pins', { token: admin })).body.pins.map((p: any) => p.slug)).toContain('founder')
  })
})

describe('event', () => {
  test('wallet, shop, stickers and nicknames', async () => {
    const owner = await createUser()
    const guest = await createUser()
    expect((await api('GET', '/v1/event/status')).body.enabled).toBe(true)
    // the web client opens the event frame only for an active portal pointing at the event app
    expect((await api('GET', '/v1/portal')).body).toMatchObject({ active: true, url: '/public/events/aliceai/' })
    const endsAt = config.event.endsAt
    config.event.endsAt = '2020-01-01T00:00:00Z'
    try {
      expect((await api('GET', '/v1/event/status')).body.enabled).toBe(false)
    } finally {
      config.event.endsAt = endsAt
    }
    const claim = await api('POST', `/v1/aliceai/profiles/${guest.id}/claim`, { token: guest.token })
    expect(claim.body).toMatchObject({ success: true, reward: 20, balance: 20 })
    expect((await api('POST', `/v1/aliceai/profiles/${guest.id}/claim`, { token: guest.token })).body.error.code).toBe('ALREADY_CLAIMED')

    const sticker = await api('POST', '/v1/aliceai/shop/sticker/buy', { token: guest.token })
    expect(sticker.body).toMatchObject({ balance: 10, item: { kind: 'sticker' } })
    const placed = await api('POST', `/v1/aliceai/profiles/${owner.username}/placements`, {
      token: guest.token,
      body: { inventoryItemId: sticker.body.item.id, x: 0.4, y: 0.6 }
    })
    expect(placed.body.success).toBe(true)
    const profile = await api('GET', `/v1/aliceai/profiles/${owner.id}`, { token: owner.token })
    expect(profile.body).toMatchObject({ profileId: owner.id, rev: 1, placements: [{ kind: 'sticker', x: 0.4, y: 0.6, wear: 0, createdBy: guest.id }] })
    // the owner wipes stickers off for free
    for (let i = 0; i < 4; i++) await api('POST', `/v1/aliceai/profiles/${owner.id}/placements/${placed.body.placementId}/erase`, { token: owner.token })
    expect((await api('GET', `/v1/aliceai/profiles/${owner.id}`, { token: owner.token })).body.placements).toHaveLength(0)

    expect((await api('POST', '/v1/aliceai/shop/window/buy', { token: guest.token })).body.error.code).toBe('INSUFFICIENT_BALANCE')
    const nickname = await api('POST', '/v1/aliceai/shop/nickname/buy', { token: owner.token })
    expect(nickname.body.error.code).toBe('INSUFFICIENT_BALANCE')

    await api('POST', `/v1/aliceai/profiles/${owner.id}/claim`, { token: owner.token })
    await db.execute(sql`update event_wallets set balance = 100 where user_id = ${owner.id}`)
    const bought = await api('POST', '/v1/aliceai/shop/nickname/buy', { token: owner.token })
    const active = await api('PUT', '/v1/aliceai/nicknames/active', { token: owner.token, body: { form: bought.body.item.id } })
    expect(active.body.nickname).toBe(bought.body.item.label)
    const nicknames = await api('GET', `/event-nicknames?ids=${owner.id},${guest.id}`, { token: guest.token })
    expect(nicknames.body.data[owner.id].label).toBe(bought.body.item.label)
    expect(nicknames.body.data[guest.id]).toBeNull()
    // guests see nicknames on posts too
    expect((await api('GET', `/event-nicknames?ids=${owner.id}`)).body.data[owner.id].label).toBe(bought.body.item.label)
    expect((await api('GET', `/users/${owner.username}`)).body.activeNickname.label).toBe(bought.body.item.label)
  })

  test('red pen: one claim per user, up to 3 corrections for one pen', async () => {
    const author = await createUser()
    const editor = await createUser()
    const other = await createUser()
    const post = await createPost(author, 'превет мир как дила вапще')
    await db.execute(sql`insert into event_wallets (user_id, red_pens) values (${editor.id}, 1), (${other.id}, 1)`)
    const state = await api('GET', `/red-pens/state?ids=${post.id}`, { token: editor.token })
    const revision = state.body.data[post.id].revision
    expect(state.body.data[post.id]).toMatchObject({ claim: null, claims: [], corrections: [] })
    expect((await api('GET', '/red-pens/inventory', { token: editor.token })).body.data.events[0].balance).toBe(1)

    const apply = (user: TestUser, start: number, end: number, replacement: string) =>
      api('POST', '/red-pens/apply', { token: user.token, body: { postId: post.id, revision, start, end, replacement } })
    const first = await apply(editor, 0, 6, 'привет')
    expect(first.body.success).toBe(true)
    // the same pen covers the next two words, the fourth one is refused
    expect((await api('GET', '/red-pens/inventory', { token: editor.token })).body.data.events[0].balance).toBe(0)
    expect((await apply(editor, 15, 19, 'дела')).body.claimId).toBe(first.body.claimId)
    expect((await apply(editor, 20, 25, 'вообще')).body.success).toBe(true)
    expect((await apply(editor, 11, 14, 'так')).body.error.code).toBe('RED_PEN_LIMIT')
    await apply(other, 7, 10, 'мирр')

    const after = (await api('GET', `/red-pens/state?ids=${post.id}`, { token: editor.token })).body.data[post.id]
    expect(Object.keys(after)).toEqual(['revision', 'serverTime', 'events', 'claim', 'claims', 'corrections'])
    expect(after.claims).toHaveLength(2)
    expect(after.claim).toMatchObject({ id: first.body.claimId, isOwner: true, used: 3, limit: 3, eventId: 'aliceai' })
    expect(Object.keys(after.claims[0]).sort()).toEqual(['actor', 'endsAt', 'eventId', 'id', 'isOwner', 'limit', 'used'])
    expect(Object.keys(after.claims[0].actor).sort()).toEqual(['displayName', 'id', 'username'])
    expect(after.claims[1]).toMatchObject({ used: 1, isOwner: false, actor: { id: other.id } })
    expect(after.corrections.map((c: any) => c.replacement)).toEqual(['привет', 'дела', 'вообще', 'мирр'])
    expect(Object.keys(after.corrections[0]).sort()).toEqual(['createdAt', 'createdAtMicros', 'end', 'id', 'replacement', 'start'])

    // cancelling a claim drops all its corrections
    expect((await api('POST', '/red-pens/cancel', { token: author.token, body: { postId: post.id, claimId: first.body.claimId } })).body).toMatchObject({ success: true, canceled: 3 })
    const left = (await api('GET', `/red-pens/state?ids=${post.id}`, { token: author.token })).body.data[post.id]
    expect(left.claims.map((c: any) => c.actor.id)).toEqual([other.id])
    expect(left.corrections).toHaveLength(1)
  })

  test('posts carry their red pen and corrector state', async () => {
    const author = await createUser()
    const editor = await createUser()
    const post = await createPost(author, 'превет мир')
    await db.execute(sql`insert into event_wallets (user_id, red_pens, correctors) values (${editor.id}, 1, 1)`)
    const fresh = (await api('GET', `/posts/${post.id}`, { token: editor.token })).body.data
    // read before toMatchObject: its asymmetric matchers get written into the received object
    const revision = fresh.redPen.revision
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    expect(fresh.redPen).toMatchObject({ claims: [], corrections: [], events: [{ id: 'aliceai' }] })
    expect(fresh.corrector).toMatchObject({ revision, marks: [], events: [{ id: 'aliceai', used: 0 }] })

    await api('POST', '/red-pens/apply', { token: editor.token, body: { postId: post.id, revision, start: 0, end: 6, replacement: 'привет' } })
    await api('POST', '/correctors/apply', { token: editor.token, body: { postId: post.id, revision, start: 7, end: 10 } })
    const marked = (await api('GET', `/posts/user/${author.username}`, { token: author.token })).body.data.posts[0]
    expect(marked.redPen.corrections).toMatchObject([{ start: 0, end: 6, replacement: 'привет' }])
    expect(marked.redPen.claims[0]).toMatchObject({ isOwner: false, used: 1, actor: { id: editor.id } })
    expect(marked.corrector.marks[0]).toMatchObject({ start: 7, end: 10, eventId: 'aliceai', actor: { id: editor.id } })
    // anonymous viewers see the marks too
    expect((await api('GET', `/posts/${post.id}`)).body.data.corrector.marks).toHaveLength(1)
  })
})
