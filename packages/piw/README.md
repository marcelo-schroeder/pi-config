# piw

`piw` is a user-owned git worktree wrapper for `pi`.

It creates or reuses a named worktree, launches `pi` inside it, injects worktree awareness through a private extension, and cleans up disposable worktrees on exit.

## Layout

Everything related to this feature lives under `packages/piw/`:

- wrapper CLI: `bin/` + `src/`
- private Pi extension: `extensions/worktree-awareness/`
- tests: `test/`

This keeps the repo root clean and avoids making the helper extension look like a general-purpose top-level extension.

## Usage

From the repo root:

```bash
node packages/piw/bin/piw.js
node packages/piw/bin/piw.js feature-auth
node packages/piw/bin/piw.js feature-auth -- --model sonnet:high
```

Or install/link the package locally:

```bash
cd packages/piw
npm link
piw feature-auth
```

## Commands

```bash
piw [name] [options] [-- <pi args...>]
piw list
piw path <name>
piw rm <name>
```

## Naming and storage

Managed worktrees use:

- branch: `piw/<name>`
- path: `<repo-parent>/<repo-name>.worktrees/<name>`

Example for this repo:

```text
/Users/marceloschroeder/myfiles/projects/pi-config
/Users/marceloschroeder/myfiles/projects/pi-config.worktrees/feature-auth
```

So the runtime worktree directories live **outside** the repo root.

## Options

### Run mode

- `--base <branch>`: base branch or revision for new worktrees
- `--keep-clean`: keep a clean worktree after `pi` exits
- `--delete-clean`: delete a clean worktree after `pi` exits
- `--keep-dirty`: keep a dirty worktree after `pi` exits
- `--delete-dirty`: delete a dirty worktree after `pi` exits
- `--yes`: skip confirmations needed by delete flags
- `--pi-bin <path>`: override the `pi` executable, useful for testing
- `--debug`: print extra wrapper diagnostics

### Clean-exit defaults

- auto-generated worktrees created via `piw` are treated as disposable and are deleted on clean exit by default
- explicitly named worktrees such as `piw feature-auth` are kept on clean exit by default
- dirty worktrees still prompt whether to keep or delete unless you override that with flags

## Private extension behavior

`piw` launches `pi` with its private extension:

```text
packages/piw/extensions/worktree-awareness/index.ts
```

That extension:

- reads `PI_WORKTREE_*` environment variables
- injects worktree-aware instructions into the system prompt
- shows a small worktree status in the footer
- registers a read-only `worktree_info` tool

The extension is intentionally kept inside `packages/piw/` because it is an implementation detail of this feature, not a standalone extension for normal sessions.

## Development

Run the package tests:

```bash
cd packages/piw
npm test
```
