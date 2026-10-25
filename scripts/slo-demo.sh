#!/usr/bin/env bash
# Outage drill: take the Guestbook frontend down, watch the SLO fast-burn alert go
# inactive -> pending -> firing, then restore the frontend (also on Ctrl-C or any error).
# With a full hour of probe history, expect "firing" about 6-7 minutes in: the 1h error ratio must
# pass 7.2% (about 4.5 minutes of failed probes) and then hold for the rule's `for: 2m`. On a fresh
# install the 1h window holds less history, so each failure weighs more and it fires sooner (~3 min).
set -euo pipefail
cd "$(dirname "$0")"
source ./lib.sh

ALERT=GuestbookAvailabilityErrorBudgetBurnFast
# Pulumi auto-names Deployments (frontend-<suffix>), so find it by the pods it selects.
DEPLOY=$(kubectl -n guestbook get deploy -o jsonpath='{.items[?(@.spec.selector.matchLabels.app=="frontend")].metadata.name}')
[ -n "$DEPLOY" ] || { echo "No frontend Deployment found in namespace guestbook"; exit 1; }
REPLICAS=$(kubectl -n guestbook get deploy "$DEPLOY" -o jsonpath='{.spec.replicas}')
SCALED_DOWN=0

restore() {
  local status=$?
  set +e   # every cleanup step must run, even if an earlier one fails
  stop_prometheus
  if [ "$SCALED_DOWN" -eq 1 ]; then
    echo "== Restoring $DEPLOY to $REPLICAS replicas"
    if ! kubectl -n guestbook scale deploy "$DEPLOY" --replicas="$REPLICAS" >/dev/null ||
       ! kubectl -n guestbook rollout status deploy "$DEPLOY" --timeout=180s; then
      echo "ERROR: restore did not complete. Run: kubectl -n guestbook scale deploy $DEPLOY --replicas=$REPLICAS" >&2
      [ "$status" -eq 0 ] && status=1
    fi
  fi
  exit "$status"
}
trap restore EXIT

# Monitoring must be reachable BEFORE anything is taken down.
start_prometheus

q() { prom_query "$1" | jq -r '.[0].value[1] // "n/a"'; }
state() {
  curl -sf -m 10 "localhost:$PORT/api/v1/alerts" |
    jq -r --arg a "$ALERT" '[.data.alerts[] | select(.labels.alertname == $a) | .state] | if length == 0 then "inactive" else unique | join(",") end'
}

echo "== $(date +%T) Outage starts: scaling $DEPLOY to 0"
SCALED_DOWN=1
kubectl -n guestbook scale deploy "$DEPLOY" --replicas=0 >/dev/null
START=$(date +%s)
while true; do
  S=$(state)
  printf "%s  +%3ss  probe_success=%s  error_ratio_5m=%s  error_ratio_1h=%s  burn_1h=%sx  alert=%s\n" \
    "$(date +%T)" "$(( $(date +%s) - START ))" \
    "$(q 'probe_success{job="guestbook-frontend-probe"}')" \
    "$(q 'round(slo:sli_error:ratio_rate5m{slo="guestbook-availability"}, 0.001)')" \
    "$(q 'round(slo:sli_error:ratio_rate1h{slo="guestbook-availability"}, 0.001)')" \
    "$(q 'round(slo:sli_error:ratio_rate1h{slo="guestbook-availability"} / 0.005, 0.1)')" "$S"
  [[ "$S" == *firing* ]] && { echo "== $(date +%T) $ALERT is FIRING after $(( $(date +%s) - START ))s"; break; }
  (( $(date +%s) - START > 900 )) && { echo "== Timed out after 15 min without the alert firing"; exit 1; }
  sleep 30
done
echo "== Error budget left: $(q 'round(slo:error_budget_remaining:ratio{slo="guestbook-availability"} * 100, 0.1)')%"
