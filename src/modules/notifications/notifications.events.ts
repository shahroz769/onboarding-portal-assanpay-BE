/**
 * In-process pub/sub for notifications.
 * Each connected SSE client registers a writer for its userId.
 * Service code calls `publish(userId, event)` to fan out.
 *
 * Note: single-process only. For multi-instance deployments, swap with Redis pub/sub.
 */

export type NotificationStreamEvent = {
  id: string;
  type: string;
  title: string;
  body: string;
  caseId: string | null;
  commentId: string | null;
  actorId: string | null;
  actorName: string | null;
  metadata: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
};

type Subscriber = (event: NotificationStreamEvent) => void;

const subscribers = new Map<string, Set<Subscriber>>();

export function subscribe(userId: string, fn: Subscriber): () => void {
  let set = subscribers.get(userId);
  if (!set) {
    set = new Set();
    subscribers.set(userId, set);
  }
  set.add(fn);

  return () => {
    const current = subscribers.get(userId);
    if (!current) return;
    current.delete(fn);
    if (current.size === 0) {
      subscribers.delete(userId);
    }
  };
}

export function publish(userId: string, event: NotificationStreamEvent): void {
  const set = subscribers.get(userId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (error) {
      console.error("[notifications.events] subscriber error", error);
    }
  }
}

export function subscriberCount(userId: string): number {
  return subscribers.get(userId)?.size ?? 0;
}
