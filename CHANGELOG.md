# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-07-07

Initial release.

### Added

- **`AskCodex` tool** — delegates a self-contained sub-task to OpenAI's
  [Codex CLI](https://github.com/openai/codex) via `codex exec --json`,
  streams structured progress events (command runs, file changes, reasoning)
  as partial output, and returns the final agent message. The tool answers
  to the names the CLI is known by — **codex**, **openai**, and **gpt** —
  surfaced in its description so the model maps any of them to this single
  tool.
- **Multi-turn conversations with Codex** — optional `sessionId` param.
  Omit for a one-shot (Codex starts fresh); pass the id returned in a prior
  call's result (`details.sessionId`, also shown in the result footer) to
  resume that session with full context. The agent decides per call which
  mode to use. Codex's JSON stream emits the session id directly in the
  `thread.started` event (no snapshot/diff hack), and `codex exec resume
  <id>` continues it natively. Codex holds all session state on disk; the
  extension is otherwise stateless.
- **Structured progress** — unlike plain stdout capture, the extension parses
  the `codex exec --json` JSONL stream and renders human-readable status:
  `running command: …`, `edited: path/to/file`, `searching: …`, reasoning
  breadcrumbs. Non-fatal transient `error` events (stream reconnects) are
  treated as progress, not failure.
- **Friendly model aliases** — `default` (omit the flag entirely), `mini`
  (gpt-5.4-mini), `full` (gpt-5.5), plus exact passthrough (e.g. `gpt-5.5`,
  `gpt-5.4-mini`). ChatGPT-account auth restricts available models, so the
  alias set is intentionally small and points only at known-good names.
- **Reasoning effort config** — `minimal`/`low`/`medium`/`high` passed to
  Codex via `-c model_reasoning_effort=…`. Defaults to `medium`. Lowering
  this is the primary lever for speed and token cost.
- **`/codex` slash command** — interactive picker (`SettingsList`) for the
  default model, default reasoning effort, and default sandbox mode. If the
  project config shadows the global, the change is written there so it
  actually takes effect; otherwise it writes to global. Outside TUI
  (RPC/headless), prints a read-only status snapshot.
- **Config file** — `~/.pi/agent/ask-codex.json` (global) merged over
  `.pi/ask-codex.json` (project). Atomic writes (temp + rename).
- **Defaults** — model `default` (Codex's own default), reasoning `medium`,
  sandbox `workspace-write` (Codex needs write access to be useful; pass
  `read-only` per-call to inspect without mutating).
- **Circular-delegation guard** — refuses to spawn Codex when the active Pi
  provider is already `codex`/`openai`.
- **Process lifecycle** — spawned `codex` runs in a detached process group so
  its own exec subprocesses are killed on abort/timeout (not orphaned); a
  watchdog enforces the timeout cap directly; stdout/stderr decoded at the
  stream level for UTF-8 safety across pipe chunks; stdin is closed so Codex
  never blocks waiting for terminal input; throttled status updates avoid
  O(n²) re-renders.
- **Environment support** — `CODEX_BIN`, `CODEX_EXTRA_ARGS`.

### Security

- **Session-id validation** — the `sessionId` param is anchored to UUID
  shape (`/^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$/`). This is stricter than a
  generic alphanumeric class: it makes a leading-dash value (e.g.
  `--dangerously-bypass-approvals-and-sandbox`, all letters and hyphens)
  impossible to pass, preventing argument injection that would silently
  disable codex's sandbox when threaded after the resume session-id
  positional. Non-matching values fall through to a fresh run.
- **Prompt end-of-options guard** — a literal `--` is inserted before the
  prompt positional, so a task beginning with a dash (e.g. `--help`, `-v`)
  is treated as the prompt, not a codex flag. Verified accepted by codex in
  both fresh and resume modes.
- **Timeout clamping** — `timeoutMinutes` is bounded to `[1, 1440]` minutes.
  Unclamped, a value of `0`, negative, `NaN`, or above ~35791m would overflow
  `setTimeout`'s 32-bit ceiling and fire the watchdog immediately, killing
  codex before it starts.
- **Argument injection surface minimized** — model, reasoning effort, and
  sandbox are enum/string-constrained before reaching the argv; `shell:false`
  throughout; `CODEX_EXTRA_ARGS` is parsed with a shell-like splitter (no
  backslash unescaping, documented).
