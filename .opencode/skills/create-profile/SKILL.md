---
name: create-profile
description: Create, update, or review OpenCode agent profiles for OpenBoard runs. Use when the user asks to create OpenCode/OpenBoard profiles, add named agents, assign models through profiles, repair malformed agent config, prevent profile-config crashes, or turn a board-plan role into files under ~/.config/opencode/agents.
---

# Create Profile

Create OpenCode agent profiles for OpenBoard without letting malformed Markdown
frontmatter take down OpenCode. Profiles are config side effects, so they must
be drafted, schema-checked, parsed by OpenCode away from the live app, installed
deliberately, and roster-verified before any OpenBoard card uses them.

## Non-Negotiables

- If this skill is running inside an OpenCode/OpenBoard orchestrator profile,
  do not write directly to `~/.config/opencode/**`. Output profile drafts first,
  then install only after a separate parse-validation step succeeds.
- Do not ask an OpenCode worker card to edit OpenCode profile/config files.
  Profile authoring is orchestrator-side setup, not board-dispatched work.
- Do not edit live config in place while relying on `opencode` or OpenBoard
  refresh to catch mistakes. Stage first, validate first, then install.
- Do not overwrite an existing profile without a timestamped backup and an
  explicit reason. Stop and ask before overwriting a durable shared profile.
- Do not create cards until the restarted OpenCode roster proves the profile is
  visible through `GET /api/agents` or MCP `list_agents`.
- Do not put task boundaries in the profile. Put task-specific files,
  acceptance criteria, and commands in the card. The profile defines behavior.

## Profile Format

OpenCode supports Markdown agent profiles under:

```text
~/.config/opencode/agents/<name>.md
.opencode/agents/<name>.md
```

The filename is the agent id. Use Markdown with YAML frontmatter followed by a
system prompt. When asked to "add system prompts for each profile," this is the
format being edited:

```md
---
description: Builds focused implementation changes for <repo>.
mode: primary
model: openai/gpt-5.5
color: info
---

You are an autonomous OpenCode worker for <repo>.
...
```

**Quoting rule (hard requirement):** always double-quote the `description`
value, and quote any frontmatter value containing a colon, `#`, or leading
special character. An unquoted `description` with a second colon (e.g.
`description: Fix lane (GPT-5.5): implements fixes`) is invalid YAML that
OpenCode does NOT reject — it silently drops the frontmatter, the agent keeps
its filename but loses `model`/`mode`, and the first dispatched session dies at
step 0 with `ProviderModelNotFoundError` on some unrelated default model. This
exact failure happened live on 2026-07-03.

Required/expected frontmatter for OpenBoard profiles:

- `description`: concise role label shown in rosters. Always quoted.
- `mode: primary`: required for assignable OpenBoard workers. Use `subagent`
  only for OpenCode internal Task-tool workers, not board lanes.
- `model`: authenticated model in `provider/model` form. OpenBoard uses the
  live roster's concrete model for task creation: when a card is created with
  this agent and no explicit override, the roster model is copied onto
  `task.model`.

Optional frontmatter:

- `color`: distinct visual badge color for concurrent runs. If present, use
  only a valid hex color like `#FF5733` or one of OpenCode's theme colors:
  `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`.
- `permission`: only when the role needs stricter limits, such as an auditor
  with `edit: deny`. Keep permission edits conservative; malformed permission
  config is part of the crash risk.

Prompt body requirements:

- State the role in one sentence.
- List source files/docs to read before work.
- State hard boundaries: no board operations, no commits/pushes, no secret
  exposure, stay inside the card's file boundary.
- State verification expectations.
- State final handoff format: changed files, commands run, results, residual
  risks, and human-gated decisions.
- For audit profiles, say review only and deny edits in both prompt and
  permission config.

## Creation Workflow

1. Derive roles from the approved board plan.
   Count distinct behaviors, not parallel lanes. One implementation role can
   run many cards; create separate profiles only for separate behavior such as
   builder vs auditor. If the plan has no Profile Manifest, stop and write one
   with the user before installing files; do not infer lifecycle/model/restart
   requirements from loose prose.

2. Draft the profile content before any install.
   Prefer surfacing fenced Markdown drafts in chat for user review. If files are
   needed, write them under a clearly temporary staging directory, not directly
   under `~/.config/opencode/agents/`. Use one template for same-role lanes so
   prompts do not drift. Profiles may differ by filename, color, and model.

3. Validate frontmatter with a REAL YAML parser — never a regex or
   string-split check.
   A first-colon split will pass `description: a (b): c`, which real YAML
   rejects; that gap shipped a broken profile on 2026-07-03. Use one of:

   ```sh
   # Node (js-yaml is in the OpenBoard repo's dependency tree):
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

   Then also reject: tabs, duplicate keys, missing closing `---`, unsupported
   `mode`, and any `color` outside the documented set or a valid hex color.
   A parser that cannot be found is a blocker, not a license to approximate.

4. Validate model/provider before install.
   Check the current OpenCode model list when possible:

   ```sh
   opencode models
   opencode models <provider>
   ```

   If model auth is uncertain, name a fallback in the run plan before cards are
   created.

5. Validate OpenCode parsing away from live config.
   Copy the current OpenCode config into a temporary config home, add the staged
   Markdown profile there, then run:

   ```sh
   XDG_CONFIG_HOME="$tmp_config" opencode agent list
   ```

   Treat any parse error, crash, empty custom roster, or missing profile as a
   blocker. Do not refresh OpenBoard against an unvalidated profile.

   **Presence is not proof.** `opencode agent list` shows an agent's name even
   when its frontmatter was silently dropped, and can still report a plausible
   mode. The name proves the file was seen, nothing more; the model binding is
   only proven at step 7.

   If validating project-local profiles, use a temporary project directory with
   `.opencode/agents/`. `OPENCODE_CONFIG_DIR` can add another config directory,
   but it is not a substitute for proving the exact final load path.

6. Install atomically.
   Create `~/.config/opencode/agents` if missing. If the target profile exists,
   back it up next to the original with a timestamp suffix before replacing it.
   Move the staged file into place only after validation passes.

7. Restart the selected control surface and prove the live roster.
   OpenCode config is not hot-reloaded. Restart the exact OpenCode server path
   that the selected OpenBoard surface is using:

   - Named OpenBoard instance: stop/start that selected instance (or use a
     product `restart` command when one exists), then keep using its resolved
     `OPENCODE_BOARD_URL`.
   - Explicit `OPENCODE_BASE_URL` / connect mode: OpenBoard does not own the
     OpenCode process; restart the external `opencode serve` process or ask
     the operator to do it before roster proof.

   Then prove:

   ```sh
   curl -s "$OPENCODE_BOARD_URL/api/health"
   curl -s "$OPENCODE_BOARD_URL/api/agents"
   ```

   The profile is not usable until `/api/agents` lists it with the expected
   `mode` AND `model` from the Profile Manifest. Assert per profile,
   mechanically — e.g.:

   ```sh
   curl -s "$OPENCODE_BOARD_URL/api/agents" | jq -e \
     '.[] | select(.id=="<name>") | select(.mode=="primary" and .model.id=="<model-id>")'
   ```

   A profile that appears by name but with a null/missing model means OpenCode
   dropped its frontmatter (most often an unquoted colon in `description`).
   That is a validation FAILURE even though the name is on the roster — fix the
   file and restart again; do not explain the missing model away as a display
   or filtering quirk.

   This roster proof is also the task-model proof: OpenBoard copies the
   roster's concrete model onto each created task assigned to this agent unless
   the run plan deliberately supplies an explicit model override.

8. Record the roster proof against the manifest.
   Report one line per profile: `id`, expected lifecycle, expected mode/model,
   observed mode/model, and pass/fail. If any profile is absent, has the wrong
   mode, or has a null/missing/wrong model, this phase is not complete and
   orchestration must not start.

9. Record lifecycle.
   Confirm every profile is marked `ephemeral` or `durable` in the run plan.
   Ephemeral profiles are removed after the run and the roster is verified
   again through the same selected-instance restart path.

End with a step gate:

```text
STEP COMPLETE: profile creation
VERIFIED: <selected instance/URL restarted; profile manifest roster-proof passed>
NEXT STEP: openboard-orchestrator
Ready to dispatch the planned OpenBoard cards?
```

Do not create cards or dispatch runs from this skill. If profile validation
fails, the next step is repair or revised drafts, not orchestration.

## Repair Workflow

When a profile config already broke OpenCode/OpenBoard:

1. Do not keep refreshing the app. Stop the server/app loop first.
2. Move the newest edited Markdown agent file out of `~/.config/opencode/agents/`
   or `.opencode/agents/`.
3. Run `opencode agent list` from the same terminal cwd that failed. The cwd
   matters because project-local `.opencode/agents/` can participate in config
   loading.
4. If it still fails, bisect recently edited agent files by moving them out one
   at a time until `opencode agent list` starts.
5. Restart OpenBoard/OpenCode and verify `/api/health` and `/api/agents`.
6. Reintroduce the profile through the staged validation workflow above.

## Failure Modes

- Letting a worker mutate the global OpenCode config it depends on.
- Hand-editing live `~/.config/opencode` and using app refresh as validation.
- Asking the OpenCode orchestrator to "add system prompts" and letting it write
  Markdown agent frontmatter straight into the live config without parse proof.
- Using unsupported color names. OpenCode accepts valid hex values or
  `primary`, `secondary`, `accent`, `success`, `warning`, `error`, `info`.
- Creating profiles with `mode: subagent`, then wondering why OpenBoard cannot
  assign them.
- Assuming profile prompts extend OpenCode's default prompt. Write full role
  behavior into the profile.
- Assuming card prose changes the runtime model. Task runtime model comes from
  the agent roster materialized onto `task.model`, or from an explicit model
  field when the approved plan calls for an override.
- Leaving one-off profiles behind after a run.
- Restarting or roster-proofing the wrong OpenBoard instance after installing
  profiles.
- Treating `opencode agent list` as enough after install; the selected
  OpenBoard `/api/agents` roster is the dispatch gate.
- Validating profiles, then silently stopping without asking whether to dispatch.
- Validating frontmatter with a string-split/regex check instead of a real YAML
  parser — it passes unquoted-colon descriptions that real YAML rejects.
- Accepting a roster that lists the profile's NAME while its `model` is
  null/missing — that is dropped frontmatter, not a cosmetic quirk.
- Leaving `description` unquoted. Colons in parenthetical model names
  (`(GPT-5.5):`) silently kill the whole frontmatter block.
