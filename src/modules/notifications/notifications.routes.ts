import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { zodValidator } from "../../lib/validators";
import { requireAuth } from "../../middleware/auth";
import type { AppEnv } from "../../types/auth";
import {
  getUnreadCount,
  listForUser,
  markAllRead,
  markRead,
} from "./notifications.service";
import { subscribe } from "./notifications.events";
import {
  listNotificationsQuerySchema,
  type ListNotificationsQuery,
} from "./notifications.schemas";

export const notificationRoutes = new Hono<AppEnv>();

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
    let queue: Array<unknown> = [];
    let resolveNext: (() => void) | null = null;

    const enqueue = (event: unknown) => {
      queue.push(event);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r();
      }
    };

    const unsubscribe = subscribe(auth.userId, (event) => {
      enqueue({ event: "notification", data: JSON.stringify(event) });
    });

    stream.onAbort(() => {
      unsubscribe();
    });

    // Ready event
    await stream.writeSSE({ event: "ready", data: "ok" });

    // Heartbeat every 25s
    const heartbeat = setInterval(() => {
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
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});
