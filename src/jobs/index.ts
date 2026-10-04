import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { accounts, files, sessions, users } from '../db/schema'
import { storage } from '../lib/storage'
import { errorMeta, logger } from '../lib/logger'
import { renewDueSubscriptions } from '../modules/subscription/service'
import { markSessionsRevoked } from '../services/session-store'
import { redis, rk } from '../redis'

/** Removes an account for good, subtracting its contributions from other users' counters first */
export async function purgeAccount(userId: string) {
  const keys = await db.select({ key: files.storageKey }).from(files).where(eq(files.ownerId, userId))
  const live = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.accountId, userId))
  await markSessionsRevoked(live.map((s) => s.id))
  await db.transaction(async (tx) => {
    const run = (query: ReturnType<typeof sql>) => tx.execute(query)
    await run(sql`update posts set likes_count = greatest(likes_count - 1, 0) where id in (select post_id from post_likes where user_id = ${userId})`)
    await run(sql`update comments set likes_count = greatest(likes_count - 1, 0) where id in (select comment_id from comment_likes where user_id = ${userId})`)
    await run(sql`update users set followers_count = greatest(followers_count - 1, 0) where id in (select following_id from follows where follower_id = ${userId})`)
    await run(sql`update users set following_count = greatest(following_count - 1, 0) where id in (select follower_id from follows where following_id = ${userId})`)
    await run(sql`
      update posts p set comments_count = greatest(p.comments_count - c.n, 0)
      from (select post_id, count(*)::int n from comments where author_id = ${userId} and deleted_at is null group by post_id) c
      where p.id = c.post_id and p.author_id <> ${userId}`)
    await run(sql`
      update comments r set replies_count = greatest(r.replies_count - c.n, 0)
      from (select root_id, count(*)::int n from comments where author_id = ${userId} and deleted_at is null and root_id is not null group by root_id) c
      where r.id = c.root_id and r.author_id <> ${userId}`)
    await run(sql`
      update posts o set reposts_count = greatest(o.reposts_count - c.n, 0)
      from (select original_post_id, count(*)::int n from posts where author_id = ${userId} and deleted_at is null and original_post_id is not null group by original_post_id) c
      where o.id = c.original_post_id`)
    await run(sql`update poll_options set votes_count = greatest(votes_count - 1, 0) where id in (select option_id from poll_votes where user_id = ${userId})`)
    await run(sql`update polls set total_votes = greatest(total_votes - 1, 0) where id in (select distinct poll_id from poll_votes where user_id = ${userId})`)
    await run(sql`
      update hashtags h set posts_count = greatest(h.posts_count - c.n, 0)
      from (select ph.hashtag_id, count(*)::int n from post_hashtags ph join posts p on p.id = ph.post_id
            where p.author_id = ${userId} and p.deleted_at is null group by ph.hashtag_id) c
      where h.id = c.hashtag_id`)
    await tx.delete(accounts).where(eq(accounts.id, userId))
  })
  for (const { key } of keys) await storage.remove(key).catch(() => {})
}

export async function purgeExpiredAccounts() {
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(isNotNull(users.deletedAt), lte(users.restoreDeadline, sql`now()`)))
    .limit(50)
  for (const { id } of due) await purgeAccount(id)
  return due.length
}

export async function liftExpiredBans() {
  const lifted = await db.execute<{ id: string }>(sql`
    with lifted as (
      update ${accounts} set banned_at = null, banned_until = null, ban_reason = null
      where banned_until is not null and banned_until <= now() returning id
    )
    update ${users} set is_banned = false where id in (select id from lifted) returning id
  `)
  return lifted.length
}

export async function cleanupSessions() {
  const removed = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} < now() - interval '7 days' or ${sessions.revokedAt} < now() - interval '7 days'`)
    .returning({ id: sessions.id })
  return removed.length
}

type Job = { name: string; everyMs: number; run: () => Promise<unknown> }

const JOBS: Job[] = [
  { name: 'purge-accounts', everyMs: 10 * 60_000, run: purgeExpiredAccounts },
  { name: 'renew-subscriptions', everyMs: 10 * 60_000, run: renewDueSubscriptions },
  { name: 'lift-bans', everyMs: 5 * 60_000, run: liftExpiredBans },
  { name: 'cleanup-sessions', everyMs: 60 * 60_000, run: cleanupSessions }
]

/** Runs periodic jobs; a redis lock makes sure only one instance executes each run */
export function startJobs() {
  const timers = JOBS.map((job) =>
    setInterval(async () => {
      const locked = await redis.set(rk('lock', 'job', job.name), '1', 'PX', job.everyMs - 1000, 'NX').catch(() => null)
      if (locked !== 'OK') return
      try {
        const result = await job.run()
        logger.debug('job finished', { job: job.name, result: result as number })
      } catch (error) {
        logger.error('job failed', { job: job.name, ...errorMeta(error) })
      }
    }, job.everyMs)
  )
  return () => timers.forEach(clearInterval)
}

