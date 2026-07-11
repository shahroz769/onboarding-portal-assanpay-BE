import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { errorHandler } from '../../src/middleware/error-handler'
import { caseRoutes } from '../../src/modules/cases/cases.routes'
import { notificationRoutes } from '../../src/modules/notifications/notifications.routes'
import type { AppEnv } from '../../src/types/auth'

function createTestApp(path: string, routes: Hono<AppEnv>) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.route(path, routes)
  return app
}

describe('production route guards', () => {
  test('manual case creation rejects anonymous requests', async () => {
    const response = await createTestApp('/api/cases', caseRoutes).request(
      '/api/cases',
      {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        merchantId: crypto.randomUUID(),
        queueId: crypto.randomUUID(),
      }),
      },
    )

    expect(response.status).toBe(401)
  })

  test('the notification test backdoor is not publicly usable', async () => {
    const response = await createTestApp(
      '/api/notifications',
      notificationRoutes,
    ).request('/api/notifications/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        userId: crypto.randomUUID(),
        type: 'case_assigned',
      }),
    })

    expect([401, 404]).toContain(response.status)
  })
})
