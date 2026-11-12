-- Sign-in attempt counters that a third party cannot use to lock the account
-- holder out. App writer: modules/auth/login-guard.ts.
--
-- One row per key, in fixed one-hour windows:
--   device:<userId>:<deviceId>     a browser the user chose to trust
--   account_ip:<account>:<ip>      an untrusted browser, per account and IP
--   account:<account>              every untrusted browser for the account
-- key_hash is a SHA-256 of the key, never the typed identifier.

CREATE TABLE IF NOT EXISTS "login_attempt_counters" (
  "key_hash" text PRIMARY KEY NOT NULL,
  "attempts" integer NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  CONSTRAINT "login_attempt_counters_attempts_positive" CHECK ("attempts" > 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_attempt_counters_window_idx"
  ON "login_attempt_counters" ("window_started_at");
