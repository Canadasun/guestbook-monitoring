// The Guestbook application from pulumi/examples (kubernetes-ts-guestbook/simple), moved into its own
// namespace and extended with Prometheus exporters:
//   - frontend (PHP/Apache): apache_exporter sidecar reads Apache's mod_status page on localhost
//   - redis leader/replica:  redis_exporter sidecar talks to Redis on localhost
// Each tier gets a ClusterIP "metrics" Service so the metrics port is never exposed publicly.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export const APACHE_EXPORTER_IMAGE = "lusotycoon/apache-exporter:v1.1.1";
// Must match the Redis version inside pulumi/guestbook-redis-replica (6.0.5): a newer leader sends a
// replication snapshot (RDB format) the replica cannot load, so it never syncs and reads come back empty.
export const REDIS_IMAGE = "redis:6.0.5";
export const REDIS_EXPORTER_IMAGE = "oliver006/redis_exporter:v1.96.0";

export interface GuestbookArgs {
    frontendServiceType: string;
    trafficGenerator: boolean;
}

export function deployGuestbook(args: GuestbookArgs) {
    const ns = new k8s.core.v1.Namespace("guestbook", { metadata: { name: "guestbook" } });
    const namespace = ns.metadata.name;

    const redisExporter: k8s.types.input.core.v1.Container = {
        name: "redis-exporter",
        image: REDIS_EXPORTER_IMAGE,
        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
        ports: [{ name: "metrics", containerPort: 9121 }],
        resources: { requests: { cpu: "10m", memory: "20Mi" }, limits: { memory: "64Mi" } },
    };

    //
    // REDIS LEADER.
    //

    const redisLeaderLabels = { app: "redis-leader", tier: "backend" };
    const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
        metadata: { namespace },
        spec: {
            selector: { matchLabels: redisLeaderLabels },
            template: {
                metadata: { labels: redisLeaderLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-leader",
                            image: REDIS_IMAGE,
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            ports: [{ containerPort: 6379 }],
                        },
                        redisExporter,
                    ],
                },
            },
        },
    });
    new k8s.core.v1.Service("redis-leader", {
        metadata: { name: "redis-leader", namespace, labels: redisLeaderLabels },
        spec: {
            ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
            selector: redisLeaderDeployment.spec.template.metadata.labels,
        },
    });

    //
    // REDIS REPLICA.
    //

    const redisReplicaLabels = { app: "redis-replica", tier: "backend" };
    const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
        metadata: { namespace },
        spec: {
            selector: { matchLabels: redisReplicaLabels },
            template: {
                metadata: { labels: redisReplicaLabels },
                spec: {
                    containers: [
                        {
                            name: "replica",
                            image: "pulumi/guestbook-redis-replica",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ containerPort: 6379 }],
                        },
                        redisExporter,
                    ],
                },
            },
        },
    });
    new k8s.core.v1.Service("redis-replica", {
        metadata: { name: "redis-replica", namespace, labels: redisReplicaLabels },
        spec: {
            ports: [{ name: "redis", port: 6379, targetPort: 6379 }],
            selector: redisReplicaDeployment.spec.template.metadata.labels,
        },
    });

    // One metrics Service for both Redis tiers (selects tier=backend).
    new k8s.core.v1.Service("redis-metrics", {
        metadata: { name: "redis-metrics", namespace, labels: { app: "redis", monitoring: "guestbook" } },
        spec: {
            clusterIP: "None",
            ports: [{ name: "metrics", port: 9121, targetPort: "metrics" }],
            selector: { tier: "backend" },
        },
    });

    //
    // FRONTEND
    //

    const frontendLabels = { app: "frontend", tier: "frontend" };
    const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
        metadata: { namespace },
        spec: {
            selector: { matchLabels: frontendLabels },
            replicas: 3,
            template: {
                metadata: { labels: frontendLabels },
                spec: {
                    containers: [
                        {
                            name: "frontend",
                            image: "pulumi/guestbook-php-redis",
                            resources: { requests: { cpu: "100m", memory: "100Mi" } },
                            env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                            ports: [{ name: "http", containerPort: 80 }],
                        },
                        {
                            // mod_status only answers "Require local", so the sidecar reads it over the
                            // pod's shared localhost; nothing extra is opened on the frontend itself.
                            name: "apache-exporter",
                            image: APACHE_EXPORTER_IMAGE,
                            args: ["--scrape_uri=http://localhost/server-status?auto"],
                            ports: [{ name: "metrics", containerPort: 9117 }],
                            resources: { requests: { cpu: "10m", memory: "20Mi" }, limits: { memory: "64Mi" } },
                        },
                    ],
                },
            },
        },
    });
    const frontendService = new k8s.core.v1.Service("frontend", {
        metadata: { name: "frontend", namespace, labels: frontendLabels },
        spec: {
            type: args.frontendServiceType,
            ports: [{ name: "http", port: 80, targetPort: "http" }],
            selector: frontendDeployment.spec.template.metadata.labels,
        },
    });
    new k8s.core.v1.Service("frontend-metrics", {
        metadata: { name: "frontend-metrics", namespace, labels: { app: "frontend", monitoring: "guestbook" } },
        spec: {
            clusterIP: "None",
            ports: [{ name: "metrics", port: 9117, targetPort: "metrics" }],
            selector: frontendLabels,
        },
    });

    if (args.trafficGenerator) {
        new k8s.apps.v1.Deployment("traffic-generator", {
            metadata: { namespace },
            spec: {
                selector: { matchLabels: { app: "traffic-generator" } },
                template: {
                    metadata: { labels: { app: "traffic-generator" } },
                    spec: {
                        containers: [{
                            name: "curl",
                            image: "curlimages/curl:8.10.1",
                            command: ["sh", "-c", "while true; do curl -s -o /dev/null http://frontend/; sleep 0.5; done"],
                            resources: { requests: { cpu: "5m", memory: "10Mi" }, limits: { memory: "32Mi" } },
                        }],
                    },
                },
            },
        });
    }

    const frontendUrl = frontendService.status.apply(s => {
        const ingress = s?.loadBalancer?.ingress?.[0];
        const host = ingress?.ip ?? ingress?.hostname;
        return host ? `http://${host}` : "kubectl -n guestbook port-forward svc/frontend 8080:80  ->  http://localhost:8080";
    });

    return { namespace, frontendUrl: pulumi.output(frontendUrl) };
}
