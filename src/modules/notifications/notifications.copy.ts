import type { NotificationType } from "./notifications.schemas";

const SNIPPET_LENGTH = 140;

/** Strip @mention syntax (`@[Name](uuid)` or plain `@name`) and clip to length. */
export function buildCommentSnippet(content: string): string {
  const stripped = content
    .replace(/@\[([^\]]+)\]\([^)]+\)/g, "@$1")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length <= SNIPPET_LENGTH) return stripped;
  return `${stripped.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…`;
}

type CaseAssignedCopy = {
  type: Extract<NotificationType, "case_assigned" | "case_unassigned">;
  caseNumber: string;
  queueName: string;
  actorName: string;
};

type CommentCopy = {
  type: Extract<
    NotificationType,
    "comment_mention" | "comment_reply" | "comment_thread"
  >;
  caseNumber: string;
  actorName: string;
  snippet: string;
};

type CaseResubmittedCopy = {
  type: Extract<NotificationType, "case_resubmitted">;
  caseNumber: string;
  clientName: string | null;
  fieldCount: number;
};

export type NotificationCopy = CaseAssignedCopy | CommentCopy | CaseResubmittedCopy;

export function buildNotificationCopy(input: NotificationCopy): {
  title: string;
  body: string;
} {
  switch (input.type) {
    case "case_assigned":
      return {
        title: `Case ${input.caseNumber} assigned to you`,
        body: `${input.actorName} assigned this ${input.queueName} case to you.`,
      };
    case "case_unassigned":
      return {
        title: `You're no longer assigned to ${input.caseNumber}`,
        body: `${input.actorName} reassigned this case in ${input.queueName}.`,
      };
    case "comment_mention":
      return {
        title: `${input.actorName} mentioned you on ${input.caseNumber}`,
        body: input.snippet,
      };
    case "comment_reply":
      return {
        title: `${input.actorName} replied on ${input.caseNumber}`,
        body: input.snippet,
      };
    case "comment_thread":
      return {
        title: `New comment on ${input.caseNumber}`,
        body: `${input.actorName}: ${input.snippet}`,
      };
    case "case_resubmitted":
      return {
        title: `Case ${input.caseNumber} — client submitted updated details`,
        body: `${input.clientName ?? "The client"} resubmitted ${input.fieldCount} field${input.fieldCount === 1 ? "" : "s"} for your review.`,
      };
  }
}
