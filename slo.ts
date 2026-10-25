// SLOs for the Guestbook frontend, with multi-window, multi-burn-rate alerts
// (Google SRE Workbook, "Alerting on SLOs").
//
// SLI source: a blackbox-exporter Probe requests the frontend Service from inside the cluster every
// 15s, the way a user would. Each probe is one "event", good or bad, so
//   error ratio over a window = 1 - avg_over_time(good[window])
// The PHP/Apache frontend exposes no per-status-code metrics, so a synthetic probe is the most honest
// availability signal available without modifying the application.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export const BLACKBOX_CHART_VERSION = "11.20.2";
export const PROBE_JOB = "guestbook-frontend-probe";
export const PROBE_TARGET = "http://frontend.guestbook.svc.cluster.local/";
export const LATENCY_THRESHOLD_SECONDS = 0.3;
export const PROBE_INTERVAL = "15s";

export interface Slo {
    name: string;
    description: string;
    objective: number;   // e.g. 0.995 = 99.5% of probes must be good over the SLO period
    goodSeries: string;  // 0/1 series per probe: 1 = good event
    sampleSeconds: number; // how often goodSeries gets a new sample (= probe interval)
}

export const SLOS: Slo[] = [
    {
        name: "guestbook-availability",
        description: "99.5% of frontend probes succeed (HTTP 2xx)",
        objective: 0.995,
        goodSeries: `probe_success{job="${PROBE_JOB}"}`,
        sampleSeconds: 15,
    },
    {
        name: "guestbook-latency",
        description: `99% of frontend probes succeed in under ${LATENCY_THRESHOLD_SECONDS * 1000} ms`,
        objective: 0.99,
        goodSeries: "slo:probe_good_latency:bool",
        sampleSeconds: 15,
    },
];

// Burn rate = how many times faster than "exactly on budget" the error budget is being spent.
// Each alert needs BOTH a long window (enough budget really burned) and a short window
// (still burning now), so it fires fast on big outages and resets fast once fixed.
// Budget consumed before firing, for a 30-day SLO period: 14.4 over 1h = 2%, 6 over 6h = 5%,
// 3 over 1d = 10%, 1 over 3d = 10%.
export const BURN_RATE_ALERTS = [
    { severity: "critical", long: "1h", short: "5m", burnRate: 14.4 },
    { severity: "critical", long: "6h", short: "30m", burnRate: 6 },
    { severity: "warning", long: "1d", short: "2h", burnRate: 3 },
    { severity: "warning", long: "3d", short: "6h", burnRate: 1 },
];
export const SLO_PERIOD = "30d";
const SLO_PERIOD_SECONDS = 30 * 24 * 3600;

const WINDOWS = Array.from(new Set(BURN_RATE_ALERTS.flatMap(a => [a.short, a.long]).concat(SLO_PERIOD)));
const round = (n: number) => Number(n.toPrecision(6));
const pascal = (s: string) => s.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join("");

export function sloRuleGroups(slos: Slo[] = SLOS) {
    // A probe is good for latency only if it succeeded AND was fast. A recording rule only sees the
    // latest probe at each evaluation, so it must run at the probe interval: at 30s it would skip
    // every other probe and could miss an outage entirely.
    const latencyEvents = {
        name: "slo-latency-events.rules",
        interval: PROBE_INTERVAL,
        rules: [{
            record: "slo:probe_good_latency:bool",
            expr: `(probe_success{job="${PROBE_JOB}"} == bool 1) * (probe_duration_seconds{job="${PROBE_JOB}"} < bool ${LATENCY_THRESHOLD_SECONDS})`,
        }],
    };
    const sli = {
        name: "slo-sli.rules",
        interval: "30s",
        rules: [
            ...slos.flatMap(slo => [
                ...WINDOWS.map(w => ({
                    record: `slo:sli_error:ratio_rate${w}`,
                    expr: `1 - avg(avg_over_time(${slo.goodSeries}[${w}]))`,
                    labels: { slo: slo.name },
                })),
                { record: "slo:objective:ratio", expr: `vector(${slo.objective})`, labels: { slo: slo.name } },
                {
                    // Budget = bad events allowed in a FULL period (e.g. 0.5% of 172,800 probes = 864).
                    // Dividing by the full period, not by the data collected so far, keeps a young
                    // or recently restarted Prometheus from reporting a huge negative budget.
                    record: "slo:error_budget_remaining:ratio",
                    expr: `1 - (sum(count_over_time(${slo.goodSeries}[${SLO_PERIOD}]) - sum_over_time(${slo.goodSeries}[${SLO_PERIOD}])) / ` +
                        `${round((1 - slo.objective) * SLO_PERIOD_SECONDS / slo.sampleSeconds)})`,
                    labels: { slo: slo.name },
                },
            ]),
        ],
    };

    const alerts = {
        name: "slo-burn-rate.alerts",
        rules: [
            ...slos.flatMap(slo => BURN_RATE_ALERTS.map(a => {
                const threshold = round(a.burnRate * (1 - slo.objective));
                const sel = `{slo="${slo.name}"}`;
                return {
                    alert: `${pascal(slo.name)}ErrorBudgetBurn${a.severity === "critical" ? "Fast" : "Slow"}`,
                    expr: `slo:sli_error:ratio_rate${a.long}${sel} > ${threshold} and slo:sli_error:ratio_rate${a.short}${sel} > ${threshold}`,
                    for: a.severity === "critical" ? "2m" : "15m",
                    labels: { severity: a.severity, slo: slo.name, long_window: a.long },
                    annotations: {
                        summary: `${slo.name}: error budget burning at ${a.burnRate}x over ${a.long}`,
                        description: `${slo.description}. Error ratio is above ${threshold} over both ${a.long} and ${a.short}; ` +
                            `at this pace the ${SLO_PERIOD} budget runs out in ${round(30 / a.burnRate)} days.`,
                    },
                };
            })),
            {
                // Without probe data the SLO alerts above can never fire, so alert on the gap itself.
                alert: "GuestbookSloProbeMissing",
                expr: `absent(probe_success{job="${PROBE_JOB}"})`,
                for: "5m",
                labels: { severity: "warning" },
                annotations: {
                    summary: "No blackbox probe data for the Guestbook frontend",
                    description: "SLO alerts are blind while this fires. Check the blackbox-exporter pod and the Probe resource.",
                },
            },
            {
                alert: "GuestbookRedisReplicationDown",
                expr: `min(redis_master_link_up{namespace="guestbook"}) == 0`,
                for: "2m",
                labels: { severity: "critical" },
                annotations: {
                    summary: "Redis replica is not syncing from the leader",
                    description: "The frontend reads from the replica, so new guestbook messages will not appear. " +
                        "Check `kubectl -n guestbook logs deploy/<redis-replica> -c replica` (e.g. RDB format/version mismatch).",
                },
            },
        ],
    };

    return [latencyEvents, sli, alerts];
}

export function deploySlo(args: { namespace: pulumi.Input<string>; monitoringNamespace: string },
                          opts: pulumi.CustomResourceOptions) {
    const blackbox = new k8s.helm.v3.Release("blackbox-exporter", {
        name: "blackbox",
        chart: "prometheus-blackbox-exporter",
        version: BLACKBOX_CHART_VERSION,
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        namespace: args.monitoringNamespace,
        values: {
            fullnameOverride: "blackbox-exporter",
            resources: { requests: { cpu: "10m", memory: "20Mi" }, limits: { memory: "64Mi" } },
        },
    }, opts);

    new k8s.apiextensions.CustomResource("frontend-probe", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "Probe",
        metadata: { name: "guestbook-frontend", namespace: args.namespace },
        spec: {
            jobName: PROBE_JOB,
            interval: PROBE_INTERVAL,
            module: "http_2xx",
            prober: { url: `blackbox-exporter.${args.monitoringNamespace}.svc:9115` },
            targets: { staticConfig: { static: [PROBE_TARGET] } },
        },
    }, { ...opts, dependsOn: [blackbox] });

    new k8s.apiextensions.CustomResource("slo-rules", {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "PrometheusRule",
        metadata: { name: "guestbook-slo", namespace: args.namespace },
        spec: { groups: sloRuleGroups() },
    }, opts);
}
