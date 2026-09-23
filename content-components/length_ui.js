/* global CONFIG, Log, setupTooltip, getTooltipPortal, getResetTimeHTML, sleep, sendBackgroundMessage, getActiveOrgId,
   isMobileView, isCodePage, UsageData, ConversationData, getConversationId, getCurrentModel,
   getCurrentModelVersion, getCurrentEffortLabel, RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, SELECTORS,
   LayoutManager, mountToAnchor, localize, fmtNum, onSsePartialUsage, shouldApplySseSession,
   LENGTH_DISPLAY_KEY */
'use strict';

// How long the title line may overflow the header before it moves to the strip (see titleFitsHeader).
const TITLE_OVERFLOW_GRACE_MS = 1500;

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

		// Hidden by settings: stay dormant rather than mount-and-hide. Nothing gets created (the
		// tooltips are appended to the portal eagerly) and uiReady stays false, so every message
		// handler already no-ops. Not mounting also matters on mobile, where mounting the title
		// line moves the scroller's top margin onto our element - hiding it afterwards would drop
		// that offset and slide the messages under the header. The settings card reloads on Save,
		// so this is read once.
		const stored = await browser.storage.local.get(LENGTH_DISPLAY_KEY);
		if (stored[LENGTH_DISPLAY_KEY] === true) {
			await Log('LengthUI: hidden by settings, staying dormant');
			return;
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

		// An invisible, zero-height copy of the line that stays in the header even while the line
		// itself is down in the strip (see mountTitleArea). It measures whether the line fits, and it
		// keeps the line's width claimed there: the text spills out of the title group at full width,
		// which is the overflow that tells other header occupants (Claude QoL) to make room. Without
		// the claim, the line moving to the strip would remove that pressure, the header would never
		// free up, and the line would never come back.
		const claim = document.createElement('div');
		claim.className = 'text-xs ut-select-none ut-title-claim';
		claim.setAttribute('aria-hidden', 'true');
		Object.assign(claim.style, {
			flexBasis: '100%',
			height: '0',
			// Firefox ignores height:0 here and lays the claim out 24px tall (a line and more), which
			// grows the title group past the fixed-height header and pushes the chat title off the top.
			// max-height does hold there.
			maxHeight: '0',
			minWidth: '0',
			overflow: 'visible',
			whiteSpace: 'nowrap',
			visibility: 'hidden',
			pointerEvents: 'none',
		});

		return { container, length, cost, cached, claim };
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
		const { container, claim } = this.elements.titleArea;

		// Only the desktop header has a width to fight over (see getDesktopTitleAreaAnchor). Anywhere
		// else, forget the header/strip decision so the next header starts with a fresh grace period.
		if (!anchor || !('strip' in anchor)) {
			claim.remove();
			// The strip lives outside the title group, so it survives a navigation that tears the
			// header down and would linger on the next page. Only the strip, though: the legacy mobile
			// anchor has moved the scroller's top margin onto our element, so pulling it out there
			// would slide the messages under the header. Tracked as state rather than read off the DOM:
			// the banner the strip sits after may already be gone by the time we look.
			if (!anchor && this.titleMountedInStrip) container.remove();
			this.titleInStrip = false;
			this.titleOverflowSince = null;
			if (!anchor) {
				this.titleMountedInStrip = false;
				return false;
			}
			this.titleMountedInStrip = !!anchor.isStrip;
			return mountToAnchor(container, anchor);
		}

		// The claim is the title group's last child and the line, when in the header, sits right
		// before it - two elements both mounted as "last child" would swap places every tick.
		mountToAnchor(claim, { parent: anchor.parent, referenceNode: null, styles: { paddingLeft: anchor.styles.paddingLeft } });
		// Synced here rather than in the renderers: renderCachedTime edits the countdown in place.
		if (claim.textContent !== container.textContent) claim.textContent = container.textContent;
		const inHeader = !anchor.strip || this.titleFitsHeader(claim);
		this.titleMountedInStrip = !inHeader;
		return mountToAnchor(container, inHeader ? { ...anchor, referenceNode: claim } : anchor.strip);
	}

	// Whether the title line should sit in the header, judged by the claim - which is laid out
	// exactly where the line would be, so it overflows exactly when the line would be truncated.
	//
	// Leaving for the strip waits out TITLE_OVERFLOW_GRACE_MS first. Something else in the header
	// may be about to make room: Claude QoL collapses its buttons into a menu when the header
	// overflows, and it checks about once a second. Coming back is immediate.
	titleFitsHeader(claim) {
		if (claim.scrollWidth <= claim.clientWidth + 1) {
			this.titleInStrip = false;
			this.titleOverflowSince = null;
			return true;
		}
		if (this.titleInStrip) return false;
		this.titleOverflowSince ??= Date.now();
		if (Date.now() - this.titleOverflowSince < TITLE_OVERFLOW_GRACE_MS) return true;
		this.titleInStrip = true;
		return false;
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

	// The model family every price and limit on this screen is computed for: the picker's reading
	// when there is one, else the conversation's own. getCurrentModel returns null both when the
	// picker is missing and when it is unreadable, and null must not reach the consumers below -
	// isSpendingCredits would stop recognising a credit-funded model - so it is resolved once, here,
	// rather than at each call site. Prices themselves go by model ID (getPricingWeight), which does
	// the same picker-then-conversation fallback on the ID and only uses this family for an ID it
	// has no price for; passing it the resolved value keeps the two paths visibly the same.
	effectiveModel() {
		return this.state.currentModel ?? this.state.conversationData?.model ?? null;
	}

	renderCostAndLength() {
		const { conversationData, currentModelVersion, currentEffortLabel } = this.state;
		const currentModel = this.effectiveModel();
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
		const weight = conversationData.getPricingWeight(currentModel, currentModelVersion);
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

		const { usageData, conversationData, currentModelVersion, currentEffortLabel } = this.state;
		const currentModel = this.effectiveModel();

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

		// Forget the in-flight guard on the home page, or coming back to the same conversation never
		// requests its data again and the line stays at N/A. Unconditional: leaving before the reply
		// arrived leaves conversationData null, and the guard would stick just the same.
		if (isHomePage) this.state.requestedConversationId = null;

		if (isHomePage && this.state.conversationData !== null) {
			this.state.conversationData = null;
			this.renderCostAndLength();
			this.renderEstimate();
		}
	}

	// Compared plainly rather than guarded on truthiness. The old `newModel && ...` form silently
	// dropped any falsy reading, so a picker that went from readable to unreadable kept reporting
	// the previous model here until the next renderAll - which assigns the reading directly and so
	// disagreed with this path. A null reading (no picker) flows through on purpose: it means "not
	// observed", and every renderer then falls back to the conversation's own model, which is the
	// right answer while the control is missing. Holding the previous reading instead would keep a
	// stale model across a conversation switch. MODEL_UNKNOWN (picker present but unreadable) is a
	// truthy sentinel and is compared like any other reading.
	async checkModelChange() {
		const newModel = await getCurrentModel(200);
		const newModelVersion = await getCurrentModelVersion(200);
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