#!/bin/sh
set -eu
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo 'TELEGRAM_BOT_TOKEN is required' >&2
  exit 1
fi
exec node --use-env-proxy bot.mjs
