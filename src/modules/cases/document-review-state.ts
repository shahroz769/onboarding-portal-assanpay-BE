import { eq, inArray, sql } from 'drizzle-orm'

import type { DbTransaction } from '../../db/client'
import { caseFieldReviews, merchantDocuments } from '../../db/schema'
import type { StorageUploadResult } from '../../lib/storage/google-drive'
import { getDocumentIdFromFieldName } from './field-labels'

/**
 * Field reviews and the merchant documents they decide, in one place. A
 * document's status follows the latest review of its `doc_<id>` field on a
 * Documents Review case:
 *
 *   pending ──review──▶ approved | rejected | pending (review cleared)
 *   any ──merchant replaces the file──▶ pending (its review too)
 *   a removed document is deleted; its review reads approved
 *
 * Both rows change in the same transaction; migration 0111 checks at commit
 * that the document agrees with its latest review (latest by updated_at or
 * resubmitted_at, whichever is later).
 */

export type FieldReviewDecision = {
  fieldName: string
  status: 'pending' | 'approved' | 'rejected'
  remarks: string | null
}

/** The Drive move of a reviewed document into its Approved/Rejected folder. */
export type ReviewedDocumentMove = {
  documentId: string
  status: 'approved' | 'rejected'
  googleDriveWebViewLink: string
  googleDriveDownloadLink: string | null
  googleDriveFolderId: string
}

/**
 * Saves the owner's decisions. On a Documents Review case each reviewed
 * document takes its review's status, with its new Drive location when the
 * file was moved. Other workflows review fields without touching documents.
 */
export async function recordFieldReviews(
  tx: DbTransaction,
  input: {
    caseId: string
    reviewerId: string
    decisions: FieldReviewDecision[]
    documentMoves: ReviewedDocumentMove[]
    updatesDocuments: boolean
    now: Date
  },
) {
  const { now } = input
  await tx
    .insert(caseFieldReviews)
    .values(
      input.decisions.map((decision) => ({
        caseId: input.caseId,
        fieldName: decision.fieldName,
        status: decision.status,
        remarks: decision.remarks,
        reviewedBy: input.reviewerId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [caseFieldReviews.caseId, caseFieldReviews.fieldName],
      set: {
        status: sql`excluded.status`,
        remarks: sql`excluded.remarks`,
        reviewedBy: input.reviewerId,
        updatedAt: now,
      },
    })

  if (!input.updatesDocuments) return

  const moveByDocument = new Map(
    input.documentMoves.map((move) => [move.documentId, move]),
  )
  for (const decision of input.decisions) {
    const documentId = getDocumentIdFromFieldName(decision.fieldName)
    if (!documentId) continue
    const move = moveByDocument.get(documentId)

    await tx
      .update(merchantDocuments)
      .set({
        status: decision.status,
        ...(move
          ? {
              googleDriveWebViewLink: move.googleDriveWebViewLink,
              googleDriveDownloadLink: move.googleDriveDownloadLink,
              googleDriveFolderId: move.googleDriveFolderId,
            }
          : {}),
        updatedAt: now,
      })
      .where(eq(merchantDocuments.id, documentId))
  }
}

/**
 * Applies a merchant's resubmission: replaced files go back to pending with
 * their reviews, edited fields are pending again, removed documents are
 * deleted and their reviews read approved.
 */
export async function recordMerchantResubmission(
  tx: DbTransaction,
  input: {
    replacedDocuments: Array<{ documentId: string; file: StorageUploadResult }>
    removedDocumentIds: string[]
    resubmittedReviewIds: string[]
    removedReviewIds: string[]
    now: Date
  },
) {
  const { now } = input

  for (const { documentId, file } of input.replacedDocuments) {
    await tx
      .update(merchantDocuments)
      .set({
        originalName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        googleDriveFileId: file.fileId,
        googleDriveWebViewLink: file.webViewLink,
        googleDriveDownloadLink: file.downloadLink,
        googleDriveFolderId: file.folderId,
        // A new file is unreviewed, like its field review below.
        status: 'pending',
        updatedAt: now,
      })
      .where(eq(merchantDocuments.id, documentId))
  }

  if (input.removedDocumentIds.length > 0) {
    await tx
      .delete(merchantDocuments)
      .where(inArray(merchantDocuments.id, input.removedDocumentIds))
  }

  if (input.resubmittedReviewIds.length > 0) {
    await tx
      .update(caseFieldReviews)
      .set({
        status: 'pending',
        remarks: null,
        resubmittedAt: now,
      })
      .where(inArray(caseFieldReviews.id, input.resubmittedReviewIds))
  }

  if (input.removedReviewIds.length > 0) {
    await tx
      .update(caseFieldReviews)
      .set({
        status: 'approved',
        remarks: null,
        resubmittedAt: now,
      })
      .where(inArray(caseFieldReviews.id, input.removedReviewIds))
  }
}
