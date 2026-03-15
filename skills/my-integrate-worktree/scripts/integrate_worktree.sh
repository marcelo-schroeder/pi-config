#!/usr/bin/env bash
set -euo pipefail

#
# Bundled helper for the my-integrate-worktree skill.
#
# Fast-forwards a recorded target branch with a rebased piw worktree branch and
# optionally pushes the target branch to its remote.
#
# The calling skill is responsible for validating worktree_info metadata,
# fetching the recorded target, and rebasing the current branch before invoking
# this helper.
#
# Usage:
#   ./scripts/integrate_worktree.sh \
#     --repo-root <repo-root> \
#     --branch <branch-name> \
#     --target-remote <remote> \
#     --target-branch <branch> \
#     [--skip-push] [--dry-run]
#
# Convenience usage:
#   ./scripts/integrate_worktree.sh \
#     --repo-root <repo-root> \
#     <worktree-name> \
#     --target-remote <remote> \
#     --target-branch <branch> \
#     [--skip-push] [--dry-run]
#
# If no --repo-root is provided, the helper tries to derive the shared repo root
# from the current git worktree via `git rev-parse --git-common-dir`.
#

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

fail() {
  printf "${RED}Error: %s${NC}\n" "$*" >&2
  exit 1
}

info() {
  printf "${YELLOW}%s${NC}\n" "$*"
}

success() {
  printf "${GREEN}%s${NC}\n" "$*"
}

usage() {
  cat <<USAGE
Fast-forward a recorded target branch with a piw worktree branch.

Usage:
  $(basename "$0") --repo-root <repo-root> --branch <branch-name> --target-remote <remote> --target-branch <branch> [options]
  $(basename "$0") --repo-root <repo-root> <worktree-name> --target-remote <remote> --target-branch <branch> [options]
  $(basename "$0") --branch <branch-name> --target-remote <remote> --target-branch <branch> [options]

Arguments:
  worktree-name          Optional convenience form; derives branch as piw/<worktree-name>

Options:
  --repo-root <path>     Shared repository root / primary checkout path
  --branch <name>        Branch to integrate directly
  --target-remote <name> Recorded integration remote
  --target-branch <name> Recorded integration branch
  --dry-run              Show what would be done without executing
  --skip-push            Merge locally but don't push the target branch
  -h, --help             Show this help message

Examples:
  $(basename "$0") --repo-root /repo --branch piw/eager-mesa-heron --target-remote origin --target-branch main
  $(basename "$0") --repo-root /repo eager-mesa-heron --target-remote origin --target-branch main --dry-run
  $(basename "$0") --branch piw/my-feature --target-remote upstream --target-branch develop --skip-push
USAGE
}

resolve_repo_root() {
  if [[ -n "$EXPLICIT_REPO_ROOT" ]]; then
    git -C "$EXPLICIT_REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || {
      fail "Invalid --repo-root: $EXPLICIT_REPO_ROOT"
    }
    return
  fi

  local common_dir
  common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || {
    fail "Not in a git repository and no --repo-root was provided"
  }
  (cd "$common_dir/.." && pwd)
}

WORKTREE_NAME=""
EXPLICIT_REPO_ROOT=""
EXPLICIT_BRANCH=""
TARGET_REMOTE=""
TARGET_BRANCH=""
DRY_RUN=false
SKIP_PUSH=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      [[ -n "${2:-}" ]] || fail "--repo-root requires a value"
      EXPLICIT_REPO_ROOT="$2"
      shift 2
      ;;
    --branch)
      [[ -n "${2:-}" ]] || fail "--branch requires a value"
      EXPLICIT_BRANCH="$2"
      shift 2
      ;;
    --target-remote)
      [[ -n "${2:-}" ]] || fail "--target-remote requires a value"
      TARGET_REMOTE="$2"
      shift 2
      ;;
    --target-branch)
      [[ -n "${2:-}" ]] || fail "--target-branch requires a value"
      TARGET_BRANCH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --skip-push)
      SKIP_PUSH=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fail "Unknown option: $1"
      ;;
    *)
      if [[ -z "$WORKTREE_NAME" ]]; then
        WORKTREE_NAME="$1"
      else
        fail "Unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[[ -n "$EXPLICIT_BRANCH" || -n "$WORKTREE_NAME" ]] || {
  usage
  fail "Missing required argument: --branch or worktree-name"
}
[[ -n "$TARGET_REMOTE" ]] || fail "Missing required argument: --target-remote"
[[ -n "$TARGET_BRANCH" ]] || fail "Missing required argument: --target-branch"

MAIN_REPO=$(resolve_repo_root)
TARGET_REF="${TARGET_REMOTE}/${TARGET_BRANCH}"

if [[ -n "$EXPLICIT_BRANCH" ]]; then
  BRANCH="$EXPLICIT_BRANCH"
else
  BRANCH="piw/${WORKTREE_NAME}"
fi

cd "$MAIN_REPO"

git rev-parse --show-toplevel >/dev/null 2>&1 || fail "Resolved repo root is not a git repository: $MAIN_REPO"
git remote get-url "$TARGET_REMOTE" >/dev/null 2>&1 || fail "Remote '$TARGET_REMOTE' does not exist in $MAIN_REPO"
git rev-parse --verify --quiet "$BRANCH^{commit}" >/dev/null || fail "Branch '$BRANCH' does not exist in $MAIN_REPO"

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}     Integrate Branch                   ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "  Main repo:       $MAIN_REPO"
[[ -n "$WORKTREE_NAME" ]] && echo "  Worktree:        $WORKTREE_NAME"
echo "  Branch:          $BRANCH"
echo "  Target:          $TARGET_REF"
echo ""

ACTIONS="fast-forward ${TARGET_BRANCH} with ${BRANCH}"
[[ "$SKIP_PUSH" == "false" ]] && ACTIONS="$ACTIONS, push ${TARGET_BRANCH}"
echo "  Actions:         $ACTIONS"
[[ "$DRY_RUN" == "true" ]] && echo -e "\n  ${YELLOW}DRY RUN MODE - No changes will be made${NC}"
echo ""

info "[1/2] Merging $BRANCH into $TARGET_BRANCH (fast-forward)..."

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[DRY RUN] Would run: git checkout $TARGET_BRANCH"
  echo "[DRY RUN] Would run: git pull --ff-only $TARGET_REMOTE $TARGET_BRANCH"
  echo "[DRY RUN] Would run: git merge --ff-only $BRANCH"
else
  git checkout "$TARGET_BRANCH" || {
    fail "Failed to checkout $TARGET_BRANCH. Your rebased commits are still on branch '$BRANCH'."
  }

  git pull --ff-only "$TARGET_REMOTE" "$TARGET_BRANCH" || {
    fail "Failed to fast-forward $TARGET_BRANCH from $TARGET_REF. Your rebased commits are still on branch '$BRANCH'."
  }

  git merge --ff-only "$BRANCH" || {
    fail "Fast-forward merge failed ($TARGET_BRANCH may have diverged). Your rebased commits are still on branch '$BRANCH'."
  }

  success "  Merged $BRANCH into $TARGET_BRANCH (fast-forward)"
fi
echo ""

if [[ "$SKIP_PUSH" == "true" ]]; then
  info "[2/2] Push skipped (--skip-push)"
else
  info "[2/2] Pushing $TARGET_BRANCH to $TARGET_REMOTE..."

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY RUN] Would run: git push $TARGET_REMOTE $TARGET_BRANCH"
  else
    git push "$TARGET_REMOTE" "$TARGET_BRANCH" || {
      fail "Failed to push $TARGET_BRANCH. The merge is done locally. Your rebased commits are still on branch '$BRANCH'."
    }

    success "  Pushed $TARGET_BRANCH to $TARGET_REMOTE"
  fi
fi
echo ""

echo ""
echo -e "${BLUE}========================================${NC}"
if [[ "$DRY_RUN" == "true" ]]; then
  success "Dry run complete!"
else
  success "Integration complete!"
fi
echo -e "${BLUE}========================================${NC}"
echo ""
