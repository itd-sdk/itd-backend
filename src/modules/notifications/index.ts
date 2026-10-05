import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { notificationSettings, notifications } from '../../db/schema'
import { ApiError, unauthorized } from '../../lib/errors'
import { sseResponse } from '../../lib/sse'
import { authPlugin, loadProfile, readAuth } from '../../plugins/auth'
import { NotificationModel, NotificationSettingsModel, Uuid } from '../../schemas'
import { loadSettings, markRead, presentNotifications, type Settings, unreadCount } from '../../services/notifications'
import { connectionClosed, connectionOpened } from '../../services/presence'
import { broadcastChannel, subscribe, userChannel } from '../../services/realtime'

function presentSettings(settings: Settings) {
  return {
    ...settings,
    soundEnabled: settings.sound,
    preferences: {
      follows: settings.follows,
      reactions: settings.likes,
      comments: settings.comments,
      replies: settings.replies,
      mentions: settings.mentions,
      wallPosts: settings.wallPosts
    }
  }
}

const Bool = t.Optional(t.Boolean())

export const notificationsModule = new Elysia({ prefix: '/notifications', tags: ['Notifications'] })
  .use(authPlugin)

  .get(
    '/',
    async ({ me, query }) => {
      const limit = query.limit ?? 20
      const offset = query.offset ?? (query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0)
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.recipientId, me.id))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit + 1)
        .offset(offset)
      const hasMore = rows.length > limit
      return { notifications: await presentNotifications(rows.slice(0, limit)), hasMore }
    },
    {
      user: true,
      query: t.Object({
        limit: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
        offset: t.Optional(t.Integer({ minimum: 0 })),
        cursor: t.Optional(t.String({ maxLength: 16 }))
      }),
      response: t.Object({ notifications: t.Array(NotificationModel), hasMore: t.Boolean() }),
      detail: { summary: 'Notifications, newest first (offset pagination)' }
    }
  )

  .get('/count', async ({ me }) => ({ count: await unreadCount(me.id) }), {
    user: true,
    response: t.Object({ count: t.Integer() }),
    detail: { summary: 'Unread notifications count' }
  })

  .post(
    '/read-batch',
    async ({ me, body }) => {
      const ids = [...new Set(body.ids)]
      const owned = ids.length
        ? await db
            .select({ id: notifications.id })
            .from(notifications)
            .where(and(eq(notifications.recipientId, me.id), inArray(notifications.id, ids)))
        : []
      if (owned.length === 0) {
        throw new ApiError(404, 'NOT_FOUND', 'Notification not found', {}, { success: false, error: { code: 'NOT_FOUND', message: 'Notification not found' } })
      }
      return { success: true, count: await markRead(me.id, ids) }
    },
    {
      user: true,
      body: t.Object({ ids: t.Array(Uuid, { minItems: 1, maxItems: 500 }) }),
      response: t.Object({ success: t.Boolean(), count: t.Integer() }),
      detail: { summary: 'Mark notifications as read' }
    }
  )

  .post(
    '/read-all',
    async ({ me }) => {
      const rows = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(and(eq(notifications.recipientId, me.id), isNull(notifications.readAt)))
        .returning({ id: notifications.id })
      return { success: true, count: rows.length }
    },
    { user: true, response: t.Object({ success: t.Boolean(), count: t.Integer() }) }
  )

  .get('/settings', async ({ me }) => presentSettings(await loadSettings(me.id)), { user: true, response: NotificationSettingsModel })

  .put(
    '/settings',
    async ({ me, body }) => {
      // both the legacy flat format and the newer {webEnabled, soundEnabled, preferences} format are accepted
      const current = await loadSettings(me.id)
      const next: Settings = { ...current }
      const assign = (key: keyof Settings, value: boolean | undefined) => {
        if (value !== undefined) next[key] = value
      }
      assign('enabled', body.enabled)
      assign('webEnabled', body.webEnabled)
      assign('sound', body.sound ?? body.soundEnabled)
      assign('follows', body.follows ?? body.preferences?.follows)
      assign('wallPosts', body.wallPosts ?? body.preferences?.wallPosts)
      assign('likes', body.likes ?? body.preferences?.reactions)
      assign('comments', body.comments ?? body.preferences?.comments)
      assign('replies', body.replies ?? body.preferences?.replies)
      assign('mentions', body.mentions ?? body.preferences?.mentions)

      await db
        .insert(notificationSettings)
        .values({ userId: me.id, ...next, updatedAt: new Date() })
        .onConflictDoUpdate({ target: notificationSettings.userId, set: { ...next, updatedAt: new Date() } })
      return presentSettings(next)
    },
    {
      user: true,
      body: t.Object({
        enabled: Bool,
        webEnabled: Bool,
        sound: Bool,
        soundEnabled: Bool,
        follows: Bool,
        wallPosts: Bool,
        likes: Bool,
        comments: Bool,
        replies: Bool,
        mentions: Bool,
        preferences: t.Optional(
          t.Object({ follows: Bool, reactions: Bool, comments: Bool, replies: Bool, mentions: Bool, wallPosts: Bool })
        )
      }),
      response: NotificationSettingsModel
    }
  )

  .get(
    '/stream',
    async ({ request, server, query }) => {
      // EventSource cannot send headers, so the token may also come as ?token=
      const authRequest = query.token && !request.headers.get('authorization') ? new Request(request.url, { headers: { authorization: `Bearer ${query.token}` } }) : request
      const auth = await readAuth(authRequest, true)
      const me = await loadProfile(auth!.accountId)
      if (!me || me.deletedAt) throw unauthorized('Profile required')
      server?.timeout(request, 0)

      return sseResponse(request, async (sink) => {
        sink.send({ userId: me.id, timestamp: Date.now() })
        await connectionOpened(me.id)
        const unsubscribe = await subscribe(userChannel(me.id), (message) => sink.send(message.data, message.event))
        const unsubscribeAll = await subscribe(broadcastChannel(), (message) => sink.send(message.data, message.event))
        return () => {
          unsubscribe()
          unsubscribeAll()
          void connectionClosed(me.id)
        }
      })
    },
    {
      query: t.Object({ token: t.Optional(t.String({ maxLength: 4096 })) }),
      detail: {
        summary: 'Server-sent events: `notification` (Notification + sound), `alice.bell`, `notification.event`',
        security: [{ bearerAuth: [] }]
      }
    }
  )

