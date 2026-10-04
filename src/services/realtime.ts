import { errorMeta, logger } from '../lib/logger'
import { getSubscriber, redis, rk } from '../redis'

export type RealtimeMessage = { event: string; data: unknown }
type Listener = (message: RealtimeMessage) => void

const listeners = new Map<string, Set<Listener>>()
let wired = false

function wire() {
  if (wired) return
  wired = true
  getSubscriber().on('message', (channel: string, payload: string) => {
    const set = listeners.get(channel)
    if (!set?.size) return
    let message: RealtimeMessage
    try {
      message = JSON.parse(payload)
    } catch {
      return
    }
    for (const listener of set) {
      try {
        listener(message)
      } catch (error) {
        logger.warn('realtime listener failed', errorMeta(error))
      }
    }
  })
}

export const userChannel = (userId: string) => rk('ch', 'user', userId)
export const qrChannel = (qrId: string) => rk('ch', 'qr', qrId)

/** Subscribes this process to a channel; returns an unsubscribe callback */
export async function subscribe(channel: string, listener: Listener) {
  wire()
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
    await getSubscriber().subscribe(channel)
  }
  set.add(listener)

  return () => {
    const current = listeners.get(channel)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) {
      listeners.delete(channel)
      getSubscriber()
        .unsubscribe(channel)
        .catch(() => {})
    }
  }
}

export async function publish(channel: string, event: string, data: unknown) {
  try {
    await redis.publish(channel, JSON.stringify({ event, data } satisfies RealtimeMessage))
  } catch (error) {
    logger.warn('realtime publish failed', errorMeta(error))
  }
}
