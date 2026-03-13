# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to read, bash, grep, find, ls, questionnaire, and optionally web_fetch
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Session persistence**: State survives session resume
- **Tool restoration**: Restores the previously active tool set after leaving plan mode

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
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

4. Choose **Execute the plan** when prompted
5. During execution, the agent marks steps complete with `[DONE:n]` tags
6. Progress widget shows completion status

## Notes

- `questionnaire` is provided by the companion local extension in `extensions/questionnaire/`
- `web_fetch` is optional and comes from your existing `pi-web-fetch` package when installed and loaded
- `web_fetch` is a tool, not a skill
