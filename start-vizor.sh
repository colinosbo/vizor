#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 24 LTS from https://nodejs.org/en/download, then reopen this launcher.'
  exit 1
fi
exec node scripts/launch.mjs "$@"
