/* global Log, RED_WARNING, sendBackgroundMessage, localize, usageUI, getSidebarDisplayPrefs,
   setSidebarDisplayPrefs, isSidebarItemVisible, SIDEBAR_LINK_KEYS, LENGTH_DISPLAY_KEY, localeReady,
   FloatingCard, initNotificationCards, isChromeBrowser, ClaudeModal, createClaudeInput,
   createClaudeToggle, createLanguageSelect, setLanguageOverride */
'use strict';

// Settings modal, and the notification cards (common/ui/cards.js) with the tracker's extras.

const DONATION_1M = 1000000;
const DONATION_10M = 10000000;

const QOL_STORE_URLS = {
	chrome: 'https://chromewebstore.google.com/detail/claude-qol/dkdnancajokhfclpjpplkhlkbhaeejob',
	firefox: 'https://addons.mozilla.org/en-US/firefox/addon/claude-qol/',
};

function openDebugOverlay() {
	// Remove existing overlay if present
	const existing = document.getElementById('ut-debug-overlay');
	if (existing) { existing.remove(); return; }

	const overlay = document.createElement('div');
	overlay.id = 'ut-debug-overlay';
	overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

	const closeBtn = document.createElement('button');
	closeBtn.textContent = '×';
	closeBtn.style.cssText = 'position:absolute;top:12px;right:16px;font-size:24px;background:none;border:none;color:#666;cursor:pointer;z-index:1;';
	closeBtn.addEventListener('click', () => overlay.remove());

	const iframe = document.createElement('iframe');
	iframe.src = browser.runtime.getURL('debug.html');
	iframe.style.cssText = 'width:90vw;height:90vh;border:none;border-radius:8px;';

	overlay.appendChild(closeBtn);
	overlay.appendChild(iframe);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
	document.body.appendChild(overlay);
}

// ======== Notification card extras ========

// Cross-promotion for Claude QoL, unless it's already installed (it marks <html>).
function addQoLButton(card) {
	if (document.documentElement.hasAttribute('data-claude-qol-installed')) return;
	const link = card.addImageButton(
		isChromeBrowser() ? QOL_STORE_URLS.chrome : QOL_STORE_URLS.firefox,
		'qol-badge.png',
		'Get Claude QoL Extension'
	);
	link.querySelector('img').style.borderRadius = '4px';
}

async function addDesktopFooter(card) {
	const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
	if (isElectron) return;

	const footer = document.createElement('div');
	footer.className = 'ut-desktop-footer';

	const link = document.createElement('a');
	link.href = 'https://github.com/lugia19/claude-webext-patcher';
	link.target = '_blank';
	link.className = 'ut-link';
	link.style.color = '#2c84db';
	link.textContent = localize('card.desktop_cta');

	footer.appendChild(link);
	card.element.appendChild(footer);
}

// Every 10M tokens tracked, at most once per 30 days.
async function checkForDonationMilestone() {
	const storage = await browser.storage.local.get(['lastDonationMilestone', 'lastDonationDate']);
	const totalTokens = await sendBackgroundMessage({ type: 'getTotalTokensTracked' });

	if (storage.lastDonationMilestone == null) {
		const initial = totalTokens < DONATION_1M
			? 0
			: Math.ceil(totalTokens / DONATION_10M) * DONATION_10M;
		await browser.storage.local.set({ lastDonationMilestone: initial });
		return;
	}

	const last = storage.lastDonationMilestone;

	let next;
	if (last < DONATION_1M) next = DONATION_1M;
	else if (last < DONATION_10M) next = DONATION_10M;
	else next = last + DONATION_10M;

	if (totalTokens < next) return;

	if (storage.lastDonationDate && Date.now() - storage.lastDonationDate < 30 * 24 * 60 * 60 * 1000) return;

	await browser.storage.local.set({ lastDonationMilestone: next, lastDonationDate: Date.now() });

	const card = new FloatingCard();
	card.addHeader(localize('card.title'));
	card.addText(localize('card.donation_milestone', { n: Math.floor(next / DONATION_1M) }));
	card.addText(localize('card.donation_support'), { bold: true });
	card.addKofiButton();
	addQoLButton(card);
	card.finish().show();
}

// ======== Settings modal ========

// A titled block of settings. Heavier than the control labels, so the blocks read as groups.
function settingsSection(title) {
	const section = document.createElement('div');
	section.style.marginBottom = '14px';

	const heading = document.createElement('div');
	heading.className = 'text-sm text-text-100 select-none';
	heading.style.fontWeight = '600';
	heading.style.marginBottom = '6px';
	heading.textContent = title;
	section.appendChild(heading);
	return section;
}

// Adds a labelled switch to a section and returns its checkbox input.
function settingsToggle(section, label, checked, onChange = null) {
	const { container, input } = createClaudeToggle(label, checked, onChange);
	container.classList.add('text-sm');
	container.style.marginBottom = '6px';
	section.appendChild(container);
	return input;
}

// Nothing here persists until Save. Every control holds its value in the DOM, so Cancel discards
// (the modal is rebuilt from storage on each open), and Save commits the lot and reloads: the
// reload re-applies everything, instead of each control patching the live UI itself.
async function showSettingsModal() {
	const [apiKey, resetEnabled, resetThreshold, extraAgainstLimit, stored, sidebarPrefs, isElectron] = await Promise.all([
		sendBackgroundMessage({ type: 'getAPIKey' }),
		sendBackgroundMessage({ type: 'getResetNotifEnabled' }),
		sendBackgroundMessage({ type: 'getResetNotifThreshold' }),
		sendBackgroundMessage({ type: 'getExtraUsageAgainstLimit' }),
		browser.storage.local.get(LENGTH_DISPLAY_KEY),
		getSidebarDisplayPrefs(),
		sendBackgroundMessage({ type: 'isElectron' }),
	]);

	// Flex rather than grid: each column takes only the width its content needs, and the right
	// column wraps below the left once the modal gets too narrow (phones).
	const columns = document.createElement('div');
	columns.style.display = 'flex';
	columns.style.flexWrap = 'wrap';
	columns.style.gap = '0 28px';
	columns.style.alignItems = 'flex-start';

	const leftColumn = document.createElement('div');
	leftColumn.style.flex = '1 1 240px';
	const rightColumn = document.createElement('div');
	rightColumn.style.flex = '1 1 200px';
	columns.append(leftColumn, rightColumn);

	// API key
	const apiSection = settingsSection(localize('card.section_api_key'));
	// Not localized on purpose: it's the literal key prefix, the same in every language. It also
	// doubles as the "no key set" tell - a password field with a value renders dots.
	const apiKeyInput = createClaudeInput({ type: 'password', placeholder: 'sk-ant-...', value: apiKey || '' });
	apiKeyInput.classList.add('text-sm');
	apiSection.appendChild(apiKeyInput);
	leftColumn.appendChild(apiSection);

	// Reset notifications: the switch, then the usage % at which the notification gets armed
	const resetSection = settingsSection(localize('card.reset_notif_toggle'));
	const thresholdRow = document.createElement('div');
	thresholdRow.className = 'flex items-center gap-2 text-sm';

	const thresholdLabel = document.createElement('label');
	thresholdLabel.htmlFor = 'ut-reset-notif-threshold';
	thresholdLabel.style.whiteSpace = 'nowrap';
	thresholdLabel.textContent = localize('card.reset_notif_threshold');

	const thresholdInput = createClaudeInput({ type: 'number', value: resetThreshold ?? 100 });
	thresholdInput.id = 'ut-reset-notif-threshold';
	thresholdInput.min = '1';
	thresholdInput.max = '100';
	thresholdInput.step = '1';
	thresholdInput.classList.add('text-sm');
	thresholdInput.style.width = '72px';
	// Clamped as you type for immediate feedback; persisted on Save.
	thresholdInput.addEventListener('change', () => {
		const n = Number(thresholdInput.value);
		thresholdInput.value = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 100;
	});

	const thresholdSuffix = document.createElement('span');
	thresholdSuffix.textContent = '%';
	thresholdRow.append(thresholdLabel, thresholdInput, thresholdSuffix);

	// The threshold only means anything while notifications are on
	const setThresholdEnabled = (enabled) => {
		thresholdInput.disabled = !enabled;
		thresholdRow.style.opacity = enabled ? '1' : '0.5';
	};
	const resetToggle = settingsToggle(resetSection, localize('card.reset_notif_enabled'), resetEnabled === true, setThresholdEnabled);
	setThresholdEnabled(resetToggle.checked);
	resetSection.appendChild(thresholdRow);
	leftColumn.appendChild(resetSection);

	// Language (shared with every extension using claude-ext-common)
	const langSection = settingsSection(localize('card.section_language'));
	const langSelect = createLanguageSelect();
	langSelect.classList.add('text-sm');
	langSection.appendChild(langSelect);
	leftColumn.appendChild(langSection);

	// Sidebar display: one switch per bar this account actually has, plus the footer links. Built
	// from the live usage data, united with the stored keys so a bar hidden before its data loaded
	// still has a way back on.
	const sidebarSection = settingsSection(localize('card.section_sidebar_display'));
	const sidebarBoxes = new Map();
	const limitKeys = [...new Set([
		...usageUI.availableLimitKeys(),
		...Object.keys(sidebarPrefs).filter(key => !SIDEBAR_LINK_KEYS.includes(key)),
	])];
	for (const key of limitKeys) {
		// Reuse the sidebar's own labels, minus their trailing colon (French writes " :").
		const label = (usageUI.usageSection?.getLimitLabel(key) ?? key).replace(/\s*[:：]\s*$/, '');
		sidebarBoxes.set(key, settingsToggle(sidebarSection, label, isSidebarItemVisible(sidebarPrefs, key)));
	}
	// Electron never builds the desktop-version footer, and the QoL footer removes itself once QoL
	// is installed, so only offer toggles for links that can actually show.
	const linkToggles = [];
	if (!isElectron) {
		linkToggles.push(['desktopLink', 'card.sidebar_desktop_link']);
		if (!document.documentElement.hasAttribute('data-claude-qol-installed')) {
			linkToggles.push(['qolLink', 'card.sidebar_qol_link']);
		}
	}
	linkToggles.push(['bugLink', 'card.sidebar_bug_link']);
	linkToggles.forEach(([key, labelKey], i) => {
		const input = settingsToggle(sidebarSection, localize(labelKey), isSidebarItemVisible(sidebarPrefs, key));
		// Set the links apart from the bars above them.
		if (i === 0 && limitKeys.length) sidebarSection.lastElementChild.style.marginTop = '10px';
		sidebarBoxes.set(key, input);
	});
	rightColumn.appendChild(sidebarSection);

	// Extra usage: measured against the monthly spend limit (issue #96, the default for new installs)
	// or against what can actually be spent (the legacy behaviour, pinned for older installs).
	const extraSection = settingsSection(localize('card.section_extra_usage'));
	const extraAgainstLimitBox = settingsToggle(extraSection, localize('card.extra_usage_against_limit'), extraAgainstLimit === true);
	rightColumn.appendChild(extraSection);

	// Conversation stats (issue #66). On means shown; the stored flag is the inverse, so a missing
	// key reads as the default "shown".
	const lengthSection = settingsSection(localize('card.section_length_display'));
	const lengthDisplayBox = settingsToggle(lengthSection, localize('card.length_display_show'), stored[LENGTH_DISPLAY_KEY] !== true);
	rightColumn.appendChild(lengthSection);

	const modal = new ClaudeModal(localize('card.settings_title'), columns);
	modal.modal.style.maxWidth = '640px';

	modal.addButton(localize('common.debug_logs'), 'secondary', async () => {
		const result = await sendBackgroundMessage({ type: 'openDebugPage' });
		if (result === 'fallback') openDebugOverlay();
	});
	modal.addCancel();
	modal.addConfirm(localize('card.save'), async () => {
		// The key is the only setting that can fail, and validating it hits the network, so only
		// touch it when it actually changed.
		if (apiKeyInput.value !== (apiKey || '')) {
			const ok = await sendBackgroundMessage({ type: 'setAPIKey', newKey: apiKeyInput.value });
			if (!ok) {
				const errorMsg = document.createElement('div');
				errorMsg.className = 'text-sm';
				errorMsg.style.color = RED_WARNING;
				errorMsg.style.marginTop = '4px';
				errorMsg.textContent = apiKeyInput.value.startsWith('sk-ant')
					? localize('card.api_key_inactive')
					: localize('card.api_key_invalid');
				apiKeyInput.after(errorMsg);
				setTimeout(() => errorMsg.remove(), 3000);
				return false; // keep the modal open, and write nothing else
			}
		}

		// Merged over the stored object, so prefs for bars not listed this session survive.
		const newSidebarPrefs = { ...sidebarPrefs };
		for (const [key, box] of sidebarBoxes) newSidebarPrefs[key] = box.checked;

		setLanguageOverride(langSelect.value);
		await Promise.all([
			sendBackgroundMessage({ type: 'setResetNotifEnabled', value: resetToggle.checked }),
			sendBackgroundMessage({ type: 'setResetNotifThreshold', value: Number(thresholdInput.value) }),
			sendBackgroundMessage({ type: 'setExtraUsageAgainstLimit', value: extraAgainstLimitBox.checked }),
			browser.storage.local.set({ [LENGTH_DISPLAY_KEY]: !lengthDisplayBox.checked }),
			setSidebarDisplayPrefs(newSidebarPrefs),
		]);

		location.reload();
	});
	modal.show();
}

document.addEventListener('ut:toggleSettings', () => {
	showSettingsModal().catch(error => Log('error', 'Failed to open settings:', error));
});

// Version-update and rate cards come from common/ui/cards.js (which waits a second first, so other
// extensions like QoL can load); the donation milestone card is the tracker's own.
(async () => {
	try {
		await localeReady;
		await initNotificationCards({
			name: localize('card.title'),
			releasesUrl: 'https://github.com/lugia19/Claude-Usage-Extension/releases',
			storeUrls: {
				chrome: 'https://chromewebstore.google.com/detail/claude-usage-tracker/knemcdpkggnbhpoaaagmjiigenifejfo',
				firefox: 'https://addons.mozilla.org/firefox/addon/claude-usage-tracker',
			},
			storage: {
				get: async (key) => (await browser.storage.local.get(key))[key],
				set: (key, value) => browser.storage.local.set({ [key]: value }),
			},
			rateDelayDays: 7,
			decorate: (card, kind) => {
				if (kind !== 'version') return;
				addQoLButton(card);
				addDesktopFooter(card);
			},
		});
		await checkForDonationMilestone();
	} catch (error) {
		await Log('error', 'Notification checks failed:', error);
	}
})();
