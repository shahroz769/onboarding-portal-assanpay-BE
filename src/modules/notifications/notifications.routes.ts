import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import { zodValidator } from '../../lib/validators'
import { requireAuth } from '../../middleware/auth'
import type { AppEnv } from '../../types/auth'
import {
  createBulkNotifications,
  getUnreadCount,
  listForUser,
  markAllRead,
  markRead,
} from './notifications.service'
import { subscribe } from './notifications.events'
import {
  listNotificationsQuerySchema,
  testNotificationBodySchema,
} from './notifications.schemas'
import type {
  ListNotificationsQuery,
  TestNotificationBody,
} from './notifications.schemas'

export const notificationRoutes = new Hono<AppEnv>()
const NOTIFICATION_STREAM_HEARTBEAT_MS = 25_000

type NotificationStreamMessage = {
  event: 'notification' | 'ping' | 'ready'
  data: string
  id?: string
}

// POST /api/notifications/test — public, no auth (dev/testing only)
notificationRoutes.post(
  '/test',
  zodValidator('json', testNotificationBodySchema),
  async (c) => {
    const { userId, type, title, body } = c.req.valid(
      'json' as never,
    ) as TestNotificationBody
    const defaultTitle = title ?? `[Test] ${type}`
    const defaultBody =
      body ?? `This is a manual test notification of type "${type}".`

    const [notification] = await createBulkNotifications([
      { userId, type, title: defaultTitle, body: defaultBody },
    ])

    return c.json({ ok: true, notification }, 201)
  },
)

notificationRoutes.use('*', requireAuth)

// GET /api/notifications — paginated list
notificationRoutes.get(
  '/',
  zodValidator('query', listNotificationsQuerySchema),
  async (c) => {
    const auth = c.get('auth')
    const query = c.req.valid('query' as never) as ListNotificationsQuery
    const result = await listForUser(auth.userId, query)
    return c.json(result)
  },
)

// GET /api/notifications/unread-count
notificationRoutes.get('/unread-count', async (c) => {
  const auth = c.get('auth')
  const count = await getUnreadCount(auth.userId)
  return c.json({ count })
})

// PATCH /api/notifications/read-all
notificationRoutes.patch('/read-all', async (c) => {
  const auth = c.get('auth')
  const result = await markAllRead(auth.userId)
  return c.json(result)
})

// PATCH /api/notifications/:id/read
notificationRoutes.patch('/:id/read', async (c) => {
  const auth = c.get('auth')
  const id = c.req.param('id')
  const result = await markRead(auth.userId, id)
  return c.json(result)
})

// GET /api/notifications/stream — SSE
notificationRoutes.get('/stream', (c) => {
  const auth = c.get('auth')

  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('Connection', 'keep-alive')
  c.header('Content-Encoding', 'Identity')
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(
    c,
    async (stream) => {
      const queue: NotificationStreamMessage[] = []
      let wakeWaiter: (() => void) | null = null
      let cleanedUp = false

      const wake = () => {
        if (!wakeWaiter) return
        const resolve = wakeWaiter
        wakeWaiter = null
        resolve()
      }

      const enqueue = (event: NotificationStreamMessage) => {
        if (cleanedUp) return
        queue.push(event)
        wake()
      }

      const unsubscribe = subscribe(auth.userId, (event) => {
        enqueue({
          event: 'notification',
          data: JSON.stringify(event),
          id: event.id,
        })
      })

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        unsubscribe()
        wake()
      }

      const waitForNextMessage =
        async (): Promise<NotificationStreamMessage | null> => {
          if (queue.length > 0) {
            return queue.shift() ?? null
          }

          return new Promise((resolve) => {
            const heartbeat = setTimeout(() => {
              wakeWaiter = null
              resolve({ event: 'ping', data: String(Date.now()) })
            }, NOTIFICATION_STREAM_HEARTBEAT_MS)

            wakeWaiter = () => {
              clearTimeout(heartbeat)
              resolve(queue.shift() ?? null)
            }
          })
        }

      const writeSse = async (message: NotificationStreamMessage) => {
        if (stream.aborted || stream.closed || cleanedUp) return false
        try {
          await stream.writeSSE(message)
          return true
        } catch {
          return false
        }
      }

      stream.onAbort(() => {
        cleanup()
      })
      c.req.raw.signal.addEventListener('abort', cleanup, { once: true })

      try {
        if (!(await writeSse({ event: 'ready', data: 'ok' }))) {
          return
        }

        while (!stream.aborted && !stream.closed) {
          const next = await waitForNextMessage()
          if (!next) break
          if (!(await writeSse(next))) break
        }
      } finally {
        cleanup()
      }
    },
    async (error, stream) => {
      if (stream.aborted || stream.closed) return
      console.error('[notifications.stream] SSE error', error)
    },
  )
})
