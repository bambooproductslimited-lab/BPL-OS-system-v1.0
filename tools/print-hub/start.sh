#!/bin/sh
# Bamboo print hub (Mac, Linux, Raspberry Pi): needs Node.js 18 or newer.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Get it from https://nodejs.org (Raspberry Pi: sudo apt install nodejs)."
  exit 1
fi
exec node bamboo-print-hub.js "$@"
