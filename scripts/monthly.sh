#!/bin/zsh
# Last month's reel, start to finish: fetch from Dreeve, render, copy to iCloud Drive.
# MONTH=YYYY-MM for another month.
set -eu
cd "${0:A:h}/.."
export MONTH="${MONTH:-$(date -v1d -v-1m +%Y-%m)}"
out="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Monthly Reels"

npm run -s fetch:dreeve
npm run -s render:last-month
mkdir -p "$out"
cp "exports/monthly-$MONTH.mp4" "$out/"
echo "Copied to iCloud Drive/Monthly Reels/monthly-$MONTH.mp4"
