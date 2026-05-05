export const AGREEMENT_QUEUE_SLUG = 'agreement'
export const AGREEMENT_FINAL_FILE_KIND = 'agreement_final'
export const AGREEMENT_CLIENT_FILE_KIND = 'agreement_client_submission'

export const AGREEMENT_DRAFTS = {
  company: {
    key: 'company',
    label: 'Company',
    draftUrl:
      'https://drive.google.com/open?id=1r18t9rOwwwudy6QcVDTDL0JASqHJ171x&usp=drive_copy',
  },
  individual: {
    key: 'individual',
    label: 'Individual',
    draftUrl:
      'https://drive.google.com/open?id=1AOLiNFtPEVl0dnU98QfueEhqqUzXw0Uc&usp=drive_copy',
  },
  ngo: {
    key: 'ngo',
    label: 'NGO',
    draftUrl:
      'https://drive.google.com/open?id=11EuILyJSszkO-9OT5bPMy5NBgVBlUJyA&usp=drive_copy',
  },
} as const

export type AgreementDraftKey = keyof typeof AGREEMENT_DRAFTS

const individualMerchantTypes = new Set(['sole_proprietorship'])
const ngoMerchantTypes = new Set([
  'ngo_npo_charity',
  'trust_society_association',
])

export function getAgreementDraftForMerchantType(
  merchantType: string,
): (typeof AGREEMENT_DRAFTS)[AgreementDraftKey] {
  if (individualMerchantTypes.has(merchantType)) {
    return AGREEMENT_DRAFTS.individual
  }

  if (ngoMerchantTypes.has(merchantType)) {
    return AGREEMENT_DRAFTS.ngo
  }

  return AGREEMENT_DRAFTS.company
}
