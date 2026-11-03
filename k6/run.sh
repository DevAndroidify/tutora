#!/usr/bin/env bash
# Runs the three k6 scenarios with Docker (no local k6 needed) and saves summaries to docs/load/.
set -euo pipefail
mkdir -p docs/load
for t in bid-create bid-accept webhooks; do
  echo "== k6 $t"
  docker run --rm --network host -v "$PWD/k6:/k6" -v "$PWD/docs/load:/out" grafana/k6:2.2.0 \
    run --quiet --summary-export "/out/$t.json" "/k6/$t.js" | tee "docs/load/$t.txt"
done
