export function sanitizeCaseHistoryDetails(action: string, details: unknown) {
  if (
    action !== 'mid_creation_saved' ||
    !details ||
    typeof details !== 'object'
  ) {
    return details
  }

  const { password: _password, ...safeDetails } = details as Record<
    string,
    unknown
  >
  return safeDetails
}

export function enrichResubmissionWhatsappHistoryDetails(
  action: string,
  details: unknown,
  activeWhatsappNumber: string | null,
) {
  if (
    action !== 'resubmission_whatsapp_sent_manual' ||
    !activeWhatsappNumber ||
    !details ||
    typeof details !== 'object'
  ) {
    return details
  }

  const safeDetails = details as Record<string, unknown>
  if (
    typeof safeDetails.whatsappRecipient === 'string' &&
    safeDetails.whatsappRecipient.trim()
  ) {
    return details
  }

  return {
    ...safeDetails,
    recipient: activeWhatsappNumber,
    whatsappRecipient: activeWhatsappNumber,
  }
}

export function getStringDetail(details: unknown, key: string) {
  if (!details || typeof details !== 'object') return null
  const value = (details as Record<string, unknown>)[key]
  return typeof value === 'string' && value ? value : null
}

// ─── Send For Resubmission ──────────────────────────────────────────────────
