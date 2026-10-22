#!/bin/bash
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
export ELECTRON_IS_DEV=0
export ELECTRON_OZONE_PLATFORM_HINT=auto
export CONV2_DISABLE_UPDATES=1

# Use Zypak for sandbox integration
# Pass the app directory (package.json "main") so Electron sets appPath and app.getVersion() correctly.
exec zypak-wrapper /app/lib/conv2/electron/electron /app/lib/conv2 "$@"
