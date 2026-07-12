export type SendForResubmissionResult = {
  status: 'sent' | 'failed'
  tokenExpiresAt: string | null
  emailLogId: string
  error?: string
}
