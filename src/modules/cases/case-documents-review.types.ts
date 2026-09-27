export type SendForResubmissionResult = {
  status: 'sent' | 'failed'
  emailLogId: string
  error?: string
}

export type RegeneratedResubmissionLinkResult = {
  url: string
  rejectedFieldCount: number
}
