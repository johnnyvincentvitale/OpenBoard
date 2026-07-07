/**
 * A narrow, board-owned view of an OpenCode AI provider and its models —
 * not a re-export of the vendored SDK's `Provider`/`Model` types, which
 * carry far more (auth env vars, config options, per-model capabilities)
 * than the TUI's new-task wizard needs.
 */
export interface RosterModel {
  id: string;
  name: string;
}

/** A currently-connected AI provider, from GET /api/providers. */
export interface RosterProvider {
  id: string;
  name: string;
  defaultModelId?: string;
  models: RosterModel[];
}
