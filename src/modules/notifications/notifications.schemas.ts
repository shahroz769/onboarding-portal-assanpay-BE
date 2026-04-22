import { z } from "zod";

export const notificationTypeValues = [
  "case_assigned",
  "case_unassigned",
  "comment_mention",
  "comment_reply",
  "comment_thread",
] as const;

export type NotificationType = (typeof notificationTypeValues)[number];

export const listNotificationsQuerySchema = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
  filter: z.enum(["all", "unread"]).default("all"),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const testNotificationBodySchema = z.object({
  userId: z.string().uuid("userId must be a valid UUID"),
  type: z.enum(notificationTypeValues).default("case_assigned"),
  title: z.string().min(1).max(255).optional(),
  body: z.string().min(1).max(1000).optional(),
});

export type TestNotificationBody = z.infer<typeof testNotificationBodySchema>;
