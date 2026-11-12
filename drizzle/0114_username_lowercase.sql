-- Login lowercases the identifier, so a username saved with capitals could
-- never be used to sign in. Usernames are now stored lowercase and unique
-- regardless of case. A row whose lowercase form is already taken is left
-- as is, and the unique index below then fails loudly instead of merging
-- two accounts.
UPDATE "users" AS target
  SET "username" = lower(target."username"), "updated_at" = now()
  WHERE target."username" <> lower(target."username")
    AND NOT EXISTS (
      SELECT 1 FROM "users" other
      WHERE other."id" <> target."id"
        AND lower(other."username") = lower(target."username")
    );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_lower_unique"
  ON "users" (lower("username"));
