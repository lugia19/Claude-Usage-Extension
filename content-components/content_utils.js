'use strict';

// Constants
const BLUE_HIGHLIGHT = "#2c84db";
const RED_WARNING = "#de2929";
const SUCCESS_GREEN = "#22c55e";

const SELECTORS = {
	MODEL_PICKER: '[data-testid="model-selector-dropdown"]',
	CHAT_MENU: '[data-testid="chat-menu-trigger"]',
	MODEL_SELECTOR: '[data-testid="model-selector-dropdown"]',
	INIT_LOGIN_SCREEN: 'button[data-testid="login-with-google"]',
	VERIF_LOGIN_SCREEN: 'input[data-testid="code"]'
};
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
	const modelSelector = await waitForElement(document, SELECTORS.MODEL_PICKER, maxWait);
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

function isCodePage() {
	return window.location.pathname.includes('claude-code-desktop') || window.location.pathname.includes('/code');
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

// Progress bar component
class ProgressBar {
	constructor(options = {}) {
		const {
			width = '100%',
			height = '6px'
		} = options;

		this.container = document.createElement('div');
		this.container.className = 'ut-progress';
		if (width !== '100%') this.container.style.width = width;

		this.track = document.createElement('div');
		this.track.className = 'bg-bg-500 ut-progress-track';
		if (height !== '6px') this.track.style.height = height;

		this.bar = document.createElement('div');
		this.bar.className = 'ut-progress-bar';
		this.bar.style.background = BLUE_HIGHLIGHT;

		this.tooltip = document.createElement('div');
		this.tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';

		this.track.appendChild(this.bar);
		this.container.appendChild(this.track);
		document.body.appendChild(this.tooltip);
		setupTooltip(this.container, this.tooltip, { topOffset: 10 });
	}

	updateProgress(total, maxTokens) {
		const percentage = (total / maxTokens) * 100;
		this.bar.style.width = `${Math.min(percentage, 100)}%`;
		this.bar.style.background = total >= maxTokens * CONFIG.WARNING.PERCENT_THRESHOLD ? RED_WARNING : BLUE_HIGHLIGHT;
		this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} credits (${percentage.toFixed(1)}%)`;
	}

	setMarker(percentage, label) {
		if (!this.marker) {
			this.marker = document.createElement('div');
			this.marker.className = 'ut-weekly-marker';
			this.marker.style.setProperty('--marker-color', RED_WARNING);
			this.container.style.paddingTop = '10px';
			this.container.style.marginTop = '-10px';
			this.container.appendChild(this.marker);

			this.markerTooltip = document.createElement('div');
			this.markerTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
			document.body.appendChild(this.markerTooltip);
			setupTooltip(this.marker, this.markerTooltip);
		}
		this.marker.style.left = `${Math.min(percentage, 100)}%`;
		this.marker.style.display = 'block';
		if (label) this.markerTooltip.textContent = label;
	}

	clearMarker() {
		if (this.marker) {
			this.marker.style.display = 'none';
			this.container.style.paddingTop = '';
			this.container.style.marginTop = '';
		}
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

// ========== PAGE LAYOUTS ==========
// Centralized layout detection and anchor resolution.
// Each layout has match() to detect the page and anchors to find DOM insertion points.
// Checked in order; first match() wins.

function getSidebarRegularAnchor() {
	const sidebarNav = document.querySelector('nav.flex');
	if (!sidebarNav) return null;

	const containerWrapper = sidebarNav.querySelector('.flex.flex-grow.flex-col.overflow-y-auto');
	const containers = containerWrapper?.querySelectorAll('.flex-1.relative');
	if (!containers) return null;

	let mainContainer = containers[containers.length - 1].querySelector('.px-2.mt-4');
	if (!mainContainer) mainContainer = containers[containers.length - 1].querySelector('.px-2.pt-2');
	if (!mainContainer) return null;

	const starredSection = mainContainer.querySelector('div.flex.flex-col.mb-4');
	const prefSwitcher = mainContainer.querySelector('.preset-switcher-section');
	const referenceNode = prefSwitcher || starredSection || mainContainer.firstChild || null;

	return {
		parent: mainContainer,
		referenceNode,
		classes: { remove: ['px-2'] },
	};
}

function getChatAreaRegularAnchor() {
	const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
	if (!modelSelector) return null;

	const toolbarRow = modelSelector.closest('.flex.w-full.items-center');
	if (!toolbarRow) return null;

	return {
		insertAfter: toolbarRow,
		styles: { paddingLeft: '6px', paddingRight: '', paddingBottom: '' },
	};
}

const pageLayouts = {
	chat: {
		match() { return !isCodePage() && !!getConversationId(); },
		anchors: {
			sidebar: getSidebarRegularAnchor,
			chatArea: getChatAreaRegularAnchor,
			titleArea() {
				const chatMenu = document.querySelector(SELECTORS.CHAT_MENU);
				if (!chatMenu) return null;

				const titleLine = chatMenu.closest('.flex.min-w-0.flex-1');
				if (!titleLine) return null;

				const headerRow = titleLine.parentElement;

				if (isMobileView()) {
					if (!headerRow) return null;
					headerRow.classList.add('flex-wrap');

					const headerPadding = parseFloat(getComputedStyle(headerRow).paddingLeft) || 0;
					return {
						parent: headerRow,
						referenceNode: null,
						styles: {
							flexBasis: '100%',
							marginTop: '-36px',
							marginLeft: `-${headerPadding}px`,
							paddingLeft: `${headerPadding + 8}px`,
						},
						classes: { add: ['bg-bg-100'], remove: ['!px-2'] },
					};
				} else {
					titleLine.classList.add('flex-wrap');

					const hasProject = !!titleLine.querySelector('a[href^="/project/"]');
					return {
						parent: titleLine,
						referenceNode: null,
						styles: { flexBasis: '100%' },
						classes: { toggle: { '!px-2': !hasProject } },
					};
				}
			},
		},
	},
	code: {
		match() { return isCodePage(); },
		anchors: {
			sidebar() {
				const sidebarNav = document.querySelector('nav.flex');

				if (sidebarNav) {
					const scrollArea = sidebarNav.querySelector('.flex-grow.overflow-y-auto');
					if (!scrollArea) return null;
					return {
						parent: scrollArea.parentElement,
						referenceNode: scrollArea,
						classes: { add: ['px-2'] },
					};
				}

				// Standalone code sidebar (no nav element)
				const codeLink = document.querySelector('a[href="/code"]');
				if (!codeLink) return null;

				const sidebarRoot = codeLink.closest('.flex.flex-col.h-full.bg-bg-100');
				if (!sidebarRoot) return null;

				const scrollArea = sidebarRoot.querySelector('.overflow-y-auto.overflow-x-hidden');
				if (!scrollArea) return null;

				const outerWrapper = scrollArea.parentElement.parentElement;
				return {
					parent: outerWrapper,
					referenceNode: outerWrapper.firstElementChild,
					classes: { add: ['px-2'] },
				};
			},
			chatArea() {
				const modelSelector = document.querySelector(SELECTORS.MODEL_SELECTOR);
				if (!modelSelector) return null;

				const toolbar = modelSelector.closest('.flex.items-center.p-2');
				if (!toolbar) return null;

				return {
					insertAfter: toolbar,
					styles: { paddingLeft: '8px', paddingRight: '8px', paddingBottom: '4px' },
				};
			},
		},
	},
	home: {
		match() { return !isCodePage() && !getConversationId(); },
		anchors: {
			sidebar: getSidebarRegularAnchor,
			chatArea: getChatAreaRegularAnchor,
		},
	},
};

const LayoutManager = {
	detectLayout() {
		for (const [name, layout] of Object.entries(pageLayouts)) {
			if (layout.match()) return { name, ...layout };
		}
		return null;
	},
	getAnchor(anchorName) {
		const layout = this.detectLayout();
		const anchorFn = layout?.anchors?.[anchorName];
		if (!anchorFn) return null;
		return anchorFn();
	},
};

function mountToAnchor(element, anchor) {
	let needsInsert;
	if (anchor.insertAfter) {
		needsInsert = anchor.insertAfter.nextElementSibling !== element;
	} else if (anchor.referenceNode) {
		needsInsert = element.nextElementSibling !== anchor.referenceNode
			|| element.parentElement !== anchor.parent;
	} else {
		needsInsert = element.parentElement !== anchor.parent;
	}

	if (needsInsert) {
		if (anchor.insertAfter) {
			anchor.insertAfter.after(element);
		} else {
			anchor.parent.insertBefore(element, anchor.referenceNode || null);
		}
	}

	if (anchor.styles) Object.assign(element.style, anchor.styles);
	if (anchor.classes?.add) element.classList.add(...anchor.classes.add);
	if (anchor.classes?.remove) element.classList.remove(...anchor.classes.remove);
	if (anchor.classes?.toggle) {
		for (const [cls, force] of Object.entries(anchor.classes.toggle)) {
			element.classList.toggle(cls, force);
		}
	}
	return true;
}

// Main initialization
async function initExtension() {
	if (window.claudeTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.claudeTrackerInstance = true;

	// Clean up any leftover UI elements from a previous instance (e.g. extension toggled off/on)
	document.querySelectorAll('[class*="ut-"]').forEach(el => el.remove());
	const oldStyles = document.getElementById('ut-styles');
	if (oldStyles) oldStyles.remove();

	await injectStyles();
	CONFIG = await sendBackgroundMessage({ type: 'getConfig' });
	await Log("Config received...");

	// Wait for login
	const LOGIN_CHECK_DELAY = 10000;
	while (true) {
		let userMenuButton = await waitForElement(document, 'button[data-testid="user-menu-button"]', 6000);
		if (!userMenuButton) userMenuButton = document.querySelector('button[data-testid="code-user-menu-button"]');

		if (userMenuButton) {
			if (userMenuButton.getAttribute('data-script-loaded')) {
				await Log('Script already running, stopping duplicate');
				return;
			}
			userMenuButton.setAttribute('data-script-loaded', true);
			break;
		}

		const initialLoginScreen = document.querySelector(SELECTORS.INIT_LOGIN_SCREEN);
		const verificationLoginScreen = document.querySelector(SELECTORS.VERIF_LOGIN_SCREEN);
		if (!initialLoginScreen && !verificationLoginScreen) {
			await Log("error", 'Neither user menu button nor any login screen found');
			return;
		}
		await Log('Login screen detected, waiting before retry...');
		await sleep(LOGIN_CHECK_DELAY);
	}

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