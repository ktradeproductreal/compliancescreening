#!/usr/bin/env bash
# Cron wrapper for the NACTA sync.
# Sources nvm so `node` is on PATH (aaPanel installs Node via nvm; cron envs
# don't inherit your shell's PATH).
#
# aaPanel Cron entry (Type: Shell Script, every 3 hours):
#   bash /www/wwwroot/compliance/deploy/sync-nacta.sh
set -e

export NVM_DIR="/www/server/nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd /www/wwwroot/compliance/server
npm run sync:nacta
