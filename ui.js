/* global UsageData, ConversationData, SidebarUI, ChatUI, NotificationCard, sendBackgroundMessage, config:writable, getConversationId, getCurrentModel, findSidebarContainers, Log, ui:writable, waitForElement, sleep, initializeFetch */
'use strict';

// Main UI Manager
class UIManager {
	constructor(currModel) {
		this.currentlyDisplayedModel = currModel;
		this.sidebarUI = new SidebarUI(this);
		this.chatUI = new ChatUI();
		this.currentConversation = -1;
		this.usageData = null;          // Changed from rawModelData
		this.conversationData = null;
	}

	async initialize() {
		await this.sidebarUI.initialize();
		this.chatUI.initialize();

		// Initial update - just request, don't await response
		await sendBackgroundMessage({ type: 'requestData' });
		await sendBackgroundMessage({ type: 'initOrg' });

		// Start animation frame loop
		this.lastFullUpdate = 0;
		this.lastMediumUpdate = 0;
		this.lastHighUpdate = 0;
		this.highUpdateFrequency = Math.round(config.UI_UPDATE_INTERVAL_MS / 4);	//750
		this.mediumUpdateFrequency = Math.round(config.UI_UPDATE_INTERVAL_MS / 2);	//1500
		this.fullUpdateFrequency = config.UI_UPDATE_INTERVAL_MS;	//3000
		this.scheduleNextFrame();
	}

	scheduleNextFrame() {
		requestAnimationFrame((timestamp) => this.frameUpdate(timestamp));
	}

	async frameUpdate(timestamp) {
		if (!this.lastHighUpdate || timestamp - this.lastHighUpdate >= this.highUpdateFrequency) {
			await this.highFrequencyUpdates();
			this.lastHighUpdate = timestamp;
		}

		if (!this.lastMediumUpdate || timestamp - this.lastMediumUpdate >= this.mediumUpdateFrequency) {
			await this.mediumFrequencyUpdates();
			this.lastMediumUpdate = timestamp;
		}

		if (!this.lastFullUpdate || timestamp - this.lastFullUpdate >= this.fullUpdateFrequency) {
			await this.lowFrequencyUpdates();
			this.lastFullUpdate = timestamp;
		}

		this.scheduleNextFrame();
	}

	async highFrequencyUpdates() {
		const currConversation = getConversationId();
		const newModel = await getCurrentModel(200);
		if (newModel && newModel !== this.currentlyDisplayedModel) {
			// Just request data, no modelOverride needed
			await sendBackgroundMessage({
				type: 'requestData',
				conversationId: currConversation
			});
			this.currentlyDisplayedModel = newModel;
		}

		const cacheExpired = this.chatUI.updateCachedTime();
		if (cacheExpired && currConversation) {
			// Cache expired - request fresh data to update costs
			await sendBackgroundMessage({
				type: 'requestData',
				conversationId: currConversation
			});
		}

		//UI presence checks
		const sidebarContainers = await findSidebarContainers();
		await this.sidebarUI.checkAndReinject(sidebarContainers);
		await this.chatUI.checkAndReinject();
	}

	async mediumFrequencyUpdates() {
		// Check for conversation changes
		const newConversation = getConversationId();
		const isHomePage = newConversation === null;

		if (this.currentConversation !== newConversation && !isHomePage) {
			// Just request, don't await response
			await sendBackgroundMessage({
				type: 'requestData',
				conversationId: newConversation
			});
			this.currentConversation = newConversation;
		}

		// Update home page state if needed
		if (isHomePage && this.conversationData !== null) {
			this.conversationData = null;
			this.chatUI.updateEstimate();
			this.chatUI.updateCostAndLength();
			this.currentConversation = null;
		}
	}

	async lowFrequencyUpdates() {
		// Check for message limits
		const messageLimitElement = document.querySelector(config.SELECTORS.USAGE_LIMIT_LINK);
		if (messageLimitElement) {
			const limitTextElement = messageLimitElement.closest('.text-text-400');
			if (limitTextElement) {
				await sendBackgroundMessage({
					type: 'resetHit',
					model: this.currentlyDisplayedModel
				});
			}
		}
		this.chatUI.updateResetTime();
	}

	// In UIManager
	async updateUsage(usageData) {
		await Log("Updating usage data", usageData);
		if (!usageData) return;

		this.usageData = UsageData.fromJSON(usageData);

		// Update sidebar
		if (this.usageData) {
			await this.sidebarUI.updateProgressBars(this.usageData);
		}

		// Update chat UI - progress bar, reset time, and estimate if we have cost data
		if (this.chatUI && this.usageData) {
			await this.chatUI.updateUsageDisplay(this.usageData, this.currentlyDisplayedModel);
		}
	}

	async updateConversation(conversationData) {
		await Log("Updating conversation data", conversationData);
		if (!conversationData) return;

		this.conversationData = ConversationData.fromJSON(conversationData);

		// Update current model from conversation if available
		/*if (this.conversationData?.model) {
			this.currentlyDisplayedModel = this.conversationData.model;
		}*/

		// Update chat UI - cost/length AND estimate (since we have new cost data)
		if (this.chatUI && this.conversationData) {
			await this.chatUI.updateConversationDisplay(this.conversationData, this.usageData, this.currentlyDisplayedModel);
		}
	}
}

// Event Handlers
// Listen for messages from background
browser.runtime.onMessage.addListener(async (message) => {
	await Log("Content received message:", message.type);
	if (message.type === 'updateUsage') {
		if (ui) await ui.updateUsage(message.data.usageData);
	}

	if (message.type === 'updateConversationData') {
		if (ui) await ui.updateConversation(message.data.conversationData);
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
	await initializeFetch();

	ui = new UIManager(await getCurrentModel());
	await ui.initialize();

	// Don't await responses anymore
	await sendBackgroundMessage({ type: 'requestData' });
	await sendBackgroundMessage({ type: 'initOrg' });
	await Log('Initialization complete. Ready to track tokens.');
}

(async () => {
	try {
		await initExtension();
	} catch (error) {
		await Log("error", 'Failed to initialize Chat Token Counter:', error);
	}
})();