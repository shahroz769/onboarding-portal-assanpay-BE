import { eq } from "drizzle-orm";

import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { caseResubmissionTokens } from "../../db/schema";
import { AppError } from "../../lib/errors";

export type IssuedToken = {
  token: string;
  tokenId: string;
  expiresAt: Date;
};

export type ValidatedToken = {
  caseId: string;
  tokenId: string;
  expiresAt: Date;
};

function generateTokenString(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export async function issueToken(
  caseId: string,
  createdByUserId: string,
): Promise<IssuedToken> {
  const db = getDb();
  const tokenString = generateTokenString();
  const expiresAt = new Date(
    Date.now() + env.RESUBMISSION_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  const [row] = await db
    .insert(caseResubmissionTokens)
    .values({
      caseId,
      token: tokenString,
      expiresAt,
      createdBy: createdByUserId,
    })
    .returning({ id: caseResubmissionTokens.id });

  if (!row) {
    throw new AppError(500, "Failed to issue resubmission token.");
  }

  return { token: tokenString, tokenId: row.id, expiresAt };
}

export async function validateToken(token: string): Promise<ValidatedToken> {
  const db = getDb();
  const [row] = await db
    .select({
      id: caseResubmissionTokens.id,
      caseId: caseResubmissionTokens.caseId,
      expiresAt: caseResubmissionTokens.expiresAt,
      consumedAt: caseResubmissionTokens.consumedAt,
    })
    .from(caseResubmissionTokens)
    .where(eq(caseResubmissionTokens.token, token))
    .limit(1);

  if (!row) {
    throw new AppError(404, "Resubmission link not found.");
  }

  if (row.consumedAt) {
    throw new AppError(410, "This resubmission link has already been used.");
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, "This resubmission link has expired.");
  }

  return { caseId: row.caseId, tokenId: row.id, expiresAt: row.expiresAt };
}

export async function consumeToken(tokenId: string): Promise<void> {
  const db = getDb();
  await db
    .update(caseResubmissionTokens)
    .set({ consumedAt: new Date() })
    .where(eq(caseResubmissionTokens.id, tokenId));
}
