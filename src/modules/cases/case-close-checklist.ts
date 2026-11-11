import { and, eq } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { agreementCaseDetails, caseFieldReviews } from '../../db/schema'
import type { QueueWorkflowType } from '../queues/queue-workflow'
import {
  ensureInheritedSubMerchantFormDetails,
  getDocumentReviewDetails,
  getLatestDocumentReviewDetailsForMerchant,
  getLiveLimitsAppliedEntry,
  getMidCreationCredentials,
  getMidCreationCredentialsSentEntry,
  getWordpressWebsiteDetails,
  type MidCreationCredentials,
} from './case-detail-lookups'
import { hasPortalApiCredentials } from './portal-api-credentials.service'

/**
 * What a working case must have before it can close successfully, for the
 * queue workflows that have a checklist. One set of rules: advanceStage
 * refuses the close with the first blocker, and the case detail returns the
 * blockers so the page shows the same answer before the owner tries.
 */
export type CloseChecklistFacts =
  | {
      workflowType: 'document_review'
      subMerchantCount: number
      hasRejectedReview: boolean
    }
  | {
      workflowType: 'sub_merchant_form'
      hasSubMerchant: boolean
      hasFinalForm: boolean
      hasSentEmailProof: boolean
    }
  | {
      workflowType: 'agreement'
      hasFinalAgreement: boolean
      hasReceivedAgreement: boolean
    }
  | {
      workflowType: 'mid'
      hasMerchantIds: boolean
      hasApiCredentials: boolean
    }
  | { workflowType: 'testing'; credentialsSent: boolean }
  | { workflowType: 'live'; limitsApplied: boolean }
  | {
      workflowType: 'wordpress'
      hasClonedWebsiteLink: boolean
      hasHomeScreenshot: boolean
      hasLogoForEachSubMerchant: boolean
      hasCheckoutScreenshot: boolean
    }

export type CloseChecklistWorkflowType = CloseChecklistFacts['workflowType']

/** Name used in "<name> cases can only be closed successfully from working." */
const CHECKLIST_WORKFLOW_LABELS: Record<CloseChecklistWorkflowType, string> = {
  document_review: 'Documents-review',
  sub_merchant_form: 'EP Sub-Merchant Form',
  agreement: 'Agreement',
  mid: 'MID Creation',
  testing: 'Testing',
  live: 'Live',
  wordpress: 'WordPress Website',
}

export function hasCloseChecklist(
  workflowType: QueueWorkflowType,
): workflowType is CloseChecklistWorkflowType {
  return workflowType in CHECKLIST_WORKFLOW_LABELS
}

export function closeOnlyFromWorkingMessage(
  workflowType: CloseChecklistWorkflowType,
) {
  return `${CHECKLIST_WORKFLOW_LABELS[workflowType]} cases can only be closed successfully from working.`
}

const MERCHANT_IDS_MESSAGE =
  'Save the email, MID, and Branch Code for both merchant IDs before closing this case.'

/** Unmet items, in the order the owner works through them. */
export function getCloseChecklistBlockers(facts: CloseChecklistFacts) {
  const blockers: string[] = []
  const require = (met: boolean, message: string) => {
    if (!met) blockers.push(message)
  }

  switch (facts.workflowType) {
    case 'document_review':
      require(facts.subMerchantCount >
        0, 'Select at least one sub-merchant before closing this case.')
      require(!facts.hasRejectedReview, 'Resolve all rejected fields and documents before closing this case.')
      break
    case 'sub_merchant_form':
      require(facts.hasSubMerchant, 'Select a sub-merchant in the document review case before closing this case.')
      require(facts.hasFinalForm, 'Upload the Final Form before closing this case.')
      require(facts.hasSentEmailProof, 'Upload the sent-email screenshot before closing this case.')
      break
    case 'agreement':
      require(facts.hasFinalAgreement, 'Upload the Final Agreement before closing this case.')
      require(facts.hasReceivedAgreement, 'Upload the signed physical agreement received by the office before closing this case.')
      break
    case 'mid':
      require(facts.hasMerchantIds, MERCHANT_IDS_MESSAGE)
      require(facts.hasApiCredentials, 'Save the API Key and API Secret for the internal merchant ID before closing this case.')
      break
    case 'testing':
      require(facts.credentialsSent, 'Send merchant portal credentials by auto Resend, manual Gmail, or WhatsApp before closing this case.')
      break
    case 'live':
      require(facts.limitsApplied, 'Confirm live limits were applied before closing this case.')
      break
    case 'wordpress':
      require(facts.hasClonedWebsiteLink, 'Save the cloned WordPress website link before closing this case.')
      require(facts.hasHomeScreenshot, 'Upload the home page screenshot before closing this case.')
      require(facts.hasLogoForEachSubMerchant, 'Upload one website logo screenshot for each selected sub-merchant before closing this case.')
      require(facts.hasCheckoutScreenshot, 'Upload the AssanPay checkout page screenshot before closing this case.')
      break
  }

  return blockers
}

// ─── Facts from loaded data ─────────────────────────────────────────────────
// Shared by the loader below and the case detail, which already holds these
// rows and builds its facts without extra queries.

export function hasCompleteMerchantIds(
  credentials: MidCreationCredentials | null,
) {
  return Boolean(
    credentials?.branchCode.trim() &&
    credentials.internalEmail.trim() &&
    credentials.internalBranchCode.trim(),
  )
}

export function hasLogoForEachSubMerchant(
  subMerchants: ReadonlyArray<{ id: string }> | undefined,
  logoScreenshots: ReadonlyArray<{ subMerchantId: string | null }>,
) {
  return Boolean(
    subMerchants?.length &&
    subMerchants.every((subMerchant) =>
      logoScreenshots.some(
        (screenshot) => screenshot.subMerchantId === subMerchant.id,
      ),
    ),
  )
}

export function wordpressChecklistFacts(
  details: Awaited<ReturnType<typeof getWordpressWebsiteDetails>>,
  subMerchants: ReadonlyArray<{ id: string }> | undefined,
): CloseChecklistFacts {
  return {
    workflowType: 'wordpress',
    hasClonedWebsiteLink: Boolean(details.clonedWebsiteLink),
    hasHomeScreenshot: details.screenshots.length > 0,
    hasLogoForEachSubMerchant: hasLogoForEachSubMerchant(
      subMerchants,
      details.subMerchantLogoScreenshots,
    ),
    hasCheckoutScreenshot: details.assanpayCheckoutScreenshots.length > 0,
  }
}

// ─── Loader for the close ───────────────────────────────────────────────────

export async function loadCloseChecklistFacts(input: {
  workflowType: CloseChecklistWorkflowType
  caseId: string
  merchantId: string
  actorId: string
}): Promise<CloseChecklistFacts> {
  const db = getDb()
  const { caseId, merchantId } = input

  switch (input.workflowType) {
    case 'document_review': {
      const [detail, [rejected]] = await Promise.all([
        getDocumentReviewDetails(caseId),
        db
          .select({ id: caseFieldReviews.id })
          .from(caseFieldReviews)
          .where(
            and(
              eq(caseFieldReviews.caseId, caseId),
              eq(caseFieldReviews.status, 'rejected'),
            ),
          )
          .limit(1),
      ])
      return {
        workflowType: 'document_review',
        subMerchantCount: detail?.subMerchants.length ?? 0,
        hasRejectedReview: Boolean(rejected),
      }
    }
    case 'sub_merchant_form': {
      const details = await ensureInheritedSubMerchantFormDetails({
        caseId,
        merchantId,
        actorId: input.actorId,
      })
      return {
        workflowType: 'sub_merchant_form',
        hasSubMerchant: Boolean(details),
        hasFinalForm: Boolean(details?.finalFormId),
        hasSentEmailProof: Boolean(
          details?.emailStatus === 'sent' && details.emailProofId,
        ),
      }
    }
    case 'agreement': {
      const details = await db.query.agreementCaseDetails.findFirst({
        where: eq(agreementCaseDetails.caseId, caseId),
        columns: { finalAgreementFileId: true, receivedAgreementFileId: true },
      })
      return {
        workflowType: 'agreement',
        hasFinalAgreement: Boolean(details?.finalAgreementFileId),
        hasReceivedAgreement: Boolean(details?.receivedAgreementFileId),
      }
    }
    case 'mid': {
      const [credentials, apiCredentials] = await Promise.all([
        getMidCreationCredentials(merchantId),
        hasPortalApiCredentials(merchantId),
      ])
      return {
        workflowType: 'mid',
        hasMerchantIds: hasCompleteMerchantIds(credentials),
        hasApiCredentials: apiCredentials,
      }
    }
    case 'testing':
      return {
        workflowType: 'testing',
        credentialsSent: Boolean(
          await getMidCreationCredentialsSentEntry(caseId),
        ),
      }
    case 'live':
      return {
        workflowType: 'live',
        limitsApplied: Boolean(await getLiveLimitsAppliedEntry(caseId)),
      }
    case 'wordpress': {
      const [details, documentReview] = await Promise.all([
        getWordpressWebsiteDetails(caseId),
        getLatestDocumentReviewDetailsForMerchant(merchantId),
      ])
      return wordpressChecklistFacts(details, documentReview?.subMerchants)
    }
  }
}
