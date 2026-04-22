import { Resend } from "resend";

import { env } from "../../config/env";

let cachedClient: Resend | null = null;

export function getResendClient(): Resend {
  if (!cachedClient) {
    cachedClient = new Resend(env.RESEND_API_KEY ?? "re_placeholder");
  }
  return cachedClient;
}
