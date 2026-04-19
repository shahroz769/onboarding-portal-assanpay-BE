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
  const baseStages: Array<Pick<NewQueueStage, "name" | "slug" | "order" | "category">> = [
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
      name: "Pending",
      slug: "pending",
      order: 3,
      category: "in_progress",
    },
    {
      name: defaultStageNames.qc,
      slug: "qc",
      order: 4,
      category: "qc",
    },
    {
    name: defaultStageNames.error,
    slug: "error",
      order: 5,
    category: "error",
    },
    {
    name: defaultStageNames.closed,
    slug: "closed",
      order: 6,
    category: "closed",
    },
  ];

  return baseStages;
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

  if (existingStages.length > 0) {
    return existingStages;
  }

  return db
    .insert(queueStages)
    .values(
      createDefaultQueueStageDefinitions(queue).map((stage) => ({
        queueId: queue.id,
        ...stage,
      })),
    )
    .returning();
}

export function getStageCategoryFromStatus(
  status: CaseStatusValue,
): StageCategoryValue {
  switch (status) {
    case "new":
      return "new";
    case "working":
    case "pending":
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
