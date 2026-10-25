import { defineConfig, devices } from "@playwright/test";

// Browser end-to-end tests against a deployed stack (see README "Browser end-to-end tests").
// URLs and the Grafana password come from `pulumi stack output` unless set in the environment.
export default defineConfig({
    testDir: "./tests",
    globalSetup: "./global-setup.ts",
    globalTeardown: "./global-teardown.ts",
    timeout: 120_000,
    expect: { timeout: 30_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: [["list"], ["html", { open: "never" }]],
    // The outage drill changes the cluster, so it only runs when asked for (npm run test:drill).
    grepInvert: process.env.DRILL ? undefined : /@drill/,
    use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
        // Headed by default so you can watch the real Chromium window (WSLg/desktop). Set HEADLESS=1
        // where there is no display, e.g. CI or a plain SSH session.
        headless: !!process.env.HEADLESS,
        screenshot: "only-on-failure",
        // Off by default: a trace records request bodies, including the Grafana login password.
        // Set PW_TRACE=1 only for local debugging, and never share the resulting test-results/.
        trace: process.env.PW_TRACE ? "retain-on-failure" : "off",
        launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    },
});
