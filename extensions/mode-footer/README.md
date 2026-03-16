# Mode Footer Extension

Moves plan/read-only mode badges out of Pi's default 3rd status line and onto the **right-hand side of footer line 2**, immediately after the model info.

## Behavior

When loaded, the footer keeps Pi's stock three-part structure:

1. working directory / git branch / session name
2. stats on the left, `<model info> <mode badges>` on the right
3. any remaining extension statuses

Mode badges rendered on line 2:

- `🔒 read-only`
- `⏸ plan`
- `📋 n/m`

Any other `ctx.ui.setStatus()` entries still stay on line 3.

## Notes

- This extension uses `ctx.ui.setFooter()`, so it replaces Pi's built-in footer.
- It intentionally filters `read-only-mode` and `plan-mode` out of the normal extension-status line to avoid duplicate badges.
- If another extension also calls `ctx.ui.setFooter()`, whichever one runs last wins.
