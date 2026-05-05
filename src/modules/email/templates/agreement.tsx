/** @jsxImportSource react */
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Tailwind,
  Text,
} from '@react-email/components'

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
    <Html>
      <Head />
      <Preview>Agreement ready for {merchantName}</Preview>
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6">
            <Heading className="m-0 text-2xl font-semibold text-gray-900">
              Agreement ready for review
            </Heading>

            <Text className="mt-6 text-base text-gray-800">
              Hi {ownerName},
            </Text>
            <Text className="text-base text-gray-800">
              Please open the secure link below, review the agreement, and
              upload the signed agreement.
            </Text>

            {remarks ? (
              <Section className="mt-6 rounded-md border border-red-200 bg-red-50 p-4">
                <Text className="m-0 text-sm font-semibold text-red-900">
                  Reviewer remarks
                </Text>
                <Text className="mt-1 text-sm text-red-800">{remarks}</Text>
              </Section>
            ) : null}

            <Section className="mt-6 text-center">
              <Button
                href={agreementUrl}
                className="rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white"
              >
                Open agreement link
              </Button>
            </Section>

            <Text className="mt-6 text-sm text-gray-600">
              This secure link expires on <strong>{expiresAt}</strong>. If the
              button does not work, copy and paste this URL into your browser:
            </Text>
            <Text className="break-all text-sm text-blue-700">
              {agreementUrl}
            </Text>

            <Hr className="my-6 border-gray-200" />

            <Text className="text-xs text-gray-500">
              This email was sent from the onboarding portal agreement workflow.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

AgreementEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  ownerName: 'Jane Owner',
  agreementUrl: 'https://app.example.com/onboarding-form/agreement/abc123',
  expiresAt: 'May 12, 2026',
  remarks: 'Please upload the signed copy with all pages included.',
} satisfies AgreementEmailProps

export default AgreementEmail
