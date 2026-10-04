import { and, desc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { verificationRequests } from '../../db/schema'
import { conflict, notFound, validationError } from '../../lib/errors'
import { isHttpUrl } from '../../lib/text'
import { iso } from '../../lib/time'
import { authPlugin } from '../../plugins/auth'
import { Enum, Uuid } from '../../schemas'

type RequestRow = typeof verificationRequests.$inferSelect

export const VerificationRequestModel = t.Object({
  id: Uuid,
  userId: Uuid,
  videoUrl: t.String(),
  status: Enum(['pending', 'approved', 'rejected']),
  rejectionReason: t.Nullable(t.String()),
  reviewedBy: t.Nullable(t.String()),
  reviewedAt: t.Nullable(t.String()),
  createdAt: t.String(),
  updatedAt: t.String()
})

export const presentVerification = (row: RequestRow) => ({
  id: row.id,
  userId: row.userId,
  videoUrl: row.videoUrl,
  status: row.status,
  rejectionReason: row.rejectionReason,
  reviewedBy: row.reviewedBy,
  reviewedAt: iso(row.reviewedAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString()
})

const Envelope = t.Object({ success: t.Boolean(), request: VerificationRequestModel })

export const verificationModule = new Elysia({ prefix: '/verification', tags: ['Verification'] })
  .use(authPlugin)
  .post(
    '/submit',
    async ({ body, me, set }) => {
      if (me.verified) throw conflict('Account is already verified', 'ALREADY_VERIFIED')
      if (!isHttpUrl(body.videoUrl)) throw validationError('videoUrl must be a valid http(s) url', 'videoUrl')
      const [pending] = await db
        .select({ id: verificationRequests.id })
        .from(verificationRequests)
        .where(and(eq(verificationRequests.userId, me.id), eq(verificationRequests.status, 'pending')))
        .limit(1)
      if (pending) throw conflict('Verification request is already pending', 'ALREADY_PENDING')
      const [row] = await db.insert(verificationRequests).values({ userId: me.id, videoUrl: body.videoUrl }).returning()
      set.status = 201
      return { success: true, request: presentVerification(row!) }
    },
    {
      user: true,
      body: t.Object({ videoUrl: t.String({ maxLength: 2048, description: 'Url of an uploaded verification video' }) }),
      response: { 201: Envelope },
      detail: { summary: 'Submit a verification video' }
    }
  )
  .get(
    '/status',
    async ({ me }) => {
      const [row] = await db
        .select()
        .from(verificationRequests)
        .where(eq(verificationRequests.userId, me.id))
        .orderBy(desc(verificationRequests.createdAt))
        .limit(1)
      if (!row) throw notFound('Verification request not found')
      return { success: true, request: presentVerification(row) }
    },
    { user: true, response: Envelope, detail: { summary: 'Latest verification request' } }
  )
