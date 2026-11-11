import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'

import { env } from '../../config/env'
import type { DbTransaction, getDb } from '../../db/client'
import { caseFlowCloseJobs } from '../../db/schema'
import {
  calculateCaseFlowRetryDelay,
  classifyCaseFlowFailure,
} from './case-flow-retry'

/**
 * The close-job lifecycle, in one place. Every write of a job's retry fields
 * goes through the functions below; `status` is generated from those fields
 * and migration 0109 rejects combinations no function here produces.
 *
 *   pending, retrying, failed ──attempt_failed──▶ retrying | failed | blocked
 *   blocked ──attempt_failed──▶ blocked (the same requirement still missing)
 *   blocked ──requirements_changed──▶ pending
 *   retrying, failed, blocked ──manual_retry──▶ pending (attempts reset)
 *   any open status ──completed──▶ completed
 *   completed is final: it proves the target case was created once.
 */
type CloseJobExecutor = ReturnType<typeof getDb> | DbTransaction

const isOpen = isNull(caseFlowCloseJobs.completedAt)

const CASE_FLOW_JOB_ERROR_MAX_LENGTH = 1_000

export function formatCaseFlowJobError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, CASE_FLOW_JOB_ERROR_MAX_LENGTH)
}

/** The target case exists (or the job no longer applies): finish the job. */
export function completeCloseJobs(db: CloseJobExecutor, where: SQL) {
  return db
    .update(caseFlowCloseJobs)
    .set({
      completedAt: new Date(),
      lastError: null,
      blockedAt: null,
      failedAt: null,
    })
    .where(and(where, isOpen))
    .returning({ id: caseFlowCloseJobs.id })
}

/**
 * An attempt to create the target case failed, by the worker or a direct
 * backfill. Schedules the next attempt with backoff and marks the job blocked
 * (a creation requirement is missing) or failed (still failing after
 * CASE_FLOW_WORKER_DEGRADED_AFTER_ATTEMPTS transient attempts).
 */
export async function recordCloseJobFailure(
  db: CloseJobExecutor,
  job: { id: string; attempts: number },
  error: unknown,
) {
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

  await db
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
    .where(and(eq(caseFlowCloseJobs.id, job.id), isOpen))

  return { nextAttempts, kind, degraded, retryDelay, formattedError }
}

/**
 * A successful close or a flow move may have satisfied what blocked these
 * jobs: make them pending and due now.
 */
export function releaseBlockedCloseJobs(db: CloseJobExecutor, where: SQL) {
  return db
    .update(caseFlowCloseJobs)
    .set({
      availableAt: sql`now()`,
      blockedAt: null,
      lastError: null,
      failedAt: null,
    })
    .where(and(where, isOpen, isNotNull(caseFlowCloseJobs.blockedAt)))
}

/** An admin retries a problem job: pending, due now, attempts reset. */
export function retryCloseJob(db: CloseJobExecutor, where: SQL) {
  return db
    .update(caseFlowCloseJobs)
    .set({
      attempts: 0,
      availableAt: sql`now()`,
      lastError: null,
      failedAt: null,
      blockedAt: null,
    })
    .where(and(where, isOpen, isNotNull(caseFlowCloseJobs.lastError)))
    .returning({ id: caseFlowCloseJobs.id })
}
