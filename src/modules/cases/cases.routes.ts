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
  emailRecipientSelectionSchema,
  listCasesQuerySchema,
  markLiveLimitsAppliedSchema,
  markTestingLimitsAppliedSchema,
  saveMidCreationDetailsSchema,
  saveDocumentReviewSubMerchantSchema,
  saveFieldReviewsSchema,
  saveWordpressWebsiteSchema,
  sendAgreementEmailSchema,
  sendLiveEmailSchema,
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
  SaveDocumentReviewSubMerchantInput,
  SaveFieldReviewsInput,
  SaveMidCreationDetailsInput,
  SaveWordpressWebsiteInput,
  SendAgreementEmailInput,
  SendLiveEmailInput,
  SendMidCreationEmailInput,
  SelectSubMerchantFormInput,
  UpdateCasePriorityInput,
  UpdateCaseStatusInput,
  EmailRecipientType,
} from './cases.schemas'
import {
  createCase,
  getCaseDetail,
  listCaseOwners,
  listCases,
} from './case-query.service'
import {
  assignCase,
  bulkAssignCases,
  takeOwnership,
  updateCasePriority,
} from './case-assignment.service'
import {
  advanceStage,
  closeUnsuccessful,
  updateCaseStatus,
} from './case-stage.service'
import {
  createCaseComment,
  listCaseComments,
  listCaseHistory,
} from './case-comments.service'
import {
  saveDocumentReviewSubMerchant,
  saveFieldReviews,
  sendForResubmission,
} from './case-documents-review.service'
import {
  confirmAgreementEmailManual,
  confirmLiveActivationEmailManual,
  confirmMidCreationEmailManual,
  confirmResubmissionEmailManual,
  getAgreementEmailPreview,
  getLiveActivationEmailPreview,
  getMidCreationEmailPreview,
  getResubmissionEmailPreview,
} from './case-communications.service'
import { markTestingLimitsApplied } from './testing-case.service'
import {
  markLiveLimitsApplied,
  sendLiveActivationEmail,
} from './live-case.service'
import {
  saveMidCreationDetails,
  sendMidCreationCredentialsEmail,
} from './mid-case.service'
import { saveWordpressWebsiteCase } from './wordpress-case.service'
import {
  selectSubMerchantForm,
  uploadSubMerchantEmailProof,
  uploadSubMerchantFinalForm,
} from './sub-merchant-form-case.service'
import {
  sendAgreementForClientUpload,
  uploadAgreementFinalAgreement,
} from './agreement-case.service'
import { uploadPhysicalAgreementCopy } from './physical-agreement-case.service'

export const caseRoutes = new Hono<AppEnv>()

function parseManualCommunicationChannel(value: FormDataEntryValue | null) {
  if (value === 'whatsapp') return 'whatsapp' as const
  return 'email' as const
}

function parseEmailRecipientType(
  value: FormDataEntryValue | null,
): EmailRecipientType {
  const parsed = emailRecipientSelectionSchema.safeParse({
    recipientEmailType: typeof value === 'string' ? value : undefined,
  })
  if (!parsed.success) {
    throw new AppError(
      400,
      parsed.error.issues[0]?.message ?? 'Invalid recipient email type.',
    )
  }
  return parsed.data.recipientEmailType
}

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

// POST /api/cases — Create case (super admin, admin)
caseRoutes.post(
  '/',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', createCaseSchema),
  async (c) => {
    const input = c.req.valid('json' as never) as CreateCaseInput
    const auth = c.get('auth')
    const result = await createCase(input, auth.userId)
    return c.json(result, 201)
  },
)

// POST /api/cases/:id/live/send-mail - Send live activation email
caseRoutes.post(
  '/:id/live/send-mail',
  zodValidator('json', sendLiveEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendLiveEmailInput
    const result = await sendLiveActivationEmail(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/bulk-assign — Bulk assign owner (super admin, admin)
caseRoutes.post(
  '/bulk-assign',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', bulkAssignCaseSchema),
  async (c) => {
    const auth = c.get('auth')
    const input = c.req.valid('json' as never) as BulkAssignCaseInput
    const result = await bulkAssignCases(input.ids, input.ownerId, auth.userId)
    return c.json(result)
  },
)

// POST /api/cases/:id/live/send-mail/preview - Get live activation email preview
caseRoutes.post(
  '/:id/live/send-mail/preview',
  zodValidator('json', sendLiveEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendLiveEmailInput
    const result = await getLiveActivationEmailPreview(id, auth.userId, input)
    return c.json(result)
  },
)

// PATCH /api/cases/:id/status — Update status (case owner only)
caseRoutes.patch(
  '/:id/status',
  zodValidator('json', updateCaseStatusSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as UpdateCaseStatusInput
    const result = await updateCaseStatus(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/live/send-mail/manual - Confirm manual live activation email
caseRoutes.post('/:id/live/send-mail/manual', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }
  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')
  const tokenId = formData.get('tokenId')
  const channel = parseManualCommunicationChannel(formData.get('channel'))
  const recipientEmailType = parseEmailRecipientType(
    formData.get('recipientEmailType'),
  )
  if (!(file instanceof File))
    throw new AppError(400, 'Screenshot file is required.')
  if (typeof tokenId !== 'string' || !tokenId)
    throw new AppError(400, 'tokenId is required.')
  const parsed = sendLiveEmailSchema.safeParse({ recipientEmailType })
  if (!parsed.success) {
    throw new AppError(
      400,
      parsed.error.issues[0]?.message ?? 'Invalid email payload.',
    )
  }
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await confirmLiveActivationEmailManual(id, auth.userId, {
    ...parsed.data,
    tokenId,
    file,
    channel,
  })
  return c.json(result)
})

// PATCH /api/cases/:id/assign — Assign, transfer, or unassign (super admin, admin)
caseRoutes.patch(
  '/:id/assign',
  requireRoles('super_admin', 'admin'),
  zodValidator('json', assignCaseSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as AssignCaseInput
    const result = await assignCase(id, input.ownerId, auth.userId)
    return c.json(result)
  },
)

// PATCH /api/cases/:id/priority — Update priority (super admin, admin)
caseRoutes.patch(
  '/:id/priority',
  requireRoles('super_admin', 'admin'),
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
  '/:id/mid-creation/save',
  zodValidator('json', saveMidCreationDetailsSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SaveMidCreationDetailsInput
    const result = await saveMidCreationDetails(id, auth.userId, input)
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
  const subMerchantLogoScreenshotFiles = formData
    .getAll('subMerchantLogoScreenshots')
    .filter((value): value is File => value instanceof File)
  const subMerchantLogoScreenshotIds = formData
    .getAll('subMerchantLogoScreenshotSubMerchantIds')
    .filter((value): value is string => typeof value === 'string')
  const assanpayCheckoutScreenshots = formData
    .getAll('assanpayCheckoutScreenshots')
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

  if (
    subMerchantLogoScreenshotFiles.length !==
    subMerchantLogoScreenshotIds.length
  ) {
    throw new AppError(
      400,
      'Each sub-merchant logo screenshot must identify its sub-merchant.',
    )
  }

  const subMerchantLogoScreenshots = subMerchantLogoScreenshotFiles.map(
    (file, index) => ({
      file,
      subMerchantId: subMerchantLogoScreenshotIds[index] ?? '',
    }),
  )

  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await saveWordpressWebsiteCase(id, auth.userId, {
    ...input,
    screenshots,
    subMerchantLogoScreenshots,
    assanpayCheckoutScreenshots,
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

caseRoutes.put(
  '/:id/document-review/sub-merchant',
  zodValidator('json', saveDocumentReviewSubMerchantSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid(
      'json' as never,
    ) as SaveDocumentReviewSubMerchantInput
    const result = await saveDocumentReviewSubMerchant(id, auth.userId, input)
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
caseRoutes.post(
  '/:id/send-for-resubmission',
  zodValidator('json', emailRecipientSelectionSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as {
      recipientEmailType: EmailRecipientType
    }
    const result = await sendForResubmission(id, auth.userId, input)
    return c.json(result)
  },
)

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

// POST /api/cases/:id/sub-merchant-form/email-proof — Upload manual Gmail proof
caseRoutes.post('/:id/sub-merchant-form/email-proof', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')

  if (!(file instanceof File)) {
    throw new AppError(400, 'Email screenshot is required.')
  }

  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await uploadSubMerchantEmailProof(id, auth.userId, { file })
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

// POST /api/cases/:id/physical-agreement/scanned-copy - Upload physical signed agreement copy
caseRoutes.post('/:id/physical-agreement/scanned-copy', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')

  if (!(file instanceof File)) {
    throw new AppError(400, 'Physical agreement copy is required.')
  }

  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await uploadPhysicalAgreementCopy(id, auth.userId, { file })
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
// POST /api/cases/:id/testing/send-credentials-mail - Send credentials and Go-Live link
caseRoutes.post(
  '/:id/testing/send-credentials-mail',
  zodValidator('json', sendMidCreationEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendMidCreationEmailInput
    const result = await sendMidCreationCredentialsEmail(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/send-for-resubmission/preview - Get resubmission email preview
caseRoutes.post(
  '/:id/send-for-resubmission/preview',
  zodValidator('json', emailRecipientSelectionSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as {
      recipientEmailType: EmailRecipientType
    }
    const result = await getResubmissionEmailPreview(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/send-for-resubmission/manual - Confirm manual resubmission email
caseRoutes.post('/:id/send-for-resubmission/manual', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }
  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')
  const tokenId = formData.get('tokenId')
  const channel = parseManualCommunicationChannel(formData.get('channel'))
  const recipientEmailType = parseEmailRecipientType(
    formData.get('recipientEmailType'),
  )
  if (!(file instanceof File))
    throw new AppError(400, 'Screenshot file is required.')
  if (typeof tokenId !== 'string' || !tokenId)
    throw new AppError(400, 'tokenId is required.')
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await confirmResubmissionEmailManual(id, auth.userId, {
    file,
    tokenId,
    channel,
    recipientEmailType,
  })
  return c.json(result)
})

// POST /api/cases/:id/agreement/send-mail/preview - Get agreement email preview
caseRoutes.post(
  '/:id/agreement/send-mail/preview',
  zodValidator('json', sendAgreementEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendAgreementEmailInput
    const result = await getAgreementEmailPreview(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/agreement/send-mail/manual - Confirm manual agreement email
caseRoutes.post('/:id/agreement/send-mail/manual', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }
  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')
  const tokenId = formData.get('tokenId')
  const remarks = formData.get('remarks')
  const channel = parseManualCommunicationChannel(formData.get('channel'))
  const recipientEmailType = parseEmailRecipientType(
    formData.get('recipientEmailType'),
  )
  if (!(file instanceof File))
    throw new AppError(400, 'Screenshot file is required.')
  if (typeof tokenId !== 'string' || !tokenId)
    throw new AppError(400, 'tokenId is required.')
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await confirmAgreementEmailManual(id, auth.userId, {
    tokenId,
    remarks: typeof remarks === 'string' ? remarks : null,
    file,
    channel,
    recipientEmailType,
  })
  return c.json(result)
})

// POST /api/cases/:id/testing/send-credentials-mail/preview - Get mid-creation email preview
caseRoutes.post(
  '/:id/testing/send-credentials-mail/preview',
  zodValidator('json', sendMidCreationEmailSchema),
  async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('id')
    const input = c.req.valid('json' as never) as SendMidCreationEmailInput
    const result = await getMidCreationEmailPreview(id, auth.userId, input)
    return c.json(result)
  },
)

// POST /api/cases/:id/testing/send-credentials-mail/manual - Confirm manual mid-creation email
caseRoutes.post('/:id/testing/send-credentials-mail/manual', async (c) => {
  const contentType = c.req.header('content-type') ?? ''
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new AppError(400, 'Content-Type must be multipart/form-data.')
  }
  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, 'Invalid multipart form payload.')
  })
  const file = formData.get('file')
  const tokenId = formData.get('tokenId')
  const channel = parseManualCommunicationChannel(formData.get('channel'))
  const recipientEmailType = parseEmailRecipientType(
    formData.get('recipientEmailType'),
  )
  if (!(file instanceof File))
    throw new AppError(400, 'Screenshot file is required.')
  if (typeof tokenId !== 'string' || !tokenId)
    throw new AppError(400, 'tokenId is required.')
  const parsed = sendMidCreationEmailSchema.safeParse({ recipientEmailType })
  if (!parsed.success)
    throw new AppError(400, parsed.error.issues[0]?.message ?? 'Invalid input.')
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await confirmMidCreationEmailManual(id, auth.userId, {
    tokenId,
    file,
    channel,
    recipientEmailType: parsed.data.recipientEmailType,
  })
  return c.json(result)
})

caseRoutes.get('/:id/comments', async (c) => {
  const id = c.req.param('id')
  const result = await listCaseComments(id, c.var.auth)
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
    const result = await createCaseComment(id, auth, input)
    return c.json(result, 201)
  },
)

// GET /api/cases/:id/history — Get case history timeline
caseRoutes.get('/:id/history', async (c) => {
  const id = c.req.param('id')
  const result = await listCaseHistory(id, c.var.auth)
  return c.json(result)
})
