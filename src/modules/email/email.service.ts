import type { ReactElement } from "react";
import { render } from "@react-email/render";
import { eq } from "drizzle-orm";

import { env } from "../../config/env";
import { getDb } from "../../db/client";
import { emailLog } from "../../db/schema";
import { getResendClient } from "./email.client";

export type SendEmailInput = {
  to: string;
  subject: string;
  react: ReactElement;
  template: string;
  caseId?: string | null;
  merchantId?: string | null;
  idempotencyKey: string;
  from?: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
};

export type SendEmailResult = {
  status: "sent" | "failed";
  resendId?: string;
  emailLogId: string;
  error?: string;
};

/**
 * Render and send an email via Resend, recording the attempt in `email_log`.
 * Best-effort: never throws on provider errors. Returns `{status:"failed"}` instead.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const db = getDb();
  const fromAddress = input.from ?? env.EMAIL_FROM;
  const replyTo = input.replyTo ?? env.EMAIL_REPLY_TO;
  const testRecipientOverride =
    Bun.env.NODE_ENV !== "production" ? env.EMAIL_TEST_TO : undefined;
  const toAddress = testRecipientOverride ?? input.to;

  // 1. Pre-create the log row in `queued` state
  const [logRow] = await db
    .insert(emailLog)
    .values({
      toEmail: toAddress,
      subject: input.subject,
      template: input.template,
      caseId: input.caseId ?? null,
      merchantId: input.merchantId ?? null,
      status: "queued",
      metadata: (
        testRecipientOverride
          ? {
              ...(input.metadata ?? {}),
              originalTo: input.to,
              overriddenTo: testRecipientOverride,
            }
          : (input.metadata ?? null)
      ) as Record<string, unknown> | null,
    })
    .returning({ id: emailLog.id });

  const emailLogId = logRow!.id;

  // 2. Render the React Email template to HTML
  let html: string;
  try {
    html = await render(input.react);
  } catch (renderError) {
    const message =
      renderError instanceof Error ? renderError.message : String(renderError);
    await db
      .update(emailLog)
      .set({
        status: "failed",
        errorMsg: `render: ${message}`,
        updatedAt: new Date(),
      })
      .where(eq(emailLog.id, emailLogId));
    return { status: "failed", emailLogId, error: message };
  }

  // 3. Send via Resend (with idempotency)
  try {
    const result = await getResendClient().emails.send(
      {
        from: fromAddress,
        to: toAddress,
        subject: input.subject,
        html,
        ...(replyTo ? { replyTo } : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    if (result.error) {
      const message = result.error.message ?? "Unknown Resend error";
      await db
        .update(emailLog)
        .set({
          status: "failed",
          errorMsg: message,
          updatedAt: new Date(),
        })
        .where(eq(emailLog.id, emailLogId));
      return { status: "failed", emailLogId, error: message };
    }

    const resendId = result.data?.id;
    await db
      .update(emailLog)
      .set({
        status: "sent",
        resendId: resendId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(emailLog.id, emailLogId));

    return { status: "sent", resendId, emailLogId };
  } catch (sendError) {
    const message =
      sendError instanceof Error ? sendError.message : String(sendError);
    await db
      .update(emailLog)
      .set({
        status: "failed",
        errorMsg: message,
        updatedAt: new Date(),
      })
      .where(eq(emailLog.id, emailLogId));
    return { status: "failed", emailLogId, error: message };
  }
}
