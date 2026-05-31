import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  getConfigurationOverview,
  updateEmailSendingModeSettings,
  updateLimitsAndMdrSettings,
  updateLinkDeadlineSettings,
  updateMerchantPortalSettings,
  uploadAgreementDraft,
  createSubMerchantDraft,
  getCaseFlowConfiguration,
  updateCaseFlowConfiguration,
} from './configuration.service'
import {
  updateCaseFlowConfigurationSchema,
  emailSendingModeSettingsSchema,
  limitsAndMdrSettingsSchema,
  linkDeadlineSettingsSchema,
  merchantPortalSettingsSchema,
} from './configuration.schemas'
import type {
  EmailSendingModeSettings,
  LimitsAndMdrSettings,
  LinkDeadlineSettings,
  MerchantPortalSettings,
  UpdateCaseFlowConfigurationInput,
} from './configuration.schemas'

export const configurationRoutes = new Hono<AppEnv>()

configurationRoutes.use('*', requireAuth, requireRoles('admin'))

configurationRoutes.get('/', async (c) => {
  return c.json(await getConfigurationOverview())
})

configurationRoutes.get('/case-flow', async (c) => {
  return c.json(await getCaseFlowConfiguration())
})

configurationRoutes.put(
  '/case-flow',
  zodValidator('json', updateCaseFlowConfigurationSchema),
  async (c) => {
    const input = c.req.valid(
      'json' as never,
    ) as UpdateCaseFlowConfigurationInput
    return c.json(await updateCaseFlowConfiguration(input))
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

configurationRoutes.post('/agreements/:businessType/draft', async (c) => {
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
})

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
