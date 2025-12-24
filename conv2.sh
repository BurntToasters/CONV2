#!/bin/bash

export ELECTRON_IS_DEV=0
export ELECTRON_DISABLE_SECURITY_WARNINGS=true

# Use Zypak for sandbox integration
zypak-wrapper /app/lib/conv2/node_modules/electron/dist/electron /app/lib/conv2/dist/main/main.js "$@"
