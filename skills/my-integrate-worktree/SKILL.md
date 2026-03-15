---
name: my-integrate-worktree
description: "Integrate the current piw-managed worktree branch into its recorded target branch by validating worktree_info metadata, rebasing onto that target, and running the repository integration script. Use only from a piw session. Args: none"
---

# My Integrate Worktree

Integrate the current branch's commits into the recorded target branch from an active `piw`-managed worktree session.

This skill is **piw-only**. It does not support Claude Code worktree layouts or other path-based worktree conventions.

Run all steps without confirmation unless an error occurs.

## Authorization

Explicit user invocation of this skill is authorization to perform the fetch, rebase, commit, staging, and integration-script operations required by this workflow.

Do not perform unrelated git operations outside this workflow.

## Step 1: Require authoritative worktree metadata

1. Call `worktree_info`
2. If the tool is unavailable, report `This skill requires a piw-managed worktree session. Re-launch the task with piw.` and stop
3. If `active !== true`, `kind !== "piw"`, or `managed !== true`, report `This skill only runs inside an active piw-managed worktree session.` and stop
4. If `metadataComplete !== true`, report `This worktree does not have complete piw integration metadata. Recreate it with piw before using this skill.` and stop

Treat `worktree_info` as the authoritative source for the session's worktree metadata. Do not infer worktree details from filesystem layout or upstream tracking.

## Step 2: Validate integration intent

Read these fields from `worktree_info`:

- `name`
- `path`
- `branch`
- `repoRoot`
- `base`
- `integration`

Require all of the following:

- `branch` starts with `piw/`
- `integration.remote` is present
- `integration.branch` is present
- `integration.createdFromTarget === true`

Then define:

- `<target-remote>` = `integration.remote`
- `<target-branch>` = `integration.branch`
- `<target-ref>` = `<target-remote>/<target-branch>`

If any check fails, stop and report that this worktree is not eligible for automated integration into its recorded target branch.

## Step 3: Verify repository integration script

Require this script to exist:

```text
<repoRoot>/scripts/integrate_worktree.sh
```

If it does not exist, report the missing path and stop.

Assume the repository's integration script is compatible with the recorded target branch. If the repository uses a different integration policy, stop and explain the mismatch when it becomes apparent.

## Step 4: Check cleanliness

Run `git status --porcelain`.

If the worktree is dirty:

1. Report the current uncommitted changes grouped as:
   - staged changes via `git diff --cached --stat`
   - unstaged tracked changes via `git diff --stat`
   - untracked files from porcelain output
2. Commit everything before continuing, following the workflow from the `my-commit-changes` skill

## Step 5: Fetch and inspect commits ahead of the recorded target

Run:

```bash
git fetch <target-remote> <target-branch>
git log <target-ref>..HEAD --oneline
```

If there are no commits ahead of `<target-ref>`, report `Nothing to integrate — no commits ahead of <target-ref>.` and stop.

Show this summary:

```text
Worktree:  <name>
Branch:    <branch>
Path:      <path>
Repo:      <repoRoot>
Base:      <base.input>
Target:    <target-ref>
Commits:   <N> ahead of <target-ref>
```

## Step 6: Rebase onto the latest recorded target

Run automatically:

```bash
git fetch <target-remote> <target-branch>
git rebase <target-ref>
```

If rebase fails:

1. Run `git rebase --abort`
2. Report which files conflicted
3. Remind the user that the branch has been restored to its pre-rebase state
4. Stop

Do not automatically resolve rebase conflicts.

## Step 7: Run repository integration

Run the repository integration script using the **actual branch from `worktree_info`**:

```bash
<repoRoot>/scripts/integrate_worktree.sh --branch <branch>
```

If the user asked to skip pushing, append `--skip-push`.

Never derive a branch name from the worktree name.

If the script exits non-zero:

1. Report the error output
2. Remind the user that the rebased commits are still on the current branch
3. Stop

## Step 8: Report success

Show:

- the list of integrated commits from Step 5
- the repo path
- the integrated branch
- the recorded target branch
- that the active `piw` worktree remains managed by `piw`
- that this skill does **not** delete the active worktree or its branch
- `<target-branch> is up to date on <target-remote>.`

## Rules

- This workflow may use `git fetch`, `git rebase`, `git add`, `git commit`, and the repository's `integrate_worktree.sh` script only as required by the steps above
- Only pause for user input when an error occurs
- Do not use upstream tracking as a precondition for this workflow
- Do not derive branch names from worktree names
- Do not delete the active worktree or branch
- Do not use `--force` on any git command
- Do not use interactive git flags (`-i`, `-p`)
- Prefer absolute paths when invoking the repository integration script
