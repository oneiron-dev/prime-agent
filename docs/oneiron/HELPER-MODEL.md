# Helper model for spawned agents (Oneiron fork)

An agent can start helper agents with `rlm.spawn` or `rlm.create_session`. When the call names
no model, upstream runs the helper on the parent's model. The fork adds a helper model: a
setting, a per-session override, and a GUI to change both.

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
- A default thinking level is clamped to what the helper's model supports.
- The daemon's `allowedModels` allowlist applies to the helper model like any model.

The same order applies on every path that starts a child agent: the daemon's `rlm.spawn` and
`rlm.create_session` (`crates/pa-daemon/src/rlm_children/host.rs`) and the direct print
host's `rlm.spawn` (`crates/pa-cli/src/print_rlm.rs`; it has no `rlm.create_session`). Factory
states and goal runs spawn through these hosts.

## Settings file

`~/.prime/agent/settings.json` (the Rust side-by-side install reads `~/.prime/agent-rs/`):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `subagentDefaultModel` | string | unset | `provider/model-id` for a spawn that names no model; unset or `parent` keeps the parent's model |
| `subagentDefaultThinking` | `off` ... `max` | unset | thinking level for a spawn that names none; unset keeps the parent's level |

Example: `{"subagentDefaultModel": "cpa-r/deepseek-flash-1017", "subagentDefaultThinking": "max"}`.

A spawn reads the file when it runs, so a change applies to the next spawn of every session.
At startup the CLI checks the model against the catalog (models.json plus the built-in models)
and prints a warning when the catalog does not know it; the TUI shows the same warning as a
row when the session opens.

## Session override

Headless runs (`-p`, `--mode json`, `--autonomous`, `--daemon-hosted`):

```
prime-agent -p --subagent-model cpa-r/deepseek-flash-1017 --subagent-thinking max "..."
PRIME_SUBAGENT_MODEL=cpa-r/deepseek-flash-1017 PRIME_SUBAGENT_THINKING=max prime-agent -p "..."
```

Each flag beats its env var. An invalid `PRIME_SUBAGENT_THINKING` warns and is ignored. In
interactive mode the flags and env vars apply to the session the launch opens.

The override covers the whole agent tree: an RLM child carries its parent's override (create
keys `subagentModel`/`subagentThinking`), so grandchildren resolve the same way. A daemon
session persists the override as a `subagent_model_state` row in its session file, so a resume,
a respawn or an idle wake keeps it. `--daemon-hosted` refuses to run against a daemon that does
not advertise the `subagent_model` capability.

## TUI

- `/subagent-model` shows the helper model and thinking level this session's spawns resolve to,
  with the layer each comes from, and warns when the model is not in the catalog.
- `/subagent-model <provider/model> [<thinking>]` sets the session override. `parent` keeps the
  parent's value; `default` leaves the field to the settings file. `/subagent-model default`
  clears the override.
- `/settings`, Models tab: "Helper model" (a list: `parent` plus the signed-in providers'
  models) and "Helper thinking" (`parent`, `off` ... `max`) write the two settings keys.
  `parent` removes the key.

## Visibility

- The `rlm.spawn` and `rlm.create_session` handles carry `model` and, when the host resolved
  one, `thinking`.
- The agents view lists each child's real model and thinking level (`model:level`).
- `/subagent-model` names the layer each value came from.

## Daemon wire

Fork-only, behind the server capability `subagent_model` (no schema bump):

- `get_subagent_model_status { activeSessionId }` and
  `set_subagent_model { activeSessionId, model?, thinking? }` answer
  `{ model, modelSource, modelKnown, thinking, thinkingSource, session, settings }`; the sources
  are `session`, `settings` or `parent`.
- RLM child creates carry `subagentModel`/`subagentThinking`; the supervisor keeps both in the
  durable create command.
