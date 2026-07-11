import { expect, test } from 'bun:test'

import { hashToken } from '../../src/lib/security'

test('public bearer tokens are represented by deterministic one-way hashes', async () => {
  const token = 'synthetic-test-token'
  const hash = await hashToken(token)

  expect(hash).toHaveLength(64)
  expect(hash).not.toContain(token)
  expect(await hashToken(token)).toBe(hash)
  expect(await hashToken(`${token}-different`)).not.toBe(hash)
})
