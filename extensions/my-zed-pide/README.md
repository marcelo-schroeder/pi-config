# My Zed PiDe Setup Extension

Installs and removes an idempotent Zed-side shortcut that exports the current file or selected text in the same `~/.pi/ide-selection.json` format used by [`@pborck/pi-de`](https://github.com/pierre-borckmans/pide).

## What it does

The extension adds two Pi slash commands:

- `/my-zed-pide-install`
- `/my-zed-pide-remove`

`/my-zed-pide-install` writes or updates three Zed-side pieces:

- `keymap.json` — adds a managed `ctrl-alt-;` binding (`Ctrl+Alt+;`)
- `tasks.json` — adds a managed task that exports the current file / selection
- a generated helper script inside the Zed config directory that writes `~/.pi/ide-selection.json`

`/my-zed-pide-remove` removes only those managed pieces and also clears `~/.pi/ide-selection.json` if it still points at Zed.

## Why this exists

Zed currently exposes enough task context to export:

- `ZED_FILE`
- `ZED_SELECTED_TEXT`
- `ZED_ROW`

That is enough to emulate the editor side of `pi-de` without asking users to hand-edit Zed config on every machine.

When there is no selection, the generated Zed helper exports just the file path (matching the VS Code behavior) rather than a single cursor line.

When there is a selection, the helper counts selected lines without treating the final trailing newline as an extra phantom line.

It also trims trailing blank lines from the exported Zed selection before writing `~/.pi/ide-selection.json`, which makes the exported range closer to what the visual selection usually suggests.

## Behavior

- install is designed to be idempotent
- rerunning install updates the managed task, keybinding, and helper script in place without creating duplicates
- remove is designed to be idempotent
- rerunning remove is a no-op once the managed config is gone
- existing non-managed `Ctrl+Alt+;` bindings are not deleted; the managed binding is appended later so it should take precedence while installed
- tasks/keymap files are normalized back to plain JSON when written

## Expected workflow

1. enable this extension in Pi
2. run `/my-zed-pide-install`
3. make sure the Pi side has a consumer for `~/.pi/ide-selection.json` such as `@pborck/pi-de`
4. in Zed, press `Ctrl+Alt+;` to export the current file or selection
5. in Pi, press `Ctrl+;` to paste the reference

## Notes

- Zed config paths use `~/.config/zed` on macOS/Linux and `%APPDATA%/Zed` on Windows
- the generated helper script is placed in that same Zed config directory
- the helper script tries to infer selection line ranges by locating the selected text in the current file and choosing the closest match to `ZED_ROW`
