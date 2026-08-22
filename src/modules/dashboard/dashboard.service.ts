import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseHistory,
  cases,
  documentReviewDetails,
  merchants,
  portalMidLimitApplications,
  queues,
  users,
} from '../../db/schema'
import type {
  ApplyPortalMidLimitsInput,
  DashboardQuery,
  DashboardRangeKey,
} from './dashboard.schemas'

// ─── Constants ──────────────────────────────────────────────────────────────

const CASE_STATUSES = [
  'new',
  'working',
  'pending',
  'qc',
  'error',
  'closed',
  'awaiting_client',
] as const

const MERCHANT_STATUSES = ['pending', 'testing', 'live', 'terminated'] as const

// Open cases mirror the "My Open Cases" definition: not closed and not error.
const OPEN_CASE_STATUSES = [
  'new',
  'working',
  'pending',
  'qc',
  'awaiting_client',
]

const MAX_TREND_DAYS = 120
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
      const safeTo = Number.isNaN(toDate.getTime()) ? now : toDate
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

type AppliedPortalMidLimitRow = {
  portalMid: number
  merchantId: string | null
  appliedByName: string | null
  appliedAt: Date | string | null
  category: 'custom_wordpress' | 'shopify' | 'internal'
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

function toAppliedPortalMidLimit(row: AppliedPortalMidLimitRow) {
  return {
    portalMid: row.portalMid,
    merchantId: row.merchantId,
    appliedByName: row.appliedByName,
    appliedAt: serializeTimestamp(row.appliedAt),
    category: row.category,
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

async function listPendingPortalMidLimitRows(
  filterPortalMids?: number[],
): Promise<PendingPortalMidLimitRow[]> {
  if (filterPortalMids && filterPortalMids.length === 0) {
    return []
  }

  const db = getDb()
  const portalMidFilter =
    filterPortalMids && filterPortalMids.length > 0
      ? sql`and candidate_mid."portalMid" in (${sql.join(
          filterPortalMids.map((portalMid) => sql`${portalMid}`),
          sql`, `,
        )})`
      : sql``

  const rows = await db.execute(sql<PendingPortalMidLimitRow>`
    with latest_mid as (
      select distinct on (${cases.merchantId})
        ${cases.merchantId} as "merchantId",
        ${merchants.businessName} as "merchantName",
        ${cases.id} as "caseId",
        ${cases.caseNumber} as "caseNumber",
        ${caseHistory.details} as "details",
        ${caseHistory.createdAt} as "savedAt"
      from ${caseHistory}
      inner join ${cases} on ${caseHistory.caseId} = ${cases.id}
      inner join ${queues} on ${cases.queueId} = ${queues.id}
      inner join ${merchants} on ${cases.merchantId} = ${merchants.id}
      where ${caseHistory.action} = 'mid_creation_saved'
        and ${queues.slug} = ${MID_CREATION_QUEUE_SLUG}
        and ${cases.status} = 'closed'
        and ${cases.closeOutcome} = 'successful'
        and ${merchants.deletedAt} is null
        and (${caseHistory.details} ->> 'portalMid') ~ '^[0-9]+$'
      order by ${cases.merchantId}, ${caseHistory.createdAt} desc
    ),
    candidate_mid as (
      select
        latest_mid."merchantId",
        latest_mid."merchantName",
        latest_mid."caseId",
        latest_mid."caseNumber",
        (latest_mid.details ->> 'portalMid')::int as "portalMid",
        'portal'::text as "midKind",
        latest_mid."savedAt"
      from latest_mid
      union all
      select
        latest_mid."merchantId",
        latest_mid."merchantName",
        latest_mid."caseId",
        latest_mid."caseNumber",
        (latest_mid.details ->> 'internalPortalMid')::int as "portalMid",
        'internal'::text as "midKind",
        latest_mid."savedAt"
      from latest_mid
      where (latest_mid.details ->> 'internalPortalMid') ~ '^[0-9]+$'
        and (latest_mid.details ->> 'internalPortalMid')::int <> (latest_mid.details ->> 'portalMid')::int
    ),
    pending as (
      select
        latest_mid."merchantId",
        latest_mid."merchantName",
        latest_mid."caseId",
        latest_mid."caseNumber",
        candidate_mid."portalMid",
        candidate_mid."midKind",
        latest_mid."savedAt"
      from candidate_mid
      inner join latest_mid
        on latest_mid."caseId" = candidate_mid."caseId"
      left join ${portalMidLimitApplications}
        on ${portalMidLimitApplications.portalMid} = candidate_mid."portalMid"
      where ${portalMidLimitApplications.portalMid} is null
        ${portalMidFilter}
    ),
    latest_review_case as (
      select distinct on (${cases.merchantId})
        ${cases.merchantId} as "merchantId",
        ${cases.id} as "caseId"
      from pending
      inner join ${cases}
        on ${cases.merchantId} = pending."merchantId"
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
      pending."merchantId",
      pending."merchantName",
      latest_submerchant."subMerchantName",
      pending."caseId",
      pending."caseNumber",
      pending."portalMid",
      pending."midKind" as "midKind",
      pending."savedAt"
    from pending
    left join latest_submerchant
      on latest_submerchant."merchantId" = pending."merchantId"
    order by "portalMid" asc
  `)

  return Array.from(rows) as PendingPortalMidLimitRow[]
}

async function listAppliedPortalMidLimitRows(): Promise<
  AppliedPortalMidLimitRow[]
> {
  const db = getDb()
  const rows = await db.execute(sql<AppliedPortalMidLimitRow>`
    with latest_mid as (
      select distinct on (${cases.merchantId})
        ${cases.merchantId} as "merchantId",
        ${merchants.websiteCms} as "websiteCms",
        ${caseHistory.details} as "details",
        ${caseHistory.createdAt} as "savedAt"
      from ${caseHistory}
      inner join ${cases} on ${caseHistory.caseId} = ${cases.id}
      inner join ${queues} on ${cases.queueId} = ${queues.id}
      inner join ${merchants} on ${cases.merchantId} = ${merchants.id}
      where ${caseHistory.action} = 'mid_creation_saved'
        and ${queues.slug} = ${MID_CREATION_QUEUE_SLUG}
        and ${merchants.deletedAt} is null
        and (${caseHistory.details} ->> 'portalMid') ~ '^[0-9]+$'
      order by ${cases.merchantId}, ${caseHistory.createdAt} desc
    ),
    classified_mid as materialized (
      select
        latest_mid."merchantId",
        latest_mid."websiteCms",
        (latest_mid."details" ->> 'portalMid')::int as "portalMid",
        'portal'::text as "midKind",
        latest_mid."savedAt"
      from latest_mid
      union all
      select
        latest_mid."merchantId",
        latest_mid."websiteCms",
        (latest_mid."details" ->> 'internalPortalMid')::int as "portalMid",
        'internal'::text as "midKind",
        latest_mid."savedAt"
      from latest_mid
      where (latest_mid."details" ->> 'internalPortalMid') ~ '^[0-9]+$'
        and (latest_mid."details" ->> 'internalPortalMid')::int <> (latest_mid."details" ->> 'portalMid')::int
    )
    select distinct on (${portalMidLimitApplications.portalMid})
      ${portalMidLimitApplications.portalMid} as "portalMid",
      coalesce(${portalMidLimitApplications.merchantId}, classified_mid."merchantId") as "merchantId",
      ${users.name} as "appliedByName",
      ${portalMidLimitApplications.appliedAt} as "appliedAt",
      coalesce(
        ${portalMidLimitApplications.category},
        case
          when classified_mid."midKind" = 'internal' then 'internal'
          when classified_mid."websiteCms" = 'shopify' then 'shopify'
          else 'custom_wordpress'
        end
      ) as "category"
    from ${portalMidLimitApplications}
    left join ${users}
      on ${portalMidLimitApplications.appliedBy} = ${users.id}
    left join classified_mid
      on classified_mid."portalMid" = ${portalMidLimitApplications.portalMid}
    order by
      ${portalMidLimitApplications.portalMid} asc,
      case
        when classified_mid."merchantId" = ${portalMidLimitApplications.merchantId} then 0
        else 1
      end,
      classified_mid."savedAt" desc
  `)

  return Array.from(rows) as AppliedPortalMidLimitRow[]
}

export async function getPendingPortalMidLimits() {
  const [pending, appliedRows] = await Promise.all([
    listPendingPortalMidLimitRows(),
    listAppliedPortalMidLimitRows(),
  ])
  const portalMids = pending.map(toPendingPortalMidLimit)
  const appliedLimits = appliedRows.map(toAppliedPortalMidLimit)

  return {
    pendingLimits: portalMids,
    appliedLimits,
    csv: portalMids.map((item) => item.portalMid).join(','),
    appliedCsv: appliedLimits.map((item) => item.portalMid).join(','),
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
  while (cursor.getTime() <= end.getTime() && guard < MAX_TREND_DAYS) {
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
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const liveMerchant = and(isNull(merchants.deletedAt))

  const [caseSummaryRows, merchantSummaryRows, dashboardTrendRows] =
    await Promise.all([
    // Case snapshot, range, and SLA metrics in one grouped scan.
    db
      .select({
        status: cases.status,
        count: int(sql`count(*)`),
        newInRange: int(
          sql`count(*) filter (where ${cases.createdAt} >= ${fromIso} and ${cases.createdAt} <= ${toIso})`,
        ),
        closedInRange: int(
          sql`count(*) filter (where ${cases.closedAt} >= ${fromIso} and ${cases.closedAt} <= ${toIso})`,
        ),
        breached: int(sql`count(*) filter (where ${cases.slaBreached} = true)`),
        evaluated: int(
          sql`count(*) filter (where ${cases.slaBreached} is not null)`,
        ),
        openOverSla: int(
          sql`count(*) filter (where ${cases.status} not in ('closed','error') and now() > ${cases.createdAt} + (${queues.slaHours} * interval '1 hour'))`,
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
          sql`count(*) filter (where ${merchants.submittedAt} >= ${fromIso} and ${merchants.submittedAt} <= ${toIso})`,
        ),
        liveInRange: int(
          sql`count(*) filter (where ${merchants.liveAt} >= ${fromIso} and ${merchants.liveAt} <= ${toIso})`,
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
        and ${merchants.submittedAt} >= ${from.toISOString()}
        and ${merchants.submittedAt} < ${addDays(startOfDay(to), 1).toISOString()}
      group by "day"
      union all
      select
        'opened'::text as "metric",
        to_char(${cases.createdAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${cases}
      where ${cases.createdAt} >= ${from.toISOString()}
        and ${cases.createdAt} < ${addDays(startOfDay(to), 1).toISOString()}
      group by "day"
      union all
      select
        'closed'::text as "metric",
        to_char(${cases.closedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${cases}
      where ${cases.closedAt} >= ${from.toISOString()}
        and ${cases.closedAt} < ${addDays(startOfDay(to), 1).toISOString()}
      group by "day"
      union all
      select
        'went_live'::text as "metric",
        to_char(${merchants.liveAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD') as "day",
        count(*)::int as "count"
      from ${merchants}
      where ${merchants.deletedAt} is null
        and ${merchants.liveAt} >= ${from.toISOString()}
        and ${merchants.liveAt} < ${addDays(startOfDay(to), 1).toISOString()}
      group by "day"
    `),

  ])
  const portalMids = await getPendingPortalMidLimits()

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
  const breachRate =
    slaSummary.evaluated > 0
      ? Math.round((slaSummary.breached / slaSummary.evaluated) * 1000) / 10
      : 0

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
  const trendRows = Array.from(dashboardTrendRows) as DashboardTrendRow[]
  const submissionMap = new Map(
    trendRows
      .filter((row) => row.metric === 'submission')
      .map((row) => [row.day, row.count]),
  )
  const newMap = new Map(
    trendRows
      .filter((row) => row.metric === 'opened')
      .map((row) => [row.day, row.count]),
  )
  const closedMap = new Map(
    trendRows
      .filter((row) => row.metric === 'closed')
      .map((row) => [row.day, row.count]),
  )
  const wentLiveMap = new Map(
    trendRows
      .filter((row) => row.metric === 'went_live')
      .map((row) => [row.day, row.count]),
  )

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
      pending: caseStatusMap.get('pending') ?? 0,
      qc: caseStatusMap.get('qc') ?? 0,
      error: caseStatusMap.get('error') ?? 0,
      closed: caseStatusMap.get('closed') ?? 0,
      awaitingClient: caseStatusMap.get('awaiting_client') ?? 0,
      newInRange: caseRange.newInRange,
      closedInRange: caseRange.closedInRange,
      slaBreached: slaSummary.breached,
      slaEvaluated: slaSummary.evaluated,
      openOverSla: slaSummary.openOverSla,
      breachRate,
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
    portalMids,
  }
}
