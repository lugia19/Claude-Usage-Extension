/* global CONFIG, Log, ProgressBar, findSidebarContainers, sendBackgroundMessage,
   setupTooltip, getResetTimeHTML, sleep, isMobileView, UsageData,
   RED_WARNING, BLUE_HIGHLIGHT */
'use strict';

// Progress bar component for usage section
class UsageSection {
	constructor() {
		this.elements = this.createElement();
	}

	createElement() {
		const container = document.createElement('div');
		container.className = 'ut-container';

		const topLine = document.createElement('div');
		topLine.className = 'text-text-000 ut-row text-sm ut-mb-1 ut-select-none';

		const nameContainer = document.createElement('div');
		nameContainer.className = 'ut-row';
		nameContainer.style.width = '35%';

		const title = document.createElement('span');
		title.className = 'text-xs';
		title.textContent = 'All:';

		const percentage = document.createElement('span');
		percentage.className = 'text-xs';
		percentage.style.marginLeft = '6px';
		percentage.style.whiteSpace = 'nowrap';

		nameContainer.appendChild(title);
		nameContainer.appendChild(percentage);

		const statsContainer = document.createElement('div');
		statsContainer.className = 'text-text-400 ut-row ut-flex-grow text-xs';

		const resetTime = document.createElement('div');
		resetTime.className = 'ut-w-full ut-text-right';
		resetTime.style.whiteSpace = 'nowrap';
		resetTime.textContent = 'Reset in: Not set';

		statsContainer.appendChild(resetTime);
		topLine.appendChild(nameContainer);
		topLine.appendChild(statsContainer);

		const progressBar = new ProgressBar();

		container.appendChild(topLine);
		container.appendChild(progressBar.container);

		return { container, percentage, resetTime, progressBar };
	}

	render(usageData) {
		if (!usageData) return;

		const { percentage, resetTime, progressBar } = this.elements;

		// Progress bar
		const weightedTotal = usageData.getWeightedTotal();
		const usageCap = usageData.usageCap;
		progressBar.updateProgress(weightedTotal, usageCap);

		// Percentage
		const pct = usageData.getUsagePercentage();
		const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;
		percentage.textContent = `${pct.toFixed(1)}%`;
		percentage.style.color = color;

		// Reset time
		const timeInfo = usageData.getResetTimeInfo();
		resetTime.innerHTML = getResetTimeHTML(timeInfo);
	}

	renderResetTime(usageData) {
		if (!usageData) return;
		const timeInfo = usageData.getResetTimeInfo();
		this.elements.resetTime.innerHTML = getResetTimeHTML(timeInfo);
	}
}

// Usage UI actor - owns sidebar and chat area usage displays
class UsageUI {
	constructor() {
		// State
		this.state = {
			usageData: null,
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
		const hasQoL = document.documentElement.hasAttribute('data-claude-qol-installed');
		if (hasQoL) return null;

		const footer = document.createElement('div');
		footer.className = 'ut-desktop-footer ut-sidebar-footer mt-1';

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

		// Left container (usage)
		const leftContainer = document.createElement('div');
		leftContainer.id = 'ut-stat-left';
		leftContainer.className = 'ut-row ut-flex-1';

		const usageDisplay = document.createElement('div');
		usageDisplay.className = 'text-text-400 text-xs';
		usageDisplay.style.whiteSpace = 'nowrap';
		if (!isMobileView()) usageDisplay.style.marginRight = '8px';
		usageDisplay.textContent = 'Quota:';

		leftContainer.appendChild(usageDisplay);

		// Progress bar (desktop only)
		let progressBar = null;
		if (!isMobileView()) {
			progressBar = new ProgressBar({ width: '100%' });
			progressBar.container.classList.remove('bg-bg-500');
			progressBar.container.classList.add('bg-bg-200');
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
			usage: create("How much of your quota you've used"),
			timer: create('When your usage will reset to full'),
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
		const modelSelector = document.querySelector(CONFIG.SELECTORS.MODEL_SELECTOR);
		if (!modelSelector) return false;

		const selectorLine = modelSelector?.parentElement?.parentElement;
		if (!selectorLine) return false;

		if (selectorLine.nextElementSibling !== this.elements.chat.statLine) {
			selectorLine.after(this.elements.chat.statLine);
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

		// Usage percentage
		const percentage = usageData.getUsagePercentage();
		const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;
		usageDisplay.innerHTML = `Quota: <span style="color: ${color}">${percentage.toFixed(1)}%</span>`;

		// Progress bar (desktop only)
		if (!isMobileView() && progressBar) {
			const weightedTotal = usageData.getWeightedTotal();
			const usageCap = usageData.usageCap;
			progressBar.updateProgress(weightedTotal, usageCap);
		}

		// Reset time
		const timeInfo = usageData.getResetTimeInfo();
		resetDisplay.innerHTML = getResetTimeHTML(timeInfo);
	}

	renderResetTimes() {
		const { usageData } = this.state;
		if (!usageData) return;

		// Sidebar
		this.usageSection.renderResetTime(usageData);

		// Chat area
		const timeInfo = usageData.getResetTimeInfo();
		this.elements.chat.resetDisplay.innerHTML = getResetTimeHTML(timeInfo);
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

	// ========== MISC ==========
	async checkDataExpiry() {
		const { usageData } = this.state;
		if (usageData && usageData.isExpired()) {
			await Log('UsageUI: Usage data expired, triggering reset');
			const orgId = document.cookie
				.split('; ')
				.find(row => row.startsWith('lastActiveOrg='))
				?.split('=')[1];
			if (orgId) {
				await sendBackgroundMessage({
					type: 'checkAndResetExpired',
					orgId: orgId
				});
			}
		}
	}

	// ========== UPDATE LOOP ==========

	startUpdateLoop() {
		const update = async (timestamp) => {
			if (timestamp - this.lastUpdateTime >= this.updateInterval) {
				this.lastUpdateTime = timestamp;
				this.renderResetTimes();
				await this.mountSidebar();
				this.mountChatArea();
				await this.checkDataExpiry();
			}
			requestAnimationFrame(update);
		};
		requestAnimationFrame(update);
	}
}

// Self-initialize
const usageUI = new UsageUI();