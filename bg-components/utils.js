// Configuration object (moved from constants.json)
const CONFIG = {
	UI_UPDATE_INTERVAL_MS: 3000,
	"OUTPUT_TOKEN_MULTIPLIER": 5,
	"USAGE_CAP": {
		"BASELINE": 1000000,
		"MULTIPLIERS": {
			"claude_free": 0.2,
			"claude_pro": 1,
			"claude_team": 1.5,
			"claude_max_5x": 5,
			"claude_max_20x": 20
		}
	},
	"MODELS": [
		"Opus",
		"Sonnet",
		"Haiku"
	],
	"MODEL_WEIGHTS": {
		"Sonnet": 1,
		"Opus": 5,
		"Haiku": 0.25
	},
	"SYNC_INTERVALS": {
		"none": 30,
		"inactive": 10,
		"active": 4
	},
	"WARNING_THRESHOLD": 0.9,
	"WARNING": {
		"PERCENT_THRESHOLD": 0.9,
		"LENGTH": 50000,
		"COST": 250000
	},
	"SELECTORS": {
		"MODEL_PICKER": "[data-testid=\"model-selector-dropdown\"]",
		"USER_MENU_BUTTON": "button[data-testid=\"user-menu-button\"]",
		"SIDEBAR_NAV": "nav.h-screen.flex",
		"SIDEBAR_CONTAINER": ".overflow-y-auto.overflow-x-hidden.flex.flex-col.gap-4",
		"USAGE_LIMIT_LINK": "a[href*=\"does-claude-pro-have-any-usage-limits\"]",
		"CHAT_MENU": "[data-testid=\"chat-menu-trigger\"]",
		"MODEL_SELECTOR": "[data-testid=\"model-selector-dropdown\"]",
		"INIT_LOGIN_SCREEN": "button[data-testid=\"login-with-google\"]",
		"VERIF_LOGIN_SCREEN": "input[data-testid=\"code\"]"
	},
	"BASE_SYSTEM_PROMPT_LENGTH": 3200,
	"FEATURE_COSTS": {
		"enabled_artifacts_attachments": 2200,
		"preview_feature_uses_artifacts": 8400,
		"preview_feature_uses_latex": 200,
		"enabled_bananagrams": 750,
		"enabled_sourdough": 900,
		"enabled_focaccia": 1350,
		"enabled_web_search": 10250,
		"citation_info": 450,
		"compass_mode": 1000,
		"profile_preferences": 850,
		"enabled_tumeric": 2000
	},
	"DONATION_TOKEN_THRESHOLDS": [
		10000000,
		50000000,
		100000000,
		300000000
	],
	"CACHING_MULTIPLIER": 0.1
};

const isElectron = chrome.action === undefined;
const FORCE_DEBUG = false; // Set to true to force debug mode

browser.storage.local.set({
	force_debug: FORCE_DEBUG // or false, or whatever your debug setting is
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function RawLog(sender, ...args) {
	let level = "debug";

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
				if (arg === null) return 'null';
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

async function Log(...args) {
	await RawLog("utils", ...args);
}

async function containerFetch(url, options = {}, cookieStoreId = null) {
	if (!cookieStoreId || cookieStoreId === "0" || isElectron) {
		return fetch(url, options);
	}

	const headers = options.headers || {};
	headers['X-Container'] = cookieStoreId;
	options.headers = headers;

	return fetch(url, options);
}

async function addContainerFetchListener() {
	if (isElectron) return;
	const stores = await browser.cookies.getAllCookieStores();
	const isFirefoxContainers = stores[0].id === "firefox-default";

	if (isFirefoxContainers) {
		await Log("We're in firefox with containers, registering blocking listener...");
		browser.webRequest.onBeforeSendHeaders.addListener(
			async (details) => {
				// Check for our container header
				const containerStore = details.requestHeaders.find(h =>
					h.name === 'X-Container'
				)?.value;

				if (containerStore) {
					await Log("Processing request for container:", containerStore, "URL:", details.url);

					// Extract domain from URL
					const url = new URL(details.url);
					const domain = url.hostname;

					// Get cookies for this domain from the specified container
					const domainCookies = await browser.cookies.getAll({
						domain: domain,
						storeId: containerStore
					});
					await Log("Found cookies for domain:", domain, "in container:", containerStore);
					if (domainCookies.length > 0) {
						// Create or find the cookie header
						let cookieHeader = details.requestHeaders.find(h => h.name === 'Cookie');
						if (!cookieHeader) {
							cookieHeader = { name: 'Cookie', value: '' };
							details.requestHeaders.push(cookieHeader);
						}

						// Format cookies for the header
						const formattedCookies = domainCookies.map(c => `${c.name}=${c.value}`);
						cookieHeader.value = formattedCookies.join('; ');
					}

					// Remove our custom header
					details.requestHeaders = details.requestHeaders.filter(h =>
						h.name !== 'X-Container'
					);
				}

				return { requestHeaders: details.requestHeaders };
			},
			{ urls: ["<all_urls>"] },
			["blocking", "requestHeaders"]
		);
	}
}


class StoredMap {
	constructor(storageKey) {
		this.storageKey = storageKey;
		this.map = new Map();
		this.initialized = null;
	}

	async ensureInitialized() {
		if (!this.initialized) {
			this.initialized = browser.storage.local.get(this.storageKey).then(stored => {
				this.map = new Map(stored[this.storageKey] || []);
			});
		}
		return this.initialized;
	}

	async set(key, value, lifetime = null) {
		await this.ensureInitialized();
		const storedValue = lifetime ? {
			value,
			expires: Date.now() + lifetime
		} : value;
		this.map.set(key, storedValue);
		await browser.storage.local.set({
			[this.storageKey]: Array.from(this.map)
		});
	}

	async get(key) {
		await this.ensureInitialized();
		const storedValue = this.map.get(key);

		if (!storedValue) return undefined;

		if (!storedValue.expires) return storedValue;

		if (Date.now() > storedValue.expires) {
			await this.delete(key);
			return undefined;
		}

		return storedValue.value;
	}

	async has(key) {
		await this.ensureInitialized();
		const storedValue = this.map.get(key);

		if (!storedValue) return false;

		if (!storedValue.expires) return true;

		if (Date.now() > storedValue.expires) {
			await this.delete(key);
			return false;
		}

		return true;
	}

	async delete(key) {
		await this.ensureInitialized();
		this.map.delete(key);
		await browser.storage.local.set({
			[this.storageKey]: Array.from(this.map)
		});
	}

	async entries() {
		await this.ensureInitialized();
		const entries = [];
		for (const [key, storedValue] of this.map.entries()) {
			if (storedValue.expires && Date.now() > storedValue.expires) {
				await this.delete(key);
				continue;
			}
			entries.push([
				key,
				storedValue.expires ? storedValue.value : storedValue
			]);
		}
		return entries;
	}
}

export {
	CONFIG,
	isElectron,
	sleep,
	RawLog,
	FORCE_DEBUG,
	containerFetch,
	addContainerFetchListener,
	StoredMap
};