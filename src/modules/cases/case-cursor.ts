import { and, or, sql } from 'drizzle-orm'

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
  value: Date | number | string
  id: string
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

    let value: Date | number | string
    if (expected.kind === 'date') {
      if (typeof parsed.value !== 'string') {
        throw new Error('Cursor date is invalid.')
      }
      value = new Date(parsed.value)
      if (Number.isNaN(value.getTime())) {
        throw new Error('Cursor date is invalid.')
      }
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
  value: Date | number | string
  id: string
}) {
  const operator = input.sortOrder === 'desc' ? '<' : '>'
  return or(
    sql`${input.expression} ${sql.raw(operator)} ${input.value}`,
    and(
      sql`${input.expression} = ${input.value}`,
      sql`${input.idExpression} ${sql.raw(operator)} ${input.id}`,
    ),
  )!
}
