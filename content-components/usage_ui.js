/* global CONFIG, Log, ProgressBar, sendBackgroundMessage, getActiveOrgId,
   setupTooltip, getTooltipPortal, getResetTimeHTML, sleep, isMobileView, isCodePage, UsageData, isPeakHours,
   RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, SELECTORS, LayoutManager, mountToAnchor,
   localize, fmtNum, localeForIntl, onSsePartialUsage, shouldApplySseSession,
   SIDEBAR_DISPLAY_KEY, getSidebarDisplayPrefs, isSidebarItemVisible */
'use strict';

// A limit whose reset time has passed needs fresh data from the server to clear. The server does
// not always have it yet - it can keep reporting the window that just expired - so this retries on
// a backoff instead of asking once. Both bounds matter: asking once and giving up leaves the bar
// stuck on "Resetting..." forever if the request fails, and asking every frame turns a window the
// server hasn't rolled over yet into a request per second.
const EXPIRY_GRACE_MS = 60 * 1000;			// how far past the reset before we ask at all
const EXPIRY_RETRY_BASE_MS = 30 * 1000;		// first retry delay, doubling per attempt
const EXPIRY_RETRY_MAX_MS = 5 * 60 * 1000;	// ceiling for that backoff

// Usage section with multiple limit bars
class UsageSection {
	constructor() {
		this.elements = this.createElement();
		this.limitBars = new Map(); // limitKey -> { row, percentage, resetTime, progressBar }
		this.hiddenKeys = new Set(); // limit keys the user switched off in settings
		this.notice = null; // stand-in shown when the server reports no limits at all
	}

	createElement() {
		const container = document.createElement('div');
		container.className = 'ut-container';

		const barsContainer = document.createElement('div');
		barsContainer.className = 'ut-bars-container';

		container.appendChild(barsContainer);
		return { container, barsContainer };
	}

	createLimitBar(limitKey) {
		const row = document.createElement('div');
		row.className = 'ut-limit-row ut-mb-2';

		const topLine = document.createElement('div');
		topLine.className = 'text-text-000 ut-row ut-justify-between ut-mb-1 ut-select-none';
		topLine.style.whiteSpace = 'nowrap';

		const leftSide = document.createElement('div');
		leftSide.className = 'ut-row';

		const title = document.createElement('span');
		title.className = 'text-xs';
		title.textContent = this.getLimitLabel(limitKey);
		title.style.minWidth = '95px';
		title.style.display = 'inline-block';

		const percentage = document.createElement('span');
		percentage.className = 'text-xs';
		percentage.style.minWidth = '30px';

		leftSide.appendChild(title);
		leftSide.appendChild(percentage);

		const resetTime = document.createElement('div');
		resetTime.className = 'text-text-400 text-xs';

		topLine.appendChild(leftSide);
		topLine.appendChild(resetTime);

		const progressBar = new ProgressBar();

		row.appendChild(topLine);
		row.appendChild(progressBar.container);

		return { row, percentage, resetTime, progressBar };
	}

	getLimitLabel(limitKey) {
		const labelKeys = {
			session: 'usage.label_session',
			weekly: 'usage.label_weekly',
			sonnetWeekly: 'usage.label_sonnet_weekly',
			opusWeekly: 'usage.label_opus_weekly',
			fableWeekly: 'usage.label_fable_weekly',
			extraUsage: 'usage.label_extra'
		};
		return labelKeys[limitKey] ? localize(labelKeys[limitKey]) : limitKey;
	}

	render(usageData) {
		if (!usageData) return;

		const activeLimits = usageData.getActiveLimits();
		const { barsContainer } = this.elements;

		// Track which limits we've seen this render
		const seenKeys = new Set();

		for (const limit of activeLimits) {
			// Hidden bars are left out of seenKeys, so the teardown pass below removes them.
			if (this.hiddenKeys.has(limit.key)) continue;

			seenKeys.add(limit.key);
			let barElements = this.limitBars.get(limit.key);

			if (!barElements) {
				barElements = this.createLimitBar(limit.key);
				this.limitBars.set(limit.key, barElements);
				barsContainer.appendChild(barElements.row);
			}

			const { percentage, resetTime, progressBar } = barElements;

			progressBar.updateProgress(limit.percentage, 100);

			// Override tooltip with estimated token values
			let cap = CONFIG.ESTIMATED_CAPS?.[usageData.subscriptionTier]?.[limit.key];
			if (limit.key === 'session' && isPeakHours()) cap = cap / CONFIG.PEAK_SESSION_MULTIPLIER;
			if (cap) {
				const used = Math.round((limit.percentage / 100) * cap);
				progressBar.tooltip.textContent = localize('usage.tooltip_tokens', { used: fmtNum(used), cap: fmtNum(cap), pct: limit.percentage.toFixed(0) });
			} else {
				progressBar.tooltip.textContent = localize('usage.tooltip_pct_used', { pct: limit.percentage.toFixed(0) });
			}

			const color = limit.percentage >= CONFIG.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
			percentage.textContent = `${limit.percentage.toFixed(0)}%`;
			percentage.style.color = color;

			resetTime.innerHTML = this.formatResetTime(limit.resetsAt);
		}

		// Extra usage bar (shown whenever extra usage is set up, even before limits are maxed —
		// credits can be spent before normal usage runs out)
		if (usageData.hasExtraUsageConfigured() && !this.hiddenKeys.has('extraUsage')) {
			seenKeys.add('extraUsage');
			let barElements = this.limitBars.get('extraUsage');

			if (!barElements) {
				barElements = this.createLimitBar('extraUsage');
				this.limitBars.set('extraUsage', barElements);
				barsContainer.appendChild(barElements.row);
			}

			const { percentage, resetTime, progressBar } = barElements;
			const effectiveTotal = usageData.getExtraUsageEffectiveTotal();
			const used = usageData.extraUsage.usedCredits;
			const pct = effectiveTotal > 0 ? (used / effectiveTotal) * 100 : 0;

			progressBar.updateProgress(pct, 100);

			const usedDollars = (used / 100).toFixed(2);
			const totalDollars = (effectiveTotal / 100).toFixed(2);
			progressBar.tooltip.textContent = localize('usage.tooltip_dollars', { used: usedDollars, total: totalDollars });

			const color = pct >= CONFIG.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
			percentage.textContent = `${pct.toFixed(0)}%`;
			percentage.style.color = color;

			resetTime.innerHTML = '';
		}

		// Remove bars for limits no longer active
		for (const [key, barElements] of this.limitBars) {
			if (!seenKeys.has(key)) {
				barElements.row.remove();
				this.limitBars.delete(key);
			}
		}

		// Re-append in limit order (seenKeys keeps insertion order). Without this a bar switched
		// back on in settings is appended at the end instead of returning to its old position.
		for (const key of seenKeys) {
			barsContainer.appendChild(this.limitBars.get(key).row);
		}

		this.renderNotice(usageData);
	}

	// With nothing to draw the section is just a header sitting on top of the footers, which reads
	// as the extension being broken rather than as claude.ai reporting nothing. Say which it is.
	//
	// Keyed off hasNoReportedUsage() rather than "no rows were drawn": switching every bar off in
	// settings also empties the container, and that user must not be told the server reports
	// nothing. Appended last so it can never land between bars.
	renderNotice(usageData) {
		if (!usageData.hasNoReportedUsage()) {
			if (this.notice) {
				this.notice.remove();
				this.notice = null;
			}
			return;
		}

		if (!this.notice) {
			this.notice = document.createElement('div');
			this.notice.className = 'ut-usage-notice text-text-400 text-xs';
			this.elements.barsContainer.appendChild(this.notice);
		}

		this.notice.textContent = usageData.subscriptionTier === 'claude_free'
			? localize('usage.no_limits_free')
			: localize('usage.no_limits');
	}

	formatResetTime(timestamp) {
		if (!timestamp) return '';
		const diff = timestamp - Date.now();
		if (diff <= 0) return `<span style="color: ${SUCCESS_GREEN}">${localize('common.resetting')}</span>`;

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

		if (hours >= 24) {
			const days = Math.floor(hours / 24);
			const remainingHours = hours % 24;
			return `⏱ ${localize('time.dh', { d: days, h: remainingHours })}`;
		}
		if (hours === 0) {
			return `⏱ ${localize('time.m', { m: minutes })}`;
		}
		return `⏱ ${localize('time.hm', { h: hours, m: minutes })}`;
	}

	renderResetTimes(usageData) {
		if (!usageData) return;

		for (const limit of usageData.getActiveLimits()) {
			const barElements = this.limitBars.get(limit.key);
			if (barElements) {
				barElements.resetTime.innerHTML = this.formatResetTime(limit.resetsAt);
			}
		}
	}
}

// Usage UI actor - owns sidebar and chat area usage displays
class UsageUI {
	constructor() {
		// State
		this.state = {
			usageData: null,
			currentModel: null,
			// limitKey -> { requestedAt, attempts } for expired limits we've asked to refresh.
			// Cleared for a limit once its reset time is in the future again.
			expiryRefreshes: new Map(),
			collapsed: false,
			sidebarDisplay: {},
		};

		// Element references
		this.elements = {
			sidebar: null,
			chat: null,
			tooltips: null,
		};

		// Sub-component
		this.usageSection = null;

		this.uiReady = false;
		this.pendingUpdate = null;

		this.lastUpdateTime = 0;
		this.updateInterval = 1000;
		this.wasPeakHours = isPeakHours();


		this.setupMessageListener();
		this.init();
	}

	// ========== SETUP ==========

	setupMessageListener() {
		browser.runtime.onMessage.addListener((message) => {
			if (message.type === 'updateUsage') {
				const msgOrgId = message.data.usageData?.orgId;
				const myOrgId = getActiveOrgId();
				if (msgOrgId && myOrgId && msgOrgId !== myOrgId) return;
				this.handleUsageUpdate(message.data.usageData);
			}
		});

		onSsePartialUsage((update) => this.handleSsePartialUsage(update));

		// Keep the collapsed state and the display toggles in sync across tabs. The settings card
		// writes storage from this same page, so this doubles as the in-page live-update path.
		browser.storage.onChanged.addListener((changes, area) => {
			if (area !== 'local') return;

			if (changes.usageSectionCollapsed) {
				const collapsed = changes.usageSectionCollapsed.newValue === true;
				if (this.uiReady && collapsed !== this.state.collapsed) {
					this.setCollapsed(collapsed, false);
				}
			}

			if (changes[SIDEBAR_DISPLAY_KEY] && this.uiReady) {
				this.state.sidebarDisplay = changes[SIDEBAR_DISPLAY_KEY].newValue || {};
				this.applySidebarDisplay();
			}
		});
	}

	async init() {
		await Log('UsageUI: Initializing...');

		while (!CONFIG) {
			await sleep(100);
		}

		const stored = await browser.storage.local.get('usageSectionCollapsed');
		this.state.collapsed = stored.usageSectionCollapsed === true;
		this.state.sidebarDisplay = await getSidebarDisplayPrefs();

		this.usageSection = new UsageSection();
		this.elements.sidebar = await this.createSidebarElements();
		this.elements.chat = this.createChatElements();
		this.elements.tooltips = this.createTooltips();
		this.attachTooltips();
		this.setCollapsed(this.state.collapsed, false);
		this.applySidebarDisplay();

		this.uiReady = true;
		await Log('UsageUI: Ready');

		// Process pending update (only most recent matters)
		if (this.pendingUpdate) {
			this.state.usageData = UsageData.fromJSON(this.pendingUpdate);
			this.pendingUpdate = null;
			this.renderAll();
		}

		this.startUpdateLoop();
	}

	// ========== CREATE (pure DOM construction) ==========

	async createSidebarElements() {
		const container = document.createElement('div');
		container.className = 'ut-usage-sidebar flex flex-col mb-6';

		const { header, toggle } = this.createHeader();
		const content = document.createElement('div');
		content.className = 'flex min-h-0 flex-col pl-2';
		content.style.paddingRight = '0.25rem';

		const sectionsContainer = document.createElement('ul');
		sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col px-1.5 gap-px';
		sectionsContainer.appendChild(this.usageSection.elements.container);
		content.appendChild(sectionsContainer);

		// Add footers
		let desktopFooter = null;
		const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
		if (!isElectron) {
			desktopFooter = this.createDesktopFooter();
			content.appendChild(desktopFooter);

			const qolFooter = this.createQoLFooter();
			if (qolFooter) {
				content.appendChild(qolFooter);
			}
		}

		const donateFooter = this.createDonateFooter();
		content.appendChild(donateFooter);

		container.appendChild(header);
		container.appendChild(content);

		const elements = { container, content, toggle, desktopFooter };
		toggle.addEventListener('click', () => this.setCollapsed(!this.state.collapsed));

		return elements;
	}

	createHeader() {
		const header = document.createElement('div');
		header.className = 'ut-row ut-justify-between';

		// Collapse toggle - mirrors the site's own sidebar section headers (label + chevron
		// that only shows on hover while expanded, and stays visible while collapsed).
		const toggle = document.createElement('button');
		toggle.type = 'button';
		toggle.className = 'ut-usage-toggle';
		toggle.setAttribute('aria-expanded', String(!this.state.collapsed));

		const title = document.createElement('h3');
		title.textContent = localize('usage.header');
		title.className = 'text-text-500 text-xs select-none';

		const chevron = document.createElement('span');
		chevron.className = 'ut-collapse-chevron text-text-500';
		chevron.setAttribute('aria-hidden', 'true');
		chevron.innerHTML = `
			<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
				<path d="M9 18l6-6-6-6"/>
			</svg>
		`;

		toggle.appendChild(title);
		toggle.appendChild(chevron);

		const settingsButton = document.createElement('button');
		settingsButton.className = 'ut-button ut-button-icon hover:bg-bg-400 hover:text-text-100';
		settingsButton.style.color = BLUE_HIGHLIGHT;
		settingsButton.style.padding = '0';
		settingsButton.style.width = '1rem';
		settingsButton.style.height = '1rem';
		settingsButton.innerHTML = `
			<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
				<path d="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
			</svg>
		`;

		settingsButton.addEventListener('click', () => {
			const buttonRect = settingsButton.getBoundingClientRect();
			document.dispatchEvent(new CustomEvent('ut:toggleSettings', {
				detail: { position: { top: buttonRect.top - 5, left: buttonRect.right + 5 } }
			}));
		});

		header.appendChild(toggle);
		header.appendChild(settingsButton);
		return { header, toggle };
	}

	// Push the display prefs into the DOM. Hidden bars drop out of the next render (the section's
	// teardown pass removes their rows), and re-checking one rebuilds it on the render after that.
	applySidebarDisplay() {
		const prefs = this.state.sidebarDisplay;

		this.usageSection.hiddenKeys = new Set(
			Object.keys(prefs).filter(key => key !== 'desktopLink' && !isSidebarItemVisible(prefs, key))
		);

		// Absent on Electron, where the footer is never built.
		const desktopFooter = this.elements.sidebar?.desktopFooter;
		if (desktopFooter) {
			desktopFooter.style.display = isSidebarItemVisible(prefs, 'desktopLink') ? '' : 'none';
		}

		if (this.state.usageData) this.renderAll();
	}

	// Keys the settings card builds its checkbox list from, ignoring the hide prefs.
	//
	// Limits are listed only when the account actually has them — an account's set of limit bars
	// is fixed by its tier, so a toggle for one it never gets would be dead UI. Extra usage is
	// different: it's a baseline switch, always offered, because the credits bar appears the
	// moment extra usage is enabled and someone who never wants to see it should be able to say
	// so in advance. Off means never; on means show it if and when it becomes relevant.
	availableLimitKeys() {
		const usageData = this.state.usageData;
		const keys = usageData ? usageData.getActiveLimits().map(limit => limit.key) : [];
		keys.push('extraUsage');
		return keys;
	}

	setCollapsed(collapsed, persist = true) {
		this.state.collapsed = collapsed;

		const { container, content, toggle } = this.elements.sidebar;
		content.style.display = collapsed ? 'none' : '';
		// mb-6 exists to separate the bars from the recents list; with nothing below the
		// header there's nothing to separate, so claw the space back.
		container.style.marginBottom = collapsed ? '0.5rem' : '';
		container.classList.toggle('ut-collapsed', collapsed);
		toggle.setAttribute('aria-expanded', String(!collapsed));

		if (persist) browser.storage.local.set({ usageSectionCollapsed: collapsed });
	}

	createDesktopFooter() {
		const footer = document.createElement('div');
		footer.className = 'ut-desktop-footer ut-sidebar-footer mt-1';

		const link = document.createElement('a');
		link.href = 'https://github.com/lugia19/claude-webext-patcher';
		link.target = '_blank';
		link.className = 'ut-link hover:text-text-200';
		link.style.color = BLUE_HIGHLIGHT;
		link.textContent = '💻 ' + localize('usage.footer_desktop');

		footer.appendChild(link);
		return footer;
	}

	createQoLFooter() {
		const footer = document.createElement('div');
		footer.className = 'ut-desktop-footer ut-sidebar-footer mt-1 ut-qol-footer';

		const isChrome = !!window.chrome && (!!window.chrome.webstore || !!window.chrome.runtime);
		const link = document.createElement('a');
		link.href = isChrome
			? 'https://chromewebstore.google.com/detail/claude-qol/dkdnancajokhfclpjpplkhlkbhaeejob'
			: 'https://addons.mozilla.org/en-US/firefox/addon/claude-qol/';
		link.target = '_blank';
		link.className = 'ut-link hover:text-text-200';
		link.style.color = BLUE_HIGHLIGHT;
		link.textContent = '⚡ ' + localize('usage.footer_qol');

		footer.appendChild(link);
		return footer;
	}

	createDonateFooter() {
		const footer = document.createElement('div');
		footer.className = 'ut-desktop-footer ut-sidebar-footer mt-1';

		const link = document.createElement('a');
		link.href = 'https://ko-fi.com/lugia19';
		link.target = '_blank';
		link.className = 'ut-link';
		link.style.cssText = 'background: #2c84db; color: white; padding: 2px 6px; border-radius: 4px; display: inline-block;';
		link.textContent = '☕ ' + localize('usage.footer_kofi');

		footer.appendChild(link);
		return footer;
	}

	createChatElements() {
		// Stat line container
		const statLine = document.createElement('div');
		statLine.id = 'ut-chat-stat-line';
		statLine.className = 'ut-row';
		statLine.style.paddingLeft = '6px'; // Align with chatbox text input

		// Left container (usage)
		const leftContainer = document.createElement('div');
		leftContainer.id = 'ut-stat-left';
		leftContainer.className = 'ut-row ut-statline-left';

		const usageDisplay = document.createElement('div');
		usageDisplay.className = 'text-text-400 text-xs';
		usageDisplay.style.whiteSpace = 'nowrap';
		if (!isMobileView()) usageDisplay.style.marginRight = '8px';
		usageDisplay.textContent = localize('usage.session_inline');

		leftContainer.appendChild(usageDisplay);

		// Progress bar (desktop only)
		let progressBar = null;
		if (!isMobileView()) {
			progressBar = new ProgressBar({ width: '100%' });
			progressBar.track.classList.remove('bg-bg-500');
			progressBar.track.classList.add('bg-bg-200');
			leftContainer.appendChild(progressBar.container);
		}

		// Spacer
		const spacer = document.createElement('div');
		spacer.className = 'ut-flex-1';

		// Right container (for LengthUI)
		const rightContainer = document.createElement('div');
		rightContainer.id = 'ut-stat-right';
		rightContainer.className = 'ut-row';

		// Peak hours indicator
		const peakIndicator = document.createElement('div');
		peakIndicator.className = 'text-text-400 text-xs';
		peakIndicator.style.cssText = `color: ${RED_WARNING}; font-weight: bold; margin-right: 8px; display: none; user-select: none;`;
		peakIndicator.textContent = localize('usage.peak');

		// Reset time display
		const resetDisplay = document.createElement('div');
		resetDisplay.className = 'text-text-400 text-xs';
		if (!isMobileView()) resetDisplay.style.marginRight = '8px';

		rightContainer.appendChild(peakIndicator);
		rightContainer.appendChild(resetDisplay);

		statLine.appendChild(leftContainer);
		statLine.appendChild(spacer);
		statLine.appendChild(rightContainer);

		return { statLine, usageDisplay, progressBar, peakIndicator, resetDisplay };
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

		// Convert peak hours (1pm-7pm GMT) to user's local timezone
		const formatLocal = (utcHour) => {
			const d = new Date();
			d.setUTCHours(utcHour, 0, 0, 0);
			return d.toLocaleTimeString(localeForIntl(), { hour: 'numeric', minute: '2-digit' });
		};
		const peakStart = formatLocal(12);
		const peakEnd = formatLocal(18);

		return {
			usage: create(localize('usage.tooltip_usage')),
			timer: create(localize('usage.tooltip_timer')),
			peak: create(localize('usage.tooltip_peak', { start: peakStart, end: peakEnd })),
		};
	}

	attachTooltips() {
		setupTooltip(this.elements.chat.usageDisplay, this.elements.tooltips.usage);
		setupTooltip(this.elements.chat.resetDisplay, this.elements.tooltips.timer);
		setupTooltip(this.elements.chat.peakIndicator, this.elements.tooltips.peak);
	}

	// ========== MOUNT (attach to page) ==========

	mountSidebar() {
		const anchor = LayoutManager.getAnchor('sidebar');
		if (!anchor) return false;
		return mountToAnchor(this.elements.sidebar.container, anchor);
	}

	mountChatArea() {
		const anchor = LayoutManager.getAnchor('chatArea');
		if (!anchor) return false;
		return mountToAnchor(this.elements.chat.statLine, anchor);
	}

	// ========== RENDER (state → DOM) ==========

	renderAll() {
		this.renderSidebar();
		this.renderChatArea();
	}

	renderSidebar() {
		const { usageData } = this.state;
		if (!usageData) return;
		this.usageSection.render(usageData);
	}

	// The stat line row collapses to nothing once its children are hidden, so the container itself
	// stays in the DOM and LengthUI.mountStatLine() keeps finding #ut-stat-right.
	setChatUsageVisible(visible) {
		const { usageDisplay, progressBar, peakIndicator, resetDisplay } = this.elements.chat;
		const display = visible ? '' : 'none';

		usageDisplay.style.display = display;
		if (progressBar) progressBar.container.style.display = display;

		// The countdown is session-specific, so it tracks the session limit rather than the row as a
		// whole. The credits branch renders with no session at all on a credit-funded model, and
		// would otherwise print "Reset in: Not set" beside a perfectly good Extra usage bar. Same
		// condition renderResetTimes() uses, so the two can't disagree about it.
		const session = this.state.usageData?.limits.session;
		resetDisplay.style.display = visible && session ? '' : 'none';

		// Owned by the render branches below while visible; forced off here so it can't outlive them.
		if (!visible) peakIndicator.style.display = 'none';
	}

	renderChatArea() {
		const { usageData } = this.state;
		const { usageDisplay, progressBar, peakIndicator, resetDisplay } = this.elements.chat;

		if (!usageData) return;

		// Read the picker directly rather than this.state.currentModel, which stays null until
		// checkModelChange() first polls (up to 1s after mount). Reused for the weekly marker below.
		const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
		const modelName = modelSelector?.textContent?.trim() || null;

		// Nothing to price this against (the free plan, where /usage reports no limits at all).
		// Returning here without touching the DOM would leave whatever was last written on screen:
		// that is how a free account ended up showing a stale "Session: 2%" - set by an SSE partial
		// a moment earlier - next to "Reset in: Not set". Hide the usage half outright instead.
		const session = usageData.limits.session;
		const hasUsage = !!session || usageData.isSpendingCredits(modelName);
		this.setChatUsageVisible(hasUsage);
		if (!hasUsage) return;

		// Show extra usage instead of the session bar whenever credits are what's being spent —
		// either the plan limits are maxed, or the selected model is credit-funded (e.g. Fable
		// on a tier where it has no plan-scoped weekly limit).
		if (usageData.isSpendingCredits(modelName)) {
			const effectiveTotal = usageData.getExtraUsageEffectiveTotal();
			const used = usageData.extraUsage.usedCredits;
			const pct = effectiveTotal > 0 ? (used / effectiveTotal) * 100 : 0;

			const color = pct >= CONFIG.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
			usageDisplay.innerHTML = `${localize('usage.extra_inline')} <span class="ut-statline-pct" style="color: ${color}">${pct.toFixed(0)}%</span>`;
			peakIndicator.style.display = 'none';

			if (!isMobileView() && progressBar) {
				progressBar.updateProgress(pct, 100);

				const usedDollars = (used / 100).toFixed(2);
				const totalDollars = (effectiveTotal / 100).toFixed(2);
				progressBar.tooltip.textContent = localize('usage.tooltip_dollars', { used: usedDollars, total: totalDollars });
				progressBar.clearMarker();
			}

			// Show session reset time (still relevant — when session resets, user goes back to included usage)
			const resetInfo = usageData.getSessionResetInfo();
			resetDisplay.innerHTML = getResetTimeHTML(resetInfo);
			return;
		}

		// Normal session display
		const color = session.percentage >= CONFIG.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
		usageDisplay.innerHTML = `${localize('usage.session_inline')} <span class="ut-statline-pct" style="color: ${color}">${session.percentage.toFixed(0)}%</span>`;
		peakIndicator.style.display = isPeakHours() ? '' : 'none';

		// Progress bar (desktop only)
		if (!isMobileView() && progressBar) {
			progressBar.updateProgress(session.percentage, 100);

			// Override tooltip with estimated token values
			let cap = CONFIG.ESTIMATED_CAPS?.[usageData.subscriptionTier]?.session;
			if (isPeakHours()) cap = cap / CONFIG.PEAK_SESSION_MULTIPLIER;
			if (cap) {
				const used = Math.round((session.percentage / 100) * cap);
				progressBar.tooltip.textContent = localize('usage.tooltip_tokens', { used: fmtNum(used), cap: fmtNum(cap), pct: session.percentage.toFixed(0) });
			} else {
				progressBar.tooltip.textContent = localize('usage.tooltip_pct_used', { pct: session.percentage.toFixed(0) });
			}

			// Add weekly marker (filter by current model)
			const weeklyLimit = usageData.getBindingWeeklyLimit(modelName);
			if (weeklyLimit) {
				const markerKeys = { weekly: 'usage.marker_all', sonnetWeekly: 'usage.marker_sonnet', opusWeekly: 'usage.marker_opus', fableWeekly: 'usage.marker_fable' };
				const markerName = markerKeys[weeklyLimit.key] ? localize(markerKeys[weeklyLimit.key]) : localize('usage.marker_fallback');
				const markerLabel = `${markerName}: ${weeklyLimit.percentage.toFixed(0)}%`;
				progressBar.setMarker(weeklyLimit.percentage, markerLabel);
			} else {
				progressBar.clearMarker();
			}
		}

		// Reset time (session)
		const resetInfo = usageData.getSessionResetInfo();
		resetDisplay.innerHTML = getResetTimeHTML(resetInfo);
	}

	renderResetTimes() {
		const { usageData } = this.state;
		if (!usageData) return;

		// Sidebar
		this.usageSection.renderResetTimes(usageData);

		// Chat area. Skipped with no session limit: this runs every second and would otherwise keep
		// writing "Reset in: Not set" into the display renderChatArea() hid.
		if (!usageData.limits.session) return;
		const resetInfo = usageData.getSessionResetInfo();
		this.elements.chat.resetDisplay.innerHTML = getResetTimeHTML(resetInfo);
	}

	// ========== MESSAGE HANDLERS ==========

	handleUsageUpdate(usageDataJSON) {
		if (!this.uiReady) {
			Log('UsageUI: Not ready, queueing update');
			this.pendingUpdate = usageDataJSON;
			return;
		}

		this.state.usageData = UsageData.fromJSON(usageDataJSON);
		this.renderAll();
	}

	// Session usage read straight off the completion stream, about a second ahead of the full
	// fetch. Overwrites the one field it knows and leaves everything else alone; if no usage has
	// arrived yet there is nothing to overwrite, so we just wait for the full fetch.
	handleSsePartialUsage({ session }) {
		if (!this.uiReady || !this.state.usageData) return;
		if (!shouldApplySseSession(this.state.usageData.limits.session, session)) return;

		this.state.usageData.limits.session = session;
		this.renderAll();
	}

	// ========== CHECKS ==========

	checkExpiredLimits() {
		const { usageData } = this.state;
		if (!usageData) return;

		const now = Date.now();
		const activeLimits = usageData.getActiveLimits();

		// Forget limits that are no longer reported, so their records can't suppress a later request.
		const activeKeys = new Set(activeLimits.map(limit => limit.key));
		for (const key of this.state.expiryRefreshes.keys()) {
			if (!activeKeys.has(key)) this.state.expiryRefreshes.delete(key);
		}

		for (const limit of activeLimits) {
			if (!limit.resetsAt || limit.resetsAt > now - EXPIRY_GRACE_MS) {
				// Not expired - the window rolled over (or never lapsed), so drop any backoff and let
				// the next expiry ask immediately.
				this.state.expiryRefreshes.delete(limit.key);
				continue;
			}

			// Note the backoff is per limit, not per reset timestamp: a server that hands back a
			// *different* still-expired timestamp each time is exactly the case we must not answer
			// with a request per frame. Only a reset time that has actually moved into the future
			// (handled above) earns an immediate request.
			const previous = this.state.expiryRefreshes.get(limit.key);
			if (previous) {
				const wait = Math.min(EXPIRY_RETRY_BASE_MS * 2 ** previous.attempts, EXPIRY_RETRY_MAX_MS);
				if (now - previous.requestedAt < wait) continue;
				previous.requestedAt = now;
				previous.attempts++;
			} else {
				this.state.expiryRefreshes.set(limit.key, { requestedAt: now, attempts: 0 });
			}

			Log(`UsageUI: Limit "${limit.key}" expired, requesting fresh data`);
			sendBackgroundMessage({ type: 'requestData' }).catch(async (error) => {
				// The request never reached the background (or it threw). Undo the attempt bump so we
				// keep retrying at the base interval instead of backing off toward the ceiling - a
				// failed request tells us nothing about whether the server has rolled the window over.
				const record = this.state.expiryRefreshes.get(limit.key);
				if (record && record.attempts > 0) record.attempts--;
				await Log("warn", `UsageUI: Refresh request for expired limit "${limit.key}" failed:`, error);
			});
			return; // one request is enough, it fetches all limits
		}
	}

	checkModelChange() {
		const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
		const modelName = modelSelector?.textContent?.trim() || null;

		if (modelName && modelName !== this.state.currentModel) {
			this.state.currentModel = modelName;
			this.renderChatArea();
		}
	}

	checkPeakHoursChange() {
		const peak = isPeakHours();
		if (peak !== this.wasPeakHours) {
			this.wasPeakHours = peak;
			this.renderChatArea();
			this.renderSidebar();
		}
	}

	checkQoLInstalled() {
		const hasQoL = document.documentElement.hasAttribute('data-claude-qol-installed');
		if (hasQoL) {
			const qolFooter = this.elements.sidebar?.container?.querySelector('.ut-qol-footer');
			if (qolFooter) {
				qolFooter.remove();
			}
		}
	}

	// ========== UPDATE LOOP ==========

	startUpdateLoop() {
		const update = async (timestamp) => {
			if (timestamp - this.lastUpdateTime >= this.updateInterval) {
				this.lastUpdateTime = timestamp;
				this.renderResetTimes();
				this.checkExpiredLimits();
				this.checkModelChange();
				this.checkPeakHoursChange();
				this.checkQoLInstalled();
				this.mountSidebar();
				this.mountChatArea();
			}
			requestAnimationFrame(update);
		};
		requestAnimationFrame(update);
	}
}

// Self-initialize
const usageUI = new UsageUI();