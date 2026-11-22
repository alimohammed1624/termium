#!/usr/bin/env bash
# Fallback: build and publish a termium release from this machine.
# The primary path is GitHub Actions: pushing a vX.Y.Z tag runs
# .github/workflows/release.yml, which builds the same assets and publishes.
# Use this script only when Actions is unavailable. The tag it pushes still
# starts the workflow, which then finds the release already made and leaves
# it alone.
#
#   scripts/release.sh vX.Y.Z [--dry-run]
#
# Checks (a real release refuses on any failure; --dry-run only warns):
#   - on branch main, work tree clean, HEAD equal to <remote>/main
#   - tag == "v" + package.json version, and the tag does not exist yet
#   - CHANGELOG.md has a "## [X.Y.Z]" section (the release notes)
#   - local CI (scripts/ci.sh) passed a full run for HEAD; if not, a real
#     release runs `scripts/ci.sh` first
# Builds the committed tree of HEAD for every target in TERMIUM_TARGETS
# (scripts/lib.sh) with `bun build --compile`, all here (Bun cross-compiles
# Linux gnu/musl and macOS, x86_64 and aarch64), runs this machine's binary
# with --version, and runs the aarch64-apple-darwin one on the Mac too if it
# is reachable (a warning, not a failure, if not). Then packages
# dist/termium-<target>.tar.gz (termium-<target>/{termium,README.md,LICENSE,
# CHANGELOG.md}) plus dist/SHA256SUMS, exactly as the release workflow does
# and install.sh expects. A real release then tags (git tag -a), pushes the
# tag and runs `gh release create` with the notes and all assets. --dry-run
# stops after packaging.
#
# Env: TERMIUM_MAC_HOST (default mba), TERMIUM_REMOTE (default origin).

set -uo pipefail

die() {
    printf 'release: error: %s\n' "$*" >&2
    exit 1
}

usage() {
    sed -n '2,/^$/s/^# \{0,1\}//p' "$0" >&2
    exit 2
}

main() {
    local tag="" dry=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --dry-run) dry=1 ;;
            -h | --help) usage ;;
            v*) [ -z "$tag" ] || usage; tag=$1 ;;
            *) usage ;;
        esac
        shift
    done
    [ -n "$tag" ] || usage
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "tag must look like v1.2.3 or v1.2.3-rc.1 (got $tag)"

    local here root
    here=$(cd "$(dirname "$0")" && pwd)
    root=$(git -C "$here" rev-parse --show-toplevel) || exit 1
    cd "$root" || exit 1
    # shellcheck source=scripts/lib.sh
    . "$here/lib.sh"
    local remote=${TERMIUM_REMOTE:-origin}
    local version=${tag#v}

    problems=0
    # check <ok?> <message>: a failed check is fatal later unless --dry-run.
    check() {
        if [ "$1" = 0 ]; then
            if [ "$dry" = 1 ]; then
                printf 'release: warning (dry run): %s\n' "$2" >&2
            else
                printf 'release: %s\n' "$2" >&2
            fi
            problems=1
        fi
    }

    command -v bun >/dev/null 2>&1 || die "bun is required (https://bun.sh)"

    local branch sha pkg_ver
    branch=$(git symbolic-ref --quiet --short HEAD || echo "(detached)")
    sha=$(git rev-parse HEAD) || die "no commit to release"
    check "$([ "$branch" = main ] && echo 1 || echo 0)" "not on main (on $branch)"
    check "$([ -z "$(git status --porcelain)" ] && echo 1 || echo 0)" "work tree is not clean"
    local remote_main
    remote_main=$(git ls-remote "$remote" refs/heads/main 2>/dev/null | cut -f1)
    if [ -n "$remote_main" ]; then
        check "$([ "$sha" = "$remote_main" ] && echo 1 || echo 0)" \
            "HEAD ${sha:0:7} is not $remote main (${remote_main:0:7}); push main first"
    else
        check 0 "could not read main from $remote"
    fi
    pkg_ver=$(git show "$sha:package.json" | pkg_version)
    check "$([ "$version" = "$pkg_ver" ] && echo 1 || echo 0)" \
        "tag $tag does not match package.json version $pkg_ver (expected v$pkg_ver)"
    check "$(git rev-parse -q --verify "refs/tags/$tag" >/dev/null && echo 0 || echo 1)" "tag $tag already exists locally"
    check "$([ -z "$(git ls-remote --tags "$remote" "refs/tags/$tag" 2>/dev/null)" ] && echo 1 || echo 0)" \
        "tag $tag already exists on $remote"

    notes=$(changelog_section "$version")
    if [ -z "$notes" ]; then
        check 0 "CHANGELOG.md has no '## [$version]' section"
        notes=$(changelog_section Unreleased)
    fi
    check "$(grep -Eq "^## \[$version\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" CHANGELOG.md && echo 1 || echo 0)" \
        "CHANGELOG.md's '## [$version]' heading needs the release date (## [$version] - YYYY-MM-DD)"

    if [ "$dry" = 0 ]; then
        command -v gh >/dev/null 2>&1 || die "gh (GitHub CLI) is required to publish"
        gh release view "$tag" >/dev/null 2>&1 && die "a GitHub release $tag already exists"
        [ "$problems" = 0 ] || die "refusing to release (see above)"
    fi

    # Local CI: a real release needs a full PASS for this exact commit.
    local state cimode
    state=$(ci_state "$sha")
    [ "$state" = RUNNING ] && { echo "release: waiting for the running local CI of ${sha:0:7}..."; ci_wait "$sha"; state=$(ci_state "$sha"); }
    cimode=$(ci_mode "$sha")
    if [ "$state" != PASS ] || [ "$cimode" != full ]; then
        if [ "$dry" = 1 ]; then
            echo "release: warning (dry run): local CI for ${sha:0:7} is ${state,,}${cimode:+ ($cimode)}, not a full PASS" >&2
        else
            echo "release: local CI for ${sha:0:7} is ${state,,}${cimode:+ ($cimode)}; running scripts/ci.sh"
            "$here/ci.sh" --sha "$sha" || die "local CI failed for ${sha:0:7}; not releasing"
        fi
    else
        echo "release: local CI PASS for ${sha:0:7}"
    fi

    local cidir dist t0=$SECONDS
    cidir=$(ci_dir)
    dist="$root/dist"
    work="$cidir/release.$$"
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    rm -rf "$dist"
    mkdir -p "$dist" "$work/bin"
    ci_snapshot "$sha" "$work/src" || die "could not extract $sha"
    echo "release: building ${sha:0:7} as $tag with bun $(bun --version) (logs: $work/*.log until the end, then dist/build-*.log)"

    (cd "$work/src" && bun install --frozen-lockfile) >"$work/install.log" 2>&1 ||
        { tail -n 20 "$work/install.log" >&2; die "bun install --frozen-lockfile failed"; }

    local entry t tt rc=0
    for entry in "${TERMIUM_TARGETS[@]}"; do
        t=${entry%%:*}
        tt=$SECONDS
        if (cd "$work/src" && bun_compile "$t" "$work/bin/$t/termium") >"$work/$t.log" 2>&1; then
            echo "  built $t ($(fmt_secs $((SECONDS - tt))))"
        else
            echo "  FAILED $t (log: $work/$t.log)"
            tail -n 20 "$work/$t.log" >&2
            rc=1
        fi
    done
    cp "$work"/*.log "$dist/" 2>/dev/null
    for f in "$dist"/*.log; do mv "$f" "$dist/build-$(basename "$f")"; done
    [ "$rc" = 0 ] || die "build failed; nothing published"

    # Smoke test: the binaries must report the version being released.
    local host got
    if host=$(host_target) && [ -x "$work/bin/$host/termium" ]; then
        got=$("$work/bin/$host/termium" --version 2>&1) || got="(exit $?) $got"
        [ "$got" = "termium $version" ] || die "$host binary: --version printed '$got', expected 'termium $version'"
        echo "  ran $host: $got"
    else
        echo "release: warning: no release target matches this machine; skipped the --version check here" >&2
    fi
    if mac_reachable; then
        # shellcheck disable=SC2016 # runs on the Mac
        got=$(mac_ssh 'f=$(mktemp) && cat >"$f" && chmod 755 "$f" && "$f" --version; rc=$?; rm -f "$f"; exit $rc' \
            <"$work/bin/aarch64-apple-darwin/termium" 2>&1) || got="(failed) $got"
        [ "$got" = "termium $version" ] ||
            die "aarch64-apple-darwin binary on $TERMIUM_MAC_HOST: --version printed '$got', expected 'termium $version'"
        echo "  ran aarch64-apple-darwin on $TERMIUM_MAC_HOST: $got"
    else
        echo "release: warning: Mac $TERMIUM_MAC_HOST unreachable over ssh; macOS binaries not run (the workflow's install-test runs them)" >&2
    fi

    # Package: keep asset names and layout in sync with install.sh.
    local name
    for entry in "${TERMIUM_TARGETS[@]}"; do
        t=${entry%%:*}
        name="termium-$t"
        [ -f "$work/bin/$t/termium" ] || die "missing binary for $t"
        # This script runs without `set -e`, so every step checks itself:
        # a missing archive must stop the release, not ship without it.
        mkdir -p "$work/pkg/$name" || die "cannot create $work/pkg/$name"
        cp "$work/bin/$t/termium" "$work/pkg/$name/termium" || die "cannot copy the $t binary"
        chmod 755 "$work/pkg/$name/termium" || die "cannot chmod the $t binary"
        for f in "${TERMIUM_PAYLOAD[@]}"; do
            cp "$work/src/$f" "$work/pkg/$name/" || die "cannot copy $f into $name"
        done
        tar -C "$work/pkg" --owner=0 --group=0 --numeric-owner -czf "$dist/$name.tar.gz" "$name" ||
            die "packaging $name.tar.gz failed"
        [ -s "$dist/$name.tar.gz" ] || die "$name.tar.gz is missing or empty"
    done
    # install.sh looks up "<hash>  termium-<target>.tar.gz" lines here.
    (cd "$dist" && sha256sum -- *.tar.gz >SHA256SUMS) || die "writing SHA256SUMS failed"
    local sums
    sums=$(wc -l <"$dist/SHA256SUMS")
    [ "$sums" -eq "${#TERMIUM_TARGETS[@]}" ] ||
        die "SHA256SUMS has $sums entries, expected ${#TERMIUM_TARGETS[@]}"
    printf '%s\n' "$notes" >"$dist/RELEASE_NOTES.md" || die "writing release notes failed"

    echo "release: packaged in $(fmt_secs $((SECONDS - t0))) -> $dist"
    (cd "$dist" && ls -l -- *.tar.gz SHA256SUMS)

    if [ "$dry" = 1 ]; then
        echo "release: dry run; not tagging or publishing $tag"
        return 0
    fi

    git tag -a "$tag" -m "termium $tag" "$sha" || die "git tag failed"
    git push "$remote" "refs/tags/$tag" || die "pushing tag $tag failed (delete it locally with: git tag -d $tag)"
    local pre=()
    [[ "$version" == *-* ]] && pre=(--prerelease)
    gh release create "$tag" --verify-tag --title "termium $tag" --notes-file "$dist/RELEASE_NOTES.md" \
        "${pre[@]}" "$dist"/*.tar.gz "$dist/SHA256SUMS" ||
        die "gh release create failed; the tag $tag is pushed — retry with: gh release create $tag --verify-tag --notes-file dist/RELEASE_NOTES.md dist/*.tar.gz dist/SHA256SUMS"
    echo "release: published $tag"
}

cleanup() {
    [ -n "${work:-}" ] && rm -rf "$work"
    return 0
}

# changelog_section <X.Y.Z|Unreleased>: body of "## [X.Y.Z]..." in CHANGELOG.md.
changelog_section() {
    awk -v v="$1" '
        /^## \[/ { if (on) exit; on = index($0, "## [" v "]") == 1; next }
        /^\[[^]]+\]: / { if (on) exit }
        on { print }
    ' CHANGELOG.md | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}

main "$@"
