import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'

import { getDb } from '../../db/client'
import { env } from '../../config/env'
import {
  caseFlowCloseBlockers,
  caseFlowCloseJobs,
  caseFlowCloseTriggers,
  caseFlowCreationRequirements,
  caseFlowStartRules,
  caseHistory,
  caseLinks,
  cases,
  documentReviewDetails,
  merchants,
  queueCaseSequences,
  queues,
  subMerchantDraftTemplates,
  subMerchantFormDetails,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { ensureQueueStages } from '../queues/queue-stage-defaults'
import { requestCaseFlowCloseJobDrain } from './case-flow-worker'
import {
  calculateCaseFlowRetryDelay,
  classifyCaseFlowFailure,
} from './case-flow-retry'

type DbTransaction = Parameters<
  Parameters<ReturnType<typeof getDb>['transaction']>[0]
>[0]

export async function getMerchantFlowVersionId(
  tx: DbTransaction,
  merchantId: string,
) {
  const merchant = await tx.query.merchants.findFirst({
    where: eq(merchants.id, merchantId),
    columns: { flowVersionId: true },
  })
  if (!merchant?.flowVersionId)
    throw new AppError(409, 'Merchant has no assigned flow version.')
  return merchant.flowVersionId
}

type TriggerType = 'form_submission' | 'case_close'

type CreatedFlowCase = {
  id: string
  caseNumber: string
  queueId: string
  queueName: string
  subMerchantId: string | null
  subMerchantName: string | null
}

type FlowSubMerchant = {
  id: string
  name: string
  draftUrl: string
}

const backfillTargetCases = alias(cases, 'backfill_target_cases')
const backfillSourceQueues = alias(queues, 'backfill_source_queues')
const backfillTargetQueues = alias(queues, 'backfill_target_queues')

type ActiveCloseTrigger = {
  flowVersionId: number
  id: string
  sourceQueueId: string
  sourceQueueName: string
  targetQueueId: string
  targetQueueName: string
}

async function getActiveCloseTrigger(
  tx: DbTransaction,
  triggerId: string,
): Promise<ActiveCloseTrigger> {
  const [trigger] = await tx
    .select({
      id: caseFlowCloseTriggers.id,
      flowVersionId: caseFlowCloseTriggers.flowVersionId,
      sourceQueueId: caseFlowCloseTriggers.sourceQueueId,
      sourceQueueName: backfillSourceQueues.name,
      targetQueueId: caseFlowCloseTriggers.targetQueueId,
      targetQueueName: backfillTargetQueues.name,
      isActive: caseFlowCloseTriggers.isActive,
    })
    .from(caseFlowCloseTriggers)
    .innerJoin(
      backfillSourceQueues,
      eq(caseFlowCloseTriggers.sourceQueueId, backfillSourceQueues.id),
    )
    .innerJoin(
      backfillTargetQueues,
      eq(caseFlowCloseTriggers.targetQueueId, backfillTargetQueues.id),
    )
    .where(eq(caseFlowCloseTriggers.id, triggerId))
    .limit(1)

  if (!trigger) throw new AppError(404, 'Close trigger not found.')
  if (!trigger.isActive) {
    throw new AppError(409, 'Activate and save this close trigger first.')
  }

  return trigger
}

async function listMissingCloseTriggerCandidates(
  tx: DbTransaction,
  trigger: ActiveCloseTrigger,
) {
  return tx
    .selectDistinctOn([cases.merchantId], {
      sourceCaseId: cases.id,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(
      and(
        eq(cases.queueId, trigger.sourceQueueId),
        eq(merchants.flowVersionId, trigger.flowVersionId),
        eq(cases.status, 'closed'),
        eq(cases.closeOutcome, 'successful'),
        notExists(
          tx
            .select({ id: backfillTargetCases.id })
            .from(backfillTargetCases)
            .where(
              and(
                eq(backfillTargetCases.merchantId, cases.merchantId),
                eq(backfillTargetCases.queueId, trigger.targetQueueId),
              ),
            ),
        ),
        // A completed outbox job proves that the target case existed even if
        // it was later deleted. The recovery action must never recreate it.
        notExists(
          tx
            .select({ id: caseFlowCloseJobs.id })
            .from(caseFlowCloseJobs)
            .where(
              and(
                eq(caseFlowCloseJobs.merchantId, cases.merchantId),
                eq(caseFlowCloseJobs.targetQueueId, trigger.targetQueueId),
                isNotNull(caseFlowCloseJobs.completedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      cases.merchantId,
      desc(cases.closedAt),
      desc(cases.createdAt),
      desc(cases.id),
    )
}

async function getCloseTriggerCandidateBreakdown(
  tx: DbTransaction,
  candidates: Array<{ merchantId: string; merchantName: string }>,
  targetQueueId: string,
) {
  if (candidates.length === 0) {
    return {
      jobBreakdown: { neverQueued: 0, pending: 0, failed: 0 },
      retryIssues: [],
    }
  }

  const jobs = await tx
    .select({
      merchantId: caseFlowCloseJobs.merchantId,
      attempts: caseFlowCloseJobs.attempts,
      failedAt: caseFlowCloseJobs.failedAt,
      lastError: caseFlowCloseJobs.lastError,
    })
    .from(caseFlowCloseJobs)
    .where(
      and(
        inArray(
          caseFlowCloseJobs.merchantId,
          candidates.map((candidate) => candidate.merchantId),
        ),
        eq(caseFlowCloseJobs.targetQueueId, targetQueueId),
        isNull(caseFlowCloseJobs.completedAt),
      ),
    )

  const merchantsWithJobs = new Set<string>()
  const merchantsWithPendingJobs = new Set<string>()
  const merchantsWithOnlyFailedJobs = new Set<string>()
  const latestIssueByMerchant = new Map<
    string,
    { attempts: number; error: string }
  >()

  for (const job of jobs) {
    merchantsWithJobs.add(job.merchantId)
    if (job.failedAt || job.lastError) {
      if (!merchantsWithPendingJobs.has(job.merchantId)) {
        merchantsWithOnlyFailedJobs.add(job.merchantId)
      }
      if (job.lastError) {
        const current = latestIssueByMerchant.get(job.merchantId)
        if (!current || job.attempts >= current.attempts) {
          latestIssueByMerchant.set(job.merchantId, {
            attempts: job.attempts,
            error: job.lastError,
          })
        }
      }
    } else {
      merchantsWithPendingJobs.add(job.merchantId)
      merchantsWithOnlyFailedJobs.delete(job.merchantId)
    }
  }

  return {
    jobBreakdown: {
      neverQueued: candidates.length - merchantsWithJobs.size,
      pending: merchantsWithPendingJobs.size,
      failed: merchantsWithOnlyFailedJobs.size,
    },
    retryIssues: candidates.flatMap((candidate) => {
      const issue = latestIssueByMerchant.get(candidate.merchantId)
      return issue ? [{ ...candidate, ...issue }] : []
    }),
  }
}

function closeTriggerSummary(trigger: ActiveCloseTrigger) {
  return {
    id: trigger.id,
    flowVersionId: trigger.flowVersionId,
    sourceQueueId: trigger.sourceQueueId,
    sourceQueueName: trigger.sourceQueueName,
    targetQueueId: trigger.targetQueueId,
    targetQueueName: trigger.targetQueueName,
  }
}

export async function previewMissingCloseTriggerCases(triggerId: string) {
  return getDb().transaction(async (tx) => {
    const trigger = await getActiveCloseTrigger(tx, triggerId)
    const candidates = await listMissingCloseTriggerCandidates(tx, trigger)
    const { jobBreakdown, retryIssues } =
      await getCloseTriggerCandidateBreakdown(
        tx,
        candidates,
        trigger.targetQueueId,
      )

    return {
      trigger: closeTriggerSummary(trigger),
      eligibleMerchantCount: candidates.length,
      jobBreakdown,
      retryIssues,
      sampleMerchants: candidates
        .slice(0, 10)
        .map(({ merchantId, merchantName }) => ({ merchantId, merchantName })),
    }
  })
}

export async function createMissingCloseTriggerCases(triggerId: string) {
  const { trigger, candidates, jobBreakdown } = await getDb().transaction(
    async (tx) => {
      const trigger = await getActiveCloseTrigger(tx, triggerId)
      const candidates = await listMissingCloseTriggerCandidates(tx, trigger)
      const { jobBreakdown } = await getCloseTriggerCandidateBreakdown(
        tx,
        candidates,
        trigger.targetQueueId,
      )

      return {
        trigger,
        candidates,
        jobBreakdown,
      }
    },
  )

  let createdMerchantCount = 0
  let createdCaseCount = 0
  let skippedMerchantCount = 0
  const failures: Array<{
    merchantId: string
    merchantName: string
    error: string
  }> = []

  for (const candidate of candidates) {
    let createdCases: CreatedFlowCase[]

    try {
      createdCases = await getDb().transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${candidate.merchantId}), hashtext(${trigger.targetQueueId}))`,
        )

        const created = await createConfiguredCases(tx, {
          merchantId: candidate.merchantId,
          targetQueueId: trigger.targetQueueId,
          parentCaseId: candidate.sourceCaseId,
          sourceQueueId: trigger.sourceQueueId,
          triggerType: 'case_close',
          onlyIfTargetMissing: true,
        })

        return created
      })
    } catch (error) {
      const message = formatCaseFlowJobError(error)
      failures.push({
        merchantId: candidate.merchantId,
        merchantName: candidate.merchantName,
        error: message,
      })

      try {
        await getDb()
          .update(caseFlowCloseJobs)
          .set({ lastError: message })
          .where(
            and(
              eq(caseFlowCloseJobs.merchantId, candidate.merchantId),
              eq(caseFlowCloseJobs.targetQueueId, trigger.targetQueueId),
              isNull(caseFlowCloseJobs.completedAt),
            ),
          )
      } catch (recordError) {
        console.error('[case-flow] Failed to record direct creation error:', {
          merchantId: candidate.merchantId,
          targetQueueId: trigger.targetQueueId,
          error: formatCaseFlowJobError(recordError),
        })
      }
      continue
    }

    // Do not hold the advisory creation lock while waiting for a worker's
    // job-row lock. The worker uses the opposite order, so separating these
    // operations prevents a lock-order deadlock.
    try {
      await getDb()
        .update(caseFlowCloseJobs)
        .set({
          completedAt: new Date(),
          lastError: null,
          failedAt: null,
        })
        .where(
          and(
            eq(caseFlowCloseJobs.merchantId, candidate.merchantId),
            eq(caseFlowCloseJobs.targetQueueId, trigger.targetQueueId),
            isNull(caseFlowCloseJobs.completedAt),
          ),
        )
    } catch (error) {
      // Creation already committed. The worker will observe the target case
      // and complete its job, so do not report a successful create as failed.
      console.error('[case-flow] Failed to complete superseded close jobs:', {
        merchantId: candidate.merchantId,
        targetQueueId: trigger.targetQueueId,
        error: formatCaseFlowJobError(error),
      })
    }

    if (createdCases.length === 0) {
      skippedMerchantCount += 1
    } else {
      createdMerchantCount += 1
      createdCaseCount += createdCases.length
    }
  }

  return {
    trigger: closeTriggerSummary(trigger),
    eligibleMerchantCount: candidates.length,
    createdMerchantCount,
    createdCaseCount,
    skippedMerchantCount,
    failedMerchantCount: failures.length,
    jobBreakdown,
    failures,
  }
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
    subMerchant: FlowSubMerchant | null
  },
): Promise<CreatedFlowCase> {
  const merchant = await tx.query.merchants.findFirst({
    where: eq(merchants.id, input.merchantId),
    columns: {
      id: true,
      businessName: true,
      priority: true,
      flowVersionId: true,
    },
  })

  const queue = await tx.query.queues.findFirst({
    where: eq(queues.id, input.targetQueueId),
    columns: {
      id: true,
      name: true,
      slug: true,
      workflowType: true,
      lifecycle: true,
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
  if (queue.lifecycle !== 'active') {
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
    workflowType: queue.workflowType,
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
      flowVersionId: merchant.flowVersionId,
      queueId: queue.id,
      merchantId: merchant.id,
      subMerchantId: input.subMerchant?.id ?? null,
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

  if (input.subMerchant) {
    await tx.insert(subMerchantFormDetails).values({
      caseId: created.id,
      subMerchantKey: input.subMerchant.id,
      subMerchantName: input.subMerchant.name,
      draftUrl: input.subMerchant.draftUrl,
    })
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
      subMerchantId: input.subMerchant?.id ?? null,
      subMerchantName: input.subMerchant?.name ?? null,
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
    subMerchantId: input.subMerchant?.id ?? null,
    subMerchantName: input.subMerchant?.name ?? null,
  }
}

async function getFlowSubMerchants(
  tx: DbTransaction,
  input: {
    merchantId: string
    targetQueueId: string
    parentCaseId: string | null
  },
): Promise<Array<FlowSubMerchant | null>> {
  const targetQueue = await tx.query.queues.findFirst({
    where: eq(queues.id, input.targetQueueId),
    columns: { workflowType: true },
  })

  if (targetQueue?.workflowType !== 'sub_merchant_form') return [null]

  const [parentCase] = input.parentCaseId
    ? await tx
        .select({ workflowType: queues.workflowType })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(eq(cases.id, input.parentCaseId))
        .limit(1)
    : []

  const selectedCaseId =
    input.parentCaseId && parentCase?.workflowType === 'document_review'
      ? input.parentCaseId
      : (
          await tx
            .select({ caseId: documentReviewDetails.caseId })
            .from(documentReviewDetails)
            .innerJoin(cases, eq(documentReviewDetails.caseId, cases.id))
            .innerJoin(queues, eq(cases.queueId, queues.id))
            .where(
              and(
                eq(cases.merchantId, input.merchantId),
                eq(queues.workflowType, 'document_review'),
              ),
            )
            .orderBy(desc(documentReviewDetails.updatedAt))
            .limit(1)
        )[0]?.caseId

  if (!selectedCaseId) {
    throw new AppError(
      409,
      'Select at least one sub-merchant in document review before creating EP Sub-Merchant Form cases.',
    )
  }

  const selected = await tx
    .select({
      id: subMerchantDraftTemplates.id,
      name: subMerchantDraftTemplates.name,
      draftUrl: subMerchantDraftTemplates.googleDriveWebViewLink,
    })
    .from(documentReviewDetails)
    .innerJoin(
      subMerchantDraftTemplates,
      eq(documentReviewDetails.subMerchantId, subMerchantDraftTemplates.id),
    )
    .where(eq(documentReviewDetails.caseId, selectedCaseId))
    .orderBy(asc(subMerchantDraftTemplates.name))

  if (selected.length === 0) {
    throw new AppError(
      409,
      'Select at least one sub-merchant in document review before creating EP Sub-Merchant Form cases.',
    )
  }

  return selected
}

async function createConfiguredCases(
  tx: DbTransaction,
  input: {
    merchantId: string
    targetQueueId: string
    parentCaseId: string | null
    sourceQueueId: string | null
    triggerType: TriggerType
    onlyIfTargetMissing?: boolean
  },
) {
  const subMerchants = await getFlowSubMerchants(tx, input)
  const createdCases: CreatedFlowCase[] = []

  for (const subMerchant of subMerchants) {
    if (input.onlyIfTargetMissing) {
      const [existingTargetCase] = await tx
        .select({ id: cases.id })
        .from(cases)
        .where(
          and(
            eq(cases.merchantId, input.merchantId),
            eq(cases.queueId, input.targetQueueId),
            subMerchant
              ? eq(cases.subMerchantId, subMerchant.id)
              : isNull(cases.subMerchantId),
          ),
        )
        .limit(1)

      if (existingTargetCase) continue
    }

    createdCases.push(await createConfiguredCase(tx, { ...input, subMerchant }))
  }

  return createdCases
}

export async function triggerStartCasesForMerchant(
  tx: DbTransaction,
  merchantId: string,
) {
  const flowVersionId = await getMerchantFlowVersionId(tx, merchantId)
  const rules = await tx
    .select({ targetQueueId: caseFlowStartRules.targetQueueId })
    .from(caseFlowStartRules)
    .where(
      and(
        eq(caseFlowStartRules.isActive, true),
        eq(caseFlowStartRules.flowVersionId, flowVersionId),
      ),
    )
    .orderBy(asc(caseFlowStartRules.order), asc(caseFlowStartRules.createdAt))

  const createdCases: CreatedFlowCase[] = []
  for (const rule of rules) {
    createdCases.push(
      ...(await createConfiguredCases(tx, {
        merchantId,
        targetQueueId: rule.targetQueueId,
        parentCaseId: null,
        sourceQueueId: null,
        triggerType: 'form_submission',
      })),
    )
  }

  return createdCases
}

export async function assertCloseBlockersSatisfied(
  tx: DbTransaction,
  input: { merchantId: string; queueId: string },
) {
  const flowVersionId = await getMerchantFlowVersionId(tx, input.merchantId)
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
        eq(caseFlowCloseBlockers.flowVersionId, flowVersionId),
      ),
    )

  if (blockers.length === 0) return

  const prerequisiteQueueIds = blockers.map(
    (blocker) => blocker.prerequisiteQueueId,
  )

  // Lock all candidate prerequisite cases in stable ID order to prevent
  // concurrent close races from observing a stale satisfaction snapshot.
  const candidateRows = await tx
    .select({
      id: cases.id,
      queueId: cases.queueId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
    })
    .from(cases)
    .where(
      and(
        eq(cases.merchantId, input.merchantId),
        inArray(cases.queueId, prerequisiteQueueIds),
      ),
    )
    .orderBy(asc(cases.id))
    .for('update')

  const satisfiedQueueIds = new Set(
    candidateRows
      .filter(
        (row) => row.status === 'closed' && row.closeOutcome === 'successful',
      )
      .map((row) => row.queueId),
  )
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
  const flowVersionId = await getMerchantFlowVersionId(tx, input.merchantId)
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
        eq(caseFlowCreationRequirements.flowVersionId, flowVersionId),
      ),
    )

  if (requirements.length === 0) return

  const prerequisiteQueueIds = requirements.map(
    (requirement) => requirement.prerequisiteQueueId,
  )

  const candidateRows = await tx
    .select({
      id: cases.id,
      queueId: cases.queueId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
    })
    .from(cases)
    .where(
      and(
        eq(cases.merchantId, input.merchantId),
        inArray(cases.queueId, prerequisiteQueueIds),
      ),
    )
    .orderBy(asc(cases.id))
    .for('update')

  const satisfiedQueueIds = new Set(
    candidateRows
      .filter(
        (row) => row.status === 'closed' && row.closeOutcome === 'successful',
      )
      .map((row) => row.queueId),
  )
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

export async function enqueueCasesAfterSuccessfulClose(
  tx: DbTransaction,
  sourceCase: { id: string; merchantId: string; queueId: string },
) {
  const flowVersionId = await getMerchantFlowVersionId(
    tx,
    sourceCase.merchantId,
  )
  const rules = await tx
    .select({ targetQueueId: caseFlowCloseTriggers.targetQueueId })
    .from(caseFlowCloseTriggers)
    .where(
      and(
        eq(caseFlowCloseTriggers.sourceQueueId, sourceCase.queueId),
        eq(caseFlowCloseTriggers.isActive, true),
        eq(caseFlowCloseTriggers.flowVersionId, flowVersionId),
        // Match the database trigger's once-only invariant. A completed job
        // is a tombstone proving this target was created in the past.
        notExists(
          tx
            .select({ id: caseFlowCloseJobs.id })
            .from(caseFlowCloseJobs)
            .where(
              and(
                eq(caseFlowCloseJobs.merchantId, sourceCase.merchantId),
                eq(
                  caseFlowCloseJobs.targetQueueId,
                  caseFlowCloseTriggers.targetQueueId,
                ),
                isNotNull(caseFlowCloseJobs.completedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      asc(caseFlowCloseTriggers.order),
      asc(caseFlowCloseTriggers.createdAt),
    )

  // A newly successful close can satisfy creation requirements that blocked
  // another target for this merchant. Re-check those jobs immediately.
  await tx
    .update(caseFlowCloseJobs)
    .set({
      availableAt: sql`now()`,
      blockedAt: null,
      lastError: null,
      failedAt: null,
    })
    .where(
      and(
        eq(caseFlowCloseJobs.merchantId, sourceCase.merchantId),
        isNull(caseFlowCloseJobs.completedAt),
        isNotNull(caseFlowCloseJobs.blockedAt),
      ),
    )

  if (rules.length === 0) return []

  return tx
    .insert(caseFlowCloseJobs)
    .values(
      rules.map((rule) => ({
        flowVersionId,
        sourceCaseId: sourceCase.id,
        merchantId: sourceCase.merchantId,
        sourceQueueId: sourceCase.queueId,
        targetQueueId: rule.targetQueueId,
        onlyIfTargetMissing: true,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: caseFlowCloseJobs.id })
}

// Compatibility export for case modules that still share the legacy import set.
export const triggerCasesAfterSuccessfulClose = enqueueCasesAfterSuccessfulClose

const CASE_FLOW_JOB_ERROR_MAX_LENGTH = 1_000

function formatCaseFlowJobError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, CASE_FLOW_JOB_ERROR_MAX_LENGTH)
}

export async function processCaseFlowCloseJobs(batchSize = 5) {
  const db = getDb()
  let claimed = 0
  let completed = 0
  let failed = 0

  for (let index = 0; index < batchSize; index += 1) {
    const result = await db.transaction(async (tx) => {
      const [job] = await tx
        .select({
          id: caseFlowCloseJobs.id,
          flowVersionId: caseFlowCloseJobs.flowVersionId,
          sourceCaseId: caseFlowCloseJobs.sourceCaseId,
          merchantId: caseFlowCloseJobs.merchantId,
          sourceQueueId: caseFlowCloseJobs.sourceQueueId,
          targetQueueId: caseFlowCloseJobs.targetQueueId,
          attempts: caseFlowCloseJobs.attempts,
          blockedAt: caseFlowCloseJobs.blockedAt,
          lastError: caseFlowCloseJobs.lastError,
          onlyIfTargetMissing: caseFlowCloseJobs.onlyIfTargetMissing,
        })
        .from(caseFlowCloseJobs)
        .where(
          and(
            isNull(caseFlowCloseJobs.completedAt),
            lte(caseFlowCloseJobs.availableAt, sql`now()`),
          ),
        )
        .orderBy(
          asc(caseFlowCloseJobs.availableAt),
          asc(caseFlowCloseJobs.createdAt),
        )
        .limit(1)
        .for('update', { skipLocked: true })

      if (!job) return { handled: false, completed: false, failed: false }

      try {
        // The nested transaction is a savepoint. If downstream creation
        // fails, its writes roll back while this outer transaction retains
        // the job lock and safely records retry state.
        await tx.transaction(async (jobTx) => {
          // Serialize recovery jobs for the same merchant and target queue.
          // This makes repeated bulk recovery requests safe across workers.
          await jobTx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${job.merchantId}), hashtext(${job.targetQueueId}))`,
          )

          const flowVersionId = await getMerchantFlowVersionId(
            jobTx,
            job.merchantId,
          )
          if (flowVersionId !== job.flowVersionId)
            throw new AppError(
              409,
              'Job flow version does not match its merchant.',
            )
          await createConfiguredCases(jobTx, {
            merchantId: job.merchantId,
            targetQueueId: job.targetQueueId,
            parentCaseId: job.sourceCaseId,
            sourceQueueId: job.sourceQueueId,
            triggerType: 'case_close',
            onlyIfTargetMissing: job.onlyIfTargetMissing,
          })
        })

        await tx
          .update(caseFlowCloseJobs)
          .set({
            completedAt: new Date(),
            lastError: null,
            failedAt: null,
            blockedAt: null,
          })
          .where(eq(caseFlowCloseJobs.id, job.id))

        return { handled: true, completed: true, failed: false }
      } catch (error) {
        const nextAttempts = job.attempts + 1
        const kind = classifyCaseFlowFailure(error)
        const degraded =
          kind === 'transient' &&
          nextAttempts >= env.CASE_FLOW_WORKER_DEGRADED_AFTER_ATTEMPTS
        const retryDelay = calculateCaseFlowRetryDelay({
          previousAttempts: job.attempts,
          kind,
          retryBaseMs: env.CASE_FLOW_WORKER_RETRY_BASE_MS,
          retryMaxMs: env.CASE_FLOW_WORKER_RETRY_MAX_MS,
          blockedRetryMs: env.CASE_FLOW_WORKER_BLOCKED_RETRY_MS,
          jitterPercent: env.CASE_FLOW_WORKER_RETRY_JITTER_PERCENT,
        })
        const formattedError = formatCaseFlowJobError(error)

        await tx
          .update(caseFlowCloseJobs)
          .set({
            attempts: nextAttempts,
            availableAt: sql`now() + (${retryDelay} * interval '1 millisecond')`,
            lastAttemptAt: sql`now()`,
            blockedAt:
              kind === 'blocked'
                ? sql`coalesce(${caseFlowCloseJobs.blockedAt}, now())`
                : null,
            failedAt: degraded
              ? sql`coalesce(${caseFlowCloseJobs.failedAt}, now())`
              : null,
            lastError: formattedError,
          })
          .where(
            and(
              eq(caseFlowCloseJobs.id, job.id),
              isNull(caseFlowCloseJobs.completedAt),
            ),
          )

        // Log deterministic blockers once (and whenever their reason changes)
        // instead of generating the same error every retry cycle.
        if (
          kind === 'transient' ||
          job.blockedAt === null ||
          job.lastError !== formattedError
        ) {
          console.error('[case-flow] Failed to process close job:', {
            jobId: job.id,
            merchantId: job.merchantId,
            sourceQueueId: job.sourceQueueId,
            targetQueueId: job.targetQueueId,
            attempts: nextAttempts,
            kind,
            retryDelayMs: retryDelay,
            error: formattedError,
          })
        }
        return { handled: true, completed: false, failed: degraded }
      }
    })

    if (!result.handled) break
    claimed += 1
    if (result.completed) completed += 1
    if (result.failed) failed += 1
  }

  return { claimed, completed, failed }
}

export async function getCaseFlowCloseJobHealth() {
  const [row] = await getDb()
    .select({
      pending: sql<number>`count(*) filter (
        where ${caseFlowCloseJobs.completedAt} is null
          and ${caseFlowCloseJobs.lastError} is null
      )`,
      retrying: sql<number>`count(*) filter (
        where ${caseFlowCloseJobs.lastError} is not null
          and ${caseFlowCloseJobs.blockedAt} is null
          and ${caseFlowCloseJobs.failedAt} is null
      )`,
      failed: sql<number>`count(*) filter (
        where ${caseFlowCloseJobs.failedAt} is not null
          and ${caseFlowCloseJobs.blockedAt} is null
      )`,
      blocked: sql<number>`count(*) filter (
        where ${caseFlowCloseJobs.blockedAt} is not null
      )`,
      oldestPendingAt: sql<Date | null>`min(${caseFlowCloseJobs.createdAt}) filter (
        where ${caseFlowCloseJobs.lastError} is null
      )`,
      oldestRetryingAt: sql<Date | null>`min(${caseFlowCloseJobs.createdAt}) filter (
        where ${caseFlowCloseJobs.lastError} is not null
          and ${caseFlowCloseJobs.blockedAt} is null
          and ${caseFlowCloseJobs.failedAt} is null
      )`,
      oldestFailedAt: sql<Date | null>`min(${caseFlowCloseJobs.failedAt}) filter (
        where ${caseFlowCloseJobs.failedAt} is not null
          and ${caseFlowCloseJobs.blockedAt} is null
      )`,
      oldestBlockedAt: sql<Date | null>`min(${caseFlowCloseJobs.blockedAt}) filter (
        where ${caseFlowCloseJobs.blockedAt} is not null
      )`,
      nextRetryAt: sql<Date | null>`min(${caseFlowCloseJobs.availableAt}) filter (
        where ${caseFlowCloseJobs.lastError} is not null
      )`,
    })
    .from(caseFlowCloseJobs)
    .where(isNull(caseFlowCloseJobs.completedAt))

  return {
    pending: Number(row?.pending ?? 0),
    retrying: Number(row?.retrying ?? 0),
    failed: Number(row?.failed ?? 0),
    blocked: Number(row?.blocked ?? 0),
    oldestPendingAt: row?.oldestPendingAt ?? null,
    oldestRetryingAt: row?.oldestRetryingAt ?? null,
    oldestFailedAt: row?.oldestFailedAt ?? null,
    oldestBlockedAt: row?.oldestBlockedAt ?? null,
    nextRetryAt: row?.nextRetryAt ?? null,
  }
}

export async function listFailedCaseFlowCloseJobs() {
  return getDb()
    .select({
      id: caseFlowCloseJobs.id,
      sourceCaseId: caseFlowCloseJobs.sourceCaseId,
      merchantId: caseFlowCloseJobs.merchantId,
      sourceQueueId: caseFlowCloseJobs.sourceQueueId,
      targetQueueId: caseFlowCloseJobs.targetQueueId,
      attempts: caseFlowCloseJobs.attempts,
      lastError: caseFlowCloseJobs.lastError,
      lastAttemptAt: caseFlowCloseJobs.lastAttemptAt,
      availableAt: caseFlowCloseJobs.availableAt,
      blockedAt: caseFlowCloseJobs.blockedAt,
      failedAt: caseFlowCloseJobs.failedAt,
    })
    .from(caseFlowCloseJobs)
    .where(
      and(
        isNull(caseFlowCloseJobs.completedAt),
        isNotNull(caseFlowCloseJobs.lastError),
      ),
    )
    .orderBy(
      desc(caseFlowCloseJobs.lastAttemptAt),
      desc(caseFlowCloseJobs.createdAt),
    )
    .limit(100)
}

export async function retryFailedCaseFlowCloseJob(jobId: string) {
  const [retried] = await getDb()
    .update(caseFlowCloseJobs)
    .set({
      attempts: 0,
      availableAt: sql`now()`,
      lastError: null,
      failedAt: null,
      blockedAt: null,
    })
    .where(
      and(
        eq(caseFlowCloseJobs.id, jobId),
        isNull(caseFlowCloseJobs.completedAt),
        isNotNull(caseFlowCloseJobs.lastError),
      ),
    )
    .returning({ id: caseFlowCloseJobs.id })

  if (!retried) {
    throw new AppError(404, 'Problem case-flow job not found.')
  }

  requestCaseFlowCloseJobDrain()
  return retried
}
