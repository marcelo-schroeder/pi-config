---
name: my-commit-staged
description: "Commit only the currently staged changes with a single Conventional Commit message. Use when the staging area already contains exactly what should be committed. Args: none"
---

# My Commit Staged

Commit only the currently staged changes following these rules:

## Authorization

Explicit user invocation of this skill is authorization to run `git commit` for the currently staged changes only.

It does not authorize staging, unstaging, or otherwise modifying the staging area.

## Steps

1. Run `git diff --cached --stat` to check for staged changes
2. If nothing is staged, report `No staged changes to commit.` and stop
3. If changes exist, run `git diff --cached` to analyze them
4. Pick the best Conventional Commit type: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`
5. Determine a short scope from the dominant directory or component
6. Craft a single-line commit subject at or below 72 characters, imperative mood, describing the main change
7. If multiple areas changed, pick the primary one for scope
8. Run `git commit -m "<type>(<scope>): <subject>"`
9. Report the final commit message used

## Critical Rules

- Do not stage or unstage any files
- Do not use `git add` or `git restore --staged`
- Only commit what is already in the staging area
