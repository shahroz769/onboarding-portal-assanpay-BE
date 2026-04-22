import { and, count, desc, eq, lt, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  caseComments,
  cases,
  notifications,
  queues,
  users,
  type NewNotification,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import {
  buildCommentSnippet,
  buildNotificationCopy,
} from "./notifications.copy";
import { publish, type NotificationStreamEvent } from "./notifications.events";
import type {
  ListNotificationsQuery,
  NotificationType,
} from "./notifications.schemas";

// ─── List ───────────────────────────────────────────────────────────────────

export async function listForUser(userId: string, query: ListNotificationsQuery) {
  const db = getDb();

  const conds = [eq(notifications.userId, userId)];
  if (query.filter === "unread") {
    conds.push(eq(notifications.isRead, false));
  }
  if (query.cursor) {
    const cursorDate = new Date(query.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      conds.push(lt(notifications.createdAt, cursorDate));
    }
  }

  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      caseId: notifications.caseId,
      caseNumber: cases.caseNumber,
      commentId: notifications.commentId,
      actorId: notifications.actorId,
      actorName: users.name,
      metadata: notifications.metadata,
      isRead: notifications.isRead,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .leftJoin(users, eq(notifications.actorId, users.id))
    .leftJoin(cases, eq(notifications.caseId, cases.id))
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const nextCursor =
    hasMore && items.length > 0
      ? items[items.length - 1]!.createdAt.toISOString()
      : null;

  const unreadCount = await getUnreadCount(userId);

  return { items, nextCursor, unreadCount };
}

// ─── Unread Count ───────────────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: count() })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    );
  return Number(row?.count ?? 0);
}

// ─── Mark Read ──────────────────────────────────────────────────────────────

export async function markRead(userId: string, notificationId: string) {
  const db = getDb();

  const [updated] = await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.userId, userId),
      ),
    )
    .returning({
      id: notifications.id,
      isRead: notifications.isRead,
      readAt: notifications.readAt,
    });

  if (!updated) {
    throw new AppError(404, "Notification not found.");
  }

  return updated;
}

export async function markAllRead(userId: string) {
  const db = getDb();
  const result = await db
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(
      and(eq(notifications.userId, userId), eq(notifications.isRead, false)),
    )
    .returning({ id: notifications.id });

  return { updated: result.length };
}

// ─── Create + Publish ───────────────────────────────────────────────────────

type CreateNotificationInput = Omit<
  NewNotification,
  "id" | "isRead" | "readAt" | "createdAt"
>;

/**
 * Persist notifications and publish a realtime event for each recipient.
 * Best-effort: callers should wrap with try/catch to avoid breaking primary flow.
 */
export async function createBulkNotifications(rows: CreateNotificationInput[]) {
  if (rows.length === 0) return [];
  const db = getDb();

  const inserted = await db
    .insert(notifications)
    .values(rows)
    .returning();

  // Resolve actor names for stream payloads (single query)
  const actorIds = Array.from(
    new Set(inserted.map((r) => r.actorId).filter((v): v is string => !!v)),
  );
  const actorMap = new Map<string, string>();
  if (actorIds.length > 0) {
    const actors = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(sql`${users.id} = ANY(${actorIds})`);
    for (const a of actors) actorMap.set(a.id, a.name);
  }

  for (const row of inserted) {
    const event: NotificationStreamEvent = {
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      caseId: row.caseId,
      commentId: row.commentId,
      actorId: row.actorId,
      actorName: row.actorId ? (actorMap.get(row.actorId) ?? null) : null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      isRead: row.isRead,
      createdAt: row.createdAt.toISOString(),
    };
    publish(row.userId, event);
  }

  return inserted;
}

// ─── Trigger Helpers (called from cases.service) ────────────────────────────

type AssignmentNotifyInput = {
  caseId: string;
  caseNumber: string;
  queueName: string;
  actorId: string;
  actorName: string;
  newOwnerId: string | null;
  previousOwnerId: string | null;
};

export async function notifyAssignment(input: AssignmentNotifyInput) {
  const rows: CreateNotificationInput[] = [];

  if (
    input.newOwnerId &&
    input.newOwnerId !== input.actorId &&
    input.newOwnerId !== input.previousOwnerId
  ) {
    const copy = buildNotificationCopy({
      type: "case_assigned",
      caseNumber: input.caseNumber,
      queueName: input.queueName,
      actorName: input.actorName,
    });
    rows.push({
      userId: input.newOwnerId,
      actorId: input.actorId,
      type: "case_assigned",
      caseId: input.caseId,
      commentId: null,
      title: copy.title,
      body: copy.body,
      metadata: {
        caseNumber: input.caseNumber,
        queueName: input.queueName,
        actorName: input.actorName,
      },
    });
  }

  if (
    input.previousOwnerId &&
    input.previousOwnerId !== input.actorId &&
    input.previousOwnerId !== input.newOwnerId
  ) {
    const copy = buildNotificationCopy({
      type: "case_unassigned",
      caseNumber: input.caseNumber,
      queueName: input.queueName,
      actorName: input.actorName,
    });
    rows.push({
      userId: input.previousOwnerId,
      actorId: input.actorId,
      type: "case_unassigned",
      caseId: input.caseId,
      commentId: null,
      title: copy.title,
      body: copy.body,
      metadata: {
        caseNumber: input.caseNumber,
        queueName: input.queueName,
        actorName: input.actorName,
      },
    });
  }

  if (rows.length === 0) return;
  await createBulkNotifications(rows);
}

type CommentNotifyInput = {
  caseId: string;
  commentId: string;
  parentCommentId: string | null;
  authorId: string;
  mentions: string[];
  content: string;
};

/**
 * Build deduped notifications for a new comment.
 * Precedence: mention > reply > thread participant.
 */
export async function notifyOnComment(input: CommentNotifyInput) {
  const db = getDb();

  // Look up case + queue
  const [caseRow] = await db
    .select({
      id: cases.id,
      caseNumber: cases.caseNumber,
      queueName: queues.name,
    })
    .from(cases)
    .innerJoin(queues, eq(cases.queueId, queues.id))
    .where(eq(cases.id, input.caseId))
    .limit(1);

  if (!caseRow) return;

  // Look up author name
  const author = await db.query.users.findFirst({
    where: eq(users.id, input.authorId),
    columns: { name: true },
  });
  const actorName = author?.name ?? "Someone";

  const snippet = buildCommentSnippet(input.content);

  // Determine recipients with precedence
  const recipientType = new Map<string, NotificationType>();

  // 1. Mentions (highest)
  for (const userId of input.mentions) {
    if (userId === input.authorId) continue;
    recipientType.set(userId, "comment_mention");
  }

  // 2. Reply to a parent — author of parent
  if (input.parentCommentId) {
    const parent = await db.query.caseComments.findFirst({
      where: eq(caseComments.id, input.parentCommentId),
      columns: { authorId: true },
    });
    if (
      parent?.authorId &&
      parent.authorId !== input.authorId &&
      !recipientType.has(parent.authorId)
    ) {
      recipientType.set(parent.authorId, "comment_reply");
    }
  }

  // 3. Thread participants (prior commenters on this case)
  const priorAuthors = await db
    .selectDistinct({ authorId: caseComments.authorId })
    .from(caseComments)
    .where(
      and(
        eq(caseComments.caseId, input.caseId),
        sql`${caseComments.id} <> ${input.commentId}`,
      ),
    );
  for (const row of priorAuthors) {
    if (!row.authorId) continue;
    if (row.authorId === input.authorId) continue;
    if (recipientType.has(row.authorId)) continue;
    recipientType.set(row.authorId, "comment_thread");
  }

  if (recipientType.size === 0) return;

  const rows: CreateNotificationInput[] = Array.from(recipientType.entries()).map(
    ([userId, type]) => {
      const copy = buildNotificationCopy({
        type: type as
          | "comment_mention"
          | "comment_reply"
          | "comment_thread",
        caseNumber: caseRow.caseNumber,
        actorName,
        snippet,
      });
      return {
        userId,
        actorId: input.authorId,
        type,
        caseId: input.caseId,
        commentId: input.commentId,
        title: copy.title,
        body: copy.body,
        metadata: {
          caseNumber: caseRow.caseNumber,
          queueName: caseRow.queueName,
          actorName,
          snippet,
        },
      };
    },
  );

  await createBulkNotifications(rows);
}

// ─── Resubmission Notification ──────────────────────────────────────────────

type ResubmissionNotifyInput = {
  caseId: string;
  caseNumber: string;
  ownerId: string;
  clientName: string | null;
  fieldCount: number;
};

/**
 * Notify the case owner that the client has submitted updated details.
 * Best-effort: callers should wrap with try/catch to avoid breaking primary flow.
 */
export async function notifyOnResubmission(input: ResubmissionNotifyInput) {
  const copy = buildNotificationCopy({
    type: "case_resubmitted",
    caseNumber: input.caseNumber,
    clientName: input.clientName,
    fieldCount: input.fieldCount,
  });

  await createBulkNotifications([
    {
      userId: input.ownerId,
      actorId: null,
      type: "case_resubmitted",
      caseId: input.caseId,
      commentId: null,
      title: copy.title,
      body: copy.body,
      metadata: {
        caseNumber: input.caseNumber,
        clientName: input.clientName,
        fieldCount: input.fieldCount,
      },
    },
  ]);
}
