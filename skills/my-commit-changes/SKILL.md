---
name: my-commit-changes
description: "Commit all uncommitted changes, grouping related files into atomic Conventional Commits. Use when the working tree has staged, unstaged, or untracked changes that should be committed. Args: none"
---

# My Commit Changes

Commit all uncommitted changes (staged, unstaged, and untracked files), intelligently grouping related files into separate atomic commits when appropriate.

## Authorization

Explicit user invocation of this skill is authorization to inspect, stage, unstage, and commit changes as required by this workflow.

Do not perform unrelated git operations outside this workflow.

## Dependency

This skill requires the `git-snapshot` extension because Step 4 must use the `git_snapshot_create` tool.

If that tool is unavailable, stop and report that the `git-snapshot` extension must be enabled before this workflow can mutate git state.

## Step 1: Gather all changes

Run these commands to understand the full picture:

- `git status --porcelain` to list all changed and untracked files
- `git diff HEAD` to see the content of all tracked-file changes (staged + unstaged combined)
- For any untracked files (lines starting with `??` in status), read them to understand their content

If there are no changes at all, report `No uncommitted changes found.` and stop.

## Step 2: Analyze and group changes

Treat all changes as a single pool regardless of current staging state. Group files into logical commits based on:

- Related functionality
- Same component or feature area
- Same type of change

If all changes are logically related, use a single commit. Do not split unnecessarily.

## Step 3: Present the plan

Show a numbered list of proposed commits, each with:

- The Conventional Commit message (`feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`)
- The list of files in that commit

Then proceed directly to execution unless the user interrupts or gives contrary instructions.

## Step 4: Create a safety snapshot

Before performing any mutating git command (`git reset`, `git add`, or `git commit`), call the `git_snapshot_create` tool.

Use the tool with no arguments unless the user explicitly asked for different snapshot behavior.

Critical sequencing rule:

- Do **not** batch the `git_snapshot_create` tool call in the same assistant turn as mutating git commands.
- Wait for the snapshot result first.
- Only after a successful snapshot step may you run mutating git commands.

Behavior:

- If the tool returns `created: true`, briefly report the stash ref and commit hash, then continue.
- If it returns `created: false`, continue normally.
- If the tool fails for any reason, stop immediately, report the error, and do not mutate git state.

## Step 5: Execute commits

Use a single shell call when practical, chaining `git add` + `git commit` pairs with `&&`.

Example:

```bash
git reset HEAD && \
git add file1 file2 && git commit -m "feat(scope): subject" && \
git add file3 && git commit -m "fix(scope): subject" && \
git status
```

After the command runs, report all commit messages used.

## Rules

- This workflow may use `git add`, `git reset HEAD`, and `git commit` only as required by the steps above
- Do not push to remote
- Do not use `git add -A` or `git add .`; always add specific files by name
- Do not use interactive git flags (`-i`, `-p`)
- Commit messages must use Conventional Commits format
- Keep commit subjects at or below 72 characters in imperative mood
