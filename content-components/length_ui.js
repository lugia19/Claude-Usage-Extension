/* global CONFIG, Log, setupTooltip, getTooltipPortal, getResetTimeHTML, sleep, sendBackgroundMessage, getActiveOrgId,
   isMobileView, isCodePage, UsageData, ConversationData, getConversationId, getCurrentModel,
   getCurrentModelVersion, getCurrentEffortLabel, RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, SELECTORS,
   LayoutManager, mountToAnchor, localize, fmtNum, onSsePartialUsage, shouldApplySseSession */
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
			currentEffortLabel: null,
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

		onSsePartialUsage((update) => this.handleSsePartialUsage(update));
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
			const currentConvoId = getConversationId();
			if (!this.pendingUpdates.conversation.conversationId || !currentConvoId ||
				this.pendingUpdates.conversation.conversationId === currentConvoId) {
				this.state.conversationData = ConversationData.fromJSON(this.pendingUpdates.conversation);
				await this.syncEffortBaseline(null);
				await this.renderAll();
			}
			this.pendingUpdates.conversation = null;
		}

		this.startUpdateLoop();
	}

	// ========== CREATE (pure DOM construction) ==========

	createTitleAreaElements() {
		const container = document.createElement('div');
		container.className = 'text-text-500 text-xs ut-select-none ut-title-stats';
		container.style.marginTop = '2px';
		container.style.flexBasis = '100%'; // Force onto its own line

		const length = document.createElement('span');
		const cost = document.createElement('span');
		const cached = document.createElement('span');

		return { container, length, cost, cached };
	}

	createStatLineElements() {
		const estimate = document.createElement('div');
		estimate.className = 'text-text-400 text-xs';
		estimate.style.cursor = 'help';
		// No margin-right so it aligns with the send button

		return { estimate };
	}

	createTooltips() {
		const create = (text) => {
			const tooltip = document.createElement('div');
			tooltip.className = 'bg-[var(--cds-tooltip-bg)] text-[var(--cds-tooltip-fg)] ut-tooltip font-normal font-ui shadow-sm dark:shadow-panel-sm';
			tooltip.textContent = text;
			tooltip.style.maxWidth = '400px';
			tooltip.style.textAlign = 'left';
			tooltip.style.whiteSpace = 'pre-line';
			getTooltipPortal().appendChild(tooltip);
			return tooltip;
		};

		return {
			length: create(localize('length.tooltip_length')),
			cost: create(localize('length.tooltip_cost')),
			cached: create(localize('length.tooltip_cached')),
			estimate: create(localize('length.tooltip_estimate')),
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
		const anchor = LayoutManager.getAnchor('titleArea');
		if (!anchor) return false;
		return mountToAnchor(this.elements.titleArea.container, anchor);
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
		const tier = this.state.usageData?.subscriptionTier;
		this.state.currentModel = await getCurrentModel(200, tier);
		this.state.currentModelVersion = await getCurrentModelVersion(200, tier);
		this.state.currentEffortLabel = await getCurrentEffortLabel(200);
		await Log('LengthUI: renderAll - detected:', this.state.currentModelVersion,
			'| stored on conversation:', this.state.conversationData?.modelVersion,
			'| effort now:', this.state.currentEffortLabel,
			'| effort when cached:', this.state.conversationData?.effortLabel,
			'| isCurrentlyCached:', this.state.conversationData?.isCurrentlyCached(
				this.state.currentModelVersion, this.state.currentEffortLabel));
		this.renderCostAndLength();
		this.renderEstimate();
	}

	renderCostAndLength() {
		const { conversationData, currentModel, currentModelVersion, currentEffortLabel } = this.state;
		const { length, cost, cached, container } = this.elements.titleArea;

		if (!conversationData) {
			length.innerHTML = `${localize('length.label')}: <span>${localize('common.na')}</span> ${localize('common.unit_tokens')}`;
			cost.innerHTML = '';
			cached.innerHTML = '';
			this.renderTitleContainer();
			return;
		}

		// Length
		const lengthColor = conversationData.isLong() ? RED_WARNING : BLUE_HIGHLIGHT;
		const lengthLabel = conversationData.lengthIsEstimate ? localize('length.label_estimate') : localize('length.label');
		length.innerHTML = `${lengthLabel}: <span style="color: ${lengthColor}">${fmtNum(conversationData.length)}</span> ${localize('common.unit_tokens')}`;

		// Update length tooltip based on estimate status
		const baseTooltip = localize('length.tooltip_length');
		this.elements.tooltips.length.textContent = conversationData.lengthIsEstimate
			? baseTooltip + '\n\n' + localize('length.tooltip_length_note')
			: baseTooltip;

		// Cost
		const weightedCost = conversationData.getWeightedFutureCost(currentModel, currentModelVersion, currentEffortLabel);
		this.state.nextMessageCost = weightedCost;

		let costColor;
		if (conversationData.isCurrentlyCached(currentModelVersion, currentEffortLabel)) {
			costColor = SUCCESS_GREEN;
		} else {
			costColor = conversationData.isExpensive() ? RED_WARNING : BLUE_HIGHLIGHT;
		}

		// If we're spending credits rather than plan usage, display in dollars instead of credits
		const { usageData } = this.state;

		if (usageData?.isSpendingCredits(currentModel)) {
			const dollars = this.extraUsageDollars(conversationData, currentModel, currentModelVersion, currentEffortLabel);
			cost.innerHTML = `${localize('length.cost')}: <span style="color: ${costColor}">$${dollars.toFixed(2)}</span>`;
		} else {
			cost.innerHTML = `${localize('length.cost')}: <span style="color: ${costColor}">${fmtNum(weightedCost)}</span> ${localize('common.unit_credits')}`;
		}

		// Cached
		if (conversationData.isCurrentlyCached(currentModelVersion, currentEffortLabel)) {
			this.state.cachedUntilTimestamp = conversationData.conversationIsCachedUntil;
			const timeInfo = conversationData.getTimeUntilCacheExpires();
			cached.innerHTML = `${localize('length.cached_prefix')} <span class="ut-cached-time" style="color: ${SUCCESS_GREEN}">${localize('time.m', { m: timeInfo.minutes })}</span>`;
		} else {
			this.state.cachedUntilTimestamp = null;
			cached.innerHTML = '';
		}

		this.renderTitleContainer();
	}

	// Dollar cost of the next message when it's billed against credits.
	// During extra usage, cache reads cost 10% of input (not free), so interpolate between the
	// cached (free) and uncached (full price) costs. This is technically not entirely accurate,
	// but it's accurate enough and doesn't require reworking half the codebase.
	extraUsageDollars(conversationData, currentModel, currentModelVersion, currentEffortLabel) {
		const weight = CONFIG.MODEL_WEIGHTS[currentModel] ?? CONFIG.FALLBACK_MODEL_WEIGHT;
		const baseFutureCost = conversationData.isCurrentlyCached(currentModelVersion, currentEffortLabel) ? conversationData.futureCost : conversationData.uncachedFutureCost;
		const interpolatedFutureCost = baseFutureCost +
			CONFIG.EXTRA_USAGE_CACHING_MULTIPLIER * (conversationData.uncachedFutureCost - baseFutureCost);
		return Math.round(interpolatedFutureCost * weight) / 1_000_000;
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

		const separator = ' | ';

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
			timeSpan.textContent = localize('time.m', { m: minutes });
		}

		return false;
	}

	renderEstimate() {
		const { estimate } = this.elements.statLine;

		if (isCodePage()) {
			estimate.innerHTML = '';
			return;
		}

		const { usageData, conversationData, currentModel, currentModelVersion, currentEffortLabel } = this.state;

		// No limits reported at all (the free plan) - there is nothing to divide the cost into, and
		// a lone "Messages left: N/A" beside the hidden usage bar reads as breakage. Drop it.
		if (usageData?.hasNoReportedUsage()) {
			estimate.innerHTML = '';
			return;
		}

		const msgPrefix = isMobileView() ? localize('length.msgs_left_mobile') : localize('length.msgs_left_desktop');

		if (!getConversationId() || !usageData || !conversationData) {
			estimate.innerHTML = `${msgPrefix} <span>${localize('common.na')}</span>`;
			return;
		}

		const messageCost = conversationData.getWeightedFutureCost(currentModel, currentModelVersion, currentEffortLabel);
		const limiting = usageData.getLimitingFactor(messageCost);

		// Estimate from dollars when credits are what's actually being spent — either the regular
		// limits are exhausted, or the model is credit-funded (in which case `limiting` reports a
		// healthy plan limit the message will never consume).
		const spendingCredits = usageData.isSpendingCredits(currentModel);
		if ((spendingCredits || !limiting || limiting.messagesLeft <= 0) && usageData.hasExtraUsage()) {
			const costPerMessageDollars = this.extraUsageDollars(conversationData, currentModel, currentModelVersion, currentEffortLabel);

			if (costPerMessageDollars > 0) {
				const remainingDollars = usageData.getExtraUsageRemaining() / 100;
				const messagesLeft = remainingDollars / costPerMessageDollars;
				const estimateValue = messagesLeft.toFixed(1);
				const color = parseFloat(estimateValue) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
				estimate.innerHTML = `${msgPrefix} <span style="color: ${color}">${estimateValue}</span>`;
				return;
			}
		}

		// Regular limits estimate — skipped for a credit-funded model, whose messages don't draw
		// on the plan limits at all, so falling back to them would report a plausible but wrong number.
		if (!usageData.isModelCreditFunded(currentModel) && limiting && limiting.messagesLeft > 0) {
			const estimateValue = limiting.messagesLeft.toFixed(1);
			const color = parseFloat(estimateValue) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
			estimate.innerHTML = `${msgPrefix} <span style="color: ${color}">${estimateValue}</span>`;
			return;
		}

		estimate.innerHTML = `${msgPrefix} <span>${localize('common.na')}</span>`;
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

	// Session usage read straight off the completion stream, about a second ahead of the full
	// fetch. Only the estimate depends on it — the cost display keys off the fields the stream
	// doesn't carry, so it can wait.
	handleSsePartialUsage({ session }) {
		if (!this.uiReady || !this.state.usageData) return;
		if (!shouldApplySseSession(this.state.usageData.limits.session, session)) return;

		this.state.usageData.limits.session = session;
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

		const previous = this.state.conversationData;
		this.state.conversationData = ConversationData.fromJSON(conversationDataJSON);
		this.syncEffortBaseline(previous).then(() => this.renderAll());
	}

	// Keeps `conversationData.effortLabel` - the effort the prompt cache was written with - current.
	// The background can't supply it (see getCurrentEffortLabel), so it is read off the picker here,
	// and WHICH updates it is read on is the whole correctness argument:
	//
	//   - the conversation moved on (new conversation, or a message settled): the picker is showing
	//     the effort that message was sent with, which is exactly what the new cache holds. Stamp it.
	//   - the same conversation state came round again (a usage window expired and usage_ui asked
	//     for a refresh, a cache-hit reply to requestData): the picker may be showing an effort the
	//     user has selected but not yet sent. Re-reading it there would quietly adopt the pending
	//     change as the baseline and put the cache indicator back on. Carry the old one forward.
	//
	// `lastMessageUuid` is the discriminator, NOT the timestamp. A message produces two updates -
	// the provisional estimate off the completion stream, then the authoritative pass ~1s later -
	// and their timestamps differ (Date.now() vs the assistant message's real created_at) even
	// though they describe the same turn. Keying on the timestamp made the pass re-read a picker
	// the user may have changed in that window, and since nothing follows the pass, the wrong
	// baseline then stuck for good.
	//
	// So the baseline is re-read only for a turn we can POSITIVELY identify as a different one:
	// both uuids present and unequal. Anything short of that - either side missing - carries the
	// old baseline forward, which is the safe direction: it can only hold a stale "not cached"
	// until the next update, never invent a cache hit that isn't there. A missing uuid means the
	// stream didn't report one, which onBeforeRequestHandler already warns about loudly.
	//
	// Left null when the picker isn't up yet; checkModelChange adopts the first real reading rather
	// than treating it as a change, since the user can't have switched a control that isn't there.
	async syncEffortBaseline(previous) {
		const conversationData = this.state.conversationData;
		if (!conversationData) return;

		const sameConversation = previous && previous.conversationId === conversationData.conversationId;
		const newTurn = previous?.lastMessageUuid && conversationData.lastMessageUuid &&
			previous.lastMessageUuid !== conversationData.lastMessageUuid;
		if (sameConversation && !newTurn) {
			conversationData.effortLabel = previous.effortLabel;
			return;
		}

		conversationData.effortLabel = await getCurrentEffortLabel(200);
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

		if (this.state.conversationData?.conversationId != newConversation && !isHomePage
			&& this.state.requestedConversationId !== newConversation) {
			await Log('LengthUI: Conversation changed, requesting data');
			// Guard against re-sending every animation frame while the reply is in flight (a slow
			// transport — e.g. the Brave content-script proxy — would otherwise cause a request storm).
			this.state.requestedConversationId = newConversation;
			sendBackgroundMessage({
				type: 'requestData',
				conversationId: newConversation
			});
			this.state.conversationData = null;
			// Clear old data to avoid showing wrong info
			this.renderCostAndLength();
			this.renderEstimate();
		}

		if (isHomePage && this.state.conversationData !== null) {
			this.state.conversationData = null;
			this.renderCostAndLength();
			this.renderEstimate();
		}
	}

	// Compared plainly rather than guarded on truthiness. The old `newModel && ...` form silently
	// dropped any falsy reading, so a picker that went from readable to unreadable kept reporting
	// the previous model here until the next renderAll - which assigns the reading directly and so
	// disagreed with this path. getCurrentModelVersion now always returns something meaningful (a
	// model id, the tier default when there is no picker, or MODEL_UNKNOWN), so there is no
	// transient falsy value left to protect against.
	async checkModelChange() {
		const tier = this.state.usageData?.subscriptionTier;
		const newModel = await getCurrentModel(200, tier);
		const newModelVersion = await getCurrentModelVersion(200, tier);
		const newEffortLabel = await getCurrentEffortLabel(200);

		// Late-mounting picker: adopt the first reading as the baseline instead of reporting it as
		// a change. Only ever fills a null - once stamped, the baseline moves on the next update.
		const conversationData = this.state.conversationData;
		if (conversationData && !conversationData.effortLabel && newEffortLabel) {
			conversationData.effortLabel = newEffortLabel;
		}

		if (newModel !== this.state.currentModel ||
			newModelVersion !== this.state.currentModelVersion ||
			newEffortLabel !== this.state.currentEffortLabel) {
			await Log('LengthUI: Model/effort changed, recalculating displays');
			this.state.currentModel = newModel;
			this.state.currentModelVersion = newModelVersion;
			this.state.currentEffortLabel = newEffortLabel;
			if (this.state.conversationData) {
				this.renderCostAndLength();
				this.renderEstimate();
			}
		}
	}
}

// Self-initialize
const lengthUI = new LengthUI();