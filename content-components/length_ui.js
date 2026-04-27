/* global CONFIG, Log, setupTooltip, getResetTimeHTML, sleep, sendBackgroundMessage, getActiveOrgId,
   isMobileView, isCodePage, UsageData, ConversationData, getConversationId, getCurrentModel,
   getCurrentModelVersion, RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, SELECTORS,
   LayoutManager, mountToAnchor */
'use strict';

// Length UI actor - handles all conversation-related displays
class LengthUI {
	constructor() {
		// State
		this.state = {
			usageData: null,
			conversationData: null,
			currentModel: null,
			currentModelVersion: null,
			nextMessageCost: null,
			cachedUntilTimestamp: null,
		};

		// Element references
		this.elements = {
			lengthCost: null,
			statLine: null,
			tooltips: null,
		};

		// Update loop timing
		this.lastHighUpdate = 0;
		this.highUpdateFrequency = 750;

		this.uiReady = false;
		this.pendingUpdates = { usage: null, conversation: null };

		this.setupMessageListeners();
		this.init();
	}

	// ========== SETUP ==========

	setupMessageListeners() {
		browser.runtime.onMessage.addListener((message) => {
			const myOrgId = getActiveOrgId();
			if (message.type === 'updateUsage') {
				const msgOrgId = message.data.usageData?.orgId;
				if (msgOrgId && myOrgId && msgOrgId !== myOrgId) return;
				this.handleUsageUpdate(message.data.usageData);
			}
			if (message.type === 'updateConversationData') {
				const msgOrgId = message.data.conversationData?.orgId;
				if (msgOrgId && myOrgId && msgOrgId !== myOrgId) return;
				this.handleConversationUpdate(message.data.conversationData);
			}
		});
	}

	async init() {
		await Log('LengthUI: Initializing...');

		while (!CONFIG) {
			await sleep(100);
		}

		this.elements.lengthCost = this.createLengthCostElements();
		this.elements.statLine = this.createStatLineElements();
		this.elements.tooltips = this.createTooltips();
		this.attachTooltips();

		this.uiReady = true;
		await Log('LengthUI: Ready');

		// Process pending updates (only most recent matters)
		if (this.pendingUpdates.usage) {
			this.state.usageData = UsageData.fromJSON(this.pendingUpdates.usage);
			this.pendingUpdates.usage = null;
		}
		if (this.pendingUpdates.conversation) {
			const currentConvoId = getConversationId();
			if (!this.pendingUpdates.conversation.conversationId || !currentConvoId ||
				this.pendingUpdates.conversation.conversationId === currentConvoId) {
				this.state.conversationData = ConversationData.fromJSON(this.pendingUpdates.conversation);
				await this.renderAll();
			}
			this.pendingUpdates.conversation = null;
		}

		this.startUpdateLoop();
	}

	// ========== CREATE (pure DOM construction) ==========

	createLengthCostElements() {
		const container = document.createElement('div');
		container.id = 'ut-chat-length-cost';
		container.className = 'text-text-500 text-sm ut-select-none ut-title-stats ut-chat-length-cost';
		container.style.display = 'flex';
		container.style.flexWrap = 'wrap';
		container.style.alignItems = 'center';
		container.style.gap = '0';
		container.style.rowGap = '4px';

		const length = document.createElement('span');
		const cost = document.createElement('span');
		const cached = document.createElement('span');

		return { container, length, cost, cached };
	}

	createStatLineElements() {
		const estimate = document.createElement('div');
		estimate.className = 'text-text-400 text-sm';
		estimate.style.cursor = 'help';
		// No margin-right so it aligns with the send button

		return { estimate };
	}

	createTooltips() {
		const create = (text) => {
			const tooltip = document.createElement('div');
			tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip font-normal font-ui';
			tooltip.textContent = text;
			tooltip.style.maxWidth = '400px';
			tooltip.style.textAlign = 'left';
			tooltip.style.whiteSpace = 'pre-line';
			document.body.appendChild(tooltip);
			return tooltip;
		};

		return {
			length: create('Length of the conversation, in tokens. The longer it is, the faster your limits run out.'),
			cost: create('Estimated cost of sending another message\nIncludes ephemeral items like thinking.\nCost = length*model mult / caching factor'),
			cached: create('Follow up messages in this conversation will have a reduced cost'),
			estimate: create('Number of messages left based on the current cost'),
		};
	}

	attachTooltips() {
		setupTooltip(this.elements.lengthCost.length, this.elements.tooltips.length);
		setupTooltip(this.elements.lengthCost.cost, this.elements.tooltips.cost);
		setupTooltip(this.elements.lengthCost.cached, this.elements.tooltips.cached);
		setupTooltip(this.elements.statLine.estimate, this.elements.tooltips.estimate);
	}

	// ========== MOUNT (attach to page) ==========

	mountLengthCostRow() {
		const anchor = LayoutManager.getAnchor('chatLengthCost');
		if (!anchor) return false;
		const el = this.elements.lengthCost.container;
		el.removeAttribute('style');
		el.style.display = 'flex';
		el.style.alignItems = 'center';
		el.style.gap = '0';
		const ok = mountToAnchor(el, anchor);
		const narrowHeaderStrip = el.classList.contains('ut-chat-length-cost--before-share');
		el.style.flexWrap = narrowHeaderStrip ? 'nowrap' : 'wrap';
		el.style.rowGap = narrowHeaderStrip ? '' : '4px';
		return ok;
	}

	mountStatLine() {
		const statRightContainer = document.getElementById('ut-stat-right');
		if (!statRightContainer) return false;

		if (isCodePage()) {
			if (statRightContainer.contains(this.elements.statLine.estimate)) {
				this.elements.statLine.estimate.remove();
			}
			return true;
		}

		if (!statRightContainer.contains(this.elements.statLine.estimate)) {
			statRightContainer.appendChild(this.elements.statLine.estimate);
		}

		return true;
	}

	// ========== RENDER (state → DOM) ==========

	async renderAll() {
		this.state.currentModel = await getCurrentModel(200);
		this.state.currentModelVersion = await getCurrentModelVersion(200);
		await Log('LengthUI: renderAll - detected:', this.state.currentModelVersion,
			'| stored on conversation:', this.state.conversationData?.modelVersion,
			'| isCurrentlyCached:', this.state.conversationData?.isCurrentlyCached(this.state.currentModelVersion));
		this.renderCostAndLength();
		this.renderEstimate();
	}

	renderCostAndLength() {
		const { conversationData, currentModel, currentModelVersion } = this.state;
		const { length, cost, cached } = this.elements.lengthCost;

		if (!conversationData) {
			length.innerHTML = 'Length: <span>N/A</span> tokens';
			cost.innerHTML = '';
			cached.innerHTML = '';
			this.renderLengthCostContainer();
			return;
		}

		// Length
		const lengthColor = conversationData.isLong() ? RED_WARNING : BLUE_HIGHLIGHT;
		const lengthLabel = conversationData.lengthIsEstimate ? 'Length*' : 'Length';
		length.innerHTML = `${lengthLabel}: <span style="color: ${lengthColor}">${conversationData.length.toLocaleString()}</span> tokens`;

		// Update length tooltip based on estimate status
		const baseTooltip = 'Length of the conversation, in tokens. The longer it is, the faster your limits run out.';
		this.elements.tooltips.length.textContent = conversationData.lengthIsEstimate
			? baseTooltip + '\n\nNOTE: Count may be inaccurate due to enabled features.'
			: baseTooltip;

		// Cost
		const weightedCost = conversationData.getWeightedFutureCost(currentModel, currentModelVersion);
		this.state.nextMessageCost = weightedCost;

		let costColor;
		if (conversationData.isCurrentlyCached(currentModelVersion)) {
			costColor = SUCCESS_GREEN;
		} else {
			costColor = conversationData.isExpensive() ? RED_WARNING : BLUE_HIGHLIGHT;
		}

		// Check if limits are maxed - if so, display in dollars instead of credits
		const { usageData } = this.state;
		const sessionMaxed = usageData?.limits?.session?.percentage >= 100;
		const weeklyLimit = usageData?.getBindingWeeklyLimit(currentModel);
		const weeklyMaxed = weeklyLimit?.percentage >= 100;

		if (sessionMaxed || weeklyMaxed) {
			// During extra usage, cache reads cost 10% of input (not free)
			// Interpolate between cached (free) and uncached (full price) costs
			// This is technically not entirely accurate, but it's accurate enough and doesn't require reworking half the codebase
			const weight = CONFIG.MODEL_WEIGHTS[currentModel] || CONFIG.MODEL_WEIGHTS[CONFIG.DEFAULT_MODEL];
			const baseFutureCost = conversationData.isCurrentlyCached(currentModelVersion) ? conversationData.futureCost : conversationData.uncachedFutureCost;
			const interpolatedFutureCost = baseFutureCost +
				CONFIG.EXTRA_USAGE_CACHING_MULTIPLIER * (conversationData.uncachedFutureCost - baseFutureCost);
			const dollars = Math.round(interpolatedFutureCost * weight) / 1_000_000;
			cost.innerHTML = `Cost: <span style="color: ${costColor}">$${dollars.toFixed(2)}</span>`;
		} else {
			cost.innerHTML = `Cost: <span style="color: ${costColor}">${weightedCost.toLocaleString()}</span> credits`;
		}

		// Cached
		if (conversationData.isCurrentlyCached(currentModelVersion)) {
			this.state.cachedUntilTimestamp = conversationData.conversationIsCachedUntil;
			const timeInfo = conversationData.getTimeUntilCacheExpires();
			cached.innerHTML = `Cached for: <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${timeInfo.minutes}m</span>`;
		} else {
			this.state.cachedUntilTimestamp = null;
			cached.innerHTML = '';
		}

		this.renderLengthCostContainer();
	}

	renderLengthCostContainer() {
		const { length, cost, cached, container } = this.elements.lengthCost;
		container.innerHTML = '';

		let elements;
		if (isMobileView()) {
			elements = [length, cached].filter(el => el.innerHTML);
		} else {
			elements = [length, cost, cached].filter(el => el.innerHTML);
		}

		elements.forEach((element, index) => {
			container.appendChild(element);
			if (index < elements.length - 1) {
				const sep = document.createElement('span');
				sep.className = 'ut-metrics-separator';
				sep.textContent = '|';
				container.appendChild(sep);
			}
		});
	}

	renderCachedTime() {
		const { cachedUntilTimestamp } = this.state;
		if (!cachedUntilTimestamp) return false;

		const now = Date.now();
		const diff = cachedUntilTimestamp - now;

		if (diff <= 0) {
			this.state.cachedUntilTimestamp = null;
			this.elements.lengthCost.cached.innerHTML = '';
			this.renderLengthCostContainer();
			return true; // Cache expired
		}

		const timeSpan = this.elements.lengthCost.cached.querySelector('.ut-cached-time');
		if (timeSpan) {
			const minutes = Math.ceil(diff / (1000 * 60));
			timeSpan.textContent = `${minutes}m`;
		}

		return false;
	}

	renderEstimate() {
		const { estimate } = this.elements.statLine;

		if (isCodePage()) {
			estimate.innerHTML = '';
			return;
		}

		const { usageData, conversationData, currentModel, currentModelVersion } = this.state;

		const msgPrefix = isMobileView() ? 'Msgs Left: ' : 'Messages left: ';

		if (!getConversationId() || !usageData || !conversationData) {
			estimate.innerHTML = `${msgPrefix}<span>N/A</span>`;
			return;
		}

		const messageCost = conversationData.getWeightedFutureCost(currentModel, currentModelVersion);
		const limiting = usageData.getLimitingFactor(messageCost);

		// If regular limits are maxed but extra usage is available, estimate from dollars
		if ((!limiting || limiting.messagesLeft <= 0) && usageData.hasExtraUsage()) {
			const weight = CONFIG.MODEL_WEIGHTS[currentModel] || CONFIG.MODEL_WEIGHTS[CONFIG.DEFAULT_MODEL];
			const baseFutureCost = conversationData.isCurrentlyCached(currentModelVersion) ? conversationData.futureCost : conversationData.uncachedFutureCost;
			const interpolatedFutureCost = baseFutureCost +
				CONFIG.EXTRA_USAGE_CACHING_MULTIPLIER * (conversationData.uncachedFutureCost - baseFutureCost);
			const costPerMessageDollars = Math.round(interpolatedFutureCost * weight) / 1_000_000;

			if (costPerMessageDollars > 0) {
				const remainingDollars = usageData.getExtraUsageRemaining() / 100;
				const messagesLeft = remainingDollars / costPerMessageDollars;
				const estimateValue = messagesLeft.toFixed(1);
				const color = parseFloat(estimateValue) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
				estimate.innerHTML = `${msgPrefix}<span style="color: ${color}">${estimateValue}</span>`;
				return;
			}
		}

		// Regular limits estimate
		if (limiting && limiting.messagesLeft > 0) {
			const estimateValue = limiting.messagesLeft.toFixed(1);
			const color = parseFloat(estimateValue) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
			estimate.innerHTML = `${msgPrefix}<span style="color: ${color}">${estimateValue}</span>`;
			return;
		}

		estimate.innerHTML = `${msgPrefix}<span>N/A</span>`;
	}

	// ========== MESSAGE HANDLERS ==========

	handleUsageUpdate(usageDataJSON) {
		if (!this.uiReady) {
			Log('LengthUI: Not ready, queueing usage update');
			this.pendingUpdates.usage = usageDataJSON;
			return;
		}

		this.state.usageData = UsageData.fromJSON(usageDataJSON);
		// Re-render cost display too — it depends on usageData for the credits/dollars switch
		if (this.state.conversationData) {
			this.renderCostAndLength();
		}
		this.renderEstimate();
	}

	handleConversationUpdate(conversationDataJSON) {
		if (!this.uiReady) {
			Log('LengthUI: Not ready, queueing conversation update');
			this.pendingUpdates.conversation = conversationDataJSON;
			return;
		}

		// Ignore updates for a different conversation (stale responses from rapid switching)
		const currentConvoId = getConversationId();
		if (conversationDataJSON.conversationId && currentConvoId &&
			conversationDataJSON.conversationId !== currentConvoId) {
			Log('LengthUI: Ignoring stale conversation update for', conversationDataJSON.conversationId);
			return;
		}

		this.state.conversationData = ConversationData.fromJSON(conversationDataJSON);
		this.renderAll();
	}

	// ========== UPDATE LOOP ==========

	startUpdateLoop() {
		const update = async (timestamp) => {
			if (timestamp - this.lastHighUpdate >= this.highUpdateFrequency) {
				this.lastHighUpdate = timestamp;

				await this.checkConversationChange();
				await this.checkModelChange();
				const cacheExpired = this.renderCachedTime();
				if (cacheExpired && this.state.conversationData?.conversationId) {
					// Request fresh data since futureCost needs recalculating without cache
					sendBackgroundMessage({
						type: 'requestData',
						conversationId: this.state.conversationData.conversationId
					});
				}
				this.mountLengthCostRow();
				this.mountStatLine();
			}

			requestAnimationFrame(update);
		};
		requestAnimationFrame(update);
	}

	async checkConversationChange() {
		const newConversation = getConversationId();
		const isHomePage = newConversation === null;

		if (this.state.conversationData?.conversationId !== newConversation && !isHomePage) {
			await Log('LengthUI: Conversation changed, requesting data');
			sendBackgroundMessage({
				type: 'requestData',
				conversationId: newConversation
			});
			this.state.conversationData = null;
			// Clear old data to avoid showing wrong info and to spam messages
			this.renderCostAndLength();
			this.renderEstimate();
		}

		if (isHomePage && this.state.conversationData !== null) {
			this.state.conversationData = null;
			this.renderCostAndLength();
			this.renderEstimate();
		}
	}

	async checkModelChange() {
		const newModel = await getCurrentModel(200);
		const newModelVersion = await getCurrentModelVersion(200);
		if ((newModel && newModel !== this.state.currentModel) ||
			(newModelVersion && newModelVersion !== this.state.currentModelVersion)) {
			await Log('LengthUI: Model changed, recalculating displays');
			this.state.currentModel = newModel;
			this.state.currentModelVersion = newModelVersion;
			if (this.state.conversationData) {
				this.renderCostAndLength();
				this.renderEstimate();
			}
		}
	}
}

// Self-initialize
const lengthUI = new LengthUI();
