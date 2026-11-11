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
  ne,
  or,
  sql,
  aliasedTable,
  type SQLWrapper,
} from 'drizzle-orm'

import { getDb, type DbTransaction } from '../../db/client'
import {
  agreementCaseDetails,
  caseHistory,
  caseFiles,
  cases,
  emailLog,
  merchantDocuments,
  merchants,
  queues,
  queueStages,
  storageObjects,
  users,
} from '../../db/schema'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import type { FileStorageProvider } from '../../lib/storage/google-drive'
import { AppError } from '../../lib/errors'
import { hashToken } from '../../lib/security'
import {
  buildKeysetCondition,
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorExpression,
  parseCsvValues,
} from '../cases/case-cursor'
import { isCaseSlaBreached } from '../cases/case-sla'
import { triggerStartCasesForMerchant } from '../cases/case-flow.service'
import {
  buildEpCaseStatusFilter,
  getEpQueueIds,
  getLatestEpCases,
} from '../cases/ep-sub-merchant.service'
import {
  getLimitsAndMdrSettings,
  getPaymentMethodSettings,
  getPayoutMethodSettings,
} from '../configuration/configuration.service'
import {
  paymentMethodSettingsSchema,
  payoutMethodSettingsSchema,
} from '../configuration/configuration.schemas'
import { AGREEMENT_RECEIVED_FILE_KIND } from '../cases/agreement.config'
import type {
  BusinessScopeValue,
  ListMerchantsQuery,
  MerchantLimitsMdr,
  MerchantDocumentType,
  MerchantFormSubmission,
  MerchantStatusValue,
  PermanentlyDeleteMerchantInput,
  PriorityValue,
  TerminateMerchantInput,
  UpdatePriorityInput,
} from './merchants.schemas'
import {
  businessScopeValues,
  merchantLimitsMdrSchema,
  merchantStatusValues,
  priorityValues,
} from './merchants.schemas'
import {
  PRIVATE_KYC_PENDING_PATH,
  buildMerchantRootFolderName,
  getSubmissionFolderName,
} from './merchant-drive-folders'
import {
  cleanupFailedAttemptObjects,
  createStorageAttemptId,
  markAttemptObjectsCurrent,
  markStorageObjectsDeleted,
  recordStorageObject,
} from '../../lib/storage/ownership'
import { withQueryTags } from '../../db/query-tags'
import { clearPortalApiCredentials } from '../cases/portal-api-credentials.service'
import { consumeOpenResubmissionTokens } from '../cases/case-resubmission-tokens.service'
import { writeCaseState } from '../cases/case-state-machine'
import {
  initialMerchantState,
  writeMerchantState,
} from './merchant-state-machine'
import {
  claimSubmissionQuota,
  recordCreatedSubmission,
  type SubmissionClient,
} from './submission-attempts.service'

type UploadedDocumentRecord = {
  documentType: MerchantDocumentType
  originalName: string
  mimeType: string
  sizeBytes: number
  googleDriveFileId: string
  googleDriveWebViewLink: string
  googleDriveDownloadLink: string | null
  googleDriveFolderId: string
}

const priorityValueSet = new Set<string>(priorityValues)
const businessScopeValueSet = new Set<string>(businessScopeValues)
const merchantStatusValueSet = new Set<string>(merchantStatusValues)

function sanitizeMerchantRecord(merchant: typeof merchants.$inferSelect) {
  return {
    id: merchant.id,
    merchantNumber: merchant.merchantNumber,
    submitterEmail: merchant.submitterEmail,
    ownerFullName: merchant.ownerFullName,
    ownerPhone: merchant.ownerPhone,
    activeWhatsappNumber: merchant.activeWhatsappNumber,
    businessName: merchant.businessName,
    businessPhone: merchant.businessPhone,
    businessEmail: merchant.businessEmail,
    businessAddress: merchant.businessAddress,
    businessWebsite: merchant.businessWebsite,
    websiteCms: merchant.websiteCms,
    businessDescription: merchant.businessDescription,
    businessRegistrationDate: merchant.businessRegistrationDate,
    businessNature: merchant.businessNature,
    merchantType: merchant.merchantType,
    estimatedMonthlyTransactions: merchant.estimatedMonthlyTransactions,
    estimatedMonthlyVolume: merchant.estimatedMonthlyVolume,
    accountTitle: merchant.accountTitle,
    bankName: merchant.bankName,
    branchName: merchant.branchName,
    accountNumberIban: merchant.accountNumberIban,
    swiftCode: merchant.swiftCode,
    nextOfKinRelation: merchant.nextOfKinRelation,
    status: merchant.status,
    submittedAt: merchant.submittedAt,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
  }
}

function sanitizeDocumentRecord(
  document: typeof merchantDocuments.$inferSelect,
) {
  return {
    id: document.id,
    documentType: document.documentType,
    originalName: document.originalName,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    googleDriveFileId: document.googleDriveFileId,
    googleDriveWebViewLink: document.googleDriveWebViewLink,
    googleDriveDownloadLink: document.googleDriveDownloadLink,
    googleDriveFolderId: document.googleDriveFolderId,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  }
}

// ─── Duplicate submissions ──────────────────────────────────────────────────

export const DUPLICATE_SUBMISSION_MESSAGE =
  'An application for this business is already under review. Our team will contact you, so you do not need to submit it again.'

const SUBMISSION_KEY_UNIQUE_CONSTRAINT = 'merchants_submission_key_hash_unique'

// Both sides of each comparison go through the same SQL expression, so the
// stored column and the submitted value are normalized identically.
function normalizedBusinessName(value: SQLWrapper | string) {
  return sql`regexp_replace(lower(${value}), '[^[:alnum:]]', '', 'g')`
}

function normalizedEmail(value: SQLWrapper | string) {
  return sql`lower(trim(${value}))`
}

function normalizedIban(value: SQLWrapper | string) {
  return sql`upper(regexp_replace(${value}, '[[:space:]]', '', 'g'))`
}

function normalizedPhone(value: SQLWrapper | string) {
  return sql`right(regexp_replace(${value}, '[^0-9]', '', 'g'), 10)`
}

type DuplicateCheckInput = Pick<
  MerchantFormSubmission,
  'businessName' | 'email' | 'accountNumberIban' | 'ownerPhone'
>

// An open application (not deleted, not terminated) with the same business
// name and the same submitter email, IBAN or owner phone. One owner may run
// several differently named businesses, and a terminated merchant may apply
// again, so neither counts.
async function findOpenDuplicateMerchant(
  db: DbTransaction | ReturnType<typeof getDb>,
  input: DuplicateCheckInput,
) {
  const [duplicate] = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(
      and(
        isNull(merchants.deletedAt),
        ne(merchants.status, 'terminated'),
        sql`${normalizedBusinessName(merchants.businessName)} = ${normalizedBusinessName(input.businessName)}`,
        or(
          sql`${normalizedEmail(merchants.submitterEmail)} = ${normalizedEmail(input.email)}`,
          sql`${normalizedIban(merchants.accountNumberIban)} = ${normalizedIban(input.accountNumberIban)}`,
          sql`${normalizedPhone(merchants.ownerPhone)} = ${normalizedPhone(input.ownerPhone)}`,
        ),
      ),
    )
    .limit(1)

  return duplicate ?? null
}

async function findSubmissionByKeyHash(submissionKeyHash: string) {
  const db = getDb()
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.submissionKeyHash, submissionKeyHash))
    .limit(1)

  if (!merchant) return null

  const documents = await db
    .select()
    .from(merchantDocuments)
    .where(eq(merchantDocuments.merchantId, merchant.id))
    .orderBy(asc(merchantDocuments.createdAt))

  return {
    merchant: sanitizeMerchantRecord(merchant),
    documents: documents.map(sanitizeDocumentRecord),
  }
}

export async function isExistingSubmissionKey(submissionKey: string) {
  const [existing] = await getDb()
    .select({ id: merchants.id })
    .from(merchants)
    .where(eq(merchants.submissionKeyHash, await hashToken(submissionKey)))
    .limit(1)

  return Boolean(existing)
}

// Rolls back an attempt whose key another request already used.
class SubmissionKeyReplayError extends Error {}

function isSubmissionKeyConflict(error: unknown) {
  const databaseError =
    error instanceof Error ? (error.cause ?? error) : undefined
  return (
    !!databaseError &&
    typeof databaseError === 'object' &&
    'code' in databaseError &&
    databaseError.code === '23505' &&
    'constraint_name' in databaseError &&
    databaseError.constraint_name === SUBMISSION_KEY_UNIQUE_CONSTRAINT
  )
}

type CreateMerchantSubmissionOptions = {
  // Client-generated Idempotency-Key; stored only as a SHA-256 hash.
  submissionKey?: string | null
  // The public caller, counted against the per-IP limit and logged.
  client?: SubmissionClient
  storage?: FileStorageProvider
}

/**
 * `replayed` is true when the submission key matched an earlier request, so
 * nothing new was created.
 */
export async function createMerchantSubmission(
  input: MerchantFormSubmission,
  {
    submissionKey = null,
    client,
    storage = new GoogleDriveStorageProvider(),
  }: CreateMerchantSubmissionOptions = {},
) {
  const submissionKeyHash = submissionKey
    ? await hashToken(submissionKey)
    : null

  if (submissionKeyHash) {
    const existing = await findSubmissionByKeyHash(submissionKeyHash)
    if (existing) return { ...existing, replayed: true }
  }

  // Checked before any upload so a rejected form leaves nothing in Drive;
  // repeated under a lock in the transaction below for concurrent requests.
  if (await findOpenDuplicateMerchant(getDb(), input)) {
    throw new AppError(409, DUPLICATE_SUBMISSION_MESSAGE)
  }

  const merchantId = crypto.randomUUID()
  const attemptId = createStorageAttemptId()
  let folderId: string | null = null

  try {
    if (!storage.createMerchantRootFolder) {
      throw new AppError(
        500,
        'Storage provider does not support claimed merchant root creation.',
      )
    }

    const folder = await storage.createMerchantRootFolder(
      buildMerchantRootFolderName(merchantId, input.businessName),
      'private',
    )
    folderId = folder.folderId
    await recordStorageObject({
      providerObjectId: folder.folderId,
      objectKind: 'folder',
      visibility: 'private',
      attemptId,
      parentProviderObjectId: folder.parentFolderId,
      lifecycle: 'provisioning',
      metadata: { role: 'merchant_root', pendingMerchantId: merchantId },
    })

    let parentFolderId = folder.folderId
    const submissionPath = [
      ...PRIVATE_KYC_PENDING_PATH,
      getSubmissionFolderName(1),
    ]
    for (const folderName of submissionPath) {
      const created = await storage.createFolder(parentFolderId, folderName)
      await recordStorageObject({
        providerObjectId: created.folderId,
        objectKind: 'folder',
        visibility: 'private',
        attemptId,
        parentProviderObjectId: parentFolderId,
        lifecycle: 'provisioning',
        metadata: { folderName },
      })
      parentFolderId = created.folderId
    }
    const uploadFolderId = parentFolderId

    const uploadedDocuments = await Promise.all(
      input.documents.map(async (document) => {
        const upload = await storage.uploadFile(uploadFolderId, {
          fileName: buildDocumentFileName(
            document.documentType,
            document.file.name,
          ),
          mimeType: document.mimeType,
          file: document.file,
        })

        await recordStorageObject({
          providerObjectId: upload.fileId,
          objectKind: 'file',
          visibility: 'private',
          attemptId,
          parentProviderObjectId: upload.folderId,
          lifecycle: 'provisioning',
          metadata: {
            documentType: document.documentType,
            fileName: upload.fileName,
            sizeBytes: upload.sizeBytes,
          },
        })

        return {
          documentType: document.documentType,
          originalName: document.file.name,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          googleDriveFileId: upload.fileId,
          googleDriveWebViewLink: upload.webViewLink,
          googleDriveDownloadLink: upload.downloadLink,
          googleDriveFolderId: upload.folderId,
        } satisfies UploadedDocumentRecord
      }),
    )

    const result = await getDb().transaction(async (tx) => {
      // Every duplicate match requires the same normalized business name, so
      // locking on it serializes exactly the submissions that could collide.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('merchant-submission:' || ${normalizedBusinessName(input.businessName)}))`,
      )
      // A concurrent request with the same key committed while this one
      // waited for the lock; it must replay, not count as a duplicate.
      if (submissionKeyHash) {
        const [sameKey] = await tx
          .select({ id: merchants.id })
          .from(merchants)
          .where(eq(merchants.submissionKeyHash, submissionKeyHash))
          .limit(1)
        if (sameKey) throw new SubmissionKeyReplayError()
      }
      if (await findOpenDuplicateMerchant(tx, input)) {
        throw new AppError(409, DUPLICATE_SUBMISSION_MESSAGE)
      }
      if (client) await claimSubmissionQuota(tx, client)

      const [createdMerchant] = await tx
        .insert(merchants)
        .values({
          id: merchantId,
          submitterEmail: input.email,
          ownerFullName: input.ownerFullName,
          ownerPhone: input.ownerPhone,
          activeWhatsappNumber: input.activeWhatsappNumber,
          businessName: input.businessName,
          businessPhone: input.businessPhone,
          businessEmail: input.businessEmail,
          businessAddress: input.businessAddress,
          businessWebsite: input.businessWebsite,
          websiteCms: input.websiteCms,
          businessDescription: input.businessDescription,
          businessRegistrationDate: input.businessRegistrationDate,
          businessNature: input.businessNature,
          merchantType: input.merchantType,
          estimatedMonthlyTransactions: input.estimatedMonthlyTransactions,
          estimatedMonthlyVolume: input.estimatedMonthlyVolume,
          accountTitle: input.accountTitle,
          bankName: input.bankName,
          branchName: input.branchName,
          accountNumberIban: input.accountNumberIban,
          swiftCode: input.swiftCode,
          nextOfKinRelation: input.nextOfKinRelation,
          googleDrivePrivateFolderId: folderId,
          submissionKeyHash,
          ...initialMerchantState,
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .returning()

      const createdDocuments = uploadedDocuments.length
        ? await tx
            .insert(merchantDocuments)
            .values(
              uploadedDocuments.map((document) => ({
                merchantId,
                documentType: document.documentType,
                originalName: document.originalName,
                mimeType: document.mimeType,
                sizeBytes: document.sizeBytes,
                googleDriveFileId: document.googleDriveFileId,
                googleDriveWebViewLink: document.googleDriveWebViewLink,
                googleDriveDownloadLink: document.googleDriveDownloadLink,
                googleDriveFolderId: document.googleDriveFolderId,
                status: 'pending' as const,
                updatedAt: new Date(),
              })),
            )
            .returning()
        : []

      await triggerStartCasesForMerchant(tx, merchantId)
      // Committed with the merchant, so a later failure never cleans them up.
      await attachMerchantToAttemptObjects(tx, attemptId, merchantId)
      await markAttemptObjectsCurrent(tx, attemptId)
      if (client) await recordCreatedSubmission(tx, client, merchantId)

      return {
        merchant: createdMerchant,
        documents: createdDocuments,
      }
    })

    return {
      merchant: sanitizeMerchantRecord(result.merchant),
      documents: result.documents.map(sanitizeDocumentRecord),
      replayed: false,
    }
  } catch (error) {
    await cleanupFailedAttemptObjects({ attemptId, storage }).catch(
      (cleanupError) => {
        console.error('[merchant-submission.cleanup]', cleanupError)
      },
    )

    // A concurrent request with the same key won the insert; answer with
    // its merchant, as a later retry would get.
    if (
      submissionKeyHash &&
      (error instanceof SubmissionKeyReplayError ||
        isSubmissionKeyConflict(error))
    ) {
      const existing = await findSubmissionByKeyHash(submissionKeyHash)
      if (existing) return { ...existing, replayed: true }
    }

    throw error
  }
}

async function attachMerchantToAttemptObjects(
  tx: DbTransaction,
  attemptId: string,
  merchantId: string,
) {
  await tx
    .update(storageObjects)
    .set({
      merchantId,
      updatedAt: new Date(),
    })
    .where(eq(storageObjects.attemptId, attemptId))
}

function buildDocumentFileName(
  documentType: MerchantDocumentType,
  originalName: string,
) {
  const extension = originalName.includes('.')
    ? `.${originalName.split('.').pop()?.toLowerCase()}`
    : ''

  return `${documentType}${extension}`
}

// ─── List / Update / Delete ─────────────────────────────────────────────────

const sortColumnMap = {
  merchantNumber: {
    expression: merchants.merchantNumber,
    kind: 'number',
  },
  businessName: {
    expression: sql`lower(${merchants.businessName})`,
    kind: 'string',
  },
  status: {
    expression: merchants.status,
    kind: 'string',
  },
  priority: {
    expression: merchants.priority,
    kind: 'string',
  },
  createdAt: {
    expression: merchants.createdAt,
    kind: 'date',
  },
  businessScope: {
    expression: merchants.businessScope,
    kind: 'string',
  },
  ownerFullName: {
    expression: sql`lower(${merchants.ownerFullName})`,
    kind: 'string',
  },
  updatedAt: {
    expression: merchants.updatedAt,
    kind: 'date',
  },
} as const

export async function listMerchants(query: ListMerchantsQuery) {
  const db = getDb()
  const conditions = [isNull(merchants.deletedAt)]

  if (query.search) {
    const term = `%${query.search}%`
    const numericSearch = Number(query.search)
    const searchConditions = [
      ilike(merchants.businessName, term),
      ilike(merchants.submitterEmail, term),
      ilike(merchants.ownerFullName, term),
    ]
    if (!Number.isNaN(numericSearch) && Number.isInteger(numericSearch)) {
      searchConditions.push(eq(merchants.merchantNumber, numericSearch))
    }
    const searchFilter = or(...searchConditions)
    if (searchFilter) conditions.push(searchFilter)
  }

  if (query.priority) {
    const priorities = parseCsvValues<PriorityValue>(
      query.priority,
      priorityValueSet,
    )
    if (priorities.length > 0) {
      conditions.push(inArray(merchants.priority, priorities))
    }
  }

  if (query.status) {
    const statuses = parseCsvValues<MerchantStatusValue>(
      query.status,
      merchantStatusValueSet,
    )
    if (statuses.length > 0) {
      conditions.push(inArray(merchants.status, statuses))
    }
  }

  if (query.currency) {
    const currencies = query.currency.split(',').filter(Boolean)
    if (currencies.length > 0) {
      conditions.push(
        inArray(merchants.currency, currencies as [string, ...string[]]),
      )
    }
  }

  if (query.businessScope) {
    const scopes = parseCsvValues<BusinessScopeValue>(
      query.businessScope,
      businessScopeValueSet,
    )
    if (scopes.length > 0) {
      conditions.push(inArray(merchants.businessScope, scopes))
    }
  }

  if (query.createdAtFrom) {
    const fromDate = new Date(query.createdAtFrom)
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gt(merchants.createdAt, fromDate))
    }
  }

  if (query.createdAtTo) {
    const toDate = new Date(query.createdAtTo)
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lt(merchants.createdAt, toDate))
    }
  }

  const epQueueIds = await getEpQueueIds()

  if (query.epStatus) {
    const epStatusFilter = buildEpCaseStatusFilter(query.epStatus, epQueueIds)
    if (epStatusFilter) conditions.push(epStatusFilter)
  }

  const orderFn = query.sortOrder === 'desc' ? desc : asc
  const sortSpec = sortColumnMap[query.sortBy]
  const cursor = query.cursor
    ? decodeKeysetCursor(query.cursor, {
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        kind: sortSpec.kind,
      })
    : null

  // Count the filtered set only on the first page; later pages reuse it.
  const total = cursor
    ? null
    : await db
        .select({ value: count() })
        .from(merchants)
        .where(and(...conditions))
        .then((result) => result[0]?.value ?? 0)

  if (cursor) {
    conditions.push(
      buildKeysetCondition({
        expression: sortSpec.expression,
        idExpression: merchants.id,
        sortOrder: query.sortOrder,
        kind: cursor.kind,
        value: cursor.value,
        id: cursor.id,
      }),
    )
  }

  const where = and(...conditions)
  const rows = await db
    .select({
      id: merchants.id,
      merchantNumber: merchants.merchantNumber,
      businessName: merchants.businessName,
      status: merchants.status,
      priority: merchants.priority,
      priorityNote: merchants.priorityNote,
      createdAt: merchants.createdAt,
      currency: merchants.currency,
      businessScope: merchants.businessScope,
      liveAt: merchants.liveAt,
      ownerFullName: merchants.ownerFullName,
      updatedAt: merchants.updatedAt,
      driveFilesDeletedAt: merchants.driveFilesDeletedAt,
      // Served by the partial cases_open_merchant_idx index. Columns are
      // qualified by hand: single-table selects render them unqualified, so
      // "id" would resolve to cases.id inside the subquery.
      openCasesCount: sql<number>`(
        select count(*)::int from "cases" as "open_cases"
        where "open_cases"."merchant_id" = "merchants"."id"
          and "open_cases"."status" <> 'closed'
      )`,
      cursorValue: keysetCursorExpression(sortSpec),
    })
    .from(merchants)
    .where(where)
    .orderBy(orderFn(sortSpec.expression), orderFn(merchants.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeKeysetCursor({
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          value: pageRows[pageRows.length - 1]!.cursorValue,
          id: pageRows[pageRows.length - 1]!.id,
        })
      : null
  const latestEpCases = await getLatestEpCases(
    pageRows.map((row) => row.id),
    epQueueIds,
  )
  const items = pageRows.map((pageRow) => {
    const row = { ...pageRow, epCases: latestEpCases.get(pageRow.id) ?? [] }
    delete (row as { cursorValue?: unknown }).cursorValue
    return row
  })

  return {
    merchants: items,
    nextCursor,
    hasMore,
    limit: query.limit,
    total,
  }
}

export async function updateMerchantPriority(
  merchantId: string,
  input: UpdatePriorityInput,
) {
  const db = getDb()

  const [updated] = await db.transaction(async (tx) => {
    const [merchant] = await tx
      .select({ status: merchants.status })
      .from(merchants)
      .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))

    if (!merchant) {
      throw new AppError(404, 'Merchant not found.')
    }

    if (merchant.status === 'terminated') {
      throw new AppError(409, 'Terminated merchant priority cannot be changed.')
    }

    const now = new Date()
    const updatedRows = await tx
      .update(merchants)
      .set({
        priority: input.priority,
        priorityNote: input.note,
        updatedAt: now,
      })
      .where(
        and(
          eq(merchants.id, merchantId),
          ne(merchants.status, 'terminated'),
          isNull(merchants.deletedAt),
        ),
      )
      .returning({
        id: merchants.id,
        priority: merchants.priority,
        priorityNote: merchants.priorityNote,
      })

    if (updatedRows.length > 0) {
      await tx
        .update(cases)
        .set({ priority: input.priority, updatedAt: now })
        .where(eq(cases.merchantId, merchantId))
    }

    return updatedRows
  })

  if (!updated) {
    throw new AppError(404, 'Merchant not found.')
  }

  return updated
}

export async function softDeleteMerchant(merchantId: string) {
  const db = getDb()

  const [merchant] = await db
    .select({ status: merchants.status })
    .from(merchants)
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }

  if (merchant.status !== 'terminated') {
    throw new AppError(409, 'Only terminated merchants can be deleted.')
  }

  const [deleted] = await writeMerchantState(db, {
    event: 'soft_deleted',
    where: eq(merchants.id, merchantId),
    set: { deletedAt: new Date() },
  })

  if (!deleted) {
    throw new AppError(404, 'Merchant not found.')
  }

  return { id: deleted.id }
}

export async function permanentlyDeleteMerchant(
  merchantId: string,
  input: PermanentlyDeleteMerchantInput,
) {
  const db = getDb()
  return db.transaction(async (tx) => {
    const [merchant] = await tx
      .select({
        id: merchants.id,
        businessName: merchants.businessName,
        status: merchants.status,
        googleDrivePrivateFolderId: merchants.googleDrivePrivateFolderId,
        googleDrivePublicFolderId: merchants.googleDrivePublicFolderId,
      })
      .from(merchants)
      .where(eq(merchants.id, merchantId))
      .for('update')

    if (!merchant) {
      throw new AppError(404, 'Merchant not found.')
    }

    if (merchant.status !== 'terminated') {
      throw new AppError(
        409,
        'Only terminated merchants can be permanently deleted.',
      )
    }

    if (input.confirmation !== merchant.businessName) {
      throw new AppError(400, 'Merchant name confirmation does not match.')
    }

    const drivePlan = await getMerchantDriveDeletionPlan(tx, merchant)
    await deleteMerchantDriveObjects(
      new GoogleDriveStorageProvider(),
      drivePlan,
    )

    await tx.delete(emailLog).where(
      sql`${emailLog.merchantId} = ${merchantId}
        or ${emailLog.caseId} in (
          select ${cases.id} from ${cases}
          where ${cases.merchantId} = ${merchantId}
        )`,
    )

    const [deletedMerchant] = await tx
      .delete(merchants)
      .where(eq(merchants.id, merchantId))
      .returning({ id: merchants.id })

    if (!deletedMerchant) {
      throw new AppError(404, 'Merchant not found.')
    }

    return {
      id: deletedMerchant.id,
      deletedStorageObjectCount: drivePlan.objectCount,
    }
  })
}

// Drive allows only so many writes at once, and a merchant can own many files.
const DRIVE_DELETE_BATCH_SIZE = 10

type MerchantDriveDeletionPlan = {
  nonRootObjectIds: string[]
  rootFolderIds: string[]
  objectCount: number
}

/**
 * Everything to delete for a merchant, limited to objects in the ownership
 * ledger. Refuses when a root folder or linked file is missing from it, so
 * nothing this merchant cannot be shown to own is ever deleted.
 */
async function getMerchantDriveDeletionPlan(
  db: DbTransaction | ReturnType<typeof getDb>,
  merchant: {
    id: string
    googleDrivePrivateFolderId: string | null
    googleDrivePublicFolderId: string | null
  },
): Promise<MerchantDriveDeletionPlan> {
  const ownedStorageObjects = await db
    .select({
      provider: storageObjects.provider,
      providerObjectId: storageObjects.providerObjectId,
      objectKind: storageObjects.objectKind,
    })
    .from(storageObjects)
    .where(eq(storageObjects.merchantId, merchant.id))

  const ownedGoogleDriveObjects = ownedStorageObjects.filter(
    (object) => object.provider === 'google_drive',
  )
  const linkedMerchantFiles = await db
    .select({ providerObjectId: merchantDocuments.googleDriveFileId })
    .from(merchantDocuments)
    .where(eq(merchantDocuments.merchantId, merchant.id))
  const linkedCaseFiles = await db
    .select({ providerObjectId: caseFiles.googleDriveFileId })
    .from(caseFiles)
    .innerJoin(cases, eq(caseFiles.caseId, cases.id))
    .where(eq(cases.merchantId, merchant.id))
  const unsupportedProviders = new Set(
    ownedStorageObjects
      .filter((object) => object.provider !== 'google_drive')
      .map((object) => object.provider),
  )

  if (unsupportedProviders.size > 0) {
    throw new AppError(
      409,
      `Merchant storage includes unsupported providers: ${Array.from(unsupportedProviders).join(', ')}.`,
    )
  }

  const rootFolderIds = new Set(
    [
      merchant.googleDrivePrivateFolderId,
      merchant.googleDrivePublicFolderId,
    ].filter((folderId): folderId is string => Boolean(folderId)),
  )
  const ownedFolderIds = new Set(
    ownedGoogleDriveObjects
      .filter((object) => object.objectKind === 'folder')
      .map((object) => object.providerObjectId),
  )
  const unownedRootFolderIds = Array.from(rootFolderIds).filter(
    (folderId) => !ownedFolderIds.has(folderId),
  )
  const ownedProviderObjectIds = new Set(
    ownedGoogleDriveObjects.map((object) => object.providerObjectId),
  )
  const unownedLinkedFileIds = [...linkedMerchantFiles, ...linkedCaseFiles]
    .map((file) => file.providerObjectId)
    .filter((fileId) => !ownedProviderObjectIds.has(fileId))

  if (unownedRootFolderIds.length > 0 || unownedLinkedFileIds.length > 0) {
    throw new AppError(
      409,
      'Merchant Drive ownership is incomplete. Run pending migrations before deleting this merchant.',
    )
  }

  return {
    nonRootObjectIds: Array.from(
      new Set(
        ownedGoogleDriveObjects
          .map((object) => object.providerObjectId)
          .filter((objectId) => !rootFolderIds.has(objectId)),
      ),
    ),
    rootFolderIds: Array.from(rootFolderIds),
    objectCount: ownedGoogleDriveObjects.length,
  }
}

// Already-deleted objects count as success, so a partial failure can be retried.
async function deleteMerchantDriveObjects(
  storage: FileStorageProvider,
  plan: MerchantDriveDeletionPlan,
) {
  for (
    let i = 0;
    i < plan.nonRootObjectIds.length;
    i += DRIVE_DELETE_BATCH_SIZE
  ) {
    await Promise.all(
      plan.nonRootObjectIds
        .slice(i, i + DRIVE_DELETE_BATCH_SIZE)
        .map((objectId) => storage.deleteFile(objectId)),
    )
  }
  await Promise.all(
    plan.rootFolderIds.map((folderId) => storage.deleteFile(folderId)),
  )
}

/**
 * Moves a terminated merchant's Drive files and folders to the Drive trash. The
 * merchant, its cases and its document records stay, and the portal offers no
 * way to bring the files back.
 */
export async function deleteMerchantDriveFiles(
  merchantId: string,
  actorId: string,
  storage: FileStorageProvider = new GoogleDriveStorageProvider(),
) {
  const db = getDb()
  const [merchant] = await db
    .select({
      id: merchants.id,
      status: merchants.status,
      googleDrivePrivateFolderId: merchants.googleDrivePrivateFolderId,
      googleDrivePublicFolderId: merchants.googleDrivePublicFolderId,
      driveFilesDeletedAt: merchants.driveFilesDeletedAt,
    })
    .from(merchants)
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }

  if (merchant.status !== 'terminated') {
    throw new AppError(
      409,
      'Only a terminated merchant can have its Google Drive files deleted.',
    )
  }

  if (merchant.driveFilesDeletedAt) {
    throw new AppError(
      409,
      "This merchant's Google Drive files are already deleted.",
    )
  }

  const plan = await getMerchantDriveDeletionPlan(db, merchant)
  await deleteMerchantDriveObjects(storage, plan)

  const now = new Date()
  await writeMerchantState(db, {
    event: 'drive_files_deleted',
    where: eq(merchants.id, merchantId),
    set: {
      driveFilesDeletedAt: now,
      driveFilesDeletedBy: actorId,
      updatedAt: now,
    },
  })
  await markStorageObjectsDeleted([
    ...plan.nonRootObjectIds,
    ...plan.rootFolderIds,
  ])

  return {
    id: merchantId,
    deletedStorageObjectCount: plan.objectCount,
    driveFilesDeletedAt: now,
  }
}

// Termination has already committed by now, so a Drive failure is reported
// rather than thrown; the merchants list offers the deletion again.
async function deleteDriveFilesAfterTermination(
  merchantId: string,
  actorId: string,
) {
  try {
    const { deletedStorageObjectCount } = await deleteMerchantDriveFiles(
      merchantId,
      actorId,
    )
    return { status: 'deleted' as const, deletedStorageObjectCount }
  } catch (error) {
    console.error('[merchant-terminate.drive-files]', { merchantId, error })
    return {
      status: 'failed' as const,
      message:
        error instanceof AppError
          ? error.message
          : 'Google Drive files could not be deleted.',
    }
  }
}

async function closeOpenCasesAsUnsuccessful(
  tx: Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0],
  input: {
    merchantIds: string[]
    actorId: string
    reason: string
    now: Date
  },
) {
  const closedCases = await writeCaseState(tx, {
    event: 'merchant_terminated',
    where: inArray(cases.merchantId, input.merchantIds),
    set: {
      currentStageId: sql`(
        select ${queueStages.id}
        from ${queueStages}
        where ${queueStages.queueId} = ${cases.queueId}
          and ${queueStages.category} = 'closed'
        order by ${queueStages.order}
        limit 1
      )`,
      closeOutcome: 'unsuccessful',
      slaBreached: sql`${sql.param(input.now, cases.createdAt)} > ${cases.createdAt} + (
        select ${queues.slaHours} * interval '1 hour'
        from ${queues}
        where ${queues.id} = ${cases.queueId}
      )`,
      closeReason: input.reason,
      closedAt: input.now,
      updatedAt: input.now,
    },
  })

  if (closedCases.length === 0) {
    return 0
  }

  await consumeOpenResubmissionTokens(
    tx,
    closedCases.map((caseRow) => caseRow.id),
  )

  await tx.insert(caseHistory).values(
    closedCases.map((caseRow) => ({
      caseId: caseRow.id,
      actorId: input.actorId,
      action: 'closed_unsuccessful',
      details: { reason: input.reason, source: 'merchant_termination' },
    })),
  )

  return closedCases.length
}

export async function terminateMerchant(
  merchantId: string,
  actorId: string,
  input: TerminateMerchantInput,
) {
  const db = getDb()
  const now = new Date()

  const result = await db.transaction(async (tx) => {
    const [updated] = await writeMerchantState(tx, {
      event: 'terminated',
      where: eq(merchants.id, merchantId),
      set: { updatedAt: now },
    })

    if (!updated) {
      return null
    }

    // Terminated merchants no longer need their portal API credentials.
    await clearPortalApiCredentials(tx, [merchantId])
    const closedCaseCount = await closeOpenCasesAsUnsuccessful(tx, {
      merchantIds: [merchantId],
      actorId,
      reason: input.reason,
      now,
    })

    return { ...updated, closedCaseCount }
  })

  if (!result) {
    throw new AppError(409, 'Merchant is already terminated or does not exist.')
  }

  return {
    ...result,
    driveFiles: input.deleteDriveFiles
      ? await deleteDriveFilesAfterTermination(merchantId, actorId)
      : null,
  }
}

// Bulk endpoints are strict: an unknown or deleted id fails the whole request
// (404) instead of being silently skipped, matching bulk case assignment.
async function assertMerchantsExist(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  ids: string[],
) {
  const uniqueIds = [...new Set(ids)]
  const rows = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(and(inArray(merchants.id, uniqueIds), isNull(merchants.deletedAt)))
  if (rows.length !== uniqueIds.length) {
    throw new AppError(404, 'One or more merchants were not found.')
  }
}

export async function bulkTerminateMerchants(
  ids: string[],
  actorId: string,
  input: TerminateMerchantInput,
) {
  const db = getDb()
  const now = new Date()

  const result = await db.transaction(async (tx) => {
    await assertMerchantsExist(tx, ids)
    const updatedRows = await writeMerchantState(tx, {
      event: 'terminated',
      where: inArray(merchants.id, ids),
      set: { updatedAt: now },
    })

    const updatedIds = updatedRows.map((row) => row.id)
    // Terminated merchants no longer need their portal API credentials.
    await clearPortalApiCredentials(tx, updatedIds)
    const closedCaseCount =
      updatedIds.length > 0
        ? await closeOpenCasesAsUnsuccessful(tx, {
            merchantIds: updatedIds,
            actorId,
            reason: input.reason,
            now,
          })
        : 0

    return {
      updatedIds,
      terminatedCount: updatedRows.length,
      closedCaseCount,
    }
  })

  const { updatedIds, ...summary } = result

  // Too slow for one request across many merchants. Anything left behind by a
  // failure or restart stays offered on the merchants list.
  if (input.deleteDriveFiles && updatedIds.length > 0) {
    void withQueryTags({ job: 'merchant-drive-file-deletion' }, async () => {
      for (const merchantId of updatedIds) {
        await deleteDriveFilesAfterTermination(merchantId, actorId)
      }
    }).catch((error) => {
      console.error('[merchant-terminate.drive-files]', error)
    })
  }

  return {
    ...summary,
    driveFilesQueuedCount: input.deleteDriveFiles ? updatedIds.length : 0,
  }
}

export async function bulkSoftDeleteMerchants(ids: string[]) {
  const db = getDb()
  await assertMerchantsExist(db, ids)

  const result = await writeMerchantState(db, {
    event: 'soft_deleted',
    where: inArray(merchants.id, ids),
    set: { deletedAt: new Date() },
  })

  return { deletedCount: result.length }
}

export async function bulkUpdatePriority(
  ids: string[],
  priority: UpdatePriorityInput['priority'],
  note?: UpdatePriorityInput['note'],
) {
  const db = getDb()

  const result = await db.transaction(async (tx) => {
    await assertMerchantsExist(tx, ids)
    const now = new Date()
    const updatedRows = await tx
      .update(merchants)
      .set({
        priority,
        priorityNote: note,
        updatedAt: now,
      })
      .where(
        and(
          inArray(merchants.id, ids),
          ne(merchants.status, 'terminated'),
          isNull(merchants.deletedAt),
        ),
      )
      .returning({ id: merchants.id })

    const updatedIds = updatedRows.map((row) => row.id)
    if (updatedIds.length > 0) {
      await tx
        .update(cases)
        .set({ priority, updatedAt: now })
        .where(inArray(cases.merchantId, updatedIds))
    }

    return updatedRows
  })

  return { updatedCount: result.length }
}

// ─── Merchant Detail ────────────────────────────────────────────────────────

function resolveLimitsMdrOverride(raw: unknown): MerchantLimitsMdr | null {
  if (!raw) return null
  const parsed = merchantLimitsMdrSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

async function getLatestMidCreationMethods(merchantId: string) {
  const [entry] = await getDb()
    .select({ details: caseHistory.details })
    .from(caseHistory)
    .innerJoin(cases, eq(caseHistory.caseId, cases.id))
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(caseHistory.action, 'mid_creation_saved'),
      ),
    )
    .orderBy(desc(caseHistory.createdAt))
    .limit(1)

  const details = entry?.details as {
    paymentMethods?: unknown
    payoutMethods?: unknown
  } | null
  const paymentMethods = paymentMethodSettingsSchema.safeParse(
    details?.paymentMethods,
  )
  const payoutMethods = payoutMethodSettingsSchema.safeParse(
    details?.payoutMethods,
  )

  return {
    paymentMethods: paymentMethods.success
      ? paymentMethods.data
      : parseLegacyMethodSettings(details?.paymentMethods, 'collection'),
    payoutMethods: payoutMethods.success
      ? payoutMethods.data
      : parseLegacyMethodSettings(
          details?.payoutMethods ?? details?.paymentMethods,
          'disbursement',
        ),
  }
}

function parseLegacyMethodSettings(
  value: unknown,
  mode: 'collection' | 'disbursement',
) {
  const legacyMethods = Array.isArray(value) ? value : []
  const migrated = legacyMethods.flatMap((method) => {
    if (!method || typeof method !== 'object') return []
    const record = method as Record<string, unknown>
    const label = typeof record.label === 'string' ? record.label.trim() : ''
    const id =
      typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : typeof record.key === 'string' && record.key.trim()
          ? record.key.trim()
          : label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const enabled =
      mode === 'collection'
        ? record.collectionEnabled !== false
        : record.disbursementEnabled !== false

    if (!label || !id || !enabled) return []
    return mode === 'collection'
      ? [
          {
            id,
            label,
            testing: readLegacyMethodRange(record.testing, {
              min: 10,
              max: 100,
            }),
            live: readLegacyMethodRange(record.live, {
              min: 100,
              max: 50000,
            }),
            commissionRate:
              typeof record.commissionRate === 'number'
                ? record.commissionRate
                : /card/i.test(label)
                  ? 3
                  : 2.5,
          },
        ]
      : [
          {
            id,
            label,
            testing: readLegacyMethodRange(record.testing, {
              min: 1000,
              max: 50000,
            }),
            live: readLegacyMethodRange(record.live, {
              min: 1000,
              max: 50000,
            }),
            commissionRate:
              typeof record.commissionRate === 'number'
                ? record.commissionRate
                : 0,
          },
        ]
  })
  const parser =
    mode === 'collection'
      ? paymentMethodSettingsSchema
      : payoutMethodSettingsSchema
  const parsed = parser.safeParse(migrated)
  return parsed.success ? parsed.data : null
}

function readLegacyMethodRange(
  value: unknown,
  fallback: { min: number; max: number },
) {
  if (!value || typeof value !== 'object') return fallback
  const range = value as Record<string, unknown>
  return typeof range.min === 'number' && typeof range.max === 'number'
    ? { min: range.min, max: range.max }
    : fallback
}

async function requireMerchant(merchantId: string) {
  const merchant = await getDb().query.merchants.findFirst({
    where: and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)),
  })

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }

  return merchant
}

function isMerchantCaseOpen(status: string, stageCategory: string | null) {
  return status !== 'closed' && stageCategory !== 'closed'
}

function withCaseSla<
  T extends {
    status: string
    stageCategory: string | null
    slaBreached: boolean | null
    createdAt: Date
    queueSlaHours: number | null
  },
>(rows: T[]) {
  const now = new Date()
  return rows.map((caseRow) => {
    const isOpen = isMerchantCaseOpen(caseRow.status, caseRow.stageCategory)
    const slaBreached = isOpen
      ? isCaseSlaBreached({
          createdAt: caseRow.createdAt,
          evaluatedAt: now,
          slaHours: caseRow.queueSlaHours,
        })
      : (caseRow.slaBreached ?? false)
    return { ...caseRow, slaBreached }
  })
}

function merchantMilestones(
  merchant: {
    submittedAt: Date
    liveAt: Date | null
  },
  testStartedAt: Date | null,
) {
  return {
    formFilledAt: merchant.submittedAt,
    testStartedAt,
    liveAt: merchant.liveAt,
  }
}

async function getTestStartedAt(merchantId: string) {
  const [row] = await getDb()
    .select({ createdAt: caseHistory.createdAt })
    .from(caseHistory)
    .innerJoin(cases, eq(caseHistory.caseId, cases.id))
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(caseHistory.action, 'testing_limits_applied'),
      ),
    )
    .orderBy(asc(caseHistory.createdAt))
    .limit(1)

  return row?.createdAt ?? null
}

async function listMerchantCases(merchantId: string) {
  return getDb()
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      queueName: queues.name,
      queueSlaHours: queues.slaHours,
      stageName: queueStages.name,
      stageCategory: queueStages.category,
      status: cases.status,
      priority: cases.priority,
      closeOutcome: cases.closeOutcome,
      closeReason: cases.closeReason,
      slaBreached: cases.slaBreached,
      ownerId: cases.ownerId,
      ownerName: users.name,
      closedAt: cases.closedAt,
      createdAt: cases.createdAt,
      updatedAt: cases.updatedAt,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .leftJoin(queueStages, eq(cases.currentStageId, queueStages.id))
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(eq(cases.merchantId, merchantId))
    .orderBy(desc(cases.createdAt))
}

async function listMerchantTimeline(merchantId: string) {
  const owner = aliasedTable(users, 'history_actor')

  return getDb()
    .select({
      id: caseHistory.id,
      caseId: caseHistory.caseId,
      caseNumber: cases.caseNumber,
      queueName: queues.name,
      action: caseHistory.action,
      details: caseHistory.details,
      actorId: caseHistory.actorId,
      actorName: owner.name,
      createdAt: caseHistory.createdAt,
    })
    .from(caseHistory)
    .innerJoin(cases, eq(caseHistory.caseId, cases.id))
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .leftJoin(owner, eq(caseHistory.actorId, owner.id))
    .where(eq(cases.merchantId, merchantId))
    .orderBy(asc(caseHistory.createdAt), asc(caseHistory.id))
}

async function getMerchantDocuments(merchantId: string) {
  return getDb()
    .select({
      id: merchantDocuments.id,
      documentType: merchantDocuments.documentType,
      originalName: merchantDocuments.originalName,
      mimeType: merchantDocuments.mimeType,
      sizeBytes: merchantDocuments.sizeBytes,
      status: merchantDocuments.status,
      googleDriveWebViewLink: merchantDocuments.googleDriveWebViewLink,
      googleDriveDownloadLink: merchantDocuments.googleDriveDownloadLink,
      createdAt: merchantDocuments.createdAt,
    })
    .from(merchantDocuments)
    .where(eq(merchantDocuments.merchantId, merchantId))
    .orderBy(asc(merchantDocuments.createdAt))
}

async function getReceivedAgreement(merchantId: string) {
  const [row] = await getDb()
    .select({
      id: caseFiles.id,
      caseId: caseFiles.caseId,
      caseNumber: cases.caseNumber,
      originalName: caseFiles.originalName,
      mimeType: caseFiles.mimeType,
      sizeBytes: caseFiles.sizeBytes,
      googleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      googleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      createdAt: caseFiles.createdAt,
    })
    .from(agreementCaseDetails)
    .innerJoin(cases, eq(agreementCaseDetails.caseId, cases.id))
    .innerJoin(
      caseFiles,
      eq(agreementCaseDetails.receivedAgreementFileId, caseFiles.id),
    )
    .where(
      and(
        eq(cases.merchantId, merchantId),
        eq(caseFiles.fileKind, AGREEMENT_RECEIVED_FILE_KIND),
      ),
    )
    .orderBy(desc(caseFiles.createdAt))
    .limit(1)

  return row ?? null
}

async function getMerchantLimitsBundle(merchant: {
  id: string
  limitsMdrOverride: unknown
}) {
  const [
    globalLimitsAndMdr,
    globalPaymentMethods,
    globalPayoutMethods,
    savedMethods,
  ] = await Promise.all([
    getLimitsAndMdrSettings(),
    getPaymentMethodSettings(),
    getPayoutMethodSettings(),
    getLatestMidCreationMethods(merchant.id),
  ])
  const override = resolveLimitsMdrOverride(merchant.limitsMdrOverride)

  return {
    limitsAndMdr: {
      effective: override ?? globalLimitsAndMdr,
      override,
      global: globalLimitsAndMdr,
      isOverridden: override !== null,
    },
    paymentMethods: savedMethods.paymentMethods ?? globalPaymentMethods,
    payoutMethods: savedMethods.payoutMethods ?? globalPayoutMethods,
  }
}

function toFormMerchant(merchant: Awaited<ReturnType<typeof requireMerchant>>) {
  return {
    id: merchant.id,
    merchantNumber: merchant.merchantNumber,
    submitterEmail: merchant.submitterEmail,
    ownerFullName: merchant.ownerFullName,
    ownerPhone: merchant.ownerPhone,
    activeWhatsappNumber: merchant.activeWhatsappNumber,
    businessName: merchant.businessName,
    businessPhone: merchant.businessPhone,
    businessEmail: merchant.businessEmail,
    businessAddress: merchant.businessAddress,
    businessWebsite: merchant.businessWebsite,
    websiteCms: merchant.websiteCms,
    businessDescription: merchant.businessDescription,
    businessRegistrationDate: merchant.businessRegistrationDate,
    businessNature: merchant.businessNature,
    merchantType: merchant.merchantType,
    estimatedMonthlyTransactions: merchant.estimatedMonthlyTransactions,
    estimatedMonthlyVolume: merchant.estimatedMonthlyVolume,
    accountTitle: merchant.accountTitle,
    bankName: merchant.bankName,
    branchName: merchant.branchName,
    accountNumberIban: merchant.accountNumberIban,
    swiftCode: merchant.swiftCode,
    nextOfKinRelation: merchant.nextOfKinRelation,
    status: merchant.status,
    priority: merchant.priority,
    priorityNote: merchant.priorityNote,
    businessScope: merchant.businessScope,
    currency: merchant.currency,
    liveAt: merchant.liveAt,
    driveFilesDeletedAt: merchant.driveFilesDeletedAt,
    submittedAt: merchant.submittedAt,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
  }
}

function isDocumentsReviewApproved(
  rows: Array<{
    queueName: string
    status: string
    closeOutcome: string | null
  }>,
) {
  return rows.some((row) => {
    const queueName = row.queueName.trim().toLowerCase().replace(/[-_]+/g, ' ')
    const status = row.status.trim().toLowerCase().replace(/[-_]+/g, ' ')
    const outcome = (row.closeOutcome ?? '')
      .trim()
      .toLowerCase()
      .replace(/[-_]+/g, ' ')
    return (
      queueName === 'documents review' &&
      status === 'closed' &&
      outcome === 'successful'
    )
  })
}

export async function getMerchantHeader(merchantId: string) {
  const merchant = await requireMerchant(merchantId)
  return {
    id: merchant.id,
    merchantNumber: merchant.merchantNumber,
    businessName: merchant.businessName,
    status: merchant.status,
    priority: merchant.priority,
    ownerFullName: merchant.ownerFullName,
    submittedAt: merchant.submittedAt,
  }
}

export async function getMerchantOverview(merchantId: string) {
  const merchant = await requireMerchant(merchantId)
  const [merchantCases, testStartedAt, limitsBundle] = await Promise.all([
    listMerchantCases(merchantId),
    getTestStartedAt(merchantId),
    getMerchantLimitsBundle(merchant),
  ])
  const casesWithSla = withCaseSla(merchantCases)
  const openCases = casesWithSla.filter((caseRow) =>
    isMerchantCaseOpen(caseRow.status, caseRow.stageCategory),
  )

  return {
    merchant: {
      id: merchant.id,
      businessName: merchant.businessName,
      ownerFullName: merchant.ownerFullName,
      status: merchant.status,
      priority: merchant.priority,
      businessScope: merchant.businessScope,
      currency: merchant.currency,
      updatedAt: merchant.updatedAt,
    },
    milestones: merchantMilestones(merchant, testStartedAt),
    caseCounts: {
      total: casesWithSla.length,
      open: openCases.length,
      working: casesWithSla.filter((caseRow) => caseRow.status === 'working')
        .length,
      closed: casesWithSla.length - openCases.length,
      slaBreached: openCases.filter((caseRow) => caseRow.slaBreached).length,
    },
    limitsAndMdr: {
      effective: limitsBundle.limitsAndMdr.effective,
      isOverridden: limitsBundle.limitsAndMdr.isOverridden,
    },
    paymentMethods: limitsBundle.paymentMethods,
    payoutMethods: limitsBundle.payoutMethods,
  }
}

export async function getMerchantForm(merchantId: string) {
  const merchant = await requireMerchant(merchantId)
  const [documents, receivedAgreement, caseOutcomes] = await Promise.all([
    getMerchantDocuments(merchantId),
    getReceivedAgreement(merchantId),
    getDb()
      .select({
        queueName: queues.name,
        status: cases.status,
        closeOutcome: cases.closeOutcome,
      })
      .from(cases)
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .where(eq(cases.merchantId, merchantId)),
  ])

  return {
    merchant: toFormMerchant(merchant),
    documents,
    agreements: {
      receivedSignedAgreement: receivedAgreement,
    },
    documentReviewApproved: isDocumentsReviewApproved(caseOutcomes),
  }
}

export async function getMerchantLimits(merchantId: string) {
  const merchant = await requireMerchant(merchantId)
  const limitsBundle = await getMerchantLimitsBundle(merchant)

  return {
    merchant: {
      id: merchant.id,
      status: merchant.status,
      currency: merchant.currency,
    },
    limitsAndMdr: limitsBundle.limitsAndMdr,
    paymentMethods: limitsBundle.paymentMethods,
    payoutMethods: limitsBundle.payoutMethods,
  }
}

export async function getMerchantHistory(merchantId: string) {
  const merchant = await requireMerchant(merchantId)
  const [merchantCases, timeline, testStartedAt] = await Promise.all([
    listMerchantCases(merchantId),
    listMerchantTimeline(merchantId),
    getTestStartedAt(merchantId),
  ])

  return {
    merchant: {
      submitterEmail: merchant.submitterEmail,
    },
    milestones: merchantMilestones(merchant, testStartedAt),
    cases: withCaseSla(merchantCases),
    timeline,
  }
}

export async function updateMerchantLimitsMdr(
  merchantId: string,
  input: MerchantLimitsMdr,
) {
  const db = getDb()
  const value = merchantLimitsMdrSchema.parse(input)

  const [updated] = await db
    .update(merchants)
    .set({ limitsMdrOverride: value, updatedAt: new Date() })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id })

  if (!updated) {
    throw new AppError(404, 'Merchant not found.')
  }

  return { id: updated.id, limitsAndMdr: value }
}

export async function resetMerchantLimitsMdr(merchantId: string) {
  const db = getDb()

  const [updated] = await db
    .update(merchants)
    .set({ limitsMdrOverride: null, updatedAt: new Date() })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id })

  if (!updated) {
    throw new AppError(404, 'Merchant not found.')
  }

  const globalLimitsAndMdr = await getLimitsAndMdrSettings()
  return {
    id: updated.id,
    limitsAndMdr: globalLimitsAndMdr,
  }
}
