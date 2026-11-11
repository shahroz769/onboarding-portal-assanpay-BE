import { and, asc, eq, gt } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { cases, merchants, queues, queueStages } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { resolveUniqueStageForStatus } from '../queues/queue-stage-defaults'
import { isManualStatusChangeAllowed } from './case-state-machine'
import {
  LIVE_WITHOUT_TESTING_MESSAGE,
  writeMerchantState,
} from '../merchants/merchant-state-machine'
import type {
  CaseStatusValue,
  CloseUnsuccessfulInput,
  UpdateCaseStatusInput,
} from './cases.schemas'
import { isCaseSlaBreached } from './case-sla'
import { assertCanWorkCase } from './case-access.service'
import {
  loadQueueStageForCase,
  transitionCaseState,
} from './case-transition.service'
import {
  closeOnlyFromWorkingMessage,
  getCloseChecklistBlockers,
  hasCloseChecklist,
  loadCloseChecklistFacts,
} from './case-close-checklist'

export async function updateCaseStatus(
  caseId: string,
  userId: string,
  input: UpdateCaseStatusInput,
) {
  const db = getDb()

  const [existing] = await db
    .select({
      id: cases.id,
      status: cases.status,
      merchantId: cases.merchantId,
      queueId: cases.queueId,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  if (existing.ownerId !== userId) {
    throw new AppError(
      403,
      'Only the current case owner can work on this case.',
    )
  }
  await assertCanWorkCase(caseId, userId)

  const currentStatus = existing.status as CaseStatusValue

  if (!isManualStatusChangeAllowed(currentStatus, input.status)) {
    throw new AppError(
      400,
      `Invalid status transition from "${currentStatus}" to "${input.status}".`,
    )
  }

  const stages = await db.query.queueStages.findMany({
    where: eq(queueStages.queueId, existing.queueId),
    orderBy: [asc(queueStages.order)],
  })

  const targetStage = resolveUniqueStageForStatus(stages, input.status)

  const updated = await transitionCaseState({
    event: 'manual_resume',
    caseId,
    actorId: userId,
    targetStage,
    requireOwner: true,
    checkCloseBlockers: false,
    historyAction: 'status_updated',
    historyDetails: {
      fromStatus: currentStatus,
      toStatus: input.status,
      fromStageId: existing.currentStageId,
      toStageId: targetStage.id,
      toStage: targetStage.name,
    },
    expected: {
      status: currentStatus,
      currentStageId: existing.currentStageId,
      ownerId: userId,
    },
    conflictMessage: 'Case status was already updated.',
  })

  return {
    id: updated.id,
    status: updated.status,
    slaBreached: updated.slaBreached,
    closedAt: updated.closedAt,
    updatedAt: updated.updatedAt,
  }
}

// ─── Assign Case ────────────────────────────────────────────────────────────

export async function advanceStage(caseId: string, userId: string) {
  const db = getDb()

  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      caseNumber: cases.caseNumber,
      status: cases.status,
      priority: cases.priority,
      createdAt: cases.createdAt,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (caseData.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can advance the stage.')
  }
  await assertCanWorkCase(caseId, userId)

  if (!caseData.currentStageId) {
    throw new AppError(400, 'Case has no current stage.')
  }

  const currentStageId = caseData.currentStageId

  const [currentStage, queue] = await Promise.all([
    loadQueueStageForCase(db, currentStageId, caseData.queueId),
    db.query.queues.findFirst({
      where: eq(queues.id, caseData.queueId),
      columns: {
        slug: true,
        workflowType: true,
        slaHours: true,
      },
    }),
  ])

  if (!currentStage || currentStage.category !== 'in_progress') {
    throw new AppError(
      400,
      'Case can only be advanced from an in-progress stage.',
    )
  }

  if (!queue) {
    throw new AppError(500, 'Case queue is not configured.')
  }

  let targetStage = null

  if (hasCloseChecklist(queue.workflowType)) {
    if (caseData.status !== 'working' || currentStage.slug !== 'working') {
      throw new AppError(400, closeOnlyFromWorkingMessage(queue.workflowType))
    }

    const [blocker] = getCloseChecklistBlockers(
      await loadCloseChecklistFacts({
        workflowType: queue.workflowType,
        caseId,
        merchantId: caseData.merchantId,
        actorId: userId,
      }),
    )
    if (blocker) {
      throw new AppError(400, blocker)
    }

    targetStage = await db.query.queueStages.findFirst({
      where: and(
        eq(queueStages.queueId, caseData.queueId),
        eq(queueStages.category, 'closed'),
      ),
    })

    if (!targetStage) {
      throw new AppError(500, 'No closed stage configured.')
    }
  } else {
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

    targetStage = nextStage
  }

  const now = new Date()

  const extraFields: {
    closeOutcome?: 'successful' | 'unsuccessful' | null
    closeReason?: string | null
    closedAt?: Date | null
    slaBreached?: boolean | null
  } = {}

  // If advancing to closed, mark successful
  if (targetStage.category === 'closed') {
    extraFields.closeOutcome = 'successful'
    extraFields.closeReason = null
    extraFields.closedAt = now
    extraFields.slaBreached = isCaseSlaBreached({
      createdAt: caseData.createdAt,
      evaluatedAt: now,
      slaHours: queue.slaHours,
    })
  }

  const action =
    targetStage.category === 'closed' ? 'closed_successful' : 'stage_advanced'

  const result = await transitionCaseState({
    event:
      targetStage.category === 'closed' ? 'close_successful' : 'advance_stage',
    caseId,
    actorId: userId,
    targetStage,
    requireOwner: true,
    checkCloseBlockers: targetStage.category === 'closed',
    historyAction: action,
    historyDetails: {
      fromStage: currentStage.name,
      toStage: targetStage.name,
    },
    extraFields,
    expected: {
      status: caseData.status as CaseStatusValue,
      currentStageId,
      ownerId: userId,
    },
    conflictMessage: 'Case stage was already updated.',
    afterUpdate: async (tx, _locked, _updated, derivedStatus) => {
      if (targetStage.category !== 'closed' || derivedStatus !== 'closed') {
        return
      }

      if (queue != null && queue.workflowType === 'testing') {
        await writeMerchantState(tx, {
          event: 'testing_completed',
          where: eq(merchants.id, caseData.merchantId),
          set: { updatedAt: now },
        })
      }

      if (queue != null && queue.workflowType === 'live') {
        // Rolls the close back unless the merchant is in testing.
        const [wentLive] = await writeMerchantState(tx, {
          event: 'went_live',
          where: eq(merchants.id, caseData.merchantId),
          set: { liveAt: now, updatedAt: now },
        })
        if (!wentLive) {
          throw new AppError(409, LIVE_WITHOUT_TESTING_MESSAGE)
        }
      }
    },
  })

  return result
}

// ─── Save Field Reviews ─────────────────────────────────────────────────────

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
      status: cases.status,
      createdAt: cases.createdAt,
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
  await assertCanWorkCase(caseId, userId)

  const queue = await db.query.queues.findFirst({
    where: eq(queues.id, caseData.queueId),
    columns: { slug: true, workflowType: true, slaHours: true },
  })

  // Verify not already closed
  if (caseData.currentStageId) {
    const currentStage = await loadQueueStageForCase(
      db,
      caseData.currentStageId,
      caseData.queueId,
    )
    if (currentStage?.category === 'closed') {
      throw new AppError(400, 'Case is already in a terminal stage.')
    }
  }

  const terminalStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseData.queueId),
      eq(queueStages.category, 'closed'),
    ),
  })

  if (!terminalStage) {
    throw new AppError(500, 'No closed stage configured for this queue.')
  }

  const now = new Date()

  return transitionCaseState({
    event: 'close_unsuccessful',
    caseId,
    actorId: userId,
    targetStage: terminalStage,
    requireOwner: true,
    checkCloseBlockers: false,
    historyAction: 'closed_unsuccessful',
    historyDetails: { reason: input.reason },
    extraFields: {
      closeOutcome: 'unsuccessful',
      closeReason: input.reason,
      closedAt: now,
      slaBreached: isCaseSlaBreached({
        createdAt: caseData.createdAt,
        evaluatedAt: now,
        slaHours: queue?.slaHours,
      }),
    },
    expected: {
      status: caseData.status as CaseStatusValue,
      currentStageId: caseData.currentStageId,
      ownerId: userId,
    },
    conflictMessage: 'Case state was already updated.',
  })
}

// ─── Case Comments ──────────────────────────────────────────────────────────
