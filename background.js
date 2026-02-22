import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, sleep, RawLog, FORCE_DEBUG, containerFetch, addContainerFetchListener, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, messageRegistry } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter } from './bg-components/tokenManagement.js';
import { ClaudeAPI, ConversationAPI } from './bg-components/claude-api.js';
import { UsageData } from './shared/dataclasses.js';
import { scheduleAlarm, createNotification } from './bg-components/electron-compat.js';

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
let processingLock = null;  // Unix timestamp or null
const pendingTasks = [];
const LOCK_TIMEOUT = 30000;  // 30 seconds - if a task takes longer, something's wrong
let pendingRequests;
let scheduledNotifications;

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
		// Always open debug page when clicking the extension icon
		browser.tabs.create({
			url: browser.runtime.getURL('debug.html')
		});
	});
}


if (browser.contextMenus) {
	browser.runtime.onInstalled.addListener(() => {
		browser.contextMenus.create({
			id: 'openDebugPage',
			title: 'Open Debug Page',
			contexts: ['action']
		});

		browser.contextMenus.create({
			id: 'openDonatePage',
			title: 'Donate',
			contexts: ['action']
		});

	});

	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (info.menuItemId === 'openDebugPage') {
			browser.tabs.create({
				url: browser.runtime.getURL('debug.html')
			});
		} else if (info.menuItemId === 'openDonatePage') {
			browser.tabs.create({
				url: "https://ko-fi.com/lugia19"
			});
		}
	});
}


if (!isElectron) {
	// WebRequest listeners
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

	addContainerFetchListener();
}

//Alarm listeners
const handledAlarms = new Set();

async function handleAlarm(alarmName) {
	if (handledAlarms.has(alarmName)) {
		await Log("warn", "Alarm already handled, skipping:", alarmName);
		return;
	}
	handledAlarms.add(alarmName);

	await Log("Alarm triggered:", alarmName);

	if (alarmName.startsWith('notifyReset_')) {
		try {
			await createNotification({
				type: 'basic',
				iconUrl: browser.runtime.getURL('icon128.png'),
				title: 'Claude Usage Reset',
				message: 'Your Claude usage limit has been reset!'
			});
			await Log(`Notification sent for: ${alarmName}`);
		} catch (error) {
			await Log("error", "Failed to create notification:", error);
		}
	}
}
let alarmListenerRegistered = false;
if (chrome.alarms) {
	if (chrome.alarms && !alarmListenerRegistered) {
		alarmListenerRegistered = true;
		chrome.alarms.onAlarm.addListener(alarm => handleAlarm(alarm.name));
	}
} else {
	messageRegistry.register('electron-alarm', (msg) => {
		handleAlarm(msg.name);
	});
}


//#endregion

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


//#endregion


async function requestActiveOrgId(tab) {
	if (typeof tab === "number") {
		tab = await browser.tabs.get(tab);
	}
	if (chrome.cookies) {
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
async function updateAllTabsWithUsage(usageData = null) {
	await Log("Updating all tabs with usage data");
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });

	for (const tab of tabs) {
		let data = usageData;

		// If no usageData provided, fetch fresh
		if (!data) {
			const orgId = await requestActiveOrgId(tab);
			const api = new ClaudeAPI(tab.cookieStoreId, orgId);
			const usageLimitsResponse = await api.getUsageLimits();
			const subscriptionTier = await api.getSubscriptionTier();
			data = UsageData.fromAPIResponse(usageLimitsResponse, subscriptionTier);
		}

		sendTabMessage(tab.id, {
			type: 'updateUsage',
			data: {
				usageData: data.toJSON()
			}
		});
	}
}

// Updates a specific tab with conversation metrics
async function updateTabWithConversationData(tabId, conversationData) {
	await Log("Updating tab with conversation metrics:", tabId, conversationData);

	sendTabMessage(tabId, {
		type: 'updateConversationData',
		data: {
			conversationData: conversationData.toJSON()
		}
	});
}

// Create the registry

// Simple handlers with inline functions
messageRegistry.register('getConfig', () => CONFIG);
messageRegistry.register('initOrg', (message, sender, orgId) => tokenStorageManager.addOrgId(orgId).then(() => true));

messageRegistry.register('getAPIKey', () => getStorageValue('apiKey'));
messageRegistry.register('setAPIKey', async (message) => {
	const newKey = message.newKey;
	if (newKey === "") {
		await removeStorageValue('apiKey');
		return true;
	}

	// Test the new key
	const isValid = await tokenCounter.testApiKey(newKey);

	if (isValid) {
		await setStorageValue('apiKey', newKey);
		await Log("API key validated and saved");
		return true;
	} else {
		await Log("warn", "API key validation failed");
		return false;
	}
});

messageRegistry.register('isElectron', () => isElectron);
messageRegistry.register('getMonkeypatchPatterns', () => isElectron ? INTERCEPT_PATTERNS : false);

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

	// Fetch usage from endpoint
	const usageLimitsResponse = await api.getUsageLimits();
	const subscriptionTier = await api.getSubscriptionTier();
	const usageData = UsageData.fromAPIResponse(usageLimitsResponse, subscriptionTier);

	// Schedule notifications for any maxed limits
	await scheduleResetNotifications(orgId, usageData);

	// Send usage data
	await sendTabMessage(sender.tab.id, {
		type: 'updateUsage',
		data: { usageData: usageData.toJSON() }
	});

	// If conversationId provided, also send conversation metrics
	if (conversationId) {
		await Log(`Requested metrics for conversation: ${conversationId}`);
		const conversation = await api.getConversation(conversationId);
		const conversationData = await conversation.getInfo(false);
		const profileTokens = await api.getProfileTokens();

		if (conversationData) {
			conversationData.length += profileTokens;
			conversationData.cost += profileTokens * CONFIG.CACHING_MULTIPLIER;
			await updateTabWithConversationData(sender.tab.id, conversationData);
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

async function getTotalTokensTracked() {
	return await tokenStorageManager.getTotalTokens();
}
messageRegistry.register(getTotalTokensTracked);

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
	await Log("Processing response...");

	const pendingRequest = await pendingRequests.get(responseKey);
	const isNewMessage = pendingRequest !== undefined;
	const model = pendingRequest?.model || "Sonnet";

	// Fetch current usage limits from endpoint
	const usageLimitsResponse = await api.getUsageLimits();
	const subscriptionTier = await api.getSubscriptionTier();
	const usageData = UsageData.fromAPIResponse(usageLimitsResponse, subscriptionTier);

	// Fetch conversation data
	const conversation = await api.getConversation(conversationId);
	const conversationData = await conversation.getInfo(isNewMessage);

	if (!conversationData) {
		await Log("warn", "Could not get conversation data, exiting...");
		return false;
	}

	// Add modifier costs to conversation data
	let modifierCost = 0;
	const profileTokens = await api.getProfileTokens();
	modifierCost += profileTokens;

	const styleTokens = await api.getStyleTokens(pendingRequest?.styleId, tabId);
	modifierCost += styleTokens;

	if (pendingRequest?.toolDefinitions) {
		let toolTokens = 0;
		for (const tool of pendingRequest.toolDefinitions) {
			toolTokens += await tokenCounter.countText(
				`${tool.name} ${tool.description} ${tool.schema}`
			);
		}
		modifierCost += toolTokens;
	}

	conversationData.cost += modifierCost;
	conversationData.futureCost += modifierCost;
	conversationData.length += profileTokens;
	conversationData.model = model;

	// If new message: log delta and update total tokens
	if (isNewMessage && pendingRequest.previousUsage) {
		const previousUsage = UsageData.fromJSON(pendingRequest.previousUsage);
		await logUsageDelta(orgId, previousUsage, usageData, conversationData.length, model);

		// Add message cost to total tracked
		await tokenStorageManager.addToTotalTokens(conversationData.cost);

		// Debug: log per-message cost keyed by limit reset timestamps
		await debugLogMessageCost(usageData, conversationData);
	}

	// Schedule notifications for any maxed limits
	await scheduleResetNotifications(orgId, usageData);

	// Send updates to UI
	await updateAllTabsWithUsage(usageData);
	await updateTabWithConversationData(tabId, conversationData);

	return true;
}

async function debugLogMessageCost(usageData, conversationData) {
	if (!FORCE_DEBUG) return;

	const limitMapping = {
		session: 'debug_session',
		weekly: 'debug_weekly',
		sonnetWeekly: 'debug_sonnet_weekly',
		opusWeekly: 'debug_opus_weekly'
	};

	for (const [limitKey, storagePrefix] of Object.entries(limitMapping)) {
		const limit = usageData.limits[limitKey];
		if (!limit) continue;

		const storageKey = `${storagePrefix}_${limit.resetsAt}`;
		const existing = await getStorageValue(storageKey, {
			resetsAt: limit.resetsAt,
			limitKey,
			messages: [],
			accumulatedCost: 0,
			lastPercentage: null
		});

		const percentageChanged = existing.lastPercentage !== null && limit.percentage !== existing.lastPercentage;

		if (percentageChanged) {
			// Percentage changed - log entry with accumulated cost included
			const entry = {
				timestamp: Date.now(),
				cost: conversationData.cost,
				accumulatedCost: existing.accumulatedCost,
				totalCost: conversationData.cost + existing.accumulatedCost,
				futureCost: conversationData.futureCost,
				model: conversationData.model,
				conversationLength: conversationData.length,
				percentageDelta: limit.percentage - existing.lastPercentage,
			};
			existing.messages.push(entry);
			existing.accumulatedCost = 0; // Reset accumulator
			await Log(`Debug [${limitKey}]: logged message cost ${entry.totalCost} (accumulated: ${entry.accumulatedCost}, this msg: ${entry.cost}, delta: ${entry.percentageDelta}%)`);
		} else {
			// Percentage didn't change - accumulate the cost
			existing.accumulatedCost += conversationData.cost;
			await Log(`Debug [${limitKey}]: accumulated cost ${conversationData.cost}, total accumulated: ${existing.accumulatedCost}`);
		}

		existing.lastPercentage = limit.percentage;
		await setStorageValue(storageKey, existing);
	}
}

async function logUsageDelta(orgId, previousUsage, currentUsage, conversationLength, model) {
	const deltas = {};

	for (const [key, currentLimit] of Object.entries(currentUsage.limits)) {
		if (!currentLimit) continue;

		const previousLimit = previousUsage.limits[key];
		if (!previousLimit) continue;

		const delta = currentLimit.percentage - previousLimit.percentage;

		// Only log if change >= 1%
		if (delta >= 1) {
			deltas[key] = delta;
		}
	}

	if (Object.keys(deltas).length > 0) {
		const entry = {
			timestamp: Date.now(),
			orgId,
			conversationLength,
			model,
			deltas
		};

		await Log(`Usage delta: ${JSON.stringify(entry)}`);
	}
}

// This just exists to avoid a possible race condition where multiple messages in quick succession could trigger multiple notifications for the same limit reset
const pendingSchedules = new Set();

async function scheduleResetNotifications(orgId, usageData) {
	const maxedLimits = usageData.getMaxedLimits();

	for (const limit of maxedLimits) {
		const timestampKey = limit.resetsAt.toString();

		// In-memory guard against concurrent calls
		if (pendingSchedules.has(timestampKey)) continue;
		pendingSchedules.add(timestampKey);

		try {
			if (await scheduledNotifications.has(timestampKey)) {
				continue;
			}

			const alarmName = `notifyReset_${orgId}_${limit.key}_${timestampKey}`;
			await scheduleAlarm(alarmName, { when: limit.resetsAt });

			const expiryTime = limit.resetsAt + (60 * 60 * 1000) - Date.now();
			await scheduledNotifications.set(timestampKey, alarmName, expiryTime);

			await Log(`Scheduled notification: ${alarmName} for ${new Date(limit.resetsAt).toISOString()}`);
		} finally {
			setTimeout(() => pendingSchedules.delete(timestampKey), 5000);
		}
	}
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

		// Fetch current usage to snapshot before message
		let previousUsage = null;
		try {
			const api = new ClaudeAPI(details.cookieStoreId, orgId);
			const currentUsage = await api.getUsageLimits();
			const subscriptionTier = await api.getSubscriptionTier();
			const usageData = UsageData.fromAPIResponse(currentUsage, subscriptionTier);
			previousUsage = usageData.toJSON();
		} catch (error) {
			await Log("warn", "Failed to fetch pre-message usage snapshot:", error);
		}

		// Store pending request with all data
		await pendingRequests.set(key, {
			orgId: orgId,
			conversationId: conversationId,
			tabId: details.tabId,
			styleId: styleId,
			model: model,
			requestTimestamp: Date.now(),
			toolDefinitions: toolDefs,
			previousUsage: previousUsage
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
	if (details.method === "GET" &&
		details.url.includes("/chat_conversations/") &&
		details.url.includes("tree=True") &&
		details.url.includes("render_all_tools=true")) {

		pendingTasks.push(async () => {
			const urlParts = details.url.split('/');
			const orgId = urlParts[urlParts.indexOf('organizations') + 1];
			await tokenStorageManager.addOrgId(orgId);
			const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]?.split('?')[0];

			const key = `${orgId}:${conversationId}`;
			const result = await processResponse(orgId, conversationId, key, details);

			if (result && await pendingRequests.has(key)) {
				await pendingRequests.delete(key);
			}
		});

		processNextTask();
	}
}

async function processNextTask() {
	// Check if already processing
	if (processingLock) {
		const lockAge = Date.now() - processingLock;
		if (lockAge < LOCK_TIMEOUT) {
			return;  // Still legitimately processing
		}
		// Lock is stale, force clear it
		await Log("warn", `Stale processing lock detected (${lockAge}ms old), clearing`);
	}

	if (pendingTasks.length === 0) return;

	processingLock = Date.now();
	const task = pendingTasks.shift();

	try {
		await task();
	} catch (error) {
		await Log("error", "Task processing failed:", error);
	} finally {
		// ALWAYS clear the lock, no matter what
		processingLock = null;

		// Process next task if any
		if (pendingTasks.length > 0) {
			processNextTask();  // Not awaited
		}
	}
}
//#endregion

//#region Variable fill in and initialization
pendingRequests = new StoredMap("pendingRequests"); // conversationId -> {userId, tabId}
scheduledNotifications = new StoredMap('scheduledNotifications');

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
Log("Done initializing.")
//#endregion