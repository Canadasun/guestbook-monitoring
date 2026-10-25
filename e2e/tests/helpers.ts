import { expect, Page } from "@playwright/test";

export const env = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set (global-setup reads it from pulumi stack output)`);
    return v;
};

// Instant PromQL query; returns the first sample's value, or undefined when the result is empty.
export async function promValue(expr: string): Promise<number | undefined> {
    const url = `${env("PROMETHEUS_URL")}/api/v1/query?query=${encodeURIComponent(expr)}`;
    const body = await (await fetch(url)).json();
    expect(body.status, `query failed: ${expr}`).toBe("success");
    const first = body.data.result[0];
    return first ? Number(first.value[1]) : undefined;
}

export async function grafanaLogin(page: Page, password = env("GRAFANA_PASSWORD"), user = env("GRAFANA_USER")) {
    await page.goto(`${env("GRAFANA_URL")}/login`);
    await page.locator('input[name="user"]').fill(user);
    const passwordBox = page.locator('input[name="password"]');
    await passwordBox.fill(password);
    const submitted = page.waitForResponse(r => r.url().endsWith("/login") && r.request().method() === "POST");
    await page.locator('button[type="submit"]').click();
    await submitted;
    // On a failed test Playwright writes error-context.md, a page snapshot that includes the typed
    // VALUE of the password box in plain text. The request is already sent, so clear the box now.
    // Short timeout: after a successful login Grafana navigates away and the box disappears, and
    // a plain fill() would wait for it until the test times out.
    if (await passwordBox.count()) await passwordBox.fill("", { timeout: 2_000 }).catch(() => { /* page navigated away */ });
}

// Log in and wait for Grafana's post-login redirect, so the next goto doesn't abort it.
export async function grafanaLoginAsAdmin(page: Page) {
    await grafanaLogin(page);
    await page.waitForURL(u => !u.pathname.startsWith("/login"));
}

export const panel = (page: Page, title: string) => page.getByTestId(`data-testid Panel header ${title}`);

export const shot = (name: string) => `screenshots/${name}.png`;

// Wait until EVERY panel shows data: a graph has drawn its canvas, or a stat tile shows a value.
// Checking only for the absence of "No data" (or for panel titles) can pass before queries return.
export async function waitForPanelsLoaded(page: Page, expected: number) {
    const panels = page.locator('[data-testid^="data-testid Panel header "]');
    await expect(panels).toHaveCount(expected);
    for (let i = 0; i < expected; i++) {
        const p = panels.nth(i);
        const title = (await p.getAttribute("data-testid"))!.replace("data-testid Panel header ", "");
        await expect.poll(async () => {
            if (await p.locator("canvas").count()) return "graph";
            const value = (await p.innerText()).replace(title, "").trim();
            return /\d|UP|DOWN/.test(value) ? "value" : "waiting";
        }, { message: `panel "${title}" never showed data` }).not.toBe("waiting");
    }
}
