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
