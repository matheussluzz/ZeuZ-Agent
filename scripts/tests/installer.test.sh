#!/usr/bin/env bash

set -Eeuo pipefail

TEST_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(CDPATH= cd -- "$TEST_DIR/../.." && pwd -P)"
INSTALLER="$REPO_ROOT/scripts/install.sh"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/zeuz-installer-tests.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() { printf 'not ok - %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }

ZEUZ_INSTALLER_TESTING=1 source "$INSTALLER"

[ "$(major_version v24.18.0)" = "24" ] || fail "major_version parses a v-prefixed version"
[ "$(major_version '11.13.0')" = "11" ] || fail "major_version parses a plain version"
pass "version parsing"

semver_at_least "2.1.170 (Claude Code)" "2.1.170" || fail "minimum semver is accepted"
semver_at_least "2.1.210 (Claude Code)" "2.1.170" || fail "newer patch semver is accepted"
if semver_at_least "2.1.159 (Claude Code)" "2.1.170"; then fail "outdated Claude semver is rejected"; fi
pass "Claude Fable minimum version gate"

allowed_resolved_url codex "https://release-assets.githubusercontent.com/path/install.sh" || fail "Codex release origin allowed"
allowed_resolved_url cursor "https://cursor.com/install" || fail "Cursor origin allowed"
allowed_resolved_url claude "https://downloads.claude.ai/claude-code-releases/bootstrap.sh" || fail "Claude origin allowed"
allowed_resolved_url agy "https://antigravity.google/cli/install.sh" || fail "Antigravity origin allowed"
if allowed_resolved_url codex "https://example.com/install.sh"; then fail "unexpected redirect origin rejected"; fi
pass "remote redirect allowlist"

cursor_home="$TMP_ROOT/cursor-home"
mkdir -p "$cursor_home/.local/bin"
printf 'unrelated\n' > "$cursor_home/.local/bin/agent"
set +e
HOME="$cursor_home" PATH="/usr/bin:/bin" ZEUZ_LOCAL_PREFIX="$cursor_home/.local" \
  COMPONENT="cursor" LABEL="Cursor Agent CLI" URL="https://cursor.com/install" \
  bash -c '
    set -Eeuo pipefail
    ZEUZ_INSTALLER_TESTING=1 source scripts/install.sh
    install_remote_cli "$COMPONENT" cursor-agent "$LABEL" "$URL"
  ' > "$TMP_ROOT/cursor-collision.out" 2>&1
cursor_collision_status=$?
set -e
[ "$cursor_collision_status" -ne 0 ] || fail "Cursor auxiliary path collision was accepted"
grep -Fq "not a recognized Cursor-owned link" "$TMP_ROOT/cursor-collision.out" || fail "Cursor collision error is not actionable"
pass "Cursor auxiliary alias clobber protection"

export ZEUZ_INSTALLER_SECRET_TEST="must-not-reach-child"
run_clean /bin/sh -c '
  test -z "${ZEUZ_INSTALLER_SECRET_TEST:-}"
  test "${NPM_CONFIG_REGISTRY:-}" = "https://registry.npmjs.org/"
  test "${NPM_CONFIG_USERCONFIG:-}" = "/dev/null"
' || fail "clean subprocess environment strips unrelated secrets"
unset ZEUZ_INSTALLER_SECRET_TEST
pass "subprocess environment sanitization"

mock_bin="$TMP_ROOT/mock-bin"
mock_home="$TMP_ROOT/home"
mkdir -p "$mock_bin" "$mock_home"

make_mock() {
  local name="$1" version="$2"
  printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$version" > "$mock_bin/$name"
  chmod +x "$mock_bin/$name"
}

make_mock node "v24.18.0"
make_mock pnpm "11.13.0"
make_mock codex "codex-cli 0.144.4"
make_mock cursor-agent "2026.07.09-a3815c0"
make_mock claude "2.1.210 (Claude Code)"
make_mock copilot "GitHub Copilot CLI 1.0.70"
make_mock agy "1.1.2"
make_mock zeuz "0.1.0"

HOME="$mock_home" PATH="$mock_bin:/usr/bin:/bin" ZEUZ_LOCAL_PREFIX="$mock_home/.local" \
  "$INSTALLER" --check > "$TMP_ROOT/check.out"
grep -Fq "All required executables are installed" "$TMP_ROOT/check.out" || fail "check mode reports success"
[ ! -e "$mock_home/.zprofile" ] || fail "check mode wrote a shell profile"
pass "check mode is read-only"

dry_home="$TMP_ROOT/dry-home"
mkdir -p "$dry_home"
HOME="$dry_home" PATH="/usr/bin:/bin" SHELL="/bin/zsh" ZEUZ_TEST_OS="Darwin" \
  ZEUZ_LOCAL_PREFIX="$dry_home/.local" ZEUZ_WORKSPACE_LINK="$dry_home/agents" \
  "$INSTALLER" --dry-run --yes > "$TMP_ROOT/dry-run.out"
grep -Fq "Dry run complete" "$TMP_ROOT/dry-run.out" || fail "dry run completed"
[ ! -e "$dry_home/.zprofile" ] || fail "dry run wrote a shell profile"
[ ! -e "$dry_home/.local" ] || fail "dry run created install paths"
[ ! -e "$dry_home/agents" ] || fail "dry run created workspace link"
pass "dry run performs no writes"

set +e
"$INSTALLER" --not-a-real-option > "$TMP_ROOT/unknown.out" 2>&1
unknown_status=$?
set -e
[ "$unknown_status" -eq 2 ] || fail "unknown option exits with status 2"
grep -Fq "Usage:" "$TMP_ROOT/unknown.out" || fail "unknown option prints usage"
pass "unknown option has beginner-safe help and exit status"

uninstall_home="$TMP_ROOT/uninstall-home"
uninstall_prefix="$uninstall_home/.local"
mkdir -p "$uninstall_prefix/bin"
ln -s "$REPO_ROOT/bin/zeuz" "$uninstall_prefix/bin/zeuz"
foreign_target="$uninstall_home/foreign-agent"
printf 'keep\n' > "$foreign_target"
ln -s "$foreign_target" "$uninstall_prefix/bin/agents"

HOME="$uninstall_home" ZEUZ_LOCAL_PREFIX="$uninstall_prefix" ZEUZ_WORKSPACE_LINK="$uninstall_home/agents" \
  "$REPO_ROOT/scripts/uninstall.sh" --dry-run --yes > "$TMP_ROOT/uninstall-dry.out"
[ -L "$uninstall_prefix/bin/zeuz" ] || fail "uninstall dry run removed owned link"
[ -L "$uninstall_prefix/bin/agents" ] || fail "uninstall dry run removed foreign link"

HOME="$uninstall_home" ZEUZ_LOCAL_PREFIX="$uninstall_prefix" ZEUZ_WORKSPACE_LINK="$uninstall_home/agents" \
  "$REPO_ROOT/scripts/uninstall.sh" --yes > "$TMP_ROOT/uninstall.out"
[ ! -e "$uninstall_prefix/bin/zeuz" ] && [ ! -L "$uninstall_prefix/bin/zeuz" ] || fail "uninstaller kept owned ZeuZ link"
[ -L "$uninstall_prefix/bin/agents" ] || fail "uninstaller removed foreign link"

ln -s "$REPO_ROOT" "$uninstall_home/agents"
HOME="$uninstall_home" ZEUZ_LOCAL_PREFIX="$uninstall_prefix" ZEUZ_WORKSPACE_LINK="$uninstall_home/agents" \
  "$REPO_ROOT/scripts/uninstall.sh" --remove-workspace-link --yes > "$TMP_ROOT/uninstall-workspace.out"
[ ! -e "$uninstall_home/agents" ] && [ ! -L "$uninstall_home/agents" ] || fail "owned workspace symlink was not removed"

mkdir "$uninstall_home/agents"
HOME="$uninstall_home" ZEUZ_LOCAL_PREFIX="$uninstall_prefix" ZEUZ_WORKSPACE_LINK="$uninstall_home/agents" \
  "$REPO_ROOT/scripts/uninstall.sh" --remove-workspace-link --yes > "$TMP_ROOT/uninstall-directory.out"
[ -d "$uninstall_home/agents" ] || fail "uninstaller removed a workspace directory"
pass "uninstaller removes only owned links"

bash -n "$INSTALLER" "$REPO_ROOT/scripts/uninstall.sh"
pass "installer scripts parse with bash"
