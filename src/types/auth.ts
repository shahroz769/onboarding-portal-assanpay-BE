export const roleTypes = [
  "admin",
  "supervisor",
  "employee",
] as const;

export type RoleType = (typeof roleTypes)[number];

export type SessionUser = {
  userId: string;
  email: string;
  roleType: RoleType;
  sessionVersion: number;
};

export type AppVariables = {
  auth: SessionUser;
};

export type AppEnv = {
  Variables: AppVariables;
};
