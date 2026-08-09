import { caseStatusValues } from './cases.schemas'

export const caseStatusValueSet = new Set<string>(caseStatusValues)
export const MAX_SUB_MERCHANT_FINAL_FORM_BYTES = 1024 * 1024
export const SUB_MERCHANT_FINAL_FORM_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
])
export const SUB_MERCHANT_FINAL_FORM_EXTENSIONS = new Set(['.pdf', '.doc', '.docx'])
export const AGREEMENT_FILE_MIME_TYPES = SUB_MERCHANT_FINAL_FORM_MIME_TYPES
export const AGREEMENT_FILE_EXTENSIONS = SUB_MERCHANT_FINAL_FORM_EXTENSIONS
export const WORDPRESS_SCREENSHOT_FILE_KIND_PREFIX = 'wordpress_screenshot_'
export const WORDPRESS_SUB_MERCHANT_LOGO_SCREENSHOT_FILE_KIND_PREFIX =
  'wordpress_sub_merchant_logo_screenshot_'
export const WORDPRESS_ASSANPAY_CHECKOUT_SCREENSHOT_FILE_KIND_PREFIX =
  'wordpress_assanpay_checkout_screenshot_'
export const RESUBMISSION_EMAIL_PROOF_KIND = 'resubmission_email_proof'
export const AGREEMENT_EMAIL_PROOF_KIND = 'agreement_email_proof'
export const MID_CREATION_EMAIL_PROOF_KIND = 'mid_creation_email_proof'
export const LIVE_ACTIVATION_EMAIL_PROOF_KIND = 'live_activation_email_proof'
export const RESUBMISSION_WHATSAPP_PROOF_KIND = 'resubmission_whatsapp_proof'
export const AGREEMENT_WHATSAPP_PROOF_KIND = 'agreement_whatsapp_proof'
export const MID_CREATION_WHATSAPP_PROOF_KIND = 'mid_creation_whatsapp_proof'
export const LIVE_ACTIVATION_WHATSAPP_PROOF_KIND = 'live_activation_whatsapp_proof'
export const EMAIL_PROOF_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
export const DOCUMENT_REVIEW_RESUBMISSION_SENT_ACTIONS = [
  'resubmission_email_sent',
  'resubmission_email_sent_manual',
  'resubmission_whatsapp_sent_manual',
] as const
export const MID_CREATION_CREDENTIALS_SENT_ACTIONS = [
  'mid_creation_email_sent',
  'mid_creation_email_sent_manual',
  'mid_creation_whatsapp_sent_manual',
] as const
export type ManualCommunicationChannel = 'email' | 'whatsapp'
export const PHYSICAL_AGREEMENT_FILE_KIND = 'physical_agreement_scanned_copy'
export const MAX_PHYSICAL_AGREEMENT_BYTES = 10 * 1024 * 1024
export const PHYSICAL_AGREEMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])
export const PHYSICAL_AGREEMENT_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
])
export const MAX_WORDPRESS_SCREENSHOT_BYTES = 10 * 1024 * 1024
export const WORDPRESS_SCREENSHOT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
])
export const WORDPRESS_SCREENSHOT_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
])
