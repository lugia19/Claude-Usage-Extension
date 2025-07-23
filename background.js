import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, sleep, RawLog, FORCE_DEBUG, containerFetch, addContainerFetchListener, StoredMap } from './bg-components/utils.js';
import { TokenCounter, TokenStorageManager, getTextFromContent } from './bg-components/tokenManagement.js';
import { FirebaseSyncManager } from './bg-components/firebase.js';
import { UsageData, ConversationData } from './bg-components/bg-dataclasses.js';

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

let isInitialized = false;
let functionsPendingUntilInitialization = [];

function runOnceInitialized(fn, args) {
	if (!isInitialized) {
		functionsPendingUntilInitialization.push({ fn, args });
		return;
	}
	return fn(...args);
}
//#endregion

//#region Listener setup (I hate MV3 - listeners must be initialized here)
//Extension-related listeners:
browser.runtime.onMessage.addListener(async (message, sender) => {
	return runOnceInitialized(handleMessageFromContent, [message, sender]);
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
		(details) => runOnceInitialized(onBeforeRequestHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onBeforeRequest.urls },
		["requestBody"]
	);

	browser.webRequest.onCompleted.addListener(
		(details) => runOnceInitialized(onCompletedHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onCompleted.urls },
		["responseHeaders"]
	);

	// Tab listeners
	// Track focused/visible claude.ai tabs
	browser.tabs.onActivated.addListener((activeInfo) =>
		runOnceInitialized(updateSyncAlarmIntervalAndFetchData, [activeInfo.tabId])
	);

	// Handle tab updates
	browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.url?.includes('claude.ai') || tab.url?.includes('claude.ai')) {
			runOnceInitialized(updateSyncAlarmIntervalAndFetchData, [tabId]);
		}
	});

	// Handle tab closing
	browser.tabs.onRemoved.addListener((tabId, removeInfo) =>
		runOnceInitialized(updateSyncAlarmIntervalAndFetchData, [tabId, true])
	);

	addContainerFetchListener();
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
		const wasOrgDataCleared = await tokenStorageManager.checkAndCleanExpiredData();
		if (wasOrgDataCleared) await updateAllTabsWithUsage();
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
			} catch (error) {
				await Log("error", "Failed to create notification:", error);
			}
		}
		const orgId = alarm.name.split('_')[1];
		await Log(`Notification sent`);
		await firebaseManager.triggerReset(orgId)
	}
});
//#endregion

//#region Alarms
browser.alarms.create('checkExpiredData', {
	periodInMinutes: 5
});

async function updateSyncAlarmIntervalAndFetchData(sourceTabId, fromRemovedEvent = false) {
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


async function Log(...args) {
	await RawLog("background", ...args)
};

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


//#endregion

//#region Manager classes

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
		return Math.round(isCached ? 0 : projectSize);
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
		const currentTrunk = [];
		const currentTrunkIds = new Set();
		let humanMessagesCount = 0;
		let assistantMessagesCount = 0;
		let currentId = conversationData.current_leaf_message_uuid;
		const rootId = "00000000-0000-4000-8000-000000000000";

		while (currentId && currentId !== rootId) {
			const message = messageMap.get(currentId);
			if (!message) {
				await Log("warn", `Message ${currentId} not found in tree`);
				break;
			}

			currentTrunk.unshift(message);
			currentTrunkIds.add(message.uuid);

			// Count while building
			if (message.sender === "human") humanMessagesCount++;
			else if (message.sender === "assistant") assistantMessagesCount++;

			currentId = message.parent_message_uuid;
		}

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
			const projectTokens = await this.getProjectTokens(conversationData.project_uuid, isNewMessage);
			lengthTokens += projectTokens;
			costTokens += projectTokens;
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

//#endregion


//#region Messaging

// Updates all tabs with usage data only
async function updateAllTabsWithUsage() {
	await Log("Updating all tabs with usage data");
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });

	for (const tab of tabs) {
		const orgId = await requestActiveOrgId(tab);
		await Log("Updating tab:", tab.id, "with orgId:", orgId);

		// Create API to get subscription tier
		const api = new ClaudeAPI(tab.cookieStoreId, orgId);
		const subscriptionTier = await api.getSubscriptionTier();

		// Get usage data with tier
		const usageData = await tokenStorageManager.getUsageData(orgId, subscriptionTier);

		await Log("Updating tab with usage data:", JSON.stringify(usageData));
		sendTabMessage(tab.id, {
			type: 'updateUsage',
			data: {
				usageData: usageData.toJSON()
			}
		});
	}
}

// Updates a specific tab with conversation metrics
async function updateTabWithConversationMetrics(tabId, conversationData) {
	await Log("Updating tab with conversation metrics:", tabId, conversationData);

	sendTabMessage(tabId, {
		type: 'updateConversationMetrics',
		data: {
			conversationData: conversationData.toJSON()
		}
	});
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

// Create the registry
const messageRegistry = new MessageHandlerRegistry();

// Simple handlers with inline functions
messageRegistry.register('getConfig', () => CONFIG);
messageRegistry.register('initOrg', (message, sender, orgId) => tokenStorageManager.addOrgId(orgId).then(() => true));
// Update getUsageCap handler
messageRegistry.register('getUsageCap', async (message, sender, orgId) => {
	const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);
	const tier = await api.getSubscriptionTier();
	const usageData = await tokenStorageManager.getUsageData(orgId, tier);
	return usageData.usageCap;
});

messageRegistry.register('resetOrgData', (message, sender, orgId) => firebaseManager.triggerReset(orgId));


messageRegistry.register('rateLimitExceeded', async (message, sender, orgId) => {
	// Only add reset if we actually exceeded the limit
	if (message?.detail?.type === 'exceeded_limit') {
		await Log(`Rate limit exceeded for org ${orgId}, adding reset`);
		const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);
		const tier = await api.getSubscriptionTier();

		await tokenStorageManager.addReset(orgId, "Sonnet", tier)
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
	const { conversationId } = message;
	const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);

	// Get subscription tier
	const subscriptionTier = await api.getSubscriptionTier();

	// Always send usage data
	const usageData = await tokenStorageManager.getUsageData(orgId, subscriptionTier);
	await sendTabMessage(sender.tab.id, {
		type: 'updateUsage',
		data: {
			usageData: usageData.toJSON()  // Send in storage format
		}
	});

	// If conversationId provided, also send conversation metrics
	if (conversationId) {
		await Log(`Requested metrics for conversation: ${conversationId}`);
		const conversationData = await api.getConversationInfo(conversationId, false);
		const profileTokens = await api.getProfileTokens();

		if (conversationData) {
			// Add profile tokens to the conversation data
			conversationData.length += profileTokens;
			conversationData.cost += profileTokens * CONFIG.CACHING_MULTIPLIER;

			await updateTabWithConversationMetrics(sender.tab.id, conversationData);
		}
	}

	await Log("Sent update messages to tab");
	return true;
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

	const pendingResponse = await pendingResponses.get(responseKey);
	const isNewMessage = pendingResponse !== undefined;

	// Get subscription tier
	const subscriptionTier = await api.getSubscriptionTier();

	const conversationData = await api.getConversationInfo(conversationId, isNewMessage);
	if (!conversationData) {
		await Log("warn", "Could not get conversation tokens, exiting...")
		return false;
	}

	const profileTokens = await api.getProfileTokens();
	conversationData.cost += profileTokens;

	await Log("Current base length:", conversationData.length);
	await Log("Current message cost (raw):", conversationData.cost);

	// The style is processed _after_ we set the conversationLengthCache, as it can vary.
	const styleTokens = await api.getStyleTokens(pendingResponse?.styleId, tabId);
	conversationData.cost += styleTokens;
	await Log("Added style tokens:", styleTokens);

	if (pendingResponse?.toolDefinitions) {
		let toolTokens = 0;
		for (const tool of pendingResponse.toolDefinitions) {
			toolTokens += await tokenCounter.countText(
				`${tool.name} ${tool.description} ${tool.schema}`
			);
		}
		await Log("Added tool definition tokens:", toolTokens);
		conversationData.cost += toolTokens;
	}

	if (isNewMessage) {
		const model = pendingResponse.model;
		const modelWeight = CONFIG.MODEL_WEIGHTS[model] || 1;
		const weightedCost = conversationData.cost * modelWeight;

		await Log(`Raw message cost: ${conversationData.cost}, Model weight: ${modelWeight}, Weighted cost: ${weightedCost}`);

		const requestTime = pendingResponse.requestTimestamp;
		const conversationFullData = await api.getConversation(conversationId);
		const latestMessageTime = new Date(conversationFullData.chat_messages[conversationFullData.chat_messages.length - 1].created_at).getTime();
		if (latestMessageTime < requestTime - 5000) {
			await Log("Message appears to be older than our request, likely an error");
		} else {
			await Log(`=============Adding tokens for model: ${model}, Raw tokens: ${conversationData.cost}, Weighted tokens: ${weightedCost}============`);
			// Store the raw tokens internally
			await tokenStorageManager.addTokensToModel(orgId, model, conversationData.cost, subscriptionTier);
		}
	}

	const model = pendingResponse?.model || conversationData.model || "Sonnet";
	conversationData.model = model;  // Ensure it's set

	// Update all tabs with usage data
	await updateAllTabsWithUsage();

	// Update specific tab with conversation metrics
	await updateTabWithConversationMetrics(tabId, conversationData);

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

//#endregion

//#region Variable fill in and initialization
pendingResponses = new StoredMap("pendingResponses"); // conversationId -> {userId, tabId}
capModifiers = new StoredMap('capModifiers');
subscriptionTiersCache = new StoredMap("subscriptionTiers");
scheduledNotifications = new StoredMap('scheduledNotifications');
tokenCounter = new TokenCounter();
if (!tokenStorageManager) tokenStorageManager = new TokenStorageManager();
firebaseManager = new FirebaseSyncManager(tokenStorageManager, updateAllTabsWithUsage);

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
updateSyncAlarmIntervalAndFetchData();
Log("Done initializing.")
//#endregion