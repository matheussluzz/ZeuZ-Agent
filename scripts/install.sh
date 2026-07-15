#!/usr/bin/env bash

# ZeuZ-Agent beginner installer (macOS-first).
# Remote vendor installers are downloaded, provenance-checked, previewed, and
# confirmed before execution. They are never piped directly into a shell.

set -Eeuo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)"

LOCAL_PREFIX="${ZEUZ_LOCAL_PREFIX:-$HOME/.local}"
LOCAL_BIN="$LOCAL_PREFIX/bin"
RUNTIME_ROOT="${ZEUZ_RUNTIME_ROOT:-$LOCAL_PREFIX/share/zeuz/runtime}"
WORKSPACE_LINK="${ZEUZ_WORKSPACE_LINK:-$HOME/agents}"
NODE_CHANNEL="${ZEUZ_NODE_CHANNEL:-latest-v24.x}"
PNPM_SPEC="${ZEUZ_PNPM_SPEC:-pnpm@latest-11}"
FORWARD_NETWORK_ENV="${ZEUZ_FORWARD_NETWORK_ENV:-0}"

CHECK_ONLY=0
DRY_RUN=0
ASSUME_YES=0
FAILED_COMPONENTS=""

info() { printf '\033[1;34m[info]\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; return 1; }

usage() {
  cat <<'EOF'
ZeuZ-Agent installer

Usage:
  ./scripts/install.sh             Interactive installation
  ./scripts/install.sh --yes       Confirm all displayed installation actions
  ./scripts/install.sh --dry-run   Show the plan without downloads or writes
  ./scripts/install.sh --check     Check binaries and versions without writes

Options:
  --yes, -y       Non-interactive confirmation. Remote sources are still shown.
  --dry-run       Do not download, install, link, or edit shell profiles.
  --check         Report installation health only. Does not test account login.
  --help, -h      Show this help.

Environment overrides (advanced):
  ZEUZ_LOCAL_PREFIX   User-local prefix (default: ~/.local)
  ZEUZ_WORKSPACE_LINK Stable ZeuZ repository path (default: ~/agents)
  ZEUZ_NODE_CHANNEL   Node 24 release channel (default: latest-v24.x)
  ZEUZ_PNPM_SPEC      pnpm npm spec (default: pnpm@latest-11)
  ZEUZ_FORWARD_NETWORK_ENV=1
                      Forward proxy/CA settings to installers (off by default)
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --check) CHECK_ONLY=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --help|-h) usage; exit 0 ;;
      *)
        printf '\033[1;31m[error]\033[0m Unknown option: %s\n\n' "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

confirm() {
  local prompt="$1" reply
  if [ "$ASSUME_YES" -eq 1 ]; then
    info "--yes supplied: confirmed — $prompt"
    return 0
  fi
  if [ ! -t 0 ]; then
    fail "Confirmation required in a non-interactive shell. Re-run with --yes after reviewing the plan."
    return 1
  fi
  printf '%s [y/N] ' "$prompt" >/dev/tty
  IFS= read -r reply </dev/tty || true
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

major_version() {
  local value="${1#v}"
  value="${value%%[^0-9.]*}"
  printf '%s\n' "${value%%.*}"
}

tool_version() {
  local command_name="$1" output
  command -v "$command_name" >/dev/null 2>&1 || return 1
  output=$("$command_name" --version 2>&1) || return 1
  printf '%s\n' "$output" | sed -n '1p'
}

node_is_compatible() {
  local output major
  output=$(tool_version node) || return 1
  major=$(major_version "$output")
  [ -n "$major" ] && [ "$major" -ge 24 ]
}

pnpm_is_compatible() {
  local output major
  output=$(tool_version pnpm) || return 1
  major=$(major_version "$output")
  [ -n "$major" ] && [ "$major" -ge 10 ]
}

tool_works() {
  tool_version "$1" >/dev/null 2>&1
}

semver_from_text() {
  printf '%s\n' "$1" | sed -E 's/^[^0-9]*([0-9]+[.][0-9]+[.][0-9]+).*$/\1/'
}

semver_at_least() {
  local actual required actual_major actual_minor actual_patch required_major required_minor required_patch
  actual=$(semver_from_text "$1")
  required=$(semver_from_text "$2")
  IFS=. read -r actual_major actual_minor actual_patch <<< "$actual"
  IFS=. read -r required_major required_minor required_patch <<< "$required"
  [ -n "${actual_patch:-}" ] && [ -n "${required_patch:-}" ] || return 1
  [ "$actual_major" -gt "$required_major" ] && return 0
  [ "$actual_major" -lt "$required_major" ] && return 1
  [ "$actual_minor" -gt "$required_minor" ] && return 0
  [ "$actual_minor" -lt "$required_minor" ] && return 1
  [ "$actual_patch" -ge "$required_patch" ]
}

claude_supports_fable() {
  local version
  version=$(tool_version claude) || return 1
  semver_at_least "$version" "2.1.170"
}

component_is_healthy() {
  local component="$1" command_name="$2"
  if [ "$component" = "claude" ]; then claude_supports_fable; else tool_works "$command_name"; fi
}

safe_path() {
  local result="$LOCAL_BIN:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local command_name command_path command_dir
  for command_name in node npm pnpm; do
    command_path=$(command -v "$command_name" 2>/dev/null || true)
    [ -n "$command_path" ] || continue
    command_dir=$(dirname -- "$command_path")
    case ":$result:" in *":$command_dir:"*) ;; *) result="$command_dir:$result" ;; esac
  done
  printf '%s\n' "$result"
}

run_clean() {
  local clean_path
  local -a env_args
  clean_path=$(safe_path)
  env_args=(
    env -i
    "HOME=$HOME"
    "USER=${USER:-$(id -un)}"
    "LOGNAME=${LOGNAME:-${USER:-$(id -un)}}"
    "PATH=$clean_path"
    "SHELL=${SHELL:-/bin/bash}"
    "TERM=${TERM:-xterm-256color}"
    "LANG=${LANG:-C.UTF-8}"
    "NPM_CONFIG_REGISTRY=https://registry.npmjs.org/"
    "NPM_CONFIG_USERCONFIG=/dev/null"
    "NPM_CONFIG_GLOBALCONFIG=/dev/null"
  )
  [ -z "${TMPDIR:-}" ] || env_args+=("TMPDIR=$TMPDIR")
  if [ "$FORWARD_NETWORK_ENV" = "1" ]; then
    [ -z "${HTTPS_PROXY:-}" ] || env_args+=("HTTPS_PROXY=$HTTPS_PROXY")
    [ -z "${HTTP_PROXY:-}" ] || env_args+=("HTTP_PROXY=$HTTP_PROXY")
    [ -z "${NO_PROXY:-}" ] || env_args+=("NO_PROXY=$NO_PROXY")
    [ -z "${SSL_CERT_FILE:-}" ] || env_args+=("SSL_CERT_FILE=$SSL_CERT_FILE")
    [ -z "${NODE_EXTRA_CA_CERTS:-}" ] || env_args+=("NODE_EXTRA_CA_CERTS=$NODE_EXTRA_CA_CERTS")
  fi
  "${env_args[@]}" "$@"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "Neither shasum nor sha256sum is available."
  fi
}

url_origin() {
  printf '%s\n' "$1" | sed -E 's#^(https://[^/]+).*$#\1#'
}

allowed_resolved_url() {
  local component="$1" url="$2"
  case "$component:$url" in
    codex:https://github.com/*|codex:https://release-assets.githubusercontent.com/*) return 0 ;;
    cursor:https://cursor.com/*) return 0 ;;
    claude:https://downloads.claude.ai/*|claude:https://claude.ai/*) return 0 ;;
    agy:https://antigravity.google/*) return 0 ;;
    *) return 1 ;;
  esac
}

download_review_and_run() {
  local component="$1" label="$2" requested_url="$3"
  local temp_dir script_path resolved_url size checksum

  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would download and review $label from $requested_url"
    return 0
  fi

  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/zeuz-installer.XXXXXX")
  script_path="$temp_dir/$component-installer.sh"
  trap 'rm -rf "${temp_dir:-}"' RETURN

  resolved_url=$(curl --fail --silent --show-error --location \
    --proto '=https' --tlsv1.2 --output "$script_path" \
    --write-out '%{url_effective}' "$requested_url")

  if ! allowed_resolved_url "$component" "$resolved_url"; then
    fail "$label redirected to an unapproved origin: $(url_origin "$resolved_url")"
    return 1
  fi
  size=$(wc -c < "$script_path" | tr -d ' ')
  if [ "$size" -lt 100 ] || [ "$size" -gt 1048576 ]; then
    fail "$label installer has an unexpected size: $size bytes"
    return 1
  fi
  if ! sed -n '1p' "$script_path" | grep -Eq '^#!.*(sh|bash)'; then
    fail "$label installer does not begin with a shell shebang."
    return 1
  fi
  checksum=$(sha256_file "$script_path")

  printf '\nRemote installer review\n'
  printf '  Provider:       %s\n' "$label"
  printf '  Requested URL:  %s\n' "$requested_url"
  printf '  Resolved origin:%s\n' " $(url_origin "$resolved_url")"
  printf '  SHA-256:        %s\n' "$checksum"
  printf '  Size:           %s bytes\n' "$size"
  printf '  Local copy:     %s\n' "$script_path"
  printf '  Source preview (first 24 lines):\n'
  sed -n '1,24p' "$script_path" | sed 's/^/    /'
  printf '\n'

  if ! confirm "Execute the downloaded $label installer?"; then
    warn "$label installation skipped by user."
    return 2
  fi

  run_clean /bin/bash "$script_path"
  rm -rf "$temp_dir"
  trap - RETURN
}

ensure_profile_path() {
  local profile marker_start marker_end
  case "${SHELL:-}" in
    */zsh) profile="$HOME/.zprofile" ;;
    */bash) profile="$HOME/.bash_profile" ;;
    *) profile="$HOME/.profile" ;;
  esac
  marker_start="# >>> ZeuZ-Agent PATH >>>"
  marker_end="# <<< ZeuZ-Agent PATH <<<"

  if [ -f "$profile" ] && grep -Fq "$marker_start" "$profile"; then
    ok "PATH marker already present in $profile"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would add $LOCAL_BIN to PATH in $profile"
    return 0
  fi
  mkdir -p "$(dirname -- "$profile")"
  {
    printf '\n%s\n' "$marker_start"
    if [ "$LOCAL_BIN" = "$HOME/.local/bin" ]; then
      printf 'export PATH="$HOME/.local/bin:$PATH"\n'
    else
      printf 'export PATH="%s:$PATH"\n' "$LOCAL_BIN"
    fi
    printf '%s\n' "$marker_end"
  } >> "$profile"
  ok "Added $LOCAL_BIN to PATH in $profile"
}

assert_link_destination_available() {
  local path="$1" owned_prefix="$2"
  [ ! -e "$path" ] && [ ! -L "$path" ] && return 0
  if [ -L "$path" ]; then
    local target
    target=$(readlink "$path")
    case "$target" in "$owned_prefix"*) return 0 ;; esac
  fi
  fail "Refusing to replace an unrelated path: $path"
}

install_node() {
  local architecture archive_name sums_url archive_url temp_dir sums_path archive_path
  local checksum_line expected actual top_level install_dir current_link binary

  if node_is_compatible; then
    ok "Node.js $(tool_version node) is compatible (24+)."
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would install the latest Node.js 24 LTS runtime from https://nodejs.org/dist/$NODE_CHANNEL/"
    return 0
  fi
  [ "$(uname -s)" = "Darwin" ] || { fail "Automatic Node installation currently supports macOS only."; return 1; }
  case "$(uname -m)" in
    arm64) architecture="arm64" ;;
    x86_64) architecture="x64" ;;
    *) fail "Unsupported macOS architecture: $(uname -m)"; return 1 ;;
  esac

  sums_url="https://nodejs.org/dist/$NODE_CHANNEL/SHASUMS256.txt"
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/zeuz-node.XXXXXX")
  trap 'rm -rf "${temp_dir:-}"' RETURN
  sums_path="$temp_dir/SHASUMS256.txt"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$sums_path" "$sums_url"
  checksum_line=$(grep -E " node-v[0-9]+([.][0-9]+)+-darwin-${architecture}[.]tar[.]gz$" "$sums_path" | tail -n 1 || true)
  [ -n "$checksum_line" ] || { fail "Could not resolve a Node 24 archive for darwin-$architecture."; return 1; }
  expected=${checksum_line%% *}
  archive_name=${checksum_line##* }
  archive_url="https://nodejs.org/dist/$NODE_CHANNEL/$archive_name"
  archive_path="$temp_dir/$archive_name"

  info "Node source: $archive_url"
  info "Expected SHA-256: $expected"
  confirm "Download and install Node.js 24 for the current user?" || { warn "Node installation cancelled."; return 2; }
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --output "$archive_path" "$archive_url"
  actual=$(sha256_file "$archive_path")
  [ "$actual" = "$expected" ] || { fail "Node archive checksum mismatch."; return 1; }

  top_level=${archive_name%.tar.gz}
  if ! tar -tzf "$archive_path" | awk -v prefix="$top_level/" 'index($0, prefix) == 1 { next } { exit 1 }'; then
    fail "Node archive contains an unexpected path."
    return 1
  fi
  mkdir -p "$RUNTIME_ROOT"
  tar -xzf "$archive_path" -C "$temp_dir"
  install_dir="$RUNTIME_ROOT/$top_level"
  if [ ! -d "$install_dir" ]; then mv "$temp_dir/$top_level" "$install_dir"; fi
  current_link="$RUNTIME_ROOT/current"
  ln -sfn "$install_dir" "$current_link"
  mkdir -p "$LOCAL_BIN"
  for binary in node npm npx corepack; do
    [ -e "$current_link/bin/$binary" ] || continue
    assert_link_destination_available "$LOCAL_BIN/$binary" "$RUNTIME_ROOT/" || return 1
    ln -sfn "$current_link/bin/$binary" "$LOCAL_BIN/$binary"
  done
  export PATH="$LOCAL_BIN:$PATH"
  node_is_compatible || { fail "Node installation finished but Node 24+ is not runnable."; return 1; }
  ok "Installed Node.js $(tool_version node) with verified SHA-256."
  rm -rf "$temp_dir"
  trap - RETURN
}

install_pnpm() {
  local npm_bin
  if pnpm_is_compatible; then
    ok "pnpm $(tool_version pnpm) is compatible."
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would install $PNPM_SPEC from npm into $LOCAL_PREFIX"
    return 0
  fi
  npm_bin=$(command -v npm 2>/dev/null || true)
  [ -n "$npm_bin" ] || { fail "npm is unavailable after Node installation."; return 1; }
  if [ -e "$LOCAL_BIN/pnpm" ] || [ -L "$LOCAL_BIN/pnpm" ]; then
    fail "A non-working pnpm path already exists at $LOCAL_BIN/pnpm; inspect it before retrying."
    return 1
  fi
  info "Installing $PNPM_SPEC from the public npm registry into $LOCAL_PREFIX"
  run_clean "$npm_bin" install --global --prefix "$LOCAL_PREFIX" "$PNPM_SPEC"
  export PATH="$LOCAL_BIN:$PATH"
  pnpm_is_compatible || { fail "pnpm installation completed but pnpm 10+ is not runnable."; return 1; }
  ok "Installed pnpm $(tool_version pnpm)."
}

install_npm_cli() {
  local command_name="$1" label="$2" package_spec="$3" npm_bin
  if tool_works "$command_name"; then
    ok "$label is already installed: $(tool_version "$command_name")"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would install $label from npm package $package_spec"
    return 0
  fi
  npm_bin=$(command -v npm 2>/dev/null || true)
  [ -n "$npm_bin" ] || { fail "npm is required to install $label."; return 1; }
  if [ -e "$LOCAL_BIN/$command_name" ] || [ -L "$LOCAL_BIN/$command_name" ]; then
    fail "A non-working path already exists at $LOCAL_BIN/$command_name; inspect it before retrying."
    return 1
  fi
  info "Installing $label from public npm package $package_spec"
  run_clean "$npm_bin" install --global --prefix "$LOCAL_PREFIX" "$package_spec"
  export PATH="$LOCAL_BIN:$PATH"
  tool_works "$command_name" || { fail "$label installed but $command_name --version failed."; return 1; }
  ok "Installed $label: $(tool_version "$command_name")"
}

install_remote_cli() {
  local component="$1" command_name="$2" label="$3" url="$4"
  if component_is_healthy "$component" "$command_name"; then
    ok "$label is already installed: $(tool_version "$command_name")"
    return 0
  fi
  if [ "$component" = "claude" ] && tool_works claude; then
    # A runnable, outdated Claude binary is the vendor-owned update target, not
    # an unrelated path collision. The reviewed official installer upgrades it.
    warn "Claude Code $(tool_version claude) is below 2.1.170, the minimum required for the Fable route; updating it."
  elif [ "$DRY_RUN" -eq 0 ] && { [ -e "$LOCAL_BIN/$command_name" ] || [ -L "$LOCAL_BIN/$command_name" ]; }; then
    fail "A non-working path already exists at $LOCAL_BIN/$command_name; inspect it before retrying."
    return 1
  fi
  if [ "$component" = "cursor" ] && [ "$DRY_RUN" -eq 0 ]; then
    local cursor_alias="$HOME/.local/bin/agent" cursor_alias_target
    if [ -e "$cursor_alias" ] || [ -L "$cursor_alias" ]; then
      cursor_alias_target=$(readlink "$cursor_alias" 2>/dev/null || true)
      case "$cursor_alias_target" in
        "$HOME/.local/share/cursor-agent/versions/"*/cursor-agent) ;;
        *) fail "Cursor's vendor installer replaces $cursor_alias; refusing because it is not a recognized Cursor-owned link."; return 1 ;;
      esac
    fi
  fi
  download_review_and_run "$component" "$label" "$url" || return $?
  [ "$DRY_RUN" -eq 1 ] && return 0
  export PATH="$LOCAL_BIN:$HOME/.local/bin:$PATH"
  component_is_healthy "$component" "$command_name" || {
    if [ "$component" = "claude" ] && tool_works claude; then
      fail "Claude Code installed, but $(tool_version claude) is still below the Fable minimum 2.1.170."
    else
      fail "$label installer exited, but $command_name --version failed."
    fi
    return 1
  }
  ok "Installed $label: $(tool_version "$command_name")"
}

ensure_workspace_link() {
  local existing_real
  if [ -e "$WORKSPACE_LINK" ] || [ -L "$WORKSPACE_LINK" ]; then
    existing_real=$(CDPATH= cd -- "$WORKSPACE_LINK" 2>/dev/null && pwd -P || true)
    [ "$existing_real" = "$REPO_ROOT" ] || { fail "$WORKSPACE_LINK already exists and is not this repository."; return 1; }
    ok "Workspace path is ready: $WORKSPACE_LINK"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would link $WORKSPACE_LINK -> $REPO_ROOT"
    return 0
  fi
  ln -s "$REPO_ROOT" "$WORKSPACE_LINK"
  ok "Linked $WORKSPACE_LINK -> $REPO_ROOT"
}

install_zeuz() {
  local pnpm_bin command_path
  if [ "$DRY_RUN" -eq 1 ]; then
    info "Would install dependencies, build ZeuZ-Agent, and link zeuz/agents into $LOCAL_BIN"
    ensure_workspace_link
    return 0
  fi
  pnpm_bin=$(command -v pnpm 2>/dev/null || true)
  [ -n "$pnpm_bin" ] || { fail "pnpm is unavailable."; return 1; }
  info "Installing locked ZeuZ dependencies and building the CLI."
  (cd "$REPO_ROOT" && run_clean "$pnpm_bin" install --frozen-lockfile)
  (cd "$REPO_ROOT" && run_clean "$pnpm_bin" build)
  ensure_workspace_link
  mkdir -p "$LOCAL_BIN"
  assert_link_destination_available "$LOCAL_BIN/zeuz" "$WORKSPACE_LINK/" || return 1
  assert_link_destination_available "$LOCAL_BIN/agents" "$WORKSPACE_LINK/" || return 1
  ln -sfn "$WORKSPACE_LINK/bin/zeuz" "$LOCAL_BIN/zeuz"
  ln -sfn "$WORKSPACE_LINK/bin/agents" "$LOCAL_BIN/agents"
  export PATH="$LOCAL_BIN:$PATH"
  tool_works zeuz || { fail "ZeuZ was built, but zeuz --version failed."; return 1; }
  ok "ZeuZ-Agent $(tool_version zeuz) is available as 'zeuz' and 'agents'."
}

record_failure() {
  local component="$1"
  FAILED_COMPONENTS="${FAILED_COMPONENTS}${FAILED_COMPONENTS:+, }$component"
}

probe() {
  local label="$1" command_name="$2" version
  if version=$(tool_version "$command_name"); then
    printf '\033[1;32m[ok]\033[0m %-18s %s (%s)\n' "$label" "$version" "$(command -v "$command_name")"
    return 0
  fi
  printf '\033[1;31m[missing]\033[0m %-13s command %s is unavailable or broken\n' "$label" "$command_name"
  return 1
}

run_check() {
  local missing=0
  printf 'ZeuZ-Agent installation check\n\n'
  if node_is_compatible; then
    probe "Node.js 24+" node || true
  else
    warn "Node.js 24+ is missing or too old."
    missing=$((missing + 1))
  fi
  if pnpm_is_compatible; then probe "pnpm 10+" pnpm || true; else warn "pnpm 10+ is missing or too old."; missing=$((missing + 1)); fi
  probe "OpenAI Codex" codex || missing=$((missing + 1))
  probe "Cursor Agent" cursor-agent || missing=$((missing + 1))
  if claude_supports_fable; then
    probe "Claude Code" claude || true
  else
    if tool_works claude; then
      printf '\033[1;33m[outdated]\033[0m %-12s %s (%s); Fable requires >=2.1.170\n' \
        "Claude Code" "$(tool_version claude)" "$(command -v claude)" >&2
    else
      warn "Claude Code is missing or broken."
    fi
    missing=$((missing + 1))
  fi
  probe "GitHub Copilot" copilot || missing=$((missing + 1))
  probe "Antigravity" agy || missing=$((missing + 1))
  probe "ZeuZ-Agent" zeuz || missing=$((missing + 1))
  printf '\nThis checks installation only; it does not prove login, subscription, entitlement, quota, or model access.\n'
  if [ "$missing" -gt 0 ]; then
    warn "$missing required installation component(s) are missing or unhealthy."
    return 1
  fi
  ok "All required executables are installed. Run 'zeuz health --deep' separately for real provider checks (it may consume quota)."
}

main() {
  parse_args "$@"
  export PATH="$LOCAL_BIN:$PATH"

  if [ "$CHECK_ONLY" -eq 1 ]; then run_check; return $?; fi
  if [ "${ZEUZ_TEST_OS:-$(uname -s)}" != "Darwin" ]; then
    fail "This installer currently supports macOS. Linux/Windows commands are documented in docs/installation.md."
    return 1
  fi

  printf 'ZeuZ - Seu orquestrador de agentes\n'
  printf 'Beginner installer · macOS · user-local prefix: %s\n\n' "$LOCAL_PREFIX"
  info "Installation is separate from provider login and paid entitlement. No API keys are requested."
  info "Remote installer scripts are downloaded, origin-checked, previewed, and confirmed before execution."

  ensure_profile_path
  install_node || { record_failure "Node.js"; fail "Node.js is required; stopping."; return 1; }
  install_pnpm || { record_failure "pnpm"; fail "pnpm is required; stopping."; return 1; }

  install_remote_cli codex codex "OpenAI Codex CLI" "https://chatgpt.com/codex/install.sh" || record_failure "Codex"
  install_remote_cli cursor cursor-agent "Cursor Agent CLI" "https://cursor.com/install" || record_failure "Cursor"
  install_remote_cli claude claude "Claude Code" "https://claude.ai/install.sh" || record_failure "Claude Code"
  install_npm_cli copilot "GitHub Copilot CLI" "@github/copilot" || record_failure "GitHub Copilot"
  install_remote_cli agy agy "Google Antigravity CLI" "https://antigravity.google/cli/install.sh" || record_failure "Antigravity"
  install_zeuz || record_failure "ZeuZ-Agent"

  if [ "$DRY_RUN" -eq 1 ]; then
    ok "Dry run complete. No downloads or writes were performed."
    return 0
  fi
  if [ -n "$FAILED_COMPONENTS" ]; then
    warn "Installation finished with incomplete components: $FAILED_COMPONENTS"
    warn "Run './scripts/install.sh --check' after addressing the messages above."
    return 1
  fi

  printf '\n'
  run_check
  printf '\nNext: open a new terminal, run `zeuz`, and complete each provider login only for subscriptions you own.\n'
}

if [ "${ZEUZ_INSTALLER_TESTING:-0}" != "1" ]; then
  main "$@"
fi
