(function () {
	'use strict';
	const BLUE_HIGHLIGHT = "#2c84db";
	const RED_WARNING = "#de2929";

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


	class UsageSection {
		constructor() {
			this.isEnabled = true;
			this.resetTime = null;
			this.buildSection();
		}

		buildSection() {
			this.container = document.createElement('div');
			this.container.className = 'ut-container';

			const topLine = document.createElement('div');
			topLine.className = 'text-text-000 ut-row ut-text-base ut-mb-1 ut-select-none';

			const nameContainer = document.createElement('div');
			nameContainer.className = 'ut-row';
			nameContainer.style.width = '35%';

			const title = document.createElement('span');
			title.textContent = 'All:';

			this.percentageDisplay = document.createElement('span');
			this.percentageDisplay.className = 'ut-text-sm';
			this.percentageDisplay.style.marginLeft = '6px';
			this.percentageDisplay.style.whiteSpace = 'nowrap';

			nameContainer.appendChild(title);
			nameContainer.appendChild(this.percentageDisplay);

			const statsContainer = document.createElement('div');
			statsContainer.className = 'text-text-400 ut-row ut-flex-grow ut-text-sm';

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

		async updateProgress(total, maxTokens) {
			// Calculate percentage
			const percentage = (total / maxTokens) * 100;

			// Update progress bar
			this.progressBar.updateProgress(total, maxTokens);

			// Update percentage display
			const color = percentage >= config.WARNING_THRESHOLD * 100 ? RED_WARNING : BLUE_HIGHLIGHT;
			this.percentageDisplay.textContent = `${percentage.toFixed(1)}%`;
			this.percentageDisplay.style.color = color;
		}

		updateResetTime(timestamp) {
			this.resetTime = timestamp;

			this.resetTimeDisplay.innerHTML = timestamp ?
				`Reset in: <span style="color: ${BLUE_HIGHLIGHT}">${formatTimeRemaining(timestamp)}</span>` :
				'Reset in: Not Set';
		}
	}

	class FloatingCard {
		constructor() {
			this.defaultPosition = { top: '20px', right: '20px' }
			this.element = document.createElement('div');
			this.element.className = 'bg-bg-100 border border-border-400 text-text-000 ut-card';
		}

		addCloseButton() {
			const closeButton = document.createElement('button');
			closeButton.className = 'ut-button ut-close ut-text-lg';
			closeButton.style.color = BLUE_HIGHLIGHT;
			closeButton.style.background = 'none';
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
			this.element.classList.add('ut-text-center');
			this.element.style.maxWidth = '250px';
			this.build();
		}

		build() {
			const dragHandle = document.createElement('div');
			dragHandle.className = 'border-b border-border-400 ut-header';
			dragHandle.textContent = 'Usage Tracker';

			const message = document.createElement('div');
			message.className = 'ut-mb-2';
			message.textContent = this.donationInfo.versionMessage;

			let patchContainer = null;
			if (this.donationInfo.patchHighlights?.length > 0) {
				patchContainer = document.createElement('div');
				patchContainer.className = 'bg-bg-000 ut-content-box ut-text-left ut-mb-2';
				patchContainer.style.maxHeight = '150px';

				if (!this.donationInfo.patchHighlights[0].includes("donation")) {
					const patchTitle = document.createElement('div');
					patchTitle.textContent = "What's New:";
					patchTitle.style.fontWeight = 'bold';
					patchTitle.className = 'ut-mb-1';
					patchContainer.appendChild(patchTitle);
				}

				const patchList = document.createElement('ul');
				patchList.style.paddingLeft = '12px';
				patchList.style.margin = '0';
				patchList.style.listStyleType = 'disc';

				this.donationInfo.patchHighlights.forEach(highlight => {
					const item = document.createElement('li');
					item.textContent = highlight;
					item.style.marginBottom = '3px';
					item.style.paddingLeft = '3px';
					patchList.appendChild(item);
				});

				patchContainer.appendChild(patchList);
			}

			const patchNotesLink = document.createElement('a');
			patchNotesLink.href = 'https://github.com/lugia19/Claude-Usage-Extension/releases';
			patchNotesLink.target = '_blank';
			patchNotesLink.className = 'ut-link ut-block ut-mb-2';
			patchNotesLink.style.color = BLUE_HIGHLIGHT;
			patchNotesLink.textContent = 'View full release notes';

			const kofiButton = document.createElement('a');
			kofiButton.href = 'https://ko-fi.com/R6R14IUBY';
			kofiButton.target = '_blank';
			kofiButton.className = 'ut-block ut-text-center';
			kofiButton.style.marginTop = '10px';

			const kofiImg = document.createElement('img');
			kofiImg.src = browser.runtime.getURL('kofi-button.png');
			kofiImg.height = 36;
			kofiImg.style.border = '0';
			kofiImg.alt = 'Buy Me a Coffee at ko-fi.com';
			kofiButton.appendChild(kofiImg);

			// Assemble
			this.element.appendChild(dragHandle);
			this.element.appendChild(message);
			if (patchContainer) this.element.appendChild(patchContainer);
			this.element.appendChild(patchNotesLink);
			this.element.appendChild(kofiButton);
			this.addCloseButton();
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
			const dragHandle = document.createElement('div');
			dragHandle.className = 'border-b border-border-400 ut-header';
			dragHandle.textContent = 'Settings';
			this.element.appendChild(dragHandle);

			const label = document.createElement('label');
			label.className = 'ut-label';
			label.textContent = 'API Key (more accurate):';

			const input = document.createElement('input');
			input.type = 'password';
			input.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input ut-w-full';
			let apiKey = await sendBackgroundMessage({ type: 'getAPIKey' })
			if (apiKey) input.value = apiKey

			const saveButton = document.createElement('button');
			saveButton.textContent = 'Save';
			saveButton.className = 'ut-button';
			saveButton.style.background = BLUE_HIGHLIGHT;
			saveButton.style.color = 'white';

			// Modifier section
			const modifierContainer = document.createElement('div');
			modifierContainer.className = 'ut-row ut-mb-3';

			const modifierLabel = document.createElement('label');
			modifierLabel.textContent = 'Cap Modifier:';
			modifierLabel.className = 'text-text-000 ut-text-base';

			const modifierInput = document.createElement('input');
			modifierInput.type = 'text';
			modifierInput.className = 'bg-bg-000 border border-border-400 text-text-000 ut-input ut-mb-0';
			modifierInput.style.width = '60px';

			const result = await sendBackgroundMessage({ type: 'getCapModifier' });
			modifierInput.value = `${((result || 1) * 100)}%`;

			modifierContainer.appendChild(modifierLabel);
			modifierContainer.appendChild(modifierInput);

			// Button container
			const buttonContainer = document.createElement('div');
			buttonContainer.className = 'ut-row';

			const debugButton = document.createElement('button');
			debugButton.textContent = 'Debug Logs';
			debugButton.className = 'bg-bg-400 border border-border-400 text-text-400 ut-button ut-text-base';



			const resetButton = document.createElement('button');
			resetButton.textContent = 'Reset Quota';
			resetButton.className = 'ut-button ut-text-base';
			resetButton.style.background = RED_WARNING;
			resetButton.style.color = 'white';

			// Event listeners remain the same...
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

			saveButton.addEventListener('click', async () => {
				const modifierValue = modifierInput.value.replace('%', '');
				let modifier = 1;
				if (!isNaN(modifierValue)) {
					modifier = parseFloat(modifierValue) / 100;
				}

				await sendBackgroundMessage({ type: 'setCapModifier', modifier });
				let result = await sendBackgroundMessage({ type: 'setAPIKey', newKey: input.value });

				if (!result) {
					const errorMsg = document.createElement('div');
					errorMsg.className = 'ut-text-lg';
					errorMsg.style.color = RED_WARNING;
					errorMsg.textContent = input.value.startsWith('sk-ant')
						? 'Inactive API key. Have you ever loaded credits to the account?'
						: 'Invalid API key. Format looks wrong, it should start with sk-ant.';
					input.after(errorMsg);
					setTimeout(() => errorMsg.remove(), 3000);
					return;
				}
				location.reload();
			});

			// Assemble
			this.element.appendChild(label);
			this.element.appendChild(input);
			this.element.appendChild(modifierContainer);
			buttonContainer.appendChild(saveButton);
			buttonContainer.appendChild(debugButton);
			buttonContainer.appendChild(resetButton);
			this.element.appendChild(buttonContainer);

			this.addCloseButton();
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
			this.bar.style.background = total >= maxTokens * config.WARNING.PERCENT_THRESHOLD ? RED_WARNING : BLUE_HIGHLIGHT;
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
			if (newModel && newModel !== this.currentlyDisplayedModel) {
				await this.updateUI(await sendBackgroundMessage({
					type: 'requestData',
					conversationId: currConversation,
					modelOverride: newModel
				}));
				this.currentlyDisplayedModel = newModel;
			}

			//UI presence checks
			const sidebarContainers = await findSidebarContainers();
			await this.sidebarUI.checkAndReinject(sidebarContainers);
			await this.chatUI.checkAndReinject();
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

			// Get the usage cap from backend
			const usageCap = await sendBackgroundMessage({ type: 'getUsageCap' });

			// Update both UIs
			await this.sidebarUI.updateProgressBars(data, usageCap);
			await this.chatUI.updateChatUI(data, this.currentlyDisplayedModel, usageCap);
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
			this.costAndLengthDisplay.className = 'text-text-500 text-xs ut-text-sm';
			this.costAndLengthDisplay.style.marginTop = '2px';

			this.statLine = document.createElement('div');
			this.statLine.className = 'ut-row ut-select-none';

			this.usageLabel = document.createElement('div');
			this.usageLabel.className = 'text-text-400 text-xs ut-select-none';
			this.usageLabel.style.marginRight = '8px';
			this.usageLabel.textContent = 'Quota:';

			this.progressBar = new ProgressBar({ width: "25%" });
			this.progressBar.container.classList.remove('bg-bg-500');
			this.progressBar.container.classList.add('bg-bg-200');
			this.progressBar.container.style.marginRight = '12px';

			const spacer = document.createElement('div');
			spacer.className = 'ut-flex-1 ut-select-none';

			this.estimateDisplay = document.createElement('div');
			this.estimateDisplay.className = 'text-text-400 text-xs ut-select-text';
			this.estimateDisplay.style.marginRight = '8px';

			this.resetDisplay = document.createElement('div');
			this.resetDisplay.className = 'text-text-400 text-xs ut-select-text';
			this.resetDisplay.style.marginRight = '8px';

			this.statLine.appendChild(this.usageLabel);
			this.statLine.appendChild(this.progressBar.container);
			this.statLine.appendChild(spacer);
			this.statLine.appendChild(this.estimateDisplay);
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

		async updateChatUI(data, currentModel, usageCap) {
			if (data.conversationMetrics) {
				this.updateCostAndLength(data.conversationMetrics);
				this.lastMessageCost = data.conversationMetrics.cost;
				this.updateEstimate(data.modelData, currentModel, usageCap, data.conversationMetrics.cost);
			} else if (this.lastMessageCost) {
				this.updateEstimate(data.modelData, currentModel, usageCap, this.lastMessageCost);
			}
			await this.updateProgressBar(data.modelData, usageCap);
			this.updateResetTime(data.modelData);
		}

		async updateProgressBar(modelData, usageCap) {
			if (!this.progressBar) return;

			const { total } = modelData;
			const modelTotal = total || 0;

			// Calculate percentage
			const percentage = (modelTotal / usageCap) * 100;

			// Update progress bar
			this.progressBar.updateProgress(modelTotal, usageCap);

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

				const lengthColor = metrics.length >= config.WARNING.LENGTH ? RED_WARNING : BLUE_HIGHLIGHT;
				const costColor = metrics.cost >= config.WARNING.COST ? RED_WARNING : BLUE_HIGHLIGHT;

				this.costAndLengthDisplay.innerHTML =
					`Length: <span style="color: ${lengthColor}">${metrics.length.toLocaleString()}</span> tokens` +
					`${separator}Cost: <span style="color: ${costColor}">${metrics.cost.toLocaleString()}</span> tokens`;
			}
		}

		updateEstimate(modelData, currentModel, usageCap, messageCost) {
			if (!this.estimateDisplay) return;
			if (!getConversationId()) {
				this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span>N/A</span>`;
				return
			}

			const { total } = modelData;
			const modelTotal = total || 0;
			const remainingTokens = usageCap - modelTotal;

			let estimate;
			if (messageCost > 0 && currentModel) {
				// Adjust the message cost by the current model's weight for estimate
				estimate = Math.max(0, remainingTokens / messageCost);
				estimate = estimate.toFixed(1);
			} else {
				estimate = "N/A";
			}

			const color = estimate !== "N/A" && parseFloat(estimate) < 15 ? RED_WARNING : BLUE_HIGHLIGHT;
			this.estimateDisplay.innerHTML = `${isMobileView() ? "Est. Msgs" : "Est. messages"}: <span style="color: ${color}">${estimate}</span>`;
		}

		updateResetTime(modelData) {
			if (!this.resetDisplay) return;

			const { resetTimestamp } = modelData;
			this.lastResetTimestamp = resetTimestamp || null;
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
				container.insertBefore(this.container, recentsSection);
			}

			this.uiReady = true;

			// Process any updates that arrived before UI was ready
			while (this.pendingUpdates.length > 0) {
				const update = this.pendingUpdates.shift();
				await this.updateProgressBars(update.data);
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

		async buildHeader() {
			const header = document.createElement('div');
			header.className = 'ut-row ut-justify-between ut-sticky';
			header.style.cssText = `
				padding-bottom: 8px;
				padding-left: 8px;
				z-index: 9999;
				background: linear-gradient(to bottom, var(--bg-200) 50%, var(--bg-200) 40%);
			`;

			const title = document.createElement('h3');
			title.textContent = 'Usage';
			title.className = 'text-text-300 flex items-center gap-1.5 text-xs select-none z-10';

			const settingsButton = document.createElement('button');
			settingsButton.className = 'ut-button ut-button-icon hover:bg-bg-400 hover:text-text-100';
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

			// Container for usage section
			const sectionsContainer = document.createElement('ul');
			sectionsContainer.className = '-mx-1.5 flex flex-1 flex-col px-1.5 gap-px';

			// Create single usage section
			this.usageSection = new UsageSection();
			sectionsContainer.appendChild(this.usageSection.container);

			content.appendChild(sectionsContainer);

			return content;
		}

		async updateProgressBars(data, usageCap) {
			if (!this.uiReady) {
				await Log("UI not ready, pushing to pending updates...");
				this.pendingUpdates.push({ data, usageCap });
				return;
			}

			// Expecting data to have modelData with total and resetTimestamp
			const { modelData } = data;
			const { total, resetTimestamp } = modelData;

			await Log("Updating usage section...");
			await this.usageSection.updateProgress(total || 0, usageCap);
			this.usageSection.updateResetTime(resetTimestamp);
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

		// Always inject rate limit monitoring
		await setupRateLimitMonitoring();

		// Conditionally inject request/response interception
		if (patterns) {
			await setupRequestInterception(patterns);
		}
	}

	async function setupRateLimitMonitoring() {
		// Set up rate limit event listener
		window.addEventListener('rateLimitExceeded', async (event) => {
			await Log("Rate limit exceeded", event.detail);
			await sendBackgroundMessage({
				type: 'rateLimitExceeded'
			})
		});

		const rateLimitScript = document.createElement('script');
		rateLimitScript.textContent = `
        (function() {
            const originalFetch = window.fetch;
            
            window.fetch = async function(...args) {
                const response = await originalFetch.apply(this, args);
                
                if (response.headers.get('content-type')?.includes('event-stream')) {
                    const clone = response.clone();
                    const reader = clone.body.getReader();
                    const decoder = new TextDecoder();

                    const readStream = async () => {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            const chunk = decoder.decode(value);
                            const lines = chunk.split('\\n');

                            for (const line of lines) {
                                if (line.startsWith('data:')) {
                                    const data = line.substring(5).trim();
                                    try {
                                        const json = JSON.parse(data);
                                        if (json.type === 'message_limit' && json.message_limit?.type === 'exceeded_limit') {
                                            window.dispatchEvent(new CustomEvent('rateLimitExceeded', { 
                                                detail: json.message_limit 
                                            }));
                                        }
                                    } catch (e) {
                                        // Not JSON, ignore
                                    }
                                }
                            }
                        }
                    };

                    readStream().catch(err => err.name !== 'AbortError' && console.error('Rate limit stream reading error:', err));
                }
                
                return response;
            };
        })();
    `;
		(document.head || document.documentElement).appendChild(rateLimitScript);
		rateLimitScript.remove();
	}

	async function setupRequestInterception(patterns) {
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

	async function injectStyles() {
		if (document.getElementById('ut-styles')) return;

		try {
			const cssContent = await fetch(browser.runtime.getURL('tracker-styles.css')).then(r => r.text());

			// Just change these lines:
			const style = document.createElement('link');
			style.rel = 'stylesheet';
			style.id = 'ut-styles';
			style.href = `data:text/css;charset=utf-8,${encodeURIComponent(cssContent)}`;

			document.head.appendChild(style);
		} catch (error) {
			await Log("error", 'Failed to load tracker styles:', error);
		}
	}

	async function initialize_extension() {
		const LOGIN_CHECK_DELAY = 10000;
		await injectStyles();
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
			await initialize_extension();
		} catch (error) {
			await Log("error", 'Failed to initialize Chat Token Counter:', error);
		}
	})();
})();
