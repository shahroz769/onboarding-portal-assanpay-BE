import { Hono } from "hono";

import { AppError } from "../../lib/errors";
import type { AppEnv } from "../../types/auth";
import { parseMerchantFormData } from "./merchants.schemas";
import { createMerchantSubmission } from "./merchants.service";

export const merchantFormRoutes = new Hono<AppEnv>();

merchantFormRoutes.post("/merchant-form", async (c) => {
  const contentType = c.req.header("content-type") ?? "";

  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    throw new AppError(400, "Content-Type must be multipart/form-data.");
  }

  const formData = await c.req.formData().catch(() => {
    throw new AppError(400, "Invalid multipart form payload.");
  });
  const input = parseMerchantFormData(formData);
  const result = await createMerchantSubmission(input);

  return c.json(
    {
      merchant: result.merchant,
      documents: result.documents,
      case: result.case,
    },
    201,
  );
});
