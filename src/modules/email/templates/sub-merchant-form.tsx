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

export type SubMerchantFormEmailProps = {
  merchantName: string
  ownerName: string
  subMerchantName: string
  finalFormUrl: string
}

export function SubMerchantFormEmail({
  merchantName,
  ownerName,
  subMerchantName,
  finalFormUrl,
}: SubMerchantFormEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Final sub-merchant form for {merchantName}</Preview>
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6">
            <Heading className="m-0 text-2xl font-semibold text-gray-900">
              Final sub-merchant form
            </Heading>

            <Text className="mt-6 text-base text-gray-800">
              Hi {ownerName},
            </Text>
            <Text className="text-base text-gray-800">
              The final sub-merchant form for {merchantName} is ready for
              review.
            </Text>

            <Section className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
              <Text className="m-0 text-sm text-gray-600">Sub-merchant</Text>
              <Text className="mt-1 text-base font-semibold text-gray-900">
                {subMerchantName}
              </Text>
            </Section>

            <Section className="mt-6 text-center">
              <Button
                href={finalFormUrl}
                className="rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white"
              >
                Open final form
              </Button>
            </Section>

            <Text className="mt-6 text-sm text-gray-600">
              If the button does not work, copy and paste this URL into your
              browser:
            </Text>
            <Text className="break-all text-sm text-blue-700">
              {finalFormUrl}
            </Text>

            <Hr className="my-6 border-gray-200" />

            <Text className="text-xs text-gray-500">
              This email was sent from the onboarding portal case workflow.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

SubMerchantFormEmail.PreviewProps = {
  merchantName: 'Acme Pvt Ltd',
  ownerName: 'Jane Owner',
  subMerchantName: 'Devtects',
  finalFormUrl: 'https://drive.google.com/open?id=example',
} satisfies SubMerchantFormEmailProps

export default SubMerchantFormEmail
