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
  /** Complete bash input, as submitted by the tool call. */
  command?: string;
  /** Command within the bash input whose decision determined `state`. */
  decisiveCommand?: string;
  /** Why bash rules were matched against the complete input instead of each command. */
  fallbackReason?: string;
  path?: string;
}
