import { and, arrayOverlaps, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { v7 as uuidv7 } from 'uuid'
import { config } from '../../config'
import { db } from '../../db/client'
import { chatHiddenMessages, chatMembers, chatMessages, chatReactions, chats, type ChatEntity } from '../../db/schema'
import { badRequest, conflict, forbidden } from '../../lib/errors'
import { authPlugin, type Me } from '../../plugins/auth'
import { currentSeq, emit, eventsSince, pushLive, type Delivery } from '../../services/messenger-events'
import { enforceActionLimit } from '../../services/rate-limit'
import { loadUserRecords } from '../../services/users'
import {
  assertCanMessage,
  catalogEmoji,
  chatSummary,
  checkAttachments,
  checkEntities,
  checkText,
  fileCategory,
  findOrCreateDirectChat,
  lastVisibleMessage,
  listChats,
  loadFiles,
  loadReactions,
  loadVisibleMessages,
  type MemberRow,
  type MessageRow,
  onlineOf,
  otherMemberId,
  presentFile,
  presentMessage,
  presentMessages,
  REACTIONS,
  requireChatPartner,
  requireMembership,
  requireVisibleMessage,
  unreadTotal,
  USER_MAX_REACTIONS,
  visibleTo
} from './service'
import { messengerUploadsModule } from './uploads'
import { messengerSocketModule } from './ws'

/*
 * The chats of the web client (route /chats), API-compatible with the official messenger under /api/v1/messenger.
 * Direct chats only. openitd has no subscription: everyone may write, subject to the recipient's
 * «who can message me» setting and blocks. Changes reach the members as events (see messenger-events).
 */

const Id = t.String({ format: 'uuid' })
const ChatParams = t.Object({ id: Id })
const MessageParams = t.Object({ id: Id, messageId: Id })
const MessageIds = t.Array(Id, { minItems: 1, maxItems: 100 })
const Entities = t.Optional(
  t.Nullable(
    t.Array(
      t.Object({
        type: t.String({ maxLength: 32 }),
        offset: t.Optional(t.Integer()),
        length: t.Optional(t.Integer()),
        url: t.Optional(t.String({ maxLength: 2048 })),
        post_id: t.Optional(t.String({ maxLength: 64 }))
      })
    )
  )
)
const SendBody = t.Object({
  client_message_id: t.Optional(Id),
  text: t.Optional(t.Nullable(t.String())),
  reply_to_id: t.Optional(t.Nullable(Id)),
  attachments: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 50 })),
  entities: Entities
})
const Paging = t.Object({
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
  before: t.Optional(t.String({ maxLength: 100 })),
  manual_unread: t.Optional(t.String())
})

const seqOf = (seqs: Map<string, number>, userId: string) => seqs.get(userId) ?? null

/** Stores a new message and tells both members; returns what the sender's request answers */
async function sendMessage(me: Me, chat: { id: string }, member: MemberRow, otherId: string, body: typeof SendBody.static) {
  await enforceActionLimit('message', me.id)

  if (body.client_message_id) {
    const [stored] = await db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.senderId, me.id), eq(chatMessages.clientMessageId, body.client_message_id)))
    if (stored) {
      if (stored.chatId !== chat.id) throw conflict('client_message_id is already used', 'CONFLICT')
      const view = await presentMessage(stored, me.id)
      return { ...view, chat_id: chat.id, replayed: true, event_seq: await currentSeq(me.id) }
    }
  }

  const text = checkText(body.text)
  const entities = checkEntities(body.entities as ChatEntity[] | null, text)
  const attachmentIds = await checkAttachments(me.id, body.attachments)
  if (!text && attachmentIds.length === 0) throw badRequest('Сообщение пустое', 'VALIDATION_ERROR')
  if (body.reply_to_id) await requireVisibleMessage(member, body.reply_to_id)
  await assertCanMessage(me, chat.id, otherId)

  const now = new Date()
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(chatMessages)
      .values({
        id: uuidv7(),
        chatId: chat.id,
        senderId: me.id,
        clientMessageId: body.client_message_id ?? null,
        text,
        entities,
        attachmentIds,
        replyToId: body.reply_to_id ?? null,
        createdAt: now
      })
      .returning()
    await tx.update(chats).set({ lastMessageId: inserted[0]!.id, lastMessageAt: now }).where(eq(chats.id, chat.id))
    // a member who deleted the chat gets it back with the new message
    await tx.update(chatMembers).set({ hiddenAt: null }).where(eq(chatMembers.chatId, chat.id))
    return inserted
  })

  const [mine, theirs] = await Promise.all([presentMessage(row!, me.id), presentMessage(row!, otherId)])
  const seqs = await emit([
    { userId: me.id, frame: { type: 'own_messages', chat_id: chat.id, messages: [mine] } },
    { userId: otherId, frame: { type: 'new_message', chat_id: chat.id, message: theirs } }
  ])
  return { ...mine, chat_id: chat.id, event_seq: seqOf(seqs, me.id) }
}

/** Both members get the edited message, each in their own view */
async function messageEvents(chat: { id: string; userLow: string; userHigh: string }, row: MessageRow, type: string) {
  const deliveries: Delivery[] = []
  for (const userId of [chat.userLow, chat.userHigh]) {
    deliveries.push({ userId, frame: { type, chat_id: chat.id, message_id: row.id, message: await presentMessage(row, userId) } })
  }
  return emit(deliveries)
}

async function reactionState(messageId: string, viewerId: string) {
  const [row] = await db.select({ version: chatMessages.reactionVersion }).from(chatMessages).where(eq(chatMessages.id, messageId))
  const reactions = (await loadReactions([messageId], viewerId)).get(messageId) ?? []
  return { reaction_version: String(row?.version ?? 0), reactions }
}

/** Messages of a page in the client's order: newest first */
async function messagePage(member: MemberRow, limit: number, filter?: ReturnType<typeof sql>) {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(visibleTo(member), filter))
    .orderBy(desc(chatMessages.id))
    .limit(limit + 1)
  return { rows: rows.slice(0, limit), more: rows.length > limit }
}

async function readCursors(chatId: string, userId: string) {
  const members = await db.select().from(chatMembers).where(eq(chatMembers.chatId, chatId))
  const cursor = (m: MemberRow) => (m.lastReadId ? { message_id: m.lastReadId, timestamp: m.lastReadAt?.toISOString() ?? null } : null)
  const others = Object.fromEntries(members.filter((m) => m.userId !== userId && m.lastReadId).map((m) => [m.userId, cursor(m)]))
  const mine = members.find((m) => m.userId === userId)
  return { read_cursors: others, my_last_read: mine ? cursor(mine) : null }
}

async function chatMemberIds(chatId: string) {
  const rows = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chatId))
  return rows.map((r) => r.userId)
}

const api = new Elysia({ prefix: '/v1/messenger', tags: ['Messenger'] })
  .use(authPlugin)

  // ---- chats

  .get(
    '/chats',
    async ({ query, me }) => ({ ...(await listChats(me.id, query.limit ?? 30, query.before)), event_seq: await currentSeq(me.id) }),
    { user: true, query: Paging, detail: { summary: 'My chats, newest activity first' } }
  )

  .get('/chats/unread', async ({ me }) => ({ total: await unreadTotal(me.id) }), {
    user: true,
    query: t.Object({ manual_unread: t.Optional(t.String()) }),
    detail: { summary: 'Unread badge' }
  })

  .post(
    '/chats/dm',
    async ({ body, me }) => {
      await requireChatPartner(me, body.target_user_id)
      await enforceActionLimit('chat', me.id)
      const { chat } = await findOrCreateDirectChat(me.id, body.target_user_id)
      await db
        .update(chatMembers)
        .set({ hiddenAt: null })
        .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, me.id)))
      return { chat_id: chat.id }
    },
    { user: true, body: t.Object({ target_user_id: Id }), detail: { summary: 'Open (or create) the direct chat with a user' } }
  )

  .get('/chats/:id', async ({ params, me }) => chatSummary(me.id, (await requireMembership(params.id, me.id)).chat.id), {
    user: true,
    params: ChatParams,
    query: t.Object({ manual_unread: t.Optional(t.String()) }),
    detail: { summary: 'One chat' }
  })

  .patch(
    '/chats/:id/pin',
    async ({ params, body, me }) => {
      await requireMembership(params.id, me.id)
      await db.update(chatMembers).set({ isPinned: body.is_pinned }).where(and(eq(chatMembers.chatId, params.id), eq(chatMembers.userId, me.id)))
      const seqs = await emit([{ userId: me.id, frame: { type: 'chat_settings', chat_id: params.id, is_pinned: body.is_pinned } }])
      return { success: true, event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ is_pinned: t.Boolean() }) }
  )

  .patch(
    '/chats/:id/mute',
    async ({ params, body, me }) => {
      await requireMembership(params.id, me.id)
      await db.update(chatMembers).set({ isMuted: body.is_muted }).where(and(eq(chatMembers.chatId, params.id), eq(chatMembers.userId, me.id)))
      const seqs = await emit([{ userId: me.id, frame: { type: 'chat_settings', chat_id: params.id, is_muted: body.is_muted } }])
      return { success: true, event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ is_muted: t.Boolean() }) }
  )

  .patch(
    '/chats/:id/unread',
    async ({ params, body, me }) => {
      await requireMembership(params.id, me.id)
      await db.update(chatMembers).set({ markedUnread: body.unread }).where(and(eq(chatMembers.chatId, params.id), eq(chatMembers.userId, me.id)))
      const seqs = await emit([{ userId: me.id, frame: { type: 'chat_settings', chat_id: params.id, marked_unread: body.unread } }])
      return { success: true, event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ unread: t.Boolean() }) }
  )

  // there are no message requests here: every chat is accepted
  .post('/chats/:id/accept', async ({ params, me }) => (await requireMembership(params.id, me.id), { success: true }), {
    user: true,
    params: ChatParams
  })

  .post(
    '/chats/:id/read',
    async ({ params, body, me }) => {
      const { chat, member } = await requireMembership(params.id, me.id)
      const message = await requireVisibleMessage(member, body.last_read_message)
      // the cursor never moves back
      const [updated] = await db
        .update(chatMembers)
        .set({
          lastReadId: sql`greatest(${chatMembers.lastReadId}, ${message.id}::uuid)`,
          lastReadAt: new Date(),
          markedUnread: false
        })
        .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, me.id)))
        .returning({ lastReadId: chatMembers.lastReadId })
      const frame = { type: 'messages_read', chat_id: chat.id, user_id: me.id, last_read_message: updated!.lastReadId }
      const seqs = await emit((await chatMemberIds(chat.id)).map((userId) => ({ userId, frame })))
      return { success: true, event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ last_read_message: Id }) }
  )

  .post(
    '/chats/:id/action',
    async ({ params, body, me }) => {
      const { chat } = await requireMembership(params.id, me.id)
      const progress = typeof body.progress === 'number' ? Math.min(1, Math.max(0, body.progress)) : undefined
      await pushLive(otherMemberId(chat, me.id), {
        type: 'typing',
        chat_id: chat.id,
        user_id: me.id,
        action: body.type,
        ...(progress !== undefined ? { progress } : {})
      })
      return { success: true }
    },
    {
      user: true,
      params: ChatParams,
      body: t.Object({
        type: t.Union(['typing', 'record_voice', 'record_video', 'upload_photo', 'upload_video', 'upload_voice', 'upload_document'].map((v) => t.Literal(v))),
        progress: t.Optional(t.Number())
      }),
      detail: { summary: 'Typing (and uploading) indicator for the other member' }
    }
  )

  .post(
    '/chats/:id/clear-history',
    async ({ params, me }) => clearHistory(me, params.id, false),
    { user: true, params: ChatParams, detail: { summary: 'Clear the history for me' } }
  )
  .post(
    '/chats/:id/clear-history-all',
    async ({ params, me }) => clearHistory(me, params.id, true),
    { user: true, params: ChatParams, detail: { summary: 'Clear the history for both members' } }
  )

  .post(
    '/chats/:id/delete',
    async ({ params, body, me }) => {
      const { chat } = await requireMembership(params.id, me.id)
      const targets = body.for_everyone ? [chat.userLow, chat.userHigh] : [me.id]
      await db
        .update(chatMembers)
        .set({ hiddenAt: new Date(), clearedBeforeId: chat.lastMessageId, markedUnread: false, isPinned: false })
        .where(and(eq(chatMembers.chatId, chat.id), inArray(chatMembers.userId, targets)))
      const seqs = await emit(targets.map((userId) => ({ userId, frame: { type: 'chat_deleted', chat_id: chat.id } })))
      return { success: true, event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ for_everyone: t.Optional(t.Boolean()) }) }
  )

  // ---- messages

  .get(
    '/chats/:id/messages',
    async ({ params, query, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      const limit = query.limit ?? 40
      if (query.before && !/^[0-9a-f-]{36}$/i.test(query.before)) throw badRequest('Invalid cursor', 'VALIDATION_ERROR')
      const page = await messagePage(member, limit, query.before ? sql`${chatMessages.id} < ${query.before}::uuid` : undefined)
      return {
        messages: await presentMessages(page.rows, me.id),
        has_older: page.more,
        has_newer: false,
        ...(await readCursors(params.id, me.id)),
        event_seq: await currentSeq(me.id)
      }
    },
    { user: true, params: ChatParams, query: Paging, detail: { summary: 'Messages, newest first; `before` pages to older ones' } }
  )

  .get(
    '/chats/:id/messages/around/:messageId',
    async ({ params, query, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      const target = await requireVisibleMessage(member, params.messageId)
      const half = Math.max(1, Math.floor((query.limit ?? 40) / 2))
      const older = await messagePage(member, half, sql`${chatMessages.id} <= ${target.id}::uuid`)
      const newerRows = await db
        .select()
        .from(chatMessages)
        .where(and(visibleTo(member), gt(chatMessages.id, target.id)))
        .orderBy(chatMessages.id)
        .limit(half + 1)
      const newer = newerRows.slice(0, half).reverse()
      return {
        messages: await presentMessages([...newer, ...older.rows], me.id),
        has_older: older.more,
        has_newer: newerRows.length > half,
        ...(await readCursors(params.id, me.id)),
        event_seq: await currentSeq(me.id)
      }
    },
    {
      user: true,
      params: MessageParams,
      query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 2, maximum: 100 })) }),
      detail: { summary: 'A window of messages around one (jump to a reply, the first unread)' }
    }
  )

  .post(
    '/chats/:id/messages',
    async ({ params, body, me }) => {
      const { chat, member } = await requireMembership(params.id, me.id)
      return sendMessage(me, chat, member, otherMemberId(chat, me.id), body)
    },
    { user: true, params: ChatParams, body: SendBody, detail: { summary: 'Send a message' } }
  )

  .post(
    '/users/:id/messages',
    async ({ params, body, me }) => {
      await assertCanMessage(me, null, params.id)
      const { chat, created } = await findOrCreateDirectChat(me.id, params.id)
      if (created) await enforceActionLimit('chat', me.id)
      const { member } = await requireMembership(chat.id, me.id)
      const sent = await sendMessage(me, chat, member, params.id, body)
      // presence is pushed to chat partners: two people who just became partners learn each other's state now
      if (created) await exchangePresence(me.id, params.id)
      return sent
    },
    { user: true, params: ChatParams, body: SendBody, detail: { summary: 'Write to a user (opens the chat with the first message)' } }
  )

  .patch(
    '/chats/:id/messages/:messageId',
    async ({ params, body, me }) => {
      const { chat, member } = await requireMembership(params.id, me.id)
      const message = await requireVisibleMessage(member, params.messageId)
      if (message.senderId !== me.id) throw forbidden('Нельзя редактировать чужое сообщение', 'FORBIDDEN')
      if (message.forwardedFromMsg) throw forbidden('forwarded_message_read_only', 'FORBIDDEN')
      if (Date.now() - message.createdAt.getTime() > config.messenger.editWindowHours * 60 * 60 * 1000) {
        throw forbidden('edit window expired', 'FORBIDDEN')
      }
      const text = checkText(body.text)
      if (!text && message.attachmentIds.length === 0) throw badRequest('Сообщение пустое', 'VALIDATION_ERROR')
      const entities = checkEntities(body.entities as ChatEntity[] | null, text)
      const [row] = await db
        .update(chatMessages)
        .set({ text, entities, editedAt: new Date() })
        .where(eq(chatMessages.id, message.id))
        .returning()
      const seqs = await messageEvents(chat, row!, 'message_edited')
      return { message_id: row!.id, edited_at: row!.editedAt!.toISOString(), text: row!.text, entities: row!.entities ?? null, event_seq: seqOf(seqs, me.id) }
    },
    {
      user: true,
      params: MessageParams,
      body: t.Object({ text: t.Optional(t.Nullable(t.String())), entities: Entities, attachments: t.Optional(t.Array(t.String())) }),
      detail: { summary: 'Edit my message (text and formatting)' }
    }
  )

  .post(
    '/chats/:id/messages/delete-for-me',
    async ({ params, body, me }) => {
      const { chat, member } = await requireMembership(params.id, me.id)
      const found = await loadVisibleMessages(member, body.message_ids)
      const ok = found.map((m) => m.id)
      if (ok.length) await db.insert(chatHiddenMessages).values(ok.map((messageId) => ({ userId: me.id, messageId }))).onConflictDoNothing()
      const seqs = ok.length
        ? await emit([
            {
              userId: me.id,
              frame: { type: 'messages_deleted', chat_id: chat.id, message_ids: ok, new_last_message: await lastVisibleMessage(member) }
            }
          ])
        : new Map()
      return { ok, failed: body.message_ids.filter((id) => !ok.includes(id)), event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ message_ids: MessageIds }) }
  )

  .post(
    '/chats/:id/messages/delete-for-all',
    async ({ params, body, me }) => {
      const { chat, member } = await requireMembership(params.id, me.id)
      // only one's own messages are deleted for both
      const found = (await loadVisibleMessages(member, body.message_ids)).filter((m) => m.senderId === me.id)
      const ok = found.map((m) => m.id)
      let seqs = new Map<string, number>()
      if (ok.length) {
        await db.update(chatMessages).set({ deletedAt: new Date() }).where(inArray(chatMessages.id, ok))
        const members = await db.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id))
        const deliveries: Delivery[] = []
        for (const m of members) {
          deliveries.push({
            userId: m.userId,
            frame: { type: 'messages_deleted', chat_id: chat.id, message_ids: ok, new_last_message: await lastVisibleMessage(m) }
          })
        }
        seqs = await emit(deliveries)
      }
      return { ok, failed: body.message_ids.filter((id) => !ok.includes(id)), event_seq: seqOf(seqs, me.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ message_ids: MessageIds }) }
  )

  .post(
    '/chats/:id/messages/forward',
    async ({ params, body, me }) => {
      await enforceActionLimit('message', me.id)
      const { chat: target } = await requireMembership(params.id, me.id)
      const { member: source } = await requireMembership(body.source_chat_id, me.id)
      const otherId = otherMemberId(target, me.id)
      await assertCanMessage(me, target.id, otherId)

      const found = new Map((await loadVisibleMessages(source, body.message_ids)).map((m) => [m.id, m]))
      const senders = await loadUserRecords([...found.values()].map((m) => m.senderId))
      const ok: { source_message_id: string; message_id: string }[] = []
      const failed: { source_message_id: string; error: string }[] = []
      const created: MessageRow[] = []
      const clientIds: Record<string, string> = body.client_message_ids ?? {}

      for (const sourceId of body.message_ids) {
        const original = found.get(sourceId)
        if (!original) {
          failed.push({ source_message_id: sourceId, error: 'not_found' })
          continue
        }
        const clientId = clientIds[sourceId]
        if (clientId) {
          const [stored] = await db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(and(eq(chatMessages.senderId, me.id), eq(chatMessages.clientMessageId, clientId)))
          if (stored) {
            ok.push({ source_message_id: sourceId, message_id: stored.id })
            continue
          }
        }
        // a forwarded copy keeps pointing at the first author
        const origin = original.forwardedFromMsg
          ? { chat: original.forwardedFromChat, msg: original.forwardedFromMsg, sender: original.forwardedFromSenderId, name: original.forwardedFromName }
          : { chat: original.chatId, msg: original.id, sender: original.senderId, name: senders.get(original.senderId)?.displayName ?? null }
        const now = new Date()
        const [row] = await db
          .insert(chatMessages)
          .values({
            id: uuidv7(),
            chatId: target.id,
            senderId: me.id,
            clientMessageId: clientId ?? null,
            text: original.text,
            entities: original.entities,
            attachmentIds: original.attachmentIds,
            forwardedFromChat: origin.chat,
            forwardedFromMsg: origin.msg,
            forwardedFromSenderId: origin.sender,
            forwardedFromName: origin.name,
            createdAt: now
          })
          .returning()
        created.push(row!)
        ok.push({ source_message_id: sourceId, message_id: row!.id })
      }

      let seqs = new Map<string, number>()
      if (created.length) {
        const last = created.at(-1)!
        await db.update(chats).set({ lastMessageId: last.id, lastMessageAt: last.createdAt }).where(eq(chats.id, target.id))
        await db.update(chatMembers).set({ hiddenAt: null }).where(eq(chatMembers.chatId, target.id))
        seqs = await emit([
          { userId: me.id, frame: { type: 'own_messages', chat_id: target.id, messages: await presentMessages(created, me.id) } },
          { userId: otherId, frame: { type: 'new_messages', chat_id: target.id, messages: await presentMessages(created, otherId) } }
        ])
      }
      return { ok, failed, event_seq: seqOf(seqs, me.id) }
    },
    {
      user: true,
      params: ChatParams,
      body: t.Object({
        source_chat_id: Id,
        message_ids: MessageIds,
        client_message_ids: t.Optional(t.Record(t.String(), Id))
      }),
      detail: { summary: 'Forward messages of another chat here' }
    }
  )

  // ---- reactions

  .get('/reactions/available', () => ({ reactions: REACTIONS.map((r) => ({ type: 'emoji', ...r })), user_max: USER_MAX_REACTIONS }), {
    user: true
  })

  .get(
    '/chats/:id/messages/:messageId/reactions',
    async ({ params, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      const message = await requireVisibleMessage(member, params.messageId)
      return reactionState(message.id, me.id)
    },
    { user: true, params: MessageParams }
  )

  .put(
    '/chats/:id/messages/:messageId/reactions',
    async ({ params, body, me }) => {
      const { chat, member } = await requireMembership(params.id, me.id)
      const message = await requireVisibleMessage(member, params.messageId)
      const emojis = [...new Set(body.reactions.map((r) => (r.type === 'emoji' && r.emoji ? catalogEmoji(r.emoji) : null)))]
      if (emojis.some((e) => !e)) throw badRequest('Такой реакции нет', 'VALIDATION_ERROR')
      if (emojis.length > USER_MAX_REACTIONS) throw badRequest(`Не больше ${USER_MAX_REACTIONS} реакций`, 'VALIDATION_ERROR')

      const applied = await db.transaction(async (tx) => {
        // the version check and the change are one step: a stale client gets 409 and reloads
        const [bumped] = await tx
          .update(chatMessages)
          .set({ reactionVersion: sql`${chatMessages.reactionVersion} + 1` })
          .where(
            and(
              eq(chatMessages.id, message.id),
              body.expected_version !== undefined ? eq(chatMessages.reactionVersion, Number(body.expected_version)) : undefined
            )
          )
          .returning({ version: chatMessages.reactionVersion })
        if (!bumped) return false
        await tx.delete(chatReactions).where(and(eq(chatReactions.messageId, message.id), eq(chatReactions.userId, me.id)))
        if (emojis.length) await tx.insert(chatReactions).values(emojis.map((emoji) => ({ messageId: message.id, userId: me.id, emoji: emoji! })))
        return true
      })
      if (!applied) throw conflict('Реакции изменились', 'VERSION_CONFLICT')

      const deliveries: Delivery[] = []
      for (const userId of [chat.userLow, chat.userHigh]) {
        const state = await reactionState(message.id, userId)
        deliveries.push({
          userId,
          frame: {
            type: 'message_reactions',
            chat_id: chat.id,
            message_id: message.id,
            ...state,
            by: me.id,
            by_reactions: emojis.map((emoji) => ({ type: 'emoji', emoji })),
            my_reactions: state.reactions.filter((r) => r.chosen).map((r) => r.reaction)
          }
        })
      }
      await emit(deliveries)
      return reactionState(message.id, me.id)
    },
    {
      user: true,
      params: MessageParams,
      body: t.Object({
        reactions: t.Array(t.Object({ type: t.String({ maxLength: 16 }), emoji: t.Optional(t.String({ maxLength: 32 })) }), { maxItems: 10 }),
        expected_version: t.Optional(t.String({ pattern: '^[0-9]{1,15}$' })),
        operation_id: t.Optional(t.String({ maxLength: 64 }))
      }),
      detail: { summary: 'Set my reactions on a message' }
    }
  )

  // ---- voice messages, media, file links

  .post(
    '/chats/:id/messages/:messageId/heard',
    async ({ params, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      const message = await requireVisibleMessage(member, params.messageId)
      if (message.senderId !== me.id && !message.heardAt) {
        await db.update(chatMessages).set({ heardAt: new Date() }).where(eq(chatMessages.id, message.id))
      }
      return { success: true }
    },
    { user: true, params: MessageParams }
  )

  .post(
    '/chats/:id/heard',
    async ({ params, body, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      const rows = await loadVisibleMessages(member, body.message_ids)
      return { heard: rows.filter((m) => m.heardAt).map((m) => m.id) }
    },
    { user: true, params: ChatParams, body: t.Object({ message_ids: MessageIds }) }
  )

  .get(
    '/chats/:id/media',
    async ({ params, query, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      const limit = query.limit ?? 40
      const items: { message_id: string; file: ReturnType<typeof presentFile> }[] = []
      let before = query.before && /^[0-9a-f-]{36}$/i.test(query.before) ? query.before : null
      let nextBefore: string | null = null
      // scan messages with attachments, newest first, until the page is full
      for (let round = 0; round < 20 && items.length < limit; round++) {
        const rows = await db
          .select()
          .from(chatMessages)
          .where(and(visibleTo(member), sql`cardinality(${chatMessages.attachmentIds}) > 0`, before ? sql`${chatMessages.id} < ${before}::uuid` : undefined))
          .orderBy(desc(chatMessages.id))
          .limit(100)
        if (rows.length === 0) {
          nextBefore = null
          break
        }
        const files = await loadFiles(rows.flatMap((r) => r.attachmentIds))
        for (const row of rows) {
          for (const id of row.attachmentIds) {
            const file = files.get(id)
            if (file && fileCategory(file) === query.category) items.push({ message_id: row.id, file: presentFile(file) })
          }
          before = row.id
          if (items.length >= limit) break
        }
        nextBefore = rows.length === 100 || items.length >= limit ? before : null
        if (rows.length < 100) break
      }
      return { items, next_before: nextBefore }
    },
    {
      user: true,
      params: ChatParams,
      query: t.Object({
        category: t.Numeric({ minimum: 0, maximum: 3 }),
        before: t.Optional(t.String({ maxLength: 64 })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 }))
      }),
      detail: { summary: 'Media of the chat: 0 photos and videos, 1 files, 2 music, 3 voice' }
    }
  )

  .post(
    '/chats/:id/file-links',
    async ({ params, body, me }) => {
      const { member } = await requireMembership(params.id, me.id)
      if (body.file_ids.length === 0) return { links: [] }
      // only files of messages the member can see
      const rows = await db
        .select({ ids: chatMessages.attachmentIds })
        .from(chatMessages)
        .where(and(visibleTo(member), arrayOverlaps(chatMessages.attachmentIds, body.file_ids)))
      const allowed = new Set(rows.flatMap((r) => r.ids))
      const files = await loadFiles(body.file_ids.filter((id) => allowed.has(id)))
      return { links: [...files.values()].map((f) => ({ fileId: f.id, url: f.url, thumbUrl: f.thumbUrl, expiresIn: presentFile(f).expiresIn })) }
    },
    { user: true, params: ChatParams, body: t.Object({ file_ids: t.Array(Id, { maxItems: 100 }) }) }
  )

  // ---- presence and missed events

  .get('/presence/:id', async ({ params }) => ({ online: (await onlineOf([params.id])).get(params.id) ?? false }), {
    user: true,
    params: ChatParams
  })

  .post(
    '/presence',
    async ({ body }) => {
      const online = await onlineOf(body.user_ids)
      return { presence: Object.fromEntries(body.user_ids.map((id) => [id, online.get(id) ?? false])) }
    },
    { user: true, body: t.Object({ user_ids: t.Array(Id, { maxItems: 256 }) }) }
  )

  .get('/updates', async ({ query, me }) => eventsSince(me.id, query.since, query.limit ?? 100), {
    user: true,
    query: t.Object({
      since: t.Numeric({ minimum: 0 }),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })),
      capabilities: t.Optional(t.String()),
      manual_unread: t.Optional(t.String())
    }),
    detail: { summary: 'Events after `since` (what the WebSocket pushed while the client was away)' }
  })

  // the official site serves chat files behind a short cookie session; here files are plain links
  .post('/browser-file-session', ({ set }) => {
    set.status = 204
    set.headers['x-file-session-max-age'] = '120'
  })

  .use(messengerUploadsModule)
  .use(messengerSocketModule)

async function exchangePresence(a: string, b: string) {
  const online = await onlineOf([a, b])
  await Promise.all([
    pushLive(a, { type: 'presence', user_id: b, online: online.get(b) ?? false }),
    pushLive(b, { type: 'presence', user_id: a, online: online.get(a) ?? false })
  ])
}

async function clearHistory(me: Me, chatId: string, forBoth: boolean) {
  const { chat } = await requireMembership(chatId, me.id)
  const targets = forBoth ? [chat.userLow, chat.userHigh] : [me.id]
  await db
    .update(chatMembers)
    .set({ clearedBeforeId: chat.lastMessageId, markedUnread: false })
    .where(and(eq(chatMembers.chatId, chat.id), inArray(chatMembers.userId, targets)))
  const seqs = await emit(targets.map((userId) => ({ userId, frame: { type: 'history_cleared', chat_id: chat.id } })))
  return { success: true, event_seq: seqOf(seqs, me.id) }
}

export const messengerModule = new Elysia({ tags: ['Messenger'] })
  .use(authPlugin)
  // the chats page reports that it was opened (the official site tracks it for the subscription offer)
  .post('/messenger/entry', () => ({ success: true }), { user: true })
  .use(api)

