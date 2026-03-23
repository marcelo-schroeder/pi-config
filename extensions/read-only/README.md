# Read-Only Extension

Session-scoped read-only mode for Pi.

This extension focuses on a single job: making a session inspect-only until you explicitly switch back.

## Behavior

Supported states:

- `default` — normal Pi behavior
- `read-only` — restricts tools and blocks workspace / git mutation

The current read-only state is persisted in the session, so resuming the session restores the same state.

## Restrictions

When read-only mode is active:

- active tools are restricted to a read-only allowlist
- `bash` is further restricted to an allowlist of safe inspection commands
- workspace edits, dependency changes, environment mutation, and git mutation are blocked
- the agent is instructed to analyze and propose changes rather than make them

Allowed tools include these when available:

- `read`
- `bash`
- `grep`
- `find`
- `ls`
- `questionnaire`
- `worktree_info`
- optional: `web_fetch`

`questionnaire` remains available so the agent can still ask short structured clarification questions while staying safely read-only.

## UI

This extension installs a custom footer and adds an explicit read-only toggle without changing Pi's default editor keybindings:

- footer line 2 shows ` • 🔒 read-only` on the right, after model info
- `Ctrl+Alt+R` toggles read-only mode as a regular Pi shortcut
- `/readonly` toggles read-only mode explicitly

## Notes

- This extension has no hard dependency on `questionnaire`, `git-snapshot`, or `piw`, but it cooperates with them naturally when they are present.
- The footer uses `ctx.ui.setFooter()`, so if another extension also replaces the footer, whichever runs last wins.
- There is no plan persistence or planning workflow in this extension; planning is expected to come from skills / agent workflows instead of a special session mode.
