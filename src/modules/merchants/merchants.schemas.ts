import * as z from 'zod'

import { AppError } from '../../lib/errors'
import {
  MAX_FILE_SIZE_BYTES,
  assertFileSizeLimit,
} from '../../lib/storage/file-limits'
import { assertFileContentSignature } from '../../lib/storage/file-signatures'

export const merchantTypes = [
  'sole_proprietorship',
  'private_limited_company',
  'public_limited_company',
  'partnership',
  'limited_liability_partnership',
  'ngo_npo_charity',
  'trust_society_association',
] as const

export const websiteCmsValues = [
  'wordpress',
  'shopify',
  'custom_website',
] as const

export const kinRelations = [
  'mother',
  'father',
  'brother',
  'sister',
  'spouse',
  'son',
  'daughter',
] as const

export const baseDocumentTypes = [
  'owner_cnic_front',
  'owner_cnic_back',
  'next_of_kin_cnic_front',
  'next_of_kin_cnic_back',
  'utility_bill',
] as const

export const merchantSpecificDocumentMap = {
  sole_proprietorship: {
    required: ['company_ntn'],
    optional: ['authority_letter', 'taxpayer_registration_certificate'],
  },
  private_limited_company: {
    required: ['company_ntn', 'company_incorporation_certificate', 'form_a'],
    optional: [
      'memorandum_articles',
      'form_ii',
      'board_resolution',
      'certificate_of_commencement',
    ],
  },
  public_limited_company: {
    required: ['company_ntn', 'company_incorporation_certificate'],
    optional: [
      'memorandum_articles',
      'form_ii',
      'form_a',
      'board_resolution',
      'certificate_of_commencement',
    ],
  },
  partnership: {
    required: ['company_ntn'],
    optional: ['authority_letter', 'partnership_deed', 'form_c'],
  },
  limited_liability_partnership: {
    required: ['company_ntn', 'company_incorporation_certificate'],
    optional: ['authority_letter', 'partnership_deed', 'llp_form_iii'],
  },
  ngo_npo_charity: {
    required: ['company_ntn', 'company_incorporation_certificate'],
    optional: [
      'memorandum_articles',
      'form_ii',
      'form_a',
      'board_resolution',
      'annual_audited_accounts',
      'other_entity_certification',
      'secp_section_42_license',
      'risk_assessment_documents',
      'by_laws_rules_regulations',
    ],
  },
  trust_society_association: {
    required: [
      'company_ntn',
      'board_resolution',
      'annual_audited_accounts',
      'trust_deed',
      'trust_registration_certificate',
      'trustees_authorized_signatories_cnic',
      'proof_of_address',
    ],
    optional: ['tax_exemption_certificate', 'other_supporting_documents'],
  },
} as const satisfies Record<
  (typeof merchantTypes)[number],
  {
    required: readonly string[]
    optional: readonly string[]
  }
>

export const allDocumentTypes = [
  ...baseDocumentTypes,
  ...new Set(
    Object.values(merchantSpecificDocumentMap).flatMap((definition) => [
      ...definition.required,
      ...definition.optional,
    ]),
  ),
  'trust_deed',
  'trust_registration_certificate',
  'trustees_authorized_signatories_cnic',
  'proof_of_address',
  'tax_exemption_certificate',
  'other_supporting_documents',
] as const

export type MerchantType = (typeof merchantTypes)[number]
export type MerchantDocumentType = (typeof allDocumentTypes)[number]

const documentTypeSet = new Set<string>(allDocumentTypes)

export { MAX_FILE_SIZE_BYTES }
export const MAX_FILE_COUNT = allDocumentTypes.length

export const allowedFileMimeTypes = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const

const extensionToMimeType: Record<
  string,
  (typeof allowedFileMimeTypes)[number]
> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export const bankNames = [
  'Al Baraka Islamic Bank Limited',
  'Bank AlFalah Limited',
  'Bank Al Habib',
  'Allied Bank Limited',
  'Askari Commercial Bank Limited',
  'Bank of Khyber',
  'Bank Islami Pakistan Limited',
  'Burj Bank Limited',
  'Citi Bank',
  'Dubai Islamic Bank Pakistan Limited',
  'Faysal Bank Limited',
  'Habib Bank Limited',
  'Habib Metropolitan Bank',
  'JS Bank',
  'KASB Bank',
  'MCB Bank Limited',
  'MCB Islamic Bank',
  'Meezan Bank',
  'National Bank of Pakistan',
  'NIB Bank',
  'Standard Chartered Bank',
  'Samba Bank',
  'Silkbank',
  'Sindh Bank',
  'Soneri Bank Limited',
  'Summit Bank',
  'United Bank Limited',
] as const

const trimmedStringSchema = z.string().trim().min(1, 'This field is required.')

function boundedTextSchema(label: string, maxLength: number) {
  return trimmedStringSchema.max(
    maxLength,
    `${label} must be ${maxLength} characters or fewer.`,
  )
}

// Domains reserved for documentation and testing (RFC 2606); no real business
// or mailbox can use them.
function isReservedDomain(domain: string) {
  const normalized = domain.toLowerCase().replace(/\.$/, '')
  return (
    /(^|\.)example\.(com|net|org)$/.test(normalized) ||
    /\.(example|test|invalid|localhost)$/.test(normalized)
  )
}

function submitterEmailSchema(requiredMessage: string) {
  return z
    .string()
    .trim()
    .max(255, 'Email must be 255 characters or fewer.')
    .pipe(z.email(requiredMessage))
    .transform(toLower)
    .refine(
      (value) => !isReservedDomain(value.split('@')[1] ?? ''),
      'Please use a real email address.',
    )
}

function isPrivateIpv4(hostname: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname)
  if (!match) return false

  const first = Number(match[1])
  const second = Number(match[2])
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  )
}

// Staff open this link from the review screens, so it must be a public website:
// no script or file URLs, and nothing pointing at an internal network.
function isPublicWebsiteUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    !url.username &&
    !url.password &&
    hostname.includes('.') &&
    // URL normalizes every IPv4 spelling to dotted form; IPv6 keeps brackets.
    !hostname.startsWith('[') &&
    !isPrivateIpv4(hostname) &&
    !isReservedDomain(hostname) &&
    !/\.(local|internal)$/.test(hostname)
  )
}

const bareDomainPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#].*)?$/i
const storedBusinessWebsiteSchema = z
  .string()
  .trim()
  .max(500, 'Business website must be 500 characters or fewer.')
  .transform((value) =>
    bareDomainPattern.test(value) ? `https://${value}` : value,
  )
  .pipe(z.url('Business website must be a valid URL.'))
export const businessWebsiteSchema = storedBusinessWebsiteSchema.refine(
  isPublicWebsiteUrl,
  'Business website must be a public http or https website.',
)
export const localMobileNumberSchema = z
  .string()
  .trim()
  .regex(/^03\d{9}$/, 'Must be a valid mobile number.')
export const digitsOnlyPhoneNumberSchema = z
  .string()
  .trim()
  .min(1, 'Business phone number is required.')
  .max(32, 'Business phone number must be 32 digits or fewer.')
  .regex(/^\d+$/, 'Business phone number must contain numbers only.')

export const scalarMerchantSchema = z.strictObject({
  email: submitterEmailSchema('Submitter email must be a valid email.'),
  activeWhatsappNumber: localMobileNumberSchema,
  ownerFullName: boundedTextSchema('Owner full name', 160),
  ownerPhone: localMobileNumberSchema,
  businessName: boundedTextSchema('Business name', 200),
  businessPhone: digitsOnlyPhoneNumberSchema,
  businessEmail: submitterEmailSchema('Business email must be a valid email.'),
  businessAddress: boundedTextSchema('Business address', 1000),
  businessWebsite: businessWebsiteSchema,
  websiteCms: z.enum(websiteCmsValues),
  businessDescription: boundedTextSchema('Business description', 5000),
  businessRegistrationDate: z
    .string()
    .trim()
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      'Business registration date is invalid.',
    )
    .refine((value) => {
      const date = new Date(value)
      const today = new Date()
      today.setHours(23, 59, 59, 999)
      return date <= today
    }, 'Business registration date cannot be in the future.')
    .transform((value) => new Date(value).toISOString().slice(0, 10)),
  businessNature: boundedTextSchema('Nature of business', 160),
  merchantType: z.enum(merchantTypes),
  estimatedMonthlyTransactions: z.coerce
    .number()
    .int('Estimated monthly transactions must be a whole number.')
    .positive('Estimated monthly transactions must be greater than zero.')
    .max(2_147_483_647, 'Estimated monthly transactions is too large.'),
  estimatedMonthlyVolume: z.coerce
    .number()
    .positive('Estimated monthly volume must be greater than zero.')
    .max(999_999_999_999.99, 'Estimated monthly volume is too large.')
    .transform((value) => value.toFixed(2)),
  accountTitle: boundedTextSchema('Account title', 200),
  bankName: z.enum(bankNames),
  branchName: boundedTextSchema('Branch name', 160),
  accountNumberIban: boundedTextSchema('Account number / IBAN', 64),
  swiftCode: z
    .string()
    .trim()
    .max(64, 'SWIFT code must be 64 characters or fewer.')
    .optional()
    .transform((value) => (value ? value : null)),
  nextOfKinRelation: z.enum(kinRelations),
})

export const storedMerchantScalarSchema = z.strictObject({
  submitterEmail: scalarMerchantSchema.shape.email,
  activeWhatsappNumber: localMobileNumberSchema.nullable(),
  ownerFullName: scalarMerchantSchema.shape.ownerFullName,
  ownerPhone: scalarMerchantSchema.shape.ownerPhone,
  businessName: scalarMerchantSchema.shape.businessName,
  businessPhone: scalarMerchantSchema.shape.businessPhone,
  businessEmail: scalarMerchantSchema.shape.businessEmail,
  businessAddress: scalarMerchantSchema.shape.businessAddress,
  // A resubmission re-checks stored values it did not change, so a website
  // accepted before the public-URL rule must not block it. Changed websites
  // are checked against businessWebsiteSchema by the resubmission route.
  businessWebsite: storedBusinessWebsiteSchema,
  websiteCms: scalarMerchantSchema.shape.websiteCms,
  businessDescription: scalarMerchantSchema.shape.businessDescription,
  businessRegistrationDate: scalarMerchantSchema.shape.businessRegistrationDate,
  businessNature: scalarMerchantSchema.shape.businessNature,
  merchantType: scalarMerchantSchema.shape.merchantType,
  estimatedMonthlyTransactions:
    scalarMerchantSchema.shape.estimatedMonthlyTransactions,
  estimatedMonthlyVolume: scalarMerchantSchema.shape.estimatedMonthlyVolume,
  accountTitle: scalarMerchantSchema.shape.accountTitle,
  bankName: scalarMerchantSchema.shape.bankName,
  branchName: scalarMerchantSchema.shape.branchName,
  accountNumberIban: scalarMerchantSchema.shape.accountNumberIban,
  swiftCode: scalarMerchantSchema.shape.swiftCode,
  nextOfKinRelation: scalarMerchantSchema.shape.nextOfKinRelation,
})

export type MerchantFormValues = z.infer<typeof scalarMerchantSchema>
export type UploadedMerchantDocument = {
  documentType: MerchantDocumentType
  file: File
  mimeType: (typeof allowedFileMimeTypes)[number]
  sizeBytes: number
}

export type MerchantFormSubmission = MerchantFormValues & {
  documents: UploadedMerchantDocument[]
}

export async function parseMerchantFormData(
  formData: FormData,
): Promise<MerchantFormSubmission> {
  const scalarValues: Record<string, string> = {}
  const files = new Map<MerchantDocumentType, UploadedMerchantDocument>()

  for (const key of scalarMerchantSchema.keyof().options) {
    const values = formData.getAll(key)

    if (values.length > 1) {
      throw new AppError(400, `Field "${key}" must be provided once.`)
    }

    // Optional fields may be omitted, matching the JSON schema.
    if (values.length === 0) {
      if (scalarMerchantSchema.shape[key].safeParse(undefined).success) {
        continue
      }
      throw new AppError(400, `Field "${key}" is required.`)
    }

    const value = values[0]

    if (typeof value !== 'string') {
      throw new AppError(400, `Field "${key}" must be a text value.`)
    }

    scalarValues[key] = value
  }

  const expectedScalarKeys = new Set<string>(
    scalarMerchantSchema.keyof().options,
  )

  for (const [key, value] of formData.entries()) {
    if (typeof value === 'string') {
      if (!expectedScalarKeys.has(key)) {
        throw new AppError(400, `Unexpected field "${key}".`)
      }

      continue
    }

    if (!documentTypeSet.has(key)) {
      throw new AppError(400, `Unexpected file field "${key}".`)
    }

    const allValues = formData.getAll(key)

    if (allValues.length > 1) {
      throw new AppError(400, `Document "${key}" must be uploaded once.`)
    }

    const file = allValues[0]

    if (!(file instanceof File)) {
      throw new AppError(400, `Document "${key}" is invalid.`)
    }

    const documentType = key as MerchantDocumentType

    if (file.size === 0) {
      continue
    }

    assertFileSizeLimit(file, `Document "${key}"`)
    assertPublicUploadFile(file, `Document "${key}"`)

    const mimeType = normalizeMimeType(file)
    await assertFileContentSignature({
      file,
      expectedMimeType: mimeType,
      label: key,
    })
    files.set(documentType, {
      documentType,
      file,
      mimeType,
      sizeBytes: file.size,
    })
  }

  if (files.size === 0) {
    throw new AppError(400, 'At least one document upload is required.')
  }

  if (files.size > MAX_FILE_COUNT) {
    throw new AppError(400, 'Too many documents uploaded.')
  }

  const parsedValues = scalarMerchantSchema.safeParse(scalarValues)

  if (!parsedValues.success) {
    throw new AppError(
      400,
      parsedValues.error.issues[0]?.message ?? 'Invalid merchant form payload.',
    )
  }

  assertRequiredDocuments(parsedValues.data.merchantType, files)

  return {
    ...parsedValues.data,
    documents: Array.from(files.values()),
  }
}

export function validateStoredMerchantScalarValues(
  values: Record<string, unknown>,
) {
  return storedMerchantScalarSchema.parse(values)
}

export function getRequiredDocumentTypes(merchantType: MerchantType) {
  return [
    ...baseDocumentTypes,
    ...merchantSpecificDocumentMap[merchantType].required,
  ] as MerchantDocumentType[]
}

export function getAllowedDocumentTypes(merchantType: MerchantType) {
  return [
    ...baseDocumentTypes,
    ...merchantSpecificDocumentMap[merchantType].required,
    ...merchantSpecificDocumentMap[merchantType].optional,
  ] as MerchantDocumentType[]
}

// ─── Per-Merchant Limits & MDR Override ─────────────────────────────────────

const limitRangeSchema = z
  .object({
    collectionMin: z.coerce.number().min(0),
    collectionMax: z.coerce.number().min(0),
    disbursementMin: z.coerce.number().min(0),
    disbursementMax: z.coerce.number().min(0),
  })
  .refine((value) => value.collectionMax >= value.collectionMin, {
    error: 'Collection maximum must be greater than or equal to the minimum.',
    path: ['collectionMax'],
  })
  .refine((value) => value.disbursementMax >= value.disbursementMin, {
    error: 'Disbursement maximum must be greater than or equal to the minimum.',
    path: ['disbursementMax'],
  })

export const merchantLimitsMdrSchema = z.object({
  testing: limitRangeSchema,
  live: limitRangeSchema,
  rates: z.object({
    eWallets: z.coerce.number().min(0).max(100),
    cardDefault: z.coerce.number().min(0).max(100),
    cardShopify: z.coerce.number().min(0).max(100),
    payout: z.coerce.number().min(0).max(100),
  }),
})

export type MerchantLimitsMdr = z.infer<typeof merchantLimitsMdrSchema>

function assertRequiredDocuments(
  merchantType: MerchantType,
  files: Map<MerchantDocumentType, UploadedMerchantDocument>,
) {
  const allowedDocumentTypes = new Set(getAllowedDocumentTypes(merchantType))

  for (const documentType of files.keys()) {
    if (!allowedDocumentTypes.has(documentType)) {
      throw new AppError(
        400,
        `Document "${documentType}" is not allowed for business type "${merchantType}".`,
      )
    }
  }

  for (const documentType of getRequiredDocumentTypes(merchantType)) {
    if (!files.has(documentType)) {
      throw new AppError(400, `Document "${documentType}" is required.`)
    }
  }
}

// Smaller than any real scan or PDF; the smallest genuine upload so far is 961 B.
const MIN_PUBLIC_FILE_SIZE_BYTES = 500
const MAX_FILE_NAME_LENGTH = 255

export function assertPublicUploadFile(file: File, label: string) {
  if (file.size < MIN_PUBLIC_FILE_SIZE_BYTES) {
    throw new AppError(
      400,
      `${label} is too small to be a valid document. Please upload a clear copy.`,
    )
  }

  if (file.name.length > MAX_FILE_NAME_LENGTH) {
    throw new AppError(
      400,
      `${label} has a file name longer than ${MAX_FILE_NAME_LENGTH} characters. Please rename it.`,
    )
  }

  if (/[/\\]/.test(file.name)) {
    throw new AppError(400, `${label} has an invalid file name.`)
  }
}

// The name is kept on the stored file, so its extension must be an allowed one
// and agree with the declared type: a valid PNG named ".htaccess" is refused.
export function normalizeMimeType(file: File) {
  const nameParts = file.name.split('.')
  const extension =
    nameParts.length > 1 ? nameParts.pop()?.toLowerCase() : undefined
  const extensionMimeType =
    extension && Object.hasOwn(extensionToMimeType, extension)
      ? extensionToMimeType[extension]
      : undefined

  if (!extensionMimeType) {
    throw new AppError(
      415,
      `Document "${file.name}" has an unsupported file type.`,
    )
  }

  if (
    allowedFileMimeTypes.includes(
      file.type as (typeof allowedFileMimeTypes)[number],
    ) &&
    file.type !== extensionMimeType
  ) {
    throw new AppError(
      415,
      `Document "${file.name}" does not match its declared file type.`,
    )
  }

  return extensionMimeType
}

function toLower(value: string) {
  return value.toLowerCase()
}

// ─── List / Update / Delete Schemas ─────────────────────────────────────────

export const merchantStatusValues = [
  'pending',
  'testing',
  'live',
  'terminated',
] as const

export const priorityValues = ['normal', 'high'] as const
export const businessScopeValues = ['local', 'international'] as const
export type MerchantStatusValue = (typeof merchantStatusValues)[number]
export type PriorityValue = (typeof priorityValues)[number]
export type BusinessScopeValue = (typeof businessScopeValues)[number]

export const sortableColumns = [
  'merchantNumber',
  'businessName',
  'status',
  'priority',
  'createdAt',
  'businessScope',
  'ownerFullName',
  'updatedAt',
] as const

export const listMerchantsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  search: z.string().trim().max(200).optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  currency: z.string().optional(),
  businessScope: z.string().optional(),
  createdAtFrom: z.string().optional(),
  createdAtTo: z.string().optional(),
  epStatus: z.string().optional(),
  sortBy: z.enum(sortableColumns).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

export type ListMerchantsQuery = z.infer<typeof listMerchantsQuerySchema>

export const updatePrioritySchema = z.object({
  priority: z.enum(priorityValues),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
})

export type UpdatePriorityInput = z.infer<typeof updatePrioritySchema>

export const bulkIdsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100),
})
export const bulkPrioritySchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100),
  priority: z.enum(priorityValues),
  note: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
})
export const terminateMerchantSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  deleteDriveFiles: z.boolean().default(false),
})
export type TerminateMerchantInput = z.infer<typeof terminateMerchantSchema>

export const permanentlyDeleteMerchantSchema = z.object({
  confirmation: z.string().trim().min(1).max(160),
})
export type PermanentlyDeleteMerchantInput = z.infer<
  typeof permanentlyDeleteMerchantSchema
>

export const bulkTerminateMerchantsSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
  deleteDriveFiles: z.boolean().default(false),
})
