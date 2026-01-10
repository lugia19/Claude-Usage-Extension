/* global config, Log, setupTooltip, getResetTimeHTML, sleep,
   isMobileView, UsageData, ConversationData, getConversationId, getCurrentModel,
   RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN */
'use strict';

// Length UI actor - handles all conversation-related displays
// Replaces ChatUI from Phase 1
class LengthUI {
	constructor() {
		// Cached data
		this.usageData = null;
		this.conversationData = null;
		this.currentModel = null;
		this.nextMessageCost = null;

		// Title area elements (length, cost, cache)
		this.lengthDisplay = null;
		this.costDisplay = null;
		this.cachedDisplay = null;
		this.costAndLengthContainer = null;

		// Stat line elements (estimate, reset time) - injected into ut-stat-right
		this.estimateDisplay = null;
		this.resetDisplay = null;
		this.statRightContainer = null;

		// Tooltips
		this.tooltips = {
			length: null,
			cost: null,
			cached: null,
			estimate: null,
			timer: null
		};

		// State for countdowns
		this.lastCachedUntilTimestamp = null;
		this.lastResetTimestamp = null;

		// Update loop timing
		this.lastHighUpdate = 0;
		this.lastLowUpdate = 0;
		this.highUpdateFrequency = 750;  // Cache countdown
		this.lowUpdateFrequency = 1000;  // Reset time countdown

		this.uiReady = false;
		this.pendingUsageUpdates = [];
		this.pendingConversationUpdates = [];

		this.setupMessageListeners();
		this.init();
	}

	setupMessageListeners() {
		browser.runtime.onMessage.addListener((message) => {
			if (message.type === 'updateUsage') {
				this.handleUsageUpdate(message.data.usageData);
			}
			if (message.type === 'updateConversationData') {
				this.handleConversationUpdate(message.data.conversationData);
			}
		});
	}

	async init() {
		await Log('LengthUI: Initializing...');

		// Wait for config to be available
		while (!config) {
			await sleep(100);
		}

		// Build UI elements
		this.buildTitleAreaElements();
		this.buildStatLineElements();
		this.createTooltips();

		this.uiReady = true;
		await Log('LengthUI: Ready');

		// Process any updates that arrived before we were ready
		while (this.pendingUsageUpdates.length > 0) {
			const usageDataJSON = this.pendingUsageUpdates.shift();
			this.usageData = UsageData.fromJSON(usageDataJSON);
			if (this.usageData?.resetTimestamp) {
				this.lastResetTimestamp = this.usageData.resetTimestamp;
			}
			this.updateResetTime();
		}

		while (this.pendingConversationUpdates.length > 0) {
			const conversationDataJSON = this.pendingConversationUpdates.shift();
			this.conversationData = ConversationData.fromJSON(conversationDataJSON);
			await this.updateAllDisplays();
		}

		// Start the update loop
		this.startUpdateLoop();
	}

	buildTitleAreaElements() {
		// Create container for title area displays (length, cost, cache)
		this.costAndLengthContainer = document.createElement('div');
		this.costAndLengthContainer.className = `text-text-500 text-xs !px-1 ut-select-none`;
		this.costAndLengthContainer.style.marginTop = '2px';

		// Create individual display elements for title area
		this.lengthDisplay = document.createElement('span');
		this.costDisplay = document.createElement('span');
		this.cachedDisplay = document.createElement('span');
	}

	buildStatLineElements() {
		// Create stat line elements (estimate, reset time)
		// These will be injected into ut-stat-right (created by UsageUI)
		this.estimateDisplay = document.createElement('div');
		this.estimateDisplay.className = 'text-text-400 text-xs';
		this.estimateDisplay.style.cursor = 'help';
		if (!isMobileView()) this.estimateDisplay.style.marginRight = '8px';

		this.resetDisplay = document.createElement('div');
		this.resetDisplay.className = 'text-text-400 text-xs';
		if (!isMobileView()) this.resetDisplay.style.marginRight = '8px';
	}

	createTooltips() {
		this.tooltips.length = this.createTooltip('Length of the conversation, in tokens. The longer it is, the faster your limits run out.');
		this.tooltips.cost = this.createTooltip('Estimated cost of sending another message\nIncludes ephemeral items like thinking.\nCost = length*model mult / caching factor');
		this.tooltips.cached = this.createTooltip('Follow up messages in this conversation will have a reduced cost');
		this.tooltips.estimate = this.createTooltip('Number of messages left based on the current cost');
		this.tooltips.timer = this.createTooltip('When your usage will reset to full');
	}

	createTooltip(text) {
		const tooltip = document.createElement('div');
		tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip font-normal font-ui';
		tooltip.textContent = text;
		tooltip.style.maxWidth = '400px';
		tooltip.style.textAlign = 'left';
		tooltip.style.whiteSpace = 'pre-line';  // Override the nowrap from ut-tooltip
		document.body.appendChild(tooltip);
		return tooltip;
	}

	handleUsageUpdate(usageDataJSON) {
		if (!this.uiReady) {
			Log('LengthUI: Not ready, queueing usage update');
			this.pendingUsageUpdates.push(usageDataJSON);
			return;
		}

		// Cache UsageData but don't re-render estimate
		// (estimate calculation needs fresh conversation cost)
		this.usageData = UsageData.fromJSON(usageDataJSON);
		if (this.usageData?.resetTimestamp) {
			this.lastResetTimestamp = this.usageData.resetTimestamp;
		}
		// Update reset time display only
		this.updateResetTime();
	}

	handleConversationUpdate(conversationDataJSON) {
		if (!this.uiReady) {
			Log('LengthUI: Not ready, queueing conversation update');
			this.pendingConversationUpdates.push(conversationDataJSON);
			return;
		}

		// Full render: uses cached UsageData + fresh ConversationData
		this.conversationData = ConversationData.fromJSON(conversationDataJSON);
		this.updateAllDisplays();
	}

	async updateAllDisplays() {
		this.currentModel = await getCurrentModel(200);
		this.updateCostAndLength();
		this.updateEstimate();
		this.updateResetTime();
	}

	async checkAndReinject() {
		// Handle title area (length/cost/cache) injection
		const chatMenu = document.querySelector(config.SELECTORS.CHAT_MENU);
		if (chatMenu) {
			const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
			if (titleLine) {
				// Find the header element and adjust its height
				let header = titleLine;
				while (header && !header.tagName.toLowerCase().includes('header')) {
					header = header.parentElement;
				}

				if (header && header.classList.contains('h-12') && isMobileView()) {
					header.classList.remove('h-12'); // Let it size naturally based on content
				}

				// Check if there's a project link
				const projectLink = titleLine.querySelector('a[href^="/project/"]');

				if (projectLink) {
					// If there's a project link, we need to create a wrapper for project and chat menu
					if (!titleLine.querySelector('.chat-project-wrapper')) {
						const wrapper = document.createElement('div');
						wrapper.className = 'chat-project-wrapper flex min-w-0 flex-row items-center md:items-center 2xl:justify-center';

						// Move elements to wrapper
						projectLink.remove();
						wrapper.appendChild(projectLink);

						const chatMenuContainer = chatMenu.closest('.flex.min-w-0.items-center');
						if (chatMenuContainer) {
							chatMenuContainer.remove();
							wrapper.appendChild(chatMenuContainer);
						}

						titleLine.insertBefore(wrapper, titleLine.firstChild);
					}
				}

				titleLine.classList.remove('md:items-center');
				titleLine.classList.add('md:items-start');
				titleLine.classList.remove('md:flex-row');
				titleLine.classList.add('md:flex-col');

				// Add our container after the wrapper or chat menu
				const chatMenuParent = chatMenu.closest('.chat-project-wrapper') || chatMenu.parentElement;
				if (chatMenuParent.nextElementSibling !== this.costAndLengthContainer) {
					chatMenuParent.after(this.costAndLengthContainer);
				}
			}
		}

		// Handle stat line right container injection (estimate, reset time)
		// The stat line is created by UsageUI, we just inject into ut-stat-right
		this.statRightContainer = document.getElementById('ut-stat-right');
		if (this.statRightContainer) {
			if (!this.statRightContainer.contains(this.estimateDisplay)) {
				this.statRightContainer.appendChild(this.estimateDisplay);
			}
			if (!this.statRightContainer.contains(this.resetDisplay)) {
				this.statRightContainer.appendChild(this.resetDisplay);
			}
		}
	}

	updateCostAndLength() {
		if (!this.conversationData) {
			this.lengthDisplay.innerHTML = `Length: <span>N/A</span> tokens`;
			this.costDisplay.innerHTML = '';
			this.cachedDisplay.innerHTML = '';
			this.updateContainer();
			return;
		}

		const lengthColor = this.conversationData.isLong() ? RED_WARNING : BLUE_HIGHLIGHT;

		// Use green if cost was calculated with caching, otherwise use normal logic
		let costColor;
		if (this.conversationData.isCurrentlyCached()) {
			costColor = SUCCESS_GREEN;
		} else {
			costColor = this.conversationData.isExpensive() ? RED_WARNING : BLUE_HIGHLIGHT;
		}

		const weightedCost = this.conversationData.getWeightedFutureCost(this.currentModel);
		this.nextMessageCost = weightedCost;

		// Update individual displays
		this.lengthDisplay.innerHTML = `Length: <span style="color: ${lengthColor}">${this.conversationData.length.toLocaleString()}</span> tokens`;
		this.costDisplay.innerHTML = `Cost: <span style="color: ${costColor}">${weightedCost.toLocaleString()}</span> credits`;

		// Add cached indicator if conversation is currently cached
		if (this.conversationData.isCurrentlyCached()) {
			this.lastCachedUntilTimestamp = this.conversationData.conversationIsCachedUntil;
			const timeInfo = this.conversationData.getTimeUntilCacheExpires();
			this.cachedDisplay.innerHTML = `Cached for: <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${timeInfo.minutes}m</span>`;
		} else {
			this.lastCachedUntilTimestamp = null;
			this.cachedDisplay.innerHTML = '';
		}

		// Update container
		this.updateContainer();

		// Set up tooltip events
		setupTooltip(this.lengthDisplay, this.tooltips.length);
		setupTooltip(this.costDisplay, this.tooltips.cost);
		setupTooltip(this.resetDisplay, this.tooltips.timer);
		// Set up cached tooltip if we have cached content
		if (this.conversationData.isCurrentlyCached()) {
			setupTooltip(this.cachedDisplay, this.tooltips.cached);
		}
	}

	updateContainer() {
		// Clear container
		this.costAndLengthContainer.innerHTML = '';

		// Filter elements - on mobile, exclude cost display
		let elements;
		if (isMobileView()) {
			elements = [this.lengthDisplay, this.cachedDisplay].filter(el => el.innerHTML);
		} else {
			elements = [this.lengthDisplay, this.costDisplay, this.cachedDisplay].filter(el => el.innerHTML);
		}

		const separator = isMobileView() ? '<br>' : ' | ';

		elements.forEach((element, index) => {
			this.costAndLengthContainer.appendChild(element);
			if (index < elements.length - 1) {
				const sep = document.createElement('span');
				sep.innerHTML = separator;
				this.costAndLengthContainer.appendChild(sep);
			}
		});
	}

	// Simplified update method that just changes the time
	updateCachedTime() {
		if (!this.lastCachedUntilTimestamp || !this.cachedDisplay) return false;

		const now = Date.now();
		const diff = this.lastCachedUntilTimestamp - now;

		if (diff <= 0) {
			// Cache expired - clear the display
			this.lastCachedUntilTimestamp = null;
			this.cachedDisplay.innerHTML = '';
			this.updateContainer(); // Rebuild the container to remove the cached element
			return true; // Return true to indicate cache expired
		}

		// Just update the time span text
		const timeSpan = this.cachedDisplay.querySelector('.ut-cached-time');
		if (timeSpan) {
			const minutes = Math.ceil(diff / (1000 * 60));
			timeSpan.textContent = `${minutes}m`;
		}

		return false; // Return false - still cached
	}

	updateEstimate() {
		if (!this.estimateDisplay) return;

		const msgPrefix = isMobileView() ? "Msgs Left: " : "Messages left: ";

		if (!getConversationId()) {
			this.estimateDisplay.innerHTML = `${msgPrefix}<span>N/A</span>`;
			return;
		}

		if (!this.usageData) {
			this.estimateDisplay.innerHTML = `${msgPrefix}<span>N/A</span>`;
			return;
		}

		const remainingTokens = this.usageData.usageCap - this.usageData.getWeightedTotal();

		let estimate;
		if (this.nextMessageCost > 0 && this.currentModel) {
			estimate = Math.max(0, remainingTokens / this.nextMessageCost);
			estimate = estimate.toFixed(1);
		} else {
			estimate = "N/A";
		}

		const color = estimate !== "N/A" && parseFloat(estimate) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
		this.estimateDisplay.innerHTML = `${msgPrefix}<span style="color: ${color}">${estimate}</span>`;

		// Set up tooltip for estimate
		setupTooltip(this.estimateDisplay, this.tooltips.estimate);
	}

	updateResetTime() {
		if (!this.resetDisplay) return;

		let timeInfo;

		if (!this.usageData && this.lastResetTimestamp) {
			// Convert timestamp to timeInfo format inline
			const now = Date.now();
			timeInfo = {
				timestamp: this.lastResetTimestamp,
				expired: this.lastResetTimestamp <= now
			};
		} else if (this.usageData) {
			if (this.usageData.resetTimestamp) {
				this.lastResetTimestamp = this.usageData.resetTimestamp;
			}
			timeInfo = this.usageData.getResetTimeInfo();
		}

		this.resetDisplay.innerHTML = getResetTimeHTML(timeInfo);
	}

	startUpdateLoop() {
		const update = async (timestamp) => {
			// High frequency: cache countdown + reinject check + model change detection
			if (timestamp - this.lastHighUpdate >= this.highUpdateFrequency) {
				this.lastHighUpdate = timestamp;

				// Check for model changes
				const newModel = await getCurrentModel(200);
				if (newModel && newModel !== this.currentModel) {
					await Log("LengthUI: Model changed, recalculating displays");
					this.currentModel = newModel;
					// Recalculate cost and estimate with new model
					if (this.conversationData) {
						this.updateCostAndLength();
						this.updateEstimate();
					}
				}

				// Cache countdown
				this.updateCachedTime();

				// Reinject check
				this.checkAndReinject();
			}

			// Low frequency: reset time countdown
			if (timestamp - this.lastLowUpdate >= this.lowUpdateFrequency) {
				this.lastLowUpdate = timestamp;
				this.updateResetTime();
			}

			requestAnimationFrame(update);
		};
		requestAnimationFrame(update);
	}
}

// Self-initialize
const lengthUI = new LengthUI();
