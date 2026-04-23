import { asc, eq } from "drizzle-orm";

import { queueStages, type NewQueueStage, type QueueStage } from "../../db/schema";
import type { CaseStatusValue, StageCategoryValue } from "../cases/cases.schemas";

type QueueStageDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
};

type QueueStageSeedInput = {
  id: string;
  name: string;
  slug: string;
  qcEnabled: boolean;
};

const defaultStageNames = {
  new: "New",
  in_progress: "Working",
  qc: "QC",
  error: "Error",
  closed: "Closed",
} as const satisfies Record<StageCategoryValue, string>;

function getStatusForStage(stage: Pick<QueueStage, "category" | "slug" | "name">): CaseStatusValue {
  const normalizedSlug = stage.slug.trim().toLowerCase();
  const normalizedName = stage.name.trim().toLowerCase();

  if (
    normalizedSlug === "awaiting_client" ||
    normalizedSlug === "awaiting-client" ||
    normalizedName === "awaiting client"
  ) {
    return "awaiting_client";
  }

  if (normalizedSlug === "pending" || normalizedName === "pending") {
    return "pending";
  }

  if (normalizedSlug === "working" || normalizedName === "working") {
    return "working";
  }

  if (normalizedSlug === "error" || normalizedName === "error") {
    return "error";
  }

  switch (stage.category) {
    case "new":
      return "new";
    case "in_progress":
      return "working";
    case "qc":
      return "qc";
    case "error":
      return "error";
    case "closed":
      return "closed";
  }
}

function stageMatchesStatus(
  stage: Pick<QueueStage, "category" | "slug" | "name">,
  status: CaseStatusValue,
) {
  return getStatusForStage(stage) === status;
}

function createDefaultQueueStageDefinitions(queue: QueueStageSeedInput) {
  if (queue.slug === "documents-review") {
    return [
      {
        name: defaultStageNames.new,
        slug: "new",
        order: 1,
        category: "new",
      },
      {
        name: defaultStageNames.in_progress,
        slug: "working",
        order: 2,
        category: "in_progress",
      },
      {
        name: "Awaiting Client",
        slug: "awaiting_client",
        order: 3,
        category: "in_progress",
      },
      {
        name: defaultStageNames.closed,
        slug: "closed",
        order: 4,
        category: "closed",
      },
    ] satisfies Array<
      Pick<NewQueueStage, "name" | "slug" | "order" | "category">
    >;
  }

  return [] satisfies Array<
    Pick<NewQueueStage, "name" | "slug" | "order" | "category">
  >;
}

function hasStageEquivalent(
  queue: QueueStageSeedInput,
  existingStages: QueueStage[],
  stageSlug: string,
) {
  if (existingStages.some((stage) => stage.slug === stageSlug)) {
    return true;
  }

  if (
    queue.slug === "documents-review" &&
    stageSlug === "working" &&
    existingStages.some((stage) => stage.slug === "in-review")
  ) {
    return true;
  }

  return false;
}

export async function ensureQueueStages(
  db: QueueStageDb,
  queue: QueueStageSeedInput,
): Promise<QueueStage[]> {
  const existingStages = await db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, queue.id))
    .orderBy(asc(queueStages.order));

  const defaultStages: Array<
    Pick<NewQueueStage, "name" | "slug" | "order" | "category">
  > = createDefaultQueueStageDefinitions(queue);

  if (existingStages.length === 0 && defaultStages.length > 0) {
    return db
      .insert(queueStages)
      .values(
        defaultStages.map((stage) => ({
          queueId: queue.id,
          ...stage,
        })),
      )
      .returning();
  }

  if (existingStages.length === 0) {
    return [];
  }

  const existingSlugs = new Set(
    existingStages.map((stage: QueueStage) => stage.slug),
  );
  const missingStages = defaultStages.filter(
    (
      stage: Pick<NewQueueStage, "name" | "slug" | "order" | "category">,
    ) =>
      !existingSlugs.has(stage.slug) &&
      !hasStageEquivalent(queue, existingStages, stage.slug),
  );

  if (missingStages.length > 0) {
    await db.insert(queueStages).values(
      missingStages.map((stage) => ({
        queueId: queue.id,
        ...stage,
      })),
    );
  }

  return db
    .select()
    .from(queueStages)
    .where(eq(queueStages.queueId, queue.id))
    .orderBy(asc(queueStages.order));
}

export function getStageCategoryFromStatus(
  status: CaseStatusValue,
): StageCategoryValue {
  switch (status) {
    case "new":
      return "new";
    case "working":
    case "pending":
    case "awaiting_client":
      return "in_progress";
    case "qc":
      return "qc";
    case "error":
      return "error";
    case "closed":
      return "closed";
  }
}

export function resolveStageForCase(params: {
  stages: QueueStage[];
  currentStageId: string | null;
  status: CaseStatusValue;
}): QueueStage | null {
  const currentStage = params.currentStageId
    ? params.stages.find((stage) => stage.id === params.currentStageId) ?? null
    : null;

  if (currentStage) {
    return currentStage;
  }

  const stageForStatus = params.stages.find((stage) =>
    stageMatchesStatus(stage, params.status),
  );

  if (stageForStatus) {
    return stageForStatus;
  }

  const inferredCategory = getStageCategoryFromStatus(params.status);
  return (
    params.stages.find((stage) => stage.category === inferredCategory) ??
    params.stages[0] ??
    null
  );
}

export { getStatusForStage };

export function getVisibleStagesForQueue(
  queueSlug: string,
  stages: QueueStage[],
) {
  if (queueSlug !== "documents-review") {
    return stages;
  }

  const allowedStageSlugs = new Set([
    "new",
    "working",
    "awaiting_client",
    "closed",
  ]);

  return stages.filter((stage) => allowedStageSlugs.has(stage.slug));
}
