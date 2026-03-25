# My Open Local Apps Extension

Provides slash commands for opening local macOS apps at the most relevant project directory for the current Pi session.

## Behavior

- in normal sessions, both commands use the current Pi session directory
- in `piw` worktree sessions, both commands use `PI_WORKTREE_PATH`
- if `PI_WORKTREE_SESSION=1` but `PI_WORKTREE_PATH` is missing or invalid, the command fails clearly instead of opening the wrong directory
- the commands do not accept arguments

## Slash commands

- `/my-open-zed`
- `/my-open-fork`

## Notes

- `/my-open-zed` launches `Zed` via `/usr/bin/open -a Zed <path>`
- `/my-open-fork` prefers Fork's CLI helper (`fork -C <path> open`) when installed, then falls back to `/usr/bin/open -a Fork <path>`
- the `piw` behavior intentionally uses the worktree root, not a mapped subdirectory
