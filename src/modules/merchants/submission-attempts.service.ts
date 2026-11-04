import { and, count, eq, gt, lt, sql } from 'drizzle-orm'

import { env } from '../../config/env'
import { getDb, type DbTransaction } from '../../db/client'
import { publicSubmissionAttempts } from '../../db/schema'
import { AppError } from '../../lib/errors'

const SUBMISSION_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000
const ATTEMPT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000
const MAX_USER_AGENT_LENGTH = 512
const MAX_ERROR_MESSAGE_LENGTH = 500

export const SUBMISSION_LIMIT_MESSAGE =
  'Too many applications have been submitted from this network today. Please try again tomorrow.'

export type SubmissionClient = {
  ipAddress: string
  userAgent: string | null
}

type AttemptOutcome = (typeof publicSubmissionAttempts.$inferInsert)['outcome']

type AttemptRecord = {
  client: SubmissionClient
  outcome: AttemptOutcome
  statusCode: number
  errorMessage?: string | null
  merchantId?: string | null
}

function attemptValues(record: AttemptRecord) {
  return {
    ipAddress: record.client.ipAddress.slice(0, 64),
    userAgent: record.client.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    outcome: record.outcome,
    statusCode: record.statusCode,
    errorMessage:
      record.errorMessage?.slice(0, MAX_ERROR_MESSAGE_LENGTH) ?? null,
    merchantId: record.merchantId ?? null,
  }
}

async function countCreatedAttempts(
  db: DbTransaction | ReturnType<typeof getDb>,
  ipAddress: string,
) {
  const [row] = await db
    .select({ value: count() })
    .from(publicSubmissionAttempts)
    .where(
      and(
        eq(publicSubmissionAttempts.ipAddress, ipAddress.slice(0, 64)),
        eq(publicSubmissionAttempts.outcome, 'created'),
        gt(
          publicSubmissionAttempts.createdAt,
          new Date(Date.now() - SUBMISSION_LIMIT_WINDOW_MS),
        ),
      ),
    )

  return row?.value ?? 0
}

/** Cheap check before the upload is read; the transaction below is the real one. */
export async function assertSubmissionQuota(ipAddress: string) {
  const used = await countCreatedAttempts(getDb(), ipAddress)
  if (used >= env.PUBLIC_SUBMISSION_LIMIT_PER_IP) {
    throw new AppError(429, SUBMISSION_LIMIT_MESSAGE)
  }
}

/**
 * Counts and records a created submission in the merchant's transaction.
 * The per-IP lock makes parallel requests wait, so they cannot all pass.
 */
export async function claimSubmissionQuota(
  tx: DbTransaction,
  client: SubmissionClient,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`merchant-submission-ip:${client.ipAddress}`}))`,
  )
  const used = await countCreatedAttempts(tx, client.ipAddress)
  if (used >= env.PUBLIC_SUBMISSION_LIMIT_PER_IP) {
    throw new AppError(429, SUBMISSION_LIMIT_MESSAGE)
  }
}

export async function recordCreatedSubmission(
  tx: DbTransaction,
  client: SubmissionClient,
  merchantId: string,
) {
  await tx.insert(publicSubmissionAttempts).values(
    attemptValues({
      client,
      outcome: 'created',
      statusCode: 201,
      merchantId,
    }),
  )
}

/** Audit only: a logging failure must never change what the applicant sees. */
export async function recordSubmissionAttempt(record: AttemptRecord) {
  try {
    await getDb().insert(publicSubmissionAttempts).values(attemptValues(record))
  } catch (error) {
    console.error('[submission-attempts.record]', error)
  }
}

export async function purgeExpiredSubmissionAttempts() {
  await getDb()
    .delete(publicSubmissionAttempts)
    .where(
      lt(
        publicSubmissionAttempts.createdAt,
        new Date(Date.now() - ATTEMPT_RETENTION_MS),
      ),
    )
}
