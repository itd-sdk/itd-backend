import { beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db/client'
import { bannedWords, posts, subscriptions, users } from '../src/db/schema'
import { invalidateBannedWords } from '../src/services/moderation'
import { api, createPost, createUser, PNG_1x1, resetState, type TestUser, uploadForm } from './helpers'

beforeAll(resetState)

const notificationTypes = async (user: TestUser) => (await api('GET', '/notifications', { token: user.token })).body.notifications.map((n: any) => n.type)

describe('create', () => {
  test('content, spans, hashtags and mentions', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const content = `**Привет** #ИТД @${bob.username} и @ghost_user`
    const post = await createPost(alice, { content, spans: [{ offset: 0, length: 10, type: 'bold' }] })
    expect(post.author).toMatchObject({ id: alice.id, username: alice.username, clanAvatar: '🐱' })
    expect(post.spans.map((s: any) => s.type)).toEqual(['bold', 'hashtag', 'mention'])
    expect(post.spans.find((s: any) => s.type === 'mention').tag).toBe(bob.username)
    expect(post).toMatchObject({ likesCount: 0, isOwner: true, isPinned: false, originalPost: null, poll: null, attachments: [] })
    expect(post.vs).toBeString()
    expect(await notificationTypes(bob)).toEqual(['mention'])
    expect((await api('GET', `/users/${alice.username}`)).body.postsCount).toBe(1)
  })

  test('validation errors', async () => {
    const alice = await createUser()
    const create = (body: unknown) => api('POST', '/posts', { token: alice.token, body })
    expect((await create({ content: '   ' })).body.error.message).toBe('Content, attachments or poll required')
    expect((await create({ content: 'x'.repeat(5001) })).body.error.message).toBe('text must be at most 5000 characters')
    expect((await create({ content: 'hi', spans: [{ offset: 0, length: 10, type: 'bold' }] })).body.error.code).toBe('VALIDATION_ERROR')
    expect((await create({ content: 'hi', poll: { question: 'q', options: [{ text: 'one' }] } })).status).toBe(422)

    await db.insert(bannedWords).values({ word: 'запрещёнка' })
    invalidateBannedWords()
    const banned = await create({ content: 'тут ЗАПРЕЩЕНКА!' })
    expect(banned.status).toBe(400)
    expect(banned.body.error).toEqual({ code: 'BANNED_WORD', message: 'Post contains prohibited content' })
    await db.delete(bannedWords)
    invalidateBannedWords()
  })

  test('wall posts respect wallAccess', async () => {
    const owner = await createUser()
    const guest = await createUser()
    const onWall = await createPost(guest, { content: 'привет на стену', wallRecipientId: owner.id })
    expect(onWall.wallRecipient.id).toBe(owner.id)
    expect(await notificationTypes(owner)).toContain('wall_post')
    expect((await api('GET', `/users/${guest.username}`)).body.postsCount).toBe(0)
    expect((await api('GET', `/posts/user/${owner.username}`)).body.data.posts.map((p: any) => p.id)).toContain(onWall.id)

    await api('PUT', '/users/me/privacy', { token: owner.token, body: { wallAccess: 'followers' } })
    const denied = await api('POST', '/posts', { token: guest.token, body: { content: 'ещё', wallRecipientId: owner.id } })
    expect(denied.body.error.message).toBe('You do not have permission to write on this wall')
    await api('POST', `/users/${owner.id}/follow`, { token: guest.token })
    expect((await api('POST', '/posts', { token: guest.token, body: { content: 'ещё', wallRecipientId: owner.id } })).status).toBe(201)
    expect((await api('POST', '/posts', { token: owner.token, body: { content: 'x', wallRecipientId: owner.id } })).body.error.message).toBe('Cannot write on your own wall')
    expect((await api('POST', '/posts', { token: owner.token, body: { content: 'x', wallRecipientId: crypto.randomUUID() } })).body.error.message).toBe(
      'Wall recipient not found'
    )

    // the wall owner may delete guests' posts
    expect((await api('DELETE', `/posts/${onWall.id}`, { token: owner.token })).body.success).toBe(true)
  })

  test('attachments must be owned; video needs НУКСТА', async () => {
    const alice = await createUser()
    const bob = await createUser()
    const image = await api('POST', '/files/upload', { token: alice.token, form: uploadForm(PNG_1x1, 'dot.png') })
    expect(image.status).toBe(201)
    expect(image.body).toMatchObject({ mimeType: 'image/png', type: 'image', width: 1, height: 1, size: PNG_1x1.length })

    const post = await createPost(alice, { content: 'картинка', attachmentIds: [image.body.id] })
    expect(post.attachments[0]).toMatchObject({ id: image.body.id, type: 'image', width: 1, order: 0 })
    const stolen = await api('POST', '/posts', { token: bob.token, body: { attachmentIds: [image.body.id] } })
    expect(stolen.body.error).toEqual({ code: 'FORBIDDEN', message: 'Некоторые файлы не принадлежат вам' })
    expect((await api('DELETE', `/files/${image.body.id}`, { token: alice.token })).body.error.code).toBe('FILE_IN_USE')

    const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex'), Buffer.alloc(64)])
    const video = await api('POST', '/files/upload', { token: alice.token, form: uploadForm(mp4, 'clip.mp4') })
    expect(video.body.type).toBe('video')
    expect((await api('POST', '/posts', { token: alice.token, body: { attachmentIds: [video.body.id] } })).body.error.code).toBe('VIDEO_REQUIRES_NUKSTA')
    await db.insert(subscriptions).values({ userId: alice.id, expiresAt: new Date(Date.now() + 86400_000) })
    expect((await api('POST', '/posts', { token: alice.token, body: { attachmentIds: [video.body.id] } })).status).toBe(201)

    const text = await api('POST', '/files/upload', { token: alice.token, form: uploadForm(Buffer.from('just some text, not media'), 'a.png', 'image/png') })
    expect(text.body.error.message).toBe('Недопустимый тип файла')
  })
})

describe('likes, reposts, stats', () => {
  test('likes are idempotent and drive the dominant emoji', async () => {
    const author = await createUser({ avatar: '🐶' })
    const fox1 = await createUser({ avatar: '🦊' })
    const fox2 = await createUser({ avatar: '🦊' })
    const post = await createPost(author, 'лайкайте')

    expect((await api('POST', `/posts/${post.id}/like`, { token: fox1.token })).body).toEqual({ liked: true, likesCount: 1 })
    expect((await api('POST', `/posts/${post.id}/like`, { token: fox1.token })).body).toEqual({ liked: true, likesCount: 1 })
    // stats are cached in redis after the first read and kept in sync by later writes
    expect((await api('POST', '/posts/stats', { body: { ids: [post.id] } })).body.posts[0].likesCount).toBe(1)
    await api('POST', `/posts/${post.id}/like`, { token: fox2.token })
    const stats = await api('POST', '/posts/stats', { token: fox2.token, body: { ids: [post.id, crypto.randomUUID()] } })
    expect(stats.body.posts).toHaveLength(1)
    expect(stats.body.posts[0]).toMatchObject({ likesCount: 2, dominantEmoji: '🦊', isLiked: true })

    expect((await api('DELETE', `/posts/${post.id}/like`, { token: fox2.token })).body).toEqual({ liked: false, likesCount: 1 })
    expect((await api('POST', '/posts/stats', { body: { ids: [post.id] } })).body.posts[0]).toMatchObject({ likesCount: 1, dominantEmoji: null })
    expect((await notificationTypes(author)).filter((t: string) => t === 'like')).toHaveLength(2)
  })

  test('reposts', async () => {
    const author = await createUser()
    const fan = await createUser()
    const post = await createPost(author, 'оригинал')
    expect((await api('POST', `/posts/${post.id}/repost`, { token: author.token })).body.error.message).toBe('Cannot repost your own post')

    const repost = await api('POST', `/posts/${post.id}/repost`, { token: fan.token, body: { content: 'смотрите' } })
    expect(repost.status).toBe(201)
    expect(repost.body).toMatchObject({ content: 'смотрите', originalPost: { id: post.id, repostsCount: 1, isReposted: true } })
    expect((await api('POST', `/posts/${post.id}/repost`, { token: fan.token })).body.error).toEqual({ code: 'CONFLICT', message: 'Post already reposted' })
    // reposting a repost targets the original
    const third = await createUser()
    const chained = await api('POST', `/posts/${repost.body.id}/repost`, { token: third.token })
    expect(chained.body.originalPost.id).toBe(post.id)
    expect((await api('GET', `/posts/${post.id}`)).body.data.repostsCount).toBe(2)

    expect((await api('DELETE', `/posts/${post.id}/repost`, { token: fan.token })).body).toEqual({ success: true, repostsCount: 1 })
    expect((await api('GET', `/users/${fan.username}`)).body.postsCount).toBe(0)
  })

  test('edit window, delete and restore keep counters right', async () => {
    const author = await createUser()
    const post = await createPost(author, 'первая версия #старый')
    const edited = await api('PUT', `/posts/${post.id}`, { token: author.token, body: { content: 'вторая версия #новый' } })
    expect(edited.body.spans).toEqual([{ offset: 14, length: 6, type: 'hashtag', tag: 'новый' }])
    expect((await api('GET', `/hashtags/${encodeURIComponent('старый')}/posts`)).body.data.hashtag.postsCount).toBe(0)
    expect((await api('GET', `/hashtags/${encodeURIComponent('новый')}/posts`)).body.data.hashtag.postsCount).toBe(1)
    expect((await api('GET', `/posts/${post.id}`)).body.data.editedAt).toBeString()

    await db.update(posts).set({ createdAt: sql`now() - interval '3 days'` }).where(eq(posts.id, post.id))
    expect((await api('PUT', `/posts/${post.id}`, { token: author.token, body: { content: 'поздно' } })).body.error.code).toBe('EDIT_WINDOW_EXPIRED')

    const other = await createUser()
    expect((await api('DELETE', `/posts/${post.id}`, { token: other.token })).status).toBe(403)
    expect((await api('DELETE', `/posts/${post.id}`, { token: author.token })).body.success).toBe(true)
    expect((await api('GET', `/posts/${post.id}`)).status).toBe(404)
    expect((await api('GET', `/users/${author.username}`)).body.postsCount).toBe(0)
    expect((await api('GET', `/hashtags/${encodeURIComponent('новый')}/posts`)).body.data.hashtag.postsCount).toBe(0)

    expect((await api('POST', `/posts/${post.id}/restore`, { token: author.token })).body.success).toBe(true)
    expect((await api('GET', `/users/${author.username}`)).body.postsCount).toBe(1)
    expect((await api('GET', `/hashtags/${encodeURIComponent('новый')}/posts`)).body.data.posts).toHaveLength(1)
    expect((await api('POST', `/posts/${post.id}/restore`, { token: author.token })).body.error.code).toBe('NOT_DELETED')
  })

  test('polls', async () => {
    const author = await createUser()
    const voter = await createUser()
    const post = await createPost(author, { content: 'выбор', poll: { question: 'Лучший язык?', options: [{ text: 'Python' }, { text: 'TypeScript' }] } })
    const [python, ts] = post.poll.options
    const vote = (body: unknown, token = voter.token) => api('POST', `/posts/${post.id}/poll/vote`, { token, body })
    expect((await vote({ optionIds: [crypto.randomUUID()] })).body.error.message).toBe('Один или несколько вариантов не принадлежат этому опросу')
    expect((await vote({ optionIds: [python.id, ts.id] })).body.error.message).toBe('В этом опросе можно выбрать только один вариант')
    const ok = await vote({ optionIds: [ts.id] })
    expect(ok.body.data).toMatchObject({ hasVoted: true, votedOptionIds: [ts.id], totalVotes: 1 })
    expect(ok.body.data.options[1].votesCount).toBe(1)
    expect((await vote({ optionIds: [python.id] })).status).toBe(409)
    const plain = await createPost(author, 'без опроса')
    expect((await api('POST', `/posts/${plain.id}/poll/vote`, { token: voter.token, body: { optionIds: [ts.id] } })).body.error.message).toBe('Опрос не найден')
  })
})

describe('feeds & walls', () => {
  test('following feed paginates with opaque cursors', async () => {
    const reader = await createUser()
    const writer = await createUser()
    await api('POST', `/users/${writer.id}/follow`, { token: reader.token })
    const created = []
    for (let i = 0; i < 5; i++) created.push(await createPost(writer, `пост ${i}`))

    const page1 = await api('GET', '/posts?tab=following&limit=2', { token: reader.token })
    expect(page1.body.data.posts.map((p: any) => p.content)).toEqual(['пост 4', 'пост 3'])
    expect(page1.body.data.pagination.hasMore).toBe(true)
    const page2 = await api('GET', `/posts?tab=following&limit=2&cursor=${page1.body.data.pagination.nextCursor}`, { token: reader.token })
    expect(page2.body.data.posts.map((p: any) => p.content)).toEqual(['пост 2', 'пост 1'])
    const page3 = await api('GET', `/posts?tab=following&limit=2&cursor=${page2.body.data.pagination.nextCursor}`, { token: reader.token })
    expect(page3.body.data.posts.map((p: any) => p.content)).toEqual(['пост 0'])
    expect(page3.body.data.pagination).toEqual({ nextCursor: null, hasMore: false })
  })

  test('clan feed and popular feed', async () => {
    const owl1 = await createUser({ avatar: '🦉' })
    const owl2 = await createUser({ avatar: '🦉' })
    const cat = await createUser({ avatar: '🐈' })
    const owlPost = await createPost(owl2, 'для совят')
    await createPost(cat, 'для котов')
    const clan = await api('GET', '/posts?tab=clan', { token: owl1.token })
    expect(clan.body.data.posts.map((p: any) => p.id)).toEqual([owlPost.id])

    for (let i = 0; i < 3; i++) {
      const fan = await createUser()
      await api('POST', `/posts/${owlPost.id}/like`, { token: fan.token })
    }
    const popular = await api('GET', '/posts?limit=3')
    expect(popular.body.data.posts[0].id).toBe(owlPost.id)
    const next = await api('GET', `/posts?limit=3&cursor=${popular.body.data.pagination.nextCursor}`)
    const seen = new Set(popular.body.data.posts.map((p: any) => p.id))
    expect(next.body.data.posts.every((p: any) => !seen.has(p.id))).toBe(true)
  })

  test('wall shows the pinned post first and liked posts honour likesVisibility', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const old = await createPost(owner, 'старый')
    for (let i = 0; i < 3; i++) await createPost(owner, `новый ${i}`)
    expect((await api('POST', `/posts/${old.id}/pin`, { token: owner.token })).body).toEqual({ success: true, pinnedPostId: old.id })

    const wall = await api('GET', `/posts/user/${owner.username}?limit=2&pinnedPostId=${old.id}`, { token: viewer.token })
    expect(wall.body.data.posts.map((p: any) => p.content)).toEqual(['старый', 'новый 2', 'новый 1'])
    expect(wall.body.data.posts[0].isPinned).toBe(true)
    const rest = await api('GET', `/posts/user/${owner.username}?limit=2&pinnedPostId=${old.id}&cursor=${wall.body.data.pagination.nextCursor}`)
    expect(rest.body.data.posts.map((p: any) => p.content)).toEqual(['новый 0'])
    expect((await api('DELETE', `/posts/${old.id}/pin`, { token: owner.token })).body.success).toBe(true)
    expect((await api('DELETE', `/posts/${old.id}/pin`, { token: owner.token })).body.error.code).toBe('NOT_PINNED')
    expect((await api('POST', `/posts/${old.id}/pin`, { token: viewer.token })).status).toBe(403)

    await api('POST', `/posts/${old.id}/like`, { token: owner.token })
    expect((await api('GET', `/posts/user/${owner.username}/liked`, { token: viewer.token })).body.data.posts).toHaveLength(1)
    await api('PUT', '/users/me/privacy', { token: owner.token, body: { likesVisibility: 'nobody' } })
    expect((await api('GET', `/posts/user/${owner.username}/liked`, { token: viewer.token })).body.data.posts).toHaveLength(0)
    expect((await api('GET', `/posts/user/${owner.username}/liked`, { token: owner.token })).body.data.posts).toHaveLength(1)
  })

  test('private and banned authors are hidden', async () => {
    const hidden = await createUser()
    const stranger = await createUser()
    const post = await createPost(hidden, 'только для своих')
    await api('PUT', '/users/me/privacy', { token: hidden.token, body: { isPrivate: true } })
    expect((await api('GET', `/posts/${post.id}`, { token: stranger.token })).body.error.code).toBe('PRIVATE_ACCOUNT')
    expect((await api('GET', `/posts/${post.id}`, { token: hidden.token })).status).toBe(200)

    await api('PUT', '/users/me/privacy', { token: hidden.token, body: { isPrivate: false } })
    await db.update(users).set({ isBanned: true }).where(eq(users.id, hidden.id))
    expect((await api('GET', `/posts/${post.id}`, { token: stranger.token })).status).toBe(404)
    const profile = await api('GET', `/users/${hidden.username}`)
    expect(profile.body.error).toEqual({ code: 'USER_BANNED', message: 'Этот аккаунт заблокирован' })
    await db.update(users).set({ isBanned: false }).where(eq(users.id, hidden.id))
  })

  test('hashtag pages and search', async () => {
    const author = await createUser({ name: 'searchable_writer' })
    for (let i = 0; i < 3; i++) await createPost(author, `тег #котики номер ${i}`)
    const page = await api('GET', `/hashtags/${encodeURIComponent('#Котики')}/posts?limit=2`)
    expect(page.body.data.hashtag).toMatchObject({ name: 'котики', postsCount: 3 })
    expect(page.body.data.posts).toHaveLength(2)
    const next = await api('GET', `/hashtags/${encodeURIComponent('котики')}/posts?limit=2&cursor=${page.body.data.pagination.nextCursor}`)
    expect(next.body.data.posts).toHaveLength(1)
    expect((await api('GET', '/hashtags/nonexistent_tag/posts')).body.data).toEqual({ hashtag: null, posts: [], pagination: { nextCursor: null, hasMore: false } })
    expect((await api('GET', '/hashtags/trending?limit=5')).body.data.hashtags.map((h: any) => h.name)).toContain('котики')

    const found = await api('GET', '/search?q=searchable&userLimit=5&hashtagLimit=5')
    expect(found.body.data.users.map((u: any) => u.username)).toEqual(['searchable_writer'])
    expect((await api('GET', `/search?q=${encodeURIComponent('#кот')}`)).body.data.hashtags.map((h: any) => h.name)).toEqual(['котики'])
  })
})
