/**
 * In-process pub/sub for the notifications stream.
 * Each connected SSE client registers a writer for its userId.
 * Service code calls `publish(userId, event)` to fan out a notification, or
 * `publishCaseEmailStatus` for a live signal that is never stored.
 *
 * Note: single-process only. For multi-instance deployments, swap with Redis pub/sub.
 */

export type NotificationStreamEvent = {
  id: string
  type: string
  title: string
  body: string
  caseId: string | null
  caseNumber: string | null
  commentId: string | null
  actorId: string | null
  actorName: string | null
  metadata: Record<string, unknown> | null
  isRead: boolean
  readAt: string | null
  createdAt: string
}

/**
 * A case email's delivery status changed (Resend webhook or a status check).
 * Only refreshes open case pages; it isn't a notification and isn't saved.
 */
export type CaseEmailStatusEvent = {
  caseId: string
  emailLogId: string
  status: string
}

export type StreamMessage =
  | { event: 'notification'; data: NotificationStreamEvent }
  | { event: 'case-email-status'; data: CaseEmailStatusEvent }

type Subscriber = (message: StreamMessage) => void

const subscribers = new Map<string, Set<Subscriber>>()

export function subscribe(userId: string, fn: Subscriber): () => void {
  let set = subscribers.get(userId)
  if (!set) {
    set = new Set()
    subscribers.set(userId, set)
  }
  set.add(fn)

  return () => {
    const current = subscribers.get(userId)
    if (!current) return
    current.delete(fn)
    if (current.size === 0) {
      subscribers.delete(userId)
    }
  }
}

function send(userId: string, message: StreamMessage): void {
  const set = subscribers.get(userId)
  if (!set || set.size === 0) return
  for (const fn of set) {
    try {
      fn(message)
    } catch (error) {
      console.error('[notifications.events] subscriber error', error)
    }
  }
}

export function publish(userId: string, event: NotificationStreamEvent): void {
  send(userId, { event: 'notification', data: event })
}

export function publishCaseEmailStatus(
  userId: string,
  event: CaseEmailStatusEvent,
): void {
  send(userId, { event: 'case-email-status', data: event })
}
