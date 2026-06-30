// Configuration object (moved from constants.json)
const CONFIG = {
	"OUTPUT_TOKEN_MULTIPLIER": 4,
	"MODELS": [
		"Fable",
		"Opus",
		"Sonnet",
		"Haiku"
	],
	"MODEL_WEIGHTS": {
		"Fable": 10,
		"Opus": 5,
		"Sonnet": 3,
		"Haiku": 1
	},
	"DEFAULT_MODEL": "Opus",
	"MODEL_VERSION_MAP": {
		// DOM labels (lowercased) → API model IDs
		"fable 5": "claude-fable-5",
		"sonnet 5": "claude-sonnet-5",
		"opus 4.8": "claude-opus-4-8",
		"opus 4.7": "claude-opus-4-7",
		"sonnet 4.6": "claude-sonnet-4-6",
		"opus 4.6": "claude-opus-4-6",
		"opus 4.5": "claude-opus-4-5-20251101",
		"sonnet 4.5": "claude-sonnet-4-5-20250929",
		"haiku 4.5": "claude-haiku-4-5-20251001",
		"opus 3": "claude-3-opus-20240229",
	},
	"DEFAULT_MODEL_VERSION": "claude-opus-4-8",
	"WARNING_THRESHOLD": 0.9,
	"PEAK_SESSION_MULTIPLIER": 1.5,
	"WARNING": {
		"PERCENT_THRESHOLD": 0.9,
		"LENGTH": 50000,
		"COST": 250000
	},
	"BASE_SYSTEM_PROMPT_LENGTH": 3200,
	"CACHING_MULTIPLIER": 0, // Seems to be free.
	"EXTRA_USAGE_CACHING_MULTIPLIER": 0.1, // Cache reads cost 10% of input during extra usage
	"TOKEN_CACHING_DURATION_MS": 60 * 60 * 1000, // 1 hour
	"ESTIMATED_CAPS": {
		// I have no idea. This is very napkin math.
		"claude_free": {
			"session": 375000
		},
		"claude_pro": {},
		"claude_team": {},
		// Genuinely mostly just vibes here, this is just a first draft

		// V5.2 will do telemetry to refine these values
		"claude_max_5x": {
			"session": 15 * 10 ** 6,
			"weekly": 150 * 10 ** 6,	// 10 sessions
			"sonnetWeekly": 90 * 10 ** 6 // Same as weekly but compensated for sonnet
		},
		"claude_max_20x": {}
	}
};

function fillEstimatedCaps(caps) {
	// Multipliers relative to pro (the base tier)
	const tierMultipliers = {
		claude_pro: 1,
		claude_team: 1.25, // Just based off the price, no idea how to differentiate between standard and premium team seats
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

const isElectron = chrome.action === undefined || navigator.userAgent.includes("Electron");
const FORCE_DEBUG = true; // Set to true to force debug mode

setStorageValue('force_debug', FORCE_DEBUG);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Debug logs are buffered in memory and flushed to storage on a short debounce, so the hot path never
// blocks on (or repeatedly rewrites) storage — previously every Log() did 2 awaited storage reads + a
// full-array write. Trade-off: up to ~1s of logs can be lost if the background context is torn down
// before a flush — acceptable for debug logging.
let pendingLogEntries = [];
let logFlushScheduled = false;

function scheduleLogFlush() {
	if (logFlushScheduled) return;
	logFlushScheduled = true;
	setTimeout(flushLogs, 1000);
}

async function flushLogs() {
	logFlushScheduled = false;
	if (pendingLogEntries.length === 0) return;
	const batch = pendingLogEntries;
	pendingLogEntries = [];
	// Read fresh and append so we don't clobber logs written by other contexts (e.g. content scripts).
	try {
		const logs = await getStorageValue('debug_logs', []);
		logs.push(...batch);
		while (logs.length > 1000) logs.shift();
		await setStorageValue('debug_logs', logs);
	} catch (e) {
		// Storage full — keep only the most recent so it self-heals; never throw.
		try {
			await setStorageValue('debug_logs', batch.slice(-100));
		} catch (e2) {
			// Give up — better to lose logs than to break anything.
		}
	}
}

async function RawLog(sender, ...args) {
	let level = "debug";

	if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
		level = args.shift();
	}

	// Gate: when FORCE_DEBUG is off, only log within the debug window. When on, skip the storage read.
	if (!FORCE_DEBUG) {
		const debugUntil = await getStorageValue('debug_mode_until');
		if (!debugUntil || debugUntil <= Date.now()) return;
	}

	if (level === "warn") {
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

	let message = args.map(arg => {
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
	}).join(' ');

	// Cap per-entry size so a large payload (e.g. a base64 proxyFetch body) can't blow the storage
	// quota. With the 1000-entry cap this bounds debug_logs well under the 10MB local limit.
	const MAX_LOG_MESSAGE = 2000;
	if (message.length > MAX_LOG_MESSAGE) {
		message = message.slice(0, MAX_LOG_MESSAGE) + `…[truncated ${message.length - MAX_LOG_MESSAGE} chars]`;
	}

	// Append to the in-memory buffer (bounded) and let the debounced flush persist it — no awaited
	// storage I/O in the caller's path.
	pendingLogEntries.push({ timestamp, sender, level, message });
	if (pendingLogEntries.length > 1000) pendingLogEntries.shift();
	scheduleLogFlush();
}

async function Log(...args) {
	await RawLog("utils", ...args);
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
	StoredMap,
	getOrgStorageKey,
	getStorageValue,
	setStorageValue,
	removeStorageValue,
	sendTabMessage,
	messageRegistry
};