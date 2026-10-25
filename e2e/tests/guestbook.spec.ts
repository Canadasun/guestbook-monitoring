import { expect, test } from "@playwright/test";
import { env, promValue, shot } from "./helpers";

test.describe("Guestbook app", () => {
    // Restore only when BOTH a snapshot was taken AND the test changed the data: a failed snapshot
    // must never be "restored" as an empty value that wipes the real messages.
    let original: string | undefined;
    let mutated = false;

    test.beforeAll(async ({ request }) => {
        const res = await request.get(`${env("GUESTBOOK_URL")}/guestbook.php?cmd=get&key=messages`);
        expect(res.ok(), "could not snapshot the guestbook before the test").toBeTruthy();
        const body = await res.json();
        expect(typeof body.data, "unexpected guestbook response").toBe("string");
        original = body.data;
    });

    test.afterAll(async ({ request }) => {
        if (original === undefined || !mutated) return;
        const res = await request.get(
            `${env("GUESTBOOK_URL")}/guestbook.php?cmd=set&key=messages&value=${encodeURIComponent(original)}`);
        expect(await res.json(), "restoring the original guestbook messages").toEqual({ message: "Updated" });
    });

    test("a submitted message survives a reload (written to the leader, read from the replica)", async ({ page }) => {
        const message = `e2e-${Date.now()}`;   // no commas: the app stores messages comma-separated
        await page.goto(env("GUESTBOOK_URL"));
        await expect(page.getByRole("heading", { name: "Guestbook" })).toBeVisible();

        await page.getByPlaceholder("Messages").fill(message);
        expect(original, "snapshot must exist before writing").toBeDefined();
        const saved = page.waitForResponse(r => r.url().includes("cmd=set") && r.ok());
        mutated = true;   // set before clicking: the write may land even if the response is lost
        await page.getByRole("button", { name: "Submit" }).click();
        expect(await (await saved).json()).toEqual({ message: "Updated" });

        // The AngularJS page adds the message client-side on Submit, so only a reload proves it was
        // stored in Redis and read back from the replica.
        const loaded = page.waitForResponse(r => r.url().includes("cmd=get") && r.ok());
        await page.reload();
        await loaded;
        await expect(page.getByText(message, { exact: true })).toBeVisible();
        await page.screenshot({ path: shot("guestbook-after-reload") });
    });

    test("page views show up in Prometheus as frontend requests", async ({ page }) => {
        const metric = 'sum(apache_accesses_total{namespace="guestbook"})';
        const before = (await promValue(metric))!;
        expect(before).toBeGreaterThan(0);
        for (let i = 0; i < 10; i++) await page.goto(env("GUESTBOOK_URL"));
        // Next scrape (15s interval) must include at least our 10 page loads.
        await expect.poll(() => promValue(metric), { timeout: 60_000, intervals: [5_000] })
            .toBeGreaterThanOrEqual(before + 10);
    });
});
