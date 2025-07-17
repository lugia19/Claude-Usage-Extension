'use strict';

// Chat UI Manager
class ChatUI {
	constructor() {
		this.costAndLengthDisplay = null;
		this.estimateDisplay = null;
		this.resetDisplay = null;
		this.statLine = null;
		this.progressBar = null;
		this.lastResetTimestamp = null;
		this.lastMessageCost = null;
		//This exists so that if we recieve updated usage data, we can update the estimate without needing to recieve the conversation cost again
		//Example: A conversation in another tab updates the usage data
		this.lastCachedUntilTimestamp = null;
		this.usageLabel = null;
		this.cachedTooltip = null;
	}

	initialize() {
		this.costAndLengthDisplay = document.createElement('div');
		this.costAndLengthDisplay.className = 'text-text-500 text-xs';
		this.costAndLengthDisplay.style.marginTop = '2px';

		this.statLine = document.createElement('div');
		this.statLine.className = 'ut-row ut-select-none';

		this.usageLabel = document.createElement('div');
		this.usageLabel.className = 'text-text-400 text-xs ut-select-none';
		if (!isMobileView()) this.usageLabel.style.marginRight = '8px';
		this.usageLabel.textContent = 'Quota:';

		this.progressBar = new ProgressBar({ width: "25%" });
		this.progressBar.container.classList.remove('bg-bg-500');
		this.progressBar.container.classList.add('bg-bg-200');

		const spacer = document.createElement('div');
		spacer.className = 'ut-flex-1 ut-select-none';

		this.estimateDisplay = document.createElement('div');
		this.estimateDisplay.className = 'text-text-400 text-xs ut-select-text';
		if (!isMobileView()) this.estimateDisplay.style.marginRight = '8px';

		this.resetDisplay = document.createElement('div');
		this.resetDisplay.className = 'text-text-400 text-xs ut-select-text';
		if (!isMobileView()) this.resetDisplay.style.marginRight = '8px';

		this.statLine.appendChild(this.usageLabel);
		this.statLine.appendChild(this.progressBar.container);
		this.statLine.appendChild(spacer);
		this.statLine.appendChild(this.estimateDisplay);
		this.statLine.appendChild(this.resetDisplay);

		this.cachedTooltip = document.createElement('div');
		this.cachedTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		this.cachedTooltip.textContent = 'Follow up messages in this conversation will have a reduced cost so long as caching is active';
		this.cachedTooltip.style.maxWidth = '400px';
		this.cachedTooltip.style.textAlign = 'left';
		this.cachedTooltip.style.whiteSpace = 'normal';  // Override the nowrap from ut-tooltip
		document.body.appendChild(this.cachedTooltip);
	}

	async checkAndReinject() {
		// Handle length display injection
		const chatMenu = document.querySelector(config.SELECTORS.CHAT_MENU);
		if (chatMenu) {
			const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
			if (titleLine) {
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

				// Keep the alignment classes on the titleLine
				titleLine.classList.remove('md:flex-row');
				titleLine.classList.add('md:flex-col');

				// Add our length display after the wrapper or chat menu
				if (chatMenu.parentElement.nextElementSibling !== this.costAndLengthDisplay) {
					const chatMenuParent = chatMenu.closest('.chat-project-wrapper') || chatMenu.parentElement;
					if (chatMenuParent.nextElementSibling !== this.costAndLengthDisplay) {
						chatMenuParent.after(this.costAndLengthDisplay);
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
		if (!this.progressBar || !usageData) return;

		const percentage = usageData.getUsagePercentage();
		const weightedTotal = usageData.getWeightedTotal();
		const usageCap = usageData.usageCap;

		// Update progress bar
		this.progressBar.updateProgress(weightedTotal, usageCap);

		// Update the usage label with percentage
		if (this.usageLabel) {
			const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;
			if (isMobileView()) {
				this.usageLabel.innerHTML = `<span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
			} else {
				this.usageLabel.innerHTML = `Quota: <span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
			}
		}
	}

	async updateUsageDisplay(usageData, currentModel) {
		if (!usageData) return;

		// Always update progress bar
		await this.updateProgressBar(usageData);

		// Always update reset time
		this.updateResetTime(usageData);

		// Update estimate if we have a stored message cost
		if (this.lastMessageCost) {
			this.updateEstimate(usageData, currentModel, this.lastMessageCost);
		}
	}

	async updateConversationDisplay(conversationData, usageData, currentModel) {
		if (!conversationData) return;

		// Update cost and length display with current model
		this.updateCostAndLength(conversationData, currentModel);

		// Store the weighted cost for future estimates using current model
		const tempConversation = Object.assign(Object.create(Object.getPrototypeOf(conversationData)), conversationData);
		tempConversation.model = currentModel;
		this.lastMessageCost = tempConversation.getWeightedCost();

		// Update estimate with new cost data
		if (usageData) {
			this.updateEstimate(usageData, currentModel, this.lastMessageCost);
		}
	}

	updateCostAndLength(conversationData, currentModel = null) {
		const separator = isMobileView() ? '<br>' : ' | ';
		if (this.costAndLengthDisplay) {
			if (!conversationData) {
				this.costAndLengthDisplay.innerHTML = `Length: N/A tokens`;
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
			if (displayData.costUsedCache) {
				costColor = SUCCESS_GREEN;
			} else {
				costColor = displayData.isExpensive() ? RED_WARNING : BLUE_HIGHLIGHT;
			}

			const weightedCost = displayData.getWeightedCost();

			let displayText =
				`Length: <span style="color: ${lengthColor}">${displayData.length.toLocaleString()}</span> tokens` +
				`${separator}Cost: <span style="color: ${costColor}">${weightedCost.toLocaleString()}</span> tokens`;

			// Add cached indicator if conversation is currently cached
			if (displayData.isCurrentlyCached()) {
				this.lastCachedUntilTimestamp = displayData.conversationIsCachedUntil;
				const timeInfo = displayData.getTimeUntilCacheExpires();
				displayText += `${separator}Cached: <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${timeInfo.minutes}m</span> <svg class="ut-cached-info" xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 256 256" style="display: inline-block; vertical-align: text-bottom; margin-left: 4px; cursor: help; transform: translateY(-1px);"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm16-40a8,8,0,0,1-8,8,16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40A8,8,0,0,1,144,176ZM112,84a12,12,0,1,1,12,12A12,12,0,0,1,112,84Z"></path></svg>`;
			} else {
				this.lastCachedUntilTimestamp = null;
			}

			this.costAndLengthDisplay.innerHTML = displayText;

			// Set up tooltip hover only if we have a cached indicator
			if (displayData.isCurrentlyCached()) {
				setTimeout(() => this.setupCachedTooltip(), 10);
			}
		}
	}

	setupCachedTooltip() {
		const infoIcon = this.costAndLengthDisplay?.querySelector('.ut-cached-info');
		if (!infoIcon || infoIcon.dataset.tooltipSetup === 'true') return;

		infoIcon.dataset.tooltipSetup = 'true';

		infoIcon.addEventListener('mouseenter', (e) => {
			const rect = infoIcon.getBoundingClientRect();

			// Show tooltip and get its dimensions
			this.cachedTooltip.style.opacity = '1';
			const tooltipRect = this.cachedTooltip.getBoundingClientRect();

			let leftPos = rect.left + (rect.width / 2);
			if (leftPos + (tooltipRect.width / 2) > window.innerWidth) {
				leftPos = window.innerWidth - tooltipRect.width - 10;
			}
			if (leftPos - (tooltipRect.width / 2) < 0) {
				leftPos = tooltipRect.width / 2 + 10;
			}

			let topPos = rect.top - tooltipRect.height - 10;
			if (topPos < 10) {
				topPos = rect.bottom + 10;
			}

			this.cachedTooltip.style.left = `${leftPos}px`;
			this.cachedTooltip.style.top = `${topPos}px`;
			this.cachedTooltip.style.transform = 'translateX(-50%)';
		});

		infoIcon.addEventListener('mouseleave', () => {
			this.cachedTooltip.style.opacity = '0';
		});
	}

	// Simplified update method that just changes the time
	updateCachedTime() {
		if (!this.lastCachedUntilTimestamp || !this.costAndLengthDisplay) return;

		const now = Date.now();
		const diff = this.lastCachedUntilTimestamp - now;

		if (diff <= 0) {
			// Cache expired
			this.lastCachedUntilTimestamp = null;
			return;
		}

		// Just update the time span text
		const timeSpan = this.costAndLengthDisplay.querySelector('.ut-cached-time');
		if (timeSpan) {
			const minutes = Math.ceil(diff / (1000 * 60));
			timeSpan.textContent = `${minutes}m`;
		}
	}

	updateEstimate(usageData, currentModel, messageCost) {
		if (!this.estimateDisplay || !usageData) return;

		if (!getConversationId()) {
			this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span>N/A</span>`;
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
		this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span style="color: ${color}">${estimate}</span>`;
	}

	updateResetTime(usageData = null) {
		if (!this.resetDisplay) return;

		// If no usageData provided, use stored timestamp
		if (!usageData && this.lastResetTimestamp) {
			const now = Date.now();
			const diff = this.lastResetTimestamp - now;

			if (diff <= 0) {
				this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">pending...</span>`;
			} else {
				const hours = Math.floor(diff / (1000 * 60 * 60));
				const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
				const timeString = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
				this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${timeString}</span>`;
			}
			return;
		}

		// If usageData provided, update stored timestamp and display
		const timeInfo = usageData?.getTimeUntilReset();

		// Store the timestamp for future updates
		if (usageData?.resetTimestamp) {
			this.lastResetTimestamp = usageData.resetTimestamp;
		}

		if (!timeInfo) {
			this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">Not set</span>`;
			return;
		}

		if (timeInfo.expired) {
			this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">pending...</span>`;
		} else {
			const timeString = timeInfo.hours > 0 ?
				`${timeInfo.hours}h ${timeInfo.minutes}m` :
				`${timeInfo.minutes}m`;
			this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${timeString}</span>`;
		}
	}
}