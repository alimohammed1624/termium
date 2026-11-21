#!/bin/sh
# Regenerates docs/screenshots/*.png from a real Ghostty window.
# Needs Ghostty, Spectacle (KDE) and network access; takes about a minute.
# Keep the new Ghostty window focused while it runs: Spectacle captures the
# active window.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/docs/screenshots"
mkdir -p "$out"
ghostty --gtk-single-instance=false --window-width=170 --window-height=48 \
    --title="termium screenshots" \
    -e python3 "$root/scripts/ghostty-shots.py" "$out"
ls -l "$out"
