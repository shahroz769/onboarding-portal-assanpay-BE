import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { getDb } from "../../db/client";
import { cases, merchants, queues, queueCaseSequences, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import {
  caseStatusValues,
  isValidStatusTransition,
  type CaseStatusValue,
  type CreateCaseInput,
  type ListCasesQuery,
  type UpdateCaseStatusInput,
} from "./cases.schemas";

const caseStatusValueSet = new Set<string>(caseStatusValues);

function parseCsvValues<TValue extends string>(
  rawValue: string,
  allowedValues: ReadonlySet<string>,
) {
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is TValue => value.length > 0 && allowedValues.has(value));
}

// ─── Case Number Generation ─────────────────────────────────────────────────

async function generateCaseNumber(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  queueId: string,
): Promise<string> {
  // Get queue prefix
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, queueId),
    columns: { prefix: true },
  });

  if (!queue) {
    throw new AppError(404, "Queue not found.");
  }

  // Atomically increment the sequence counter
  const [updated] = await tx
    .update(queueCaseSequences)
    .set({
      lastNumber: sql`${queueCaseSequences.lastNumber} + 1`,
    })
    .where(eq(queueCaseSequences.queueId, queueId))
    .returning({ lastNumber: queueCaseSequences.lastNumber });

  if (!updated) {
    throw new AppError(500, "Failed to generate case number. Queue sequence not found.");
  }

  const paddedNumber = String(updated.lastNumber).padStart(9, "0");
  return `${queue.prefix}-${paddedNumber}`;
}

// ─── Create Case ────────────────────────────────────────────────────────────

export async function createCase(input: CreateCaseInput) {
  const db = getDb();

  return db.transaction(async (tx) => {
    // Verify merchant exists
    const merchant = await tx.query.merchants.findFirst({
      where: eq(merchants.id, input.merchantId),
      columns: { id: true, businessName: true, priority: true },
    });

    if (!merchant) {
      throw new AppError(404, "Merchant not found.");
    }

    // Verify queue exists
    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, input.queueId),
      columns: { id: true, name: true },
    });

    if (!queue) {
      throw new AppError(404, "Queue not found.");
    }

    const caseNumber = await generateCaseNumber(tx, input.queueId);

    const [created] = await tx
      .insert(cases)
      .values({
        caseNumber,
        queueId: input.queueId,
        merchantId: input.merchantId,
        ownerId: null,
        status: "new",
        priority: merchant.priority,
        updatedAt: new Date(),
      })
      .returning();

    if (!created) {
      throw new AppError(500, "Failed to create case.");
    }

    return {
      id: created.id,
      caseNumber: created.caseNumber,
      queueId: created.queueId,
      queueName: queue.name,
      merchantId: created.merchantId,
      merchantName: merchant.businessName,
      ownerId: created.ownerId,
      ownerName: null as string | null,
      status: created.status,
      priority: created.priority,
      closedAt: created.closedAt,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  });
}

// ─── List Cases ─────────────────────────────────────────────────────────────

export async function listCases(query: ListCasesQuery) {
  const db = getDb();
  const conditions = [];

  if (query.search) {
    const term = `%${query.search}%`;
    conditions.push(
      or(
        ilike(cases.caseNumber, term),
        ilike(merchants.businessName, term),
      )!,
    );
  }

  if (query.queueId) {
    conditions.push(eq(cases.queueId, query.queueId));
  }

  if (query.ownerId) {
    const ownerIds = query.ownerId.split(",").map((id) => id.trim()).filter(Boolean);
    if (ownerIds.length > 0) {
      conditions.push(inArray(cases.ownerId, ownerIds));
    }
  }

  if (query.status) {
    const statuses = parseCsvValues<CaseStatusValue>(query.status, caseStatusValueSet);
    if (statuses.length > 0) {
      conditions.push(inArray(cases.status, statuses));
    }
  }

  if (query.createdAtFrom) {
    const fromDate = new Date(query.createdAtFrom);
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gt(cases.createdAt, fromDate));
    }
  }

  if (query.createdAtTo) {
    const toDate = new Date(query.createdAtTo);
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lt(cases.createdAt, toDate));
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumnMap = {
    caseNumber: cases.caseNumber,
    status: cases.status,
    createdAt: cases.createdAt,
    closedAt: cases.closedAt,
    updatedAt: cases.updatedAt,
    merchantName: sql`lower(${merchants.businessName})`,
  } as const;

  const orderFn = query.sortOrder === "desc" ? desc : asc;
  const sortCol = sortColumnMap[query.sortBy] ?? cases.createdAt;

  const offset = (query.page - 1) * query.perPage;

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        queueId: cases.queueId,
        queueName: queues.name,
        merchantId: cases.merchantId,
        merchantName: merchants.businessName,
        ownerId: cases.ownerId,
        ownerName: users.name,
        status: cases.status,
        priority: cases.priority,
        closedAt: cases.closedAt,
        createdAt: cases.createdAt,
        updatedAt: cases.updatedAt,
      })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(where)
      .orderBy(orderFn(sortCol), orderFn(cases.id))
      .limit(query.perPage)
      .offset(offset),
    db
      .select({ count: count() })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(where),
  ]);

  const totalCount = Number(totalRow?.count ?? 0);
  const totalPages = Math.ceil(totalCount / query.perPage);

  return {
    cases: rows,
    page: query.page,
    perPage: query.perPage,
    totalCount,
    totalPages,
  };
}

// ─── List Case Owners ───────────────────────────────────────────────────────

export async function listCaseOwners() {
  const db = getDb();

  const rows = await db
    .selectDistinct({
      id: users.id,
      name: users.name,
    })
    .from(cases)
    .innerJoin(users, eq(cases.ownerId, users.id));

  return rows;
}

// ─── Bulk Assign Cases ──────────────────────────────────────────────────────

export async function bulkAssignCases(caseIds: string[], ownerId: string | null) {
  const db = getDb();

  // Verify owner exists if provided
  if (ownerId) {
    const owner = await db.query.users.findFirst({
      where: eq(users.id, ownerId),
      columns: { id: true },
    });

    if (!owner) {
      throw new AppError(404, "User not found.");
    }
  }

  await db
    .update(cases)
    .set({
      ownerId,
      updatedAt: new Date(),
    })
    .where(inArray(cases.id, caseIds));

  return { updated: caseIds.length };
}

// ─── Update Case Status ─────────────────────────────────────────────────────

export async function updateCaseStatus(
  caseId: string,
  input: UpdateCaseStatusInput,
) {
  const db = getDb();

  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true, status: true },
  });

  if (!existing) {
    throw new AppError(404, "Case not found.");
  }

  const currentStatus = existing.status as CaseStatusValue;

  if (!isValidStatusTransition(currentStatus, input.status)) {
    throw new AppError(
      400,
      `Invalid status transition from "${currentStatus}" to "${input.status}".`,
    );
  }

  const updateData: Record<string, unknown> = {
    status: input.status,
    updatedAt: new Date(),
  };

  // Auto-set closedAt when transitioning to closed
  if (input.status === "closed") {
    updateData.closedAt = new Date();
  }

  // Clear closedAt when re-opening from closed
  if (currentStatus === "closed" && input.status !== "closed") {
    updateData.closedAt = null;
  }

  const [updated] = await db
    .update(cases)
    .set(updateData)
    .where(eq(cases.id, caseId))
    .returning({
      id: cases.id,
      status: cases.status,
      closedAt: cases.closedAt,
      updatedAt: cases.updatedAt,
    });

  if (!updated) {
    throw new AppError(500, "Failed to update case status.");
  }

  return updated;
}

// ─── Assign Case ────────────────────────────────────────────────────────────

export async function assignCase(caseId: string, ownerId: string | null) {
  const db = getDb();

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  });

  if (!existing) {
    throw new AppError(404, "Case not found.");
  }

  // Verify owner exists if provided
  if (ownerId) {
    const owner = await db.query.users.findFirst({
      where: eq(users.id, ownerId),
      columns: { id: true },
    });

    if (!owner) {
      throw new AppError(404, "User not found.");
    }
  }

  const [updated] = await db
    .update(cases)
    .set({
      ownerId,
      updatedAt: new Date(),
    })
    .where(eq(cases.id, caseId))
    .returning({
      id: cases.id,
      ownerId: cases.ownerId,
      updatedAt: cases.updatedAt,
    });

  if (!updated) {
    throw new AppError(500, "Failed to assign case.");
  }

  return updated;
}

// ─── Update Case Priority ────────────────────────────────────────────────────

export async function updateCasePriority(
  caseId: string,
  priority: "normal" | "high",
) {
  const db = getDb();

  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  });

  if (!existing) {
    throw new AppError(404, "Case not found.");
  }

  const [updated] = await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(eq(cases.id, caseId))
    .returning({ id: cases.id, priority: cases.priority, updatedAt: cases.updatedAt });

  if (!updated) {
    throw new AppError(500, "Failed to update case priority.");
  }

  return updated;
}

// ─── Cascade Merchant Priority to Cases ──────────────────────────────────────

export async function cascadeMerchantPriority(
  merchantId: string,
  priority: "normal" | "high",
) {
  const db = getDb();

  await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(eq(cases.merchantId, merchantId));
}
