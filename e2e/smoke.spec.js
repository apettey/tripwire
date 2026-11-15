// The app comes up: header, four panels, a live poll, no console errors.
const { test } = require("@playwright/test");
const { login, expect } = require("./helpers");

test("the app loads clean and polls", async ({ page }) => {
	const errors = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	await login(page, "Perimeter");
	await expect(page.locator("#infoSystem")).toHaveText(/Perimeter/);
	await expect(page.locator(".gridWidget:visible")).toHaveCount(4);
	await expect(page.locator("#user-avatar")).toHaveCount(1); // theme may choose to hide it

	// The poll loop reschedules: the timer id must change.
	const t1 = await page.evaluate(() => tripwire.timer);
	await page.waitForFunction((t) => tripwire.timer !== t, t1, { timeout: 20000 });
	expect(errors).toEqual([]);
});

// In wormhole space the System panel's graph gives way to zKillboard's kill
// stream; in k-space the graph stays and the stream is gone.
test("a wormhole system shows the kill stream, a k-space system the graph", async ({ page }) => {
	await login(page, "Perimeter");
	await expect(page.locator("#killStream")).toBeHidden();
	await expect(page.locator("#activityGraph")).toBeVisible();
	await page.evaluate(() => tripwire.systemChange(31000005));
	await page.waitForFunction(() => Number(viewingSystemID) === 31000005);
	await expect(page.locator("#infoWidget")).toHaveClass(/is-wormhole/);
	await expect(page.locator("#killStream")).toBeVisible();
	await expect(page.locator("#activityGraph")).toBeHidden();
	// Either the board had kills and the strip lists them, or it had none and our quiet line shows.
	await expect.poll(async () => {
		const n = await page.locator("#killStreamStrip .kill").count();
		const quiet = await page.locator("#killStream").evaluate(e => e.classList.contains("is-quiet"));
		return n > 0 || quiet;
	}, { timeout: 20000 }).toBe(true);
	await expect(page.locator("#killStream > #infoLinks.in-killstream-foot")).toBeVisible();   // the links close the section
	await expect(page.locator("#killStreamLink")).toHaveAttribute("href", /zkillboard\.com\/system\/31000005\//);
	await page.evaluate(() => tripwire.systemChange(30000144));
	await page.waitForFunction(() => Number(viewingSystemID) === 30000144);
	await expect(page.locator("#killStream")).toBeHidden();
	await expect(page.locator("#activityGraph")).toBeVisible();
	await expect(page.locator("#activityGraphControls #infoLinks")).toBeVisible(); // and back
});
