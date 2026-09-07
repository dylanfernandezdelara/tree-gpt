#!/usr/bin/env bash
#
# scripts/agent-worktree.sh — parallel-agent worktree lifecycle.
#
# Goal: let N agents work locally in separated git worktrees, with the
# worktree automatically purged once the work is done (merged or disposed).
#
# Agent protocol (paste into the agent prompt):
#   1. Create:  scripts/agent-worktree.sh create <task>
#   2. Work:    cd <WORKTREE printed above>, edit, git add, git commit
#   3. Finish:  cd back to the main checkout, then
#               scripts/agent-worktree.sh finish <task>
#   On merge conflict finish aborts the merge and leaves the worktree and
#   branch intact — rebase/retry, then call finish again. Never force-push
#   the base branch, never delete a branch that is not fully merged.
#
# Subcommands:
#   create <task> [--base <branch>]   new sibling worktree + agent/<task> branch
#   finish <task> [--base <branch>]   merge branch into base, then purge worktree+branch
#   dispose <task> [--force] [--base <branch>]  purge worktree without merging (abandoned work)
#   gc [--base <branch>]              purge every merged agent/* worktree (sweep leftovers)
#   list                              prune + list worktrees
#
# Conventions: task "add login page" -> branch "agent/add-login-page",
# worktree "<repo-parent>/treeGPT-add-login-page" (sibling of main checkout).
# Worktree removal always uses --force because worktrees legitimately contain
# ignored build artifacts (node_modules/, .wrangler/); tracked cleanliness is
# verified via `git status --porcelain` before any destructive step.
#
set -euo pipefail

BASE_DEFAULT="main"
LOCK_PATH="${TMPDIR:-/tmp}/treegpt-agent-worktree.lock"

die() { echo "agent-worktree: error: $*" >&2; exit 1; }
info() { echo "agent-worktree: $*"; }

sanitize() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-60 \
    | sed -E 's/-+$//'
  # NOTE: create dies if the resulting agent/<name> branch already exists,
  # so two tasks that sanitize identically fail safe instead of colliding.
}

repo_parent() {
  local top
  top="$(git rev-parse --show-toplevel)" || die "not inside a git repo"
  dirname "$top"
}

task_branch() { printf 'agent/%s' "$(sanitize "$1")"; }
task_path() { printf '%s/treeGPT-%s' "$(repo_parent)" "$(sanitize "$1")"; }

# Print the worktree path that currently has <base> checked out.
base_worktree_path() {
  local base="$1" path="" line
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ refs/heads/"$base") printf '%s\n' "$path"; return 0 ;;
    esac
  done < <(git worktree list --porcelain)
  return 1
}

worktree_listed() {
  git worktree list --porcelain | grep -qFx "worktree $1"
}

# Cleanliness helpers fail CLOSED: if git errors, the empty capture must not
# read as "clean", so the exit status is checked before testing emptiness.
# A git failure therefore blocks finish / skips gc instead of destroying work.
is_clean() {
  local out
  out="$(git -C "$1" status --porcelain)" || return 1
  [ -z "$out" ]
}
# Tracked-only cleanliness: untracked files (new scripts/, scratch files) do
# not affect merge safety in the base worktree, so they must not block finish.
is_clean_tracked() {
  local out
  out="$(git -C "$1" status --porcelain --untracked-files=no)" || return 1
  [ -z "$out" ]
}

acquire_lock() {
  local waited=0
  while ! mkdir "$LOCK_PATH" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
    if [ "$waited" -ge 60 ]; then
      die "another agent holds the worktree lock ($LOCK_PATH held 60s); retry later"
    fi
  done
  trap 'rmdir "$LOCK_PATH" 2>/dev/null || true' EXIT
}

release_lock() { rmdir "$LOCK_PATH" 2>/dev/null || true; trap - EXIT; }

cmd_create() {
  local task="${1:?usage: create <task> [--base <branch>]}" base="$BASE_DEFAULT"
  shift
  while [ $# -gt 0 ]; do case "$1" in
    --base) base="${2:?}"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac; done

  local san branch path src_wt f
  san="$(sanitize "$task")"
  [ -n "$san" ] || die "task name sanitizes to empty"
  branch="agent/$san"; path="$(task_path "$task")"

  git rev-parse --verify --quiet "refs/heads/$base" >/dev/null \
    || die "base branch '$base' does not exist"
  [ -e "$path" ] && die "path already exists: $path"
  git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null \
    && die "branch already exists: $branch"
  git worktree prune || true

  git fetch origin "$base" 2>/dev/null || true
  git worktree add "$path" -b "$branch" "$base"

  # Bootstrap ignored local secrets (never committed) so the agent can run the app.
  src_wt="$(base_worktree_path "$base" || git rev-parse --show-toplevel)"
  for f in .dev.vars .env; do
    if [ -f "$src_wt/$f" ] && [ ! -e "$path/$f" ]; then
      cp "$src_wt/$f" "$path/$f"
      info "copied $f from $(basename "$src_wt")"
    fi
  done

  info "created $branch at $path from $base"
  printf 'TASK=%s\nBRANCH=%s\nWORKTREE=%s\nBASE=%s\n' "$san" "$branch" "$path" "$base"
}

cmd_finish() {
  local task="${1:?usage: finish <task> [--base <branch>]}" base="$BASE_DEFAULT"
  shift
  while [ $# -gt 0 ]; do case "$1" in
    --base) base="${2:?}"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac; done

  local san branch path base_wt ahead
  san="$(sanitize "$task")"
  [ -n "$san" ] || die "task name sanitizes to empty"
  branch="agent/$san"; path="$(task_path "$task")"

  worktree_listed "$path" || die "no worktree for task '$san' ($path)"
  is_clean "$path" || die "worktree has uncommitted or untracked files — git add/commit them first, then retry"

  acquire_lock

  base_wt="$(base_worktree_path "$base" || true)"
  [ -n "${base_wt:-}" ] || { release_lock; die "base branch '$base' is not checked out in any worktree"; }
  is_clean_tracked "$base_wt" || { release_lock; die "base worktree ($base_wt) has modified tracked files — refusing to merge there"; }

  git -C "$base_wt" fetch origin "$base" 2>/dev/null || true
  if git -C "$base_wt" rev-parse --verify --quiet "refs/remotes/origin/$base" >/dev/null; then
    git -C "$base_wt" merge --ff-only -q "origin/$base" 2>/dev/null || \
      info "base has diverged from origin/$base; merging into local $base as-is"
  fi

  ahead="$(git -C "$base_wt" rev-list --count "$base..$branch" --)" \
    || { release_lock; die "cannot compare $branch against $base"; }
  if [ "$ahead" -eq 0 ]; then
    info "branch $branch has no commits ahead of $base; nothing to merge"
  else
    if ! git -C "$base_wt" merge --no-ff -m "Merge $branch: $task" "$branch"; then
      git -C "$base_wt" merge --abort || true
      release_lock
      die "merge conflict — merge aborted, worktree ($path) and branch ($branch) left intact; resolve, then retry finish"
    fi
    git -C "$base_wt" merge-base --is-ancestor "$branch" "$base" \
      || { release_lock; die "merge did not include $branch; leaving everything intact"; }
    info "merged $branch ($ahead commit(s)) into $base"
  fi

  git worktree remove --force "$path"
  git worktree prune || true
  # Delete from the base worktree: -d checks merged-ness against HEAD, which
  # is only the freshly merged base tip there (not in whatever worktree we run from).
  git -C "$base_wt" branch -d "$branch" || { release_lock; die "worktree purged but branch $branch not fully merged; left for inspection"; }
  release_lock

  info "purged worktree $path and deleted $branch"
  if case "$PWD" in "$path"*) true;; *) false;; esac; then
    info "your shell is still inside the removed path; cd to $base_wt"
  fi
}

cmd_dispose() {
  local task="${1:?usage: dispose <task> [--force] [--base <branch>]}" force=0 base="$BASE_DEFAULT"
  shift
  while [ $# -gt 0 ]; do case "$1" in
    --force) force=1; shift ;;
    --base) base="${2:?}"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac; done

  local san branch path
  san="$(sanitize "$task")"
  [ -n "$san" ] || die "task name sanitizes to empty"
  branch="agent/$san"; path="$(task_path "$task")"

  # Shared lock with finish/gc: disposing a worktree must not race a merge.
  acquire_lock

  if worktree_listed "$path"; then
    if [ "$force" -eq 1 ]; then
      git worktree remove --force "$path"
    else
      git worktree remove "$path" || { release_lock; die "worktree is dirty; retry with --force to discard"; }
    fi
    git worktree prune || true
    info "removed worktree $path"
  else
    info "no worktree for task '$san'; pruning and checking branch"
    git worktree prune || true
  fi

  if git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; then
    if [ "$force" -eq 1 ]; then
      git branch -D "$branch"
    # -d checks merged-ness against the caller's HEAD, which may not be the
    # base; prove ancestry against the base explicitly instead — then -D is
    # exactly as safe as -d would be there, from any caller worktree.
    elif git merge-base --is-ancestor "$branch" "$base"; then
      git branch -D "$branch"
    else
      release_lock
      die "branch $branch is not merged into $base; retry with --force to discard"
    fi
    info "deleted $branch"
  fi
  release_lock
}

# Purge every agent/* worktree whose branch is fully merged into base.
# Never touches dirty worktrees or unmerged branches — those are skipped.
cmd_gc() {
  local base="$BASE_DEFAULT"
  while [ $# -gt 0 ]; do case "$1" in
    --base) base="${2:?}"; shift 2 ;;
    *) die "unknown flag: $1" ;;
  esac; done

  local base_wt="" path="" branch="" line removed=0 skipped=0 purged
  base_wt="$(base_worktree_path "$base" || true)"
  # Shared lock with finish/dispose: sweeping must not race a merge or purge.
  acquire_lock
  git worktree prune || true
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }" ;;
      branch\ refs/heads/agent/*)
        branch="${line#branch refs/heads/}"
        if [ "$path" = "$base_wt" ]; then path=""; continue; fi
        # No output suppression: git errors surface on stderr while the
        # worktree is conservatively skipped, never misclassified as clean.
        if ! is_clean "$path"; then info "gc: skip $branch (dirty or git error)"; skipped=$((skipped+1));
        elif git merge-base --is-ancestor "$branch" "$base"; then
          purged=0
          if git worktree remove --force "$path"; then
            if [ -n "$base_wt" ]; then git -C "$base_wt" branch -d "$branch"; else git branch -d "$branch"; fi && purged=1
          fi
          if [ "$purged" -eq 1 ]; then info "gc: purged $branch ($path)"; removed=$((removed+1));
          else info "gc: skip $branch (purge failed)"; skipped=$((skipped+1)); fi
        else info "gc: skip $branch (unmerged)"; skipped=$((skipped+1)); fi
        path="" ;;
      branch\ *|detached|bare) path="" ;;
    esac
  done < <(git worktree list --porcelain)
  git worktree prune || true
  release_lock
  info "gc done: purged=$removed skipped=$skipped"
}

cmd_list() { git worktree prune || true; git worktree list; }

usage() {
  sed -n '2,/^set /p' "$0" | sed -E 's/^# ?//'
}

main() {
  local cmd="${1:-help}"; shift || true
  case "$cmd" in
    create) cmd_create "$@" ;;
    finish) cmd_finish "$@" ;;
    dispose) cmd_dispose "$@" ;;
    gc) cmd_gc "$@" ;;
    list) cmd_list "$@" ;;
    help|--help|-h) usage ;;
    *) die "unknown command: $cmd (create|finish|dispose|gc|list)" ;;
  esac
}

main "$@"
