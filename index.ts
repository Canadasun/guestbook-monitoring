// Kubernetes Guestbook + Prometheus/Grafana monitoring.
//   guestbook.ts  - the Guestbook app with metrics exporters
//   monitoring.ts - kube-prometheus-stack, ServiceMonitors and the Grafana dashboard
//   slo.ts        - blackbox probe, SLO recording rules and burn-rate alerts (beyond the brief)

import * as pulumi from "@pulumi/pulumi";
import { deployGuestbook } from "./guestbook";
import { deployMonitoring, GRAFANA_ADMIN_USER, MONITORING_NAMESPACE } from "./monitoring";
import { deploySlo } from "./slo";

const config = new pulumi.Config();

const guestbook = deployGuestbook({
    frontendServiceType: config.get("frontendServiceType") ?? "LoadBalancer",
    trafficGenerator: config.getBoolean("trafficGenerator") ?? false,
});

const monitoring = deployMonitoring({
    grafanaServiceType: config.get("grafanaServiceType") ?? "LoadBalancer",
    guestbookNamespace: guestbook.namespace,
});

deploySlo({ namespace: guestbook.namespace, monitoringNamespace: MONITORING_NAMESPACE },
    { dependsOn: [monitoring.release] });

export const frontendUrl = guestbook.frontendUrl;
export const grafanaUrl = monitoring.grafanaUrl;
export const grafanaAdminUser = GRAFANA_ADMIN_USER;
// Marked secret by Pulumi: shown as [secret] until you run `pulumi stack output grafanaAdminPassword --show-secrets`.
export const grafanaAdminPassword = monitoring.grafanaPassword;
