import { describe, expect, test } from 'bun:test'

import { isCaseSlaBreached } from '../../src/modules/cases/case-sla'

describe('isCaseSlaBreached', () => {
  test('uses the configured SLA boundary', () => {
    const createdAt = new Date('2026-07-01T00:00:00.000Z')

    expect(
      isCaseSlaBreached({
        createdAt,
        evaluatedAt: new Date('2026-07-01T11:59:59.000Z'),
        slaHours: 12,
      }),
    ).toBe(false)
    expect(
      isCaseSlaBreached({
        createdAt,
        evaluatedAt: new Date('2026-07-01T12:00:01.000Z'),
        slaHours: 12,
      }),
    ).toBe(true)
  })

  test('falls back to 24 hours when the queue SLA is absent', () => {
    expect(
      isCaseSlaBreached({
        createdAt: '2026-07-01T00:00:00.000Z',
        evaluatedAt: '2026-07-02T00:00:01.000Z',
        slaHours: null,
      }),
    ).toBe(true)
  })
})
