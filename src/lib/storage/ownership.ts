import { and, eq, inArray } from 'drizzle-orm'

import { getDb } from '../../db/client'
import { storageObjects } from '../../db/schema'
import type { NewStorageObject, StorageObject } from '../../db/schema'
import { AppError } from '../errors'
import type {
  FileStorageProvider,
  GoogleDriveVisibility,
} from './google-drive'

export const STORAGE_PROVIDER = 'google_drive' as const

export type StorageObjectKind = 'file' | 'folder'
export type StorageObjectLifecycle =
  | 'provisioning'
  | 'current'
  | 'superseded'
  | 'failed'

export type RecordStorageObjectInput = {
  providerObjectId: string
  objectKind: StorageObjectKind
  visibility: GoogleDriveVisibility
  attemptId: string
  merchantId?: string | null
  caseId?: string | null
  parentProviderObjectId?: string | null
  lifecycle?: StorageObjectLifecycle
  metadata?: Record<string, unknown> | null
}

export function createStorageAttemptId() {
  return crypto.randomUUID()
}

export async function recordStorageObject(input: RecordStorageObjectInput) {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .insert(storageObjects)
    .values({
      provider: STORAGE_PROVIDER,
      providerObjectId: input.providerObjectId,
      objectKind: input.objectKind,
      merchantId: input.merchantId ?? null,
      caseId: input.caseId ?? null,
      visibility: input.visibility,
      attemptId: input.attemptId,
      lifecycle: input.lifecycle ?? 'provisioning',
      parentProviderObjectId: input.parentProviderObjectId ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    } satisfies NewStorageObject)
    .returning()

  if (!row) {
    throw new AppError(500, 'Failed to record storage object ownership.')
  }

  return row
}

export async function markStorageObjectsLifecycle(
  providerObjectIds: string[],
  lifecycle: StorageObjectLifecycle,
) {
  if (providerObjectIds.length === 0) return

  const db = getDb()
  await db
    .update(storageObjects)
    .set({
      lifecycle,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(storageObjects.provider, STORAGE_PROVIDER),
        inArray(storageObjects.providerObjectId, providerObjectIds),
      ),
    )
}

export async function markAttemptObjectsFailed(attemptId: string) {
  const db = getDb()
  await db
    .update(storageObjects)
    .set({
      lifecycle: 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(storageObjects.attemptId, attemptId),
        inArray(storageObjects.lifecycle, ['provisioning', 'current']),
      ),
    )
}

export async function supersedeStorageObjects(providerObjectIds: string[]) {
  const uniqueIds = Array.from(
    new Set(providerObjectIds.filter((id): id is string => Boolean(id))),
  )
  if (uniqueIds.length === 0) return

  const db = getDb()
  const existing = await db.query.storageObjects.findMany({
    where: and(
      eq(storageObjects.provider, STORAGE_PROVIDER),
      inArray(storageObjects.providerObjectId, uniqueIds),
    ),
    columns: {
      providerObjectId: true,
    },
  })
  const knownIds = existing.map((row) => row.providerObjectId)
  if (knownIds.length === 0) return

  await markStorageObjectsLifecycle(knownIds, 'superseded')
}

export async function listAttemptStorageObjects(attemptId: string) {
  const db = getDb()
  return db.query.storageObjects.findMany({
    where: eq(storageObjects.attemptId, attemptId),
  })
}

/**
 * Deletes only Drive objects that were created by this attempt and recorded
 * in the ownership ledger. Never deletes find-or-create results without a
 * matching ownership row for the attempt.
 */
export async function cleanupFailedAttemptObjects(input: {
  attemptId: string
  storage: FileStorageProvider
}) {
  const objects = await listAttemptStorageObjects(input.attemptId)
  await markAttemptObjectsFailed(input.attemptId)

  const deletable = objects
    .filter((row) => row.lifecycle !== 'superseded')
    .sort((left, right) => rankForCleanup(right) - rankForCleanup(left))

  for (const object of deletable) {
    if (isPendingClaimObjectId(object.providerObjectId)) {
      continue
    }

    await input.storage.deleteFile(object.providerObjectId).catch((error) => {
      console.error('[storage-ownership.cleanup]', {
        attemptId: input.attemptId,
        providerObjectId: object.providerObjectId,
        error,
      })
    })
  }
}

export function buildPendingRootClaimObjectId(attemptId: string) {
  return `pending-root:${attemptId}`
}

export function isPendingClaimObjectId(providerObjectId: string) {
  return providerObjectId.startsWith('pending-root:')
}

export async function finalizeRootClaim(input: {
  claim: StorageObject
  providerObjectId: string
  parentProviderObjectId: string
}) {
  const db = getDb()
  const now = new Date()
  const [row] = await db
    .update(storageObjects)
    .set({
      providerObjectId: input.providerObjectId,
      parentProviderObjectId: input.parentProviderObjectId,
      lifecycle: 'current',
      updatedAt: now,
      metadata: {
        ...(asRecord(input.claim.metadata) ?? {}),
        role: 'merchant_root',
      },
    })
    .where(eq(storageObjects.id, input.claim.id))
    .returning()

  if (!row) {
    throw new AppError(500, 'Failed to finalize merchant root ownership claim.')
  }

  return row
}

function rankForCleanup(object: StorageObject) {
  return object.objectKind === 'file' ? 2 : 1
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}
