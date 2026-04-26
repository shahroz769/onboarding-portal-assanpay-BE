import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  cases,
  merchantDocuments,
  merchants,
  queues,
  queueCaseSequences,
} from "../../db/schema";
import {
  GoogleDriveStorageProvider,
  type FileStorageProvider,
} from "../../lib/storage/google-drive";
import { AppError } from "../../lib/errors";
import { ensureQueueStages } from "../queues/queue-stage-defaults";
import type {
  BusinessScopeValue,
  ListMerchantsQuery,
  MerchantDocumentType,
  MerchantStatusValue,
  MerchantFormSubmission,
  PriorityValue,
  UpdatePriorityInput,
} from "./merchants.schemas";
import {
  businessScopeValues,
  merchantStatusValues,
  priorityValues,
} from "./merchants.schemas";

type UploadedDocumentRecord = {
  documentType: MerchantDocumentType;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  googleDriveFileId: string;
  googleDriveWebViewLink: string;
  googleDriveDownloadLink: string | null;
  googleDriveFolderId: string;
};

const merchantStatusValueSet = new Set<string>(merchantStatusValues);
const priorityValueSet = new Set<string>(priorityValues);
const businessScopeValueSet = new Set<string>(businessScopeValues);

function parseCsvValues<TValue extends string>(
  rawValue: string,
  allowedValues: ReadonlySet<string>,
) {
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is TValue => value.length > 0 && allowedValues.has(value));
}

type KeysetCursorKind = "date" | "number" | "string";

type DecodedKeysetCursor = {
  sortBy: string;
  sortOrder: "asc" | "desc";
  value: Date | number | string;
  id: string;
};

function encodeKeysetCursor(input: {
  sortBy: string;
  sortOrder: "asc" | "desc";
  value: unknown;
  id: string;
}) {
  return btoa(
    encodeURIComponent(
      JSON.stringify({
        ...input,
        value:
          input.value instanceof Date ? input.value.toISOString() : input.value,
      }),
    ),
  );
}

function decodeKeysetCursor(
  rawCursor: string,
  expected: {
    sortBy: string;
    sortOrder: "asc" | "desc";
    kind: KeysetCursorKind;
  },
): DecodedKeysetCursor {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(rawCursor))) as {
      sortBy?: unknown;
      sortOrder?: unknown;
      value?: unknown;
      id?: unknown;
    };

    if (
      parsed.sortBy !== expected.sortBy ||
      parsed.sortOrder !== expected.sortOrder ||
      typeof parsed.id !== "string"
    ) {
      throw new Error("Cursor does not match the active sort.");
    }

    let value: Date | number | string;
    if (expected.kind === "date") {
      if (typeof parsed.value !== "string") {
        throw new Error("Cursor date is invalid.");
      }
      value = new Date(parsed.value);
      if (Number.isNaN(value.getTime())) {
        throw new Error("Cursor date is invalid.");
      }
    } else if (expected.kind === "number") {
      value = Number(parsed.value);
      if (!Number.isFinite(value)) {
        throw new Error("Cursor number is invalid.");
      }
    } else {
      if (typeof parsed.value !== "string") {
        throw new Error("Cursor value is invalid.");
      }
      value = parsed.value;
    }

    return {
      sortBy: expected.sortBy,
      sortOrder: expected.sortOrder,
      value,
      id: parsed.id,
    };
  } catch {
    throw new AppError(400, "Invalid pagination cursor.");
  }
}

function buildKeysetCondition(input: {
  expression: unknown;
  idExpression: unknown;
  sortOrder: "asc" | "desc";
  value: Date | number | string;
  id: string;
}) {
  const operator = input.sortOrder === "desc" ? "<" : ">";
  return or(
    sql`${input.expression} ${sql.raw(operator)} ${input.value}`,
    and(
      sql`${input.expression} = ${input.value}`,
      sql`${input.idExpression} ${sql.raw(operator)} ${input.id}`,
    ),
  )!;
}

function sanitizeMerchantRecord(merchant: typeof merchants.$inferSelect) {
  return {
    id: merchant.id,
    submitterEmail: merchant.submitterEmail,
    ownerFullName: merchant.ownerFullName,
    ownerPhone: merchant.ownerPhone,
    businessName: merchant.businessName,
    businessPhone: merchant.businessPhone,
    businessEmail: merchant.businessEmail,
    businessAddress: merchant.businessAddress,
    businessWebsite: merchant.businessWebsite,
    websiteCms: merchant.websiteCms,
    businessDescription: merchant.businessDescription,
    businessRegistrationDate: merchant.businessRegistrationDate,
    businessNature: merchant.businessNature,
    merchantType: merchant.merchantType,
    estimatedMonthlyTransactions: merchant.estimatedMonthlyTransactions,
    estimatedMonthlyVolume: merchant.estimatedMonthlyVolume,
    accountTitle: merchant.accountTitle,
    bankName: merchant.bankName,
    branchName: merchant.branchName,
    accountNumberIban: merchant.accountNumberIban,
    swiftCode: merchant.swiftCode,
    nextOfKinRelation: merchant.nextOfKinRelation,
    status: merchant.status,
    onboardingStage: merchant.onboardingStage,
    submittedAt: merchant.submittedAt,
    createdAt: merchant.createdAt,
    updatedAt: merchant.updatedAt,
  };
}

function sanitizeDocumentRecord(document: typeof merchantDocuments.$inferSelect) {
  return {
    id: document.id,
    documentType: document.documentType,
    originalName: document.originalName,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    googleDriveFileId: document.googleDriveFileId,
    googleDriveWebViewLink: document.googleDriveWebViewLink,
    googleDriveDownloadLink: document.googleDriveDownloadLink,
    googleDriveFolderId: document.googleDriveFolderId,
    status: document.status,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

function sanitizeCaseRecord(caseRecord: typeof cases.$inferSelect) {
  return {
    id: caseRecord.id,
    caseNumber: caseRecord.caseNumber,
    queueId: caseRecord.queueId,
    merchantId: caseRecord.merchantId,
    ownerId: caseRecord.ownerId,
    currentStageId: caseRecord.currentStageId,
    status: caseRecord.status,
    priority: caseRecord.priority,
    closedAt: caseRecord.closedAt,
    createdAt: caseRecord.createdAt,
    updatedAt: caseRecord.updatedAt,
  };
}

export async function createMerchantSubmission(
  input: MerchantFormSubmission,
  storage: FileStorageProvider = new GoogleDriveStorageProvider(),
) {
  const merchantId = crypto.randomUUID();
  let folderId: string | null = null;
  let submissionFolderId: string | null = null;

  try {
    const folder = await storage.createMerchantFolder(buildFolderName(merchantId, input.businessName));
    folderId = folder.folderId;
    const submissionFolder = await storage.createFolder(
      folderId,
      getSubmissionFolderName(1),
    );
    submissionFolderId = submissionFolder.folderId;
    const uploadFolderId = submissionFolderId;

    const uploadedDocuments = await Promise.all(
      input.documents.map(async (document) => {
        const upload = await storage.uploadFile(uploadFolderId, {
          fileName: buildDocumentFileName(document.documentType, document.file.name),
          mimeType: document.mimeType,
          file: document.file,
        });

        return {
          documentType: document.documentType,
          originalName: document.file.name,
          mimeType: upload.mimeType,
          sizeBytes: upload.sizeBytes,
          googleDriveFileId: upload.fileId,
          googleDriveWebViewLink: upload.webViewLink,
          googleDriveDownloadLink: upload.downloadLink,
          googleDriveFolderId: upload.folderId,
        } satisfies UploadedDocumentRecord;
      }),
    );

    const result = await getDb().transaction(async (tx) => {
      const [createdMerchant] = await tx
        .insert(merchants)
        .values({
          id: merchantId,
          submitterEmail: input.email,
          ownerFullName: input.ownerFullName,
          ownerPhone: input.ownerPhone,
          businessName: input.businessName,
          businessPhone: input.businessPhone,
          businessEmail: input.businessEmail,
          businessAddress: input.businessAddress,
          businessWebsite: input.businessWebsite,
          websiteCms: input.websiteCms,
          businessDescription: input.businessDescription,
          businessRegistrationDate: input.businessRegistrationDate,
          businessNature: input.businessNature,
          merchantType: input.merchantType,
          estimatedMonthlyTransactions: input.estimatedMonthlyTransactions,
          estimatedMonthlyVolume: input.estimatedMonthlyVolume,
          accountTitle: input.accountTitle,
          bankName: input.bankName,
          branchName: input.branchName,
          accountNumberIban: input.accountNumberIban,
          swiftCode: input.swiftCode,
          nextOfKinRelation: input.nextOfKinRelation,
          status: "documents_review",
          onboardingStage: "documents_review",
          submittedAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      const createdDocuments = uploadedDocuments.length
        ? await tx
            .insert(merchantDocuments)
            .values(
              uploadedDocuments.map((document) => ({
                merchantId,
                documentType: document.documentType,
                originalName: document.originalName,
                mimeType: document.mimeType,
                sizeBytes: document.sizeBytes,
                googleDriveFileId: document.googleDriveFileId,
                googleDriveWebViewLink: document.googleDriveWebViewLink,
                googleDriveDownloadLink: document.googleDriveDownloadLink,
                googleDriveFolderId: document.googleDriveFolderId,
                status: "pending" as const,
                updatedAt: new Date(),
              })),
            )
            .returning()
        : [];

      const [docReviewQueue] = await tx
        .insert(queues)
        .values({
          name: "Documents Review",
          slug: "documents-review",
          prefix: "DR",
          qcEnabled: false,
        })
        .onConflictDoUpdate({
          target: queues.slug,
          set: {
            name: "Documents Review",
            prefix: "DR",
            qcEnabled: false,
          },
        })
        .returning({
          id: queues.id,
          name: queues.name,
          slug: queues.slug,
          prefix: queues.prefix,
          qcEnabled: queues.qcEnabled,
        });

      if (!docReviewQueue) {
        throw new AppError(500, "Failed to resolve documents review queue.");
      }

      const stages = await ensureQueueStages(tx, docReviewQueue);
      const initialStage = stages[0];

      if (!initialStage) {
        throw new AppError(500, "No initial stage configured for documents review queue.");
      }

      await tx
        .insert(queueCaseSequences)
        .values({
          queueId: docReviewQueue.id,
          lastNumber: 0,
        })
        .onConflictDoNothing();

      const [seqRow] = await tx
        .update(queueCaseSequences)
        .set({
          lastNumber: sql`${queueCaseSequences.lastNumber} + 1`,
        })
        .where(eq(queueCaseSequences.queueId, docReviewQueue.id))
        .returning({ lastNumber: queueCaseSequences.lastNumber });

      if (!seqRow) {
        throw new AppError(500, "Failed to generate documents review case number.");
      }

      const caseNumber = `${docReviewQueue.prefix}-${String(seqRow.lastNumber).padStart(9, "0")}`;
      const [createdCase] = await tx
        .insert(cases)
        .values({
          caseNumber,
          queueId: docReviewQueue.id,
          merchantId,
          ownerId: null,
          currentStageId: initialStage.id,
          status: "new",
          priority: createdMerchant.priority,
          updatedAt: new Date(),
        })
        .returning();

      if (!createdCase) {
        throw new AppError(500, "Failed to create documents review case.");
      }

      return {
        merchant: createdMerchant,
        documents: createdDocuments,
        case: createdCase,
      };
    });

    return {
      merchant: sanitizeMerchantRecord(result.merchant),
      documents: result.documents.map(sanitizeDocumentRecord),
      case: sanitizeCaseRecord(result.case),
    };
  } catch (error) {
    if (submissionFolderId) {
      await storage.deleteFile(submissionFolderId).catch((cleanupError) => {
        console.error("[merchant-submission.cleanup]", cleanupError);
      });
    }

    if (folderId) {
      await storage.deleteFile(folderId).catch((cleanupError) => {
        console.error("[merchant-submission.cleanup]", cleanupError);
      });
    }

    throw error;
  }
}

function buildFolderName(merchantId: string, businessName: string) {
  const slug = businessName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return `${slug || "merchant"}-${merchantId}`;
}

function buildDocumentFileName(documentType: MerchantDocumentType, originalName: string) {
  const extension = originalName.includes(".")
    ? `.${originalName.split(".").pop()?.toLowerCase()}`
    : "";

  return `${documentType}${extension}`;
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

// ─── List / Update / Delete ─────────────────────────────────────────────────

const sortColumnMap = {
  merchantNumber: {
    expression: merchants.merchantNumber,
    kind: "number",
  },
  businessName: {
    expression: sql`lower(${merchants.businessName})`,
    kind: "string",
  },
  onboardingStage: {
    expression: merchants.onboardingStage,
    kind: "string",
  },
  status: {
    expression: merchants.status,
    kind: "string",
  },
  priority: {
    expression: merchants.priority,
    kind: "string",
  },
  createdAt: {
    expression: merchants.createdAt,
    kind: "date",
  },
  businessScope: {
    expression: merchants.businessScope,
    kind: "string",
  },
} as const;

export async function listMerchants(query: ListMerchantsQuery) {
  const db = getDb();
  const conditions = [isNull(merchants.deletedAt)];

  if (query.search) {
    const term = `%${query.search}%`;
    const numericSearch = Number(query.search);
    const searchConditions = [
      ilike(merchants.businessName, term),
      ilike(merchants.submitterEmail, term),
    ];
    if (!Number.isNaN(numericSearch) && Number.isInteger(numericSearch)) {
      searchConditions.push(eq(merchants.merchantNumber, numericSearch));
    }
    conditions.push(or(...searchConditions)!);
  }

  if (query.onboardingStage) {
    const stages = parseCsvValues<MerchantStatusValue>(
      query.onboardingStage,
      merchantStatusValueSet,
    );
    if (stages.length > 0) {
      conditions.push(inArray(merchants.onboardingStage, stages));
    }
  }

  if (query.priority) {
    const priorities = parseCsvValues<PriorityValue>(query.priority, priorityValueSet);
    if (priorities.length > 0) {
      conditions.push(inArray(merchants.priority, priorities));
    }
  }

  if (query.currency) {
    const currencies = query.currency.split(",").filter(Boolean);
    if (currencies.length > 0) {
      conditions.push(
        inArray(merchants.currency, currencies as [string, ...string[]]),
      );
    }
  }

  if (query.businessScope) {
    const scopes = parseCsvValues<BusinessScopeValue>(
      query.businessScope,
      businessScopeValueSet,
    );
    if (scopes.length > 0) {
      conditions.push(inArray(merchants.businessScope, scopes));
    }
  }

  if (query.createdAtFrom) {
    const fromDate = new Date(query.createdAtFrom);
    if (!Number.isNaN(fromDate.getTime())) {
      conditions.push(gt(merchants.createdAt, fromDate));
    }
  }

  if (query.createdAtTo) {
    const toDate = new Date(query.createdAtTo);
    if (!Number.isNaN(toDate.getTime())) {
      conditions.push(lt(merchants.createdAt, toDate));
    }
  }

  const orderFn = query.sortOrder === "desc" ? desc : asc;
  const sortSpec = sortColumnMap[query.sortBy] ?? sortColumnMap.merchantNumber;
  const cursor = query.cursor
    ? decodeKeysetCursor(query.cursor, {
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        kind: sortSpec.kind,
      })
    : null;

  if (cursor) {
    conditions.push(
      buildKeysetCondition({
        expression: sortSpec.expression,
        idExpression: merchants.id,
        sortOrder: query.sortOrder,
        value: cursor.value,
        id: cursor.id,
      }),
    );
  }

  const where = and(...conditions);
  const rows = await db
    .select({
      id: merchants.id,
      merchantNumber: merchants.merchantNumber,
      businessName: merchants.businessName,
      onboardingStage: merchants.onboardingStage,
      status: merchants.status,
      priority: merchants.priority,
      priorityNote: merchants.priorityNote,
      createdAt: merchants.createdAt,
      currency: merchants.currency,
      businessScope: merchants.businessScope,
      liveAt: merchants.liveAt,
      cursorValue: sortSpec.expression,
    })
    .from(merchants)
    .where(where)
    .orderBy(orderFn(sortSpec.expression), orderFn(merchants.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor =
    hasMore && pageRows.length > 0
      ? encodeKeysetCursor({
          sortBy: query.sortBy,
          sortOrder: query.sortOrder,
          value: pageRows[pageRows.length - 1]!.cursorValue,
          id: pageRows[pageRows.length - 1]!.id,
        })
      : null;
  const items = pageRows.map((pageRow) => {
    const row = { ...pageRow };
    delete (row as { cursorValue?: unknown }).cursorValue;
    return row;
  });

  return {
    merchants: items,
    nextCursor,
    hasMore,
    limit: query.limit,
  };
}

export async function updateMerchantPriority(
  merchantId: string,
  input: UpdatePriorityInput,
) {
  const db = getDb();

  const [updated] = await db.transaction(async (tx) => {
    const now = new Date();
    const updatedRows = await tx
      .update(merchants)
      .set({
        priority: input.priority,
        priorityNote: input.note,
        updatedAt: now,
      })
      .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
      .returning({
        id: merchants.id,
        priority: merchants.priority,
        priorityNote: merchants.priorityNote,
      });

    if (updatedRows.length > 0) {
      await tx
        .update(cases)
        .set({ priority: input.priority, updatedAt: now })
        .where(eq(cases.merchantId, merchantId));
    }

    return updatedRows;
  });

  if (!updated) {
    throw new AppError(404, "Merchant not found.");
  }

  return updated;
}

export async function softDeleteMerchant(merchantId: string) {
  const db = getDb();

  const [deleted] = await db
    .update(merchants)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id });

  if (!deleted) {
    throw new AppError(404, "Merchant not found.");
  }

  return deleted;
}

export async function bulkSoftDeleteMerchants(ids: string[]) {
  const db = getDb();

  const result = await db
    .update(merchants)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(merchants.id, ids), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id });

  return { deletedCount: result.length };
}

export async function bulkUpdatePriority(
  ids: string[],
  priority: UpdatePriorityInput["priority"],
) {
  const db = getDb();

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const updatedRows = await tx
      .update(merchants)
      .set({
        priority,
        updatedAt: now,
      })
      .where(and(inArray(merchants.id, ids), isNull(merchants.deletedAt)))
      .returning({ id: merchants.id });

    const updatedIds = updatedRows.map((row) => row.id);
    if (updatedIds.length > 0) {
      await tx
        .update(cases)
        .set({ priority, updatedAt: now })
        .where(inArray(cases.merchantId, updatedIds));
    }

    return updatedRows;
  });

  return { updatedCount: result.length };
}
