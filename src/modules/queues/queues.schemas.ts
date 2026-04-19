import { z } from "zod";

export const createQueueSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
      message: "Slug must be lowercase alphanumeric with hyphens.",
    }),
    prefix: z
      .string()
      .min(1)
      .max(4)
      .regex(/^[A-Z]{1,4}$/, { message: "Prefix must be 1-4 uppercase letters." }),
  })
  .strict();

export type CreateQueueInput = z.infer<typeof createQueueSchema>;
