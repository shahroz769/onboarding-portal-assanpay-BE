import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm'

import { getDb, type DbTransaction } from '../../db/client'
import {
  caseFlowCloseBlockers,
  caseFlowCloseJobs,
  caseFlowCloseTriggers,
  caseFlowCreationRequirements,
  caseFlowMerchantMoveItems,
  caseFlowMerchantMoves,
  caseFlowStartRules,
  cases,
  flowConfigurationRevisions,
  merchants,
  queues,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { releaseBlockedCloseJobs } from '../cases/case-flow-job-state'
import { requestCaseFlowCloseJobDrain } from '../cases/case-flow-worker'
import type {
  MoveCaseFlowMerchantsInput,
  UpdateCaseFlowConfigurationInput,
} from './configuration.schemas'

type FlowRules = Pick<
  UpdateCaseFlowConfigurationInput,
  'startRules' | 'closeTriggers' | 'closeBlockers' | 'creationRequirements'
>

type RuleKind =
  | 'start'
  | 'closeTrigger'
  | 'closeBlocker'
  | 'creationRequirement'

type RuleRef = {
  kind: RuleKind
  sourceQueueId: string | null
  targetQueueId: string
}

function ruleKey(rule: RuleRef) {
  return `${rule.kind}:${rule.sourceQueueId ?? ''}:${rule.targetQueueId}`
}

function activeRuleRefs(rules: FlowRules): RuleRef[] {
  return [
    ...rules.startRules
      .filter((rule) => rule.isActive)
      .map((rule) => ({
        kind: 'start' as const,
        sourceQueueId: null,
        targetQueueId: rule.targetQueueId,
      })),
    ...rules.closeTriggers
      .filter((rule) => rule.isActive)
      .map((rule) => ({
        kind: 'closeTrigger' as const,
        sourceQueueId: rule.sourceQueueId,
        targetQueueId: rule.targetQueueId,
      })),
    ...rules.closeBlockers
      .filter((rule) => rule.isActive)
      .map((rule) => ({
        kind: 'closeBlocker' as const,
        sourceQueueId: rule.prerequisiteQueueId,
        targetQueueId: rule.blockedQueueId,
      })),
    ...rules.creationRequirements
      .filter((rule) => rule.isActive)
      .map((rule) => ({
        kind: 'creationRequirement' as const,
        sourceQueueId: rule.prerequisiteQueueId,
        targetQueueId: rule.targetQueueId,
      })),
  ]
}

async function readVersionRules(
  tx: DbTransaction,
  versionId: number,
): Promise<FlowRules> {
  const [startRules, closeTriggers, closeBlockers, creationRequirements] =
    await Promise.all([
      tx
        .select({
          targetQueueId: caseFlowStartRules.targetQueueId,
          order: caseFlowStartRules.order,
          isActive: caseFlowStartRules.isActive,
        })
        .from(caseFlowStartRules)
        .where(eq(caseFlowStartRules.flowVersionId, versionId)),
      tx
        .select({
          sourceQueueId: caseFlowCloseTriggers.sourceQueueId,
          targetQueueId: caseFlowCloseTriggers.targetQueueId,
          order: caseFlowCloseTriggers.order,
          isActive: caseFlowCloseTriggers.isActive,
        })
        .from(caseFlowCloseTriggers)
        .where(eq(caseFlowCloseTriggers.flowVersionId, versionId)),
      tx
        .select({
          blockedQueueId: caseFlowCloseBlockers.blockedQueueId,
          prerequisiteQueueId: caseFlowCloseBlockers.prerequisiteQueueId,
          isActive: caseFlowCloseBlockers.isActive,
        })
        .from(caseFlowCloseBlockers)
        .where(eq(caseFlowCloseBlockers.flowVersionId, versionId)),
      tx
        .select({
          targetQueueId: caseFlowCreationRequirements.targetQueueId,
          prerequisiteQueueId: caseFlowCreationRequirements.prerequisiteQueueId,
          isActive: caseFlowCreationRequirements.isActive,
        })
        .from(caseFlowCreationRequirements)
        .where(eq(caseFlowCreationRequirements.flowVersionId, versionId)),
    ])

  return { startRules, closeTriggers, closeBlockers, creationRequirements }
}

// A merchant moves when the flow can still do something for it. Terminated
// merchants keep their version, as do live merchants with nothing left open.
function hasUnfinishedWork() {
  return or(
    inArray(merchants.status, ['pending', 'testing']),
    sql`exists (
      select 1 from ${cases}
      where ${cases.merchantId} = ${merchants.id} and ${cases.status} <> 'closed'
    )`,
    sql`exists (
      select 1 from ${caseFlowCloseJobs}
      where ${caseFlowCloseJobs.merchantId} = ${merchants.id}
        and ${caseFlowCloseJobs.completedAt} is null
    )`,
  )
}

function eligibleMerchantsWhere(targetVersionId: number | null) {
  return and(
    sql`${merchants.deletedAt} is null`,
    ne(merchants.status, 'terminated'),
    hasUnfinishedWork(),
    targetVersionId === null
      ? undefined
      : ne(merchants.flowVersionId, targetVersionId),
  )
}

function reachableQueueIds(rules: FlowRules) {
  return new Set([
    ...rules.startRules
      .filter((rule) => rule.isActive)
      .map((rule) => rule.targetQueueId),
    ...rules.closeTriggers
      .filter((rule) => rule.isActive)
      .map((rule) => rule.targetQueueId),
  ])
}

function activeCloseTriggerKeys(rules: FlowRules) {
  return new Set(
    rules.closeTriggers
      .filter((rule) => rule.isActive)
      .map((rule) => `${rule.sourceQueueId}:${rule.targetQueueId}`),
  )
}

async function buildPreview(
  tx: DbTransaction,
  input: {
    targetRules: FlowRules
    targetVersionId: number | null
    revision: number
  },
) {
  const queueRows = await tx
    .select({ id: queues.id, name: queues.name })
    .from(queues)
  const queueName = new Map(queueRows.map((queue) => [queue.id, queue.name]))
  const nameOf = (id: string | null) =>
    id === null ? null : (queueName.get(id) ?? 'Unknown queue')

  const eligible = await tx
    .select({ id: merchants.id, flowVersionId: merchants.flowVersionId })
    .from(merchants)
    .where(eligibleMerchantsWhere(input.targetVersionId))

  const [staying] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(merchants)
    .where(
      and(
        sql`${merchants.deletedAt} is null`,
        input.targetVersionId === null
          ? undefined
          : ne(merchants.flowVersionId, input.targetVersionId),
        sql`not (${eligibleMerchantsWhere(null)})`,
      ),
    )

  const countByVersion = new Map<number, number>()
  for (const merchant of eligible) {
    countByVersion.set(
      merchant.flowVersionId,
      (countByVersion.get(merchant.flowVersionId) ?? 0) + 1,
    )
  }

  const targetRefs = activeRuleRefs(input.targetRules)
  const targetKeys = new Set(targetRefs.map(ruleKey))
  const sourceVersions = await Promise.all(
    [...countByVersion.entries()]
      .sort(([a], [b]) => a - b)
      .map(async ([versionId, merchantCount]) => {
        const sourceRefs = activeRuleRefs(await readVersionRules(tx, versionId))
        const sourceKeys = new Set(sourceRefs.map(ruleKey))
        const describe = (type: 'added' | 'removed') => (rule: RuleRef) => ({
          type,
          kind: rule.kind,
          sourceQueueName: nameOf(rule.sourceQueueId),
          targetQueueName: nameOf(rule.targetQueueId) as string,
        })
        return {
          versionId,
          merchantCount,
          changes: [
            ...sourceRefs
              .filter((rule) => !targetKeys.has(ruleKey(rule)))
              .map(describe('removed')),
            ...targetRefs
              .filter((rule) => !sourceKeys.has(ruleKey(rule)))
              .map(describe('added')),
          ],
        }
      }),
  )

  const merchantIds = eligible.map((merchant) => merchant.id)
  const reachable = reachableQueueIds(input.targetRules)
  const triggerKeys = activeCloseTriggerKeys(input.targetRules)

  const openCases = merchantIds.length
    ? await tx
        .select({
          queueId: cases.queueId,
          count: sql<number>`count(*)`,
        })
        .from(cases)
        .where(
          and(
            inArray(cases.merchantId, merchantIds),
            ne(cases.status, 'closed'),
          ),
        )
        .groupBy(cases.queueId)
    : []

  const openJobs = merchantIds.length
    ? await tx
        .select({
          sourceQueueId: caseFlowCloseJobs.sourceQueueId,
          targetQueueId: caseFlowCloseJobs.targetQueueId,
          count: sql<number>`count(*)`,
        })
        .from(caseFlowCloseJobs)
        .where(
          and(
            inArray(caseFlowCloseJobs.merchantId, merchantIds),
            sql`${caseFlowCloseJobs.completedAt} is null`,
          ),
        )
        .groupBy(
          caseFlowCloseJobs.sourceQueueId,
          caseFlowCloseJobs.targetQueueId,
        )
    : []

  return {
    targetVersionId: input.targetVersionId,
    revision: input.revision,
    eligibleMerchantCount: eligible.length,
    stayingMerchantCount: Number(staying?.count ?? 0),
    sourceVersions,
    // Left open by the move: closing them is a person's decision.
    openCasesOnRemovedSteps: openCases
      .filter((row) => !reachable.has(row.queueId))
      .map((row) => ({
        queueName: nameOf(row.queueId) as string,
        caseCount: Number(row.count),
      })),
    jobsToCancel: openJobs
      .filter(
        (row) => !triggerKeys.has(`${row.sourceQueueId}:${row.targetQueueId}`),
      )
      .map((row) => ({
        sourceQueueName: nameOf(row.sourceQueueId) as string,
        targetQueueName: nameOf(row.targetQueueId) as string,
        jobCount: Number(row.count),
      })),
  }
}

async function readActiveRevision(tx: DbTransaction) {
  const [current] = await tx
    .select()
    .from(flowConfigurationRevisions)
    .where(eq(flowConfigurationRevisions.id, 1))
    .for('share')
  if (!current)
    throw new AppError(409, 'Case flow versioning is not initialized.')
  return current
}

/** Impact of moving merchants onto the version that is active right now. */
export async function previewMoveToActiveVersion() {
  return getDb().transaction(async (tx) => {
    const current = await readActiveRevision(tx)
    return buildPreview(tx, {
      targetRules: await readVersionRules(tx, current.activeFlowVersionId),
      targetVersionId: current.activeFlowVersionId,
      revision: current.revision,
    })
  })
}

/** Impact of publishing these unsaved rules and moving merchants with them. */
export async function previewMoveToDraftRules(rules: FlowRules) {
  return getDb().transaction(async (tx) => {
    const current = await readActiveRevision(tx)
    return buildPreview(tx, {
      targetRules: rules,
      targetVersionId: null,
      revision: current.revision,
    })
  })
}

/**
 * Moves every in-progress merchant onto `targetVersionId`, which must already be
 * the active version. Runs inside the caller's transaction, which must hold the
 * configuration row FOR UPDATE, so a publish and its move commit or fail as one.
 */
export async function moveMerchantsToActiveVersionTx(
  tx: DbTransaction,
  input: { targetVersionId: number; movedBy: string; reason: string },
) {
  // Wait briefly rather than hold an admin request behind a long-running case
  // operation. The failure is reported as "try again" by the callers.
  await tx.execute(sql`select set_config('lock_timeout', '10s', true)`)

  const eligible = await tx
    .select({ id: merchants.id, flowVersionId: merchants.flowVersionId })
    .from(merchants)
    .where(eligibleMerchantsWhere(input.targetVersionId))
    .orderBy(asc(merchants.id))

  if (eligible.length === 0) {
    return { moveId: null, movedMerchantCount: 0, cancelledJobCount: 0 }
  }

  const [move] = await tx
    .insert(caseFlowMerchantMoves)
    .values({
      toVersionId: input.targetVersionId,
      movedBy: input.movedBy,
      reason: input.reason,
      merchantCount: eligible.length,
      cancelledJobCount: 0,
    })
    .returning({ id: caseFlowMerchantMoves.id })
  if (!move) throw new AppError(500, 'Failed to record the merchant move.')

  const merchantIds = eligible.map((merchant) => merchant.id)

  // Closing a case locks the case and then its merchant, so lock in that order
  // too. Waiting here also lets an in-flight close commit its jobs first, which
  // the job handling below then sees.
  await tx
    .select({ id: cases.id })
    .from(cases)
    .where(inArray(cases.merchantId, merchantIds))
    .orderBy(asc(cases.id))
    .for('no key update')

  // The triggers require this audit row before any version can change.
  await tx.insert(caseFlowMerchantMoveItems).values(
    eligible.map((merchant) => ({
      moveId: move.id,
      merchantId: merchant.id,
      fromVersionId: merchant.flowVersionId,
    })),
  )

  await tx
    .update(merchants)
    .set({ flowVersionId: input.targetVersionId })
    .where(inArray(merchants.id, merchantIds))

  await tx
    .update(cases)
    .set({ flowVersionId: input.targetVersionId })
    .where(inArray(cases.merchantId, merchantIds))

  const targetRules = await readVersionRules(tx, input.targetVersionId)
  const triggerKeys = activeCloseTriggerKeys(targetRules)

  const openJobs = await tx
    .select({
      id: caseFlowCloseJobs.id,
      sourceQueueId: caseFlowCloseJobs.sourceQueueId,
      targetQueueId: caseFlowCloseJobs.targetQueueId,
    })
    .from(caseFlowCloseJobs)
    .where(
      and(
        inArray(caseFlowCloseJobs.merchantId, merchantIds),
        sql`${caseFlowCloseJobs.completedAt} is null`,
      ),
    )
    .orderBy(asc(caseFlowCloseJobs.id))
    .for('update')

  // Cancelled jobs are deleted, not completed: a completed job is the tombstone
  // proving its target was created, which would block a later version from ever
  // creating that case again.
  const cancelledJobIds = openJobs
    .filter(
      (job) => !triggerKeys.has(`${job.sourceQueueId}:${job.targetQueueId}`),
    )
    .map((job) => job.id)
  if (cancelledJobIds.length > 0) {
    await tx
      .delete(caseFlowCloseJobs)
      .where(inArray(caseFlowCloseJobs.id, cancelledJobIds))
  }

  await tx
    .update(caseFlowCloseJobs)
    .set({ flowVersionId: input.targetVersionId })
    .where(inArray(caseFlowCloseJobs.merchantId, merchantIds))

  // Jobs that were waiting on the old version's creation requirements are
  // re-checked straight away against the new ones.
  await releaseBlockedCloseJobs(
    tx,
    inArray(caseFlowCloseJobs.merchantId, merchantIds),
  )

  await tx
    .update(caseFlowMerchantMoves)
    .set({ cancelledJobCount: cancelledJobIds.length })
    .where(eq(caseFlowMerchantMoves.id, move.id))

  return {
    moveId: move.id,
    movedMerchantCount: eligible.length,
    cancelledJobCount: cancelledJobIds.length,
  }
}

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  while (current && typeof current === 'object') {
    if ('code' in current && typeof current.code === 'string') {
      return current.code
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return undefined
}

/** Turns lock contention during a move into a retryable message. */
export function rethrowMoveLockFailure(error: unknown): never {
  const code = postgresErrorCode(error)
  if (code === '40P01' || code === '55P03') {
    throw new AppError(
      409,
      'Some of these merchants are being updated right now. No merchants were moved. Try again in a moment.',
    )
  }
  throw error
}

export async function moveMerchantsToActiveVersion(
  input: MoveCaseFlowMerchantsInput,
  movedBy: string,
) {
  const result = await getDb()
    .transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(flowConfigurationRevisions)
        .where(eq(flowConfigurationRevisions.id, 1))
        .for('update')
      if (!current || current.revision !== input.revision) {
        throw new AppError(
          409,
          'Case flow configuration was updated by someone else. Reload and try again.',
          { revision: current?.revision ?? input.revision },
        )
      }
      return moveMerchantsToActiveVersionTx(tx, {
        targetVersionId: current.activeFlowVersionId,
        movedBy,
        reason: input.reason,
      })
    })
    .catch(rethrowMoveLockFailure)

  requestCaseFlowCloseJobDrain()
  return result
}
