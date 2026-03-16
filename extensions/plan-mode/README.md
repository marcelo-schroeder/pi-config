# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to `read`, `bash`, `grep`, `find`, `ls`, `questionnaire`, `worktree_info`, and optionally `web_fetch`
- **Bash allowlist**: Only read-only bash commands are allowed
- **Optional task tracking**: Numbered `Plan:` steps can be tracked, but tracking is off by default and only turns on when you explicitly ask for it
- **Structured step completion**: Tracked execution uses the `plan_step_done` tool so progress does not depend only on exact prose markers
- **Legacy `[DONE:n]` fallback**: Older or prose-based completions are still recognized with tolerant parsing for compatibility
- **Progress tracking widget**: Shows completion status only during tracked execution
- **Transcript progress updates**: Tracked execution emits visible progress updates in the session transcript as steps are completed
- **Session persistence**: State survives session resume, switch, and fork
- **Tool restoration**: Restores the previously active non-mode tool set after leaving plan mode
- **Mode coexistence**: Cooperates with other mode-style extensions via the event bus without requiring them
- **Mode indicator**: shows `⏸ plan` while planning and `📋 n/m` only during tracked execution; with `mode-footer` loaded it is rendered on footer line 2 next to the model info instead of Pi's default status line

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show task-tracking status for the current plan
- `/todos on` - Enable task tracking for the current plan
- `/todos off` - Disable task tracking and clear tracked items
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Usage

1. Enable plan mode with `/plan` or `--plan`
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```text
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. If you want tracked tasks for that plan, explicitly enable them with `/todos on`
5. Choose **Execute the plan** when prompted
6. Only when task tracking is enabled:
   - the plan steps are captured into a tracked todo list
   - execution uses the `plan_step_done` tool to mark tracked steps complete
   - progress appears in the widget/footer and in transcript updates as tracked steps complete
   - legacy `[DONE:n]` markers are still accepted as fallback
7. If you do not enable task tracking, plan mode still works normally without todo/task UI

## Interoperability

This extension has **no hard dependency** on any other extension.

It publishes its mode state on the extension event bus so other extensions can cooperate with it if they want to. If those extensions are absent, plan mode still works normally.

## Notes

- `questionnaire` is provided by the companion local extension in `extensions/questionnaire/`
- `web_fetch` is optional and comes from your existing `pi-web-fetch` package when installed and loaded
- `web_fetch` is a tool, not a skill
