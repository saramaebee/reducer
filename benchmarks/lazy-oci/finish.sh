#!/usr/bin/env bash
# Experiment A for every measured app, then all metrics and the summary.
# Run after `run.ts trials` has finished for every app.
set -u
cd "$(dirname "$0")/../.."
APPS="json-server verdaccio express-realworld uptime-kuma juice-shop strapi"
for a in $APPS; do
  echo "##### expA $a"
  timeout 3600 bun run benchmarks/lazy-oci/run.ts expa --app "$a" 2>&1 | grep -E '^\[|Error'
done
for a in $APPS; do bun run benchmarks/lazy-oci/analyze.ts --app "$a"; done
for a in $APPS; do bun run benchmarks/lazy-oci/analyze-expa.ts --app "$a"; done
bun run benchmarks/lazy-oci/summarize.ts > /dev/null
echo "FINISH COMPLETE"
