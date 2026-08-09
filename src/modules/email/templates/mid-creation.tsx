/** @jsxImportSource react */
import {
  ButtonRow,
  CTAButton,
  Divider,
  EmailShell,
  H2,
  KeyRow,
  LinkFallback,
  Panel,
  Paragraph,
  SectionLabel,
} from './_brand'

export type MidCreationEmailProps = {
  merchantName: string
  portalEmail: string
  portalPassword: string
  merchantPortalUrl: string
  goLiveUrl: string
  availableAt: string
  goLiveAvailabilityHours?: number | null
  testingLimits?: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
  rates?: {
    eWallets: number
    card: number
    payout: number
    payoutLabel?: string
  }
}

export function MidCreationEmail({
  merchantName,
  portalEmail,
  portalPassword,
  merchantPortalUrl,
  goLiveUrl,
  availableAt,
  goLiveAvailabilityHours = 72,
  testingLimits = {
    collectionMin: 10,
    collectionMax: 100,
    disbursementMin: 1000,
    disbursementMax: 50000,
  },
  rates = {
    eWallets: 2.5,
    card: 3,
    payout: 0,
    payoutLabel: 'Bank Settlement',
  },
}: MidCreationEmailProps) {
  return (
    <EmailShell
      preview={`Your AssanPay merchant portal is ready — ${merchantName}`}
      eyebrow="Merchant portal access"
      title="Your testing environment is live"
      intro={`Welcome aboard, ${merchantName}. Your AssanPay merchant testing environment has been provisioned — sign in to start running test transactions.`}
    >
      <Panel tone="cream">
        <SectionLabel>Login credentials</SectionLabel>
        <KeyRow label="Portal email" value={portalEmail} mono />
        <KeyRow label="Temporary password" value={portalPassword} mono />
      </Panel>
      <Paragraph>
        For your security, update this temporary password after your first
        login.
      </Paragraph>

      <ButtonRow>
        <CTAButton href={merchantPortalUrl}>Open merchant portal</CTAButton>
      </ButtonRow>

      <Divider />

      <Panel tone="plain">
        <SectionLabel>Testing limits · per transaction</SectionLabel>
        <KeyRow
          label="Collection"
          value={`${testingLimits.collectionMin.toLocaleString()} – ${testingLimits.collectionMax.toLocaleString()}`}
        />
        <KeyRow
          label="Disbursement"
          value={`${testingLimits.disbursementMin.toLocaleString()} – ${testingLimits.disbursementMax.toLocaleString()}`}
        />
      </Panel>

      <Panel tone="plain">
        <SectionLabel>Applicable rates</SectionLabel>
        <KeyRow label="E-wallets & QR" value={`${rates.eWallets}% + tax`} />
        <KeyRow label="Card" value={`${rates.card}% + tax`} />
        <KeyRow label={rates.payoutLabel ?? 'Payout'} value={`${rates.payout}%`} />
      </Panel>

      <Divider />

      <H2>Going live</H2>
      <Paragraph>
        {goLiveAvailabilityHours == null ? (
          <>
            The Go-Live button is available <strong>immediately</strong>.
          </>
        ) : (
          <>
            The Go-Live button unlocks{' '}
            <strong>{goLiveAvailabilityHours} hours</strong> after this email —
            on <strong>{availableAt}</strong>. Until then the link will show
            these same instructions.
          </>
        )}{' '}
        Before Go-Live can proceed, send the signed physical agreement to
        AssanPay Head Office. This physical agreement copy is required for live
        activation.
      </Paragraph>

      <ButtonRow>
        <CTAButton href={goLiveUrl} variant="secondary">
          Go live
        </CTAButton>
      </ButtonRow>

      <LinkFallback
        href={goLiveUrl}
        label="If the Go-Live button doesn’t work"
      />
    </EmailShell>
  )
}

MidCreationEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  portalEmail: 'merchant@example.com',
  portalPassword: 'merchant@ASSAN123',
  merchantPortalUrl: 'https://merchant.assanpay.com/login',
  goLiveUrl: 'https://app.example.com/onboarding-form/go-live/abc123',
  availableAt: 'May 8, 2026, 12:00 PM',
  goLiveAvailabilityHours: 72,
} satisfies MidCreationEmailProps

export default MidCreationEmail
