#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/browser-skill-install-test.XXXXXX")

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_equals() {
  expected=$1
  actual=$2
  cmp -s "$expected" "$actual" || fail "$actual does not match $expected"
}

make_fixture_binary() {
  destination=$1
  label=$2
  {
    echo '#!/bin/sh'
    echo "echo $label"
  } > "$destination"
  chmod 755 "$destination"
}

# --binary must stay fully offline, install an executable, and preserve user config.
fixture_binary="$TEST_ROOT/fixture-browser-skill"
make_fixture_binary "$fixture_binary" fixture-binary
binary_home="$TEST_ROOT/binary-home"
binary_install="$TEST_ROOT/binary-bin"
HOME="$binary_home" BROWSER_SKILL_INSTALL_DIR="$binary_install" \
  "$REPO_ROOT/install.sh" --binary "$fixture_binary" >/dev/null
test -x "$binary_install/browser-skill" || fail "--binary did not install an executable"
assert_file_equals "$fixture_binary" "$binary_install/browser-skill"
test -f "$binary_home/.browser-skill/config.env" || fail "default config was not installed"

printf '%s\n' 'BROWSER_SKILL_PORT=4567' > "$binary_home/.browser-skill/config.env"
preserved_config="$TEST_ROOT/preserved-config"
cp "$binary_home/.browser-skill/config.env" "$preserved_config"
HOME="$binary_home" BROWSER_SKILL_INSTALL_DIR="$binary_install" \
  "$REPO_ROOT/install.sh" --binary "$fixture_binary" >/dev/null
assert_file_equals "$preserved_config" "$binary_home/.browser-skill/config.env"

# Exercise the default release path without network access by replacing curl and uname.
release_dir="$TEST_ROOT/release"
mock_bin="$TEST_ROOT/mock-bin"
mkdir -p "$release_dir" "$mock_bin"
release_asset="$release_dir/browser-skill-linux-x86_64"
make_fixture_binary "$release_asset" fixture-release
(cd "$release_dir" && {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum browser-skill-linux-x86_64 > browser-skill-linux-x86_64.sha256
  else
    shasum -a 256 browser-skill-linux-x86_64 > browser-skill-linux-x86_64.sha256
  fi
})

cat > "$mock_bin/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  *) exit 2 ;;
esac
EOF
cat > "$mock_bin/curl" <<'EOF'
#!/bin/sh
set -eu
url=
destination=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      destination=$1
      ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
test -n "$url"
test -n "$destination"
case "$url" in
  */runtime-v9.8.7/*) ;;
  *) echo "unexpected URL: $url" >&2; exit 1 ;;
esac
cp "$BROWSER_SKILL_TEST_RELEASE_DIR/${url##*/}" "$destination"
EOF
chmod 755 "$mock_bin/uname" "$mock_bin/curl"

release_home="$TEST_ROOT/release-home"
release_install="$TEST_ROOT/release-bin"
PATH="$mock_bin:$PATH" \
HOME="$release_home" \
BROWSER_SKILL_INSTALL_DIR="$release_install" \
BROWSER_SKILL_TEST_RELEASE_DIR="$release_dir" \
BROWSER_SKILL_VERSION=9.8.7 \
  "$REPO_ROOT/install.sh" >/dev/null
assert_file_equals "$release_asset" "$release_install/browser-skill"

printf '%064d  %s\n' 0 browser-skill-linux-x86_64 \
  > "$release_dir/browser-skill-linux-x86_64.sha256"
if PATH="$mock_bin:$PATH" \
  HOME="$TEST_ROOT/checksum-home" \
  BROWSER_SKILL_INSTALL_DIR="$TEST_ROOT/checksum-bin" \
  BROWSER_SKILL_TEST_RELEASE_DIR="$release_dir" \
  BROWSER_SKILL_VERSION=9.8.7 \
  "$REPO_ROOT/install.sh" >/dev/null 2>&1; then
  fail "installer accepted a mismatched checksum"
fi

if "$REPO_ROOT/install.sh" --binary >/dev/null 2>&1; then
  fail "--binary without a path unexpectedly succeeded"
fi
if "$REPO_ROOT/install.sh" --unknown >/dev/null 2>&1; then
  fail "unknown argument unexpectedly succeeded"
fi

echo "install.sh offline tests passed"
