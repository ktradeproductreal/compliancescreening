#!/usr/bin/env bash
# Cron wrapper for the UNSC daily sync. Mirrors sync-nacta.sh.
#
# aaPanel Cron entry (Type: Shell Script, daily at 03:00):
#   bash /www/wwwroot/compliance/deploy/sync-unsc.sh
set -e

export NVM_DIR="/www/server/nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd /www/wwwroot/compliance/server
npm run sync:unsc
