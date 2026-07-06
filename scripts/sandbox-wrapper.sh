#!/bin/sh
# OpenBoard macOS sandbox wrapper (v1)
#
# Configured as OpenCode's `shell` (see src/server/opencode.ts /
# src/server/sandbox.ts) so every bash-tool call for a dispatched task is
# spawned as `sandbox-wrapper.sh -c "<command>"` instead of a bare
# `/bin/sh -c`. Builds a per-invocation Seatbelt profile from this process's
# own cwd (the session's Location — the task worktree for a worktree-isolated
# task, or the project checkout itself for an in-place task) and execs the
# real command inside it via `sandbox-exec`.
#
# Deliberately has NO fallback path to a bare, unsandboxed `/bin/sh` — if
# sandbox-exec is missing or fails to start, this script fails closed
# (nonzero exit) rather than silently running the command unsandboxed. See
# projects/opencode-board/plans/sandbox-wrapper-plan.md's "fail closed"
# product decision.
#
# macOS (Seatbelt/sandbox-exec) only. Not portable to Linux — a bwrap
# equivalent is a separate, not-yet-built probe.
set -eu

cwd="$(pwd -P)"

tmp_input="${TMPDIR:-/tmp}"
tmp_resolved="$(cd "$tmp_input" && pwd -P)"

# Resolved dynamically rather than hardcoding ~/.npm — npm's cache dir is
# configurable.
npm_cache=""
if command -v npm >/dev/null 2>&1; then
  npm_cache="$(npm config get cache 2>/dev/null || true)"
fi

# Must be resolved *before* entering the sandbox, and must be the whole
# shared base-repo `.git` directory (git-common-dir), not just the
# per-worktree `.git` file's `worktrees/<id>` leaf — objects, refs, and
# config are shared at the base repo's `.git` root, so a commit needs write
# access there, not just the leaf. See opencode-capabilities.md's
# "Sandbox-wrapper probe" section for how this was found.
git_common_dir=""
if command -v git >/dev/null 2>&1; then
  git_common_dir="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
fi

# NOTE: cwd/tmp_resolved/npm_cache/git_common_dir/$HOME are trusted local
# environment values (not attacker-controlled task-prompt content); a path
# containing a literal `"` could in principle break out of a Seatbelt
# `(subpath "...")` string literal. Not handled — same as the reference
# probe design this implements — since it requires an operator's own
# machine to have a quote character in a system path, outside this
# wrapper's threat model (arbitrary bash commands from a dispatched agent).
profile="(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath \"$cwd\"))
(allow file-write* (subpath \"/private/tmp\"))
(allow file-write* (subpath \"$tmp_resolved\"))
(allow file-write* (subpath \"/dev\"))"

if [ -n "${HOME:-}" ]; then
  profile="$profile
(allow file-write* (subpath \"$HOME/.cache\"))"
fi

if [ -n "$npm_cache" ]; then
  profile="$profile
(allow file-write* (subpath \"$npm_cache\"))"
fi

if [ -n "$git_common_dir" ]; then
  profile="$profile
(allow file-write* (subpath \"$git_common_dir\"))"
fi

exec sandbox-exec -p "$profile" /bin/sh "$@"
