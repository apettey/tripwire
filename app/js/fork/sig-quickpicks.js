const sigQuickPicks = {
	/** Maximum number of quick-pick buttons per side */
	MAX: 6,

	/** Static wormhole types of a system, in data order (empty array if unknown/k-space) */
	staticsFor: function(systemID) {
		if (systemID === undefined || systemID === null || systemID === '') { return []; }
		let statics;
		if (typeof systemAnalysis !== 'undefined' && appData.systems[systemID]) {
			statics = systemAnalysis.analyse(systemID).statics;
		}
		if (!statics && appData.systems[systemID]) { statics = appData.systems[systemID].statics; }
		return Array.isArray(statics) ? statics.slice() : [];
	},

	/** Build a quick-pick item for a wormhole type key */
	item: function(key, isStatic) {
		const wh = appData.wormholes[key];
		return { key: key, static: !!isStatic, frig: !!(wh && wh.jump <= 5000000) };
	},

	/** Order eligible types with the given statics first (each group keeps its original order) and cap the list */
	orderAndCap: function(eligible, statics) {
		const keys = [];
		eligible.forEach(e => { if (keys.indexOf(e.key) < 0) { keys.push(e.key); } });
		const first = keys.filter(k => statics.indexOf(k) >= 0);
		const rest = keys.filter(k => statics.indexOf(k) < 0);
		return first.map(k => sigQuickPicks.item(k, true))
			.concat(rest.map(k => sigQuickPicks.item(k, false)))
			.slice(0, sigQuickPicks.MAX);
	},

	/** Compute the quick picks for the signature dialog.
	@param systemID The system the signature is in
	@param leadsToText The current text of the Leads To field
	@return { from: [{key, static, frig}], to: [...] } */
	compute: function(systemID, leadsToText) {
		const statics = sigQuickPicks.staticsFor(systemID);
		const text = (leadsToText || '').trim();
		const target = text ? wormholeAnalysis.targetSystemID(text, undefined) : null;
		if (target === null || target === undefined) {
			// Leads To empty (or not a recognisable system/class yet): offer this system's statics
			return { from: statics.map(k => sigQuickPicks.item(k, true)), to: [sigQuickPicks.item('K162', false)] };
		}
		const eligible = wormholeAnalysis.eligibleWormholeTypes(systemID, target);
		if (!eligible) { return { from: [], to: [] }; }
		const targetStatics = appData.systems[target] ? sigQuickPicks.staticsFor(target) : [];
		return {
			from: sigQuickPicks.orderAndCap(eligible.from, statics),
			to: sigQuickPicks.orderAndCap(eligible.to, targetStatics)
		};
	},

	/** Destination class to fill into Leads To when a static is picked with Leads To empty, or null */
	leadsToFor: function(type) {
		const wh = appData.wormholes[(type || '').toUpperCase()];
		if (!wh || typeof wh.leadsTo !== 'string') { return null; }
		const generic = appData.genericSystemTypes || [];
		return generic.indexOf(wh.leadsTo) >= 0 ? wh.leadsTo : null;
	}
};

if (typeof window !== "undefined" && typeof jQuery !== "undefined" && jQuery.fn && jQuery.fn.dialog) {
	$(function() {
		const dialogSel = "#dialog-signature";

		function render(elem, items, currentValue) {
			if (!elem) { return; }
			elem.innerHTML = '';
			const current = (currentValue || '').toUpperCase();
			items.forEach(type => {
				const button = document.createElement('button');
				button.className = 'quick-select' + (type.frig ? ' frig' : '') + (type.static ? ' static' : '') +
					(type.key === current ? ' selected' : '');
				if (type.static) { button.title = 'Static'; }
				button.textContent = type.key;
				button.value = type.key;
				button.type = 'button';	// otherwise it is 'submit'
				button.tabIndex = -1;	// keyboard users will just want to type in the autocomplete field
				elem.appendChild(button);
			});
		}

		function renderAll() {
			if (typeof sigDialogVM === 'undefined' || !sigDialogVM.viewingSystemID) { return; }
			const leads = $(dialogSel + " [name='leadsTo']").val();
			const picks = sigQuickPicks.compute(sigDialogVM.viewingSystemID, leads);
			render(document.getElementById('wormholeTypeQuickSelectFrom'), picks.from, $(dialogSel + " input[name='wormholeType']").val());
			render(document.getElementById('wormholeTypeQuickSelectTo'), picks.to, $(dialogSel + " input[name='wormholeType2']").val());
		}

		// Run after upstream's handlers (and after the dialog's open callback has filled the fields)
		function scheduleRender() { setTimeout(renderAll, 0); }

		$(document).on("dialogopen", dialogSel, scheduleRender);
		$(document).on("selectmenuchange", dialogSel + " [name='signatureType']", scheduleRender);
		$(document).on("change input", dialogSel + " [name='leadsTo']", scheduleRender);
		$(document).on("change input", dialogSel + " .wormholeType", scheduleRender);

		// Picking a static with Leads To empty also fills Leads To with the static's destination class.
		// Upstream's own click handler (bound directly on the span) has already set the type input.
		$(document).on("click", dialogSel + " #wormholeTypeQuickSelectFrom button.static", function() {
			const leadsTo = $(dialogSel + " [name='leadsTo']");
			if ((leadsTo.val() || '').trim()) { return; }
			const dest = sigQuickPicks.leadsToFor(this.value);
			if (dest) { leadsTo.val(dest).change(); }
		});
	});
}
