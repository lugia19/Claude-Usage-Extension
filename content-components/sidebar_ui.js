/* global Log, waitForElement, sleep, config, RED_WARNING, BLUE_HIGHLIGHT, SUCCESS_GREEN, setupTooltip, NotificationCard, getResetTimeHTML, sendBackgroundMessage, VersionNotificationCard, SettingsCard */
'use strict';

// Helper function to find sidebar containers
async function findSidebarContainers() {
	// First find the nav element
	const sidebarNav = document.querySelector(config.SELECTORS.SIDEBAR_NAV);
	if (!sidebarNav) {
		await Log("error", 'Could not find sidebar nav');
		return null;
	}

	// Look for the main container that holds all sections
	const containerWrapper = sidebarNav.querySelector('.flex.flex-grow.flex-col.overflow-y-auto')
	const containers = containerWrapper.querySelectorAll('.transition-all.duration-200');
	const mainContainer = containers[containers.length - 1].querySelector('.px-2.mt-4');
	if (!mainContainer) {
		await Log("error", 'Could not find main container in sidebar');
		return null;
	}

	// Look for the Starred section
	const starredSection = await waitForElement(mainContainer, 'div.flex.flex-col.mb-4', 5000);
	if (!starredSection) {
		await Log("error", 'Could not find Starred section.');
	}

	// Check if the Recents section exists as the next sibling
	let recentsSection = null;
	if (starredSection) {
		recentsSection = starredSection.nextElementSibling;
	} else {
		recentsSection = mainContainer.firstChild;
	}

	if (!recentsSection) {
		await Log("error", 'Could not find any injection site');
		return null;
	}

	// Return the parent container so we can insert our UI between Starred and Recents
	return {
		container: mainContainer,
		starredSection: starredSection,
		recentsSection: recentsSection
	};
}

// Progress bar component
class ProgressBar {
	constructor(options = {}) {
		const {
			width = '100%',
			height = '6px'
		} = options;

		this.container = document.createElement('div');
		this.container.className = 'bg-bg-500 ut-progress';
		if (width !== '100%') this.container.style.width = width;
		if (height !== '6px') this.container.style.height = height;

		this.bar = document.createElement('div');
		this.bar.className = 'ut-progress-bar';
		this.bar.style.background = BLUE_HIGHLIGHT;

		this.tooltip = document.createElement('div');
		this.tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';

		this.container.appendChild(this.bar);
		document.body.appendChild(this.tooltip);
		setupTooltip(this.container, this.tooltip, { topOffset: 10 });
	}

	updateProgress(total, maxTokens) {
		const percentage = (total / maxTokens) * 100;
		this.bar.style.width = `${Math.min(percentage, 100)}%`;
		this.bar.style.background = total >= maxTokens * config.WARNING.PERCENT_THRESHOLD ? RED_WARNING : BLUE_HIGHLIGHT;
		this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} credits (${percentage.toFixed(1)}%)`;
	}
}

// Usage section component
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
		// Update progress
		await this.updateProgress(usageData);
		// Update reset time
		this.updateResetTime(usageData);
	}

	async updateProgress(usageData) {
		const weightedTotal = usageData.getWeightedTotal();
		const usageCap = usageData.usageCap;
		const percentage = usageData.getUsagePercentage();

		// Update progress bar
		this.progressBar.updateProgress(weightedTotal, usageCap);

		// Update percentage display
		const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;
		this.percentageDisplay.textContent = `${percentage.toFixed(1)}%`;
		this.percentageDisplay.style.color = color;
	}

	updateResetTime(usageData) {
		const timeInfo = usageData.getResetTimeInfo();
		this.resetTimeDisplay.innerHTML = getResetTimeHTML(timeInfo);
	}
}

// Main sidebar UI manager
class SidebarUI {
	constructor(ui) {
		this.container = null;
		this.usageSection = null;
		this.uiReady = false;
		this.parentUI = ui;
		this.pendingUpdates = [];
	}

	async initialize() {
		// Create container for the sidebar integration
		this.container = document.createElement('div');
		this.container.className = 'flex flex-col mb-6';

		this.header = await this.buildHeader();
		this.container.appendChild(this.header);
		this.content = await this.buildContent();
		this.container.appendChild(this.content);

		// Find the sidebar's containers
		const sidebarContainers = await findSidebarContainers();
		if (sidebarContainers) {
			const { container, starredSection, recentsSection } = sidebarContainers;

			// Insert our container between Starred and Recents
			container.insertBefore(this.container, starredSection);
		}

		this.uiReady = true;

		// Process any updates that arrived before UI was ready
		while (this.pendingUpdates.length > 0) {
			const update = this.pendingUpdates.shift();
			await this.updateProgressBars(update.usageData);
		}

		// Check for version notification
		const donationInfo = await sendBackgroundMessage({
			type: 'shouldShowDonationNotification',
			currentVersion: browser.runtime.getManifest().version
		});

		if (donationInfo && donationInfo.shouldShow) {
			const notificationCard = new VersionNotificationCard(donationInfo);
			notificationCard.show();
		}
	}

	async updateProgressBars(usageData) {
		if (!this.uiReady) {
			await Log("UI not ready, pushing to pending updates...");
			this.pendingUpdates.push({ usageData });
			return;
		}

		await Log("Updating usage section...");
		await this.usageSection.updateFromUsageData(usageData);
	}

	async buildHeader() {
		const header = document.createElement('div');
		header.className = 'ut-row ut-justify-between';

		const title = document.createElement('h3');
		title.textContent = 'Usage';
		title.className = 'text-text-500 pb-2 mt-1 text-xs select-none pl-2 pr-2';

		const settingsButton = document.createElement('button');
		settingsButton.className = 'ut-button ut-button-icon hover:bg-bg-400 hover:text-text-100';
		settingsButton.style.color = BLUE_HIGHLIGHT;
		settingsButton.style.padding = '0';  // Add this line to remove button padding
		settingsButton.style.width = '1rem';  // Add explicit width
		settingsButton.style.height = '1rem'; // Add explicit height
		settingsButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 24 24">
                <path d="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
            </svg>
        `;

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
		// Create our container div that matches the Starred/Recents sections style
		const content = document.createElement('div');
		content.className = 'flex min-h-0 flex-col pl-2';
		content.style.paddingRight = "0.25rem"

		// Container for usage section
		const sectionsContainer = document.createElement('ul');
		sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col px-1.5 gap-px';
		// Create single usage section
		this.usageSection = new UsageSection();
		sectionsContainer.appendChild(this.usageSection.container);

		content.appendChild(sectionsContainer);

		// Add desktop version footer if not in Electron
		const isElectron = await sendBackgroundMessage({ type: 'isElectron' });
		if (!isElectron) {
			const footer = this.buildDesktopFooter();
			content.appendChild(footer);

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
		// Check if Claude QoL extension is installed
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

	async updateProgress(usageData) {
		const weightedTotal = usageData.getWeightedTotal();
		const usageCap = usageData.usageCap;
		const percentage = usageData.getUsagePercentage();

		// Update progress bar
		this.progressBar.updateProgress(weightedTotal, usageCap);

		// Update percentage display
		const color = usageData.isNearLimit() ? RED_WARNING : BLUE_HIGHLIGHT;
		this.percentageDisplay.textContent = `${percentage.toFixed(1)}%`;
		this.percentageDisplay.style.color = color;
	}

	async checkAndReinject(sidebarContainers) {
		if (!sidebarContainers || !sidebarContainers.container.contains(this.container)) {
			if (sidebarContainers) {
				await Log('UI not present in sidebar, re-injecting...');
				this.uiReady = false;
				sidebarContainers.container.insertBefore(this.container, sidebarContainers.starredSection);
				this.uiReady = true;
			}
			return false;
		}
		return true;
	}
}