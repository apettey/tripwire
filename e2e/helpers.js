const { expect } = require("@playwright/test");

const USER = process.env.E2E_USER || "preview";
const PASS = process.env.E2E_PASS || "preview";

// Sign in through the Tripwire-account form on the landing page and wait
// for the app to be live (tripwire.client populated, first refresh done).
// The session comes from global-setup's storageState; this only falls back
// to the form if that session has expired.
async function login(page, system) {
	await page.goto("?system=" + encodeURIComponent(system || "Perimeter"));
	if (await page.locator("#login_username").count()) {
		await page.locator("#login-link").click();
		await page.fill("#login_username", USER);
		await page.fill("#login_password", PASS);
		await page.click("#login-submit");
	}
	// Ready = the first sync has landed (it schedules the poll timer). Not
	// `tripwire.client.signatures`: a system with no signatures arrives as null.
	await page.waitForFunction(() => window.tripwire && tripwire.client && tripwire.timer && document.querySelector("#sigTable"), null, { timeout: 30000 });
	// Login is rate-limited to one per IP per 30s; nothing to do about that
	// but give the first refresh a moment to land.
	await page.waitForTimeout(1500);
}

// Signature ids as the client holds them, lower-cased, e.g. "zzq901".
async function clientSigIds(page) {
	return page.evaluate(() => Object.values((tripwire.client && tripwire.client.signatures) || {}).map(s => (s.signatureID || "").toLowerCase()));
}

// Remove every signature whose id starts with the given prefix -- the
// tests' own fixtures only. Goes through the same remove payload the UI
// uses, and waits for the client to agree.
async function removeSigsByPrefix(page, prefix) {
	await page.evaluate((prefix) => new Promise((resolve) => {
		const ids = Object.values((tripwire.client && tripwire.client.signatures) || {})
			.filter(s => (s.signatureID || "").toLowerCase().startsWith(prefix.toLowerCase()))
			.map(s => s.id);
		if (!ids.length) { return resolve(0); }
		const payload = { signatures: { remove: ids }, systemID: viewingSystemID };
		tripwire.refresh("refresh", payload, () => resolve(ids.length), () => setTimeout(() => resolve(ids.length), 500));
	}), prefix);
	await page.waitForFunction((prefix) => !Object.values((tripwire.client && tripwire.client.signatures) || {}).some(s => (s.signatureID || "").toLowerCase().startsWith(prefix.toLowerCase())), prefix, { timeout: 15000 });
}

// The signature-type select is a jQuery UI selectmenu: the native <select>
// is hidden and a button + menu stand in for it. Drive the widget the way a
// person does -- open the button, pick the item -- so the test exercises the
// same path and the widget's own change handling runs.
async function chooseType(page, label) {
	await page.locator("#dialog-signature #signatureType .ui-selectmenu-button, #dialog-signature .ui-selectmenu-button").first().click();
	await page.locator(".ui-selectmenu-menu:visible .ui-menu-item").filter({ hasText: new RegExp("^\\s*" + label + "\\s*$", "i") }).first().click();
}

// Put text on the clipboard and prove it landed. A second writeText in a
// run can fail silently when the document has lost transient activation,
// and the next read then returns the previous scan -- which looks like
// "paste did not update" when it is "paste got the old text".
async function setClipboard(page, text) {
	await page.locator("body").click({ position: { x: 5, y: 400 } });
	await page.evaluate((t) => navigator.clipboard.writeText(t), text);
	await page.waitForFunction(async (t) => (await navigator.clipboard.readText()) === t, text, { timeout: 5000 });
}

module.exports = { login, clientSigIds, removeSigsByPrefix, chooseType, setClipboard, expect };
