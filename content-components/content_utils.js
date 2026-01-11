'use strict';

// Constants
const BLUE_HIGHLIGHT = "#2c84db";
const RED_WARNING = "#de2929";
const SUCCESS_GREEN = "#22c55e";
// Dynamic debug setting - will be loaded from storage
let FORCE_DEBUG = true;
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
let CONFIG;

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

	if (level === "debug") {
		console.log("[UsageTracker]", ...args);
	} else if (level === "warn") {
		console.warn("[UsageTracker]", ...args);
	} else if (level === "error") {
		console.error("[UsageTracker]", ...args);
	} else {
		console.log("[UsageTracker]", ...args);
	}

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
	const modelSelector = await waitForElement(document, CONFIG.SELECTORS.MODEL_PICKER, maxWait);
	if (!modelSelector) return undefined;

	let fullModelName = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';
	if (!fullModelName || fullModelName === 'default') return undefined;

	fullModelName = fullModelName.toLowerCase();
	const modelTypes = CONFIG.MODELS

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

// Helper function to find sidebar containers
async function findSidebarContainers() {
	// First find the nav element
	const sidebarNav = document.querySelector(CONFIG.SELECTORS.SIDEBAR_NAV);
	if (!sidebarNav) {
		await Log("error", 'Could not find sidebar nav');
		return null;
	}

	// Look for the main container that holds all sections
	const containerWrapper = sidebarNav.querySelector('.flex.flex-grow.flex-col.overflow-y-auto')
	const containers = containerWrapper?.querySelectorAll('.flex-1.relative');
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
		this.bar.style.background = total >= maxTokens * CONFIG.WARNING.PERCENT_THRESHOLD ? RED_WARNING : BLUE_HIGHLIGHT;
		this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} credits (${percentage.toFixed(1)}%)`;
	}
}

// Message handlers for background script requests
browser.runtime.onMessage.addListener(async (message) => {
	if (message.type === 'getActiveModel') {
		const currModel = await getCurrentModel();
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
				if (styleData) styleId = styleData.styleKey;
			} catch (e) {
				await Log("error", 'Failed to parse stored style:', e);
			}
		}
		return Promise.resolve({ styleId });
	}
});

// Style injection
async function injectStyles() {
	if (document.getElementById('ut-styles')) return;
	try {
		const cssContent = await fetch(browser.runtime.getURL('tracker-styles.css')).then(r => r.text());
		const style = document.createElement('link');
		style.rel = 'stylesheet';
		style.id = 'ut-styles';
		style.href = `data:text/css;charset=utf-8,${encodeURIComponent(cssContent)}`;
		document.head.appendChild(style);
	} catch (error) {
		await Log("error", 'Failed to load tracker styles:', error);
	}
}

// Main initialization
async function initExtension() {
	if (window.claudeTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	await injectStyles();
	CONFIG = await sendBackgroundMessage({ type: 'getConfig' });
	await Log("Config received...");

	// Wait for login
	const LOGIN_CHECK_DELAY = 10000;
	while (true) {
		const userMenuButton = await waitForElement(document, CONFIG.SELECTORS.USER_MENU_BUTTON, 6000);
		if (userMenuButton) {
			if (userMenuButton.getAttribute('data-script-loaded')) {
				await Log('Script already running, stopping duplicate');
				return;
			}
			userMenuButton.setAttribute('data-script-loaded', true);
			break;
		}

		const initialLoginScreen = document.querySelector(CONFIG.SELECTORS.INIT_LOGIN_SCREEN);
		const verificationLoginScreen = document.querySelector(CONFIG.SELECTORS.VERIF_LOGIN_SCREEN);
		if (!initialLoginScreen && !verificationLoginScreen) {
			await Log("error", 'Neither user menu button nor any login screen found');
			return;
		}
		await Log('Login screen detected, waiting before retry...');
		await sleep(LOGIN_CHECK_DELAY);
	}

	await setupRateLimitMonitoring();

	// Request initial data
	sendBackgroundMessage({ type: 'requestData' });
	sendBackgroundMessage({ type: 'initOrg' });

	await Log('Initialization complete. Ready to track tokens.');
}

// Self-initialize
(async () => {
	try {
		await initExtension();
	} catch (error) {
		await Log("error", 'Failed to initialize Chat Token Counter:', error);
	}
})();