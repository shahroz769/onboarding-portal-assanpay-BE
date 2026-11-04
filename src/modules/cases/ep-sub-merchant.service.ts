import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm'

import { getDb, type DbTransaction } from '../../db/client'
import {
  cases,
  documentReviewDetails,
  merchants,
  queues,
  subMerchantDraftTemplates,
  users,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { SessionUser } from '../../types/auth'
import { getAgentQueueAccess } from './case-access.service'
import {
  buildKeysetCondition,
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorExpression,
  parseCsvValues,
} from './case-cursor'
import { createCaseInTransaction } from './case-query.service'
import {
  epProgressFilterValues,
  epWordpressFilterValues,
} from './cases.schemas'
import type {
  EpProgressFilterValue,
  EpWordpressFilterValue,
  ListEpMerchantsQuery,
  TriggerEpCaseInput,
} from './cases.schemas'

type DbExecutor = ReturnType<typeof getDb> | DbTransaction

const EP_WORKFLOW = 'sub_merchant_form'
const WORDPRESS_WORKFLOW = 'wordpress'
const DOCUMENT_REVIEW_WORKFLOW = 'document_review'

// ─── Queue lookups ──────────────────────────────────────────────────────────

async function getWorkflowQueueIds(database: DbExecutor = getDb()) {
  const rows = await database
    .select({ id: queues.id, workflowType: queues.workflowType })
    .from(queues)
    .where(
      inArray(queues.workflowType, [
        EP_WORKFLOW,
        WORDPRESS_WORKFLOW,
        DOCUMENT_REVIEW_WORKFLOW,
      ]),
    )

  const idsFor = (workflowType: string) =>
    rows.filter((row) => row.workflowType === workflowType).map((row) => row.id)

  return {
    ep: idsFor(EP_WORKFLOW),
    wordpress: idsFor(WORDPRESS_WORKFLOW),
    documentReview: idsFor(DOCUMENT_REVIEW_WORKFLOW),
  }
}

export async function getEpQueueIds(database: DbExecutor = getDb()) {
  const rows = await database
    .select({ id: queues.id })
    .from(queues)
    .where(eq(queues.workflowType, EP_WORKFLOW))
  return rows.map((row) => row.id)
}

// ─── Access ─────────────────────────────────────────────────────────────────

/** Admins, or agents with working access to an EP queue. */
export async function assertCanManageEpCases(
  actor: SessionUser,
  database: DbExecutor = getDb(),
) {
  if (actor.roleType !== 'agent') return

  const [access, epQueueIds] = await Promise.all([
    getAgentQueueAccess(actor.userId, database),
    getEpQueueIds(database),
  ])

  if (!access?.workQueueIds.some((id) => epQueueIds.includes(id))) {
    throw new AppError(
      403,
      'You do not have working access to the EP Sub-Merchant queue.',
    )
  }
}

// ─── SQL fragments ──────────────────────────────────────────────────────────
// Correlated to the outer merchants row. Columns are qualified by hand because
// single-table selects render Drizzle columns unqualified, which would resolve
// to the subquery's own table.

function uuidList(ids: string[]) {
  if (ids.length === 0) return sql`null::uuid`
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
}

function epCasesExist(epQueueIds: string[], condition?: SQL) {
  return sql`exists (
    select 1 from "cases" as "ep"
    where "ep"."merchant_id" = "merchants"."id"
      and "ep"."queue_id" in (${uuidList(epQueueIds)})
      ${condition ? sql`and ${condition}` : sql``}
  )`
}

// The Documents Review selection the flow also uses: the most recently updated
// selection across the merchant's Documents Review cases.
function selectedSubMerchants(documentReviewQueueIds: string[]) {
  return sql`(
    select "selected"."sub_merchant_id"
    from "document_review_details" as "selected"
    where "selected"."case_id" = (
      select "latest"."case_id"
      from "document_review_details" as "latest"
      inner join "cases" as "review" on "review"."id" = "latest"."case_id"
      where "review"."merchant_id" = "merchants"."id"
        and "review"."queue_id" in (${uuidList(documentReviewQueueIds)})
      order by "latest"."updated_at" desc
      limit 1
    )
  ) as "selection"`
}

function wordpressSuccessful(wordpressQueueIds: string[]) {
  return sql`exists (
    select 1 from "cases" as "wp"
    where "wp"."merchant_id" = "merchants"."id"
      and "wp"."queue_id" in (${uuidList(wordpressQueueIds)})
      and "wp"."status" = 'closed'
      and "wp"."close_outcome" = 'successful'
  )`
}

function progressCondition(
  value: EpProgressFilterValue,
  queueIds: Awaited<ReturnType<typeof getWorkflowQueueIds>>,
) {
  const selection = selectedSubMerchants(queueIds.documentReview)
  const epForSelection = sql`"ep"."sub_merchant_id" = "selection"."sub_merchant_id"`

  switch (value) {
    case 'not_triggered':
      return sql`(
        (
          not exists (select 1 from ${selection})
          and not ${epCasesExist(queueIds.ep)}
        )
        or exists (
          select 1 from ${selection}
          where not ${epCasesExist(queueIds.ep, epForSelection)}
        )
      )`
    case 'open':
      return epCasesExist(queueIds.ep, sql`"ep"."status" <> 'closed'`)
    case 'unsuccessful':
      return sql`exists (
        select 1 from ${selection}
        where (
          select "ep"."status" = 'closed' and "ep"."close_outcome" = 'unsuccessful'
          from "cases" as "ep"
          where "ep"."merchant_id" = "merchants"."id"
            and "ep"."queue_id" in (${uuidList(queueIds.ep)})
            and ${epForSelection}
          order by "ep"."created_at" desc, "ep"."id" desc
          limit 1
        ) is true
      )`
    case 'completed':
      return sql`(
        exists (select 1 from ${selection})
        and not exists (
          select 1 from ${selection}
          where not ${epCasesExist(
            queueIds.ep,
            sql`${epForSelection} and "ep"."status" = 'closed' and "ep"."close_outcome" = 'successful'`,
          )}
        )
      )`
  }
}

// ─── Merchants list EP status ───────────────────────────────────────────────

export const epCaseStatusFilterValues = [
  'not_created',
  'new',
  'working',
  'awaiting_merchant',
  'closed_successful',
  'closed_unsuccessful',
] as const
export type EpCaseStatusFilterValue = (typeof epCaseStatusFilterValues)[number]

const epCaseStatusFilterValueSet = new Set<string>(epCaseStatusFilterValues)

function epCaseStatusCondition(
  value: EpCaseStatusFilterValue,
  epQueueIds: string[],
) {
  switch (value) {
    case 'not_created':
      return sql`not ${epCasesExist(epQueueIds)}`
    case 'new':
    case 'working':
    case 'awaiting_merchant':
      return epCasesExist(epQueueIds, sql`"ep"."status" = ${value}`)
    case 'closed_successful':
      return epCasesExist(
        epQueueIds,
        sql`"ep"."status" = 'closed' and "ep"."close_outcome" = 'successful'`,
      )
    // Only while it is the latest case: a re-trigger supersedes it.
    case 'closed_unsuccessful':
      return epCasesExist(
        epQueueIds,
        sql`"ep"."status" = 'closed' and "ep"."close_outcome" = 'unsuccessful'
          and not exists (
            select 1 from "cases" as "newer"
            where "newer"."merchant_id" = "ep"."merchant_id"
              and "newer"."queue_id" = "ep"."queue_id"
              and "newer"."sub_merchant_id" is not distinct from "ep"."sub_merchant_id"
              and "newer"."created_at" > "ep"."created_at"
          )`,
      )
  }
}

/** Filter for `GET /api/merchants`; undefined when nothing valid is selected. */
export function buildEpCaseStatusFilter(
  rawValue: string,
  epQueueIds: string[],
) {
  const values = parseCsvValues<EpCaseStatusFilterValue>(
    rawValue,
    epCaseStatusFilterValueSet,
  )
  if (values.length === 0) return undefined
  return or(...values.map((value) => epCaseStatusCondition(value, epQueueIds)))
}

/** The latest EP case per sub-merchant, for each merchant. */
export async function getLatestEpCases(
  merchantIds: string[],
  epQueueIds: string[],
) {
  const latest = new Map<string, LatestEpCase[]>()
  if (merchantIds.length === 0 || epQueueIds.length === 0) return latest

  const rows = await getDb()
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      merchantId: cases.merchantId,
      subMerchantId: cases.subMerchantId,
      subMerchantName: subMerchantDraftTemplates.name,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
      ownerName: users.name,
    })
    .from(cases)
    .leftJoin(
      subMerchantDraftTemplates,
      eq(cases.subMerchantId, subMerchantDraftTemplates.id),
    )
    .leftJoin(users, eq(cases.ownerId, users.id))
    .where(
      and(
        inArray(cases.merchantId, merchantIds),
        inArray(cases.queueId, epQueueIds),
      ),
    )
    .orderBy(desc(cases.createdAt), desc(cases.id))

  const seen = new Set<string>()
  for (const { merchantId, ...row } of rows) {
    const key = `${merchantId}:${row.subMerchantId ?? row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const merchantCases = latest.get(merchantId) ?? []
    merchantCases.push(row)
    latest.set(merchantId, merchantCases)
  }

  return latest
}

type LatestEpCase = {
  id: string
  caseNumber: string
  subMerchantId: string | null
  subMerchantName: string | null
  status: 'new' | 'working' | 'closed' | 'awaiting_merchant'
  closeOutcome: 'successful' | 'unsuccessful' | null
  ownerName: string | null
}

function canTriggerOver(latestCase: LatestEpCase | undefined) {
  return (
    !latestCase ||
    (latestCase.status === 'closed' &&
      latestCase.closeOutcome === 'unsuccessful')
  )
}

// ─── EP page list ───────────────────────────────────────────────────────────

const epSortColumnMap = {
  createdAt: { expression: merchants.createdAt, kind: 'date' },
  merchantNumber: { expression: merchants.merchantNumber, kind: 'number' },
  businessName: {
    expression: sql`lower(${merchants.businessName})`,
    kind: 'string',
  },
  ownerFullName: {
    expression: sql`lower(${merchants.ownerFullName})`,
    kind: 'string',
  },
  status: { expression: merchants.status, kind: 'string' },
  updatedAt: { expression: merchants.updatedAt, kind: 'date' },
} as const

const epProgressValueSet = new Set<string>(epProgressFilterValues)
const epWordpressValueSet = new Set<string>(epWordpressFilterValues)
const activeMerchantStatuses = ['pending', 'testing', 'live'] as const
type ActiveMerchantStatus = (typeof activeMerchantStatuses)[number]
const activeMerchantStatusSet = new Set<string>(activeMerchantStatuses)

async function getSelectedSubMerchants(
  merchantIds: string[],
  documentReviewQueueIds: string[],
) {
  const selected = new Map<string, { id: string; name: string }[]>()
  if (merchantIds.length === 0 || documentReviewQueueIds.length === 0) {
    return selected
  }

  const rows = await getDb()
    .select({
      merchantId: cases.merchantId,
      caseId: documentReviewDetails.caseId,
      id: subMerchantDraftTemplates.id,
      name: subMerchantDraftTemplates.name,
    })
    .from(documentReviewDetails)
    .innerJoin(cases, eq(documentReviewDetails.caseId, cases.id))
    .innerJoin(
      subMerchantDraftTemplates,
      eq(documentReviewDetails.subMerchantId, subMerchantDraftTemplates.id),
    )
    .where(
      and(
        inArray(cases.merchantId, merchantIds),
        inArray(cases.queueId, documentReviewQueueIds),
      ),
    )
    .orderBy(desc(documentReviewDetails.updatedAt))

  // Rows arrive newest first, so the first case seen is the merchant's latest.
  const latestCaseIds = new Map<string, string>()
  for (const row of rows) {
    if (!latestCaseIds.has(row.merchantId)) {
      latestCaseIds.set(row.merchantId, row.caseId)
    }
    if (latestCaseIds.get(row.merchantId) !== row.caseId) continue
    const merchantSelection = selected.get(row.merchantId) ?? []
    merchantSelection.push({ id: row.id, name: row.name })
    selected.set(row.merchantId, merchantSelection)
  }

  return selected
}

async function getWordpressSummaries(
  merchantIds: string[],
  wordpressQueueIds: string[],
) {
  const summaries = new Map<
    string,
    {
      isSuccessful: boolean
      status: LatestEpCase['status']
      closeOutcome: LatestEpCase['closeOutcome']
    }
  >()
  if (merchantIds.length === 0 || wordpressQueueIds.length === 0) {
    return summaries
  }

  const rows = await getDb()
    .select({
      merchantId: cases.merchantId,
      status: cases.status,
      closeOutcome: cases.closeOutcome,
    })
    .from(cases)
    .where(
      and(
        inArray(cases.merchantId, merchantIds),
        inArray(cases.queueId, wordpressQueueIds),
      ),
    )
    .orderBy(desc(cases.createdAt), desc(cases.id))

  for (const row of rows) {
    const isSuccessful =
      row.status === 'closed' && row.closeOutcome === 'successful'
    const current = summaries.get(row.merchantId)
    if (!current) {
      summaries.set(row.merchantId, {
        isSuccessful,
        status: row.status,
        closeOutcome: row.closeOutcome,
      })
    } else if (isSuccessful && !current.isSuccessful) {
      // A successful WordPress case keeps the merchant eligible even if a
      // newer one exists, so it is what the page shows.
      summaries.set(row.merchantId, {
        isSuccessful,
        status: row.status,
        closeOutcome: row.closeOutcome,
      })
    }
  }

  return summaries
}

export async function listEpMerchants(
  query: ListEpMerchantsQuery,
  actor: SessionUser,
) {
  await assertCanManageEpCases(actor)

  const db = getDb()
  const queueIds = await getWorkflowQueueIds()
  const conditions: (SQL | undefined)[] = [
    isNull(merchants.deletedAt),
    ne(merchants.status, 'terminated'),
  ]

  if (query.search) {
    const term = `%${query.search}%`
    const numericSearch = Number(query.search)
    conditions.push(
      or(
        ilike(merchants.businessName, term),
        ilike(merchants.submitterEmail, term),
        ilike(merchants.ownerFullName, term),
        Number.isInteger(numericSearch)
          ? eq(merchants.merchantNumber, numericSearch)
          : undefined,
      ),
    )
  }

  if (query.status) {
    const statuses = parseCsvValues<ActiveMerchantStatus>(
      query.status,
      activeMerchantStatusSet,
    )
    if (statuses.length > 0) {
      conditions.push(inArray(merchants.status, statuses))
    }
  }

  if (query.wordpress) {
    const values = parseCsvValues<EpWordpressFilterValue>(
      query.wordpress,
      epWordpressValueSet,
    )
    // Selecting both values is the same as no filter.
    if (values.length === 1) {
      const successful = wordpressSuccessful(queueIds.wordpress)
      conditions.push(
        values[0] === 'successful' ? successful : sql`not ${successful}`,
      )
    }
  }

  if (query.progress) {
    const values = parseCsvValues<EpProgressFilterValue>(
      query.progress,
      epProgressValueSet,
    )
    if (values.length > 0) {
      conditions.push(
        or(...values.map((value) => progressCondition(value, queueIds))),
      )
    }
  }

  const orderFn = query.sortOrder === 'desc' ? desc : asc
  const sortSpec = epSortColumnMap[query.sortBy]
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

  const rows = await db
    .select({
      id: merchants.id,
      merchantNumber: merchants.merchantNumber,
      businessName: merchants.businessName,
      ownerFullName: merchants.ownerFullName,
      status: merchants.status,
      createdAt: merchants.createdAt,
      updatedAt: merchants.updatedAt,
      cursorValue: keysetCursorExpression(sortSpec),
    })
    .from(merchants)
    .where(and(...conditions))
    .orderBy(orderFn(sortSpec.expression), orderFn(merchants.id))
    .limit(query.limit + 1)

  const hasMore = rows.length > query.limit
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows
  const lastRow = pageRows[pageRows.length - 1]
  const nextCursor =
    hasMore && lastRow
      ? encodeKeysetCursor({
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          value: lastRow.cursorValue,
          id: lastRow.id,
        })
      : null

  const merchantIds = pageRows.map((row) => row.id)
  const [selections, wordpress, latestCases] = await Promise.all([
    getSelectedSubMerchants(merchantIds, queueIds.documentReview),
    getWordpressSummaries(merchantIds, queueIds.wordpress),
    getLatestEpCases(merchantIds, queueIds.ep),
  ])

  return {
    merchants: pageRows.map(({ cursorValue: _cursorValue, ...row }) => {
      const merchantCases = latestCases.get(row.id) ?? []
      const selected = (selections.get(row.id) ?? []).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      )
      const selectedIds = new Set(selected.map((subMerchant) => subMerchant.id))
      const wordpressSummary = wordpress.get(row.id) ?? null
      const isEligible = wordpressSummary?.isSuccessful ?? false

      return {
        ...row,
        wordpress: wordpressSummary,
        isEligible,
        subMerchants: selected.map((subMerchant) => {
          const latestCase = merchantCases.find(
            (epCase) => epCase.subMerchantId === subMerchant.id,
          )
          return {
            id: subMerchant.id,
            name: subMerchant.name,
            canTrigger: isEligible && canTriggerOver(latestCase),
            latestCase: latestCase ?? null,
          }
        }),
        // EP cases outside the current selection still need to be visible.
        otherCases: merchantCases.filter(
          (epCase) =>
            !epCase.subMerchantId || !selectedIds.has(epCase.subMerchantId),
        ),
      }
    }),
    nextCursor,
    hasMore,
    limit: query.limit,
    total,
  }
}

// ─── Trigger ────────────────────────────────────────────────────────────────

export async function triggerEpCase(
  input: TriggerEpCaseInput,
  actor: SessionUser,
) {
  await assertCanManageEpCases(actor)

  return getDb().transaction(async (tx) => {
    const merchant = await tx.query.merchants.findFirst({
      where: and(
        eq(merchants.id, input.merchantId),
        isNull(merchants.deletedAt),
      ),
      columns: { status: true },
    })

    if (!merchant) throw new AppError(404, 'Merchant not found.')
    if (merchant.status === 'terminated') {
      throw new AppError(
        409,
        'EP cases cannot be triggered for terminated merchants.',
      )
    }

    const [epQueue] = await tx
      .select({ id: queues.id })
      .from(queues)
      .where(
        and(
          eq(queues.workflowType, EP_WORKFLOW),
          eq(queues.lifecycle, 'active'),
        ),
      )
      .limit(1)

    if (!epQueue) {
      throw new AppError(409, 'The EP Sub-Merchant queue is not active.')
    }

    const queueIds = await getWorkflowQueueIds(tx)

    // Serializes triggers for this pair, so a concurrent one sees this case.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${input.merchantId}), hashtext(${`ep-case:${input.subMerchantId}`}))`,
    )

    const [wordpressCase] = await tx
      .select({ id: cases.id })
      .from(cases)
      .where(
        and(
          eq(cases.merchantId, input.merchantId),
          inArray(cases.queueId, queueIds.wordpress),
          eq(cases.status, 'closed'),
          eq(cases.closeOutcome, 'successful'),
        ),
      )
      .limit(1)

    if (!wordpressCase) {
      throw new AppError(
        409,
        'The WordPress case must be closed successfully before an EP case can be triggered.',
      )
    }

    const [latestReview] = await tx
      .select({ caseId: documentReviewDetails.caseId })
      .from(documentReviewDetails)
      .innerJoin(cases, eq(documentReviewDetails.caseId, cases.id))
      .where(
        and(
          eq(cases.merchantId, input.merchantId),
          inArray(cases.queueId, queueIds.documentReview),
        ),
      )
      .orderBy(desc(documentReviewDetails.updatedAt))
      .limit(1)

    const isSelected = latestReview
      ? await tx.query.documentReviewDetails.findFirst({
          where: and(
            eq(documentReviewDetails.caseId, latestReview.caseId),
            eq(documentReviewDetails.subMerchantId, input.subMerchantId),
          ),
          columns: { caseId: true },
        })
      : undefined

    if (!isSelected) {
      throw new AppError(
        409,
        'This sub-merchant was not selected in the Documents Review case.',
      )
    }

    const existingCases = await tx
      .select({
        caseNumber: cases.caseNumber,
        status: cases.status,
        closeOutcome: cases.closeOutcome,
      })
      .from(cases)
      .where(
        and(
          eq(cases.merchantId, input.merchantId),
          eq(cases.subMerchantId, input.subMerchantId),
          inArray(cases.queueId, queueIds.ep),
        ),
      )
      .orderBy(desc(cases.createdAt), desc(cases.id))

    // Only cases closed as unsuccessful can be followed by another one.
    const blocking = existingCases.find(
      (existing) =>
        existing.status !== 'closed' ||
        existing.closeOutcome !== 'unsuccessful',
    )

    if (blocking) {
      throw new AppError(
        409,
        blocking.status === 'closed'
          ? `EP case ${blocking.caseNumber} was already completed for this sub-merchant.`
          : `EP case ${blocking.caseNumber} is already open for this sub-merchant.`,
      )
    }

    return createCaseInTransaction(
      tx,
      {
        merchantId: input.merchantId,
        queueId: epQueue.id,
        subMerchantId: input.subMerchantId,
      },
      actor.userId,
    )
  })
}
