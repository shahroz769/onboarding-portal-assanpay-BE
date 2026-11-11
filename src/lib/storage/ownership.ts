import { and, eq, inArray, type SQL } from 'drizzle-orm'

import { getDb, type DbTransaction } from '../../db/client'
import { storageObjects } from '../../db/schema'
import type { NewStorageObject, StorageObject } from '../../db/schema'
import { AppError } from '../errors'
import type { FileStorageProvider, GoogleDriveVisibility } from './google-drive'

export const STORAGE_PROVIDER = 'google_drive' as const

export type StorageObjectKind = 'file' | 'folder'
export type StorageObjectLifecycle =
  | 'provisioning'
  | 'current'
  | 'superseded'
  | 'failed'
  | 'deleted'

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

/**
 * The storage-object lifecycle. An object starts as provisioning while its
 * attempt is in flight, becomes current in the same transaction that commits
 * the rows pointing at it, and is superseded when a newer file replaces it.
 * Only provisioning objects can fail, so failed-attempt cleanup never deletes
 * a committed object. Migration 0105 enforces the same moves.
 *
 *   provisioning ──▶ current ──▶ superseded ──▶ deleted
 *        │             └──────────────────────▶ deleted
 *        └──▶ failed ──▶ deleted
 */
export const STORAGE_LIFECYCLE_TRANSITIONS: Record<
  StorageObjectLifecycle,
  readonly StorageObjectLifecycle[]
> = {
  provisioning: ['current', 'failed', 'deleted'],
  current: ['superseded', 'deleted'],
  superseded: ['deleted'],
  failed: ['deleted'],
  deleted: [],
}

function sourcesFor(target: StorageObjectLifecycle) {
  return (
    Object.keys(STORAGE_LIFECYCLE_TRANSITIONS) as StorageObjectLifecycle[]
  ).filter((from) => STORAGE_LIFECYCLE_TRANSITIONS[from].includes(target))
}

type StorageExecutor = ReturnType<typeof getDb> | DbTransaction

/**
 * The only writer of storage_objects.lifecycle. Moves the matched objects to
 * `target`, leaving any that cannot make that move as they are.
 */
async function moveStorageObjects(
  db: StorageExecutor,
  where: SQL,
  target: StorageObjectLifecycle,
) {
  return db
    .update(storageObjects)
    .set({ lifecycle: target, updatedAt: new Date() })
    .where(and(where, inArray(storageObjects.lifecycle, sourcesFor(target))))
    .returning({
      id: storageObjects.id,
      providerObjectId: storageObjects.providerObjectId,
    })
}

function byProviderObjectIds(providerObjectIds: string[]) {
  return and(
    eq(storageObjects.provider, STORAGE_PROVIDER),
    inArray(storageObjects.providerObjectId, providerObjectIds),
  )!
}

/**
 * Commits an attempt's objects. Call it inside the transaction that writes
 * the rows pointing at them, so they are current exactly when those rows are.
 */
export async function markAttemptObjectsCurrent(
  db: StorageExecutor,
  attemptId: string,
) {
  return moveStorageObjects(
    db,
    eq(storageObjects.attemptId, attemptId),
    'current',
  )
}

/** Records Drive objects as removed from Drive. */
export async function markStorageObjectsDeleted(providerObjectIds: string[]) {
  if (providerObjectIds.length === 0) return
  await moveStorageObjects(
    getDb(),
    byProviderObjectIds(providerObjectIds),
    'deleted',
  )
}

/** Fails the attempt's objects that never committed. */
export async function markAttemptObjectsFailed(attemptId: string) {
  return moveStorageObjects(
    getDb(),
    eq(storageObjects.attemptId, attemptId),
    'failed',
  )
}

/** Marks replaced files superseded; unknown ids are ignored. */
export async function supersedeStorageObjects(providerObjectIds: string[]) {
  const uniqueIds = Array.from(
    new Set(providerObjectIds.filter((id): id is string => Boolean(id))),
  )
  if (uniqueIds.length === 0) return

  await moveStorageObjects(
    getDb(),
    byProviderObjectIds(uniqueIds),
    'superseded',
  )
}

export async function listAttemptStorageObjects(attemptId: string) {
  const db = getDb()
  return db.query.storageObjects.findMany({
    where: eq(storageObjects.attemptId, attemptId),
  })
}

/**
 * Deletes only Drive objects that were created by this attempt, recorded in
 * the ownership ledger, and never committed. Never deletes find-or-create results without a
 * matching ownership row for the attempt.
 */
export async function cleanupFailedAttemptObjects(input: {
  attemptId: string
  storage: FileStorageProvider
}) {
  await markAttemptObjectsFailed(input.attemptId)
  // Committed (current, superseded) objects are never deleted here; failed
  // ones from an earlier cleanup are retried.
  const deletable = (await listAttemptStorageObjects(input.attemptId))
    .filter((row) => row.lifecycle === 'failed')
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

/**
 * Binds the created root folder to its claim. The claim stays provisioning
 * until the merchant row points at the folder (markAttemptObjectsCurrent).
 */
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
      updatedAt: now,
      metadata: {
        ...asRecord(input.claim.metadata),
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
