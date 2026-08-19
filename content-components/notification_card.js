/* global Log, RED_WARNING, BLUE_HIGHLIGHT, sendBackgroundMessage, SUCCESS_GREEN, localize, SUPPORTED_LOCALES,
   usageUI, getSidebarDisplayPrefs, setSidebarDisplayPrefs, isSidebarItemVisible */
'use strict';

const DONATION_1M = 1000000;
const DONATION_10M = 10000000;

// Native language display names for the settings override dropdown. These are intentionally NOT
// translated — each language is shown in its own script so users recognize their own language.
const LANGUAGE_NATIVE_NAMES = {
	en: 'English',
	fr: 'Français',
	de: 'Deutsch',
	hi: 'हिन्दी',
	id: 'Bahasa Indonesia',
	it: 'Italiano',
	ja: '日本語',
	ko: '한국어',
	'pt-BR': 'Português (Brasil)',
	es: 'Español',
};

function openDebugOverlay() {
	// Remove existing overlay if present
	const existing = document.getElementById('ut-debug-overlay');
	if (existing) { existing.remove(); return; }

	const overlay = document.createElement('div');
	overlay.id = 'ut-debug-overlay';
	overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

	const closeBtn = document.createElement('button');
	closeBtn.textContent = '\u00D7';
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

// Draggable functionality for cards
function makeDraggable(element, dragHandle = null) {
	let isDragging = false;
	let currentX;
	let currentY;
	let initialX;
	let initialY;
	let pointerId = null; // Track which pointer is dragging

	// If no specific drag handle is provided, the entire element is draggable
	const dragElement = dragHandle || element;

	function handleDragStart(e) {
		// Only start dragging if we're not already dragging
		if (isDragging) return;

		isDragging = true;
		pointerId = e.pointerId;

		// Capture the pointer to this element
		dragElement.setPointerCapture(e.pointerId);

		initialX = e.clientX - element.offsetLeft;
		initialY = e.clientY - element.offsetTop;

		dragElement.style.cursor = 'grabbing';

		// Prevent text selection during drag
		e.preventDefault();
	}

	function handleDragMove(e) {
		if (!isDragging || e.pointerId !== pointerId) return;
		e.preventDefault();

		currentX = e.clientX - initialX;
		currentY = e.clientY - initialY;

		// Ensure the element stays within the viewport
		const maxX = window.innerWidth - element.offsetWidth;
		const maxY = window.innerHeight - element.offsetHeight;
		currentX = Math.min(Math.max(0, currentX), maxX);
		currentY = Math.min(Math.max(0, currentY), maxY);

		element.style.left = `${currentX}px`;
		element.style.top = `${currentY}px`;
		element.style.right = 'auto';
		element.style.bottom = 'auto';
	}

	function handleDragEnd(e) {
		if (e.pointerId !== pointerId) return;

		isDragging = false;
		pointerId = null;
		dragElement.style.cursor = dragHandle ? 'move' : 'grab';

		// Release the pointer capture
		dragElement.releasePointerCapture(e.pointerId);
	}

	// Pointer events (covers mouse, touch, and pen)
	dragElement.addEventListener('pointerdown', handleDragStart);
	dragElement.addEventListener('pointermove', handleDragMove);
	dragElement.addEventListener('pointerup', handleDragEnd);
	dragElement.addEventListener('pointercancel', handleDragEnd);

	// Set initial cursor style
	dragElement.style.cursor = dragHandle ? 'move' : 'grab';

	// Prevent touch scrolling when dragging
	dragElement.style.touchAction = 'none';

	// Return a cleanup function
	return () => {
		dragElement.removeEventListener('pointerdown', handleDragStart);
		dragElement.removeEventListener('pointermove', handleDragMove);
		dragElement.removeEventListener('pointerup', handleDragEnd);
		dragElement.removeEventListener('pointercancel', handleDragEnd);
	};
}

// Base floating card class
class FloatingCard {
	constructor() {
		// Electron needs extra top offset to clear the toolbar in the content pane
		const isElectronClient = !!document.querySelector('.dframe-content-inner');
		this.defaultPosition = { top: isElectronClient ? '40px' : '20px', right: '20px' };
		this.element = document.createElement('div');
		this.element.className = 'bg-bg-100 border border-border-400 text-text-000 ut-card';
	}

	addCloseButton() {
		const closeButton = document.createElement('button');
		closeButton.className = 'ut-button ut-close text-base';
		closeButton.style.color = BLUE_HIGHLIGHT;
		closeButton.style.background = 'none';
		closeButton.textContent = '×';
		closeButton.addEventListener('click', () => this.remove());
		this.element.appendChild(closeButton);
	}

	show(position) {
		// If position is provided, use it instead of default
		if (position) {
			// Clear any previous position styles
			['top', 'right', 'bottom', 'left'].forEach(prop => {
				this.element.style[prop] = null;
			});
			// Apply new position
			Object.entries(position).forEach(([key, value]) => {
				this.element.style[key] = typeof value === 'number' ? `${value}px` : value;
			});
		} else {
			// Apply default position
			Object.entries(this.defaultPosition).forEach(([key, value]) => {
				this.element.style[key] = value;
			});
		}
		// On Electron, inject into content area so cards don't overlap window controls.
		// Ensure the mount is a positioning context so `top`/`right` are relative to it.
		const electronMount = document.querySelector('.dframe-content-inner');
		if (electronMount) {
			if (getComputedStyle(electronMount).position === 'static') {
				electronMount.style.position = 'relative';
			}
			this.element.style.position = 'absolute';
			electronMount.appendChild(this.element);
		} else {
			document.body.appendChild(this.element);
		}
	}

	makeCardDraggable(dragHandle = null) {
		this.cleanup = makeDraggable(this.element, dragHandle);
	}

	remove() {
		if (this.cleanup) {
			this.cleanup();
		}
		this.element.remove();
	}
}

// Base class for notification cards with buttons (Ko-fi, QoL)
class ButtonNotificationCard extends FloatingCard {
	constructor() {
		super();
		this.element.classList.add('ut-text-center');
		this.element.style.maxWidth = '250px';
	}

	addImageButton(href, imageFile, alt) {
		const link = document.createElement('a');
		link.href = href;
		link.target = '_blank';
		link.className = 'ut-block ut-text-center';
		link.style.marginTop = '10px';

		const img = document.createElement('img');
		img.src = browser.runtime.getURL(imageFile);
		img.height = 36;
		img.style.border = '0';
		img.alt = alt;
		link.appendChild(img);

		this.element.appendChild(link);
		return link;
	}

	addKofiButton() {
		this.addImageButton('https://ko-fi.com/R6R14IUBY', 'kofi-button.png', 'Buy Me a Coffee at ko-fi.com');
	}

	addQoLButton() {
		const hasQoL = document.documentElement.hasAttribute('data-claude-qol-installed');
		if (hasQoL) return;

		const isChrome = !!window.chrome && (!!window.chrome.webstore || !!window.chrome.runtime);
		const href = isChrome
			? 'https://chromewebstore.google.com/detail/claude-qol/dkdnancajokhfclpjpplkhlkbhaeejob'
			: 'https://addons.mozilla.org/en-US/firefox/addon/claude-qol/';
		const link = this.addImageButton(href, 'qol-badge.png', 'Get Claude QoL Extension');
		const img = link.querySelector('img');
		img.style.borderRadius = '4px';
		img.style.display = 'inline-block';
	}

	async addDesktopFooter() {
		const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
		if (isElectron) return;

		const footer = document.createElement('div');
		footer.className = 'ut-desktop-footer';

		const link = document.createElement('a');
		link.href = 'https://github.com/lugia19/claude-webext-patcher';
		link.target = '_blank';
		link.className = 'ut-link';
		link.style.color = BLUE_HIGHLIGHT;
		link.textContent = localize('card.desktop_cta');

		footer.appendChild(link);
		this.element.appendChild(footer);
	}

}

// Version update notification card
class VersionNotificationCard extends ButtonNotificationCard {
	constructor(previousVersion, currentVersion, patchHighlights) {
		super();
		this.previousVersion = previousVersion;
		this.currentVersion = currentVersion;
		this.patchHighlights = patchHighlights;
		this.build();
	}

	build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header';
		dragHandle.textContent = localize('card.title');

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = localize('card.updated', { a: this.previousVersion, b: this.currentVersion });

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);

		if (this.patchHighlights?.length > 0) {
			const patchContainer = document.createElement('div');
			patchContainer.className = 'bg-bg-000 ut-content-box ut-text-left ut-mb-2';
			patchContainer.style.maxHeight = '150px';

			const patchTitle = document.createElement('div');
			patchTitle.textContent = localize('card.whats_new');
			patchTitle.style.fontWeight = 'bold';
			patchTitle.className = 'ut-mb-1';
			patchContainer.appendChild(patchTitle);

			const patchList = document.createElement('ul');
			patchList.style.paddingLeft = '12px';
			patchList.style.margin = '0';
			patchList.style.listStyleType = 'disc';

			this.patchHighlights.forEach(highlight => {
				const item = document.createElement('li');
				item.textContent = highlight;
				item.style.marginBottom = '3px';
				item.style.paddingLeft = '3px';
				patchList.appendChild(item);
			});

			patchContainer.appendChild(patchList);
			this.element.appendChild(patchContainer);
		}

		const patchNotesLink = document.createElement('a');
		patchNotesLink.href = 'https://github.com/lugia19/Claude-Usage-Extension/releases';
		patchNotesLink.target = '_blank';
		patchNotesLink.className = 'ut-link ut-block ut-mb-2';
		patchNotesLink.style.color = BLUE_HIGHLIGHT;
		patchNotesLink.textContent = localize('card.release_notes');
		this.element.appendChild(patchNotesLink);

		this.addKofiButton();
		this.addQoLButton();
		this.addDesktopFooter();

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}
}

// Donation milestone notification card
class DonationNotificationCard extends ButtonNotificationCard {
	constructor(tokenMillions) {
		super();
		this.tokenMillions = tokenMillions;
		this.build();
	}

	build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header';
		dragHandle.textContent = localize('card.title');

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = localize('card.donation_milestone', { n: this.tokenMillions });

		const supportMessage = document.createElement('div');
		supportMessage.className = 'ut-mb-2';
		supportMessage.style.fontWeight = 'bold';
		supportMessage.textContent = localize('card.donation_support');

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);
		this.element.appendChild(supportMessage);

		this.addKofiButton();
		this.addQoLButton();

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}
}

// Rate extension notification card
class RateNotificationCard extends ButtonNotificationCard {
	constructor() {
		super();
		this.build();
	}

	build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header';
		dragHandle.textContent = localize('card.title');

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = localize('card.rate_enjoying');

		const supportMessage = document.createElement('div');
		supportMessage.className = 'ut-mb-2';
		supportMessage.style.fontWeight = 'bold';
		supportMessage.textContent = localize('card.rate_consider');

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);
		this.element.appendChild(supportMessage);

		const isChrome = !!window.chrome && (!!window.chrome.webstore || !!window.chrome.runtime);
		const rateUrl = isChrome
			? 'https://chromewebstore.google.com/detail/claude-usage-tracker/knemcdpkggnbhpoaaagmjiigenifejfo'
			: 'https://addons.mozilla.org/firefox/addon/claude-usage-tracker';
		this.addImageButton(rateUrl, 'rate-badge.png', 'Rate this extension');

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}
}

// Settings card
class SettingsCard extends FloatingCard {
	static currentInstance = null;

	constructor() {
		super();
		this.element.classList.add('settings-panel'); // Add the class for easier querying
		// Sized to its content rather than to a fixed width, so the right edge sits just past the
		// longest label instead of leaving a gutter. The cap keeps it on-screen on a phone, at
		// which point the columns wrap (see build()).
		this.element.style.width = 'fit-content';
		this.element.style.maxWidth = 'calc(100vw - 16px)';
	}

	// Section heading. Deliberately heavier than the plain field labels next to inputs, so the
	// four blocks read as groups rather than as more fields.
	static sectionHeading(text) {
		const heading = document.createElement('label');
		heading.className = 'ut-label text-text-100 text-sm select-none';
		heading.style.fontWeight = '600';
		heading.style.marginBottom = '6px';
		heading.textContent = text;
		return heading;
	}

	// Checkbox + clickable label pair, as used by every toggle in the card. onChange is optional —
	// most toggles are staged and only read back on Save.
	static checkboxRow(id, labelText, checked, onChange = null) {
		const row = document.createElement('div');
		row.className = 'ut-row';
		row.style.gap = '6px';

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.id = id;
		checkbox.checked = checked;
		if (onChange) checkbox.addEventListener('change', () => onChange(checkbox.checked));

		const label = document.createElement('label');
		label.htmlFor = id;
		label.className = 'text-sm';
		label.textContent = labelText;

		row.appendChild(checkbox);
		row.appendChild(label);
		return { row, checkbox };
	}

	async build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header text-sm';
		dragHandle.textContent = localize('card.settings_title');
		this.element.appendChild(dragHandle);

		// Flex rather than grid: each column takes only the width its content needs (a grid's 1fr
		// tracks would split the card evenly and leave the short right column padded out). Wrapping
		// drops the right column below the left once the viewport cap squeezes the card.
		const columns = document.createElement('div');
		columns.style.display = 'flex';
		columns.style.flexWrap = 'wrap';
		columns.style.gap = '0 20px';
		columns.style.alignItems = 'flex-start';

		const leftColumn = document.createElement('div');
		leftColumn.style.flex = '0 1 auto';
		leftColumn.style.minWidth = '210px';

		const rightColumn = document.createElement('div');
		rightColumn.style.flex = '0 1 auto';

		columns.appendChild(leftColumn);
		columns.appendChild(rightColumn);

		const input = document.createElement('input');
		input.type = 'password';
		input.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input ut-w-full text-sm';
		let apiKey = await sendBackgroundMessage({ type: 'getAPIKey' })
		if (apiKey) input.value = apiKey
		const initialApiKey = input.value;

		const saveButton = document.createElement('button');
		saveButton.textContent = localize('card.save');
		saveButton.className = 'ut-button text-sm';
		saveButton.style.background = BLUE_HIGHLIGHT;
		saveButton.style.color = 'white';

		// Button container
		const buttonContainer = document.createElement('div');
		buttonContainer.className = 'ut-row';

		const debugButton = document.createElement('button');
		debugButton.textContent = localize('common.debug_logs');
		debugButton.className = 'bg-bg-300 border border-border-400 text-text-400 ut-button text-sm';

		// Event listeners
		debugButton.addEventListener('click', async () => {
			const result = await sendBackgroundMessage({ type: 'openDebugPage' });
			if (result === 'fallback') {
				openDebugOverlay();
			}
			this.remove();
		});

		// Nothing in this card persists until Save. Every control just holds its value in the DOM,
		// so closing the card discards (it is rebuilt from storage on each open), and Save commits
		// the lot and reloads — the reload is what re-applies everything, instead of each control
		// having to patch the live UI itself.
		saveButton.addEventListener('click', async () => {
			// The key is the only setting that can fail, and validating it hits the network, so
			// only touch it when it actually changed — a language-only edit shouldn't wait on
			// (or be rejected by) that round trip.
			if (input.value !== initialApiKey) {
				const result = await sendBackgroundMessage({ type: 'setAPIKey', newKey: input.value });

				if (!result) {
					const errorMsg = document.createElement('div');
					errorMsg.className = 'text-sm';
					errorMsg.style.color = RED_WARNING;
					errorMsg.textContent = input.value.startsWith('sk-ant')
						? localize('card.api_key_inactive')
						: localize('card.api_key_invalid');
					input.after(errorMsg);
					setTimeout(() => errorMsg.remove(), 3000);
					return; // abort before anything else is written, so the card never half-commits
				}
			}

			await Promise.all([
				sendBackgroundMessage({ type: 'setResetNotifEnabled', value: checkbox.checked }),
				sendBackgroundMessage({ type: 'setResetNotifThreshold', value: Number(thresholdInput.value) }),
				sendBackgroundMessage({ type: 'setLanguageOverride', value: langSelect.value || null }),
				setSidebarDisplayPrefs(this.collectSidebarDisplayPrefs()),
			]);

			location.reload();
		});

		// Reset notification section: heading, then "Enabled" + the arming threshold on one row
		const resetContainer = document.createElement('div');
		resetContainer.className = 'ut-container';

		const resetHeading = SettingsCard.sectionHeading(localize('card.reset_notif_toggle'));

		const resetRow = document.createElement('div');
		resetRow.className = 'ut-row';
		// "Enabled" and the threshold share a line in English, but locales with longer labels
		// (German's "Benachrichtigen ab:") overflow the column — let the threshold drop below.
		resetRow.style.flexWrap = 'wrap';
		resetRow.style.rowGap = '6px';

		const { row: toggleGroup, checkbox } = SettingsCard.checkboxRow(
			'ut-reset-notif-toggle',
			localize('card.reset_notif_enabled'),
			await sendBackgroundMessage({ type: 'getResetNotifEnabled' }) || false,
			(enabled) => setThresholdEnabled(enabled) // purely local; persisted on Save
		);

		// Usage % at which the reset notification gets armed
		const thresholdGroup = document.createElement('div');
		thresholdGroup.className = 'ut-row';
		thresholdGroup.style.gap = '6px';
		thresholdGroup.style.marginLeft = 'auto';

		const thresholdLabel = document.createElement('label');
		thresholdLabel.htmlFor = 'ut-reset-notif-threshold';
		thresholdLabel.className = 'text-sm';
		thresholdLabel.style.whiteSpace = 'nowrap'; // it would wrap to two lines in the narrow column
		thresholdLabel.textContent = localize('card.reset_notif_threshold');

		const thresholdInput = document.createElement('input');
		thresholdInput.type = 'number';
		thresholdInput.id = 'ut-reset-notif-threshold';
		thresholdInput.min = '1';
		thresholdInput.max = '100';
		thresholdInput.step = '1';
		thresholdInput.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input text-sm';
		thresholdInput.style.width = '56px';
		thresholdInput.style.marginBottom = '0'; // ut-input's bottom margin would break the row's alignment
		thresholdInput.value = await sendBackgroundMessage({ type: 'getResetNotifThreshold' }) ?? 100;

		// Clamped as you type for immediate feedback; the value is persisted on Save.
		thresholdInput.addEventListener('change', () => {
			const n = Number(thresholdInput.value);
			thresholdInput.value = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 100;
		});

		const thresholdSuffix = document.createElement('span');
		thresholdSuffix.className = 'text-sm';
		thresholdSuffix.textContent = '%';

		// The threshold only means anything while notifications are on
		const setThresholdEnabled = (enabled) => {
			thresholdInput.disabled = !enabled;
			thresholdGroup.style.opacity = enabled ? '1' : '0.5';
		};
		setThresholdEnabled(checkbox.checked);

		thresholdGroup.appendChild(thresholdLabel);
		thresholdGroup.appendChild(thresholdInput);
		thresholdGroup.appendChild(thresholdSuffix);

		resetRow.appendChild(toggleGroup);
		resetRow.appendChild(thresholdGroup);
		resetContainer.appendChild(resetHeading);
		resetContainer.appendChild(resetRow);

		// Language override dropdown
		const langContainer = document.createElement('div');
		langContainer.className = 'ut-container';

		const langHeading = SettingsCard.sectionHeading(localize('card.section_language'));

		const langSelect = document.createElement('select');
		langSelect.id = 'ut-language-override';
		langSelect.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input text-sm';
		langSelect.style.width = '100%';

		const autoOpt = document.createElement('option');
		autoOpt.value = '';
		autoOpt.textContent = localize('card.language_auto');
		langSelect.appendChild(autoOpt);

		for (const loc of SUPPORTED_LOCALES) {
			const opt = document.createElement('option');
			opt.value = loc;
			opt.textContent = LANGUAGE_NATIVE_NAMES[loc] || loc;
			langSelect.appendChild(opt);
		}

		// Preselect after options are appended ('' selects the Auto option).
		const currentOverride = await sendBackgroundMessage({ type: 'getLanguageOverride' });
		langSelect.value = currentOverride || '';

		langContainer.appendChild(langHeading);
		langContainer.appendChild(langSelect);

		// Assemble
		leftColumn.appendChild(SettingsCard.sectionHeading(localize('card.section_api_key')));
		leftColumn.appendChild(input);
		leftColumn.appendChild(resetContainer);
		leftColumn.appendChild(langContainer);

		rightColumn.appendChild(await this.buildSidebarDisplaySection());

		buttonContainer.appendChild(saveButton);
		buttonContainer.appendChild(debugButton);
		this.element.appendChild(columns);
		this.element.appendChild(buttonContainer);

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
	}

	// One checkbox per bar this account actually has, plus the desktop link. Built from the live
	// usage data rather than a fixed list, so nobody gets a toggle for a bar they never see.
	async buildSidebarDisplaySection() {
		const container = document.createElement('div');
		container.className = 'ut-container';
		container.appendChild(SettingsCard.sectionHeading(localize('card.section_sidebar_display')));

		// Kept so the save handler can read the boxes back, and so the stored object can be merged
		// rather than replaced (a pref for a limit not listed this session must survive).
		this.storedSidebarPrefs = await getSidebarDisplayPrefs();
		this.sidebarDisplayBoxes = new Map();
		const prefs = this.storedSidebarPrefs;

		// Union with the stored keys: if usage data hasn't landed yet, a bar hidden earlier would
		// otherwise have no checkbox and no way back on.
		const limitKeys = [...new Set([
			...usageUI.availableLimitKeys(),
			...Object.keys(prefs).filter(key => key !== 'desktopLink'),
		])];

		const addToggle = (key, label) => {
			const { row, checkbox } = SettingsCard.checkboxRow(
				`ut-sidebar-display-${key}`,
				label,
				isSidebarItemVisible(prefs, key) // no onChange: staged, written on Save
			);
			this.sidebarDisplayBoxes.set(key, checkbox);
			return row;
		};

		for (const key of limitKeys) {
			// Reuse the sidebar's own labels, minus their trailing colon, so each checkbox reads
			// exactly like the bar it controls. French writes " :", the rest a bare colon.
			const label = (usageUI.usageSection?.getLimitLabel(key) ?? key).replace(/\s*[:：]\s*$/, '');
			container.appendChild(addToggle(key, label));
		}

		// Electron never builds the desktop-version footer, so there's nothing to toggle there.
		const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
		if (!isElectron) {
			const row = addToggle('desktopLink', localize('card.sidebar_desktop_link'));
			if (limitKeys.length) row.style.marginTop = '8px'; // it isn't a limit; set it apart
			container.appendChild(row);
		}

		return container;
	}

	// Checkbox states merged over the stored object, so prefs for bars not listed this session
	// (a limit whose usage data hadn't loaded, or the desktop link on Electron) are preserved.
	collectSidebarDisplayPrefs() {
		const prefs = { ...this.storedSidebarPrefs };
		for (const [key, checkbox] of this.sidebarDisplayBoxes) {
			prefs[key] = checkbox.checked;
		}
		return prefs;
	}

	show(position) {
		if (SettingsCard.currentInstance) {
			SettingsCard.currentInstance.remove();
		}

		if (position) {
			// Get the card's width - we need to temporarily add it to the DOM to measure
			this.element.style.visibility = 'hidden';
			document.body.appendChild(this.element);
			const cardWidth = this.element.offsetWidth;
			this.element.remove();
			this.element.style.visibility = 'visible';

			// Check if card would overflow the right edge
			if (position.left + cardWidth > window.innerWidth) {
				// Adjust to align with left edge of screen with small margin
				position.left = 8;
			}
		}

		super.show(position);
		SettingsCard.currentInstance = this;
	}

	remove() {
		super.remove();
		if (SettingsCard.currentInstance === this) {
			SettingsCard.currentInstance = null;
		}
	}
}

// Floating cards actor - owns all card lifecycle
class FloatingCardsUI {
	constructor() {
		this.setupEventListeners();
		this.checkNotifications();
	}

	setupEventListeners() {
		document.addEventListener('ut:toggleSettings', async (event) => {
			await this.handleToggleSettings(event.detail);
		});
	}

	async handleToggleSettings(detail) {
		const position = detail?.position || null;

		if (SettingsCard.currentInstance) {
			SettingsCard.currentInstance.remove();
		} else {
			const settingsCard = new SettingsCard();
			await settingsCard.build();
			settingsCard.show(position);
		}
	}

	async checkNotifications() {
		// Delay to allow other extensions (like QoL) to load first
		await new Promise(resolve => setTimeout(resolve, 1000));
		await this.checkForVersionUpdate();
		await this.checkForDonationMilestone();
		await this.checkForRateReminder();
	}

	async checkForVersionUpdate() {
		const currentVersion = browser.runtime.getManifest().version;
		const storage = await browser.storage.local.get(['previousVersion']);
		const previousVersion = storage.previousVersion;

		// First install - don't show notification
		if (!previousVersion) {
			await browser.storage.local.set({ previousVersion: currentVersion });
			return;
		}

		// No version change
		if (previousVersion === currentVersion) {
			return;
		}

		// Load patch notes
		let patchHighlights = [];
		try {
			const patchNotesFile = await fetch(browser.runtime.getURL('update_patchnotes.txt'));
			if (patchNotesFile.ok) {
				const patchNotesText = await patchNotesFile.text();
				patchHighlights = patchNotesText
					.split('\n')
					.filter(line => line.trim().length > 0);
			}
		} catch (error) {
			await Log("error", "Failed to load patch notes:", error);
		}

		await browser.storage.local.set({ previousVersion: currentVersion });

		const notificationCard = new VersionNotificationCard(previousVersion, currentVersion, patchHighlights);
		notificationCard.show();
	}

	async checkForDonationMilestone() {
		// Every 10M tokens tracked, rate limited to once per 30 days
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

		const notificationCard = new DonationNotificationCard(Math.floor(next / DONATION_1M));
		notificationCard.show();
	}

	async checkForRateReminder() {

		const storage = await browser.storage.local.get(['rateReminderTime', 'rateReminderShown']);

		if (!storage.rateReminderTime) {
			await browser.storage.local.set({ rateReminderTime: Date.now() + 7 * 24 * 60 * 60 * 1000 });
			return;
		}

		if (storage.rateReminderShown) return;
		if (Date.now() < storage.rateReminderTime) return;

		await browser.storage.local.set({ rateReminderShown: true });

		const notificationCard = new RateNotificationCard();
		notificationCard.show();
	}
}

// Self-initialize
const floatingCardsUI = new FloatingCardsUI();