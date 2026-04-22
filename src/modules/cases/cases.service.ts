import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseComments,
  caseFieldReviews,
  caseHistory,
  cases,
  merchantDocuments,
  merchants,
  queues,
  queueCaseSequences,
  queueStages,
  users,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import {
  ensureQueueStages,
  getStatusForStage,
  resolveStageForCase,
} from '../queues/queue-stage-defaults'
import {
  notifyAssignment,
  notifyOnComment,
} from '../notifications/notifications.service'
import {
  caseStatusValues,
  isValidStatusTransition,
  type CaseStatusValue,
  type CloseUnsuccessfulInput,
  type CreateCaseInput,
  type CreateCommentInput,
  type ListCasesQuery,
  type SaveFieldReviewsInput,
  type UpdateCaseStatusInput,
} from './cases.schemas'

const caseStatusValueSet = new Set<string>(caseStatusValues)

function parseCsvValues<TValue extends string>(
  rawValue: string,
  allowedValues: ReadonlySet<string>,
) {
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(
      (value): value is TValue => value.length > 0 && allowedValues.has(value),
    )
}

// ─── Case Number Generation ─────────────────────────────────────────────────

async function generateCaseNumber(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  queueId: string,
): Promise<string> {
  // Get queue prefix
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, queueId),
    columns: { prefix: true },
  })

  if (!queue) {
    throw new AppError(404, 'Queue not found.')
  }

  // Atomically increment the sequence counter
  const [updated] = await tx
    .update(queueCaseSequences)
    .set({
      lastNumber: sql`${queueCaseSequences.lastNumber} + 1`,
    })
    .where(eq(queueCaseSequences.queueId, queueId))
    .returning({ lastNumber: queueCaseSequences.lastNumber })

  if (!updated) {
    throw new AppError(
      500,
      'Failed to generate case number. Queue sequence not found.',
    )
  }

  const paddedNumber = String(updated.lastNumber).padStart(9, '0')
  return `${queue.prefix}-${paddedNumber}`
}

// ─── Create Case ────────────────────────────────────────────────────────────

export async function createCase(input: CreateCaseInput) {
  const db = getDb()

  return db.transaction(async (tx) => {
    // Verify merchant exists
    const merchant = await tx.query.merchants.findFirst({
      where: eq(merchants.id, input.merchantId),
      columns: { id: true, businessName: true, priority: true },
    })

    if (!merchant) {
      throw new AppError(404, 'Merchant not found.')
    }

    // Verify queue exists
    const queue = await tx.query.queues.findFirst({
      where: eq(queues.id, input.queueId),
      columns: { id: true, name: true, qcEnabled: true },
    })

    if (!queue) {
      throw new AppError(404, 'Queue not found.')
    }

    const stages = await ensureQueueStages(tx, {
      id: queue.id,
      name: queue.name,
      qcEnabled: queue.qcEnabled ?? false,
    })
    const initialStage = stages[0]

    if (!initialStage) {
      throw new AppError(500, 'No initial stage configured for this queue.')
    }

    const caseNumber = await generateCaseNumber(tx, input.queueId)

    const [created] = await tx
      .insert(cases)
      .values({
        caseNumber,
        queueId: input.queueId,
        merchantId: input.merchantId,
        ownerId: null,
        currentStageId: initialStage.id,
        status: 'new',
        priority: merchant.priority,
        updatedAt: new Date(),
      })
      .returning()

    if (!created) {
      throw new AppError(500, 'Failed to create case.')
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
    }
  })
}

// ─── List Cases ─────────────────────────────────────────────────────────────

export async function listCases(query: ListCasesQuery) {
  const db = getDb()
  const conditions = []

  if (query.search) {
    const term = `%${query.search}%`
    conditions.push(
      or(ilike(cases.caseNumber, term), ilike(merchants.businessName, term))!,
    )
  }

  if (query.queueId) {
    conditions.push(eq(cases.queueId, query.queueId))
  }

  if (query.ownerId) {
    const ownerIds = query.ownerId
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    if (ownerIds.length > 0) {
      conditions.push(inArray(cases.ownerId, ownerIds))
    }
  }

  if (query.status) {
    const statuses = parseCsvValues<CaseStatusValue>(
      query.status,
      caseStatusValueSet,
    )
    if (statuses.length > 0) {
      conditions.push(inArray(cases.status, statuses))
    }
  }

  if (query.createdAtFrom) {
    const fromDate = new Date(query.createdAtFrom)
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gt(cases.createdAt, fromDate))
    }
  }

  if (query.createdAtTo) {
    const toDate = new Date(query.createdAtTo)
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lt(cases.createdAt, toDate))
    }
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const sortColumnMap = {
    caseNumber: cases.caseNumber,
    status: cases.status,
    createdAt: cases.createdAt,
    closedAt: cases.closedAt,
    updatedAt: cases.updatedAt,
    merchantName: sql`lower(${merchants.businessName})`,
  } as const

  const orderFn = query.sortOrder === 'desc' ? desc : asc
  const sortCol = sortColumnMap[query.sortBy] ?? cases.createdAt

  const offset = (query.page - 1) * query.perPage

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
  ])

  const totalCount = Number(totalRow?.count ?? 0)
  const totalPages = Math.ceil(totalCount / query.perPage)

  return {
    cases: rows,
    page: query.page,
    perPage: query.perPage,
    totalCount,
    totalPages,
  }
}

// ─── List Case Owners ───────────────────────────────────────────────────────

export async function listCaseOwners() {
  const db = getDb()

  const rows = await db
    .selectDistinct({
      id: users.id,
      name: users.name,
    })
    .from(cases)
    .innerJoin(users, eq(cases.ownerId, users.id))

  return rows
}

// ─── Bulk Assign Cases ──────────────────────────────────────────────────────

export async function bulkAssignCases(
  caseIds: string[],
  ownerId: string | null,
  actorId: string,
) {
  const db = getDb()
  const uniqueCaseIds = Array.from(new Set(caseIds))
  const nextOwner = ownerId
    ? await db.query.users.findFirst({
        where: eq(users.id, ownerId),
        columns: { id: true, name: true },
      })
    : null

  // Verify owner exists if provided
  if (ownerId && !nextOwner) {
    throw new AppError(404, 'User not found.')
  }

  const existingCases = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      ownerName: users.name,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(inArray(cases.id, uniqueCaseIds))

  if (existingCases.length !== uniqueCaseIds.length) {
    throw new AppError(404, 'One or more cases were not found.')
  }

  const updatedCases = await db
    .update(cases)
    .set({
      ownerId,
      updatedAt: new Date(),
    })
    .where(inArray(cases.id, uniqueCaseIds))
    .returning({ id: cases.id })

  const historyEntries = existingCases
    .filter((caseRecord) => caseRecord.ownerId !== ownerId)
    .map((caseRecord) => ({
      caseId: caseRecord.id,
      actorId,
      action: 'owner_changed',
      details: {
        fromOwner: caseRecord.ownerName ?? 'Unassigned',
        toOwner: nextOwner?.name ?? 'Unassigned',
      },
    }))

  if (historyEntries.length > 0) {
    await db.insert(caseHistory).values(historyEntries)

    // Notifications (best-effort) for each affected case
    try {
      const actor = await db.query.users.findFirst({
        where: eq(users.id, actorId),
        columns: { name: true },
      })
      const affectedIds = historyEntries.map((h) => h.caseId)
      const metas = await db
        .select({
          id: cases.id,
          caseNumber: cases.caseNumber,
          queueName: queues.name,
        })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(inArray(cases.id, affectedIds))
      const metaById = new Map(metas.map((m) => [m.id, m]))
      const previousById = new Map(
        existingCases.map((c) => [c.id, c.ownerId ?? null]),
      )
      await Promise.all(
        affectedIds.map((cid) => {
          const meta = metaById.get(cid)
          if (!meta) return Promise.resolve()
          return notifyAssignment({
            caseId: cid,
            caseNumber: meta.caseNumber,
            queueName: meta.queueName,
            actorId,
            actorName: actor?.name ?? 'Someone',
            newOwnerId: ownerId,
            previousOwnerId: previousById.get(cid) ?? null,
          })
        }),
      )
    } catch (error) {
      console.error('[notifications] bulkAssignCases notify failed', error)
    }
  }

  return { updated: updatedCases.length }
}

// ─── Update Case Status ─────────────────────────────────────────────────────

export async function updateCaseStatus(
  caseId: string,
  input: UpdateCaseStatusInput,
) {
  const db = getDb()

  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true, status: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const currentStatus = existing.status as CaseStatusValue

  if (!isValidStatusTransition(currentStatus, input.status)) {
    throw new AppError(
      400,
      `Invalid status transition from "${currentStatus}" to "${input.status}".`,
    )
  }

  const updateData: Record<string, unknown> = {
    status: input.status,
    updatedAt: new Date(),
  }

  // Auto-set closedAt when transitioning to closed
  if (input.status === 'closed' || input.status === 'error') {
    updateData.closedAt = new Date()
  }

  // Clear closedAt when re-opening from closed
  if (
    (currentStatus === 'closed' || currentStatus === 'error') &&
    input.status !== 'closed' &&
    input.status !== 'error'
  ) {
    updateData.closedAt = null
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
    })

  if (!updated) {
    throw new AppError(500, 'Failed to update case status.')
  }

  return updated
}

// ─── Assign Case ────────────────────────────────────────────────────────────

export async function assignCase(
  caseId: string,
  ownerId: string | null,
  actorId: string,
) {
  const db = getDb()
  const nextOwner = ownerId
    ? await db.query.users.findFirst({
        where: eq(users.id, ownerId),
        columns: { id: true, name: true },
      })
    : null

  // Verify case exists
  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      ownerName: users.name,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  const existingCase = existing[0]

  if (!existingCase) {
    throw new AppError(404, 'Case not found.')
  }

  // Verify owner exists if provided
  if (ownerId && !nextOwner) {
    throw new AppError(404, 'User not found.')
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
    })

  if (!updated) {
    throw new AppError(500, 'Failed to assign case.')
  }

  if (existingCase.ownerId !== ownerId) {
    await db.insert(caseHistory).values({
      caseId,
      actorId,
      action: 'owner_changed',
      details: {
        fromOwner: existingCase.ownerName ?? 'Unassigned',
        toOwner: nextOwner?.name ?? 'Unassigned',
      },
    })

    // Notifications (best-effort)
    try {
      const meta = await db
        .select({ caseNumber: cases.caseNumber, queueName: queues.name })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(eq(cases.id, caseId))
        .limit(1)
      const actor = await db.query.users.findFirst({
        where: eq(users.id, actorId),
        columns: { name: true },
      })
      if (meta[0]) {
        await notifyAssignment({
          caseId,
          caseNumber: meta[0].caseNumber,
          queueName: meta[0].queueName,
          actorId,
          actorName: actor?.name ?? 'Someone',
          newOwnerId: ownerId,
          previousOwnerId: existingCase.ownerId ?? null,
        })
      }
    } catch (error) {
      console.error('[notifications] assignCase notify failed', error)
    }
  }

  return updated
}

// ─── Update Case Priority ────────────────────────────────────────────────────

export async function updateCasePriority(
  caseId: string,
  priority: 'normal' | 'high',
) {
  const db = getDb()

  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const [updated] = await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(eq(cases.id, caseId))
    .returning({
      id: cases.id,
      priority: cases.priority,
      updatedAt: cases.updatedAt,
    })

  if (!updated) {
    throw new AppError(500, 'Failed to update case priority.')
  }

  return updated
}

// ─── Cascade Merchant Priority to Cases ──────────────────────────────────────

export async function cascadeMerchantPriority(
  merchantId: string,
  priority: 'normal' | 'high',
) {
  const db = getDb()

  await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(eq(cases.merchantId, merchantId))
}

// ─── Get Case Detail ────────────────────────────────────────────────────────

export async function getCaseDetail(caseId: string) {
  const db = getDb()

  // Get case with joins
  const caseRow = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      ownerId: cases.ownerId,
      ownerName: users.name,
      currentStageId: cases.currentStageId,
      status: cases.status,
      priority: cases.priority,
      closeOutcome: cases.closeOutcome,
      closeReason: cases.closeReason,
      closedAt: cases.closedAt,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!caseRow[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = caseRow[0]

  // Fetch all related data in parallel
  const [queue, stagesResult, merchant, documents, fieldReviews] = await Promise.all([
    db.query.queues.findFirst({
      where: eq(queues.id, caseData.queueId),
    }),
    db
      .select()
      .from(queueStages)
      .where(eq(queueStages.queueId, caseData.queueId))
      .orderBy(asc(queueStages.order)),
    db.query.merchants.findFirst({
      where: eq(merchants.id, caseData.merchantId),
    }),
    db
      .select()
      .from(merchantDocuments)
      .where(eq(merchantDocuments.merchantId, caseData.merchantId)),
    db
      .select({
        id: caseFieldReviews.id,
        fieldName: caseFieldReviews.fieldName,
        status: caseFieldReviews.status,
        remarks: caseFieldReviews.remarks,
        reviewedBy: caseFieldReviews.reviewedBy,
        reviewedByName: users.name,
        updatedAt: caseFieldReviews.updatedAt,
      })
      .from(caseFieldReviews)
      .leftJoin(users, eq(caseFieldReviews.reviewedBy, users.id))
      .where(eq(caseFieldReviews.caseId, caseId)),
  ])

  if (!queue || !merchant) {
    throw new AppError(500, 'Case data integrity error.')
  }

  const stages =
    stagesResult.length > 0
      ? stagesResult
      : await ensureQueueStages(db, {
          id: queue.id,
          name: queue.name,
          qcEnabled: queue.qcEnabled,
        })

  const currentStage =
    resolveStageForCase({
      stages,
      currentStageId: caseData.currentStageId,
      status: caseData.status as CaseStatusValue,
    }) ?? null

  if (currentStage && currentStage.id !== caseData.currentStageId) {
    await db
      .update(cases)
      .set({
        currentStageId: currentStage.id,
        updatedAt: new Date(),
      })
      .where(eq(cases.id, caseId))
  }

  return {
    case: {
      id: caseData.id,
      caseNumber: caseData.caseNumber,
      status: caseData.status,
      priority: caseData.priority,
      closeOutcome: caseData.closeOutcome,
      closeReason: caseData.closeReason,
      closedAt: caseData.closedAt,
      createdAt: caseData.createdAt,
      updatedAt: caseData.updatedAt,
    },
    currentStage,
    stages,
    queue: {
      id: queue.id,
      name: queue.name,
      slug: queue.slug,
      qcEnabled: queue.qcEnabled,
    },
    merchant,
    documents,
    fieldReviews,
    owner: caseData.ownerId
      ? { id: caseData.ownerId, name: caseData.ownerName ?? 'Unknown' }
      : null,
  }
}

// ─── Take Ownership ─────────────────────────────────────────────────────────

export async function takeOwnership(caseId: string, userId: string) {
  const db = getDb()
  const actor = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { name: true },
  })

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId) {
    throw new AppError(400, 'Case already has an owner.')
  }

  // Verify current stage is category 'new'
  const currentStage = caseData.currentStageId
    ? await db.query.queueStages.findFirst({
        where: eq(queueStages.id, caseData.currentStageId),
      })
    : null

  if (!currentStage || currentStage.category !== 'new') {
    throw new AppError(400, 'Case is not in the initial stage.')
  }

  // Find next stage (first in_progress stage)
  const nextStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseData.queueId),
      gt(queueStages.order, currentStage.order),
    ),
    orderBy: asc(queueStages.order),
  })

  if (!nextStage) {
    throw new AppError(500, 'No next stage configured for this queue.')
  }

  const newStatus = getStatusForStage(nextStage)

  const [updated] = await db
    .update(cases)
    .set({
      ownerId: userId,
      currentStageId: nextStage.id,
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(eq(cases.id, caseId))
    .returning()

  // Record history
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'ownership_taken',
    details: {
      fromStage: currentStage.name,
      toStage: nextStage.name,
      fromOwner: 'Unassigned',
      toOwner: actor?.name ?? 'Assigned',
    },
  })

  return updated
}

// ─── Advance Stage ──────────────────────────────────────────────────────────

export async function advanceStage(caseId: string, userId: string) {
  const db = getDb()

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can advance the stage.')
  }

  if (!caseData.currentStageId) {
    throw new AppError(400, 'Case has no current stage.')
  }

  const currentStage = await db.query.queueStages.findFirst({
    where: eq(queueStages.id, caseData.currentStageId),
  })

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(400, 'Case can only be advanced from an in-progress stage.')
  }

  // Get queue for qcEnabled check
  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
    columns: { qcEnabled: true },
  })

  // Find next stage by order
  const nextStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseData.queueId),
      gt(queueStages.order, currentStage.order),
    ),
    orderBy: asc(queueStages.order),
  })

  if (!nextStage) {
    throw new AppError(500, 'No next stage configured.')
  }

  // If next stage is QC and qcEnabled is false, skip to the closed stage
  let targetStage = nextStage
  if (nextStage.category === 'qc' && !queue?.qcEnabled) {
    const closedStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })
    if (!closedStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
    targetStage = closedStage
  }

  const newStatus = getStatusForStage(targetStage)
  const now = new Date()

  const updateData: Record<string, unknown> = {
    currentStageId: targetStage.id,
    status: newStatus,
    updatedAt: now,
  }

  // If advancing to closed, mark successful
  if (targetStage.category === 'closed') {
    updateData.closeOutcome = 'successful'
    updateData.closedAt = now
  }

  const [updated] = await db
    .update(cases)
    .set(updateData)
    .where(eq(cases.id, caseId))
    .returning()

  // Record history
  const action = targetStage.category === 'closed' ? 'closed_successful' : 'stage_advanced'
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action,
    details: { fromStage: currentStage.name, toStage: targetStage.name },
  })

  return updated
}

// ─── Save Field Reviews ─────────────────────────────────────────────────────

export async function saveFieldReviews(
  caseId: string,
  userId: string,
  input: SaveFieldReviewsInput,
) {
  const db = getDb()

  // Validate case state
  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can save field reviews.')
  }

  if (!caseData.currentStageId) {
    throw new AppError(400, 'Case has no current stage.')
  }

  const currentStage = await db.query.queueStages.findFirst({
    where: eq(queueStages.id, caseData.currentStageId),
  })

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(400, 'Field reviews can only be saved in an in-progress stage.')
  }

  // Upsert field reviews
  const now = new Date()
  for (const review of input.reviews) {
    await db
      .insert(caseFieldReviews)
      .values({
        caseId,
        fieldName: review.fieldName,
        status: review.status,
        remarks: review.remarks ?? null,
        reviewedBy: userId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [caseFieldReviews.caseId, caseFieldReviews.fieldName],
        set: {
          status: review.status,
          remarks: review.remarks ?? null,
          reviewedBy: userId,
          updatedAt: now,
        },
      })
  }

  // Record history
  const rejected = input.reviews.filter((r) => r.status === 'rejected').length
  const approved = input.reviews.filter((r) => r.status === 'approved').length
  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'field_reviews_saved',
    details: { total: input.reviews.length, approved, rejected },
  })

  return { saved: input.reviews.length }
}

// ─── Close Unsuccessful ─────────────────────────────────────────────────────

export async function closeUnsuccessful(
  caseId: string,
  userId: string,
  input: CloseUnsuccessfulInput,
) {
  const db = getDb()

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can close the case.')
  }

  // Verify not already closed
  if (caseData.currentStageId) {
    const currentStage = await db.query.queueStages.findFirst({
      where: eq(queueStages.id, caseData.currentStageId),
    })
    if (currentStage?.category === 'closed' || currentStage?.category === 'error') {
      throw new AppError(400, 'Case is already in a terminal stage.')
    }
  }

  // Find error stage for this queue
  const errorStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseData.queueId),
      eq(queueStages.category, 'error'),
    ),
  })

  if (!errorStage) {
    throw new AppError(500, 'No error stage configured for this queue.')
  }

  const now = new Date()
  const [updated] = await db
    .update(cases)
    .set({
      currentStageId: errorStage.id,
      status: 'error',
      closeOutcome: 'unsuccessful',
      closeReason: input.reason,
      closedAt: now,
      updatedAt: now,
    })
    .where(eq(cases.id, caseId))
    .returning()

  await db.insert(caseHistory).values({
    caseId,
    actorId: userId,
    action: 'closed_unsuccessful',
    details: { reason: input.reason },
  })

  return updated
}

// ─── Case Comments ──────────────────────────────────────────────────────────

export async function listCaseComments(caseId: string) {
  const db = getDb()

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const comments = await db
    .select({
      id: caseComments.id,
      caseId: caseComments.caseId,
      authorId: caseComments.authorId,
      authorName: users.name,
      authorUsername: users.username,
      content: caseComments.content,
      parentId: caseComments.parentId,
      mentions: caseComments.mentions,
      createdAt: caseComments.createdAt,
      updatedAt: caseComments.updatedAt,
    })
    .from(caseComments)
    .leftJoin(users, eq(caseComments.authorId, users.id))
    .where(eq(caseComments.caseId, caseId))
    .orderBy(asc(caseComments.createdAt))

  return comments
}

export async function createCaseComment(
  caseId: string,
  userId: string,
  input: CreateCommentInput,
) {
  const db = getDb()

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  // Verify parent comment exists if provided
  if (input.parentId) {
    const parent = await db.query.caseComments.findFirst({
      where: and(
        eq(caseComments.id, input.parentId),
        eq(caseComments.caseId, caseId),
      ),
      columns: { id: true },
    })
    if (!parent) {
      throw new AppError(404, 'Parent comment not found.')
    }
  }

  const [created] = await db
    .insert(caseComments)
    .values({
      caseId,
      authorId: userId,
      content: input.content,
      parentId: input.parentId ?? null,
      mentions: input.mentions ?? null,
    })
    .returning()

  // Notifications (best-effort)
  if (created) {
    try {
      await notifyOnComment({
        caseId,
        commentId: created.id,
        parentCommentId: input.parentId ?? null,
        authorId: userId,
        mentions: input.mentions ?? [],
        content: input.content,
      })
    } catch (error) {
      console.error('[notifications] createCaseComment notify failed', error)
    }
  }

  return created
}

// ─── Case History ───────────────────────────────────────────────────────────

export async function listCaseHistory(caseId: string) {
  const db = getDb()

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const history = await db
    .select({
      id: caseHistory.id,
      caseId: caseHistory.caseId,
      actorId: caseHistory.actorId,
      actorName: users.name,
      action: caseHistory.action,
      details: caseHistory.details,
      createdAt: caseHistory.createdAt,
    })
    .from(caseHistory)
    .leftJoin(users, eq(caseHistory.actorId, users.id))
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        sql`${caseHistory.action} <> 'comment_added'`,
      ),
    )
    .orderBy(desc(caseHistory.createdAt))

  return history
}
