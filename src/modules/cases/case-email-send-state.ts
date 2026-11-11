/**
 * The send state of an Agreement or EP Sub-Merchant Form email, as stored on
 * agreement_case_details and sub_merchant_form_details. These builders are
 * the only way those columns are written, and migration 0111 checks the same
 * shape for any other writer:
 *
 *   not_sent  nothing sent yet, or a new Final document reset it
 *   sent      sent automatically (with its email_log row) or copied manually
 *   failed    the automatic send failed; email_sent_at stays empty
 *
 * Delivery updates (bounces, complaints) only reach the email log; reads go
 * through agreementEmailStatusSql, which reports those as failed.
 */
export function notSentEmailFields() {
  return {
    emailStatus: 'not_sent' as const,
    emailLogId: null,
    emailSentAt: null,
    emailRecipient: null,
  }
}

/** Sent: by Resend (`emailLogId` set) or as a manual copy (`emailLogId` null). */
export function sentEmailFields(input: {
  recipient: string
  emailLogId: string | null
  sentAt: Date
}) {
  return {
    emailStatus: 'sent' as const,
    emailLogId: input.emailLogId,
    emailSentAt: input.sentAt,
    emailRecipient: input.recipient,
  }
}

/** The automatic send failed; its email_log row says why. */
export function failedEmailFields(input: {
  recipient: string
  emailLogId: string | null
}) {
  return {
    emailStatus: 'failed' as const,
    emailLogId: input.emailLogId,
    emailSentAt: null,
    emailRecipient: input.recipient,
  }
}
