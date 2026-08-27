export type SendForResubmissionResult = {
  status: 'sent' | 'failed'
  tokenExpiresAt: string | null
  emailLogId: string
  error?: string
}

export type RegeneratedResubmissionLinkResult = {
  url: string
  expiresAt: string
  rejectedFieldCount: number
}
