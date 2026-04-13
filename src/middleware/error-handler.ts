import type { Context, Next } from "hono";

import { AppError } from "../lib/errors";

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    if (error instanceof AppError) {
      return c.json(
        { error: error.message },
        { status: error.statusCode as 400 | 401 | 403 | 404 | 409 | 500 },
      );
    }

    console.error(error);
    return c.json({ error: "Internal server error." }, 500);
  }
}
