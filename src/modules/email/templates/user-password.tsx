/** @jsxImportSource react */
import {
  ButtonRow,
  CTAButton,
  EmailShell,
  ExpiryNote,
  LinkFallback,
  Paragraph,
} from './_brand'

export type UserPasswordEmailProps = {
  name: string
  actionUrl: string
  expiresAt: string
  purpose: 'invite' | 'reset'
}

export function UserPasswordEmail({
  name,
  actionUrl,
  expiresAt,
  purpose,
}: UserPasswordEmailProps) {
  const isInvite = purpose === 'invite'

  const title = isInvite ? 'Welcome to AssanPay' : 'Reset your password'
  const eyebrow = isInvite ? 'Account invitation' : 'Password reset'
  const intro = isInvite
    ? 'Your onboarding portal account is ready. Choose a password using the secure link below to finish setting things up.'
    : 'We received a request to reset the password on your onboarding portal account. Use the secure link below to choose a new one.'
  const preview = isInvite
    ? `${name}, set up your AssanPay onboarding portal account`
    : `${name}, reset your AssanPay onboarding portal password`
  const ctaLabel = isInvite ? 'Set up account' : 'Reset password'

  return (
    <EmailShell
      preview={preview}
      eyebrow={eyebrow}
      title={title}
      intro={intro}
    >
      <Paragraph>Hi {name},</Paragraph>
      <Paragraph>
        {isInvite
          ? 'Set your password and you’ll be ready to sign in to the onboarding portal. The link is single-use and only valid for a short window.'
          : 'You can choose a new password using the link below. If you didn’t request a reset, you can safely ignore this email — your current password will continue to work.'}
      </Paragraph>

      <ButtonRow>
        <CTAButton href={actionUrl}>{ctaLabel}</CTAButton>
      </ButtonRow>

      <ExpiryNote expiresAt={expiresAt} />
      <LinkFallback href={actionUrl} />
    </EmailShell>
  )
}

UserPasswordEmail.PreviewProps = {
  name: 'Jane Owner',
  actionUrl: 'https://app.example.com/auth/invite/abc123',
  expiresAt: 'in 24 hours',
  purpose: 'invite',
} satisfies UserPasswordEmailProps

export default UserPasswordEmail
