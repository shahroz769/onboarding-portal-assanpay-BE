import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { getDb } from '../../db/client'
import {
  caseComments,
  caseFiles,
  caseHistory,
  cases,
  merchants,
  users,
} from '../../db/schema'
import { AppError } from '../../lib/errors'
import type { SessionUser } from '../../types/auth'
import { notifyOnComment } from '../notifications/notifications.service'
import type { CreateCommentInput } from './cases.schemas'
import { assertCanViewCase, assertCanWorkCase } from './case-access.service'

import {
  enrichResubmissionWhatsappHistoryDetails,
  getStringDetail,
  sanitizeCaseHistoryDetails,
} from './case-history-format'

export async function listCaseComments(caseId: string, actor: SessionUser) {
  const db = getDb()
  await assertCanViewCase(caseId, actor)

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const comments = await db
    .select({
      id: caseComments.id,
      caseId: caseComments.caseId,
      authorId: caseComments.authorId,
      authorName: users.name,
      authorUsername: users.username,
      content: caseComments.content,
      parentId: caseComments.parentId,
      mentions: caseComments.mentions,
      createdAt: caseComments.createdAt,
      updatedAt: caseComments.updatedAt,
    })
    .from(caseComments)
    .leftJoin(users, eq(caseComments.authorId, users.id))
    .where(eq(caseComments.caseId, caseId))
    .orderBy(asc(caseComments.createdAt))

  return comments
}

export async function createCaseComment(
  caseId: string,
  actor: SessionUser,
  input: CreateCommentInput,
) {
  const db = getDb()
  await assertCanWorkCase(caseId, actor.userId)

  // Verify parent comment exists if provided
  if (input.parentId) {
    const parent = await db.query.caseComments.findFirst({
      where: and(
        eq(caseComments.id, input.parentId),
        eq(caseComments.caseId, caseId),
      ),
      columns: { id: true },
    })
    if (!parent) {
      throw new AppError(404, 'Parent comment not found.')
    }
  }

  const [created] = await db
    .insert(caseComments)
    .values({
      caseId,
      authorId: actor.userId,
      content: input.content,
      parentId: input.parentId ?? null,
      mentions: input.mentions ?? null,
    })
    .returning()

  // Notifications (best-effort)
  if (created) {
    try {
      await notifyOnComment({
        caseId,
        commentId: created.id,
        parentCommentId: input.parentId ?? null,
        authorId: actor.userId,
        mentions: input.mentions ?? [],
        content: input.content,
      })
    } catch (error) {
      console.error('[notifications] createCaseComment notify failed', error)
    }
  }

  return created
}

// ─── Case History ───────────────────────────────────────────────────────────

export async function listCaseHistory(caseId: string, actor: SessionUser) {
  const db = getDb()
  await assertCanViewCase(caseId, actor)

  // Verify case exists
  const existing = await db.query.cases.findFirst({
    where: eq(cases.id, caseId),
    columns: { id: true, merchantId: true },
  })

  if (!existing) {
    throw new AppError(404, 'Case not found.')
  }

  const history = await db
    .select({
      id: caseHistory.id,
      caseId: caseHistory.caseId,
      actorId: caseHistory.actorId,
      actorName: users.name,
      action: caseHistory.action,
      details: caseHistory.details,
      createdAt: caseHistory.createdAt,
    })
    .from(caseHistory)
    .leftJoin(users, eq(caseHistory.actorId, users.id))
    .where(
      and(
        eq(caseHistory.caseId, caseId),
        sql`${caseHistory.action} <> 'comment_added'`,
      ),
    )
    .orderBy(
      desc(caseHistory.createdAt),
      sql`case
        when ${caseHistory.action} = 'resubmission_email_sent' then 2
        when ${caseHistory.action} = 'rejections_prepared' then 1
        else 0
      end desc`,
      desc(caseHistory.id),
    )

  const merchantContact = await db.query.merchants.findFirst({
    where: eq(merchants.id, existing.merchantId),
    columns: { activeWhatsappNumber: true },
  })
  const activeWhatsappNumber = merchantContact?.activeWhatsappNumber ?? null

  const sanitizedHistory = history.map((entry) => ({
    ...entry,
    details: enrichResubmissionWhatsappHistoryDetails(
      entry.action,
      sanitizeCaseHistoryDetails(entry.action, entry.details),
      activeWhatsappNumber,
    ),
  }))
  const screenshotFileIds = sanitizedHistory
    .map((entry) => getStringDetail(entry.details, 'screenshotFileId'))
    .filter((id): id is string => Boolean(id))

  if (screenshotFileIds.length === 0) return sanitizedHistory

  const proofFiles = await db
    .select({
      id: caseFiles.id,
      originalName: caseFiles.originalName,
      mimeType: caseFiles.mimeType,
      sizeBytes: caseFiles.sizeBytes,
      googleDriveWebViewLink: caseFiles.googleDriveWebViewLink,
      googleDriveDownloadLink: caseFiles.googleDriveDownloadLink,
      createdAt: caseFiles.createdAt,
    })
    .from(caseFiles)
    .where(inArray(caseFiles.id, screenshotFileIds))
  const proofFileById = new Map(proofFiles.map((file) => [file.id, file]))

  return sanitizedHistory.map((entry) => {
    const screenshotFileId = getStringDetail(entry.details, 'screenshotFileId')
    const proofFile = screenshotFileId
      ? proofFileById.get(screenshotFileId)
      : null

    if (!proofFile) return entry

    return {
      ...entry,
      details: {
        ...(entry.details as Record<string, unknown>),
        proofFile: {
          ...proofFile,
          createdAt: proofFile.createdAt.toISOString(),
        },
      },
    }
  })
}
