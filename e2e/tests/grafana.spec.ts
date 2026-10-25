import { expect, test } from "@playwright/test";
import { env, grafanaLogin, grafanaLoginAsAdmin, panel, shot, waitForPanelsLoaded } from "./helpers";

const DASHBOARD = "/d/guestbook-overview?orgId=1&from=now-30m&to=now";

test.describe("Grafana", () => {
    test("anonymous visitors are sent to the login page", async ({ page }) => {
        await page.goto(`${env("GRAFANA_URL")}${DASHBOARD}`);
        await expect(page).toHaveURL(/\/login/);
    });

    test("a wrong password is rejected", async ({ page }) => {
        // Not "admin": Grafana locks a username after ~5 failed logins in 5 minutes, so failing as
        // admin on repeated runs would lock out the real login used by the other tests.
        await grafanaLogin(page, "definitely-not-the-password", "e2e-nonexistent-user");
        await expect(page.getByText("Invalid username or password")).toBeVisible();
        await expect(page).toHaveURL(/\/login/);
    });

    test("the Pulumi-output credentials log in and the Prometheus datasource is healthy", async ({ page }) => {
        await grafanaLoginAsAdmin(page);
        await expect(page).not.toHaveURL(/\/login/);
        const health = await page.request.get(`${env("GRAFANA_URL")}/api/datasources/uid/prometheus/health`);
        expect(health.ok()).toBeTruthy();
        expect((await health.json()).status).toBe("OK");
    });

    test("Guestbook Overview renders every panel with live data", async ({ page }) => {
        await page.setViewportSize({ width: 1600, height: 3200 });   // whole dashboard on screen, no lazy panels
        await grafanaLoginAsAdmin(page);
        // Every panel runs its own /api/ds/query request; collect their HTTP statuses.
        const queryStatuses: number[] = [];
        page.on("response", r => { if (r.url().includes("/api/ds/query")) queryStatuses.push(r.status()); });
        await page.goto(`${env("GRAFANA_URL")}${DASHBOARD}`);
        await expect(page.getByText("Guestbook Overview").first()).toBeVisible();

        await waitForPanelsLoaded(page, 18);                           // 19 panels minus the row header
        expect(queryStatuses.length, "dashboard queries sent").toBeGreaterThanOrEqual(18);
        expect(queryStatuses.filter(s => s !== 200), "failed dashboard queries").toEqual([]);
        // Only now are the negative checks meaningful.
        await expect(page.getByText("No data", { exact: true })).toHaveCount(0);
        await expect(page.getByText("NO DATA", { exact: true })).toHaveCount(0);
        await expect(page.locator('[data-testid*="Panel status error"]')).toHaveCount(0);

        // Health tiles show the expected healthy values.
        await expect(panel(page, "Targets up")).toContainText("100%");
        await expect(panel(page, "Replication")).toContainText("UP");
        await expect(panel(page, "Avail. budget")).toContainText("%");
        await expect(page.getByText(/^SLOs & error budget/).first()).toBeVisible();
        await page.screenshot({ path: shot("grafana-dashboard"), fullPage: true });
    });
});
