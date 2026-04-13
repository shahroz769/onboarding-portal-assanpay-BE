import { z } from "zod";

import { roleTypes } from "../../types/auth";

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.toLowerCase()),
  employeeId: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(128),
});

export const loginSchema = z.object({
  email: z.email().transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
});

export const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().transform((value) => value.toLowerCase()),
  employeeId: z.string().trim().min(2).max(64),
  password: z.string().min(8).max(128),
  roleType: z.enum(roleTypes),
  accessPolicyId: z.uuid().optional(),
});
