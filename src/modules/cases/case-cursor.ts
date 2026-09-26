import { and, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { AppError } from '../../lib/errors'

export function parseCsvValues<TValue extends string>(
  rawValue: string,
  allowedValues: ReadonlySet<string>,
) {
  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(
      (value): value is TValue => value.length > 0 && allowedValues.has(value),
    )
}

// ─── Case Number Generation ─────────────────────────────────────────────────

export type KeysetCursorKind = 'date' | 'number' | 'string'

export type DecodedKeysetCursor = {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  kind: KeysetCursorKind
  value: number | string
  id: string
}

// Postgres timestamps keep microseconds but JS Dates only keep milliseconds, so
// date cursors round-trip as full-precision UTC ISO strings instead of Dates.
const cursorTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

export function keysetCursorExpression(spec: {
  expression: PgColumn | SQL
  kind: KeysetCursorKind
}) {
  if (spec.kind !== 'date') return spec.expression
  return sql<string>`to_char(${spec.expression} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

export function encodeKeysetCursor(input: {
  sortBy: string
  sortOrder: 'asc' | 'desc'
  value: unknown
  id: string
}) {
  return btoa(
    encodeURIComponent(
      JSON.stringify({
        ...input,
        value:
          input.value instanceof Date ? input.value.toISOString() : input.value,
      }),
    ),
  )
}

export function decodeKeysetCursor(
  rawCursor: string,
  expected: {
    sortBy: string
    sortOrder: 'asc' | 'desc'
    kind: KeysetCursorKind
  },
): DecodedKeysetCursor {
  try {
    const parsed = JSON.parse(decodeURIComponent(atob(rawCursor))) as {
      sortBy?: unknown
      sortOrder?: unknown
      value?: unknown
      id?: unknown
    }

    if (
      parsed.sortBy !== expected.sortBy ||
      parsed.sortOrder !== expected.sortOrder ||
      typeof parsed.id !== 'string'
    ) {
      throw new Error('Cursor does not match the active sort.')
    }

    let value: number | string
    if (expected.kind === 'date') {
      if (
        typeof parsed.value !== 'string' ||
        !cursorTimestampPattern.test(parsed.value) ||
        Number.isNaN(
          new Date(parsed.value.replace(/(\.\d{3})\d+/, '$1')).getTime(),
        )
      ) {
        throw new Error('Cursor date is invalid.')
      }
      value = parsed.value
    } else if (expected.kind === 'number') {
      value = Number(parsed.value)
      if (!Number.isFinite(value)) {
        throw new Error('Cursor number is invalid.')
      }
    } else {
      if (typeof parsed.value !== 'string') {
        throw new Error('Cursor value is invalid.')
      }
      value = parsed.value
    }

    return {
      sortBy: expected.sortBy,
      sortOrder: expected.sortOrder,
      kind: expected.kind,
      value,
      id: parsed.id,
    }
  } catch {
    throw new AppError(400, 'Invalid pagination cursor.')
  }
}

export function buildKeysetCondition(input: {
  expression: unknown
  idExpression: unknown
  sortOrder: 'asc' | 'desc'
  kind: KeysetCursorKind
  value: number | string
  id: string
}) {
  const operator = input.sortOrder === 'desc' ? '<' : '>'
  // Raw SQL parameters do not inherit the timestamp column's Drizzle encoder,
  // so date cursors stay ISO strings and are cast on the Postgres side.
  const value =
    input.kind === 'date' ? sql`${input.value}::timestamptz` : input.value

  return or(
    sql`${input.expression} ${sql.raw(operator)} ${value}`,
    and(
      sql`${input.expression} = ${value}`,
      sql`${input.idExpression} ${sql.raw(operator)} ${input.id}`,
    ),
  )!
}
