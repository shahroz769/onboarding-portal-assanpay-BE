import type { MerchantDocumentType } from "../merchants/merchants.schemas";

/**
 * Stable backend mapping of merchant text-field keys to human-readable labels.
 * Mirrors the labels used in the frontend documents-review UI.
 */
export const MERCHANT_FIELD_LABELS: Record<string, string> = {
  submitterEmail: "Submitter Email",
  ownerFullName: "Owner Full Name",
  ownerPhone: "Owner Phone Number",
  businessName: "Business Name",
  businessPhone: "Business Phone Number",
  businessEmail: "Business Email",
  businessWebsite: "Business Website",
  businessAddress: "Business Address",
  websiteCms: "Website Platform / CMS",
  businessRegistrationDate: "Business Registration Date",
  businessDescription: "Business Description",
  businessNature: "Nature of Business",
  merchantType: "Merchant Type",
  estimatedMonthlyTransactions: "Estimated Monthly Transactions",
  estimatedMonthlyVolume: "Estimated Monthly Volume (PKR)",
  accountTitle: "Account Title",
  bankName: "Bank Name",
  branchName: "Branch Name",
  accountNumberIban: "Account Number / IBAN",
  swiftCode: "SWIFT Code",
  nextOfKinRelation: "Next of Kin Relation",
};

/**
 * Backend mapping of `merchantDocuments.documentType` values to human labels.
 */
export const DOCUMENT_TYPE_LABELS: Record<MerchantDocumentType, string> = {
  owner_cnic_front: "Owner CNIC Front",
  owner_cnic_back: "Owner CNIC Back",
  next_of_kin_cnic_front: "Next Of Kin CNIC Front",
  next_of_kin_cnic_back: "Next Of Kin CNIC Back",
  utility_bill: "Utility Bill",
  company_ntn: "Company NTN",
  authority_letter: "Authority Letter",
  taxpayer_registration_certificate: "Taxpayer Registration Certificate",
  company_incorporation_certificate: "Company Incorporation Certificate",
  memorandum_articles: "Memorandum & Articles",
  form_ii: "Form II",
  form_a: "Form A",
  board_resolution: "Board Resolution",
  certificate_of_commencement: "Certificate Of Commencement",
  partnership_deed: "Partnership Deed",
  form_c: "Form C",
  llp_form_iii: "LLP Form III",
  annual_audited_accounts: "Annual Audited Accounts",
  other_entity_certification: "Other Entity Certification",
  secp_section_42_license: "SECP Section 42 License",
  risk_assessment_documents: "Risk Assessment Documents",
  by_laws_rules_regulations: "By Laws / Rules / Regulations",
};

/** Document field-review keys are stored as `doc_${merchantDocuments.id}`. */
export const DOCUMENT_FIELD_PREFIX = "doc_";

export function isDocumentFieldName(fieldName: string): boolean {
  return fieldName.startsWith(DOCUMENT_FIELD_PREFIX);
}

export function getDocumentIdFromFieldName(fieldName: string): string | null {
  if (!isDocumentFieldName(fieldName)) return null;
  return fieldName.slice(DOCUMENT_FIELD_PREFIX.length) || null;
}

export function isMerchantFieldName(fieldName: string): boolean {
  return Object.prototype.hasOwnProperty.call(MERCHANT_FIELD_LABELS, fieldName);
}
