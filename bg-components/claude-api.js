import { CONFIG, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, getOrgStorageKey, sendTabMessage, containerFetch } from './utils.js';
import { tokenCounter, getTextFromContent } from './tokenManagement.js';
import { UsageData, ConversationData } from '../shared/dataclasses.js';

const FEATURE_COSTS = {
	"enabled_artifacts_attachments": 2200,	// DEPRECATED: Analysis tool
	"preview_feature_uses_artifacts": 8400,	// Artifacts
	"preview_feature_uses_latex": 200,		// DEPRECATED: LaTeX
	"enabled_bananagrams": 750,				// Drive search
	"enabled_sourdough": 900,				// GCal or GMail search (not sure which)
	"enabled_focaccia": 1350,				// GCal or GMail search (not sure which)
	"enabled_web_search": 10250,			// Web search
	"citation_info": 450,					// Citation info
	"compass_mode": 1000,					// Research tool
	"profile_preferences": 850,				// Base preferences cost
	"enabled_turmeric": 2000,				// AI artifacts
	"enabled_saffron": 4250,				// Memory base cost (actual memory content counted separately)
	"enabled_saffron_search": 3000,			// Memory search
	"enabled_monkeys_in_a_barrel": 5300		// Code Interpreter
};

async function Log(...args) {
	await RawLog("claude-api", ...args);
}
const subscriptionTiersCache = new StoredMap("subscriptionTiers");
const syncTokenCache = new StoredMap("syncTokens");
const projectCache = new StoredMap("projectCache");

// Pure HTTP/API layer
class ClaudeAPI {
	constructor(cookieStoreId, orgId) {
		this.baseUrl = 'https://claude.ai/api';
		this.cookieStoreId = cookieStoreId;
		this.orgId = orgId;
	}

	// Core methods
	async getRequest(endpoint) {
		const response = await containerFetch(`${this.baseUrl}${endpoint}`, {
			headers: {
				'Content-Type': 'application/json'
			},
			method: 'GET'
		}, this.cookieStoreId);
		return response.json();
	}

	async fetchUrl(url, options = {}) {
		return containerFetch(url, options, this.cookieStoreId);
	}

	// Factory method - returns a ConversationAPI instance
	async getConversation(conversationId) {
		return new ConversationAPI(conversationId, this);
	}

	// Fetch usage limits from the /usage endpoint
	async getUsageLimits() {
		return this.getRequest(`/organizations/${this.orgId}/usage`);
	}

	// Fetch memory content
	async getMemory() {
		return this.getRequest(`/organizations/${this.orgId}/memory`);
	}

	// Platform operations
	async getGoogleDriveDocument(uri) {
		return this.getRequest(`/organizations/${this.orgId}/sync/mcp/drive/document/${uri}`);
	}

	// Platform operations with business logic
	async getProjectStats(projectId, isNewMessage = false) {
		const projectStats = await this.getRequest(`/organizations/${this.orgId}/projects/${projectId}/kb/stats`);
		const projectSize = projectStats.use_project_knowledge_search ? 0 : projectStats.knowledge_size;

		// Check cache
		const cachedAmount = await projectCache.get(projectId) || -1;
		const isCached = cachedAmount == projectSize;

		// Update cache if this is a new message
		if (isNewMessage) {
			await projectCache.set(projectId, projectSize, CONFIG.TOKEN_CACHING_DURATION_MS);
		}

		return {
			...projectStats,
			tokenInfo: {
				length: projectSize,
				isCached: isCached
			}
		};
	}

	async getStyleTokens(styleId, tabId) {
		if (!styleId) {
			await Log("Fetching styleId from tab:", tabId);
			const response = await sendTabMessage(tabId, {
				action: "getStyleId"
			});
			styleId = response?.styleId;
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

	async getProfileTokens() {
		const profileData = await this.getRequest('/account_profile');
		let totalTokens = 0;
		if (profileData.conversation_preferences) {
			totalTokens = await tokenCounter.countText(profileData.conversation_preferences) + FEATURE_COSTS["profile_preferences"];
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
			subscriptionTier = "claude_team";
		} else if (identifier === "claude_max") {
			const orgData = await this.getRequest(`/organizations/${this.orgId}`);
			await Log("Org data for tier check:", orgData);
			if (orgData?.rate_limit_tier === "default_claude_max_20x") {
				subscriptionTier = "claude_max_20x";
			} else {
				subscriptionTier = "claude_max_5x";
			}
		} else {
			subscriptionTier = identifier;
		}

		await subscriptionTiersCache.set(this.orgId, subscriptionTier, 24 * 60 * 60 * 1000);
		return subscriptionTier;
	}
}

// Message-level operations
class MessageAPI {
	constructor(messageData, isCached, api) {
		this.data = messageData;
		this.isCached = isCached;
		this.api = api;
	}

	get uuid() {
		return this.data.uuid;
	}

	get sender() {
		return this.data.sender;
	}

	// Now owns file download logic
	async getUploadedFileAsBase64(url) {
		try {
			await Log(`Starting file download from: https://claude.ai${url}`);
			const response = await this.api.fetchUrl(`https://claude.ai${url}`);
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

	// Now owns sync text logic
	async getSyncText(sync) {
		if (!sync) return "";

		const syncType = sync.type;
		await Log("Processing sync:", syncType, sync.uuid || sync.id);

		if (syncType === "gdrive") {
			const uri = sync.config?.uri;
			if (!uri) return "";

			const response = await this.api.getGoogleDriveDocument(uri);
			return response?.text || "";
		}
		else if (syncType === "github") {
			try {
				const { owner, repo, branch, filters } = sync.config || {};
				if (!owner || !repo || !branch || !filters?.filters) {
					await Log("warn", "Incomplete GitHub sync config", sync.config);
					return "";
				}

				let allContent = "";
				for (const [filePath, action] of Object.entries(filters.filters)) {
					if (action !== "include") continue;

					const cleanPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
					const githubUrl = `https://github.com/${owner}/${repo}/raw/refs/heads/${branch}/${cleanPath}`;

					try {
						const response = await this.api.fetchUrl(githubUrl, { method: 'GET' });
						if (response.ok) {
							const fileContent = await response.text();
							allContent += fileContent + "\n";
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

		await Log("warn", `Unsupported sync type: ${syncType}`);
		return "";
	}

	async getSyncTokens() {
		const SYNC_CACHE_TIME_THRESHOLD = 60 * 60 * 1000;
		const syncPromises = (this.data.sync_sources || []).map(async (sync) => {
			await Log("Processing sync source:", sync.type, sync.uuid);
			const cacheKey = `${this.api.orgId}:${sync.uuid}`;
			const cachedData = await syncTokenCache.get(cacheKey);

			// Check cache first
			if (cachedData &&
				cachedData.sizeBytes === sync.status.current_size_bytes &&
				cachedData.fileCount === sync.status.current_file_count) {

				const timeDiff = new Date(sync.status.last_synced_at).getTime() -
					new Date(cachedData.lastSyncedAt).getTime();

				if (timeDiff < SYNC_CACHE_TIME_THRESHOLD) {
					await Log("Using cached sync data for:", sync.type, sync.uuid);
					return cachedData.tokenCount;
				}
			}

			// Cache miss - fetch and count
			await Log("Cache miss for sync source:", sync.type, sync.uuid);
			const syncText = await this.getSyncText(sync);
			if (!syncText) return 0;

			const tokenCount = await tokenCounter.countText(syncText);

			// Update cache
			await syncTokenCache.set(cacheKey, {
				sizeBytes: sync.status.current_size_bytes,
				fileCount: sync.status.current_file_count,
				lastSyncedAt: sync.status.last_synced_at,
				tokenCount: tokenCount
			});

			return tokenCount;
		});

		const tokenCounts = await Promise.all(syncPromises);
		return tokenCounts.reduce((total, count) => total + count, 0);
	}

	async getFileTokens() {
		const filePromises = (this.data.files_v2 || []).map(async (file) => {
			const tokenCountingAPIKey = await tokenCounter.getApiKey();
			if (tokenCountingAPIKey) {
				try {
					const fileUrl = file.file_kind === "image" ?
						file.preview_asset.url :
						file.document_asset.url;

					const fileInfo = await this.getUploadedFileAsBase64(fileUrl);
					if (fileInfo?.data) {
						return await tokenCounter.getNonTextFileTokens(
							fileInfo.data,
							fileInfo.media_type,
							file,
							this.api.orgId
						);
					}
				} catch (error) {
					await Log("error", "Failed to fetch file content:", error);
				}
			}
			// Fallback to estimation
			return await tokenCounter.getNonTextFileTokens(null, null, file, this.api.orgId);
		});

		const tokenCounts = await Promise.all(filePromises);
		return tokenCounts.reduce((total, count) => total + count, 0);
	}

	// Get text content (Not tokens, so it can be done all in one call later)
	async getTextContent(includeEphemeral = false) {
		let messageContent = [];

		// Process content array
		for (const content of this.data.content || []) {
			const textParts = await getTextFromContent(content, includeEphemeral, this.api, this.api.orgId);
			messageContent = messageContent.concat(textParts);
		}

		// Process attachments
		for (const attachment of this.data.attachments || []) {
			if (attachment.extracted_content) {
				messageContent.push(attachment.extracted_content);
			}
		}

		return messageContent.join(' ');
	}
}

// Conversation-level operations
class ConversationAPI {
	constructor(conversationId, api) {
		this.conversationId = conversationId;
		this.api = api;
		this.conversationData = null;
	}

	// Lazy load conversation data
	async getData(full_tree = false) {
		if (!this.conversationData || full_tree) {
			this.conversationData = await this.api.getRequest(
				`/organizations/${this.api.orgId}/chat_conversations/${this.conversationId}?tree=${full_tree}&rendering_mode=messages&render_all_tools=true`
			);
		}
		return this.conversationData;
	}

	async getCachingInfo(isNewMessage) {
		const conversationData = await this.getData(true);
		// Build message map and find latest assistants
		const messageMap = new Map();
		let latestAssistant = null;
		let secondLatestAssistant = null;

		for (const rawMessage of conversationData.chat_messages) {
			messageMap.set(rawMessage.uuid, rawMessage);

			if (rawMessage.sender === "assistant") {
				if (!latestAssistant || rawMessage.created_at > latestAssistant.created_at) {
					secondLatestAssistant = latestAssistant;
					latestAssistant = rawMessage;
				} else if (!secondLatestAssistant || rawMessage.created_at > secondLatestAssistant.created_at) {
					secondLatestAssistant = rawMessage;
				}
			}
		}

		// Reconstruct trunk
		const currentTrunkIds = new Set();
		let humanMessagesCount = 0;
		let assistantMessagesCount = 0;
		let currentId = conversationData.current_leaf_message_uuid;
		const rootId = "00000000-0000-4000-8000-000000000000";

		const tempTrunk = [];
		while (currentId && currentId !== rootId) {
			const rawMessage = messageMap.get(currentId);
			tempTrunk.push(rawMessage);
			currentTrunkIds.add(rawMessage.uuid);

			if (rawMessage.sender === "human") humanMessagesCount++;
			else if (rawMessage.sender === "assistant") assistantMessagesCount++;

			currentId = rawMessage.parent_message_uuid;
		}
		const currentTrunk = tempTrunk.reverse();

		// Validation
		if (!currentTrunk || currentTrunk.length == 0) {
			return null; // Caller should handle this
		}

		const lastRawMessage = currentTrunk[currentTrunk.length - 1];
		if (humanMessagesCount === 0 || assistantMessagesCount === 0 ||
			humanMessagesCount !== assistantMessagesCount ||
			!lastRawMessage || lastRawMessage.sender !== "assistant") {
			await Log(`Message count mismatch or wrong last sender - Human: ${humanMessagesCount}, Assistant: ${assistantMessagesCount}, Last message sender: ${lastRawMessage?.sender}`);
			return null;
		}

		// Cache determination
		const referenceMessage = isNewMessage ? secondLatestAssistant : latestAssistant;
		let cacheEndId = null;
		let conversationIsCached = false;
		const cache_lifetime = CONFIG.TOKEN_CACHING_DURATION_MS;

		if (!referenceMessage) {
			conversationIsCached = false;
			await Log("Not enough messages to determine cache status - cache is cold");
		} else {
			const messageAge = Date.now() - Date.parse(referenceMessage.created_at);
			if (messageAge >= cache_lifetime) {
				conversationIsCached = false;
				await Log("Reference message too old - cache is cold");
			} else {
				if (currentTrunkIds.has(referenceMessage.uuid)) {
					conversationIsCached = true;
					cacheEndId = referenceMessage.uuid;
					await Log("Reference message in current trunk - cache available up to:", cacheEndId);
				} else {
					// Find common ancestor
					let currentId = referenceMessage.uuid;
					while (currentId && currentId !== rootId) {
						if (currentTrunkIds.has(currentId)) {
							conversationIsCached = true;
							cacheEndId = currentId;
							await Log(`Cache ends at common ancestor: ${cacheEndId}`);
							break;
						}
						const rawMessage = messageMap.get(currentId);
						currentId = rawMessage?.parent_message_uuid;
					}

					if (!conversationIsCached) {
						await Log("No common ancestor found - cache is cold");
					}
				}
			}
		}

		// Calculate cache expiration
		let conversationIsCachedUntil = null;
		if (!latestAssistant) {
			await Log("No latest assistant message found - assuming cache expires in lifetime");
			conversationIsCachedUntil = Date.now() + cache_lifetime;
		} else {
			conversationIsCachedUntil = new Date(latestAssistant?.created_at).getTime() + cache_lifetime;
		}

		return {
			currentTrunk,
			conversationIsCached,
			cacheEndId,
			conversationIsCachedUntil
		};
	}

	async getInfo(isNewMessage) {
		await Log("API: Requesting information for conversation:", this.conversationId);
		const conversationData = await this.getData(true);
		const cachingInfo = await this.getCachingInfo(isNewMessage);
		if (!cachingInfo) return undefined;

		const { currentTrunk, conversationIsCached, cacheEndId, conversationIsCachedUntil } = cachingInfo;

		// Initialize token counting
		let cacheIsActive = conversationIsCached;
		let lengthTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH;
		let costTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH * CONFIG.CACHING_MULTIPLIER;

		// Add settings costs
		for (const [setting, enabled] of Object.entries(conversationData.settings)) {
			await Log("Setting:", setting, enabled);
			if (enabled && FEATURE_COSTS[setting]) {
				lengthTokens += FEATURE_COSTS[setting];
				costTokens += FEATURE_COSTS[setting] * CONFIG.CACHING_MULTIPLIER;
			}
		}

		if ("enabled_web_search" in conversationData.settings || "enabled_bananagrams" in conversationData.settings) {
			if (conversationData.settings?.enabled_websearch || conversationData.settings?.enabled_bananagrams) {
				lengthTokens += FEATURE_COSTS["citation_info"];
				costTokens += FEATURE_COSTS["citation_info"] * CONFIG.CACHING_MULTIPLIER;
			}
		}

		// Add memory content tokens if memory is enabled
		if (conversationData.settings?.enabled_saffron) {
			try {
				const memoryData = await this.api.getMemory();
				if (memoryData?.memory) {
					const memoryTokens = await tokenCounter.countText(memoryData.memory);
					await Log("Memory tokens:", memoryTokens);
					lengthTokens += memoryTokens;
					costTokens += memoryTokens * CONFIG.CACHING_MULTIPLIER;
				}
			} catch (error) {
				await Log("warn", "Failed to fetch memory:", error);
			}
		}

		// Steps 7-8: Process messages and count tokens
		const humanMessageData = [];
		const assistantMessageData = [];
		let hasWebSearchResult = false;

		for (let i = 0; i < currentTrunk.length; i++) {
			const rawMessageData = currentTrunk[i];
			const message = new MessageAPI(rawMessageData, cacheIsActive, this.api);

			// Check for web search results in message content
			if (!hasWebSearchResult && rawMessageData.content) {
				hasWebSearchResult = rawMessageData.content.some(
					item => item.type === 'tool_result' && item.name === 'web_search'
				);
			}

			// Run both in parallel
			const [fileTokens, syncTokens] = await Promise.all([
				message.getFileTokens(),
				message.getSyncTokens()
			]);

			// Then apply the calculations
			lengthTokens += fileTokens + syncTokens;
			costTokens += message.isCached ?
				(fileTokens + syncTokens) * CONFIG.CACHING_MULTIPLIER :
				(fileTokens + syncTokens);

			// Text content
			const textContent = await message.getTextContent(false, this, this.orgId);

			if (message.sender === "human") {
				humanMessageData.push({ content: textContent, isCached: message.isCached });
			} else {
				assistantMessageData.push({ content: textContent, isCached: message.isCached });
			}

			// Last message output tokens
			if (i === currentTrunk.length - 1) {
				const lastMessageContent = await message.getTextContent(true, this, this.orgId);
				costTokens += await tokenCounter.countText(lastMessageContent) * CONFIG.OUTPUT_TOKEN_MULTIPLIER;
			}

			// Update cache status
			if (message.uuid === cacheEndId) {
				cacheIsActive = false;
				await Log("Hit cache boundary at message:", message.uuid);
			}
		}

		// Batch token counting
		const allMessageTokens = await tokenCounter.countMessages(
			humanMessageData.map(m => m.content),
			assistantMessageData.map(m => m.content)
		);
		lengthTokens += allMessageTokens;
		costTokens += allMessageTokens;

		// Subtract cached tokens
		const cachedHuman = humanMessageData.filter(m => m.isCached).map(m => m.content);
		const cachedAssistant = assistantMessageData.filter(m => m.isCached).map(m => m.content);
		if (cachedHuman.length > 0 || cachedAssistant.length > 0) {
			const cachedTokens = await tokenCounter.countMessages(cachedHuman, cachedAssistant);
			costTokens -= cachedTokens * (1 - CONFIG.CACHING_MULTIPLIER);
		}

		// Steps 9-10: Project tokens and model detection
		let projectStats = null;
		if (conversationData.project_uuid) {
			projectStats = await this.api.getProjectStats(conversationData.project_uuid, isNewMessage);
			lengthTokens += projectStats.tokenInfo.length;
			costTokens += projectStats.tokenInfo.isCached ? 0 : projectStats.tokenInfo.length;
		}

		// Determine if length is an estimate (features that add unknown tokens)
		const lengthIsEstimate = !!(
			conversationData.settings?.enabled_monkeys_in_a_barrel ||  // Code execution
			hasWebSearchResult ||                                      // Web search result in history
			conversationData.settings?.enabled_bananagrams ||          // Drive search
			projectStats?.use_project_knowledge_search                 // Project retrieval
		);

		let conversationModelType = undefined;
		let modelString = "sonnet"
		if (conversationData.model) modelString = conversationData.model.toLowerCase();
		for (const modelType of CONFIG.MODELS) {
			if (modelString.includes(modelType.toLowerCase())) {
				conversationModelType = modelType;
				break;
			}
		}

		await Log(`Total tokens for conversation ${this.conversationId}: ${lengthTokens} with model ${conversationModelType}`);

		// Step 11: Future cost
		let futureCost;
		if (isNewMessage) {
			const futureConversation = await this.getInfo(false);
			futureCost = futureConversation.cost;
		} else {
			futureCost = Math.round(costTokens);
		}

		const lastRawMessage = currentTrunk[currentTrunk.length - 1];
		// Step 12: Return result
		return new ConversationData({
			conversationId: this.conversationId,
			length: Math.round(lengthTokens),
			cost: Math.round(costTokens),
			futureCost: futureCost,
			model: conversationModelType,
			costUsedCache: conversationIsCached,
			conversationIsCachedUntil: conversationIsCachedUntil,
			projectUuid: conversationData.project_uuid,
			settings: conversationData.settings,
			lastMessageTimestamp: new Date(lastRawMessage.created_at).getTime(),
			lengthIsEstimate: lengthIsEstimate
		});
	}
}

// Export the new structure
export { ClaudeAPI, ConversationAPI, MessageAPI }