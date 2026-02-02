/* global CONFIG, Log, setupTooltip, getResetTimeHTML, sleep, sendBackgroundMessage,
   isMobileView, UsageData, ConversationData, getConversationId, getCurrentModel,
   RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN */
'use strict';

// Length UI actor - handles all conversation-related displays
class LengthUI {
	constructor() {
		// State
		this.state = {
			usageData: null,
			conversationData: null,
			currentModel: null,
			nextMessageCost: null,
			cachedUntilTimestamp: null,
		};

		// Element references
		this.elements = {
			titleArea: null,
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

		while (!CONFIG) {
			await sleep(100);
		}

		this.elements.titleArea = this.createTitleAreaElements();
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
			this.state.conversationData = ConversationData.fromJSON(this.pendingUpdates.conversation);
			this.pendingUpdates.conversation = null;
			await this.renderAll();
		}

		this.startUpdateLoop();
	}

	// ========== CREATE (pure DOM construction) ==========

	createTitleAreaElements() {
		const container = document.createElement('div');
		container.className = 'text-text-500 text-xs !px-1 ut-select-none';
		container.style.marginTop = '2px';

		const length = document.createElement('span');
		const cost = document.createElement('span');
		const cached = document.createElement('span');

		return { container, length, cost, cached };
	}

	createStatLineElements() {
		const estimate = document.createElement('div');
		estimate.className = 'text-text-400 text-xs';
		estimate.style.cursor = 'help';
		if (!isMobileView()) estimate.style.marginRight = '8px';

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
		setupTooltip(this.elements.titleArea.length, this.elements.tooltips.length);
		setupTooltip(this.elements.titleArea.cost, this.elements.tooltips.cost);
		setupTooltip(this.elements.titleArea.cached, this.elements.tooltips.cached);
		setupTooltip(this.elements.statLine.estimate, this.elements.tooltips.estimate);
	}

	// ========== MOUNT (attach to page) ==========

	mountTitleArea() {
		const chatMenu = document.querySelector(CONFIG.SELECTORS.CHAT_MENU);
		if (!chatMenu) return false;

		const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
		if (!titleLine) return false;

		// Prepare layout if needed
		this.prepareLayoutForTitleArea(titleLine, chatMenu);

		// Mount container
		const chatMenuParent = chatMenu.closest('.chat-project-wrapper') || chatMenu.parentElement;
		if (chatMenuParent && chatMenuParent.nextElementSibling !== this.elements.titleArea.container) {
			chatMenuParent.after(this.elements.titleArea.container);
		}

		return true;
	}

	prepareLayoutForTitleArea(titleLine, chatMenu) {
		// Adjust header height on mobile
		let header = titleLine;
		while (header && !header.tagName.toLowerCase().includes('header')) {
			header = header.parentElement;
		}
		if (header && header.classList.contains('h-12') && isMobileView()) {
			header.classList.remove('h-12');
		}

		// Handle project link wrapping
		const projectLink = titleLine.querySelector('a[href^="/project/"]');
		if (projectLink && !titleLine.querySelector('.chat-project-wrapper')) {
			const wrapper = document.createElement('div');
			wrapper.className = 'chat-project-wrapper flex min-w-0 flex-row items-center md:items-center 2xl:justify-center';

			projectLink.remove();
			wrapper.appendChild(projectLink);

			const chatMenuContainer = chatMenu.closest('.flex.min-w-0.items-center');
			if (chatMenuContainer) {
				chatMenuContainer.remove();
				wrapper.appendChild(chatMenuContainer);
			}

			titleLine.insertBefore(wrapper, titleLine.firstChild);
		}

		// Adjust title line layout
		titleLine.classList.remove('md:items-center');
		titleLine.classList.add('md:items-start');
		titleLine.classList.remove('md:flex-row');
		titleLine.classList.add('md:flex-col');
	}

	mountStatLine() {
		const statRightContainer = document.getElementById('ut-stat-right');
		if (!statRightContainer) return false;

		if (!statRightContainer.contains(this.elements.statLine.estimate)) {
			statRightContainer.appendChild(this.elements.statLine.estimate);
		}

		return true;
	}

	// ========== RENDER (state → DOM) ==========

	async renderAll() {
		this.state.currentModel = await getCurrentModel(200);
		this.renderCostAndLength();
		this.renderEstimate();
	}

	renderCostAndLength() {
		const { conversationData, currentModel } = this.state;
		const { length, cost, cached, container } = this.elements.titleArea;

		if (!conversationData) {
			length.innerHTML = 'Length: <span>N/A</span> tokens';
			cost.innerHTML = '';
			cached.innerHTML = '';
			this.renderTitleContainer();
			return;
		}

		// Length
		const lengthColor = conversationData.isLong() ? RED_WARNING : BLUE_HIGHLIGHT;
		length.innerHTML = `Length: <span style="color: ${lengthColor}">${conversationData.length.toLocaleString()}</span> tokens`;

		// Cost
		const weightedCost = conversationData.getWeightedFutureCost(currentModel);
		this.state.nextMessageCost = weightedCost;

		let costColor;
		if (conversationData.isCurrentlyCached()) {
			costColor = SUCCESS_GREEN;
		} else {
			costColor = conversationData.isExpensive() ? RED_WARNING : BLUE_HIGHLIGHT;
		}
		cost.innerHTML = `Cost: <span style="color: ${costColor}">${weightedCost.toLocaleString()}</span> credits`;

		// Cached
		if (conversationData.isCurrentlyCached()) {
			this.state.cachedUntilTimestamp = conversationData.conversationIsCachedUntil;
			const timeInfo = conversationData.getTimeUntilCacheExpires();
			cached.innerHTML = `Cached for: <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${timeInfo.minutes}m</span>`;
		} else {
			this.state.cachedUntilTimestamp = null;
			cached.innerHTML = '';
		}

		this.renderTitleContainer();
	}

	renderTitleContainer() {
		const { length, cost, cached, container } = this.elements.titleArea;
		container.innerHTML = '';

		let elements;
		if (isMobileView()) {
			elements = [length, cached].filter(el => el.innerHTML);
		} else {
			elements = [length, cost, cached].filter(el => el.innerHTML);
		}

		const separator = isMobileView() ? '<br>' : ' | ';

		elements.forEach((element, index) => {
			container.appendChild(element);
			if (index < elements.length - 1) {
				const sep = document.createElement('span');
				sep.innerHTML = separator;
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
			this.elements.titleArea.cached.innerHTML = '';
			this.renderTitleContainer();
			return true; // Cache expired
		}

		const timeSpan = this.elements.titleArea.cached.querySelector('.ut-cached-time');
		if (timeSpan) {
			const minutes = Math.ceil(diff / (1000 * 60));
			timeSpan.textContent = `${minutes}m`;
		}

		return false;
	}

	renderEstimate() {
		const { estimate } = this.elements.statLine;
		const { usageData, conversationData, currentModel } = this.state;

		const msgPrefix = isMobileView() ? 'Msgs Left: ' : 'Messages left: ';

		if (!getConversationId() || !usageData || !conversationData) {
			estimate.innerHTML = `${msgPrefix}<span>N/A</span>`;
			return;
		}

		const messageCost = conversationData.getWeightedFutureCost(currentModel);
		const limiting = usageData.getLimitingFactor(messageCost);

		if (!limiting) {
			estimate.innerHTML = `${msgPrefix}<span>N/A</span>`;
			return;
		}

		const estimateValue = limiting.messagesLeft.toFixed(1);
		const color = parseFloat(estimateValue) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
		estimate.innerHTML = `${msgPrefix}<span style="color: ${color}">${estimateValue}</span>`;
	}

	// ========== MESSAGE HANDLERS ==========

	handleUsageUpdate(usageDataJSON) {
		if (!this.uiReady) {
			Log('LengthUI: Not ready, queueing usage update');
			this.pendingUpdates.usage = usageDataJSON;
			return;
		}

		// Cache UsageData but don't re-render estimate
		// (estimate calculation needs fresh conversation cost)
		this.state.usageData = UsageData.fromJSON(usageDataJSON);
	}

	handleConversationUpdate(conversationDataJSON) {
		if (!this.uiReady) {
			Log('LengthUI: Not ready, queueing conversation update');
			this.pendingUpdates.conversation = conversationDataJSON;
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
				this.renderCachedTime();
				this.mountTitleArea();
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
		}

		if (isHomePage && this.state.conversationData !== null) {
			this.state.conversationData = null;
			this.renderCostAndLength();
			this.renderEstimate();
		}
	}

	async checkModelChange() {
		const newModel = await getCurrentModel(200);
		if (newModel && newModel !== this.state.currentModel) {
			await Log('LengthUI: Model changed, recalculating displays');
			this.state.currentModel = newModel;
			if (this.state.conversationData) {
				this.renderCostAndLength();
				this.renderEstimate();
			}
		}
	}
}

// Self-initialize
const lengthUI = new LengthUI();