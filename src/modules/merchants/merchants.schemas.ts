import { z } from "zod";

import { AppError } from "../../lib/errors";

export const merchantTypes = [
  "sole_proprietorship",
  "private_limited_company",
  "partnership",
  "limited_liability_partnership",
  "ngo_npo_charity",
  "trust_society_association",
] as const;

export const websiteCmsValues = [
  "wordpress",
  "shopify",
  "custom_website",
] as const;

export const kinRelations = [
  "mother",
  "father",
  "brother",
  "sister",
  "wife",
  "son",
  "daughter",
] as const;

export const baseDocumentTypes = [
  "owner_cnic_front",
  "owner_cnic_back",
  "next_of_kin_cnic_front",
  "next_of_kin_cnic_back",
  "utility_bill",
] as const;

export const merchantSpecificDocumentMap = {
  sole_proprietorship: {
    required: ["company_ntn"],
    optional: ["authority_letter", "taxpayer_registration_certificate"],
  },
  private_limited_company: {
    required: ["company_ntn", "company_incorporation_certificate"],
    optional: [
      "memorandum_articles",
      "form_ii",
      "form_a",
      "board_resolution",
      "certificate_of_commencement",
    ],
  },
  partnership: {
    required: ["company_ntn"],
    optional: ["authority_letter", "partnership_deed", "form_c"],
  },
  limited_liability_partnership: {
    required: ["company_ntn", "company_incorporation_certificate"],
    optional: ["authority_letter", "partnership_deed", "llp_form_iii"],
  },
  ngo_npo_charity: {
    required: ["company_ntn", "company_incorporation_certificate"],
    optional: [
      "memorandum_articles",
      "form_ii",
      "form_a",
      "board_resolution",
      "annual_audited_accounts",
      "other_entity_certification",
      "secp_section_42_license",
      "risk_assessment_documents",
      "by_laws_rules_regulations",
    ],
  },
  trust_society_association: {
    required: ["company_ntn"],
    optional: [
      "board_resolution",
      "annual_audited_accounts",
      "other_entity_certification",
    ],
  },
} as const satisfies Record<
  (typeof merchantTypes)[number],
  {
    required: readonly string[];
    optional: readonly string[];
  }
>;

export const allDocumentTypes = [
  ...baseDocumentTypes,
  ...new Set(
    Object.values(merchantSpecificDocumentMap).flatMap((definition) => [
      ...definition.required,
      ...definition.optional,
    ]),
  ),
] as const;

export type MerchantType = (typeof merchantTypes)[number];
export type WebsiteCms = (typeof websiteCmsValues)[number];
export type KinRelation = (typeof kinRelations)[number];
export type MerchantDocumentType = (typeof allDocumentTypes)[number];

const documentTypeSet = new Set<string>(allDocumentTypes);

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_COUNT = allDocumentTypes.length;

export const allowedFileMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const allowedFileExtensions = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "webp",
] as const;

const extensionToMimeType: Record<string, (typeof allowedFileMimeTypes)[number]> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export const bankNames = [
  "Advans Microfinance Bank",
  "Al Baraka Islamic Bank Limited",
  "Bank AlFalah Limited",
  "Allied Bank Limited",
  "Apna Microfinance Bank",
  "Askari Commercial Bank Limited",
  "Bank of Khyber",
  "Bank Islami Pakistan Limited",
  "Burj Bank Limited",
  "Citi Bank",
  "Dubai Islamic Bank Pakistan Limited",
  "FINCA",
  "Finja",
  "First Women Bank",
  "Faysal Bank Limited",
  "Habib Bank Limited",
  "Habib Metropolitan Bank",
  "ICBC",
  "JS Bank",
  "KASB Bank",
  "MCB Bank Limited",
  "MCB Arif Habib",
  "MCB Islamic Bank",
  "Meezan Bank",
  "Mobilink Microfinance Bank",
  "NayaPay",
  "National Bank of Pakistan",
  "NIB Bank",
  "NRSP Bank Fori Cash",
  "Paymax",
  "Sadapay",
  "Standard Chartered Bank",
  "Samba Bank",
  "Silkbank",
  "Sindh Bank",
  "Soneri Bank Limited",
  "Summit Bank",
  "TAG",
  "United Bank Limited",
  "Upaisa",
  "ZTBL",
  "EasyPaisa",
  "JazzCash",
] as const;

const sanitizedStringSchema = z
  .string()
  .trim()
  .min(1, "This field is required.")
  .transform(sanitizeText);

const trimmedStringSchema = z.string().trim().min(1, "This field is required.");

const scalarMerchantSchema = z
  .object({
    email: z.string().trim().email("Submitter email must be a valid email.").transform(toLower),
    ownerFullName: sanitizedStringSchema,
    ownerPhone: trimmedStringSchema,
    businessName: sanitizedStringSchema,
    businessPhone: trimmedStringSchema,
    businessEmail: z.string().trim().email("Business email must be a valid email.").transform(toLower),
    businessAddress: sanitizedStringSchema,
    businessWebsite: z.string().trim().url("Business website must be a valid URL."),
    websiteCms: z.enum(websiteCmsValues),
    businessDescription: sanitizedStringSchema,
    businessRegistrationDate: z
      .string()
      .trim()
      .refine((value) => !Number.isNaN(Date.parse(value)), "Business registration date is invalid.")
      .refine((value) => {
        const date = new Date(value);
        const today = new Date();
        today.setHours(23, 59, 59, 999);
        return date <= today;
      }, "Business registration date cannot be in the future.")
      .transform((value) => new Date(value).toISOString().slice(0, 10)),
    businessNature: sanitizedStringSchema,
    merchantType: z.enum(merchantTypes),
    estimatedMonthlyTransactions: z.coerce
      .number()
      .int("Estimated monthly transactions must be a whole number.")
      .positive("Estimated monthly transactions must be greater than zero."),
    estimatedMonthlyVolume: z.coerce
      .number()
      .positive("Estimated monthly volume must be greater than zero.")
      .transform((value) => value.toFixed(2)),
    accountTitle: sanitizedStringSchema,
    bankName: z.enum(bankNames),
    branchName: sanitizedStringSchema,
    accountNumberIban: trimmedStringSchema,
    swiftCode: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? value : null)),
    nextOfKinRelation: z.enum(kinRelations),
  })
  .strict();

export type MerchantFormValues = z.infer<typeof scalarMerchantSchema>;

export type UploadedMerchantDocument = {
  documentType: MerchantDocumentType;
  file: File;
  mimeType: (typeof allowedFileMimeTypes)[number];
  sizeBytes: number;
};

export type MerchantFormSubmission = MerchantFormValues & {
  documents: UploadedMerchantDocument[];
};

export function parseMerchantFormData(formData: FormData): MerchantFormSubmission {
  const scalarValues: Record<string, string> = {};
  const files = new Map<MerchantDocumentType, UploadedMerchantDocument>();

  for (const key of scalarMerchantSchema.keyof().options) {
    const values = formData.getAll(key);

    if (values.length > 1) {
      throw new AppError(400, `Field "${key}" must be provided once.`);
    }

    const value = values[0];

    if (typeof value !== "string") {
      throw new AppError(400, `Field "${key}" must be a text value.`);
    }

    scalarValues[key] = value;
  }

  const expectedScalarKeys = new Set<string>(scalarMerchantSchema.keyof().options);

  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") {
      if (!expectedScalarKeys.has(key)) {
        throw new AppError(400, `Unexpected field "${key}".`);
      }

      continue;
    }

    if (!documentTypeSet.has(key)) {
      throw new AppError(400, `Unexpected file field "${key}".`);
    }

    const allValues = formData.getAll(key);

    if (allValues.length > 1) {
      throw new AppError(400, `Document "${key}" must be uploaded once.`);
    }

    const file = allValues[0];

    if (!(file instanceof File)) {
      throw new AppError(400, `Document "${key}" is invalid.`);
    }

    const documentType = key as MerchantDocumentType;

    if (file.size === 0) {
      continue;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new AppError(413, `Document "${key}" exceeds the 10 MB limit.`);
    }

    const mimeType = normalizeMimeType(file);
    files.set(documentType, {
      documentType,
      file,
      mimeType,
      sizeBytes: file.size,
    });
  }

  if (files.size === 0) {
    throw new AppError(400, "At least one document upload is required.");
  }

  if (files.size > MAX_FILE_COUNT) {
    throw new AppError(400, "Too many documents uploaded.");
  }

  const parsedValues = scalarMerchantSchema.safeParse(scalarValues);

  if (!parsedValues.success) {
    throw new AppError(400, parsedValues.error.issues[0]?.message ?? "Invalid merchant form payload.");
  }

  assertRequiredDocuments(parsedValues.data.merchantType, files);

  return {
    ...parsedValues.data,
    documents: Array.from(files.values()),
  };
}

export function getRequiredDocumentTypes(merchantType: MerchantType) {
  return [
    ...baseDocumentTypes,
    ...merchantSpecificDocumentMap[merchantType].required,
  ] as MerchantDocumentType[];
}

export function getAllowedDocumentTypes(merchantType: MerchantType) {
  return [
    ...baseDocumentTypes,
    ...merchantSpecificDocumentMap[merchantType].required,
    ...merchantSpecificDocumentMap[merchantType].optional,
  ] as MerchantDocumentType[];
}

function assertRequiredDocuments(
  merchantType: MerchantType,
  files: Map<MerchantDocumentType, UploadedMerchantDocument>,
) {
  const allowedDocumentTypes = new Set(getAllowedDocumentTypes(merchantType));

  for (const documentType of files.keys()) {
    if (!allowedDocumentTypes.has(documentType)) {
      throw new AppError(
        400,
        `Document "${documentType}" is not allowed for merchant type "${merchantType}".`,
      );
    }
  }

  for (const documentType of getRequiredDocumentTypes(merchantType)) {
    if (!files.has(documentType)) {
      throw new AppError(400, `Document "${documentType}" is required.`);
    }
  }
}

function normalizeMimeType(file: File) {
  if (allowedFileMimeTypes.includes(file.type as (typeof allowedFileMimeTypes)[number])) {
    return file.type as (typeof allowedFileMimeTypes)[number];
  }

  const extension = file.name.split(".").pop()?.toLowerCase();

  if (!extension || !(extension in extensionToMimeType)) {
    throw new AppError(415, `Document "${file.name}" has an unsupported file type.`);
  }

  return extensionToMimeType[extension];
}

function sanitizeText(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function toLower(value: string) {
  return value.toLowerCase();
}

// ─── List / Update / Delete Schemas ─────────────────────────────────────────

export const merchantStatusValues = [
  "form_submitted",
  "documents_review",
  "sub_merchant",
  "agreement",
  "testing",
  "live",
  "suspended",
] as const;

export const priorityValues = ["normal", "high"] as const;
export const businessScopeValues = ["local", "international"] as const;
export type MerchantStatusValue = (typeof merchantStatusValues)[number];
export type PriorityValue = (typeof priorityValues)[number];
export type BusinessScopeValue = (typeof businessScopeValues)[number];

export const sortableColumns = [
  "merchantNumber",
  "businessName",
  "onboardingStage",
  "status",
  "priority",
  "createdAt",
  "businessScope",
] as const;

export const listMerchantsQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
  onboardingStage: z.string().optional(),
  priority: z.string().optional(),
  currency: z.string().optional(),
  businessScope: z.string().optional(),
  createdAtFrom: z.string().optional(),
  createdAtTo: z.string().optional(),
  sortBy: z.enum(sortableColumns).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

export type ListMerchantsQuery = z.infer<typeof listMerchantsQuerySchema>;

export const updatePrioritySchema = z.object({
  priority: z.enum(priorityValues),
  note: z.string().trim().max(500).optional().transform((v) => v || null),
});

export type UpdatePriorityInput = z.infer<typeof updatePrioritySchema>;

export const bulkIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
});
export type BulkIdsInput = z.infer<typeof bulkIdsSchema>;

export const bulkPrioritySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(100),
  priority: z.enum(priorityValues),
});
export type BulkPriorityInput = z.infer<typeof bulkPrioritySchema>;
