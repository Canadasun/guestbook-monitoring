import { execFileSync } from "child_process";
import { expect, test } from "@playwright/test";
import { env, grafanaLoginAsAdmin, panel, promValue, shot } from "./helpers";

// Outage drill in the browser (changes the cluster - run with `npm run test:drill`):
// frontend down -> users see errors -> SLO fast-burn alert fires -> Grafana shows the budget
// burning -> frontend restored -> the app works again.
const kubectl = (...args: string[]) => execFileSync("kubectl", ["-n", "guestbook", ...args], { encoding: "utf8" }).trim();
const ALERT = "GuestbookAvailabilityErrorBudgetBurnFast";

test("@drill frontend outage fires the SLO page and recovers", async ({ page, request }) => {
    test.setTimeout(20 * 60_000);
    const deploy = kubectl("get", "deploy", "-o", `jsonpath={.items[?(@.spec.selector.matchLabels.app=="frontend")].metadata.name}`);
    expect(deploy, "frontend Deployment").not.toBe("");
    const replicas = kubectl("get", "deploy", deploy, "-o", "jsonpath={.spec.replicas}");
    const budgetBefore = (await promValue('slo:error_budget_remaining:ratio{slo="guestbook-availability"}'))!;
    // A drill only proves something if the page goes from quiet to firing. After a previous drill the
    // 6h/30m pair keeps firing until the outage leaves the 30m window.
    expect(await promValue(`count(ALERTS{alertname="${ALERT}"})`),
        `${ALERT} is already pending/firing from an earlier outage - wait ~30 minutes and rerun`).toBeUndefined();

    // Inside try: if the scale-down is applied but the client then errors, `finally` still restores.
    try {
        kubectl("scale", "deploy", deploy, "--replicas=0");
        // 1. A user can no longer load the site.
        await expect.poll(async () => {
            try { return (await request.get(env("GUESTBOOK_URL"), { timeout: 5_000 })).ok(); } catch { return false; }
        }, { timeout: 120_000, intervals: [5_000] }).toBe(false);

        // 2. The SLO page fires (pending first, then firing after `for: 2m`).
        await expect.poll(() => promValue(`count(ALERTS{alertname="${ALERT}", alertstate="firing"})`),
            { timeout: 12 * 60_000, intervals: [15_000] }).toBeGreaterThan(0);
        await page.goto(`${env("PROMETHEUS_URL")}/alerts`);
        await expect(page.getByText(ALERT).first()).toBeVisible();
        // The visible "firing (n)" badge (shown upper-case via CSS); the word also exists in the
        // hidden state-filter dropdown, hence the visibility filter.
        await expect(page.getByText(/^firing \(\d+\)$/i).filter({ visible: true }).first()).toBeVisible();
        await page.screenshot({ path: shot("drill-prometheus-alert-firing"), fullPage: true });

        // 3. Grafana shows the error budget being spent.
        await page.setViewportSize({ width: 1600, height: 3200 });
        await grafanaLoginAsAdmin(page);
        await page.goto(`${env("GRAFANA_URL")}/d/guestbook-overview?orgId=1&from=now-30m&to=now`);
        // Not waitForPanelsLoaded: with no frontend pods, the frontend graphs legitimately have no
        // new data. Wait for the tile this step checks.
        await expect(panel(page, "Avail. budget")).toContainText(/\d\s*%/);
        const budgetNow = (await promValue('slo:error_budget_remaining:ratio{slo="guestbook-availability"}'))!;
        expect(budgetNow).toBeLessThan(budgetBefore);
        // The tile on screen must show the reduced budget too. It keeps falling during the outage, so
        // compare against 100% rather than the exact API value.
        const tile = (await panel(page, "Avail. budget").innerText()).match(/(-?\d+(?:\.\d+)?)\s*%/);
        expect(tile, "budget tile shows a percentage").not.toBeNull();
        expect(Number(tile![1])).toBeLessThan(100);
        await page.screenshot({ path: shot("drill-grafana-burning"), fullPage: true });
    } finally {
        kubectl("scale", "deploy", deploy, `--replicas=${replicas}`);
        kubectl("rollout", "status", "deploy", deploy, "--timeout=180s");
    }

    // 4. Recovered: the page loads for users again.
    await expect.poll(async () => {
        try { return (await request.get(env("GUESTBOOK_URL"), { timeout: 5_000 })).ok(); } catch { return false; }
    }, { timeout: 120_000, intervals: [5_000] }).toBe(true);
    await page.goto(env("GUESTBOOK_URL"));
    await expect(page.getByRole("heading", { name: "Guestbook" })).toBeVisible();
});
