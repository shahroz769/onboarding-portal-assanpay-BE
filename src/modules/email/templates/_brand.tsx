/** @jsxImportSource react */
import type { CSSProperties, ReactNode } from 'react'
import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components'

const LOGO_URL =
  'https://res.cloudinary.com/dv964glvh/image/upload/q_auto/f_auto/v1779718539/logo_x9cdzc.svg'

/**
 * AssanPay brand tokens (mirrors the design system palette).
 * Keep this file as the single source of truth for email styling so the
 * template surface stays cohesive end to end.
 */
export const brand = {
  // Warm orange brand
  primary: '#e09145',
  primarySoft: '#fec185',
  cream: '#f8eadc',
  // Espresso ink (dark on cream)
  ink: '#251200',
  inkDeep: '#1b0c00',
  // Neutral surfaces
  surface: '#ffffff',
  surfaceMuted: '#f5f5f5',
  surfaceWarm: '#fbf7f2',
  // Borders + supporting tones
  border: '#eadfd1',
  borderSoft: '#f3e8d8',
  muted: '#908e8c',
  inkSoft: '#5a3818',
  white: '#ffffff',
} as const

export const fontStack = {
  display:
    "'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  body: "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
} as const

const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Outfit:wght@100..900&family=Manrope:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap'

// ────────────────────────────────────────────────────────────────────────────
// Shell
// ────────────────────────────────────────────────────────────────────────────

export type EmailShellProps = {
  preview: string
  eyebrow: string
  title: string
  intro?: string
  children: ReactNode
}

export function EmailShell({
  preview,
  eyebrow,
  title,
  intro,
  children,
}: EmailShellProps) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
      </Head>
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          padding: '32px 16px',
          backgroundColor: brand.surfaceMuted,
          fontFamily: fontStack.body,
          color: brand.ink,
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
        }}
      >
        <Container
          style={{
            width: '100%',
            maxWidth: '600px',
            margin: '0 auto',
            backgroundColor: brand.surface,
            borderRadius: '20px',
            overflow: 'hidden',
            boxShadow:
              '0 1px 2px rgba(37,18,0,0.04), 0 18px 40px -18px rgba(37,18,0,0.18)',
          }}
        >
          {/* Top accent bar */}
          <Section
            style={{
              padding: 0,
              margin: 0,
              height: '6px',
              backgroundColor: brand.primary,
              lineHeight: '6px',
              fontSize: 0,
            }}
          >
            &nbsp;
          </Section>

          {/* Header / hero */}
          <Section
            style={{
              padding: '40px 40px 36px',
              backgroundColor: brand.cream,
              borderBottom: `1px solid ${brand.borderSoft}`,
            }}
          >
            <BrandLockup />
            <Text
              style={{
                margin: '32px 0 10px',
                fontFamily: fontStack.body,
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: brand.primary,
              }}
            >
              {eyebrow}
            </Text>
            <Text
              style={{
                margin: 0,
                fontFamily: fontStack.display,
                fontWeight: 800,
                fontOpticalSizing: 'auto',
                fontSize: '32px',
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: brand.ink,
              }}
            >
              {title}
            </Text>
            {intro ? (
              <Text
                style={{
                  margin: '16px 0 0',
                  fontFamily: fontStack.body,
                  fontSize: '15px',
                  lineHeight: 1.6,
                  color: brand.inkSoft,
                  maxWidth: '480px',
                }}
              >
                {intro}
              </Text>
            ) : null}
          </Section>

          {/* Body */}
          <Section style={{ padding: '36px 40px 40px' }}>{children}</Section>

          {/* Footer */}
          <BrandFooter />
        </Container>

        {/* Trailing meta line */}
        <Container
          style={{
            width: '100%',
            maxWidth: '600px',
            margin: '20px auto 0',
            textAlign: 'center',
          }}
        >
          <Text
            style={{
              margin: 0,
              fontFamily: fontStack.body,
              fontSize: '11px',
              letterSpacing: '0.06em',
              color: brand.muted,
            }}
          >
            © {new Date().getFullYear()} AssanPay · Payment Gateway
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Brand lockup (CSS-only, renders in every email client)
// ────────────────────────────────────────────────────────────────────────────

function BrandLockup() {
  return (
    <table
      cellPadding={0}
      cellSpacing={0}
      role="presentation"
      border={0}
      style={{ borderCollapse: 'collapse' }}
    >
      <tbody>
        <tr>
          <td
            style={{
              width: '52px',
              height: '52px',
              verticalAlign: 'middle',
              textAlign: 'center',
              padding: 0,
            }}
          >
            {LOGO_URL ? (
              <Img
                src={LOGO_URL}
                alt="AssanPay"
                width="52"
                height="52"
                style={{
                  display: 'block',
                  width: '52px',
                  height: '52px',
                }}
              />
            ) : null}
          </td>
          <td style={{ paddingLeft: '14px', verticalAlign: 'middle' }}>
            <div
              style={{
                fontFamily: fontStack.display,
                fontWeight: 700,
                fontOpticalSizing: 'auto',
                fontSize: '21px',
                lineHeight: 1.05,
                letterSpacing: '-0.015em',
                color: brand.ink,
              }}
            >
              AssanPay
            </div>
            <div
              style={{
                marginTop: '3px',
                fontFamily: fontStack.body,
                fontSize: '10px',
                fontWeight: 600,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: brand.muted,
              }}
            >
              Payment Gateway
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Footer
// ────────────────────────────────────────────────────────────────────────────

function BrandFooter() {
  return (
    <Section
      style={{
        backgroundColor: brand.ink,
        padding: '26px 40px 28px',
      }}
    >
      <table
        cellPadding={0}
        cellSpacing={0}
        role="presentation"
        border={0}
        style={{ width: '100%', borderCollapse: 'collapse' }}
      >
        <tbody>
          <tr>
            <td style={{ verticalAlign: 'middle' }}>
              <div
                style={{
                  fontFamily: fontStack.display,
                  fontWeight: 700,
                  fontOpticalSizing: 'auto',
                  fontSize: '17px',
                  letterSpacing: '-0.015em',
                  color: brand.primarySoft,
                }}
              >
                AssanPay
              </div>
              <div
                style={{
                  marginTop: '3px',
                  fontFamily: fontStack.body,
                  fontSize: '11px',
                  letterSpacing: '0.04em',
                  color: 'rgba(255,255,255,0.72)',
                }}
              >
                Payment Gateway
              </div>
              <div style={{ marginTop: '6px' }}>
                <Link
                  href="https://assanpay.com"
                  style={{
                    fontFamily: fontStack.display,
                    fontSize: '13px',
                    fontWeight: 700,
                    fontOpticalSizing: 'auto',
                    letterSpacing: '0.01em',
                    color: brand.white,
                    textDecoration: 'none',
                  }}
                >
                  assanpay.com
                </Link>
              </div>
            </td>
            <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
              <span
                style={{
                  display: 'inline-block',
                  fontFamily: fontStack.body,
                  fontSize: '10px',
                  fontWeight: 700,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: brand.primary,
                  padding: '6px 12px',
                  border: `1px solid ${brand.primary}`,
                  borderRadius: '999px',
                }}
              >
                Onboarding
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </Section>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Typography primitives
// ────────────────────────────────────────────────────────────────────────────

const baseText: CSSProperties = {
  margin: '0 0 14px',
  fontFamily: fontStack.body,
  fontSize: '15px',
  lineHeight: 1.65,
  color: brand.ink,
}

export function Lede({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        ...baseText,
        fontSize: '16px',
        fontWeight: 600,
        color: brand.ink,
      }}
    >
      {children}
    </Text>
  )
}

export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={baseText}>{children}</Text>
}

export function Muted({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        ...baseText,
        fontSize: '13px',
        color: brand.muted,
      }}
    >
      {children}
    </Text>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        margin: '0 0 14px',
        fontFamily: fontStack.body,
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: brand.primary,
      }}
    >
      {children}
    </Text>
  )
}

export function H2({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        margin: '0 0 12px',
        fontFamily: fontStack.display,
        fontWeight: 700,
        fontOpticalSizing: 'auto',
        fontSize: '22px',
        lineHeight: 1.2,
        letterSpacing: '-0.015em',
        color: brand.ink,
      }}
    >
      {children}
    </Text>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Panels & rows
// ────────────────────────────────────────────────────────────────────────────

export type PanelTone = 'cream' | 'plain' | 'warning' | 'dark'

export function Panel({
  children,
  tone = 'cream',
}: {
  children: ReactNode
  tone?: PanelTone
}) {
  const styles: Record<PanelTone, CSSProperties> = {
    cream: {
      backgroundColor: brand.cream,
      border: `1px solid ${brand.borderSoft}`,
    },
    plain: {
      backgroundColor: brand.surfaceWarm,
      border: `1px solid ${brand.border}`,
    },
    warning: {
      backgroundColor: '#fff3e1',
      border: `1px solid ${brand.primarySoft}`,
    },
    dark: {
      backgroundColor: brand.ink,
      border: `1px solid ${brand.ink}`,
    },
  }
  return (
    <Section
      style={{
        margin: '0 0 18px',
        padding: '20px 22px',
        borderRadius: '14px',
        ...styles[tone],
      }}
    >
      {children}
    </Section>
  )
}

export function KeyRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: ReactNode
  mono?: boolean
}) {
  return (
    <table
      cellPadding={0}
      cellSpacing={0}
      role="presentation"
      border={0}
      style={{
        width: '100%',
        marginTop: '6px',
        borderCollapse: 'collapse',
      }}
    >
      <tbody>
        <tr>
          <td
            style={{
              width: '38%',
              paddingRight: '12px',
              paddingTop: '4px',
              paddingBottom: '4px',
              fontFamily: fontStack.body,
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: brand.muted,
              verticalAlign: 'top',
            }}
          >
            {label}
          </td>
          <td
            style={{
              paddingTop: '4px',
              paddingBottom: '4px',
              fontFamily: mono ? fontStack.mono : fontStack.body,
              fontSize: mono ? '13px' : '14px',
              fontWeight: mono ? 600 : 500,
              color: brand.ink,
              letterSpacing: mono ? '0' : '-0.005em',
              verticalAlign: 'top',
              wordBreak: 'break-word',
            }}
          >
            {value}
          </td>
        </tr>
      </tbody>
    </table>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Buttons & links
// ────────────────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'outline'

export function CTAButton({
  href,
  children,
  variant = 'primary',
}: {
  href: string
  children: ReactNode
  variant?: ButtonVariant
}) {
  const styles: Record<ButtonVariant, CSSProperties> = {
    primary: {
      backgroundColor: brand.ink,
      color: brand.primary,
      border: `1px solid ${brand.ink}`,
    },
    secondary: {
      backgroundColor: brand.primary,
      color: brand.ink,
      border: `1px solid ${brand.primary}`,
    },
    outline: {
      backgroundColor: brand.surface,
      color: brand.ink,
      border: `1px solid ${brand.ink}`,
    },
  }
  return (
    <Button
      href={href}
      style={{
        ...styles[variant],
        display: 'inline-block',
        padding: '15px 28px',
        borderRadius: '999px',
        fontFamily: fontStack.body,
        fontSize: '14px',
        fontWeight: 700,
        letterSpacing: '0.02em',
        textDecoration: 'none',
        textAlign: 'center',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </Button>
  )
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <Section style={{ margin: '8px 0 4px', padding: 0 }}>{children}</Section>
  )
}

export function LinkFallback({
  href,
  label = "If the button doesn’t work",
}: {
  href: string
  label?: string
}) {
  return (
    <>
      <Text
        style={{
          margin: '24px 0 6px',
          fontFamily: fontStack.body,
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: brand.muted,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          margin: 0,
          fontFamily: fontStack.mono,
          fontSize: '12px',
          lineHeight: 1.5,
          wordBreak: 'break-all',
        }}
      >
        <Link
          href={href}
          style={{
            color: brand.primary,
            textDecoration: 'underline',
          }}
        >
          {href}
        </Link>
      </Text>
    </>
  )
}

export function ExpiryNote({ expiresAt }: { expiresAt: string }) {
  return (
    <Text
      style={{
        margin: '22px 0 0',
        fontFamily: fontStack.body,
        fontSize: '13px',
        lineHeight: 1.6,
        color: brand.muted,
      }}
    >
      This secure link expires{' '}
      <strong style={{ color: brand.ink, fontWeight: 700 }}>{expiresAt}</strong>{' '}
      and can be used only once.
    </Text>
  )
}

export function Divider() {
  return (
    <Hr
      style={{
        border: 'none',
        borderTop: `1px solid ${brand.borderSoft}`,
        margin: '28px 0',
      }}
    />
  )
}
