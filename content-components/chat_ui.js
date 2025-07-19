'use strict';

// Chat UI Manager
class ChatUI {
	constructor() {
		// Separate display elements
		this.lengthDisplay = null;
		this.costDisplay = null;
		this.cachedDisplay = null;
		this.estimateDisplay = null;
		this.resetDisplay = null;
		this.chatBoxStatLine = null;	//Input area
		this.costAndLengthContainer = null; //Title area
		this.progressBar = null;
		this.lastResetTimestamp = null;
		this.nextMessageCost = null;
		//This exists so that if we recieve updated usage data, we can update the estimate without needing to recieve the conversation cost again
		//Example: A conversation in another tab updates the usage data
		this.lastCachedUntilTimestamp = null;
		this.usageDisplay = null;

		// Tooltips
		this.tooltips = {
			length: null,
			cost: null,
			cached: null,
			estimate: null,
			timer: null,
			usage: null
		};
	}

	initialize() {
		// Create container for the separated displays
		this.costAndLengthContainer = document.createElement('div');
		this.costAndLengthContainer.className = `text-text-500 text-xs !px-1 ut-select-none`;
		this.costAndLengthContainer.style.marginTop = '2px';

		// Create individual display elements
		this.lengthDisplay = document.createElement('span');
		this.costDisplay = document.createElement('span');
		this.cachedDisplay = document.createElement('span');

		this.statLine = document.createElement('div');
		this.statLine.className = `ut-row`;

		this.usageDisplay = document.createElement('div');
		this.usageDisplay.className = 'text-text-400 text-xs';
		if (!isMobileView()) this.usageDisplay.style.marginRight = '8px';
		this.usageDisplay.textContent = 'Quota:';

		// Only create progress bar on desktop
		if (!isMobileView()) {
			this.progressBar = new ProgressBar({ width: "25%" });
			this.progressBar.container.classList.remove('bg-bg-500');
			this.progressBar.container.classList.add('bg-bg-200');
		}

		const spacer = document.createElement('div');
		spacer.className = 'ut-flex-1';

		this.estimateDisplay = document.createElement('div');
		this.estimateDisplay.className = 'text-text-400 text-xs';
		this.estimateDisplay.style.cursor = 'help';
		if (!isMobileView()) this.estimateDisplay.style.marginRight = '8px';

		this.resetDisplay = document.createElement('div');
		this.resetDisplay.className = 'text-text-400 text-xs';
		if (!isMobileView()) this.resetDisplay.style.marginRight = '8px';

		this.statLine.appendChild(this.usageDisplay);
		if (!isMobileView() && this.progressBar) {
			this.statLine.appendChild(this.progressBar.container);
		}
		this.statLine.appendChild(spacer);
		this.statLine.appendChild(this.estimateDisplay);
		this.statLine.appendChild(this.resetDisplay);

		this.tooltips.length = this.createTooltip('Length of the conversation, in tokens. The longer it is, the faster your limits run out.');
		this.tooltips.cost = this.createTooltip('Estimated cost of sending another message\nIncludes ephemeral items like thinking.\nCost = length*model mult / caching factor');
		this.tooltips.cached = this.createTooltip('Follow up messages in this conversation will have a reduced cost');
		this.tooltips.estimate = this.createTooltip('Number of messages left based on the current cost');
		this.tooltips.timer = this.createTooltip('When your usage will reset to full')
		this.tooltips.usage = this.createTooltip(`How much of your quota you've used`)
	}

	createTooltip(text) {
		const tooltip = document.createElement('div');
		tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		tooltip.textContent = text;
		tooltip.style.maxWidth = '400px';
		tooltip.style.textAlign = 'left';
		tooltip.style.whiteSpace = 'pre-line';  // Override the nowrap from ut-tooltip
		document.body.appendChild(tooltip);
		return tooltip;
	}

	async checkAndReinject() {
		// Handle length display injection
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
					header.classList.remove('h-12') // Let it size naturally based on content
				}

				// Check if there's a project link
				const projectLink = titleLine.querySelector('a[href^="/project/"]');

				if (projectLink) {
					// If there's a project link, we need to create a wrapper for project and chat menu
					if (!titleLine.querySelector('.chat-project-wrapper')) {
						const wrapper = document.createElement('div');
						wrapper.className = 'chat-project-wrapper flex min-w-0 flex-row items-center md:items-center 2xl:justify-center';

						//Move elements to wrapper
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
				titleLine.classList.add('md:items-start'); // This aligns to the left in column layout
				
				// Keep the alignment classes on the titleLine
				titleLine.classList.remove('md:flex-row');
				titleLine.classList.add('md:flex-col');

				// Add our container after the wrapper or chat menu
				if (chatMenu.parentElement.nextElementSibling !== this.costAndLengthContainer) {
					const chatMenuParent = chatMenu.closest('.chat-project-wrapper') || chatMenu.parentElement;
					if (chatMenuParent.nextElementSibling !== this.costAndLengthContainer) {
						chatMenuParent.after(this.costAndLengthContainer);
					}
				}
			}
		}

		// Handle stat line injection
		const modelSelector = document.querySelector(config.SELECTORS.MODEL_SELECTOR);
		if (!modelSelector) {
			await Log("warning", 'Could not find model selector!');
			return;
		}

		const selectorLine = modelSelector?.parentElement?.parentElement;

		if (!selectorLine) {
			await Log("warning", 'Could not find selector line!');
			return;
		}
		if (selectorLine && selectorLine.nextElementSibling !== this.statLine) {
			selectorLine.after(this.statLine);
		}
	}

	async updateProgressBar(usageData) {
		if (!usageData) return;

		const percentage = usageData.getUsagePercentage();
		const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;

		// Always update the usage label with percentage
		if (this.usageDisplay) {
			this.usageDisplay.innerHTML = `Quota: <span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
		}
		// Only update progress bar on desktop
		if (!isMobileView() && this.progressBar) {
			const weightedTotal = usageData.getWeightedTotal();
			const usageCap = usageData.usageCap;
			this.progressBar.updateProgress(weightedTotal, usageCap);
		}
	}

	async updateUsageDisplay(usageData, currentModel) {
		if (!usageData) return;

		// Always update progress bar
		await this.updateProgressBar(usageData);

		// Always update reset time
		this.updateResetTime(usageData);

		// Update estimate if we have a stored message cost
		if (this.nextMessageCost) {
			this.updateEstimate(usageData, currentModel, this.nextMessageCost);
		}
	}

	async updateConversationDisplay(conversationData, usageData, currentModel) {
		if (!conversationData) return;

		// Update cost and length display with current model
		this.updateCostAndLength(conversationData, currentModel);

		// Store the weighted cost for future estimates using current model
		const tempConversation = Object.assign(Object.create(Object.getPrototypeOf(conversationData)), conversationData);
		tempConversation.model = currentModel;
		this.nextMessageCost = tempConversation.getWeightedFutureCost();

		// Update estimate with new cost data
		if (usageData) {
			this.updateEstimate(usageData, currentModel, this.nextMessageCost);
		}
	}

	updateCostAndLength(conversationData, currentModel = null) {
		if (!conversationData) {
			this.lengthDisplay.innerHTML = `Length: <span>N/A</span> tokens`;
			this.costDisplay.innerHTML = '';
			this.cachedDisplay.innerHTML = '';
			this.updateContainer();
			return;
		}

		// Create a temporary copy with overridden model if provided
		let displayData = conversationData;
		if (currentModel) {
			displayData = Object.assign(Object.create(Object.getPrototypeOf(conversationData)), conversationData);
			displayData.model = currentModel;
		}

		const lengthColor = displayData.isLong() ? RED_WARNING : BLUE_HIGHLIGHT;

		// Use green if cost was calculated with caching, otherwise use normal logic
		let costColor;
		if (displayData.isCurrentlyCached()) {
			costColor = SUCCESS_GREEN;
		} else {
			costColor = displayData.isExpensive() ? RED_WARNING : BLUE_HIGHLIGHT;
		}

		const weightedCost = displayData.getWeightedFutureCost();

		// Update individual displays
		this.lengthDisplay.innerHTML = `Length: <span style="color: ${lengthColor}">${displayData.length.toLocaleString()}</span> tokens`;
		this.costDisplay.innerHTML = `Cost: <span style="color: ${costColor}">${weightedCost.toLocaleString()}</span> credits`;

		// Add cached indicator if conversation is currently cached
		if (displayData.isCurrentlyCached()) {
			this.lastCachedUntilTimestamp = displayData.conversationIsCachedUntil;
			const timeInfo = displayData.getTimeUntilCacheExpires();
			this.cachedDisplay.innerHTML = `Cached: <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${timeInfo.minutes}m</span>`;
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
		setupTooltip(this.usageDisplay, this.tooltips.usage)
		// Set up cached tooltip if we have cached content
		if (displayData.isCurrentlyCached()) {
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

	updateEstimate(usageData, currentModel, messageCost) {
		if (!this.estimateDisplay || !usageData) return;
		const msgPrefix = isMobileView() ? "Msgs Left: " : "Messages left: "
		if (!getConversationId()) {
			this.estimateDisplay.innerHTML = `${msgPrefix}<span>N/A</span>`;
			return;
		}

		const remainingTokens = usageData.usageCap - usageData.getWeightedTotal();

		let estimate;
		if (messageCost > 0 && currentModel) {
			estimate = Math.max(0, remainingTokens / messageCost);
			estimate = estimate.toFixed(1);
		} else {
			estimate = "N/A";
		}

		const color = estimate !== "N/A" && parseFloat(estimate) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
		this.estimateDisplay.innerHTML = `${msgPrefix}<span style="color: ${color}">${estimate}</span>`;

		// Set up tooltip for estimate
		setupTooltip(this.estimateDisplay, this.tooltips.estimate);
	}

	updateResetTime(usageData = null) {
		if (!this.resetDisplay) return;

		let timeInfo;

		if (!usageData && this.lastResetTimestamp) {
			// Convert timestamp to timeInfo format inline
			const now = Date.now();
			const diff = this.lastResetTimestamp - now;

			timeInfo = diff <= 0
				? { expired: true }
				: {
					expired: false,
					hours: Math.floor(diff / (1000 * 60 * 60)),
					minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
				};
		} else if (usageData) {
			if (usageData.resetTimestamp) {
				this.lastResetTimestamp = usageData.resetTimestamp;
			}
			timeInfo = usageData.getTimeUntilReset();
		}

		this.resetDisplay.innerHTML = getResetTimeHTML(timeInfo);
	}
}