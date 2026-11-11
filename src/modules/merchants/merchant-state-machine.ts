import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm'

import type { DbTransaction, getDb } from '../../db/client'
import { merchants, type merchantStatusEnum } from '../../db/schema'
import { AppError } from '../../lib/errors'

/**
 * The merchant lifecycle, in one place. Every update of a merchant's status,
 * soft delete or Drive-files flag goes through writeMerchantState() with a
 * named event; the triggers from migration 0103 enforce the same rules for
 * any other writer.
 *
 *   pending ──testing_completed──▶ testing ──went_live──▶ live
 *   pending, testing, live ──terminated──▶ terminated
 *   terminated ──soft_deleted / drive_files_deleted──▶ terminated
 *
 * A merchant only moves forward. It goes live only from testing, so only
 * after its Testing case closed. Terminated is final, and a terminated
 * merchant gets no new cases.
 */
export type MerchantStatusValue = (typeof merchantStatusEnum.enumValues)[number]

export type MerchantEvent =
  /** A testing-queue case closed successfully. */
  | 'testing_completed'
  /** A live-queue case closed successfully. */
  | 'went_live'
  /** Single or bulk termination; its open cases close as unsuccessful. */
  | 'terminated'
  /** Hidden from lists; only a terminated merchant. */
  | 'soft_deleted'
  /** Google Drive files removed after termination. */
  | 'drive_files_deleted'

export const MERCHANT_TRANSITIONS: Record<
  MerchantEvent,
  {
    from: readonly MerchantStatusValue[]
    to: MerchantStatusValue | 'unchanged'
    /** Also applies to a soft-deleted merchant. */
    includeDeleted?: boolean
  }
> = {
  // A live merchant stays live: closing another Testing case never moves it
  // back.
  testing_completed: { from: ['pending', 'testing'], to: 'testing' },
  went_live: { from: ['testing'], to: 'live' },
  terminated: { from: ['pending', 'testing', 'live'], to: 'terminated' },
  soft_deleted: { from: ['terminated'], to: 'unchanged' },
  // Files are already gone by the time this is written, so record it even if
  // the merchant was soft-deleted meanwhile.
  drive_files_deleted: {
    from: ['terminated'],
    to: 'unchanged',
    includeDeleted: true,
  },
}

/** The state every new merchant starts in. */
export const initialMerchantState = { status: 'pending' as const }

export const LIVE_WITHOUT_TESTING_MESSAGE =
  'Close the Testing case before taking this merchant live.'

export const TERMINATED_MERCHANT_CASE_MESSAGE =
  'This merchant is terminated. New cases cannot be opened for it.'

/** Whether new cases may be opened for this merchant. */
export function canMerchantOpenCases(merchant: {
  status: MerchantStatusValue
  deletedAt: Date | null
}) {
  return merchant.status !== 'terminated' && merchant.deletedAt === null
}

/**
 * Loads the merchant a new case is for and holds a share lock until the
 * transaction ends. Termination updates the same row, so it either waits for
 * this case to commit (and then closes it) or commits first (and this throws).
 */
export async function lockMerchantForNewCase(
  tx: DbTransaction,
  merchantId: string,
) {
  const [merchant] = await tx
    .select({
      id: merchants.id,
      businessName: merchants.businessName,
      priority: merchants.priority,
      flowVersionId: merchants.flowVersionId,
      status: merchants.status,
      deletedAt: merchants.deletedAt,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1)
    .for('share')

  if (!merchant) {
    throw new AppError(404, 'Merchant not found.')
  }
  if (!canMerchantOpenCases(merchant)) {
    throw new AppError(409, TERMINATED_MERCHANT_CASE_MESSAGE)
  }
  return merchant
}

type MerchantStateFields = {
  liveAt?: Date
  deletedAt?: Date
  driveFilesDeletedAt?: Date
  driveFilesDeletedBy?: string | null
  updatedAt?: Date
}

type MerchantStateExecutor = ReturnType<typeof getDb> | DbTransaction

/**
 * The only writer of merchant status, deletedAt and the Drive-files flag.
 * Applies `event` to the merchants matched by `where`, limited to the statuses
 * the event may leave (and to merchants that are not soft-deleted), so a
 * merchant already in another state is left alone. Returns the changed rows.
 */
export async function writeMerchantState(
  db: MerchantStateExecutor,
  input: { event: MerchantEvent; where: SQL; set?: MerchantStateFields },
) {
  const rule = MERCHANT_TRANSITIONS[input.event]
  const predicates: SQL[] = [
    input.where,
    inArray(merchants.status, [...rule.from]),
  ]
  if (!rule.includeDeleted) predicates.push(isNull(merchants.deletedAt))

  return db
    .update(merchants)
    .set({
      updatedAt: new Date(),
      ...input.set,
      ...(rule.to === 'unchanged' ? {} : { status: rule.to }),
    })
    .where(and(...predicates))
    .returning({ id: merchants.id, status: merchants.status })
}
