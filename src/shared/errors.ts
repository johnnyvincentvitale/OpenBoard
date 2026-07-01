/** Canonical error codes and the JSON envelope every route returns on failure. */
export const ERROR_CODES = [
  "opencode_unreachable",
  "session_not_found",
  "validation",
  "internal",
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
};
