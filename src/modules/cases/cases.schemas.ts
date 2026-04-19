import { z } from "zod";

export const caseStatusValues = ["new", "working", "pending", "qc", "closed"] as const;
export type CaseStatusValue = (typeof caseStatusValues)[number];

// Ordered index for transition validation
const statusOrder: Record<CaseStatusValue, number> = {
  new: 0,
  working: 1,
  pending: 2,
  qc: 3,
  closed: 4,
};

/**
 * Validates that a status transition is allowed.
 * Forward transitions: any forward step is allowed.
 * Backward transitions: only one step back is allowed.
 */
export function isValidStatusTransition(
  current: CaseStatusValue,
  next: CaseStatusValue,
): boolean {
  if (current === next) return false;
  const currentIdx = statusOrder[current];
  const nextIdx = statusOrder[next];

  // Forward: any jump forward is allowed
  if (nextIdx > currentIdx) return true;

  // Backward: only one step back
  if (currentIdx - nextIdx === 1) return true;

  return false;
}

// ─── Request Schemas ────────────────────────────────────────────────────────

export const createCaseSchema = z
  .object({
    merchantId: z.string().uuid(),
    queueId: z.string().uuid(),
  })
  .strict();

export type CreateCaseInput = z.infer<typeof createCaseSchema>;

export const updateCaseStatusSchema = z
  .object({
    status: z.enum(caseStatusValues),
  })
  .strict();

export type UpdateCaseStatusInput = z.infer<typeof updateCaseStatusSchema>;

export const assignCaseSchema = z
  .object({
    ownerId: z.string().uuid().nullable(),
  })
  .strict();

export type AssignCaseInput = z.infer<typeof assignCaseSchema>;

export const bulkAssignCaseSchema = z
  .object({
    ids: z.array(z.string().uuid()).min(1),
    ownerId: z.string().uuid().nullable(),
  })
  .strict();

export type BulkAssignCaseInput = z.infer<typeof bulkAssignCaseSchema>;

export const updateCasePrioritySchema = z
  .object({
    priority: z.enum(["normal", "high"]),
  })
  .strict();

export type UpdateCasePriorityInput = z.infer<typeof updateCasePrioritySchema>;

export const listCasesQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(30),
  search: z.string().optional(),
  queueId: z.string().uuid().optional(),
  ownerId: z.string().optional(),
  status: z.string().optional(),
  sortBy: z
    .enum(["caseNumber", "status", "createdAt", "closedAt", "updatedAt", "merchantName"])
    .default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  createdAtFrom: z.string().optional(),
  createdAtTo: z.string().optional(),
});

export type ListCasesQuery = z.infer<typeof listCasesQuerySchema>;
