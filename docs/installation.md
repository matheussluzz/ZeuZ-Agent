# Installation

ZeuZ-Agent is macOS-first today. The beginner installer sets up a user-local
Node.js 24 LTS runtime when needed, pnpm, the supported provider CLIs, the ZeuZ
build, and the `zeuz`/`agents` executables. It does **not** log in to providers,
buy subscriptions, request API keys, or imply that a particular model is
included in your account.

## Beginner setup on macOS

After downloading and extracting the GitHub ZIP, a beginner can double-click `install.command` in Finder. The same audited flow is available in Terminal:

Open Terminal, then clone the public repository into the stable ZeuZ path:

```bash
git clone https://github.com/matheussluzz/ZeuZ-Agent.git ~/agents
cd ~/agents
./scripts/install.sh
```

The installer is interactive by default. Before executing a vendor's remote
installer, it downloads it to a temporary file, validates the final domain,
prints the requested URL, resolved origin, SHA-256, size, and a source preview,
then asks for confirmation. It never uses `curl ... | sh`.

For an unattended setup after reviewing this repository and the displayed
sources:

```bash
./scripts/install.sh --dry-run
./scripts/install.sh --yes
```

`--yes` is explicit confirmation of each displayed action. It is not a way to
hide the remote source information. The installer uses `~/.local` and does not
need `sudo`. If the repository was cloned elsewhere and `~/agents` does not
exist, it creates a symlink; it refuses to replace an existing unrelated path.

Open a new terminal after installation:

```bash
zeuz
```

## What is installed

| Component | Installation path | Official source |
| --- | --- | --- |
| Node.js 24 LTS | Verified official tarball under `~/.local/share/zeuz/runtime` | [Node.js downloads](https://nodejs.org/en/download) |
| pnpm | `pnpm@latest-11` through npm, prefix `~/.local` | [pnpm installation](https://pnpm.io/installation) |
| OpenAI Codex CLI | Downloaded official standalone installer | [Codex CLI](https://developers.openai.com/codex/cli/) |
| Cursor Agent CLI | Downloaded official standalone installer | [Cursor CLI installation](https://docs.cursor.com/en/cli/installation) |
| Claude Code | Downloaded official native installer | [Claude Code installation](https://code.claude.com/docs/en/installation) |
| GitHub Copilot CLI | `@github/copilot` through npm, prefix `~/.local` | [GitHub Copilot CLI installation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli) |
| Google Antigravity CLI | Downloaded official `agy` installer | [Antigravity CLI getting started](https://antigravity.google/docs/cli-getting-started) |
| ZeuZ-Agent | Built from the checked-out lockfile; links in `~/.local/bin` | This repository |

ZeuZ requires Claude Code `2.1.170` or newer before it marks the Fable fallback
route as installation-healthy. An older but runnable `claude` executable is
updated rather than silently accepted.

The local Node archive is accepted only when its SHA-256 matches the current
official `SHASUMS256.txt`. Package and vendor installers run with a sanitized
environment that excludes API keys, tokens, user npm configuration, and the
rest of the caller's environment. npm is pinned to the public registry for
these public packages. Basic proxy and CA settings are not forwarded by
default because proxy URLs can contain credentials. On a trusted corporate
network, opt in deliberately with `ZEUZ_FORWARD_NETWORK_ENV=1` after reviewing
those values and the downloaded vendor source.

NVIDIA models do not require a separate NVIDIA CLI. ZeuZ talks to the configured
NVIDIA endpoints using the ignored local `lamine.yaml`; follow the credential
instructions in the main README and never paste keys into the installer.

## Validate the installation

This check is local and does not consume model quota:

```bash
./scripts/install.sh --check
```

It validates executable presence and versions only. It deliberately does not
claim that authentication, subscription, organizational policy, quota, or a
specific model entitlement works.

After logging in, ZeuZ can run real provider checks:

```bash
zeuz health
zeuz health --deep
```

`--deep` can make real provider requests and consume quota.

## Login is a separate step

Run only the providers for which you have an account or subscription:

```bash
codex          # choose an available OpenAI/ChatGPT sign-in method
cursor-agent   # follow Cursor's browser authentication flow
claude         # requires an eligible Claude/Console or supported cloud account
copilot login  # requires a Copilot plan and allowed organization policy
agy            # choose Google OAuth or a Google Cloud project
```

Provider availability changes independently of ZeuZ. A CLI can be installed
correctly while login or model access is unavailable. ZeuZ must report that
degraded state rather than treating installation as proof of entitlement.

## Existing installations and idempotency

Healthy existing Node/pnpm/provider commands are preserved. Re-running the
installer skips them and rebuilds/relinks ZeuZ. A broken file already occupying
a managed command path is not overwritten automatically; inspect and remove or
repair it deliberately, then run the installer again.

Vendor installers can manage auxiliary paths in addition to their documented
main command. Cursor's current official installer also replaces
`~/.local/bin/agent`; ZeuZ refuses to execute it when that path exists and is
not a recognized Cursor-owned symlink. Other confirmed vendor actions remain
visible in the downloaded source preview and require execution confirmation.

The installer adds one marked block to the appropriate shell profile:

```text
# >>> ZeuZ-Agent PATH >>>
export PATH="$HOME/.local/bin:$PATH"
# <<< ZeuZ-Agent PATH <<<
```

The marker makes the PATH edit idempotent and auditable.

## Uninstall ZeuZ

Preview and remove only the ZeuZ executable links:

```bash
./scripts/uninstall.sh --dry-run --yes
./scripts/uninstall.sh
```

To also remove `~/agents` when, and only when, it is a symlink to this exact
repository:

```bash
./scripts/uninstall.sh --remove-workspace-link
```

The uninstaller intentionally preserves the repository, provider CLIs, Node,
pnpm, provider logins, `~/.agents`, `lamine.yaml`, local profiles, and vault
content. Remove vendor CLIs through their official uninstall procedures if you
no longer use them.

## Linux and Windows status

The provider vendors publish Linux and/or Windows installation methods in the
official links above, but ZeuZ's combined automatic installer has not yet been
implemented or verified end-to-end on those platforms. On Linux or Windows,
install Node.js 24+, pnpm, and each provider CLI from those official pages, then
run from this repository:

```bash
pnpm install --frozen-lockfile
pnpm build
node bin/zeuz --version
```

Do not present that manual path as a tested one-click installer until it has
platform-specific CI and a real smoke test.
