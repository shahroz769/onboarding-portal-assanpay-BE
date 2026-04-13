import { z } from "zod";

import { roleTypes } from "../../types/auth";

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    username: z.string().trim().min(2).max(64).optional(),
    roleType: z.enum(roleTypes).optional(),
    status: z.enum(["active", "inactive"]).optional(),
    accessPolicyId: z.uuid().nullable().optional(),
    password: z.string().min(8).max(128).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required.",
  });
