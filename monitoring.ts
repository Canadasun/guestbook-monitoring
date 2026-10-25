// Prometheus + Grafana via the kube-prometheus-stack Helm chart, plus the Guestbook-specific pieces:
// ServiceMonitors (what Prometheus should scrape) and a Grafana dashboard delivered as a ConfigMap.

import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

export const CHART_VERSION = "92.13.1";
export const RELEASE_NAME = "monitoring";
export const MONITORING_NAMESPACE = "monitoring";
export const GRAFANA_ADMIN_USER = "admin";

export interface MonitoringArgs {
    grafanaServiceType: string;
    guestbookNamespace: pulumi.Input<string>;
}

export function deployMonitoring(args: MonitoringArgs) {
    // Generated once and kept in the (encrypted) Pulumi state; never written to git.
    const grafanaPassword = new random.RandomPassword("grafana-admin-password", {
        length: 20,
        special: false,
    });
    // Wrap explicitly so the value stays encrypted in state, Helm values and stack outputs.
    const adminPassword = pulumi.secret(grafanaPassword.result);

    // Owned by Pulumi (not Helm's createNamespace) so `pulumi destroy` removes it too.
    const ns = new k8s.core.v1.Namespace("monitoring", { metadata: { name: MONITORING_NAMESPACE } });

    const stack = new k8s.helm.v3.Release("kube-prometheus-stack", {
        name: RELEASE_NAME,
        chart: "kube-prometheus-stack",
        version: CHART_VERSION,
        repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
        namespace: ns.metadata.name,
        timeout: 900,
        values: {
            grafana: {
                adminUser: GRAFANA_ADMIN_USER,
                adminPassword,
                service: { type: args.grafanaServiceType },
                // The sidecar loads every ConfigMap labelled grafana_dashboard=1 as a dashboard.
                sidecar: { dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1" } },
            },
            prometheus: {
                prometheusSpec: {
                    // By default the operator only picks up ServiceMonitors carrying this Helm release's
                    // label; false makes it pick up ServiceMonitors from every namespace (ours included).
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    probeSelectorNilUsesHelmValues: false,
                    ruleSelectorNilUsesHelmValues: false,
                    // Long enough for the 30-day SLO window. Storage is the pod's emptyDir (lost on
                    // reschedule); production would add a PersistentVolume via storageSpec.
                    retention: "30d",
                    retentionSize: "4GB",
                    resources: { requests: { cpu: "100m", memory: "400Mi" } },
                },
            },
            alertmanager: {
                alertmanagerSpec: { resources: { requests: { cpu: "10m", memory: "32Mi" } } },
            },
            // Managed control planes (AKS/EKS/GKE) hide these components, so scraping them only
            // produces permanently-down targets and noisy alerts.
            kubeControllerManager: { enabled: false },
            kubeScheduler: { enabled: false },
            kubeEtcd: { enabled: false },
            kubeProxy: { enabled: false },
        },
    });

    // ServiceMonitor CRDs are installed by the chart, so these must wait for the release.
    const after = { dependsOn: [stack] };
    for (const app of ["frontend", "redis"]) {
        new k8s.apiextensions.CustomResource(`${app}-servicemonitor`, {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: { name: `guestbook-${app}`, namespace: args.guestbookNamespace },
            spec: {
                selector: { matchLabels: { app, monitoring: "guestbook" } },
                endpoints: [{ port: "metrics", interval: "15s" }],
            },
        }, after);
    }

    const dashboardJson = fs.readFileSync(path.join(__dirname, "dashboards", "guestbook-overview.json"), "utf8");
    new k8s.core.v1.ConfigMap("guestbook-dashboard", {
        metadata: {
            name: "guestbook-dashboard",
            namespace: ns.metadata.name,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook-overview.json": dashboardJson },
    }, after);

    // Read the Grafana Service the chart created; by now Helm has waited for its load balancer.
    const grafanaService = k8s.core.v1.Service.get("grafana-service",
        pulumi.interpolate`${stack.status.namespace}/${stack.status.name}-grafana`, after);

    const grafanaUrl = pulumi.all([grafanaService.spec, grafanaService.status])
        .apply(([spec, status]) => grafanaUrlFor(spec, status));

    return { grafanaUrl, grafanaPassword: adminPassword, release: stack };
}

// Works on any cluster, including kind where node IPs are not reachable from the host.
const PORT_FORWARD = `kubectl -n ${MONITORING_NAMESPACE} port-forward svc/${RELEASE_NAME}-grafana 3000:80  ->  http://localhost:3000`;

export function grafanaUrlFor(spec: { type?: string; ports?: { nodePort?: number }[] },
                              status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } }): string {
    const ingress = status?.loadBalancer?.ingress?.[0];
    const host = ingress?.ip ?? ingress?.hostname;
    if (spec.type === "LoadBalancer" && host) {
        return `http://${host}`;
    }
    if (spec.type === "NodePort") {
        const nodePort = spec.ports?.[0]?.nodePort;
        return `NodePort ${nodePort} on any node IP (minikube: 'minikube service -n ${MONITORING_NAMESPACE} ${RELEASE_NAME}-grafana --url'); ` +
            `portable: ${PORT_FORWARD}`;
    }
    return PORT_FORWARD;
}
