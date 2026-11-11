import { and, isNull, type SQL } from 'drizzle-orm'

import type { DbTransaction, getDb } from '../../db/client'
import { userPasswordTokens } from '../../db/schema'
import { AppError } from '../../lib/errors'

/**
 * The password-link lifecycle (invite and reset links). A link is open until
 * it expires or is consumed, once, for a reason; migration 0110 rejects
 * reopening or re-consuming it. consumePasswordTokens is the only writer of
 * consumed_at.
 */
export type PasswordTokenConsumedReason = NonNullable<
  (typeof userPasswordTokens.$inferSelect)['consumedReason']
>

type PasswordTokenExecutor = ReturnType<typeof getDb> | DbTransaction

/** Consumes the matched open links. Returns the links this call consumed. */
export function consumePasswordTokens(
  db: PasswordTokenExecutor,
  where: SQL,
  reason: PasswordTokenConsumedReason,
  now = new Date(),
) {
  return db
    .update(userPasswordTokens)
    .set({ consumedAt: now, consumedReason: reason })
    .where(and(where, isNull(userPasswordTokens.consumedAt)))
    .returning({
      id: userPasswordTokens.id,
      userId: userPasswordTokens.userId,
    })
}

/** Why a link cannot be used, as the set-password page explains it. */
export type ClosedPasswordLinkReason =
  | PasswordTokenConsumedReason
  | 'expired'
  | 'invalid'

const CLOSED_LINK_MESSAGES: Record<ClosedPasswordLinkReason, string> = {
  used: 'This password link was already used.',
  superseded:
    'A newer password link was sent. Use the link in the latest email.',
  invalidated:
    'This password link stopped working because the password was set with another link.',
  expired: 'This password link has expired.',
  invalid: 'This password link is expired or invalid.',
}

/**
 * The state of a link that cannot be used, or null when it is open. Links
 * consumed before reasons were recorded read as invalid.
 */
export function getClosedPasswordLinkReason(
  link: {
    consumedAt: Date | null
    consumedReason: PasswordTokenConsumedReason | null
    expiresAt: Date
  } | null,
  now = new Date(),
): ClosedPasswordLinkReason | null {
  if (!link) return 'invalid'
  if (link.consumedAt) return link.consumedReason ?? 'invalid'
  if (link.expiresAt <= now) return 'expired'
  return null
}

/** 410 with the reason, which the set-password page turns into its copy. */
export function closedPasswordLinkError(reason: ClosedPasswordLinkReason) {
  return new AppError(410, CLOSED_LINK_MESSAGES[reason], { reason })
}
