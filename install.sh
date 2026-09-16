#!/bin/sh
# Sarma installer/updater (Linux & macOS).
#
#   curl -fsSL https://raw.githubusercontent.com/Captain-AI-Hub/Sarma/main/install.sh | sh
#
# Pin a version:  sh install.sh v0.2.0        (or: SARMA_VERSION=v0.2.0)
# Uninstall:      sh install.sh uninstall
#
# What it does: installs Bun if missing, downloads the latest tagged source
# (falling back to main when the tag predates the build script), compiles the
# standalone binary, and installs it to ~/.local/bin. Re-running updates.
set -eu

REPO="Captain-AI-Hub/Sarma"
SRC_DIR="${SARMA_SRC_DIR:-$HOME/.local/share/sarma}"
BIN_DIR="${SARMA_BIN_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

uninstall() {
  log "Removing Sarma"
  rm -f "$BIN_DIR/sarma"
  rm -rf "$SRC_DIR"
  log "Done. Config under ~/.sarma was left untouched."
  exit 0
}

[ "${1:-}" = "uninstall" ] && uninstall

# ---------------------------------------------------------------- version ---
VERSION="${1:-${SARMA_VERSION:-}}"
if [ -z "$VERSION" ]; then
  # Prefer git ls-remote (no rate limits, semver-sorted); fall back to the
  # GitHub API, then main.
  if command -v git >/dev/null 2>&1; then
    VERSION=$(git ls-remote --tags --refs --sort=-v:refname \
      "https://github.com/$REPO.git" 'v*' 2>/dev/null \
      | head -n 1 | sed 's|.*refs/tags/||') || VERSION=""
  fi
  if [ -z "$VERSION" ]; then
    VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/tags" 2>/dev/null \
      | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' | head -n 1) || VERSION=""
  fi
  [ -n "$VERSION" ] || VERSION="main"
fi

archive_url() {
  case "$1" in
    main) echo "https://github.com/$REPO/archive/refs/heads/main.tar.gz" ;;
    *) echo "https://github.com/$REPO/archive/refs/tags/$1.tar.gz" ;;
  esac
}

fetch_source() {
  rm -rf "$SRC_DIR"
  mkdir -p "$SRC_DIR"
  curl -fsSL "$(archive_url "$1")" | tar -xzf - -C "$SRC_DIR" --strip-components=1
}

# -------------------------------------------------------------------- bun ---
if ! command -v bun >/dev/null 2>&1; then
  log "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 \
  || die "Bun is installed but not on PATH. Open a new terminal and re-run."

# ------------------------------------------------------------------ source ---
log "Downloading Sarma $VERSION"
fetch_source "$VERSION"
# Tags cut before the standalone build existed (pre-0.2.1) cannot be compiled.
if [ ! -f "$SRC_DIR/scripts/build.ts" ]; then
  log "Tag $VERSION has no build script; falling back to main"
  VERSION="main"
  fetch_source "$VERSION"
fi

# ------------------------------------------------------------------- build ---
log "Installing dependencies"
(cd "$SRC_DIR" && bun install)

log "Compiling standalone binary"
(cd "$SRC_DIR" && bun run build)
[ -f "$SRC_DIR/dist/sarma" ] || die "build did not produce dist/sarma"

# ----------------------------------------------------------------- install ---
log "Installing to $BIN_DIR/sarma"
mkdir -p "$BIN_DIR"
cp "$SRC_DIR/dist/sarma" "$BIN_DIR/sarma"
chmod +x "$BIN_DIR/sarma"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    PROFILE="$HOME/.profile"
    case "$SHELL" in
      *zsh*) [ -f "$HOME/.zshrc" ] && PROFILE="$HOME/.zshrc" ;;
    esac
    printf '\n# added by Sarma installer\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >>"$PROFILE"
    log "Added $BIN_DIR to PATH via $PROFILE"
    log "Restart your shell, or run: export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

log "Installed Sarma $("$BIN_DIR/sarma" --version)"
