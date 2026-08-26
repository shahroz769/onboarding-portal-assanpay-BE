import { and, eq, isNull } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { caseHistory, cases, queueStages, queues } from '../../db/schema'
import type { QueueStage } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { getStatusForStage } from '../queues/queue-stage-defaults'
import type { CaseStatusValue } from './cases.schemas'
import { assertCanWorkQueue } from './case-access.service'
import {
  assertCloseBlockersSatisfied,
  enqueueCasesAfterSuccessfulClose,
} from './case-flow.service'
import { requestCaseFlowCloseJobDrain } from './case-flow-worker'
import { isCaseSlaBreached } from './case-sla'

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

export type LockedCaseRow = {
  id: string
  ownerId: string | null
  currentStageId: string | null
  queueId: string
  merchantId: string
  status: CaseStatusValue
  closeOutcome: 'successful' | 'unsuccessful' | null
  closeReason: string | null
  closedAt: Date | null
  slaBreached: boolean | null
  createdAt: Date
  updatedAt: Date
}

type TargetStage = Pick<
  QueueStage,
  'id' | 'queueId' | 'name' | 'slug' | 'category' | 'order'
>

type TransitionExtraFields = {
  ownerId?: string | null
  closeOutcome?: 'successful' | 'unsuccessful' | null
  closeReason?: string | null
  closedAt?: Date | null
  slaBreached?: boolean | null
}

type StaleGuard = {
  status?: CaseStatusValue
  currentStageId?: string | null
  ownerId?: string | null
  ownerMustBeNull?: boolean
}

export type TransitionCaseStateInput = {
  caseId: string
  actorId: string
  targetStage: TargetStage
  historyAction: string
  historyDetails?: Record<string, unknown>
  requireOwner?: boolean
  requireWorkAccess?: boolean
  checkCloseBlockers?: boolean
  expected?: StaleGuard
  extraFields?: TransitionExtraFields
  conflictMessage?: string
  applyTerminalTimestamps?: boolean
  beforeUpdate?: (
    tx: DbTransaction,
    locked: LockedCaseRow,
    derivedStatus: CaseStatusValue,
  ) => Promise<void>
  afterUpdate?: (
    tx: DbTransaction,
    locked: LockedCaseRow,
    updated: LockedCaseRow,
    derivedStatus: CaseStatusValue,
  ) => Promise<void>
}

async function lockCaseRow(
  tx: DbTransaction,
  caseId: string,
): Promise<LockedCaseRow> {
  const [locked] = await tx
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      currentStageId: cases.currentStageId,
      queueId: cases.queueId,
      merchantId: cases.merchantId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
      closeReason: cases.closeReason,
      closedAt: cases.closedAt,
      slaBreached: cases.slaBreached,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1)
    .for('update')

  if (!locked) {
    throw new AppError(404, 'Case not found.')
  }

  return {
    ...locked,
    status: locked.status as CaseStatusValue,
  }
}

/**
 * Atomically transition a case to a target stage.
 * Locks the case row, re-validates auth, derives status from the stage,
 * optionally checks close blockers, applies a stale-state guard, and
 * writes history in the same transaction.
 */
export async function transitionCaseState(
  input: TransitionCaseStateInput,
): Promise<LockedCaseRow> {
  const db = getDb()
  const startedAt = performance.now()
  let outcome = 'success'
  let closeJobsEnqueued = false

  try {
    const result = await db.transaction(async (tx) => {
      const locked = await lockCaseRow(tx, input.caseId)

      if (input.requireOwner && locked.ownerId !== input.actorId) {
        throw new AppError(
          403,
          'Only the current case owner can work on this case.',
        )
      }

      if (input.targetStage.queueId !== locked.queueId) {
        throw new AppError(
          400,
          'Target stage does not belong to this case queue.',
        )
      }

      const [, currentStage, queue] = await Promise.all([
        input.requireWorkAccess
          ? assertCanWorkQueue(locked.queueId, input.actorId, tx)
          : Promise.resolve(),
        locked.currentStageId
          ? tx.query.queueStages.findFirst({
              where: and(
                eq(queueStages.id, locked.currentStageId),
                eq(queueStages.queueId, locked.queueId),
              ),
            })
          : Promise.resolve(null),
        tx.query.queues.findFirst({
          where: eq(queues.id, locked.queueId),
          columns: { id: true, slug: true, slaHours: true, qcEnabled: true },
        }),
      ])

      if (locked.currentStageId && !currentStage) {
        throw new AppError(409, 'Case stage no longer belongs to this queue.')
      }

      if (!queue) {
        throw new AppError(500, 'Case queue is not configured.')
      }

      const derivedStatus = getStatusForStage(input.targetStage)
      const now = new Date()

      const updateData: Record<string, unknown> = {
        currentStageId: input.targetStage.id,
        status: derivedStatus,
        updatedAt: now,
        ...input.extraFields,
      }

      if (
        derivedStatus === 'closed' &&
        input.extraFields?.closeOutcome === undefined
      ) {
        updateData.closeOutcome = 'successful'
        updateData.closeReason = null
      }

      if (input.applyTerminalTimestamps !== false) {
        const becomingTerminal =
          derivedStatus === 'closed' || derivedStatus === 'error'
        const leavingTerminal =
          (locked.status === 'closed' || locked.status === 'error') &&
          !becomingTerminal

        if (
          becomingTerminal &&
          input.extraFields?.closedAt === undefined &&
          (input.targetStage.category === 'closed' ||
            input.targetStage.category === 'error' ||
            derivedStatus === 'closed' ||
            derivedStatus === 'error')
        ) {
          if (!updateData.closedAt) {
            updateData.closedAt = now
          }
          if (updateData.slaBreached === undefined) {
            updateData.slaBreached = isCaseSlaBreached({
              createdAt: locked.createdAt,
              evaluatedAt: now,
              slaHours: queue.slaHours,
            })
          }
        }

        if (leavingTerminal && input.extraFields?.closedAt === undefined) {
          updateData.closedAt = null
          updateData.slaBreached = null
        }
      }

      const shouldCheckCloseBlockers =
        input.checkCloseBlockers ?? derivedStatus === 'closed'

      if (shouldCheckCloseBlockers) {
        await assertCloseBlockersSatisfied(tx, {
          merchantId: locked.merchantId,
          queueId: locked.queueId,
        })
      }

      if (input.beforeUpdate) {
        await input.beforeUpdate(tx, locked, derivedStatus)
      }

      const guard = input.expected ?? {
        status: locked.status,
        currentStageId: locked.currentStageId,
        ownerId: locked.ownerId,
      }

      const predicates = [eq(cases.id, input.caseId)]

      if (guard.status !== undefined) {
        predicates.push(eq(cases.status, guard.status))
      }
      if (guard.currentStageId !== undefined) {
        predicates.push(
          guard.currentStageId === null
            ? isNull(cases.currentStageId)
            : eq(cases.currentStageId, guard.currentStageId),
        )
      }
      if (guard.ownerMustBeNull) {
        predicates.push(isNull(cases.ownerId))
      } else if (guard.ownerId !== undefined) {
        predicates.push(
          guard.ownerId === null
            ? isNull(cases.ownerId)
            : eq(cases.ownerId, guard.ownerId),
        )
      }

      const [updated] = await tx
        .update(cases)
        .set(updateData)
        .where(and(...predicates))
        .returning({
          id: cases.id,
          ownerId: cases.ownerId,
          currentStageId: cases.currentStageId,
          queueId: cases.queueId,
          merchantId: cases.merchantId,
          status: cases.status,
          closeOutcome: cases.closeOutcome,
          closeReason: cases.closeReason,
          closedAt: cases.closedAt,
          slaBreached: cases.slaBreached,
          createdAt: cases.createdAt,
          updatedAt: cases.updatedAt,
        })

      if (!updated) {
        throw new AppError(
          409,
          input.conflictMessage ?? 'Case state was already updated.',
        )
      }

      const updatedRow: LockedCaseRow = {
        ...updated,
        status: updated.status as CaseStatusValue,
      }

      await tx.insert(caseHistory).values({
        caseId: input.caseId,
        actorId: input.actorId,
        action: input.historyAction,
        details: input.historyDetails ?? {},
      })

      if (input.afterUpdate) {
        await input.afterUpdate(tx, locked, updatedRow, derivedStatus)
      }

      if (
        derivedStatus === 'closed' &&
        updatedRow.closeOutcome === 'successful'
      ) {
        await enqueueCasesAfterSuccessfulClose(tx, {
          id: updatedRow.id,
          merchantId: updatedRow.merchantId,
          queueId: updatedRow.queueId,
        })
        // The database trigger also captures the jobs. Wake the worker even
        // when the application insert reports a conflict with those rows.
        closeJobsEnqueued = true
      }

      return updatedRow
    })

    if (closeJobsEnqueued) requestCaseFlowCloseJobDrain()
    return result
  } catch (error) {
    outcome = 'error'
    throw error
  } finally {
    console.info(
      JSON.stringify({
        event: 'case_transition_completed',
        action: input.historyAction,
        outcome,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      }),
    )
  }
}

export async function loadQueueStageForCase(
  database: ReturnType<typeof getDb> | DbTransaction,
  stageId: string,
  queueId: string,
) {
  return database.query.queueStages.findFirst({
    where: and(eq(queueStages.id, stageId), eq(queueStages.queueId, queueId)),
  })
}
