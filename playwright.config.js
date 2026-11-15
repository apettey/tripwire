// End-to-end tests against a running Tripwire.
//
// These run against a real instance -- by default the OrbStack preview on
// the preview box through an SSH tunnel at localhost:8080 -- because the paths
// worth testing (paste, add, edit, undo) round-trip through refresh.php and
// MySQL, and a mocked server would only prove the mocks. Point E2E_BASE_URL
// elsewhere to run them against another instance. Credentials come from
// E2E_USER / E2E_PASS (default: the preview seed user).
//
//   npm run e2e            headless
//   npm run e2e:headed     watch it
const { defineConfig } = require("@playwright/test");
require('dotenv').config();

module.exports = defineConfig({
	testDir: "./e2e",
	globalSetup: require.resolve("./e2e/global-setup.js"),
	timeout: 60000,
	expect: { timeout: 10000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: process.env.E2E_BASE_URL || "http://localhost:8080",
		storageState: require("path").join(__dirname, "e2e", ".auth", "state.json"),
		ignoreHTTPSErrors: true,
		viewport: { width: 1440, height: 900 },
		colorScheme: "dark",
		trace: "retain-on-failure",
		screenshot: "only-on-failure"
	}
});
