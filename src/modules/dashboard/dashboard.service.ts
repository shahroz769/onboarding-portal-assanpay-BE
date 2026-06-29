import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseHistory,
  cases,
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

const RISK_LIST_LIMIT = 8
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
}

function normalizePortalMids(portalMids: number[]) {
  return Array.from(new Set(portalMids)).sort((a, b) => a - b)
}

function toPendingPortalMidLimit(row: PendingPortalMidLimitRow) {
  return {
    merchantId: row.merchantId,
    merchantName: row.merchantName,
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
    )
    , candidate_mid as (
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
    )
    select
      latest_mid."merchantId",
      latest_mid."merchantName",
      latest_mid."caseId",
      latest_mid."caseNumber",
      candidate_mid."portalMid",
      candidate_mid."midKind" as "midKind",
      latest_mid."savedAt"
    from candidate_mid
    inner join latest_mid
      on latest_mid."caseId" = candidate_mid."caseId"
    left join ${portalMidLimitApplications}
      on ${portalMidLimitApplications.portalMid} = candidate_mid."portalMid"
    where ${portalMidLimitApplications.portalMid} is null
      ${portalMidFilter}
    order by "portalMid" asc
  `)

  return Array.from(rows) as PendingPortalMidLimitRow[]
}

async function listAppliedPortalMidLimitRows(): Promise<
  AppliedPortalMidLimitRow[]
> {
  const db = getDb()
  const rows = await db
    .select({
      portalMid: portalMidLimitApplications.portalMid,
      merchantId: portalMidLimitApplications.merchantId,
      appliedByName: users.name,
      appliedAt: portalMidLimitApplications.appliedAt,
    })
    .from(portalMidLimitApplications)
    .leftJoin(users, eq(portalMidLimitApplications.appliedBy, users.id))
    .orderBy(asc(portalMidLimitApplications.portalMid))

  return rows
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

  if (candidates.length > 0) {
    await db
      .insert(portalMidLimitApplications)
      .values(
        candidates.map((portalMid) => ({
          portalMid,
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

  const now = new Date()
  const startToday = startOfDay(now)
  const startWeek = startOfDay(addDays(now, -6))
  const startMonth = startOfMonth(now)

  // ISO strings for raw `sql` interpolation. postgres-js cannot bind raw Date
  // objects passed as template params, so timestamps must be serialized first.
  const fromIso = from.toISOString()
  const toIso = to.toISOString()
  const startTodayIso = startToday.toISOString()
  const startWeekIso = startWeek.toISOString()
  const startMonthIso = startMonth.toISOString()

  const liveMerchant = and(isNull(merchants.deletedAt))

  const [
    caseStatusRows,
    caseRangeRow,
    caseSlaRow,
    merchantStatusRows,
    merchantRangeRow,
    submissionWindowRow,
    queueRows,
    submissionTrendRows,
    openedTrendRows,
    closedTrendRows,
    slaBreachedCases,
    awaitingClientCases,
    oldestOpenCases,
    highPriorityOpenCases,
    recentMerchants,
    recentClosedCases,
    portalMids,
  ] = await Promise.all([
    // Case counts by status (snapshot)
    db
      .select({
        status: cases.status,
        count: int(sql`count(*)`),
      })
      .from(cases)
      .groupBy(cases.status),

    // Case range metrics
    db
      .select({
        newInRange: int(
          sql`count(*) filter (where ${cases.createdAt} >= ${fromIso} and ${cases.createdAt} <= ${toIso})`,
        ),
        closedInRange: int(
          sql`count(*) filter (where ${cases.closedAt} >= ${fromIso} and ${cases.closedAt} <= ${toIso})`,
        ),
      })
      .from(cases),

    // SLA breach summary + live open-over-sla
    db
      .select({
        breached: int(sql`count(*) filter (where ${cases.slaBreached} = true)`),
        evaluated: int(
          sql`count(*) filter (where ${cases.slaBreached} is not null)`,
        ),
        openOverSla: int(
          sql`count(*) filter (where ${cases.status} not in ('closed','error') and now() > ${cases.createdAt} + (${queues.slaHours} * interval '1 hour'))`,
        ),
      })
      .from(cases)
      .innerJoin(queues, eq(cases.queueId, queues.id)),

    // Merchant counts by status
    db
      .select({
        status: merchants.status,
        count: int(sql`count(*)`),
      })
      .from(merchants)
      .where(liveMerchant)
      .groupBy(merchants.status),

    // Merchant range metrics
    db
      .select({
        submittedInRange: int(
          sql`count(*) filter (where ${merchants.submittedAt} >= ${fromIso} and ${merchants.submittedAt} <= ${toIso})`,
        ),
        liveInRange: int(
          sql`count(*) filter (where ${merchants.liveAt} >= ${fromIso} and ${merchants.liveAt} <= ${toIso})`,
        ),
      })
      .from(merchants)
      .where(liveMerchant),

    // Submission windows (today / week / month) — independent of selected range
    db
      .select({
        today: int(
          sql`count(*) filter (where ${merchants.submittedAt} >= ${startTodayIso})`,
        ),
        thisWeek: int(
          sql`count(*) filter (where ${merchants.submittedAt} >= ${startWeekIso})`,
        ),
        thisMonth: int(
          sql`count(*) filter (where ${merchants.submittedAt} >= ${startMonthIso})`,
        ),
      })
      .from(merchants)
      .where(liveMerchant),

    // Per-queue workload
    db
      .select({
        id: queues.id,
        name: queues.name,
        slug: queues.slug,
        slaHours: queues.slaHours,
        isActive: queues.isActive,
        total: int(sql`count(${cases.id})`),
        open: int(
          sql`count(${cases.id}) filter (where ${cases.status} not in ('closed','error'))`,
        ),
        new: int(
          sql`count(${cases.id}) filter (where ${cases.status} = 'new')`,
        ),
        working: int(
          sql`count(${cases.id}) filter (where ${cases.status} = 'working')`,
        ),
        pending: int(
          sql`count(${cases.id}) filter (where ${cases.status} in ('pending','qc','awaiting_client'))`,
        ),
        closed: int(
          sql`count(${cases.id}) filter (where ${cases.status} = 'closed')`,
        ),
        breached: int(
          sql`count(${cases.id}) filter (where ${cases.slaBreached} = true)`,
        ),
        atRisk: int(
          sql`count(${cases.id}) filter (where ${cases.status} not in ('closed','error') and now() > ${cases.createdAt} + (${queues.slaHours} * interval '1 hour'))`,
        ),
      })
      .from(queues)
      .leftJoin(cases, eq(cases.queueId, queues.id))
      .where(eq(queues.isActive, true))
      .groupBy(
        queues.id,
        queues.name,
        queues.slug,
        queues.slaHours,
        queues.isActive,
      )
      .orderBy(queues.name),

    // Submission trend (daily)
    db
      .select({
        day: sql<string>`to_char(${merchants.submittedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD')`,
        count: int(sql`count(*)`),
      })
      .from(merchants)
      .where(
        and(
          liveMerchant,
          gte(merchants.submittedAt, from),
          lt(merchants.submittedAt, addDays(startOfDay(to), 1)),
        ),
      )
      .groupBy(
        sql`to_char(${merchants.submittedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD')`,
      ),

    // New cases trend (daily)
    db
      .select({
        day: sql<string>`to_char(${cases.createdAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD')`,
        count: int(sql`count(*)`),
      })
      .from(cases)
      .where(
        and(
          gte(cases.createdAt, from),
          lt(cases.createdAt, addDays(startOfDay(to), 1)),
        ),
      )
      .groupBy(
        sql`to_char(${cases.createdAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD')`,
      ),

    // Cases closed trend (daily)
    db
      .select({
        day: sql<string>`to_char(${cases.closedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD')`,
        count: int(sql`count(*)`),
      })
      .from(cases)
      .where(
        and(
          gte(cases.closedAt, from),
          lt(cases.closedAt, addDays(startOfDay(to), 1)),
        ),
      )
      .groupBy(
        sql`to_char(${cases.closedAt} at time zone ${DASHBOARD_TIME_ZONE}, 'YYYY-MM-DD')`,
      ),

    // Risk list — SLA breached cases (most recent)
    db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        merchantName: merchants.businessName,
        queueName: queues.name,
        status: cases.status,
        priority: cases.priority,
        ownerName: users.name,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(eq(cases.slaBreached, true))
      .orderBy(desc(cases.updatedAt))
      .limit(RISK_LIST_LIMIT),

    // Risk list — awaiting client response
    db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        merchantName: merchants.businessName,
        queueName: queues.name,
        status: cases.status,
        priority: cases.priority,
        ownerName: users.name,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(eq(cases.status, 'awaiting_client'))
      .orderBy(asc(cases.updatedAt))
      .limit(RISK_LIST_LIMIT),

    // Risk list — oldest open cases
    db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        merchantName: merchants.businessName,
        queueName: queues.name,
        status: cases.status,
        priority: cases.priority,
        ownerName: users.name,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(sql`${cases.status} not in ('closed','error')`)
      .orderBy(asc(cases.createdAt))
      .limit(RISK_LIST_LIMIT),

    // Risk list — high priority open cases
    db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        merchantName: merchants.businessName,
        queueName: queues.name,
        status: cases.status,
        priority: cases.priority,
        ownerName: users.name,
        createdAt: cases.createdAt,
      })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(
        and(
          eq(cases.priority, 'high'),
          sql`${cases.status} not in ('closed','error')`,
        ),
      )
      .orderBy(asc(cases.createdAt))
      .limit(RISK_LIST_LIMIT),

    // Recent submitted merchants
    db
      .select({
        id: merchants.id,
        merchantNumber: merchants.merchantNumber,
        businessName: merchants.businessName,
        status: merchants.status,
        priority: merchants.priority,
        submittedAt: merchants.submittedAt,
      })
      .from(merchants)
      .where(liveMerchant)
      .orderBy(desc(merchants.submittedAt))
      .limit(RISK_LIST_LIMIT),

    // Recently closed cases
    db
      .select({
        id: cases.id,
        caseNumber: cases.caseNumber,
        merchantName: merchants.businessName,
        queueName: queues.name,
        closeOutcome: cases.closeOutcome,
        slaBreached: cases.slaBreached,
        ownerName: users.name,
        closedAt: cases.closedAt,
      })
      .from(cases)
      .innerJoin(merchants, eq(cases.merchantId, merchants.id))
      .innerJoin(queues, eq(cases.queueId, queues.id))
      .leftJoin(users, eq(cases.ownerId, users.id))
      .where(sql`${cases.closedAt} is not null`)
      .orderBy(desc(cases.closedAt))
      .limit(RISK_LIST_LIMIT),

    getPendingPortalMidLimits(),
  ])

  // ─── Shape Case Status Counts ─────────────────────────────────────────────

  const caseStatusMap = new Map(
    caseStatusRows.map((row) => [row.status, row.count]),
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

  const slaSummary = caseSlaRow[0] ?? {
    breached: 0,
    evaluated: 0,
    openOverSla: 0,
  }
  const caseRange = caseRangeRow[0] ?? { newInRange: 0, closedInRange: 0 }
  const breachRate =
    slaSummary.evaluated > 0
      ? Math.round((slaSummary.breached / slaSummary.evaluated) * 1000) / 10
      : 0

  // ─── Shape Merchant Counts ────────────────────────────────────────────────

  const merchantStatusMap = new Map(
    merchantStatusRows.map((row) => [row.status, row.count]),
  )
  const merchantFunnel = MERCHANT_STATUSES.map((status) => ({
    status,
    count: merchantStatusMap.get(status) ?? 0,
  }))
  const totalMerchants = merchantFunnel.reduce(
    (sum, item) => sum + item.count,
    0,
  )
  const merchantRange = merchantRangeRow[0] ?? {
    submittedInRange: 0,
    liveInRange: 0,
  }
  const submissionWindows = submissionWindowRow[0] ?? {
    today: 0,
    thisWeek: 0,
    thisMonth: 0,
  }

  // ─── Shape Trends ─────────────────────────────────────────────────────────

  const series = buildDateSeries(from, to)
  const submissionMap = new Map(
    submissionTrendRows.map((row) => [row.day, row.count]),
  )
  const newMap = new Map(openedTrendRows.map((row) => [row.day, row.count]))
  const closedMap = new Map(closedTrendRows.map((row) => [row.day, row.count]))

  const submissionsTrend = series.map((day) => ({
    date: day,
    count: submissionMap.get(day) ?? 0,
  }))
  const caseFlowTrend = series.map((day) => ({
    date: day,
    new: newMap.get(day) ?? 0,
    closed: closedMap.get(day) ?? 0,
  }))

  // ─── Shape Queues ─────────────────────────────────────────────────────────

  const queueWorkload = queueRows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    slaHours: row.slaHours,
    total: row.total,
    open: row.open,
    new: row.new,
    working: row.working,
    pending: row.pending,
    closed: row.closed,
    breached: row.breached,
    atRisk: row.atRisk,
    breachRate:
      row.closed > 0 ? Math.round((row.breached / row.closed) * 1000) / 10 : 0,
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
      submissions: submissionWindows,
      funnel: merchantFunnel,
    },
    queues: queueWorkload,
    trends: {
      submissions: submissionsTrend,
      caseFlow: caseFlowTrend,
    },
    risk: {
      slaBreachedCases: slaBreachedCases.map(serializeRiskCase),
      awaitingClientCases: awaitingClientCases.map(serializeRiskCase),
      oldestOpenCases: oldestOpenCases.map(serializeRiskCase),
      highPriorityOpenCases: highPriorityOpenCases.map(serializeRiskCase),
      recentMerchants: recentMerchants.map((row) => ({
        id: row.id,
        merchantNumber: row.merchantNumber,
        businessName: row.businessName,
        status: row.status,
        priority: row.priority,
        submittedAt: row.submittedAt.toISOString(),
      })),
      recentClosedCases: recentClosedCases.map((row) => ({
        id: row.id,
        caseNumber: row.caseNumber,
        merchantName: row.merchantName,
        queueName: row.queueName,
        closeOutcome: row.closeOutcome,
        slaBreached: row.slaBreached,
        ownerName: row.ownerName,
        closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      })),
    },
    portalMids,
  }
}

type RiskCaseRow = {
  id: string
  caseNumber: string
  merchantName: string
  queueName: string
  status: string
  priority: string
  ownerName: string | null
  createdAt: Date
}

function serializeRiskCase(row: RiskCaseRow) {
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    merchantName: row.merchantName,
    queueName: row.queueName,
    status: row.status,
    priority: row.priority,
    ownerName: row.ownerName,
    createdAt: row.createdAt.toISOString(),
  }
}
