import { and, count, eq, inArray, isNull } from "drizzle-orm";
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
import { validateToken } from "../cases/case-resubmission-tokens.service";
import {
  DOCUMENT_TYPE_LABELS,
  getDocumentIdFromFieldName,
  isDocumentFieldName,
  MERCHANT_FIELD_LABELS,
} from "../cases/field-labels";
import { getResubmissionContext } from "../cases/cases.service";
import {
  MAX_FILE_SIZE_BYTES,
  getAllowedDocumentTypes,
  getRequiredDocumentTypes,
  type MerchantDocumentType,
  normalizeMimeType,
  validateStoredMerchantScalarValues,
} from "./merchants.schemas";
import { notifyOnResubmission } from "../notifications/notifications.service";

export const resubmissionRoutes = new Hono<AppEnv>();

const DOCUMENT_ACTION_PREFIX = "__document_action__:";
const submissionFolderPattern =
  /^(first|second|third)\s+submission$|^submission\s+\d+$/i;

// GET /api/public/resubmission/:token - Load context for the resubmission form
resubmissionRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  const validated = await validateToken(token);
  const context = await getResubmissionContext(
    validated.caseId,
    validated.expiresAt,
  );
  return c.json(context);
});

// POST /api/public/resubmission/:token - Apply the resubmission
resubmissionRoutes.post("/:token", async (c) => {
  const token = c.req.param("token");
  const validated = await validateToken(token);
  const db = getDb();

  const [caseRow] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueId: cases.queueId,
      ownerId: cases.ownerId,
      merchantId: cases.merchantId,
      merchantName: merchants.businessName,
      merchantOwnerName: merchants.ownerFullName,
      merchantType: merchants.merchantType,
      submitterEmail: merchants.submitterEmail,
      ownerFullName: merchants.ownerFullName,
      ownerPhone: merchants.ownerPhone,
      businessName: merchants.businessName,
      businessPhone: merchants.businessPhone,
      businessEmail: merchants.businessEmail,
      businessAddress: merchants.businessAddress,
      businessWebsite: merchants.businessWebsite,
      websiteCms: merchants.websiteCms,
      businessDescription: merchants.businessDescription,
      businessRegistrationDate: merchants.businessRegistrationDate,
      businessNature: merchants.businessNature,
      estimatedMonthlyTransactions: merchants.estimatedMonthlyTransactions,
      estimatedMonthlyVolume: merchants.estimatedMonthlyVolume,
      accountTitle: merchants.accountTitle,
      bankName: merchants.bankName,
      branchName: merchants.branchName,
      accountNumberIban: merchants.accountNumberIban,
      swiftCode: merchants.swiftCode,
      nextOfKinRelation: merchants.nextOfKinRelation,
    })
    .from(cases)
    .innerJoin(merchants, eq(cases.merchantId, merchants.id))
    .where(eq(cases.id, validated.caseId))
    .limit(1);

  if (!caseRow) {
    throw new AppError(404, "Case not found.");
  }

  const rejectedReviews = await db
    .select({
      id: caseFieldReviews.id,
      fieldName: caseFieldReviews.fieldName,
      remarks: caseFieldReviews.remarks,
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

  const allowedFieldNames = new Set(rejectedReviews.map((review) => review.fieldName));
  const reviewByField = new Map(
    rejectedReviews.map((review) => [review.fieldName, review] as const),
  );

  const formData = await c.req.formData();
  const submittedTextFields = new Map<string, string>();
  const submittedFiles = new Map<string, File>();
  const documentActions = new Map<string, "replace" | "remove">();

  for (const [key, value] of formData.entries()) {
    if (key.startsWith(DOCUMENT_ACTION_PREFIX)) {
      const fieldName = key.slice(DOCUMENT_ACTION_PREFIX.length);
      if (!allowedFieldNames.has(fieldName) || !isDocumentFieldName(fieldName)) {
        throw new AppError(400, `Field "${fieldName}" is not pending document resubmission.`);
      }

      if (typeof value !== "string" || (value !== "replace" && value !== "remove")) {
        throw new AppError(400, `Document action for "${fieldName}" is invalid.`);
      }

      documentActions.set(fieldName, value);
      continue;
    }

    if (!allowedFieldNames.has(key)) {
      throw new AppError(400, `Field "${key}" is not pending resubmission.`);
    }

    if (isDocumentFieldName(key)) {
      if (typeof value === "string") {
        throw new AppError(400, `Expected file upload for "${key}".`);
      }
      if (submittedFiles.has(key)) {
        throw new AppError(400, `Document "${key}" must be uploaded once.`);
      }
      submittedFiles.set(key, value);
      continue;
    }

    if (!(key in MERCHANT_FIELD_LABELS)) {
      throw new AppError(400, `Unknown merchant field "${key}".`);
    }
    if (typeof value !== "string") {
      throw new AppError(400, `Field "${key}" must be a text value.`);
    }
    submittedTextFields.set(key, value.trim());
  }

  for (const fieldName of allowedFieldNames) {
    if (isDocumentFieldName(fieldName)) {
      if (!documentActions.has(fieldName)) {
        throw new AppError(400, `Document "${fieldName}" must be resubmitted.`);
      }
      continue;
    }

    if (!submittedTextFields.has(fieldName)) {
      throw new AppError(400, `Field "${fieldName}" is required in this resubmission.`);
    }
  }

  const rejectedDocumentIds = rejectedReviews
    .map((review) =>
      isDocumentFieldName(review.fieldName)
        ? getDocumentIdFromFieldName(review.fieldName)
        : null,
    )
    .filter((id): id is string => Boolean(id));

  const existingDocs = rejectedDocumentIds.length
    ? await db
        .select({
          id: merchantDocuments.id,
          merchantId: merchantDocuments.merchantId,
          documentType: merchantDocuments.documentType,
          originalName: merchantDocuments.originalName,
          googleDriveFileId: merchantDocuments.googleDriveFileId,
          googleDriveFolderId: merchantDocuments.googleDriveFolderId,
          googleDriveWebViewLink: merchantDocuments.googleDriveWebViewLink,
        })
        .from(merchantDocuments)
        .where(inArray(merchantDocuments.id, rejectedDocumentIds))
    : [];

  const existingDocsById = new Map(existingDocs.map((doc) => [doc.id, doc] as const));
  const requiredDocumentTypes = new Set(getRequiredDocumentTypes(caseRow.merchantType));
  const allowedDocumentTypes = new Set(getAllowedDocumentTypes(caseRow.merchantType));

  for (const fieldName of allowedFieldNames) {
    if (!isDocumentFieldName(fieldName)) {
      continue;
    }

    const docId = getDocumentIdFromFieldName(fieldName);
    if (!docId) {
      throw new AppError(400, `Invalid document field "${fieldName}".`);
    }

    const existing = existingDocsById.get(docId);
    if (!existing || existing.merchantId !== caseRow.merchantId) {
      throw new AppError(400, `Invalid document field "${fieldName}".`);
    }

    if (!allowedDocumentTypes.has(existing.documentType)) {
      throw new AppError(
        400,
        `Document "${existing.documentType}" is not allowed for this merchant type.`,
      );
    }

    const action = documentActions.get(fieldName);
    if (!action) {
      throw new AppError(400, `Document "${fieldName}" must be resubmitted.`);
    }

    const isRequired = requiredDocumentTypes.has(existing.documentType);
    if (isRequired && action !== "replace") {
      throw new AppError(
        400,
        `${DOCUMENT_TYPE_LABELS[existing.documentType]} must be uploaded again.`,
      );
    }

    if (action === "replace") {
        const file = submittedFiles.get(fieldName);
        if (!(file instanceof File) || file.size === 0) {
          throw new AppError(
            400,
            `${DOCUMENT_TYPE_LABELS[existing.documentType]} must be uploaded again.`,
          );
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
          throw new AppError(
            413,
            `${DOCUMENT_TYPE_LABELS[existing.documentType]} exceeds the 10 MB limit.`,
          );
        }
        normalizeMimeType(file);
        continue;
      }

    if (submittedFiles.has(fieldName)) {
      throw new AppError(400, `Document "${fieldName}" cannot be uploaded and removed together.`);
    }
  }

  const validatedMerchantValues = validateStoredMerchantScalarValues({
    submitterEmail: submittedTextFields.get("submitterEmail") ?? caseRow.submitterEmail,
    ownerFullName: submittedTextFields.get("ownerFullName") ?? caseRow.ownerFullName,
    ownerPhone: submittedTextFields.get("ownerPhone") ?? caseRow.ownerPhone,
    businessName: submittedTextFields.get("businessName") ?? caseRow.businessName,
    businessPhone: submittedTextFields.get("businessPhone") ?? caseRow.businessPhone,
    businessEmail: submittedTextFields.get("businessEmail") ?? caseRow.businessEmail,
    businessAddress: submittedTextFields.get("businessAddress") ?? caseRow.businessAddress,
    businessWebsite: submittedTextFields.get("businessWebsite") ?? caseRow.businessWebsite,
    websiteCms: submittedTextFields.get("websiteCms") ?? caseRow.websiteCms,
    businessDescription:
      submittedTextFields.get("businessDescription") ?? caseRow.businessDescription,
    businessRegistrationDate:
      submittedTextFields.get("businessRegistrationDate") ?? caseRow.businessRegistrationDate,
    businessNature: submittedTextFields.get("businessNature") ?? caseRow.businessNature,
    merchantType: submittedTextFields.get("merchantType") ?? caseRow.merchantType,
    estimatedMonthlyTransactions:
      submittedTextFields.get("estimatedMonthlyTransactions") ??
      String(caseRow.estimatedMonthlyTransactions),
    estimatedMonthlyVolume:
      submittedTextFields.get("estimatedMonthlyVolume") ??
      String(caseRow.estimatedMonthlyVolume),
    accountTitle: submittedTextFields.get("accountTitle") ?? caseRow.accountTitle,
    bankName: submittedTextFields.get("bankName") ?? caseRow.bankName,
    branchName: submittedTextFields.get("branchName") ?? caseRow.branchName,
    accountNumberIban:
      submittedTextFields.get("accountNumberIban") ?? caseRow.accountNumberIban,
    swiftCode: submittedTextFields.get("swiftCode") ?? caseRow.swiftCode ?? "",
    nextOfKinRelation:
      submittedTextFields.get("nextOfKinRelation") ?? caseRow.nextOfKinRelation,
  });

  const storage = new GoogleDriveStorageProvider();
  const replaceActions = Array.from(documentActions.entries()).filter(
    ([, action]) => action === "replace",
  );
  const removeActions = Array.from(documentActions.entries()).filter(
    ([, action]) => action === "remove",
  );

  const previousResubmissions = await db
    .select({ count: count() })
    .from(caseHistory)
    .where(
      and(
        eq(caseHistory.caseId, caseRow.id),
        eq(caseHistory.action, "client_resubmitted"),
      ),
    );

  const submissionIndex = Number(previousResubmissions[0]?.count ?? 0) + 2;
  let nextSubmissionFolderId: string | null = null;

  if (replaceActions.length > 0) {
    const firstDocument = existingDocsById.get(
      getDocumentIdFromFieldName(replaceActions[0]![0])!,
    );

    if (!firstDocument) {
      throw new AppError(400, "Unable to resolve the current document folder.");
    }

    const merchantFolderId = await resolveMerchantFolderId(
      storage,
      firstDocument.googleDriveFolderId,
    );
    const createdFolder = await storage.createFolder(
      merchantFolderId,
      getSubmissionFolderName(submissionIndex),
    );
    nextSubmissionFolderId = createdFolder.folderId;
  }

  const uploadedByField = new Map<
    string,
    {
      docId: string;
      documentType: MerchantDocumentType;
      previousFileId: string;
      previousFileName: string;
      previousFileUrl: string;
      uploaded: Awaited<ReturnType<typeof storage.uploadFile>>;
    }
  >();

  try {
    if (nextSubmissionFolderId) {
      for (const [fieldName] of replaceActions) {
        const docId = getDocumentIdFromFieldName(fieldName)!;
        const existing = existingDocsById.get(docId)!;
        const file = submittedFiles.get(fieldName);

        if (!file) {
          throw new AppError(400, `Document "${fieldName}" must be uploaded.`);
        }

        const uploaded = await storage.uploadFile(nextSubmissionFolderId, {
          fileName: buildDocumentFileName(existing.documentType, file.name),
          mimeType: normalizeMimeType(file),
          file,
        });

        uploadedByField.set(fieldName, {
          docId,
          documentType: existing.documentType,
          previousFileId: existing.googleDriveFileId,
          previousFileName: existing.originalName,
          previousFileUrl: existing.googleDriveWebViewLink,
          uploaded,
        });
      }
    }

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
    const fieldsUpdated = Array.from(allowedFieldNames);
    const resubmittedFieldIds = fieldsUpdated
      .map((fieldName) => reviewByField.get(fieldName)?.id)
      .filter((id): id is string => Boolean(id));
    const fieldsUpdatedDetails = fieldsUpdated.map((fieldName) => {
      if (!isDocumentFieldName(fieldName)) {
        return {
          fieldName,
          label: MERCHANT_FIELD_LABELS[fieldName] ?? fieldName,
          type: "text" as const,
        };
      }

      const docId = getDocumentIdFromFieldName(fieldName)!;
      const existing = existingDocsById.get(docId)!;
      const uploaded = uploadedByField.get(fieldName);

      return {
        fieldName,
        label:
          DOCUMENT_TYPE_LABELS[existing.documentType as keyof typeof DOCUMENT_TYPE_LABELS] ??
          existing.documentType,
        type: "document" as const,
        action: documentActions.get(fieldName),
        previousFileName: existing.originalName,
        previousFileUrl: existing.googleDriveWebViewLink,
        nextFileName: uploaded?.uploaded.fileName ?? null,
        nextFileUrl: uploaded?.uploaded.webViewLink ?? null,
      };
    });

    await db.transaction(async (tx) => {
      await tx
        .update(merchants)
        .set({
          submitterEmail: validatedMerchantValues.submitterEmail,
          ownerFullName: validatedMerchantValues.ownerFullName,
          ownerPhone: validatedMerchantValues.ownerPhone,
          businessName: validatedMerchantValues.businessName,
          businessPhone: validatedMerchantValues.businessPhone,
          businessEmail: validatedMerchantValues.businessEmail,
          businessAddress: validatedMerchantValues.businessAddress,
          businessWebsite: validatedMerchantValues.businessWebsite,
          websiteCms: validatedMerchantValues.websiteCms,
          businessDescription: validatedMerchantValues.businessDescription,
          businessRegistrationDate: validatedMerchantValues.businessRegistrationDate,
          businessNature: validatedMerchantValues.businessNature,
          merchantType: validatedMerchantValues.merchantType,
          estimatedMonthlyTransactions: validatedMerchantValues.estimatedMonthlyTransactions,
          estimatedMonthlyVolume: validatedMerchantValues.estimatedMonthlyVolume,
          accountTitle: validatedMerchantValues.accountTitle,
          bankName: validatedMerchantValues.bankName,
          branchName: validatedMerchantValues.branchName,
          accountNumberIban: validatedMerchantValues.accountNumberIban,
          swiftCode: validatedMerchantValues.swiftCode,
          nextOfKinRelation: validatedMerchantValues.nextOfKinRelation,
          updatedAt: now,
        })
        .where(eq(merchants.id, caseRow.merchantId));

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

      for (const [fieldName] of removeActions) {
        const docId = getDocumentIdFromFieldName(fieldName)!;
        await tx.delete(merchantDocuments).where(eq(merchantDocuments.id, docId));
      }

      if (resubmittedFieldIds.length > 0) {
        await tx
          .update(caseFieldReviews)
          .set({
            status: "pending",
            remarks: null,
            resubmittedAt: now,
          })
          .where(inArray(caseFieldReviews.id, resubmittedFieldIds));
      }

      const removedFieldIds = removeActions
        .map(([fieldName]) => reviewByField.get(fieldName)?.id)
        .filter((id): id is string => Boolean(id));

      if (removedFieldIds.length > 0) {
        await tx
          .update(caseFieldReviews)
          .set({
            status: "approved",
            remarks: null,
            resubmittedAt: now,
          })
          .where(inArray(caseFieldReviews.id, removedFieldIds));
      }

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
        throw new AppError(410, "This resubmission link has already been used.");
      }

      await tx
        .update(cases)
        .set({
          status: "working",
          currentStageId: workingStage.id,
          updatedAt: now,
        })
        .where(eq(cases.id, caseRow.id));

      await tx.insert(caseHistory).values({
        caseId: caseRow.id,
        actorId: null,
        action: "client_resubmitted",
        details: {
          tokenId: validated.tokenId,
          submissionIndex,
          fieldsUpdated,
          fieldsUpdatedLabels: fieldsUpdatedDetails.map((item) => item.label),
          fieldsUpdatedDetails,
          documentActions: Array.from(documentActions.entries()).map(
            ([fieldName, action]) => ({
              fieldName,
              action,
            }),
          ),
        },
      });
    });

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
  } catch (error) {
    if (nextSubmissionFolderId) {
      await storage.deleteFile(nextSubmissionFolderId).catch(() => {
        // Best effort cleanup only.
      });
    }

    throw error;
  }
});

async function resolveMerchantFolderId(
  storage: GoogleDriveStorageProvider,
  currentFolderId: string,
) {
  const folder = await storage.getFileMetadata(currentFolderId);

  if (!submissionFolderPattern.test(folder.name ?? "")) {
    return currentFolderId;
  }

  const merchantFolderId = folder.parents?.[0];
  if (!merchantFolderId) {
    throw new AppError(500, "Unable to resolve the merchant folder for this resubmission.");
  }

  return merchantFolderId;
}

function getSubmissionFolderName(index: number) {
  switch (index) {
    case 1:
      return "First Submission";
    case 2:
      return "Second Submission";
    case 3:
      return "Third Submission";
    default:
      return `Submission ${index}`;
  }
}

function buildDocumentFileName(documentType: MerchantDocumentType, originalName: string) {
  const extension = originalName.includes(".")
    ? `.${originalName.split(".").pop()?.toLowerCase()}`
    : "";

  return `${documentType}${extension}`;
}
