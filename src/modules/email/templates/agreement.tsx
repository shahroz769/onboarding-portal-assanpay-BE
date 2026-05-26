/** @jsxImportSource react */
import {
  ButtonRow,
  CTAButton,
  EmailShell,
  ExpiryNote,
  LinkFallback,
  Panel,
  Paragraph,
  SectionLabel,
  brand,
  fontStack,
} from './_brand'
import { Text } from '@react-email/components'

export type AgreementEmailProps = {
  merchantName: string
  ownerName: string
  agreementUrl: string
  expiresAt: string
  remarks?: string | null
}

export function AgreementEmail({
  merchantName,
  ownerName,
  agreementUrl,
  expiresAt,
  remarks,
}: AgreementEmailProps) {
  return (
    <EmailShell
      preview={`Your AssanPay merchant agreement is ready — ${merchantName}`}
      eyebrow="Agreement ready"
      title="Review & sign your agreement"
      intro={`We’ve prepared the AssanPay merchant agreement for ${merchantName}. Open it, review the terms, and upload the signed copy.`}
    >
      <Paragraph>Hi {ownerName},</Paragraph>
      <Paragraph>
        The link below is unique to your onboarding case. Please review the
        agreement carefully and upload the fully signed copy — including every
        page — so we can move to the next step.
      </Paragraph>

      {remarks ? (
        <Panel tone="warning">
          <SectionLabel>Reviewer remarks</SectionLabel>
          <Text
            style={{
              margin: 0,
              fontFamily: fontStack.body,
              fontSize: '14px',
              lineHeight: 1.65,
              color: brand.ink,
            }}
          >
            {remarks}
          </Text>
        </Panel>
      ) : null}

      <ButtonRow>
        <CTAButton href={agreementUrl}>Open agreement</CTAButton>
      </ButtonRow>

      <ExpiryNote expiresAt={expiresAt} />
      <LinkFallback href={agreementUrl} />
    </EmailShell>
  )
}

AgreementEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  ownerName: 'Jane Owner',
  agreementUrl: 'https://app.example.com/onboarding-form/agreement/abc123',
  expiresAt: 'on May 12, 2026',
  remarks: 'Please upload the signed copy with all pages included.',
} satisfies AgreementEmailProps

export default AgreementEmail
