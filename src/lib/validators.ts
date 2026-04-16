import type { ValidationTargets } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";

import { AppError } from "./errors";

export function zodValidator<
  TTarget extends keyof ValidationTargets,
  TSchema extends z.ZodTypeAny,
>(target: TTarget, schema: TSchema) {
  return validator(target, (value) => {
    const parsed = schema.safeParse(value);

    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.issues[0]?.message ?? `Invalid ${target} payload.`,
      );
    }

    return parsed.data;
  });
}
