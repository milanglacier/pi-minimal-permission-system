export type PermissionState = "allow" | "deny" | "ask";

export type SupportedToolName = "bash" | "read" | "edit" | "write";

export type ToolPermissions = Record<string, PermissionState>;

export type PermissionConfig = Partial<Record<SupportedToolName, ToolPermissions>>;

export type PermissionLayerName = "global" | "project";

export interface PermissionRule {
  toolName: SupportedToolName;
  pattern: string;
  state: PermissionState;
  layer: PermissionLayerName;
}

export interface PermissionCheckResult {
  toolName: SupportedToolName;
  state: PermissionState;
  matchedPattern?: string;
  matchedLayer?: PermissionLayerName;
  command?: string;
  path?: string;
}
