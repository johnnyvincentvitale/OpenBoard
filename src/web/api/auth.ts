/**
 * Helper for web API clients: reads the board token injected by the server
 * into `window.__BOARD_API_TOKEN__` and returns either an Authorization
 * header or a query-string suffix for SSE/EventSource connections.
 *
 * When the token is missing from the window (e.g. the server hasn't injected
 * it, or we're in a test environment), returns empty so requests degrade
 * gracefully to a 401 rather than silently breaking.
 */

declare global {
  interface Window {
    __BOARD_API_TOKEN__?: string;
  }
}

export function boardAuthHeaders(): Record<string, string> {
  const token = typeof window !== "undefined" ? window.__BOARD_API_TOKEN__ : undefined;
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function boardTokenQueryParam(): string {
  const token = typeof window !== "undefined" ? window.__BOARD_API_TOKEN__ : undefined;
  if (!token) return "";
  return `board_token=${encodeURIComponent(token)}`;
}