import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

let client: ReturnType<typeof postgres> | null = null;
let database:
  | ReturnType<typeof drizzle<typeof schema>>
  | null = null;

function getDatabaseUrl() {
  const databaseUrl = Bun.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set.");
  }

  return databaseUrl;
}

export function getQueryClient() {
  if (!client) {
    client = postgres(getDatabaseUrl(), {
      max: 1,
    });
  }

  return client;
}

export function getDb() {
  if (!database) {
    database = drizzle(getQueryClient(), { schema });
  }

  return database;
}
