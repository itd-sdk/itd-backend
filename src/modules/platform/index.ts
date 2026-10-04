import { Enum } from '../../schemas'
import { desc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { announcements, appVersions, changelog } from '../../db/schema'

const AppModel = t.Object({ minVersion: t.String(), latestVersion: t.String(), updateUrl: t.String() })
const AnnouncementModel = t.Object({
  id: t.String(),
  title: t.String(),
  description: t.Nullable(t.String()),
  additional_text: t.Nullable(t.String()),
  additionalText: t.Nullable(t.String()),
  image: t.Nullable(t.Object({ url: t.String(), width: t.Optional(t.Nullable(t.Integer())), height: t.Optional(t.Nullable(t.Integer())) })),
  buttons: t.Array(
    t.Object({
      title: t.String(),
      style: Enum(['primary', 'secondary']),
      action: t.Object({ type: Enum(['dismiss', 'link']), url: t.Optional(t.Nullable(t.String())) })
    })
  ),
  createdAt: t.String()
})

export const platformModule = new Elysia({ prefix: '/platform', tags: ['Platform'] })
  .get(
    '/version',
    async () => {
      const rows = await db.select().from(appVersions)
      return Object.fromEntries(rows.map((r) => [r.name, { minVersion: r.minVersion, latestVersion: r.latestVersion, updateUrl: r.updateUrl }]))
    },
    { response: t.Record(t.String(), AppModel), detail: { summary: 'Official app versions (keyed by app name)' } }
  )
  .get(
    '/changelog',
    async () => {
      const rows = await db.select().from(changelog).orderBy(desc(changelog.createdAt))
      return { data: rows.map((r) => ({ version: r.version, date: r.date, changes: r.changes })) }
    },
    { response: t.Object({ data: t.Array(t.Object({ version: t.String(), date: t.String(), changes: t.Array(t.String()) })) }) }
  )
  .get(
    '/announcements',
    async () => {
      const rows = await db.select().from(announcements).where(eq(announcements.active, true)).orderBy(desc(announcements.createdAt))
      return {
        announcements: rows.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          additional_text: r.additionalText,
          additionalText: r.additionalText,
          image: r.image,
          buttons: r.buttons,
          createdAt: r.createdAt.toISOString()
        }))
      }
    },
    { response: t.Object({ announcements: t.Array(AnnouncementModel) }) }
  )
