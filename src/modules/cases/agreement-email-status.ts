import { eq, sql } from 'drizzle-orm'

import type { DbTransaction, getDb } from '../../db/client'
import { agreementCaseDetails } from '../../db/schema'
import { UNDELIVERED_EMAIL_STATUSES } from '../email/email-delivery-status'

export type AgreementEmailStatus =
  (typeof agreementCaseDetails.$inferSelect)['emailStatus']

const UNDELIVERED_LIST = sql.raw(
  [...UNDELIVERED_EMAIL_STATUSES].map((status) => `'${status}'`).join(', '),
)

/**
 * The Agreement email status as it stands now. The stored column is written
 * once, when the email is sent; delivery updates (bounces, complaints) only
 * reach the email log. So an email the log shows as undelivered reads as
 * failed. A manual copy has no log row and keeps its stored status.
 * Use in queries on agreement_case_details.
 */
export const agreementEmailStatusSql = sql<AgreementEmailStatus>`(case when exists (
  select 1 from "email_log"
  where "email_log"."id" = ${agreementCaseDetails.emailLogId}
    and "email_log"."status" in (${UNDELIVERED_LIST})
) then 'failed' else ${agreementCaseDetails.emailStatus}::text end)`

export async function getAgreementEmailStatus(
  db: ReturnType<typeof getDb> | DbTransaction,
  caseId: string,
): Promise<AgreementEmailStatus | null> {
  const [row] = await db
    .select({ emailStatus: agreementEmailStatusSql })
    .from(agreementCaseDetails)
    .where(eq(agreementCaseDetails.caseId, caseId))
    .limit(1)
  return row?.emailStatus ?? null
}
