/** @jsxImportSource react */
import { Text } from '@react-email/components'
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

export type DocumentResubmissionEmailRejection = {
  label: string
  remarks: string | null
}

export type DocumentResubmissionEmailProps = {
  merchantName: string
  ownerName: string
  rejections: DocumentResubmissionEmailRejection[]
  resubmissionUrl: string
  expiresAt: string
}

export function DocumentResubmissionEmail({
  merchantName,
  ownerName,
  rejections,
  resubmissionUrl,
  expiresAt,
}: DocumentResubmissionEmailProps) {
  return (
    <EmailShell
      preview={`Action required: update onboarding submission for ${merchantName}`}
      eyebrow="Action required"
      title="A few items need an update"
      intro={`We’ve reviewed the onboarding submission for ${merchantName} and need a small set of items refreshed before we can move forward.`}
    >
      <Paragraph>Hi {ownerName},</Paragraph>
      <Paragraph>
        Please review the notes below and update the requested items using the
        secure link. Once everything looks good, we’ll continue the review
        right away.
      </Paragraph>

      <Panel tone="cream">
        <SectionLabel>Items to update</SectionLabel>
        {rejections.map((item, index) => (
          <table
            key={`${item.label}-${index}`}
            cellPadding={0}
            cellSpacing={0}
            role="presentation"
            border={0}
            style={{
              width: '100%',
              marginTop: index === 0 ? '4px' : '14px',
              borderCollapse: 'collapse',
            }}
          >
            <tbody>
              <tr>
                <td
                  style={{
                    width: '4px',
                    backgroundColor: brand.primary,
                    borderRadius: '4px',
                    padding: 0,
                  }}
                >
                  &nbsp;
                </td>
                <td style={{ paddingLeft: '14px', verticalAlign: 'top' }}>
                  <Text
                    style={{
                      margin: 0,
                      fontFamily: fontStack.body,
                      fontSize: '14px',
                      fontWeight: 700,
                      lineHeight: 1.4,
                      color: brand.ink,
                    }}
                  >
                    {item.label}
                  </Text>
                  {item.remarks ? (
                    <Text
                      style={{
                        margin: '4px 0 0',
                        fontFamily: fontStack.body,
                        fontSize: '13px',
                        lineHeight: 1.6,
                        color: brand.inkSoft,
                      }}
                    >
                      {item.remarks}
                    </Text>
                  ) : null}
                </td>
              </tr>
            </tbody>
          </table>
        ))}
      </Panel>

      <ButtonRow>
        <CTAButton href={resubmissionUrl}>Update submission</CTAButton>
      </ButtonRow>

      <ExpiryNote expiresAt={expiresAt} />
      <LinkFallback href={resubmissionUrl} />
    </EmailShell>
  )
}

DocumentResubmissionEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  ownerName: 'Jane Owner',
  rejections: [
    { label: 'Business Name', remarks: 'Name does not match NTN certificate.' },
    {
      label: 'Owner CNIC Front',
      remarks: 'Image is blurry, please re-upload.',
    },
  ],
  resubmissionUrl: 'https://app.example.com/onboarding-form/resubmit/abc123',
  expiresAt: 'on April 29, 2026',
} satisfies DocumentResubmissionEmailProps

export default DocumentResubmissionEmail
