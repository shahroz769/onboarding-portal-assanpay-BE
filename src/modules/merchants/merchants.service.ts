import { getDb } from "../../db/client";
import { merchantDocuments, merchants } from "../../db/schema";
import {
  GoogleDriveStorageProvider,
  type FileStorageProvider,
} from "../../lib/storage/google-drive";
import type {
  MerchantDocumentType,
  MerchantFormSubmission,
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

    const uploadedDocuments: UploadedDocumentRecord[] = [];

    for (const document of input.documents) {
      const upload = await storage.uploadFile(folderId, {
        fileName: buildDocumentFileName(document.documentType, document.file.name),
        mimeType: document.mimeType,
        file: document.file,
      });

      uploadedDocuments.push({
        documentType: document.documentType,
        originalName: document.file.name,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        googleDriveFileId: upload.fileId,
        googleDriveWebViewLink: upload.webViewLink,
        googleDriveDownloadLink: upload.downloadLink,
        googleDriveFolderId: upload.folderId,
      });
    }

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
