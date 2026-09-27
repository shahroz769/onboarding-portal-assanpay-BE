import type { ReactElement } from 'react'
import { render } from '@react-email/render'

import { env } from '../../config/env'
import { AppError } from '../../lib/errors'
import {
  buildAgreementEmailBody,
  buildLiveActivationEmailBody,
  buildMidCreationMessageBody,
  buildResubmissionEmailBody,
} from '../cases/case-communication-helpers'
import { getEmailTemplateLabel } from './email-templates'
import { AgreementEmail, agreementEmailSubject } from './templates/agreement'
import {
  DOCUMENT_RESUBMISSION_EMAIL_SUBJECT,
  DocumentResubmissionEmail,
} from './templates/document-resubmission'
import {
  LiveActivationEmail,
  liveActivationEmailSubject,
} from './templates/live-activation'
import {
  MidCreationEmail,
  midCreationEmailSubject,
} from './templates/mid-creation'
import {
  UserPasswordEmail,
  userPasswordEmailSubject,
} from './templates/user-password'

// Read-only catalog of every email the portal sends, for Configuration →
// Email templates. Each entry renders the real template with `{{variable}}`
// placeholders in place of merchant data, so the page can never drift from
// what is actually sent.

/** A `{{name}}` placeholder. */
const v = (name: string) => `{{${name}}}`

/**
 * A placeholder where the template expects a number. Templates only format
 * these with `toLocaleString()` or string interpolation, which a string
 * passes through unchanged, so the token shows up as-is.
 */
const n = (name: string) => v(name) as unknown as number

type EmailTemplateVariable = {
  name: string
  description: string
}

type EmailTemplateGroup = 'case' | 'account'

type EmailTemplateDefinition = {
  key: string
  group: EmailTemplateGroup
  trigger: string
  recipients: string
  subject: string
  variables: EmailTemplateVariable[]
  notes: string[]
  renderEmail: () => ReactElement
  /** Plain-text body agents paste into Gmail in manual sending mode. */
  buildPlainText?: () => string
}

const CASE_RECIPIENTS =
  "The merchant's business or submitter email (the agent picks when sending), plus the CC, BCC and reply-to from Email Sending."

const methodVariables = (
  limitName: 'testing' | 'live',
): EmailTemplateVariable[] => [
  {
    name: 'method.label',
    description:
      'Name of each payment or payout method enabled for the merchant. One row per method.',
  },
  {
    name: `method.${limitName}Min`,
    description: `Per-transaction ${limitName} minimum for the method, in PKR.`,
  },
  {
    name: `method.${limitName}Max`,
    description: `Per-transaction ${limitName} maximum for the method, in PKR.`,
  },
  {
    name: 'method.commissionRate',
    description: "Commission rate for the method, from the merchant's MDR.",
  },
]

/** One placeholder row standing in for each of the merchant's methods. */
const sampleMethod = {
  id: 'method',
  label: v('method.label'),
  commissionRate: n('method.commissionRate'),
}
const testingMethod = {
  ...sampleMethod,
  testing: { min: n('method.testingMin'), max: n('method.testingMax') },
}
const liveMethod = {
  ...sampleMethod,
  live: { min: n('method.liveMin'), max: n('method.liveMax') },
}

const passwordVariables: EmailTemplateVariable[] = [
  { name: 'name', description: "The portal user's name." },
  {
    name: 'actionUrl',
    description: 'Single-use link to the set-password page.',
  },
  {
    name: 'expiresAt',
    description:
      'When the link expires, in Pakistan time (e.g. "Sep 28, 2026, 3:00 PM").',
  },
]

const definitions: EmailTemplateDefinition[] = [
  {
    key: 'document-resubmission',
    group: 'case',
    trigger:
      'An agent rejects items during document review and sends the case back to the merchant.',
    recipients: CASE_RECIPIENTS,
    subject: DOCUMENT_RESUBMISSION_EMAIL_SUBJECT,
    variables: [
      { name: 'merchantName', description: 'Merchant business name.' },
      { name: 'ownerName', description: "Merchant owner's name." },
      {
        name: 'item.label',
        description:
          'Each rejected field or document. One row per rejected item.',
      },
      {
        name: 'item.remarks',
        description: "The reviewer's remarks on the item, when given.",
      },
      {
        name: 'resubmissionUrl',
        description: 'Secure, single-use link to the resubmission form.',
      },
    ],
    notes: [],
    renderEmail: () =>
      DocumentResubmissionEmail({
        merchantName: v('merchantName'),
        ownerName: v('ownerName'),
        rejections: [{ label: v('item.label'), remarks: v('item.remarks') }],
        resubmissionUrl: v('resubmissionUrl'),
      }),
    buildPlainText: () =>
      buildResubmissionEmailBody({
        merchantName: v('merchantName'),
        ownerName: v('ownerName'),
        rejections: [{ label: v('item.label'), remarks: v('item.remarks') }],
        resubmissionUrl: v('resubmissionUrl'),
      }),
  },
  {
    key: 'mid-creation',
    group: 'case',
    trigger:
      'The MID creation case is sent, giving the merchant their testing portal login.',
    recipients: CASE_RECIPIENTS,
    subject: midCreationEmailSubject(v('merchantName')),
    variables: [
      { name: 'merchantName', description: 'Merchant business name.' },
      {
        name: 'portalEmail',
        description: 'Login email created for the merchant portal.',
      },
      {
        name: 'portalPassword',
        description: 'Temporary merchant portal password.',
      },
      {
        name: 'merchantPortalUrl',
        description: 'Login URL from Configuration → Portal & Support.',
      },
      {
        name: 'integrationGuideLabel',
        description:
          "Integration guide for the merchant's website platform (e.g. Custom Website, WooCommerce).",
      },
      {
        name: 'serverBaseUrl',
        description: 'Server base URL from Portal & Support.',
      },
      {
        name: 'serverCallbackIp',
        description: 'Server callback IP from Portal & Support.',
      },
      ...methodVariables('testing'),
    ],
    notes: [
      'The server integration section only appears for merchants on a custom website.',
      'When the merchant has no payout methods, a single "Disbursement" row with the default testing limits and payout rate replaces the payout rows.',
    ],
    renderEmail: () =>
      MidCreationEmail({
        merchantName: v('merchantName'),
        portalEmail: v('portalEmail'),
        portalPassword: v('portalPassword'),
        merchantPortalUrl: v('merchantPortalUrl'),
        integrationGuideLabel: v('integrationGuideLabel'),
        serverIntegration: {
          baseUrl: v('serverBaseUrl'),
          callbackIp: v('serverCallbackIp'),
        },
        paymentMethods: [testingMethod],
        payoutMethods: [testingMethod],
      }),
    buildPlainText: () =>
      buildMidCreationMessageBody({
        merchantName: v('merchantName'),
        portalEmail: v('portalEmail'),
        portalPassword: v('portalPassword'),
        merchantPortalUrl: v('merchantPortalUrl'),
        integrationGuideLabel: v('integrationGuideLabel'),
        serverIntegration: {
          baseUrl: v('serverBaseUrl'),
          callbackIp: v('serverCallbackIp'),
        },
        testingLimits: {
          collectionMin: 0,
          collectionMax: 0,
          disbursementMin: 0,
          disbursementMax: 0,
        },
        paymentMethods: [testingMethod],
        payoutMethods: [testingMethod],
        payoutRate: '',
        payoutRateLabel: '',
      }),
  },
  {
    key: 'agreement',
    group: 'case',
    trigger:
      'The Agreement case is sent with the Final Agreement for the merchant to sign.',
    recipients: CASE_RECIPIENTS,
    subject: agreementEmailSubject(v('merchantName')),
    variables: [
      { name: 'merchantName', description: 'Merchant business name.' },
      { name: 'ownerName', description: "Merchant owner's name." },
      {
        name: 'officeAddress',
        description: 'Devtects delivery address from Portal & Support.',
      },
      {
        name: 'legalEmail',
        description: 'Legal contact email from Portal & Support.',
      },
      {
        name: 'remarks',
        description:
          'Optional remarks the agent adds when sending. The panel is hidden when empty.',
      },
      {
        name: 'agreementUrl',
        description: "Google Drive link to the case's Final Agreement.",
      },
    ],
    notes: [],
    renderEmail: () =>
      AgreementEmail({
        merchantName: v('merchantName'),
        ownerName: v('ownerName'),
        agreementUrl: v('agreementUrl'),
        officeAddress: v('officeAddress'),
        legalEmail: v('legalEmail'),
        remarks: v('remarks'),
      }),
    buildPlainText: () =>
      buildAgreementEmailBody({
        merchantName: v('merchantName'),
        ownerName: v('ownerName'),
        agreementUrl: v('agreementUrl'),
        officeAddress: v('officeAddress'),
        legalEmail: v('legalEmail'),
        remarks: v('remarks'),
      }),
  },
  {
    key: 'live-activation',
    group: 'case',
    trigger: 'The Live case is closed and the merchant account goes live.',
    recipients: CASE_RECIPIENTS,
    subject: liveActivationEmailSubject(v('merchantName')),
    variables: [
      { name: 'merchantName', description: 'Merchant business name.' },
      {
        name: 'merchantPortalUrl',
        description: 'Login URL from Configuration → Portal & Support.',
      },
      ...methodVariables('live'),
    ],
    notes: [
      'When the merchant has no payout methods, a single "Disbursement" row with the default live limits replaces the payout rows.',
    ],
    renderEmail: () =>
      LiveActivationEmail({
        merchantName: v('merchantName'),
        merchantPortalUrl: v('merchantPortalUrl'),
        paymentMethods: [liveMethod],
        payoutMethods: [liveMethod],
        liveLimits: {
          collectionMin: 0,
          collectionMax: 0,
          disbursementMin: 0,
          disbursementMax: 0,
        },
      }),
    buildPlainText: () =>
      buildLiveActivationEmailBody({
        merchantName: v('merchantName'),
        merchantPortalUrl: v('merchantPortalUrl'),
        paymentMethods: [liveMethod],
        payoutMethods: [liveMethod],
        liveLimits: {
          collectionMin: 0,
          collectionMax: 0,
          disbursementMin: 0,
          disbursementMax: 0,
        },
      }),
  },
  {
    key: 'user-password-invite',
    group: 'account',
    trigger: 'An admin creates a portal user.',
    recipients: 'The new portal user.',
    subject: userPasswordEmailSubject('invite'),
    variables: passwordVariables,
    notes: ['Always sent automatically through Resend.'],
    renderEmail: () =>
      UserPasswordEmail({
        name: v('name'),
        actionUrl: v('actionUrl'),
        expiresAt: v('expiresAt'),
        purpose: 'invite',
      }),
  },
  {
    key: 'user-password-reset',
    group: 'account',
    trigger: 'An admin sends a password reset from User Management.',
    recipients: 'The portal user whose password is being reset.',
    subject: userPasswordEmailSubject('reset'),
    variables: passwordVariables,
    notes: ['Always sent automatically through Resend.'],
    renderEmail: () =>
      UserPasswordEmail({
        name: v('name'),
        actionUrl: v('actionUrl'),
        expiresAt: v('expiresAt'),
        purpose: 'reset',
      }),
  },
]

const TOKEN_PATTERN = /\{\{([\w.]+)\}\}/g

// The portal's light-theme --primary. The portal preview swaps it for the
// dark-theme one when the portal is dark.
const TOKEN_STYLE =
  'background-color:rgba(74,109,101,0.12);color:rgb(74,109,101);border-radius:4px;padding:0 3px;font-weight:600;white-space:nowrap;'

/**
 * Wraps each `{{variable}}` in the email body's text in a highlight. Only text
 * between tags is touched, so tokens inside attributes (hrefs) stay valid, and
 * the head is left alone because `<title>` cannot hold markup.
 */
function highlightTokens(html: string) {
  const bodyStart = html.search(/<body[\s>]/i)
  if (bodyStart === -1) return html
  const body = html
    .slice(bodyStart)
    .replace(/>([^<]+)</g, (_match, text: string) => {
      const highlighted = text.replace(
        TOKEN_PATTERN,
        (token, name: string) =>
          `<span data-var="${name}" style="${TOKEN_STYLE}">${token}</span>`,
      )
      return `>${highlighted}<`
    })
  return html.slice(0, bodyStart) + body
}

function toSummary(definition: EmailTemplateDefinition) {
  return {
    key: definition.key,
    label: getEmailTemplateLabel(definition.key),
    group: definition.group,
    audience: definition.group === 'case' ? 'Merchant' : 'Portal user',
    trigger: definition.trigger,
    recipients: definition.recipients,
    subject: definition.subject,
    variables: definition.variables,
    notes: definition.notes,
    hasPlainText: Boolean(definition.buildPlainText),
  }
}

export async function getEmailTemplatePreview(key: string) {
  const definition = definitions.find((entry) => entry.key === key)
  if (!definition) throw new AppError(404, 'Email template not found.')

  const html = await render(definition.renderEmail())
  return {
    ...toSummary(definition),
    from: env.EMAIL_FROM,
    html: highlightTokens(html),
    plainText: definition.buildPlainText?.() ?? null,
  }
}
