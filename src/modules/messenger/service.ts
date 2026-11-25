import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { config } from '../../config'
import { db } from '../../db/client'
import { chatFiles, chatHiddenMessages, chatMembers, chatMessages, chatReactions, chats, type ChatEntity, users } from '../../db/schema'
import { ApiError, badRequest, forbidden, notFound } from '../../lib/errors'
import { getPresence } from '../../services/presence'
import { hasAccess, loadRelation, loadUserRecords, type UserRecord } from '../../services/users'

export type ChatRow = typeof chats.$inferSelect
export type MemberRow = typeof chatMembers.$inferSelect
export type MessageRow = typeof chatMessages.$inferSelect
export type FileRow = typeof chatFiles.$inferSelect

// how long the client may cache a file link; files are public links here, so it is long
const LINK_TTL_SECONDS = 24 * 60 * 60
export const USER_MAX_REACTIONS = 3

// the reactions the web client has pictures for, in its order (its picker shows only these)
export const REACTIONS: { emoji: string; title: string }[] = (
  [
    ['🙂', 'Улыбка'], ['😭', 'Рыдаю'], ['😂', 'Смеюсь до слёз'], ['😁', 'Смешно'], ['😊', 'Радуюсь'], ['🥹', 'Тронут'],
    ['🥺', 'Пожалуйста'], ['😔', 'Печально'], ['😢', 'Грустно'], ['🤔', 'Думаю'], ['😐', 'Без эмоций'], ['🫤', 'Сомневаюсь'],
    ['😎', 'Крутой'], ['😏', 'Ухмыляюсь'], ['🤓', 'Умник'], ['😇', 'Невиновен'], ['😋', 'Вкусно'], ['🙄', 'Закатываю глаза'],
    ['😶‍🌫️', 'В облаках'], ['🫣', 'Подглядываю'], ['🤪', 'Дурачусь'], ['😍', 'Обожаю'], ['🥰', 'Влюблён'], ['😘', 'Целую'],
    ['🥳', 'Веселюсь'], ['🤮', 'Тошнит'], ['😱', 'В ужасе'], ['🤩', 'Восторг'], ['🤡', 'Клоун'], ['😡', 'Злюсь'],
    ['😈', 'Дьявол'], ['🫡', 'Честь'], ['🤯', 'Взрыв мозга'], ['❤️', 'Сердце'], ['💔', 'Разбитое сердце'], ['❤️‍🔥', 'Пылающее сердце'],
    ['🔥', 'Огонь'], ['💀', 'Череп'], ['👀', 'Смотрю'], ['💩', 'Какашка'], ['🤷', 'Не знаю'], ['👍', 'Нравится'],
    ['👎', 'Не нравится'], ['👌', 'Окей'], ['🤝', 'Согласен'], ['🖕', 'Средний палец'], ['🙏', 'Спасибо'], ['👋', 'Привет'],
    ['⚡', 'Молния'], ['💥', 'Взрыв'], ['💯', 'Сто из ста'], ['💋', 'Поцелуй'], ['🎉', 'Праздник'], ['🏆', 'Кубок'],
    ['📝', 'Пишу']
  ] as [string, string][]
).map(([emoji, title]) => ({ emoji, title }))

/** The client compares reactions without variation selectors */
export const reactionKey = (emoji: string) => emoji.normalize('NFC').replace(/️/g, '')
const CATALOG = new Map(REACTIONS.map((r) => [reactionKey(r.emoji), r.emoji]))
export const catalogEmoji = (emoji: string) => CATALOG.get(reactionKey(emoji)) ?? null

export const messengerError = (status: number, message: string, code: string | null = null) => new ApiError(status, code, message)
export const chatNotFound = () => notFound('Чат не найден', 'NOT_FOUND')
export const messageNotFound = () => notFound('Сообщение не найдено', 'NOT_FOUND')

// ---- membership and visibility

export async function loadMembership(chatId: string, userId: string) {
  const [row] = await db
    .select({ chat: chats, member: chatMembers })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.id, chatMembers.chatId))
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
  return row ?? null
}

/** The chat as seen by its member; 404 for anyone else */
export async function requireMembership(chatId: string, userId: string) {
  const row = await loadMembership(chatId, userId)
  if (!row) throw chatNotFound()
  return row
}

export const otherMemberId = (chat: ChatRow, userId: string) => (chat.userLow === userId ? chat.userHigh : chat.userLow)

/** Messages of the chat the member can see: not deleted, not hidden by them, after their cleared history */
export function visibleTo(member: MemberRow): SQL {
  return and(
    eq(chatMessages.chatId, member.chatId),
    isNull(chatMessages.deletedAt),
    member.clearedBeforeId ? sql`${chatMessages.id} > ${member.clearedBeforeId}` : undefined,
    sql`not exists (select 1 from ${chatHiddenMessages} h where h.user_id = ${member.userId} and h.message_id = ${chatMessages.id})`
  )!
}

export async function loadVisibleMessages(member: MemberRow, ids: string[]) {
  if (ids.length === 0) return []
  return db
    .select()
    .from(chatMessages)
    .where(and(visibleTo(member), inArray(chatMessages.id, ids)))
}

export async function requireVisibleMessage(member: MemberRow, messageId: string) {
  const [row] = await loadVisibleMessages(member, [messageId])
  if (!row) throw messageNotFound()
  return row
}

/** Finds the direct chat of two users, creating it (and both memberships) when there is none */
export async function findOrCreateDirectChat(userId: string, otherId: string) {
  const [low, high] = [userId, otherId].sort() as [string, string]
  const existing = await db.select().from(chats).where(and(eq(chats.userLow, low), eq(chats.userHigh, high)))
  if (existing[0]) return { chat: existing[0], created: false }
  return db.transaction(async (tx) => {
    const [chat] = await tx.insert(chats).values({ userLow: low, userHigh: high, createdBy: userId }).onConflictDoNothing().returning()
    if (!chat) {
      const [raced] = await tx.select().from(chats).where(and(eq(chats.userLow, low), eq(chats.userHigh, high)))
      return { chat: raced!, created: false }
    }
    await tx.insert(chatMembers).values([
      { chatId: chat.id, userId: low },
      { chatId: chat.id, userId: high }
    ])
    return { chat, created: true }
  })
}

/** A user one can open a chat with: exists, active, not blocked either way */
export async function requireChatPartner(me: { id: string }, otherId: string) {
  if (otherId === me.id) throw badRequest('Нельзя написать самому себе')
  const [other] = (await loadUserRecords([otherId])).values()
  if (!other || other.deletedAt || other.isBanned) throw notFound('Пользователь не найден', 'NOT_FOUND')
  const relation = await loadRelation(me.id, other.id)
  if (relation.blockedAt || relation.blockedBy) throw forbidden('Действие недоступно из-за блокировки', 'BLOCKED')
  return { other, relation }
}

/** May `me` send to `other` here: their «who can message me» setting, or they already wrote in this chat */
export async function assertCanMessage(me: { id: string }, chatId: string | null, otherId: string) {
  const { other, relation } = await requireChatPartner(me, otherId)
  if (hasAccess(other.messageAccess, relation, false)) return other
  if (chatId) {
    const [wrote] = await db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.chatId, chatId), eq(chatMessages.senderId, otherId)))
      .limit(1)
    if (wrote) return other
  }
  throw forbidden('Пользователь ограничил отправку сообщений', 'MESSAGES_CLOSED')
}

// ---- files

export async function loadFiles(ids: string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map<string, FileRow>()
  const rows = await db.select().from(chatFiles).where(inArray(chatFiles.id, unique))
  return new Map(rows.map((f) => [f.id, f]))
}

export function presentFile(file: FileRow) {
  return {
    fileId: file.id,
    url: file.url,
    filename: file.filename,
    mime: file.mime,
    thumbUrl: file.thumbUrl,
    thumbhash: file.thumbhash,
    waveform: file.waveform,
    sizePlain: file.size,
    width: file.width,
    height: file.height,
    durationMs: file.durationMs,
    expiresIn: LINK_TTL_SECONDS,
    thumbWidth: file.thumbWidth,
    thumbHeight: file.thumbHeight
  }
}

/** The client's media tabs: 0 photos and videos, 1 files, 2 music, 3 voice messages */
export function fileCategory(file: Pick<FileRow, 'mime' | 'waveform'>) {
  if (file.mime.startsWith('image/') || file.mime.startsWith('video/')) return 0
  if (file.mime.startsWith('audio/')) return file.waveform ? 3 : 2
  return 1
}

function attachmentKind(files: FileRow[]) {
  const kinds = new Set(
    files.map((f) =>
      f.mime.startsWith('image/') ? 'photo' : f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('audio/') ? (f.waveform ? 'voice' : 'music') : 'file'
    )
  )
  return kinds.size === 0 ? null : kinds.size === 1 ? [...kinds][0]! : 'mixed'
}

// ---- messages

/** Messages in the client's format, as `viewerId` sees them (their own reactions are `chosen`) */
export async function presentMessages(rows: MessageRow[], viewerId: string) {
  if (rows.length === 0) return []
  const replyIds = rows.map((r) => r.replyToId).filter((id): id is string => !!id)
  const replies = replyIds.length ? await db.select().from(chatMessages).where(inArray(chatMessages.id, replyIds)) : []
  const files = await loadFiles(rows.flatMap((r) => r.attachmentIds))
  const people = await loadUserRecords([...new Set(replies.map((r) => r.senderId))])
  const reactions = await loadReactions(
    rows.map((r) => r.id),
    viewerId
  )
  const replyById = new Map(replies.map((r) => [r.id, r]))

  return rows.map((row) => {
    const reply = row.replyToId ? replyById.get(row.replyToId) : undefined
    return {
      message_id: row.id,
      sender_id: row.senderId,
      created_at: row.createdAt.toISOString(),
      text: row.text,
      entities: row.entities ?? null,
      attachments: row.attachmentIds.map((id) => files.get(id)).filter((f): f is FileRow => !!f).map(presentFile),
      reactions: reactions.get(row.id) ?? [],
      reaction_version: String(row.reactionVersion),
      reply_to: reply
        ? {
            message_id: reply.id,
            sender_id: reply.senderId,
            text: reply.deletedAt ? null : reply.text,
            sender_name: people.get(reply.senderId)?.displayName ?? null
          }
        : null,
      is_deleted: false,
      forwarded_from_chat: row.forwardedFromChat,
      forwarded_from_msg: row.forwardedFromMsg,
      forwarded_from_sender_id: row.forwardedFromSenderId,
      forwarded_from_name: row.forwardedFromName,
      edited_at: row.editedAt?.toISOString() ?? null,
      ...(row.senderId === viewerId && row.clientMessageId ? { client_message_id: row.clientMessageId } : {})
    }
  })
}

export async function presentMessage(row: MessageRow, viewerId: string) {
  return (await presentMessages([row], viewerId))[0]!
}

type ReactionView = { reaction: { type: 'emoji'; emoji: string }; count: number; chosen: boolean }

export async function loadReactions(messageIds: string[], viewerId: string) {
  const result = new Map<string, ReactionView[]>()
  if (messageIds.length === 0) return result
  const rows = await db
    .select({
      messageId: chatReactions.messageId,
      emoji: chatReactions.emoji,
      count: sql<number>`count(*)::int`,
      chosen: sql<boolean>`bool_or(${chatReactions.userId} = ${viewerId})`,
      first: sql<Date>`min(${chatReactions.createdAt})`
    })
    .from(chatReactions)
    .where(inArray(chatReactions.messageId, messageIds))
    .groupBy(chatReactions.messageId, chatReactions.emoji)
    .orderBy(sql`min(${chatReactions.createdAt})`)
  for (const row of rows) {
    const list = result.get(row.messageId) ?? []
    list.push({ reaction: { type: 'emoji', emoji: row.emoji }, count: row.count, chosen: row.chosen })
    result.set(row.messageId, list)
  }
  return result
}

/** The chat list's preview of a message */
export function lastMessagePreview(row: MessageRow, files: Map<string, FileRow>) {
  const attached = row.attachmentIds.map((id) => files.get(id)).filter((f): f is FileRow => !!f)
  return {
    id: row.id,
    text: row.text,
    sender_id: row.senderId,
    at: row.createdAt.toISOString(),
    attachment_kind: attachmentKind(attached),
    attachment_filename: attached[0]?.filename ?? null,
    attachment_count: attached.length
  }
}

/** The member's newest visible message, for the chat list (null when there is none) */
export async function lastVisibleMessage(member: MemberRow) {
  const [row] = await db.select().from(chatMessages).where(visibleTo(member)).orderBy(desc(chatMessages.id)).limit(1)
  if (!row) return null
  return lastMessagePreview(row, await loadFiles(row.attachmentIds))
}

// ---- chats

type SummaryRow = {
  chat_id: string
  activity: Date
  is_pinned: boolean
  is_muted: boolean
  marked_unread: boolean
  other_id: string
  other_read_id: string | null
  unread: number
  last_id: string | null
}

/** Chat summaries in the client's format; `where` narrows the member's chats */
async function querySummaries(userId: string, where: SQL, limit: number) {
  const rows = await db.execute<SummaryRow>(sql`
    select c.id as chat_id, coalesce(c.last_message_at, c.created_at) as activity,
      m.is_pinned, m.is_muted, m.marked_unread, o.user_id as other_id, o.last_read_id as other_read_id,
      (select count(*) from ${chatMessages} x
        where x.chat_id = c.id and x.deleted_at is null and x.sender_id <> ${userId}
          and (m.cleared_before_id is null or x.id > m.cleared_before_id)
          and (m.last_read_id is null or x.id > m.last_read_id)
          and not exists (select 1 from ${chatHiddenMessages} h where h.user_id = ${userId} and h.message_id = x.id))::int as unread,
      (select x.id from ${chatMessages} x
        where x.chat_id = c.id and x.deleted_at is null
          and (m.cleared_before_id is null or x.id > m.cleared_before_id)
          and not exists (select 1 from ${chatHiddenMessages} h where h.user_id = ${userId} and h.message_id = x.id)
        order by x.id desc limit 1) as last_id
    from ${chatMembers} m
    join ${chats} c on c.id = m.chat_id
    join ${chatMembers} o on o.chat_id = c.id and o.user_id <> m.user_id
    where m.user_id = ${userId} and ${where}
    order by coalesce(c.last_message_at, c.created_at) desc, c.id desc
    limit ${limit}
  `)
  const lastIds = rows.map((r) => r.last_id).filter((id): id is string => !!id)
  const lastRows = lastIds.length ? await db.select().from(chatMessages).where(inArray(chatMessages.id, lastIds)) : []
  const files = await loadFiles(lastRows.flatMap((r) => r.attachmentIds))
  const lastById = new Map(lastRows.map((r) => [r.id, r]))
  const people = await loadUserRecords(rows.map((r) => r.other_id))

  return rows.map((row) => {
    const other = people.get(row.other_id)
    const last = row.last_id ? lastById.get(row.last_id) : undefined
    return {
      cursor: `${new Date(row.activity).toISOString()}|${row.chat_id}`,
      chat: {
        chat_id: row.chat_id,
        chat_type: 0,
        title: other && !other.deletedAt ? other.displayName : null,
        avatar: other && !other.deletedAt ? (other.avatarUrl ?? other.avatar) : null,
        other_user_id: row.other_id,
        other_user_deleted: !other || !!other.deletedAt,
        other_read_message_id: row.other_read_id,
        unread_count: row.unread,
        marked_unread: row.marked_unread,
        is_request: false,
        is_pinned: row.is_pinned,
        is_muted: row.is_muted,
        last_message: last ? lastMessagePreview(last, files) : null
      }
    }
  })
}

// the member deleted the chat: hidden; an empty chat is listed only for whoever opened it
const listed = (userId: string) => sql`m.hidden_at is null and (c.last_message_id is not null or c.created_by = ${userId})`

export async function listChats(userId: string, limit: number, before?: string) {
  let cursor = sql`true`
  if (before) {
    const [at, id] = before.split('|')
    const date = new Date(at ?? '')
    if (Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw badRequest('Invalid cursor', 'VALIDATION_ERROR')
    cursor = sql`(coalesce(c.last_message_at, c.created_at), c.id) < (${date.toISOString()}::timestamptz, ${id}::uuid)`
  }
  const rows = await querySummaries(userId, sql`${listed(userId)} and ${cursor}`, limit + 1)
  const page = rows.slice(0, limit)
  return { chats: page.map((r) => r.chat), next_before: rows.length > limit ? page.at(-1)!.cursor : null }
}

export async function chatSummary(userId: string, chatId: string) {
  const [row] = await querySummaries(userId, sql`c.id = ${chatId}`, 1)
  if (!row) throw chatNotFound()
  return row.chat
}

/** The unread badge: unread messages of all chats, a chat marked unread counts as one */
export async function unreadTotal(userId: string) {
  const rows = await querySummaries(userId, listed(userId), 10_000)
  return rows.reduce((sum, { chat }) => sum + (chat.unread_count || (chat.marked_unread ? 1 : 0)), 0)
}

/** The other members of the user's chats (who should hear about their presence) */
export async function chatPartners(userId: string) {
  const rows = await db
    .select({ low: chats.userLow, high: chats.userHigh })
    .from(chats)
    .where(or(eq(chats.userLow, userId), eq(chats.userHigh, userId)))
    .limit(1000)
  return rows.map((r) => (r.low === userId ? r.high : r.low))
}

/** Online state as others may see it: hidden when the user hides their last-seen time */
export async function onlineOf(ids: string[]) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map<string, boolean>()
  const rows = await db
    .select({ id: users.id, lastSeenAt: users.lastSeenAt, showLastSeen: users.showLastSeen, deletedAt: users.deletedAt })
    .from(users)
    .where(inArray(users.id, unique))
  const presence = await getPresence(rows)
  return new Map(rows.map((r) => [r.id, r.showLastSeen && !r.deletedAt && !!presence.get(r.id)?.online]))
}

// ---- input checks

const ENTITY_TYPES = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'text_link'])

/** Text spans in the client's format; offsets count UTF-16 code units like the client */
export function checkEntities(entities: ChatEntity[] | undefined | null, text: string | null): ChatEntity[] | null {
  if (!entities || entities.length === 0) return null
  if (entities.length > 50) throw badRequest('Слишком много форматирования', 'VALIDATION_ERROR')
  const length = text?.length ?? 0
  return entities.map((e) => {
    if (e.type === 'sticker') throw badRequest('Стикеры пока недоступны', 'VALIDATION_ERROR')
    if (e.type === 'post') {
      if (typeof e.post_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(e.post_id)) throw badRequest('Invalid post entity', 'VALIDATION_ERROR')
      return { type: 'post', post_id: e.post_id }
    }
    if (!ENTITY_TYPES.has(e.type)) throw badRequest(`Unknown entity type: ${e.type}`, 'VALIDATION_ERROR')
    const { offset, length: size } = e
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset! < 0 || size! <= 0 || offset! + size! > length) {
      throw badRequest('Invalid entity range', 'VALIDATION_ERROR')
    }
    if (e.type === 'text_link') {
      let url: URL
      try {
        url = new URL(String(e.url))
      } catch {
        throw badRequest('Invalid link', 'VALIDATION_ERROR')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('Invalid link', 'VALIDATION_ERROR')
      return { type: e.type, offset, length: size, url: url.toString() }
    }
    return { type: e.type, offset, length: size }
  })
}

export function checkText(text: string | null | undefined) {
  if (text == null) return null
  if (text.length > config.messenger.textMaxLength) throw badRequest(`Сообщение длиннее ${config.messenger.textMaxLength} символов`, 'VALIDATION_ERROR')
  return text.trim() ? text : null
}

/** Attachments of a new message: the sender's own uploaded files */
export async function checkAttachments(ownerId: string, ids: string[] | undefined) {
  if (!ids || ids.length === 0) return []
  const unique = [...new Set(ids)]
  if (unique.length > config.messenger.maxAttachments) throw badRequest(`Не больше ${config.messenger.maxAttachments} вложений`, 'VALIDATION_ERROR')
  const files = await loadFiles(unique)
  for (const id of unique) {
    if (files.get(id)?.ownerId !== ownerId) throw badRequest('Файл не найден', 'FILE_NOT_FOUND')
  }
  return unique
}

export type { UserRecord }
