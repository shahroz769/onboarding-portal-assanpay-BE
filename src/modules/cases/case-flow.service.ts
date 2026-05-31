import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import type { getDb } from '../../db/client'
import {
  caseFlowCloseBlockers,
  caseFlowCloseTriggers,
  caseFlowCreationRequirements,
  caseFlowStartRules,
  caseHistory,
  caseLinks,
  cases,
  merchants,
  queueCaseSequences,
  queues,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { ensureQueueStages } from '../queues/queue-stage-defaults'

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

type TriggerType = 'form_submission' | 'case_close'

type CreatedFlowCase = {
  id: string
  caseNumber: string
  queueId: string
  queueName: string
}

async function generateFlowCaseNumber(
  tx: DbTransaction,
  queueId: string,
): Promise<string> {
  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, queueId),
    columns: { prefix: true },
  })

  if (!queue) {
    throw new AppError(404, 'Queue not found.')
  }

  await tx
    .insert(queueCaseSequences)
    .values({ queueId, lastNumber: 0 })
    .onConflictDoNothing()

  const [updated] = await tx
    .update(queueCaseSequences)
    .set({ lastNumber: sql`${queueCaseSequences.lastNumber} + 1` })
    .where(eq(queueCaseSequences.queueId, queueId))
    .returning({ lastNumber: queueCaseSequences.lastNumber })

  if (!updated) {
    throw new AppError(500, 'Failed to generate case number.')
  }

  return `${queue.prefix}-${String(updated.lastNumber).padStart(9, '0')}`
}

async function createConfiguredCase(
  tx: DbTransaction,
  input: {
    merchantId: string
    targetQueueId: string
    parentCaseId: string | null
    sourceQueueId: string | null
    triggerType: TriggerType
  },
): Promise<CreatedFlowCase> {
  const merchant = await tx.query.merchants.findFirst({
    where: eq(merchants.id, input.merchantId),
    columns: { id: true, businessName: true, priority: true },
  })

  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, input.targetQueueId),
    columns: {
      id: true,
      name: true,
      slug: true,
      qcEnabled: true,
      isActive: true,
    },
  })

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }
  if (!queue) {
    throw new AppError(404, 'Target queue not found.')
  }
  if (!queue.isActive) {
    throw new AppError(
      409,
      `${queue.name} is inactive. Automatic case creation is disabled.`,
    )
  }

  await assertCreationRequirementsSatisfied(tx, {
    merchantId: merchant.id,
    targetQueueId: queue.id,
  })

  const stages = await ensureQueueStages(tx, {
    id: queue.id,
    name: queue.name,
    slug: queue.slug,
    qcEnabled: queue.qcEnabled,
  })
  const initialStage = stages[0]
  if (!initialStage) {
    throw new AppError(500, `No initial stage configured for ${queue.name}.`)
  }

  const caseNumber = await generateFlowCaseNumber(tx, queue.id)
  const now = new Date()
  const [created] = await tx
    .insert(cases)
    .values({
      caseNumber,
      queueId: queue.id,
      merchantId: merchant.id,
      ownerId: null,
      currentStageId: initialStage.id,
      status: 'new',
      priority: merchant.priority,
      updatedAt: now,
    })
    .returning({ id: cases.id, caseNumber: cases.caseNumber })

  if (!created) {
    throw new AppError(500, 'Failed to create configured case.')
  }

  const [sourceCase] = input.parentCaseId
    ? await tx
        .select({
          caseNumber: cases.caseNumber,
          queueName: queues.name,
        })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(eq(cases.id, input.parentCaseId))
        .limit(1)
    : []

  await tx.insert(caseHistory).values({
    caseId: created.id,
    actorId: null,
    action:
      input.triggerType === 'form_submission'
        ? 'case_created_from_flow_start'
        : 'case_created_from_flow_close',
    details: {
      parentCaseId: input.parentCaseId,
      sourceQueueId: input.sourceQueueId,
      sourceCaseNumber: sourceCase?.caseNumber ?? null,
      sourceQueueName: sourceCase?.queueName ?? null,
      targetQueueId: queue.id,
      targetQueueName: queue.name,
      merchantName: merchant.businessName,
    },
  })

  await tx.insert(caseLinks).values({
    parentCaseId: input.parentCaseId,
    childCaseId: created.id,
    merchantId: merchant.id,
    triggerType: input.triggerType,
    sourceQueueId: input.sourceQueueId,
    targetQueueId: queue.id,
  })

  return {
    id: created.id,
    caseNumber: created.caseNumber,
    queueId: queue.id,
    queueName: queue.name,
  }
}

export async function triggerStartCasesForMerchant(
  tx: DbTransaction,
  merchantId: string,
) {
  const rules = await tx
    .select({ targetQueueId: caseFlowStartRules.targetQueueId })
    .from(caseFlowStartRules)
    .where(eq(caseFlowStartRules.isActive, true))
    .orderBy(asc(caseFlowStartRules.order), asc(caseFlowStartRules.createdAt))

  const createdCases: CreatedFlowCase[] = []
  for (const rule of rules) {
    createdCases.push(
      await createConfiguredCase(tx, {
        merchantId,
        targetQueueId: rule.targetQueueId,
        parentCaseId: null,
        sourceQueueId: null,
        triggerType: 'form_submission',
      }),
    )
  }

  return createdCases
}

export async function assertCloseBlockersSatisfied(
  tx: DbTransaction,
  input: { merchantId: string; queueId: string },
) {
  const blockers = await tx
    .select({
      prerequisiteQueueId: caseFlowCloseBlockers.prerequisiteQueueId,
      prerequisiteQueueName: queues.name,
    })
    .from(caseFlowCloseBlockers)
    .innerJoin(queues, eq(caseFlowCloseBlockers.prerequisiteQueueId, queues.id))
    .where(
      and(
        eq(caseFlowCloseBlockers.blockedQueueId, input.queueId),
        eq(caseFlowCloseBlockers.isActive, true),
      ),
    )

  if (blockers.length === 0) return

  const prerequisiteQueueIds = blockers.map(
    (blocker) => blocker.prerequisiteQueueId,
  )
  const satisfiedRows = await tx
    .select({ queueId: cases.queueId })
    .from(cases)
    .where(
      and(
        eq(cases.merchantId, input.merchantId),
        inArray(cases.queueId, prerequisiteQueueIds),
        eq(cases.status, 'closed'),
        eq(cases.closeOutcome, 'successful'),
      ),
    )

  const satisfiedQueueIds = new Set(satisfiedRows.map((row) => row.queueId))
  const missing = blockers.filter(
    (blocker) => !satisfiedQueueIds.has(blocker.prerequisiteQueueId),
  )

  if (missing.length > 0) {
    throw new AppError(
      409,
      `Close ${missing.map((item) => item.prerequisiteQueueName).join(', ')} before closing this case.`,
    )
  }
}

export async function assertCreationRequirementsSatisfied(
  tx: DbTransaction,
  input: { merchantId: string; targetQueueId: string },
) {
  const requirements = await tx
    .select({
      prerequisiteQueueId: caseFlowCreationRequirements.prerequisiteQueueId,
      prerequisiteQueueName: queues.name,
    })
    .from(caseFlowCreationRequirements)
    .innerJoin(
      queues,
      eq(caseFlowCreationRequirements.prerequisiteQueueId, queues.id),
    )
    .where(
      and(
        eq(caseFlowCreationRequirements.targetQueueId, input.targetQueueId),
        eq(caseFlowCreationRequirements.isActive, true),
      ),
    )

  if (requirements.length === 0) return

  const prerequisiteQueueIds = requirements.map(
    (requirement) => requirement.prerequisiteQueueId,
  )
  const satisfiedRows = await tx
    .select({ queueId: cases.queueId })
    .from(cases)
    .where(
      and(
        eq(cases.merchantId, input.merchantId),
        inArray(cases.queueId, prerequisiteQueueIds),
        eq(cases.status, 'closed'),
        eq(cases.closeOutcome, 'successful'),
      ),
    )

  const satisfiedQueueIds = new Set(satisfiedRows.map((row) => row.queueId))
  const missing = requirements.filter(
    (requirement) => !satisfiedQueueIds.has(requirement.prerequisiteQueueId),
  )

  if (missing.length > 0) {
    throw new AppError(
      409,
      `Close ${missing.map((item) => item.prerequisiteQueueName).join(', ')} before creating this case.`,
    )
  }
}

export async function triggerCasesAfterSuccessfulClose(
  tx: DbTransaction,
  sourceCase: { id: string; merchantId: string; queueId: string },
) {
  const rules = await tx
    .select({ targetQueueId: caseFlowCloseTriggers.targetQueueId })
    .from(caseFlowCloseTriggers)
    .where(
      and(
        eq(caseFlowCloseTriggers.sourceQueueId, sourceCase.queueId),
        eq(caseFlowCloseTriggers.isActive, true),
      ),
    )
    .orderBy(
      asc(caseFlowCloseTriggers.order),
      asc(caseFlowCloseTriggers.createdAt),
    )

  const createdCases: CreatedFlowCase[] = []
  for (const rule of rules) {
    createdCases.push(
      await createConfiguredCase(tx, {
        merchantId: sourceCase.merchantId,
        targetQueueId: rule.targetQueueId,
        parentCaseId: sourceCase.id,
        sourceQueueId: sourceCase.queueId,
        triggerType: 'case_close',
      }),
    )
  }

  return createdCases
}
