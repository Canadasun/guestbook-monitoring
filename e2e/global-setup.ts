import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const STATE = path.join(os.tmpdir(), "guestbook-e2e-state.json");

function stackOutput(name: string, secret = false): string {
    const args = ["stack", "output", name, ...(secret ? ["--show-secrets"] : [])];
    if (process.env.PULUMI_STACK) args.push("--stack", process.env.PULUMI_STACK);
    return execFileSync("pulumi", args, { cwd: path.join(__dirname, ".."), encoding: "utf8" }).trim();
}

// Port-forward to Prometheus; trust it only after kubectl reports its own listener is bound.
async function portForwardPrometheus(port: number): Promise<number> {
    const pf = spawn("kubectl", ["-n", "monitoring", "port-forward",
        "svc/monitoring-kube-prometheus-prometheus", `${port}:9090`], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    pf.stdout.on("data", d => (log += d));
    pf.stderr.on("data", d => (log += d));
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (pf.exitCode !== null) throw new Error(`Prometheus port-forward failed: ${log}`);
        if (log.includes(`Forwarding from 127.0.0.1:${port}`)) {
            const ready = await fetch(`http://localhost:${port}/-/ready`).then(r => r.ok, () => false);
            if (ready) { pf.unref(); return pf.pid!; }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    pf.kill();
    throw new Error(`Prometheus not ready on localhost:${port}: ${log}`);
}

export default async function globalSetup() {
    const env = process.env;
    env.GUESTBOOK_URL ??= stackOutput("frontendUrl");
    env.GRAFANA_URL ??= stackOutput("grafanaUrl");
    env.GRAFANA_USER ??= stackOutput("grafanaAdminUser");
    env.GRAFANA_PASSWORD ??= stackOutput("grafanaAdminPassword", true);
    for (const k of ["GUESTBOOK_URL", "GRAFANA_URL"]) {
        if (!/^https?:\/\//.test(env[k]!)) {
            throw new Error(`${k} is "${env[k]}" - not a URL. On minikube/kind, port-forward and set ${k}=http://localhost:<port>.`);
        }
    }
    // Set PROMETHEUS_URL to use your own connection; otherwise a port-forward is opened here.
    let pid: number | undefined;
    if (!env.PROMETHEUS_URL) {
        const port = Number(env.PROM_PORT ?? 9095);
        pid = await portForwardPrometheus(port);
        env.PROMETHEUS_URL = `http://localhost:${port}`;
    }
    fs.writeFileSync(STATE, JSON.stringify({ pid }));
}
