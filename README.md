# pi-config

Opinionated personal configuration for [Pi](https://shittycodingagent.ai): local extensions, reusable skills, and [`piw`](packages/piw/README.md), a git worktree wrapper for launching Pi inside managed worktrees.

This repo is meant to be a thin index at the top level. The detailed behavior for each extension, skill, and `piw` lives in its own documentation, so this README mostly points you to the right place.

## What this repo contains

- [`extensions/`](extensions/) — Pi extensions you can enable with `pi config`
- [`skills/`](skills/) — Pi skills that show up as `/skill:<name>`
- [`packages/piw/`](packages/piw/) — a standalone `piw` package and its private worktree-awareness extension

The top-level `extensions/` and `skills/` directories are intended to be used as a Pi package. `packages/piw/` is separate and is documented separately.

## Quick start

Clone the repo, then add it to Pi.

### Install this repo as a Pi package

Project-local install:

```bash
pi install -l .
```

Global install:

```bash
pi install /absolute/path/to/pi-config
```

After the repo is on GitHub, you can also install it directly from git:

```bash
pi install git:github.com/<your-user>/<your-repo>
# or project-local
pi install -l git:github.com/<your-user>/<your-repo>
```

Then enable the pieces you want:

```bash
pi config
```

Pi will auto-discover the top-level `extensions/` and `skills/` directories using its normal package conventions.

## Recommended starting setup

If you want a sensible default setup from this repo, start with:

- [`questionnaire`](extensions/questionnaire/README.md)
- [`session-modes`](extensions/session-modes/README.md)
- optionally [`git-snapshot`](extensions/git-snapshot/README.md)

A couple of useful relationships to know up front:

- `questionnaire` is the companion extension that provides the `questionnaire` tool used by planning / structured clarification workflows
- `session-modes` replaces three former local extensions with one unified mode + plan workflow

## Using `piw`

[`piw`](packages/piw/README.md) is a separate tool in this repo. It is **not** the same thing as installing the repo's top-level extensions and skills.

Use `piw` when you want Pi sessions to run inside managed git worktrees with recorded worktree metadata and the private `worktree_info` tool.

Start with the dedicated docs here:

- [`packages/piw/README.md`](packages/piw/README.md)

Typical entry points:

```bash
node packages/piw/bin/piw.js
node packages/piw/bin/piw.js feature-auth -- --model sonnet:high

cd packages/piw
npm link
piw feature-auth
```

If you plan to use [`my-integrate-worktree`](skills/my-integrate-worktree/SKILL.md), launch the session with `piw` first — that skill is specifically designed for `piw`-managed worktrees.

## Extensions

Enable these with `pi config` after installing the repo as a Pi package.

| Extension | Purpose | Docs |
| --- | --- | --- |
| `questionnaire` | Structured interactive question/answer tool for short clarifications and confirmations. Companion extension used by other workflows in this repo. | [`extensions/questionnaire/README.md`](extensions/questionnaire/README.md) |
| `session-modes` | Unified `default` / `read-only` / `plan` session modes with persisted session-linked plans and integrated footer UI. | [`extensions/session-modes/README.md`](extensions/session-modes/README.md) |
| `git-snapshot` | Adds `/snapshot` commands for stash-style workspace snapshots. | [`extensions/git-snapshot/README.md`](extensions/git-snapshot/README.md) |

## Skills

After installing the repo, Pi can auto-load these on demand, or you can invoke them directly with `/skill:<name>`.

| Skill | Purpose | Docs |
| --- | --- | --- |
| `my-commit-changes` | Commit all uncommitted changes, grouping related files into atomic Conventional Commits. | [`skills/my-commit-changes/SKILL.md`](skills/my-commit-changes/SKILL.md) |
| `my-commit-staged` | Commit only the currently staged changes with a single Conventional Commit message. | [`skills/my-commit-staged/SKILL.md`](skills/my-commit-staged/SKILL.md) |
| `my-integrate-worktree` | Integrate the current `piw` worktree branch into its recorded target branch. | [`skills/my-integrate-worktree/SKILL.md`](skills/my-integrate-worktree/SKILL.md) |

## Repo layout

```text
extensions/      Top-level Pi extensions
skills/          Top-level Pi skills
packages/piw/    Standalone piw package and private extension
```

## Related Pi docs

If you are new to Pi itself, the upstream docs are the best reference for the surrounding concepts:

- [Pi packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [Extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md)
