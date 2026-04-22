import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { zodValidator } from "../../lib/validators";
import { requireAuth } from "../../middleware/auth";
import type { AppEnv } from "../../types/auth";
import {
  createBulkNotifications,
  getUnreadCount,
  listForUser,
  markAllRead,
  markRead,
} from "./notifications.service";
import { subscribe } from "./notifications.events";
import { listNotificationsQuerySchema, testNotificationBodySchema } from "./notifications.schemas";
import type { ListNotificationsQuery, TestNotificationBody } from "./notifications.schemas";

export const notificationRoutes = new Hono<AppEnv>();

// POST /api/notifications/test — public, no auth (dev/testing only)
notificationRoutes.post(
  "/test",
  zodValidator("json", testNotificationBodySchema),
  async (c) => {
    const { userId, type, title, body } = c.req.valid("json" as never) as TestNotificationBody;
    const defaultTitle = title ?? `[Test] ${type}`;
    const defaultBody = body ?? `This is a manual test notification of type "${type}".`;

    const [notification] = await createBulkNotifications([
      { userId, type, title: defaultTitle, body: defaultBody },
    ]);

    return c.json({ ok: true, notification }, 201);
  },
);

notificationRoutes.use("*", requireAuth);

// GET /api/notifications — paginated list
notificationRoutes.get(
  "/",
  zodValidator("query", listNotificationsQuerySchema),
  async (c) => {
    const auth = c.get("auth");
    const query = c.req.valid("query" as never) as ListNotificationsQuery;
    const result = await listForUser(auth.userId, query);
    return c.json(result);
  },
);

// GET /api/notifications/unread-count
notificationRoutes.get("/unread-count", async (c) => {
  const auth = c.get("auth");
  const count = await getUnreadCount(auth.userId);
  return c.json({ count });
});

// PATCH /api/notifications/read-all
notificationRoutes.patch("/read-all", async (c) => {
  const auth = c.get("auth");
  const result = await markAllRead(auth.userId);
  return c.json(result);
});

// PATCH /api/notifications/:id/read
notificationRoutes.patch("/:id/read", async (c) => {
  const auth = c.get("auth");
  const id = c.req.param("id");
  const result = await markRead(auth.userId, id);
  return c.json(result);
});

// GET /api/notifications/stream — SSE
notificationRoutes.get("/stream", (c) => {
  const auth = c.get("auth");

  return streamSSE(c, async (stream) => {
    const queue: Array<unknown> = [];
    let resolveNext: (() => void) | null = null;
    let cleanedUp = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const wake = () => {
      if (!resolveNext) return;
      const resolve = resolveNext;
      resolveNext = null;
      resolve();
    };

    const enqueue = (event: unknown) => {
      queue.push(event);
      wake();
    };

    const unsubscribe = subscribe(auth.userId, (event) => {
      enqueue({ event: "notification", data: JSON.stringify(event) });
    });

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      unsubscribe();
      wake();
    };

    stream.onAbort(() => {
      cleanup();
    });

    // Ready event
    await stream.writeSSE({ event: "ready", data: "ok" });

    // Heartbeat every 25s
    heartbeat = setInterval(() => {
      enqueue({ event: "ping", data: String(Date.now()) });
    }, 25_000);

    try {
      while (!stream.aborted && !stream.closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
        const next = queue.shift() as
          | { event: string; data: string }
          | undefined;
        if (!next) continue;
        await stream.writeSSE(next);
      }
    } finally {
      cleanup();
    }
  });
});
