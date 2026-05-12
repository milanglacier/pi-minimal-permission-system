export type PermissionState = "allow" | "deny" | "ask";

export type ToolPermissions = Record<string, PermissionState>;

export interface PermissionConfig {
  bash?: ToolPermissions;
  read?: ToolPermissions;
  write?: ToolPermissions;
  edit?: ToolPermissions;
}

export interface PermissionCheckResult {
  toolName: string;
  state: PermissionState;
  matchedPattern?: string;
  command?: string;
  path?: string;
}
