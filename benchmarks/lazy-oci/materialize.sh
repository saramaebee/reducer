#!/usr/bin/env bash
# Materialize ONE frozen corpus app for linux/arm64 inside a container.
# Same pinned app SHA, same lockfile, same install command as
# benchmarks/hazard-domain/MATERIALIZATION.md — only the platform differs.
# Rationale: the frozen corpus was installed on darwin-arm64, so its native
# addons are Mach-O and cannot execute under any Linux lazy-OCI substrate.
set -euo pipefail
APP=$1
SRC=/Users/sara/.cache/reducer-corpus-v1/$APP
DST=/Users/sara/.cache/reducer-lazyoci-v1/apps/$APP
SHA=$(git -C "$SRC" rev-parse HEAD)
mkdir -p "$(dirname "$DST")"
rm -rf "$DST" "$DST.tmp"
rsync -a --exclude '.git' --exclude 'node_modules' --exclude '**/node_modules' "$SRC/" "$DST.tmp/"
mv "$DST.tmp" "$DST"
echo "$SHA" > "$DST/.reducer-sha"
INSTALL=$2   # npm | pnpm | yarn
case "$INSTALL" in
  npm)  CMD='npm ci --dangerously-allow-all-scripts' ;;
  pnpm) CMD='corepack enable && pnpm install --frozen-lockfile' ;;
  yarn) CMD='corepack enable && corepack yarn install --immutable' ;;
  *) echo "unknown installer $INSTALL"; exit 2 ;;
esac
docker run --rm --platform linux/arm64 -v "$DST":/app -w /app \
  -e npm_config_update_notifier=false -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  reducer-materialize:v1 bash -lc "$CMD"
echo "MATERIALIZED $APP $SHA"
