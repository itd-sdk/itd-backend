import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { config } from '../config'
import * as schema from './schema'

export const sqlClient = postgres(config.databaseUrl, {
  max: config.databasePoolSize,
  onnotice: () => {},
  // timestamps are returned as JS Dates by drizzle; keep server timezone neutral
  connection: { TimeZone: 'UTC' }
})

export const db = drizzle(sqlClient, { schema, casing: 'snake_case' })

export type Database = typeof db
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
export type Executor = Database | Transaction

export async function closeDb() {
  await sqlClient.end({ timeout: 5 })
}
