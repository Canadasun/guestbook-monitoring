# Guestbook monitoring with Pulumi, Prometheus and Grafana

This project extends the Pulumi [Kubernetes Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook) with monitoring. A single `pulumi up` deploys:

- **The Guestbook app.** This is the PHP frontend plus a Redis leader and replica. Each now runs a small Prometheus exporter beside it.
- **Prometheus and Grafana**, installed with the `kube-prometheus-stack` Helm chart.
- **ServiceMonitors.** These tell Prometheus to scrape the Guestbook frontend and backend.
- **A Grafana dashboard stored as code**, which loads automatically. It covers request rate, Redis activity, replication health, pod CPU and memory, and restarts.
- **Beyond the brief: SLOs with multi-window, multi-burn-rate alerts.** A blackbox probe checks the frontend's availability and latency. There are error-budget panels, alert rules that are tested with `promtool`, and an outage drill script that shows an alert firing.

## Quick start (about 5 minutes for a reviewer)

```bash
npm install && pulumi stack init dev && pulumi up --yes   # kubectl must point at your cluster
pulumi stack output grafanaUrl                            # open it in a browser
pulumi stack output grafanaAdminPassword --show-secrets   # log in as "admin"
./scripts/verify-metrics.sh                               # prints ALL CHECKS PASSED
```

Then open **Dashboards → Guestbook Overview** in Grafana. On minikube or kind, set the two `NodePort`/`ClusterIP` options under [Deploy](#deploy) first. How each requirement is met:

| Requirement | Where |
|---|---|
| Prometheus and Grafana deployed by Pulumi | `monitoring.ts`: kube-prometheus-stack Helm release |
| Frontend and backend scraped | `guestbook.ts` exporter sidecars and metrics Services, plus 2 ServiceMonitors in `monitoring.ts` |
| Grafana exposed | LoadBalancer by default, NodePort via config |
| URL and credentials output | stack outputs `grafanaUrl`, `grafanaAdminUser`, `grafanaAdminPassword` (secret) |
| Stretch: dashboard | `dashboards/guestbook-overview.json`, auto-loaded |

Everything under [Beyond the brief](#beyond-the-brief-slos-and-burn-rate-alerting) is optional extra work and isn't needed to evaluate the assignment.

## Architecture

```
                         namespace: guestbook                                  namespace: monitoring
 ┌──────────────────────────────────────────────────────────────┐   ┌────────────────────────────────────┐
 │  frontend pod (x3)                  redis-leader / replica   │   │  Prometheus  ◄── ServiceMonitors,  │
 │  ┌──────────────┬────────────────┐  ┌──────────┬───────────┐ │   │      │           Probe, Rules      │
 │  │ PHP/Apache   │ apache_exporter│  │  redis   │  redis_   │ │   │      │                             │
 │  │ :80          │ :9117 /metrics │  │  :6379   │  exporter │ │   │      ▼                             │
 │  │ mod_status ──┼─► (localhost)  │  │          │  :9121    │ │   │  Grafana (LoadBalancer) ◄─ you     │
 │  └──────────────┴────────────────┘  └──────────┴───────────┘ │   │      ▲ dashboard ConfigMap         │
 │        ▲                   ▲                     ▲           │   │      │ (sidecar auto-loads)        │
 │  Service frontend    Service frontend-metrics  Service       │   │                                    │
 │  (LoadBalancer :80)  (ClusterIP :9117)         redis-metrics │   │  blackbox-exporter ──► probes      │
 │                                                (ClusterIP)   │   │  http://frontend.guestbook.svc/    │
 └──────────────────────────────────────────────────────────────┘   └────────────────────────────────────┘
```

How it works:

- **The frontend has no metrics of its own,** so an `apache_exporter` sidecar reads Apache's built-in `mod_status` page. The image only allows that page from `localhost`, and a sidecar shares the pod's network, so nothing new is exposed publicly.
- **Redis also has no `/metrics` endpoint,** so a `redis_exporter` sidecar runs next to the leader and the replica.
- **Metrics ports stay private.** They are published only on separate ClusterIP `*-metrics` Services. The frontend's public LoadBalancer exposes port 80 and nothing else.
- **The blackbox exporter acts as a user.** It requests the frontend through its Service every 15 s, which provides the SLI for the SLOs.

## Repository layout

| Path | Purpose |
|---|---|
| `index.ts` | Entry point: connects the modules and exports the stack outputs |
| `guestbook.ts` | The Guestbook app (from the upstream example), its exporter sidecars and metrics Services |
| `monitoring.ts` | kube-prometheus-stack Helm release, ServiceMonitors, dashboard ConfigMap, Grafana URL and password outputs |
| `slo.ts` | SLO definitions, generated recording and alert rules, blackbox exporter and Probe |
| `dashboards/guestbook-overview.json` | The Grafana dashboard (19 panels) |
| `tests/infra.test.ts` | Pulumi unit tests (mocked, no cluster needed) |
| `tests/rules/slo-alerts.test.yaml` | Prometheus rule unit tests (`promtool test rules`) |
| `e2e/` | Optional browser end-to-end tests (Playwright and Chromium) against the deployed stack |
| `scripts/` | `verify-metrics.sh`, `slo-demo.sh`, `test-rules.sh`, `lib.sh` (shared fail-fast Prometheus helpers), plus optional `create-aks.sh` and `destroy-aks.sh` |

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/) 3.x, logged in (`pulumi login`; Pulumi Cloud or `pulumi login --local` both work)
- Node.js 22 or later and npm (required by `@pulumi/pulumi` 3.272; declared in `package.json` `engines`)
- A Kubernetes cluster that your current `kubectl` context points at (AKS, EKS, GKE, minikube or kind). It needs about 2 vCPU and 4 GB free.
  - **x86 (amd64) nodes are required**, because the upstream Guestbook images are amd64-only.
  - `scripts/create-aks.sh` creates a suitable 2-node AKS cluster if you need one.
- `kubectl`, `curl` and `jq` to run the verification scripts. Docker is needed only for `scripts/test-rules.sh`.

## Deploy

```bash
npm install
pulumi stack init dev

# Optional: a tiny in-cluster client sends about 2 req/s so the dashboards show traffic
pulumi config set trafficGenerator true

# On minikube or kind (no cloud load balancer):
# pulumi config set grafanaServiceType NodePort
# pulumi config set frontendServiceType ClusterIP
# On kind, node IPs usually aren't reachable from your machine: open Grafana with
#   kubectl -n monitoring port-forward svc/monitoring-grafana 3000:80   ->  http://localhost:3000

pulumi preview      # review the plan
pulumi up           # about 4-5 minutes, most of it the Helm chart
```

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `grafanaServiceType` | `LoadBalancer` | `LoadBalancer` (cloud) or `NodePort` (minikube or kind) |
| `frontendServiceType` | `LoadBalancer` | `LoadBalancer` or `ClusterIP` |
| `trafficGenerator` | `false` | Runs a curl loop against the frontend so the panels have data |

The included `Pulumi.dev.yaml` is the stack this project was tested with, and it sets `trafficGenerator: true`. A stack named `dev` therefore starts with traffic on. Use a different stack name to start from the defaults.

## Grafana access: URL and admin credentials

Pulumi prints these as stack outputs at the end of `pulumi up`:

```bash
pulumi stack output grafanaUrl                           # e.g. http://52.162.202.60
pulumi stack output grafanaAdminUser                     # admin
pulumi stack output grafanaAdminPassword --show-secrets  # generated at deploy time
```

- **There is deliberately no shared default password.** A 20-character password is generated by `@pulumi/random` and stored encrypted in the Pulumi state as a secret. It appears as `[secret]` in all logs and outputs until you ask for it with `--show-secrets`.
- **The username is `admin`.**
- **Where the URL comes from:**
  - With `LoadBalancer`, `grafanaUrl` is the load balancer's public IP.
  - With `NodePort`, it shows the node port. On minikube, run `minikube service -n monitoring monitoring-grafana --url`. On kind, use the `kubectl port-forward` command that the output also includes, then open http://localhost:3000.
  - If no address is available yet, it prints a `kubectl port-forward` command instead.

The Guestbook app's own URL is `pulumi stack output frontendUrl`.

## Verify that Prometheus is scraping the Guestbook

### Option 1: one script

```bash
./scripts/verify-metrics.sh
```

This script:

1. port-forwards to Prometheus
2. sends 20 requests to the frontend
3. lists the Guestbook scrape targets (all 5 should show `up`: 3 frontend pods, the Redis leader and the replica)
4. queries the app metrics

It **exits non-zero** if any exporter target is down, the probe target is down, or a metric has no data, and it ends with `ALL CHECKS PASSED` when everything is healthy.

Example output:

```
== 2. Guestbook scrape targets (health should be 'up')
frontend-metrics  frontend-...-2pddp      up
frontend-metrics  frontend-...-mlv8h      up
frontend-metrics  frontend-...-nvw5q      up
redis-metrics     redis-replica-...-bg8hl up
redis-metrics     redis-leader-...-qmkvv  up
== 3. Metrics
-- sum by (pod) (apache_accesses_total{namespace="guestbook"})
frontend-...-2pddp   104
...
ALL CHECKS PASSED
```

### Option 2: the Prometheus UI

```bash
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```

1. Open http://localhost:9090/targets. The pools `serviceMonitor/guestbook/guestbook-frontend/0`, `serviceMonitor/guestbook/guestbook-redis/0` and `probe/guestbook/guestbook-frontend` should all be green (UP).
2. In the **Query** tab, try:
   - `rate(apache_accesses_total{namespace="guestbook"}[2m])` for frontend requests per second, per pod
   - `rate(redis_commands_processed_total{namespace="guestbook"}[2m])` for Redis commands per second
   - `redis_master_link_up{namespace="guestbook"}`, where 1 means the replica is in sync with the leader
   - `sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",container!=""}[5m]))` for pod CPU

### Option 3: Grafana

1. Log in.
2. Open **Dashboards → Guestbook Overview**. Every panel should show data within about a minute.
3. Alternatively, use **Explore** with the queries above.

## Dashboard

**Guestbook Overview** (`dashboards/guestbook-overview.json`) is delivered as a ConfigMap labelled `grafana_dashboard: "1"`. Grafana's dashboard sidecar watches for that label and loads it automatically, so no manual import is needed. The dashboard has four parts:

- **Top row:** frontend request rate, scrape targets healthy (up ÷ the pods the Deployments want), Redis operations per second, container restarts and the Redis replication link
- **Traffic and saturation:** requests per second by pod, Apache busy workers, Redis commands and Redis clients
- **Resources:** pod CPU and working-set memory (from cAdvisor)
- **SLOs and error budget:** availability and latency against target, the error budget left, probe response time, and burn rate with alert-threshold lines

## Beyond the brief: SLOs and burn-rate alerting

The rubric asks for basic metrics. Alerting on raw metrics, such as paging when CPU is high, creates noise. SREs alert on **user-visible symptoms measured against an SLO** instead. `slo.ts` defines the SLOs as data and generates the Prometheus rules from them, in the same way tools like Sloth and Pyrra do.

| SLO | SLI (what is measured) | Objective | Error budget (30 days) |
|---|---|---|---|
| `guestbook-availability` | Blackbox probes returning HTTP 2xx | 99.5% | 0.5%, about 3.6 hours of downtime (864 failed probes) |
| `guestbook-latency` | Probes that succeed in under 300 ms | 99% | 1% |

**Why a synthetic probe?** The PHP/Apache frontend exposes no per-status-code metrics. A probe that requests the page through the Service, the way a user does, is the most honest availability signal available without changing the app.

**Alerts** (`PrometheusRule guestbook/guestbook-slo`). These follow the multi-window, multi-burn-rate method from the Google SRE Workbook:

| Alert | Fires when (both windows) | Budget spent before firing | Severity |
|---|---|---|---|
| `…ErrorBudgetBurnFast` | burn > 14.4× over 1h **and** 5m | 2% | critical (page) |
| `…ErrorBudgetBurnFast` | burn > 6× over 6h **and** 30m | 5% | critical (page) |
| `…ErrorBudgetBurnSlow` | burn > 3× over 1d **and** 2h | 10% | warning (ticket) |
| `…ErrorBudgetBurnSlow` | burn > 1× over 3d **and** 6h | 10% | warning (ticket) |
| `GuestbookSloProbeMissing` | no probe data for 5m | n/a | warning |
| `GuestbookRedisReplicationDown` | replica not syncing for 2m | n/a | critical |

What the two windows do:

- **Burn rate** is how much faster than "exactly on budget" the budget is being spent.
- **The long window** proves that real budget has been lost.
- **The short window** proves the problem is still happening. It also makes the alert clear soon after the service recovers.

**The latency SLI is recorded every 15 s, the probe interval, in its own rule group.** A recording rule only sees the newest probe at each evaluation, so recording every 30 s would skip every other probe. A unit test guards this interval, because promtool ignores per-group intervals.

**Error budget remaining** is measured against the bad events allowed in a *full* 30-day period. It is not measured against the data collected so far, so a freshly installed or restarted Prometheus can't report a huge negative budget.

**Tested, not just written:** `./scripts/test-rules.sh` runs `promtool check rules` and `promtool test rules`. The tests replay synthetic probe data and check that:

- a healthy hour pages nobody
- a 10-minute outage triggers both fast-burn pages, but not the slow-burn ticket (the ticket needs `for: 15m`)
- the error budget left after that outage is exactly 1 − 41/864
- the replication and missing-probe alerts fire
- regressions found in code review: when every other probe fails, both SLIs report 50% errors; probes that succeed but take 500 ms page on latency only

### Outage drill

```bash
./scripts/slo-demo.sh
```

The script scales the frontend to 0 and prints the burn rate every 30 s until the fast-burn alert fires. It then restores the frontend, and also does so on Ctrl-C. Watch the **SLOs & error budget** row in Grafana while it runs. A recorded run on a freshly installed cluster:

```
+  0s  probe_success=1  error_ratio_5m=0    burn_1h=0x     alert=inactive
+ 63s  probe_success=0  error_ratio_5m=0.1  burn_1h=13.8x  alert=pending
+188s  probe_success=0  error_ratio_5m=0.6  burn_1h=61.5x  alert=firing
== GuestbookAvailabilityErrorBudgetBurnFast is FIRING after 189s
```

On a fresh install the long windows hold less than their full history, so the alerts are more sensitive at first. For example, the 6h/30m pair can stay firing until the outage leaves the 30-minute window. With full history, the 1h/5m page fires about 6–7 minutes into a total outage.

## Tests

```bash
npm test                  # 16 Pulumi unit tests with mocks - no cluster needed
./scripts/test-rules.sh   # promtool: validate and unit-test the SLO alert rules (needs Docker)
```

The unit tests check the wiring that makes monitoring work:

- each ServiceMonitor selects a Service that has a `metrics` port and is not public
- the metrics Services select the pods that actually run the exporters
- the Grafana password is generated and kept secret
- every SLO series the dashboard queries is produced by a recording rule
- the burn-rate thresholds are correct

### Browser end-to-end tests (optional)

These are real Chromium tests, using Playwright, against the deployed stack. They live in `e2e/` with their own `package.json`, so the main install stays small. They read the URLs and the Grafana password from `pulumi stack output` and open their own Prometheus port-forward.

```bash
cd e2e
npm install && npx playwright install chromium
npm test              # 8 tests, about 1 minute, read-only apart from one guestbook message (restored afterwards)
npm run test:drill    # optional outage drill in the browser (scales the frontend to 0, about 5-8 minutes)
HEADLESS=1 npm test   # no browser window, for CI or a machine without a display
```

By default the tests open a visible Chromium window so you can watch each step. They need a display (a desktop session, or WSLg on Windows). Set `HEADLESS=1` to run without one.

What the tests check:

- **Guestbook:** a submitted message survives a page reload, which proves it was written to the Redis leader and read back from the replica. Ten page views must show up in Prometheus's request counter.
- **Grafana:** anonymous visitors are redirected to login, and a wrong password is rejected. The wrong-password test uses a separate username, because Grafana's brute-force protection would otherwise lock out `admin`. The Pulumi-output credentials work, and the Prometheus datasource is healthy. All 18 dashboard panels render with data and no errors; scrape targets show 100% and replication shows UP.
- **Prometheus UI:** each Guestbook scrape pool shows all of its targets up (3, 2 and 1). All 31 SLO rules are loaded and healthy. Any alert that is firing is recorded as a test note, not a failure, because the slow-burn alerts stay firing for hours after a real outage or a drill.
- **Drill:** during the outage the site fails for users, `GuestbookAvailabilityErrorBudgetBurnFast` reaches *firing*, and the error budget drops. After the frontend is restored, the site loads again.

Screenshots are saved in `e2e/screenshots/`.

## Design decisions

- **`helm.v3.Release` rather than `helm.v3.Chart`.** kube-prometheus-stack ships large CRDs and relies on Helm hooks. `Release` runs a real Helm install, with hooks and `--wait`, so Pulumi only reads the Grafana Service once its load balancer has an address. `Chart` renders templates client-side and has known problems with this chart's CRDs.
- **Sidecar exporters rather than changing the app.** The application images stay unchanged. Each exporter scales with its pod automatically, and the localhost-only status page never leaves the pod.
- **ServiceMonitors rather than `prometheus.io/scrape` annotations.** kube-prometheus-stack uses the Prometheus Operator, which ignores those annotations. `serviceMonitorSelectorNilUsesHelmValues: false` (and the equivalent settings for Probes and Rules) lets Prometheus discover ServiceMonitors in the `guestbook` namespace.
- **Control-plane scrapes are disabled.** Managed control planes (AKS, EKS, GKE) don't expose the scheduler, controller-manager, etcd or kube-proxy to the cluster. Leaving those scrapes on only creates permanently-down targets and false alerts.
- **Versions are pinned.** This covers the chart versions, the exporter images and the Redis image.

### A bug found in the upstream example

The upstream example runs the Redis leader as `redis` (latest, now 8.x), while `pulumi/guestbook-redis-replica` contains **Redis 6.0.5**. A newer leader sends a replication snapshot in an RDB format the old replica can't load (`Can't handle RDB format version 12`). The replica therefore never syncs, and because the frontend reads from the replica, every message you submit seems to disappear.

The fix pins the leader to `redis:6.0.5`. A unit test guards the versions, and the new `redis_master_link_up` panel and `GuestbookRedisReplicationDown` alert make this failure visible if it ever happens again.

## Limitations and production next steps

- **Prometheus storage is the pod's `emptyDir`,** so history is lost if the pod is rescheduled. Production would add a PersistentVolume via `prometheusSpec.storageSpec`, or remote-write to long-term storage such as Thanos, Mimir or Azure Managed Prometheus.
- **Alertmanager has no receivers configured.** Alerts are visible in Prometheus and Alertmanager but notify no one. Production would route `critical` to a pager such as PagerDuty or Opsgenie and `warning` to a ticket queue or Slack.
- **Bundled alerts you will see firing:**
  - `Watchdog` fires constantly by design. It is a dead man's switch that proves the alerting pipeline works.
  - On a small 2-node cluster, `KubeCPUOvercommit` also fires. It is a true capacity warning: the pods' CPU requests could not be rescheduled if one node failed. Production would size for N+1.
- **Grafana is exposed over plain HTTP on a public IP.** Production would put it behind an Ingress with TLS and SSO, or keep it private.
- **The availability SLI is synthetic,** from one probe location. Request-based SLIs from real traffic would need per-status-code metrics from the app or an ingress controller (for example NGINX or Envoy).

## Clean up

```bash
pulumi destroy             # removes everything this stack created, including both namespaces
pulumi stack rm dev        # optional: delete the stack's history
./scripts/destroy-aks.sh   # only if you created the cluster with create-aks.sh
```

Helm deliberately never deletes CRDs, so the Prometheus Operator CRDs stay after `pulumi destroy`. That's harmless, but on a shared cluster leave them, because other monitoring may use them. To remove them on a cluster of your own:

```bash
kubectl get crd -o name | grep monitoring.coreos.com | xargs kubectl delete
```

## License

Apache License 2.0, see [LICENSE](LICENSE). `guestbook.ts` is adapted from the Apache-2.0 [Pulumi Kubernetes Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook); see [NOTICE](NOTICE).
