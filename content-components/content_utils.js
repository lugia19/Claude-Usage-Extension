'use strict';

// Constants
const BLUE_HIGHLIGHT = "#2c84db";
const RED_WARNING = "#de2929";
const SUCCESS_GREEN = "#22c55e";
// Dynamic debug setting - will be loaded from storage
let FORCE_DEBUG;

// Load FORCE_DEBUG from storage and set up error handlers
browser.storage.local.get('force_debug').then(result => {
	FORCE_DEBUG = result.force_debug || false;

	// Set up error logging based on debug setting
	if (!FORCE_DEBUG) {
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
	}
});

// Global variables that will be shared across all content scripts
let config;
let ui;

// Logging function
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

	console.log("[UsageTracker]", ...args);

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
		Error.captureStackTrace(error, logError);
	}
	await Log("error", JSON.stringify(error.stack));
}

// Utility functions
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

// Fetch interception functions
async function initializeInjections() {
	// Always inject rate limit monitoring
	await setupRateLimitMonitoring();
	const isElectron = await browser.runtime.sendMessage({ type: 'isElectron' });
	if (isElectron) {
		const patterns = await browser.runtime.sendMessage({
			type: 'getMonkeypatchPatterns'
		});
		// Conditionally inject request/response interception
		if (patterns) {
			await setupRequestInterception(patterns);
			await setupElectronEventListeners();
		}
	}

}

async function setupRateLimitMonitoring() {
	// Set up rate limit event listener
	window.addEventListener('rateLimitExceeded', async (event) => {
		await Log("Rate limit exceeded", event.detail);
		await sendBackgroundMessage({
			type: 'rateLimitExceeded',
			detail: event.detail
		})
	});

	// Inject external rate limit monitoring script
	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/rate-limit-watcher.js');
	script.onload = function () {
		this.remove();
	};
	(document.head || document.documentElement).appendChild(script);
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

	// Inject external request interception script with patterns as data attribute
	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/webrequest-polyfill.js');
	script.dataset.patterns = JSON.stringify(patterns);
	script.onload = function () {
		this.remove();
	};
	(document.head || document.documentElement).appendChild(script);
}

async function setupElectronEventListeners() {
	// Electron tab activity listeners
	window.addEventListener('electronTabActivated', async (event) => {
		await Log("Electron tab activated", event.detail);
		browser.runtime.sendMessage({
			type: 'electronTabActivated',
			details: event.detail
		});
	});

	window.addEventListener('electronTabDeactivated', async (event) => {
		await Log("Electron tab deactivated", event.detail);
		browser.runtime.sendMessage({
			type: 'electronTabDeactivated',
			details: event.detail
		});
	});

	window.addEventListener('electronTabRemoved', async (event) => {
		await Log("Electron tab removed", event.detail);
		browser.runtime.sendMessage({
			type: 'electronTabRemoved',
			details: event.detail
		});
	});
}

function getResetTimeHTML(timeInfo) {
	const prefix = 'Reset in: ';

	if (!timeInfo || !timeInfo.timestamp || timeInfo.expired) {
		return `${prefix}<span>Not set</span>`;
	}

	const now = Date.now();
	const diff = timeInfo.timestamp - now;

	// Convert to seconds and round to nearest minute
	const totalMinutes = Math.round(diff / (1000 * 60));

	if (totalMinutes === 0) {
		return `${prefix}<span style="color: ${BLUE_HIGHLIGHT}"><1m</span>`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;

	const timeString = hours > 0 ? `${hours}h ${minutes}m` : `${totalMinutes}m`;

	return `${prefix}<span style="color: ${BLUE_HIGHLIGHT}">${timeString}</span>`;
}

function setupTooltip(element, tooltip, options = {}) {
	if (!element || !tooltip) return;

	// Check if already set up
	if (element.hasAttribute('data-tooltip-setup')) {
		return;
	}
	element.setAttribute('data-tooltip-setup', 'true');

	const { topOffset = 10 } = options;

	// Add standard classes for all tooltip elements
	element.classList.add('ut-tooltip-trigger', 'ut-info-item');
	element.style.cursor = 'help';


	let pressTimer;
	let tooltipHideTimer;

	const showTooltip = () => {
		const rect = element.getBoundingClientRect();
		tooltip.style.opacity = '1';
		const tooltipRect = tooltip.getBoundingClientRect();

		let leftPos = rect.left + (rect.width / 2);
		if (leftPos + (tooltipRect.width / 2) > window.innerWidth) {
			leftPos = window.innerWidth - tooltipRect.width - 10;
		}
		if (leftPos - (tooltipRect.width / 2) < 0) {
			leftPos = tooltipRect.width / 2 + 10;
		}

		let topPos = rect.top - tooltipRect.height - topOffset;
		if (topPos < 10) {
			topPos = rect.bottom + 10;
		}

		tooltip.style.left = `${leftPos}px`;
		tooltip.style.top = `${topPos}px`;
		tooltip.style.transform = 'translateX(-50%)';
	};

	const hideTooltip = () => {
		tooltip.style.opacity = '0';
		clearTimeout(tooltipHideTimer);
	};

	// Pointer events work for both mouse and touch
	element.addEventListener('pointerdown', (e) => {

		if (e.pointerType === 'touch' || isMobileView()) {
			// Touch/mobile: long press
			pressTimer = setTimeout(() => {
				showTooltip();

				// Auto-hide after 3 seconds
				tooltipHideTimer = setTimeout(hideTooltip, 3000);
			}, 500);
		}
		// Mouse is handled by enter/leave below
	});

	element.addEventListener('pointerup', (e) => {
		if (e.pointerType === 'touch' || isMobileView()) {
			clearTimeout(pressTimer);
		}
	});

	element.addEventListener('pointercancel', (e) => {
		clearTimeout(pressTimer);
		hideTooltip();
	});

	// Keep mouse hover for desktop
	if (!isMobileView()) {
		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') {
				showTooltip();
			}
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') {
				hideTooltip();
			}
		});
	}
}