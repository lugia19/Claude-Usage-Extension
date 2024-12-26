import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';

const tokenizer = GPTTokenizer_o200k_base;


const STORAGE_KEY = "claudeUsageTracker_v5"
const DEBUG_MODE = false

//#region Utility functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function debugLog(...args) {
	if (DEBUG_MODE) {
		console.log(...args);
	}
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
		console.error("Error setting API key:", error);
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
		debugLog("CALLING API!", userMessages, assistantMessages, file)
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
		debugLog("API response:", data);
		if (data.error) {
			console.error("API error:", data.error);
			return 0
		}
		return data.input_tokens;
	} catch (error) {
		console.error("Error counting tokens via API:", error);
		return 0
	}
}
//#endregion

//#region Manager classes
class Config {
	static instance = null;
	static CONFIG_URL = 'https://raw.githubusercontent.com/lugia19/Claude-Usage-Extension/refs/heads/main/constants.json';
	static REFRESH_INTERVAL = 10; // minutes

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
		this.setupRefresh();
	}

	async getFreshConfig() {
		try {
			const response = await fetch(Config.CONFIG_URL);
			if (!response.ok) {
				console.warn('Using default config');
				return this.defaultConfig;
			}

			const remoteConfig = await response.json();
			const mergedConfig = mergeDeep(this.defaultConfig, remoteConfig);
			mergedConfig.MODELS = Object.keys(mergedConfig.MODEL_CAPS.pro)
				.filter(key => key !== 'default');
			return mergedConfig;
		} catch (error) {
			console.warn('Error loading remote config:', error);
			return this.defaultConfig;
		}
	}

	setupRefresh() {
		browser.alarms.create('refreshConfig', {
			periodInMinutes: Config.REFRESH_INTERVAL
		});

		browser.alarms.onAlarm.addListener(async (alarm) => {
			if (alarm.name === 'refreshConfig') {
				this.config = await this.getFreshConfig();
			}
		});
	}
}

// Token storage manager
class TokenStorageManager {
	constructor() {
		this.isSyncingFirebase = false;
		this.isSyncingResetTimes = false;
		this.storageLock = false;
		this.orgIds = undefined;
		this.subscriptionTiers = new StoredMap("subscriptionTiers")
		this.filesTokenCache = new StoredMap("fileTokens")
		this.resetsHit = new StoredMap("resetsHit");


		const nextAlarm = new Date();
		nextAlarm.setHours(nextAlarm.getHours() + 1, 1, 0, 0);

		browser.alarms.create('checkExpiredData', {
			when: nextAlarm.getTime(),
			periodInMinutes: 60
		});

		browser.alarms.create('firebaseSync', { periodInMinutes: 5 });
		browser.alarms.create('resetTimesSync', { periodInMinutes: 15 });

		//debugLog("Alarm created, syncing every", 5, "minutes");
		browser.alarms.onAlarm.addListener(async (alarm) => {
			//debugLog("Alarm triggered:", alarm);
			if (!this.orgIds) {
				await this.loadOrgIds();
			}
			if (alarm.name === 'firebaseSync') {
				await this.syncWithFirebase();
				await updateAllTabs();
			}

			if (alarm.name === 'resetTimesSync') {
				await this.syncResetTimes();
			}

			if (alarm.name === 'checkExpiredData') {
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
				const url = `${configManager.config.FIREBASE_BASE_URL}/users/${orgId}/models.json`;
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

	async getCaps(orgId, api) {
		let subscriptionTier = await this.subscriptionTiers.get(orgId)
		if (!subscriptionTier) {
			subscriptionTier = await api.getSubscriptionTier(orgId)
			//await this.subscriptionTiers.set(orgId, subscriptionTier, 10 * 1000)	//5 seconds (for testing only)
			await this.subscriptionTiers.set(orgId, subscriptionTier, 1 * 60 * 60 * 1000)	//1 hour
		}
		return configManager.config.MODEL_CAPS[subscriptionTier]
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

	async getUploadedFileTokens(orgId, file, estimateOnly = false, uploaderClaudeAI_API = null) {
		if (await this.filesTokenCache.has(`${orgId}:${file.file_uuid}`)) {
			debugLog("Using cached amount for file:", file.file_uuid, "which is", await this.filesTokenCache.get(`${orgId}:${file.file_uuid}`));
			return await this.filesTokenCache.get(`${orgId}:${file.file_uuid}`);
		} else {
			if ((await browser.storage.local.get('apiKey'))?.apiKey && !estimateOnly) {
				try {
					debugLog("Using api...")
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
						debugLog("Falling back to estimate...")
						return this.getUploadedFileTokens(orgId, file, true)
					}
					await this.filesTokenCache.set(`${orgId}:${file.file_uuid}`, fileTokens)
					return fileTokens
				} catch (error) {
					console.error("Error fetching file tokens:", error)
					debugLog("Falling back to estimate...")
					return this.getUploadedFileTokens(orgId, file, true)
				}
			} else {
				debugLog("Using estimate...")
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

	async addReset(orgId, model) {
		await sleep(1000); //We want to ensure we get the latest data, which can take a second - so we wait.
		const modelData = await this.getModelData(orgId, model);
		if (!modelData) return;

		const key = `${orgId}:${modelData.resetTimestamp}`;

		// Only add if not already present
		if (!(await this.resetsHit.has(key))) {
			await this.resetsHit.set(key, {
				total: modelData.total,
				model: model,
				timestamp: modelData.resetTimestamp
			});
		}
	}

	async syncResetTimes() {
		if (this.isSyncingResetTimes) {
			debugLog("Reset times sync already in progress, skipping");
			return;
		}

		this.isSyncingResetTimes = true;
		debugLog("=== RESET TIMES SYNC STARTING ===");

		try {
			// Group all entries by orgId
			const groupedResets = {};
			for (const [key, value] of await this.resetsHit.entries()) {
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
						model: resetData.model
					};
				}

				const url = `${configManager.config.FIREBASE_BASE_URL}/users/${orgId}/resets.json`;
				debugLog("Writing reset times for orgId:", orgId);

				const writeResponse = await fetch(url, {
					method: 'PUT',
					body: JSON.stringify(transformedResets)
				});
				if (!writeResponse.ok) {
					throw new Error(`Write failed! status: ${writeResponse.status}`);
				}
			}
			debugLog("=== RESET TIMES SYNC COMPLETED SUCCESSFULLY ===");
		} catch (error) {
			console.error('=== RESET TIMES SYNC FAILED ===');
			console.error('Error details:', error);
		} finally {
			this.isSyncingResetTimes = false;
		}
	}


}

// Claude API interface
class ClaudeAPI {
	static async create(cookieStoreId = "0") {
		const api = new ClaudeAPI();
		debugLog("Creating API from cookie store:", cookieStoreId);
		api.sessionKey = await api.getSessionKey(cookieStoreId)
		return api;
	}

	constructor() {
		this.baseUrl = 'https://claude.ai/api';
		this.sessionKey = undefined;
	}

	//I love jank...
	async getSessionKey(cookieStoreId = "0") {
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
			debugLog(`Starting file download from: https://claude.ai${url}`);
			const response = await fetch(`https://claude.ai${url}`, {
				headers: {
					'X-Overwrite-SessionKey': this.sessionKey
				}
			});

			if (!response.ok) {
				console.error('Fetch failed:', response.status, response.statusText);
				return null;
			}

			const blob = await response.blob();
			return new Promise((resolve) => {
				const reader = new FileReader();
				reader.onloadend = () => {
					const base64Data = reader.result.split(',')[1];
					debugLog('Base64 length:', base64Data.length);
					resolve({
						data: base64Data,
						media_type: blob.type
					});
				};
				reader.readAsDataURL(blob);
			});

		} catch (e) {
			console.error('Download error:', e);
			return null;
		}
	}

	async getSyncText(orgId, syncURI, syncType) {
		if (!syncURI) return "";
		if (syncType != "gdrive") return ""
		let syncText = (await this.getRequest(`/organizations/${orgId}/sync/mcp/drive/document/${syncURI}`))?.text
		debugLog("Sync text:", syncText);
		return syncText || "";
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
			debugLog("Doc:", doc.uuid);
			project_text += doc.content;
			debugLog("Doc tokens:", await getTextTokens(doc.content, true));
		}

		const syncData = await this.getRequest(`/organizations/${orgId}/projects/${projectId}/syncs`);
		for (const sync of syncData) {
			debugLog("Sync:", sync.uuid);
			const syncText = await this.getSyncText(orgId, sync.config?.uri, sync.type);
			project_text += syncText;
			debugLog("Sync tokens:", await getTextTokens(syncText, true));
		}

		let total_tokens = await getTextTokens(project_text);
		debugLog(`Total tokens for project ${projectId}: ${total_tokens}`);
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
			debugLog(`Message count mismatch or wrong last sender - Human: ${humanMessagesCount}, Assistant: ${assistantMessagesCount}, Last message sender: ${lastMessage?.sender}`);
			return undefined;
		}

		let totalTokens = 0;
		// Add settings costs
		for (const [setting, enabled] of Object.entries(conversationData.settings)) {
			debugLog("Setting:", setting, enabled);
			if (enabled && configManager.config.FEATURE_COSTS[setting]) {
				totalTokens += configManager.config.FEATURE_COSTS[setting];
			}
		}

		let humanMessages = [];
		let assistantMessages = [];

		// Process each message
		for (const message of conversationData.chat_messages) {
			// Files_v2 tokens (handle separately)
			for (const file of message.files_v2) {
				debugLog("File_v2:", file.file_name, file.file_uuid)
				totalTokens += await tokenStorageManager.getUploadedFileTokens(orgId, file, false, this)
			}

			let messageContent = [];

			debugLog("Message:", message.uuid);
			// Process content array
			for (const content of message.content) {
				if (content.text) {
					messageContent.push(content.text);
				}
				if (content.input?.code) {
					messageContent.push(content.input.code);
				}
				if (content.content?.text) {
					messageContent.push(content.content.text);
				}
			}

			// Attachment tokens
			for (const attachment of message.attachments) {
				debugLog("Attachment:", attachment.file_name, attachment.id);
				if (attachment.extracted_content) {
					messageContent.push(attachment.extracted_content);
				}
			}


			// Sync tokens
			for (const sync of message.sync_sources) {
				debugLog("Sync source:", sync.uuid)
				messageContent.push(await this.getSyncText(orgId, sync.config?.uri, sync.type));
			}

			if (message === lastMessage) {
				totalTokens += await getTextTokens(messageContent.join(' ')) * (configManager.config.OUTPUT_TOKEN_MULTIPLIER - 1);
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
				totalTokens += await getTextTokens(humanMessages.join(' ')) + await getTextTokens(assistantMessages.join(' '));
			} else {
				totalTokens += tempTokens
			}
		} else {
			totalTokens += await getTextTokens(humanMessages.join(' ')) + await getTextTokens(assistantMessages.join(' '));
		}

		// If part of a project, get project data
		if (conversationData.project_uuid) {
			totalTokens += await this.getProjectTokens(orgId, conversationData.project_uuid);
		}
		debugLog(`Total tokens for conversation ${conversationId}: ${totalTokens}`);
		return totalTokens;
	}

	async getProfileTokens() {
		const profileData = await this.getRequest('/account_profile');
		let totalTokens = 0;
		if (profileData.conversation_preferences) {
			totalTokens = await getTextTokens(profileData.conversation_preferences) + 800
		}

		debugLog(`Profile tokens: ${totalTokens}`);
		return totalTokens;
	}

	async getSubscriptionTier(orgId) {
		const statsigData = await this.getRequest(`/bootstrap/${orgId}/statsig`);
		debugLog("Got statsig data:", statsigData);
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
async function updateAllTabs(currentLength = undefined, lengthTabId = undefined) {
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
	for (const tab of tabs) {
		const orgId = await requestActiveOrgId(tab);
		const tabData = {
			modelData: {}
		};

		for (const model of configManager.config.MODELS) {
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

// Content -> Background messaging
async function handleMessageFromContent(message, sender) {
	debugLog("📥 Received message:", message);
	//const { sessionKey, orgId } = message;
	const { orgId } = message;
	const api = await ClaudeAPI.create(sender.tab?.cookieStoreId);
	const response = await (async () => {
		switch (message.type) {
			case 'getCollapsedState':
				return await tokenStorageManager.getCollapsedState();
			case 'setCollapsedState':
				return await tokenStorageManager.setCollapsedState(message.isCollapsed);
			case 'getConfig':
				return await configManager.config;
			case 'requestData':
				const baseData = { modelData: {} };
				const { conversationId } = message ?? undefined;
				// Get data for all models
				for (const model of configManager.config.MODELS) {
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
							const messageCost = conversationTokens + profileTokens + configManager.config.BASE_SYSTEM_PROMPT_LENGTH;
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
				return await tokenStorageManager.getCaps(orgId, api);
			case 'getAPIKey':
				return (await browser.storage.local.get('apiKey'))?.apiKey;
			case 'setAPIKey':
				const { newKey } = message
				return await checkAndSetAPIKey(newKey);
			case 'resetHit':
				const { model } = message;
				tokenStorageManager.addReset(orgId, model).catch(err => {
					console.error('Adding reset failed:', err);
				});
				return true;
		}
	})();
	debugLog("📤 Sending response:", response);
	return response;
}

function addExtensionListeners() {
	browser.runtime.onMessage.addListener((message, sender) => {
		debugLog("Background received message:", message);
		return handleMessageFromContent(message, sender);
	});

	browser.action.onClicked.addListener(() => {
		browser.tabs.create({
			url: "https://ko-fi.com/lugia19"
		});
	});
}
//#endregion



//#region Network handling
async function processResponse(orgId, conversationId, isNewMessage, details) {
	const tabId = details.tabId;
	const api = await ClaudeAPI.create(details.cookieStoreId);

	const conversationTokens = await api.getConversationTokens(orgId, conversationId);
	if (conversationTokens === undefined) {
		return false;
	}



	const profileTokens = await api.getProfileTokens();
	const messageCost = conversationTokens + profileTokens + configManager.config.BASE_SYSTEM_PROMPT_LENGTH
	debugLog("Current per message cost:", messageCost);
	conversationLengthCache.set(`${orgId}:${conversationId}`, messageCost);

	if (isNewMessage) {
		// Get model from based on conversation settings or tab
		const conversationData = await api.getConversation(orgId, conversationId);
		let model;
		if (conversationData.model) {
			const modelString = conversationData.model.toLowerCase();
			const modelTypes = Object.keys(configManager.config.MODEL_CAPS.pro).filter(key => key !== 'default');
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
	for (const model of configManager.config.MODELS) {
		const modelData = await tokenStorageManager.getModelData(orgId, model);
		if (modelData) {
			baseData.modelData[model] = modelData;
		}
	}

	await updateAllTabs(messageCost, tabId);

	return true;
}


// Listen for message sending
function addWebRequestListeners() {
	browser.webRequest.onBeforeRequest.addListener(
		async (details) => {
			if (details.method === "POST" &&
				(details.url.includes("/completion") || details.url.includes("/retry_completion"))) {
				debugLog("Request sent - URL:", details.url);
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
				const orgId = await requestActiveOrgId(details.tabId);
				const api = await ClaudeAPI.create(details.cookieStoreId);
				let subscriptionTier = await api.getSubscriptionTier(orgId)
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
				debugLog("Response recieved - URL:", details.url);
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
}

// Only relevant for firefox - to support different accounts in different containers
async function addFirefoxContainerFixListener() {
	const stores = await browser.cookies.getAllCookieStores();
	const isFirefoxContainers = stores[0].id === "firefox-default";

	if (isFirefoxContainers) {
		debugLog("We're in firefox with containers, registering blocking listener...")
		browser.webRequest.onBeforeSendHeaders.addListener(
			(details) => {
				const overwriteKey = details.requestHeaders.find(h =>
					h.name === 'X-Overwrite-SessionKey'
				)?.value;

				if (overwriteKey) {
					debugLog("Overwriting session key.");
					// Find existing cookie header
					const cookieHeader = details.requestHeaders.find(h => h.name === 'Cookie');
					if (cookieHeader) {
						// Parse existing cookies
						const cookies = cookieHeader.value.split('; ')
							.filter(c => !c.startsWith('sessionKey='));
						// Add our new sessionKey
						cookies.push(`sessionKey=${overwriteKey}`);
						// Rebuild cookie header
						cookieHeader.value = cookies.join('; ');
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
addWebRequestListeners();
addExtensionListeners();
addFirefoxContainerFixListener();

const configManager = new Config();
configManager.initialize();
const pendingResponses = new StoredMap("pendingResponses"); // conversationId -> {userId, tabId}
const conversationLengthCache = new Map();
let tokenStorageManager = new TokenStorageManager();
tokenStorageManager.loadOrgIds()
let processingQueue = Promise.resolve();

