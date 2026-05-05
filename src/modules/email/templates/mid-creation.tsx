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

export type MidCreationEmailProps = {
  merchantName: string
  portalEmail: string
  portalPassword: string
  portalMid: number
  merchantPortalUrl: string
  goLiveUrl: string
  availableAt: string
}

export function MidCreationEmail({
  merchantName,
  portalEmail,
  portalPassword,
  merchantPortalUrl,
  goLiveUrl,
  availableAt,
}: MidCreationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>AssanPay merchant portal credentials for {merchantName}</Preview>
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6">
            <Heading className="m-0 text-2xl font-semibold text-gray-900">
              Merchant portal credentials
            </Heading>

            <Text className="mt-6 text-base text-gray-800">
              Hi {merchantName},
            </Text>
            <Text className="text-base text-gray-800">
              Your AssanPay merchant testing environment has been provisioned.
              Use the credentials below to sign in and begin testing.
            </Text>

            <Section className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
              <Text className="m-0 text-sm font-semibold text-gray-900">
                Login Credentials
              </Text>
              <Text className="mb-0 mt-3 text-sm text-gray-800">
                Email: {portalEmail}
              </Text>
              <Text className="m-0 text-sm text-gray-800">
                Password: {portalPassword}
              </Text>
            </Section>

            <Section className="mt-6 text-center">
              <Button
                href={merchantPortalUrl}
                className="box-border rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white"
              >
                Open merchant portal
              </Button>
            </Section>

            <Section className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
              <Text className="m-0 text-sm font-semibold text-gray-900">
                Testing Limits Per Transaction
              </Text>
              <Text className="mb-0 mt-3 text-sm text-gray-800">
                Collection: 10-100
              </Text>
              <Text className="m-0 text-sm text-gray-800">
                Disbursement: 1000-50,000
              </Text>
            </Section>

            <Section className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
              <Text className="m-0 text-sm font-semibold text-gray-900">
                Applicable Rates
              </Text>
              <Text className="mb-0 mt-3 text-sm text-gray-800">
                E-Wallets &amp; QR: 2.5% + Tax
              </Text>
              <Text className="m-0 text-sm text-gray-800">Card: 3% + Tax</Text>
              <Text className="m-0 text-sm text-gray-800">
                Bank Settlement: 0%
              </Text>
            </Section>

            <Heading
              as="h2"
              className="mb-0 mt-8 text-lg font-semibold text-gray-900"
            >
              Go-Live
            </Heading>
            <Text className="text-base text-gray-800">
              The Go-Live button works after 72 hours only. It unlocks on{' '}
              <strong>{availableAt}</strong>. Before that time, the link will
              show these instructions only. After it unlocks, selecting Go-Live
              starts the live activation process.
            </Text>

            <Section className="mt-6 text-center">
              <Button
                href={goLiveUrl}
                className="box-border rounded-md bg-green-600 px-5 py-3 text-sm font-medium text-white"
              >
                Go Live
              </Button>
            </Section>

            <Text className="mt-6 text-sm text-gray-600">
              If the Go-Live button does not work, copy and paste this URL into
              your browser:
            </Text>
            <Text className="break-all text-sm text-blue-700">{goLiveUrl}</Text>

            <Hr className="my-6 border-solid border-gray-200" />

            <Text className="text-xs text-gray-500">
              This email was sent from the AssanPay onboarding workflow.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

MidCreationEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  portalEmail: 'merchant@example.com',
  portalPassword: 'secret-password',
  portalMid: 10001,
  merchantPortalUrl: 'https://merchant.assanpay.com/login',
  goLiveUrl: 'https://app.example.com/onboarding-form/go-live/abc123',
  availableAt: 'May 8, 2026, 12:00 PM',
} satisfies MidCreationEmailProps

export default MidCreationEmail
