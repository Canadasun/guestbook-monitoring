import { expect, test } from "@playwright/test";
import { env, promValue, shot } from "./helpers";

test.describe("Prometheus UI", () => {
    test("Targets page shows every Guestbook scrape pool fully up", async ({ page }) => {
        await page.goto(`${env("PROMETHEUS_URL")}/targets`);
        // Expected targets per pool: 3 frontend pods, 2 redis pods (leader + replica), 1 probe.
        for (const [pool, n] of [
            ["serviceMonitor/guestbook/guestbook-frontend/0", 3],
            ["serviceMonitor/guestbook/guestbook-redis/0", 2],
            ["probe/guestbook/guestbook-frontend", 1],
        ] as const) {
            await expect(page.getByText(pool, { exact: true }).first()).toBeVisible();
            // Each pool card header reads "<pool>  Show config  <up> / <total> up" (the name also appears
            // in the filter list), so look for the count among the few lines after any occurrence.
            const lines = (await page.locator("body").innerText()).split("\n").map(l => l.trim()).filter(Boolean);
            const near = lines.flatMap((l, i) => (l === pool ? lines.slice(i + 1, i + 4) : []));
            expect(near, pool).toContain(`${n} / ${n} up`);
        }
        await page.screenshot({ path: shot("prometheus-targets"), fullPage: true });
    });

    test("Alerts page lists the SLO rules and every rule evaluates without errors", async ({ page }) => {
        await page.goto(`${env("PROMETHEUS_URL")}/alerts`);
        await expect(page.getByText("slo-burn-rate.alerts")).toBeVisible();
        for (const alert of ["GuestbookAvailabilityErrorBudgetBurnFast", "GuestbookLatencyErrorBudgetBurnFast",
                             "GuestbookSloProbeMissing", "GuestbookRedisReplicationDown"]) {
            await expect(page.getByText(alert).first()).toBeVisible();
        }
        const rules = await (await fetch(`${env("PROMETHEUS_URL")}/api/v1/rules`)).json();
        const slo = rules.data.groups.filter((g: any) => g.name.startsWith("slo-")).flatMap((g: any) => g.rules);
        expect(slo.length, "SLO rules loaded").toBe(31);
        expect(slo.filter((r: any) => r.health !== "ok").map((r: any) => `${r.name}: ${r.lastError}`)).toEqual([]);
        // Firing is not a failure here: after a real outage (or the drill) the slow-burn alerts are
        // meant to stay active for hours. Record them so the report shows the current state.
        const firing = slo.filter((r: any) => r.state === "firing").map((r: any) => `${r.name} (${r.labels?.long_window ?? "-"})`);
        test.info().annotations.push({ type: "firing alerts", description: firing.length ? firing.join(", ") : "none" });
        await page.screenshot({ path: shot("prometheus-alerts"), fullPage: true });
    });
});
