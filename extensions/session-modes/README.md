# Session Modes Extension

Unified session-scoped modes and persisted plans for Pi.

This extension replaces three former local extensions that handled read-only mode, plan mode, and footer mode badges separately.

## Modes

Supported modes:

- `default` — normal Pi behavior
- `read-only` — restricts tools and blocks workspace / git mutation
- `plan` — read-only behavior plus planning-focused guidance and persisted session plans

The current mode is persisted in the session, so resuming the session restores the same mode.

## Plans

A session can have:

- zero or more persisted plans
- zero or one current plan

Plans are:

- stored in Pi session custom entries on disk
- linked naturally to the current session / branch
- identified by a friendly 3-word id like `calm-river-fox`

When a plan is:

- **created** → it becomes the current plan
- **updated** → it becomes the current plan
- **shown or selected by id** → that plan becomes the current plan

## Behavior

### Automatic plan mode entry

If the session is currently in `default` or `read-only` mode and the user asks to create or modify a plan, the extension automatically switches the session into `plan` mode before the turn runs.

### Plan presentation

In `plan` mode, after a plan is created or updated, the persisted plan is shown to the user in a formatted tool result and the user is asked what to do next:

- `clean context and implement plan`
- `keep context and implement plan`
- `stay in plan mode`

Pressing `Esc` in that questionnaire behaves the same as **stay in plan mode**.

### Showing plans in any mode

The agent can show the current plan, list all plans, or select a plan by id in any mode.

## Status / footer

The current mode is displayed as the last element on the right-hand side of footer line 2:

- `default` — no badge
- `read-only` — `🔒 read-only`
- `plan` — `🧭 plan`

## Keyboard behavior

This extension installs a custom editor layer with these shortcuts while the main editor is focused:

- `Shift+Tab` — cycle session mode: `default -> read-only -> plan -> default`
- `Ctrl+Alt+T` — cycle thinking level

### Recommended Pi keybindings config

Pi still documents its built-in thinking-level action as `Shift+Tab` unless you also remap it in your global Pi keybindings file.

Recommended `~/.pi/agent/keybindings.json`:

```json
{
  "cycleThinkingLevel": ["ctrl+alt+t"]
}
```

Then run `/reload`.

The extension still provides the editor-level shortcut behavior even if you do not add that config, but updating the global keybindings keeps `/hotkeys` and other built-in hints accurate.

## Notes

- This extension expects the companion `questionnaire` extension to be available so the agent can ask structured clarifying questions when needed.
- Persisted plans live inside the session JSONL file rather than separate plan files.
- There are no public slash commands for mode switching.
