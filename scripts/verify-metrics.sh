#!/usr/bin/env bash
# Prove Prometheus is scraping the Guestbook: every expected target is up and the app metrics have
# data. Exits non-zero on any failure. Needs kubectl pointed at the cluster, plus curl and jq.
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh
trap stop_prometheus EXIT

FAILED=0
fail() { echo "FAIL: $*"; FAILED=1; }

start_prometheus

echo "== 1. Some traffic for the frontend (20 requests)"
kubectl -n guestbook run "load-$RANDOM" --rm -i --restart=Never --quiet --image=curlimages/curl:8.10.1 -- \
  sh -c 'for i in $(seq 1 20); do curl -s -o /dev/null http://frontend/; done; echo sent' 2>/dev/null

echo "== Waiting 20s so every target has been scraped at least once"
sleep 20

echo "== 2. Guestbook scrape targets (health should be 'up')"
TARGETS=$(curl -sf -m 10 "localhost:$PORT/api/v1/targets?state=active" | jq -c '
  [.data.activeTargets[] | select(.labels.namespace == "guestbook")
   | {job: .labels.job, pod: (.labels.pod // .labels.instance), health, err: .lastError}]')
echo "$TARGETS" | jq -r '.[] | "\(.job)\t\(.pod)\t\(.health)\t\(.err)"'
# Expected = pods the Deployments want, minus the traffic generator (it has no exporter).
EXPECTED=$(kubectl -n guestbook get deploy -o json | jq '[.items[]
  | select(.spec.selector.matchLabels.app != "traffic-generator") | .spec.replicas] | add')
UP=$(echo "$TARGETS" | jq '[.[] | select(.job != "guestbook-frontend-probe" and .health == "up")] | length')
if [ "$UP" -eq "$EXPECTED" ]; then echo "OK: $UP/$EXPECTED exporter targets up"; else fail "$UP/$EXPECTED exporter targets up"; fi
if echo "$TARGETS" | jq -e 'any(.[]; .job == "guestbook-frontend-probe" and .health == "up")' >/dev/null; then
  echo "OK: blackbox probe target up"
else
  fail "blackbox probe target is not up"
fi

echo "== 3. Metrics"
check() {
  local result
  if ! result=$(prom_query "$1"); then fail "query error: $1"; return; fi
  echo "-- $1"
  echo "$result" | jq -r '.[] | "\(.metric.pod // "total")\t\(.value[1])"'
  [ "$(echo "$result" | jq length)" -gt 0 ] || fail "no data for: $1"
}
check 'sum by (pod) (apache_accesses_total{namespace="guestbook"})'
check 'sum by (pod) (redis_commands_processed_total{namespace="guestbook"})'
check 'min(redis_master_link_up{namespace="guestbook"}) == 1'
check 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",container!=""}[5m]))'
check 'probe_success{job="guestbook-frontend-probe"} == 1'

echo
if [ "$FAILED" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; exit 1; fi
