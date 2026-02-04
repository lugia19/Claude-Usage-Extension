/* global CONFIG, Log, ProgressBar, findSidebarContainers, sendBackgroundMessage,
   setupTooltip, getResetTimeHTML, sleep, isMobileView, UsageData,
   RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, SELECTORS */
'use strict';

// Usage section with multiple limit bars
class UsageSection {
	constructor() {
		this.elements = this.createElement();
		this.limitBars = new Map(); // limitKey -> { row, percentage, resetTime, progressBar }
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
		const labels = {
			session: 'Session (5h):',
			weekly: 'Weekly:',
			sonnetWeekly: 'Sonnet Weekly:',
			opusWeekly: 'Opus Weekly:'
		};
		return labels[limitKey] || limitKey;
	}

	render(usageData) {
		if (!usageData) return;

		const activeLimits = usageData.getActiveLimits();
		const { barsContainer } = this.elements;

		// Track which limits we've seen this render
		const seenKeys = new Set();

		for (const limit of activeLimits) {
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
			const cap = CONFIG.ESTIMATED_CAPS?.[usageData.subscriptionTier]?.[limit.key];
			if (cap) {
				const used = Math.round((limit.percentage / 100) * cap);
				progressBar.tooltip.textContent = `${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${limit.percentage.toFixed(0)}%)`;
			} else {
				progressBar.tooltip.textContent = `${limit.percentage.toFixed(0)}% used`;
			}

			const color = limit.percentage >= CONFIG.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
			percentage.textContent = `${limit.percentage.toFixed(0)}%`;
			percentage.style.color = color;

			resetTime.innerHTML = this.formatResetTime(limit.resetsAt);
		}

		// Remove bars for limits no longer active
		for (const [key, barElements] of this.limitBars) {
			if (!seenKeys.has(key)) {
				barElements.row.remove();
				this.limitBars.delete(key);
			}
		}
	}

	formatResetTime(timestamp) {
		if (!timestamp) return '';
		const diff = timestamp - Date.now();
		if (diff <= 0) return `<span style="color: ${SUCCESS_GREEN}">Resetting...</span>`;

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

		if (hours >= 24) {
			const days = Math.floor(hours / 24);
			const remainingHours = hours % 24;
			return `⏱ ${days}d ${remainingHours}h`;
		}
		if (hours === 0) {
			return `⏱ ${minutes}m`;
		}
		return `⏱ ${hours}h ${minutes}m`;
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
			refreshedExpiredLimits: new Set(), // track which expired limits we've already requested a refresh for
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

		this.setupMessageListener();
		this.init();
	}

	// ========== SETUP ==========

	setupMessageListener() {
		browser.runtime.onMessage.addListener((message) => {
			if (message.type === 'updateUsage') {
				this.handleUsageUpdate(message.data.usageData);
			}
		});
	}

	async init() {
		await Log('UsageUI: Initializing...');

		while (!CONFIG) {
			await sleep(100);
		}

		this.usageSection = new UsageSection();
		this.elements.sidebar = await this.createSidebarElements();
		this.elements.chat = this.createChatElements();
		this.elements.tooltips = this.createTooltips();
		this.attachTooltips();

		await this.mountSidebar();

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
		container.className = 'flex flex-col mb-6';

		const header = this.createHeader();
		const content = document.createElement('div');
		content.className = 'flex min-h-0 flex-col pl-2';
		content.style.paddingRight = '0.25rem';

		const sectionsContainer = document.createElement('ul');
		sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col px-1.5 gap-px';
		sectionsContainer.appendChild(this.usageSection.elements.container);
		content.appendChild(sectionsContainer);

		// Add footers
		const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
		if (!isElectron) {
			const desktopFooter = this.createDesktopFooter();
			content.appendChild(desktopFooter);

			const qolFooter = this.createQoLFooter();
			if (qolFooter) {
				content.appendChild(qolFooter);
			}
		}

		container.appendChild(header);
		container.appendChild(content);

		return { container };
	}

	createHeader() {
		const header = document.createElement('div');
		header.className = 'ut-row ut-justify-between';

		const title = document.createElement('h3');
		title.textContent = 'Usage';
		title.className = 'text-text-500 pb-2 mt-1 text-xs select-none pl-2 pr-2';

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

		header.appendChild(title);
		header.appendChild(settingsButton);
		return header;
	}

	createDesktopFooter() {
		const footer = document.createElement('div');
		footer.className = 'ut-desktop-footer ut-sidebar-footer mt-1';

		const link = document.createElement('a');
		link.href = 'https://github.com/lugia19/claude-webext-patcher';
		link.target = '_blank';
		link.className = 'ut-link hover:text-text-200';
		link.style.color = BLUE_HIGHLIGHT;
		link.textContent = '💻 Desktop version available';

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
		link.textContent = '⚡ Check out the Claude QoL extension';

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
		leftContainer.className = 'ut-row ut-flex-1';

		const usageDisplay = document.createElement('div');
		usageDisplay.className = 'text-text-400 text-xs';
		usageDisplay.style.whiteSpace = 'nowrap';
		if (!isMobileView()) usageDisplay.style.marginRight = '8px';
		usageDisplay.textContent = 'Session:';

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

		// Reset time display
		const resetDisplay = document.createElement('div');
		resetDisplay.className = 'text-text-400 text-xs';
		if (!isMobileView()) resetDisplay.style.marginRight = '8px';

		rightContainer.appendChild(resetDisplay);

		statLine.appendChild(leftContainer);
		statLine.appendChild(spacer);
		statLine.appendChild(rightContainer);

		return { statLine, usageDisplay, progressBar, resetDisplay };
	}

	createTooltips() {
		const create = (text) => {
			const tooltip = document.createElement('div');
			tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip font-normal font-ui';
			tooltip.textContent = text;
			tooltip.style.maxWidth = '400px';
			tooltip.style.textAlign = 'left';
			document.body.appendChild(tooltip);
			return tooltip;
		};

		return {
			usage: create("How much of your 5-hour quota you've used"),
			timer: create('When your 5-hour usage will reset'),
		};
	}

	attachTooltips() {
		setupTooltip(this.elements.chat.usageDisplay, this.elements.tooltips.usage);
		setupTooltip(this.elements.chat.resetDisplay, this.elements.tooltips.timer);
	}

	// ========== MOUNT (attach to page) ==========

	async mountSidebar() {
		const sidebarContainers = await findSidebarContainers();
		if (!sidebarContainers) return false;

		const { container, starredSection } = sidebarContainers;
		if (!container.contains(this.elements.sidebar.container)) {
			container.insertBefore(this.elements.sidebar.container, starredSection);
		}
		return true;
	}

	mountChatArea() {
		const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
		if (!modelSelector) return false;

		const selectorLine = modelSelector?.parentElement?.parentElement;
		if (!selectorLine?.parentElement) return false;

		const parentContainer = selectorLine.parentElement;
		if (parentContainer.nextElementSibling !== this.elements.chat.statLine) {
			parentContainer.after(this.elements.chat.statLine);
		}
		return true;
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

	renderChatArea() {
		const { usageData } = this.state;
		const { usageDisplay, progressBar, resetDisplay } = this.elements.chat;

		if (!usageData) return;

		const session = usageData.limits.session;
		if (!session) return;

		// Session percentage
		const color = session.percentage >= CONFIG.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
		usageDisplay.innerHTML = `Session: <span style="color: ${color}">${session.percentage.toFixed(0)}%</span>`;

		// Progress bar (desktop only)
		if (!isMobileView() && progressBar) {
			progressBar.updateProgress(session.percentage, 100);

			// Override tooltip with estimated token values
			const cap = CONFIG.ESTIMATED_CAPS?.[usageData.subscriptionTier]?.session;
			if (cap) {
				const used = Math.round((session.percentage / 100) * cap);
				progressBar.tooltip.textContent = `${used.toLocaleString()} / ${cap.toLocaleString()} tokens (${session.percentage.toFixed(0)}%)`;
			} else {
				progressBar.tooltip.textContent = `${session.percentage.toFixed(0)}% used`;
			}

			// Add weekly marker (filter by current model)
			const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
			const modelName = modelSelector?.textContent?.trim() || null;
			const weeklyLimit = usageData.getBindingWeeklyLimit(modelName);
			if (weeklyLimit) {
				const markerLabels = { weekly: 'All Models (Weekly)', sonnetWeekly: 'Sonnet (Weekly)', opusWeekly: 'Opus (Weekly)' };
				const markerLabel = `${markerLabels[weeklyLimit.key] || 'Weekly'}: ${weeklyLimit.percentage.toFixed(0)}%`;
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

		// Chat area
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
		this.state.refreshedExpiredLimits.clear();
		this.renderAll();
	}

	// ========== CHECKS ==========

	checkExpiredLimits() {
		const { usageData } = this.state;
		if (!usageData) return;

		for (const limit of usageData.getActiveLimits()) {
			if (limit.resetsAt && limit.resetsAt <= Date.now() && !this.state.refreshedExpiredLimits.has(limit.key)) {
				this.state.refreshedExpiredLimits.add(limit.key);
				Log(`UsageUI: Limit "${limit.key}" expired, requesting fresh data`);
				sendBackgroundMessage({ type: 'requestData' });
				return; // one request is enough, it fetches all limits
			}
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
				this.checkQoLInstalled();
				await this.mountSidebar();
				this.mountChatArea();
			}
			requestAnimationFrame(update);
		};
		requestAnimationFrame(update);
	}
}

// Self-initialize
const usageUI = new UsageUI();