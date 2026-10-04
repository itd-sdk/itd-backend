import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { closeDb, db } from './client'

export async function runMigrations() {
  await migrate(db, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })
}

if (import.meta.main) {
  await runMigrations()
  console.log('migrations applied')
  await closeDb()
}
