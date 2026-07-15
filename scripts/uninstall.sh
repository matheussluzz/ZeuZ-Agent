#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"
LOCAL_PREFIX="${ZEUZ_LOCAL_PREFIX:-$HOME/.local}"
LOCAL_BIN="$LOCAL_PREFIX/bin"
WORKSPACE_LINK="${ZEUZ_WORKSPACE_LINK:-$HOME/agents}"
ASSUME_YES=0
DRY_RUN=0
REMOVE_WORKSPACE_LINK=0

usage() {
  cat <<'EOF'
Usage: ./scripts/uninstall.sh [--yes] [--dry-run] [--remove-workspace-link]

Removes only the ZeuZ executable links. It intentionally preserves provider
CLIs, Node.js, pnpm, logins, ~/.agents state, lamine.yaml, vaults, and repos.

  --remove-workspace-link  Also remove ~/agents only when it is a symlink to
                           this exact repository. Never removes a directory.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --remove-workspace-link) REMOVE_WORKSPACE_LINK=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

confirm() {
  local reply
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ -t 0 ] || { printf 'Confirmation required; re-run with --yes.\n' >&2; return 1; }
  printf 'Remove ZeuZ executable links? [y/N] ' >/dev/tty
  IFS= read -r reply </dev/tty || true
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

remove_owned_link() {
  local path="$1" target
  [ -L "$path" ] || { printf '[skip] %s is not a symlink\n' "$path"; return 0; }
  target=$(readlink "$path")
  case "$target" in
    "$WORKSPACE_LINK/bin/zeuz"|"$REPO_ROOT/bin/zeuz"|"$WORKSPACE_LINK/bin/agents"|"$REPO_ROOT/bin/agents")
      if [ "$DRY_RUN" -eq 1 ]; then printf '[plan] remove %s -> %s\n' "$path" "$target"; else rm "$path"; printf '[ok] removed %s\n' "$path"; fi
      ;;
    *) printf '[skip] refusing to remove unrelated link %s -> %s\n' "$path" "$target" ;;
  esac
}

confirm || { printf 'Cancelled.\n'; exit 0; }
remove_owned_link "$LOCAL_BIN/zeuz"
remove_owned_link "$LOCAL_BIN/agents"

if [ "$REMOVE_WORKSPACE_LINK" -eq 1 ]; then
  if [ -L "$WORKSPACE_LINK" ]; then
    existing_real=$(CDPATH= cd -- "$WORKSPACE_LINK" 2>/dev/null && pwd -P || true)
    if [ "$existing_real" = "$REPO_ROOT" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then printf '[plan] remove workspace link %s\n' "$WORKSPACE_LINK"; else rm "$WORKSPACE_LINK"; printf '[ok] removed workspace link %s\n' "$WORKSPACE_LINK"; fi
    else
      printf '[skip] workspace link does not resolve to this repository\n'
    fi
  else
    printf '[skip] %s is not a symlink; directories are never removed\n' "$WORKSPACE_LINK"
  fi
fi

printf 'Provider CLIs, runtimes, credentials, local state, and repositories were preserved.\n'
