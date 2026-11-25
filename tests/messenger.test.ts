import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { api, app, createUser, PNG_1x1, resetState, type TestUser } from './helpers'

beforeAll(resetState)

const M = '/v1/messenger'
const as = (user: TestUser) => ({ token: user.token })
const uuid = () => crypto.randomUUID()

async function send(from: TestUser, to: TestUser, text: string, extra: Record<string, unknown> = {}) {
  const res = await api('POST', `${M}/users/${to.id}/messages`, { ...as(from), body: { text, ...extra } })
  if (res.status !== 200) throw new Error(`send failed: ${JSON.stringify(res.body)}`)
  return res.body
}

async function updates(user: TestUser, since = 0) {
  return (await api('GET', `${M}/updates?since=${since}&capabilities=chat_settings&manual_unread=1`, as(user))).body
}

describe('messenger: chats and messages', () => {
  test('a first message opens the chat; the recipient sees it, unread, and in its events', async () => {
    const [alice, bob] = [await createUser(), await createUser()]
    const clientId = uuid()
    const sent = await send(alice, bob, 'привет', { client_message_id: clientId })
    expect(sent).toMatchObject({ text: 'привет', sender_id: alice.id, client_message_id: clientId, event_seq: 1 })
    expect(sent.chat_id).toMatch(/^[0-9a-f-]{36}$/)

    // a retried send returns the stored message
    const replay = await send(alice, bob, 'привет', { client_message_id: clientId })
    expect(replay).toMatchObject({ replayed: true, message_id: sent.message_id })

    const list = (await api('GET', `${M}/chats?limit=30&manual_unread=1`, as(bob))).body
    const chat = list.chats[0]
    expect(list.event_seq).toBe(1)
    expect(chat).toMatchObject({ chat_id: sent.chat_id, chat_type: 0, title: alice.username, avatar: '🐱', other_user_id: alice.id, unread_count: 1 })
    expect(chat.last_message).toMatchObject({ id: sent.message_id, text: 'привет', sender_id: alice.id, attachment_count: 0 })
    expect((await api('GET', `${M}/chats/unread?manual_unread=1`, as(bob))).body).toEqual({ total: 1 })

    const events = await updates(bob)
    expect(events.reset_required).toBe(false)
    expect(events.next_event_seq).toBe(1)
    expect(events.events[0]).toMatchObject({ type: 'new_message', chat_id: sent.chat_id, event_seq: 1, message: { message_id: sent.message_id } })
    // the client's own copy of the sent message
    expect((await updates(alice)).events[0]).toMatchObject({ type: 'own_messages', messages: [{ client_message_id: clientId }] })

    // reading: the counter drops and the sender learns how far the recipient read
    const read = await api('POST', `${M}/chats/${sent.chat_id}/read`, { ...as(bob), body: { last_read_message: sent.message_id } })
    expect(read.body).toMatchObject({ success: true, event_seq: 2 })
    expect((await api('GET', `${M}/chats/unread`, as(bob))).body.total).toBe(0)
    expect((await updates(alice, 1)).events[0]).toMatchObject({ type: 'messages_read', user_id: bob.id, last_read_message: sent.message_id })
    expect((await api('GET', `${M}/chats/${sent.chat_id}`, as(alice))).body.other_read_message_id).toBe(sent.message_id)

    // strangers do not see the chat
    const eve = await createUser()
    expect((await api('GET', `${M}/chats/${sent.chat_id}`, as(eve))).status).toBe(404)
    expect((await api('GET', `${M}/chats/${sent.chat_id}/messages`, as(eve))).status).toBe(404)
  })

  test('history pages newest first, replies, formatting, editing and deleting', async () => {
    const [alice, bob] = [await createUser(), await createUser()]
    const first = await send(alice, bob, 'один')
    const chatId = first.chat_id
    const ids = [first.message_id]
    for (const text of ['два', 'три', 'четыре']) ids.push((await send(bob, alice, text)).message_id)

    const page = (await api('GET', `${M}/chats/${chatId}/messages?limit=2`, as(alice))).body
    expect(page.messages.map((m: { text: string }) => m.text)).toEqual(['четыре', 'три'])
    expect(page.has_older).toBe(true)
    const older = (await api('GET', `${M}/chats/${chatId}/messages?limit=2&before=${page.messages[1].message_id}`, as(alice))).body
    expect(older.messages.map((m: { text: string }) => m.text)).toEqual(['два', 'один'])
    expect(older.has_older).toBe(false)
    const around = (await api('GET', `${M}/chats/${chatId}/messages/around/${ids[1]}?limit=2`, as(alice))).body
    expect(around.messages.map((m: { text: string }) => m.text)).toEqual(['три', 'два'])
    expect(around).toMatchObject({ has_older: true, has_newer: true })

    const reply = await api('POST', `${M}/chats/${chatId}/messages`, {
      ...as(alice),
      body: { text: 'жирный ответ', reply_to_id: ids[3], entities: [{ type: 'bold', offset: 0, length: 6 }, { type: 'text_link', offset: 7, length: 5, url: 'https://example.com' }] }
    })
    expect(reply.body.reply_to).toMatchObject({ message_id: ids[3], sender_id: bob.id, text: 'четыре', sender_name: bob.username })
    expect(reply.body.entities).toEqual([{ type: 'bold', offset: 0, length: 6 }, { type: 'text_link', offset: 7, length: 5, url: 'https://example.com/' }])
    const badRange = await api('POST', `${M}/chats/${chatId}/messages`, { ...as(alice), body: { text: 'ой', entities: [{ type: 'bold', offset: 1, length: 5 }] } })
    expect(badRange.status).toBe(400)
    expect((await api('POST', `${M}/chats/${chatId}/messages`, { ...as(alice), body: { text: '   ' } })).status).toBe(400)

    const edited = await api('PATCH', `${M}/chats/${chatId}/messages/${reply.body.message_id}`, { ...as(alice), body: { text: 'исправлено' } })
    expect(edited.body).toMatchObject({ text: 'исправлено', entities: null })
    expect(edited.body.edited_at).toBeString()
    expect((await api('PATCH', `${M}/chats/${chatId}/messages/${ids[1]}`, { ...as(alice), body: { text: 'чужое' } })).status).toBe(403)
    const bobEvents = (await updates(bob)).events
    expect(bobEvents.at(-1)).toMatchObject({ type: 'message_edited', message_id: reply.body.message_id, message: { text: 'исправлено' } })

    // for me: only alice stops seeing it; for all: only one's own messages
    const forMe = await api('POST', `${M}/chats/${chatId}/messages/delete-for-me`, { ...as(alice), body: { message_ids: [ids[1]] } })
    expect(forMe.body).toMatchObject({ ok: [ids[1]], failed: [] })
    const forAll = await api('POST', `${M}/chats/${chatId}/messages/delete-for-all`, { ...as(alice), body: { message_ids: [ids[0], ids[2]] } })
    expect(forAll.body).toMatchObject({ ok: [ids[0]], failed: [ids[2]] })
    const aliceSees = (await api('GET', `${M}/chats/${chatId}/messages`, as(alice))).body.messages.map((m: { message_id: string }) => m.message_id)
    const bobSees = (await api('GET', `${M}/chats/${chatId}/messages`, as(bob))).body.messages.map((m: { message_id: string }) => m.message_id)
    expect(aliceSees).not.toContain(ids[1])
    expect(aliceSees).not.toContain(ids[0])
    expect(bobSees).toContain(ids[1])
    expect(bobSees).not.toContain(ids[0])
    expect((await updates(bob)).events.at(-1)).toMatchObject({ type: 'messages_deleted', message_ids: [ids[0]] })
  })

  test('reactions: the catalog, versions and what each member sees', async () => {
    const [alice, bob] = [await createUser(), await createUser()]
    const sent = await send(alice, bob, 'реагируй')
    const catalog = (await api('GET', `${M}/reactions/available`, as(bob))).body
    expect(catalog.user_max).toBe(3)
    expect(catalog.reactions).toHaveLength(55)
    expect(catalog.reactions[0]).toEqual({ type: 'emoji', emoji: '🙂', title: 'Улыбка' })

    const path = `${M}/chats/${sent.chat_id}/messages/${sent.message_id}/reactions`
    // the heart without its variation selector is the same reaction
    const set = await api('PUT', path, { ...as(bob), body: { reactions: [{ type: 'emoji', emoji: '❤' }], expected_version: '0', operation_id: uuid() } })
    expect(set.body).toEqual({ reaction_version: '1', reactions: [{ reaction: { type: 'emoji', emoji: '❤️' }, count: 1, chosen: true }] })
    const stale = await api('PUT', path, { ...as(alice), body: { reactions: [{ type: 'emoji', emoji: '🔥' }], expected_version: '0' } })
    expect(stale.status).toBe(409)
    expect((await api('PUT', path, { ...as(alice), body: { reactions: [{ type: 'emoji', emoji: '🦄' }], expected_version: '1' } })).status).toBe(400)

    expect((await api('GET', path, as(alice))).body.reactions).toEqual([{ reaction: { type: 'emoji', emoji: '❤️' }, count: 1, chosen: false }])
    const frame = (await updates(alice)).events.at(-1)
    expect(frame).toMatchObject({ type: 'message_reactions', message_id: sent.message_id, reaction_version: '1', by: bob.id, my_reactions: [] })
    const listed = (await api('GET', `${M}/chats/${sent.chat_id}/messages`, as(bob))).body.messages[0]
    expect(listed).toMatchObject({ reaction_version: '1', reactions: [{ count: 1, chosen: true }] })
  })

  test('forwarding keeps the first author', async () => {
    const [alice, bob, carol] = [await createUser(), await createUser(), await createUser()]
    const original = await send(bob, alice, 'новость')
    const toCarol = await send(alice, carol, 'смотри')
    const once = await api('POST', `${M}/chats/${toCarol.chat_id}/messages/forward`, {
      ...as(alice),
      body: { source_chat_id: original.chat_id, message_ids: [original.message_id, uuid()], client_message_ids: { [original.message_id]: uuid() } }
    })
    expect(once.body.ok).toHaveLength(1)
    expect(once.body.failed).toHaveLength(1)
    const copy = (await api('GET', `${M}/chats/${toCarol.chat_id}/messages`, as(carol))).body.messages[0]
    expect(copy).toMatchObject({ text: 'новость', sender_id: alice.id, forwarded_from_sender_id: bob.id, forwarded_from_name: bob.username })
    expect((await updates(carol)).events.at(-1)).toMatchObject({ type: 'new_messages', messages: [{ text: 'новость' }] })
    // a forwarded message cannot be edited
    const edit = await api('PATCH', `${M}/chats/${toCarol.chat_id}/messages/${copy.message_id}`, { ...as(alice), body: { text: 'другое' } })
    expect(edit.body.error.message).toBe('forwarded_message_read_only')
  })

  test('who can write: privacy setting, an existing conversation and blocks', async () => {
    const [alice, carol] = [await createUser(), await createUser()]
    await api('PUT', '/users/me/privacy', { ...as(carol), body: { messageAccess: 'nobody' } })
    const closed = await api('POST', `${M}/users/${carol.id}/messages`, { ...as(alice), body: { text: 'можно?' } })
    expect(closed.status).toBe(403)
    expect(closed.body.error.message).toBe('Пользователь ограничил отправку сообщений')
    // carol wrote first: alice may answer
    const fromCarol = await send(carol, alice, 'пиши')
    expect((await api('POST', `${M}/chats/${fromCarol.chat_id}/messages`, { ...as(alice), body: { text: 'спасибо' } })).status).toBe(200)

    await api('POST', `/users/${carol.id}/block`, as(alice))
    const blocked = await api('POST', `${M}/chats/${fromCarol.chat_id}/messages`, { ...as(carol), body: { text: 'эй' } })
    expect(blocked.status).toBe(403)
    expect((await api('POST', `${M}/chats/dm`, { ...as(carol), body: { target_user_id: alice.id } })).status).toBe(403)
    expect((await api('POST', `${M}/chats/dm`, { ...as(alice), body: { target_user_id: alice.id } })).status).toBe(400)
  })

  test('chat settings, clearing history, deleting a chat; /updates asks for a reset when it cannot replay', async () => {
    const [alice, bob] = [await createUser(), await createUser()]
    const dm = await api('POST', `${M}/chats/dm`, { ...as(alice), body: { target_user_id: bob.id } })
    const chatId = dm.body.chat_id
    // an empty chat is listed for whoever opened it only
    expect((await api('GET', `${M}/chats`, as(alice))).body.chats.map((c: { chat_id: string }) => c.chat_id)).toEqual([chatId])
    expect((await api('GET', `${M}/chats`, as(bob))).body.chats).toEqual([])
    expect((await api('POST', `${M}/chats/dm`, { ...as(alice), body: { target_user_id: bob.id } })).body.chat_id).toBe(chatId)

    await send(bob, alice, 'раз')
    for (const [path, body, field] of [
      ['pin', { is_pinned: true }, 'is_pinned'],
      ['mute', { is_muted: true }, 'is_muted'],
      ['unread', { unread: true }, 'marked_unread']
    ] as const) {
      const res = await api('PATCH', `${M}/chats/${chatId}/${path}`, { ...as(alice), body })
      expect(res.status).toBe(200)
      expect((await api('GET', `${M}/chats/${chatId}`, as(alice))).body[field]).toBe(true)
    }
    expect((await updates(alice)).events.at(-1)).toMatchObject({ type: 'chat_settings', chat_id: chatId, marked_unread: true })

    await api('POST', `${M}/chats/${chatId}/clear-history`, as(alice))
    expect((await api('GET', `${M}/chats/${chatId}/messages`, as(alice))).body.messages).toEqual([])
    expect((await api('GET', `${M}/chats/${chatId}/messages`, as(bob))).body.messages).toHaveLength(1)

    await api('POST', `${M}/chats/${chatId}/delete`, { ...as(alice), body: { for_everyone: false } })
    expect((await api('GET', `${M}/chats`, as(alice))).body.chats).toEqual([])
    // a new message brings the chat back, with that message only
    await send(bob, alice, 'два')
    const back = (await api('GET', `${M}/chats`, as(alice))).body.chats
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ unread_count: 1, last_message: { text: 'два' } })

    const all = await updates(alice)
    expect((await updates(alice, all.next_event_seq + 5)).reset_required).toBe(true)
    expect(await updates(alice, all.next_event_seq)).toEqual({ events: [], reset_required: false, next_event_seq: all.next_event_seq })
  })
})

describe('messenger: files', () => {
  async function upload(user: TestUser, bytes: Uint8Array, mime: string, finalize: Record<string, unknown> = {}) {
    const init = await api('POST', `${M}/media/upload/init`, { ...as(user), body: { mime, size: bytes.length, totalParts: 1 } })
    expect(init.status).toBe(200)
    const part = await api('PUT', `${M}/media/upload/${init.body.uploadId}/part/0`, {
      ...as(user),
      raw: bytes,
      headers: { 'content-type': 'application/octet-stream' }
    })
    expect(part.status).toBe(200)
    return api('POST', `${M}/media/upload/${init.body.uploadId}/finalize`, { ...as(user), body: finalize })
  }

  test('upload in parts, send, and find it in the chat media', async () => {
    const [alice, bob] = [await createUser(), await createUser()]
    const image = await upload(alice, PNG_1x1, 'image/png', { filename: 'dot.png', thumb: { bytes: PNG_1x1.toString('base64'), width: 1, height: 1 } })
    expect(image.body).toMatchObject({ mime: 'image/png', sizePlain: PNG_1x1.length })
    // a document keeps its name, but is stored as a download (never served as a page)
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    const doc = await upload(alice, html, 'text/html', { filename: 'page.html' })
    expect(doc.body.url).toEndWith('.bin')

    const sent = await send(alice, bob, '', { attachments: [image.body.fileId, doc.body.fileId] })
    expect(sent.attachments.map((a: { filename: string }) => a.filename)).toEqual(['dot.png', 'page.html'])
    expect(sent.attachments[0]).toMatchObject({ mime: 'image/png', width: 1, height: 1, expiresIn: 86400 })
    expect(sent.attachments[0]).toMatchObject({ thumbWidth: 1, thumbHeight: 1 })
    expect(sent.attachments[0].thumbUrl).toBeString()
    const served = await app.handle(new Request(`http://localhost${new URL(doc.body.url).pathname}`))
    expect(served.headers.get('content-type')).toBe('application/octet-stream')

    const chat = (await api('GET', `${M}/chats`, as(bob))).body.chats[0]
    expect(chat.last_message).toMatchObject({ attachment_kind: 'mixed', attachment_count: 2, attachment_filename: 'dot.png' })
    const media = (await api('GET', `${M}/chats/${sent.chat_id}/media?category=0&limit=40`, as(bob))).body
    expect(media.items.map((i: { file: { fileId: string } }) => i.file.fileId)).toEqual([image.body.fileId])
    const files = (await api('GET', `${M}/chats/${sent.chat_id}/media?category=1`, as(bob))).body
    expect(files.items.map((i: { file: { fileId: string } }) => i.file.fileId)).toEqual([doc.body.fileId])
    const links = await api('POST', `${M}/chats/${sent.chat_id}/file-links`, { ...as(bob), body: { file_ids: [image.body.fileId, crypto.randomUUID()] } })
    expect(links.body.links).toHaveLength(1)

    // someone else's file cannot be attached; a part of the wrong size is refused
    expect((await api('POST', `${M}/users/${alice.id}/messages`, { ...as(bob), body: { text: 'x', attachments: [image.body.fileId] } })).status).toBe(400)
    const init = await api('POST', `${M}/media/upload/init`, { ...as(bob), body: { mime: 'image/png', size: 100, totalParts: 1 } })
    const wrong = await api('PUT', `${M}/media/upload/${init.body.uploadId}/part/0`, { ...as(bob), raw: new Uint8Array(10), headers: { 'content-type': 'application/octet-stream' } })
    expect(wrong.status).toBe(400)
    expect((await api('POST', `${M}/media/upload/${init.body.uploadId}/finalize`, { ...as(alice), body: {} })).status).toBe(404)
    expect((await api('POST', `${M}/media/upload/init`, { ...as(bob), body: { mime: 'image/png', size: 100, totalParts: 2 } })).status).toBe(400)
  })
})

describe('messenger: WebSocket', () => {
  let server: ReturnType<typeof app.listen> | undefined
  let base = ''
  beforeAll(() => {
    server = app.listen({ port: 0, hostname: '127.0.0.1' })
    base = `ws://127.0.0.1:${server.server!.port}/api${M}/ws?capabilities=chat_settings_v2`
  })
  afterAll(() => server?.stop(true))

  function connect(user: TestUser | null, token?: string) {
    const socket = new WebSocket(base, ['itd.messenger.v1', `bearer.${token ?? user!.token}`])
    const frames: unknown[] = []
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (e) => resolve(e.code)))
    socket.addEventListener('message', (e) => frames.push(e.data === 'pong' ? 'pong' : JSON.parse(String(e.data))))
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('socket error')))
    })
    return { socket, frames, opened, closed }
  }

  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(20)
    expect(check()).toBe(true)
  }

  test('pushes events live with their numbers, typing without; ping → pong', async () => {
    const [alice, bob] = [await createUser(), await createUser()]
    const bobSocket = connect(bob)
    await bobSocket.opened
    expect(bobSocket.socket.protocol).toBe('itd.messenger.v1')
    // the subscription is set up right after the socket opens
    await Bun.sleep(100)

    const sent = await send(alice, bob, 'вживую')
    await waitFor(() => bobSocket.frames.some((f) => (f as { type?: string }).type === 'new_message'))
    expect(bobSocket.frames.find((f) => (f as { type?: string }).type === 'new_message')).toMatchObject({
      type: 'new_message',
      chat_id: sent.chat_id,
      event_seq: 1,
      message: { message_id: sent.message_id, text: 'вживую' }
    })

    await api('POST', `${M}/chats/${sent.chat_id}/action`, { ...as(alice), body: { type: 'upload_photo', progress: 0.5 } })
    await waitFor(() => bobSocket.frames.some((f) => (f as { type?: string }).type === 'typing'))
    const typing = bobSocket.frames.find((f) => (f as { type?: string }).type === 'typing') as Record<string, unknown>
    expect(typing).toEqual({ type: 'typing', chat_id: sent.chat_id, user_id: alice.id, action: 'upload_photo', progress: 0.5 })

    // presence: bob is online for his chat partner
    expect((await api('POST', `${M}/presence`, { ...as(alice), body: { user_ids: [bob.id] } })).body.presence[bob.id]).toBe(true)

    bobSocket.socket.send('ping')
    await waitFor(() => bobSocket.frames.includes('pong'))
    bobSocket.socket.close()
  })

  test('a bad token closes the socket with 4001', async () => {
    const bad = connect(null, 'not-a-token')
    expect(await bad.closed).toBe(4001)
  })
})
