# piw

`piw` is a user-owned git worktree wrapper for `pi`.

It creates or reuses a named worktree, launches `pi` inside it, injects worktree awareness through a private extension, persists small worktree metadata for automation, and cleans up disposable worktrees on exit.

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
node packages/piw/bin/piw.js feature-auth --base develop --target develop
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
- `--target <branch>`: intended integration target on `origin` for new worktrees
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

## Persisted metadata

For each managed worktree, `piw` stores a small JSON metadata file in the worktree's git admin area.

That metadata records:

- worktree identity (`name`, `branch`, `repoRoot`)
- whether the worktree name was explicit or auto-generated
- the creation base (`base.input`, `base.resolvedRef`, `base.commit`)
- the intended integration target on `origin`
- whether the worktree was created from the target commit (`integration.createdFromTarget`)

This metadata is used to make automation safer. For example, a skill can refuse to integrate a worktree when its target metadata is missing, ambiguous, or clearly not based on the intended target branch.

### Target behavior

- If you pass `--target <branch>`, `piw` records that branch as the intended integration target on `origin`.
- If you omit `--target`, `piw` tries to infer a target only when the base is a local branch and `origin/<branch>` exists.
- If no safe target can be derived, the worktree still works normally, but metadata-backed integration workflows should treat it as incomplete.
- Existing older worktrees that predate metadata remain reusable, but they are intentionally treated as metadata-incomplete.

Examples:

```bash
piw feature-auth --base develop --target develop
piw feature-auth --base main --target main
```

Use the target branch that the work is intended to land in.

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

The `worktree_info` tool is the authoritative source for wrapper session metadata. It includes:

- worktree name, branch, path, and repo root
- the original launch directory
- whether persisted metadata is complete
- base and integration metadata when available

The extension is intentionally kept inside `packages/piw/` because it is an implementation detail of this feature, not a standalone extension for normal sessions.

## Integration workflows

Skills that integrate a `piw` worktree should:

- require the `worktree_info` tool
- rely on `worktree_info` instead of filesystem-layout guesses or upstream tracking
- use the real branch from `worktree_info` (for example `piw/feature-auth`)
- rebase against the recorded integration target from `worktree_info.integration`
- refuse integration when `metadataComplete` is false

## Development

Run the package tests:

```bash
cd packages/piw
npm test
```
