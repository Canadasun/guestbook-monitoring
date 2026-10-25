import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Safety net: no artifact may keep the Grafana password. Redact it from text artifacts; traces
// (zip, only with PW_TRACE=1) can't be safely edited, so warn about them instead.
function scrubArtifacts(secret: string | undefined) {
    if (!secret || secret.length < 8) return;
    for (const dir of ["test-results", "playwright-report"].map(d => path.join(__dirname, d))) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
            const file = path.join(dir, f);
            if (!fs.statSync(file).isFile()) continue;
            const buf = fs.readFileSync(file);
            if (!buf.includes(secret)) continue;
            if (file.endsWith(".zip")) {
                console.warn(`WARNING: ${file} contains the Grafana password - delete it before sharing.`);
            } else {
                fs.writeFileSync(file, buf.toString("utf8").split(secret).join("[REDACTED]"));
                console.warn(`Redacted the Grafana password from ${file}`);
            }
        }
    }
}

export default async function globalTeardown() {
    scrubArtifacts(process.env.GRAFANA_PASSWORD);
    const state = path.join(os.tmpdir(), "guestbook-e2e-state.json");
    if (!fs.existsSync(state)) return;
    const { pid } = JSON.parse(fs.readFileSync(state, "utf8"));
    if (pid) {
        try { process.kill(pid); } catch { /* already gone */ }
    }
    fs.rmSync(state);
}
