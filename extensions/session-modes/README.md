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

That formatted plan result is the canonical presentation. If the tool/UI already renders the plan and questionnaire, the assistant should add no extra congratulatory text, paraphrase, or next-step narration by default. Only add assistant text when clarification is needed or the tool output failed to render.

Pressing `Esc` in that questionnaire behaves the same as **stay in plan mode**.

### Direct implementation handoff from plan mode

If `plan` mode is active and a current plan exists, choosing either implementation option from the post-plan questionnaire or giving a direct user instruction to implement the plan automatically switches the session back to `default` mode before implementation begins.

### Implicit plan creation while already in plan mode

If `plan` mode is active and there is no current plan, the agent should default to creating a persisted implementation plan for substantive work prompts, even when the user never explicitly says `plan`.

This includes prompts framed as bugs, problems, challenges, tasks, or desired changes after the user manually toggles into plan mode.

- If enough information is already available, create the plan immediately.
- Otherwise ask only the missing focused questions, ideally via `questionnaire`.

Examples:

- `I toggled plan mode. There is a bug in session-modes: manual plan mode does not default to planning.` → create a persisted implementation plan
- `I am in plan mode. Help me fix this problem in the extension.` → create a persisted implementation plan
- `Are we in plan mode right now?` → answer directly; do not create or update a plan
- `How does plan mode work?` → answer directly; do not create or update a plan
- `show the plan`, `list plans`, `select calm-river-fox` → use plan display/selection behavior; do not create a new plan unless explicitly asked

Direct implementation handoff still only applies once a current plan already exists.

### Plan quality

Persisted plans are the canonical execution artifact in `plan` mode and must stand on their own.

Write each plan so a competent agent with no access to prior conversation context can execute it without losing quality. Completeness and clarity should override brevity.

Include whatever context is needed to preserve execution quality, such as:

- the goal and intended outcome
- relevant current context and assumptions
- concrete intended changes
- affected files, components, systems, or interfaces
- dependencies, sequencing, and decision points
- constraints, invariants, non-goals, and edge cases
- validation steps, tests, and acceptance criteria
- material risks, ambiguities, and open questions

Plans should stay actionable and tailored to the task rather than forcing a rigid template, but they should not rely on shorthand like “as discussed above” or omit important details merely to be brief.

If an important implementation detail is unknown and would require guessing, the agent should ask a focused follow-up question or explicitly record the uncertainty and how it should be resolved.

### Showing plans in any mode

The agent can show the current plan, list all plans, or select a plan by id in any mode.

## Status / footer

The current mode is displayed as the last element on the right-hand side of footer line 2. Non-default badge text is highlighted separately from the dim status text, while the ` • ` separator stays dim:

- `default` — no badge
- `read-only` — ` • 🔒 read-only`
- `plan` — ` • 📐 plan`

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

## Verification checklist

Use this checklist when validating plan-mode behavior manually in Pi:

- Start with no current plan and manually toggle the session into `plan` mode.
- Send a substantive work prompt such as a bug report, problem statement, challenge, or desired change that does **not** mention the word `plan`.
  - Expected: the agent creates a persisted implementation plan instead of answering generally or starting implementation.
- Ask a meta/status prompt such as `Are we in plan mode right now?` or `How does plan mode work?`.
  - Expected: the agent answers directly without creating or updating a plan.
- Ask to `show`, `list`, or `select` a plan.
  - Expected: the agent uses plan display/selection behavior without creating a new plan.
- With a current plan present, ask to `implement the plan`.
  - Expected: the session switches out of plan mode and begins implementation as before.
- Outside plan mode, ask to create or modify a plan.
  - Expected: the session automatically enters `plan` mode and persists the plan.

## Notes

- This extension expects the companion `questionnaire` extension to be available so the agent can ask structured clarifying questions when needed.
- Persisted plans live inside the session JSONL file rather than separate plan files.
- There are no public slash commands for mode switching.
