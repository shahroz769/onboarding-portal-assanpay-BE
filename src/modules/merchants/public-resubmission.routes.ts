import { and, count, eq, inArray, isNull } from 'drizzle-orm'
import { Hono } from 'hono'

import { getDb } from '../../db/client'
import {
  caseFieldReviews,
  caseHistory,
  caseResubmissionTokens,
  cases,
  merchantDocuments,
  merchants,
  queueStages,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { assertFileContentSignature } from '../../lib/storage/file-signatures'
import { assertFileSizeLimit } from '../../lib/storage/file-limits'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import {
  cleanupFailedAttemptObjects,
  createStorageAttemptId,
  listAttemptStorageObjects,
  markStorageObjectsLifecycle,
  recordStorageObject,
  supersedeStorageObjects,
} from '../../lib/storage/ownership'
import type { AppEnv } from '../../types/auth'
import { validateToken } from '../cases/case-resubmission-tokens.service'
import {
  DOCUMENT_TYPE_LABELS,
  getDocumentIdFromFieldName,
  isDocumentFieldName,
  MERCHANT_FIELD_LABELS,
} from '../cases/field-labels'
import { getResubmissionContext } from '../cases/case-documents-review.service'
import {
  getAllowedDocumentTypes,
  getRequiredDocumentTypes,
  normalizeMimeType,
  validateStoredMerchantScalarValues,
} from './merchants.schemas'
import type { MerchantDocumentType } from './merchants.schemas'
import { notifyOnResubmission } from '../notifications/notifications.service'
import {
  PRIVATE_KYC_PENDING_PATH,
  ensureMerchantFolderPath,
  getSubmissionFolderName,
} from './merchant-drive-folders'

export const resubmissionRoutes = new Hono<AppEnv>()

const DOCUMENT_ACTION_PREFIX = '__document_action__:'

// GET /api/public/resubmission/:token - Load context for the resubmission form
resubmissionRoutes.get('/:token', async (c) => {
  const token = c.req.param('token')
  const validated = await validateToken(token)
  const context = await getResubmissionContext(
    validated.caseId,
    validated.expiresAt,
  )
  return c.json(context)
})

// POST /api/public/resubmission/:token - Apply the resubmission
resubmissionRoutes.post('/:token', async (c) => {
  const token = c.req.param('token')
  const validated = await validateToken(token)
  const db = getDb()

  const [caseRow] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      ownerId: cases.ownerId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantType: merchants.merchantType,
      submitterEmail: merchants.submitterEmail,
      ownerFullName: merchants.ownerFullName,
      ownerPhone: merchants.ownerPhone,
      activeWhatsappNumber: merchants.activeWhatsappNumber,
      businessName: merchants.businessName,
      businessPhone: merchants.businessPhone,
      businessEmail: merchants.businessEmail,
      businessAddress: merchants.businessAddress,
      businessWebsite: merchants.businessWebsite,
      websiteCms: merchants.websiteCms,
      businessDescription: merchants.businessDescription,
      businessRegistrationDate: merchants.businessRegistrationDate,
      businessNature: merchants.businessNature,
      estimatedMonthlyTransactions: merchants.estimatedMonthlyTransactions,
      estimatedMonthlyVolume: merchants.estimatedMonthlyVolume,
      accountTitle: merchants.accountTitle,
      bankName: merchants.bankName,
      branchName: merchants.branchName,
      accountNumberIban: merchants.accountNumberIban,
      swiftCode: merchants.swiftCode,
      nextOfKinRelation: merchants.nextOfKinRelation,
      googleDrivePrivateFolderId: merchants.googleDrivePrivateFolderId,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, validated.caseId))
    .limit(1)

  if (!caseRow) {
    throw new AppError(404, 'Case not found.')
  }

  const rejectedReviews = await db
    .select({
      id: caseFieldReviews.id,
      fieldName: caseFieldReviews.fieldName,
      remarks: caseFieldReviews.remarks,
    })
    .from(caseFieldReviews)
    .where(
      and(
        eq(caseFieldReviews.caseId, validated.caseId),
        eq(caseFieldReviews.status, 'rejected'),
      ),
    )

  if (rejectedReviews.length === 0) {
    throw new AppError(400, 'There are no rejected fields to update.')
  }

  const allowedFieldNames = new Set(
    rejectedReviews.map((review) => review.fieldName),
  )
  const reviewByField = new Map(
    rejectedReviews.map((review) => [review.fieldName, review] as const),
  )

  const formData = await c.req.formData()
  const submittedTextFields = new Map<string, string>()
  const submittedFiles = new Map<string, File>()
  const documentActions = new Map<string, 'replace' | 'remove'>()

  for (const [key, value] of formData.entries()) {
    if (key.startsWith(DOCUMENT_ACTION_PREFIX)) {
      const fieldName = key.slice(DOCUMENT_ACTION_PREFIX.length)
      if (
        !allowedFieldNames.has(fieldName) ||
        !isDocumentFieldName(fieldName)
      ) {
        throw new AppError(
          400,
          `Field "${fieldName}" is not pending document resubmission.`,
        )
      }

      if (
        typeof value !== 'string' ||
        (value !== 'replace' && value !== 'remove')
      ) {
        throw new AppError(
          400,
          `Document action for "${fieldName}" is invalid.`,
        )
      }

      documentActions.set(fieldName, value)
      continue
    }

    if (!allowedFieldNames.has(key)) {
      throw new AppError(400, `Field "${key}" is not pending resubmission.`)
    }

    if (isDocumentFieldName(key)) {
      if (typeof value === 'string') {
        throw new AppError(400, `Expected file upload for "${key}".`)
      }
      if (submittedFiles.has(key)) {
        throw new AppError(400, `Document "${key}" must be uploaded once.`)
      }
      submittedFiles.set(key, value)
      continue
    }

    if (!(key in MERCHANT_FIELD_LABELS)) {
      throw new AppError(400, `Unknown merchant field "${key}".`)
    }
    if (typeof value !== 'string') {
      throw new AppError(400, `Field "${key}" must be a text value.`)
    }
    submittedTextFields.set(key, value.trim())
  }

  for (const fieldName of allowedFieldNames) {
    if (isDocumentFieldName(fieldName)) {
      if (!documentActions.has(fieldName)) {
        throw new AppError(400, `Document "${fieldName}" must be resubmitted.`)
      }
      continue
    }

    if (!submittedTextFields.has(fieldName)) {
      throw new AppError(
        400,
        `Field "${fieldName}" is required in this resubmission.`,
      )
    }
  }

  const rejectedDocumentIds = rejectedReviews
    .map((review) =>
      isDocumentFieldName(review.fieldName)
        ? getDocumentIdFromFieldName(review.fieldName)
        : null,
    )
    .filter((id): id is string => Boolean(id))

  const existingDocs = rejectedDocumentIds.length
    ? await db
        .select({
          id: merchantDocuments.id,
          merchantId: merchantDocuments.merchantId,
          documentType: merchantDocuments.documentType,
          originalName: merchantDocuments.originalName,
          googleDriveFileId: merchantDocuments.googleDriveFileId,
          googleDriveFolderId: merchantDocuments.googleDriveFolderId,
          googleDriveWebViewLink: merchantDocuments.googleDriveWebViewLink,
        })
        .from(merchantDocuments)
        .where(inArray(merchantDocuments.id, rejectedDocumentIds))
    : []

  const existingDocsById = new Map(
    existingDocs.map((doc) => [doc.id, doc] as const),
  )
  const requiredDocumentTypes = new Set(
    getRequiredDocumentTypes(caseRow.merchantType),
  )
  const allowedDocumentTypes = new Set(
    getAllowedDocumentTypes(caseRow.merchantType),
  )

  for (const fieldName of allowedFieldNames) {
    if (!isDocumentFieldName(fieldName)) {
      continue
    }

    const docId = getDocumentIdFromFieldName(fieldName)
    if (!docId) {
      throw new AppError(400, `Invalid document field "${fieldName}".`)
    }

    const existing = existingDocsById.get(docId)
    if (!existing || existing.merchantId !== caseRow.merchantId) {
      throw new AppError(400, `Invalid document field "${fieldName}".`)
    }

    if (!allowedDocumentTypes.has(existing.documentType)) {
      throw new AppError(
        400,
        `Document "${existing.documentType}" is not allowed for this business type.`,
      )
    }

    const action = documentActions.get(fieldName)
    if (!action) {
      throw new AppError(400, `Document "${fieldName}" must be resubmitted.`)
    }

    const isRequired = requiredDocumentTypes.has(existing.documentType)
    if (isRequired && action !== 'replace') {
      throw new AppError(
        400,
        `${DOCUMENT_TYPE_LABELS[existing.documentType]} must be uploaded again.`,
      )
    }

    if (action === 'replace') {
      const file = submittedFiles.get(fieldName)
      if (!(file instanceof File) || file.size === 0) {
        throw new AppError(
          400,
          `${DOCUMENT_TYPE_LABELS[existing.documentType]} must be uploaded again.`,
        )
      }
      assertFileSizeLimit(
        file,
        DOCUMENT_TYPE_LABELS[existing.documentType],
      )
      const mimeType = normalizeMimeType(file)
      await assertFileContentSignature({
        file,
        expectedMimeType: mimeType,
        label: DOCUMENT_TYPE_LABELS[existing.documentType],
      })
      continue
    }

    if (submittedFiles.has(fieldName)) {
      throw new AppError(
        400,
        `Document "${fieldName}" cannot be uploaded and removed together.`,
      )
    }
  }

  const validatedMerchantValues = validateStoredMerchantScalarValues({
    submitterEmail:
      submittedTextFields.get('submitterEmail') ?? caseRow.submitterEmail,
    ownerFullName:
      submittedTextFields.get('ownerFullName') ?? caseRow.ownerFullName,
    ownerPhone: submittedTextFields.get('ownerPhone') ?? caseRow.ownerPhone,
    activeWhatsappNumber:
      submittedTextFields.get('activeWhatsappNumber') ??
      caseRow.activeWhatsappNumber,
    businessName:
      submittedTextFields.get('businessName') ?? caseRow.businessName,
    businessPhone:
      submittedTextFields.get('businessPhone') ?? caseRow.businessPhone,
    businessEmail:
      submittedTextFields.get('businessEmail') ?? caseRow.businessEmail,
    businessAddress:
      submittedTextFields.get('businessAddress') ?? caseRow.businessAddress,
    businessWebsite:
      submittedTextFields.get('businessWebsite') ?? caseRow.businessWebsite,
    websiteCms: submittedTextFields.get('websiteCms') ?? caseRow.websiteCms,
    businessDescription:
      submittedTextFields.get('businessDescription') ??
      caseRow.businessDescription,
    businessRegistrationDate:
      submittedTextFields.get('businessRegistrationDate') ??
      caseRow.businessRegistrationDate,
    businessNature:
      submittedTextFields.get('businessNature') ?? caseRow.businessNature,
    merchantType:
      submittedTextFields.get('merchantType') ?? caseRow.merchantType,
    estimatedMonthlyTransactions:
      submittedTextFields.get('estimatedMonthlyTransactions') ??
      String(caseRow.estimatedMonthlyTransactions),
    estimatedMonthlyVolume:
      submittedTextFields.get('estimatedMonthlyVolume') ??
      String(caseRow.estimatedMonthlyVolume),
    accountTitle:
      submittedTextFields.get('accountTitle') ?? caseRow.accountTitle,
    bankName: submittedTextFields.get('bankName') ?? caseRow.bankName,
    branchName: submittedTextFields.get('branchName') ?? caseRow.branchName,
    accountNumberIban:
      submittedTextFields.get('accountNumberIban') ?? caseRow.accountNumberIban,
    swiftCode: submittedTextFields.get('swiftCode') ?? caseRow.swiftCode ?? '',
    nextOfKinRelation:
      submittedTextFields.get('nextOfKinRelation') ?? caseRow.nextOfKinRelation,
  })

  const storage = new GoogleDriveStorageProvider()
  const replaceActions = Array.from(documentActions.entries()).filter(
    ([, action]) => action === 'replace',
  )
  const removeActions = Array.from(documentActions.entries()).filter(
    ([, action]) => action === 'remove',
  )

  const previousResubmissions = await db
    .select({ count: count() })
    .from(caseHistory)
    .where(
      and(
        eq(caseHistory.caseId, caseRow.id),
        eq(caseHistory.action, 'client_resubmitted'),
      ),
    )

  const submissionIndex = Number(previousResubmissions[0]?.count ?? 0) + 2
  const submissionAttemptFolder = `Attempt ${crypto.randomUUID()}`
  const attemptId = createStorageAttemptId()
  const now = new Date()

  const workingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, 'working'),
    ),
  })

  if (!workingStage) {
    throw new AppError(500, 'No working stage configured for this queue.')
  }

  const uploadedByField = new Map<
    string,
    {
      docId: string
      documentType: MerchantDocumentType
      previousFileId: string
      previousFileName: string
      previousFileUrl: string
      uploaded: Awaited<ReturnType<typeof storage.uploadFile>>
    }
  >()

  try {
    if (replaceActions.length > 0) {
      const parentPath = [
        ...PRIVATE_KYC_PENDING_PATH,
        getSubmissionFolderName(submissionIndex),
      ]
      const parentFolder = caseRow.googleDrivePrivateFolderId
        ? await storage.ensureFolderPath(
            caseRow.googleDrivePrivateFolderId,
            parentPath,
          )
        : await ensureMerchantFolderPath({
            merchantId: caseRow.merchantId,
            merchantName: caseRow.merchantName,
            visibility: 'private',
            path: parentPath,
            storage,
          })

      const attemptFolder = await storage.createFolder(
        parentFolder.folderId,
        submissionAttemptFolder,
      )
      await recordStorageObject({
        providerObjectId: attemptFolder.folderId,
        objectKind: 'folder',
        visibility: 'private',
        attemptId,
        merchantId: caseRow.merchantId,
        caseId: caseRow.id,
        parentProviderObjectId: parentFolder.folderId,
        lifecycle: 'provisioning',
        metadata: {
          role: 'resubmission_attempt_folder',
          submissionIndex,
        },
      })

      for (const [fieldName] of replaceActions) {
        const docId = getDocumentIdFromFieldName(fieldName)!
        const existing = existingDocsById.get(docId)!
        const file = submittedFiles.get(fieldName)

        if (!file) {
          throw new AppError(400, `Document "${fieldName}" must be uploaded.`)
        }

        const uploaded = await storage.uploadFile(attemptFolder.folderId, {
          fileName: buildDocumentFileName(existing.documentType, file.name),
          mimeType: normalizeMimeType(file),
          file,
        })

        await recordStorageObject({
          providerObjectId: uploaded.fileId,
          objectKind: 'file',
          visibility: 'private',
          attemptId,
          merchantId: caseRow.merchantId,
          caseId: caseRow.id,
          parentProviderObjectId: uploaded.folderId,
          lifecycle: 'provisioning',
          metadata: {
            documentType: existing.documentType,
            fileName: uploaded.fileName,
            sizeBytes: uploaded.sizeBytes,
            merchantDocumentId: docId,
          },
        })

        uploadedByField.set(fieldName, {
          docId,
          documentType: existing.documentType,
          previousFileId: existing.googleDriveFileId,
          previousFileName: existing.originalName,
          previousFileUrl: existing.googleDriveWebViewLink,
          uploaded,
        })
      }
    }

    const fieldsUpdated = Array.from(allowedFieldNames)
    const resubmittedFieldIds = fieldsUpdated
      .map((fieldName) => reviewByField.get(fieldName)?.id)
      .filter((id): id is string => Boolean(id))
    const fieldsUpdatedDetails = fieldsUpdated.map((fieldName) => {
      const review = reviewByField.get(fieldName)
      if (!isDocumentFieldName(fieldName)) {
        return {
          fieldName,
          label: MERCHANT_FIELD_LABELS[fieldName] ?? fieldName,
          type: 'text' as const,
          rejectionReason: review?.remarks ?? null,
          previousValue: String(
            caseRow[fieldName as keyof typeof caseRow] ?? '',
          ),
          submittedValue: submittedTextFields.get(fieldName) ?? null,
        }
      }

      const docId = getDocumentIdFromFieldName(fieldName)!
      const existing = existingDocsById.get(docId)!
      const uploaded = uploadedByField.get(fieldName)

      return {
        fieldName,
        label:
          DOCUMENT_TYPE_LABELS[
            existing.documentType as keyof typeof DOCUMENT_TYPE_LABELS
          ],
        type: 'document' as const,
        action: documentActions.get(fieldName),
        rejectionReason: review?.remarks ?? null,
        previousFileName: existing.originalName,
        previousFileUrl: existing.googleDriveWebViewLink,
        nextFileName: uploaded?.uploaded.fileName ?? null,
        nextFileUrl: uploaded?.uploaded.webViewLink ?? null,
      }
    })

    await db.transaction(async (tx) => {
      // Consume the token in the same transaction as the completed
      // resubmission. If any database write fails, the token remains usable.
      // Concurrent attempts may upload into isolated attempt folders, but only
      // the request that atomically consumes the token can commit; the other
      // request falls through to failed-attempt storage cleanup.
      const [consumedToken] = await tx
        .update(caseResubmissionTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(caseResubmissionTokens.id, validated.tokenId),
            isNull(caseResubmissionTokens.consumedAt),
          ),
        )
        .returning({ id: caseResubmissionTokens.id })

      if (!consumedToken) {
        throw new AppError(410, 'This resubmission link has already been used.')
      }

      // Clean up any legacy sibling tokens created before the one-active-token
      // constraint was deployed. They must not survive into a later rejection
      // round.
      await tx
        .update(caseResubmissionTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(caseResubmissionTokens.caseId, caseRow.id),
            isNull(caseResubmissionTokens.consumedAt),
          ),
        )

      await tx
        .update(merchants)
        .set({
          submitterEmail: validatedMerchantValues.submitterEmail,
          ownerFullName: validatedMerchantValues.ownerFullName,
          ownerPhone: validatedMerchantValues.ownerPhone,
          activeWhatsappNumber: validatedMerchantValues.activeWhatsappNumber,
          businessName: validatedMerchantValues.businessName,
          businessPhone: validatedMerchantValues.businessPhone,
          businessEmail: validatedMerchantValues.businessEmail,
          businessAddress: validatedMerchantValues.businessAddress,
          businessWebsite: validatedMerchantValues.businessWebsite,
          websiteCms: validatedMerchantValues.websiteCms,
          businessDescription: validatedMerchantValues.businessDescription,
          businessRegistrationDate:
            validatedMerchantValues.businessRegistrationDate,
          businessNature: validatedMerchantValues.businessNature,
          merchantType: validatedMerchantValues.merchantType,
          estimatedMonthlyTransactions:
            validatedMerchantValues.estimatedMonthlyTransactions,
          estimatedMonthlyVolume:
            validatedMerchantValues.estimatedMonthlyVolume,
          accountTitle: validatedMerchantValues.accountTitle,
          bankName: validatedMerchantValues.bankName,
          branchName: validatedMerchantValues.branchName,
          accountNumberIban: validatedMerchantValues.accountNumberIban,
          swiftCode: validatedMerchantValues.swiftCode,
          nextOfKinRelation: validatedMerchantValues.nextOfKinRelation,
          updatedAt: now,
        })
        .where(eq(merchants.id, caseRow.merchantId))

      for (const [, info] of uploadedByField.entries()) {
        await tx
          .update(merchantDocuments)
          .set({
            originalName: info.uploaded.fileName,
            mimeType: info.uploaded.mimeType,
            sizeBytes: info.uploaded.sizeBytes,
            googleDriveFileId: info.uploaded.fileId,
            googleDriveWebViewLink: info.uploaded.webViewLink,
            googleDriveDownloadLink: info.uploaded.downloadLink,
            googleDriveFolderId: info.uploaded.folderId,
            updatedAt: now,
          })
          .where(eq(merchantDocuments.id, info.docId))
      }

      for (const [fieldName] of removeActions) {
        const docId = getDocumentIdFromFieldName(fieldName)!
        await tx
          .delete(merchantDocuments)
          .where(eq(merchantDocuments.id, docId))
      }

      if (resubmittedFieldIds.length > 0) {
        await tx
          .update(caseFieldReviews)
          .set({
            status: 'pending',
            remarks: null,
            resubmittedAt: now,
          })
          .where(inArray(caseFieldReviews.id, resubmittedFieldIds))
      }

      const removedFieldIds = removeActions
        .map(([fieldName]) => reviewByField.get(fieldName)?.id)
        .filter((id): id is string => Boolean(id))

      if (removedFieldIds.length > 0) {
        await tx
          .update(caseFieldReviews)
          .set({
            status: 'approved',
            remarks: null,
            resubmittedAt: now,
          })
          .where(inArray(caseFieldReviews.id, removedFieldIds))
      }

      await tx
        .update(cases)
        .set({
          status: 'working',
          currentStageId: workingStage.id,
          updatedAt: now,
        })
        .where(eq(cases.id, caseRow.id))

      await tx.insert(caseHistory).values({
        caseId: caseRow.id,
        actorId: null,
        action: 'client_resubmitted',
        details: {
          tokenId: validated.tokenId,
          attemptId,
          submissionIndex,
          fieldsUpdated,
          fieldsUpdatedLabels: fieldsUpdatedDetails.map((item) => item.label),
          fieldsUpdatedDetails,
          rejectedFieldDetails: fieldsUpdatedDetails.map((item) => ({
            fieldName: item.fieldName,
            label: item.label,
            type: item.type,
            rejectionReason: item.rejectionReason,
          })),
          documentActions: Array.from(documentActions.entries()).map(
            ([fieldName, action]) => ({
              fieldName,
              action,
            }),
          ),
        },
      })
    })

    const attemptObjects = await listAttemptStorageObjects(attemptId)
    await markStorageObjectsLifecycle(
      attemptObjects.map((object) => object.providerObjectId),
      'current',
    )

    const supersededFileIds = [
      ...Array.from(uploadedByField.values()).map(
        (info) => info.previousFileId,
      ),
      ...removeActions.flatMap(([fieldName]) => {
        const docId = getDocumentIdFromFieldName(fieldName)
        if (!docId) return []
        const existing = existingDocsById.get(docId)
        return existing?.googleDriveFileId ? [existing.googleDriveFileId] : []
      }),
    ]
    await supersedeStorageObjects(supersededFileIds)

    if (caseRow.ownerId) {
      try {
        await notifyOnResubmission({
          caseId: caseRow.id,
          caseNumber: caseRow.caseNumber,
          ownerId: caseRow.ownerId,
          clientName: caseRow.merchantOwnerName,
          fieldCount: fieldsUpdated.length,
        })
      } catch {
        // Notifications must never break the primary flow
      }
    }

    return c.json({ success: true, caseNumber: caseRow.caseNumber })
  } catch (error) {
    await cleanupFailedAttemptObjects({ attemptId, storage }).catch(
      (cleanupError) => {
        console.error('[public-resubmission.cleanup]', cleanupError)
      },
    )
    throw error
  }
})

function buildDocumentFileName(
  documentType: MerchantDocumentType,
  originalName: string,
) {
  const extension = originalName.includes('.')
    ? `.${originalName.split('.').pop()?.toLowerCase()}`
    : ''

  return `${documentType}${extension}`
}
