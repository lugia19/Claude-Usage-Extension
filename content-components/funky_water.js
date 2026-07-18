/* global localize, setupTooltip, getTooltipPortal */
'use strict';

// Funky "water waste" visuals — converts estimated token usage into a playful
// datacenter-cooling-water equivalent. Purely cosmetic; nothing here affects tracking.

// Napkin math, in the proud tradition of ESTIMATED_CAPS: a commonly cited estimate
// ("Making AI Less Thirsty", Li et al. 2023) puts a chatbot exchange at roughly
// ~10-50 mL of datacenter cooling water. Claude exchanges move a LOT of tokens
// (full history each time), so we land on ~1 mL per 1k tokens.
const ML_PER_TOKEN = 0.001;

const GLASS_ML = 250;
const BOTTLE_ML = 500;
const BUCKET_ML = 10000;
const BATHTUB_ML = 150000;

// Shared setting accessor — content scripts can touch storage directly.
async function isFunkyWaterEnabled() {
	const { funkyWaterEnabled } = await browser.storage.local.get('funkyWaterEnabled');
	return funkyWaterEnabled !== false; // default: on
}

// Small "💧 ~2.3 L of water · ≈ 4 bottles" line that lives under the sidebar usage bars.
class WaterWidget {
	constructor() {
		this.element = document.createElement('div');
		this.element.className = 'ut-water-line text-text-400 text-xs';
		this.element.style.display = 'none';

		this.tooltip = document.createElement('div');
		this.tooltip.className = 'bg-[var(--cds-tooltip-bg)] text-[var(--cds-tooltip-fg)] ut-tooltip shadow-sm dark:shadow-panel-sm';
		this.tooltip.textContent = localize('usage.water_tooltip');
		this.tooltip.style.maxWidth = '300px';
		this.tooltip.style.whiteSpace = 'normal';
		getTooltipPortal().appendChild(this.tooltip);
		setupTooltip(this.element, this.tooltip, { topOffset: 10 });

		this.enabled = true;
		this.tokens = null;
	}

	setEnabled(enabled) {
		this.enabled = enabled;
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

		const ml = this.tokens * ML_PER_TOKEN;

		// Emoji escalates with the damage.
		let emoji = '💧';
		if (ml >= BATHTUB_ML) emoji = '🛁';
		else if (ml >= BUCKET_ML) emoji = '🪣';
		else if (ml >= 1000) emoji = '🚰';

		// Primary amount.
		let amount;
		if (ml >= 1000) {
			amount = localize('usage.water_liters', { n: (ml / 1000).toFixed(1) });
		} else {
			const rounded = ml >= 100 ? Math.round(ml / 10) * 10 : Math.round(ml);
			amount = localize('usage.water_ml', { n: rounded });
		}

		// Friendly equivalent, largest applicable unit (singular keys when it rounds to 1).
		const equivFor = (unitMl, singularKey, pluralKey) => {
			const n = Math.round(ml / unitMl);
			return localize(n === 1 ? singularKey : pluralKey, { n });
		};
		let equiv = '';
		if (ml >= BATHTUB_ML) equiv = equivFor(BATHTUB_ML, 'usage.water_bathtub', 'usage.water_bathtubs');
		else if (ml >= BUCKET_ML) equiv = equivFor(BUCKET_ML, 'usage.water_bucket', 'usage.water_buckets');
		else if (ml >= BOTTLE_ML * 4) equiv = equivFor(BOTTLE_ML, 'usage.water_bottle', 'usage.water_bottles');
		else if (ml >= GLASS_ML) equiv = equivFor(GLASS_ML, 'usage.water_glass', 'usage.water_glasses');

		this.element.textContent = equiv ? `${emoji} ${amount} · ${equiv}` : `${emoji} ${amount}`;
		this.element.style.display = '';
	}
}
