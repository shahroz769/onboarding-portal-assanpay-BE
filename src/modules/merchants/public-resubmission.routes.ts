import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";

import { getDb } from "../../db/client";
import {
  caseFieldReviews,
  caseHistory,
  caseResubmissionTokens,
  cases,
  merchantDocuments,
  merchants,
  queueStages,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { GoogleDriveStorageProvider } from "../../lib/storage/google-drive";
import type { AppEnv } from "../../types/auth";
import {
  validateToken,
} from "../cases/case-resubmission-tokens.service";
import {
  DOCUMENT_TYPE_LABELS,
  getDocumentIdFromFieldName,
  isDocumentFieldName,
  MERCHANT_FIELD_LABELS,
} from "../cases/field-labels";
import { getResubmissionContext } from "../cases/cases.service";
import { notifyOnResubmission } from "../notifications/notifications.service";

export const resubmissionRoutes = new Hono<AppEnv>();

// GET /api/public/resubmission/:token — Load context for the resubmission form
resubmissionRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const validated = await validateToken(token);
  const context = await getResubmissionContext(
    validated.caseId,
    validated.expiresAt,
  );
  return c.json(context);
});

// POST /api/public/resubmission/:token — Apply the resubmission
resubmissionRoutes.post("/:token", async (c) => {
  const token = c.req.param("token");
  const validated = await validateToken(token);
  const db = getDb();

  // Re-load case + merchant
  const [caseRow] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      ownerId: cases.ownerId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      driveFolderId: merchants.googleDriveFolderId,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, validated.caseId))
    .limit(1);

  if (!caseRow) {
    throw new AppError(404, "Case not found.");
  }

  // Load rejected reviews — these define what the client may submit
  const rejectedReviews = await db
    .select({
      id: caseFieldReviews.id,
      fieldName: caseFieldReviews.fieldName,
    })
    .from(caseFieldReviews)
    .where(
      and(
        eq(caseFieldReviews.caseId, validated.caseId),
        eq(caseFieldReviews.status, "rejected"),
      ),
    );

  if (rejectedReviews.length === 0) {
    throw new AppError(400, "There are no rejected fields to update.");
  }

  const allowedFieldNames = new Set(rejectedReviews.map((r) => r.fieldName));
  const reviewIdByField = new Map(
    rejectedReviews.map((r) => [r.fieldName, r.id] as const),
  );

  // Parse multipart form data
  const formData = await c.req.formData();
  const submittedTextFields = new Map<string, string>();
  const submittedFiles = new Map<string, File>();

  for (const [key, value] of formData.entries()) {
    if (!allowedFieldNames.has(key)) {
      throw new AppError(400, `Field "${key}" is not pending resubmission.`);
    }
    if (isDocumentFieldName(key)) {
      if (!(value instanceof File)) {
        throw new AppError(400, `Expected file upload for "${key}".`);
      }
      submittedFiles.set(key, value);
    } else {
      // Reject merchant text fields not in known label map
      if (!(key in MERCHANT_FIELD_LABELS)) {
        throw new AppError(400, `Unknown merchant field "${key}".`);
      }
      const text = typeof value === "string" ? value : String(value);
      submittedTextFields.set(key, text.trim());
    }
  }

  if (
    submittedTextFields.size === 0 &&
    submittedFiles.size === 0
  ) {
    throw new AppError(400, "No updated values were submitted.");
  }

  // Pre-load existing document rows for any submitted document fields
  const docFieldIds = Array.from(submittedFiles.keys())
    .map((k) => getDocumentIdFromFieldName(k))
    .filter((id): id is string => id !== null);

  const existingDocs = docFieldIds.length
    ? await db
        .select({
          id: merchantDocuments.id,
          merchantId: merchantDocuments.merchantId,
          documentType: merchantDocuments.documentType,
          googleDriveFileId: merchantDocuments.googleDriveFileId,
          googleDriveFolderId: merchantDocuments.googleDriveFolderId,
        })
        .from(merchantDocuments)
        .where(inArray(merchantDocuments.id, docFieldIds))
    : [];

  const existingDocsById = new Map(existingDocs.map((d) => [d.id, d] as const));

  // Validate every submitted doc belongs to this merchant
  for (const fieldName of submittedFiles.keys()) {
    const docId = getDocumentIdFromFieldName(fieldName)!;
    const existing = existingDocsById.get(docId);
    if (!existing || existing.merchantId !== caseRow.merchantId) {
      throw new AppError(400, `Invalid document field "${fieldName}".`);
    }
  }

  // Upload all files BEFORE the transaction
  const storage = new GoogleDriveStorageProvider();
  const uploadedByField = new Map<
    string,
    {
      docId: string;
      previousFileId: string;
      uploaded: Awaited<ReturnType<typeof storage.uploadFile>>;
    }
  >();

  for (const [fieldName, file] of submittedFiles.entries()) {
    const docId = getDocumentIdFromFieldName(fieldName)!;
    const existing = existingDocsById.get(docId)!;
    const folderId =
      existing.googleDriveFolderId ?? caseRow.driveFolderId;
    const uploaded = await storage.uploadFile(folderId, {
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      file,
    });
    uploadedByField.set(fieldName, {
      docId,
      previousFileId: existing.googleDriveFileId,
      uploaded,
    });
  }

  // Resolve working stage
  const workingStage = await db.query.queueStages.findFirst({
    where: and(
      eq(queueStages.queueId, caseRow.queueId),
      eq(queueStages.slug, "working"),
    ),
  });

  if (!workingStage) {
    throw new AppError(500, "No working stage configured for this queue.");
  }

  const now = new Date();
  const resubmittedFieldIds = Array.from([
    ...submittedTextFields.keys(),
    ...submittedFiles.keys(),
  ])
    .map((fn) => reviewIdByField.get(fn))
    .filter((id): id is string => Boolean(id));
  const fieldsUpdated = [
    ...submittedTextFields.keys(),
    ...submittedFiles.keys(),
  ];
  const fieldLabelsByName = new Map<string, string>();

  for (const fieldName of submittedTextFields.keys()) {
    fieldLabelsByName.set(
      fieldName,
      MERCHANT_FIELD_LABELS[fieldName] ?? fieldName,
    );
  }

  for (const fieldName of submittedFiles.keys()) {
    const docId = getDocumentIdFromFieldName(fieldName)!;
    const existing = existingDocsById.get(docId);
    const label = existing
      ? (DOCUMENT_TYPE_LABELS[
          existing.documentType as keyof typeof DOCUMENT_TYPE_LABELS
        ] ?? existing.documentType)
      : fieldName;
    fieldLabelsByName.set(fieldName, label);
  }

  const fieldsUpdatedLabels = fieldsUpdated.map(
    (fieldName) => fieldLabelsByName.get(fieldName) ?? fieldName,
  );

  await db.transaction(async (tx) => {
    // 1. Update merchant text columns
    if (submittedTextFields.size > 0) {
      const merchantUpdates: Record<string, unknown> = { updatedAt: now };
      for (const [field, value] of submittedTextFields.entries()) {
        merchantUpdates[field] = value;
      }
      await tx
        .update(merchants)
        .set(merchantUpdates)
        .where(eq(merchants.id, caseRow.merchantId));
    }

    // 2. Update document rows
    for (const [, info] of uploadedByField.entries()) {
      await tx
        .update(merchantDocuments)
        .set({
          originalName: info.uploaded.fileName,
          mimeType: info.uploaded.mimeType,
          sizeBytes: info.uploaded.sizeBytes,
          googleDriveFileId: info.uploaded.fileId,
          googleDriveWebViewLink: info.uploaded.webViewLink,
          googleDriveDownloadLink: info.uploaded.downloadLink,
          googleDriveFolderId: info.uploaded.folderId,
          updatedAt: now,
        })
        .where(eq(merchantDocuments.id, info.docId));
    }

    // 3. Stamp resubmittedAt on the matching field reviews
    if (resubmittedFieldIds.length > 0) {
      await tx
        .update(caseFieldReviews)
        .set({ resubmittedAt: now })
        .where(inArray(caseFieldReviews.id, resubmittedFieldIds));
    }

    // 4. Consume the token inside the same transaction to keep the flow single-use
    const [consumedToken] = await tx
      .update(caseResubmissionTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(caseResubmissionTokens.id, validated.tokenId),
          isNull(caseResubmissionTokens.consumedAt),
        ),
      )
      .returning({ id: caseResubmissionTokens.id });

    if (!consumedToken) {
      throw new AppError(
        410,
        "This resubmission link has already been used.",
      );
    }

    // 5. Move case back to working
    await tx
      .update(cases)
      .set({
        status: "working",
        currentStageId: workingStage.id,
        updatedAt: now,
      })
      .where(eq(cases.id, caseRow.id));

    // 6. History
    await tx.insert(caseHistory).values({
      caseId: caseRow.id,
      actorId: null,
      action: "client_resubmitted",
      details: {
        tokenId: validated.tokenId,
        fieldsUpdated,
        fieldsUpdatedLabels,
      },
    });
  });

  // 7. Clean up old drive files after a successful commit (best-effort)
  for (const info of uploadedByField.values()) {
    if (info.previousFileId && info.previousFileId !== info.uploaded.fileId) {
      try {
        await storage.deleteFile(info.previousFileId);
      } catch {
        // Best effort — ignore cleanup failures
      }
    }
  }

  // 8. Notify owner (best-effort)
  if (caseRow.ownerId) {
    try {
      await notifyOnResubmission({
        caseId: caseRow.id,
        caseNumber: caseRow.caseNumber,
        ownerId: caseRow.ownerId,
        clientName: caseRow.merchantOwnerName,
        fieldCount: fieldsUpdated.length,
      });
    } catch {
      // Notifications must never break the primary flow
    }
  }

  return c.json({ success: true, caseNumber: caseRow.caseNumber });
});
