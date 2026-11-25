import { Elysia, t } from 'elysia'
import { verifyAccessToken } from '../../lib/jwt'
import { errorMeta, logger } from '../../lib/logger'
import { loadProfile } from '../../plugins/auth'
import { redis, rk } from '../../redis'
import { messengerChannel, pushLive } from '../../services/messenger-events'
import { connectionClosed, connectionOpened } from '../../services/presence'
import { subscribe } from '../../services/realtime'
import { isSessionRevoked } from '../../services/session-store'
import { chatPartners } from './service'

/*
 * The messenger WebSocket: /api/v1/messenger/ws with subprotocols ["itd.messenger.v1", "bearer.<access token>"].
 * The server pushes JSON frames (see messenger-events); the client sends "ping" and gets "pong".
 * A bad token closes with 4001 (the client refreshes it and reconnects), a missing profile with 4003.
 */

const PROTOCOL = 'itd.messenger.v1'

type Connection = { userId: string; unsubscribe: () => void; closed: boolean }
const connections = new Map<string, Connection>()

async function authenticate(header: string | null | undefined) {
  const token = (header ?? '')
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith('bearer.'))
    ?.slice('bearer.'.length)
  if (!token) return { error: 4001 }
  try {
    const claims = verifyAccessToken(token)
    if (await isSessionRevoked(claims.sid)) return { error: 4001 }
    const profile = await loadProfile(claims.sub)
    if (!profile || profile.deletedAt) return { error: 4003 }
    return { profile }
  } catch {
    return { error: 4001 }
  }
}

/** Partners see the user come online or go offline, unless the user hides it */
async function announcePresence(userId: string, online: boolean, showLastSeen: boolean) {
  if (!showLastSeen) return
  const partners = await chatPartners(userId)
  await Promise.all(partners.map((partnerId) => pushLive(partnerId, { type: 'presence', user_id: userId, online })))
}

export const messengerSocketModule = new Elysia().ws('/ws', {
  query: t.Object({ capabilities: t.Optional(t.String()) }),
  upgrade: () => ({ 'Sec-WebSocket-Protocol': PROTOCOL }),
  idleTimeout: 120,

  async open(ws) {
    const auth = await authenticate(ws.data.headers['sec-websocket-protocol'])
    if (!auth.profile) {
      ws.close(auth.error, auth.error === 4003 ? 'forbidden' : 'unauthorized')
      return
    }
    const userId = auth.profile.id
    const connection: Connection = { userId, unsubscribe: () => {}, closed: false }
    connections.set(ws.id, connection)
    try {
      connection.unsubscribe = await subscribe(messengerChannel(userId), (message) => {
        if (!connection.closed) ws.send(JSON.stringify(message.data))
      })
      // the socket may have closed while subscribing
      if (connection.closed) return connection.unsubscribe()
      await connectionOpened(userId)
      if ((await redis.get(rk('online', userId))) === '1') await announcePresence(userId, true, auth.profile.showLastSeen)
    } catch (error) {
      logger.warn('messenger socket open failed', errorMeta(error))
      ws.close(1011, 'error')
    }
  },

  message(ws, message) {
    if (message === 'ping') ws.send('pong')
  },

  async close(ws) {
    const connection = connections.get(ws.id)
    if (!connection) return
    connections.delete(ws.id)
    connection.closed = true
    connection.unsubscribe()
    try {
      await connectionClosed(connection.userId)
      if (!(await redis.exists(rk('online', connection.userId)))) {
        const profile = await loadProfile(connection.userId)
        await announcePresence(connection.userId, false, profile?.showLastSeen ?? false)
      }
    } catch (error) {
      logger.warn('messenger socket close failed', errorMeta(error))
    }
  }
})
