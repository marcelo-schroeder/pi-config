# Read-Only Mode Extension

Default safe mode for pi sessions.

## Features

- **Default on for new sessions**: fresh sessions start in read-only mode automatically
- **Session persistence**: resumed sessions restore the last saved read-only state
- **Strict tool allowlist**: restricts available tools to read-only ones such as `read`, `grep`, `find`, `ls`, `worktree_info`, `questionnaire`, and optionally `bash`/`web_fetch`
- **Bash allowlist**: only explicitly read-only bash commands are allowed
- **Defense in depth**: both active tools and `tool_call` interception enforce the restriction
- **Footer indicator**: shows `🔒 read-only` while active
- **Mode coexistence**: cooperates with other mode-style extensions via the event bus without requiring them

## Commands

- `/readonly` - Toggle read-only mode
- `Ctrl+Alt+R` - Toggle read-only mode (shortcut)

## Behavior

When read-only mode is active, the agent can inspect and analyze, but it cannot:

- edit or write files
- change git state
- install or remove dependencies
- run destructive shell commands
- modify the environment

If the agent needs to make changes, it should explain what it would do instead of trying to do it.

## Interoperability

This extension has **no hard dependency** on any other extension.

It publishes its mode state on the extension event bus so other extensions can cooperate with it if they want to. If those extensions are absent, read-only mode still works normally.
