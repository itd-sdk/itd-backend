import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, type Executor } from '../db/client'
import { type NotificationType, notificationSettings, notifications } from '../db/schema'
import { errorMeta, logger } from '../lib/logger'
import { truncate } from '../lib/text'
import { iso } from '../lib/time'
import { publish, userChannel } from './realtime'
import { isBlockedBetween, loadBriefs, type UserBrief } from './users'

export type NotificationRow = typeof notifications.$inferSelect
export type SettingsRow = typeof notificationSettings.$inferSelect

export const DEFAULT_SETTINGS = {
  enabled: true,
  webEnabled: true,
  sound: true,
  follows: true,
  wallPosts: true,
  likes: true,
  comments: true,
  replies: true,
  mentions: true
}
export type Settings = typeof DEFAULT_SETTINGS

const SETTING_FOR_TYPE: Partial<Record<NotificationType, keyof Settings>> = {
  follow: 'follows',
  follow_request: 'follows',
  follow_accepted: 'follows',
  like: 'likes',
  comment_like: 'likes',
  repost: 'likes',
  comment: 'comments',
  reply: 'replies',
  mention: 'mentions',
  comment_mention: 'mentions',
  wall_post: 'wallPosts'
}

export async function loadSettings(userId: string, executor: Executor = db): Promise<Settings> {
  const [row] = await executor.select().from(notificationSettings).where(eq(notificationSettings.userId, userId)).limit(1)
  if (!row) return { ...DEFAULT_SETTINGS }
  const { userId: _, updatedAt: __, ...settings } = row
  return settings
}

export type NotifyInput = {
  recipientId: string
  actorId: string | null
  type: NotificationType
  targetType?: 'post' | null
  targetId?: string | null
  subjectType?: 'post' | 'comment' | null
  subjectId?: string | null
  preview?: string | null
  title?: string | null
  link?: string | null
  eventId?: string | null
  expiresAt?: Date | null
  dedupeKey?: string | null
}

export function presentNotification(row: NotificationRow, actor: UserBrief | null) {
  return {
    id: row.id,
    type: row.type,
    targetType: row.targetType,
    targetId: row.targetId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    preview: row.preview,
    title: row.title,
    link: row.link,
    eventId: row.eventId,
    eventCycle: row.eventCycle,
    expiresAt: iso(row.expiresAt),
    read: !!row.readAt,
    readAt: iso(row.readAt),
    createdAt: row.createdAt.toISOString(),
    actor
  }
}

export async function presentNotifications(rows: NotificationRow[]) {
  const { briefs } = await loadBriefs(rows.map((row) => row.actorId).filter((id): id is string => !!id))
  return rows.map((row) => presentNotification(row, row.actorId ? (briefs.get(row.actorId) ?? null) : null))
}

/**
 * Creates a notification (respecting recipient preferences, blocks and dedupe keys)
 * and pushes it to the recipient's realtime channel. Never throws: notifications are best-effort.
 */
export async function notify(input: NotifyInput) {
  try {
    if (input.actorId && input.actorId === input.recipientId) return null
    const settings = await loadSettings(input.recipientId)
    const setting = SETTING_FOR_TYPE[input.type]
    if (setting && !settings[setting]) return null
    if (input.actorId && (await isBlockedBetween(input.actorId, input.recipientId))) return null

    const [row] = await db
      .insert(notifications)
      .values({
        recipientId: input.recipientId,
        actorId: input.actorId,
        type: input.type,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        preview: truncate(input.preview ?? null, 200),
        title: input.title ?? null,
        link: input.link ?? null,
        eventId: input.eventId ?? null,
        expiresAt: input.expiresAt ?? null,
        dedupeKey: input.dedupeKey ?? null
      })
      .onConflictDoNothing({ target: [notifications.recipientId, notifications.dedupeKey], where: sql`dedupe_key is not null` })
      .returning()
    if (!row) return null

    const [presented] = await presentNotifications([row])
    await publish(userChannel(input.recipientId), 'notification', { ...presented, sound: settings.sound && settings.enabled })
    return row
  } catch (error) {
    logger.error('notification failed', { ...errorMeta(error), type: input.type })
    return null
  }
}

export async function removeNotifications(where: { recipientId: string; actorId?: string; type: NotificationType; dedupeKey?: string }) {
  const conditions = [eq(notifications.recipientId, where.recipientId), eq(notifications.type, where.type)]
  if (where.actorId) conditions.push(eq(notifications.actorId, where.actorId))
  if (where.dedupeKey) conditions.push(eq(notifications.dedupeKey, where.dedupeKey))
  await db.delete(notifications).where(and(...conditions))
}

export async function unreadCount(userId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.recipientId, userId), isNull(notifications.readAt)))
  return row?.count ?? 0
}

export async function markRead(userId: string, ids: string[]) {
  if (ids.length === 0) return 0
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.recipientId, userId), inArray(notifications.id, ids), isNull(notifications.readAt)))
    .returning({ id: notifications.id })
  return rows.length
}
