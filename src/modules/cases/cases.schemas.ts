import { z } from "zod";

export const caseStatusValues = ["new", "working", "pending", "qc", "error", "closed"] as const;
export type CaseStatusValue = (typeof caseStatusValues)[number];

// Ordered index for transition validation
const statusOrder: Record<CaseStatusValue, number> = {
  new: 0,
  working: 1,
  pending: 2,
  qc: 3,
  error: 4,
  closed: 5,
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

// ─── Stage-based Schemas ────────────────────────────────────────────────────

export const stageCategoryValues = ["new", "in_progress", "qc", "error", "closed"] as const;
export type StageCategoryValue = (typeof stageCategoryValues)[number];

/**
 * Maps stage category to the legacy status column for backward compat.
 */
export function categoryToStatus(category: StageCategoryValue): CaseStatusValue {
  switch (category) {
    case "new":
      return "new";
    case "in_progress":
      return "working";
    case "qc":
      return "qc";
    case "error":
      return "error";
    case "closed":
      return "closed";
  }
}

// ─── Field Review Schemas ───────────────────────────────────────────────────

export const fieldReviewStatusValues = ["pending", "approved", "rejected"] as const;
export type FieldReviewStatusValue = (typeof fieldReviewStatusValues)[number];

export const fieldReviewItemSchema = z.object({
  fieldName: z.string().min(1).max(120),
  status: z.enum(fieldReviewStatusValues),
  remarks: z.string().max(2000).optional(),
});

export const saveFieldReviewsSchema = z
  .object({
    reviews: z.array(fieldReviewItemSchema).min(1).max(200),
  })
  .strict()
  .refine(
    (data) =>
      data.reviews.every(
        (r) => r.status !== "rejected" || (r.remarks && r.remarks.trim().length > 0),
      ),
    { message: "Remarks are required for rejected fields." },
  );

export type SaveFieldReviewsInput = z.infer<typeof saveFieldReviewsSchema>;

// ─── Close Unsuccessful Schema ──────────────────────────────────────────────

export const closeUnsuccessfulSchema = z
  .object({
    reason: z.string().min(1).max(2000),
  })
  .strict();

export type CloseUnsuccessfulInput = z.infer<typeof closeUnsuccessfulSchema>;

// ─── Comment Schemas ────────────────────────────────────────────────────────

export const createCommentSchema = z
  .object({
    content: z.string().min(1).max(5000),
    parentId: z.string().uuid().optional(),
    mentions: z.array(z.string().uuid()).max(20).optional(),
  })
  .strict();

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
