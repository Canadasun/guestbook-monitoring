#!/usr/bin/env bash
# Validate the generated SLO rules with promtool and run Prometheus rule unit tests
# (tests/rules/*.test.yaml replay fake probe data and assert which alerts fire). Needs Docker.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
npx ts-node -e 'const { sloRuleGroups } = require("./slo"); console.log(JSON.stringify({ groups: sloRuleGroups() }, null, 2))' > build/slo-rules.json
cp tests/rules/*.test.yaml build/
docker run --rm -v "$PWD/build:/work" -w /work --entrypoint promtool prom/prometheus:v3.7.3 check rules slo-rules.json
docker run --rm -v "$PWD/build:/work" -w /work --entrypoint promtool prom/prometheus:v3.7.3 test rules $(cd build && ls *.test.yaml)
