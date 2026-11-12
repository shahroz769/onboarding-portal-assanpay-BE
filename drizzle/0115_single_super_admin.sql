-- There is exactly one super admin. The app already has no way to create
-- another (the role cannot be assigned or created, and the bootstrap
-- endpoint was removed), so this makes the rule hold for any writer.
-- Fails loudly if more than one exists: pick which account keeps the role
-- before deploying rather than letting a migration demote someone.
CREATE UNIQUE INDEX IF NOT EXISTS "users_single_super_admin"
  ON "users" ("role_type")
  WHERE "role_type" = 'super_admin';
