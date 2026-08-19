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
  serverIntegration?: {
    baseUrl: string
    callbackIp: string
  } | null
  paymentMethods?: Array<{
    id: string
    label: string
    testing: { min: number; max: number }
    commissionRate: number
  }>
  payoutMethods?: Array<{
    id: string
    label: string
    testing: { min: number; max: number }
    commissionRate: number
  }>
  testingLimits?: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
  rates?: {
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
  serverIntegration = null,
  paymentMethods = [],
  payoutMethods = [],
  testingLimits = {
    collectionMin: 10,
    collectionMax: 100,
    disbursementMin: 1000,
    disbursementMax: 50000,
  },
  rates = {
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

      {serverIntegration ? (
        <Panel tone="plain">
          <SectionLabel>Custom website server integration</SectionLabel>
          <KeyRow label="Server base URL" value={serverIntegration.baseUrl} />
          <KeyRow
            label="Server callback IP"
            value={serverIntegration.callbackIp}
            mono
          />
        </Panel>
      ) : null}

      <ButtonRow>
        <CTAButton href={merchantPortalUrl}>Open merchant portal</CTAButton>
      </ButtonRow>

      <Divider />

      <Panel tone="plain">
        <SectionLabel>Testing limits · per transaction</SectionLabel>
        {paymentMethods.map((method) => (
          <KeyRow
            key={method.id}
            label={`${method.label} collection`}
            value={`${method.testing.min.toLocaleString()} – ${method.testing.max.toLocaleString()}`}
          />
        ))}
        {payoutMethods.length > 0 ? (
          payoutMethods.map((method) => (
            <KeyRow
              key={method.id}
              label={`${method.label} payout`}
              value={`${method.testing.min.toLocaleString()} – ${method.testing.max.toLocaleString()}`}
            />
          ))
        ) : (
          <KeyRow
            label="Disbursement"
            value={`${testingLimits.disbursementMin.toLocaleString()} – ${testingLimits.disbursementMax.toLocaleString()}`}
          />
        )}
      </Panel>

      <Panel tone="plain">
        <SectionLabel>Applicable rates</SectionLabel>
        {paymentMethods.map((method) => (
          <KeyRow
            key={method.id}
            label={method.label}
            value={`${method.commissionRate}%`}
          />
        ))}
        {payoutMethods.length > 0 ? (
          payoutMethods.map((method) => (
            <KeyRow
              key={method.id}
              label={method.label}
              value={`${method.commissionRate}%`}
            />
          ))
        ) : (
          <KeyRow
            label={rates.payoutLabel ?? 'Payout'}
            value={`${rates.payout}%`}
          />
        )}
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
