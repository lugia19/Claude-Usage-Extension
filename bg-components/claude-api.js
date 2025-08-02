import { CONFIG, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, getOrgStorageKey, sendTabMessage, containerFetch } from './utils.js';
import { tokenCounter, tokenStorageManager, getTextFromContent } from './tokenManagement.js';
import { UsageData, ConversationData } from './bg-dataclasses.js';

async function Log(...args) {
	await RawLog("claude-api", ...args);
}
const subscriptionTiersCache = new StoredMap("subscriptionTiers");

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
					//await Log("Fetching GitHub file from:", githubUrl);

					try {
						// Let containerFetch handle everything
						const response = await containerFetch(githubUrl, { method: 'GET' }, this.cookieStoreId);

						if (response.ok) {
							const fileContent = await response.text();
							allContent += fileContent + "\n";
							//await Log(`GitHub file fetched: ${filePath}, size: ${fileContent.length} bytes`);
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

	async getProjectTokens(projectId, isNewMessage) {
		const projectStats = await this.getRequest(`/organizations/${this.orgId}/projects/${projectId}/kb/stats`);
		const projectSize = projectStats.use_project_knowledge_search ? 0 : projectStats.knowledge_size;

		// Check cache
		const cachedAmount = await tokenStorageManager.projectCache.get(projectId) || -1;
		const isCached = cachedAmount == projectSize;

		// Update cache with 1 hour TTL if htis is a new message
		if (isNewMessage) {
			await tokenStorageManager.projectCache.set(projectId, projectSize, 60 * 60 * 1000);
		}

		// Return 0 tokens if cached, docs say it "doesn't count against your limits when reused"
		// This is unlike conversations which are listed as "partially cached"
		return { length: projectSize, isCached: isCached };
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

	async getConversationInfo(conversationId, isNewMessage) {
		const conversationData = await this.getConversation(conversationId, true); // Always get full tree

		// Single pass to build message map and find latest assistants
		const messageMap = new Map();
		let latestAssistant = null;
		let secondLatestAssistant = null;

		for (const message of conversationData.chat_messages) {
			messageMap.set(message.uuid, message);

			if (message.sender === "assistant") {
				if (!latestAssistant || message.created_at > latestAssistant.created_at) {
					secondLatestAssistant = latestAssistant;
					latestAssistant = message;
				} else if (!secondLatestAssistant || message.created_at > secondLatestAssistant.created_at) {
					secondLatestAssistant = message;
				}
			}
		}

		// Reconstruct trunk, count messages, and build ID set
		const currentTrunkIds = new Set();
		let humanMessagesCount = 0;
		let assistantMessagesCount = 0;
		let currentId = conversationData.current_leaf_message_uuid;
		const rootId = "00000000-0000-4000-8000-000000000000";

		const tempTrunk = [];
		while (currentId && currentId !== rootId) {
			const message = messageMap.get(currentId);
			tempTrunk.push(message);  // O(1) - just adds to end
			currentTrunkIds.add(message.uuid);

			if (message.sender === "human") humanMessagesCount++;
			else if (message.sender === "assistant") assistantMessagesCount++;

			currentId = message.parent_message_uuid;
		}
		const currentTrunk = tempTrunk.reverse();

		// Sanity check
		if (!currentTrunk || currentTrunk.length == 0) return 0;

		const lastMessage = currentTrunk[currentTrunk.length - 1];

		if (humanMessagesCount === 0 || assistantMessagesCount === 0 || humanMessagesCount !== assistantMessagesCount ||
			!lastMessage || lastMessage.sender !== "assistant") {
			await Log(`Message count mismatch or wrong last sender - Human: ${humanMessagesCount}, Assistant: ${assistantMessagesCount}, Last message sender: ${lastMessage?.sender}`);
			return undefined;
		}

		// Pick reference message based on whether we just sent a message
		const referenceMessage = isNewMessage ? secondLatestAssistant : latestAssistant;
		console.log("Reference message:", referenceMessage?.uuid, "Created at:", referenceMessage?.created_at);
		console.log("Because isNewMessage:", isNewMessage, "Latest assistant:", latestAssistant?.uuid, "Second latest assistant:", secondLatestAssistant?.uuid);

		let cacheEndId = null;
		let cacheCanBeWarm = false;
		const cache_lifetime = 60 * 60 * 1000; // 1 hour

		if (!referenceMessage) {
			// Not enough messages for cache to be warm
			cacheCanBeWarm = false;
			await Log("Not enough messages to determine cache status - cache is cold");
		} else {
			const messageAge = Date.now() - Date.parse(referenceMessage.created_at);
			if (messageAge >= cache_lifetime) {
				// Cache definitely cold
				cacheCanBeWarm = false;
				await Log("Reference message too old - cache is cold");
			} else {
				// Cache could be warm, check if reference is in current trunk
				if (currentTrunkIds.has(referenceMessage.uuid)) {
					// Reference is in trunk - cache available up to reference message
					cacheCanBeWarm = true;
					cacheEndId = referenceMessage.uuid;
					await Log("Reference message in current trunk - cache available up to:", cacheEndId);
				} else {
					// Need to find common ancestor
					let currentId = referenceMessage.uuid;

					while (currentId && currentId !== rootId) {
						if (currentTrunkIds.has(currentId)) {
							cacheCanBeWarm = true;
							cacheEndId = currentId;
							await Log(`Cache ends at common ancestor: ${cacheEndId}`);
							break;
						}
						const message = messageMap.get(currentId);
						currentId = message?.parent_message_uuid;
					}

					if (!cacheCanBeWarm) {
						await Log("No common ancestor found - cache is cold");
					}
				}
			}
		}

		// Calculate when conversation cache expires (based on the latest message)
		let conversationIsCachedUntil = null;
		if (!latestAssistant) {
			await Log("No latest assistant message found - assuming cache expires in lifetime");
			conversationIsCachedUntil = Date.now() + cache_lifetime;
		} else {
			conversationIsCachedUntil = new Date(latestAssistant?.created_at).getTime() + cache_lifetime;
		}


		// Initialize cacheIsWarm - will be toggled during message processing
		let cacheIsWarm = cacheCanBeWarm;

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
		const messageCount = currentTrunk.length;

		// Process each message
		for (let i = 0; i < messageCount; i++) {
			const message = currentTrunk[i];
			const isCached = cacheIsWarm;

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
				//await Log("Sync source:", sync.uuid)
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

			// Check if we've hit the cache boundary at the END of processing this message
			if (message.uuid === cacheEndId) {
				cacheIsWarm = false;
				await Log("Hit cache boundary at message:", message.uuid);
			}
		}


		const allMessageTokens = await tokenCounter.countMessages(humanMessageData.map(m => m.content), assistantMessageData.map(m => m.content));
		lengthTokens += allMessageTokens;
		costTokens += allMessageTokens;

		const cachedHuman = humanMessageData.filter(m => m.isCached).map(m => m.content);
		const cachedAssistant = assistantMessageData.filter(m => m.isCached).map(m => m.content);
		if (cachedHuman.length > 0 || cachedAssistant.length > 0) {
			const cachedTokens = await tokenCounter.countMessages(cachedHuman, cachedAssistant);
			// Subtract 90% of cached tokens (leaving 10%)
			costTokens -= cachedTokens * (1 - CONFIG.CACHING_MULTIPLIER);
		}

		// If part of a project, get project data
		if (conversationData.project_uuid) {
			const projectData = await this.getProjectTokens(conversationData.project_uuid, isNewMessage);
			lengthTokens += projectData.length;
			costTokens += projectData.isCached ? 0 : projectData.length;
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

		let futureCost;
		if (isNewMessage) {
			// We just calculated the cost of the message that was sent
			// Now calculate what the next message will cost

			const futureConversation = await this.getConversationInfo(conversationId, false);
			futureCost = futureConversation.cost;
		} else {
			// Already calculating future cost, so they're the same
			futureCost = Math.round(costTokens);
		}

		return new ConversationData({
			conversationId: conversationId,
			length: Math.round(lengthTokens),
			cost: Math.round(costTokens),
			futureCost: futureCost,  // New field
			model: conversationModelType,
			costUsedCache: cacheIsWarm,
			conversationIsCachedUntil: conversationIsCachedUntil,
			projectUuid: conversationData.project_uuid,
			settings: conversationData.settings
		});
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
			subscriptionTier = "claude_team"; //IDK if this is the actual identifier, so I'm just overriding it based on the old value.
		} else if (identifier === "claude_max") {
			const orgData = await this.getRequest(`/organizations/${this.orgId}`);
			await Log("Org data for tier check:", orgData);
			if (orgData?.settings?.rate_limit_tier === "default_claude_max_20x") {
				subscriptionTier = "claude_max_20x";
			} else {
				subscriptionTier = "claude_max_5x";
			}
		} else {
			subscriptionTier = identifier;
		}

		// Cache for 24 hours instead of 1 hour
		await subscriptionTiersCache.set(this.orgId, subscriptionTier, 24 * 60 * 60 * 1000);

		return subscriptionTier;
	}
}

export { ClaudeAPI }