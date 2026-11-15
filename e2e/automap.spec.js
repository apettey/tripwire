const { test } = require("@playwright/test");
const { login, expect } = require("./helpers");

// Two tabs with the automapper on see the same jump at the same moment and
// each sends the same "add a connection" request. The server must keep one.
// The two systems are k-space neighbours of nowhere on the corp map; the
// test refuses to run if they are already connected, and removes what it
// made afterwards through the same remove payload the UI sends.
const FROM = "Ikuchi";
const TO = "Kisogo";

function automapPayload(from, to) {
	return {
		signatures: { add: [{
			wormhole: { type: null, parent: "initial", life: "stable", mass: "stable" },
			signatures: [{ systemID: from, type: "wormhole" }, { systemID: to, type: "wormhole" }]
		}], update: [] },
		automap: { character: 0 },
		systemID: from
	};
}

// Wormholes on the client joining the two systems, with their signature ids.
function connectionsBetween(page, from, to) {
	return page.evaluate(([from, to]) => {
		const sigs = (tripwire.client && tripwire.client.signatures) || {};
		return Object.values((tripwire.client && tripwire.client.wormholes) || {})
			.map(w => ({ id: w.id, a: sigs[w.initialID], b: sigs[w.secondaryID] }))
			.filter(x => x.a && x.b && ((x.a.systemID == from && x.b.systemID == to) || (x.a.systemID == to && x.b.systemID == from)))
			.map(x => ({ id: x.id, sigs: [x.a.id, x.b.id] }));
	}, [from, to]);
}

function post(page, payload) {
	return page.evaluate((payload) => new Promise((resolve) => {
		tripwire.refresh("refresh", payload, (data) => resolve(data.resultSet), () => setTimeout(() => resolve(null), 500));
	}), payload);
}

async function removeConnections(page, from, to) {
	const found = await connectionsBetween(page, from, to);
	const ids = found.flatMap(c => c.sigs);
	if (!ids.length) return;
	await post(page, { signatures: { remove: ids }, systemID: from });
	await page.waitForFunction(([from, to]) => {
		const sigs = (tripwire.client && tripwire.client.signatures) || {};
		return !Object.values(sigs).some(s => s.type === "wormhole" && (s.systemID == from || s.systemID == to));
	}, [from, to], { timeout: 15000 });
}

test("two tabs automapping the same jump make one connection", async ({ context }) => {
	const one = await context.newPage();
	await login(one, FROM);
	const from = await one.evaluate((n) => findSystemID(n), FROM);
	const to = await one.evaluate((n) => findSystemID(n), TO);
	expect(from, "fixture system " + FROM).toBeTruthy();
	expect(to, "fixture system " + TO).toBeTruthy();
	expect(await connectionsBetween(one, from, to), "the fixture pair must start unconnected").toEqual([]);

	const two = await context.newPage();
	await login(two, FROM);

	try {
		const [r1, r2] = await Promise.all([post(one, automapPayload(from, to)), post(two, automapPayload(from, to))]);
		expect(r1 && r1[0] && r1[0].result, "tab one").toBe(true);
		expect(r2 && r2[0] && r2[0].result, "tab two").toBe(true);

		// Let both tabs sync, then count on each.
		await one.waitForFunction(([from, to]) => {
			const sigs = (tripwire.client && tripwire.client.signatures) || {};
			return Object.values(sigs).filter(s => s.type === "wormhole" && s.systemID == from).length >= 1;
		}, [from, to], { timeout: 15000 });
		await two.waitForTimeout(6000);
		expect((await connectionsBetween(one, from, to)).length, "connections seen by tab one").toBe(1);
		expect((await connectionsBetween(two, from, to)).length, "connections seen by tab two").toBe(1);
	} finally {
		await removeConnections(one, from, to).catch(() => {});
		await two.close();
		await one.close();
	}
});
