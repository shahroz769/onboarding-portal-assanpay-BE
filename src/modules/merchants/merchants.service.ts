import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { merchantDocuments, merchants } from "../../db/schema";
import {
  GoogleDriveStorageProvider,
  type FileStorageProvider,
} from "../../lib/storage/google-drive";
import { AppError } from "../../lib/errors";
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

export async function createMerchantSubmission(
  input: MerchantFormSubmission,
  storage: FileStorageProvider = new GoogleDriveStorageProvider(),
) {
  const merchantId = crypto.randomUUID();
  let folderId: string | null = null;

  try {
    const folder = await storage.createMerchantFolder(buildFolderName(merchantId, input.businessName));
    folderId = folder.folderId;
    const uploadFolderId = folderId;

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
          status: "form_submitted",
          onboardingStage: "form_submitted",
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

      return {
        merchant: createdMerchant,
        documents: createdDocuments,
      };
    });

    return {
      merchant: sanitizeMerchantRecord(result.merchant),
      documents: result.documents.map(sanitizeDocumentRecord),
    };
  } catch (error) {
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

// ─── List / Update / Delete ─────────────────────────────────────────────────

const sortColumnMap = {
  merchantNumber: merchants.merchantNumber,
  businessName: merchants.businessName,
  onboardingStage: merchants.onboardingStage,
  status: merchants.status,
  priority: merchants.priority,
  createdAt: merchants.createdAt,
  businessScope: merchants.businessScope,
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

  const where = and(...conditions);

  // Cursor pagination: fetch items after the cursor
  if (query.cursor) {
    const cursorRow = await db.query.merchants.findFirst({
      where: eq(merchants.id, query.cursor),
      columns: {
        id: true,
        merchantNumber: true,
        businessName: true,
        onboardingStage: true,
        status: true,
        priority: true,
        createdAt: true,
        businessScope: true,
      },
    });

    if (cursorRow) {
      // Mirror the same sort expression used in ORDER BY below
      const sortCol =
        query.sortBy === "businessName"
          ? sql`lower(${merchants.businessName})`
          : sortColumnMap[query.sortBy] ?? merchants.createdAt;

      // Apply the same transformation to the cursor value
      const cursorSortValue: unknown =
        query.sortBy === "businessName"
          ? cursorRow.businessName.toLowerCase()
          : cursorRow[query.sortBy];

      if (query.sortOrder === "desc") {
        conditions.push(
          or(
            lt(sortCol, cursorSortValue),
            and(eq(sortCol, cursorSortValue), lt(merchants.id, cursorRow.id)),
          )!,
        );
      } else {
        conditions.push(
          or(
            gt(sortCol, cursorSortValue),
            and(eq(sortCol, cursorSortValue), gt(merchants.id, cursorRow.id)),
          )!,
        );
      }
    }
  }

  const orderFn = query.sortOrder === "desc" ? desc : asc;
  const sortCol = query.sortBy === "businessName"
    ? sql`lower(${merchants.businessName})`
    : sortColumnMap[query.sortBy] ?? merchants.createdAt;

  const [rows, [totalRow]] = await Promise.all([
    db
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
      })
      .from(merchants)
      .where(and(...conditions))
      .orderBy(orderFn(sortCol), orderFn(merchants.id))
      .limit(query.limit + 1),
    db
      .select({ count: count() })
      .from(merchants)
      .where(where),
  ]);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;

  return {
    merchants: items,
    nextCursor,
    totalCount: totalRow?.count ?? 0,
  };
}

export async function updateMerchantPriority(
  merchantId: string,
  input: UpdatePriorityInput,
) {
  const db = getDb();

  const [updated] = await db
    .update(merchants)
    .set({
      priority: input.priority,
      priorityNote: input.note,
      updatedAt: new Date(),
    })
    .where(and(eq(merchants.id, merchantId), isNull(merchants.deletedAt)))
    .returning({
      id: merchants.id,
      priority: merchants.priority,
      priorityNote: merchants.priorityNote,
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

  const result = await db
    .update(merchants)
    .set({
      priority,
      updatedAt: new Date(),
    })
    .where(and(inArray(merchants.id, ids), isNull(merchants.deletedAt)))
    .returning({ id: merchants.id });

  return { updatedCount: result.length };
}
