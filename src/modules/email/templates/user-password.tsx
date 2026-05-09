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
  const title = isInvite ? 'Set up your account' : 'Reset your password'
  const preview = isInvite
    ? 'Your AssanPay onboarding portal account is ready'
    : 'Reset your AssanPay onboarding portal password'

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6">
            <Heading className="m-0 text-2xl font-semibold text-gray-900">
              {title}
            </Heading>

            <Text className="mt-6 text-base text-gray-800">Hi {name},</Text>
            <Text className="text-base text-gray-800">
              {isInvite
                ? 'Your onboarding portal account has been created. Set your password using the secure link below.'
                : 'Use the secure link below to set a new password for your onboarding portal account.'}
            </Text>

            <Section className="mt-6 text-center">
              <Button
                href={actionUrl}
                className="rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white"
              >
                {title}
              </Button>
            </Section>

            <Text className="mt-6 text-sm text-gray-600">
              This link expires on <strong>{expiresAt}</strong> and can only be
              used once.
            </Text>
            <Text className="break-all text-sm text-blue-700">
              {actionUrl}
            </Text>

            <Hr className="my-6 border-gray-200" />

            <Text className="text-xs text-gray-500">
              This email was sent from the AssanPay onboarding portal.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
