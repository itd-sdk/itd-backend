import { and, asc, eq, gt, lt, sql } from 'drizzle-orm'
import { config } from '../config'
import { db } from '../db/client'
import { messengerEvents, messengerState } from '../db/schema'
import { rk } from '../redis'
import { publish } from './realtime'

/*
 * Every change in a user's chats becomes an event with the next number of that user's sequence (event_seq).
 * The WebSocket pushes events live; a client that missed some (a gap in the numbers, a reconnect) replays
 * them from GET /updates?since=N. Typing and presence are pushed without a number and are not stored.
 */

export type Frame = { type: string } & Record<string, unknown>
export type Delivery = { userId: string; frame: Frame }

export const messengerChannel = (userId: string) => rk('ch', 'msgr', userId)

/** Stores the events and pushes them; returns the last event number of each user */
export async function emit(deliveries: Delivery[]): Promise<Map<string, number>> {
  const byUser = new Map<string, Frame[]>()
  for (const { userId, frame } of deliveries) byUser.set(userId, [...(byUser.get(userId) ?? []), frame])
  const numbered: { userId: string; frame: Frame; seq: number }[] = []
  const last = new Map<string, number>()
  if (byUser.size === 0) return last

  // one transaction: each user's counter row stays locked until the events are committed, so numbers are
  // committed in order and /updates never skips one; users are locked in sorted order (no deadlocks)
  await db.transaction(async (tx) => {
    for (const userId of [...byUser.keys()].sort()) {
      const frames = byUser.get(userId)!
      const [row] = await tx
        .insert(messengerState)
        .values({ userId, lastSeq: frames.length })
        .onConflictDoUpdate({ target: messengerState.userId, set: { lastSeq: sql`${messengerState.lastSeq} + ${frames.length}` } })
        .returning({ lastSeq: messengerState.lastSeq })
      const first = row!.lastSeq - frames.length + 1
      const rows = frames.map((frame, index) => ({ userId, seq: first + index, payload: frame }))
      await tx.insert(messengerEvents).values(rows)
      rows.forEach((r) => numbered.push({ userId, frame: r.payload, seq: r.seq }))
      last.set(userId, row!.lastSeq)
    }
  })

  await Promise.all(numbered.map(({ userId, frame, seq }) => publish(messengerChannel(userId), 'frame', { ...frame, event_seq: seq })))
  return last
}

/** A frame that is only pushed live (typing, presence) */
export async function pushLive(userId: string, frame: Frame) {
  await publish(messengerChannel(userId), 'frame', frame)
}

export async function currentSeq(userId: string) {
  const [row] = await db.select({ lastSeq: messengerState.lastSeq }).from(messengerState).where(eq(messengerState.userId, userId))
  return row?.lastSeq ?? 0
}

/** Events after `since`; reset_required when some of them are no longer kept (or the client is ahead) */
export async function eventsSince(userId: string, since: number, limit: number) {
  const last = await currentSeq(userId)
  const reset = { events: [], reset_required: true, next_event_seq: last }
  if (since > last) return reset
  if (since === last) return { events: [], reset_required: false, next_event_seq: since }

  const rows = await db
    .select({ seq: messengerEvents.seq, payload: messengerEvents.payload })
    .from(messengerEvents)
    .where(and(eq(messengerEvents.userId, userId), gt(messengerEvents.seq, since)))
    .orderBy(asc(messengerEvents.seq))
    .limit(limit)
  if (rows[0]?.seq !== since + 1) return reset
  return {
    events: rows.map((r) => ({ ...r.payload, event_seq: r.seq })),
    reset_required: false,
    next_event_seq: rows.at(-1)!.seq
  }
}

/** Drops events older than the retention period (a job) */
export async function pruneEvents() {
  const before = new Date(Date.now() - config.messenger.eventRetentionDays * 24 * 60 * 60 * 1000)
  await db.delete(messengerEvents).where(lt(messengerEvents.createdAt, before))
}
