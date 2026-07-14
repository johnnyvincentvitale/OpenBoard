/** Instance-scoped permission-request timeout exposed by the Settings view. */
export interface PermissionSettings {
  /** Seconds before an unanswered OpenCode or ACP permission ask falls back to policy. */
  timeoutSeconds: number;
}

export interface UpdatePermissionSettingsInput {
  timeoutSeconds: number;
}

export const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;
export const MAX_PERMISSION_TIMEOUT_SECONDS = 24 * 60 * 60;

/** Accept whole milliseconds while presenting the setting to operators in seconds. */
export function permissionTimeoutSecondsToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_PERMISSION_TIMEOUT_SECONDS) {
    return undefined;
  }
  const milliseconds = value * 1000;
  return Number.isInteger(milliseconds) ? milliseconds : undefined;
}

