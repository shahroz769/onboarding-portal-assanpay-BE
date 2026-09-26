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
  updateSubMerchantDraft,
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

configurationRoutes.get(
  '/case-flow/versions/:versionId',
  zodValidator(
    'param',
    z.object({
      versionId: z.coerce
        .number({ message: 'Invalid version.' })
        .int({ message: 'Invalid version.' })
        .min(1, { message: 'Invalid version.' }),
    }),
  ),
  async (c) => {
    const { versionId } = c.req.valid('param')
    return c.json(await getCaseFlowConfiguration(versionId))
  },
)

configurationRoutes.put(
  '/case-flow',
  zodValidator('json', updateCaseFlowConfigurationSchema),
  async (c) => {
    const input = c.req.valid('json')
    return c.json(
      await updateCaseFlowConfiguration(input, c.get('auth').userId),
    )
  },
)

configurationRoutes.put(
  '/limits-and-mdr',
  zodValidator('json', limitsAndMdrSettingsSchema),
  async (c) => {
    const input = c.req.valid('json')
    return c.json(await updateLimitsAndMdrSettings(input))
  },
)

configurationRoutes.put(
  '/link-deadlines',
  zodValidator('json', linkDeadlineSettingsSchema),
  async (c) => {
    const input = c.req.valid('json')
    return c.json(await updateLinkDeadlineSettings(input))
  },
)

configurationRoutes.put(
  '/email-sending-mode',
  zodValidator('json', emailSendingModeSettingsSchema),
  async (c) => {
    const input = c.req.valid('json')
    return c.json(await updateEmailSendingModeSettings(input))
  },
)

configurationRoutes.put(
  '/merchant-portal',
  zodValidator('json', merchantPortalSettingsSchema),
  async (c) => {
    const input = c.req.valid('json')
    return c.json(await updateMerchantPortalSettings(input))
  },
)

configurationRoutes.put(
  '/payment-methods',
  zodValidator('json', paymentMethodSettingsSchema),
  async (c) => {
    const input = c.req.valid('json')
    return c.json(await updatePaymentMethodSettings(input))
  },
)

configurationRoutes.put(
  '/payout-methods',
  zodValidator('json', payoutMethodSettingsSchema),
  async (c) => {
    const input = c.req.valid('json')
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
      return c.json({ error: 'Draft file is required.' }, 400)
    }

    const result = await uploadAgreementDraft({
      businessType: c.req.valid('param').businessType,
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
    return c.json({ error: 'Sub-merchant name is required.' }, 400)
  }
  if (typeof sellerCode !== 'string') {
    return c.json({ error: 'Seller Code is required.' }, 400)
  }
  if (!(file instanceof File)) {
    return c.json({ error: 'Draft file is required.' }, 400)
  }

  const result = await createSubMerchantDraft({ name, sellerCode, file })
  return c.json(result, 201)
})

configurationRoutes.patch(
  '/sub-merchants/:id',
  zodValidator(
    'param',
    z.object({ id: z.uuid({ message: 'Invalid sub-merchant.' }) }),
  ),
  async (c) => {
    const body = await c.req.parseBody()
    const file = body.file
    const name = body.name
    const sellerCode = body.sellerCode
    if (typeof name !== 'string') {
      return c.json({ error: 'Sub-merchant name is required.' }, 400)
    }
    if (typeof sellerCode !== 'string') {
      return c.json({ error: 'Seller Code is required.' }, 400)
    }
    if (file !== undefined && !(file instanceof File)) {
      return c.json({ error: 'Draft file is invalid.' }, 400)
    }

    const result = await updateSubMerchantDraft({
      id: c.req.valid('param').id,
      name,
      sellerCode,
      file: file ?? null,
    })
    return c.json(result)
  },
)
