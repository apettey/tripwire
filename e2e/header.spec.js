// Header toggles: what you click must change, visibly, and stay changed.
const { test, expect } = require("@playwright/test");
const { login } = require("./helpers");

async function ready(page) {
	await login(page, "Perimeter");
	await page.waitForFunction(() => window.tripwire && window.options && window.options.buttons);
	await page.waitForSelector("#follow", { state: "visible" });
}

// This test requires that the logged in character has tracking turned on, so the auto-follow option is shown
test("follow-my-system toggles on click, shows it, and survives a reload", async ({ page }) => {
	await ready(page);
	const follow = page.locator("#follow");
	const state = () => page.evaluate(() => ({
		active: document.getElementById("follow").classList.contains("active"),
		option: !!options.buttons.follow,
		color: getComputedStyle(document.getElementById("follow")).color,
		primary: getComputedStyle(document.documentElement).getPropertyValue("--primary").trim(),
	}));
	const before = await state();

	await follow.click();
	const after = await state();
	expect(after.active).toBe(!before.active);
	expect(after.option).toBe(after.active);

	// On draws in the brand orange; off in the muted grey. Whichever way we
	// just went, the two states must not look the same.
	expect(after.color).not.toBe(before.color);
	const onColor = after.active ? after.color : before.color;
	const rgb = await page.evaluate(p => { const d = document.createElement("div"); d.style.color = p; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; }, after.primary);
	expect(onColor).toBe(rgb);

	// Persisted: the options sync writes it, a reload reads it back.
	await page.waitForTimeout(1500);
	await ready(page);
	expect((await state()).active).toBe(after.active);

	// Leave the account as we found it.
	await follow.click();
	await page.waitForTimeout(1500);
	expect((await state()).active).toBe(before.active);
});

// The header system picker: Escape closes it, and picking a suggestion goes
// there without a second Enter (ported from squizzlabs/tripwire b0fef1b).
test.describe("system picker", () => {
	test("Escape closes the picker", async ({ page }) => {
		await login(page, "Perimeter");
		await page.click("#search");
		const input = page.locator("#searchSpan input.systemsAutocomplete");
		await expect(input).toBeVisible();
		await expect(input).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(page.locator("#searchSpan")).toBeHidden();
		await expect(page.locator("#search")).not.toHaveClass(/active/);
	});

	test("choosing a suggestion opens that system", async ({ page }) => {
		await login(page, "Perimeter");
		await page.click("#search");
		const input = page.locator("#searchSpan input.systemsAutocomplete");
		await input.fill("Jita");
		await expect(page.locator("ul.ui-autocomplete li.ui-menu-item").first()).toBeVisible();
		await Promise.all([
			page.waitForURL(/system=Jita/),
			page.keyboard.press("ArrowDown").then(() => page.keyboard.press("Enter"))
		]);
		await expect(page).toHaveURL(/system=Jita/);
	});
});
