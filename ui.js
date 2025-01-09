(function () {
	'use strict';

	function debugLog(...args) {
		const sender = `content:${document.title.substring(0, 20)}${document.title.length > 20 ? '...' : ''}`;
		return browser.storage.local.get('debug_mode_until')
			.then(result => {
				const debugUntil = result.debug_mode_until;
				const now = Date.now();

				if (!debugUntil || debugUntil <= now) {
					return Promise.resolve();
				}
				console.log(...args);
				const timestamp = new Date().toLocaleString('default', {
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					hour12: false,
					fractionalSecondDigits: 3
				});
				const logEntry = {
					timestamp: timestamp,
					sender: sender,
					message: args.map(arg => {
						if (typeof arg === 'object') {
							return JSON.stringify(arg, null, 2);
						}
						return String(arg);
					}).join(' ')
				};

				return browser.storage.local.get('debug_logs')
					.then(result => {
						const logs = result.debug_logs || [];
						logs.push(logEntry);

						if (logs.length > 1000) logs.shift();

						return browser.storage.local.set({ debug_logs: logs });
					});
			});
	}

	if (window.claudeTrackerInstance) {
		debugLog('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	let config;
	let ui;

	//#region Storage Interface
	class TokenStorageInterface {
		async getPreviousVersion() {
			return await sendBackgroundMessage({ type: 'getPreviousVersion' });
		}

		async setCurrentVersion(version) {
			return await sendBackgroundMessage({
				type: 'setCurrentVersion',
				version
			});
		}

		async getCaps() {
			return await sendBackgroundMessage({ type: 'getCaps' });
		}
	}
	let storageInterface;
	//#endregion

	//State variables
	let currentlyDisplayedModel = 'default';
	let currentConversation = -1;
	let modelSections = {};
	let uiReady = false;
	const pendingUpdates = [];


	//#region Utils
	const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	async function sendBackgroundMessage(message) {
		const enrichedMessage = {
			...message,
			orgId: document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1]
		};
		let counter = 10;
		while (counter > 0) {
			try {
				const response = await browser.runtime.sendMessage(enrichedMessage);
				return response;
			} catch (error) {
				// Check if it's the specific "receiving end does not exist" error
				if (error.message?.includes('Receiving end does not exist')) {
					console.warn('Background script not ready, retrying...', error);
					await sleep(200);
				} else {
					// For any other error, throw immediately
					throw error;
				}
			}
			counter--;
		}
		throw new Error("Failed to send message to background script after 10 retries.");
	}

	async function waitForElement(target, selector, maxTime = 1000) {
		let elapsed = 0;
		const waitInterval = 100
		while (elapsed < maxTime) {
			const element = target.querySelector(selector);
			if (element) return element;
			await sleep(waitInterval);
			elapsed += waitInterval;
		}

		return null;
	}

	async function getCurrentModel() {
		const overrideSelector = await waitForElement(document, config.SELECTORS.MODEL_OVERRIDE, 1000);
		if (overrideSelector) {
			const overrideModel = overrideSelector.options[overrideSelector.selectedIndex].text
			let overrideModelName = overrideModel.toLowerCase();
			const modelTypes = Object.keys(config.MODEL_CAPS.pro).filter(key => key !== 'default');

			for (const modelType of modelTypes) {
				if (overrideModelName.includes(modelType.toLowerCase())) {
					return modelType;
				}
			}
		}
		const modelSelector = await waitForElement(document, config.SELECTORS.MODEL_PICKER, 3000);
		if (!modelSelector) return 'default';

		let fullModelName = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';
		if (!fullModelName || fullModelName === 'default') return 'default';

		fullModelName = fullModelName.toLowerCase();
		const modelTypes = Object.keys(config.MODEL_CAPS.pro).filter(key => key !== 'default');

		for (const modelType of modelTypes) {
			if (fullModelName.includes(modelType.toLowerCase())) {
				return modelType;
			}
		}
		debugLog("Could not find matching model, returning default")
		return 'default';
	}

	function isMobileView() {
		// First check if we're on a chat page
		if (!window.location.pathname.startsWith('/chat/')) {
			return false;
		}

		// Check if height > width (portrait orientation)
		return window.innerHeight > window.innerWidth;
	}
	//#endregion

	//#region UI elements
	function makeDraggable(element, dragHandle = null) {
		let isDragging = false;
		let currentX;
		let currentY;
		let initialX;
		let initialY;

		// If no specific drag handle is provided, the entire element is draggable
		const dragElement = dragHandle || element;

		function handleDragStart(e) {
			isDragging = true;

			if (e.type === "mousedown") {
				initialX = e.clientX - element.offsetLeft;
				initialY = e.clientY - element.offsetTop;
			} else if (e.type === "touchstart") {
				initialX = e.touches[0].clientX - element.offsetLeft;
				initialY = e.touches[0].clientY - element.offsetTop;
			}

			dragElement.style.cursor = 'grabbing';
		}

		function handleDragMove(e) {
			if (!isDragging) return;
			e.preventDefault();

			if (e.type === "mousemove") {
				currentX = e.clientX - initialX;
				currentY = e.clientY - initialY;
			} else if (e.type === "touchmove") {
				currentX = e.touches[0].clientX - initialX;
				currentY = e.touches[0].clientY - initialY;
			}

			// Ensure the element stays within the viewport
			const maxX = window.innerWidth - element.offsetWidth;
			const maxY = window.innerHeight - element.offsetHeight;
			currentX = Math.min(Math.max(0, currentX), maxX);
			currentY = Math.min(Math.max(0, currentY), maxY);

			element.style.left = `${currentX}px`;
			element.style.top = `${currentY}px`;
			element.style.right = 'auto';
			element.style.bottom = 'auto';
		}

		function handleDragEnd() {
			isDragging = false;
			dragElement.style.cursor = dragHandle ? 'move' : 'grab';
		}

		// Mouse events
		dragElement.addEventListener('mousedown', handleDragStart);
		document.addEventListener('mousemove', handleDragMove);
		document.addEventListener('mouseup', handleDragEnd);

		// Touch events
		dragElement.addEventListener('touchstart', handleDragStart, { passive: false });
		document.addEventListener('touchmove', handleDragMove, { passive: false });
		document.addEventListener('touchend', handleDragEnd);
		document.addEventListener('touchcancel', handleDragEnd);

		// Set initial cursor style
		dragElement.style.cursor = dragHandle ? 'move' : 'grab';

		// Return a cleanup function
		return () => {
			dragElement.removeEventListener('mousedown', handleDragStart);
			document.removeEventListener('mousemove', handleDragMove);
			document.removeEventListener('mouseup', handleDragEnd);
			dragElement.removeEventListener('touchstart', handleDragStart);
			document.removeEventListener('touchmove', handleDragMove);
			document.removeEventListener('touchend', handleDragEnd);
			document.removeEventListener('touchcancel', handleDragEnd);
		};
	}


	class ModelSection {
		constructor(modelName) {
			this.modelName = modelName;
			this.isEnabled = true;
			this.resetTime = null;
			this.buildSection();
		}

		buildSection() {
			// Create main container
			this.container = document.createElement('div');
			this.container.style.cssText = `
				margin-bottom: 12px;
				border-bottom: 1px solid #3B3B3B;
				padding-bottom: 8px;
				opacity: 1;
				transition: opacity 0.2s;
				position: relative;
			`;

			// Create header
			const sectionHeader = document.createElement('div');
			sectionHeader.style.cssText = `
				display: flex;
				align-items: center;
				gap: 8px;
				margin-bottom: 8px;
				color: white;
				font-size: 12px;
			`;

			// Create title
			const title = document.createElement('div');
			title.textContent = this.modelName;
			title.style.cssText = 'flex-grow: 1;';

			// Create active indicator
			this.activeIndicator = document.createElement('div');
			this.activeIndicator.style.cssText = `
				width: 8px;
				height: 8px;
				border-radius: 50%;
				background: #3b82f6;
				opacity: 1;
				transition: opacity 0.2s;
			`;

			// Assemble header
			sectionHeader.appendChild(title);
			sectionHeader.appendChild(this.activeIndicator);

			// Create content container
			this.content = document.createElement('div');

			// Create reset time display
			this.resetTimeDisplay = document.createElement('div');
			this.resetTimeDisplay.style.cssText = `
				color: #888;
				font-size: 11px;
				margin-bottom: 8px;
			`;
			this.resetTimeDisplay.textContent = 'Reset in: Not set.';

			// Create progress container and bar
			const progressContainer = document.createElement('div');
			progressContainer.style.cssText = `
				background: #3B3B3B;
				height: 6px;
				border-radius: 3px;
				overflow: hidden;
			`;

			this.progressBar = document.createElement('div');
			this.progressBar.style.cssText = `
				width: 0%;
				height: 100%;
				background: #3b82f6;
				transition: width 0.3s ease, background-color 0.3s ease;
			`;

			// Create tooltip
			this.tooltip = document.createElement('div');
			this.tooltip.style.cssText = `
				position: absolute;
				bottom: 100%;
				left: 50%;
				transform: translateX(-50%);
				background: rgba(0, 0, 0, 0.9);
				color: white;
				padding: 4px 8px;
				border-radius: 4px;
				font-size: 12px;
				opacity: 0;
				transition: opacity 0.2s;
				pointer-events: none;
				margin-bottom: 4px;
				white-space: nowrap;
				z-index: 9999;
			`;

			// Create message counter
			this.messageCounter = document.createElement('div');
			this.messageCounter.style.cssText = `
				color: #888;
				font-size: 11px;
				margin-top: 4px;
			`;
			this.messageCounter.textContent = 'Messages: 0';

			// Assemble content
			progressContainer.appendChild(this.progressBar);
			this.content.appendChild(this.messageCounter);
			this.content.appendChild(this.resetTimeDisplay);
			this.content.appendChild(progressContainer);
			this.content.appendChild(this.tooltip);

			// Assemble final container
			this.container.appendChild(sectionHeader);
			this.container.appendChild(this.content);

			// Add event listeners
			this.setupEventListeners();
		}

		setupEventListeners() {
			// Tooltip visibility
			this.container.addEventListener('mouseenter', () => {
				this.tooltip.style.opacity = '1';
			});
			this.container.addEventListener('mouseleave', () => {
				this.tooltip.style.opacity = '0';
			});
		}

		updateProgress(total, maxTokens) {
			const percentage = (total / maxTokens) * 100;
			this.progressBar.style.width = `${Math.min(percentage, 100)}%`;
			this.progressBar.style.background = total >= maxTokens * config.WARNING_THRESHOLD ? '#ef4444' : '#3b82f6';
			this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`;
		}

		updateMessageCount(count) {
			this.messageCounter.textContent = `Messages: ${count}`;
		}

		updateResetTime(timestamp) {
			this.resetTime = timestamp;
			this.resetTimeDisplay.textContent = timestamp ?
				formatTimeRemaining(new Date(timestamp)) :
				'Reset in: Not set';
		}

		setActive(active) {
			this.activeIndicator.style.opacity = active ? '1' : '0';
		}
	}

	async function checkVersionNotification() {
		const previousVersion = await storageInterface.getPreviousVersion();
		const currentVersion = browser.runtime.getManifest().version;
		// Skip if versions match
		if (previousVersion === currentVersion) return null;

		// Store current version
		await storageInterface.setCurrentVersion(currentVersion);

		return {
			previousVersion,
			currentVersion
		};
	}

	class FloatingCard {
		constructor(position) {
			this.element = document.createElement('div');
			this.position = position || { top: '20px', right: '20px' };
			this.setupBaseStyles();
		}

		setupBaseStyles() {
			// Start with basic styles that aren't position-related
			const baseStyles = `
				position: fixed;
				background: #2D2D2D;
				border: 1px solid #3B3B3B;
				border-radius: 8px;
				padding: 12px;
				color: white;
				font-size: 12px;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
				z-index: 10000;
				user-select: none;
			`;

			// Add position styles based on provided position object
			const positionStyles = Object.entries(this.position)
				.map(([key, value]) => `${key}: ${value};`)
				.join('\n');

			this.element.style.cssText = baseStyles + positionStyles;
		}

		addCloseButton() {
			const closeButton = document.createElement('button');
			closeButton.style.cssText = `
				position: absolute;
				top: 0px;
				right: 8px;
				background: none;
				border: none;
				color: #3b82f6;
				cursor: pointer;
				font-size: 14px;
				padding: 4px 8px;
			`;
			closeButton.textContent = '×';
			closeButton.addEventListener('click', () => this.remove());
			this.element.appendChild(closeButton);
		}

		show() {
			document.body.appendChild(this.element);
		}

		makeCardDraggable(dragHandle = null) {
			this.cleanup = makeDraggable(this.element, dragHandle);
		}

		remove() {
			if (this.cleanup) {
				this.cleanup();
			}
			this.element.remove();
		}
	}

	class VersionNotificationCard extends FloatingCard {
		constructor(versionInfo) {
			super();
			this.versionInfo = versionInfo;
			this.element.style.textAlign = 'center';
			this.element.style.maxWidth = '250px';
			this.build();
		}

		build() {
			// Create and style the header/drag handle
			const dragHandle = document.createElement('div');
			dragHandle.style.cssText = `
				padding: 8px;
				margin: -12px -12px 8px -12px;
				border-bottom: 1px solid #3B3B3B;
				cursor: move;
			`;
			dragHandle.textContent = 'Usage Tracker';

			// Add version message
			const message = document.createElement('div');
			message.style.marginBottom = '10px';
			message.textContent = this.versionInfo.previousVersion ?
				`Updated from v${this.versionInfo.previousVersion} to v${this.versionInfo.currentVersion}!` :
				`Welcome to the usage tracker! You're on v${this.versionInfo.currentVersion}`;


			let patchNotesLink = null;
			// Add patch notes link if applicable
			if (this.versionInfo.previousVersion) {
				patchNotesLink = document.createElement('a');
				patchNotesLink.href = 'https://github.com/lugia19/Claude-Usage-Extension/releases';
				patchNotesLink.target = '_blank';
				patchNotesLink.style.cssText = `
					color: #3b82f6;
					text-decoration: underline;
					cursor: pointer;
					display: block;
					margin-bottom: 10px;
					font-size: 12px;
				`;
				patchNotesLink.textContent = 'View patch notes';
				this.element.appendChild(patchNotesLink);
			}

			// Add Ko-fi button
			const kofiButton = document.createElement('a');
			kofiButton.href = 'https://ko-fi.com/R6R14IUBY';
			kofiButton.target = '_blank';
			kofiButton.style.cssText = `
				display: block;
				text-align: center;
				margin-top: 10px;
			`;

			const kofiImg = document.createElement('img');
			kofiImg.src = browser.runtime.getURL('kofi-button.png');
			kofiImg.height = 36;
			kofiImg.style.border = '0';
			kofiImg.alt = 'Buy Me a Coffee at ko-fi.com';

			kofiButton.appendChild(kofiImg);

			// Add elements to the card in the correct order
			this.element.appendChild(dragHandle);
			this.element.appendChild(message);
			if (this.versionInfo.previousVersion) {
				this.element.appendChild(patchNotesLink);
			}
			this.element.appendChild(kofiButton);
			this.addCloseButton();

			// Make the card draggable by the header
			this.makeCardDraggable(dragHandle);
		}
	}

	class SettingsCard extends FloatingCard {
		static currentInstance = null;

		constructor() {
			super({ bottom: '20px', left: '20px' });
			this.element.classList.add('settings-panel'); // Add the class for easier querying
			this.element.style.maxWidth = '275px';
		}

		async build() {
			const label = document.createElement('label');
			label.textContent = 'API Key (more accurate):';
			label.style.display = 'block';
			label.style.marginBottom = '8px';

			const input = document.createElement('input');
			input.type = 'password';
			input.style.cssText = `
				width: calc(100% - 12px);
				padding: 6px;
				margin-bottom: 12px;
				background: #3B3B3B;
				border: 1px solid #4B4B4B;
				border-radius: 4px;
				color: white;
			`;

			let apiKey = await sendBackgroundMessage({ type: 'getAPIKey' })
			if (apiKey) input.value = apiKey

			const saveButton = document.createElement('button');
			saveButton.textContent = 'Save';
			saveButton.style.cssText = `
				background: #3b82f6;
				border: none;
				border-radius: 4px;
				color: white;
				cursor: pointer;
				padding: 6px 12px;
			`;

			saveButton.addEventListener('click', async () => {
				let result = await sendBackgroundMessage({ type: 'setAPIKey', newKey: input.value })
				if (!result) {
					const errorMsg = document.createElement('div');
					errorMsg.style.cssText = `
						color: #ef4444;
						font-size: 14px;
					`;
					errorMsg.textContent = 'Invalid API key.';
					input.after(errorMsg);
					setTimeout(() => errorMsg.remove(), 3000);
					return;
				}

				location.reload();
			});

			this.element.appendChild(label);
			this.element.appendChild(input);
			this.element.appendChild(saveButton);
			this.addCloseButton();

			// Make the card draggable by the label area
			const dragHandle = document.createElement('div');
			dragHandle.style.cssText = `
				padding: 8px;
				margin: -12px -12px 8px -12px;
				border-bottom: 1px solid #3B3B3B;
				cursor: move;
			`;
			dragHandle.textContent = 'Settings';

			this.element.insertBefore(dragHandle, this.element.firstChild);
			this.makeCardDraggable(dragHandle);
		}

		show() {
			if (SettingsCard.currentInstance) {
				SettingsCard.currentInstance.remove();
			}
			super.show();
			SettingsCard.currentInstance = this;
		}

		remove() {
			super.remove();
			if (SettingsCard.currentInstance === this) {
				SettingsCard.currentInstance = null;
			}
		}

	}

	class MainUI {
		constructor() {
			this.container = null;
			this.currentlyDisplayedModel = 'default';
			this.currentConversation = -1;
			this.modelSections = {};
			this.uiReady = false;
			this.pendingUpdates = [];
		}

		async initialize() {
			this.container = document.createElement('div');
			this.container.style.cssText = `
				position: fixed;
				bottom: 20px;
				right: 20px;
				background: #2D2D2D;
				border: 1px solid #3B3B3B;
				border-radius: 8px;
				z-index: 9998;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
				user-select: none;
			`;
			await this.buildHeader();
			await this.buildContent();

			document.body.appendChild(this.container);

			// Make the container draggable using the header
			makeDraggable(this.container, this.header);

			// Check for version notification
			const versionInfo = await checkVersionNotification();
			debugLog("Version info", versionInfo);
			if (versionInfo) {
				const notificationCard = new VersionNotificationCard(versionInfo);
				notificationCard.show();
			}

			this.uiReady = true;
			// Process any updates that arrived before UI was ready
			while (this.pendingUpdates.length > 0) {
				debugLog("UI is ready, processing pending updates...");
				const update = this.pendingUpdates.shift();
				await this.updateProgressBar(update);
			}

			// Initialize model activity
			const isHomePage = getConversationId() === null;
			config.MODELS.forEach(modelName => {
				const section = this.modelSections[modelName];
				if (section) {
					const isActiveModel = modelName === this.currentlyDisplayedModel;
					section.setActive(isActiveModel);
				}
			});
		}

		async buildHeader() {
			this.header = document.createElement('div');
			this.header.style.cssText = `
				display: flex;
				align-items: center;
				padding: 8px 10px;
				color: white;
				font-size: 12px;
				gap: 8px;
				cursor: move;
			`;

			// Create estimate display for the header
			this.headerEstimateDisplay = document.createElement('div');
			this.headerEstimateDisplay.id = 'messages-left-estimate';
			this.headerEstimateDisplay.style.cssText = `
				flex-grow: 1;
				white-space: nowrap;
			`;
			this.headerEstimateDisplay.textContent = 'Est. messages left: Loading...';

			// Add settings button
			const settingsButton = document.createElement('button');
			settingsButton.innerHTML = `
				<svg viewBox="0 0 24 24" width="20" height="20" style="cursor: pointer;">
					<path fill="currentColor" d="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
				</svg>
			`;
			settingsButton.style.cssText = `
				margin-left: auto;
				display: flex;
				align-items: center;
				color: #3b82f6;
			`;
			settingsButton.addEventListener('click', async () => {
				if (SettingsCard.currentInstance) {
					SettingsCard.currentInstance.remove();
				} else {
					const settingsCard = new SettingsCard();
					await settingsCard.build();
					settingsCard.show();
				}
			});

			this.header.appendChild(this.headerEstimateDisplay);
			this.header.appendChild(settingsButton);
			this.container.appendChild(this.header);
		}

		async buildContent() {
			// Conversation info
			const currentConversationDisplay = document.createElement('div');
			currentConversationDisplay.style.cssText = `
				color: white;
				font-size: 12px;
				padding: 0 10px;
				margin-bottom: 8px;
				border-bottom: 1px solid #3B3B3B;
				padding-bottom: 8px;
			`;

			this.lengthDisplay = document.createElement('div');
			this.lengthDisplay.id = 'conversation-token-count';
			this.lengthDisplay.style.cssText = `
				color: #888;
				font-size: 11px;
				margin-top: 4px;
			`;
			this.lengthDisplay.textContent = 'Current cost: 0 tokens';

			currentConversationDisplay.appendChild(this.lengthDisplay);

			// Content container
			this.content = document.createElement('div');
			this.content.style.cssText = `
				padding: 0 10px 10px 10px;
			`;

			// Create sections for each model
			config.MODELS.forEach(model => {
				const section = new ModelSection(model);
				this.modelSections[model] = section;
				this.content.appendChild(section.container);
			});

			this.container.appendChild(currentConversationDisplay);
			this.container.appendChild(this.content);
		}

		async updateProgressBar(data) {
			debugLog("Got data", data);
			if (!this.uiReady) {
				debugLog("UI not ready, pushing to pending updates...");
				this.pendingUpdates.push(data);
				return;
			}

			const { conversationLength, modelData } = data;

			// Update conversation length display
			if (conversationLength) {
				this.lengthDisplay.textContent = `Current cost: ${conversationLength.toLocaleString()} tokens`;
			}

			// Update messages left estimate
			//Let's ensure the model is up to date...
			this.currentlyDisplayedModel = await getCurrentModel();

			// Get the token cap for current model, or use default if not found
			const modelCaps = await storageInterface.getCaps();
			const maxTokens = modelCaps[this.currentlyDisplayedModel] || modelCaps.default;

			// Get the total tokens used so far
			const currentModelData = modelData[this.currentlyDisplayedModel];
			const modelTotal = currentModelData?.total || 0;

			// Calculate how many tokens are left
			const remainingTokens = maxTokens - modelTotal;
			debugLog(`Calculating difference: ${maxTokens} - ${modelTotal} = ${remainingTokens}`);
			debugLog("Estimating messages...");

			let estimate;
			if (conversationLength > 0 && this.currentlyDisplayedModel != "default") {
				estimate = Math.max(0, remainingTokens / conversationLength);
				estimate = estimate.toFixed(1);
			} else {
				estimate = "N/A";
			}
			debugLog("Estimate", estimate);
			this.headerEstimateDisplay.textContent = `Est. messages left: ${estimate}`;

			// Update each model section
			debugLog("Updating model sections...");
			for (const [modelName, section] of Object.entries(this.modelSections)) {
				const modelInfo = modelData[modelName] || {};
				const modelTotal = modelInfo.total || 0;
				const messageCount = modelInfo.messageCount || 0;
				const maxTokens = modelCaps[modelName];

				section.updateProgress(modelTotal, maxTokens);
				section.updateMessageCount(messageCount);
				section.updateResetTime(modelInfo.resetTimestamp);
			}
		}
	}

	function formatTimeRemaining(resetTime) {
		const now = new Date();
		const diff = resetTime - now;

		if (diff <= 0) return 'Reset pending...';
		const hours = Math.floor(diff / (1000 * 60 * 60));
		const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

		return hours > 0 ? `Reset in: ${hours}h ${minutes}m` : `Reset in: ${minutes}m`;
	}

	// Listen for messages from background
	browser.runtime.onMessage.addListener(async (message) => {
		if (message.type === 'updateUsage') {
			await ui.updateProgressBar(message.data);
		}

		if (message.type === 'getActiveModel') {
			return await getCurrentModel();
		}

		if (message.action === "getOrgID") {
			const orgId = document.cookie
				.split('; ')
				.find(row => row.startsWith('lastActiveOrg='))
				?.split('=')[1];
			return Promise.resolve({ orgId });
		}
	});
	//#endregion

	//#region Event Handlers
	//This polls for model changes as well as running out of messages
	function pollForUIUpdates() {
		setInterval(async () => {
			let updateTriggered = false;
			const newModel = await getCurrentModel();
			const isHomePage = getConversationId() === null;
			const newConversation = getConversationId();

			// Check for message limit element
			const messageLimitElement = document.querySelector('a[href*="8325612-does-claude-pro-have-any-usage-limits"]');
			if (messageLimitElement) {
				const limitTextElement = messageLimitElement.closest('.text-text-400');
				if (limitTextElement && limitTextElement.textContent.includes('messages remaining')) {
					debugLog("We've reached the limit for the current model. Sending reset data to background for model", newModel);
					await sendBackgroundMessage({ type: 'resetHit', model: newModel });
				}
			}

			// Have we changed conversation?
			if (ui.currentConversation !== newConversation && !isHomePage) {
				debugLog(`Conversation changed from ${ui.currentConversation} to ${newConversation}`);
				await ui.updateProgressBar(await sendBackgroundMessage({ type: 'requestData', conversationId: newConversation }));
				ui.currentConversation = newConversation;
				updateTriggered = true;
			}

			//Have we changed model?
			if (newModel !== ui.currentlyDisplayedModel && !updateTriggered) {
				debugLog(`Model changed from ${ui.currentlyDisplayedModel} to ${newModel}`);
				await ui.updateProgressBar(await sendBackgroundMessage({ type: 'requestData', conversationId: newConversation }));
				updateTriggered = true;
			}

			ui.currentlyDisplayedModel = newModel;

			// Update all sections - will collapse inactive ones
			for (const [modelName, section] of Object.entries(ui.modelSections)) {
				const isActiveModel = modelName === ui.currentlyDisplayedModel;
				section.setActive(isActiveModel);
			}

			ui.currentConversation = newConversation;

			if (isHomePage) {
				// Reset conversation length display
				ui.headerEstimateDisplay.textContent = `Est. messages left: N/A`;
				ui.lengthDisplay.textContent = `Current cost: N/A tokens`;
			}
		}, config.UI_UPDATE_INTERVAL_MS);
	}

	//#endregion
	async function initialize() {
		const MAX_RETRIES = 15;
		const RETRY_DELAY = 200;
		const LOGIN_CHECK_DELAY = 10000;

		// Load and assign configuration to global variables
		debugLog("Calling browser message...")
		config = await sendBackgroundMessage({ type: 'getConfig' });
		debugLog("Config received...")
		debugLog(config)
		let userMenuButton = null;
		while (true) {
			// Check for duplicate running with retry logic

			let attempts = 0;

			while (!userMenuButton && attempts < MAX_RETRIES) {
				userMenuButton = document.querySelector(config.SELECTORS.USER_MENU_BUTTON);
				if (!userMenuButton) {
					debugLog(`User menu button not found, attempt ${attempts + 1}/${MAX_RETRIES}`);
					await sleep(RETRY_DELAY);
					attempts++;
				}
			}

			if (userMenuButton) {
				// Found the button, continue with initialization
				break;
			}

			// Check if we're on either login screen
			const initialLoginScreen = document.querySelector('button[data-testid="login-with-google"]');
			const verificationLoginScreen = document.querySelector('input[data-testid="code"]');

			if (!initialLoginScreen && !verificationLoginScreen) {
				console.error('Neither user menu button nor any login screen found');
				return;
			}

			debugLog('Login screen detected, waiting before retry...');
			await sleep(LOGIN_CHECK_DELAY);
		}



		if (userMenuButton.getAttribute('data-script-loaded')) {
			debugLog('Script already running, stopping duplicate');
			return;
		}
		userMenuButton.setAttribute('data-script-loaded', true);
		debugLog('We\'re unique, initializing Chat Token Counter...');

		storageInterface = new TokenStorageInterface();
		// Initialize everything else
		currentlyDisplayedModel = await getCurrentModel();

		ui = new MainUI();
		await ui.initialize();
		pollForUIUpdates();

		await ui.updateProgressBar(await sendBackgroundMessage({ type: 'requestData' }));
		await sendBackgroundMessage({ type: 'initOrg' });
		debugLog('Initialization complete. Ready to track tokens.');
	}

	(async () => {
		try {
			await initialize();
		} catch (error) {
			console.error('Failed to initialize Chat Token Counter:', error);
		}
	})();
})();
