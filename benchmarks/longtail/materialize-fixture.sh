#!/usr/bin/env bash
# Materialize the controlled long-tail Next.js fixture for linux/arm64.
#
# Same shape as a real self-hosted Next deployment's Dockerfile: install every
# dependency, build, then prune the dev tree away so the production universe is
# production-only. Nothing is pinned to this machine — the lockfile produced
# here is committed alongside the source, so the tree is reproducible.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/fixture-app" && pwd)"
DST=/Users/sara/.cache/reducer-lazyoci-v1/apps/nextjs-longtail
mkdir -p "$(dirname "$DST")"
rm -rf "$DST" "$DST.tmp"
mkdir -p "$DST.tmp"
rsync -a --exclude node_modules --exclude .next "$SRC/" "$DST.tmp/"
mv "$DST.tmp" "$DST"

docker run --rm --platform linux/arm64 -v "$DST":/app -w /app \
  -e npm_config_update_notifier=false -e CI=1 -e NEXT_TELEMETRY_DISABLED=1 \
  reducer-materialize:v1 bash -lc '
    set -e
    npm install --no-audit --no-fund --dangerously-allow-all-scripts
    npm run build
    npm prune --omit=dev
    node -e "console.log(\"NEXT_BUILD_OK\", require(\"fs\").existsSync(\".next/BUILD_ID\"))"
  '

# The fixture is authored here, not fetched: its "SHA" is the git commit that
# contains the source, recorded once the tree exists.
git -C "$(dirname "$SRC")/../.." rev-parse HEAD > "$DST/.reducer-sha"
cp "$DST/package-lock.json" "$SRC/package-lock.json" 2>/dev/null || true
echo "MATERIALIZED nextjs-longtail"
