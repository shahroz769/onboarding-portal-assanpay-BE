import { migrate } from "drizzle-orm/postgres-js/migrator";

import { getDb, getQueryClient } from "./client";

await migrate(getDb(), {
  migrationsFolder: "./drizzle",
});

await getQueryClient().end();

console.log("Migrations applied.");
