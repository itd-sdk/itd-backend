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
    expect(Object.keys(doc.paths).length).toBeGreaterThan(80)
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

  test('a banner is drawn from strokes; a picture has its own endpoint', async () => {
    const user = await createUser()
    const strokes = { version: 1, width: 1100, height: 380, ops: [{ tool: 'brush', color: '#FF3B30', width: 12, points: [[50, 50], [600, 300]] }] }
    const drawn = await api('POST', '/files/banner-drawing', { token: user.token, body: strokes })
    expect(drawn.status).toBe(201)
    expect(drawn.body).toMatchObject({ mimeType: 'image/png', type: 'image', width: 1100, height: 380 })
    const served = await app.handle(new Request(`http://localhost${new URL(drawn.body.url).pathname}`))
    expect(served.headers.get('content-type')).toBe('image/png')
    expect((await api('PUT', '/users/me', { token: user.token, body: { bannerId: drawn.body.id } })).body.banner).toBe(drawn.body.url)

    // the drawing endpoint takes strokes only
    for (const body of [{ ...strokes, ops: [{ tool: 'image', url: 'https://example.com/a.png' }] }, { ...strokes, width: 4000 }, { image: 'data:image/png;base64,AAAA' }]) {
      expect((await api('POST', '/files/banner-drawing', { token: user.token, body })).status).toBeOneOf([400, 422])
    }
    expect((await api('POST', '/files/banner-drawing', { body: strokes })).status).toBe(401)

    const picture = await api('POST', '/files/banner-image', { token: user.token, form: uploadForm(PNG_1x1, 'banner.png') })
    expect(picture.status).toBe(201)
    expect(picture.body).toMatchObject({ mimeType: 'image/png', type: 'image', width: 1, height: 1 })
    expect((await api('PUT', '/users/me', { token: user.token, body: { bannerId: picture.body.id } })).body.banner).toBe(picture.body.url)
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(32)])
    expect((await api('POST', '/files/banner-image', { token: user.token, form: uploadForm(mp4, 'clip.mp4') })).status).toBe(400)
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

describe('portal', () => {
  test('the event tab: inactive by default, an old event-app url means no portal', async () => {
    expect((await api('GET', '/v1/portal')).body).toEqual({ active: false, title: 'Портал', url: '' })
    const saved = { ...config.portal }
    Object.assign(config.portal, { active: true, url: 'https://example.com/event' })
    try {
      expect((await api('GET', '/v1/portal')).body).toMatchObject({ active: true, url: 'https://example.com/event' })
      // the removed event pages are gone
      expect((await api('GET', '/v1/event/status')).status).toBe(404)
      expect((await api('GET', '/red-pens/inventory')).status).toBe(404)
    } finally {
      Object.assign(config.portal, saved)
    }
  })
})
