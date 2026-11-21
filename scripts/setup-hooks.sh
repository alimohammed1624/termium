#!/usr/bin/env bash
# Opt in to the local CI git hooks for this clone and check prerequisites.
# Optional: GitHub Actions runs CI on every push to main and every pull
# request, and builds releases from v* tags; the hooks only add a local
# pre-flight (.githooks/post-commit runs scripts/ci.sh on main,
# .githooks/pre-push checks its result before pushing main).
#
#   scripts/setup-hooks.sh          set core.hooksPath=.githooks, check tools
#   scripts/setup-hooks.sh --mac    also install bun (user-level, ~/.bun) on
#                                   the Mac if it is missing
#
# Idempotent. core.hooksPath is per repository (shared by its worktrees).
# Opt out again with: git config --unset core.hooksPath

set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
# shellcheck source=scripts/lib.sh
. "$here/lib.sh"

mac=0
case "${1:-}" in
    --mac) mac=1 ;;
    "") ;;
    *) sed -n '2,/^$/s/^# \{0,1\}//p' "$0" >&2; exit 2 ;;
esac

current=$(git config --get core.hooksPath || true)
if [ "$current" = .githooks ]; then
    echo "hooks: already enabled (core.hooksPath=.githooks)"
else
    [ -n "$current" ] && echo "hooks: replacing core.hooksPath=$current"
    git config core.hooksPath .githooks
    echo "hooks: enabled (core.hooksPath=.githooks)"
fi
chmod +x .githooks/* scripts/*.sh 2>/dev/null

missing=0
check() { # check <required|optional> <command> <what it is for / how to get it>
    if command -v "$2" >/dev/null 2>&1; then
        printf '  ok        %s\n' "$2"
    else
        printf '  %-9s %s — %s\n' "$([ "$1" = required ] && echo MISSING || echo missing)" "$2" "$3"
        [ "$1" = required ] && missing=1
    fi
}
echo "local tools:"
check required git "git"
check required bun "Bun (https://bun.sh)"
check required flock "util-linux"
check optional ssh "openssh (ci.sh --mac, release.sh's macOS smoke test)"
check optional shellcheck "script lint: uv tool install shellcheck-py"
check optional actionlint "workflow lint: uv tool install actionlint-py"
check optional notify-send "desktop notifications (libnotify; gdbus is the fallback)"
check optional gh "release.sh publishing: GitHub CLI"

echo "mac ($TERMIUM_MAC_HOST):"
if ! mac_reachable; then
    echo "  unreachable over ssh (BatchMode) — ci.sh --mac and release.sh skip it"
elif mac_has_bun; then
    echo "  ok        reachable, bun installed"
elif [ "$mac" = 1 ]; then
    echo "  installing bun (user-level, ~/.bun)..."
    mac_ssh 'set -e; curl -fsSL https://bun.sh/install | bash' ||
        echo "  bun install failed"
else
    echo "  reachable, but no bun — run scripts/setup-hooks.sh --mac"
fi

exit "$missing"
