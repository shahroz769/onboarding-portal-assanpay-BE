import type { Context } from "hono";

import { AppError } from "../lib/errors";

export function errorHandler(error: Error, c: Context) {
  if (error instanceof AppError) {
    return c.json({ error: error.message }, error.statusCode as never);
  }

  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
}
