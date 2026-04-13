import type { Context } from "hono";

import { AppError } from "../lib/errors";

export function errorHandler(error: Error, c: Context) {
  if (error instanceof AppError) {
    return c.json(
      { error: error.message },
      { status: error.statusCode as 400 | 401 | 403 | 404 | 409 | 500 },
    );
  }

  console.error(error);
  return c.json({ error: "Internal server error." }, 500);
}
