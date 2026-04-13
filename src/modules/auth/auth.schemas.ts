import { z } from "zod";

import { roleTypes } from "../../types/auth";

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.toLowerCase()),
  username: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(2)
    .max(255)
    .optional(),
  email: z
    .string()
    .trim()
    .min(2)
    .max(255)
    .optional(),
  password: z.string().min(8).max(128),
}).transform((value, ctx) => {
  const identifier = value.identifier ?? value.email;

  if (!identifier) {
    ctx.addIssue({
      code: "custom",
      path: ["identifier"],
      message: "Username or email is required.",
    });

    return z.NEVER;
  }

  return {
    identifier: identifier.trim().toLowerCase(),
    password: value.password,
  };
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.toLowerCase()),
  username: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(128),
  roleType: z.enum(roleTypes),
  accessPolicyId: z.uuid().optional(),
});
