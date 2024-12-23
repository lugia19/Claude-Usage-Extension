import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';

const tokenizer = GPTTokenizer_o200k_base;

function getTextTokens(text) {
	return Math.round(tokenizer.countTokens(text) * 1.2);
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
//Open the source code on click.
browser.action.onClicked.addListener(() => {
	browser.tabs.create({
		url: "https://ko-fi.com/lugia19"
	});
});

const STORAGE_KEY = "claudeUsageTracker_v5"
const CONFIG_URL = 'https://raw.githubusercontent.com/lugia19/Claude-Usage-Extension/refs/heads/main/constants.json';
const DEBUG_MODE = false


//Helper logging method
function debugLog(...args) {
	if (DEBUG_MODE) {
		console.log(...args);
	}
}

// Helper for merging stuff
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

// Function to get fresh config
async function getFreshConfig() {
	if (!defaultConfig) {
		await initializeConfig();
	}

	try {
		const response = await fetch(CONFIG_URL);
		if (!response.ok) {
			console.warn('Failed to load remote config, using defaults');
			return defaultConfig;
		}

		const remoteConfig = await response.json();
		//debugLog('Loaded remote config:', remoteConfig);
		const mergedConfig = mergeDeep(defaultConfig, remoteConfig);
		mergedConfig.MODELS = Object.keys(mergedConfig.MODEL_CAPS.pro).filter(key => key !== 'default');
		return mergedConfig;
	} catch (error) {
		console.warn('Error loading remote config:', error);
		return defaultConfig;
	}
}


let globalConfig = null;
let defaultConfig = null;
// Setup alarm and initial config
async function initializeConfigRefresh() {
	// Get initial config
	globalConfig = await getFreshConfig();

	// Create alarm to refresh every 10 minutes
	browser.alarms.create('refreshConfig', {
		periodInMinutes: 10
	});
}

// Handle alarm
browser.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name === 'refreshConfig') {
		globalConfig = await getFreshConfig();
	}
});

initializeConfigRefresh();


// Token storage manager
class TokenStorageManager {
	constructor() {
		this.syncInterval = 1; // 1m
		this.isSyncingFirebase = false;
		this.storageLock = false;
		this.orgIds = undefined;
		this.subscriptionTiers = new StoredMap("subscriptionTiers")
		const nextAlarm = new Date();
		nextAlarm.setHours(nextAlarm.getHours() + 1, 1, 0, 0);

		browser.alarms.create('checkExpiredData', {
			when: nextAlarm.getTime(),
			periodInMinutes: 60
		});

		browser.alarms.create('firebaseSync', { periodInMinutes: this.syncInterval });
		//debugLog("Alarm created, syncing every", this.syncInterval, "minutes");
		browser.alarms.onAlarm.addListener(async (alarm) => {
			//debugLog("Alarm triggered:", alarm);
			if (alarm.name === 'firebaseSync') {
				if (!this.orgIds) {
					await this.loadOrgIds();
				}
				await this.syncWithFirebase();
				await updateAllTabs();
			}

			if (alarm.name === 'checkExpiredData') {
				if (!this.orgIds) {
					await this.loadOrgIds();
				}
				for (const orgId of this.orgIds) {
					await this.#checkAndCleanExpiredData(orgId);
				}
				await updateAllTabs();
			}
		});
	}

	async loadOrgIds() {
		try {
			const result = await browser.storage.local.get('orgIds');
			this.orgIds = new Set(result.orgIds || []);
		} catch (error) {
			this.orgIds = new Set(); // Return empty Set if there's an error
		}
		return;
	}

	async addOrgId(orgId) {
		if (!this.orgIds) {
			await this.loadOrgIds();
		}
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
			debugLog("Sync already in progress, skipping");
			return;
		}

		this.isSyncingFirebase = true;
		debugLog("=== FIREBASE SYNC STARTING ===");

		try {
			for (const orgId of this.orgIds) {
				// Get local data
				const localModels = await this.#getValue(this.#getStorageKey(orgId, 'models')) || {};
				debugLog("Local models:", localModels);

				// Get remote data
				const url = `${defaultConfig.FIREBASE_BASE_URL}/users/${orgId}/models.json`;
				debugLog("Fetching from:", url);

				const response = await fetch(url);
				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}
				const firebaseModels = await response.json() || {};
				debugLog("Firebase models:", firebaseModels);

				const mergedModels = this.#mergeModelData(localModels, firebaseModels);
				debugLog("Merged result:", mergedModels);

				// Write merged data back
				debugLog("Writing merged data back to Firebase...");
				const writeResponse = await fetch(url, {
					method: 'PUT',
					body: JSON.stringify(mergedModels)
				});
				if (!writeResponse.ok) {
					throw new Error(`Write failed! status: ${writeResponse.status}`);
				}

				// Update local storage
				debugLog("Updating local storage...");
				await this.#setValue(this.#getStorageKey(orgId, 'models'), mergedModels);
				debugLog("=== SYNC COMPLETED SUCCESSFULLY ===");
			}
		} catch (error) {
			console.error('=== SYNC FAILED ===');
			console.error('Error details:', error);
			console.error('Stack:', error.stack);
		} finally {
			this.isSyncingFirebase = false;
		}
	}

	//Just a helper method to merge the data
	#mergeModelData(localModels = {}, firebaseModels = {}) {
		debugLog("MERGING...")
		const merged = {};
		const allModelKeys = new Set([
			...Object.keys(localModels),
			...Object.keys(firebaseModels)
		]);

		const currentTime = new Date().getTime();

		allModelKeys.forEach(model => {
			const local = localModels[model];
			const remote = firebaseModels[model];

			if (!remote) {
				merged[model] = local;
			} else if (!local) {
				merged[model] = remote;
			} else {
				// If reset times match, take the highest counts as before
				if (local.resetTimestamp === remote.resetTimestamp) {
					debugLog("TIMESTAMP MATCHES, TAKING HIGHEST COUNTS!")
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
						debugLog("EARLIER TIMESTAMP STILL VALID, COMBINING COUNTS!")
						merged[model] = {
							total: earlier.total + later.total,
							messageCount: earlier.messageCount + later.messageCount,
							resetTimestamp: earlier.resetTimestamp
						};
					} else {
						// If earlier timestamp is expired, use later one
						debugLog("EARLIER TIMESTAMP EXPIRED, USING LATER ONE!")
						merged[model] = later;
					}
				}
			}
		});

		return merged;
	}

	async getCaps(orgId) {
		let subscriptionTier = await this.subscriptionTiers.get(orgId)
		if (!subscriptionTier) {
			subscriptionTier = await new ClaudeAPI().getSubscriptionTier(orgId)
			//await this.subscriptionTiers.set(orgId, subscriptionTier, 10 * 1000)	//5 seconds (for testing only)
			await this.subscriptionTiers.set(orgId, subscriptionTier, 1 * 60 * 60 * 1000)	//1 hour
		}
		debugLog("Returning caps:", globalConfig.MODEL_CAPS[subscriptionTier])
		return globalConfig.MODEL_CAPS[subscriptionTier]
	}

	async getCollapsedState() {
		return await this.#getValue(`${STORAGE_KEY}_collapsed`, false);
	}

	async setCollapsedState(isCollapsed) {
		await this.#setValue(`${STORAGE_KEY}_collapsed`, isCollapsed);
	}

	//This needs to iterate over orgIDs as well, since we will store data per user
	async #checkAndCleanExpiredData(orgId) {
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
		await this.#checkAndCleanExpiredData(orgId);
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
}

// Claude API interface
class ClaudeAPI {
	constructor(sessionKey) {
		this.baseUrl = 'https://claude.ai/api';
		this.sessionKey = sessionKey;
	}

	//I love jank...
	async ensureSessionKey() {
		if (!this.sessionKey) {
			const cookie = await browser.cookies.get({
				url: "https://claude.ai",
				name: "sessionKey"
			});
			this.sessionKey = cookie?.value;
		}
		return this.sessionKey;
	}

	// Core request method with auth
	async request(endpoint, options = {}) {
		await this.ensureSessionKey();
		const headers = {
			'Cookie': `sessionKey=${this.sessionKey}`,
			'Content-Type': 'application/json',
			...options.headers
		};

		const response = await fetch(`${this.baseUrl}${endpoint}`, {
			...options,
			headers
		});
		return response.json();
	}

	// API methods
	async getProjectData(orgId, projectId) {
		return this.request(`/organizations/${orgId}/projects/${projectId}`);
	}

	async getProjectDocs(orgId, projectId) {
		return this.request(`/organizations/${orgId}/projects/${projectId}/docs`);
	}

	async getProjectTokens(orgId, projectId) {
		let total_tokens = 0;
		const projectData = await this.getProjectData(orgId, projectId);

		if (projectData.prompt_template) {
			total_tokens += getTextTokens(projectData.prompt_template);
		}

		if (projectData.docs_count > 0) {
			const docsData = await this.getProjectDocs(orgId, projectId);
			for (const doc of docsData) {
				debugLog("Doc:", doc.uuid);
				total_tokens += getTextTokens(doc.content);
				debugLog("Doc tokens:", getTextTokens(doc.content));
			}
		}

		debugLog(`Total tokens for project ${projectId}: ${total_tokens}`);
		return total_tokens;
	}

	async getConversation(orgId, conversationId, full_tree = false) {
		return this.request(
			`/organizations/${orgId}/chat_conversations/${conversationId}?tree=${full_tree}&rendering_mode=messages&render_all_tools=true`
		);
	}

	async getConversationTokens(orgId, conversationId) {
		const conversationData = await this.getConversation(orgId, conversationId);
		// Count messages by sender
		let humanMessages = 0;
		let assistantMessages = 0;
		const lastMessage = conversationData.chat_messages[conversationData.chat_messages.length - 1];

		for (const message of conversationData.chat_messages) {
			if (message.sender === "human") humanMessages++;
			if (message.sender === "assistant") assistantMessages++;
		}

		// Sanity check
		if (humanMessages === 0 || assistantMessages === 0 || humanMessages !== assistantMessages ||
			!lastMessage || lastMessage.sender !== "assistant") {
			debugLog(`Message count mismatch or wrong last sender - Human: ${humanMessages}, Assistant: ${assistantMessages}, Last message sender: ${lastMessage?.sender}`);
			return undefined;
		}

		let totalTokens = 0;

		// Add settings costs
		for (const [setting, enabled] of Object.entries(conversationData.settings)) {
			debugLog("Setting:", setting, enabled);
			if (enabled && globalConfig.FEATURE_COSTS[setting]) {
				totalTokens += globalConfig.FEATURE_COSTS[setting];
			}
		}

		// Process each message
		for (const message of conversationData.chat_messages) {
			let messageTokens = 0;

			debugLog("Message:", message.uuid);
			// Process content array
			for (const content of message.content) {
				if (content.text) {
					debugLog("Content:", content.text);
					messageTokens += getTextTokens(content.text);
				}
				if (content.input?.code) {
					messageTokens += getTextTokens(content.input.code)
				}
				if (content.content?.text) {
					messageTokens += getTextTokens(content.content.text)
				}
			}

			// Attachment tokens
			for (const attachment of message.attachments) {
				debugLog("Attachment:", attachment.file_name, attachment.id);
				if (attachment.extracted_content) {
					messageTokens += getTextTokens(attachment.extracted_content);
					debugLog("Extracted tokens:", getTextTokens(attachment.extracted_content));
				}
			}

			// Files tokens
			for (const file of message.files_v2) {
				debugLog("File_v2:", file.file_name, file.file_uuid)
				if (file.file_kind === "image") {
					const width = file.preview_asset.image_width
					const height = file.preview_asset.image_width
					messageTokens += Math.min(1600, Math.ceil((width * height) / 750));
				} else if (file.file_kind === "document") {
					messageTokens += 2250 * file.document_asset.page_count;
				}
			}

			if (message === lastMessage) {
				messageTokens *= globalConfig.OUTPUT_TOKEN_MULTIPLIER;
			}

			totalTokens += messageTokens;
		}

		// If part of a project, get project data
		if (conversationData.project_uuid) {
			totalTokens += await this.getProjectTokens(orgId, conversationData.project_uuid);
		}
		debugLog(`Total tokens for conversation ${conversationId}: ${totalTokens}`);
		return totalTokens;
	}

	async getProfileTokens() {
		const profileData = await this.request('/account_profile');
		let totalTokens = 0;
		if (profileData.conversation_preferences) {
			totalTokens = getTextTokens(profileData.conversation_preferences) + 800
		}

		debugLog(`Profile tokens: ${totalTokens}`);
		return totalTokens;
	}

	async getSubscriptionTier(orgId) {
		const statsigData = await this.request(`/bootstrap/${orgId}/statsig`);

		if (statsigData.user?.custom?.isRaven) {
			return "team"
		}
		if (statsigData.user?.custom?.isPro) {
			return "pro"
		}
		return "free"
	}
}

async function getActiveOrgId(tab) {
	if (typeof tab !== "number") {
		tab = tab.id
	}
	try {
		const response = await browser.tabs.sendMessage(tab, {
			action: "getOrgID"
		});
		return response?.orgId;
	} catch (error) {
		console.error("Error getting org ID:", error);
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
}

const tokenStorageManager = new TokenStorageManager();
const pendingResponses = new StoredMap("pendingResponses"); // conversationId -> {userId, tabId}
const conversationLengthCache = new Map();
let processingQueue = Promise.resolve();

// Load default config before doing anything else
async function initializeConfig() {
	try {
		const response = await fetch(browser.runtime.getURL('constants.json'));
		defaultConfig = await response.json();
		defaultConfig.MODELS = Object.keys(defaultConfig.MODEL_CAPS.pro).filter(key => key !== 'default');
		//debugLog("Default config loaded:", defaultConfig);
	} catch (error) {
		console.error("Failed to load default config:", error);
	}
}


// Listen for message sending
browser.webRequest.onBeforeRequest.addListener(
	async (details) => {
		if (details.method === "POST" &&
			(details.url.includes("/completion") || details.url.includes("/retry_completion"))) {
			// Extract IDs from URL - we can refine these regexes
			const urlParts = details.url.split('/');
			const orgId = urlParts[urlParts.indexOf('organizations') + 1];
			await tokenStorageManager.addOrgId(orgId);
			const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

			const key = `${orgId}:${conversationId}`;
			debugLog(`Message sent - Key: ${key}`);
			// Store pending response with both orgId and tabId
			await pendingResponses.set(key, {
				orgId: orgId,
				conversationId: conversationId,
				tabId: details.tabId
			});
		}

		if (details.method === "GET" && details.url.includes("/settings/billing")) {
			debugLog("Hit the billing page, let's make sure we get the updated subscription tier in case it was changed...")
			const orgId = await getActiveOrgId(details.tabId);
			let subscriptionTier = await new ClaudeAPI().getSubscriptionTier(orgId)
			await tokenStorageManager.subscriptionTiers.set(orgId, subscriptionTier, 6 * 60 * 60 * 1000)
		}
	},
	{ urls: ["*://claude.ai/*"] }
);

// Listen for responses
browser.webRequest.onCompleted.addListener(
	async (details) => {
		if (details.method === "GET" &&
			details.url.includes("/chat_conversations/") &&
			details.url.includes("tree=True") &&
			details.url.includes("render_all_tools=true")) {
			processingQueue = processingQueue.then(async () => {
				const urlParts = details.url.split('/');
				const orgId = urlParts[urlParts.indexOf('organizations') + 1];
				await tokenStorageManager.addOrgId(orgId);
				const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]?.split('?')[0];

				const key = `${orgId}:${conversationId}`;
				const result = await processResponse(orgId, conversationId, await pendingResponses.has(key), details);

				if (result && await pendingResponses.has(key)) {
					await pendingResponses.delete(key);
				}
			});
		}
	},
	{ urls: ["*://claude.ai/*"] },
	["responseHeaders"]
);

//Updates each tab with its own data
async function updateAllTabs(currentLength = undefined, lengthTabId = undefined) {
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
	for (const tab of tabs) {
		const orgId = await getActiveOrgId(tab);
		const tabData = {
			modelData: {}
		};

		for (const model of globalConfig.MODELS) {
			const modelData = await tokenStorageManager.getModelData(orgId, model);
			if (modelData) {
				tabData.modelData[model] = modelData;
			}
		}

		if (currentLength && lengthTabId && tab.id === lengthTabId) {
			tabData.conversationLength = currentLength;
		}

		browser.tabs.sendMessage(tab.id, {
			type: 'updateUsage',
			data: tabData
		});
	}
}

async function processResponse(orgId, conversationId, isNewMessage, details) {
	const tabId = details.tabId;
	const sessionKey = details.responseHeaders
		.find(header => header.name.toLowerCase() === 'cookie')
		?.value.split('; ')
		.find(cookie => cookie.startsWith('sessionKey='))
		?.split('=')[1];

	const api = new ClaudeAPI(sessionKey);

	const conversationTokens = await api.getConversationTokens(orgId, conversationId);
	if (conversationTokens === undefined) {
		return false;
	}



	const profileTokens = await api.getProfileTokens();
	const messageCost = conversationTokens + profileTokens + globalConfig.BASE_SYSTEM_PROMPT_LENGTH
	debugLog("Current per message cost:", messageCost);
	conversationLengthCache.set(`${orgId}:${conversationId}`, messageCost);

	if (isNewMessage) {
		// Get model from based on conversation settings or tab
		const conversationData = await api.getConversation(orgId, conversationId);
		let model;
		if (conversationData.model) {
			const modelString = conversationData.model.toLowerCase();
			const modelTypes = Object.keys(globalConfig.MODEL_CAPS.pro).filter(key => key !== 'default');
			for (const modelType of modelTypes) {
				if (modelString.includes(modelType.toLowerCase())) {
					model = modelType;
					debugLog("Model from conversation:", model);
					break;
				}
			}
		}
		// If no model found in response, ask the tab
		if (!model) {
			model = await browser.tabs.sendMessage(tabId, { type: 'getActiveModel' });
			debugLog("Model from tab:", model);
			if (!model) model = "Sonnet"
		}
		debugLog(`=============Adding tokens for model: ${model}, Total tokens: ${messageCost}============`);
		await tokenStorageManager.addTokensToModel(orgId, model, messageCost);
	}

	// Prep base data that goes to all tabs
	const baseData = {
		modelData: {}
	};

	// Get data for all models
	for (const model of globalConfig.MODELS) {
		const modelData = await tokenStorageManager.getModelData(orgId, model);
		if (modelData) {
			baseData.modelData[model] = modelData;
		}
	}

	await updateAllTabs(messageCost, tabId);

	return true;
}



// Content -> Background messaging
async function handleMessage(message, sender) {
	debugLog("📥 Received message:", message);
	//const { sessionKey, orgId } = message;
	const { orgId } = message;
	const api = new ClaudeAPI();

	const response = await (async () => {
		switch (message.type) {
			case 'getCollapsedState':
				return await tokenStorageManager.getCollapsedState();
			case 'setCollapsedState':
				return await tokenStorageManager.setCollapsedState(message.isCollapsed);
			case 'getConfig':
				return await getFreshConfig();
			case 'requestData':
				const baseData = { modelData: {} };
				const { conversationId } = message ?? undefined;
				// Get data for all models
				for (const model of globalConfig.MODELS) {
					const modelData = await tokenStorageManager.getModelData(orgId, model);
					if (modelData) {
						baseData.modelData[model] = modelData;
					}
				}
				if (conversationId) {
					debugLog("Requested length for conversation:", conversationId);
					const key = `${orgId}:${conversationId}`;

					//Fetch it only if missing...
					if (!conversationLengthCache.has(key)) {
						debugLog("Conversation length not found, fetching...");
						const conversationTokens = await api.getConversationTokens(orgId, conversationId);
						if (conversationTokens != undefined) {
							const profileTokens = await api.getProfileTokens();
							const messageCost = conversationTokens + profileTokens + globalConfig.BASE_SYSTEM_PROMPT_LENGTH;
							conversationLengthCache.set(key, messageCost);
						}
					}

					if (conversationLengthCache.has(key)) baseData.conversationLength = conversationLengthCache.get(key)
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
				return await tokenStorageManager.getCaps(orgId);
		}
	})();
	debugLog("📤 Sending response:", response);
	return response;
}

browser.runtime.onMessage.addListener((message, sender) => {
	debugLog("Background received message:", message);
	return handleMessage(message, sender);
});

