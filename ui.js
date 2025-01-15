(function () {
	'use strict';
	const BLUE_HIGHLIGHT = '#3b82f6';
	const RED_WARNING = "#ef4444";

	async function Log(...args) {
		const sender = `content:${document.title.substring(0, 20)}${document.title.length > 20 ? '...' : ''}`;
		let level = "debug";

		// If first argument is a valid log level, use it and remove it from args
		if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
			level = args.shift();
		}

		const result = await browser.storage.local.get('debug_mode_until');
		const debugUntil = result.debug_mode_until;
		const now = Date.now();

		if (!debugUntil || debugUntil <= now) {
			return;
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
			level: level,
			message: args.map(arg => {
				if (arg instanceof Error) {
					return arg.stack || `${arg.name}: ${arg.message}`;
				}
				if (typeof arg === 'object') {
					// Handle null case
					if (arg === null) return 'null';
					// For other objects, try to stringify with error handling
					try {
						return JSON.stringify(arg, Object.getOwnPropertyNames(arg), 2);
					} catch (e) {
						return String(arg);
					}
				}
				return String(arg);
			}).join(' ')
		};

		const logsResult = await browser.storage.local.get('debug_logs');
		const logs = logsResult.debug_logs || [];
		logs.push(logEntry);

		if (logs.length > 1000) logs.shift();

		await browser.storage.local.set({ debug_logs: logs });
	}

	if (window.claudeTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	let config;
	let ui;

	//State variables

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
					await Log("warn", 'Background script not ready, retrying...', error);
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

	async function getCurrentModel(maxWait = 3000) {
		const modelSelector = await waitForElement(document, config.SELECTORS.MODEL_PICKER, maxWait);
		if (!modelSelector) return undefined;

		let fullModelName = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';
		if (!fullModelName || fullModelName === 'default') return undefined;

		fullModelName = fullModelName.toLowerCase();
		const modelTypes = Object.keys(config.MODEL_CAPS.pro).filter(key => key !== 'default');

		for (const modelType of modelTypes) {
			if (fullModelName.includes(modelType.toLowerCase())) {
				return modelType;
			}
		}
		await Log("Could not find matching model, returning undefined")
		return undefined;
	}

	function isMobileView() {
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
			// Main container stays the same
			this.container = document.createElement('div');
			this.container.style.cssText = `
				margin-bottom: 8px;
				padding-bottom: 4px;
				opacity: 1;
				transition: opacity 0.2s;
				position: relative;
			`;

			// Top line with flexbox layout
			const topLine = document.createElement('div');
			topLine.style.cssText = `
				display: flex;
				align-items: center;
				color: white;
				font-size: 12px;
				margin-bottom: 4px;
				user-select: none;
			`;

			// Model name container with fixed width
			const nameContainer = document.createElement('div');
			nameContainer.style.cssText = `
				width: 20%;
				flex-shrink: 0;
			`;
			const title = document.createElement('div');
			title.textContent = this.modelName;
			nameContainer.appendChild(title);

			// Stats container for messages and reset time
			const statsContainer = document.createElement('div');
			statsContainer.style.cssText = `
				display: flex;
				gap: 12px;
				flex-grow: 1;
				color: #888;
				font-size: 11px;
			`;

			// Message counter
			this.messageCounter = document.createElement('div');
			this.messageCounter.style.width = '40%';
			this.messageCounter.textContent = 'Messages: 0';

			// Reset time display
			this.resetTimeDisplay = document.createElement('div');
			this.resetTimeDisplay.textContent = 'Reset in: Not set';

			// Active indicator
			this.activeIndicator = document.createElement('div');
			this.activeIndicator.style.cssText = `
				width: 8px;
				height: 8px;
				border-radius: 50%;
				background: #3b82f6;
				opacity: 1;
				transition: opacity 0.2s;
				margin-left: auto;
				flex-shrink: 0;
			`;

			// Assemble the top line
			statsContainer.appendChild(this.messageCounter);
			statsContainer.appendChild(this.resetTimeDisplay);

			topLine.appendChild(nameContainer);
			topLine.appendChild(statsContainer);
			topLine.appendChild(this.activeIndicator);

			// Create progress bar
			this.progressBar = new ProgressBar();

			// Assemble everything
			this.container.appendChild(topLine);
			this.container.appendChild(this.progressBar.container);
		}

		updateProgress(total, maxTokens) {
			this.progressBar.updateProgress(total, maxTokens);
		}

		updateMessageCount(count) {
			this.messageCounter.textContent = `Messages: ${count}`;
		}

		updateResetTime(timestamp) {
			this.resetTime = timestamp;
			this.resetTimeDisplay.textContent = timestamp ?
				`Reset in: ${formatTimeRemaining(timestamp).split(': ')[1]}` :
				'Reset in: Not Set';
		}

		setActive(active) {
			this.activeIndicator.style.opacity = active ? '1' : '0';
		}
	}

	async function checkVersionNotification() {
		const previousVersion = await sendBackgroundMessage({ type: 'getPreviousVersion' });
		const currentVersion = browser.runtime.getManifest().version;

		// Skip if versions match
		if (previousVersion === currentVersion) return null;
		// Store current version
		await sendBackgroundMessage({
			type: 'setCurrentVersion',
			version: currentVersion
		});

		return {
			previousVersion,
			currentVersion
		};
	}

	class FloatingCard {
		constructor() {
			this.defaultPosition = { top: '20px', right: '20px' }
			this.element = document.createElement('div');
			this.setupBaseStyles();
		}

		setupBaseStyles() {
			// Start with basic styles that aren't position-related
			this.element.style.cssText = `
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
		}

		addCloseButton() {
			const closeButton = document.createElement('button');
			closeButton.style.cssText = `
				position: absolute;
				top: 0px;
				right: 8px;
				background: none;
				border: none;
				color: ${BLUE_HIGHLIGHT};
				cursor: pointer;
				font-size: 14px;
				padding: 4px 8px;
			`;
			closeButton.textContent = '×';
			closeButton.addEventListener('click', () => this.remove());
			this.element.appendChild(closeButton);
		}

		show(position) {
			// If position is provided, use it instead of default
			if (position) {
				// Clear any previous position styles
				['top', 'right', 'bottom', 'left'].forEach(prop => {
					this.element.style[prop] = null;
				});
				// Apply new position
				Object.entries(position).forEach(([key, value]) => {
					this.element.style[key] = typeof value === 'number' ? `${value}px` : value;
				});
			} else {
				// Apply default position
				Object.entries(this.defaultPosition).forEach(([key, value]) => {
					this.element.style[key] = value;
				});
			}
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
					color: ${BLUE_HIGHLIGHT};
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
			super();
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
				background: ${BLUE_HIGHLIGHT};
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
						color: ${RED_WARNING};
						font-size: 14px;
					`;
					if (input.value.startsWith('sk-ant')) {
						errorMsg.textContent = 'Inactive API key. Have you ever loaded credits to the account?';
					} else {
						errorMsg.textContent = 'Invalid API key. Format looks wrong, it should start with sk-ant.';
					}

					input.after(errorMsg);
					setTimeout(() => errorMsg.remove(), 3000);
					return;
				}

				location.reload();
			});

			this.element.appendChild(label);
			this.element.appendChild(input);

			// Create a container for the buttons
			const buttonContainer = document.createElement('div');
			buttonContainer.style.cssText = `
				display: flex;
				gap: 8px;
				align-items: center;
			`;

			// Move the save button into the container
			buttonContainer.appendChild(saveButton);

			// Create and add debug button to container
			const debugButton = document.createElement('button');
			debugButton.textContent = 'Debug Logs';
			debugButton.style.cssText = `
				background: #3B3B3B;
				border: 1px solid #4B4B4B;
				border-radius: 4px;
				color: #888;
				cursor: pointer;
				padding: 6px 12px;
				font-size: 12px;
			`;

			debugButton.addEventListener('click', async () => {
				const result = await sendBackgroundMessage({
					type: 'openDebugPage'
				});

				if (result === 'fallback') {
					window.location.href = chrome.runtime.getURL('debug.html');
				}
			});

			buttonContainer.appendChild(debugButton);

			// Add the container instead of just the save button
			this.element.appendChild(buttonContainer);

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

		show(position) {
			if (SettingsCard.currentInstance) {
				SettingsCard.currentInstance.remove();
			}
			super.show(position);
			SettingsCard.currentInstance = this;
		}

		remove() {
			super.remove();
			if (SettingsCard.currentInstance === this) {
				SettingsCard.currentInstance = null;
			}
		}

	}

	class ProgressBar {
		constructor(options = {}) {
			const {
				width = '100%',
				backgroundColor = '#3B3B3B',
				height = '6px'
			} = options;

			this.container = document.createElement('div');
			this.container.style.cssText = `
				background: ${backgroundColor};
				height: ${height};
				border-radius: 3px;
				overflow: hidden;
				width: ${width};
				user-select: none;
			`;

			this.bar = document.createElement('div');
			this.bar.style.cssText = `
				width: 0%;
				height: 100%;
				background: #3b82f6;
				transition: width 0.3s ease, background-color 0.3s ease;
			`;

			this.tooltip = document.createElement('div');
			this.tooltip.style.cssText = `
				position: fixed;
				background: rgba(0, 0, 0, 0.9);
				color: white;
				padding: 4px 8px;
				border-radius: 4px;
				font-size: 12px;
				opacity: 0;
				transition: opacity 0.2s;
				pointer-events: none;
				white-space: nowrap;
				z-index: 9999;
				user-select: none;
			`;

			this.container.appendChild(this.bar);
			document.body.appendChild(this.tooltip);

			this.setupEventListeners();
		}

		setupEventListeners() {
			this.container.addEventListener('mouseenter', () => {
				const rect = this.container.getBoundingClientRect();
				this.tooltip.style.left = `${rect.left + (rect.width / 2)}px`;
				this.tooltip.style.top = `${rect.top - 30}px`;
				this.tooltip.style.transform = 'translateX(-50%)';
				this.tooltip.style.opacity = '1';
			});

			this.container.addEventListener('mouseleave', () => {
				this.tooltip.style.opacity = '0';
			});
		}

		updateProgress(total, maxTokens) {
			const percentage = (total / maxTokens) * 100;
			this.bar.style.width = `${Math.min(percentage, 100)}%`;
			this.bar.style.background = total >= maxTokens * config.WARNING_THRESHOLD ? '#ef4444' : '#3b82f6';
			this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`;
		}
	}


	async function findSidebarContainer() {
		// First find the nav element with the specific data-testid
		const sidebarNav = document.querySelector('nav[data-testid="menu-sidebar"]');
		if (!sidebarNav) {
			await Log("error", 'Could not find sidebar nav');
			return null;
		}

		// Then find the scrollable container within it
		const container = sidebarNav.querySelector('.overflow-y-auto.overflow-x-hidden.flex.flex-col.gap-4');
		if (!container) {
			await Log("error", 'Could not find sidebar container within nav');
			return null;
		}

		return container;
	}

	class UIManager {
		constructor(currModel) {
			this.currentlyDisplayedModel = currModel;
			this.sidebarUI = new SidebarUI(this);
			this.chatUI = new ChatUI();
			this.currentConversation = -1;
			this.conversationLength = null;
		}

		async initialize() {
			await this.sidebarUI.initialize();
			this.chatUI.initialize();

			// Initial update
			await this.updateUI(await sendBackgroundMessage({ type: 'requestData' }));
			await sendBackgroundMessage({ type: 'initOrg' });

			// Start animation frame loop
			this.lastFullUpdate = 0;
			this.lastMediumUpdate = 0;
			this.lastHighUpdate = 0;
			this.highUpdateFrequency = Math.round(config.UI_UPDATE_INTERVAL_MS / 4);	//750
			this.mediumUpdateFrequency = Math.round(config.UI_UPDATE_INTERVAL_MS / 2);	//1500
			this.fullUpdateFrequency = config.UI_UPDATE_INTERVAL_MS;	//3000
			this.scheduleNextFrame();
		}

		scheduleNextFrame() {
			requestAnimationFrame((timestamp) => this.frameUpdate(timestamp));
		}

		async frameUpdate(timestamp) {
			if (!this.lastHighUpdate || timestamp - this.lastHighUpdate >= this.highUpdateFrequency) {
				await this.highFrequencyUpdates();
				this.lastHighUpdate = timestamp;
			}

			if (!this.lastMediumUpdate || timestamp - this.lastMediumUpdate >= this.mediumUpdateFrequency) {
				await this.mediumFrequencyUpdates();
				this.lastMediumUpdate = timestamp;
			}

			if (!this.lastFullUpdate || timestamp - this.lastFullUpdate >= this.fullUpdateFrequency) {
				await this.lowFrequencyUpdates();
				this.lastFullUpdate = timestamp;
			}

			this.scheduleNextFrame();
		}

		async highFrequencyUpdates() {
			const currConversation = getConversationId();
			const newModel = await getCurrentModel(200);
			if (newModel !== this.currentlyDisplayedModel) {
				await this.updateUI(await sendBackgroundMessage({ type: 'requestData', conversationId: currConversation }));
				this.currentlyDisplayedModel = newModel;
			}

			//UI presence checks
			const sidebarContainer = await findSidebarContainer();
			await this.sidebarUI.checkAndReinject(sidebarContainer);
			await this.chatUI.checkAndReinject();

			this.sidebarUI.updateModelStates(this.currentlyDisplayedModel);
		}

		async mediumFrequencyUpdates() {
			// Check for conversation changes
			const newConversation = getConversationId();
			const isHomePage = newConversation === null;

			if (this.currentConversation !== newConversation && !isHomePage) {
				await this.updateUI(await sendBackgroundMessage({
					type: 'requestData',
					conversationId: newConversation
				}));
				this.currentConversation = newConversation;
			}

			// Update home page state if needed
			if (isHomePage && this.conversationLength !== null) {
				this.conversationLength = null;
				this.chatUI.updateEstimate(null, null, null, null, true);
			}
		}

		async lowFrequencyUpdates() {
			// Check for message limits
			const messageLimitElement = document.querySelector('a[href*="does-claude-pro-have-any-usage-limits"]');
			if (messageLimitElement) {
				const limitTextElement = messageLimitElement.closest('.text-text-400');
				if (limitTextElement) {
					await sendBackgroundMessage({
						type: 'resetHit',
						model: this.currentlyDisplayedModel
					});
				}
			}
			this.chatUI.updateResetTimeDisplay();
		}

		async updateUI(data) {
			await Log("Updating UI with data", data);
			if (!data) return;
			const { conversationLength, modelData } = data;

			if (conversationLength) this.conversationLength = conversationLength;

			// Update current model
			this.currentlyDisplayedModel = await getCurrentModel() || this.currentlyDisplayedModel

			// Get the token cap for current model
			const modelCaps = await sendBackgroundMessage({ type: 'getCaps' });

			// Update both UIs
			await this.sidebarUI.updateProgressBars(data, this.currentlyDisplayedModel, modelCaps);
			this.chatUI.updateChatUI(data, this.currentlyDisplayedModel, modelCaps);
		}

	}

	class ChatUI {
		constructor() {
			this.lengthDisplay = null;
			this.estimateDisplay = null;
			this.resetDisplay = null;
			this.statLine = null;
			this.progressBar = null;
			this.lastResetTimestamp = null;
		}

		initialize() {
			this.lengthDisplay = document.createElement('div');
			this.lengthDisplay.className = 'text-text-500 text-xs';
			this.lengthDisplay.style.cssText = "margin-top: 2px; font-size: 11px;";

			// Create container for estimate and reset time
			this.statLine = document.createElement('div');
			this.statLine.className = 'flex items-center min-w-0 max-w-full';
			this.statLine.style.userSelect = 'none'; // Make the whole line unselectable by default

			// Add label for progress bar if not on mobile
			if (!isMobileView()) {
				const usageLabel = document.createElement('div');
				usageLabel.className = 'text-text-400 text-xs mr-2';
				usageLabel.textContent = 'Quota:';
				usageLabel.style.userSelect = 'none';
				this.statLine.appendChild(usageLabel);
			}

			// Create progress bar
			this.progressBar = new ProgressBar({
				backgroundColor: '#2D2D2D',  // Slightly darker background
				width: "25%",
			});
			this.progressBar.container.style.marginRight = '12px';
			this.statLine.appendChild(this.progressBar.container);

			// Add spacer
			const spacer = document.createElement('div');
			spacer.className = 'flex-1';
			spacer.style.userSelect = 'none';
			this.statLine.appendChild(spacer);

			// Create estimate display
			this.estimateDisplay = document.createElement('div');
			this.estimateDisplay.className = 'text-text-400 text-xs mr-2';
			this.estimateDisplay.style.userSelect = 'text';  // Make text selectable
			this.statLine.appendChild(this.estimateDisplay);

			// Create reset display
			this.resetDisplay = document.createElement('div');
			this.resetDisplay.className = 'text-text-400 text-xs mr-2';
			this.resetDisplay.style.userSelect = 'text';  // Make text selectable
			this.statLine.appendChild(this.resetDisplay);
		}

		async checkAndReinject() {
			// Handle length display injection
			const chatMenu = document.querySelector('[data-testid="chat-menu-trigger"]');
			if (chatMenu) {
				const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
				if (titleLine) {
					titleLine.classList.remove('md:flex-row');
					titleLine.classList.add('md:flex-col');

					if (chatMenu.parentElement.nextElementSibling !== this.lengthDisplay) {
						chatMenu.parentElement.after(this.lengthDisplay);
					}
				}
			}

			// Handle stat line injection
			const modelSelector = document.querySelector('[data-testid="model-selector-dropdown"]');
			if (!modelSelector) return;
			// Handle stat line injection
			const selectorLine = modelSelector.closest('.min-w-0.flex-1.flex')?.parentElement?.parentElement;
			if (!selectorLine) return;
			if (selectorLine && selectorLine.nextElementSibling !== this.statLine) {
				selectorLine.after(this.statLine);
			}
		}

		updateChatUI(data, currentModel, modelCaps) {
			if (data.conversationLength) this.updateLength(data.conversationLength);
			this.updateProgressBar(data.modelData, currentModel, modelCaps);
			if (data.conversationLength) this.updateEstimate(data.modelData, currentModel, modelCaps, data.conversationLength, false);
			this.updateResetTime(data.modelData, currentModel);
		}

		updateProgressBar(modelData, currentModel, modelCaps) {
			if (!this.progressBar) return;

			const maxTokens = modelCaps[currentModel] || modelCaps.default;
			const currentModelData = modelData[currentModel];
			const modelTotal = currentModelData?.total || 0;

			this.progressBar.updateProgress(modelTotal, maxTokens);
		}

		updateLength(length) {
			if (this.lengthDisplay) {
				this.lengthDisplay.textContent = length ?
					`Current cost: ${length.toLocaleString()} tokens` :
					'Current cost: N/A tokens';
			}
		}

		updateEstimate(modelData, currentModel, modelCaps, conversationLength, overrideNone) {
			if (!this.estimateDisplay) return;
			if (overrideNone) {
				this.estimateDisplay.innerHTML = `Est. messages left: <span>N/A</span>`;
				return
			}
			const maxTokens = modelCaps[currentModel] || modelCaps.default;
			const currentModelData = modelData[currentModel];
			const modelTotal = currentModelData?.total || 0;
			const remainingTokens = maxTokens - modelTotal;

			let estimate;
			if (conversationLength > 0 && currentModel) {
				estimate = Math.max(0, remainingTokens / conversationLength);
				estimate = estimate.toFixed(1);
			} else {
				estimate = "N/A";
			}

			this.estimateDisplay.innerHTML = `Est. messages left: <span style="color: ${BLUE_HIGHLIGHT}">${estimate}</span>`;
		}

		updateResetTime(modelData, currentModel) {
			if (!this.resetDisplay) return;

			const currentModelInfo = modelData[currentModel];
			this.lastResetTimestamp = currentModelInfo?.resetTimestamp || null;
			this.updateResetTimeDisplay();
		}

		updateResetTimeDisplay() {
			if (!this.resetDisplay) return;

			if (!this.lastResetTimestamp) {
				this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">Not set</span>`;
				return;
			}

			const now = Date.now();
			const diff = this.lastResetTimestamp - now;

			if (diff <= 0) {
				this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">pending...</span>`;
			} else {
				const hours = Math.floor(diff / (1000 * 60 * 60));
				const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
				const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
				this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${timeStr}</span>`;
			}
		}
	}

	class SidebarUI {
		constructor(ui) {
			this.container = null;
			this.modelSections = {};
			this.uiReady = false;
			this.parentUI = ui;
			this.pendingUpdates = [];
		}

		async initialize() {
			// Create container for the sidebar integration
			this.container = document.createElement('div');
			this.container.className = 'flex flex-col min-h-0';
			this.container.style.cssText = `opacity: 1; filter: blur(0px); transform: translateX(0%) translateZ(0px);`

			this.header = await this.buildHeader();
			this.container.appendChild(this.header);
			this.content = await this.buildContent();
			this.container.appendChild(this.content);

			// Find the sidebar's scrollable container and inject at the end
			const sidebarContainer = await findSidebarContainer();
			if (sidebarContainer) {
				sidebarContainer.appendChild(this.container);
			}

			this.uiReady = true;

			// Process any updates that arrived before UI was ready
			while (this.pendingUpdates.length > 0) {
				const update = this.pendingUpdates.shift();
				await this.updateProgressBars(update);
			}

			// Initialize model section visibility
			const isHomePage = getConversationId() === null;
			config.MODELS.forEach(modelName => {
				const section = this.modelSections[modelName];
				if (section) {
					const isActiveModel = modelName === this.parentUI.currentlyDisplayedModel;
					section.setActive(isActiveModel);
				}
			});

			// Check for version notification
			const versionInfo = await checkVersionNotification();
			if (versionInfo) {
				const notificationCard = new VersionNotificationCard(versionInfo);
				notificationCard.show();
			}
		}

		async buildHeader() {
			const header = document.createElement('div');
			header.className = 'text-text-300 mb-1 flex';

			// Create title
			const title = document.createElement('span');
			title.textContent = 'Usage Tracker';
			title.className = 'text-text-300 mb-1 flex items-center gap-1.5 text-sm font-medium';
			title.style.cssText = `
				left: 0px
			`
			// Add settings button
			const settingsButton = document.createElement('button');
			settingsButton.innerHTML = `
				<svg viewBox="0 0 24 24" width="16" height="16" style="cursor: pointer;">
					<path fill="currentColor" d="M19.43 12.98c.04-.32.07-.64.07-.98 0-.34-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98 0 .33.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
				</svg>
			`;
			settingsButton.style.cssText = `
				margin-left: auto;
				display: flex;
				align-items: center;
				color: ${BLUE_HIGHLIGHT};
			`;
			settingsButton.className = "settings-button"
			settingsButton.addEventListener('click', async () => {
				if (SettingsCard.currentInstance) {
					SettingsCard.currentInstance.remove();
				} else {
					const buttonRect = settingsButton.getBoundingClientRect();
					const settingsCard = new SettingsCard();
					await settingsCard.build();
					settingsCard.show({
						top: buttonRect.bottom + 5,
						left: buttonRect.left
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
			content.className = 'flex min-h-0 flex-col min-h-min';
			content.style.cssText = 'opacity: 1; filter: blur(0px); transform: translateX(0%) translateZ(0px);';

			// Container for model sections
			const sectionsContainer = document.createElement('div');
			sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col gap-0.5 overflow-y-auto px-1.5';

			// Create model sections
			config.MODELS.forEach(model => {
				const section = new ModelSection(model);
				this.modelSections[model] = section;
				sectionsContainer.appendChild(section.container);
			});

			content.appendChild(sectionsContainer);

			return content;
		}

		async updateProgressBars(data, currentlyDisplayedModel, modelCaps) {
			if (!this.uiReady) {
				await Log("UI not ready, pushing to pending updates...");
				this.pendingUpdates.push(data);
				return;
			}

			const { modelData } = data;

			// Update each model section
			await Log("Updating model sections...");
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

		async checkAndReinject(sidebarContainer) {
			if (!sidebarContainer || !sidebarContainer.contains(this.container)) {
				if (sidebarContainer) {
					await Log('UI not present in sidebar, re-injecting...');
					this.uiReady = false;
					sidebarContainer.appendChild(this.container);
					this.uiReady = true;
				}
				return false;
			}
			return true;
		}

		updateModelStates(currentlyDisplayedModel) {
			for (const [modelName, section] of Object.entries(this.modelSections)) {
				const isActiveModel = modelName === currentlyDisplayedModel;
				section.setActive(isActiveModel);
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
	//#endregion

	//#region Event Handlers
	// Listen for messages from background
	browser.runtime.onMessage.addListener(async (message) => {
		if (message.type === 'updateUsage') {
			if (ui) await ui.updateUI(message.data);
		}

		if (message.type === 'getActiveModel') {
			const currModel = await getCurrentModel();
			if (!currModel && ui) return ui.currentlyDisplayedModel;
			return currModel || "Sonnet";
		}

		if (message.action === "getOrgID") {
			const orgId = document.cookie
				.split('; ')
				.find(row => row.startsWith('lastActiveOrg='))
				?.split('=')[1];
			return Promise.resolve({ orgId });
		}

		if (message.action === "getStyleId") {
			const storedStyle = localStorage.getItem('LSS-claude_personalized_style');
			let styleId;

			if (storedStyle) {
				try {
					const styleData = JSON.parse(storedStyle);
					styleId = styleData.styleKey;
				} catch (e) {
					// If JSON parsing fails, we'll return undefined
					await Log("error", 'Failed to parse stored style:', e);
				}
			}

			return Promise.resolve({ styleId });
		}
	});

	// Monkeypatch fetching if required
	async function initializeFetch() {
		const patterns = await browser.runtime.sendMessage({
			type: 'needsMonkeypatching'
		});

		if (!patterns) return;

		const originalFetch = window.fetch;
		window.fetch = async function (resource, options) {
			const url = resource instanceof Request ? resource.url : resource;

			const details = {
				url: url,
				method: options?.method || 'GET',
				requestBody: options?.body ? { raw: [{ bytes: options.body }] } : null
			};

			if (patterns.onBeforeRequest.urls.some(pattern => url.includes(pattern))) {
				browser.runtime.sendMessage({
					type: 'interceptedRequest',
					details: details
				});
			}

			const response = await originalFetch(resource, options);

			if (patterns.onCompleted.urls.some(pattern => url.includes(pattern))) {
				browser.runtime.sendMessage({
					type: 'interceptedResponse',
					details: {
						...details,
						status: response.status,
						statusText: response.statusText
					}
				});
			}

			return response;
		};
	}
	//#endregion

	async function initialize() {
		const MAX_RETRIES = 15;
		const RETRY_DELAY = 200;
		const LOGIN_CHECK_DELAY = 10000;

		// Load and assign configuration to global variables
		await Log("Calling browser message...")
		let timeLeft = 5000; // 5 seconds in ms, how long to retry getting the config
		while (timeLeft > 0) {
			config = await sendBackgroundMessage({ type: 'getConfig' });
			if (config) break;
			await sleep(100);
			timeLeft -= 100;
		}
		await Log("Config received...")
		await Log(config)
		let userMenuButton = null;
		while (true) {
			// Check for duplicate running with retry logic

			let attempts = 0;

			while (!userMenuButton && attempts < MAX_RETRIES) {
				userMenuButton = document.querySelector(config.SELECTORS.USER_MENU_BUTTON);
				if (!userMenuButton) {
					await Log(`User menu button not found, attempt ${attempts + 1}/${MAX_RETRIES}`);
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
				await Log("error", 'Neither user menu button nor any login screen found');
				return;
			}

			await Log('Login screen detected, waiting before retry...');
			await sleep(LOGIN_CHECK_DELAY);
		}

		if (userMenuButton.getAttribute('data-script-loaded')) {
			await Log('Script already running, stopping duplicate');
			return;
		}
		userMenuButton.setAttribute('data-script-loaded', true);
		await Log('We\'re unique, initializing Chat Token Counter...');
		await Log("Initializing fetch...")
		await initializeFetch();

		ui = new UIManager(await getCurrentModel());
		await ui.initialize();

		await ui.updateUI(await sendBackgroundMessage({ type: 'requestData' }));
		await sendBackgroundMessage({ type: 'initOrg' });
		await Log('Initialization complete. Ready to track tokens.');
	}

	(async () => {
		try {
			await initialize();
		} catch (error) {
			await Log("error", 'Failed to initialize Chat Token Counter:', error);
		}
	})();
})();
