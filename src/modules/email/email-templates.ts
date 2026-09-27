// Human names for the `template` recorded on each email_log row, used in case
// history, notifications and close-case messages.
const EMAIL_TEMPLATE_LABELS: Record<string, string> = {
  agreement: 'Agreement',
  'document-resubmission': 'Resubmission request',
  'live-activation': 'Live activation',
  'mid-creation': 'Portal credentials',
  'user-password-invite': 'Password setup',
  'user-password-reset': 'Password reset',
}

export function getEmailTemplateLabel(template: string) {
  return EMAIL_TEMPLATE_LABELS[template] ?? 'Case'
}
