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
  agreementCaseDetails,
  caseComments,
  caseLinks,
  caseFiles,
  caseFieldReviews,
  documentReviewDetails,
  caseHistory,
  caseResubmissionTokens,
  cases,
  midGoLiveTokens,
  merchantDocuments,
  merchants,
  portalMidLimitApplications,
  queues,
  queueCaseSequences,
  queueStages,
  subMerchantFormDetails,
  subMerchantDraftTemplates,
  users,
} from '../../db/schema'
import type { Merchant } from '../../db/schema'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'
import { env } from '../../config/env'
import type { SessionUser } from '../../types/auth'
import { assertFileContentSignature } from '../../lib/storage/file-signatures'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import {
  ensureQueueStages,
  getVisibleStagesForQueue,
  getStatusForStage,
  resolveStageForCase,
  resolveUniqueStageForStatus,
} from '../queues/queue-stage-defaults'
import {
  isQueueWorkflowType,
  type QueueWorkflowType,
} from '../queues/queue-workflow'
import {
  notifyAssignment,
  notifyOnComment,
} from '../notifications/notifications.service'
import { sendEmail } from '../email/email.service'
import { DocumentResubmissionEmail } from '../email/templates/document-resubmission'
import { AgreementEmail } from '../email/templates/agreement'
import { MidCreationEmail } from '../email/templates/mid-creation'
import { LiveActivationEmail } from '../email/templates/live-activation'
import {
  defaultPaymentMethodSettings,
  defaultPayoutMethodSettings,
  getConfiguredAgreementDraftForMerchantType,
  getEmailSendingModeSettings,
  getLimitsAndMdrSettings,
  getLinkDeadlineSettings,
  getMerchantPortalSettings,
  getPaymentMethodSettings,
  getPayoutMethodSettings,
} from '../configuration/configuration.service'
import { paymentMethodSettingsSchema } from '../configuration/configuration.schemas'
import type { PaymentMethodSettings } from '../configuration/configuration.schemas'
import {
  assertCreationRequirementsSatisfied,
  triggerCasesAfterSuccessfulClose,
} from './case-flow.service'
import { getRequiredDocumentTypes } from '../merchants/merchants.schemas'
import type { MerchantDocumentType } from '../merchants/merchants.schemas'
import {
  PRIVATE_INTERNAL_CASE_FILES_PATH,
  PRIVATE_KYC_APPROVED_PATH,
  PRIVATE_KYC_REJECTED_PATH,
  PUBLIC_AGREEMENT_PATH,
  buildCaseFolderName,
  ensureMerchantFolderPath,
  getRejectedRoundFolderName,
} from '../merchants/merchant-drive-folders'
import {
  DOCUMENT_TYPE_LABELS,
  MERCHANT_FIELD_LABELS,
  getDocumentIdFromFieldName,
  isDocumentFieldName,
} from './field-labels'
import { issueToken } from './case-resubmission-tokens.service'
import { caseStatusValues, isValidStatusTransition } from './cases.schemas'
import type {
  CaseStatusValue,
  CloseUnsuccessfulInput,
  CreateCaseInput,
  CreateCommentInput,
  ListCasesQuery,
  MarkLiveLimitsAppliedInput,
  MarkTestingLimitsAppliedInput,
  MerchantPortalRole,
  SaveDocumentReviewSubMerchantInput,
  SaveFieldReviewsInput,
  SaveMidCreationDetailsInput,
  SaveWordpressWebsiteInput,
  SelectSubMerchantFormInput,
  SendAgreementEmailInput,
  SendLiveEmailInput,
  SendMidCreationEmailInput,
  EmailRecipientType,
  UpdateCaseStatusInput,
} from './cases.schemas'
import {
  AGREEMENT_CLIENT_FILE_KIND,
  AGREEMENT_FINAL_FILE_KIND
} from './agreement.config'
import {
  SUB_MERCHANT_EMAIL_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_KIND
} from './sub-merchant-form.config'
import { isCaseSlaBreached } from './case-sla'
import {
  assertCanViewCase,
  assertCanWorkCase,
  assertOwnerCanWorkCases,
  getAgentQueueAccess,
} from './case-access.service'
import {
  loadQueueStageForCase,
  transitionCaseState,
} from './case-transition.service'

import type { DbTransaction } from './case-db'
import {
  enrichResubmissionWhatsappHistoryDetails,
  getStringDetail,
  sanitizeCaseHistoryDetails,
} from './case-history-format'

export async function listCaseComments(caseId: string, actor: SessionUser) {
  const db = getDb()
  await assertCanViewCase(caseId, actor)

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
  actor: SessionUser,
  input: CreateCommentInput,
) {
  const db = getDb()
  await assertCanWorkCase(caseId, actor.userId)

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
      authorId: actor.userId,
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
        authorId: actor.userId,
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

export async function listCaseHistory(caseId: string, actor: SessionUser) {
  const db = getDb()
  await assertCanViewCase(caseId, actor)

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true, merchantId: true },
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
    .orderBy(
      desc(caseHistory.createdAt),
      sql`case
        when ${caseHistory.action} = 'resubmission_email_sent' then 2
        when ${caseHistory.action} = 'rejections_prepared' then 1
        else 0
      end desc`,
      desc(caseHistory.id),
    )

  const merchantContact = await db.query.merchants.findFirst({
    where: eq(merchants.id, existing.merchantId),
    columns: { activeWhatsappNumber: true },
  })
  const activeWhatsappNumber = merchantContact?.activeWhatsappNumber ?? null

  const sanitizedHistory = history.map((entry) => ({
    ...entry,
    details: enrichResubmissionWhatsappHistoryDetails(
      entry.action,
      sanitizeCaseHistoryDetails(entry.action, entry.details),
      activeWhatsappNumber,
    ),
  }))
  const screenshotFileIds = sanitizedHistory
    .map((entry) => getStringDetail(entry.details, 'screenshotFileId'))
    .filter((id): id is string => Boolean(id))

  if (screenshotFileIds.length === 0) return sanitizedHistory

  const proofFiles = await db
    .select({
      id: caseFiles.id,
      originalName: caseFiles.originalName,
      mimeType: caseFiles.mimeType,
      sizeBytes: caseFiles.sizeBytes,
      googleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      googleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      createdAt: caseFiles.createdAt,
    })
    .from(caseFiles)
    .where(inArray(caseFiles.id, screenshotFileIds))
  const proofFileById = new Map(proofFiles.map((file) => [file.id, file]))

  return sanitizedHistory.map((entry) => {
    const screenshotFileId = getStringDetail(entry.details, 'screenshotFileId')
    const proofFile = screenshotFileId
      ? proofFileById.get(screenshotFileId)
      : null

    if (!proofFile) return entry

    return {
      ...entry,
      details: {
        ...(entry.details as Record<string, unknown>),
        proofFile: {
          ...proofFile,
          createdAt: proofFile.createdAt.toISOString(),
        },
      },
    }
  })
}
