import { Hono } from 'hono'
import { z } from 'zod'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  getConfigurationOverview,
  getEmailSendingModeSettings,
  getLimitsAndMdrSettings,
  getLinkDeadlineSettings,
  getMerchantPortalSettings,
  getPaymentMethodSettings,
  getPayoutMethodSettings,
  updateEmailSendingModeSettings,
  updateLimitsAndMdrSettings,
  updateLinkDeadlineSettings,
  updateMerchantPortalSettings,
  updatePaymentMethodSettings,
  updatePayoutMethodSettings,
  uploadAgreementDraft,
  createSubMerchantDraft,
  getCaseFlowConfiguration,
  listAgreementDrafts,
  listSubMerchantDrafts,
  updateCaseFlowConfiguration,
} from './configuration.service'
import {
  businessTypeSchema,
  updateCaseFlowConfigurationSchema,
  emailSendingModeSettingsSchema,
  limitsAndMdrSettingsSchema,
  linkDeadlineSettingsSchema,
  merchantPortalSettingsSchema,
  paymentMethodSettingsSchema,
  payoutMethodSettingsSchema,
} from './configuration.schemas'
import type {
  EmailSendingModeSettings,
  LimitsAndMdrSettings,
  LinkDeadlineSettings,
  MerchantPortalSettings,
  PaymentMethodSettings,
  PayoutMethodSettings,
  UpdateCaseFlowConfigurationInput,
} from './configuration.schemas'

export const configurationRoutes = new Hono<AppEnv>()

configurationRoutes.use('*', requireAuth)

configurationRoutes.get('/sub-merchants', async (c) => {
  const subMerchants = await listSubMerchantDrafts()
  return c.json(
    subMerchants.map(({ id, name }) => ({
      id,
      name,
    })),
  )
})

// Operational case workflows need to know which delivery options are enabled.
// The setting contains booleans only; updates remain restricted to admins below.
configurationRoutes.get('/email-sending-mode', async (c) => {
  return c.json(await getEmailSendingModeSettings())
})

configurationRoutes.use('*', requireRoles('super_admin', 'admin'))

configurationRoutes.get('/', async (c) => {
  return c.json(await getConfigurationOverview())
})

configurationRoutes.get('/limits-and-mdr', async (c) => {
  return c.json(await getLimitsAndMdrSettings())
})

configurationRoutes.get('/payment-methods', async (c) => {
  return c.json(await getPaymentMethodSettings())
})

configurationRoutes.get('/payout-methods', async (c) => {
  return c.json(await getPayoutMethodSettings())
})

configurationRoutes.get('/agreements', async (c) => {
  return c.json(await listAgreementDrafts())
})

configurationRoutes.get('/sub-merchants/drafts', async (c) => {
  return c.json(await listSubMerchantDrafts())
})

configurationRoutes.get('/merchant-portal', async (c) => {
  return c.json(await getMerchantPortalSettings())
})

configurationRoutes.get('/link-deadlines', async (c) => {
  return c.json(await getLinkDeadlineSettings())
})

configurationRoutes.get('/case-flow', async (c) => {
  return c.json(await getCaseFlowConfiguration())
})

configurationRoutes.get('/case-flow/versions/:versionId', async (c) => {
  const versionId = Number(c.req.param('versionId'))
  if (!Number.isSafeInteger(versionId) || versionId < 1)
    return c.json({ message: 'Invalid version.' }, 400)
  return c.json(await getCaseFlowConfiguration(versionId))
})

configurationRoutes.put(
  '/case-flow',
  zodValidator('json', updateCaseFlowConfigurationSchema),
  async (c) => {
    const input = c.req.valid(
      'json' as never,
    ) as UpdateCaseFlowConfigurationInput
    return c.json(
      await updateCaseFlowConfiguration(input, c.get('auth').userId),
    )
  },
)

configurationRoutes.put(
  '/limits-and-mdr',
  zodValidator('json', limitsAndMdrSettingsSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as LimitsAndMdrSettings
    return c.json(await updateLimitsAndMdrSettings(input))
  },
)

configurationRoutes.put(
  '/link-deadlines',
  zodValidator('json', linkDeadlineSettingsSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as LinkDeadlineSettings
    return c.json(await updateLinkDeadlineSettings(input))
  },
)

configurationRoutes.put(
  '/email-sending-mode',
  zodValidator('json', emailSendingModeSettingsSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as EmailSendingModeSettings
    return c.json(await updateEmailSendingModeSettings(input))
  },
)

configurationRoutes.put(
  '/merchant-portal',
  zodValidator('json', merchantPortalSettingsSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as MerchantPortalSettings
    return c.json(await updateMerchantPortalSettings(input))
  },
)

configurationRoutes.put(
  '/payment-methods',
  zodValidator('json', paymentMethodSettingsSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as PaymentMethodSettings
    return c.json(await updatePaymentMethodSettings(input))
  },
)

configurationRoutes.put(
  '/payout-methods',
  zodValidator('json', payoutMethodSettingsSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as PayoutMethodSettings
    return c.json(await updatePayoutMethodSettings(input))
  },
)

configurationRoutes.post(
  '/agreements/:businessType/draft',
  zodValidator(
    'param',
    z.object({
      businessType: z.enum(businessTypeSchema.options, {
        message: 'Invalid business type.',
      }),
    }),
  ),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      return c.json({ message: 'Draft file is required.' }, 400)
    }

    const result = await uploadAgreementDraft({
      businessType: c.req.param('businessType'),
      file,
    })
    return c.json(result)
  },
)

configurationRoutes.post('/sub-merchants', async (c) => {
  const body = await c.req.parseBody()
  const file = body.file
  const name = body.name
  const sellerCode = body.sellerCode
  if (typeof name !== 'string') {
    return c.json({ message: 'Sub-merchant name is required.' }, 400)
  }
  if (typeof sellerCode !== 'string') {
    return c.json({ message: 'Seller Code is required.' }, 400)
  }
  if (!(file instanceof File)) {
    return c.json({ message: 'Draft file is required.' }, 400)
  }

  const result = await createSubMerchantDraft({ name, sellerCode, file })
  return c.json(result, 201)
})
