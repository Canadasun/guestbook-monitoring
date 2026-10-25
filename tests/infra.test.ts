// Unit tests: run the Pulumi program against mocks (no cluster needed) and check the wiring that
// makes monitoring work - exporters, metrics Services, ServiceMonitor selectors, secrets, outputs.

import { test, before } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";

interface Created { type: string; name: string; inputs: any; }
const created: Created[] = [];

pulumi.runtime.setMocks({
    newResource(args: pulumi.runtime.MockResourceArgs) {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        const state: any = { ...args.inputs };
        if (args.type === "kubernetes:helm.sh/v3:Release") {
            state.status = { name: args.inputs.name, namespace: args.inputs.namespace };
        }
        if (args.type === "kubernetes:core/v1:Namespace") {
            state.metadata = { ...args.inputs.metadata, name: args.inputs.metadata?.name ?? args.name };
        }
        if (args.type === "kubernetes:core/v1:Service" && args.name === "grafana-service") {
            state.spec = { type: "LoadBalancer", ports: [{ port: 80 }] };
            state.status = { loadBalancer: { ingress: [{ ip: "20.1.2.3" }] } };
        }
        if (args.type === "random:index/randomPassword:RandomPassword") {
            state.result = "mock-generated-password";
        }
        return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
}, "guestbook-monitoring", "test", false);

let program: any;
before(async () => {
    program = require("../index");
    // Let all resource registrations settle.
    await new Promise(r => setTimeout(r, 200));
});

const value = <T>(o: pulumi.Output<T>) => new Promise<T>(r => o.apply(v => { r(v); return v; }));
const isSecret = (o: pulumi.Output<any>) => (o as any).isSecret as Promise<boolean>;
const byName = (type: string, name: string) => {
    const r = created.find(c => c.type === type && c.name === name);
    assert.ok(r, `expected ${type} ${name}`);
    return r!;
};
const containers = (deployment: string) =>
    byName("kubernetes:apps/v1:Deployment", deployment).inputs.spec.template.spec.containers as any[];

test("frontend pods run an apache_exporter sidecar that reads mod_status on localhost", () => {
    const sidecar = containers("frontend").find(c => c.name === "apache-exporter");
    assert.ok(sidecar);
    assert.deepEqual(sidecar.args, ["--scrape_uri=http://localhost/server-status?auto"]);
    assert.equal(sidecar.ports[0].name, "metrics");
});

test("redis leader and replica both run a redis_exporter sidecar", () => {
    for (const d of ["redis-leader", "redis-replica"]) {
        const sidecar = containers(d).find(c => c.name === "redis-exporter");
        assert.ok(sidecar, d);
        assert.equal(sidecar.env[0].value, "redis://localhost:6379");
    }
});

test("every ServiceMonitor selects a metrics Service that has a 'metrics' port and is not public", () => {
    const monitors = created.filter(c => c.inputs.kind === "ServiceMonitor");
    assert.equal(monitors.length, 2);
    for (const m of monitors) {
        const want = m.inputs.spec.selector.matchLabels;
        const svc = created.find(c => c.type === "kubernetes:core/v1:Service" &&
            Object.entries(want).every(([k, v]) => c.inputs.metadata?.labels?.[k] === v));
        assert.ok(svc, `no Service matches ${JSON.stringify(want)}`);
        assert.equal(m.inputs.metadata.namespace, "guestbook");
        assert.equal(m.inputs.spec.endpoints[0].port, "metrics");
        assert.ok(svc!.inputs.spec.ports.some((p: any) => p.name === "metrics"));
        assert.equal(svc!.inputs.spec.type, undefined, "metrics Service must stay ClusterIP");
    }
});

test("metrics Services select the pods that actually run the exporters", () => {
    const frontendPods = byName("kubernetes:apps/v1:Deployment", "frontend").inputs.spec.template.metadata.labels;
    const sel = byName("kubernetes:core/v1:Service", "frontend-metrics").inputs.spec.selector;
    assert.ok(Object.entries(sel).every(([k, v]) => frontendPods[k] === v));
    for (const d of ["redis-leader", "redis-replica"]) {
        const pods = byName("kubernetes:apps/v1:Deployment", d).inputs.spec.template.metadata.labels;
        const rsel = byName("kubernetes:core/v1:Service", "redis-metrics").inputs.spec.selector;
        assert.ok(Object.entries(rsel).every(([k, v]) => pods[k] === v), d);
    }
});

test("redis leader runs the same Redis version as the replica image so replication can sync", () => {
    const { REDIS_IMAGE } = require("../guestbook");
    const leader = containers("redis-leader").find(c => c.name === "redis-leader");
    assert.equal(leader.image, REDIS_IMAGE);
    // pulumi/guestbook-redis-replica ships Redis 6.0.5; a newer leader breaks the RDB sync.
    assert.equal(REDIS_IMAGE, "redis:6.0.5");
});

test("kube-prometheus-stack is pinned, picks up our ServiceMonitors, and exposes Grafana", () => {
    const rel = byName("kubernetes:helm.sh/v3:Release", "kube-prometheus-stack").inputs;
    // Values contain the Grafana password, so Pulumi passes the whole object as a secret.
    assert.equal(rel.values[pulumi.runtime.specialSigKey], pulumi.runtime.specialSecretSig);
    rel.values = rel.values.value;
    assert.equal(rel.chart, "kube-prometheus-stack");
    assert.match(rel.version, /^\d+\.\d+\.\d+$/);
    assert.equal(rel.values.prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues, false);
    assert.equal(rel.values.grafana.service.type, "LoadBalancer");
    assert.equal(rel.values.grafana.sidecar.dashboards.label, "grafana_dashboard");
});

test("Grafana password is generated, not hard-coded, and exported as a secret", async () => {
    assert.ok(await isSecret(program.grafanaAdminPassword));
    assert.equal(await value(program.grafanaAdminPassword), "mock-generated-password");
    const source = fs.readFileSync(path.join(__dirname, "..", "monitoring.ts"), "utf8");
    assert.doesNotMatch(source, /adminPassword:\s*["']/);
});

test("outputs the Grafana URL from the LoadBalancer and the admin user", async () => {
    assert.equal(await value(program.grafanaUrl), "http://20.1.2.3");
    assert.equal(program.grafanaAdminUser, "admin");
});

test("Grafana URL output is usable for LoadBalancer, NodePort and pending clusters", () => {
    const { grafanaUrlFor } = require("../monitoring");
    assert.equal(grafanaUrlFor({ type: "LoadBalancer" }, { loadBalancer: { ingress: [{ hostname: "lb.example.com" }] } }),
        "http://lb.example.com");
    const nodePort = grafanaUrlFor({ type: "NodePort", ports: [{ nodePort: 31234 }] }, {});
    assert.match(nodePort, /NodePort 31234/);
    assert.match(nodePort, /port-forward svc\/monitoring-grafana 3000:80/, "kind needs the portable fallback");
    // LoadBalancer still waiting for an address (or ClusterIP): fall back to port-forward.
    assert.match(grafanaUrlFor({ type: "LoadBalancer" }, { loadBalancer: {} }), /^kubectl -n monitoring port-forward/);
    assert.match(grafanaUrlFor({ type: "ClusterIP" }), /^kubectl -n monitoring port-forward/);
});

test("dashboard ConfigMap carries the sidecar label and valid dashboard JSON", () => {
    const cm = byName("kubernetes:core/v1:ConfigMap", "guestbook-dashboard").inputs;
    assert.equal(cm.metadata.labels.grafana_dashboard, "1");
    const dash = JSON.parse(cm.data["guestbook-overview.json"]);
    assert.equal(dash.uid, "guestbook-overview");
    const ids = dash.panels.map((p: any) => p.id);
    assert.equal(new Set(ids).size, ids.length, "panel ids must be unique");
    for (const p of dash.panels.filter((p: any) => p.type !== "row")) {
        assert.equal(p.datasource.uid, "prometheus", p.title);
        for (const t of p.targets) {
            assert.match(t.expr, /namespace="guestbook"|slo="guestbook-|job="guestbook-frontend-probe"/, p.title);
        }
    }
});

test("every recorded SLO series the dashboard queries is produced by a rule", () => {
    const { sloRuleGroups } = require("../slo");
    const recorded = new Set(sloRuleGroups().flatMap((g: any) => g.rules.map((r: any) => r.record)).filter(Boolean));
    const dash = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dashboards", "guestbook-overview.json"), "utf8"));
    const used = dash.panels.flatMap((p: any) => (p.targets ?? []).map((t: any) => t.expr))
        .flatMap((e: string) => e.match(/slo:[a-z_:0-9]+/g) ?? []);
    assert.ok(used.length > 0);
    for (const series of used) assert.ok(recorded.has(series), `${series} is not recorded by any rule`);
});

test("blackbox Probe targets the frontend Service through the blackbox exporter", () => {
    const probe = created.find(c => c.inputs.kind === "Probe")!.inputs;
    assert.equal(probe.metadata.namespace, "guestbook");
    assert.equal(probe.spec.module, "http_2xx");
    assert.deepEqual(probe.spec.targets.staticConfig.static, ["http://frontend.guestbook.svc.cluster.local/"]);
    assert.match(probe.spec.prober.url, /^blackbox-exporter\.monitoring\.svc:9115$/);
});

test("burn-rate alerts use the SRE Workbook windows and thresholds for each SLO", () => {
    const rule = created.find(c => c.inputs.kind === "PrometheusRule")!.inputs;
    const alerts = rule.spec.groups.flatMap((g: any) => g.rules).filter((r: any) => r.alert);
    const avail = alerts.filter((a: any) => a.labels.slo === "guestbook-availability");
    assert.deepEqual(avail.map((a: any) => [a.labels.long_window, a.labels.severity]),
        [["1h", "critical"], ["6h", "critical"], ["1d", "warning"], ["3d", "warning"]]);
    // 14.4x burn of a 0.5% budget = 7.2% errors, over both the 1h and 5m windows.
    assert.match(avail[0].expr, /ratio_rate1h\{slo="guestbook-availability"\} > 0\.072 and .*ratio_rate5m.* > 0\.072$/);
    assert.ok(alerts.some((a: any) => a.alert === "GuestbookSloProbeMissing"));
});

test("latency events are recorded at the probe interval so no probe is skipped", () => {
    // promtool ignores per-group intervals, so this guard has to live here.
    const { sloRuleGroups, PROBE_INTERVAL, SLOS } = require("../slo");
    const group = sloRuleGroups().find((g: any) => g.rules.some((r: any) => r.record === "slo:probe_good_latency:bool"));
    assert.equal(group.interval, PROBE_INTERVAL);
    const probe = created.find(c => c.inputs.kind === "Probe")!.inputs;
    assert.equal(probe.spec.interval, PROBE_INTERVAL);
    for (const slo of SLOS) assert.equal(`${slo.sampleSeconds}s`, PROBE_INTERVAL, slo.name);
});

test("the monitoring namespace is a Pulumi resource, so destroy removes it", () => {
    const rel = byName("kubernetes:helm.sh/v3:Release", "kube-prometheus-stack").inputs;
    assert.equal(rel.createNamespace, undefined);
    assert.equal(byName("kubernetes:core/v1:Namespace", "monitoring").inputs.metadata.name, rel.namespace);
});

test("Prometheus also picks up Probes and PrometheusRules from every namespace", () => {
    const values = byName("kubernetes:helm.sh/v3:Release", "kube-prometheus-stack").inputs.values;
    const spec = (values.value ?? values).prometheus.prometheusSpec;
    assert.equal(spec.probeSelectorNilUsesHelmValues, false);
    assert.equal(spec.ruleSelectorNilUsesHelmValues, false);
    assert.equal(spec.retention, "30d");
});
