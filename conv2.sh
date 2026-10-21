#!/bin/bash
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export ELECTRON_IS_DEV=0
export ELECTRON_OZONE_PLATFORM_HINT=auto
export CONV2_DISABLE_UPDATES=1

# Use Zypak for sandbox integration
exec zypak-wrapper /app/lib/conv2/node_modules/electron/dist/electron /app/lib/conv2/dist/main/main.js "$@"
