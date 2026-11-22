#!/bin/sh
# termium installer.
#
#   curl -fsSL https://raw.githubusercontent.com/alimohammed1624/termium/main/install.sh | sh
#
# Downloads the prebuilt termium binary for this machine from the latest
# GitHub release, verifies it against the release's SHA256SUMS and installs
# it into ~/.local/bin (no sudo).
#
# Options (environment variables):
#   TERMIUM_INSTALL_DIR    install directory (default: $HOME/.local/bin)
#   TERMIUM_VERSION        release tag to install, e.g. v0.2.0 (default: latest)
#   TERMIUM_TARGET         force an archive, e.g. x86_64-apple-darwin (default: detected)
#   TERMIUM_DOWNLOAD_BASE  fetch the assets from here instead of GitHub
#                          (any URL curl/wget accept, e.g. file:///path/dist;
#                          used by the release workflow's install test)
#
# Asset names (termium-<target>.tar.gz containing termium-<target>/termium):
# keep asset names and targets in sync with TERMIUM_TARGETS in scripts/lib.sh
# (used by scripts/release.sh) and .github/workflows/release.yml.
# Linux gets the glibc (-gnu) build, or the -musl one where there is no
# glibc (Alpine and friends).
#
# POSIX sh only. Everything runs from main(), called on the last line, so a
# truncated download never executes a partial script.

set -eu

REPO="alimohammed1624/termium"
SOURCE_HINT="bun install -g github:$REPO
  or run it from a clone:
    git clone https://github.com/$REPO && cd termium && bun install && bun src/main.ts"
_termium_tmp=""

say() {
    printf '%s\n' "$*"
}

warn() {
    printf 'termium-install: warning: %s\n' "$*" >&2
}

err() {
    printf 'termium-install: error: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [ -n "$_termium_tmp" ] && [ -d "$_termium_tmp" ]; then
        rm -rf "$_termium_tmp"
    fi
}

need() {
    command -v "$1" >/dev/null 2>&1 || err "'$1' is required but was not found on PATH"
}

# Prints "gnu" or "musl": the C library the Linux binary must link against.
detect_libc() {
    if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
        echo gnu
    elif ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
        echo musl
    else
        echo gnu
    fi
}

# Prints the release target triple for this machine, or exits with an error.
detect_target() {
    if [ -n "${TERMIUM_TARGET:-}" ]; then
        case "$TERMIUM_TARGET" in
            x86_64-unknown-linux-gnu | aarch64-unknown-linux-gnu | \
                x86_64-unknown-linux-musl | aarch64-unknown-linux-musl | \
                x86_64-apple-darwin | aarch64-apple-darwin)
                echo "$TERMIUM_TARGET"
                return
                ;;
            *) err "unknown TERMIUM_TARGET '$TERMIUM_TARGET'" ;;
        esac
    fi
    _os=$(uname -s 2>/dev/null || echo unknown)
    _arch=$(uname -m 2>/dev/null || echo unknown)

    case "$_os" in
        Linux)
            _libc=$(detect_libc)
            case "$_arch" in
                x86_64 | amd64) echo "x86_64-unknown-linux-$_libc"; return ;;
                aarch64 | arm64) echo "aarch64-unknown-linux-$_libc"; return ;;
            esac
            ;;
        Darwin)
            # A shell running under Rosetta reports x86_64 on Apple silicon;
            # prefer the native arm64 build there.
            if [ "$_arch" = "x86_64" ] &&
                [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
                _arch=arm64
            fi
            case "$_arch" in
                x86_64 | amd64) echo "x86_64-apple-darwin"; return ;;
                aarch64 | arm64) echo "aarch64-apple-darwin"; return ;;
            esac
            ;;
    esac

    err "no prebuilt termium binary for $_os/$_arch.
  Run it from source instead (needs Bun, https://bun.sh):
    $SOURCE_HINT"
}

# download <url> <output-file>
download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 -o "$2" "$1" || err "download failed: $1"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$2" "$1" || err "download failed: $1"
    else
        err "need curl or wget to download termium"
    fi
}

# sha256 <file>: prints the hex digest.
sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        err "need sha256sum or shasum to verify the download"
    fi
}

main() {
    need uname
    need tar
    need mktemp
    need awk
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        err "need curl or wget to download termium"
    fi
    if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
        err "need sha256sum or shasum to verify the download"
    fi

    target=$(detect_target)
    asset="termium-$target.tar.gz"

    version="${TERMIUM_VERSION:-}"
    case "$version" in
        "" | latest) version="" ;;
        v*) ;;
        *) version="v$version" ;;
    esac

    if [ -n "${TERMIUM_DOWNLOAD_BASE:-}" ]; then
        base="${TERMIUM_DOWNLOAD_BASE%/}"
    elif [ -n "$version" ]; then
        base="https://github.com/$REPO/releases/download/$version"
    else
        base="https://github.com/$REPO/releases/latest/download"
    fi

    if [ -n "${TERMIUM_INSTALL_DIR:-}" ]; then
        dir="$TERMIUM_INSTALL_DIR"
    elif [ -n "${HOME:-}" ]; then
        dir="$HOME/.local/bin"
    else
        err "HOME is not set; set TERMIUM_INSTALL_DIR to choose where to install"
    fi

    _termium_tmp=$(mktemp -d 2>/dev/null || mktemp -d -t termium-install) ||
        err "could not create a temporary directory"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    say "Installing termium ${version:-(latest)} for $target"

    download "$base/$asset" "$_termium_tmp/$asset"
    download "$base/SHA256SUMS" "$_termium_tmp/SHA256SUMS"

    expected=$(awk -v n="$asset" '$2 == n || $2 == "*" n { print $1; exit }' "$_termium_tmp/SHA256SUMS")
    [ -n "$expected" ] || err "$asset is not listed in SHA256SUMS; refusing to install"
    actual=$(sha256 "$_termium_tmp/$asset")
    if [ "$expected" != "$actual" ]; then
        err "checksum mismatch for $asset; refusing to install.
  expected: $expected
  got:      $actual"
    fi
    say "Checksum verified."

    tar -xzf "$_termium_tmp/$asset" -C "$_termium_tmp" || err "could not extract $asset"
    bin="$_termium_tmp/termium-$target/termium"
    [ -f "$bin" ] || err "$asset does not contain termium-$target/termium"

    case "$dir" in
        /*) ;;
        *) dir="$(pwd)/$dir" ;;
    esac
    mkdir -p "$dir" || err "could not create $dir"
    # mv onto a directory would move the binary *into* it and "succeed".
    if [ -d "$dir/termium" ] && [ ! -L "$dir/termium" ]; then
        err "$dir/termium is a directory; move it away and run this again"
    fi
    staged="$dir/.termium.install.$$"
    if ! cp "$bin" "$staged" || ! chmod 755 "$staged" || ! mv -f "$staged" "$dir/termium"; then
        rm -f "$staged"
        err "could not install termium into $dir (is it writable?)"
    fi

    installed=$("$dir/termium" --version 2>/dev/null) || installed=""
    if [ -n "$installed" ]; then
        say "Installed $installed to $dir/termium"
    else
        warn "installed $dir/termium, but '$dir/termium --version' failed"
        case "$target" in
            *-musl) warn "musl builds need libstdc++ and libgcc (Alpine: apk add libstdc++ libgcc)" ;;
        esac
    fi

    case ":${PATH:-}:" in
        *":$dir:"*) ;;
        *)
            path_dir="$dir"
            if [ -n "${HOME:-}" ]; then
                case "$dir" in
                    "$HOME"/*) path_dir="\$HOME${dir#"$HOME"}" ;;
                esac
            fi
            say ""
            say "$dir is not on your PATH. Add this line to your shell profile"
            say "(e.g. ~/.profile, ~/.bashrc or ~/.zshrc), then open a new terminal:"
            say ""
            say "    export PATH=\"$path_dir:\$PATH\""
            ;;
    esac

    say ""
    say "termium needs, at run time:"
    say "  - Helium (or another Chromium-based browser) installed"
    say "  - a terminal with the kitty graphics protocol (Ghostty recommended)"
    say "Then run 'termium'."
}

main "$@"
