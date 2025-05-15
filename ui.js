(function () {
	'use strict';
	const BLUE_HIGHLIGHT = '#3b82f6';
	const RED_WARNING = "#ef4444";
	const FORCE_DEBUG = false;

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

		if ((!debugUntil || debugUntil <= now) && !FORCE_DEBUG) {
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

	async function logError(error) {
		// If object is not an error, log it as a string
		if (!(error instanceof Error)) {
			await Log("error", JSON.stringify(error));
			return
		}

		await Log("error", error.toString());
		if ("captureStackTrace" in Error) {
			Error.captureStackTrace(error, getStack);
		}
		await Log("error", JSON.stringify(error.stack));
	}

	//Error logging
	window.addEventListener('error', async function (event) {
		await logError(event.error);
	});

	window.addEventListener('unhandledrejection', async function (event) {
		await logError(event.reason);
	});

	self.onerror = async function (message, source, lineno, colno, error) {
		await logError(error);
		return false;
	};

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
		const modelTypes = config.MODELS

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

			// Model name container - fixed percentage width
			const nameContainer = document.createElement('div');
			nameContainer.style.cssText = `
				width: 35%;
				display: flex;
				align-items: center;
			`;

			// Create model name
			const title = document.createElement('span');
			title.textContent = `${this.modelName}:`;

			// Create percentage display next to model name
			this.percentageDisplay = document.createElement('span');
			this.percentageDisplay.style.cssText = `
				margin-left: 6px;
				font-size: 11px;
				white-space: nowrap;
			`;

			// Add both to the name container
			nameContainer.appendChild(title);
			nameContainer.appendChild(this.percentageDisplay);

			// Stats container with fixed column widths for alignment
			const statsContainer = document.createElement('div');
			statsContainer.style.cssText = `
				display: flex;
				flex-grow: 1;
				align-items: center;
				color: #888;
				font-size: 11px;
			`;

			// Message counter - fixed width column for alignment
			this.messageCounter = document.createElement('div');
			this.messageCounter.style.cssText = `
				width: 35%;
				text-align: left;
				white-space: nowrap;
			`;
			this.messageCounter.textContent = 'Msgs: 0';

			// Reset time display
			this.resetTimeDisplay = document.createElement('div');
			this.resetTimeDisplay.style.cssText = `
				width: 30%;
				text-align: left;
				white-space: nowrap;
			`;
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
				margin-left: 2%;
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

		async updateProgress(total, maxTokens) {
			// Get modifiers
			const result = await sendBackgroundMessage({ type: 'getCapModifiers' });
			const modifiers = result || {};

			// Apply modifier if it exists
			const adjustedMax = modifiers[this.modelName] ? maxTokens * modifiers[this.modelName] : maxTokens;

			// Calculate percentage
			const percentage = (total / adjustedMax) * 100;

			// Update progress bar
			this.progressBar.updateProgress(total, adjustedMax);

			// Update percentage display
			const color = percentage >= config.WARNING_THRESHOLD * 100 ? '#ef4444' : '#3b82f6';
			this.percentageDisplay.textContent = `${percentage.toFixed(1)}%`;
			this.percentageDisplay.style.color = color;
		}

		updateMessageCount(count) {
			this.messageCounter.textContent = `Msgs: ${count}`;
		}

		updateResetTime(timestamp) {
			this.resetTime = timestamp;

			this.resetTimeDisplay.innerHTML = timestamp ?
				`Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${formatTimeRemaining(timestamp)}</span>` :
				'Reset in: Not Set';
		}

		setActive(active) {
			this.activeIndicator.style.opacity = active ? '1' : '0';
		}
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
				z-index: 99999;
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
		constructor(donationInfo) {
			super();
			this.donationInfo = donationInfo;
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
			message.textContent = this.donationInfo.versionMessage;

			// Create patch notes container if needed
			let patchContainer = null;
			if (this.donationInfo.patchHighlights && this.donationInfo.patchHighlights.length > 0) {
				patchContainer = document.createElement('div');
				patchContainer.style.cssText = `
					text-align: left;
					margin-bottom: 10px;
					max-height: 150px;
					overflow-y: auto;
					background: #3B3B3B;
					padding: 8px;
					border-radius: 4px;
					font-size: 12px;
				`;

				if (!(this.donationInfo.patchHighlights[0].includes("donation"))) {
					const patchTitle = document.createElement('div');
					patchTitle.textContent = "What's New:";
					patchTitle.style.fontWeight = 'bold';
					patchTitle.style.marginBottom = '5px';
					patchContainer.appendChild(patchTitle);
				}


				const patchList = document.createElement('ul');
				patchList.style.cssText = `
					padding-left: 12px; /* Reduced from 20px */
					margin: 0;
					list-style-type: disc; /* Explicitly set bullet style */
					list-style-position: outside; /* Keep bullets outside */
				`;

				this.donationInfo.patchHighlights.forEach(highlight => {
					const item = document.createElement('li');
					item.textContent = highlight;
					item.style.marginBottom = '3px'; /* Add some spacing between items */
					item.style.paddingLeft = '3px'; /* Add a bit of padding after the bullet */
					patchList.appendChild(item);
				});

				patchContainer.appendChild(patchList);
			}

			// Add patch notes link
			const patchNotesLink = document.createElement('a');
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
			patchNotesLink.textContent = 'View full release notes';

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

			// Add patch notes if available
			if (patchContainer) {
				this.element.appendChild(patchContainer);
			}

			this.element.appendChild(patchNotesLink);
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
			this.element.style.maxWidth = '350px';
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
				// Collect modifiers
				const modifiers = {};
				modifiersContainer.querySelectorAll('input').forEach(input => {
					const value = input.value.replace('%', '');
					if (!isNaN(value)) {
						modifiers[input.dataset.model] = parseFloat(value) / 100;
					}
				});

				// Save modifiers
				await sendBackgroundMessage({
					type: 'setCapModifiers',
					modifiers
				});

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
			buttonContainer.appendChild(saveButton);
			const separatorText = document.createElement('div');
			separatorText.textContent = 'Model Cap Modifiers:';
			separatorText.style.cssText = `
				font-size: 12px;
				margin-bottom: 8px;
			`;

			// Add model modifiers
			const modifiersContainer = document.createElement('div');
			modifiersContainer.style.cssText = `
				display: flex;
				flex-direction: row;
				gap: 12px;
				margin-bottom: 12px;
			`;

			// Get stored modifiers
			const result = await sendBackgroundMessage({ type: 'getCapModifiers' });
			const storedModifiers = result || {};
			// Create input for each model
			config.MODELS.forEach(model => {
				const row = document.createElement('div');
				row.style.cssText = `
					display: flex;
					align-items: center;
					gap: 4px;
				`;

				const label = document.createElement('label');
				label.textContent = `${model}:`;
				label.style.color = '#FFF';
				label.style.fontSize = '12px';

				const input = document.createElement('input');
				input.type = 'text';
				input.value = storedModifiers[model] !== undefined ? `${(storedModifiers[model] * 100)}%` : '100%';
				input.style.cssText = `
					width: 45px;
					padding: 4px;
					background: #3B3B3B;
					border: 1px solid #4B4B4B;
					border-radius: 4px;
					color: white;
					font-size: 12px;
				`;
				input.dataset.model = model;

				row.appendChild(label);
				row.appendChild(input);
				modifiersContainer.appendChild(row);
			});

			this.element.appendChild(separatorText);
			this.element.appendChild(modifiersContainer);
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
					window.location.href = browser.runtime.getURL('debug.html');
				} else {
					this.remove();
				}
			});

			buttonContainer.appendChild(debugButton);

			// Create reset button with warning styling
			const resetButton = document.createElement('button');
			resetButton.textContent = 'Reset Quota';
			resetButton.style.cssText = `
				background: ${RED_WARNING};
				border: none;
				border-radius: 4px;
				color: white;
				cursor: pointer;
				padding: 6px 12px;
				font-size: 12px;
			`;

			resetButton.addEventListener('click', async () => {
				// Show confirmation dialog
				const confirmation = confirm(
					'Are you sure you want to reset usage data for this organization?\n\n' +
					'This will reset ALL models\' usage counters to zero and sync this reset across all your devices. ' +
					'This action cannot be undone.'
				);

				if (confirmation) {
					try {
						// Show loading state
						const originalText = resetButton.textContent;
						resetButton.textContent = 'Resetting...';
						resetButton.disabled = true;

						// Send reset message to background (sendBackgroundMessage already handles orgId)
						const result = await sendBackgroundMessage({
							type: 'resetOrgData'
						});

						if (result) {
							// Show success message
							resetButton.textContent = 'Reset Complete!';
							resetButton.style.background = '#22c55e'; // Success green

							// Reset button after delay
							setTimeout(() => {
								resetButton.textContent = originalText;
								resetButton.style.background = RED_WARNING;
								resetButton.disabled = false;
							}, 2000);
						} else {
							throw new Error('Reset failed');
						}
					} catch (error) {
						// Show error
						resetButton.textContent = 'Reset Failed';
						console.error('Reset failed:', error);

						// Reset button after delay
						setTimeout(() => {
							resetButton.textContent = originalText;
							resetButton.disabled = false;
						}, 2000);
					}
				}
			});

			buttonContainer.appendChild(resetButton);

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

			if (position) {
				// Get the card's width - we need to temporarily add it to the DOM to measure
				this.element.style.visibility = 'hidden';
				document.body.appendChild(this.element);
				const cardWidth = this.element.offsetWidth;
				this.element.remove();
				this.element.style.visibility = 'visible';

				// Check if card would overflow the right edge
				if (position.left + cardWidth > window.innerWidth) {
					// Adjust to align with left edge of screen with small margin
					position.left = 8;
				}
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
				const tooltipRect = this.tooltip.getBoundingClientRect();

				let leftPos = rect.left + (rect.width / 2);
				if (leftPos + (tooltipRect.width / 2) > window.innerWidth) {
					leftPos = window.innerWidth - tooltipRect.width - 10;
				}
				if (leftPos - (tooltipRect.width / 2) < 0) {
					leftPos = tooltipRect.width / 2 + 10;
				}

				let topPos = rect.top - 30;
				if (topPos < 10) {
					topPos = rect.bottom + 10;
				}

				this.tooltip.style.left = `${leftPos}px`;
				this.tooltip.style.top = `${topPos}px`;
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
			this.bar.style.background = total >= maxTokens * config.WARNING.PERCENT_THRESHOLD ? '#ef4444' : '#3b82f6';
			this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} tokens (${percentage.toFixed(1)}%)`;
		}
	}


	async function findSidebarContainers() {
		// First find the nav element
		const sidebarNav = document.querySelector(config.SELECTORS.SIDEBAR_NAV);
		if (!sidebarNav) {
			await Log("error", 'Could not find sidebar nav');
			return null;
		}

		// Look for the main container that holds all sections
		const mainContainer = sidebarNav.querySelector('.transition-all.duration-200.flex.flex-grow.flex-col.overflow-y-auto');
		if (!mainContainer) {
			await Log("error", 'Could not find main container in sidebar');
			return null;
		}

		// Look for the Starred section
		const starredSection = await waitForElement(mainContainer, 'div.flex.flex-col.mb-6', 5000);
		if (!starredSection) {
			await Log("error", 'Could not find Starred section, falling back to just recents');
		}

		// Check if the Recents section exists as the next sibling
		let recentsSection = null;
		if (starredSection) {
			recentsSection = starredSection.nextElementSibling;
		} else {
			recentsSection = mainContainer.firstChild;
		}

		if (!recentsSection) {
			await Log("error", 'Could not find Recents section');
			return null;
		}

		// Return the parent container so we can insert our UI between Starred and Recents
		return {
			container: mainContainer,
			starredSection: starredSection,
			recentsSection: recentsSection
		};
	}

	class UIManager {
		constructor(currModel) {
			this.currentlyDisplayedModel = currModel;
			this.sidebarUI = new SidebarUI(this);
			this.chatUI = new ChatUI();
			this.currentConversation = -1;
			this.conversationMetrics = null;
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
			const sidebarContainers = await findSidebarContainers();
			await this.sidebarUI.checkAndReinject(sidebarContainers);
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
			if (isHomePage && this.conversationMetrics !== null) {
				this.conversationMetrics = null;
				this.chatUI.updateEstimate();
				this.chatUI.updateCostAndLength();
				this.currentConversation = null;
			}
		}

		async lowFrequencyUpdates() {
			// Check for message limits
			const messageLimitElement = document.querySelector(config.SELECTORS.USAGE_LIMIT_LINK);
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
			const { conversationMetrics, modelData } = data;

			if (conversationMetrics) this.conversationMetrics = conversationMetrics;

			// Update current model
			this.currentlyDisplayedModel = await getCurrentModel() || this.currentlyDisplayedModel

			// Get the token cap for current model
			const modelCaps = await sendBackgroundMessage({ type: 'getCaps' });

			// Update both UIs
			await this.sidebarUI.updateProgressBars(data, this.currentlyDisplayedModel, modelCaps);
			await this.chatUI.updateChatUI(data, this.currentlyDisplayedModel, modelCaps);
		}

	}

	class ChatUI {
		constructor() {
			this.costAndLengthDisplay = null;
			this.estimateDisplay = null;
			this.resetDisplay = null;
			this.statLine = null;
			this.progressBar = null;
			this.lastResetTimestamp = null;
			this.lastMessageCost = null;
			this.usageLabel = null;
		}

		initialize() {
			this.costAndLengthDisplay = document.createElement('div');
			this.costAndLengthDisplay.className = 'text-text-500 text-xs';
			this.costAndLengthDisplay.style.cssText = "margin-top: 2px; font-size: 11px;";

			// Create container for estimate and reset time
			this.statLine = document.createElement('div');
			this.statLine.className = 'flex items-center min-w-0 max-w-full';
			this.statLine.style.userSelect = 'none'; // Make the whole line unselectable by default

			// Add label for progress bar
			//if (!isMobileView() || true) {
			this.usageLabel = document.createElement('div');
			this.usageLabel.className = 'text-text-400 text-xs mr-2';
			this.usageLabel.textContent = 'Quota:';
			this.usageLabel.style.userSelect = 'none';
			this.statLine.appendChild(this.usageLabel);


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
			this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span>N/A</span>`;
			this.statLine.appendChild(this.estimateDisplay);

			// Create reset display
			this.resetDisplay = document.createElement('div');
			this.resetDisplay.className = 'text-text-400 text-xs mr-2';
			this.resetDisplay.style.userSelect = 'text';  // Make text selectable
			this.statLine.appendChild(this.resetDisplay);
		}

		async checkAndReinject() {
			// Handle length display injection
			const chatMenu = document.querySelector(config.SELECTORS.CHAT_MENU);
			if (chatMenu) {
				const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
				if (titleLine) {
					// Check if there's a project link
					const projectLink = titleLine.querySelector('a[href^="/project/"]');

					if (projectLink) {
						// If there's a project link, we need to create a wrapper for project and chat menu
						if (!titleLine.querySelector('.chat-project-wrapper')) {
							const wrapper = document.createElement('div');
							wrapper.className = 'chat-project-wrapper flex min-w-0 flex-row items-center md:items-center 2xl:justify-center';

							//Move elements to wrapper
							projectLink.remove();
							wrapper.appendChild(projectLink);

							const chatMenuContainer = chatMenu.closest('.flex.min-w-0.items-center');
							if (chatMenuContainer) {
								chatMenuContainer.remove();
								wrapper.appendChild(chatMenuContainer);
							}

							titleLine.insertBefore(wrapper, titleLine.firstChild);
						}
					}

					// Keep the alignment classes on the titleLine
					titleLine.classList.remove('md:flex-row');
					titleLine.classList.add('md:flex-col');

					// Add our length display after the wrapper or chat menu
					if (chatMenu.parentElement.nextElementSibling !== this.costAndLengthDisplay) {
						const chatMenuParent = chatMenu.closest('.chat-project-wrapper') || chatMenu.parentElement;
						if (chatMenuParent.nextElementSibling !== this.costAndLengthDisplay) {
							chatMenuParent.after(this.costAndLengthDisplay);
						}
					}
				}
			}

			// Handle stat line injection
			const modelSelector = document.querySelector(config.SELECTORS.MODEL_SELECTOR);
			if (!modelSelector) {
				await Log("warning", 'Could not find model selector!');
				return;
			}

			const selectorLine = modelSelector?.parentElement?.parentElement;

			if (!selectorLine) {
				await Log("warning", 'Could not find selector line!');
				return;
			}
			if (selectorLine && selectorLine.nextElementSibling !== this.statLine) {
				selectorLine.after(this.statLine);
			}
		}

		async updateChatUI(data, currentModel, modelCaps) {
			if (data.conversationMetrics) {
				this.updateCostAndLength(data.conversationMetrics);
				this.lastMessageCost = data.conversationMetrics.cost;
				this.updateEstimate(data.modelData, currentModel, modelCaps, data.conversationMetrics.cost);
			} else if (this.lastMessageCost) {
				this.updateEstimate(data.modelData, currentModel, modelCaps, this.lastMessageCost);
			}
			await this.updateProgressBar(data.modelData, currentModel, modelCaps);
			this.updateResetTime(data.modelData, currentModel);
		}

		async updateProgressBar(modelData, currentModel, modelCaps) {
			if (!this.progressBar) return;

			const maxTokens = modelCaps[currentModel] || modelCaps.default;
			const currentModelData = modelData[currentModel];
			const modelTotal = currentModelData?.total || 0;

			// Get modifiers
			const result = await sendBackgroundMessage({ type: 'getCapModifiers' });
			const modifiers = result || {};

			// Apply modifier if it exists
			const adjustedMax = modifiers[currentModel] ? maxTokens * modifiers[currentModel] : maxTokens;

			// Calculate percentage
			const percentage = (modelTotal / adjustedMax) * 100;

			// Update progress bar
			this.progressBar.updateProgress(modelTotal, adjustedMax);

			// Update the usage label with percentage
			if (this.usageLabel) {
				const color = percentage >= config.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
				if (isMobileView()) {
					this.usageLabel.innerHTML = `<span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
				} else {
					this.usageLabel.innerHTML = `Quota: <span style="color: ${color}">${percentage.toFixed(1)}%</span>`;
				}

			}
		}

		updateCostAndLength(metrics) {
			const separator = isMobileView() ? '<br>' : ' | ';
			if (this.costAndLengthDisplay) {
				if (!metrics) {
					this.costAndLengthDisplay.innerHTML = `Length: N/A tokens`;
					return;
				}

				const hasCost = config.OUTPUT_TOKEN_MULTIPLIER != 1 || metrics.cost != metrics.length;
				const lengthColor = metrics.length >= config.WARNING.LENGTH ? RED_WARNING : BLUE_HIGHLIGHT;
				const costColor = metrics.cost >= config.WARNING.COST ? RED_WARNING : BLUE_HIGHLIGHT;

				/*this.costAndLengthDisplay.innerHTML =
					`Length: <span style="color: ${lengthColor}">${metrics.length.toLocaleString()}</span> tokens` +
					`${hasCost ? `${separator}Cost: <span style="color: ${costColor}">${metrics.cost.toLocaleString()}</span> tokens` : ""}`;
				*/
				this.costAndLengthDisplay.innerHTML =
					`Length: <span style="color: ${lengthColor}">${metrics.length.toLocaleString()}</span> tokens` +
					`${separator}Cost: <span style="color: ${costColor}">${metrics.cost.toLocaleString()}</span> tokens`;
			}
		}

		updateEstimate(modelData, currentModel, modelCaps, messageCost) {
			if (!this.estimateDisplay) return;
			if (!getConversationId()) {
				this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span>N/A</span>`;
				return
			}
			const maxTokens = modelCaps[currentModel] || modelCaps.default;
			const currentModelData = modelData[currentModel];
			const modelTotal = currentModelData?.total || 0;
			const remainingTokens = maxTokens - modelTotal;

			let estimate;
			if (messageCost > 0 && currentModel) {
				estimate = Math.max(0, remainingTokens / messageCost);
				estimate = estimate.toFixed(1);
			} else {
				estimate = "N/A";
			}

			const color = estimate !== "N/A" && parseFloat(estimate) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
			this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span style="color: ${color}">${estimate}</span>`;
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
				this.resetDisplay.innerHTML = `Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${formatTimeRemaining(this.lastResetTimestamp)}</span>`;
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
				container.insertBefore(this.container, recentsSection);
			}

			this.uiReady = true;

			// Process any updates that arrived before UI was ready
			while (this.pendingUpdates.length > 0) {
				const update = this.pendingUpdates.shift();
				await this.updateProgressBars(
					update.data,
					update.currentlyDisplayedModel,
					update.modelCaps
				);
			}

			// Initialize model section visibility
			config.MODELS.forEach(modelName => {
				const section = this.modelSections[modelName];
				if (section) {
					const isActiveModel = modelName === this.parentUI.currentlyDisplayedModel;
					section.setActive(isActiveModel);
				}
			});

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

		async buildHeader() {
			const header = document.createElement('div');
			header.className = 'flex items-center justify-between pb-2 pl-2 sticky top-0 bg-gradient-to-b from-bg-200 from-50% to-bg-200/40';
			header.style.zIndex = "9999"
			// Create title
			const title = document.createElement('h3');
			title.textContent = 'Usage';
			title.className = 'text-text-300 flex items-center gap-1.5 text-xs select-none z-10 bg-gradient-to-b from-bg-200 from-50% to-bg-200/40';

			// Add settings button
			const settingsButton = document.createElement('button');
			settingsButton.className = 'inline-flex items-center justify-center relative shrink-0 can-focus select-none text-text-300 border-transparent transition font-styrene duration-300 ease-[cubic-bezier(0.165,0.85,0.45,1)] hover:bg-bg-400 hover:text-text-100 h-8 w-8 rounded-md active:scale-95';
			settingsButton.style.color = BLUE_HIGHLIGHT;
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

			// Container for model sections
			const sectionsContainer = document.createElement('ul');
			sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col px-1.5 gap-px';

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
				this.pendingUpdates.push({
					data,
					currentlyDisplayedModel,
					modelCaps
				});
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

				await section.updateProgress(modelTotal, maxTokens);
				section.updateMessageCount(messageCount);
				section.updateResetTime(modelInfo.resetTimestamp);
				section.container.style.display = maxTokens === 0 ? 'none' : '';
			}
		}

		async checkAndReinject(sidebarContainers) {
			if (!sidebarContainers || !sidebarContainers.container.contains(this.container)) {
				if (sidebarContainers) {
					await Log('UI not present in sidebar, re-injecting...');
					this.uiReady = false;
					sidebarContainers.container.insertBefore(this.container, sidebarContainers.recentsSection);
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

		return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
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

		// Set up event listeners in content script context
		window.addEventListener('interceptedRequest', async (event) => {
			await Log("Intercepted request", event.detail);
			browser.runtime.sendMessage({
				type: 'interceptedRequest',
				details: event.detail
			});
		});

		window.addEventListener('interceptedResponse', async (event) => {
			await Log("Intercepted response", event.detail);
			browser.runtime.sendMessage({
				type: 'interceptedResponse',
				details: event.detail
			});
		});

		const setupScript = document.createElement('script');
		setupScript.textContent = `
			window.__interceptPatterns = ${JSON.stringify(patterns)};
			const originalFetch = window.fetch;

			async function getBodyDetails(body) {
				if (!body) return null;
				
				// If it's already a string (like JSON), just pass it through
				if (typeof body === 'string') {
					return { raw: [{ bytes: body }], fromMonkeypatch: true };
				}
				
				// Handle FormData and other complex types
				if (body instanceof FormData) {
					const text = Array.from(body.entries())
						.map(entry => entry[0] + '=' + entry[1])
						.join('&');
					return { raw: [{ bytes: text }], fromMonkeypatch: true };
				}
				
				// For everything else, try to stringify
				try {
					return { raw: [{ bytes: JSON.stringify(body) }], fromMonkeypatch: true };
				} catch (e) {
					console.error('Failed to serialize body:', e);
					return null;
				}
			}

			window.fetch = async (...args) => {
				const patterns = window.__interceptPatterns;
				if (!patterns) return originalFetch(...args);
				
				const [input, config] = args;
				
				let url;
				if (input instanceof URL) {
					url = input.href;
				} else if (typeof input === 'string') {
					url = input;
				} else if (input instanceof Request) {
					url = input.url;
				}
				if (url.startsWith('/')) {
					url = 'https://claude.ai' + url;
				}
	
				const details = {
					url: url,
					method: config?.method || 'GET',
					requestBody: config?.body ? await getBodyDetails(config.body) : null
				};
				
				if (patterns.onBeforeRequest.regexes.some(pattern => new RegExp(pattern).test(url))) {
					window.dispatchEvent(new CustomEvent('interceptedRequest', { detail: details }));
				}
	
				const response = await originalFetch(...args);
				
				if (patterns.onCompleted.regexes.some(pattern => new RegExp(pattern).test(url))) {
					window.dispatchEvent(new CustomEvent('interceptedResponse', { 
						detail: {
							...details,
							status: response.status,
							statusText: response.statusText
						}
					}));
				}
	
				return response;
			};
		`;
		(document.head || document.documentElement).appendChild(setupScript);
		setupScript.remove();
	}
	//#endregion

	async function initialize() {
		const LOGIN_CHECK_DELAY = 10000;

		// Load and assign configuration to global variables
		config = await sendBackgroundMessage({ type: 'getConfig' });
		await Log("Config received...")
		await Log(config)
		let userMenuButton = null;
		while (true) {
			// Check for duplicate running with retry logic

			userMenuButton = await waitForElement(document, config.SELECTORS.USER_MENU_BUTTON, 6000);
			if (userMenuButton) {
				// Found the button, continue with initialization
				break;
			}

			// Check if we're on either login screen
			const initialLoginScreen = document.querySelector(config.SELECTORS.INIT_LOGIN_SCREEN);
			const verificationLoginScreen = document.querySelector(config.SELECTORS.VERIF_LOGIN_SCREEN);

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
