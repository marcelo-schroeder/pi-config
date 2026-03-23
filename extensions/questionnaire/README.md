# Questionnaire Extension

Provides a `questionnaire` tool for asking structured clarification questions in interactive Pi sessions.

This extension is mainly intended as a building block for other workflows in this repo, especially read-only or planning-first workflows, but it can also be useful on its own whenever the model should ask the user to choose from clear options instead of free-form chat.

## What it does

- asks one or more structured questions
- supports labeled options with optional descriptions
- supports a fallback **Type something** option for custom answers
- uses a custom TUI flow for interactive selection and submission
- returns a concise structured summary of the user's answers to the model

## Best use cases

Use `questionnaire` for:

- short clarifications
- confirmations
- preference selection
- cases where a fixed option list is better than an open-ended question

Avoid it for broad exploratory conversations where normal chat is a better fit.

## Requirements

This tool requires Pi's interactive UI.

In non-interactive mode, it returns an error result instead of opening the questionnaire UI.

## Tool shape

The tool accepts a `questions` array. Each question has:

- `id` — unique identifier
- `label` — optional short tab label
- `prompt` — the question text shown to the user
- `options` — list of selectable answers
- `allowOther` — optional, defaults to `true`

Example:

```json
{
  "questions": [
    {
      "id": "scope",
      "label": "Scope",
      "prompt": "Which area should I focus on?",
      "options": [
        { "value": "docs", "label": "Documentation" },
        { "value": "tests", "label": "Tests" },
        { "value": "refactor", "label": "Refactor" }
      ]
    },
    {
      "id": "priority",
      "label": "Priority",
      "prompt": "How urgent is this?",
      "options": [
        { "value": "low", "label": "Low" },
        { "value": "medium", "label": "Medium" },
        { "value": "high", "label": "High" }
      ],
      "allowOther": false
    }
  ]
}
```

## Notes

- `read-only` keeps `questionnaire` available so the agent can still ask structured clarifying questions without leaving safety mode.
- This extension provides a tool, not a slash command.
- Implementation lives in [`index.ts`](./index.ts) with shared UI logic in [`ui.ts`](./ui.ts).
