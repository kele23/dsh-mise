# Mise environments

A DeepSeek Harness bundle for projects whose toolchains are managed by [mise](https://mise.jdx.dev). It lets the agent inspect a project's `mise.toml`, install the pinned tools (optionally from `mise.lock`), and run commands and tasks inside that environment instead of relying on globally installed runtimes.

## What it adds

| Tool | Purpose |
|---|---|
| `mise_status` | Read-only report of the applicable config roots and trust state, `mise.lock`, declared tools (installed or missing), and project tasks. |
| `mise_prepare` | Installs project tools and tools required by tasks, then verifies no project tool is missing. Uses `--locked` whenever `mise.lock` exists; `lock: true` creates or refreshes it first, and `trust: true` runs `mise trust` (persisted, can allow project code to run). |
| `mise_run` | Runs a shell command through `mise exec`, or a project task through `mise run`, with the pinned tools and `[env]` applied. |

The bundle also adds a short system-prompt section asking the agent to inspect with `mise_status`, run project commands with `mise_run`, prepare with `mise_prepare`, and keep `mise.lock` committed.

## Reproducible workflow

1. Declare the project tools in `mise.toml` (`[tools]`), plus any `[env]` and `[tasks]`.
2. Run `mise_prepare` with `lock: true` to resolve versions, write `mise.lock`, and install from it with `--locked`. If mise reports the config untrusted, review `mise.toml` and rerun with `trust: true`.
3. Commit `mise.toml` and `mise.lock` together.
4. On another machine or worktree, `mise_prepare` installs the locked versions (and task tools) with `--locked`.
5. Run builds, tests, and scripts with `mise_run`.

`mise_status` flags a missing lockfile, untrusted configs, and tools that are not installed.

## Configuration

Add overrides to the **Mise environments** row in the profile's `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `misePath` | `"mise"` | Executable name or absolute path of the mise CLI. |
| `promptGuidance` | `true` | Whether to add the mise guidance to the system prompt. |
| `grantMiseWritableRoots` | `true` | Under the `workspace-write` sandbox, grant mise's data, cache, config, and state directories for `mise_prepare` and `mise_run` operations, since mise may install tools lazily. |
| `commandTimeoutMs` | `120000` | Default timeout for `mise_run`. |
| `installTimeoutMs` | `900000` | Timeout for `mise lock` and `mise install`. |

## Notes and limitations

- Commands run through the Harness `shell` service, so the session sandbox applies. Under `workspace-write`, mise directories are granted per operation for `mise_prepare` and `mise_run`; with `grantMiseWritableRoots: false`, installs that write outside the workspace are denied.
- `trust: true` persists mise trust: a trusted config may run template settings or env hooks. Review `mise.toml` before trusting a repository.
- mise must be installed and on `PATH` (or set `misePath`).
- `mise_run` does not replace `bash` for general shell work; it is for project commands that need the mise environment. Without a mise config it still applies the global mise environment.
- This plugin creates or refreshes `mise.lock` only when `mise_prepare` is called with `lock: true`.
- Commands are composed for POSIX shells (Linux and macOS). Windows PowerShell quoting is not implemented or verified.
