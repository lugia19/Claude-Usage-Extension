import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';

const tokenizer = GPTTokenizer_o200k_base;
const STORAGE_KEY = "claudeUsageTracker_v6"
const FORCE_DEBUG = true;
const INTERCEPT_PATTERNS = {
	onBeforeRequest: {
		urls: [
			"*://claude.ai/api/organizations/*/completion",
			"*://claude.ai/api/organizations/*/retry_completion",
			"*://claude.ai/api/settings/billing*"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/completion$",
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/retry_completion$",
			"^https?://claude\\.ai/api/settings/billing"
		]
	},
	onCompleted: {
		urls: [
			"*://claude.ai/api/organizations/*/chat_conversations/*"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*$"
		]
	}
};

//#region Variable declarations
let processingQueue = Promise.resolve();
let pendingResponses;
let capModifiers;
let subscriptionTiersCache;
let tokenStorageManager;
let firebaseManager;
let scheduledNotifications;
let tokenCounter;
let CONFIG = null;

let isInitialized = false;
let pendingHandlers = [];
const isElectron = chrome.action === undefined;

function queueOrExecute(fn, args) {
	if (!isInitialized) {
		pendingHandlers.push({ fn, args });
		return;
	}
	return fn(...args);
}
//#endregion

//#region Listener setup (I hate MV3 - listeners must be initialized here)
//Extension-related listeners:
browser.runtime.onMessage.addListener(async (message, sender) => {
	return queueOrExecute(handleMessageFromContent, [message, sender]);
});

if (!isElectron) {
	browser.action.onClicked.addListener(() => {
		if (browser.contextMenus) {
			// Desktop - open ko-fi
			browser.tabs.create({
				url: "https://ko-fi.com/lugia19"
			});
		} else {
			// Mobile - open debug page
			browser.tabs.create({
				url: browser.runtime.getURL('debug.html')
			});
		}
	});
}


if (browser.contextMenus) {
	browser.runtime.onInstalled.addListener(() => {
		browser.contextMenus.create({
			id: 'openDebugPage',
			title: 'Open Debug Page',
			contexts: ['action']
		});
	});

	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (info.menuItemId === 'openDebugPage') {
			browser.tabs.create({
				url: browser.runtime.getURL('debug.html')
			});
		}
	});
}

// WebRequest listeners
if (!isElectron) {
	browser.webRequest.onBeforeRequest.addListener(
		(details) => queueOrExecute(onBeforeRequestHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onBeforeRequest.urls },
		["requestBody"]
	);

	browser.webRequest.onCompleted.addListener(
		(details) => queueOrExecute(onCompletedHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onCompleted.urls },
		["responseHeaders"]
	);

	// Tab listeners
	// Track focused/visible claude.ai tabs
	browser.tabs.onActivated.addListener(async (activeInfo) => {
		await updateSyncAlarmAndFetchData(activeInfo.tabId);
	});

	// Handle tab updates
	browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		if (changeInfo.url?.includes('claude.ai') || tab.url?.includes('claude.ai')) {
			await updateSyncAlarmAndFetchData(tabId);
		}
	});

	// Handle tab closing
	browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
		await updateSyncAlarmAndFetchData(tabId, true);
	});

	addFirefoxContainerFixListener();
}

//Alarm listeners
browser.alarms.onAlarm.addListener(async (alarm) => {
	await Log("Alarm triggered:", alarm.name);

	if (!tokenStorageManager) tokenStorageManager = new TokenStorageManager();
	await tokenStorageManager.ensureOrgIds();

	if (alarm.name === 'firebaseSync') {
		await firebaseManager.syncWithFirebase();
	}

	if (alarm.name === 'capHitsSync') {
		await firebaseManager.syncCapHits();
	}

	if (alarm.name === 'checkExpiredData') {
		for (const orgId of tokenStorageManager.orgIds) {
			await tokenStorageManager.checkAndCleanExpiredData(orgId);
		}
		await updateAllTabs();
	}

	if (alarm.name.startsWith('notifyReset_')) {
		// Handle notification alarm
		await Log(`Notification alarm triggered: ${alarm.name}`);

		// Create notification
		if (browser.notifications) {
			try {
				await browser.notifications.create({
					type: 'basic',
					iconUrl: browser.runtime.getURL('icon128.png'),
					title: 'Claude Usage Reset',
					message: 'Your Claude usage limit has been reset!'
				});
				await Log(`Notification sent`);
			} catch (error) {
				await Log("error", "Failed to create notification:", error);
			}
		}
	}
});
//#endregion

//#region Alarms
const nextAlarm = new Date();
nextAlarm.setHours(nextAlarm.getHours() + 1, 1, 0, 0);
Log("Creating firebase alarms...");
browser.alarms.create('checkExpiredData', {
	when: nextAlarm.getTime(),
	periodInMinutes: 60
});

async function updateSyncAlarmAndFetchData(sourceTabId, fromRemovedEvent = false) {
	const allClaudeTabs = await browser.tabs.query({ url: "*://claude.ai/*" });
	let state;
	let desiredInterval;

	if (allClaudeTabs.length === 0 || (fromRemovedEvent && allClaudeTabs.length <= 1)) {
		state = 'none';
		desiredInterval = CONFIG.SYNC_INTERVALS.none;
	} else {
		const activeClaudeTabs = await browser.tabs.query({ url: "*://claude.ai/*", active: true });
		if (activeClaudeTabs.length > 0) {
			state = 'active';
			desiredInterval = CONFIG.SYNC_INTERVALS.active;
		} else {
			state = 'inactive';
			desiredInterval = CONFIG.SYNC_INTERVALS.inactive;
		}
	}
	await Log("Current state:", state, "Desired interval:", desiredInterval);

	const currentAlarm = await browser.alarms.get('firebaseSync');
	const isStateChange = !currentAlarm || currentAlarm.periodInMinutes !== desiredInterval;
	//const wasActive = currentAlarm && currentAlarm.periodInMinutes === CONFIG.SYNC_INTERVALS.active;

	if (isStateChange) {
		await browser.alarms.clear('firebaseSync');
		browser.alarms.create('firebaseSync', { periodInMinutes: desiredInterval });
		await Log(`Updated firebaseSync alarm to ${desiredInterval} minutes (state: ${state})`);

		// Trigger sync if we're changing to or from active state
		if (state === 'active' && sourceTabId) {
			await Log("Changed to active, triggering immediate sync! Ensuring we have the orgId first.")
			const orgId = await requestActiveOrgId(sourceTabId);
			await tokenStorageManager.addOrgId(orgId);
			await firebaseManager.syncWithFirebase();
		}
	}
}

browser.alarms.create('capHitsSync', { periodInMinutes: 10 });
Log("Firebase alarms created.");

Log("Initializing config refresh...");
browser.alarms.create('refreshConfig', {
	periodInMinutes: 15
});
Log("Config refresh alarm created.");
//#endregion



//#region Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function Log(...args) {
	const sender = "background"
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
		Error.captureStackTrace(error, logError);
	}
	await Log("error", JSON.stringify(error.stack));
}

//Error logging
if (!FORCE_DEBUG) {
	if (typeof window != "undefined") {
		window.addEventListener('error', async function (event) {
			await logError(event.error);
		});

		window.addEventListener('unhandledrejection', async function (event) {
			await logError(event.reason);
		});
	}


	self.onerror = async function (message, source, lineno, colno, error) {
		await logError(error);
		return false;
	};
}



async function loadConfig() {
	try {
		// Load the local configuration file
		const localConfig = await (await fetch(browser.runtime.getURL('constants.json'))).json();

		// Set the global config
		CONFIG = localConfig;

		await Log("Config loaded:", CONFIG);
		return CONFIG;
	} catch (error) {
		await Log("error", "Failed to load config:", error);
		throw error; // This is critical - we can't proceed without config
	}
}

class TokenCounter {
	constructor() {
		this.tokenizer = GPTTokenizer_o200k_base;
		this.ESTIMATION_MULTIPLIER = 1.2;
		this.fileTokenCache = new StoredMap("fileTokens");
	}

	// Core text counting - the main workhorse
	async countText(text) {
		if (!text) return 0;

		// Try API first if available
		const apiKey = await this.getApiKey();
		if (apiKey) {
			try {
				const tokens = await this.callMessageAPI([text], [], apiKey);
				if (tokens > 0) return tokens;
			} catch (error) {
				await Log("warn", "API token counting failed, falling back to estimation:", error);
			}
		}

		// Fallback to local estimation
		return Math.round(this.tokenizer.countTokens(text) * this.ESTIMATION_MULTIPLIER);
	}

	// Count a conversation's messages
	async countMessages(userMessages, assistantMessages) {
		const apiKey = await this.getApiKey();
		if (apiKey) {
			try {
				const tokens = await this.callMessageAPI(userMessages, assistantMessages, apiKey);
				if (tokens > 0) return tokens;
			} catch (error) {
				await Log("warn", "API message counting failed, falling back to estimation:", error);
			}
		}

		// Fallback: sum all messages using local estimation directly
		let total = 0;
		for (const msg of [...userMessages, ...assistantMessages]) {
			// Use the tokenizer directly to avoid redundant API attempts
			total += Math.round(this.tokenizer.countTokens(msg) * this.ESTIMATION_MULTIPLIER);
		}
		return total;
	}

	// Count file tokens with caching
	async getNonTextFileTokens(fileContent, mediaType, fileMetadata, orgId) {
		// Check cache first
		const cacheKey = `${orgId}:${fileMetadata.file_uuid}`;
		const cachedValue = await this.fileTokenCache.get(cacheKey);
		if (cachedValue !== undefined) {
			await Log(`Using cached token count for file ${fileMetadata.file_uuid}: ${cachedValue}`);
			return cachedValue;
		}

		const apiKey = await this.getApiKey();
		let tokens = 0;

		if (apiKey && fileContent) {
			try {
				tokens = await this.callFileAPI(fileContent, mediaType, apiKey);
				if (tokens > 0) {
					await this.fileTokenCache.set(cacheKey, tokens);
					return tokens;
				}
			} catch (error) {
				await Log("warn", "API file counting failed, falling back to estimation:", error);
			}
		}

		// Fallback to estimation using file metadata
		tokens = this.estimateFileTokens(fileMetadata);
		await this.fileTokenCache.set(cacheKey, tokens);
		return tokens;
	}

	// Estimate file tokens based on type
	estimateFileTokens(fileMetadata) {
		if (fileMetadata.file_kind === "image") {
			const width = fileMetadata.preview_asset.image_width;
			const height = fileMetadata.preview_asset.image_height;
			return Math.min(1600, Math.ceil((width * height) / 750));
		} else if (fileMetadata.file_kind === "document") {
			return 2250 * fileMetadata.document_asset.page_count;
		}
		return 0;
	}

	async callMessageAPI(userMessages, assistantMessages, apiKey) {
		const messages = this.formatMessagesForAPI(userMessages, assistantMessages);

		const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'Access-Control-Allow-Origin': '*',
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify({
				messages,
				model: "claude-3-5-sonnet-latest"
			})
		});

		const data = await response.json();
		if (data.error) {
			throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
		}

		return data.input_tokens || 0;
	}

	// API call for files
	async callFileAPI(fileContent, mediaType, apiKey) {
		const fileData = {
			type: mediaType.startsWith('image/') ? 'image' : 'document',
			source: {
				type: 'base64',
				media_type: mediaType,
				data: fileContent
			}
		};

		const messages = [{
			role: "user",
			content: [
				fileData,
				{ type: "text", text: "1" } // Minimal text required
			]
		}];

		const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'Access-Control-Allow-Origin': '*',
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify({
				messages,
				model: "claude-3-5-sonnet-latest"
			})
		});

		const data = await response.json();
		if (data.error) {
			throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
		}

		return data.input_tokens || 0;
	}

	// Format messages for the API
	formatMessagesForAPI(userMessages, assistantMessages) {
		const messages = [];
		const maxLength = Math.max(userMessages.length, assistantMessages.length);

		for (let i = 0; i < maxLength; i++) {
			if (i < userMessages.length) {
				messages.push({ role: "user", content: userMessages[i] });
			}
			if (i < assistantMessages.length) {
				messages.push({ role: "assistant", content: assistantMessages[i] });
			}
		}

		return messages;
	}

	// Helper to get API key
	async getApiKey() {
		const result = await browser.storage.local.get('apiKey');
		return result?.apiKey || null;
	}

	// Test if API key is valid
	async testApiKey(apiKey) {
		try {
			const tokens = await this.callMessageAPI(["Test"], [], apiKey);
			return tokens > 0;
		} catch (error) {
			await Log("error", "API key test failed:", error);
			return false;
		}
	}
}

async function getTextFromContent(content, includeEphemeral = false, api = null, orgId = null) {
	let textPieces = [];

	if (content.text) {
		textPieces.push(content.text);
	}

	if (content.thinking && includeEphemeral) {
		textPieces.push(content.thinking);
	}

	if (content.input) {
		textPieces.push(JSON.stringify(content.input));
	}
	if (content.content) {
		// Handle nested content array
		if (Array.isArray(content.content)) {
			if (content.type !== "tool_result" || includeEphemeral) {
				// Tool results are ephemeral
				for (const nestedContent of content.content) {
					textPieces = textPieces.concat(await getTextFromContent(nestedContent, includeEphemeral, api, orgId));
				}
			}
		}
		// Handle single nested content object
		else if (typeof content.content === 'object') {
			textPieces = textPieces.concat(await getTextFromContent(content.content, includeEphemeral, api, orgId));
		}
	}

	if (content.type === "knowledge" && includeEphemeral) {
		//"knowledge" type content is ephemeral, like tool results. Only fetch what is needed.
		if (content.url && content.url.length > 0) {
			//We have a knowledge url. Does it contain a gdoc link?
			if (content.url.includes("docs.google.com")) {
				//Get the text from gdrive using the sync endpoint
				if (api && orgId) {
					// Extract the document UUID from metadata.uri or parse it from the URL
					const docUuid = content.metadata?.uri;

					if (docUuid) {
						// Construct the sync object in the format expected by getSyncText
						const syncObj = { type: "gdrive", config: { uri: docUuid } };
						await Log("Fetching Google Drive document content:", content.url, "with sync object:", syncObj);
						try {
							const syncText = await api.getSyncText(syncObj);
							//const syncText = ""
							if (syncText) {
								textPieces.push(syncText);
								await Log("Retrieved Google Drive document content successfully:", syncText);
							}
						} catch (error) {
							await Log("error", "Error fetching Google Drive document:", error);
						}
					} else {
						await Log("error", "Could not extract document UUID from URL or metadata");
					}
				} else {
					await Log("warn", "API or orgId not provided, cannot fetch Google Drive document");
				}
			}
		}
	}

	return textPieces;
}

// Generic container-aware fetch utility
async function containerFetch(url, options = {}, cookieStoreId = null) {
	if (!cookieStoreId || cookieStoreId === "0" || isElectron) {
		// No container specifics needed, just do a regular fetch
		return fetch(url, options);
	}

	// Add our container ID header
	const headers = options.headers || {};
	headers['X-Container'] = cookieStoreId;
	options.headers = headers;

	return fetch(url, options);
}
//#endregion

//#region Manager classes
// Token storage manager
class TokenStorageManager {
	constructor() {
		this.firebase_base_url = "https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app";
		this.storageLock = false;
		this.orgIds = undefined;
		this.filesTokenCache = new StoredMap("fileTokens");
		this.resetsHit = new StoredMap("resetsHit");
		this.projectCache = new StoredMap("projectCache");

		// Create Firebase manager and give it access to this manager
		this.firebaseManager = new FirebaseSyncManager(this);
	}

	async ensureOrgIds() {
		if (this.orgIds) return;
		try {
			const result = await browser.storage.local.get('orgIds');
			this.orgIds = new Set(result.orgIds || []);
		} catch (error) {
			this.orgIds = new Set(); // Return empty Set if there's an error
		}
		return;
	}

	async addOrgId(orgId) {
		await this.ensureOrgIds();
		this.orgIds.add(orgId);
		await browser.storage.local.set({ 'orgIds': Array.from(this.orgIds) });
	}

	// Helper methods for browser.storage
	getStorageKey(orgId, type) {
		return `${STORAGE_KEY}_${orgId}_${type}`;
	}

	async setValue(key, value) {
		await browser.storage.local.set({ [key]: value });
		return true;
	}

	async getValue(key, defaultValue = null) {
		const result = await browser.storage.local.get(key) || {};
		return result[key] ?? defaultValue;
	}

	async mergeModelData(localData = {}, firebaseData = {}) {
		await Log("MERGING...");
		const merged = {};
		const currentTime = new Date().getTime();

		// Extract reset timestamps
		const localReset = localData.resetTimestamp;
		const remoteReset = firebaseData.resetTimestamp;

		// Determine which reset timestamp to use
		if (!remoteReset || (localReset && localReset > remoteReset)) {
			merged.resetTimestamp = localReset;
		} else if (!localReset || remoteReset > localReset) {
			merged.resetTimestamp = remoteReset;
		} else {
			// They're equal, use either
			merged.resetTimestamp = localReset;
		}

		// If the merged reset timestamp is in the past, don't merge any data
		if (merged.resetTimestamp && merged.resetTimestamp < currentTime) {
			await Log("Reset timestamp is in the past, returning empty data");
			return {};
		}

		// Get all model keys (excluding resetTimestamp)
		const allModelKeys = new Set([
			...Object.keys(localData).filter(k => k !== 'resetTimestamp'),
			...Object.keys(firebaseData).filter(k => k !== 'resetTimestamp')
		]);

		// Merge each model's data
		allModelKeys.forEach(model => {
			const local = localData[model];
			const remote = firebaseData[model];

			if (!remote) {
				merged[model] = local;
			} else if (!local) {
				merged[model] = remote;
			} else {
				// Take the highest counts
				merged[model] = {
					total: Math.max(local.total || 0, remote.total || 0),
					messageCount: Math.max(local.messageCount || 0, remote.messageCount || 0)
				};
			}
		});

		await Log("Merged data:", merged);
		return merged;
	}

	async getUsageCap(subscriptionTier) {
		const baseline = CONFIG.USAGE_CAP.BASELINE;
		const tierMultiplier = CONFIG.USAGE_CAP.MULTIPLIERS[subscriptionTier];
		const modifier = await capModifiers.get("global") || 1;
		return baseline * tierMultiplier * modifier;
	}

	async getCollapsedState() {
		return await this.getValue(`${STORAGE_KEY}_collapsed`, false);
	}

	async setCollapsedState(isCollapsed) {
		await this.setValue(`${STORAGE_KEY}_collapsed`, isCollapsed);
	}

	async checkAndCleanExpiredData(orgId) {
		const allModelData = await this.getValue(this.getStorageKey(orgId, 'models'));
		if (!allModelData || !allModelData.resetTimestamp) return;

		const currentTime = new Date().getTime();

		// If the shared reset timestamp has passed, clear all model data
		if (currentTime >= allModelData.resetTimestamp) {
			await this.setValue(this.getStorageKey(orgId, 'models'), {});
		}
	}

	async getModelData(orgId, model) {
		await this.checkAndCleanExpiredData(orgId);
		const allModelData = await this.getValue(this.getStorageKey(orgId, 'models'));
		if (!allModelData || !allModelData[model]) return null;

		// Return the model data with the shared reset timestamp
		return {
			...allModelData[model],
			resetTimestamp: allModelData.resetTimestamp
		};
	}

	async addTokensToModel(orgId, model, newTokens) {
		// Wait if sync is in progress
		while (this.firebaseManager.isSyncing || this.storageLock) {
			await sleep(50);
		}

		try {
			this.storageLock = true;
			let allModelData = await this.getValue(this.getStorageKey(orgId, 'models'), {});
			const stored = allModelData[model];
			const resetTimestamp = allModelData.resetTimestamp;
			const now = new Date();

			// If reset timestamp exists and has passed, reset ALL models
			if (resetTimestamp && resetTimestamp < now.getTime()) {
				// Clear all model data but keep the structure
				const newData = {
					resetTimestamp: this.#getResetFromNow(now).getTime()
				};
				allModelData = newData;
			}

			// Initialize reset timestamp if it doesn't exist
			if (!allModelData.resetTimestamp) {
				allModelData.resetTimestamp = this.#getResetFromNow(now).getTime();
			}

			// Add tokens to the specific model
			allModelData[model] = {
				total: (stored?.total || 0) + newTokens,
				messageCount: (stored?.messageCount || 0) + 1
			};

			await this.setValue(this.getStorageKey(orgId, 'models'), allModelData);
			await browser.storage.local.set({ 'totalTokensTracked': await this.getTotalTokens() + newTokens });
			return allModelData[model];
		} finally {
			this.storageLock = false;
		}
	}

	#getResetFromNow(currentTime) {
		const hourStart = new Date(currentTime);
		hourStart.setMinutes(0, 0, 0);
		const resetTime = new Date(hourStart);
		resetTime.setHours(hourStart.getHours() + 5);
		return resetTime;
	}

	async addReset(orgId, model, cap) {
		await sleep(15000); // We want to ensure we get the latest data, which can take a second - so we wait 15.
		const allModelData = await this.getValue(this.getStorageKey(orgId, 'models'));
		if (!allModelData || !allModelData.resetTimestamp) return;

		const key = `${orgId}:${allModelData.resetTimestamp}`;
		const tier = await this.subscriptionTiersCache.get(orgId);
		const hasApiKey = !!(await browser.storage.local.get('apiKey'))?.apiKey;

		// Calculate weighted total across all models
		let weightedTotal = 0;
		const modelBreakdown = {};

		for (const [modelName, modelData] of Object.entries(allModelData)) {
			if (modelName !== 'resetTimestamp' && modelData?.total) {
				const weight = CONFIG.MODEL_WEIGHTS[modelName] || 1;
				weightedTotal += modelData.total * weight;
				modelBreakdown[modelName] = modelData.total;
			}
		}

		// Only add if not already present
		if (!(await this.resetsHit.has(key))) {
			await this.resetsHit.set(key, {
				total: `${Math.round(weightedTotal)}/${cap}`,
				weightedTotal: Math.round(weightedTotal),
				models: modelBreakdown,  // Add individual model totals
				reset_time: allModelData.resetTimestamp,
				warning_time: new Date().toISOString(),
				tier: tier,
				accurateCount: hasApiKey
			});
		}
	}

	async getTotalTokens() {
		const result = await browser.storage.local.get('totalTokensTracked');
		return result.totalTokensTracked || 0;
	}
}

// Firebase sync manager
class FirebaseSyncManager {
	constructor(tokenStorageManager) {
		this.tokenStorage = tokenStorageManager;
		this.firebase_base_url = "https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app";
		this.isSyncing = false;
		this.isSyncingCapHits = false;
		this.deviceStateMap = new StoredMap("deviceStates"); // Unified map for device states
		this.resetCounters = new StoredMap("resetCounters");
	}

	async triggerReset(orgId) {
		await Log(`Triggering reset for org ${orgId}`);

		// Get current local counter
		const localCounter = await this.resetCounters.get(orgId) || 0;
		const newCounter = localCounter + 1;

		// Update local counter immediately
		await this.resetCounters.set(orgId, newCounter);

		// Clear our own data
		await this.clearOrgData(orgId, true);
		await updateAllTabs();

		// Attempt to update remote counter if we're not a lone device
		const isLoneDevice = await this.checkDevices(orgId);
		if (!isLoneDevice) {
			const resetCounterUrl = `${this.firebase_base_url}/users/${orgId}/reset_counter.json`;
			await fetch(resetCounterUrl, {
				method: 'PUT',
				body: JSON.stringify({
					value: newCounter,
					lastReset: Date.now(),
					triggeredBy: await this.ensureDeviceId()
				})
			});
		}

		await Log(`Reset completed for org ${orgId}, new counter: ${newCounter}`);
		return true;
	}

	async clearOrgData(orgId, cleanRemote = false) {
		// Clear models data
		await this.tokenStorage.setValue(
			this.tokenStorage.getStorageKey(orgId, 'models'),
			{}
		);

		// Clear related data
		await this.tokenStorage.setValue(
			this.tokenStorage.getStorageKey(orgId, 'lastSyncHash'),
			null
		);

		// Write empty data back to Firebase
		if (cleanRemote) {
			await this.uploadData(orgId, {}, await this.ensureDeviceId());
		}

		await Log(`Cleared all data for org ${orgId}`);
	}

	async syncWithFirebase() {
		if (this.isSyncing) {
			await Log("Sync already in progress, skipping");
			return;
		}

		this.isSyncing = true;
		await Log("=== FIREBASE SYNC STARTING ===");

		try {
			await this.tokenStorage.ensureOrgIds();
			const deviceId = await this.ensureDeviceId();
			await Log("Syncing device ID:", deviceId);
			for (const orgId of this.tokenStorage.orgIds) {
				await this.syncSingleOrg(orgId, deviceId);
			}

			await Log("=== SYNC COMPLETED SUCCESSFULLY, UPDATING TABS ===");
			await updateAllTabs();
		} catch (error) {
			await Log("error", '=== SYNC FAILED ===');
			await Log("error", 'Error details:', error);
			await Log("error", 'Stack:', error.stack);
		} finally {
			this.isSyncing = false;
		}
	}

	async checkDevices(orgId) {
		const now = Date.now();
		const deviceState = await this.deviceStateMap.get(orgId) || {
			lastCheckTime: 0,
			isLoneDevice: true,
			lastUploadTime: 0
		};
		if (deviceState.isLoneDevice === undefined) deviceState.isLoneDevice = true;

		const deviceId = await this.ensureDeviceId();
		const devicesUrl = `${this.firebase_base_url}/users/${orgId}/devices_seen.json`;

		// PART 1: Update our own device presence if needed (once per 24h)
		const UPLOAD_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

		if (!deviceState.lastUploadTime || now - deviceState.lastUploadTime > UPLOAD_INTERVAL) {
			await Log(`Updating our device presence for ${orgId} (hasn't been updated in 24h)`);

			// Use PATCH to only update our specific device
			const devicePatchUrl = `${this.firebase_base_url}/users/${orgId}/devices_seen/${deviceId}.json`;

			await fetch(devicePatchUrl, {
				method: 'PATCH',
				body: JSON.stringify({
					timestamp: now
				})
			});

			// Update our last upload time
			deviceState.lastUploadTime = now;
			await this.deviceStateMap.set(orgId, deviceState);
		}

		// PART 2: Check for other devices with adaptive interval
		// Use shorter interval (15min) for lone devices, longer (60min) for multi-device
		const MULTI_DEVICE_CHECK_INTERVAL = 60 * 60 * 1000; // 60 minutes
		const DEVICE_CHECK_INTERVAL = 5 * 60 * 1000;
		const checkInterval = deviceState.isLoneDevice ?
			DEVICE_CHECK_INTERVAL : // 15 minutes for lone devices
			MULTI_DEVICE_CHECK_INTERVAL; // 60 minutes for multi-device setups

		if (now - deviceState.lastCheckTime < checkInterval) {
			await Log(`Using cached device state for ${orgId}: isLoneDevice=${deviceState.isLoneDevice}, last checked ${Math.round((now - deviceState.lastCheckTime) / 1000)}s ago, next check in ${Math.round((checkInterval - (now - deviceState.lastCheckTime)) / 1000)}s`);
			return deviceState.isLoneDevice;
		}

		try {
			// Download all devices
			const response = await fetch(devicesUrl);
			const devices = await response.json() || {};

			// Filter out stale devices (older than 7 days)
			const cutoffTime = now - (7 * 24 * 60 * 60 * 1000);
			let deviceCount = 0;

			for (const [id, data] of Object.entries(devices)) {
				if (data.timestamp > cutoffTime) {
					deviceCount++;
				}
			}

			// Determine if we're the only active device
			const wasLoneDevice = deviceState.isLoneDevice;
			deviceState.isLoneDevice = deviceCount === 1;
			deviceState.lastCheckTime = now;

			await this.deviceStateMap.set(orgId, deviceState);

			await Log(`Device check for ${orgId}: ${deviceCount} active devices, isLoneDevice: ${deviceState.isLoneDevice}, was lone device: ${wasLoneDevice}, next check in ${deviceState.isLoneDevice ? '15min' : '60min'}`);
			return deviceState.isLoneDevice;
		} catch (error) {
			await Log("error", "Error checking devices:", error);
			return false; // Default to false on error (do sync)
		}
	}

	async syncCapHits() {
		if (this.isSyncingCapHits) {
			await Log("Cap hits sync already in progress, skipping");
			return;
		}

		this.isSyncingCapHits = true;
		await Log("=== CAP HITS SYNC STARTING ===");
		try {
			// Group all entries by orgId
			const groupedResets = {};
			for (const [key, value] of (await this.tokenStorage.resetsHit.entries())) {
				const orgId = key.split(':')[0];
				if (!groupedResets[orgId]) {
					groupedResets[orgId] = {};
				}
				groupedResets[orgId][key] = value;
			}
			// Sync each orgId's data to Firebase
			for (const [orgId, resets] of Object.entries(groupedResets)) {
				// Transform the data to use model:timestamp as keys
				const transformedResets = {};
				for (const [_, resetData] of Object.entries(resets)) {
					const newKey = `${resetData.model}:${resetData.reset_time}`;
					transformedResets[newKey] = {
						total: resetData.total,
						reset_time: resetData.reset_time,
						warning_time: resetData.warning_time,
						model: resetData.model,
						tier: resetData.tier,
						accurateCount: resetData.accurateCount
					};
				}
				await Log("Transformed cap hits:", transformedResets)

				const url = `${this.firebase_base_url}/users/${orgId}/cap_hits.json`;
				await Log("Writing cap hits for orgId:", orgId);

				const writeResponse = await fetch(url, {
					method: 'PUT',
					body: JSON.stringify(transformedResets)
				});
				if (!writeResponse.ok) {
					throw new Error(`Write failed! status: ${writeResponse.status}`);
				}
			}
			await Log("=== CAP HITS SYNC COMPLETED SUCCESSFULLY ===");
		} catch (error) {
			await Log("error", '=== CAP HITS SYNC FAILED ===');
			await Log("error", 'Error details:', error);
		} finally {
			this.isSyncingCapHits = false;
		}
	}

	// Helper methods
	async ensureDeviceId() {
		let deviceId = await browser.storage.local.get('deviceId');
		if (!deviceId?.deviceId) {
			deviceId = crypto.randomUUID();
			await browser.storage.local.set({ deviceId });
		} else {
			deviceId = deviceId.deviceId;
		}
		return deviceId;
	}

	async syncResetCounter(orgId) {
		const resetCounterUrl = `${this.firebase_base_url}/users/${orgId}/reset_counter.json`;
		const response = await fetch(resetCounterUrl);
		const remoteData = await response.json();
		const remoteCounter = remoteData?.value || 0;

		// Get local counter
		const localCounter = await this.resetCounters.get(orgId) || 0;

		await Log(`Reset counters for ${orgId}: local=${localCounter}, remote=${remoteCounter}`);

		if (localCounter > remoteCounter) {
			// If our local counter is higher, update the remote
			await Log(`Local reset counter is higher, updating remote to ${localCounter}`);
			await fetch(resetCounterUrl, {
				method: 'PUT',
				body: JSON.stringify({
					value: localCounter,
					lastReset: Date.now(),
					triggeredBy: await this.ensureDeviceId()
				})
			});
			// We've already reset our data when the trigger happened locally
			return true;

		} else if (remoteCounter > localCounter) {
			// If remote counter is higher, we need to reset
			await Log(`Remote reset counter is higher, resetting local data`);

			// Clear our data
			await this.clearOrgData(orgId);

			// Update our local counter
			await this.resetCounters.set(orgId, remoteCounter);

			return true;
		}

		// Counters are equal, no reset needed
		return false;
	}

	async syncSingleOrg(orgId, deviceId) {
		if (!orgId) return
		try {
			// Check if we're the only device
			const isLoneDevice = await this.checkDevices(orgId);

			if (isLoneDevice) {
				await Log(`Lone device for org ${orgId}, skipping sync entirely.`);
				return;
			}

			// Check for resets before doing normal sync
			const resetProcessed = await this.syncResetCounter(orgId);

			// If we just processed a reset, we should still continue with sync
			// to get any other changes, but log it for debugging
			if (resetProcessed) {
				await Log(`Reset processed for org ${orgId}, continuing with sync`);
			}

			// Get local state + remote info
			const localState = await this.prepareLocalState(orgId);
			const lastUpdateInfo = await this.getLastUpdateInfo(orgId);
			await Log("Remote info for org", orgId, ":", lastUpdateInfo);

			// Determine sync strategy
			const strategy = await this.determineSyncStrategy(localState, lastUpdateInfo, deviceId);
			let mergedModels = localState.localModels;

			if (strategy.shouldDownload) {
				mergedModels = await this.downloadAndMerge(orgId, localState.localModels);
			}

			if (strategy.shouldUpload) {
				await this.uploadData(orgId, mergedModels, deviceId);
			}

			// Update local storage
			await this.tokenStorage.setValue(
				this.tokenStorage.getStorageKey(orgId, 'models'),
				mergedModels
			);
			await this.tokenStorage.setValue(
				this.tokenStorage.getStorageKey(orgId, 'lastSyncHash'),
				localState.currentHashString
			);

		} catch (error) {
			await Log("error", `Error syncing org ${orgId}:`, error);
			throw error; // Re-throw to handle it in the caller
		}
	}

	async determineSyncStrategy(localState, remoteInfo, deviceId) {
		const noRemoteData = !remoteInfo.deviceId;
		const isAnotherDeviceData = remoteInfo.deviceId !== deviceId;
		const hasLocalChanges = localState.hasLocalChanges;

		const shouldDownload = noRemoteData || isAnotherDeviceData || hasLocalChanges;

		let shouldUpload = false;
		let uploadReason = "";

		if (noRemoteData) {
			shouldUpload = true;
			uploadReason = "noRemoteData";
		} else {
			shouldUpload = hasLocalChanges;
			uploadReason = "localChanges";
		}

		await Log("Sync decisions:", {
			shouldDownload,
			shouldUpload,
			uploadReason,
			reasons: {
				noRemoteData,
				isAnotherDeviceData,
				hasLocalChanges
			}
		});

		return { shouldDownload, shouldUpload, uploadReason };
	}

	async prepareLocalState(orgId) {
		const localModels = await this.tokenStorage.getValue(
			this.tokenStorage.getStorageKey(orgId, 'models')
		) || {};

		const currentHash = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify(localModels))
		);

		const currentHashString = Array.from(new Uint8Array(currentHash))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		const lastSyncHash = await this.tokenStorage.getValue(
			this.tokenStorage.getStorageKey(orgId, 'lastSyncHash')
		);

		const hasLocalChanges = !lastSyncHash || currentHashString !== lastSyncHash;
		await Log("We have local changes:", hasLocalChanges);
		return {
			localModels,
			currentHashString,
			hasLocalChanges
		};
	}

	async getLastUpdateInfo(orgId) {
		const lastUpdateUrl = `${this.firebase_base_url}/users/${orgId}/last_update.json`;
		const response = await fetch(lastUpdateUrl);
		const remoteUpdate = await response.json();

		return {
			deviceId: remoteUpdate?.deviceId,
			timestamp: remoteUpdate?.timestamp
		};
	}

	async downloadAndMerge(orgId, localModels) {
		await Log("Downloading remote data");
		const usageUrl = `${this.firebase_base_url}/users/${orgId}/usage.json`;
		const usageResponse = await fetch(usageUrl);
		const remoteUsage = await usageResponse.json() || {};

		const mergedModels = await this.tokenStorage.mergeModelData(localModels, remoteUsage);
		return mergedModels;
	}

	async uploadData(orgId, models, deviceId) {
		await Log("Uploading data and updating device ID");

		// Calculate weighted total before uploading
		let weightedTotal = 0;
		for (const [modelName, modelData] of Object.entries(models)) {
			if (modelName !== 'resetTimestamp' && modelData?.total) {
				const weight = CONFIG.MODEL_WEIGHTS[modelName] || 1;
				weightedTotal += modelData.total * weight;
			}
		}

		// Add weighted total to the data structure
		const dataToUpload = {
			...models,
			weightedTotal: Math.round(weightedTotal)
		};

		// Upload models with weighted total
		const usageUrl = `${this.firebase_base_url}/users/${orgId}/usage.json`;
		const writeResponse = await fetch(usageUrl, {
			method: 'PUT',
			body: JSON.stringify(dataToUpload)
		});

		if (!writeResponse.ok) {
			throw new Error(`Write failed! status: ${writeResponse.status}`);
		}

		// Update last update info
		const lastUpdateUrl = `${this.firebase_base_url}/users/${orgId}/last_update.json`;
		await fetch(lastUpdateUrl, {
			method: 'PUT',
			body: JSON.stringify({
				deviceId: deviceId,
				timestamp: Date.now()
			})
		});
	}
}

// Claude API interface
class ClaudeAPI {
	constructor(cookieStoreId, orgId) {
		this.baseUrl = 'https://claude.ai/api';
		this.cookieStoreId = cookieStoreId;
		this.orgId = orgId;
	}

	// Core GET method with auth
	async getRequest(endpoint) {
		const response = await containerFetch(`${this.baseUrl}${endpoint}`, {
			headers: {
				'Content-Type': 'application/json'
			},
			method: 'GET'
		}, this.cookieStoreId);
		return response.json();
	}

	// API methods
	async getUploadedFileAsBase64(url) {
		try {
			await Log(`Starting file download from: https://claude.ai${url}`);
			const response = await containerFetch(`https://claude.ai${url}`, undefined, this.cookieStoreId);
			if (!response.ok) {
				await Log("error", 'Fetch failed:', response.status, response.statusText);
				return null;
			}

			const blob = await response.blob();
			return new Promise((resolve) => {
				const reader = new FileReader();
				reader.onloadend = async () => {
					const base64Data = reader.result.split(',')[1];
					await Log('Base64 length:', base64Data.length);
					resolve({
						data: base64Data,
						media_type: blob.type
					});
				};
				reader.readAsDataURL(blob);
			});

		} catch (e) {
			await Log("error", 'Download error:', e);
			return null;
		}
	}

	async getSyncText(sync) {
		if (!sync) return "";

		const syncType = sync.type;
		await Log("Processing sync:", syncType, sync.uuid || sync.id);

		if (syncType === "gdrive") {
			const uri = sync.config?.uri;
			if (!uri) return "";

			// Use the existing API endpoint for Google Drive
			const response = await containerFetch(`${this.baseUrl}/organizations/${this.orgId}/sync/mcp/drive/document/${uri}`,
				{ headers: { 'Content-Type': 'application/json' } },
				this.cookieStoreId
			);

			if (!response.ok) {
				await Log("warn", `Failed to fetch Google Drive document: ${uri}, status: ${response.status}`);
				return "";
			}

			const data = await response.json();
			const syncText = data?.text || "";
			await Log("Gdrive sync text:", syncText?.substring(0, 100) + (syncText?.length > 100 ? "..." : ""));
			return syncText;
		}
		else if (syncType === "github") {
			try {
				const { owner, repo, branch, filters } = sync.config || {};
				if (!owner || !repo || !branch || !filters?.filters) {
					await Log("warn", "Incomplete GitHub sync config", sync.config);
					return "";
				}

				// For each included file, fetch and aggregate content
				let allContent = "";
				for (const [filePath, action] of Object.entries(filters.filters)) {
					if (action !== "include") continue;

					// Remove leading slash if present
					const cleanPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;

					// Use the GitHub raw URL format directly - redirects will be followed automatically
					const githubUrl = `https://github.com/${owner}/${repo}/raw/refs/heads/${branch}/${cleanPath}`;
					await Log("Fetching GitHub file from:", githubUrl);

					try {
						// Let containerFetch handle everything
						const response = await containerFetch(githubUrl, { method: 'GET' }, this.cookieStoreId);

						if (response.ok) {
							const fileContent = await response.text();
							allContent += fileContent + "\n";
							await Log(`GitHub file fetched: ${filePath}, size: ${fileContent.length} bytes`);
						} else {
							await Log("warn", `Failed to fetch GitHub file: ${githubUrl}, status: ${response.status}`);
						}
					} catch (error) {
						await Log("error", `Error fetching GitHub file: ${githubUrl}`, error);
					}
				}

				return allContent;
			} catch (error) {
				await Log("error", "Error processing GitHub sync source:", error);
				return "";
			}
		}

		// Unsupported sync type
		await Log("warn", `Unsupported sync type: ${syncType}`);
		return "";
	}

	async getStyleTokens(styleId, tabId) {
		if (!styleId) {
			//Ask the tabId to fetch it from localStorage.
			await Log("Fetching styleId from tab:", tabId);
			const response = await sendTabMessage(tabId, {
				action: "getStyleId"
			});
			styleId = response?.styleId;

			// If we still don't have a styleId, return 0
			if (!styleId) return 0;
		}
		const styleData = await this.getRequest(`/organizations/${this.orgId}/list_styles`);
		let style = styleData?.defaultStyles?.find(style => style.key === styleId);
		if (!style) {
			style = styleData?.customStyles?.find(style => style.uuid === styleId);
		}
		await Log("Got style:", style);
		if (style) {
			return await tokenCounter.countText(style.prompt);
		} else {
			return 0;
		}
	}

	async getProjectTokens(projectId) {
		const projectStats = await this.getRequest(`/organizations/${this.orgId}/projects/${projectId}/kb/stats`);
		const projectSize = projectStats.use_project_knowledge_search ? 0 : projectStats.knowledge_size;

		// Check cache
		const cachedAmount = await tokenStorageManager.projectCache.get(projectId) || -1;
		const isCached = cachedAmount == projectSize;

		// Update cache with 1 hour TTL
		await tokenStorageManager.projectCache.set(projectId, projectSize, 60 * 60 * 1000);

		// Return discounted tokens if cached
		return Math.round(isCached ? projectSize * CONFIG.CACHING_MULTIPLIER : projectSize);
	}


	async getUploadedFileTokens(fileMetadata) {
		// Only fetch content if we have an API key
		const tokenCountingAPIKey = await tokenCounter.getApiKey();
		if (tokenCountingAPIKey && this) {
			try {
				const fileUrl = fileMetadata.file_kind === "image" ?
					fileMetadata.preview_asset.url :
					fileMetadata.document_asset.url;

				const fileInfo = await this.getUploadedFileAsBase64(fileUrl);
				if (fileInfo?.data) {
					return await tokenCounter.getNonTextFileTokens(
						fileInfo.data,
						fileInfo.media_type,
						fileMetadata,
						this.orgId
					);
				}
			} catch (error) {
				await Log("error", "Failed to fetch file content:", error);
			}
		}

		// Fallback to estimation
		return await tokenCounter.getNonTextFileTokens(null, null, fileMetadata, this.orgId);
	}

	async getConversation(conversationId, full_tree = false) {
		return this.getRequest(
			`/organizations/${this.orgId}/chat_conversations/${conversationId}?tree=${full_tree}&rendering_mode=messages&render_all_tools=true`
		);
	}

	async getConversationInfo(conversationId) {
		const conversationData = await this.getConversation(conversationId);
		// Count messages by sender
		let humanMessagesCount = 0;
		let assistantMessagesCount = 0;
		if (!conversationData.chat_messages) return 0;

		const lastMessage = conversationData.chat_messages[conversationData.chat_messages.length - 1];

		for (const message of conversationData.chat_messages) {
			if (message.sender === "human") humanMessagesCount++;
			if (message.sender === "assistant") assistantMessagesCount++;
		}

		// Sanity check
		if (humanMessagesCount === 0 || assistantMessagesCount === 0 || humanMessagesCount !== assistantMessagesCount ||
			!lastMessage || lastMessage.sender !== "assistant") {
			await Log(`Message count mismatch or wrong last sender - Human: ${humanMessagesCount}, Assistant: ${assistantMessagesCount}, Last message sender: ${lastMessage?.sender}`);
			return undefined;
		}

		const latestMessage = conversationData.chat_messages[conversationData.chat_messages.length - 1];
		const messageAge = Date.now() - new Date(latestMessage.created_at).getTime();
		const cacheIsWarm = messageAge < 60 * 60 * 1000; // 1 hour in milliseconds

		let lengthTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH; // Base tokens for system prompt
		let costTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH * CONFIG.CACHING_MULTIPLIER; // Base cost tokens for system prompt


		// Add settings costs
		for (const [setting, enabled] of Object.entries(conversationData.settings)) {
			await Log("Setting:", setting, enabled);
			if (enabled && CONFIG.FEATURE_COSTS[setting]) {
				lengthTokens += CONFIG.FEATURE_COSTS[setting];
				costTokens += CONFIG.FEATURE_COSTS[setting] * CONFIG.CACHING_MULTIPLIER;
			}
		}

		if ("enabled_web_search" in conversationData.settings || "enabled_bananagrams" in conversationData.settings) {
			if (conversationData.settings?.enabled_websearch || conversationData.settings?.enabled_bananagrams) {
				lengthTokens += CONFIG.FEATURE_COSTS["citation_info"];
				costTokens += CONFIG.FEATURE_COSTS["citation_info"] * CONFIG.CACHING_MULTIPLIER;
			}
		}

		let humanMessageData = [];
		let assistantMessageData = [];
		const messageCount = conversationData.chat_messages.length;

		// Process each message
		for (let i = 0; i < messageCount; i++) {
			const message = conversationData.chat_messages[i];
			const isCached = cacheIsWarm && i < (messageCount - 3);	//TODO: This needs to be changed to be an amount of tokens, not messages.

			// Files_v2 tokens (handle separately)
			for (const file of message.files_v2) {
				await Log("File_v2:", file.file_name, file.file_uuid)
				let fileTokens = await this.getUploadedFileTokens(file)
				lengthTokens += fileTokens;
				costTokens += isCached ? fileTokens * CONFIG.CACHING_MULTIPLIER : fileTokens;
			}

			let messageContent = [];
			// Process content array
			for (const content of message.content) {
				//We don't consider the thinking tokens in the length calculation at all, as they don't remain in the context.
				messageContent = messageContent.concat(await getTextFromContent(content, false, this, this.orgId));
			}
			// Attachment tokens
			for (const attachment of message.attachments) {
				await Log("Attachment:", attachment.file_name, attachment.id);
				if (attachment.extracted_content) {
					messageContent.push(attachment.extracted_content);
				}
			}


			// Sync tokens
			for (const sync of message.sync_sources) {
				await Log("Sync source:", sync.uuid)
				messageContent.push(await this.getSyncText(sync));
			}

			if (message === lastMessage) {
				let lastMessageContent = [];
				for (const content of message.content) {
					lastMessageContent = lastMessageContent.concat(await getTextFromContent(content, true, this, this.orgId));
				}
				costTokens += await tokenCounter.countText(lastMessageContent.join(' ')) * CONFIG.OUTPUT_TOKEN_MULTIPLIER;
			}

			if (message.sender === "human") {
				humanMessageData.push({ content: messageContent.join(' '), isCached });
			} else {
				assistantMessageData.push({ content: messageContent.join(' '), isCached });
			}
		}

		const humanMessages = humanMessageData.map(m => m.content);
		const assistantMessages = assistantMessageData.map(m => m.content);

		const tempTokens = await tokenCounter.countMessages(humanMessages, assistantMessages);
		lengthTokens += tempTokens;
		costTokens += tempTokens;

		const cachedHuman = humanMessages.filter(m => m.isCached).map(m => m.content);
		const cachedAssistant = assistantMessageData.filter(m => m.isCached).map(m => m.content);
		if (cachedHuman.length > 0 || cachedAssistant.length > 0) {
			const cachedTokens = await tokenCounter.countMessages(cachedHuman, cachedAssistant);
			// Subtract 90% of cached tokens (leaving 10%)
			costTokens -= cachedTokens * (1 - CONFIG.CACHING_MULTIPLIER);
		}

		// If part of a project, get project data
		if (conversationData.project_uuid) {
			lengthTokens += await this.getProjectTokens(conversationData.project_uuid);
		}

		let conversationModelType = undefined;
		let modelString = "sonnet"
		if (conversationData.model) modelString = conversationData.model.toLowerCase();
		for (const modelType of CONFIG.MODELS) {
			if (modelString.includes(modelType.toLowerCase())) {
				conversationModelType = modelType;
				break;
			}
		}

		await Log(`Total tokens for conversation ${conversationId}: ${lengthTokens} with model ${conversationModelType}`);

		return {
			length: Math.round(lengthTokens),
			cost: Math.round(costTokens),
			model: conversationModelType,
		};
	}

	async getProfileTokens() {
		const profileData = await this.getRequest('/account_profile');
		let totalTokens = 0;
		if (profileData.conversation_preferences) {
			totalTokens = await tokenCounter.countText(profileData.conversation_preferences) + CONFIG.FEATURE_COSTS["profile_preferences"];
		}

		await Log(`Profile tokens: ${totalTokens}`);
		return totalTokens;
	}



	async getSubscriptionTier(skipCache = false) {
		let subscriptionTier = await subscriptionTiersCache.get(this.orgId);
		if (subscriptionTier && !skipCache) return subscriptionTier;

		const statsigData = await this.getRequest(`/bootstrap/${this.orgId}/statsig`);
		const identifier = statsigData.user?.custom?.orgType;
		await Log("User identifier:", identifier);
		if (statsigData.user?.custom?.isRaven) {
			subscriptionTier = "claude_team";	//IDK if this is the actual identifier, so I'm just overriding it based on the old value.
		} else if (identifier === "claude_max") {
			//Need to differentiate between 5x and 20x - fetch the org data
			const orgData = await this.getRequest(`/organizations/${this.orgId}`);
			await Log("Org data for tier check:", orgData);
			if (orgData?.settings?.rate_limit_tier === "default_claude_max_20x") {
				subscriptionTier = "claude_max_20x";
			} else {
				subscriptionTier = "claude_max_5x";
			}
		}
		subscriptionTier = identifier;
		await subscriptionTiersCache.set(this.orgId, subscriptionTier, 60 * 60 * 1000); // 1 hour
		return subscriptionTier;
	}
}

async function requestActiveOrgId(tab) {
	if (typeof tab === "number") {
		tab = await browser.tabs.get(tab);
	}

	try {
		const cookie = await browser.cookies.get({
			name: 'lastActiveOrg',
			url: tab.url,
			storeId: tab.cookieStoreId
		});

		if (cookie?.value) {
			return cookie.value;
		}
	} catch (error) {
		await Log("error", "Error getting cookie directly:", error);
	}

	try {
		const response = await sendTabMessage(tab.id, {
			action: "getOrgID"
		});
		return response?.orgId;
	} catch (error) {
		await Log("error", "Error getting org ID from content script:", error);
		return null;
	}
}

//Simple util class - need to persist the state in storage with caching duration
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

		// If it's not a timed value, return directly
		if (!storedValue.expires) return storedValue;

		// Check expiration
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

		// If it's not a timed value, return directly
		if (!storedValue.expires) return true;

		// Check expiration
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
			// Skip expired entries
			if (storedValue.expires && Date.now() > storedValue.expires) {
				await this.delete(key);
				continue;
			}
			// Add the entry with the actual value for timed entries
			entries.push([
				key,
				storedValue.expires ? storedValue.value : storedValue
			]);
		}

		return entries;
	}
}

//#endregion


//#region Messaging

//Updates each tab with its own data
async function updateAllTabs(currentCost = undefined, currentLength = undefined, lengthTabId = undefined) {
	await Log("Updating all tabs with new data");
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });

	for (const tab of tabs) {
		const orgId = await requestActiveOrgId(tab);
		await Log("Updating tab:", tab.id, "with orgId:", orgId);

		// Get the internal model data
		const allModelData = await tokenStorageManager.getValue(
			tokenStorageManager.getStorageKey(orgId, 'models')
		) || {};

		// Transform to frontend format
		let weightedTotal = 0;
		const resetTimestamp = allModelData.resetTimestamp;

		// Calculate weighted total
		for (const [modelName, modelData] of Object.entries(allModelData)) {
			if (modelName !== 'resetTimestamp' && modelName !== 'weightedTotal' && modelData?.total) {
				const weight = CONFIG.MODEL_WEIGHTS[modelName] || 1;
				weightedTotal += modelData.total * weight;
			}
		}

		const tabData = {
			modelData: {
				total: Math.round(weightedTotal),
				resetTimestamp: resetTimestamp,
				modelWeights: CONFIG.MODEL_WEIGHTS
			}
		};

		if (currentCost && currentLength && lengthTabId && tab.id === lengthTabId) {
			tabData.conversationMetrics = {
				cost: currentCost,
				length: currentLength
			};
		}
		await Log("Updating tab with data:", JSON.stringify(tabData));
		sendTabMessage(tab.id, {
			type: 'updateUsage',
			data: tabData
		});
	}
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
		const handler = this.handlers.get(message.type);
		if (!handler) {
			await Log("warn", `No handler for message type: ${message.type}`);
			return null;
		}

		// Extract common parameters
		const orgId = message.orgId;
		const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);

		// Pass common parameters to the handler
		return handler(message, sender, orgId);
	}
}

// Create the registry
const messageRegistry = new MessageHandlerRegistry();

// Simple handlers with inline functions
messageRegistry.register('getConfig', () => CONFIG);
messageRegistry.register('initOrg', (message, sender, orgId) => tokenStorageManager.addOrgId(orgId).then(() => true));
messageRegistry.register('getUsageCap', async (message, sender, orgId) => tokenStorageManager.getUsageCap(await new ClaudeAPI(sender.tab?.cookieStoreId, orgId).getSubscriptionTier()));
messageRegistry.register('resetOrgData', (message, sender, orgId) => firebaseManager.triggerReset(orgId));


messageRegistry.register('rateLimitExceeded', async (message, sender, orgId) => {
	// Only add reset if we actually exceeded the limit
	if (message?.detail?.type === 'exceeded_limit') {
		await Log(`Rate limit exceeded for org ${orgId}, adding reset`);
		const cap = await this.getUsageCap(await new ClaudeAPI(sender.tab?.cookieStoreId, orgId).getSubscriptionTier())
		tokenStorageManager.addReset(orgId, "Sonnet", cap)
			.catch(async err => await Log("error", 'Adding reset failed:', err));
	}

	// Schedule notification if we have a timestamp (for both exceeded and nearing)
	if (message?.detail?.resetsAt) {
		try {
			await Log(`Scheduling notification for org ${orgId} at ${message?.detail?.resetsAt * 1000}`);
			const resetTime = new Date(message?.detail?.resetsAt * 1000); // Convert seconds to milliseconds
			const timestampKey = resetTime.getTime().toString();

			// Check if we already have a notification scheduled for this timestamp
			if (!(await scheduledNotifications.has(timestampKey))) {
				const alarmName = `notifyReset_${orgId}_${timestampKey}`;

				// Schedule the alarm for when the reset occurs
				await browser.alarms.create(alarmName, {
					when: resetTime.getTime()
				});

				// Calculate expiry time: 1 hour after the reset time
				const expiryTime = resetTime.getTime() + (60 * 60 * 1000) - Date.now();

				// Store in our map with expiration 1 hour after reset time
				await scheduledNotifications.set(timestampKey, alarmName, expiryTime);

				await Log(`Scheduled notification alarm: ${alarmName} for ${resetTime.toISOString()}`);
			} else {
				await Log(`Notification already scheduled for timestamp: ${resetTime.toISOString()}`);
			}
		} catch (error) {
			await Log("error", "Failed to schedule notification:", error);
		}
	}

	return true;
});

messageRegistry.register('getAPIKey', () => browser.storage.local.get('apiKey').then(data => data.apiKey));
messageRegistry.register('setAPIKey', async (message) => {
	const newKey = message.newKey;
	if (newKey === "") {
		await browser.storage.local.remove('apiKey');
		return true;
	}

	// Test the new key
	const isValid = await tokenCounter.testApiKey(newKey);

	if (isValid) {
		await browser.storage.local.set({ apiKey: newKey });
		await Log("API key validated and saved");
		return true;
	} else {
		await Log("warn", "API key validation failed");
		return false;
	}
});

messageRegistry.register('getCapModifier', async () => {
	return await capModifiers.get('global') || 1;
});
messageRegistry.register('setCapModifier', async (message) => {
	await capModifiers.set('global', message.modifier);
	return true;
});

messageRegistry.register('needsMonkeypatching', () => isElectron ? INTERCEPT_PATTERNS : false);
async function openDebugPage() {
	if (browser.tabs?.create) {
		browser.tabs.create({
			url: browser.runtime.getURL('debug.html')
		});
		return true;
	}
	return 'fallback';
}
messageRegistry.register(openDebugPage);

// Complex handlers
async function requestData(message, sender, orgId) {
	const { conversationId, modelOverride } = message;
	const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);

	// Get the internal model data
	const allModelData = await tokenStorageManager.getValue(
		tokenStorageManager.getStorageKey(orgId, 'models')
	) || {};

	// Transform to frontend format
	let weightedTotal = 0;
	const resetTimestamp = allModelData.resetTimestamp;

	// Calculate weighted total
	for (const [modelName, modelData] of Object.entries(allModelData)) {
		if (modelName !== 'resetTimestamp' && modelName !== 'weightedTotal' && modelData?.total) {
			const weight = CONFIG.MODEL_WEIGHTS[modelName] || 1;
			weightedTotal += modelData.total * weight;
		}
	}

	const baseData = {
		modelData: {
			total: Math.round(weightedTotal),
			resetTimestamp: resetTimestamp,
			modelWeights: CONFIG.MODEL_WEIGHTS
		}
	};

	if (conversationId) {
		await Log(`Requested metrics for conversation: ${conversationId}`);
		const convoInfo = await api.getConversationInfo(conversationId);
		const profileTokens = await api.getProfileTokens();
		if (convoInfo) {
			const baseLength = convoInfo.length + profileTokens;
			const messageCost = convoInfo.cost + profileTokens * CONFIG.CACHING_MULTIPLIER;	//We assume preferences are always cached
			let currentModel = convoInfo.model;
			if (modelOverride) currentModel = modelOverride;
			if (!currentModel) {
				await Log("No model provided, using Sonnet fallback");
				currentModel = "Sonnet";
			}
			await Log("Fetched conversation from cache, model is:", currentModel);
			const modelWeight = CONFIG.MODEL_WEIGHTS[currentModel];

			// Return length as-is, but weight the cost
			baseData.conversationMetrics = {
				length: baseLength,
				cost: Math.round(messageCost * modelWeight)
			};
		}
	}
	await Log("Returning base data:", baseData);
	return baseData;
}
messageRegistry.register(requestData);

async function interceptedRequest(message, sender) {
	await Log("Got intercepted request, are we in electron?", isElectron);
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onBeforeRequestHandler(message.details);
	return true;
}
messageRegistry.register(interceptedRequest);

async function interceptedResponse(message, sender) {
	await Log("Got intercepted response, are we in electron?", isElectron);
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onCompletedHandler(message.details);
	return true;
}
messageRegistry.register(interceptedResponse);

async function shouldShowDonationNotification(message) {
	const { currentVersion } = message;
	let previousVersion = await browser.storage.local.get('previousVersion').then(data => data.previousVersion);

	// Prepare response object
	const donationInfo = {
		shouldShow: false,
		versionMessage: '',
		patchHighlights: []
	};

	// First install - don't show notification
	if (!previousVersion) {
		await browser.storage.local.set({ previousVersion: currentVersion });
		return donationInfo;
	}

	// Get total tokens tracked
	const totalTokens = await tokenStorageManager.getTotalTokens();
	const tokenThresholds = CONFIG.DONATION_TOKEN_THRESHOLDS;
	const { shownDonationThresholds = [] } = await browser.storage.local.get('shownDonationThresholds');

	const exceededThreshold = tokenThresholds.find(threshold =>
		totalTokens >= threshold && !shownDonationThresholds.includes(threshold)
	);

	// Version change - show update notification with patch notes
	if (previousVersion !== currentVersion) {
		donationInfo.shouldShow = true;
		donationInfo.versionMessage = `Updated from v${previousVersion} to v${currentVersion}!`;

		try {
			const patchNotesFile = await fetch(browser.runtime.getURL('update_patchnotes.txt'));
			if (patchNotesFile.ok) {
				const patchNotesText = await patchNotesFile.text();
				donationInfo.patchHighlights = patchNotesText
					.split('\n')
					.filter(line => line.trim().length > 0);
			}
		} catch (error) {
			await Log("error", "Failed to load patch notes:", error);
		}

		await browser.storage.local.set({ previousVersion: currentVersion });
	}
	else if (exceededThreshold) {
		const tokenMillions = Math.floor(exceededThreshold / 1000000);
		donationInfo.shouldShow = true;
		donationInfo.versionMessage = `You've tracked over ${tokenMillions}M tokens with this extension!`;
		donationInfo.patchHighlights = [
			"Please consider supporting continued development with a donation!"
		];

		// Mark this threshold as shown
		await browser.storage.local.set({
			shownDonationThresholds: [...shownDonationThresholds, exceededThreshold]
		});
	}
	return donationInfo;
}
messageRegistry.register(shouldShowDonationNotification);

// Main handler function
async function handleMessageFromContent(message, sender) {
	return messageRegistry.handle(message, sender);
}
//#endregion



//#region Network handling
async function parseRequestBody(requestBody) {
	if (!requestBody?.raw?.[0]?.bytes) return undefined;

	// Handle differently based on source
	if (requestBody.fromMonkeypatch) {
		const body = requestBody.raw[0].bytes;
		try {
			return JSON.parse(body);
		} catch (e) {
			try {
				const params = new URLSearchParams(body);
				const formData = {};
				for (const [key, value] of params) {
					formData[key] = value;
				}
				return formData;
			} catch (e) {
				return undefined;
			}
		}
	} else {
		// Original webRequest handling
		try {
			const text = new TextDecoder().decode(requestBody.raw[0].bytes);
			return JSON.parse(text);
		} catch (e) {
			return undefined;
		}
	}
}

async function processResponse(orgId, conversationId, responseKey, details) {
	const tabId = details.tabId;
	const api = new ClaudeAPI(details.cookieStoreId, orgId);
	await Log("Processing response...")

	const convoInfo = await api.getConversationInfo(conversationId);
	if (!convoInfo) {
		await Log("warn", "Could not get conversation tokens, exiting...")
		return false;
	}

	const profileTokens = await api.getProfileTokens();
	let baseLength = convoInfo.length;
	let messageCost = convoInfo.cost + profileTokens;

	await Log("Current base length:", baseLength);
	await Log("Current message cost (raw):", messageCost);

	const pendingResponse = await pendingResponses.get(responseKey);
	const isNewMessage = pendingResponse !== undefined;

	// The style is processed _after_ we set the conversationLengthCache, as it can vary.
	const styleTokens = await api.getStyleTokens(pendingResponse?.styleId, tabId);
	messageCost += styleTokens;
	await Log("Added style tokens:", styleTokens);

	if (pendingResponse?.toolDefinitions) {
		let toolTokens = 0;
		for (const tool of pendingResponse.toolDefinitions) {
			toolTokens += await tokenCounter.countText(
				`${tool.name} ${tool.description} ${tool.schema}`
			);
		}
		await Log("Added tool definition tokens:", toolTokens);
		messageCost += toolTokens;
	}

	if (isNewMessage) {
		const model = pendingResponse.model;	//This should be more reliable than using the conversation model.
		const modelWeight = CONFIG.MODEL_WEIGHTS[model] || 1;
		const weightedCost = messageCost * modelWeight;

		await Log(`Raw message cost: ${messageCost}, Model weight: ${modelWeight}, Weighted cost: ${weightedCost}`);

		const requestTime = pendingResponse.requestTimestamp;
		const conversationData = await api.getConversation(conversationId);
		const latestMessageTime = new Date(conversationData.chat_messages[conversationData.chat_messages.length - 1].created_at).getTime();
		if (latestMessageTime < requestTime - 5000) {
			await Log("Message appears to be older than our request, likely an error");
		} else {
			await Log(`=============Adding tokens for model: ${model}, Raw tokens: ${messageCost}, Weighted tokens: ${weightedCost}============`);
			// Store the raw tokens internally (backend will handle weighting for display)
			await tokenStorageManager.addTokensToModel(orgId, model, messageCost);
		}
	}

	// Update the cache with the weighted cost for the current model
	const currentModel = pendingResponse?.model || convoInfo?.model || "Sonnet";
	const modelWeight = CONFIG.MODEL_WEIGHTS[currentModel] || 1;
	const weightedMessageCost = messageCost * modelWeight;

	// Update all tabs with the raw length but weighted cost
	await updateAllTabs(weightedMessageCost, baseLength, tabId);

	return true;
}


// Listen for message sending
async function onBeforeRequestHandler(details) {
	await Log("Intercepted request:", details.url);
	await Log("Intercepted body:", details.requestBody);
	if (details.method === "POST" &&
		(details.url.includes("/completion") || details.url.includes("/retry_completion"))) {
		await Log("Request sent - URL:", details.url);
		const requestBodyJSON = await parseRequestBody(details.requestBody);
		await Log("Request sent - Body:", requestBodyJSON);
		// Extract IDs from URL - we can refine these regexes
		const urlParts = details.url.split('/');
		const orgId = urlParts[urlParts.indexOf('organizations') + 1];
		await tokenStorageManager.addOrgId(orgId);
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

		let model = "Sonnet"; // Default model
		if (requestBodyJSON?.model) {
			const modelString = requestBodyJSON.model.toLowerCase();
			for (const modelType of CONFIG.MODELS) {
				if (modelString.includes(modelType.toLowerCase())) {
					model = modelType;
					await Log("Model from request:", model);
					break;
				}
			}
		}

		const key = `${orgId}:${conversationId}`;
		await Log(`Message sent - Key: ${key}`);
		const styleId = requestBodyJSON?.personalized_styles?.[0]?.key || requestBodyJSON?.personalized_styles?.[0]?.uuid
		await Log("Choosing style between:", requestBodyJSON?.personalized_styles?.[0]?.key, requestBodyJSON?.personalized_styles?.[0]?.uuid)

		// Process tool definitions if present
		const toolDefs = requestBodyJSON?.tools?.filter(tool =>
			tool.name && !['artifacts_v0', 'repl_v0'].includes(tool.type)
		)?.map(tool => ({
			name: tool.name,
			description: tool.description || '',
			schema: JSON.stringify(tool.input_schema || {})
		})) || [];
		await Log("Tool definitions:", toolDefs);

		// Store pending response with all data
		await pendingResponses.set(key, {
			orgId: orgId,
			conversationId: conversationId,
			tabId: details.tabId,
			styleId: styleId,
			model: model,
			requestTimestamp: Date.now(),
			toolDefinitions: toolDefs
		});
	}

	if (details.method === "GET" && details.url.includes("/settings/billing")) {
		await Log("Hit the billing page, let's make sure we get the updated subscription tier in case it was changed...")
		const orgId = await requestActiveOrgId(details.tabId);
		const api = new ClaudeAPI(details.cookieStoreId, orgId);
		await api.getSubscriptionTier(true);
	}
}

async function onCompletedHandler(details) {
	await Log("Intercepted response:", details.url);
	if (details.method === "GET" &&
		details.url.includes("/chat_conversations/") &&
		details.url.includes("tree=True") &&
		details.url.includes("render_all_tools=true")) {
		await Log("Response recieved - URL:", details.url);
		processingQueue = processingQueue.then(async () => {
			const urlParts = details.url.split('/');
			const orgId = urlParts[urlParts.indexOf('organizations') + 1];
			await tokenStorageManager.addOrgId(orgId);
			const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]?.split('?')[0];

			const key = `${orgId}:${conversationId}`;
			const result = await processResponse(orgId, conversationId, key, details);

			if (result && await pendingResponses.has(key)) {
				await pendingResponses.delete(key);
			}
		});
	}
}

// Only relevant for firefox - to support different accounts in different containers
async function addFirefoxContainerFixListener() {
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

//#endregion

//#region Variable fill in and initialization
pendingResponses = new StoredMap("pendingResponses"); // conversationId -> {userId, tabId}
capModifiers = new StoredMap('capModifiers');
subscriptionTiersCache = new StoredMap("subscriptionTiers");
scheduledNotifications = new StoredMap('scheduledNotifications');
tokenCounter = new TokenCounter();
if (!tokenStorageManager) tokenStorageManager = new TokenStorageManager();
firebaseManager = tokenStorageManager.firebaseManager

loadConfig().then(async () => {
	isInitialized = true;
	for (const handler of pendingHandlers) {
		handler.fn(...handler.args);
	}
	pendingHandlers = [];
	updateSyncAlarmAndFetchData();
	Log("Done initializing.")
});
//#endregion