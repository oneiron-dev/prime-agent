# Helper model for spawned agents (Oneiron fork)

An agent can start helper agents with `rlm.spawn` or `rlm.create_session`. When the call names
no model, upstream runs the helper on the parent's model. The fork adds a helper model: a
setting, a per-session override, and a GUI to change both. It also adds a helper model list:
the models spawned agents may run on, kept apart from the full model catalog.

## Resolution order

Each field (model, thinking level) resolves on its own. The first layer that names a value wins:

1. the spawn call: `rlm.spawn(..., model=..., thinking=...)`;
2. the session override: `--subagent-model`/`--subagent-thinking`, the env vars
   `PRIME_SUBAGENT_MODEL`/`PRIME_SUBAGENT_THINKING`, or `/subagent-model` in the TUI;
3. the settings file: `subagentDefaultModel`/`subagentDefaultThinking`;
4. the parent's own model and thinking level (upstream behavior).

The value `parent` at layer 2 or 3 stops the walk and keeps the parent's value.

- The spawn call's own values keep their strict checks: an unknown model or an unsupported
  thinking level fails the spawn.
- A default model (layer 2 or 3) that the model catalog does not know never fails a spawn. The
  process warns once and the helper runs on the parent's model.
- A default thinking level, and the parent's own, is clamped to what the helper's model supports.
- The helper model list (below) then applies to the model.
- The daemon's `allowedModels` allowlist applies to the helper model like any model.

The same order applies on every path that starts a child agent: the daemon's `rlm.spawn` and
`rlm.create_session` (`crates/pa-daemon/src/rlm_children/host.rs`) and the direct print
host's `rlm.spawn` (`crates/pa-cli/src/print_rlm.rs`; it has no `rlm.create_session`). Factory
states and goal runs spawn through these hosts.

## Helper model list

`subagentModels` is an ordered list of `provider/model-id` references. When it is set, spawned
agents may run only on these models. Every model stays in the catalog, so a person can still
pick any of them with `--model` or `/model`. Absent or empty: no limit (upstream behavior).

- A spawn call that names a model off the list is refused. The error names the allowed models,
  so the agent retries with one:
  `Requested subagent model "cpa-a/claude-opus-5" is not on the helper model list; use one of:
  cpa-r/deepseek-flash-1017, cpa-r/kimi-k3.1 (or omit model= for the default)`.
- A settings default (`subagentDefaultModel`) or a parent model off the list falls to the
  list's first entry. The process warns once on stderr; the status reports it.
- A person's choice is always allowed: the session override (`--subagent-model`,
  `PRIME_SUBAGENT_MODEL`, `/subagent-model`) may name a model off the list, and an agent may
  then name that model too.
- A person can widen the list for one session: `--subagent-models a,b`, the env var
  `PRIME_SUBAGENT_MODELS=a,b`, or `/subagent-models a,b` in the TUI. The session's entries
  follow the settings file's, so the first entry stays the settings file's first. With no
  settings list there is no limit to widen.
- `rlm.find_models` lists only the models on the list.
- Entries match the resolved selector exactly (case-insensitive). Write the full
  `provider/model-id`: a short form is not an entry.
- `subagentModels` is read from the global settings file only, like `allowedModels`. A project
  file, which an agent can write, cannot widen it.
- The list's first entry must be in the catalog: a fallback to an unknown first entry fails the
  spawn.

The list covers the whole agent tree: an RLM child carries its parent's session additions
(create key `subagentModels`), and the daemon persists them in the `subagent_model_state` row.

## Settings file

`~/.prime/agent/settings.json` (the Rust side-by-side install reads `~/.prime/agent-rs/`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `subagentDefaultModel` | string | unset | `provider/model-id` for a spawn that names no model; unset or `parent` keeps the parent's model |
| `subagentDefaultThinking` | `off` ... `max`, or `parent` | unset | thinking level for a spawn that names none; unset or `parent` keeps the parent's level (a project file's `parent` overrides a global level) |
| `subagentModels` | array of strings | unset | the helper model list: the models spawned agents may run on, first entry the fallback; global file only; unset or empty is no limit (one comma-separated string also works) |

Example:

```json
{
  "subagentDefaultModel": "cpa-r/deepseek-flash-1017",
  "subagentDefaultThinking": "max",
  "subagentModels": ["cpa-r/deepseek-flash-1017", "cpa-r/kimi-k3.1"]
}
```

A spawn reads the file when it runs, so a change applies to the next spawn of every session.
At startup the CLI checks the model against the catalog (models.json plus the built-in models)
and prints a warning when the catalog does not know it; the TUI shows the same warning as a
row when the session opens, and a warning when the default is off the helper model list.

## Session override

Headless runs (`-p`, `--mode json`, `--autonomous`, `--daemon-hosted`):

```
prime-agent -p --subagent-model cpa-r/deepseek-flash-1017 --subagent-thinking max "..."
PRIME_SUBAGENT_MODEL=cpa-r/deepseek-flash-1017 PRIME_SUBAGENT_THINKING=max prime-agent -p "..."
prime-agent -p --subagent-models cpa-a/claude-opus-5 "..."
PRIME_SUBAGENT_MODELS=cpa-a/claude-opus-5 prime-agent -p "..."
```

Each flag beats its env var. An invalid `PRIME_SUBAGENT_THINKING` warns and is ignored. In
interactive mode the flags and env vars apply to the session the launch opens.

The override covers the whole agent tree: an RLM child carries its parent's override (create
keys `subagentModel`/`subagentThinking`/`subagentModels`), so grandchildren resolve the same
way. The daemon worker persists the override as a `subagent_model_state` row in the session
file it owns (every `set_subagent_model` and `set_subagent_models`, a clear included, and an RLM
child's inherited override once, at birth), so a resume, a respawn or an idle wake keeps it; the
latest row wins over the create keys. `--daemon-hosted` refuses to run against a daemon that
does not advertise the `subagent_model` capability (or `subagent_models`, for
`--subagent-models`).

## TUI

- `/subagent-model` shows the helper model and thinking level this session's spawns resolve to,
  with the layer each comes from, and the helper model list with its source. It warns when the
  model is not in the catalog or not on the list.
- `/subagent-model <provider/model> [<thinking>]` sets the session override. `parent` keeps the
  parent's value; `default` leaves the field to the settings file. `/subagent-model default`
  clears the override. The session's list additions stay.
- `/subagent-models` shows the same status. `/subagent-models a,b` replaces the session's
  additions to the helper model list; `/subagent-models default` clears them. The override's
  model and thinking level stay.
- `/settings`, Models tab: "Helper model" (a list: `parent` plus the signed-in providers'
  models) and "Helper thinking" (`parent`, `off` ... `max`) write the two settings keys.
  `parent` removes the key. Edit `subagentModels` in the settings file.

## Visibility

- The `rlm.spawn` and `rlm.create_session` handles carry `model` and `thinking`: the level the
  child runs at, clamped to its model (absent only when neither a default nor the parent names
  a level).
- The agents view lists each child's real model and thinking level (`model:level`).
- `/subagent-model` and `/subagent-models` name the layer each value came from and the list's
  source.

## Daemon wire

Fork-only, no schema bump:

- Capability `subagent_model`: `get_subagent_model_status { activeSessionId }` and
  `set_subagent_model { activeSessionId, model?, thinking? }`.
- Capability `subagent_models`: `set_subagent_models { activeSessionId, models? }` (an empty or
  absent list clears the session's additions), and the daemon enforces the helper model list.
- Each command answers `{ model, modelSource, modelKnown, modelAllowed, thinking,
  thinkingSource, models, modelsSource, session, settings }`. The model and thinking sources are
  `session`, `settings` or `parent`. `models` is the active list (`null`: no limit) and
  `modelsSource` is `settings`, or `settings+session` when the session added entries.
  `modelAllowed` is `false` when the model the spawns default to is off the list (they run on
  its first entry), `null` without a list.
- RLM child creates carry `subagentModel`/`subagentThinking`/`subagentModels`; the supervisor
  keeps all three in the durable create command.
