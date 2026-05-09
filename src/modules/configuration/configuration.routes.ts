import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  getConfigurationOverview,
  updateLimitsAndMdrSettings,
  updateLinkDeadlineSettings,
  uploadAgreementDraft,
  createSubMerchantDraft,
} from './configuration.service'
import {
  limitsAndMdrSettingsSchema,
  linkDeadlineSettingsSchema,
} from './configuration.schemas'
import type {
  LimitsAndMdrSettings,
  LinkDeadlineSettings,
} from './configuration.schemas'

export const configurationRoutes = new Hono<AppEnv>()

configurationRoutes.use('*', requireAuth, requireRoles('admin'))

configurationRoutes.get('/', async (c) => {
  return c.json(await getConfigurationOverview())
})

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
  if (typeof name !== 'string') {
    return c.json({ message: 'Sub-merchant name is required.' }, 400)
  }
  if (!(file instanceof File)) {
    return c.json({ message: 'Draft file is required.' }, 400)
  }

  const result = await createSubMerchantDraft({ name, file })
  return c.json(result, 201)
})
