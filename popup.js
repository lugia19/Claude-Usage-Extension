/* global UsageData, isPeakHours */
'use strict';
let CONFIG;
const BLUE_HIGHLIGHT = '#2c84db';
const RED_WARNING = '#de2929';
const SUCCESS_GREEN = '#22c55e';
const WARNING_THRESHOLD = 0.9;

const LIMIT_LABELS = {
	session: 'Session (5h):',
	weekly: 'Weekly:',
	sonnetWeekly: 'Sonnet Weekly:',
	opusWeekly: 'Opus Weekly:',
	extraUsage: 'Extra Usage:'
};

function createProgressBar(percentage) {
	const container = document.createElement('div');
	container.className = 'ut-progress';

	const track = document.createElement('div');
	track.className = 'ut-progress-track';

	const bar = document.createElement('div');
	bar.className = 'ut-progress-bar';
	bar.style.width = `${Math.min(percentage, 100)}%`;
	bar.style.background = percentage >= WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;

	track.appendChild(bar);
	container.appendChild(track);
	return container;
}

function formatResetTime(timestamp) {
	if (!timestamp) return '';
	const diff = timestamp - Date.now();
	if (diff <= 0) return `<span style="color: ${SUCCESS_GREEN}">Resetting...</span>`;

	const hours = Math.floor(diff / (1000 * 60 * 60));
	const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h`;
	}
	if (hours === 0) return `${minutes}m`;
	return `${hours}h ${minutes}m`;
}

function createLimitRow(key, limit) {
	const row = document.createElement('div');
	row.className = 'ut-limit-row ut-mb-2';

	const topLine = document.createElement('div');
	topLine.className = 'ut-row ut-justify-between ut-mb-1 ut-select-none';
	topLine.style.whiteSpace = 'nowrap';

	const leftSide = document.createElement('div');
	leftSide.className = 'ut-row';

	const title = document.createElement('span');
	title.style.cssText = 'font-size: 12px; min-width: 95px; display: inline-block;';
	title.textContent = LIMIT_LABELS[key] || key;

	const percentage = document.createElement('span');
	percentage.style.cssText = 'font-size: 12px; min-width: 30px;';
	percentage.textContent = `${limit.percentage.toFixed(0)}%`;
	percentage.style.color = limit.percentage >= WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;

	leftSide.appendChild(title);
	leftSide.appendChild(percentage);

	const resetTime = document.createElement('div');
	resetTime.style.cssText = 'font-size: 11px; color: #888;';
	resetTime.dataset.resetsAt = limit.resetsAt || '';
	resetTime.innerHTML = formatResetTime(limit.resetsAt);

	topLine.appendChild(leftSide);
	topLine.appendChild(resetTime);

	row.appendChild(topLine);
	row.appendChild(createProgressBar(limit.percentage));

	return row;
}

function renderOrgUsage(orgResult, showLabel) {
	const wrapper = document.createElement('div');
	wrapper.className = 'popup-org-section';

	if (showLabel) {
		const header = document.createElement('div');
		header.className = 'popup-org-header';
		header.textContent = orgResult.orgName || orgResult.orgId.substring(0, 12) + '...';
		wrapper.appendChild(header);
	}

	const usageData = new UsageData(orgResult.usageData);
	const activeLimits = usageData.getActiveLimits();

	if (activeLimits.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'popup-empty';
		empty.textContent = 'No active limits.';
		wrapper.appendChild(empty);
		return wrapper;
	}

	for (const limit of activeLimits) {
		wrapper.appendChild(createLimitRow(limit.key, limit));
	}

	// Extra usage bar when any limit is maxed
	const hasMaxedLimit = activeLimits.some(l => l.percentage >= 100);
	if (hasMaxedLimit && usageData.hasExtraUsage()) {
		const effectiveTotal = usageData.getExtraUsageEffectiveTotal();
		const used = usageData.extraUsage.usedCredits;
		const pct = effectiveTotal > 0 ? (used / effectiveTotal) * 100 : 0;

		const row = createLimitRow('extraUsage', { percentage: pct, resetsAt: null });
		wrapper.appendChild(row);
	}

	return wrapper;
}

async function loadUsageData() {
	const container = document.getElementById('usage-container');

	try {
		// Set CONFIG global so UsageData methods work (declared in ui_dataclasses.js)
		CONFIG = await chrome.runtime.sendMessage({ type: 'getConfig' });
		const results = await chrome.runtime.sendMessage({ type: 'getPopupUsageData' });

		if (!results || results.length === 0) {
			container.innerHTML = '<div class="popup-empty">No usage data found. Open claude.ai first (and authorize the extension if necessary).</div>';
			return;
		}

		container.innerHTML = '';
		const validResults = results.filter(r => !r.error);
		const showOrgLabels = validResults.length > 1;

		for (const orgResult of validResults) {
			container.appendChild(renderOrgUsage(orgResult, showOrgLabels));
		}

		if (validResults.length === 0) {
			container.innerHTML = '<div class="popup-error">Failed to load usage data.</div>';
		}

		// Update reset countdowns every 30 seconds
		setInterval(() => {
			document.querySelectorAll('[data-resets-at]').forEach(el => {
				const resetsAt = parseInt(el.dataset.resetsAt);
				if (resetsAt) el.innerHTML = formatResetTime(resetsAt);
			});
		}, 30000);
	} catch (error) {
		console.error('Error loading usage data in popup:', error);
		container.innerHTML = '<div class="popup-error">Failed to load usage data.</div>';
	}
}

document.getElementById('debug').addEventListener('click', () => {
	chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
	window.close();
});

document.getElementById('donate').addEventListener('click', () => {
	chrome.tabs.create({ url: 'https://ko-fi.com/lugia19' });
	window.close();
});

loadUsageData();
