# My New Cmux Tab Extension

Provides `/my-new-cmux-tab` for opening a new cmux terminal tab immediately to the right of the active tab.

## Behavior

- requires Pi to be running inside cmux
- opens a new sibling terminal tab to the right of the active one
- does this as a tab, not as a workspace
- in normal sessions, it does not send any directory-change command
- in `piw` worktree sessions, it opens the new tab and changes it to `PI_WORKTREE_PATH`

## Slash command

- `/my-new-cmux-tab`

The command does not take any arguments.

## Notes

- This is implemented as an extension because it needs direct local cmux side effects.
- The `piw` behavior intentionally uses the worktree root, not a mapped subdirectory.
- If `PI_WORKTREE_SESSION=1` but `PI_WORKTREE_PATH` is missing or invalid, the command fails clearly instead of opening the wrong directory.
