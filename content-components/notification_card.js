/* global Log, RED_WARNING, BLUE_HIGHLIGHT, sendBackgroundMessage, SUCCESS_GREEN */
'use strict';

const DONATION_1M = 1000000;
const DONATION_10M = 10000000;

function openDebugOverlay() {
	// Remove existing overlay if present
	const existing = document.getElementById('ut-debug-overlay');
	if (existing) { existing.remove(); return; }

	const overlay = document.createElement('div');
	overlay.id = 'ut-debug-overlay';
	overlay.style.cssText = 'position:;inset:0;z-index:99999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';

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

// Base class for notification cards with optional image link (e.g. store rating)
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
		dragHandle.textContent = 'Usage Tracker';

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = `Updated from v${this.previousVersion} to v${this.currentVersion}!`;

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);

		if (this.patchHighlights?.length > 0) {
			const patchContainer = document.createElement('div');
			patchContainer.className = 'bg-bg-000 ut-content-box ut-text-left ut-mb-2';
			patchContainer.style.maxHeight = '150px';

			const patchTitle = document.createElement('div');
			patchTitle.textContent = "What's New:";
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
		patchNotesLink.textContent = 'View full release notes';
		this.element.appendChild(patchNotesLink);

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
		dragHandle.textContent = 'Usage Tracker';

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = `You've tracked over ${this.tokenMillions}M tokens!`;

		this.element.appendChild(dragHandle);
		this.element.appendChild(message);

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
		dragHandle.textContent = 'Usage Tracker';

		const message = document.createElement('div');
		message.className = 'ut-mb-2';
		message.textContent = 'Enjoying the Usage Tracker?';

		const supportMessage = document.createElement('div');
		supportMessage.className = 'ut-mb-2';
		supportMessage.style.fontWeight = 'bold';
		supportMessage.textContent = 'Consider leaving a rating!';

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
		this.element.style.maxWidth = '350px';
	}

	async build() {
		const dragHandle = document.createElement('div');
		dragHandle.className = 'border-b border-border-400 ut-header text-sm';
		dragHandle.textContent = 'Settings';
		this.element.appendChild(dragHandle);

		const label = document.createElement('label');
		label.className = 'ut-label text-sm';
		label.textContent = 'API Key (more accurate):';

		const input = document.createElement('input');
		input.type = 'password';
		input.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input ut-w-full text-sm';
		let apiKey = await sendBackgroundMessage({ type: 'getAPIKey' })
		if (apiKey) input.value = apiKey

		const saveButton = document.createElement('button');
		saveButton.textContent = 'Save';
		saveButton.className = 'ut-button text-sm';
		saveButton.style.background = BLUE_HIGHLIGHT;
		saveButton.style.color = 'white';

		// Button container
		const buttonContainer = document.createElement('div');
		buttonContainer.className = 'ut-row';

		const debugButton = document.createElement('button');
		debugButton.textContent = 'Debug Logs';
		debugButton.className = 'bg-bg-300 border border-border-400 text-text-400 ut-button text-sm';

		// Event listeners
		debugButton.addEventListener('click', async () => {
			const result = await sendBackgroundMessage({ type: 'openDebugPage' });
			if (result === 'fallback') {
				openDebugOverlay();
			}
			this.remove();
		});

		saveButton.addEventListener('click', async () => {
			let result = await sendBackgroundMessage({ type: 'setAPIKey', newKey: input.value });

			if (!result) {
				const errorMsg = document.createElement('div');
				errorMsg.className = 'text-sm';
				errorMsg.style.color = RED_WARNING;
				errorMsg.textContent = input.value.startsWith('sk-ant')
					? 'Inactive API key. Have you ever loaded credits to the account?'
					: 'Invalid API key. Format looks wrong, it should start with sk-ant.';
				input.after(errorMsg);
				setTimeout(() => errorMsg.remove(), 3000);
				return;
			}
			location.reload();
		});

		// Reset notification toggle
		const toggleContainer = document.createElement('div');
		toggleContainer.className = 'ut-row';
		toggleContainer.style.alignItems = 'start';
		toggleContainer.style.gap = '6px';
		toggleContainer.style.marginBottom = '8px';

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.id = 'ut-reset-notif-toggle';
		checkbox.checked = await sendBackgroundMessage({ type: 'getResetNotifEnabled' }) || false;
		checkbox.addEventListener('change', () => {
			sendBackgroundMessage({ type: 'setResetNotifEnabled', value: checkbox.checked });
		});

		const toggleLabel = document.createElement('label');
		toggleLabel.htmlFor = 'ut-reset-notif-toggle';
		toggleLabel.className = 'text-sm';
		toggleLabel.innerHTML = 'Usage reset notifications';

		toggleContainer.appendChild(checkbox);
		toggleContainer.appendChild(toggleLabel);

		// Assemble
		this.element.appendChild(label);
		this.element.appendChild(input);
		buttonContainer.appendChild(saveButton);
		buttonContainer.appendChild(debugButton);
		this.element.appendChild(toggleContainer);
		this.element.appendChild(buttonContainer);

		this.addCloseButton();
		this.makeCardDraggable(dragHandle);
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
		console.log("Last donation milestone:", last, "Total tokens:", totalTokens);

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