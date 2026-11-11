import { and, asc, eq, isNull, lt } from 'drizzle-orm'

import { getDb, type DbTransaction } from '../../db/client'
import {
  agreementCaseDetails,
  caseHistory,
  caseMerchantRequests,
  caseResubmissionTokens,
  cases,
  emailLog,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { UNDELIVERED_EMAIL_STATUSES } from '../email/email-delivery-status'
import { consumeResubmissionTokens } from './case-resubmission-tokens.service'
import { writeCaseState } from './case-state-machine'

/**
 * Asking the merchant for something (the resubmission email, the Agreement
 * email, or a manually sent copy of either) reserves the case as
 * awaiting_merchant before the slow part: the Resend call or the proof upload.
 * The reservation opens a request in the same transaction; the request is
 * then resolved exactly once:
 *
 *   sent    the success history (and Agreement details) are written
 *   failed  the reservation is undone: the case returns to working, the
 *           email's link is invalidated, and the failure is recorded
 *
 * Normally the flow resolves its own request. A request still open after
 * STALE_AFTER_MS (a crash, a restart, or an error between the steps) is
 * resolved by recoverStaleMerchantRequests from what the email log knows.
 */
export type MerchantRequestKind =
  (typeof caseMerchantRequests.$inferSelect)['kind']

export type MerchantRequestOutcome =
  | { status: 'sent' }
  | { status: 'failed'; error: string | null }

/** Longer than any send or upload takes; shorter than a merchant would wait. */
export const MERCHANT_REQUEST_STALE_AFTER_MS = 15 * 60 * 1000

export const INTERRUPTED_REQUEST_MESSAGE =
  'Sending was interrupted before it finished. Send it again.'

type ResubmissionDetails = {
  rejectedFields: string[]
  rejectedFieldLabels: string[]
  rejectedFieldDetails: unknown[]
  recipient: string
  recipientEmailType: string
}

type AgreementDetails = {
  recipient: string
  recipientEmailType: string
  remarks: string | null
}

type OpenInput =
  | {
      kind: 'document_resubmission'
      tokenId: string
      emailLogId: string
      details: ResubmissionDetails
    }
  | { kind: 'agreement'; emailLogId: string; details: AgreementDetails }
  | { kind: 'document_resubmission_manual' | 'agreement_manual' }

/** Opens a request; call it in the transaction that reserves the case. */
export async function openMerchantRequest(
  tx: DbTransaction,
  input: OpenInput & {
    caseId: string
    actorId: string
    releaseStageId: string | null
  },
) {
  const [row] = await tx
    .insert(caseMerchantRequests)
    .values({
      caseId: input.caseId,
      kind: input.kind,
      actorId: input.actorId,
      releaseStageId: input.releaseStageId,
      emailLogId: 'emailLogId' in input ? input.emailLogId : null,
      tokenId: 'tokenId' in input ? input.tokenId : null,
      details: 'details' in input ? input.details : {},
    })
    .returning({ id: caseMerchantRequests.id })

  if (!row) throw new AppError(500, 'Failed to record the merchant request.')
  return row.id
}

/**
 * Resolves a manual request as sent inside the caller's transaction (which
 * writes its own history). Throws 409 if recovery already undid it, so the
 * caller's writes roll back.
 */
export async function markManualMerchantRequestSent(
  tx: DbTransaction,
  requestId: string,
) {
  const [resolved] = await tx
    .update(caseMerchantRequests)
    .set({ resolvedAt: new Date(), outcome: 'sent' })
    .where(
      and(
        eq(caseMerchantRequests.id, requestId),
        isNull(caseMerchantRequests.resolvedAt),
      ),
    )
    .returning({ id: caseMerchantRequests.id })

  if (!resolved) {
    throw new AppError(409, INTERRUPTED_REQUEST_MESSAGE)
  }
}

/**
 * Applies the outcome of a request once. Returns false if it was already
 * resolved (by the flow itself or by recovery).
 */
export async function resolveMerchantRequest(
  requestId: string,
  outcome: MerchantRequestOutcome,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(caseMerchantRequests)
      .where(
        and(
          eq(caseMerchantRequests.id, requestId),
          isNull(caseMerchantRequests.resolvedAt),
        ),
      )
      .limit(1)
      .for('update')

    if (!request) return false

    const [email] = request.emailLogId
      ? await tx
          .select({
            ccEmails: emailLog.ccEmails,
            bccEmails: emailLog.bccEmails,
            replyTo: emailLog.replyTo,
          })
          .from(emailLog)
          .where(eq(emailLog.id, request.emailLogId))
          .limit(1)
      : []
    const recipients = {
      cc: email?.ccEmails ?? [],
      bcc: email?.bccEmails ?? [],
      replyTo: email?.replyTo ?? [],
    }
    const now = new Date()

    if (outcome.status === 'failed') {
      await writeCaseState(tx, {
        event: 'release_request',
        where: eq(cases.id, request.caseId),
        set: { currentStageId: request.releaseStageId, updatedAt: now },
      })
    }

    switch (request.kind) {
      case 'document_resubmission': {
        const details = request.details as ResubmissionDetails
        if (outcome.status === 'sent') {
          await tx.insert(caseHistory).values([
            {
              caseId: request.caseId,
              actorId: request.actorId,
              action: 'rejections_prepared',
              details: {
                total: details.rejectedFields.length,
                rejected: details.rejectedFields.length,
                approved: 0,
                rejectedFields: details.rejectedFields,
                rejectedFieldLabels: details.rejectedFieldLabels,
                rejectedFieldDetails: details.rejectedFieldDetails,
              },
              createdAt: request.createdAt,
            },
            {
              caseId: request.caseId,
              actorId: request.actorId,
              action: 'resubmission_email_sent',
              details: {
                tokenId: request.tokenId,
                rejectedFields: details.rejectedFields,
                rejectedFieldLabels: details.rejectedFieldLabels,
                rejectedFieldDetails: details.rejectedFieldDetails,
                emailLogId: request.emailLogId,
                recipient: details.recipient,
                ...recipients,
                recipientEmailType: details.recipientEmailType,
              },
              createdAt: now,
            },
          ])
        } else {
          if (request.tokenId) {
            await consumeResubmissionTokens(
              tx,
              eq(caseResubmissionTokens.id, request.tokenId),
              'invalidated',
            )
          }
          await tx.insert(caseHistory).values({
            caseId: request.caseId,
            actorId: request.actorId,
            action: 'resubmission_email_failed',
            details: {
              tokenId: request.tokenId,
              emailLogId: request.emailLogId,
              error: outcome.error,
            },
          })
        }
        break
      }
      case 'agreement': {
        const details = request.details as AgreementDetails
        await tx
          .update(agreementCaseDetails)
          .set({
            emailStatus: outcome.status,
            emailLogId: request.emailLogId,
            emailSentAt: outcome.status === 'sent' ? now : null,
            emailRecipient: details.recipient,
            lastRejectionRemarks: details.remarks,
            updatedAt: now,
          })
          .where(eq(agreementCaseDetails.caseId, request.caseId))
        await tx.insert(caseHistory).values({
          caseId: request.caseId,
          actorId: request.actorId,
          action:
            outcome.status === 'sent'
              ? 'agreement_email_sent'
              : 'agreement_email_failed',
          details: {
            emailLogId: request.emailLogId,
            recipient: details.recipient,
            ...recipients,
            recipientEmailType: details.recipientEmailType,
            remarks: details.remarks,
            error: outcome.status === 'failed' ? outcome.error : null,
          },
        })
        break
      }
      case 'document_resubmission_manual':
      case 'agreement_manual': {
        // A manual copy is resolved as sent by its own flow; here it can only
        // be undone, so the owner sees why the case is working again.
        if (outcome.status === 'failed') {
          await tx.insert(caseHistory).values({
            caseId: request.caseId,
            actorId: request.actorId,
            action: 'merchant_request_interrupted',
            details: { kind: request.kind, error: outcome.error },
          })
        }
        break
      }
    }

    await tx
      .update(caseMerchantRequests)
      .set({ resolvedAt: now, outcome: outcome.status })
      .where(eq(caseMerchantRequests.id, request.id))

    return true
  })
}

/**
 * Resolves requests left open for longer than the stale window. An email the
 * log still shows as queued never got Resend's answer, so it is marked failed
 * and its request undone; any other email status decides the outcome.
 */
export async function recoverStaleMerchantRequests(
  input: { staleAfterMs?: number; limit?: number } = {},
) {
  const db = getDb()
  const staleBefore = new Date(
    Date.now() - (input.staleAfterMs ?? MERCHANT_REQUEST_STALE_AFTER_MS),
  )
  const stale = await db
    .select({
      id: caseMerchantRequests.id,
      emailLogId: caseMerchantRequests.emailLogId,
    })
    .from(caseMerchantRequests)
    .where(
      and(
        isNull(caseMerchantRequests.resolvedAt),
        lt(caseMerchantRequests.createdAt, staleBefore),
      ),
    )
    .orderBy(asc(caseMerchantRequests.createdAt))
    .limit(input.limit ?? 20)

  let recovered = 0
  for (const request of stale) {
    let outcome: MerchantRequestOutcome = {
      status: 'failed',
      error: INTERRUPTED_REQUEST_MESSAGE,
    }

    if (request.emailLogId) {
      const now = new Date()
      await db
        .update(emailLog)
        .set({
          status: 'failed',
          errorMsg: INTERRUPTED_REQUEST_MESSAGE,
          statusDetail: INTERRUPTED_REQUEST_MESSAGE,
          statusUpdatedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(emailLog.id, request.emailLogId),
            eq(emailLog.status, 'queued'),
          ),
        )
      const [email] = await db
        .select({ status: emailLog.status, detail: emailLog.statusDetail })
        .from(emailLog)
        .where(eq(emailLog.id, request.emailLogId))
        .limit(1)
      if (email && !UNDELIVERED_EMAIL_STATUSES.has(email.status)) {
        outcome = { status: 'sent' }
      } else if (email) {
        outcome = {
          status: 'failed',
          error: email.detail ?? INTERRUPTED_REQUEST_MESSAGE,
        }
      }
    }

    if (await resolveMerchantRequest(request.id, outcome)) {
      recovered += 1
      console.warn('[merchant-request.recovered]', {
        requestId: request.id,
        outcome: outcome.status,
      })
    }
  }

  return { recovered }
}
