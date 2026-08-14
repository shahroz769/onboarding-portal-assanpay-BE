import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { env } from '../config/env'
import * as schema from './schema'

let client: ReturnType<typeof postgres> | null = null
let database: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getQueryClient() {
  if (!client) {
    client = postgres(env.DATABASE_URL, {
      max: env.DATABASE_POOL_MAX,
      connect_timeout: env.DATABASE_CONNECT_TIMEOUT_SECONDS,
      idle_timeout: env.DATABASE_IDLE_TIMEOUT_SECONDS,
      // Neon and PlanetScale pooled endpoints use transaction pooling. Avoid
      // session-bound prepared statements because transactions may switch servers.
      prepare: false,
    })
  }

  return client
}

export function getDb() {
  if (!database) {
    database = drizzle(getQueryClient(), { schema })
  }

  return database
}

export async function closeQueryClient() {
  if (!client) return

  const currentClient = client
  client = null
  database = null
  await currentClient.end({ timeout: 5 })
}
