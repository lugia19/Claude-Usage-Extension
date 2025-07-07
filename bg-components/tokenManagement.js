import { CONFIG, sleep, RawLog, FORCE_DEBUG, StoredMap } from './utils.js';

// Create component-specific logger
async function Log(...args) {
	await RawLog("tokenManagement", ...args);
}

// Move getTextFromContent here since it's token-related
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
		if (Array.isArray(content.content)) {
			if (content.type !== "tool_result" || includeEphemeral) {
				for (const nestedContent of content.content) {
					textPieces = textPieces.concat(await getTextFromContent(nestedContent, includeEphemeral, api, orgId));
				}
			}
		}
		else if (typeof content.content === 'object') {
			textPieces = textPieces.concat(await getTextFromContent(content.content, includeEphemeral, api, orgId));
		}
	}

	if (content.type === "knowledge" && includeEphemeral) {
		if (content.url && content.url.length > 0) {
			if (content.url.includes("docs.google.com")) {
				if (api && orgId) {
					const docUuid = content.metadata?.uri;
					if (docUuid) {
						const syncObj = { type: "gdrive", config: { uri: docUuid } };
						await Log("Fetching Google Drive document content:", content.url, "with sync object:", syncObj);
						try {
							const syncText = await api.getSyncText(syncObj);
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

// Token storage manager
class TokenStorageManager {
	constructor() {
		this.firebase_base_url = "https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app";
		this.storageLock = false;
		this.externalLock = false; // NEW: For external sync coordination
		this.orgIds = undefined;
		this.filesTokenCache = new StoredMap("fileTokens");
		this.resetsHit = new StoredMap("resetsHit");
		this.projectCache = new StoredMap("projectCache");

		// REMOVED: this.firebaseManager = new FirebaseSyncManager(this);
	}

	// NEW: Method to set external lock
	setExternalLock(isLocked) {
		this.externalLock = isLocked;
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
		return `claudeUsageTracker_v6_${orgId}_${type}`;
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
		// Note: capModifiers will be passed in from background.js when needed
		return baseline * tierMultiplier;
	}

	async getCollapsedState() {
		return await this.getValue(`claudeUsageTracker_v6_collapsed`, false);
	}

	async setCollapsedState(isCollapsed) {
		await this.setValue(`claudeUsageTracker_v6_collapsed`, isCollapsed);
	}

	async checkAndCleanExpiredData(orgId = null) {
		// If no orgId provided, check all orgs
		if (!orgId) {
			await this.ensureOrgIds();
			let wasOrgDataCleared = false;
			for (const org of this.orgIds) {
				const result = await this.checkAndCleanExpiredData(org);  // Recursive call with specific orgId
				if (result) wasOrgDataCleared = true;
			}
			return wasOrgDataCleared;
		}

		// Original single-org logic
		const allModelData = await this.getValue(this.getStorageKey(orgId, 'models'));
		if (!allModelData || !allModelData.resetTimestamp) return false;

		const currentTime = new Date().getTime();

		if (currentTime >= allModelData.resetTimestamp) {
			await this.setValue(this.getStorageKey(orgId, 'models'), {});
			return true;
		}
	}

	async getUsageData(orgId) {
		await this.checkAndCleanExpiredData(orgId);
		const allModelData = await this.getValue(this.getStorageKey(orgId, 'models'));
		return allModelData || {};
	}

	async addTokensToModel(orgId, model, newTokens) {
		while (this.externalLock || this.storageLock) {
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
		// Note: subscriptionTiersCache will be passed in when needed
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
				tier: "unknown", // Will be filled in by caller
				accurateCount: hasApiKey
			});
		}
	}

	async getTotalTokens() {
		const result = await browser.storage.local.get('totalTokensTracked');
		return result.totalTokensTracked || 0;
	}
}

export { TokenCounter, TokenStorageManager, getTextFromContent };