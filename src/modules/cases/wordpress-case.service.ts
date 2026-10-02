import { and, eq, ilike, inArray } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseFiles,
  caseHistory,
  cases,
  merchants,
  queues,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import { supersedeStorageObjects } from '../../lib/storage/ownership'
import type { SaveWordpressWebsiteInput } from './cases.schemas'
import { assertCanWorkCase } from './case-access.service'

import {
  WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX,
  WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX,
  WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX,
} from './case-constants'
import { getLatestDocumentReviewDetailsForMerchant } from './case-detail-lookups'
import { validateWordpressScreenshotFile } from './case-upload-validation'
import { ensurePrivateInternalCaseFolder } from './case-drive-folders'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'

export async function loadWordpressWebsiteCase(caseId: string, userId: string) {
  const db = getDb()
  const [row] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      ownerId: cases.ownerId,
      status: cases.status,
      currentStageId: cases.currentStageId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      businessWebsite: merchants.businessWebsite,
      queueId: cases.queueId,
      queueName: queues.name,
      queueSlug: queues.slug,
      workflowType: queues.workflowType,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, caseId))
    .limit(1)

  if (!row) {
    throw new AppError(404, 'Case not found.')
  }

  if (row.workflowType !== 'wordpress') {
    throw new AppError(
      400,
      'This action is only available for WordPress Website cases.',
    )
  }

  if (row.ownerId !== userId) {
    throw new AppError(403, 'Only the case owner can update this case.')
  }
  await assertCanWorkCase(caseId, userId)

  if (row.status !== 'working') {
    throw new AppError(400, 'The case must be in the working stage.')
  }

  return row
}

export async function saveWordpressWebsiteCase(
  caseId: string,
  userId: string,
  input: SaveWordpressWebsiteInput & {
    screenshots: File[]
    subMerchantLogoScreenshots: Array<{
      subMerchantId: string
      file: File
    }>
    assanpayCheckoutScreenshots: File[]
  },
) {
  const db = getDb()
  const caseRow = await loadWordpressWebsiteCase(caseId, userId)

  if (input.screenshots.length === 0) {
    throw new AppError(400, 'A home page screenshot is required.')
  }

  if (input.subMerchantLogoScreenshots.length === 0) {
    throw new AppError(
      400,
      'At least one sub-merchant website logo screenshot is required.',
    )
  }

  if (input.assanpayCheckoutScreenshots.length === 0) {
    throw new AppError(400, 'An AssanPay checkout page screenshot is required.')
  }

  if (input.screenshots.length > 1) {
    throw new AppError(400, 'Upload only one home page screenshot.')
  }

  if (input.subMerchantLogoScreenshots.length > 30) {
    throw new AppError(
      400,
      'Upload no more than 30 sub-merchant logo screenshots.',
    )
  }

  if (input.assanpayCheckoutScreenshots.length > 1) {
    throw new AppError(
      400,
      'Upload only one AssanPay checkout page screenshot.',
    )
  }

  for (const screenshot of input.screenshots) {
    await validateWordpressScreenshotFile(screenshot)
  }
  const documentReview = await getLatestDocumentReviewDetailsForMerchant(
    caseRow.merchantId,
  )
  const selectedSubMerchants = documentReview?.subMerchants ?? []
  const selectedSubMerchantIds = new Set(
    selectedSubMerchants.map((item) => item.id),
  )
  const submittedSubMerchantIds = input.subMerchantLogoScreenshots.map(
    (item) => item.subMerchantId,
  )

  if (
    selectedSubMerchants.length === 0 ||
    submittedSubMerchantIds.length !== selectedSubMerchantIds.size ||
    new Set(submittedSubMerchantIds).size !== submittedSubMerchantIds.length ||
    submittedSubMerchantIds.some((id) => !selectedSubMerchantIds.has(id))
  ) {
    throw new AppError(
      400,
      'Upload exactly one website logo screenshot for each selected sub-merchant.',
    )
  }

  for (const screenshot of input.subMerchantLogoScreenshots) {
    await validateWordpressScreenshotFile(screenshot.file)
  }
  for (const screenshot of input.assanpayCheckoutScreenshots) {
    await validateWordpressScreenshotFile(screenshot)
  }

  const existingFiles = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(caseFiles.fileKind, `${WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX}%`),
      ),
    )

  const existingLogoFiles = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(
          caseFiles.fileKind,
          `${WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX}%`,
        ),
      ),
    )

  const existingCheckoutFiles = await db
    .select()
    .from(caseFiles)
    .where(
      and(
        eq(caseFiles.caseId, caseId),
        ilike(
          caseFiles.fileKind,
          `${WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX}%`,
        ),
      ),
    )

  const storage = new GoogleDriveStorageProvider()
  const folder = await ensurePrivateInternalCaseFolder({
    merchantId: caseRow.merchantId,
    merchantName: caseRow.merchantName,
    caseNumber: caseRow.caseNumber,
    queueName: caseRow.queueName,
    section: 'WordPress Screenshots',
    storage,
  })

  const uploadedScreenshots = await Promise.all(
    input.screenshots.map((file, index) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `wordpress-page-${String(index + 1).padStart(2, '0')}-${file.name}`,
          mimeType: file.type,
          file,
        })
        .then((uploaded) => ({ file, uploaded, index })),
    ),
  )
  const uploadedLogoScreenshots = await Promise.all(
    input.subMerchantLogoScreenshots.map(({ file, subMerchantId }) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `sub-merchant-logo-${subMerchantId}-${file.name}`,
          mimeType: file.type,
          file,
        })
        .then((uploaded) => ({ file, uploaded, subMerchantId })),
    ),
  )
  const uploadedCheckoutScreenshots = await Promise.all(
    input.assanpayCheckoutScreenshots.map((file, index) =>
      storage
        .uploadFile(folder.folderId, {
          fileName: `assanpay-checkout-${String(index + 1).padStart(2, '0')}-${file.name}`,
          mimeType: file.type,
          file,
        })
        .then((uploaded) => ({ file, uploaded, index })),
    ),
  )

  const now = new Date()
  const saved = await db.transaction(async (tx) => {
    const savedFiles: Array<typeof caseFiles.$inferSelect> = []
    const savedLogoFiles: Array<typeof caseFiles.$inferSelect> = []
    const savedCheckoutFiles: Array<typeof caseFiles.$inferSelect> = []

    for (const { file, uploaded, index } of uploadedScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX}${String(index + 1).padStart(2, '0')}`,
          originalName: file.name,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          googleDriveFileId: uploaded.fileId,
          googleDriveWebViewLink: uploaded.webViewLink,
          googleDriveDownloadLink: uploaded.downloadLink,
          googleDriveFolderId: uploaded.folderId,
          uploadedBy: userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [caseFiles.caseId, caseFiles.fileKind],
          set: {
            originalName: file.name,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            googleDriveFileId: uploaded.fileId,
            googleDriveWebViewLink: uploaded.webViewLink,
            googleDriveDownloadLink: uploaded.downloadLink,
            googleDriveFolderId: uploaded.folderId,
            uploadedBy: userId,
            updatedAt: now,
          },
        })
        .returning()

      if (!savedFile) {
        throw new AppError(500, 'Failed to save screenshot.')
      }

      savedFiles.push(savedFile)
    }

    for (const { file, uploaded, subMerchantId } of uploadedLogoScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX}${subMerchantId}`,
          originalName: file.name,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          googleDriveFileId: uploaded.fileId,
          googleDriveWebViewLink: uploaded.webViewLink,
          googleDriveDownloadLink: uploaded.downloadLink,
          googleDriveFolderId: uploaded.folderId,
          uploadedBy: userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [caseFiles.caseId, caseFiles.fileKind],
          set: {
            originalName: file.name,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            googleDriveFileId: uploaded.fileId,
            googleDriveWebViewLink: uploaded.webViewLink,
            googleDriveDownloadLink: uploaded.downloadLink,
            googleDriveFolderId: uploaded.folderId,
            uploadedBy: userId,
            updatedAt: now,
          },
        })
        .returning()

      if (!savedFile) {
        throw new AppError(500, 'Failed to save sub-merchant logo screenshot.')
      }

      savedLogoFiles.push(savedFile)
    }

    for (const { file, uploaded, index } of uploadedCheckoutScreenshots) {
      const [savedFile] = await tx
        .insert(caseFiles)
        .values({
          caseId,
          fileKind: `${WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX}${String(index + 1).padStart(2, '0')}`,
          originalName: file.name,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.sizeBytes,
          googleDriveFileId: uploaded.fileId,
          googleDriveWebViewLink: uploaded.webViewLink,
          googleDriveDownloadLink: uploaded.downloadLink,
          googleDriveFolderId: uploaded.folderId,
          uploadedBy: userId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [caseFiles.caseId, caseFiles.fileKind],
          set: {
            originalName: file.name,
            mimeType: uploaded.mimeType,
            sizeBytes: uploaded.sizeBytes,
            googleDriveFileId: uploaded.fileId,
            googleDriveWebViewLink: uploaded.webViewLink,
            googleDriveDownloadLink: uploaded.downloadLink,
            googleDriveFolderId: uploaded.folderId,
            uploadedBy: userId,
            updatedAt: now,
          },
        })
        .returning()

      if (!savedFile) {
        throw new AppError(500, 'Failed to save checkout page screenshot.')
      }

      savedCheckoutFiles.push(savedFile)
    }

    const keptKinds = new Set(savedFiles.map((file) => file.fileKind))
    const staleFiles = existingFiles.filter(
      (file) => !keptKinds.has(file.fileKind),
    )
    if (staleFiles.length > 0) {
      await tx.delete(caseFiles).where(
        inArray(
          caseFiles.id,
          staleFiles.map((file) => file.id),
        ),
      )
    }
    const keptLogoKinds = new Set(savedLogoFiles.map((file) => file.fileKind))
    const staleLogoFiles = existingLogoFiles.filter(
      (file) => !keptLogoKinds.has(file.fileKind),
    )
    if (staleLogoFiles.length > 0) {
      await tx.delete(caseFiles).where(
        inArray(
          caseFiles.id,
          staleLogoFiles.map((file) => file.id),
        ),
      )
    }
    const keptCheckoutKinds = new Set(
      savedCheckoutFiles.map((file) => file.fileKind),
    )
    const staleCheckoutFiles = existingCheckoutFiles.filter(
      (file) => !keptCheckoutKinds.has(file.fileKind),
    )
    if (staleCheckoutFiles.length > 0) {
      await tx.delete(caseFiles).where(
        inArray(
          caseFiles.id,
          staleCheckoutFiles.map((file) => file.id),
        ),
      )
    }

    await tx.insert(caseHistory).values({
      caseId,
      actorId: userId,
      action: 'wordpress_website_saved',
      details: {
        businessWebsite: caseRow.businessWebsite,
        clonedWebsiteLink: input.clonedWebsiteLink,
        screenshots: savedFiles.length,
        subMerchantLogoScreenshots: savedLogoFiles.length,
        assanpayCheckoutScreenshots: savedCheckoutFiles.length,
      },
      createdAt: now,
    })

    return {
      clonedWebsiteLink: input.clonedWebsiteLink,
      savedAt: now.toISOString(),
      screenshots: savedFiles,
      subMerchantLogoScreenshots: savedLogoFiles,
      assanpayCheckoutScreenshots: savedCheckoutFiles,
    }
  })

  const replacedFileIds = new Set(
    [
      ...uploadedScreenshots,
      ...uploadedLogoScreenshots,
      ...uploadedCheckoutScreenshots,
    ].map(({ uploaded }) => uploaded.fileId),
  )
  const supersededIds = [
    ...existingFiles,
    ...existingLogoFiles,
    ...existingCheckoutFiles,
  ]
    .map((oldFile) => oldFile.googleDriveFileId)
    .filter((fileId) => !replacedFileIds.has(fileId))
  await supersedeStorageObjects(supersededIds)

  return saved
}
