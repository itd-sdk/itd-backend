import { afterAll } from 'bun:test'
import { rm } from 'node:fs/promises'
import { config } from '../src/config'
import { closeDb } from '../src/db/client'
import { runMigrations } from '../src/db/migrate'
import { closeRedis } from '../src/redis'

if (!new URL(config.databaseUrl).pathname.endsWith('_test')) {
  throw new Error(`Refusing to run tests against ${config.databaseUrl}: the database name must end with "_test"`)
}

await runMigrations()

afterAll(async () => {
  await rm(config.storage.uploadDir, { recursive: true, force: true })
})

process.on('beforeExit', () => {
  void Promise.allSettled([closeDb(), closeRedis()])
})
