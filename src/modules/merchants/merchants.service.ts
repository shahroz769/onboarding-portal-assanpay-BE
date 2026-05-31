import {
  and,
  asc,
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
} from 'drizzle-orm'
import { aliasedTable } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseHistory,
  cases,
  merchantDocuments,
  merchants,
  queueStages,
  users,
} from '../../db/schema'
import { GoogleDriveStorageProvider } from '../../lib/storage/google-drive'
import type { FileStorageProvider } from '../../lib/storage/google-drive'
import { AppError } from '../../lib/errors'
import { queues } from '../../db/schema'
import { isCaseSlaBreached } from '../cases/case-sla'
import { triggerStartCasesForMerchant } from '../cases/case-flow.service'
import {
  getLimitsAndMdrSettings,
  defaultLimitsAndMdrSettings,
} from '../configuration/configuration.service'
import { merchantLimitsMdrSchema } from './merchants.schemas'
import type { MerchantLimitsMdr } from './merchants.schemas'
import type {
  BusinessScopeValue,
  ListMerchantsQuery,
  MerchantDocumentType,
  MerchantFormSubmission,
  PriorityValue,
  TerminateMerchantInput,
  UpdatePriorityInput,
} from './merchants.schemas'
import {
  businessScopeValues,
  priorityValues,
} from './merchants.schemas'

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

function parseCsvValues<TValue extends string>(
  rawValue: string,
  allowedValues: ReadonlySet<string>,
) {
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(
      (value): value is TValue => value.length > 0 && allowedValues.has(value),
    )
}

type KeysetCursorKind = 'date' | 'number' | 'string'

type DecodedKeysetCursor = {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  value: Date | number | string
  id: string
}

function encodeKeysetCursor(input: {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  value: unknown
  id: string
}) {
  return btoa(
    encodeURIComponent(
      JSON.stringify({
        ...input,
        value:
          input.value instanceof Date ? input.value.toISOString() : input.value,
      }),
    ),
  )
}

function decodeKeysetCursor(
  rawCursor: string,
  expected: {
    sortBy: string
    sortOrder: 'asc' | 'desc'
    kind: KeysetCursorKind
  },
): DecodedKeysetCursor {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(rawCursor))) as {
      sortBy?: unknown
      sortOrder?: unknown
      value?: unknown
      id?: unknown
    }

    if (
      parsed.sortBy !== expected.sortBy ||
      parsed.sortOrder !== expected.sortOrder ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('Cursor does not match the active sort.')
    }

    let value: Date | number | string
    if (expected.kind === 'date') {
      if (typeof parsed.value !== 'string') {
        throw new Error('Cursor date is invalid.')
      }
      value = new Date(parsed.value)
      if (Number.isNaN(value.getTime())) {
        throw new Error('Cursor date is invalid.')
      }
    } else if (expected.kind === 'number') {
      value = Number(parsed.value)
      if (!Number.isFinite(value)) {
        throw new Error('Cursor number is invalid.')
      }
    } else {
      if (typeof parsed.value !== 'string') {
        throw new Error('Cursor value is invalid.')
      }
      value = parsed.value
    }

    return {
      sortBy: expected.sortBy,
      sortOrder: expected.sortOrder,
      value,
      id: parsed.id,
    }
  } catch {
    throw new AppError(400, 'Invalid pagination cursor.')
  }
}

function buildKeysetCondition(input: {
  expression: unknown
  idExpression: unknown
  sortOrder: 'asc' | 'desc'
  value: Date | number | string
  id: string
}) {
  const operator = input.sortOrder === 'desc' ? '<' : '>'
  return or(
    sql`${input.expression} ${sql.raw(operator)} ${input.value}`,
    and(
      sql`${input.expression} = ${input.value}`,
      sql`${input.idExpression} ${sql.raw(operator)} ${input.id}`,
    ),
  )!
}

function sanitizeMerchantRecord(merchant: typeof merchants.$inferSelect) {
  return {
    id: merchant.id,
    submitterEmail: merchant.submitterEmail,
    ownerFullName: merchant.ownerFullName,
    ownerPhone: merchant.ownerPhone,
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

export async function createMerchantSubmission(
  input: MerchantFormSubmission,
  storage: FileStorageProvider = new GoogleDriveStorageProvider(),
) {
  const merchantId = crypto.randomUUID()
  let folderId: string | null = null
  let submissionFolderId: string | null = null

  try {
    const folder = await storage.createMerchantFolder(
      buildFolderName(merchantId, input.businessName),
    )
    folderId = folder.folderId
    const submissionFolder = await storage.createFolder(
      folderId,
      getSubmissionFolderName(1),
    )
    submissionFolderId = submissionFolder.folderId
    const uploadFolderId = submissionFolderId

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
      const [createdMerchant] = await tx
        .insert(merchants)
        .values({
          id: merchantId,
          submitterEmail: input.email,
          ownerFullName: input.ownerFullName,
          ownerPhone: input.ownerPhone,
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
          status: 'pending',
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

      return {
        merchant: createdMerchant,
        documents: createdDocuments,
      }
    })

    return {
      merchant: sanitizeMerchantRecord(result.merchant),
      documents: result.documents.map(sanitizeDocumentRecord),
    }
  } catch (error) {
    if (submissionFolderId) {
      await storage.deleteFile(submissionFolderId).catch((cleanupError) => {
        console.error('[merchant-submission.cleanup]', cleanupError)
      })
    }

    if (folderId) {
      await storage.deleteFile(folderId).catch((cleanupError) => {
        console.error('[merchant-submission.cleanup]', cleanupError)
      })
    }

    throw error
  }
}

function buildFolderName(merchantId: string, businessName: string) {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return `${slug || 'merchant'}-${merchantId}`
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

function getSubmissionFolderName(index: number) {
  switch (index) {
    case 1:
      return 'First Submission'
    case 2:
      return 'Second Submission'
    case 3:
      return 'Third Submission'
    default:
      return `Submission ${index}`
  }
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
    ]
    if (!Number.isNaN(numericSearch) && Number.isInteger(numericSearch)) {
      searchConditions.push(eq(merchants.merchantNumber, numericSearch))
    }
    conditions.push(or(...searchConditions))
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

  const orderFn = query.sortOrder === 'desc' ? desc : asc
  const sortSpec = sortColumnMap[query.sortBy]
  const cursor = query.cursor
    ? decodeKeysetCursor(query.cursor, {
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        kind: sortSpec.kind,
      })
    : null

  if (cursor) {
    conditions.push(
      buildKeysetCondition({
        expression: sortSpec.expression,
        idExpression: merchants.id,
        sortOrder: query.sortOrder,
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
      cursorValue: sortSpec.expression,
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
  const items = pageRows.map((pageRow) => {
    const row = { ...pageRow }
    delete (row as { cursorValue?: unknown }).cursorValue
    return row
  })

  return {
    merchants: items,
    nextCursor,
    hasMore,
    limit: query.limit,
  }
}

export async function updateMerchantPriority(
  merchantId: string,
  input: UpdatePriorityInput,
) {
  const db = getDb()

  const [updated] = await db.transaction(async (tx) => {
    const now = new Date()
    const updatedRows = await tx
      .update(merchants)
      .set({
        priority: input.priority,
        priorityNote: input.note,
        updatedAt: now,
      })
      .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
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

  const [deleted] = await db
    .update(merchants)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id })

  if (!deleted) {
    throw new AppError(404, 'Merchant not found.')
  }

  return deleted
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
  const openCases = await tx
    .select({
      id: cases.id,
      queueId: cases.queueId,
      createdAt: cases.createdAt,
      queueSlaHours: queues.slaHours,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(
      and(
        inArray(cases.merchantId, input.merchantIds),
        ne(cases.status, 'closed'),
      ),
    )

  if (openCases.length === 0) {
    return 0
  }

  const queueIds = [...new Set(openCases.map((caseRow) => caseRow.queueId))]
  const closedStages = await tx
    .select({ id: queueStages.id, queueId: queueStages.queueId })
    .from(queueStages)
    .where(
      and(
        inArray(queueStages.queueId, queueIds),
        eq(queueStages.category, 'closed'),
      ),
    )
  const closedStageByQueueId = new Map(
    closedStages.map((stage) => [stage.queueId, stage.id]),
  )

  for (const caseRow of openCases) {
    await tx
      .update(cases)
      .set({
        currentStageId: closedStageByQueueId.get(caseRow.queueId) ?? null,
        status: 'closed',
        closeOutcome: 'unsuccessful',
        slaBreached: isCaseSlaBreached({
          createdAt: caseRow.createdAt,
          evaluatedAt: input.now,
          slaHours: caseRow.queueSlaHours,
        }),
        closeReason: input.reason,
        closedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(cases.id, caseRow.id))
  }

  await tx.insert(caseHistory).values(
    openCases.map((caseRow) => ({
      caseId: caseRow.id,
      actorId: input.actorId,
      action: 'closed_unsuccessful',
      details: { reason: input.reason, source: 'merchant_termination' },
    })),
  )

  return openCases.length
}

export async function terminateMerchant(
  merchantId: string,
  actorId: string,
  input: TerminateMerchantInput,
) {
  const db = getDb()
  const now = new Date()

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(merchants)
      .set({ status: 'terminated', updatedAt: now })
      .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
      .returning({ id: merchants.id, status: merchants.status })

    if (!updated) {
      return null
    }

    const closedCaseCount = await closeOpenCasesAsUnsuccessful(tx, {
      merchantIds: [merchantId],
      actorId,
      reason: input.reason,
      now,
    })

    return { ...updated, closedCaseCount }
  })

  if (!result) {
    throw new AppError(404, 'Merchant not found.')
  }

  return result
}

export async function bulkTerminateMerchants(
  ids: string[],
  actorId: string,
  input: TerminateMerchantInput,
) {
  const db = getDb()
  const now = new Date()

  const result = await db.transaction(async (tx) => {
    const updatedRows = await tx
      .update(merchants)
      .set({ status: 'terminated', updatedAt: now })
      .where(and(inArray(merchants.id, ids), isNull(merchants.deletedAt)))
      .returning({ id: merchants.id })

    const updatedIds = updatedRows.map((row) => row.id)
    const closedCaseCount =
      updatedIds.length > 0
        ? await closeOpenCasesAsUnsuccessful(tx, {
            merchantIds: updatedIds,
            actorId,
            reason: input.reason,
            now,
          })
        : 0

    return { terminatedCount: updatedRows.length, closedCaseCount }
  })

  return result
}

export async function bulkSoftDeleteMerchants(ids: string[]) {
  const db = getDb()

  const result = await db
    .update(merchants)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(merchants.id, ids), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id })

  return { deletedCount: result.length }
}

export async function bulkUpdatePriority(
  ids: string[],
  priority: UpdatePriorityInput['priority'],
  note?: UpdatePriorityInput['note'],
) {
  const db = getDb()

  const result = await db.transaction(async (tx) => {
    const now = new Date()
    const updatedRows = await tx
      .update(merchants)
      .set({
        priority,
        priorityNote: note,
        updatedAt: now,
      })
      .where(and(inArray(merchants.id, ids), isNull(merchants.deletedAt)))
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

export async function getMerchantDetail(merchantId: string) {
  const db = getDb()

  const merchant = await db.query.merchants.findFirst({
    where: and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)),
  })

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }

  const owner = aliasedTable(users, 'history_actor')

  const [documents, merchantCases, timeline] = await Promise.all([
    db
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
      .orderBy(asc(merchantDocuments.createdAt)),
    db
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
      .orderBy(desc(cases.createdAt)),
    db
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
      .orderBy(asc(caseHistory.createdAt), asc(caseHistory.id)),
  ])

  const now = new Date()
  const casesWithSla = merchantCases.map((caseRow) => {
    const isOpen =
      caseRow.status !== 'closed' &&
      caseRow.status !== 'error' &&
      caseRow.stageCategory !== 'closed'
    const slaBreached = isOpen
      ? isCaseSlaBreached({
          createdAt: caseRow.createdAt,
          evaluatedAt: now,
          slaHours: caseRow.queueSlaHours,
        })
      : (caseRow.slaBreached ?? false)
    return { ...caseRow, slaBreached }
  })

  const testStartedAt =
    timeline.find((event) => event.action === 'testing_limits_applied')
      ?.createdAt ?? null

  const globalLimitsAndMdr = await getLimitsAndMdrSettings()
  const override = resolveLimitsMdrOverride(merchant.limitsMdrOverride)

  return {
    merchant: {
      ...merchant,
      limitsMdrOverride: override,
    },
    documents,
    cases: casesWithSla,
    timeline,
    milestones: {
      formFilledAt: merchant.submittedAt,
      testStartedAt,
      liveAt: merchant.liveAt,
    },
    limitsAndMdr: {
      effective: override ?? globalLimitsAndMdr ?? defaultLimitsAndMdrSettings,
      override,
      global: globalLimitsAndMdr ?? defaultLimitsAndMdrSettings,
      isOverridden: override !== null,
    },
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
    limitsAndMdr: globalLimitsAndMdr ?? defaultLimitsAndMdrSettings,
  }
}

