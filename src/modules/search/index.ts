import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db } from '../../db/client'
import { hashtags, users } from '../../db/schema'
import { authPlugin } from '../../plugins/auth'
import { contextPlugin } from '../../plugins/context'
import { HashtagModel, UserListItemModel } from '../../schemas'
import { enforceActionLimit } from '../../services/rate-limit'
import { loadRelations, loadUserRecords, presentListItem } from '../../services/users'

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

export const searchModule = new Elysia({ tags: ['Search'] })
  .use(contextPlugin)
  .use(authPlugin)
  .get(
    '/search',
    async ({ query, me, ip }) => {
      await enforceActionLimit('search', me?.id ?? ip)
      const q = query.q.trim().toLowerCase()
      const userLimit = query.userLimit ?? 10
      const hashtagLimit = query.hashtagLimit ?? 10
      if (!q) return { data: { users: [], hashtags: [] } }

      const term = q.replace(/^@/, '')
      const prefix = `${escapeLike(term)}%`
      const contains = `%${escapeLike(term)}%`
      const tag = q.replace(/^#/, '')

      const [userRows, tagRows] = await Promise.all([
        userLimit === 0 || q.startsWith('#')
          ? Promise.resolve([])
          : db
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  isNull(users.deletedAt),
                  eq(users.isBanned, false),
                  sql`(lower(${users.username}) like ${prefix} or lower(${users.displayName}) like ${contains})`
                )
              )
              .orderBy(
                sql`case when lower(${users.username}) = ${term} then 0 when lower(${users.username}) like ${prefix} then 1 else 2 end`,
                desc(users.followersCount)
              )
              .limit(userLimit),
        hashtagLimit === 0 || q.startsWith('@')
          ? Promise.resolve([])
          : db
              .select({ id: hashtags.id, name: hashtags.name, postsCount: hashtags.postsCount })
              .from(hashtags)
              .where(and(sql`${hashtags.name} like ${`${escapeLike(tag)}%`}`, sql`${hashtags.postsCount} > 0`))
              .orderBy(desc(hashtags.postsCount))
              .limit(hashtagLimit)
      ])

      const ids = userRows.map((r) => r.id)
      const [records, relations] = await Promise.all([loadUserRecords(ids), loadRelations(me?.id ?? null, ids)])
      const found = ids.flatMap((id) => {
        const record = records.get(id)
        return record ? [presentListItem(record, relations.get(id))] : []
      })
      return { data: { users: found, hashtags: tagRows } }
    },
    {
      optionalUser: true,
      query: t.Object({
        q: t.String({ maxLength: 100 }),
        userLimit: t.Optional(t.Integer({ minimum: 0, maximum: 50 })),
        hashtagLimit: t.Optional(t.Integer({ minimum: 0, maximum: 50 }))
      }),
      response: t.Object({ data: t.Object({ users: t.Array(UserListItemModel), hashtags: t.Array(HashtagModel) }) }),
      detail: { summary: 'Search users (username / display name) and hashtags' }
    }
  )
