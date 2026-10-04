import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { eq, sql } from 'drizzle-orm'
import { config } from '../src/config'
import { db } from '../src/db/client'
import { accounts, follows, posts, subscriptions, users } from '../src/db/schema'
import { liftExpiredBans, purgeAccount } from '../src/jobs'
import { renewDueSubscriptions } from '../src/modules/subscription/service'
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
    expect((await api('GET', '/platform/changelog')).body.data[0]).toMatchObject({ version: '1.2.0', date: '13 мая' })
    expect((await api('GET', '/platform/announcements')).body.announcements[0]).toMatchObject({ id: 'welcome', buttons: [{ action: { type: 'dismiss' } }] })
  })
})

describe('subscription', () => {
  test('mock checkout activates НУКСТА, grants the pin and manages cards', async () => {
    const user = await createUser()
    expect((await api('GET', '/v1/subscription', { token: user.token })).body).toMatchObject({ isActive: false, price: 199 })
    expect((await api('POST', '/v1/subscription/auto-renewal', { token: user.token, body: { enabled: false } })).body.error).toEqual({
      code: 'NOT_FOUND',
      message: 'Активная подписка не найдена'
    })

    const pay = await api('POST', '/v1/subscription/pay', { token: user.token })
    const url = new URL(pay.body.confirmationUrl)
    const page = await app.handle(new Request(`http://localhost${url.pathname}${url.search}`))
    expect(await page.text()).toContain('Оплатить')
    const forged = await app.handle(new Request(`http://localhost${url.pathname}/confirm?sig=forged`, { method: 'POST' }))
    expect(forged.status).toBe(400)
    const confirm = await app.handle(new Request(`http://localhost${url.pathname}/confirm${url.search}`, { method: 'POST', headers: { accept: 'application/json' } }))
    expect(await confirm.json()).toEqual({ success: true })

    const state = await api('GET', '/v1/subscription', { token: user.token })
    expect(state.body).toMatchObject({ isActive: true, autoRenewal: true, hasPaymentMethod: true })
    expect((await api('GET', '/users/me', { token: user.token })).body).toMatchObject({ hasNuksta: true, subscription: { isActive: true } })
    expect((await api('GET', '/users/me/pins', { token: user.token })).body.data.pins.map((p: any) => p.slug)).toContain('nuksta')
    expect((await api('POST', '/v1/subscription/auto-renewal', { token: user.token, body: { enabled: false } })).body).toEqual({ autoRenewal: false })

    const methods = await api('GET', '/v1/subscription/methods', { token: user.token })
    expect(methods.body.data).toHaveLength(1)
    expect(methods.body.data[0]).toMatchObject({ brand: 'MIR', isDefault: true })
    expect((await api('DELETE', `/v1/subscription/methods/${methods.body.data[0].id}`, { token: user.token })).body.success).toBe(true)
  })

  test('renewal job charges the default card', async () => {
    const user = await createUser()
    const pay = await api('POST', '/v1/subscription/pay', { token: user.token })
    const url = new URL(pay.body.confirmationUrl)
    await app.handle(new Request(`http://localhost${url.pathname}/confirm${url.search}`, { method: 'POST' }))
    await db.update(subscriptions).set({ expiresAt: sql`now() - interval '1 hour'` }).where(eq(subscriptions.userId, user.id))
    expect((await api('GET', '/v1/subscription', { token: user.token })).body.isActive).toBe(false)
    await renewDueSubscriptions()
    expect((await api('GET', '/v1/subscription', { token: user.token })).body.isActive).toBe(true)
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

describe('pins', () => {
  test('admin creates a pin with a picture and grants it; the default НУКСТА pin has one', async () => {
    const admin = await makeAdmin(await createUser())
    const user = await createUser()
    const pin = { slug: 'founder', name: 'Основатель', description: 'Запустил сервер', url: '/uploads/founder.png' }
    expect((await api('POST', '/admin/pins', { token: admin, body: pin })).body.success).toBe(true)
    expect((await api('POST', `/admin/users/${user.username}/pins`, { token: admin, body: { slug: 'founder' } })).body.success).toBe(true)
    expect((await api('PUT', '/users/me/pin', { token: user.token, body: { slug: 'founder' } })).body.success).toBe(true)
    expect((await api('GET', `/users/${user.username}`)).body.pin).toMatchObject({ slug: 'founder', url: '/uploads/founder.png' })
    const all = (await api('GET', '/admin/pins', { token: admin })).body.pins
    expect(all.find((p: any) => p.slug === 'nuksta').url).toBe('/cdn/public/pins/nuksta.gif')
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

  test('red pens mark posts until cancelled', async () => {
    const author = await createUser()
    const editor = await createUser()
    const post = await createPost(author, 'превет мир')
    await db.execute(sql`insert into event_wallets (user_id, red_pens) values (${editor.id}, 1)`)
    const state = await api('GET', `/red-pens/state?ids=${post.id}`, { token: editor.token })
    const revision = state.body.data[post.id].revision
    expect((await api('GET', '/red-pens/inventory', { token: editor.token })).body.data.events[0].balance).toBe(1)

    const applied = await api('POST', '/red-pens/apply', { token: editor.token, body: { postId: post.id, revision, start: 0, end: 6, replacement: 'привет' } })
    expect(applied.body.success).toBe(true)
    const after = await api('GET', `/red-pens/state?ids=${post.id}`, { token: author.token })
    expect(after.body.data[post.id].claims[0]).toMatchObject({ isOwner: false, corrections: [{ start: 0, end: 6, replacement: 'привет' }], actor: { id: editor.id } })
    expect((await api('POST', '/red-pens/apply', { token: editor.token, body: { postId: post.id, revision, start: 0, end: 6, replacement: 'x' } })).body.error.code).toBe(
      'INSUFFICIENT_BALANCE'
    )
    expect((await api('POST', '/red-pens/cancel', { token: author.token, body: { postId: post.id, claimId: applied.body.claimId } })).body.success).toBe(true)
    expect((await api('GET', `/red-pens/state?ids=${post.id}`, { token: author.token })).body.data[post.id].claims).toHaveLength(0)
  })
})
