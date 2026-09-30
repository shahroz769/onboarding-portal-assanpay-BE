import { eq, inArray, like } from 'drizzle-orm'

import { closeQueryClient, getDb } from './client'
import {
  agreementCaseDetails,
  caseComments,
  caseFlowCloseJobs,
  caseHistory,
  caseLinks,
  cases,
  merchants,
  portalMidLimitApplications,
  queueCaseSequences,
  queueStages,
  queues,
  userQueueAccess,
  users,
} from './schema'

// Demo data for eyeballing the dashboard and lists. Every merchant gets a
// submitter email on DEMO_EMAIL_DOMAIN, so a re-run wipes the previous demo
// set (cases, links, history, comments cascade) and rebuilds it. Real rows are
// never touched.
const DEMO_EMAIL_DOMAIN = 'demo.assanpay.test'
const MERCHANT_COUNT = 96

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.now()
// Demo submissions span Aug 1 - Sep 30, 2026.
const WINDOW_START = new Date('2026-08-01T00:00:00+05:00').getTime()

type CaseStatus = (typeof cases.$inferInsert)['status'] & string
type Outcome = 'successful' | 'unsuccessful'
type MerchantType = (typeof merchants.$inferInsert)['merchantType']
type MerchantStatus = (typeof merchants.$inferInsert)['status'] & string
type WebsiteCms = (typeof merchants.$inferInsert)['websiteCms']
type KinRelation = (typeof merchants.$inferInsert)['nextOfKinRelation']

interface PlannedCase {
  key: string
  queueSlug: string
  parentKey: string | null
  status: CaseStatus
  outcome: Outcome | null
  createdAt: Date
  closedAt: Date | null
  ownerId: string | null
  ownedAt: Date | null
}

interface PlannedMerchant {
  merchantType: MerchantType
  websiteCms: WebsiteCms
  status: MerchantStatus
  priority: 'normal' | 'high'
  submittedAt: Date
  liveAt: Date | null
  cases: PlannedCase[]
}

// ─── Randomness ─────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20260929)
const between = (min: number, max: number) => min + rand() * (max - min)
const int = (min: number, max: number) => Math.floor(between(min, max + 1))
const pick = <T>(items: readonly T[]) => items[int(0, items.length - 1)] as T
const chance = (p: number) => rand() < p

function weighted<T>(entries: readonly (readonly [T, number])[]) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  let roll = rand() * total
  for (const [value, weight] of entries) {
    roll -= weight
    if (roll <= 0) return value
  }
  return entries[entries.length - 1]![0]
}

// ─── Merchant Content ───────────────────────────────────────────────────────

const BUSINESS_NAMES = [
  'Karachi Thread Works', 'Lahore Leather Co', 'Indus Digital Studio',
  'Zameen Organics', 'Punjab Pixel Labs', 'Sindh Spice Traders',
  'Margalla Outdoor Gear', 'Chenab Textiles', 'Roshan Learning Hub',
  'Bahria Bites Catering', 'Hunza Dry Fruits', 'Mehran Auto Parts',
  'Pak Fitness Club', 'Saffron Home Decor', 'Gulberg Gadgets',
  'Peshawar Carpet House', 'Nayab Jewellers', 'Al Noor Pharmacy',
  'Tez Courier Services', 'Sajawal Solar', 'Kohsar Books',
  'Ravi Cloud Hosting', 'Fresh Basket Grocers', 'Karakoram Travels',
  'Bilal Electronics', 'Clifton Cakes', 'Data Tech Solutions',
  'Falak Fashion House', 'Green Valley Farms', 'Haveli Furniture',
  'Ibtida Charity Trust', 'Jhelum Sports Goods', 'Kashif Mobile Mart',
  'Lakson Learning Academy', 'Mall Road Optics', 'Noor Ul Ain Foundation',
  'Orient Tea Company', 'Pearl Beauty Salon', 'Quetta Kabab House',
  'Rehmat Medical Store', 'Sadaf Stitching Studio', 'Tariq Tyres',
  'Umeed Welfare Society', 'Vertex Software House', 'Wapda Town Bakers',
  'Xpress Print Shop', 'Yaqoob Traders', 'Zaitoon Oil Mills',
  'Afaq Consultancy', 'Bloom Flower Shop', 'Cedar Kids Wear',
  'Daraz Seller Hub', 'Eastern Herbal Care', 'Fajr Islamic Store',
  'Gwadar Seafood', 'Hira Handicrafts',
] as const

const OWNER_NAMES = [
  'Ahmed Raza', 'Sana Malik', 'Bilal Chaudhry', 'Ayesha Siddiqui',
  'Hamza Qureshi', 'Fatima Noor', 'Usman Farooq', 'Zainab Ali',
  'Kamran Akhtar', 'Hina Shah', 'Faisal Mehmood', 'Maryam Iqbal',
  'Talha Javed', 'Nimra Aslam', 'Salman Butt', 'Rabia Anwar',
] as const

const NATURES = [
  'E-commerce', 'Retail', 'Software Services', 'Education', 'Food & Beverage',
  'Healthcare', 'Logistics', 'Textile', 'Travel', 'Non-profit', 'Consulting',
] as const

const BANKS = [
  'HBL', 'Meezan Bank', 'UBL', 'MCB Bank', 'Allied Bank Limited',
  'Bank Alfalah', 'Standard Chartered', 'Faysal Bank', 'Askari Bank',
] as const

const CITIES = [
  'Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan',
  'Peshawar', 'Sialkot', 'Quetta', 'Hyderabad',
] as const

const MERCHANT_TYPES: readonly (readonly [MerchantType, number])[] = [
  ['sole_proprietorship', 5],
  ['private_limited_company', 4],
  ['partnership', 2],
  ['ngo_npo_charity', 2],
  ['public_limited_company', 1],
  ['limited_liability_partnership', 1],
  ['trust_society_association', 1],
]

const KIN: readonly KinRelation[] = [
  'mother', 'father', 'brother', 'sister', 'spouse', 'son', 'daughter',
]

const MERCHANT_TYPE_LABELS: Record<MerchantType, string> = {
  sole_proprietorship: 'Sole Proprietorship',
  private_limited_company: 'Private Limited Company',
  public_limited_company: 'Public Limited Company',
  partnership: 'Partnership',
  limited_liability_partnership: 'Limited Liability Partnership',
  ngo_npo_charity: 'NGO / NPO / Charity',
  trust_society_association: 'Trust / Society / Association',
}

const COMMENTS = [
  'Picked this up, checking the documents now.',
  'Merchant has been reminded on WhatsApp, waiting for a reply.',
  'Bank details look fine, please double check the IBAN once more.',
  'Escalating: this one is close to breaching SLA.',
  'Signed copy is expected by courier tomorrow.',
  'Website still under construction, will retest once it is live.',
  'Called the owner, they will share the updated CNIC today.',
] as const

// ─── Plan ───────────────────────────────────────────────────────────────────

// How far a merchant has travelled through the flow. Deeper merchants were
// submitted earlier, so recent days show intake and older days show closures.
//   Documents Review → Agreement + MID Creation
//   MID Creation     → Testing + WordPress Website → EP Sub-Merchant Form
//   Agreement        → Live
type Depth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const DEPTHS: readonly (readonly [Depth, number])[] = [
  [0, 6], // Documents Review new
  [1, 5], // Documents Review working
  [2, 4], // Documents Review awaiting merchant
  [3, 5], // Agreement + MID Creation just opened
  [4, 6], // agreement sent, MID in progress
  [5, 6], // MID done, Testing + WordPress open
  [6, 6], // almost live
  [7, 26], // live
  [8, 4], // terminated
]

const SUBMITTED_DAYS_AGO: Record<Depth, readonly [number, number]> = {
  0: [0, 2],
  1: [0, 4],
  2: [1, 8],
  3: [3, 20],
  4: [5, 35],
  5: [8, 50],
  6: [10, 58],
  7: [2, 60],
  8: [10, 60],
}

const cap = (ms: number) => Math.min(ms, NOW - 2 * 60 * 1000)

interface OwnerPools {
  bySlug: Map<string, string[]>
  fallback: string[]
}

function planMerchant(depth: Depth, owners: OwnerPools): PlannedMerchant {
  const [minDays, maxDays] = SUBMITTED_DAYS_AGO[depth]
  const submittedMs = Math.max(
    cap(NOW - between(minDays, maxDays) * DAY),
    WINDOW_START,
  )
  const planned: PlannedCase[] = []
  const ownerFor = (slug: string) =>
    pick(owners.bySlug.get(slug) ?? owners.fallback)

  // A case opened at `createdMs`. Open statuses keep `closedAt` null; a case
  // that closes does so 1-40 hours after it opened.
  function addCase(
    slug: string,
    parentKey: string | null,
    createdMs: number,
    state:
      | { status: 'new' | 'working' | 'awaiting_merchant' }
      | { status: 'closed'; outcome: Outcome },
  ) {
    const createdAt = new Date(cap(createdMs))
    const closes = state.status === 'closed'
    const closedMs = closes
      ? cap(createdAt.getTime() + between(1, 40) * HOUR)
      : null
    const ownerId = state.status === 'new' ? null : ownerFor(slug)
    const item: PlannedCase = {
      key: slug,
      queueSlug: slug,
      parentKey,
      status: state.status,
      outcome: state.status === 'closed' ? state.outcome : null,
      createdAt,
      closedAt: closedMs === null ? null : new Date(closedMs),
      ownerId,
      ownedAt: ownerId
        ? new Date(cap(createdAt.getTime() + between(5, 90) * 60 * 1000))
        : null,
    }
    planned.push(item)
    return item
  }

  const closedMs = (item: PlannedCase) => (item.closedAt as Date).getTime()
  const openStatus = (p: readonly (readonly [CaseStatus, number])[]) =>
    weighted(p) as 'new' | 'working' | 'awaiting_merchant'

  const dr = addCase(
    'documents-review',
    null,
    submittedMs + between(0.1, 2) * HOUR,
    depth === 0
      ? { status: 'new' }
      : depth === 1
        ? { status: 'working' }
        : depth === 2
          ? { status: 'awaiting_merchant' }
          : depth === 8 && chance(0.4)
            ? { status: 'closed', outcome: 'unsuccessful' }
            : { status: 'closed', outcome: 'successful' },
  )

  if (depth >= 3) {
    const flowStart = closedMs(dr)
    const unsuccessfulReview = dr.outcome === 'unsuccessful'

    if (!unsuccessfulReview) {
      const agState: Parameters<typeof addCase>[3] =
        depth === 3
          ? { status: openStatus([['new', 3], ['working', 1]]) }
          : depth === 4 || depth === 5
            ? { status: 'awaiting_merchant' }
            : depth === 8
              ? { status: 'closed', outcome: 'unsuccessful' }
              : { status: 'closed', outcome: 'successful' }
      const ag = addCase('agreement', 'documents-review', flowStart, agState)

      const miState: Parameters<typeof addCase>[3] =
        depth === 3
          ? { status: openStatus([['new', 3], ['working', 2]]) }
          : depth === 4
            ? { status: 'working' }
            : depth === 8
              ? { status: 'closed', outcome: 'unsuccessful' }
              : { status: 'closed', outcome: 'successful' }
      const mi = addCase('merchant-id', 'documents-review', flowStart, miState)

      if (depth >= 5 && depth <= 7) {
        const midDone = closedMs(mi)
        const tsState: Parameters<typeof addCase>[3] =
          depth === 5
            ? { status: openStatus([['new', 2], ['working', 3]]) }
            : { status: 'closed', outcome: 'successful' }
        addCase('testing', 'merchant-id', midDone, tsState)

        const wpState: Parameters<typeof addCase>[3] =
          depth === 5
            ? { status: openStatus([['new', 3], ['working', 2]]) }
            : { status: 'closed', outcome: 'successful' }
        const wp = addCase('wordpress-website', 'merchant-id', midDone, wpState)

        if (depth >= 6) {
          const smState: Parameters<typeof addCase>[3] =
            depth === 6
              ? { status: openStatus([['new', 3], ['working', 2]]) }
              : { status: 'closed', outcome: 'successful' }
          addCase('sub-merchant-form', 'wordpress-website', closedMs(wp), smState)

          const lvState: Parameters<typeof addCase>[3] =
            depth === 6
              ? { status: openStatus([['new', 3], ['working', 2]]) }
              : { status: 'closed', outcome: 'successful' }
          addCase('live', 'agreement', closedMs(ag), lvState)
        }
      }
    }
  }

  const live = planned.find(
    (item) => item.queueSlug === 'live' && item.outcome === 'successful',
  )
  const testingOpen = planned.some(
    (item) => item.queueSlug === 'testing' || item.queueSlug === 'live',
  )
  const status: MerchantStatus =
    depth === 8
      ? 'terminated'
      : live
        ? 'live'
        : testingOpen
          ? 'testing'
          : 'pending'

  return {
    merchantType: weighted(MERCHANT_TYPES),
    websiteCms: weighted([
      ['wordpress', 4],
      ['shopify', 3],
      ['custom_website', 3],
    ] as const),
    status,
    priority: chance(0.14) ? 'high' : 'normal',
    submittedAt: new Date(submittedMs),
    liveAt: live?.closedAt ?? null,
    cases: planned,
  }
}

// ─── Row Builders ───────────────────────────────────────────────────────────

function digits(length: number) {
  return Array.from({ length }, () => int(0, 9)).join('')
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function toDateString(date: Date) {
  return date.toISOString().slice(0, 10)
}

function merchantRow(index: number, plan: PlannedMerchant) {
  const businessName = BUSINESS_NAMES[index % BUSINESS_NAMES.length]!
  const owner = pick(OWNER_NAMES)
  const slug = slugify(businessName)
  const phone = `03${int(0, 4)}${digits(8)}`
  const city = pick(CITIES)
  const volume = pick([250_000, 750_000, 1_500_000, 4_000_000, 12_000_000])

  return {
    submitterEmail: `${slug}.${index}@${DEMO_EMAIL_DOMAIN}`,
    ownerFullName: owner,
    ownerPhone: phone,
    activeWhatsappNumber: phone,
    businessName,
    businessPhone: `03${int(0, 4)}${digits(8)}`,
    businessEmail: `info@${slug}.example.pk`,
    businessAddress: `${int(1, 250)}-${pick(['A', 'B', 'C'])}, Main Boulevard, ${city}`,
    businessWebsite: `https://www.${slug}.example.pk`,
    websiteCms: plan.websiteCms,
    businessDescription: `${businessName} sells and delivers across Pakistan.`,
    businessRegistrationDate: toDateString(
      new Date(NOW - int(200, 2500) * DAY),
    ),
    businessNature: pick(NATURES),
    merchantType: plan.merchantType,
    estimatedMonthlyTransactions: Math.round(volume / int(2000, 9000)),
    estimatedMonthlyVolume: volume.toFixed(2),
    accountTitle: businessName,
    bankName: pick(BANKS),
    branchName: `${city} Main Branch`,
    accountNumberIban: `PK${int(10, 99)}${pick(['HABB', 'MEZN', 'UNIL', 'MUCB'])}${digits(16)}`,
    swiftCode: null,
    nextOfKinRelation: pick(KIN),
    status: plan.status,
    priority: plan.priority,
    priorityNote:
      plan.priority === 'high'
        ? pick([
            'Large retailer, wants to launch before Eid.',
            'Referred by sales, please expedite.',
            'Seasonal campaign starts next week.',
          ])
        : null,
    businessScope: chance(0.12) ? ('international' as const) : ('local' as const),
    liveAt: plan.liveAt,
    submittedAt: plan.submittedAt,
    createdAt: plan.submittedAt,
    updatedAt: plan.liveAt ?? plan.submittedAt,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const db = getDb()

  const [queueRows, stageRows, userRows, accessRows] = await Promise.all([
    db.select().from(queues),
    db.select().from(queueStages),
    db.select().from(users).where(eq(users.status, 'active')),
    db
      .select()
      .from(userQueueAccess)
      .where(eq(userQueueAccess.accessType, 'work')),
  ])

  const queueBySlug = new Map(queueRows.map((queue) => [queue.slug, queue]))
  const stageId = (queueId: string, slug: string) =>
    stageRows.find((stage) => stage.queueId === queueId && stage.slug === slug)
      ?.id ?? null

  const admins = userRows
    .filter((user) => user.roleType !== 'agent')
    .map((user) => user.id)
  if (admins.length === 0) {
    throw new Error('No active admin users; cannot assign case owners.')
  }

  const owners: OwnerPools = { bySlug: new Map(), fallback: admins }
  for (const queue of queueRows) {
    const agents = accessRows
      .filter((row) => row.queueId === queue.id)
      .map((row) => row.userId)
      .filter((id) => userRows.some((user) => user.id === id))
    owners.bySlug.set(queue.slug, [...agents, ...admins])
  }
  const userName = new Map(userRows.map((user) => [user.id, user.name]))

  for (const slug of [
    'documents-review',
    'agreement',
    'merchant-id',
    'testing',
    'wordpress-website',
    'sub-merchant-form',
    'live',
  ]) {
    if (!queueBySlug.has(slug)) throw new Error(`Queue "${slug}" is missing.`)
  }

  const plans = Array.from({ length: MERCHANT_COUNT }, () =>
    planMerchant(weighted(DEPTHS), owners),
  ).sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime())

  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(merchants)
      .where(like(merchants.submitterEmail, `%@${DEMO_EMAIL_DOMAIN}`))
      .returning({ id: merchants.id })

    // Case numbers come from per-queue counters; reserve a block per queue.
    const sequences = new Map<string, number>()
    const sequenceRows = await tx
      .select()
      .from(queueCaseSequences)
      .for('update')
    for (const row of sequenceRows) sequences.set(row.queueId, row.lastNumber)

    const insertedMerchants = await tx
      .insert(merchants)
      .values(plans.map((plan, index) => merchantRow(index, plan)))
      .returning({
        id: merchants.id,
        businessName: merchants.businessName,
        submitterEmail: merchants.submitterEmail,
        businessEmail: merchants.businessEmail,
        websiteCms: merchants.websiteCms,
        merchantType: merchants.merchantType,
      })

    const caseValues: (typeof cases.$inferInsert)[] = []
    const seeded: {
      merchantIndex: number
      plan: PlannedCase
      caseId: string
      caseNumber: string
      queueId: string
    }[] = []

    plans.forEach((plan, merchantIndex) => {
      const merchant = insertedMerchants[merchantIndex]!
      for (const item of plan.cases) {
        const queue = queueBySlug.get(item.queueSlug)!
        const next = (sequences.get(queue.id) ?? 0) + 1
        sequences.set(queue.id, next)
        const caseId = crypto.randomUUID()
        const caseNumber = `${queue.prefix}-${String(next).padStart(9, '0')}`
        const closed = item.status === 'closed'

        caseValues.push({
          id: caseId,
          caseNumber,
          queueId: queue.id,
          merchantId: merchant.id,
          ownerId: item.ownerId,
          currentStageId: stageId(
            queue.id,
            item.status === 'awaiting_merchant' &&
              !stageId(queue.id, 'awaiting_merchant')
              ? 'working'
              : item.status,
          ),
          status: item.status,
          priority: plan.priority,
          closeOutcome: item.outcome,
          slaBreached: closed
            ? (item.closedAt!.getTime() - item.createdAt.getTime()) / HOUR >
              queue.slaHours
            : null,
          closeReason:
            item.outcome === 'unsuccessful'
              ? pick([
                  'Merchant failed compliance review.',
                  'Merchant unresponsive after multiple follow-ups.',
                  'Business category not supported.',
                ])
              : null,
          closedAt: item.closedAt,
          createdAt: item.createdAt,
          updatedAt: item.closedAt ?? item.ownedAt ?? item.createdAt,
        })
        seeded.push({
          merchantIndex,
          plan: item,
          caseId,
          caseNumber,
          queueId: queue.id,
        })
      }
    })

    const insertChunks = async <T>(
      insert: (chunk: T[]) => Promise<unknown>,
      values: T[],
    ) => {
      for (let offset = 0; offset < values.length; offset += 200) {
        await insert(values.slice(offset, offset + 200))
      }
    }

    await insertChunks((chunk) => tx.insert(cases).values(chunk), caseValues)

    for (const [queueId, lastNumber] of sequences) {
      await tx
        .insert(queueCaseSequences)
        .values({ queueId, lastNumber })
        .onConflictDoUpdate({
          target: queueCaseSequences.queueId,
          set: { lastNumber },
        })
    }

    // Closing a case successfully enqueues follow-up jobs that would spawn
    // real cases; the demo chains are already planned, so drop those jobs.
    await insertChunks(
      (chunk) =>
        tx.delete(caseFlowCloseJobs).where(
          inArray(
            caseFlowCloseJobs.sourceCaseId,
            chunk.map((row) => row.caseId),
          ),
        ),
      seeded,
    )

    // ─── History, links, agreements, MIDs, comments ───────────────────────

    const byMerchantSlug = new Map(
      seeded.map((row) => [`${row.merchantIndex}:${row.plan.queueSlug}`, row]),
    )
    const queueName = (queueId: string) =>
      queueRows.find((queue) => queue.id === queueId)?.name ?? ''
    const stamp = (ms: number) => new Date(cap(ms))

    const historyValues: (typeof caseHistory.$inferInsert)[] = []
    const linkValues: (typeof caseLinks.$inferInsert)[] = []
    const agreementValues: (typeof agreementCaseDetails.$inferInsert)[] = []
    const commentValues: (typeof caseComments.$inferInsert)[] = []
    const applicationValues: (typeof portalMidLimitApplications.$inferInsert)[] =
      []
    let nextPortalMid = 2000
    let nextInternalMid = 90000

    for (const row of seeded) {
      const { plan: item, merchantIndex, caseId } = row
      const merchant = insertedMerchants[merchantIndex]!
      const parent = item.parentKey
        ? byMerchantSlug.get(`${merchantIndex}:${item.parentKey}`)
        : undefined

      historyValues.push({
        caseId,
        action: parent
          ? 'case_created_from_flow_close'
          : 'case_created_from_flow_start',
        details: {
          merchantName: merchant.businessName,
          parentCaseId: parent?.caseId ?? null,
          sourceQueueId: parent?.queueId ?? null,
          targetQueueId: row.queueId,
          sourceQueueName: parent ? queueName(parent.queueId) : null,
          targetQueueName: queueName(row.queueId),
          sourceCaseNumber: parent?.caseNumber ?? null,
        },
        createdAt: item.createdAt,
      })

      linkValues.push({
        parentCaseId: parent?.caseId ?? null,
        childCaseId: caseId,
        merchantId: merchant.id,
        triggerType: parent ? 'case_close' : 'form_submission',
        sourceQueueId: parent?.queueId ?? null,
        targetQueueId: row.queueId,
        createdAt: item.createdAt,
      })

      if (item.ownerId && item.ownedAt) {
        historyValues.push({
          caseId,
          actorId: item.ownerId,
          action: 'ownership_taken',
          details: {
            toOwner: userName.get(item.ownerId) ?? 'Unknown',
            toStage: 'Working',
            fromOwner: 'Unassigned',
            fromStage: 'New',
          },
          createdAt: item.ownedAt,
        })
      }

      if (item.status === 'awaiting_merchant' && item.ownedAt) {
        historyValues.push({
          caseId,
          actorId: item.ownerId,
          action: 'status_updated',
          details: { fromStatus: 'working', toStatus: 'awaiting_merchant' },
          createdAt: stamp(item.ownedAt.getTime() + between(1, 6) * HOUR),
        })
      }

      if (item.closedAt && item.outcome) {
        historyValues.push({
          caseId,
          actorId: item.ownerId,
          action: `closed_${item.outcome}`,
          details:
            item.outcome === 'unsuccessful'
              ? { reason: 'Closed as unsuccessful' }
              : { fromStage: 'Working', toStage: 'Closed' },
          createdAt: item.closedAt,
        })
      }

      if (item.queueSlug === 'merchant-id' && item.outcome === 'successful') {
        const portalMid = nextPortalMid++
        const internalPortalMid = nextInternalMid++
        const closedMs = item.closedAt!.getTime()
        historyValues.push({
          caseId,
          actorId: item.ownerId,
          action: 'mid_creation_saved',
          details: {
            email: merchant.businessEmail,
            portalMid,
            internalPortalMid,
            merchantRole: 'merchant_admin',
          },
          createdAt: new Date(closedMs - 2 * 60 * 1000),
        })

        // Some MIDs already have limits applied; the rest show as pending.
        const applied = weighted([
          ['both', 6],
          ['portal', 1],
          ['none', 4],
        ] as const)
        const category =
          merchant.websiteCms === 'shopify' ? 'shopify' : 'custom_wordpress'
        const appliedAt = stamp(closedMs + between(2, 30) * HOUR)
        if (applied !== 'none') {
          applicationValues.push({
            portalMid,
            category,
            merchantId: merchant.id,
            appliedBy: pick(admins),
            appliedAt,
          })
        }
        if (applied === 'both') {
          applicationValues.push({
            portalMid: internalPortalMid,
            category: 'internal',
            merchantId: merchant.id,
            appliedBy: pick(admins),
            appliedAt,
          })
        }
      }

      if (item.queueSlug === 'agreement') {
        const sent =
          item.status === 'awaiting_merchant' || item.status === 'closed'
        const anchor = (item.ownedAt ?? item.createdAt).getTime()
        agreementValues.push({
          caseId,
          businessType: merchant.merchantType,
          draftKey: merchant.merchantType,
          draftLabel: MERCHANT_TYPE_LABELS[merchant.merchantType],
          draftUrl: 'https://example.com/demo-agreement-draft',
          emailStatus: sent ? 'sent' : 'not_sent',
          emailRecipient: sent ? merchant.submitterEmail : null,
          emailSentAt: sent ? stamp(anchor + between(1, 4) * HOUR) : null,
          createdAt: item.createdAt,
          updatedAt: item.closedAt ?? item.ownedAt ?? item.createdAt,
        })
      }

      if (item.ownerId && item.ownedAt && chance(0.3)) {
        const latest = item.closedAt?.getTime() ?? NOW
        const owned = item.ownedAt.getTime()
        commentValues.push({
          caseId,
          authorId: item.ownerId,
          content: pick(COMMENTS),
          createdAt: stamp(owned + between(0.1, 0.9) * (latest - owned)),
          updatedAt: item.ownedAt,
        })
      }
    }

    await insertChunks(
      (chunk) => tx.insert(caseHistory).values(chunk),
      historyValues,
    )
    await insertChunks((chunk) => tx.insert(caseLinks).values(chunk), linkValues)
    await insertChunks(
      (chunk) => tx.insert(agreementCaseDetails).values(chunk),
      agreementValues,
    )
    await insertChunks(
      (chunk) => tx.insert(caseComments).values(chunk),
      commentValues,
    )
    await insertChunks(
      (chunk) => tx.insert(portalMidLimitApplications).values(chunk),
      applicationValues,
    )

    console.log(
      `Removed ${removed.length} previous demo merchants. Seeded ${insertedMerchants.length} merchants, ${seeded.length} cases, ${applicationValues.length} applied MIDs.`,
    )
  })
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => closeQueryClient())
