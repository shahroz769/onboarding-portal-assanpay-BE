import { AppError } from '../../lib/errors'

export type CaseFlowFailureKind = 'blocked' | 'transient'

export function classifyCaseFlowFailure(error: unknown): CaseFlowFailureKind {
  return error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500
    ? 'blocked'
    : 'transient'
}

export function calculateCaseFlowRetryDelay(input: {
  previousAttempts: number
  kind: CaseFlowFailureKind
  retryBaseMs: number
  retryMaxMs: number
  blockedRetryMs: number
  jitterPercent: number
  random?: () => number
}) {
  const baseDelay =
    input.kind === 'blocked'
      ? input.blockedRetryMs
      : Math.min(
          input.retryBaseMs * 2 ** Math.min(input.previousAttempts, 30),
          input.retryMaxMs,
        )
  const random = input.random ?? Math.random
  const jitter = 1 + (random() * 2 - 1) * (input.jitterPercent / 100)

  return Math.max(1_000, Math.round(baseDelay * jitter))
}
