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
		this.usageLabel = null;
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

	async updateChatUI(data, currentModel, usageCap) {
		if (data.conversationMetrics) {
			this.updateCostAndLength(data.conversationMetrics);
			// Use weighted cost for estimate
			this.lastMessageCost = data.conversationMetrics.weightedCost || data.conversationMetrics.cost;
			this.updateEstimate(data.modelData, currentModel, usageCap, this.lastMessageCost);
		} else if (this.lastMessageCost) {
			this.updateEstimate(data.modelData, currentModel, usageCap, this.lastMessageCost);
		}
		await this.updateProgressBar(data.modelData, usageCap);
		this.updateResetTime(data.modelData);
	}

	async updateProgressBar(modelData, usageCap) {
		if (!this.progressBar) return;

		const { total } = modelData;
		const modelTotal = total || 0;

		// Calculate percentage
		const percentage = (modelTotal / usageCap) * 100;

		// Update progress bar
		this.progressBar.updateProgress(modelTotal, usageCap);

		// Update the usage label with percentage
		if (this.usageLabel) {
			const color = percentage >= config.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
			if (isMobileView()) {
				this.usageLabel.innerHTML = `<span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
			} else {
				this.usageLabel.innerHTML = `Quota: <span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
			}
		}
	}

	updateCostAndLength(metrics) {
		const separator = isMobileView() ? '<br>' : ' | ';
		if (this.costAndLengthDisplay) {
			if (!metrics) {
				this.costAndLengthDisplay.innerHTML = `Length: N/A tokens`;
				return;
			}

			const lengthColor = metrics.length >= config.WARNING.LENGTH ? RED_WARNING : BLUE_HIGHLIGHT;
			// Use weightedCost if available, otherwise fall back to cost
			const displayCost = metrics.weightedCost || metrics.cost;
			const costColor = displayCost >= config.WARNING.COST ? RED_WARNING : BLUE_HIGHLIGHT;

			this.costAndLengthDisplay.innerHTML =
				`Length: <span style="color: ${lengthColor}">${metrics.length.toLocaleString()}</span> tokens` +
				`${separator}Cost: <span style="color: ${costColor}">${displayCost.toLocaleString()}</span> tokens`;

			// If we have cache status, we could add an indicator here
			if (metrics.cacheStatus?.costUsedCache) {
				// Add a cache indicator if desired
			}
		}
	}

	updateEstimate(modelData, currentModel, usageCap, messageCost) {
		if (!this.estimateDisplay) return;
		if (!getConversationId()) {
			this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span>N/A</span>`;
			return;
		}

		const { total } = modelData;
		const modelTotal = total || 0;
		const remainingTokens = usageCap - modelTotal;

		let estimate;
		if (messageCost > 0 && currentModel) {
			// messageCost should already be weighted by the UI
			estimate = Math.max(0, remainingTokens / messageCost);
			estimate = estimate.toFixed(1);
		} else {
			estimate = "N/A";
		}

		const color = estimate !== "N/A" && parseFloat(estimate) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
		this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span style="color: ${color}">${estimate}</span>`;
	}

	updateResetTime(modelData) {
		if (!this.resetDisplay) return;

		const { resetTimestamp } = modelData;
		this.lastResetTimestamp = resetTimestamp || null;
		this.updateResetTimeDisplay();
	}

	updateResetTimeDisplay() {
		if (!this.resetDisplay) return;

		if (!this.lastResetTimestamp) {
			this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">Not set</span>`;
			return;
		}

		const now = Date.now();
		const diff = this.lastResetTimestamp - now;

		if (diff <= 0) {
			this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">pending...</span>`;
		} else {
			this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${formatTimeRemaining(this.lastResetTimestamp)}</span>`;
		}
	}
}