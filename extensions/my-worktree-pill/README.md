# My Worktree Pill Extension

Provides `/my-worktree-pill` for manually updating a cmux sidebar status pill in the current workspace.

## Behavior

- if Pi is not running inside cmux, the command is a no-op
- if the `cmux` CLI is unavailable, the command is a no-op
- with no arguments:
  - in a `piw` worktree session, it sets the pill to `PI_WORKTREE_NAME`
  - in a normal Pi session, it clears the pill
- `set [text]` sets the pill explicitly
- `clear` clears the pill
- the command uses the sidebar status key `piw_worktree`

## Slash command

- `/my-worktree-pill`
- `/my-worktree-pill set`
- `/my-worktree-pill set <text>`
- `/my-worktree-pill clear`

## Notes

- `/my-worktree-pill set` without explicit text requires an active `piw` worktree session so it can use `PI_WORKTREE_NAME`
- the pill is workspace-scoped because cmux status entries are workspace metadata
- this extension intentionally does not try to auto-track terminal focus
