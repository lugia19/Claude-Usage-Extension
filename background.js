import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';

const tokenizer = GPTTokenizer_o200k_base;
const STORAGE_KEY = "claudeUsageTracker_v5"
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
let conversationLengthCache;
let tokenStorageManager;
let configManager;

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
	await Log("Background received message:", message);
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
	browser.tabs.onCreated.addListener(async (tab) => {
		if (tab.url?.includes('claude.ai')) {
			await updateSyncAlarm(true);
		}
	});

	browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
		if (changeInfo.url?.includes('claude.ai')) {
			await updateSyncAlarm(true);
		}
	});

	browser.tabs.onRemoved.addListener(async () => {
		// Check remaining claude.ai tabs
		const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
		await Log("Remaining tabs:", tabs.length);
		if (tabs.length <= 1) {
			await updateSyncAlarm(false);
		}
	});

	addFirefoxContainerFixListener();
}


//Alarm listeners
browser.alarms.onAlarm.addListener(async (alarm) => {
	await Log("Alarm triggered:", alarm.name);
});

browser.alarms.onAlarm.addListener(async (alarm) => {
	if (!configManager) return
	if (alarm.name === 'refreshConfig') {
		configManager.config = await configManager.getFreshConfig();
	}
});

browser.alarms.onAlarm.addListener(async (alarm) => {
	if (!tokenStorageManager) return;
	await tokenStorageManager.ensureOrgIds();

	if (alarm.name === 'firebaseSync') {
		await tokenStorageManager.syncWithFirebase();
		await updateAllTabs();
	}

	if (alarm.name === 'capHitsSync') {
		await tokenStorageManager.syncCapHits();
	}

	if (alarm.name === 'checkExpiredData') {
		for (const orgId of tokenStorageManager.orgIds) {
			await tokenStorageManager.checkAndCleanExpiredData(orgId);
		}
		await updateAllTabs();
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

browser.alarms.create('firebaseSync', { periodInMinutes: isElectron ? 3 : 15 });

async function updateSyncAlarm(hasActiveTabs) {
	const currentAlarm = await browser.alarms.get('firebaseSync');
	if (hasActiveTabs === undefined) {
		hasActiveTabs = (await browser.tabs.query({ url: "*://claude.ai/*" })).length > 0;
	}
	const desiredInterval = hasActiveTabs ? 3 : 15;
	if (!currentAlarm || currentAlarm.periodInMinutes !== desiredInterval) {
		await browser.alarms.clear('firebaseSync');
		browser.alarms.create('firebaseSync', { periodInMinutes: desiredInterval });
		await Log(`Updated firebaseSync alarm to ${desiredInterval} minutes`);
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

	if (!debugUntil || debugUntil <= now) {
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

function mergeDeep(target, source) {
	for (const key in source) {
		if (source[key] instanceof Object && key in target) {
			target[key] = mergeDeep(target[key], source[key]);
		} else {
			target[key] = source[key];
		}
	}
	return target;
}

async function checkAndSetAPIKey(newKey) {
	if (newKey == "") {
		await browser.storage.local.remove('apiKey');
		return true;
	}
	try {
		const result = await countTokensViaAPI(["Test"], [], null, newKey)
		if (result && result != 0) {
			await browser.storage.local.set({ apiKey: newKey });
			return true;
		}
	} catch (error) {
		await Log("error", "Error setting API key:", error);
		return false;
	}
}

async function getTextTokens(text, estimateOnly) {
	let api_key = (await browser.storage.local.get('apiKey'))?.apiKey
	if (api_key && !estimateOnly) {
		let tempTokens = await countTokensViaAPI([text], [], null)
		if (tempTokens == 0) {
			tempTokens = Math.round(tokenizer.countTokens(text) * 1.2);
		}
		return tempTokens
	} else {
		return Math.round(tokenizer.countTokens(text) * 1.2);
	}
}

async function countTokensViaAPI(userMessages = [], assistantMessages = [], file = null, keyOverride = null) {
	let api_key = keyOverride
	if (!api_key) {
		api_key = (await browser.storage.local.get('apiKey'))?.apiKey
		if (!api_key) {
			return 0;
		}
	}
	try {
		await Log("CALLING API!", userMessages, assistantMessages, file)
		const messages = [];

		if (file && userMessages.length === 0) {
			userMessages.push("1");
		}

		let fileData = null;
		if (file) {
			const fileInfo = await file.uploaderAPI.getUploadedFileAsBase64(file.url);
			const base64Data = fileInfo?.data;
			const mediaType = fileInfo?.media_type;
			if (!base64Data) return 0
			fileData = {
				type: mediaType.startsWith('image/') ? 'image' : 'document',
				source: {
					type: 'base64',
					media_type: mediaType,
					data: base64Data
				}
			};
		}

		const maxLength = Math.max(userMessages.length, assistantMessages.length);
		for (let i = 0; i < maxLength; i++) {
			if (i < userMessages.length) {
				const content = i === 0 && fileData ? [
					fileData,
					{
						type: "text",
						text: userMessages[i]
					}
				] : userMessages[i];

				messages.push({
					role: "user",
					content: content
				});
			}

			if (i < assistantMessages.length) {
				messages.push({
					role: "assistant",
					content: assistantMessages[i]
				});
			}
		}

		const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': api_key,
				'Access-Control-Allow-Origin': '*',
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify({
				messages,
				model: "claude-3-5-sonnet-latest"
			})
		});

		const data = await response.json();
		await Log("API response:", data);
		if (data.error) {
			await Log("error", "API error:", data.error);
			return 0
		}
		return data.input_tokens;
	} catch (error) {
		await Log("error", "Error counting tokens via API:", error);
		return 0
	}
}

async function getTextFromContent(content) {
	let textPieces = [];

	if (content.text) {
		textPieces.push(content.text);
	}
	if (content.input) {
		textPieces.push(JSON.stringify(content.input));
	}
	if (content.content) {
		// Handle nested content array
		if (Array.isArray(content.content)) {
			for (const nestedContent of content.content) {
				textPieces = textPieces.concat(await getTextFromContent(nestedContent));
			}
		}
		// Handle single nested content object
		else if (typeof content.content === 'object') {
			textPieces = textPieces.concat(await getTextFromContent(content.content));
		}
	}
	return textPieces;
}
//#endregion

//#region Manager classes
class Config {
	static instance = null;
	static CONFIG_URL = 'https://raw.githubusercontent.com/lugia19/Claude-Usage-Extension/refs/heads/main/constants.json';

	constructor() {
		if (Config.instance) {
			return Config.instance;
		}
		Config.instance = this;
		this.config = null;
		this.defaultConfig = null;
	}

	async initialize() {
		const localConfig = await (await fetch(browser.runtime.getURL('constants.json'))).json();
		localConfig.MODELS = Object.keys(localConfig.MODEL_CAPS.pro).filter(key => key !== 'default');
		this.defaultConfig = localConfig;
		this.config = await this.getFreshConfig();
	}

	async getFreshConfig() {
		try {
			const response = await fetch(Config.CONFIG_URL);
			if (!response.ok) {
				await Log("warn", 'Using default config');
				return this.defaultConfig;
			}

			const remoteConfig = await response.json();
			const mergedConfig = mergeDeep(this.defaultConfig, remoteConfig);
			mergedConfig.MODELS = Object.keys(mergedConfig.MODEL_CAPS.pro)
				.filter(key => key !== 'default');
			return mergedConfig;
		} catch (error) {
			await Log("warn", 'Error loading remote config:', error);
			return this.defaultConfig;
		}
	}

	async getConfig() {
		if (!this.config) {
			this.config = await this.getFreshConfig();
		}
		return this.config;
	}
}

// Token storage manager
class TokenStorageManager {
	constructor() {
		this.firebase_base_url = "https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app"
		this.isSyncingFirebase = false;
		this.isSyncingCapHits = false;
		this.storageLock = false;
		this.orgIds = undefined;
		this.subscriptionTiers = new StoredMap("subscriptionTiers")
		this.filesTokenCache = new StoredMap("fileTokens")
		this.resetsHit = new StoredMap("resetsHit");
	}

	async ensureOrgIds() {
		if (this.orgIds) return
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
	#getStorageKey(orgId, type) {
		return `${STORAGE_KEY}_${orgId}_${type}`;
	}

	async #setValue(key, value) {
		await browser.storage.local.set({ [key]: value });
		return true;
	}

	async #getValue(key, defaultValue = null) {
		const result = await browser.storage.local.get(key) || {};
		return result[key] ?? defaultValue;
	}

	async syncWithFirebase() {
		if (this.isSyncingFirebase) {
			await Log("Sync already in progress, skipping");
			return;
		}

		this.isSyncingFirebase = true;
		await Log("=== FIREBASE SYNC STARTING ===");
		await this.ensureOrgIds();

		try {
			// Ensure we have a device ID
			let deviceId = await browser.storage.local.get('deviceId');
			if (!deviceId?.deviceId) {
				deviceId = crypto.randomUUID();
				await browser.storage.local.set({ deviceId });
			} else {
				deviceId = deviceId.deviceId;
			}

			for (const orgId of this.orgIds) {
				const localModels = await this.#getValue(this.#getStorageKey(orgId, 'models')) || {};
				const currentHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(localModels)));
				const lastSyncHash = await this.#getValue(this.#getStorageKey(orgId, 'lastSyncHash'));

				// Check if we have local changes
				const currentHashString = Array.from(new Uint8Array(currentHash)).map(b => b.toString(16).padStart(2, '0')).join('')
				const hasLocalChanges = !lastSyncHash || currentHashString !== lastSyncHash;

				// First get last update info but don't download models yet
				const lastUpdateUrl = `${this.firebase_base_url}/users/${orgId}/last_update.json`;
				const response = await fetch(lastUpdateUrl);
				const remoteUpdate = await response.json();
				const remoteDeviceId = remoteUpdate?.deviceId;

				// Get our last download timestamp
				const lastDownloadTime = await this.#getValue(this.#getStorageKey(orgId, 'lastDownloadTime')) || 0;
				const shouldDownload = !remoteDeviceId ||
					(remoteDeviceId !== deviceId && (Date.now() - lastDownloadTime > 5 * 60 * 1000)) ||
					hasLocalChanges ||
					(Date.now() - lastDownloadTime > 9 * 60 * 1000);

				let shouldUpload = false;
				let mergedModels = localModels;

				// If we should download, get the remote data
				if (shouldDownload) {
					await Log("Downloading remote data");
					const modelsUrl = `${this.firebase_base_url}/users/${orgId}/models.json`;
					const modelsResponse = await fetch(modelsUrl);
					const remoteModels = await modelsResponse.json() || {};
					mergedModels = await this.#mergeModelData(localModels, remoteModels);
					await this.#setValue(this.#getStorageKey(orgId, 'lastDownloadTime'), Date.now());
				}

				// Determine if we should upload
				await Log(`Got remote device ID: ${remoteDeviceId} vs local: ${deviceId}`);
				if (!remoteDeviceId) {
					// No remote data - upload immediately
					shouldUpload = true;
					await Log("No remote device ID, will upload:", shouldUpload);
				} else if (remoteDeviceId === deviceId) {
					// Our data - upload every 7 minutes if we have changes
					shouldUpload = hasLocalChanges &&
						(!remoteUpdate.timestamp || (Date.now() - remoteUpdate.timestamp > 7 * 60 * 1000));
					await Log("Our device ID, will upload:", shouldUpload);
				} else {
					// Another device's data - upload immediately if we have changes
					shouldUpload = hasLocalChanges;
					await Log("Different device ID, will upload:", shouldUpload);
				}

				// Upload if needed
				if (shouldUpload) {
					await Log("Uploading data and updating device ID");
					const modelsUrl = `${this.firebase_base_url}/users/${orgId}/models.json`;
					const writeResponse = await fetch(modelsUrl, {
						method: 'PUT',
						body: JSON.stringify(mergedModels)
					});
					if (!writeResponse.ok) {
						throw new Error(`Write failed! status: ${writeResponse.status}`);
					}

					// Update last update info
					await fetch(lastUpdateUrl, {
						method: 'PUT',
						body: JSON.stringify({
							deviceId: deviceId,
							timestamp: Date.now()
						})
					});
				}

				//Always update local data...
				await this.#setValue(this.#getStorageKey(orgId, 'models'), mergedModels);
				await this.#setValue(this.#getStorageKey(orgId, 'lastSyncHash'), currentHashString);
			}

			await Log("=== SYNC COMPLETED SUCCESSFULLY ===");
		} catch (error) {
			await Log("error", '=== SYNC FAILED ===');
			await Log("error", 'Error details:', error);
			await Log("error", 'Stack:', error.stack);
		} finally {
			this.isSyncingFirebase = false;
		}
	}

	//Just a helper method to merge the data
	async #mergeModelData(localModels = {}, firebaseModels = {}) {
		await Log("MERGING...")
		const merged = {};
		const allModelKeys = new Set([
			...Object.keys(localModels),
			...Object.keys(firebaseModels)
		]);

		const currentTime = new Date().getTime();

		allModelKeys.forEach(async model => {
			const local = localModels[model];
			const remote = firebaseModels[model];

			if (!remote) {
				merged[model] = local;
			} else if (!local) {
				merged[model] = remote;
			} else {
				// If reset times match, take the highest counts as before
				if (local.resetTimestamp === remote.resetTimestamp) {
					await Log("TIMESTAMP MATCHES, TAKING HIGHEST COUNTS!")
					merged[model] = {
						total: Math.max(local.total, remote.total),
						messageCount: Math.max(local.messageCount, remote.messageCount),
						resetTimestamp: local.resetTimestamp
					};
				} else {
					// Get the earlier and later timestamps
					const earlier = local.resetTimestamp < remote.resetTimestamp ? local : remote;
					const later = local.resetTimestamp < remote.resetTimestamp ? remote : local;

					// If earlier timestamp is still valid (not in past)
					if (earlier.resetTimestamp > currentTime) {
						await Log("EARLIER TIMESTAMP STILL VALID, COMBINING COUNTS!")
						merged[model] = {
							total: earlier.total + later.total,
							messageCount: earlier.messageCount + later.messageCount,
							resetTimestamp: earlier.resetTimestamp
						};
					} else {
						// If earlier timestamp is expired, use later one
						await Log("EARLIER TIMESTAMP EXPIRED, USING LATER ONE!")
						merged[model] = later;
					}
				}
			}
		});
		return merged;
	}

	async getCaps(orgId, api) {
		let subscriptionTier = await this.subscriptionTiers.get(orgId)
		if (!subscriptionTier) {
			subscriptionTier = await api.getSubscriptionTier(orgId)
			//await this.subscriptionTiers.set(orgId, subscriptionTier, 10 * 1000)	//5 seconds (for testing only)
			await this.subscriptionTiers.set(orgId, subscriptionTier, 10 * 60 * 1000)	//10 minutes
		}
		return (await configManager.getConfig()).MODEL_CAPS[subscriptionTier]
	}

	async getCollapsedState() {
		return await this.#getValue(`${STORAGE_KEY}_collapsed`, false);
	}

	async setCollapsedState(isCollapsed) {
		await this.#setValue(`${STORAGE_KEY}_collapsed`, isCollapsed);
	}

	async checkAndCleanExpiredData(orgId) {
		const allModelData = await this.#getValue(this.#getStorageKey(orgId, 'models'));
		if (!allModelData) return;

		const currentTime = new Date();
		let hasChanges = false;

		for (const model in allModelData) {
			const resetTime = new Date(allModelData[model].resetTimestamp);
			if (currentTime >= resetTime) {
				delete allModelData[model];
				hasChanges = true;
			}
		}

		if (hasChanges) {
			await this.#setValue(this.#getStorageKey(orgId, 'models'), allModelData);
		}
	}

	async getModelData(orgId, model) {
		await this.checkAndCleanExpiredData(orgId);
		const allModelData = await this.#getValue(this.#getStorageKey(orgId, 'models'));
		return allModelData?.[model];
	}

	async addTokensToModel(orgId, model, newTokens) {
		// Wait if sync is in progress
		while (this.isSyncingFirebase || this.storageLock) {
			await sleep(50);
		}

		try {
			this.storageLock = true;
			let allModelData = await this.#getValue(this.#getStorageKey(orgId, 'models'), {});
			const stored = allModelData[model];
			const now = new Date();

			// If stored data exists and its reset time has passed, treat as new period
			if (stored && stored.resetTimestamp < now.getTime()) {
				allModelData[model] = {
					total: newTokens,
					messageCount: 1,
					resetTimestamp: this.#getResetFromNow(now).getTime()
				};
			} else {
				// Otherwise add to existing or create new
				allModelData[model] = {
					total: (stored?.total || 0) + newTokens,
					messageCount: (stored?.messageCount || 0) + 1,
					resetTimestamp: stored?.resetTimestamp || this.#getResetFromNow(now).getTime()
				};
			}

			await this.#setValue(this.#getStorageKey(orgId, 'models'), allModelData);
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

	async getUploadedFileTokens(orgId, file, estimateOnly = false, uploaderClaudeAI_API = null) {
		if (await this.filesTokenCache.has(`${orgId}:${file.file_uuid}`)) {
			await Log("Using cached amount for file:", file.file_uuid, "which is", await this.filesTokenCache.get(`${orgId}:${file.file_uuid}`));
			return await this.filesTokenCache.get(`${orgId}:${file.file_uuid}`);
		} else {
			if ((await browser.storage.local.get('apiKey'))?.apiKey && !estimateOnly) {
				try {
					await Log("Using api...")
					let filename = ""
					let fileurl = ""
					filename = file.file_name
					if (file.file_kind === "image") {
						fileurl = file.preview_asset.url
					} else if (file.file_kind === "document") {
						fileurl = file.document_asset.url
					}

					let fileTokens = await countTokensViaAPI([], [], { "url": fileurl, "filename": filename, "uploaderAPI": uploaderClaudeAI_API })
					if (fileTokens === 0) {
						await Log("Falling back to estimate...")
						return this.getUploadedFileTokens(orgId, file, true)
					}
					await this.filesTokenCache.set(`${orgId}:${file.file_uuid}`, fileTokens)
					return fileTokens
				} catch (error) {
					await Log("error", "Error fetching file tokens:", error)
					await Log("Falling back to estimate...")
					return this.getUploadedFileTokens(orgId, file, true)
				}
			} else {
				await Log("Using estimate...")
				if (file.file_kind === "image") {
					const width = file.preview_asset.image_width
					const height = file.preview_asset.image_width
					return Math.min(1600, Math.ceil((width * height) / 750));
				} else if (file.file_kind === "document") {
					return 2250 * file.document_asset.page_count;
				}
			}
		}
		return 0;
	}

	async addReset(orgId, model, api) {
		await sleep(15000); //We want to ensure we get the latest data, which can take a second - so we wait 15.
		const modelData = await this.getModelData(orgId, model);
		if (!modelData) return;

		const key = `${orgId}:${modelData.resetTimestamp}`;
		const cap = (await tokenStorageManager.getCaps(orgId, api))[model]
		const tier = await tokenStorageManager.subscriptionTiers.get(orgId)
		const hasApiKey = !!(await browser.storage.local.get('apiKey'))?.apiKey;

		// Only add if not already present
		if (!(await this.resetsHit.has(key))) {
			await this.resetsHit.set(key, {
				total: `${modelData.total}/${cap}`,
				model: model,
				timestamp: modelData.resetTimestamp,
				tier: tier,
				accurateCount: hasApiKey
			});
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
			for (const [key, value] of (await this.resetsHit.entries())) {
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
					const newKey = `${resetData.model}:${resetData.timestamp}`;
					transformedResets[newKey] = {
						total: resetData.total,
						timestamp: resetData.timestamp,
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


}

// Claude API interface
class ClaudeAPI {
	static async create(cookieStoreId = "0") {
		const api = new ClaudeAPI();
		await Log("Creating API from cookie store:", cookieStoreId);
		api.sessionKey = await api.getSessionKey(cookieStoreId)
		return api;
	}

	constructor() {
		this.baseUrl = 'https://claude.ai/api';
		this.sessionKey = undefined;
	}

	//I love jank...
	async getSessionKey(cookieStoreId = "0") {
		if (isElectron) return undefined;
		const cookie = await browser.cookies.get({
			url: "https://claude.ai",
			name: "sessionKey",
			storeId: cookieStoreId
		});
		return cookie?.value;
	}

	// Core GET method with auth
	async getRequest(endpoint) {
		const response = await fetch(`${this.baseUrl}${endpoint}`, {
			headers: {
				'X-Overwrite-SessionKey': this.sessionKey,	//This is only relevant on firefox, to handle different cookie stores
				'Content-Type': 'application/json'
			},
			method: 'GET'
		});
		return response.json();
	}

	// API methods
	async getUploadedFileAsBase64(url) {
		try {
			await Log(`Starting file download from: https://claude.ai${url}`);
			const response = await fetch(`https://claude.ai${url}`, {
				headers: {
					'X-Overwrite-SessionKey': this.sessionKey
				}
			});

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

	async getSyncText(orgId, syncURI, syncType) {
		if (!syncURI) return "";
		if (syncType != "gdrive") return ""
		let syncText = (await this.getRequest(`/organizations/${orgId}/sync/mcp/drive/document/${syncURI}`))?.text
		await Log("Sync text:", syncText);
		return syncText || "";
	}

	async getStyleTokens(orgId, styleId, tabId) {
		if (!styleId) {
			//Ask the tabId to fetch it from localStorage.
			await Log("Fetching styleId from tab:", tabId);
			const response = await browser.tabs.sendMessage(tabId, {
				action: "getStyleId"
			});
			styleId = response?.styleId;

			// If we still don't have a styleId, return 0
			if (!styleId) return 0;
		}
		const styleData = await this.getRequest(`/organizations/${orgId}/list_styles`);
		let style = styleData?.defaultStyles?.find(style => style.key === styleId);
		if (!style) {
			style = styleData?.customStyles?.find(style => style.uuid === styleId);
		}
		await Log("Got style:", style);
		if (style) {
			return await getTextTokens(style.prompt);
		} else {
			return 0;
		}
	}

	async getProjectTokens(orgId, projectId) {
		//These are all text. No point in employing caching as it'll only take up one request anyway.
		let project_text = "";
		const projectData = await this.getRequest(`/organizations/${orgId}/projects/${projectId}`);

		if (projectData.prompt_template) {
			project_text += projectData.prompt_template;
		}

		const docsData = await this.getRequest(`/organizations/${orgId}/projects/${projectId}/docs`);
		for (const doc of docsData) {
			await Log("Doc:", doc.uuid);
			project_text += doc.content;
			await Log("Doc tokens:", await getTextTokens(doc.content, true));
		}

		const syncData = await this.getRequest(`/organizations/${orgId}/projects/${projectId}/syncs`);
		for (const sync of syncData) {
			await Log("Sync:", sync.uuid);
			const syncText = await this.getSyncText(orgId, sync.config?.uri, sync.type);
			project_text += syncText;
			await Log("Sync tokens:", await getTextTokens(syncText, true));
		}

		let total_tokens = await getTextTokens(project_text);
		await Log(`Total tokens for project ${projectId}: ${total_tokens}`);
		return total_tokens;
	}

	async getConversation(orgId, conversationId, full_tree = false) {
		return this.getRequest(
			`/organizations/${orgId}/chat_conversations/${conversationId}?tree=${full_tree}&rendering_mode=messages&render_all_tools=true`
		);
	}

	async getConversationTokens(orgId, conversationId) {
		const conversationData = await this.getConversation(orgId, conversationId);
		// Count messages by sender
		let humanMessagesCount = 0;
		let assistantMessagesCount = 0;

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

		let baseTokens = 0;
		let lastMessageTokens = 0;

		// Add settings costs
		for (const [setting, enabled] of Object.entries(conversationData.settings)) {
			await Log("Setting:", setting, enabled);
			if (enabled && (await configManager.getConfig()).FEATURE_COSTS[setting]) {
				baseTokens += (await configManager.getConfig()).FEATURE_COSTS[setting];
			}
		}

		let humanMessages = [];
		let assistantMessages = [];

		// Process each message
		for (const message of conversationData.chat_messages) {
			// Files_v2 tokens (handle separately)
			for (const file of message.files_v2) {
				await Log("File_v2:", file.file_name, file.file_uuid)
				baseTokens += await tokenStorageManager.getUploadedFileTokens(orgId, file, false, this)
			}

			let messageContent = [];
			// Process content array
			for (const content of message.content) {
				messageContent = messageContent.concat(await getTextFromContent(content));
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
				messageContent.push(await this.getSyncText(orgId, sync.config?.uri, sync.type));
			}

			if (message === lastMessage) {
				lastMessageTokens = await getTextTokens(messageContent.join(' ')) * ((await configManager.getConfig()).OUTPUT_TOKEN_MULTIPLIER - 1);
			}

			if (message.sender === "human") {
				humanMessages.push(messageContent.join(' '));
			} else {
				assistantMessages.push(messageContent.join(' '));
			}
		}

		let api_key = (await browser.storage.local.get('apiKey'))?.apiKey
		if (api_key) {
			const tempTokens = await countTokensViaAPI(humanMessages, assistantMessages);
			if (tempTokens === 0) {
				baseTokens += await getTextTokens(humanMessages.join(' ')) + await getTextTokens(assistantMessages.join(' '));
			} else {
				baseTokens += tempTokens
			}
		} else {
			baseTokens += await getTextTokens(humanMessages.join(' ')) + await getTextTokens(assistantMessages.join(' '));
		}

		// If part of a project, get project data
		if (conversationData.project_uuid) {
			baseTokens += await this.getProjectTokens(orgId, conversationData.project_uuid);
		}
		await Log(`Total tokens for conversation ${conversationId}: ${baseTokens}`);
		return {
			length: baseTokens,
			cost: baseTokens + lastMessageTokens
		};
	}

	async getProfileTokens() {
		const profileData = await this.getRequest('/account_profile');
		let totalTokens = 0;
		if (profileData.conversation_preferences) {
			totalTokens = await getTextTokens(profileData.conversation_preferences) + 850
		}

		await Log(`Profile tokens: ${totalTokens}`);
		return totalTokens;
	}

	async getSubscriptionTier(orgId) {
		const statsigData = await this.getRequest(`/bootstrap/${orgId}/statsig`);
		await Log("User is Raven?", statsigData.user?.custom?.isRaven);
		await Log("User is Pro?", statsigData.user?.custom?.isPro);
		if (statsigData.user?.custom?.isRaven) {
			return "team"
		}
		if (statsigData.user?.custom?.isPro) {
			return "pro"
		}
		return "free"
	}
}

async function requestActiveOrgId(tab) {
	if (typeof tab !== "number") {
		tab = tab.id
	}
	try {
		const response = await browser.tabs.sendMessage(tab, {
			action: "getOrgID"
		});
		return response?.orgId;
	} catch (error) {
		await Log("error", "Error getting org ID:", error);
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
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
	for (const tab of tabs) {
		const orgId = await requestActiveOrgId(tab);
		const tabData = {
			modelData: {}
		};

		for (const model of (await configManager.getConfig()).MODELS) {
			const modelData = await tokenStorageManager.getModelData(orgId, model);
			if (modelData) {
				tabData.modelData[model] = modelData;
			}
		}

		if (currentCost && currentLength && lengthTabId && tab.id === lengthTabId) {
			tabData.conversationMetrics = {
				cost: currentCost,
				length: currentLength
			};
		}

		browser.tabs.sendMessage(tab.id, {
			type: 'updateUsage',
			data: tabData
		});
	}
}

// Content -> Background messaging
async function handleMessageFromContent(message, sender) {
	await Log("📥 Received message:", message);
	const { orgId } = message;
	const api = await ClaudeAPI.create(sender.tab?.cookieStoreId);
	const response = await (async () => {
		switch (message.type) {
			case 'getCollapsedState':
				return await tokenStorageManager.getCollapsedState();
			case 'setCollapsedState':
				return await tokenStorageManager.setCollapsedState(message.isCollapsed);
			case 'getConfig':
				let config = (await configManager.getConfig());
				return config;
			case 'requestData':
				const baseData = { modelData: {} };
				const { conversationId } = message ?? undefined;

				// Get data for all models
				for (const model of (await configManager.getConfig()).MODELS) {
					const modelData = await tokenStorageManager.getModelData(orgId, model);
					if (modelData) {
						baseData.modelData[model] = modelData;
					}
				}

				if (conversationId) {
					await Log("Requested metrics for conversation:", conversationId);
					const key = `${orgId}:${conversationId}:metrics`;

					if (!conversationLengthCache.has(key)) {
						await Log("Conversation metrics not found, fetching...");
						const tokens = await api.getConversationTokens(orgId, conversationId);
						if (tokens) {
							const profileTokens = await api.getProfileTokens();
							const baseLength = tokens.length + profileTokens + (await configManager.getConfig()).BASE_SYSTEM_PROMPT_LENGTH;
							const messageCost = tokens.cost + profileTokens + (await configManager.getConfig()).BASE_SYSTEM_PROMPT_LENGTH;

							conversationLengthCache.set(key, {
								length: baseLength,
								cost: messageCost
							});
						}
					}

					if (conversationLengthCache.has(key)) {
						baseData.conversationMetrics = conversationLengthCache.get(key);
					}
				}
				return baseData;
			case 'initOrg':
				await tokenStorageManager.addOrgId(orgId);
				return true;
			case 'getPreviousVersion':
				return await browser.storage.local.get('previousVersion').then(data => data.previousVersion);
			case 'setCurrentVersion':
				return await browser.storage.local.set({ previousVersion: message.version });
			case 'getCaps':
				return await tokenStorageManager.getCaps(orgId, api);
			case 'getAPIKey':
				return (await browser.storage.local.get('apiKey'))?.apiKey;
			case 'setAPIKey':
				const { newKey } = message
				return await checkAndSetAPIKey(newKey);
			case 'resetHit':
				const { model } = message;
				tokenStorageManager.addReset(orgId, model, api).catch(async err => {
					await Log("error", 'Adding reset failed:', err);
				});
				return true;
			case 'openDebugPage':
				if (browser.tabs?.create) {
					browser.tabs.create({
						url: browser.runtime.getURL('debug.html')
					});
					return true;
				}
				return 'fallback';
			case 'needsMonkeypatching':
				return isElectron ? INTERCEPT_PATTERNS : false;
			case 'interceptedRequest':
				await Log("Got intercepted request, are we in electron?", isElectron);
				if (!isElectron) return false;
				message.details.tabId = sender.tab.id;
				message.details.cookieStoreId = sender.tab.cookieStoreId;
				onBeforeRequestHandler(message.details);
				return true;
			case 'interceptedResponse':
				await Log("Got intercepted response, are we in electron?", isElectron);
				if (!isElectron) return false;
				message.details.tabId = sender.tab.id;
				message.details.cookieStoreId = sender.tab.cookieStoreId;
				onCompletedHandler(message.details);
				return true;
			case 'getCapModifiers':
				const entries = await capModifiers.entries();
				return Object.fromEntries(entries);

			case 'setCapModifiers':
				for (const [model, value] of Object.entries(message.modifiers)) {
					await capModifiers.set(model, value);
				}
				return true;
		}
	})();
	await Log("📤 Sending response:", response);
	return response;
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
	const api = await ClaudeAPI.create(details.cookieStoreId);

	const tokens = await api.getConversationTokens(orgId, conversationId);
	if (!tokens) {
		return false;
	}



	const profileTokens = await api.getProfileTokens();
	let baseLength = tokens.length + (await configManager.getConfig()).BASE_SYSTEM_PROMPT_LENGTH;
	let messageCost = tokens.cost + profileTokens + (await configManager.getConfig()).BASE_SYSTEM_PROMPT_LENGTH;

	await Log("Current base length:", baseLength);
	await Log("Current message cost:", messageCost);

	conversationLengthCache.set(`${orgId}:${conversationId}:metrics`, {
		length: baseLength,
		cost: messageCost
	});

	const pendingResponse = await pendingResponses.get(responseKey);
	const isNewMessage = pendingResponse !== undefined;

	// The style is procesed _after_ we set the conversationLengthCache, as it can vary.
	// Yes, this means the length display won't update when you change the style. Too bad!
	const styleTokens = await api.getStyleTokens(orgId, pendingResponse?.styleId, tabId);
	messageCost += styleTokens;
	await Log("Added style tokens:", styleTokens);

	if (pendingResponse?.toolDefinitions) {
		let toolTokens = 0
		for (const tool of pendingResponse.toolDefinitions) {
			toolTokens += await getTextTokens(
				`${tool.name} ${tool.description} ${tool.schema}`
			);
		}
		await Log("Added tool definition tokens;:", toolTokens);
		messageCost += toolTokens;
	}

	if (isNewMessage) {
		const model = pendingResponse.model;
		const requestTime = pendingResponse.requestTimestamp;
		const conversationData = await api.getConversation(orgId, conversationId);
		const latestMessageTime = new Date(conversationData.chat_messages[conversationData.chat_messages.length - 1].created_at).getTime();
		if (latestMessageTime < requestTime - 5000) {
			await Log("Message appears to be older than our request, likely an error");
		} else {
			await Log(`=============Adding tokens for model: ${model}, Total tokens: ${messageCost}============`);
			await tokenStorageManager.addTokensToModel(orgId, model, messageCost);
		}
	}

	// Prep base data that goes to all tabs
	const baseData = {
		modelData: {}
	};

	// Get data for all models
	for (const model of (await configManager.getConfig()).MODELS) {
		const modelData = await tokenStorageManager.getModelData(orgId, model);
		if (modelData) {
			baseData.modelData[model] = modelData;
		}
	}

	await updateAllTabs(messageCost, baseLength, tabId);

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
			const modelTypes = Object.keys((await configManager.getConfig()).MODEL_CAPS.pro).filter(key => key !== 'default');
			for (const modelType of modelTypes) {
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
		const api = await ClaudeAPI.create(details.cookieStoreId);
		let subscriptionTier = await api.getSubscriptionTier(orgId)
		await tokenStorageManager.subscriptionTiers.set(orgId, subscriptionTier, 6 * 60 * 60 * 1000)
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

	//Fine to register this here, as it's only relevant for the background script's own requests. No wakeup needed.
	if (isFirefoxContainers) {
		await Log("We're in firefox with containers, registering blocking listener...")
		browser.webRequest.onBeforeSendHeaders.addListener(
			async (details) => {
				const overwriteKey = details.requestHeaders.find(h =>
					h.name === 'X-Overwrite-SessionKey'
				)?.value;

				if (overwriteKey) {
					// Find existing cookie header
					const cookieHeader = details.requestHeaders.find(h => h.name === 'Cookie');
					if (cookieHeader) {
						// Parse existing cookies
						const cookies = cookieHeader.value.split('; ');
						// Extract existing sessionKey if present
						const existingSessionKey = cookies
							.find(c => c.startsWith('sessionKey='))
							?.split('=')[1];

						if (existingSessionKey != overwriteKey) {
							await Log("Modifying session key (request must've been made from non-default container...");
						}

						// Filter out existing sessionKey and add new one
						const filteredCookies = cookies.filter(c => !c.startsWith('sessionKey='));
						filteredCookies.push(`sessionKey=${overwriteKey}`);

						// Rebuild cookie header
						cookieHeader.value = filteredCookies.join('; ');
					}

					// Remove our custom header
					details.requestHeaders = details.requestHeaders.filter(h =>
						h.name !== 'X-Overwrite-SessionKey'
					);
				}
				return { requestHeaders: details.requestHeaders };
			},
			{ urls: ["*://claude.ai/api/*"] },
			["blocking", "requestHeaders"]
		);
	}
}

//#endregion

//#region Variable fill in and initialization
pendingResponses = new StoredMap("pendingResponses"); // conversationId -> {userId, tabId}
capModifiers = new StoredMap('capModifiers');
conversationLengthCache = new Map();
tokenStorageManager = new TokenStorageManager();
configManager = new Config();
configManager.initialize();

isInitialized = true;
for (const handler of pendingHandlers) {
	handler.fn(...handler.args);
}
pendingHandlers = [];
updateSyncAlarm();
Log("Done initializing.")
//#endregion