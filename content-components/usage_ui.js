/* global config, Log, ProgressBar, findSidebarContainers, sendBackgroundMessage,
   setupTooltip, getResetTimeHTML, waitForElement, sleep, isMobileView, UsageData,
   RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, VersionNotificationCard, SettingsCard */
'use strict';

// Usage section component for sidebar
class UsageSection {
	constructor() {
		this.isEnabled = true;
		this.buildSection();
	}

	buildSection() {
		this.container = document.createElement('div');
		this.container.className = 'ut-container';

		const topLine = document.createElement('div');
		topLine.className = 'text-text-000 ut-row text-sm ut-mb-1 ut-select-none';

		const nameContainer = document.createElement('div');
		nameContainer.className = 'ut-row';
		nameContainer.style.width = '35%';

		const title = document.createElement('span');
		title.className = 'text-xs';
		title.textContent = 'All:';

		this.percentageDisplay = document.createElement('span');
		this.percentageDisplay.className = 'text-xs';
		this.percentageDisplay.style.marginLeft = '6px';
		this.percentageDisplay.style.whiteSpace = 'nowrap';

		nameContainer.appendChild(title);
		nameContainer.appendChild(this.percentageDisplay);

		const statsContainer = document.createElement('div');
		statsContainer.className = 'text-text-400 ut-row ut-flex-grow text-xs';

		this.resetTimeDisplay = document.createElement('div');
		this.resetTimeDisplay.className = 'ut-w-full ut-text-right';
		this.resetTimeDisplay.style.whiteSpace = 'nowrap';
		this.resetTimeDisplay.textContent = 'Reset in: Not set';

		statsContainer.appendChild(this.resetTimeDisplay);
		topLine.appendChild(nameContainer);
		topLine.appendChild(statsContainer);

		this.progressBar = new ProgressBar();

		this.container.appendChild(topLine);
		this.container.appendChild(this.progressBar.container);
	}

	async updateFromUsageData(usageData) {
		if (!usageData) return;
		await this.updateProgress(usageData);
		this.updateResetTime(usageData);
	}

	async updateProgress(usageData) {
		const weightedTotal = usageData.getWeightedTotal();
		const usageCap = usageData.usageCap;
		const percentage = usageData.getUsagePercentage();

		this.progressBar.updateProgress(weightedTotal, usageCap);

		const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;
		this.percentageDisplay.textContent = `${percentage.toFixed(1)}%`;
		this.percentageDisplay.style.color = color;
	}

	updateResetTime(usageData) {
		const timeInfo = usageData.getResetTimeInfo();
		this.resetTimeDisplay.innerHTML = getResetTimeHTML(timeInfo);
	}
}

// Usage UI actor - owns sidebar and chat area usage displays
class UsageUI {
	constructor() {
		this.usageData = null;

		// Sidebar elements
		this.sidebarContainer = null;
		this.usageSection = null;

		// Chat area elements
		this.chatStatLine = null;
		this.chatUsageDisplay = null;
		this.chatProgressBar = null;
		this.chatUsageTooltip = null;

		this.uiReady = false;
		this.pendingUpdates = [];

		this.lastUpdateTime = 0;
		this.updateInterval = 1000; // Sidebar reset time countdown frequency

		this.setupMessageListener();
		this.init();
	}

	setupMessageListener() {
		browser.runtime.onMessage.addListener((message) => {
			if (message.type === 'updateUsage') {
				this.handleUsageUpdate(message.data.usageData);
			}
		});
	}

	async init() {
		await Log('UsageUI: Initializing...');

		// Wait for config to be available
		while (!config) {
			await sleep(100);
		}

		// Build the sidebar UI
		await this.buildSidebarUI();

		// Build the chat area UI
		this.buildChatUI();

		// Check for version notification (temporary - will move to FloatingCards in Phase 3)
		await this.checkVersionNotification();

		this.uiReady = true;
		await Log('UsageUI: Ready');

		// Process any updates that arrived before we were ready
		while (this.pendingUpdates.length > 0) {
			const usageDataJSON = this.pendingUpdates.shift();
			this.usageData = UsageData.fromJSON(usageDataJSON);
			this.updateAllDisplays();
		}

		// Start the update loop for reset time countdown
		this.startUpdateLoop();
	}

	async buildSidebarUI() {
		// Create main container
		this.sidebarContainer = document.createElement('div');
		this.sidebarContainer.className = 'flex flex-col mb-6';

		// Build header with settings button
		const header = this.buildHeader();
		this.sidebarContainer.appendChild(header);

		// Build content area
		const content = await this.buildContent();
		this.sidebarContainer.appendChild(content);

		// Find sidebar and inject
		const sidebarContainers = await findSidebarContainers();
		if (sidebarContainers) {
			const { container, starredSection } = sidebarContainers;
			container.insertBefore(this.sidebarContainer, starredSection);
		}
	}

	buildChatUI() {
		// Create the shared stat line container
		this.chatStatLine = document.createElement('div');
		this.chatStatLine.id = 'ut-chat-stat-line';
		this.chatStatLine.className = 'ut-row';

		// Left container for usage elements (owned by UsageUI)
		const leftContainer = document.createElement('div');
		leftContainer.id = 'ut-stat-left';
		leftContainer.className = 'ut-row ut-flex-1';

		// Usage display
		this.chatUsageDisplay = document.createElement('div');
		this.chatUsageDisplay.className = 'text-text-400 text-xs';
		this.chatUsageDisplay.style.whiteSpace = 'nowrap';
		if (!isMobileView()) this.chatUsageDisplay.style.marginRight = '8px';
		this.chatUsageDisplay.textContent = 'Quota:';

		leftContainer.appendChild(this.chatUsageDisplay);

		// Progress bar (desktop only)
		if (!isMobileView()) {
			this.chatProgressBar = new ProgressBar({ width: "100%" });
			this.chatProgressBar.container.classList.remove('bg-bg-500');
			this.chatProgressBar.container.classList.add('bg-bg-200');
			leftContainer.appendChild(this.chatProgressBar.container);
		}

		// Spacer
		const spacer = document.createElement('div');
		spacer.className = 'ut-flex-1';

		// Right container for LengthUI elements (will be populated in Phase 2)
		const rightContainer = document.createElement('div');
		rightContainer.id = 'ut-stat-right';
		rightContainer.className = 'ut-row';

		this.chatStatLine.appendChild(leftContainer);
		this.chatStatLine.appendChild(spacer);
		this.chatStatLine.appendChild(rightContainer);

		// Create tooltip for usage display
		this.chatUsageTooltip = document.createElement('div');
		this.chatUsageTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip font-normal font-ui';
		this.chatUsageTooltip.textContent = "How much of your quota you've used";
		this.chatUsageTooltip.style.maxWidth = '400px';
		this.chatUsageTooltip.style.textAlign = 'left';
		document.body.appendChild(this.chatUsageTooltip);
		setupTooltip(this.chatUsageDisplay, this.chatUsageTooltip);
	}

	buildHeader() {
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

		// Settings button click handler (will become event dispatch in Phase 3)
		settingsButton.addEventListener('click', async () => {
			if (SettingsCard.currentInstance) {
				SettingsCard.currentInstance.remove();
			} else {
				const buttonRect = settingsButton.getBoundingClientRect();
				const settingsCard = new SettingsCard();
				await settingsCard.build();
				settingsCard.show({
					top: buttonRect.top - 5,
					left: buttonRect.right + 5
				});
			}
		});

		header.appendChild(title);
		header.appendChild(settingsButton);
		return header;
	}

	async buildContent() {
		const content = document.createElement('div');
		content.className = 'flex min-h-0 flex-col pl-2';
		content.style.paddingRight = '0.25rem';

		// Container for usage section
		const sectionsContainer = document.createElement('ul');
		sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col px-1.5 gap-px';

		// Create usage section
		this.usageSection = new UsageSection();
		sectionsContainer.appendChild(this.usageSection.container);

		content.appendChild(sectionsContainer);

		// Add footer links if not in Electron
		const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
		if (!isElectron) {
			const desktopFooter = this.buildDesktopFooter();
			content.appendChild(desktopFooter);

			const qolFooter = this.buildQoLFooter();
			if (qolFooter) {
				content.appendChild(qolFooter);
			}
		}

		return content;
	}

	buildDesktopFooter() {
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

	buildQoLFooter() {
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

	async checkVersionNotification() {
		// Temporary - will move to FloatingCards actor in Phase 3
		const donationInfo = await sendBackgroundMessage({
			type: 'shouldShowDonationNotification',
			currentVersion: browser.runtime.getManifest().version
		});

		if (donationInfo && donationInfo.shouldShow) {
			const notificationCard = new VersionNotificationCard(donationInfo);
			notificationCard.show();
		}
	}

	handleUsageUpdate(usageDataJSON) {
		if (!this.uiReady) {
			Log('UsageUI: Not ready, queueing update');
			this.pendingUpdates.push(usageDataJSON);
			return;
		}

		this.usageData = UsageData.fromJSON(usageDataJSON);
		this.updateAllDisplays();
	}

	updateAllDisplays() {
		this.updateSidebarSection();
		this.updateChatUsageDisplay();
	}

	async updateSidebarSection() {
		if (!this.usageData || !this.usageSection) return;
		await this.usageSection.updateFromUsageData(this.usageData);
	}

	updateChatUsageDisplay() {
		if (!this.usageData) return;

		const percentage = this.usageData.getUsagePercentage();
		const color = this.usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;

		// Update usage label with percentage
		if (this.chatUsageDisplay) {
			this.chatUsageDisplay.innerHTML = `Quota: <span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
		}

		// Update progress bar (desktop only)
		if (!isMobileView() && this.chatProgressBar) {
			const weightedTotal = this.usageData.getWeightedTotal();
			const usageCap = this.usageData.usageCap;
			this.chatProgressBar.updateProgress(weightedTotal, usageCap);
		}
	}

	startUpdateLoop() {
		const update = async (timestamp) => {
			if (timestamp - this.lastUpdateTime >= this.updateInterval) {
				this.lastUpdateTime = timestamp;
				this.updateResetTimeDisplays();
				await this.checkAndReinject();
			}
			requestAnimationFrame(update);
		};
		requestAnimationFrame(update);
	}

	updateResetTimeDisplays() {
		// Update sidebar reset time only
		// Chat area reset time is handled by LengthUI (Phase 2)
		if (this.usageData && this.usageSection) {
			this.usageSection.updateResetTime(this.usageData);
		}
	}

	async checkAndReinject() {
		// Check sidebar
		const sidebarContainers = await findSidebarContainers();
		if (sidebarContainers && !sidebarContainers.container.contains(this.sidebarContainer)) {
			await Log('UsageUI: Re-injecting sidebar...');
			sidebarContainers.container.insertBefore(this.sidebarContainer, sidebarContainers.starredSection);
		}

		// Check chat area stat line
		await this.checkAndReinjectChatUI();
	}

	async checkAndReinjectChatUI() {
		const modelSelector = document.querySelector(config.SELECTORS.MODEL_SELECTOR);
		if (!modelSelector) return;

		const selectorLine = modelSelector?.parentElement?.parentElement;
		if (!selectorLine) return;

		if (selectorLine.nextElementSibling !== this.chatStatLine) {
			selectorLine.after(this.chatStatLine);
		}
	}
}

// Self-initialize
const usageUI = new UsageUI();
