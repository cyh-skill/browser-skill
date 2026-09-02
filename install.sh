#!/bin/sh
set -eu

SKILL_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
USER_BASE=${HOME:?HOME is required}
INSTALL_DIR=${BROWSER_SKILL_INSTALL_DIR:-"$USER_BASE/.local/bin"}
CONFIG_DIR="$USER_BASE/.browser-skill"
RUNTIME_VERSION=${BROWSER_SKILL_VERSION:-$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$SKILL_ROOT/Cargo.toml" | head -1)}
MODE=release
LOCAL_BINARY=

usage() {
  echo "Usage: ./install.sh [--from-source | --binary PATH]"
  echo "Default: download the prebuilt runtime-v$RUNTIME_VERSION binary; Rust is not required."
}

download() {
  url=$1
  destination=$2
  if ! curl -fLSs "$url" -o "$destination"; then
    echo "Failed to download $url" >&2
    echo "The Runtime release may not exist yet; use --binary PATH or --from-source." >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from-source) MODE=source ;;
    --binary)
      shift
      [ "$#" -gt 0 ] || { echo "--binary requires a path" >&2; exit 2; }
      MODE=binary
      LOCAL_BINARY=$1
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"

if [ "$MODE" = source ]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "--from-source requires Rust stable and cargo." >&2
    exit 1
  fi
  cargo build --release --locked --manifest-path "$SKILL_ROOT/Cargo.toml"
  install -m 755 "$SKILL_ROOT/target/release/browser-skill" "$INSTALL_DIR/browser-skill"
elif [ "$MODE" = binary ]; then
  [ -f "$LOCAL_BINARY" ] || { echo "Binary not found: $LOCAL_BINARY" >&2; exit 1; }
  install -m 755 "$LOCAL_BINARY" "$INSTALL_DIR/browser-skill"
else
  [ -n "$RUNTIME_VERSION" ] || {
    echo "Unable to determine the Runtime version from Cargo.toml." >&2
    exit 1
  }
  OS=$(uname -s)
  ARCH=$(uname -m)
  case "$OS:$ARCH" in
    Darwin:arm64) ASSET=browser-skill-macos-aarch64 ;;
    Darwin:x86_64) ASSET=browser-skill-macos-x86_64 ;;
    Linux:x86_64|Linux:amd64) ASSET=browser-skill-linux-x86_64 ;;
    *) echo "No prebuilt Runtime for $OS/$ARCH; use --from-source." >&2; exit 1 ;;
  esac
  command -v curl >/dev/null 2>&1 || { echo "curl is required to download the Runtime." >&2; exit 1; }
  DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/browser-skill-install.XXXXXX")
  trap 'rm -rf "$DOWNLOAD_DIR"' EXIT HUP INT TERM
  BASE_URL="https://github.com/cyh-skill/browser-skill/releases/download/runtime-v$RUNTIME_VERSION"
  download "$BASE_URL/$ASSET" "$DOWNLOAD_DIR/$ASSET"
  download "$BASE_URL/$ASSET.sha256" "$DOWNLOAD_DIR/$ASSET.sha256"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$DOWNLOAD_DIR" && sha256sum -c "$ASSET.sha256")
  else
    (cd "$DOWNLOAD_DIR" && shasum -a 256 -c "$ASSET.sha256")
  fi
  install -m 755 "$DOWNLOAD_DIR/$ASSET" "$INSTALL_DIR/browser-skill"
fi

if [ ! -f "$CONFIG_DIR/config.env" ]; then
  install -m 600 "$SKILL_ROOT/templates/config.env.template" "$CONFIG_DIR/config.env"
fi

echo "Installed Runtime: $INSTALL_DIR/browser-skill"
echo "Local config: $CONFIG_DIR/config.env"
echo "Load extension/: chrome://extensions -> Developer mode -> Load unpacked"
