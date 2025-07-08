'use strict';

// Main UI Manager
class UIManager {
	constructor(currModel) {
		this.currentlyDisplayedModel = currModel;
		this.sidebarUI = new SidebarUI(this);
		this.chatUI = new ChatUI();
		this.currentConversation = -1;
		this.conversationMetrics = null;
		this.rawModelData = null; // Store raw model data
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
		if (isHomePage && this.conversationMetrics !== null) {
			this.conversationMetrics = null;
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
		this.chatUI.updateResetTimeDisplay();
	}

	async updateUI(data) {
		await Log("Updating UI with data", data);
		if (!data) return;
		const { conversationMetrics, modelData } = data;

		// Store raw model data
		if (modelData) this.rawModelData = modelData;

		// Just store conversation metrics as-is
		if (conversationMetrics) {
			this.conversationMetrics = conversationMetrics;
		}

		// Update current model
		this.currentlyDisplayedModel = await getCurrentModel() || this.currentlyDisplayedModel;

		// Get the usage cap from backend
		const usageCap = await sendBackgroundMessage({ type: 'getUsageCap' });

		// Calculate weighted total for display
		const weightedTotal = calculateWeightedTotal(this.rawModelData);

		// Calculate weighted cost on-demand if we have metrics
		let displayMetrics = null;
		if (this.conversationMetrics) {
			const model = this.conversationMetrics.model || this.currentlyDisplayedModel;
			const weightedCost = Math.round(this.conversationMetrics.cost * (config.MODEL_WEIGHTS[model] || 1));
			displayMetrics = {
				...this.conversationMetrics,
				weightedCost: weightedCost
			};
		}

		const displayData = {
			modelData: {
				total: weightedTotal,
				resetTimestamp: this.rawModelData.resetTimestamp
			},
			conversationMetrics: displayMetrics
		};

		// Update both UIs with calculated data
		await this.sidebarUI.updateProgressBars(displayData, usageCap);
		await this.chatUI.updateChatUI(displayData, this.currentlyDisplayedModel, usageCap);
	}
}

// Event Handlers
// Listen for messages from background
browser.runtime.onMessage.addListener(async (message) => {
	if (message.type === 'updateUsage') {
		if (ui) await ui.updateUI(message.data);
	}

	if (message.type === 'updateConversationMetrics') {
		if (ui) {
			// Merge conversation metrics with existing data
			const currentData = {
				modelData: ui.rawModelData,
				conversationMetrics: message.data.conversationMetrics
			};
			await ui.updateUI(currentData);
		}
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

// Start the extension
(async () => {
	try {
		await initExtension();
	} catch (error) {
		await Log("error", 'Failed to initialize Chat Token Counter:', error);
	}
})();