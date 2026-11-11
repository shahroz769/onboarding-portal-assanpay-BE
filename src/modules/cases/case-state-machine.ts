import { and, eq, inArray, type SQL } from 'drizzle-orm'

import type { DbTransaction, getDb } from '../../db/client'
import { cases, type QueueStage } from '../../db/schema'
import type { CaseStatusValue } from './cases.schemas'

/**
 * The case lifecycle, in one place. Every update of a case's status, stage or
 * owner goes through writeCaseState() with a named event; the database trigger
 * from migration 0101 enforces the same rules for any other writer.
 *
 *   new ──start_work──▶ working ──request_merchant──▶ awaiting_merchant
 *    ▲                   │  ▲                              │
 *    └──return_to_pool───┘  └──release_request / merchant_responded /
 *                                manual_resume─────────────┘
 *   any open status ──close_unsuccessful / merchant_terminated──▶ closed
 *   working, awaiting_merchant ──close_successful──▶ closed
 *   closed is final.
 */
export type CaseEvent =
  /** Owner taken or assigned on a new case. */
  | 'start_work'
  /** Owner assigned or transferred without a status change. */
  | 'change_owner'
  /** Owner removed: the case goes back to the unassigned pool. */
  | 'return_to_pool'
  /** Email, WhatsApp or Agreement sent: wait for the merchant. */
  | 'request_merchant'
  /** The send failed after reserving awaiting_merchant: undo it. */
  | 'release_request'
  /** Merchant resubmitted, or the signed Agreement came back. */
  | 'merchant_responded'
  /** Case owner moved the case back to working (status PATCH). */
  | 'manual_resume'
  /** Advance to the next non-closed stage of the queue. */
  | 'advance_stage'
  | 'close_successful'
  | 'close_unsuccessful'
  /** Bulk unsuccessful close of a terminated merchant's open cases. */
  | 'merchant_terminated'
  /** Point a case with a missing stage at the stage for its status. */
  | 'repair_stage'

type Target = CaseStatusValue | 'unchanged' | 'from_stage'

const OPEN: readonly CaseStatusValue[] = ['new', 'working', 'awaiting_merchant']

export const CASE_TRANSITIONS: Record<
  CaseEvent,
  { from: readonly CaseStatusValue[]; to: Target }
> = {
  start_work: { from: ['new'], to: 'working' },
  change_owner: { from: OPEN, to: 'unchanged' },
  return_to_pool: { from: ['new', 'working'], to: 'new' },
  request_merchant: { from: ['working'], to: 'awaiting_merchant' },
  release_request: { from: ['awaiting_merchant'], to: 'working' },
  merchant_responded: { from: ['awaiting_merchant'], to: 'working' },
  manual_resume: { from: ['awaiting_merchant'], to: 'working' },
  advance_stage: { from: ['working', 'awaiting_merchant'], to: 'from_stage' },
  close_successful: { from: ['working', 'awaiting_merchant'], to: 'closed' },
  close_unsuccessful: { from: OPEN, to: 'closed' },
  merchant_terminated: { from: OPEN, to: 'closed' },
  repair_stage: {
    from: [...OPEN, 'closed'],
    to: 'unchanged',
  },
}

/** Whether a case owner may request this status change directly. */
export function isManualStatusChangeAllowed(
  current: CaseStatusValue,
  next: CaseStatusValue,
) {
  const rule = CASE_TRANSITIONS.manual_resume
  return rule.from.includes(current) && rule.to === next
}

// Stage slugs that name a status of their own. Any other stage takes its
// status from its category; awaiting_merchant shares in_progress with working.
const STATUS_BY_STAGE_SLUG: Record<string, CaseStatusValue> = {
  awaiting_merchant: 'awaiting_merchant',
  'awaiting-merchant': 'awaiting_merchant',
  working: 'working',
}

const STATUS_BY_STAGE_CATEGORY: Record<
  QueueStage['category'],
  CaseStatusValue
> = {
  new: 'new',
  in_progress: 'working',
  closed: 'closed',
}

export function getStatusForStage(
  stage: Pick<QueueStage, 'category' | 'slug'>,
): CaseStatusValue {
  return (
    STATUS_BY_STAGE_SLUG[stage.slug.trim().toLowerCase()] ??
    STATUS_BY_STAGE_CATEGORY[stage.category]
  )
}

/** The state every new case starts in. */
export function initialCaseState(initialStageId: string) {
  return {
    status: 'new' as const,
    currentStageId: initialStageId,
    ownerId: null,
  }
}

type CaseStateFields = {
  status?: CaseStatusValue
  currentStageId?: string | null | SQL
  ownerId?: string | null
  closeOutcome?: 'successful' | 'unsuccessful' | null
  closeReason?: string | null
  closedAt?: Date | null
  slaBreached?: boolean | null | SQL
  updatedAt?: Date
}

type CaseStateExecutor = ReturnType<typeof getDb> | DbTransaction

/**
 * The only writer of case status, stage and owner. Applies `event` to the
 * cases matched by `where`, limited to the statuses the event may leave, so a
 * case already in another state is left alone (callers treat no returned row
 * as a conflict). Fills the target status for events that have one.
 */
export async function writeCaseState(
  db: CaseStateExecutor,
  input: { event: CaseEvent; where: SQL; set: CaseStateFields },
) {
  const rule = CASE_TRANSITIONS[input.event]
  const set: CaseStateFields = { updatedAt: new Date(), ...input.set }
  const predicates = [input.where, inArray(cases.status, [...rule.from])]

  if (rule.to === 'unchanged') {
    // A caller may restate the status; it must already be the current one.
    if (set.status !== undefined) predicates.push(eq(cases.status, set.status))
  } else if (rule.to === 'from_stage') {
    if (set.status === undefined || set.status === 'closed') {
      throw new Error(
        `Case event "${input.event}" needs a non-closed status from its stage.`,
      )
    }
  } else if (set.status === undefined) {
    set.status = rule.to
  } else if (set.status !== rule.to) {
    throw new Error(
      `Case event "${input.event}" cannot set status "${set.status}".`,
    )
  }

  return db
    .update(cases)
    .set(set)
    .where(and(...predicates))
    .returning()
}
