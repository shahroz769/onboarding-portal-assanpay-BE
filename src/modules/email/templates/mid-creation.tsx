/** @jsxImportSource react */
import {
  ButtonRow,
  CTAButton,
  Divider,
  EmailShell,
  H2,
  KeyRow,
  Panel,
  Paragraph,
  SectionLabel,
} from './_brand'

export type MidCreationEmailProps = {
  merchantName: string
  portalEmail: string
  portalPassword: string
  merchantPortalUrl: string
  integrationGuideLabel: string
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
  integrationGuideLabel,
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

      <Panel tone="plain">
        <SectionLabel>Merchant portal</SectionLabel>
        <KeyRow label="Login URL" value={merchantPortalUrl} />
      </Panel>

      <ButtonRow>
        <CTAButton href={merchantPortalUrl}>Open merchant portal</CTAButton>
      </ButtonRow>

      <Paragraph>
        The <strong>{integrationGuideLabel}</strong> integration guide is
        available in the <strong>Documentation</strong> section of the merchant
        portal.
      </Paragraph>

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

      <Paragraph>
        Perform low-amount tests only across every enabled collection and
        disbursement method. After testing, withdraw your balance. Settlement is
        T+2 and is processed at 12:00 AM after each 48-hour period.
      </Paragraph>

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
        Your account cannot go live until AssanPay receives and approves the
        signed agreement. After the Agreement case is closed successfully,
        AssanPay will start the Live process automatically. No additional
        Go-Live request is required from you.
      </Paragraph>
    </EmailShell>
  )
}

MidCreationEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  portalEmail: 'merchant@example.com',
  portalPassword: 'merchant@ASSAN123',
  merchantPortalUrl: 'https://merchant.assanpay.com/login',
  integrationGuideLabel: 'Custom Website',
} satisfies MidCreationEmailProps

export default MidCreationEmail
