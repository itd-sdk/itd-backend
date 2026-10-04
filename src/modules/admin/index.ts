import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { accounts, announcements, appVersions, bannedWords, changelog, comments, pins, posts, reports, type Role, userPins, users, verificationRequests } from '../../db/schema'
import { badRequest, conflict, notFound } from '../../lib/errors'
import { ruDate } from '../../lib/time'
import { authPlugin } from '../../plugins/auth'
import { Enum, SuccessModel, Uuid } from '../../schemas'
import { invalidateBannedWords } from '../../services/moderation'
import { notify } from '../../services/notifications'
import { requireTargetUser, findUserByIdentifier } from '../../services/users'
import { revokeAllSessions } from '../auth/service'
import { presentVerification, VerificationRequestModel } from '../verification'

const IdentifierParams = t.Object({ id: t.String({ maxLength: 512 }) })
const PageQuery = t.Object({
  status: t.Optional(t.String({ maxLength: 16 })),
  page: t.Optional(t.Integer({ minimum: 1 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 }))
})

async function requireAnyUser(identifier: string) {
  const user = await findUserByIdentifier(identifier)
  if (!user) throw notFound('User not found')
  return user
}

export const adminModule = new Elysia({ prefix: '/admin', tags: ['Admin'] })
  .use(authPlugin)

  .get(
    '/stats',
    async () => {
      const [row] = await db.execute<Record<string, number>>(sql`
        select
          (select count(*)::int from ${users} where deleted_at is null) as users,
          (select count(*)::int from ${posts} where deleted_at is null) as posts,
          (select count(*)::int from ${comments} where deleted_at is null) as comments,
          (select count(*)::int from ${reports} where status = 'pending') as "pendingReports",
          (select count(*)::int from ${verificationRequests} where status = 'pending') as "pendingVerifications"
      `)
      return row ?? {}
    },
    { admin: true, detail: { summary: 'Instance counters' } }
  )

  // ------------------------------------------------------------ users

  .post(
    '/users/:id/ban',
    async ({ params, body, me }) => {
      const user = await requireAnyUser(params.id)
      if (user.id === me.id) throw badRequest('Cannot ban yourself')
      const until = body.until ? new Date(body.until) : null
      if (until && Number.isNaN(until.getTime())) throw badRequest('Invalid `until` date')
      await db.transaction(async (tx) => {
        await tx
          .update(accounts)
          .set({ bannedAt: new Date(), bannedUntil: until, banReason: body.reason ?? null })
          .where(eq(accounts.id, user.id))
        await tx.update(users).set({ isBanned: true }).where(eq(users.id, user.id))
      })
      const revoked = await revokeAllSessions(user.id, { reason: 'banned' })
      return { success: true, revokedSessions: revoked }
    },
    {
      admin: true,
      params: IdentifierParams,
      body: t.Object({ reason: t.Optional(t.String({ maxLength: 500 })), until: t.Optional(t.String({ format: 'date-time' })) }),
      detail: { summary: 'Ban a user (temporary when `until` is set)' }
    }
  )

  .delete(
    '/users/:id/ban',
    async ({ params }) => {
      const user = await requireAnyUser(params.id)
      await db.transaction(async (tx) => {
        await tx.update(accounts).set({ bannedAt: null, bannedUntil: null, banReason: null }).where(eq(accounts.id, user.id))
        await tx.update(users).set({ isBanned: false }).where(eq(users.id, user.id))
      })
      return { success: true }
    },
    { admin: true, params: IdentifierParams, response: SuccessModel }
  )

  .put(
    '/users/:id/verified',
    async ({ params, body }) => {
      const user = await requireTargetUser(params.id)
      await db.update(users).set({ verified: body.verified }).where(eq(users.id, user.id))
      return { success: true }
    },
    { admin: true, params: IdentifierParams, body: t.Object({ verified: t.Boolean() }), response: SuccessModel }
  )

  .put(
    '/users/:id/roles',
    async ({ params, body }) => {
      const user = await requireAnyUser(params.id)
      const roles = [...new Set<Role>(['user', ...body.roles])]
      await db.update(accounts).set({ roles }).where(eq(accounts.id, user.id))
      return { success: true, roles }
    },
    { admin: true, params: IdentifierParams, body: t.Object({ roles: t.Array(Enum(['user', 'admin'])) }) }
  )

  // ------------------------------------------------------------ pins

  .get('/pins', async () => ({ pins: await db.select().from(pins).orderBy(asc(pins.slug)) }), { admin: true })

  .post(
    '/pins',
    async ({ body }) => {
      await db
        .insert(pins)
        .values({ slug: body.slug, name: body.name, description: body.description ?? '', url: body.url ?? null })
        .onConflictDoUpdate({ target: pins.slug, set: { name: body.name, description: body.description ?? '', url: body.url ?? null } })
      return { success: true }
    },
    {
      admin: true,
      body: t.Object({
        slug: t.String({ pattern: '^[a-z0-9_-]{2,64}$' }),
        name: t.String({ maxLength: 100 }),
        description: t.Optional(t.String({ maxLength: 500 })),
        url: t.Optional(t.Nullable(t.String({ maxLength: 2048 })))
      }),
      response: SuccessModel
    }
  )

  .post(
    '/users/:id/pins',
    async ({ params, body }) => {
      const user = await requireAnyUser(params.id)
      const [pin] = await db.select().from(pins).where(eq(pins.slug, body.slug)).limit(1)
      if (!pin) throw notFound('Pin not found')
      await db.insert(userPins).values({ userId: user.id, pinSlug: pin.slug }).onConflictDoNothing()
      return { success: true }
    },
    { admin: true, params: IdentifierParams, body: t.Object({ slug: t.String({ maxLength: 64 }) }), response: SuccessModel }
  )

  .delete(
    '/users/:id/pins/:slug',
    async ({ params }) => {
      const user = await requireAnyUser(params.id)
      await db.delete(userPins).where(and(eq(userPins.userId, user.id), eq(userPins.pinSlug, params.slug)))
      await db
        .update(users)
        .set({ activePinSlug: null })
        .where(and(eq(users.id, user.id), eq(users.activePinSlug, params.slug)))
      return { success: true }
    },
    { admin: true, params: t.Object({ id: t.String({ maxLength: 512 }), slug: t.String({ maxLength: 64 }) }), response: SuccessModel }
  )

  // ------------------------------------------------------------ reports

  .get(
    '/reports',
    async ({ query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 50
      const rows = await db
        .select()
        .from(reports)
        .where(eq(reports.status, (query.status ?? 'pending') as 'pending'))
        .orderBy(desc(reports.createdAt))
        .limit(limit)
        .offset((page - 1) * limit)
      return { reports: rows }
    },
    { admin: true, query: PageQuery }
  )

  .patch(
    '/reports/:id',
    async ({ params, body, me }) => {
      const [row] = await db
        .update(reports)
        .set({ status: body.status, resolvedBy: me.id, resolvedAt: new Date() })
        .where(eq(reports.id, params.id))
        .returning()
      if (!row) throw notFound('Report not found')
      return { success: true }
    },
    { admin: true, params: t.Object({ id: Uuid }), body: t.Object({ status: Enum(['resolved', 'rejected', 'pending']) }), response: SuccessModel }
  )

  // ------------------------------------------------------------ verification

  .get(
    '/verification',
    async ({ query }) => {
      const page = query.page ?? 1
      const limit = query.limit ?? 50
      const rows = await db
        .select()
        .from(verificationRequests)
        .where(eq(verificationRequests.status, (query.status ?? 'pending') as 'pending'))
        .orderBy(asc(verificationRequests.createdAt))
        .limit(limit)
        .offset((page - 1) * limit)
      return { requests: rows.map(presentVerification) }
    },
    { admin: true, query: PageQuery, response: t.Object({ requests: t.Array(VerificationRequestModel) }) }
  )

  .post(
    '/verification/:id/:decision',
    async ({ params, body, me }) => {
      const approve = params.decision === 'approve'
      const [row] = await db
        .update(verificationRequests)
        .set({
          status: approve ? 'approved' : 'rejected',
          rejectionReason: approve ? null : (body?.reason ?? 'Видео не прошло проверку'),
          reviewedBy: me.id,
          reviewedAt: new Date(),
          updatedAt: new Date()
        })
        .where(and(eq(verificationRequests.id, params.id), eq(verificationRequests.status, 'pending')))
        .returning()
      if (!row) throw conflict('Request not found or already reviewed')
      if (approve) await db.update(users).set({ verified: true }).where(eq(users.id, row.userId))
      return { success: true, request: presentVerification(row) }
    },
    {
      admin: true,
      params: t.Object({ id: Uuid, decision: Enum(['approve', 'reject']) }),
      body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 500 })) })),
      response: t.Object({ success: t.Boolean(), request: VerificationRequestModel })
    }
  )

  // ------------------------------------------------------------ content

  .get('/banned-words', async () => ({ words: (await db.select().from(bannedWords).orderBy(asc(bannedWords.word))).map((w) => w.word) }), { admin: true })

  .post(
    '/banned-words',
    async ({ body }) => {
      await db.insert(bannedWords).values({ word: body.word.trim().toLowerCase() }).onConflictDoNothing()
      invalidateBannedWords()
      return { success: true }
    },
    { admin: true, body: t.Object({ word: t.String({ minLength: 1, maxLength: 100 }) }), response: SuccessModel }
  )

  .delete(
    '/banned-words/:word',
    async ({ params }) => {
      await db.delete(bannedWords).where(eq(bannedWords.word, decodeURIComponent(params.word).toLowerCase()))
      invalidateBannedWords()
      return { success: true }
    },
    { admin: true, response: SuccessModel }
  )

  .post(
    '/changelog',
    async ({ body }) => {
      await db
        .insert(changelog)
        .values({ version: body.version, date: body.date ?? ruDate(new Date()), changes: body.changes })
        .onConflictDoUpdate({ target: changelog.version, set: { date: body.date ?? ruDate(new Date()), changes: body.changes } })
      return { success: true }
    },
    {
      admin: true,
      body: t.Object({ version: t.String({ maxLength: 32 }), date: t.Optional(t.String({ maxLength: 32 })), changes: t.Array(t.String({ maxLength: 500 })) }),
      response: SuccessModel
    }
  )

  .post(
    '/announcements',
    async ({ body }) => {
      const values = {
        title: body.title,
        description: body.description ?? null,
        additionalText: body.additionalText ?? null,
        image: body.image ?? null,
        buttons: body.buttons ?? [],
        active: body.active ?? true
      }
      await db
        .insert(announcements)
        .values({ id: body.id, ...values })
        .onConflictDoUpdate({ target: announcements.id, set: values })
      return { success: true }
    },
    {
      admin: true,
      body: t.Object({
        id: t.String({ maxLength: 64 }),
        title: t.String({ maxLength: 200 }),
        description: t.Optional(t.String({ maxLength: 2000 })),
        additionalText: t.Optional(t.String({ maxLength: 2000 })),
        image: t.Optional(t.Object({ url: t.String(), width: t.Optional(t.Integer()), height: t.Optional(t.Integer()) })),
        buttons: t.Optional(
          t.Array(
            t.Object({
              title: t.String(),
              style: Enum(['primary', 'secondary']),
              action: t.Object({ type: Enum(['dismiss', 'link']), url: t.Optional(t.String()) })
            })
          )
        ),
        active: t.Optional(t.Boolean())
      }),
      response: SuccessModel
    }
  )

  .put(
    '/app-versions/:name',
    async ({ params, body }) => {
      const values = { minVersion: body.minVersion, latestVersion: body.latestVersion, updateUrl: body.updateUrl, updatedAt: new Date() }
      await db
        .insert(appVersions)
        .values({ name: params.name, ...values })
        .onConflictDoUpdate({ target: appVersions.name, set: values })
      return { success: true }
    },
    {
      admin: true,
      params: t.Object({ name: t.String({ maxLength: 32 }) }),
      body: t.Object({ minVersion: t.String(), latestVersion: t.String(), updateUrl: t.String() }),
      response: SuccessModel
    }
  )

  .post(
    '/notifications/reminder',
    async ({ body }) => {
      const recipients = body.userIds?.length
        ? body.userIds
        : (await db.select({ id: users.id }).from(users).where(sql`${users.deletedAt} is null`)).map((u) => u.id)
      // broadcast in the background: the request should not wait for every recipient
      void (async () => {
        for (const recipientId of recipients) {
          await notify({
            recipientId,
            actorId: null,
            type: 'alice_task_reminder',
            title: body.title,
            link: body.link ?? null,
            eventId: body.eventId ?? null,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null
          })
        }
      })()
      return { success: true, recipients: recipients.length }
    },
    {
      admin: true,
      body: t.Object({
        title: t.String({ maxLength: 200 }),
        link: t.Optional(t.String({ maxLength: 2048 })),
        eventId: t.Optional(t.String({ maxLength: 64 })),
        expiresAt: t.Optional(t.String({ format: 'date-time' })),
        userIds: t.Optional(t.Array(Uuid, { maxItems: 1000 }))
      }),
      detail: { summary: 'Send an event reminder notification' }
    }
  )
