import { sql } from "drizzle-orm";
import { getDb, getQueryClient } from "./client";

const db = getDb();
await db.execute(sql`TRUNCATE cases, merchants RESTART IDENTITY CASCADE`);
await getQueryClient().end();
console.log("Cleaned up merchants and cases.");
