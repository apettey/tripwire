// The ways signatures get into Tripwire, end to end against a real instance.
//
// Every test here creates its own fixtures under the ZZQ prefix and removes
// them afterwards through the same remove payload the UI sends, so the
// preview's real data is untouched and a failed run leaves nothing behind
// that the next run will not clear.
const { test } = require("@playwright/test");
const { login, clientSigIds, removeSigsByPrefix, chooseType, setClipboard, expect } = require("./helpers");

const SYSTEM = process.env.E2E_SYSTEM || "Perimeter";
const PREFIX = "zzq";

test.describe("signatures", () => {
	test.beforeEach(async ({ page }) => {
		await login(page, SYSTEM);
		await removeSigsByPrefix(page, PREFIX);
	});
	test.afterEach(async ({ page }) => {
		await removeSigsByPrefix(page, PREFIX).catch(() => {});
	});

	test("add a signature by hand: typed into the dialog, saved with Enter", async ({ page }) => {
		await page.click("#add-signature");
		const dlg = page.locator(".ui-dialog:visible");
		await expect(dlg.locator(".ui-dialog-title")).toHaveText(/Add Signature/);

		// Typed, not filled: this is the path the single-key shortcuts could
		// interfere with, and the path a person actually uses.
		await page.locator("#dialog-signature input[name=signatureID_Alpha]").click();
		await page.keyboard.type("ZZQ");
		await page.keyboard.press("Tab");
		await page.keyboard.type("101");
		await chooseType(page, "Data");
		await page.locator("#dialog-signature input[name=signatureName]").click();
		await page.keyboard.type("E2E data site");
		await page.keyboard.press("Enter");

		await expect(dlg).toBeHidden();
		await expect(page.locator("#sigTable tbody td:first-child", { hasText: /ZZQ-101/i })).toBeVisible();
		expect(await clientSigIds(page)).toContain("zzq101");
	});

	test("add a signature by hand: the Add button", async ({ page }) => {
		await page.click("#add-signature");
		const dlg = page.locator(".ui-dialog:visible");
		await page.fill("#dialog-signature input[name=signatureID_Alpha]", "ZZQ");
		await page.fill("#dialog-signature input[name=signatureID_Numeric]", "102");
		await chooseType(page, "Combat");
		await page.fill("#dialog-signature input[name=signatureName]", "E2E combat site");
		await dlg.getByRole("button", { name: "Add", exact: true }).click();

		await expect(dlg).toBeHidden();
		expect(await clientSigIds(page)).toContain("zzq102");
	});

	test("paste probe-scanner results with Ctrl-V anywhere on the page", async ({ page, context }) => {
		const scan = [
			"ZZQ-201\tCosmic Signature\tRelic Site\tE2E relic\t100.0%\t2.31 AU",
			"ZZQ-202\tCosmic Signature\tGas Site\tE2E gas\t100.0%\t4.10 AU",
			"ZZQ-203\tCosmic Signature\t\t\t12.5%\t9.00 AU"
		].join("\n");
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await setClipboard(page, scan);

		// Nothing focused, Ctrl-V: paste.js focuses #clipboard and parses.
		await page.locator("body").click({ position: { x: 5, y: 400 } });
		await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).filter(s => /^zzq20/i.test(s.signatureID)).length >= 3, null, { timeout: 15000 });
		const ids = await clientSigIds(page);
		expect(ids).toEqual(expect.arrayContaining(["zzq201", "zzq202", "zzq203"]));
		const relic = await page.evaluate(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).find(s => /zzq201/i.test(s.signatureID)));
		expect(relic.type).toBe("relic");
		expect(relic.name).toBe("E2E relic");
	});

	test("the Paste scan button ingests the clipboard", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await setClipboard(page, "ZZQ-301\tCosmic Signature\tData Site\tE2E button paste\t100.0%\t1.00 AU");
		await page.click("#paste-signatures");
		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq301/i.test(s.signatureID)), null, { timeout: 15000 });
		expect(await clientSigIds(page)).toContain("zzq301");
	});

	test("a pasted signature updates rather than duplicates", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await setClipboard(page, "ZZQ-401\tCosmic Signature\t\t\t10.0%\t5.00 AU");
		await page.click("#paste-signatures");
		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq401/i.test(s.signatureID)), null, { timeout: 15000 });
		await setClipboard(page, "ZZQ-401\tCosmic Signature\tOre Site\tE2E ore\t100.0%\t5.00 AU");
		await page.click("#paste-signatures");
		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq401/i.test(s.signatureID) && s.type === "ore"), null, { timeout: 115000 });
		const matches = (await clientSigIds(page)).filter(id => id === "zzq401");
		expect(matches).toHaveLength(1);
	});

	test("undo removes what was just added", async ({ page }) => {
		await page.click("#add-signature");
		await page.fill("#dialog-signature input[name=signatureID_Alpha]", "ZZQ");
		await page.fill("#dialog-signature input[name=signatureID_Numeric]", "501");
		await chooseType(page, "Ore");
		await page.locator(".ui-dialog:visible").getByRole("button", { name: "Add", exact: true }).click();
		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq501/i.test(s.signatureID)));
		await expect(page.locator("#undo")).not.toHaveClass(/disabled/);
		await page.click("#undo");
		await page.waitForFunction(() => !Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq501/i.test(s.signatureID)), null, { timeout: 15000 });
	});
});

test.describe("the traps", () => {
	test.beforeEach(async ({ page }) => { await login(page, SYSTEM); await removeSigsByPrefix(page, PREFIX); });
	test.afterEach(async ({ page }) => { await removeSigsByPrefix(page, PREFIX).catch(() => {}); });

	test("typing the id then Tab does not skip the numeric half", async ({ page }) => {
		await page.click("#add-signature");
		await page.locator("#dialog-signature input[name=signatureID_Alpha]").click();
		await page.keyboard.type("ZZQ");     // auto-advances to the numeric field
		await page.keyboard.press("Tab");     // the habitual Tab must not skip it
		await page.keyboard.type("601");
		await expect(page.locator("#dialog-signature input[name=signatureID_Numeric]")).toHaveValue("601");
		await chooseType(page, "Gas");
		await page.locator(".ui-dialog:visible").getByRole("button", { name: "Add", exact: true }).click();
		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq601/i.test(s.signatureID)), null, { timeout: 15000 });
	});

	test("a whole id pasted into the first field splits itself", async ({ page }) => {
		await page.click("#add-signature");
		await page.fill("#dialog-signature input[name=signatureID_Alpha]", "ZZQ-602");
		await expect(page.locator("#dialog-signature input[name=signatureID_Alpha]")).toHaveValue("ZZQ");
		await expect(page.locator("#dialog-signature input[name=signatureID_Numeric]")).toHaveValue("602");
	});

	test("Ctrl-V with the search box focused still ingests a scan", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await setClipboard(page, "ZZQ-701\tCosmic Signature\tCombat Site\tE2E from search\t100.0%\t1.00 AU");
		await page.click("#search");   // opens search and focuses its input
		await expect(page.locator("#searchSpan input")).toBeFocused();
		await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
		await page.waitForFunction(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => /zzq701/i.test(s.signatureID)), null, { timeout: 15000 });
		await expect(page.locator("#searchSpan input")).toHaveValue("");
	});
});
