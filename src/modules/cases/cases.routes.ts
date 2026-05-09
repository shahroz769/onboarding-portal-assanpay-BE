import { Hono } from 'hono'

import { requireAuth } from '../../middleware/auth'
import { requireRoles } from '../../middleware/rbac'
import { AppError } from '../../lib/errors'
import { zodValidator } from '../../lib/validators'
import type { AppEnv } from '../../types/auth'
import {
  assignCaseSchema,
  bulkAssignCaseSchema,
  closeUnsuccessfulSchema,
  createCaseSchema,
  createCommentSchema,
  listCasesQuerySchema,
  markLiveLimitsAppliedSchema,
  markTestingLimitsAppliedSchema,
  saveFieldReviewsSchema,
  saveWordpressWebsiteSchema,
  sendAgreementEmailSchema,
  sendMidCreationEmailSchema,
  selectSubMerchantFormSchema,
  updateCasePrioritySchema,
  updateCaseStatusSchema,
} from './cases.schemas'
import type {
  AssignCaseInput,
  BulkAssignCaseInput,
  CloseUnsuccessfulInput,
  CreateCaseInput,
  CreateCommentInput,
  ListCasesQuery,
  MarkLiveLimitsAppliedInput,
  MarkTestingLimitsAppliedInput,
  SaveFieldReviewsInput,
  SaveWordpressWebsiteInput,
  SendAgreementEmailInput,
  SendMidCreationEmailInput,
  SelectSubMerchantFormInput,
  UpdateCasePriorityInput,
  UpdateCaseStatusInput,
} from './cases.schemas'
import {
  advanceStage,
  assignCase,
  bulkAssignCases,
  closeUnsuccessful,
  createCase,
  createCaseComment,
  getCaseDetail,
  listCaseComments,
  listCaseHistory,
  listCaseOwners,
  listCases,
  markLiveLimitsApplied,
  markTestingLimitsApplied,
  saveFieldReviews,
  saveWordpressWebsiteCase,
  selectSubMerchantForm,
  takeOwnership,
  updateCasePriority,
  updateCaseStatus,
  sendForResubmission,
  sendAgreementForClientUpload,
  sendMidCreationCredentialsEmail,
  sendSubMerchantFormEmail,
  uploadAgreementFinalAgreement,
  uploadSubMerchantFinalForm,
} from './cases.service'

export const caseRoutes = new Hono<AppEnv>()

// TEMP DEVELOPMENT: public case creation. Revert by moving this back below
// requireAuth with requireRoles("admin", "supervisor").
caseRoutes.post('/', zodValidator('json', createCaseSchema), async (c) => {
  const input = c.req.valid('json' as never) as CreateCaseInput
  const result = await createCase(input)
  return c.json(result, 201)
})

// All routes require authentication
caseRoutes.use('*', requireAuth)

// GET /api/cases/owners — Distinct case owners
caseRoutes.get('/owners', async (c) => {
  const owners = await listCaseOwners()
  return c.json(owners)
})

// GET /api/cases — List cases (all authenticated users)
caseRoutes.get('/', zodValidator('query', listCasesQuerySchema), async (c) => {
  const query = c.req.valid('query' as never) as ListCasesQuery
  const result = await listCases(query, c.var.auth)
  return c.json(result)
})

// POST /api/cases — Create case (admin, supervisor)
caseRoutes.post(
  '/',
  requireRoles('admin', 'supervisor'),
  zodValidator('json', createCaseSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as CreateCaseInput
    const auth = c.get('auth')
    const result = await createCase(input, auth.userId)
    return c.json(result, 201)
  },
)

// POST /api/cases/bulk-assign — Bulk assign owner (admin, supervisor)
caseRoutes.post(
  '/bulk-assign',
  requireRoles('admin', 'supervisor'),
  zodValidator('json', bulkAssignCaseSchema),
  async (c) => {
    const auth = c.get('auth')
    const input = c.req.valid('json' as never) as BulkAssignCaseInput
    const result = await bulkAssignCases(input.ids, input.ownerId, auth.userId)
    return c.json(result)
  },
)

// PATCH /api/cases/:id/status — Update case status (admin, supervisor)
caseRoutes.patch(
  '/:id/status',
  requireRoles('admin', 'supervisor'),
  zodValidator('json', updateCaseStatusSchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdateCaseStatusInput
    const result = await updateCaseStatus(id, input)
    return c.json(result)
  },
)

// PATCH /api/cases/:id/assign — Assign case owner (admin, supervisor)
caseRoutes.patch(
  '/:id/assign',
  requireRoles('admin', 'supervisor'),
  zodValidator('json', assignCaseSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as AssignCaseInput
    const result = await assignCase(id, input.ownerId, auth.userId)
    return c.json(result)
  },
)

// PATCH /api/cases/:id/priority — Update case priority (admin, supervisor)
caseRoutes.patch(
  '/:id/priority',
  requireRoles('admin', 'supervisor'),
  zodValidator('json', updateCasePrioritySchema),
  async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdateCasePriorityInput
    const result = await updateCasePriority(id, input.priority)
    return c.json(result)
  },
)

// GET /api/cases/:id — Get case detail (all authenticated)
caseRoutes.get('/:id', async (c) => {
  const id = c.req.param('id')
  const result = await getCaseDetail(id, c.var.auth)
  return c.json(result)
})

// PATCH /api/cases/:id/take-ownership — Take ownership of a case
caseRoutes.patch('/:id/take-ownership', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await takeOwnership(id, auth.userId)
  return c.json(result)
})

// PATCH /api/cases/:id/advance-stage — Advance case to next stage
caseRoutes.patch('/:id/advance-stage', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await advanceStage(id, auth.userId)
  return c.json(result)
})

// PUT /api/cases/:id/field-reviews — Save field reviews
caseRoutes.post(
  '/:id/testing/limits-applied',
  zodValidator('json', markTestingLimitsAppliedSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as MarkTestingLimitsAppliedInput
    const result = await markTestingLimitsApplied(id, auth.userId, input)
    return c.json(result)
  },
)

caseRoutes.post(
  '/:id/live/limits-applied',
  zodValidator('json', markLiveLimitsAppliedSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as MarkLiveLimitsAppliedInput
    const result = await markLiveLimitsApplied(id, auth.userId, input)
    return c.json(result)
  },
)

caseRoutes.post('/:id/wordpress-website', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const clonedWebsiteLink = formData.get('clonedWebsiteLink')
  const screenshots = formData
    .getAll('screenshots')
    .filter((value): value is File => value instanceof File)

  const parsedInput = saveWordpressWebsiteSchema.safeParse({
    clonedWebsiteLink,
  })

  if (!parsedInput.success) {
    throw new AppError(
      400,
      'A valid cloned WordPress website link is required.',
    )
  }

  const input: SaveWordpressWebsiteInput = parsedInput.data

  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await saveWordpressWebsiteCase(id, auth.userId, {
    ...input,
    screenshots,
  })
  return c.json(result)
})

caseRoutes.put(
  '/:id/field-reviews',
  zodValidator('json', saveFieldReviewsSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SaveFieldReviewsInput
    const result = await saveFieldReviews(id, auth.userId, input)
    return c.json(result)
  },
)

// PATCH /api/cases/:id/close-unsuccessful — Close case as unsuccessful
caseRoutes.patch(
  '/:id/close-unsuccessful',
  zodValidator('json', closeUnsuccessfulSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as CloseUnsuccessfulInput
    const result = await closeUnsuccessful(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/send-for-resubmission — Email client + move to awaiting_client
caseRoutes.post('/:id/send-for-resubmission', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await sendForResubmission(id, auth.userId)
  return c.json(result)
})

// PUT /api/cases/:id/sub-merchant-form/selection — Select sub-merchant
caseRoutes.put(
  '/:id/sub-merchant-form/selection',
  zodValidator('json', selectSubMerchantFormSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SelectSubMerchantFormInput
    const result = await selectSubMerchantForm(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/sub-merchant-form/final-form — Upload final form
caseRoutes.post('/:id/sub-merchant-form/final-form', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')
  const subMerchantKey = formData.get('subMerchantKey')

  if (!(file instanceof File)) {
    throw new AppError(400, 'Final Form file is required.')
  }

  if (typeof subMerchantKey !== 'string' || !subMerchantKey.trim()) {
    throw new AppError(400, 'Sub-merchant selection is required.')
  }

  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await uploadSubMerchantFinalForm(id, auth.userId, {
    file,
    subMerchantKey,
  })
  return c.json(result)
})

// POST /api/cases/:id/sub-merchant-form/send-mail — Email final form
caseRoutes.post('/:id/sub-merchant-form/send-mail', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await sendSubMerchantFormEmail(id, auth.userId)
  return c.json(result)
})

// POST /api/cases/:id/agreement/final-agreement - Upload final agreement
caseRoutes.post('/:id/agreement/final-agreement', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')

  if (!(file instanceof File)) {
    throw new AppError(400, 'Final Agreement file is required.')
  }

  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await uploadAgreementFinalAgreement(id, auth.userId, { file })
  return c.json(result)
})

// POST /api/cases/:id/agreement/send-mail - Send agreement upload link
caseRoutes.post(
  '/:id/agreement/send-mail',
  zodValidator('json', sendAgreementEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendAgreementEmailInput
    const result = await sendAgreementForClientUpload(id, auth.userId, input)
    return c.json(result)
  },
)

// GET /api/cases/:id/comments — List comments for a case
// POST /api/cases/:id/mid-creation/send-mail - Send MID credentials and Go-Live link
caseRoutes.post(
  '/:id/mid-creation/send-mail',
  zodValidator('json', sendMidCreationEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendMidCreationEmailInput
    const result = await sendMidCreationCredentialsEmail(id, auth.userId, input)
    return c.json(result)
  },
)

caseRoutes.get('/:id/comments', async (c) => {
  const id = c.req.param('id')
  const result = await listCaseComments(id)
  return c.json(result)
})

// POST /api/cases/:id/comments — Create a comment on a case
caseRoutes.post(
  '/:id/comments',
  zodValidator('json', createCommentSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as CreateCommentInput
    const result = await createCaseComment(id, auth.userId, input)
    return c.json(result, 201)
  },
)

// GET /api/cases/:id/history — Get case history timeline
caseRoutes.get('/:id/history', async (c) => {
  const id = c.req.param('id')
  const result = await listCaseHistory(id)
  return c.json(result)
})
