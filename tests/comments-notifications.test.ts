import { beforeAll, describe, expect, test } from 'bun:test'
import { api, app, createPost, createUser, resetState } from './helpers'

beforeAll(resetState)

describe('comments', () => {
  test('comments, replies, likes and counters', async () => {
    const author = await createUser()
    const alice = await createUser()
    const bob = await createUser()
    const post = await createPost(author, 'обсуждаем')

    const comment = await api('POST', `/posts/${post.id}/comments`, { token: alice.token, body: { content: `первый @${bob.username}` } })
    expect(comment.status).toBe(201)
    expect(comment.body).toMatchObject({ content: `первый @${bob.username}`, rootId: null, likesCount: 0, replies: [], replyTo: null })
    const reply = await api('POST', `/comments/${comment.body.id}/replies`, { token: bob.token, body: { content: 'ответ' } })
    expect(reply.body).toMatchObject({ rootId: comment.body.id, replyTo: { id: alice.id } })
    // a reply to a reply is attached to the root comment
    const nested = await api('POST', `/comments/${reply.body.id}/replies`, { token: alice.token, body: { content: 'ответ на ответ', replyToUserId: bob.id } })
    expect(nested.body).toMatchObject({ rootId: comment.body.id, replyTo: { id: bob.id } })

    expect((await api('POST', `/comments/${comment.body.id}/like`, { token: bob.token })).body).toEqual({ liked: true, likesCount: 1 })
    const listed = await api('GET', `/posts/${post.id}/comments`, { token: bob.token })
    expect(listed.body.data).toMatchObject({ total: 1, hasMore: false, nextCursor: null })
    expect(listed.body.data.comments[0]).toMatchObject({ id: comment.body.id, repliesCount: 2, isLiked: true })
    expect(listed.body.data.comments[0].replies.map((r: any) => r.content)).toEqual(['ответ', 'ответ на ответ'])

    const replies = await api('GET', `/comments/${comment.body.id}/replies?page=1&limit=1`)
    expect(replies.body.data.replies).toHaveLength(1)
    expect(replies.body.data.pagination).toEqual({ page: 1, limit: 1, total: 2, hasMore: true })
    const byCursor = await api('GET', `/comments/${comment.body.id}/replies?limit=1&cursor=${replies.body.data.nextCursor}`)
    expect(byCursor.body.data.replies[0].content).toBe('ответ на ответ')

    const single = await api('GET', `/posts/${post.id}`)
    expect(single.body.data.commentsCount).toBe(3)
    expect(single.body.data.comments).toHaveLength(1)

    const types = (await api('GET', '/notifications', { token: alice.token })).body.notifications.map((n: any) => n.type)
    expect(types.sort()).toEqual(['comment_like', 'reply'])
    const bobTypes = (await api('GET', '/notifications', { token: bob.token })).body.notifications.map((n: any) => n.type)
    expect(bobTypes.sort()).toEqual(['comment_mention', 'reply'])
  })

  test('edit, delete permissions and restore', async () => {
    const author = await createUser()
    const commenter = await createUser()
    const stranger = await createUser()
    const post = await createPost(author, 'пост')
    const comment = (await api('POST', `/posts/${post.id}/comments`, { token: commenter.token, body: { content: 'было' } })).body
    await api('POST', `/comments/${comment.id}/replies`, { token: author.token, body: { content: 'ответ автора' } })

    expect((await api('PATCH', `/comments/${comment.id}`, { token: stranger.token, body: { content: 'взлом' } })).body.error.message).toBe('Not allowed to edit this comment')
    const edited = await api('PATCH', `/comments/${comment.id}`, { token: commenter.token, body: { content: 'стало' } })
    expect(edited.body).toMatchObject({ id: comment.id, content: 'стало' })

    expect((await api('DELETE', `/comments/${comment.id}`, { token: stranger.token })).status).toBe(403)
    // the post author moderates comments under the post; the root takes its replies along
    expect((await api('DELETE', `/comments/${comment.id}`, { token: author.token })).body.success).toBe(true)
    expect((await api('DELETE', `/comments/${comment.id}`, { token: author.token })).body.error.code).toBe('ALREADY_DELETED')
    expect((await api('GET', `/posts/${post.id}`)).body.data.commentsCount).toBe(0)
    // deleting a reply under a deleted root must not change the post counter twice
    const replies = await api('GET', `/posts/${post.id}/comments`)
    expect(replies.body.data.total).toBe(0)
    expect((await api('POST', `/comments/${comment.id}/restore`, { token: commenter.token })).body.success).toBe(true)
    expect((await api('GET', `/posts/${post.id}`)).body.data.commentsCount).toBe(2)
    const reply = (await api('GET', `/comments/${comment.id}/replies`)).body.data.replies[0]
    await api('DELETE', `/comments/${comment.id}`, { token: author.token })
    await api('DELETE', `/comments/${reply.id}`, { token: author.token })
    expect((await api('GET', `/posts/${post.id}`)).body.data.commentsCount).toBe(0)
    await api('POST', `/comments/${comment.id}/restore`, { token: author.token })
    expect((await api('GET', `/posts/${post.id}`)).body.data).toMatchObject({ commentsCount: 1 })
    expect((await api('GET', `/posts/${post.id}/comments`)).body.data.comments[0].repliesCount).toBe(0)
  })

  test('validation and sorting', async () => {
    const author = await createUser()
    const post = await createPost(author, 'пост')
    expect((await api('POST', `/posts/${post.id}/comments`, { token: author.token, body: { content: ' ' } })).body.error.message).toBe('Content or attachments required')
    expect((await api('POST', `/posts/${crypto.randomUUID()}/comments`, { token: author.token, body: { content: 'x' } })).status).toBe(404)
    for (const text of ['a', 'b', 'c']) await api('POST', `/posts/${post.id}/comments`, { token: author.token, body: { content: text } })
    const oldest = await api('GET', `/posts/${post.id}/comments?sort=oldest&limit=2`)
    expect(oldest.body.data.comments.map((c: any) => c.content)).toEqual(['a', 'b'])
    expect(oldest.body.data.nextCursor).toBe(2)
    const rest = await api('GET', `/posts/${post.id}/comments?sort=old&limit=2&cursor=2`)
    expect(rest.body.data.comments.map((c: any) => c.content)).toEqual(['c'])
    const newest = await api('GET', `/posts/${post.id}/comments?sort=new&cursor=0`)
    expect(newest.body.data.comments.map((c: any) => c.content)).toEqual(['c', 'b', 'a'])
  })
})

describe('notifications', () => {
  test('list, dedupe, read state and counters', async () => {
    const target = await createUser()
    const actor = await createUser()
    const post = await createPost(target, 'пост')
    await api('POST', `/users/${target.id}/follow`, { token: actor.token })
    await api('DELETE', `/users/${target.id}/follow`, { token: actor.token })
    await api('POST', `/users/${target.id}/follow`, { token: actor.token })
    await api('POST', `/posts/${post.id}/like`, { token: actor.token })
    await api('DELETE', `/posts/${post.id}/like`, { token: actor.token })
    await api('POST', `/posts/${post.id}/like`, { token: actor.token })

    const list = await api('GET', '/notifications?limit=1', { token: target.token })
    expect(list.body.hasMore).toBe(true)
    expect(list.body.notifications[0]).toMatchObject({ type: 'like', targetType: 'post', targetId: post.id, read: false, preview: 'пост', actor: { id: actor.id } })
    const all = await api('GET', '/notifications', { token: target.token })
    expect(all.body.notifications.map((n: any) => n.type)).toEqual(['like', 'follow'])
    expect((await api('GET', '/notifications/count', { token: target.token })).body).toEqual({ count: 2 })

    expect((await api('POST', '/notifications/read-batch', { token: target.token, body: { ids: [list.body.notifications[0].id] } })).body).toEqual({ success: true, count: 1 })
    const missing = await api('POST', '/notifications/read-batch', { token: target.token, body: { ids: [crypto.randomUUID()] } })
    expect(missing.status).toBe(404)
    expect(missing.body.success).toBe(false)
    expect((await api('POST', '/notifications/read-all', { token: target.token })).body).toEqual({ success: true, count: 1 })
    expect((await api('GET', '/notifications/count', { token: target.token })).body.count).toBe(0)
  })

  test('settings accept both formats and mute notification types', async () => {
    const user = await createUser()
    const actor = await createUser()
    const legacy = await api('PUT', '/notifications/settings', { token: user.token, body: { follows: false, sound: false } })
    expect(legacy.body).toMatchObject({ follows: false, sound: false, soundEnabled: false, preferences: { follows: false, reactions: true } })
    const modern = await api('PUT', '/notifications/settings', { token: user.token, body: { webEnabled: false, preferences: { reactions: false } } })
    expect(modern.body).toMatchObject({ webEnabled: false, likes: false, follows: false })

    await api('POST', `/users/${user.id}/follow`, { token: actor.token })
    const post = await createPost(user, 'тихо')
    await api('POST', `/posts/${post.id}/like`, { token: actor.token })
    expect((await api('GET', '/notifications', { token: user.token })).body.notifications).toHaveLength(0)
    expect((await api('GET', '/notifications/settings', { token: user.token })).body.likes).toBe(false)
  })

  test('SSE stream delivers notifications through redis pub/sub', async () => {
    const listener = await createUser()
    const actor = await createUser()
    const post = await createPost(listener, 'живой пост')
    const controller = new AbortController()
    const res = await app.handle(
      new Request('http://localhost/api/notifications/stream', { headers: { authorization: `Bearer ${listener.token}` }, signal: controller.signal })
    )
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 5000
      while (!buffer.includes(needle) && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(5000).then(() => ({ done: true, value: undefined }))])
        if (chunk.done) break
        buffer += decoder.decode(chunk.value)
      }
      return buffer
    }

    const hello = await readUntil('timestamp')
    expect(hello).toContain(`"userId":"${listener.id}"`)
    // presence: an open stream marks the user online
    expect((await api('GET', `/users/${listener.username}`, { token: actor.token })).body.online).toBe(true)

    await api('POST', `/posts/${post.id}/like`, { token: actor.token })
    const text = await readUntil('event: notification')
    const event = text.split('\n\n').find((block) => block.startsWith('event: notification'))!
    const payload = JSON.parse(event.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
    expect(payload).toMatchObject({ type: 'like', targetId: post.id, sound: true, actor: { id: actor.id } })
    controller.abort()
    await reader.cancel().catch(() => {})
  })
})
