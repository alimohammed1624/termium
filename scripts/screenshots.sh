#!/bin/sh
# Regenerates docs/screenshots/*.png from a real Ghostty window.
# `screenshots.sh tmux` takes the tmux ones instead (tmux-split.png,
# tmux-reattach.png; needs tmux 3.3 or later).
# Needs Ghostty, Spectacle (KDE) and network access; takes about a minute.
# Keep the new Ghostty window focused while it runs: Spectacle captures the
# active window. A capture that isn't the termium window (wrong size) is
# deleted and the run stops.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/docs/screenshots"
mkdir -p "$out"
script=ghostty-shots.py
[ "${1:-}" = tmux ] && script=ghostty-tmux-shots.py
ghostty --gtk-single-instance=false --window-width=170 --window-height=48 \
    --title="termium screenshots" \
    -e python3 "$root/scripts/$script" "$out"
if [ -f "$out/screenshots-error.txt" ]; then
    cat "$out/screenshots-error.txt" >&2
    rm -f "$out/screenshots-error.txt"
    exit 1
fi
ls -l "$out"
