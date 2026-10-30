#!/usr/bin/env bash
# Updates the live app with the latest code from GitHub.
# Run on the VPS: bash /var/www/biesca-otp/deploy.sh
set -e
cd "$(dirname "$0")"
git pull
npm install --omit=dev
pm2 restart biesca-otp
