// Configuration object (moved from constants.json)
const CONFIG = {
	"OUTPUT_TOKEN_MULTIPLIER": 5,
	"MODELS": [
		"Opus",
		"Sonnet",
		"Haiku"
	],
	"MODEL_WEIGHTS": {
		"Opus": 5,
		"Sonnet": 3,
		"Haiku": 1
	},
	"WARNING_THRESHOLD": 0.9,
	"WARNING": {
		"PERCENT_THRESHOLD": 0.9,
		"LENGTH": 50000,
		"COST": 250000
	},
	"BASE_SYSTEM_PROMPT_LENGTH": 3200,
	"CACHING_MULTIPLIER": 0.1,
	"TOKEN_CACHING_DURATION_MS": 5 * 60 * 1000, // 5 minutes
	"ESTIMATED_CAPS": {
		"claude_free": {
			"session": 50000,
			"weekly": 150000
		},
		"claude_pro": {},
		// Genuinely mostly just vibes here, this is just a first draft
		// Next update will do telemetry to refine these values
		"claude_max_5x": {
			"session": 5 * 10 ** 6,
			"weekly": 50 * 10 ** 6,
			"sonnetWeekly": 30 * 10 ** 6
		},
		"claude_max_20x": {}
	}
};

function fillEstimatedCaps(caps) {
	// Multipliers relative to pro (the base tier)
	const tierMultipliers = {
		claude_pro: 1,
		claude_max_5x: 5,
		claude_max_20x: 20,
	};

	const tiers = Object.keys(tierMultipliers);

	// For session and weekly: find the first tier that has a value,
	// normalize it back to "pro-equivalent", then fill in the rest.
	// Priority order: pro → 5x → 20x (due to tiers array order)
	for (const key of ['session', 'weekly']) {
		const sourceTier = tiers.find(t => caps[t]?.[key] != null);
		if (!sourceTier) continue;

		const proEquivalent = caps[sourceTier][key] / tierMultipliers[sourceTier];

		for (const tier of tiers) {
			caps[tier] ??= {};
			caps[tier][key] ??= proEquivalent * tierMultipliers[tier];
		}
	}

	// sonnetWeekly only lives on max_5x and max_20x (4x relationship)
	const max5x = caps.claude_max_5x;
	const max20x = caps.claude_max_20x;
	if (max5x && max20x) {
		if (max5x.sonnetWeekly != null && max20x.sonnetWeekly == null) {
			max20x.sonnetWeekly = max5x.sonnetWeekly * 4;
		} else if (max20x.sonnetWeekly != null && max5x.sonnetWeekly == null) {
			max5x.sonnetWeekly = max20x.sonnetWeekly / 4;
		}
	}

	return caps;
}

CONFIG.ESTIMATED_CAPS = fillEstimatedCaps(CONFIG.ESTIMATED_CAPS);
console.log("Final estimated caps:", CONFIG.ESTIMATED_CAPS);

const isElectron = chrome.action === undefined;
const FORCE_DEBUG = true; // Set to true to force debug mode

setStorageValue('force_debug', FORCE_DEBUG);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function RawLog(sender, ...args) {
	let level = "debug";

	if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
		level = args.shift();
	}

	const debugUntil = await getStorageValue('debug_mode_until');
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

	const logs = await getStorageValue('debug_logs', []);
	logs.push(logEntry);

	if (logs.length > 1000) logs.shift();

	await setStorageValue('debug_logs', logs);
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
	const isFirefoxContainers = stores[0]?.id === "firefox-default";

	if (isFirefoxContainers) {
		await Log("We're in firefox with containers, registering blocking listener...");
		browser.webRequest.onBeforeSendHeaders.addListener(
			async (details) => {
				// Check for our container header
				const containerStore = details.requestHeaders.find(h =>
					h.name === 'X-Container'
				)?.value;

				if (containerStore) {
					//await Log("Processing request for container:", containerStore, "URL:", details.url);

					// Extract domain from URL
					const url = new URL(details.url);
					const domain = url.hostname;

					// Get cookies for this domain from the specified container
					const domainCookies = await browser.cookies.getAll({
						domain: domain,
						storeId: containerStore
					});
					//await Log("Found cookies for domain:", domain, "in container:", containerStore);
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
			this.initialized = getStorageValue(this.storageKey, []).then(storedArray => {
				this.map = new Map(storedArray);
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
		await setStorageValue(this.storageKey, Array.from(this.map));
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
		await setStorageValue(this.storageKey, Array.from(this.map));
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

	async clear() {
		this.map.clear();
		await setStorageValue(this.storageKey, []);
	}
}


// Browser storage helpers
function getOrgStorageKey(orgId, type) {
	return `claudeUsageTracker_v6_${orgId}_${type}`;
}

async function setStorageValue(key, value) {
	await browser.storage.local.set({ [key]: value });
	return true;
}

async function getStorageValue(key, defaultValue = null) {
	const result = await browser.storage.local.get(key) || {};
	return result[key] ?? defaultValue;
}

async function removeStorageValue(key) {
	await browser.storage.local.remove(key);
	return true;
}

// Background -> Content messaging
async function sendTabMessage(tabId, message, maxRetries = 10, delay = 100) {
	let counter = maxRetries;
	await Log("Sending message to tab:", tabId, message);
	while (counter > 0) {
		try {
			const response = await browser.tabs.sendMessage(tabId, message);
			await Log("Got response from tab:", response);
			return response;
		} catch (error) {
			if (error.message?.includes('Receiving end does not exist')) {
				await Log("warn", `Tab ${tabId} not ready, retrying...`, error);
				await new Promise(resolve => setTimeout(resolve, delay));
			} else {
				// For any other error, throw immediately
				throw error;
			}
		}
		counter--;
	}
	throw new Error(`Failed to send message to tab ${tabId} after ${maxRetries} retries.`);
}

// Content -> Background messaging
class MessageHandlerRegistry {
	constructor() {
		this.handlers = new Map();
	}

	register(messageTypeOrHandler, handlerFn = null) {
		if (typeof messageTypeOrHandler === 'function') {
			this.handlers.set(messageTypeOrHandler.name, messageTypeOrHandler);
		} else {
			this.handlers.set(messageTypeOrHandler, handlerFn);
		}
	}

	async handle(message, sender) {
		await Log("Background received message:", message.type);
		const handler = this.handlers.get(message.type);
		if (!handler) {
			await Log("warn", `No handler for message type: ${message.type}`);
			return null;
		}

		// Extract common parameters
		const orgId = message.orgId;

		// Pass common parameters to the handler
		return handler(message, sender, orgId);
	}
}
const messageRegistry = new MessageHandlerRegistry();
export {
	CONFIG,
	isElectron,
	sleep,
	RawLog,
	FORCE_DEBUG,
	containerFetch,
	addContainerFetchListener,
	StoredMap,
	getOrgStorageKey,
	getStorageValue,
	setStorageValue,
	removeStorageValue,
	sendTabMessage,
	messageRegistry
};