/** @jsxImportSource react */
import {
  ButtonRow,
  CTAButton,
  EmailShell,
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
  officeAddress: string
  legalEmail: string
  remarks?: string | null
}

export function AgreementEmail({
  merchantName,
  ownerName,
  agreementUrl,
  officeAddress,
  legalEmail,
  remarks,
}: AgreementEmailProps) {
  return (
    <EmailShell
      preview={`Your AssanPay merchant agreement is ready - ${merchantName}`}
      eyebrow="Agreement ready"
      title="Agreement for review and execution"
    >
      <Paragraph>Hi {ownerName},</Paragraph>
      <Paragraph>
        Please find the agreement for your review and execution.
      </Paragraph>
      <Paragraph>Kindly follow the instructions below:</Paragraph>
      <Paragraph>
        1. Please print the agreement on Rs. 200 stamp paper.
        <br />
        2. Please sign each page of the agreement.
        <br />
        3. If your company/brand has an official stamp, please affix the stamp
        on each page as well.
        <br />
        4. Once signed and stamped, kindly courier the original agreement to the
        address mentioned in the agreement, which is the address of Devtects.
      </Paragraph>
      <Panel tone="plain">
        <SectionLabel>Devtects delivery address</SectionLabel>
        <Text
          style={{
            margin: 0,
            whiteSpace: 'pre-line',
            fontFamily: fontStack.body,
            fontSize: '14px',
            lineHeight: 1.65,
            color: brand.ink,
          }}
        >
          {officeAddress}
        </Text>
      </Panel>
      <Paragraph>
        Please let us know once the courier has been dispatched and share the
        tracking details for our record.
      </Paragraph>
      <Paragraph>
        Your account cannot go live until AssanPay receives and approves the
        signed agreement. Once the Agreement case is closed successfully,
        AssanPay will start the Live process automatically. No additional
        Go-Live request is required from you.
      </Paragraph>
      <Paragraph>
        If you need any clarification, please feel free to contact us at{' '}
        <a href={`mailto:${legalEmail}`}>{legalEmail}</a>.
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

      <LinkFallback href={agreementUrl} />
    </EmailShell>
  )
}

AgreementEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  ownerName: 'Jane Owner',
  agreementUrl: 'https://drive.google.com/file/d/example/view',
  officeAddress: 'AssanPay Head Office\nKarachi, Pakistan',
  legalEmail: 'legal@example.com',
  remarks: 'Please include every page of the agreement.',
} satisfies AgreementEmailProps

export default AgreementEmail
