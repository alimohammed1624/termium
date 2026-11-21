# shellcheck shell=bash
# Shared helpers for scripts/ci.sh, scripts/release.sh and .githooks/*.
# Sourced, never run directly. Needs git, bun, flock (util-linux) and ssh.
#
# Local CI state lives in the git dir (never committed), one set per commit:
#   <git-common-dir>/termium-ci/<sha>.log      full log of the last run
#   <git-common-dir>/termium-ci/<sha>.status   PASS | FAIL | RUNNING, then details
#   <git-common-dir>/termium-ci/<sha>.lock     held (flock) while a run is going
#   <git-common-dir>/termium-ci/<sha>.unseen   result not yet shown to anyone
#
# The Mac (TERMIUM_MAC_HOST, default "mba") is optional: Bun cross-compiles
# every release target here, so the Mac only runs the checks natively
# (ci.sh --mac) and smoke-tests the macOS binary (release.sh). It gets the
# exact commit via `git archive | ssh`, never via its own network access to
# GitHub. Remote layout: ~/.cache/termium-ci/src/<sha>-<id>/ (pruned).

TERMIUM_MAC_HOST="${TERMIUM_MAC_HOST:-mba}"

# Release targets, as <target triple>:<bun --target>. The triple names the
# asset (termium-<triple>.tar.gz). Keep in sync with install.sh and
# .github/workflows/{release,ci}.yml.
#   Linux gnu   glibc distros (Debian, Ubuntu, Fedora, Arch, ...)
#   Linux musl  Alpine and other musl distros (need libstdc++ and libgcc)
#   x64 builds use Bun's "baseline" variant, which runs on CPUs without
#   AVX2 too.
TERMIUM_TARGETS=(
    x86_64-unknown-linux-gnu:bun-linux-x64-baseline
    aarch64-unknown-linux-gnu:bun-linux-arm64
    x86_64-unknown-linux-musl:bun-linux-x64-musl-baseline
    aarch64-unknown-linux-musl:bun-linux-arm64-musl
    x86_64-apple-darwin:bun-darwin-x64-baseline
    aarch64-apple-darwin:bun-darwin-arm64
)

# Files shipped next to the binary in every archive.
# shellcheck disable=SC2034 # used by scripts/release.sh
TERMIUM_PAYLOAD=(README.md LICENSE CHANGELOG.md)

# Directory holding CI logs/status for this clone (shared by its worktrees).
ci_dir() {
    local common
    common=$(git rev-parse --path-format=absolute --git-common-dir) || return 1
    printf '%s/termium-ci\n' "$common"
}

# ci_state <sha>: prints PASS, FAIL, RUNNING or NONE. A RUNNING status whose
# lock is no longer held (the run was killed) counts as NONE.
ci_state() {
    local dir sha=$1
    dir=$(ci_dir) || return 1
    if [ -e "$dir/$sha.lock" ] && ! flock -n "$dir/$sha.lock" true 2>/dev/null; then
        echo RUNNING
        return
    fi
    if [ -f "$dir/$sha.status" ]; then
        case "$(head -n1 "$dir/$sha.status")" in
            PASS*) echo PASS ;;
            FAIL*) echo FAIL ;;
            *) echo NONE ;;
        esac
    else
        echo NONE
    fi
}

# ci_mode <sha>: "full" or "quick" for the recorded run (empty if none).
ci_mode() {
    local dir
    dir=$(ci_dir) || return 1
    sed -n 's/^mode: //p' "$dir/$1.status" 2>/dev/null | head -n1
}

# ci_wait <sha>: block until no CI run holds the lock for <sha>.
ci_wait() {
    local dir
    dir=$(ci_dir) || return 1
    [ -e "$dir/$1.lock" ] && flock "$dir/$1.lock" true 2>/dev/null
    return 0
}

# ci_announce: print one line per finished run nobody has been told about
# (no desktop notification, or a FAIL) and mark it seen.
ci_announce() {
    local dir f sha line
    dir=$(ci_dir) || return 0
    for f in "$dir"/*.unseen; do
        [ -e "$f" ] || continue
        sha=$(basename "$f" .unseen)
        line=$(head -n1 "$dir/$sha.status" 2>/dev/null) || line=""
        case "$line" in
            PASS* | FAIL*)
                printf 'termium CI: %s (log: %s)\n' "$line" "$dir/$sha.log" >&2
                rm -f "$f"
                ;;
        esac
    done
}

# ci_snapshot <sha> <dir>: extract the committed tree of <sha> into <dir>.
# Files get the current time (tar -m), not the commit time, so no tool
# mistakes the fresh copy for an older one.
ci_snapshot() {
    rm -rf "$2"
    mkdir -p "$2"
    git archive --format=tar "$1" | tar -x -m -C "$2"
}

# pkg_version <package.json text on stdin>: prints its "version".
pkg_version() {
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1
}

# bun_target <triple>: prints the bun --target for a release target triple.
bun_target() {
    local t
    for t in "${TERMIUM_TARGETS[@]}"; do
        [ "${t%%:*}" = "$1" ] && { printf '%s\n' "${t#*:}"; return 0; }
    done
    echo "error: unknown target $1" >&2
    return 1
}

# bun_compile <triple> <outfile>: standalone termium binary for <triple>,
# built from src/main.ts in the current directory.
bun_compile() {
    local bt
    bt=$(bun_target "$1") || return 1
    mkdir -p "$(dirname "$2")"
    bun build --compile --minify --target="$bt" src/main.ts --outfile "$2"
}

# host_target: prints the release target triple of this Linux machine.
host_target() {
    local libc=gnu
    if ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
        libc=musl
    fi
    case "$(uname -m)" in
        x86_64 | amd64) echo "x86_64-unknown-linux-$libc" ;;
        aarch64 | arm64) echo "aarch64-unknown-linux-$libc" ;;
        *) return 1 ;;
    esac
}

mac_ssh() {
    ssh -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=30 \
        "$TERMIUM_MAC_HOST" "$@"
}

mac_reachable() {
    mac_ssh true >/dev/null 2>&1
}

mac_has_bun() {
    # shellcheck disable=SC2016 # $HOME expands on the Mac
    mac_ssh 'test -x "$HOME/.bun/bin/bun" || test -x /opt/homebrew/bin/bun' >/dev/null 2>&1
}

# mac_ship <sha> <id>: copy the tree of <sha> to the Mac and print the remote
# directory (relative to the Mac's $HOME). Keeps the 5 newest source dirs.
mac_ship() {
    local rdir=".cache/termium-ci/src/$1-$2"
    git archive --format=tar "$1" | mac_ssh "set -e
        d=\"\$HOME/$rdir\"
        rm -rf \"\$d\" && mkdir -p \"\$d\" && tar -x -m -C \"\$d\"
        cd \"\$HOME/.cache/termium-ci/src\"
        ls -1t | tail -n +6 | while IFS= read -r old; do rm -rf \"./\$old\"; done" || return 1
    printf '%s\n' "$rdir"
}

# mac_run <remote dir> <shell commands>: run bash on the Mac inside <remote
# dir> with bun on PATH.
mac_run() {
    local rdir=$1
    shift
    # The body sits in a function so bash has read all of it before any
    # command runs; commands get /dev/null as stdin, not the script.
    mac_ssh 'bash -s' <<EOF
main() {
set -euo pipefail
export PATH="\$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NO_COLOR=1 CI=true
cd "\$HOME/$rdir"
$*
}
main </dev/null
EOF
}

# mac_cleanup <remote dir>
mac_cleanup() {
    mac_ssh "rm -rf \"\$HOME/$1\"" >/dev/null 2>&1 || true
}

# fmt_secs <seconds>: 75 -> 1m15s
fmt_secs() {
    if [ "$1" -ge 60 ]; then
        printf '%dm%02ds' $(($1 / 60)) $(($1 % 60))
    else
        printf '%ds' "$1"
    fi
}
