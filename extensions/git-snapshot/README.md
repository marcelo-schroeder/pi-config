# Git Snapshot Extension

Provides `/snapshot` commands plus a guarded `git_snapshot_create` LLM tool for stash-style workspace safety snapshots.

## Public Surface

### Slash commands

- `/snapshot create [--message "..."] [--tracked-only]`
- `/snapshot list [--limit N]`
- `/snapshot restore [<snapshot>] [--no-index] [--yes]`

### LLM tool

- `git_snapshot_create`
  - `repoPath?`
  - `message?`
  - `trackedOnly?`

The tool defaults to the current session repository when `repoPath` is omitted.

The LLM tool is reserved for explicit `/skill:my-commit-changes` runs. For direct/manual snapshot requests, use `/snapshot create` instead.

## Frozen Behavior

### create

- Creates a stash-style snapshot of the current workspace.
- Includes untracked files by default.
- `--tracked-only` / `trackedOnly: true` excludes untracked files.
- Must preserve the current worktree and index state.
- Requires an existing `HEAD` commit for v1.
- Does not include ignored files in v1.
- Uses an internal TypeScript implementation shared by `/snapshot create` and `git_snapshot_create`.

### list

- Lists only snapshots created by this extension.
- Does not show unrelated user stash entries.
- Will filter by the message prefix `pi snapshot:`.
- Supports `--limit N` for truncation.

### restore

- Restores a previously created snapshot.
- Uses `git stash apply --index` by default.
- `--no-index` restores without index state.
- If the target workspace is dirty, confirmation is required unless `--yes` is passed.
- Does not drop the stash entry after restore.

## UX Rules

- `/snapshot` with no arguments shows help.
- `/snapshot help` shows help.
- Invalid subcommands or malformed arguments show help plus an error message.
- Interactive mode should prefer pickers and confirmations.
- Non-interactive mode should fail conservatively for restore operations.
- v1 intentionally does not persist snapshot metadata into pi session entries (`appendEntry` is not used).

## Notes

- Direct invocation of old private helper scripts is not a supported interface.
- Skills in this repo should use the `git_snapshot_create` tool instead of shelling out to snapshot internals.
- General agent turns are blocked from using `git_snapshot_create`; the extension only allows it for explicit `/skill:my-commit-changes` runs.
