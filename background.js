import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, sleep, RawLog, FORCE_DEBUG, containerFetch, addContainerFetchListener, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, MessageHandlerRegistry } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter, getTextFromContent } from './bg-components/tokenManagement.js';
import { firebaseSyncManager } from './bg-components/firebase.js';
import { UsageData, ConversationData } from './bg-components/bg-dataclasses.js';
import { ClaudeAPI, ConversationAPI } from './bg-components/claude-api.js';

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
let capModifiers;
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

// Temporary telemetry to try and identify the memory leak. Only works if debug mode is enabled.
const functionCallCounts = new Map();
const SUSPICIOUS_THRESHOLD = 10000;
let alertSent = false;

async function trackCall(functionName) {
    const debugUntil = await getStorageValue('debug_mode_until');
    const now = Date.now();
    
    if ((!debugUntil || debugUntil <= now) && !FORCE_DEBUG) {
        return;
    }
    
    const count = (functionCallCounts.get(functionName) || 0) + 1;
    functionCallCounts.set(functionName, count);
    
    // Check total across all functions
    let totalCalls = 0;
    for (const [_, funcCount] of functionCallCounts) {
        totalCalls += funcCount;
    }
    
    if (totalCalls >= SUSPICIOUS_THRESHOLD && !alertSent) {
		console.error("Total count", totalCalls, "has reached the suspicious threshold of", SUSPICIOUS_THRESHOLD);
		console.error(functionCallCounts)
        alertSent = true;  // Only send once per service worker lifetime
        await sendTelemetryAlert();
    }
}


// Send the entire map as one object
async function sendTelemetryAlert() {
    const alertId = crypto.randomUUID();
    const url = `https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app/telemetry/${alertId}.json`;
    
    const report = {
        counts: Object.fromEntries(functionCallCounts),  // The entire map
        timestamp: Date.now(),
        version: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        trigger: 'threshold_exceeded'
    };
    
    await fetch(url, {
        method: 'PUT',
        body: JSON.stringify(report)
    });
}

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
	trackCall("AlarmWakeup");

	await tokenStorageManager.ensureOrgIds();

	if (alarm.name === 'firebaseSync') {
		await firebaseSyncManager.syncWithFirebase();
	}

	if (alarm.name === 'capHitsSync') {
		await firebaseSyncManager.syncCapHits();
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
		} else if (isElectron) {
			// Send notification request to active Claude tab
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*", active: true });
			if (tabs.length > 0) {
				await sendTabMessage(tabs[0].id, {
					type: 'createElectronNotification',
					options: {
						title: 'Claude Usage Reset',
						message: 'Your Claude usage limit has been reset!'
					}
				});
			}
		}
		const orgId = alarm.name.split('_')[1];
		await Log(`Notification sent`);
		await firebaseSyncManager.triggerReset(orgId)
	}
});
//#endregion

//#region Alarms
async function updateSyncAlarmIntervalAndFetchData(sourceTabId, fromRemovedEvent = false) {
	trackCall("updateSyncAlarmIntervalAndFetchData");
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
			await firebaseSyncManager.syncWithFirebase();
		}
	}
}

browser.alarms.create('capHitsSync', { periodInMinutes: 10 });
Log("Firebase alarms created.");
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


async function requestActiveOrgId(tab) {
	trackCall("requestActiveOrgId");
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
	trackCall("updateAllTabsWithUsage");
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
async function updateTabWithConversationData(tabId, conversationData) {
	trackCall("updateTabWithConversationData");
	await Log("Updating tab with conversation metrics:", tabId, conversationData);

	sendTabMessage(tabId, {
		type: 'updateConversationData',
		data: {
			conversationData: conversationData.toJSON()
		}
	});
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

messageRegistry.register('resetOrgData', (message, sender, orgId) => firebaseSyncManager.triggerReset(orgId));


messageRegistry.register('rateLimitExceeded', async (message, sender, orgId) => {
	trackCall("RateLimitExceeded");
	// Only add reset if we actually exceeded the limit
	if (message?.detail?.type === 'exceeded_limit') {
		await Log(`Rate limit exceeded for org ${orgId}, adding reset`);
		const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);
		const tier = await api.getSubscriptionTier();

		await tokenStorageManager.addCapHit(orgId, "Sonnet", tier)
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

messageRegistry.register('getCapModifier', async () => {
	return await capModifiers.get('global') || 1;
});
messageRegistry.register('setCapModifier', async (message) => {
	await capModifiers.set('global', message.modifier);
	return true;
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

messageRegistry.register('electronTabActivated', (message, sender) => {
    updateSyncAlarmIntervalAndFetchData(sender.tab.id);
    return true;
});

messageRegistry.register('electronTabDeactivated', (message, sender) => {
    updateSyncAlarmIntervalAndFetchData(sender.tab.id);
    return true;
});

messageRegistry.register('electronTabRemoved', (message, sender) => {
    updateSyncAlarmIntervalAndFetchData(sender.tab.id, true);
    return true;
});


messageRegistry.register('checkAndResetExpired', async (message, sender, orgId) => {
	await Log(`UI triggered reset check for org ${orgId}`);
	const wasCleared = await tokenStorageManager.checkAndCleanExpiredData(orgId);
	if (wasCleared) {
		await Log("Usage was expired and reset");
		await updateAllTabsWithUsage();
	}
	return wasCleared;
});

// Complex handlers
async function requestData(message, sender, orgId) {
	trackCall("requestData");
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
		const conversation = await api.getConversation(conversationId);
		const conversationData = await conversation.getInfo(false);
		const profileTokens = await api.getProfileTokens();

		if (conversationData) {
			// Add profile tokens to the conversation data
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

async function shouldShowDonationNotification(message) {
	trackCall("shouldShowDonationNotification");
	const { currentVersion } = message;
	let previousVersion = await getStorageValue('previousVersion');

	// Prepare response object
	const donationInfo = {
		shouldShow: false,
		versionMessage: '',
		patchHighlights: []
	};

	// First install - don't show notification
	if (!previousVersion) {
		await setStorageValue('previousVersion', currentVersion);
		return donationInfo;
	}

	// Get total tokens tracked
	const totalTokens = await tokenStorageManager.getTotalTokens();
	const tokenThresholds = CONFIG.DONATION_TOKEN_THRESHOLDS;
	const shownDonationThresholds = await getStorageValue('shownDonationThresholds', []);

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

		await setStorageValue('previousVersion', currentVersion);
	}
	else if (exceededThreshold) {
		const tokenMillions = Math.floor(exceededThreshold / 1000000);
		donationInfo.shouldShow = true;
		donationInfo.versionMessage = `You've tracked over ${tokenMillions}M tokens with this extension!`;
		donationInfo.patchHighlights = [
			"Please consider supporting continued development with a donation!"
		];

		// Mark this threshold as shown
		await setStorageValue('shownDonationThresholds', [...shownDonationThresholds, exceededThreshold]);
	}
	return donationInfo;
}
messageRegistry.register(shouldShowDonationNotification);

// Main handler function
async function handleMessageFromContent(message, sender) {
	trackCall("handleMessageFromContent");
	return messageRegistry.handle(message, sender);
}
//#endregion



//#region Network handling
async function parseRequestBody(requestBody) {
	trackCall("parseRequestBody");
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
	trackCall("processResponse");
	const tabId = details.tabId;
	const api = new ClaudeAPI(details.cookieStoreId, orgId);
	await Log("Processing response...")

	const pendingRequest = await pendingRequests.get(responseKey);
	const isNewMessage = pendingRequest !== undefined;

	// Get subscription tier
	const subscriptionTier = await api.getSubscriptionTier();

	const conversation = await api.getConversation(conversationId);
	const conversationData = await conversation.getInfo(isNewMessage);
	if (!conversationData) {
		await Log("warn", "Could not get conversation tokens, exiting...")
		return false;
	}

	await Log("Current base length:", conversationData.length);
	await Log("Current message cost (raw):", conversationData.cost);

	// Process all the modifiers
	let modifierCost = 0;
	const profileTokens = await api.getProfileTokens();
	modifierCost += profileTokens;

	const styleTokens = await api.getStyleTokens(pendingRequest?.styleId, tabId);
	modifierCost += styleTokens;
	await Log("Added style tokens:", styleTokens);

	if (pendingRequest?.toolDefinitions) {
		let toolTokens = 0;
		for (const tool of pendingRequest.toolDefinitions) {
			toolTokens += await tokenCounter.countText(
				`${tool.name} ${tool.description} ${tool.schema}`
			);
		}
		await Log("Added tool definition tokens:", toolTokens);
		modifierCost += toolTokens;
	}
	conversationData.cost += modifierCost;

	const model = pendingRequest?.model || conversationData.model || "Sonnet";
	if (isNewMessage) {
		const weightedCost = conversationData.getWeightedCost(model);

		await Log(`Raw message cost: ${conversationData.cost}, Model: ${model}, Weighted cost: ${weightedCost}`);

		const requestTime = pendingRequest.requestTimestamp;
		if (conversationData.lastMessageTimestamp < requestTime - 5000) {
			await Log("Message appears to be older than our request, likely an error");
		} else {
			await Log(`=============Adding tokens for model: ${model}, Raw tokens: ${conversationData.cost}, Weighted tokens: ${weightedCost}============`);
			await tokenStorageManager.addTokensToModel(orgId, model, conversationData.cost, subscriptionTier);
		}
	}

	conversationData.model = model;  // Ensure it's set before forwarding it

	// Update all tabs with usage data
	await updateAllTabsWithUsage();

	// Update specific tab with conversation metrics
	await updateTabWithConversationData(tabId, conversationData);

	return true;
}


// Listen for message sending
async function onBeforeRequestHandler(details) {
	trackCall("onBeforeRequestHandler");
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

		// Store pending request with all data
		await pendingRequests.set(key, {
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
	trackCall("onCompletedHandler");
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
	trackCall("processNextTask");
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
capModifiers = new StoredMap('capModifiers');
scheduledNotifications = new StoredMap('scheduledNotifications');
firebaseSyncManager.setUpdateAllTabsCallback(updateAllTabsWithUsage);

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
updateSyncAlarmIntervalAndFetchData();
Log("Done initializing.")
//#endregion