import { assertProductionConfig, config, usesDevSecret } from './config'
import { closeDb } from './db/client'
import { runMigrations } from './db/migrate'
import { createApp } from './app'
import { startJobs } from './jobs'
import { logger } from './lib/logger'
import { closeRedis } from './redis'

assertProductionConfig()
if (process.env.MIGRATE_ON_START === 'true') await runMigrations()

const app = createApp().listen({ hostname: config.host, port: config.port })
const stopJobs = config.jobsEnabled ? startJobs() : () => {}
logger.info('itd-backend started', { url: `http://${config.host}:${config.port}`, docs: `${config.publicUrl}/swagger` })
if (usesDevSecret()) logger.warn('JWT_SECRET is not set: using an insecure development secret')

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  logger.info('shutting down', { signal })
  // never hang a restart: a stuck close must not keep the old process (and the port) alive
  setTimeout(() => process.exit(1), 5000).unref()
  stopJobs()
  // notification streams (SSE) never finish on their own: drop open connections instead of waiting for them
  await app.stop(true)
  await Promise.allSettled([closeDb(), closeRedis()])
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
