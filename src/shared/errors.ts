/** Canonical error codes and the JSON envelope every route returns on failure. */
export const ERROR_CODES = [
  "opencode_unreachable",
  "session_not_found",
  "validation",
  "internal",
  "unauthorized",
  "permission_ask_not_found",
  "permission_ask_stale",
  "permission_already_claimed",
  "permission_action_unsupported",
  "permission_reply_failed",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** Maps each error code to its HTTP status. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  opencode_unreachable: 503,
  session_not_found: 404,
  validation: 400,
  internal: 500,
  unauthorized: 401,
  permission_ask_not_found: 404,
  permission_ask_stale: 409,
  permission_already_claimed: 409,
  permission_action_unsupported: 422,
  permission_reply_failed: 502,
};

/** Typed adapter error carrying a canonical code -> HTTP status + JSON envelope. */
export class AdapterError extends Error {
  readonly code: ErrorCode;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "AdapterError";
    this.code = code;
    this.cause = cause;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, message: this.message } };
  }

  static unreachable(message = "OpenCode server is unreachable", cause?: unknown): AdapterError {
    return new AdapterError("opencode_unreachable", message, cause);
  }
  static notFound(message = "Session not found"): AdapterError {
    return new AdapterError("session_not_found", message);
  }
  static validation(message: string): AdapterError {
    return new AdapterError("validation", message);
  }
  static internal(message = "Internal error", cause?: unknown): AdapterError {
    return new AdapterError("internal", message, cause);
  }
  static unauthorized(message = "Invalid or missing API token"): AdapterError {
    return new AdapterError("unauthorized", message);
  }
}
