import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  agreementCaseDetails,
  cases,
  documentReviewDetails,
  merchants,
  midCasePortalMids,
  portalMidLimitApplications,
  queues,
  users,
} from '../../db/schema'
import {
  buildKeysetCondition,
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorExpression,
} from '../cases/case-cursor'
import type {
  ApplyPortalMidLimitsInput,
  DashboardQuery,
  DashboardRangeKey,
  AwaitingPhysicalAgreementsQuery,
  PendingPortalMidGroup,
  PendingPortalMidsQuery,
  PendingPortalMidValuesQuery,
} from './dashboard.schemas'
import { MAX_DASHBOARD_RANGE_DAYS } from './dashboard.schemas'

// ─── Constants ──────────────────────────────────────────────────────────────

const CASE_STATUSES = [
  'new',
  'working',
  'closed',
  'awaiting_merchant',
] as const

const MERCHANT_STATUSES = ['pending', 'testing', 'live', 'terminated'] as const

// Open cases mirror the "My Open Cases" definition: not closed.
const OPEN_CASE_STATUSES = ['new', 'working', 'awaiting_merchant']

const DASHBOARD_TIME_ZONE = sql.raw("'Asia/Karachi'")
const DASHBOARD_TIME_ZONE_OFFSET_MINUTES = 5 * 60
const MID_CREATION_QUEUE_SLUG = 'merchant-id'

// ─── Range Resolution ───────────────────────────────────────────────────────

function startOfDay(date: Date) {
  return dateKeyToStartOfDay(toDashboardDateKey(date))
}

function startOfMonth(date: Date) {
  return dateKeyToStartOfDay(`${toDashboardDateKey(date).slice(0, 8)}01`)
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000)
}

function toDashboardDateKey(date: Date) {
  return new Date(
    date.getTime() + DASHBOARD_TIME_ZONE_OFFSET_MINUTES * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10)
}

function dateKeyToStartOfDay(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000+05:00`)
}

interface ResolvedRange {
  key: DashboardRangeKey
  from: Date
  to: Date
  label: string
}

function resolveRange(query: DashboardQuery): ResolvedRange {
  const now = new Date()
  const to = now

  switch (query.range) {
    case 'today':
      return { key: 'today', from: startOfDay(now), to, label: 'Today' }
    case '7d':
      return {
        key: '7d',
        from: startOfDay(addDays(now, -6)),
        to,
        label: 'Last 7 days',
      }
    case '90d':
      return {
        key: '90d',
        from: startOfDay(addDays(now, -89)),
        to,
        label: 'Last 90 days',
      }
    case 'mtd':
      return {
        key: 'mtd',
        from: startOfMonth(now),
        to,
        label: 'Month to date',
      }
    case 'custom': {
      const fromDate = dateKeyToStartOfDay(query.from as string)
      const toDate = dateKeyToStartOfDay(query.to as string)
      // `to` is a date key for a whole day, so report the end of it. Queries
      // bound on the next day's start (see getDashboard's `endIso`).
      const safeTo = Number.isNaN(toDate.getTime())
        ? now
        : new Date(addDays(toDate, 1).getTime() - 1)
      const safeFrom = Number.isNaN(fromDate.getTime())
        ? startOfDay(addDays(now, -29))
        : fromDate
      return {
        key: 'custom',
        from: safeFrom,
        to: safeTo,
        label: 'Custom range',
      }
    }
    case '30d':
    default:
      return {
        key: '30d',
        from: startOfDay(addDays(now, -29)),
        to,
        label: 'Last 30 days',
      }
  }
}

// ─── SQL Helpers ────────────────────────────────────────────────────────────

const int = (expr: ReturnType<typeof sql>) => sql<number>`${expr}::int`

type PendingPortalMidLimitRow = {
  merchantId: string
  merchantName: string
  subMerchantName: string | null
  caseId: string
  caseNumber: string
  portalMid: number
  midKind: 'portal' | 'internal'
  savedAt: Date | string | null
}

type DashboardTrendRow = {
  metric: 'submission' | 'opened' | 'closed' | 'went_live'
  day: string
  count: number
}

function normalizePortalMids(portalMids: number[]) {
  return Array.from(new Set(portalMids)).sort((a, b) => a - b)
}

function toPendingPortalMidLimit(row: PendingPortalMidLimitRow) {
  return {
    merchantId: row.merchantId,
    merchantName: row.merchantName,
    subMerchantName: row.subMerchantName,
    caseId: row.caseId,
    caseNumber: row.caseNumber,
    portalMid: row.portalMid,
    midKind: row.midKind,
    savedAt: serializeTimestamp(row.savedAt),
  }
}

function serializeTimestamp(value: Date | string | null) {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'string') {
    return new Date(value).toISOString()
  }

  return new Date(0).toISOString()
}

type PendingPortalMidOptions = {
  filterPortalMids?: number[]
  group?: PendingPortalMidGroup
}

// Internal MIDs, else the merchant's website CMS: Shopify or Custom/WordPress.
const pendingGroupExpression = sql`
  case
    when candidate_mid."midKind" = 'internal' then 'internal'
    when ${merchants.websiteCms} = 'shopify' then 'shopify'
    else 'custom_wordpress'
  end
`

/**
 * CTEs ending in `pending`: every portal/internal MID from a merchant's latest
 * successful MID Creation case whose limits have not been applied yet. Shared
 * by the paged list, the counts and the copy-all MID lists so they can never
 * disagree.
 *
 * Unapplied MIDs are found first, so the case and merchant checks only run for
 * those rows; the cost follows the pending MIDs, not every MID ever saved.
 */
function pendingPortalMidCtes(options: PendingPortalMidOptions = {}) {
  const { filterPortalMids, group } = options
  const portalMidFilter =
    filterPortalMids && filterPortalMids.length > 0
      ? sql`and candidate."portalMid" in (${sql.join(
          filterPortalMids.map((portalMid) => sql`${portalMid}`),
          sql`, `,
        )})`
      : sql``
  // The MID kind narrows candidates early; the CMS split needs the merchant.
  const midKindFilter = group
    ? sql`and candidate."midKind" = ${group === 'internal' ? 'internal' : 'portal'}`
    : sql``
  const groupFilter = group
    ? sql`and ${pendingGroupExpression} = ${group}`
    : sql``

  return sql`
    with candidate_mid as (
      select
        ${midCasePortalMids.caseId} as "caseId",
        ${midCasePortalMids.savedAt} as "savedAt",
        candidate."portalMid",
        candidate."midKind"
      from ${midCasePortalMids}
      cross join lateral (
        values
          (${midCasePortalMids.portalMid}, 'portal'::text),
          (${midCasePortalMids.internalPortalMid}, 'internal'::text)
      ) as candidate("portalMid", "midKind")
      where candidate."portalMid" is not null
        -- An internal MID equal to the portal MID is the same MID.
        and (
          candidate."midKind" = 'portal'
          or candidate."portalMid" <> ${midCasePortalMids.portalMid}
        )
        and not exists (
          select 1
          from ${portalMidLimitApplications}
          where ${portalMidLimitApplications.portalMid} = candidate."portalMid"
        )
        ${portalMidFilter}
        ${midKindFilter}
    ),
    pending as (
      select
        ${cases.merchantId} as "merchantId",
        ${merchants.businessName} as "merchantName",
        ${cases.id} as "caseId",
        ${cases.caseNumber} as "caseNumber",
        candidate_mid."portalMid",
        candidate_mid."midKind",
        ${pendingGroupExpression} as "group",
        candidate_mid."savedAt",
        ${cases.id}::text || ':' || candidate_mid."midKind" as "rowKey"
      from candidate_mid
      inner join ${cases} on ${cases.id} = candidate_mid."caseId"
      inner join ${queues} on ${queues.id} = ${cases.queueId}
      inner join ${merchants} on ${merchants.id} = ${cases.merchantId}
      where ${queues.slug} = ${MID_CREATION_QUEUE_SLUG}
        and ${cases.status} = 'closed'
        and ${cases.closeOutcome} = 'successful'
        and ${merchants.deletedAt} is null
        ${groupFilter}
        -- Only the merchant's latest successful MID case counts.
        and not exists (
          select 1
          from ${cases} as newer_case
          inner join ${midCasePortalMids} as newer_mid
            on newer_mid.case_id = newer_case.id
          where newer_case.merchant_id = ${cases.merchantId}
            and newer_case.queue_id = ${cases.queueId}
            and newer_case.status = 'closed'
            and newer_case.close_outcome = 'successful'
            and newer_mid.saved_at > candidate_mid."savedAt"
        )
    )
  `
}

async function listPendingPortalMidLimitRows(
  filterPortalMids?: number[],
  page?: { after?: { portalMid: number; rowKey: string }; limit: number },
): Promise<(PendingPortalMidLimitRow & { rowKey: string })[]> {
  if (filterPortalMids && filterPortalMids.length === 0) {
    return []
  }

  const db = getDb()
  const afterFilter = page?.after
    ? sql`where (pending."portalMid", pending."rowKey") > (${page.after.portalMid}::int, ${page.after.rowKey}::text)`
    : sql``
  const limitClause = page ? sql`limit ${page.limit}` : sql``

  // Sub-merchant names are resolved only for the rows on this page.
  const rows = await db.execute(sql<PendingPortalMidLimitRow>`
    ${pendingPortalMidCtes({ filterPortalMids })},
    page as (
      select * from pending
      ${afterFilter}
      order by pending."portalMid" asc, pending."rowKey" asc
      ${limitClause}
    ),
    latest_review_case as (
      select distinct on (${cases.merchantId})
        ${cases.merchantId} as "merchantId",
        ${cases.id} as "caseId"
      from (select distinct "merchantId" from page) page_merchant
      inner join ${cases}
        on ${cases.merchantId} = page_merchant."merchantId"
      inner join ${documentReviewDetails}
        on ${documentReviewDetails.caseId} = ${cases.id}
      order by ${cases.merchantId}, ${documentReviewDetails.updatedAt} desc
    ),
    latest_submerchant as (
      select
        latest_review_case."merchantId",
        string_agg(${documentReviewDetails.subMerchantName}, ', ' order by ${documentReviewDetails.subMerchantName}) as "subMerchantName"
      from latest_review_case
      inner join ${documentReviewDetails}
        on ${documentReviewDetails.caseId} = latest_review_case."caseId"
      group by latest_review_case."merchantId"
    )
    select
      page."merchantId",
      page."merchantName",
      latest_submerchant."subMerchantName",
      page."caseId",
      page."caseNumber",
      page."portalMid",
      page."midKind" as "midKind",
      page."savedAt",
      page."rowKey"
    from page
    left join latest_submerchant
      on latest_submerchant."merchantId" = page."merchantId"
    order by page."portalMid" asc, page."rowKey" asc
  `)

  return Array.from(rows) as (PendingPortalMidLimitRow & { rowKey: string })[]
}

async function countPendingPortalMidLimits() {
  type PendingCounts = {
    total: number
    internal: number
    customWordpress: number
    shopify: number
  }
  const db = getDb()
  const [row] = Array.from(
    await db.execute(sql<PendingCounts>`
      ${pendingPortalMidCtes()}
      select
        count(*)::int as "total",
        (count(*) filter (where pending."group" = 'internal'))::int as "internal",
        (count(*) filter (where pending."group" = 'custom_wordpress'))::int as "customWordpress",
        (count(*) filter (where pending."group" = 'shopify'))::int as "shopify"
      from pending
    `),
  ) as PendingCounts[]

  return {
    total: row?.total ?? 0,
    internal: row?.internal ?? 0,
    customWordpress: row?.customWordpress ?? 0,
    shopify: row?.shopify ?? 0,
  }
}

/**
 * Every applied MID grouped by category, for the Applied dialog. Loaded only
 * when the dialog opens, never with the dashboard summary.
 */
export async function listAppliedPortalMids() {
  const rows = await getDb()
    .select({
      portalMid: portalMidLimitApplications.portalMid,
      category: portalMidLimitApplications.category,
    })
    .from(portalMidLimitApplications)
    .orderBy(asc(portalMidLimitApplications.portalMid))

  const customWordpress: number[] = []
  const shopify: number[] = []
  const internal: number[] = []
  for (const row of rows) {
    if (row.category === 'shopify') shopify.push(row.portalMid)
    else if (row.category === 'internal') internal.push(row.portalMid)
    else customWordpress.push(row.portalMid)
  }

  return {
    customWordpress,
    shopify,
    internal,
    csv: rows.map((row) => row.portalMid).join(','),
  }
}

const PENDING_MID_CURSOR_SORT = {
  sortBy: 'portalMid',
  sortOrder: 'asc',
  kind: 'number',
} as const

export async function listPendingPortalMidLimitsPage(
  query: PendingPortalMidsQuery,
) {
  const cursor = query.cursor
    ? decodeKeysetCursor(query.cursor, PENDING_MID_CURSOR_SORT)
    : null
  const [rows, counts] = await Promise.all([
    listPendingPortalMidLimitRows(undefined, {
      after: cursor
        ? { portalMid: Number(cursor.value), rowKey: cursor.id }
        : undefined,
      limit: query.limit + 1,
    }),
    // Totals only on the first page; later pages keep the first response's.
    cursor ? null : countPendingPortalMidLimits(),
  ])
  const hasMore = rows.length > query.limit
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows
  const last = pageRows[pageRows.length - 1]

  return {
    data: pageRows.map(toPendingPortalMidLimit),
    nextCursor:
      hasMore && last
        ? encodeKeysetCursor({
            sortBy: PENDING_MID_CURSOR_SORT.sortBy,
            sortOrder: PENDING_MID_CURSOR_SORT.sortOrder,
            value: last.portalMid,
            id: last.rowKey,
          })
        : null,
    hasMore,
    limit: query.limit,
    counts,
  }
}

/** Every pending MID (optionally one group) straight from the DB, for copying. */
export async function listPendingPortalMidValues(
  query: PendingPortalMidValuesQuery,
) {
  const db = getDb()
  const rows = Array.from(
    await db.execute(sql<{ portalMid: number }>`
      ${pendingPortalMidCtes({ group: query.group })}
      select distinct pending."portalMid" as "portalMid"
      from pending
      order by pending."portalMid" asc
    `),
  ) as { portalMid: number }[]
  const mids = rows.map((row) => row.portalMid)

  return { mids, csv: mids.join(',') }
}

// ─── Agreements Awaiting Physical Copy ──────────────────────────────────────

// Agreement cases where the agreement email went out and the case is waiting
// on the client, but the signed physical copy has not been uploaded yet.
function awaitingPhysicalAgreementConditions() {
  return [
    eq(queues.workflowType, 'agreement'),
    eq(cases.status, 'awaiting_merchant'),
    eq(agreementCaseDetails.emailStatus, 'sent'),
    isNull(agreementCaseDetails.receivedAgreementFileId),
    isNull(merchants.deletedAt),
  ]
}

const AWAITING_AGREEMENT_SORT = {
  sortBy: 'emailSentAt',
  sortOrder: 'asc',
  kind: 'date',
} as const

// Oldest sent first: the longest-waiting merchants need the follow-up most.
const awaitingAgreementSentAt = sql<
  Date | string
>`coalesce(${agreementCaseDetails.emailSentAt}, ${cases.updatedAt})`

async function countAwaitingPhysicalAgreements() {
  const db = getDb()
  const [row] = await db
    .select({ value: count() })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .innerJoin(agreementCaseDetails, eq(agreementCaseDetails.caseId, cases.id))
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(and(...awaitingPhysicalAgreementConditions()))

  return row?.value ?? 0
}

export async function listAwaitingPhysicalAgreementsPage(
  query: AwaitingPhysicalAgreementsQuery,
) {
  const db = getDb()
  const cursor = query.cursor
    ? decodeKeysetCursor(query.cursor, AWAITING_AGREEMENT_SORT)
    : null
  const conditions = awaitingPhysicalAgreementConditions()

  if (cursor) {
    conditions.push(
      buildKeysetCondition({
        expression: awaitingAgreementSentAt,
        idExpression: cases.id,
        sortOrder: AWAITING_AGREEMENT_SORT.sortOrder,
        kind: cursor.kind,
        value: cursor.value,
        id: cursor.id,
      }),
    )
  }

  const [rows, total] = await Promise.all([
    db
      .select({
        caseId: cases.id,
        caseNumber: cases.caseNumber,
        merchantId: merchants.id,
        merchantName: merchants.businessName,
        emailRecipient: agreementCaseDetails.emailRecipient,
        ownerName: users.name,
        emailSentAt: awaitingAgreementSentAt,
        cursorValue: keysetCursorExpression({
          expression: awaitingAgreementSentAt,
          kind: 'date',
        }),
      })
      .from(cases)
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .innerJoin(
        agreementCaseDetails,
        eq(agreementCaseDetails.caseId, cases.id),
      )
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(and(...conditions))
      .orderBy(asc(awaitingAgreementSentAt), asc(cases.id))
      .limit(query.limit + 1),
    // Totals only on the first page; later pages keep the first response's.
    cursor ? null : countAwaitingPhysicalAgreements(),
  ])

  const hasMore = rows.length > query.limit
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows
  const last = pageRows[pageRows.length - 1]

  return {
    data: pageRows.map(({ cursorValue: _cursorValue, ...row }) => ({
      ...row,
      emailSentAt: serializeTimestamp(row.emailSentAt),
    })),
    nextCursor:
      hasMore && last
        ? encodeKeysetCursor({
            sortBy: AWAITING_AGREEMENT_SORT.sortBy,
            sortOrder: AWAITING_AGREEMENT_SORT.sortOrder,
            value: last.cursorValue,
            id: last.caseId,
          })
        : null,
    hasMore,
    limit: query.limit,
    total,
  }
}

export async function applyPortalMidLimits(
  input: ApplyPortalMidLimitsInput,
  userId: string,
) {
  const db = getDb()
  const requested = normalizePortalMids(input.portalMids)
  const existingRows =
    requested.length > 0
      ? await db
          .select({ portalMid: portalMidLimitApplications.portalMid })
          .from(portalMidLimitApplications)
          .where(inArray(portalMidLimitApplications.portalMid, requested))
      : []
  const alreadyApplied = normalizePortalMids(
    existingRows.map((row) => row.portalMid),
  )
  const alreadyAppliedSet = new Set(alreadyApplied)
  const candidates = requested.filter((mid) => !alreadyAppliedSet.has(mid))
  const pendingRows = await listPendingPortalMidLimitRows(candidates)
  const pendingByMid = new Map(pendingRows.map((row) => [row.portalMid, row]))
  const now = new Date()

  if (alreadyApplied.length > 0) {
    await db
      .update(portalMidLimitApplications)
      .set({ category: input.category })
      .where(inArray(portalMidLimitApplications.portalMid, alreadyApplied))
  }

  if (candidates.length > 0) {
    await db
      .insert(portalMidLimitApplications)
      .values(
        candidates.map((portalMid) => ({
          portalMid,
          category: input.category,
          merchantId: pendingByMid.get(portalMid)?.merchantId ?? null,
          appliedBy: userId,
          appliedAt: now,
        })),
      )
      .onConflictDoNothing()
  }

  const applied = normalizePortalMids(candidates)
  const notFound: number[] = []

  return { applied, alreadyApplied, notFound }
}

function buildDateSeries(from: Date, to: Date) {
  const days: string[] = []
  const cursor = startOfDay(from)
  const end = startOfDay(to)
  let guard = 0
  while (
    cursor.getTime() <= end.getTime() &&
    guard < MAX_DASHBOARD_RANGE_DAYS
  ) {
    days.push(toDashboardDateKey(cursor))
    cursor.setTime(addDays(cursor, 1).getTime())
    guard += 1
  }
  return days
}

// ─── Main Aggregation ───────────────────────────────────────────────────────

export async function getDashboard(query: DashboardQuery) {
  const db = getDb()
  const range = resolveRange(query)
  const { from, to } = range

  // ISO strings for raw `sql` interpolation. postgres-js cannot bind raw Date
  // objects passed as template params, so timestamps must be serialized first.
  // Every range filter is [from, endIso): the start of the day after `to`, so
  // the range totals and the daily trend series count exactly the same rows.
  const fromIso = from.toISOString()
  const endIso = addDays(startOfDay(to), 1).toISOString()
  const liveMerchant = and(isNull(merchants.deletedAt))

  // Portal MID counts and applied MIDs come from their own endpoints: the
  // pending list's first page carries the counts, and the Applied dialog
  // loads its MIDs on open.
  const [caseSummaryRows, merchantSummaryRows, dashboardTrendRows] =
    await Promise.all([
      // Case snapshot, range, and SLA metrics in one grouped scan.
      db
        .select({
          status: cases.status,
          count: int(sql`count(*)`),
          newInRange: int(
            sql`count(*) filter (where ${cases.createdAt} >= ${fromIso} and ${cases.createdAt} < ${endIso})`,
          ),
          closedInRange: int(
            sql`count(*) filter (where ${cases.closedAt} >= ${fromIso} and ${cases.closedAt} < ${endIso})`,
          ),
          breached: int(
            sql`count(*) filter (where ${cases.slaBreached} = true)`,
          ),
          evaluated: int(
            sql`count(*) filter (where ${cases.slaBreached} is not null)`,
          ),
          openOverSla: int(
            sql`count(*) filter (where ${cases.status} <> 'closed' and now() > ${cases.createdAt} + (${queues.slaHours} * interval '1 hour'))`,
          ),
        })
        .from(cases)
        .innerJoin(queues, eq(cases.queueId, queues.id))
        .groupBy(cases.status),

      // Merchant snapshot, range, and submission windows in one grouped scan.
      db
        .select({
          status: merchants.status,
          count: int(sql`count(*)`),
          submittedInRange: int(
            sql`count(*) filter (where ${merchants.submittedAt} >= ${fromIso} and ${merchants.submittedAt} < ${endIso})`,
          ),
          liveInRange: int(
            sql`count(*) filter (where ${merchants.liveAt} >= ${fromIso} and ${merchants.liveAt} < ${endIso})`,
          ),
        })
        .from(merchants)
        .where(liveMerchant)
        .groupBy(merchants.status),

      // All daily trends in one round trip.
      db.execute(sql<DashboardTrendRow>`
      select
        'submission'::text as "metric",
        to_char(${merchants.submittedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${merchants}
      where ${merchants.deletedAt} is null
        and ${merchants.submittedAt} >= ${fromIso}
        and ${merchants.submittedAt} < ${endIso}
      group by "day"
      union all
      select
        'opened'::text as "metric",
        to_char(${cases.createdAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${cases}
      where ${cases.createdAt} >= ${fromIso}
        and ${cases.createdAt} < ${endIso}
      group by "day"
      union all
      select
        'closed'::text as "metric",
        to_char(${cases.closedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${cases}
      where ${cases.closedAt} >= ${fromIso}
        and ${cases.closedAt} < ${endIso}
      group by "day"
      union all
      select
        'went_live'::text as "metric",
        to_char(${merchants.liveAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${merchants}
      where ${merchants.deletedAt} is null
        and ${merchants.liveAt} >= ${fromIso}
        and ${merchants.liveAt} < ${endIso}
      group by "day"
    `),
    ])

  // ─── Shape Case Status Counts ─────────────────────────────────────────────

  const caseStatusMap = new Map(
    caseSummaryRows.map((row) => [row.status, row.count]),
  )
  const caseStatusDistribution = CASE_STATUSES.map((status) => ({
    status,
    count: caseStatusMap.get(status) ?? 0,
  }))
  const totalCases = caseStatusDistribution.reduce(
    (sum, item) => sum + item.count,
    0,
  )
  const openCases = caseStatusDistribution
    .filter((item) => OPEN_CASE_STATUSES.includes(item.status))
    .reduce((sum, item) => sum + item.count, 0)

  const slaSummary = caseSummaryRows.reduce(
    (summary, row) => ({
      breached: summary.breached + row.breached,
      evaluated: summary.evaluated + row.evaluated,
      openOverSla: summary.openOverSla + row.openOverSla,
    }),
    { breached: 0, evaluated: 0, openOverSla: 0 },
  )
  const caseRange = caseSummaryRows.reduce(
    (summary, row) => ({
      newInRange: summary.newInRange + row.newInRange,
      closedInRange: summary.closedInRange + row.closedInRange,
    }),
    { newInRange: 0, closedInRange: 0 },
  )

  // ─── Shape Merchant Counts ────────────────────────────────────────────────

  const merchantStatusMap = new Map(
    merchantSummaryRows.map((row) => [row.status, row.count]),
  )
  const merchantFunnel = MERCHANT_STATUSES.map((status) => ({
    status,
    count: merchantStatusMap.get(status) ?? 0,
  }))
  const totalMerchants = merchantFunnel.reduce(
    (sum, item) => sum + item.count,
    0,
  )
  const merchantRange = merchantSummaryRows.reduce(
    (summary, row) => ({
      submittedInRange: summary.submittedInRange + row.submittedInRange,
      liveInRange: summary.liveInRange + row.liveInRange,
    }),
    { submittedInRange: 0, liveInRange: 0 },
  )
  // ─── Shape Trends ─────────────────────────────────────────────────────────

  const series = buildDateSeries(from, to)
  const trendMaps: Record<DashboardTrendRow['metric'], Map<string, number>> = {
    submission: new Map(),
    opened: new Map(),
    closed: new Map(),
    went_live: new Map(),
  }
  for (const row of Array.from(dashboardTrendRows) as DashboardTrendRow[]) {
    trendMaps[row.metric].set(row.day, row.count)
  }
  const {
    submission: submissionMap,
    opened: newMap,
    closed: closedMap,
    went_live: wentLiveMap,
  } = trendMaps

  const submissionsTrend = series.map((day) => ({
    date: day,
    count: submissionMap.get(day) ?? 0,
  }))
  const caseFlowTrend = series.map((day) => ({
    date: day,
    new: newMap.get(day) ?? 0,
    closed: closedMap.get(day) ?? 0,
  }))
  const merchantsLiveTrend = series.map((day) => ({
    date: day,
    count: wentLiveMap.get(day) ?? 0,
  }))

  return {
    range: {
      key: range.key,
      from: from.toISOString(),
      to: to.toISOString(),
      label: range.label,
    },
    cases: {
      total: totalCases,
      open: openCases,
      new: caseStatusMap.get('new') ?? 0,
      working: caseStatusMap.get('working') ?? 0,
      closed: caseStatusMap.get('closed') ?? 0,
      awaitingMerchant: caseStatusMap.get('awaiting_merchant') ?? 0,
      newInRange: caseRange.newInRange,
      closedInRange: caseRange.closedInRange,
      slaBreached: slaSummary.breached,
      slaEvaluated: slaSummary.evaluated,
      openOverSla: slaSummary.openOverSla,
      statusDistribution: caseStatusDistribution,
    },
    merchants: {
      total: totalMerchants,
      pending: merchantStatusMap.get('pending') ?? 0,
      testing: merchantStatusMap.get('testing') ?? 0,
      live: merchantStatusMap.get('live') ?? 0,
      terminated: merchantStatusMap.get('terminated') ?? 0,
      submittedInRange: merchantRange.submittedInRange,
      liveInRange: merchantRange.liveInRange,
      funnel: merchantFunnel,
    },
    trends: {
      submissions: submissionsTrend,
      caseFlow: caseFlowTrend,
      merchantsLive: merchantsLiveTrend,
    },
  }
}
