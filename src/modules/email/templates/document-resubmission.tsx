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
} from "@react-email/components";

export type DocumentResubmissionEmailRejection = {
  label: string;
  remarks: string | null;
};

export type DocumentResubmissionEmailProps = {
  merchantName: string;
  ownerName: string;
  rejections: DocumentResubmissionEmailRejection[];
  resubmissionUrl: string;
  expiresAt: string;
};

export function DocumentResubmissionEmail({
  merchantName,
  ownerName,
  rejections,
  resubmissionUrl,
  expiresAt,
}: DocumentResubmissionEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        Action required: please update your onboarding submission for {merchantName}
      </Preview>
      <Tailwind>
        <Body className="bg-gray-50 font-sans">
          <Container className="mx-auto my-10 max-w-xl rounded-lg bg-white p-6">
            <Heading className="m-0 text-2xl font-semibold text-gray-900">
              Update required for {merchantName}
            </Heading>

            <Text className="mt-6 text-base text-gray-800">
              Hi {ownerName},
            </Text>
            <Text className="text-base text-gray-800">
              We reviewed your onboarding submission and need a few items
              updated before we can proceed. Please review the notes below and
              resubmit the requested information.
            </Text>

            <Section className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
              <Heading
                as="h2"
                className="m-0 text-base font-semibold text-gray-900"
              >
                Items to update
              </Heading>

              {rejections.map((item, index) => (
                <Section
                  key={`${item.label}-${index}`}
                  className="mt-3 rounded-md border border-gray-200 bg-white p-3"
                >
                  <Text className="m-0 text-sm font-semibold text-gray-900">
                    {item.label}
                  </Text>
                  {item.remarks ? (
                    <Text className="mt-1 text-sm text-gray-700">
                      {item.remarks}
                    </Text>
                  ) : null}
                </Section>
              ))}
            </Section>

            <Section className="mt-6 text-center">
              <Button
                href={resubmissionUrl}
                className="rounded-md bg-blue-600 px-5 py-3 text-sm font-medium text-white"
              >
                Update your submission
              </Button>
            </Section>

            <Text className="mt-6 text-sm text-gray-600">
              This secure link expires on <strong>{expiresAt}</strong>. If the
              button does not work, copy and paste this URL into your browser:
            </Text>
            <Text className="break-all text-sm text-blue-700">
              {resubmissionUrl}
            </Text>

            <Hr className="my-6 border-gray-200" />

            <Text className="text-xs text-gray-500">
              If you did not expect this message, you can safely ignore it.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}

DocumentResubmissionEmail.PreviewProps = {
  merchantName: "Acme Pvt Ltd",
  ownerName: "Jane Owner",
  rejections: [
    { label: "Business Name", remarks: "Name does not match NTN certificate." },
    { label: "Owner CNIC Front", remarks: "Image is blurry, please re-upload." },
  ],
  resubmissionUrl: "https://app.example.com/onboarding-form/resubmit/abc123",
  expiresAt: "April 29, 2026",
} satisfies DocumentResubmissionEmailProps;

export default DocumentResubmissionEmail;
