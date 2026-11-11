import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'

import type { DbTransaction, getDb } from '../../db/client'
import { refreshTokens } from '../../db/schema'

/**
 * The refresh-token lifecycle, in one place. Every status change goes through
 * the functions below; migration 0110 enforces the same rules for any other
 * writer.
 *
 *   active ──rotate──▶ rotated   (replaced by the next token in the chain)
 *   active, rotated ──revoke──▶ revoked
 *   revoked is final.
 *
 * A rotated token is kept so a stolen copy presented later is recognised as
 * reuse. Revoking also covers rotated tokens: after logout-everywhere or a
 * password change, an old copy must be refused, not treated as reuse again.
 */
type RefreshTokenExecutor = ReturnType<typeof getDb> | DbTransaction

/**
 * Replaces an active token with the next one. Returns no row when the token
 * was already rotated, revoked or matched nothing, so of two concurrent
 * refreshes with the same token only one wins.
 */
export function rotateRefreshToken(
  db: RefreshTokenExecutor,
  input: { where: SQL; replacedByTokenId: string },
) {
  return db
    .update(refreshTokens)
    .set({
      status: 'rotated',
      revokedAt: new Date(),
      replacedByTokenId: input.replacedByTokenId,
    })
    .where(and(input.where, eq(refreshTokens.status, 'active')))
    .returning({ id: refreshTokens.id })
}

/**
 * Ends the matched sessions. A rotated token keeps the time it was rotated,
 * so its row still says when it stopped being usable.
 */
export function revokeRefreshTokens(db: RefreshTokenExecutor, where: SQL) {
  return db
    .update(refreshTokens)
    .set({
      status: 'revoked',
      revokedAt: sql`coalesce(${refreshTokens.revokedAt}, now())`,
    })
    .where(and(where, inArray(refreshTokens.status, ['active', 'rotated'])))
}
