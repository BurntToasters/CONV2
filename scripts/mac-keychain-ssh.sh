#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "mac-keychain-ssh.sh: skipping (not macOS)."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/keychain-security.sh"

KEYCHAIN_PATH="${KEYCHAIN_PATH:-$HOME/Library/Keychains/login.keychain-db}"
DOTENV_FILE="${DOTENV_FILE:-.env}"

if [[ -z "${KEYCHAIN_PASSWORD:-}" && -n "${SSH_USER_PWD:-}" ]]; then
  KEYCHAIN_PASSWORD="${SSH_USER_PWD}"
fi

if [[ -z "${KEYCHAIN_PASSWORD:-}" && -f "$DOTENV_FILE" ]]; then
  DOTENV_SSH_USER_PWD="$(awk -F= '
    /^[[:space:]]*SSH_USER_PWD[[:space:]]*=/ {
      val=substr($0, index($0, "=") + 1)
      sub(/\r$/, "", val)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", val)
      if ((val ~ /^".*"$/) || (val ~ /^'\''.*'\''$/)) {
        val=substr(val, 2, length(val)-2)
      }
      print val
    }
  ' "$DOTENV_FILE" | tail -n 1)"
  if [[ -n "$DOTENV_SSH_USER_PWD" ]]; then
    KEYCHAIN_PASSWORD="$DOTENV_SSH_USER_PWD"
  fi
fi

if [[ -z "${KEYCHAIN_PASSWORD:-}" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "Login keychain password: " KEYCHAIN_PASSWORD
    echo
  else
    echo "KEYCHAIN_PASSWORD or SSH_USER_PWD is required in non-interactive shells."
    exit 1
  fi
fi

if ! command -v expect >/dev/null 2>&1; then
  echo "expect is required so the keychain password is not placed on security argv."
  exit 1
fi

echo "Preparing keychain for non-GUI codesign..."
export KEYCHAIN_PASSWORD

# A locked keychain here means codesign prompts mid-release, so stop instead.
if ! security_with_password unlock-keychain "$KEYCHAIN_PATH" >/dev/null; then
  echo "Could not unlock $KEYCHAIN_PATH. Check SSH_USER_PWD in $DOTENV_FILE."
  exit 1
fi

security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security list-keychains -d user -s "$KEYCHAIN_PATH"
security default-keychain -d user -s "$KEYCHAIN_PATH"

if ! security_with_password set-key-partition-list -S apple-tool:,apple:,codesign: -s \
  "$KEYCHAIN_PATH" >/dev/null; then
  echo "Could not allow codesign to use keys in $KEYCHAIN_PATH."
  exit 1
fi

echo "Keychain ready for SSH signing."
