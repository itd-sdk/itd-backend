import Redis from 'ioredis'
import { config } from './config'
import { errorMeta, logger } from './lib/logger'

function createClient(name: string) {
  const client = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    connectionName: `itd-backend:${name}`
  })
  client.on('error', (error) => logger.error(`redis ${name} error`, errorMeta(error)))
  return client
}

export const redis = createClient('main')

let subscriber: Redis | undefined
// Pub/sub needs a dedicated connection; created lazily by the realtime hub
export function getSubscriber() {
  subscriber ??= createClient('subscriber')
  return subscriber
}

/** Builds a namespaced redis key */
export const rk = (...parts: (string | number)[]) => config.redisPrefix + parts.join(':')

export async function closeRedis() {
  await Promise.allSettled([redis.quit(), subscriber?.quit()])
}
