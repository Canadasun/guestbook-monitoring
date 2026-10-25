# Shared helpers for the scripts in this folder (source it, don't run it).

PROM_SVC="${PROM_SVC:-svc/monitoring-kube-prometheus-prometheus}"
PORT="${PORT:-9090}"
PF_PID=""
PF_LOG=""

# Port-forward to Prometheus and wait until it answers. Exits non-zero instead of carrying on
# without monitoring (port already in use, wrong kube context, Prometheus not running).
# Readiness is only trusted once kubectl reports that *its own* listener is bound; otherwise an
# unrelated server already on $PORT could answer the HTTP check while our port-forward dies.
start_prometheus() {
  PF_LOG=$(mktemp)
  kubectl -n monitoring port-forward "$PROM_SVC" "$PORT:9090" >"$PF_LOG" 2>&1 &
  PF_PID=$!
  local bound=0
  for _ in $(seq 1 30); do
    if ! kill -0 "$PF_PID" 2>/dev/null; then
      echo "ERROR: port-forward to Prometheus failed: $(tr '\n' ' ' <"$PF_LOG")" >&2
      echo "       (is port $PORT already in use? set PORT=<free port>; is kubectl pointed at the cluster?)" >&2
      return 1
    fi
    if [ "$bound" -eq 0 ] && grep -q "Forwarding from 127.0.0.1:$PORT" "$PF_LOG"; then
      bound=1
    fi
    if [ "$bound" -eq 1 ] && curl -sf -m 2 "localhost:$PORT/-/ready" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: Prometheus not ready on localhost:$PORT after 30s" >&2
  return 1
}

stop_prometheus() {
  [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null
  [ -n "$PF_LOG" ] && rm -f "$PF_LOG"
  PF_PID=""
  PF_LOG=""
  return 0
}

# Instant query; prints the raw JSON result array.
prom_query() {
  curl -sf -m 10 "localhost:$PORT/api/v1/query" --data-urlencode "query=$1" | jq -c '.data.result'
}
