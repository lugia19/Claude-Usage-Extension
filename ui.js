/* global UsageData, ConversationData, sendBackgroundMessage, config:writable, getConversationId, getCurrentModel, Log, ui:writable, waitForElement, sleep, setupRateLimitMonitoring */
'use strict';

// Main UI Manager - now minimal after Phase 2 refactor
// Handles: conversation change detection, data expiry checks, background message requests
// Display logic moved to UsageUI (Phase 1) and LengthUI (Phase 2)
class UIManager {
	constructor(currModel) {
		this.currentlyDisplayedModel = currModel;
		this.usageData = null;
		this.conversationData = null;
	}

	async initialize() {
		// Initial update - just request, don't await response
		await sendBackgroundMessage({ type: 'requestData' });
		await sendBackgroundMessage({ type: 'initOrg' });

		// Start animation frame loop
		this.lastMediumUpdate = 0;
		this.mediumUpdateFrequency = Math.round(config.UI_UPDATE_INTERVAL_MS / 2);	//1500
		this.scheduleNextFrame();
	}

	scheduleNextFrame() {
		requestAnimationFrame((timestamp) => this.frameUpdate(timestamp));
	}

	async frameUpdate(timestamp) {
		if (!this.lastMediumUpdate || timestamp - this.lastMediumUpdate >= this.mediumUpdateFrequency) {
			await this.mediumFrequencyUpdates();
			this.lastMediumUpdate = timestamp;
		}

		this.scheduleNextFrame();
	}

	async mediumFrequencyUpdates() {
		// Check for conversation changes
		const newConversation = getConversationId();
		const isHomePage = newConversation === null;

		if (this.conversationData?.conversationId !== newConversation && !isHomePage) {
			// Just request, don't await response
			await Log("Conversation changed, requesting data for new conversation.");
			sendBackgroundMessage({
				type: 'requestData',
				conversationId: newConversation
			});
			if (this.conversationData) {
				this.conversationData.conversationId = newConversation;
			} else {
				this.conversationData = new ConversationData({ conversationId: newConversation });
			}
		}

		// Reset conversation data on home page
		if (isHomePage && this.conversationData !== null) {
			this.conversationData = null;
		}

		// Check if the current usage data is expired
		if (this.usageData && this.usageData.isExpired()) {
			await Log("Usage data expired, triggering reset");

			const orgId = document.cookie
				.split('; ')
				.find(row => row.startsWith('lastActiveOrg='))
				?.split('=')[1];

			if (orgId) {
				// Just trigger the reset - background will handle updating all tabs, including us
				await sendBackgroundMessage({
					type: 'checkAndResetExpired',
					orgId: orgId
				});
			}
		}
	}

	// Cache usage data for expiry checks
	updateUsageCache(usageData) {
		if (!usageData) return;
		this.usageData = UsageData.fromJSON(usageData);
	}

	// Cache conversation data for change detection
	updateConversationCache(conversationData) {
		if (!conversationData) return;
		this.conversationData = ConversationData.fromJSON(conversationData);
	}
}

// Event Handlers
// Listen for messages from background
browser.runtime.onMessage.addListener(async (message) => {
	await Log("Content received message:", message.type);

	// Cache data for UIManager's expiry/change detection
	if (message.type === 'updateUsage') {
		if (ui) ui.updateUsageCache(message.data.usageData);
	}

	if (message.type === 'updateConversationData') {
		if (ui) ui.updateConversationCache(message.data.conversationData);
	}

	if (message.type === 'getActiveModel') {
		const currModel = await getCurrentModel();
		if (!currModel && ui) return ui.currentlyDisplayedModel;
		return currModel || "Sonnet";
	}

	if (message.action === "getOrgID") {
		const orgId = document.cookie
			.split('; ')
			.find(row => row.startsWith('lastActiveOrg='))
			?.split('=')[1];
		return Promise.resolve({ orgId });
	}

	if (message.action === "getStyleId") {
		const storedStyle = localStorage.getItem('LSS-claude_personalized_style');
		let styleId;

		if (storedStyle) {
			try {
				const styleData = JSON.parse(storedStyle);
				if (styleData) styleId = styleData.styleKey;
			} catch (e) {
				// If JSON parsing fails, we'll return undefined
				await Log("error", 'Failed to parse stored style:', e);
			}
		}

		return Promise.resolve({ styleId });
	}
});

// Style injection
async function injectStyles() {
	if (document.getElementById('ut-styles')) return;

	try {
		const cssContent = await fetch(browser.runtime.getURL('tracker-styles.css')).then(r => r.text());

		// Just change these lines:
		const style = document.createElement('link');
		style.rel = 'stylesheet';
		style.id = 'ut-styles';
		style.href = `data:text/css;charset=utf-8,${encodeURIComponent(cssContent)}`;

		document.head.appendChild(style);
	} catch (error) {
		await Log("error", 'Failed to load tracker styles:', error);
	}
}

// Main initialization function
async function initExtension() {
	if (window.claudeTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;
	const LOGIN_CHECK_DELAY = 10000;
	await injectStyles();
	// Load and assign configuration to global variables
	config = await sendBackgroundMessage({ type: 'getConfig' });
	await Log("Config received...")
	await Log(config)
	let userMenuButton = null;
	while (true) {
		// Check for duplicate running with retry logic

		userMenuButton = await waitForElement(document, config.SELECTORS.USER_MENU_BUTTON, 6000);
		if (userMenuButton) {
			// Found the button, continue with initialization
			break;
		}

		// Check if we're on either login screen
		const initialLoginScreen = document.querySelector(config.SELECTORS.INIT_LOGIN_SCREEN);
		const verificationLoginScreen = document.querySelector(config.SELECTORS.VERIF_LOGIN_SCREEN);

		if (!initialLoginScreen && !verificationLoginScreen) {
			await Log("error", 'Neither user menu button nor any login screen found');
			return;
		}

		await Log('Login screen detected, waiting before retry...');
		await sleep(LOGIN_CHECK_DELAY);
	}

	if (userMenuButton.getAttribute('data-script-loaded')) {
		await Log('Script already running, stopping duplicate');
		return;
	}
	userMenuButton.setAttribute('data-script-loaded', true);
	await Log('We\'re unique, initializing Chat Token Counter...');

	await Log("Initializing fetch...")
	await setupRateLimitMonitoring();

	ui = new UIManager(await getCurrentModel());
	await ui.initialize();

	// Don't await responses anymore
	sendBackgroundMessage({ type: 'requestData' });
	sendBackgroundMessage({ type: 'initOrg' });
	await Log('Initialization complete. Ready to track tokens.');
}

(async () => {
	try {
		await initExtension();
	} catch (error) {
		await Log("error", 'Failed to initialize Chat Token Counter:', error);
	}
})();
