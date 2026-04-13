import type { z } from "zod";

import { AppError } from "./errors";

export async function parseJsonBody<TSchema extends z.ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  const json = await request.json().catch(() => {
    throw new AppError(400, "Invalid JSON body.");
  });

  const parsed = schema.safeParse(json);

  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues[0]?.message ?? "Invalid request body.");
  }

  return parsed.data;
}
