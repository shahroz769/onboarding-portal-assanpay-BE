/** @jsxImportSource react */
import {
  ButtonRow,
  CTAButton,
  Divider,
  EmailShell,
  KeyRow,
  LinkFallback,
  Panel,
  Paragraph,
  SectionLabel,
} from './_brand'

export type LiveActivationEmailProps = {
  merchantName: string
  merchantPortalUrl: string
  liveLimits: {
    collectionMin: number
    collectionMax: number
    disbursementMin: number
    disbursementMax: number
  }
}

export function LiveActivationEmail({
  merchantName,
  merchantPortalUrl,
  liveLimits,
}: LiveActivationEmailProps) {
  return (
    <EmailShell
      preview={`Your AssanPay account is live - ${merchantName}`}
      eyebrow="Live activation"
      title="You are live now"
      intro={`Congratulations, ${merchantName}. Your AssanPay merchant account is now live and ready for production transactions.`}
    >
      <Panel tone="cream">
        <SectionLabel>Live limits - per transaction</SectionLabel>
        <KeyRow
          label="Collection"
          value={`${liveLimits.collectionMin.toLocaleString()} - ${liveLimits.collectionMax.toLocaleString()}`}
        />
        <KeyRow
          label="Disbursement"
          value={`${liveLimits.disbursementMin.toLocaleString()} - ${liveLimits.disbursementMax.toLocaleString()}`}
        />
      </Panel>

      <Paragraph>
        Please use the merchant portal to monitor live activity and manage your
        AssanPay merchant account.
      </Paragraph>

      <ButtonRow>
        <CTAButton href={merchantPortalUrl}>Open merchant portal</CTAButton>
      </ButtonRow>

      <Divider />

      <LinkFallback
        href={merchantPortalUrl}
        label="If the merchant portal button doesn't work"
      />
    </EmailShell>
  )
}