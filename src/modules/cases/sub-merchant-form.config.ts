export const SUB_MERCHANT_FORM_QUEUE_SLUG = 'sub-merchant-form'
export const SUB_MERCHANT_FORM_QUEUE_NAME = 'EP Sub-Merchant Form'
export const SUB_MERCHANT_FORM_QUEUE_PREFIX = 'SM'
export const SUB_MERCHANT_FINAL_FORM_KIND = 'sub_merchant_final_form'
export const SUB_MERCHANT_EMAIL_PROOF_KIND = 'sub_merchant_email_proof'

export const SUB_MERCHANT_FORM_OPTIONS = [
  {
    key: 'devtects',
    name: 'Devtects',
    draftUrl:
      'https://drive.google.com/open?id=1TAS9wWcEfXISRdTVuPhjUZs2gVM5sd27&usp=drive_copy',
  },
  {
    key: 'digifytive',
    name: 'Digifytive',
    draftUrl:
      'https://drive.google.com/open?id=1JTYSHQHg4iz8DYK9FDG2z2o_iWzCiYTr&usp=drive_copy',
  },
  {
    key: 'evolvica-solutions',
    name: 'Evolvica Solutions',
    draftUrl:
      'https://drive.google.com/open?id=1pYrQY4uWYCwPugCCNxRTWWAXI8V_gr21&usp=drive_copy',
  },
  {
    key: 'monic-tech',
    name: 'Monic Tech',
    draftUrl:
      'https://drive.google.com/open?id=1HpgKBmrEmcTQIhji5vkhiRHU8LrlK0lU&usp=drive_copy',
  },
] as const

export type SubMerchantFormOptionKey =
  (typeof SUB_MERCHANT_FORM_OPTIONS)[number]['key']

export function getSubMerchantFormOption(key: string) {
  return SUB_MERCHANT_FORM_OPTIONS.find((option) => option.key === key) ?? null
}
