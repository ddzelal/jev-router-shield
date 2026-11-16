#!/bin/sh
# jev-router-shield installer: clone (or update) into ~/.jev-router-shield, then run the interactive setup.
set -e
DIR="${JEV_SHIELD_DIR:-$HOME/.jev-router-shield}"
command -v bun >/dev/null 2>&1 || { echo "Bun is required: curl -fsSL https://bun.sh/install | bash"; exit 1; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 https://github.com/ddzelal/jev-router-shield "$DIR"; fi
exec bun "$DIR/src/cli.ts" setup "$@" </dev/tty
