---
name: create-profile
description: Create, update, or review OpenCode agent profiles for OpenBoard runs. Use when the user asks to create OpenCode/OpenBoard profiles, add named agents, assign models through profiles, repair malformed agent config, prevent profile-config crashes, or turn a board-plan role into files under ~/.config/opencode/agents.
---

# Create Profile

Create OpenCode agent profiles for OpenBoard without letting malformed
Markdown frontmatter take down OpenCode. Profiles are config side effects:
draft them, schema-check them, parse them with OpenCode away from the live
app, install deliberately, and roster-verify before any card uses them.

## Non-Negotiables

- Never write directly to `~/.config/opencode/**` from an orchestrator
  session. Draft first; install only after parse validation succeeds.
- Never ask an OpenCode worker card to edit OpenCode profile/config files —
  profile authoring is orchestrator-side setup, not board-dispatched work.
- Never edit live config in place and rely on app refresh to catch mistakes.
  Stage first, validate first, then install.
- Never overwrite an existing profile without a timestamped backup and an
  explicit reason; stop and ask before overwriting a durable shared profile.
- No cards until the restarted roster proves the profile through
  `GET /api/agents` or MCP `list_agents`.
- No task boundaries in the profile. Task files, acceptance criteria, and
  commands belong in the card; the profile defines behavior.

## Profile Format

OpenCode supports Markdown agent profiles under:

```text
~/.config/opencode/agents/<name>.md
.opencode/agents/<name>.md
```

The filename is the agent id: YAML frontmatter followed by the system prompt.

```md
---
description: "Builds focused implementation changes for <repo>."
mode: primary
model: openai/gpt-5.5
color: info
---

You are an autonomous OpenCode worker for <repo>.
...
```

**Quoting rule (hard requirement):** always double-quote `description`, and
quote any frontmatter value containing a colon, `#`, or leading special
character. An unquoted `description` with a second colon (e.g.
`description: Fix lane (GPT-5.5): implements fixes`) is invalid YAML that
OpenCode does NOT reject — it silently drops the whole frontmatter block, the
agent keeps its filename but loses `model`/`mode`, and the first dispatched
session dies at step 0 with `ProviderModelNotFoundError` on some unrelated
default model. This failure has happened in real runs.

Required frontmatter for OpenBoard profiles:

- `description`: concise role label, always quoted.
- `mode: primary`: required for assignable OpenBoard workers. `subagent`
  serves OpenCode's internal Task tool, not board lanes.
- `model`: authenticated model in `provider/model` form. When a card is
  created with this agent and no explicit override, the live roster's model is
  copied onto `task.model`.

Optional frontmatter:

- `color`: distinct badge color for concurrent runs — a valid hex value like
  `#FF5733` or one of OpenCode's theme colors: `primary`, `secondary`,
  `accent`, `success`, `warning`, `error`, `info`.
- `permission`: only when the role needs stricter limits (e.g. an auditor with
  `edit: deny`). Keep permission edits conservative; malformed permission
  config is part of the crash risk.

Prompt body requirements: state the role in one sentence; list sources to read
before work; mirror the enforced board boundary (`task_diff`, `task_context`,
and `task_compare` for inspection; `complete_task` / `block_task` for the final
report; never run/move/create/integrate); state other hard boundaries (no
commits/pushes; no secret exposure; stay inside the card's file boundary);
state verification
expectations; state the final handoff format (changed files, commands run,
results, residual risks, human-gated decisions). For audit profiles, say
review-only and deny edits in both prompt and permission config.

## Creation Workflow

1. **Derive roles from the approved board plan.** Count distinct behaviors,
   not parallel lanes: one implementation role can run many cards; separate
   profiles only for separate behavior (builder vs auditor). If the plan has
   no Profile Manifest, stop and write one with the user first — do not infer
   lifecycle/model/restart requirements from loose prose.

2. **Draft before any install.** Surface fenced Markdown drafts in chat for
   review, or stage files in a clearly temporary directory — never directly
   under `~/.config/opencode/agents/`. Use one template for same-role lanes so
   prompts do not drift; profiles may differ by filename, color, and model.

3. **Validate frontmatter with a REAL YAML parser** — never a regex or
   string-split check. A first-colon split passes `description: a (b): c`,
   which real YAML rejects; that gap has shipped a broken profile. Use:

   ```sh
   # js-yaml is NOT an OpenBoard dependency — install it into the staging
   # area first; do not expect require() to find it from the repo:
   npm install --prefix "$stage" --no-save js-yaml >/dev/null
   NODE_PATH="$stage/node_modules" \
   node -e 'const y=require("js-yaml"),fs=require("fs");
     const m=fs.readFileSync(process.argv[1],"utf8").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
     if(!m) throw new Error("no single frontmatter block");
     const fm=y.load(m[1]);   // throws on invalid YAML — that is the point
     for (const k of ["description","mode","model"]) if(typeof fm[k]!=="string"||!fm[k]) throw new Error("bad "+k);
     if(!m[2].trim()) throw new Error("empty body");
     console.log("OK", fm.model)' <file>.md
   # Python: python3 -c 'import yaml' must succeed first; if neither parser
   # is available, STOP and install one — do not fall back to hand parsing.
   ```

   Also reject: tabs, duplicate keys, missing closing `---`, unsupported
   `mode`, and any `color` outside the documented set or a valid hex value.
   A missing parser is a blocker, not a license to approximate.

4. **Validate model/provider.** Check `opencode models` /
   `opencode models <provider>` when possible. Multi-segment ids
   (`openrouter/vendor/model`) are valid — the board splits the provider on
   the first slash only. If model auth is uncertain, name a fallback in the
   run plan before cards are created.

5. **Validate OpenCode parsing away from live config.** Copy the current
   OpenCode config into a temporary config home, add the staged profile, then:

   ```sh
   XDG_CONFIG_HOME="$tmp_config" opencode agent list
   ```

   Any parse error, crash, empty custom roster, or missing profile is a
   blocker. **Presence is not proof:** `opencode agent list` shows an agent's
   name even when its frontmatter was silently dropped. The name proves the
   file was seen; the model binding is only proven at step 7. For
   project-local profiles, use a temporary project directory with
   `.opencode/agents/`.

6. **Install atomically.** Create `~/.config/opencode/agents` if missing; back
   up any existing target with a timestamp suffix; move the staged file into
   place only after validation passes.

7. **Restart the selected control surface and prove the live roster.**
   OpenCode config is not hot-reloaded. Restart the exact OpenCode server path
   the selected OpenBoard surface uses — a named instance: `openboard restart
   <name>` (stops, starts, waits for health, flags unsafe RUNNING cards); an
   explicit `OPENCODE_BASE_URL` board: OpenBoard does not own the process, so
   restart the external `opencode serve` or ask the operator. Then prove the
   roster with `openboard agents <name>` (token injected) or MCP
   `list_agents`; for raw curl remember every route except `/api/health`
   needs the board token:

   ```sh
   curl -s "$OPENCODE_BOARD_URL/api/health"
   curl -s -H "Authorization: Bearer $OPENBOARD_API_TOKEN" \
     "$OPENCODE_BOARD_URL/api/agents" | jq -e \
     '.[] | select(.id=="<name>") | select(.mode=="primary" and .model.id=="<model-id>")'
   ```

   The profile is usable only when `/api/agents` lists it with the expected
   `mode` AND `model` from the Profile Manifest. A profile present by name but
   with a null/missing model means OpenCode dropped its frontmatter (most
   often an unquoted colon in `description`) — that is a validation FAILURE,
   not a display quirk; fix the file and restart again. The TUI new-task
   wizard now also blocks submission when the chosen agent has no usable
   roster model — treat that as the same dropped-frontmatter symptom. This roster proof is
   also the task-model proof: OpenBoard copies the roster model onto each
   created task assigned to this agent unless the plan supplies an explicit
   override.

8. **Record the proof against the manifest.** One line per profile: `id`,
   expected lifecycle, expected mode/model, observed mode/model, pass/fail.
   Any absent/wrong-mode/wrong-model profile means this phase is incomplete
   and orchestration must not start.

9. **Record lifecycle.** Confirm every profile is marked `ephemeral` or
   `durable` in the plan. Ephemeral profiles are removed after the run and the
   roster re-verified through the same restart path.

End with a step gate:

```text
STEP COMPLETE: profile creation
VERIFIED: <selected instance/URL restarted; profile manifest roster-proof passed>
NEXT STEP: openboard-orchestrator
Ready to dispatch the planned OpenBoard cards?
```

Do not create cards or dispatch runs from this skill. If validation fails, the
next step is repair, not orchestration.

## Repair Workflow

When a profile config already broke OpenCode/OpenBoard:

1. Stop the server/app refresh loop first.
2. Move the newest edited agent file out of `~/.config/opencode/agents/` or
   `.opencode/agents/`.
3. Run `opencode agent list` from the same cwd that failed — project-local
   `.opencode/agents/` participates in config loading.
4. Still failing? Bisect recently edited agent files one at a time until
   `opencode agent list` starts.
5. Restart OpenBoard/OpenCode (`openboard restart <name>` for a named
   instance) and verify health plus the roster (`openboard agents <name>`).
6. Reintroduce the profile through the staged validation workflow above.

## Failure Modes

- Letting a worker mutate the global OpenCode config it depends on.
- Hand-editing live `~/.config/opencode` and using app refresh as validation.
- Validating frontmatter with a string-split/regex check instead of a real
  YAML parser; leaving `description` unquoted (a parenthetical colon silently
  kills the whole frontmatter block).
- Accepting a roster that lists the profile's NAME while its `model` is
  null/missing — dropped frontmatter, not a cosmetic quirk.
- Unsupported color names (valid: hex, or `primary`, `secondary`, `accent`,
  `success`, `warning`, `error`, `info`).
- `mode: subagent` profiles that OpenBoard then cannot assign.
- Assuming profile prompts extend OpenCode's default prompt — write full role
  behavior into the profile.
- Assuming card prose changes the runtime model; it comes from the roster
  materialized onto `task.model`, or an approved explicit override.
- Restarting or roster-proofing the wrong OpenBoard instance; treating
  `opencode agent list` as sufficient (the selected board's `/api/agents` is
  the dispatch gate).
- Leaving one-off profiles behind after a run.
- Validating profiles, then silently stopping without asking whether to
  dispatch.
