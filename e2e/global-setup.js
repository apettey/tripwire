// One login for the whole run.
//
// Tripwire rate-limits logins to one per IP per 30 seconds (_history_login),
// so a suite that signs in per test spends most of its time waiting or,
// worse, fails on the wait. Sign in once here, keep the session cookie in
// storageState, and every test starts already inside the app.
const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, ".auth", "state.json");

module.exports = async function globalSetup(config) {
	const base = config.projects[0].use.baseURL || process.env.E2E_BASE_URL || "http://localhost:8080";
	const USER = process.env.E2E_USER || "preview";
	const PASS = process.env.E2E_PASS || "preview";
	fs.mkdirSync(path.dirname(STATE), { recursive: true });

	const browser = await chromium.launch();
	const page = await browser.newPage({ ignoreHTTPSErrors: true });
	await page.goto(base + "/?system=Perimeter");
	if (await page.locator("#card-login").count()) {
		await page.locator("details.alt > summary").click();
		await page.fill("#login_username", USER);
		await page.fill("#login_password", PASS);
		await page.click("#login-submit");
		await page.waitForFunction(() => window.tripwire && tripwire.client && tripwire.timer, null, { timeout: 45000 });
	}
	await page.context().storageState({ path: STATE });
	await browser.close();
};

module.exports.STATE = STATE;
