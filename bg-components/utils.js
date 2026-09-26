// Always-on logging (common/log/logger.js publishes createLogger/configureLogger on globalThis).
import '../common/log/logger.js';
/* global createLogger, configureLogger */
// The background is the only writer of the debug log; content scripts send it their entries.
configureLogger({ app: 'tracker', prefix: '[UsageTracker]', role: 'background' });

// Configuration object (moved from constants.json)
const CONFIG = {
	"OUTPUT_TOKEN_MULTIPLIER": 4,
	"MODELS": [
		"Fable",
		"Opus",
		"Sonnet",
		"Haiku"
	],
	// Cost weight per API model ID - the model's input price in $/MTok. Priced per model rather
	// than per family because prices vary within a family (Opus 5.5 is cheaper than Opus 5, Sonnet
	// 5 than Sonnet 4.6). Looked up by modelWeight() in shared/dataclasses.js.
	"MODEL_WEIGHTS": {
		"claude-fable-5-1": 10,
		"claude-fable-5": 10,
		"claude-opus-5-5": 4,
		"claude-opus-5": 5,
		"claude-sonnet-5": 2,
		"claude-opus-4-8": 5,
		"claude-opus-4-7": 5,
		"claude-sonnet-4-6": 3,
		"claude-opus-4-6": 5,
		"claude-opus-4-5-20251101": 5,
		"claude-sonnet-4-5-20250929": 3,
		"claude-haiku-4-5-20251001": 1,
		"claude-3-opus-20240229": 15,
	},
	// Weight for a model ID not in MODEL_WEIGHTS (e.g. one released after this build), by family.
	// Each errs toward the family's higher price - over-reporting a cost is the safe direction.
	"FAMILY_MODEL_WEIGHTS": {
		"Fable": 10,
		"Opus": 5,
		"Sonnet": 3,
		"Haiku": 1
	},
	// Weight to use when even the family is unknown. Opus-equivalent, erring high for the same reason.
	"FALLBACK_MODEL_WEIGHT": 5,
	"MODEL_VERSION_MAP": {
		// DOM labels (lowercased) → API model IDs.
		// Matched with startsWith() in insertion order, so a longer label must come above
		// any shorter label that prefixes it ("opus 5.1" above "opus 5").
		"fable 5.1": "claude-fable-5-1",
		"fable 5": "claude-fable-5",
		"opus 5.5": "claude-opus-5-5",
		"opus 5": "claude-opus-5",
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
	// claude.ai's default picker selection depends on the plan: Max lands on Opus,
	// every other tier on Sonnet.
	"DEFAULT_MODEL_VERSION_BY_TIER": {
		"claude_free": "claude-sonnet-5",
		"claude_pro": "claude-sonnet-5",
		"claude_team": "claude-sonnet-5",
		"claude_max_5x": "claude-opus-5-5",
		"claude_max_20x": "claude-opus-5-5"
	},
	// Used only when the tier isn't known yet (e.g. a content script before the first
	// updateUsage arrives). Matches the claude_free row, which is where an unresolvable
	// tier already degrades to.
	"DEFAULT_MODEL_VERSION": "claude-sonnet-5",
	"WARNING_THRESHOLD": 0.9,
	"PEAK_SESSION_MULTIPLIER": 1.5,
	"WARNING": {
		"PERCENT_THRESHOLD": 0.9,
		"LENGTH": 50000,
		"COST": 250000
	},
	"BASE_SYSTEM_PROMPT_LENGTH": 3200,
	"CACHING_MULTIPLIER": 0, // Seems to be free.
	// o200k undercounts against Claude's real tokenizer; this closes the gap. Lives in CONFIG
	// rather than on TokenCounter so the content script gets the same figure via getConfig —
	// sse_bridge.js counts the streamed reply locally and must agree with the background.
	"ESTIMATION_MULTIPLIER": 1.4,
	"EXTRA_USAGE_CACHING_MULTIPLIER": 0.1, // Cache reads cost 10% of input during extra usage
	// How close two reset timestamps must be to count as the same usage window. Lives in CONFIG,
	// like ESTIMATION_MULTIPLIER and for the same reason: content-components/sse_bridge.js gets it
	// via getConfig, and its in-page guard must agree with what storeSseUsage persists in
	// bg-components/claude-api.js. Two copies of this number would drift.
	"SSE_SAME_WINDOW_TOLERANCE_MS": 60 * 1000,
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

	// fableWeekly is half of the (all-model) weekly cap on every tier that has one
	for (const tier of tiers) {
		if (caps[tier]?.weekly != null) {
			caps[tier].fableWeekly ??= caps[tier].weekly / 2;
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
browser.storage.local.remove(['force_debug', 'debug_mode_until']).catch(() => { });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// sender is the module name ("background", "claude-api", ...). Kept as a function for the existing
// `Log = (...args) => RawLog('<module>', ...args)` wrappers.
function RawLog(sender, ...args) {
	createLogger(sender)(...args);
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

	// Drops every expired entry in one pass, with a single write.
	//
	// get/has/entries only evaluate expiry for the keys they happen to touch, and set() serialises
	// the map untouched — so a TTL'd entry whose key is never read again is never reclaimed, and
	// storage grows for as long as new keys keep arriving. Callers that write far more keys than
	// they read back (pendingRequests: one per conversation, read only if you revisit it) need to
	// sweep explicitly.
	async prune() {
		await this.ensureInitialized();
		const now = Date.now();
		let removed = 0;
		for (const [key, storedValue] of [...this.map.entries()]) {
			if (storedValue && storedValue.expires && now > storedValue.expires) {
				this.map.delete(key);
				removed++;
			}
		}
		if (removed > 0) await setStorageValue(this.storageKey, Array.from(this.map));
		return removed;
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
	StoredMap,
	getOrgStorageKey,
	getStorageValue,
	setStorageValue,
	removeStorageValue,
	sendTabMessage,
	messageRegistry
};