/* global localize, fmtNum, setupTooltip, getTooltipPortal */
'use strict';

// Funky "water waste" visuals — converts estimated token usage into a datacenter
// cooling-water equivalent, anchored to peer-reviewed estimates. Purely cosmetic;
// nothing here affects tracking.
//
// EVIDENCE MODEL
//   Per-request water = server_energy × [on-site-WUE + PUE × off-site-EWIF]
// (scope-1 evaporative cooling + scope-2 electricity generation), as given by:
//   Li, Yang, Islam & Ren (2025), "Making AI Less 'Thirsty': Uncovering and
//   Addressing the Secret Water Footprint of AI Models", arXiv:2304.03271 (v5),
//   accepted in Communications of the ACM. Table 1 reports per-request operational
//   water *consumption* for a "medium-sized request" (≤800-word input + 150–300-word
//   output ≈ ~1,300 tokens) across Microsoft datacenter regions.
// We convert each regional figure to a per-1k-token factor (×1000/~1300) and expose
// a few as selectable presets. The on-screen RANGE always spans the paper's reported
// best-case (Ireland, dry-cooled) to worst-case (Washington, hydro-heavy EWIF).
//
// CAVEATS (surfaced in the tooltip)
//   • Figures are for GPT-3 in Microsoft datacenters. Anthropic does NOT publicly
//     disclose Claude's per-request water — Claude runs on AWS + GCP with different
//     PUE/WUE, so the absolute value is uncertain.
//   • Assumes roughly linear per-token scaling (defensible for Claude, which re-reads
//     the full conversation history every turn — i.e. what this tracker measures).
//   • INCLUDES only operational scope-1 + scope-2 water. EXCLUDES training water
//     (millions of liters amortized over a model's life), scope-3 chip/supply-chain
//     water (Apple reports ~99% of its water footprint is supply-chain), and any
//     reclaimed/off-grid offsets.
//   • Vendor disclosures span orders of magnitude (e.g. Google's 2025 self-report of
//     ~0.26 mL/prompt for Gemini is far below academic estimates, due to newer
//     water-offset infra and smaller prompts). The "true" value may be lower or
//     higher than the central estimate.

// mL of (scope-1 + scope-2) water consumed per 1,000 tokens, derived from Table 1
// of Li et al. (2025), assuming a ~1,300-token "medium request".
const ML_PER_1K = {
	best:    7.107  * 1000 / 1300, // Ireland (dry-cooled; near-zero on-site, low PUE)
	us_avg:  16.904 * 1000 / 1300, // U.S. average across Microsoft regions
	aws_va:  11.435 * 1000 / 1300, // Virginia (AWS us-east-1 is a major Claude host)
	hot:     29.926 * 1000 / 1300, // Arizona (hot, cooling-tower heavy)
	worst:   47.506 * 1000 / 1300, // Washington (high grid EWIF, hydro evaporation)
};

const GLASS_ML = 250;
const BOTTLE_ML = 500;
const BUCKET_ML = 10000;     // 10 L
const BATHTUB_ML = 150000;   // 150 L

// Shared settings accessors — content scripts touch storage directly.
async function isFunkyWaterEnabled() {
	const { funkyWaterEnabled } = await browser.storage.local.get('funkyWaterEnabled');
	return funkyWaterEnabled !== false; // default: on
}

async function getFunkyWaterPreset() {
	const { funkyWaterPreset } = await browser.storage.local.get('funkyWaterPreset');
	return ML_PER_1K[funkyWaterPreset] ? funkyWaterPreset : 'us_avg';
}

function formatAmount(ml) {
	return formatWith(ml, 'usage.water_liters', 'usage.water_ml');
}

// Compact variant for the range subline (no "of water" suffix).
function formatAmountShort(ml) {
	return formatWith(ml, 'usage.water_short_liters', 'usage.water_short_ml');
}

// Adaptive precision: ≥10 L as integer (with thousands sep via fmtNum),
// 1–10 L to 1 decimal, ≥100 mL rounded to nearest 10, else integer mL.
function formatWith(ml, literKey, mlKey) {
	if (ml >= 1000) {
		const liters = ml / 1000;
		const n = liters >= 10 ? fmtNum(Math.round(liters)) : liters.toFixed(1);
		return localize(literKey, { n });
	}
	const rounded = ml >= 100 ? Math.round(ml / 10) * 10 : Math.round(ml);
	return localize(mlKey, { n: rounded });
}

// "💧 ~2.3 L of water" headline + "est. 16–110 L" range subline, with a tooltip
// carrying the full methodology + citations + caveats. Lives under the sidebar bars.
class WaterWidget {
	constructor() {
		this.element = document.createElement('div');
		this.element.className = 'ut-water-line text-text-400 text-xs';
		this.element.style.display = 'none';

		this.headline = document.createElement('div');
		this.headline.className = 'ut-water-headline';
		this.rangeLine = document.createElement('div');
		this.rangeLine.className = 'ut-water-range';
		this.element.appendChild(this.headline);
		this.element.appendChild(this.rangeLine);

		this.tooltip = document.createElement('div');
		this.tooltip.className = 'bg-[var(--cds-tooltip-bg)] text-[var(--cds-tooltip-fg)] ut-tooltip shadow-sm dark:shadow-panel-sm';
		this.tooltip.style.maxWidth = '340px';
		this.tooltip.style.whiteSpace = 'normal';
		this.tooltip.style.textAlign = 'left';
		getTooltipPortal().appendChild(this.tooltip);
		setupTooltip(this.element, this.tooltip, { topOffset: 10 });

		this.enabled = true;
		this.tokens = null;
		this.preset = 'us_avg';
	}

	setEnabled(enabled) {
		this.enabled = enabled;
		this.update();
	}

	setPreset(preset) {
		this.preset = ML_PER_1K[preset] ? preset : 'us_avg';
		this.update();
	}

	// Pass the estimated session tokens used, or null when unknown (hides the line).
	setTokens(tokens) {
		this.tokens = tokens;
		this.update();
	}

	update() {
		if (!this.enabled || this.tokens == null) {
			this.element.style.display = 'none';
			return;
		}

		const tokens = this.tokens;
		const central = (tokens / 1000) * ML_PER_1K[this.preset];
		const low = (tokens / 1000) * ML_PER_1K.best;
		const high = (tokens / 1000) * ML_PER_1K.worst;

		// Emoji escalates with the damage (based on the central estimate).
		let emoji = '💧';
		if (central >= BATHTUB_ML) emoji = '🛁';
		else if (central >= BUCKET_ML) emoji = '🪣';
		else if (central >= 1000) emoji = '🚰';

		// Friendly equivalent (largest applicable unit, singular keys at n===1).
		const equivFor = (unitMl, singularKey, pluralKey) => {
			const n = Math.round(central / unitMl);
			return localize(n === 1 ? singularKey : pluralKey, { n });
		};
		let equiv = '';
		if (central >= BATHTUB_ML) equiv = equivFor(BATHTUB_ML, 'usage.water_bathtub', 'usage.water_bathtubs');
		else if (central >= BUCKET_ML) equiv = equivFor(BUCKET_ML, 'usage.water_bucket', 'usage.water_buckets');
		else if (central >= BOTTLE_ML) equiv = equivFor(BOTTLE_ML, 'usage.water_bottle', 'usage.water_bottles');
		else if (central >= GLASS_ML) equiv = equivFor(GLASS_ML, 'usage.water_glass', 'usage.water_glasses');

		this.headline.textContent = equiv ? `${emoji} ${formatAmount(central)} ${equiv}` : `${emoji} ${formatAmount(central)}`;
		this.rangeLine.textContent = localize('usage.water_range', { low: formatAmountShort(low), high: formatAmountShort(high) });

		this.tooltip.textContent = localize('usage.water_tooltip', {
			tokens: fmtNum(Math.round(tokens)),
			best: (ML_PER_1K.best).toFixed(1),
			worst: (ML_PER_1K.worst).toFixed(1)
		});

		this.element.style.display = '';
	}
}