#!/bin/sh
# Regenerates docs/screenshots/*.png from a real Ghostty window.
# Needs Ghostty, Spectacle (KDE) and network access; takes about a minute.
# Keep the new Ghostty window focused while it runs: Spectacle captures the
# active window. A capture that isn't the termium window (wrong size) is
# deleted and the run stops.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/docs/screenshots"
mkdir -p "$out"
ghostty --gtk-single-instance=false --window-width=170 --window-height=48 \
    --title="termium screenshots" \
    -e python3 "$root/scripts/ghostty-shots.py" "$out"
if [ -f "$out/screenshots-error.txt" ]; then
    cat "$out/screenshots-error.txt" >&2
    rm -f "$out/screenshots-error.txt"
    exit 1
fi
ls -l "$out"
