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
  notInArray,
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
import { assertCreationRequirementsSatisfied } from './case-flow.service'
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
  assertOwnerCanWorkCases,
  getAgentQueueAccess,
} from './case-access.service'
import {
  loadQueueStageForCase,
  transitionCaseState,
} from './case-transition.service'

import type { DbTransaction } from './case-db'
import {
  AGREEMENT_EMAIL_PROOF_KIND,
  AGREEMENT_FILE_EXTENSIONS,
  AGREEMENT_FILE_MIME_TYPES,
  AGREEMENT_WHATSAPP_PROOF_KIND,
  DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS,
  EMAIL_PROOF_MIME_TYPES,
  LIVE_ACTIVATION_EMAIL_PROOF_KIND,
  LIVE_ACTIVATION_WHATSAPP_PROOF_KIND,
  MAX_PHYSICAL_AGREEMENT_BYTES,
  MAX_SUB_MERCHANT_FINAL_FORM_BYTES,
  MAX_WORDPRESS_SCREENSHOT_BYTES,
  MID_CREATION_CREDENTIALS_SENT_ACTIONS,
  MID_CREATION_EMAIL_PROOF_KIND,
  MID_CREATION_WHATSAPP_PROOF_KIND,
  PHYSICAL_AGREEMENT_EXTENSIONS,
  PHYSICAL_AGREEMENT_FILE_KIND,
  PHYSICAL_AGREEMENT_MIME_TYPES,
  RESUBMISSION_EMAIL_PROOF_KIND,
  RESUBMISSION_WHATSAPP_PROOF_KIND,
  SUB_MERCHANT_FINAL_FORM_EXTENSIONS,
  SUB_MERCHANT_FINAL_FORM_MIME_TYPES,
  WORDPRESS_SCREENSHOT_EXTENSIONS,
  WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX,
  WORDPRESS_SCREENSHOT_MIME_TYPES,
  WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX,
  caseStatusValueSet,
  type ManualCommunicationChannel,
} from './case-constants'

export async function bulkAssignCases(
  caseIds: string[],
  ownerId: string | null,
  actorId: string,
) {
  const db = getDb()
  const uniqueCaseIds = Array.from(new Set(caseIds))
  const { updatedCases, existingCases } = await db.transaction(async (tx) => {
    const nextOwner = ownerId
      ? await tx.query.users.findFirst({
          where: eq(users.id, ownerId),
          columns: { id: true, name: true, status: true },
        })
      : null

    if (ownerId && !nextOwner) {
      throw new AppError(404, 'User not found.')
    }
    if (nextOwner && nextOwner.status !== 'active') {
      throw new AppError(403, 'Inactive employees cannot own cases.')
    }

    const existingCases = await tx
      .select({
        id: cases.id,
        ownerId: cases.ownerId,
        ownerName: users.name,
        queueId: cases.queueId,
        status: cases.status,
        closeOutcome: cases.closeOutcome,
        closedAt: cases.closedAt,
        currentStageId: cases.currentStageId,
        currentStageName: queueStages.name,
        currentStageCategory: queueStages.category,
      })
      .from(cases)
      .leftJoin(users, eq(cases.ownerId, users.id))
      .leftJoin(queueStages, eq(cases.currentStageId, queueStages.id))
      .where(inArray(cases.id, uniqueCaseIds))
      .orderBy(asc(cases.id))
      .for('update', { of: cases })

    if (existingCases.length !== uniqueCaseIds.length) {
      throw new AppError(404, 'One or more cases were not found.')
    }

    const closedCase = existingCases.find(
      (caseRecord) =>
        caseRecord.status === 'closed' ||
        caseRecord.status === 'error' ||
        caseRecord.currentStageCategory === 'closed' ||
        Boolean(caseRecord.closeOutcome) ||
        Boolean(caseRecord.closedAt),
    )
    if (closedCase) {
      throw new AppError(
        400,
        'Closed cases cannot be assigned or transferred.',
      )
    }

    await assertOwnerCanWorkCases(ownerId, uniqueCaseIds, tx)

    const queueIds = Array.from(
      new Set(existingCases.map((item) => item.queueId)),
    )
    const stageRows = await tx
      .select({
        id: queueStages.id,
        queueId: queueStages.queueId,
        name: queueStages.name,
        slug: queueStages.slug,
        category: queueStages.category,
      })
      .from(queueStages)
      .where(inArray(queueStages.queueId, queueIds))

    const stagesByQueueId = new Map<
      string,
      Array<(typeof stageRows)[number]>
    >()
    for (const stage of stageRows) {
      const queueStageRows = stagesByQueueId.get(stage.queueId) ?? []
      queueStageRows.push(stage)
      stagesByQueueId.set(stage.queueId, queueStageRows)
    }

    const stageByQueue = new Map<
      string,
      {
        newStageId: string
        workingStageId: string
        newStageName: string
        workingStageName: string
      }
    >()
    for (const queueId of queueIds) {
      const queueStageRows = stagesByQueueId.get(queueId) ?? []
      const newStage = queueStageRows.find(
        (stage) => stage.category === 'new',
      )
      const workingStage = queueStageRows.find(
        (stage) => stage.slug === 'working',
      )
      if (!newStage || !workingStage) {
        throw new AppError(
          500,
          'Required New and Working stages are not configured.',
        )
      }
      stageByQueue.set(queueId, {
        newStageId: newStage.id,
        workingStageId: workingStage.id,
        newStageName: newStage.name,
        workingStageName: workingStage.name,
      })
    }

    const changedCases = existingCases.filter(
      (caseRecord) => caseRecord.ownerId !== ownerId,
    )
    if (changedCases.length === 0) {
      return { updatedCases: changedCases, existingCases }
    }

    const now = new Date()
    if (ownerId === null) {
      for (const queueId of queueIds) {
        const queueCaseIds = changedCases
          .filter((caseRecord) => caseRecord.queueId === queueId)
          .map((caseRecord) => caseRecord.id)
        if (queueCaseIds.length === 0) continue
        const stages = stageByQueue.get(queueId)
        if (!stages) {
          throw new AppError(500, 'Queue stages are not configured.')
        }
        await tx
          .update(cases)
          .set({
            ownerId: null,
            currentStageId: stages.newStageId,
            status: 'new',
            closeOutcome: null,
            closeReason: null,
            closedAt: null,
            slaBreached: null,
            updatedAt: now,
          })
          .where(inArray(cases.id, queueCaseIds))
      }
    } else {
      const changedCaseIds = changedCases.map((caseRecord) => caseRecord.id)
      await tx
        .update(cases)
        .set({ ownerId, updatedAt: now })
        .where(inArray(cases.id, changedCaseIds))

      for (const queueId of queueIds) {
        const workingCaseIds = changedCases
          .filter(
            (caseRecord) =>
              caseRecord.queueId === queueId &&
              caseRecord.currentStageCategory === 'new',
          )
          .map((caseRecord) => caseRecord.id)
        if (workingCaseIds.length === 0) continue
        const stages = stageByQueue.get(queueId)
        if (!stages) {
          throw new AppError(500, 'Queue stages are not configured.')
        }
        await tx
          .update(cases)
          .set({
            currentStageId: stages.workingStageId,
            status: 'working',
            updatedAt: now,
          })
          .where(inArray(cases.id, workingCaseIds))
      }
    }

    await tx.insert(caseHistory).values(
      changedCases.map((caseRecord) => {
        const stages = stageByQueue.get(caseRecord.queueId)
        if (!stages) {
          throw new AppError(500, 'Queue stages are not configured.')
        }
        const shouldStartWorking =
          ownerId !== null && caseRecord.currentStageCategory === 'new'
        return {
          caseId: caseRecord.id,
          actorId,
          action:
            ownerId === null
              ? 'owner_unassigned'
              : caseRecord.ownerId
                ? 'owner_transferred'
                : 'owner_assigned',
          details: {
            fromOwner: caseRecord.ownerName ?? 'AP System',
            toOwner: nextOwner?.name ?? 'AP System',
            fromStage: caseRecord.currentStageName,
            toStage:
              ownerId === null
                ? stages.newStageName
                : shouldStartWorking
                  ? stages.workingStageName
                  : caseRecord.currentStageName,
          },
        }
      }),
    )

    return { updatedCases: changedCases, existingCases }
  })

  if (updatedCases.length > 0) {
    // Notifications (best-effort) for each affected case
    try {
      const actor = await db.query.users.findFirst({
        where: eq(users.id, actorId),
        columns: { name: true },
      })
      const affectedIds = updatedCases.map((item) => item.id)
      const metas = await db
        .select({
          id: cases.id,
          caseNumber: cases.caseNumber,
          queueName: queues.name,
        })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(inArray(cases.id, affectedIds))
      const metaById = new Map(metas.map((m) => [m.id, m]))
      const previousById = new Map(
        existingCases.map((c) => [c.id, c.ownerId ?? null]),
      )
      await Promise.all(
        affectedIds.map((cid) => {
          const meta = metaById.get(cid)
          if (!meta) return Promise.resolve()
          return notifyAssignment({
            caseId: cid,
            caseNumber: meta.caseNumber,
            queueName: meta.queueName,
            actorId,
            actorName: actor?.name ?? 'Someone',
            newOwnerId: ownerId,
            previousOwnerId: previousById.get(cid) ?? null,
          })
        }),
      )
    } catch (error) {
      console.error('[notifications] bulkAssignCases notify failed', error)
    }
  }

  return { updated: updatedCases.length }
}

// ─── Update Case Status ─────────────────────────────────────────────────────

export async function assignCase(
  caseId: string,
  ownerId: string | null,
  actorId: string,
) {
  const db = getDb()
  const nextOwner = ownerId
    ? await db.query.users.findFirst({
        where: eq(users.id, ownerId),
        columns: { id: true, name: true, status: true },
      })
    : null

  // Verify case exists
  const existing = await db
    .select({
      id: cases.id,
      ownerId: cases.ownerId,
      ownerName: users.name,
      queueId: cases.queueId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
      closedAt: cases.closedAt,
      currentStageId: cases.currentStageId,
      currentStageName: queueStages.name,
      currentStageCategory: queueStages.category,
    })
    .from(cases)
    .leftJoin(users, eq(cases.ownerId, users.id))
    .leftJoin(queueStages, eq(cases.currentStageId, queueStages.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  const existingCase = existing[0]

  if (!existingCase) {
    throw new AppError(404, 'Case not found.')
  }

  if (
    existingCase.status === 'closed' ||
    existingCase.status === 'error' ||
    existingCase.currentStageCategory === 'closed' ||
    Boolean(existingCase.closeOutcome) ||
    Boolean(existingCase.closedAt)
  ) {
    throw new AppError(400, 'Closed cases cannot be assigned or transferred.')
  }

  if (ownerId && !nextOwner) {
    throw new AppError(404, 'User not found.')
  }
  if (nextOwner && nextOwner.status !== 'active') {
    throw new AppError(403, 'Inactive employees cannot own cases.')
  }

  if (existingCase.ownerId === ownerId) {
    return {
      id: existingCase.id,
      ownerId: existingCase.ownerId,
      updatedAt: new Date(),
    }
  }

  await assertOwnerCanWorkCases(ownerId, [caseId])

  const stageRows = await db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, existingCase.queueId))
  const newStage = stageRows.find((stage) => stage.category === 'new')
  const workingStage = stageRows.find((stage) => stage.slug === 'working')
  if (!newStage || !workingStage) {
    throw new AppError(
      500,
      'Required New and Working stages are not configured.',
    )
  }

  const shouldStartWorking =
    ownerId !== null && existingCase.currentStageCategory === 'new'

  const targetStage =
    ownerId === null
      ? newStage
      : shouldStartWorking
        ? workingStage
        : existingCase.currentStageId
          ? await loadQueueStageForCase(
              db,
              existingCase.currentStageId,
              existingCase.queueId,
            )
          : null

  if (!targetStage) {
    throw new AppError(500, 'Case has no current stage configured.')
  }

  const historyAction =
    ownerId === null
      ? 'owner_unassigned'
      : existingCase.ownerId
        ? 'owner_transferred'
        : 'owner_assigned'

  const updated = await transitionCaseState({
    caseId,
    actorId,
    targetStage,
    checkCloseBlockers: false,
    applyTerminalTimestamps: false,
    historyAction,
    historyDetails: {
      fromOwner: existingCase.ownerName ?? 'AP System',
      toOwner: nextOwner?.name ?? 'AP System',
      fromStage: existingCase.currentStageName,
      toStage: targetStage.name,
    },
    extraFields:
      ownerId === null
        ? {
            ownerId: null,
            closeOutcome: null,
            closeReason: null,
            closedAt: null,
            slaBreached: null,
          }
        : {
            ownerId,
          },
    expected: {
      status: existingCase.status as CaseStatusValue,
      currentStageId: existingCase.currentStageId,
      ownerId: existingCase.ownerId,
    },
    conflictMessage: 'Case assignment was already updated.',
  })

  if (existingCase.ownerId !== ownerId) {
    // Notifications (best-effort)
    try {
      const meta = await db
        .select({ caseNumber: cases.caseNumber, queueName: queues.name })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .where(eq(cases.id, caseId))
        .limit(1)
      const actor = await db.query.users.findFirst({
        where: eq(users.id, actorId),
        columns: { name: true },
      })
      if (meta[0]) {
        await notifyAssignment({
          caseId,
          caseNumber: meta[0].caseNumber,
          queueName: meta[0].queueName,
          actorId,
          actorName: actor?.name ?? 'Someone',
          newOwnerId: ownerId,
          previousOwnerId: existingCase.ownerId ?? null,
        })
      }
    } catch (error) {
      console.error('[notifications] assignCase notify failed', error)
    }
  }

  return {
    id: updated.id,
    ownerId: updated.ownerId,
    updatedAt: updated.updatedAt,
  }
}

// ─── Update Case Priority ────────────────────────────────────────────────────

export async function updateCasePriority(
  caseId: string,
  priority: 'normal' | 'high',
) {
  const db = getDb()

  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: {
      id: true,
      status: true,
      closeOutcome: true,
      closedAt: true,
    },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  if (
    existing.status === 'closed' ||
    existing.status === 'error' ||
    existing.closeOutcome != null ||
    existing.closedAt != null
  ) {
    throw new AppError(409, 'Priority cannot be changed for a closed case.')
  }

  const [updated] = await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(
      and(
        eq(cases.id, caseId),
        notInArray(cases.status, ['closed', 'error']),
        isNull(cases.closeOutcome),
        isNull(cases.closedAt),
      ),
    )
    .returning({
      id: cases.id,
      priority: cases.priority,
      updatedAt: cases.updatedAt,
    })

  if (!updated) {
    throw new AppError(409, 'Priority cannot be changed for a closed case.')
  }

  return updated
}

// ─── Cascade Merchant Priority to Cases ──────────────────────────────────────

export async function cascadeMerchantPriority(
  merchantId: string,
  priority: 'normal' | 'high',
) {
  const db = getDb()

  await db
    .update(cases)
    .set({ priority, updatedAt: new Date() })
    .where(
      and(
        eq(cases.merchantId, merchantId),
        notInArray(cases.status, ['closed', 'error']),
        isNull(cases.closeOutcome),
        isNull(cases.closedAt),
      ),
    )
}

// ─── Get Case Detail ────────────────────────────────────────────────────────

export async function takeOwnership(caseId: string, userId: string) {
  const db = getDb()
  const [actor, existing] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { name: true },
    }),
    db
      .select({
        id: cases.id,
        ownerId: cases.ownerId,
        currentStageId: cases.currentStageId,
        queueId: cases.queueId,
        status: cases.status,
        closeOutcome: cases.closeOutcome,
        closedAt: cases.closedAt,
      })
      .from(cases)
      .where(eq(cases.id, caseId))
      .limit(1),
  ])

  if (!existing[0]) {
    throw new AppError(404, 'Case not found.')
  }

  const caseData = existing[0]

  if (
    caseData.status === 'closed' ||
    caseData.status === 'error' ||
    Boolean(caseData.closeOutcome) ||
    Boolean(caseData.closedAt)
  ) {
    throw new AppError(400, 'Closed cases cannot be assigned or transferred.')
  }

  if (caseData.ownerId) {
    throw new AppError(400, 'Case already has an owner.')
  }

  // Verify current stage is category 'new'
  const currentStage = caseData.currentStageId
    ? await loadQueueStageForCase(db, caseData.currentStageId, caseData.queueId)
    : null

  if (!currentStage || currentStage.category !== 'new') {
    throw new AppError(400, 'Case is not in the initial stage.')
  }

  // Find next stage (first in_progress stage)
  const nextStage =
    currentStage.slug === 'new'
      ? await db.query.queueStages.findFirst({
          where: and(
            eq(queueStages.queueId, caseData.queueId),
            eq(queueStages.slug, 'working'),
          ),
        })
      : await db.query.queueStages.findFirst({
          where: and(
            eq(queueStages.queueId, caseData.queueId),
            gt(queueStages.order, currentStage.order),
          ),
          orderBy: asc(queueStages.order),
        })

  if (!nextStage) {
    throw new AppError(500, 'No next stage configured for this queue.')
  }

  return transitionCaseState({
    caseId,
    actorId: userId,
    targetStage: nextStage,
    requireWorkAccess: true,
    checkCloseBlockers: false,
    applyTerminalTimestamps: false,
    historyAction: 'ownership_taken',
    historyDetails: {
      fromStage: currentStage.name,
      toStage: nextStage.name,
      fromOwner: 'Unassigned',
      toOwner: actor?.name ?? 'Assigned',
    },
    extraFields: {
      ownerId: userId,
    },
    expected: {
      status: caseData.status as CaseStatusValue,
      currentStageId: caseData.currentStageId,
      ownerMustBeNull: true,
    },
    conflictMessage: 'Case was assigned by another user.',
  })
}

// ─── Advance Stage ──────────────────────────────────────────────────────────
