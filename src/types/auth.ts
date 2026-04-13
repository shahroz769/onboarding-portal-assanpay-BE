export const roleTypes = [
  "super_admin",
  "admin",
  "supervisor",
  "employee",
] as const;

export type RoleType = (typeof roleTypes)[number];

export type SessionUser = {
  userId: string;
  email: string;
  roleType: RoleType;
};

export type AppVariables = {
  auth: SessionUser;
};

export type AppEnv = {
  Variables: AppVariables;
};
