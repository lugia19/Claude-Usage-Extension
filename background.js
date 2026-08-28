import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, messageRegistry } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter } from './bg-components/tokenManagement.js';
import { getStrategy, initContainerStrategy, setBrave } from './bg-components/container-strategy.js';
import { UsageData, modelFamilyFromVersion, defaultModelForTier, defaultModelVersionForTier } from './shared/dataclasses.js';
import { translate, normalizeLocale } from './shared/localization.js';
import { scheduleAlarm, getAlarm, createNotification } from './bg-components/electron-compat.js';
import { invalidateAccountSettings, invalidateProfileTokens, storeSseUsage } from './bg-components/claude-api.js';

const INTERCEPT_PATTERNS = {
	onBeforeRequest: {
		urls: [
			"*://claude.ai/api/organizations/*/completion",
			"*://claude.ai/api/organizations/*/retry_completion",
			"*://claude.ai/api/settings/billing*",
			"*://claude.ai/api/account_profile",
			"*://claude.ai/api/account/settings*"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/completion$",
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/retry_completion$",
			"^https?://claude\\.ai/api/settings/billing",
			"^https?://claude\\.ai/api/account_profile$",
			"^https?://claude\\.ai/api/account/settings"
		]
	},
	onCompleted: {
		urls: [
			"*://claude.ai/api/organizations/*/chat_conversations/*",
			"*://claude.ai/v1/sessions/*/events",
			"*://claude.ai/api/account_profile"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*$",
			"^https?://claude\\.ai/v1/sessions/[^/]*/events$",
			"^https?://claude\\.ai/api/account_profile$"
		]
	}
};

//#region Variable declarations
let processingLock = null;  // Unix timestamp or null
const pendingLocaleReloads = new Map();  // tabId -> normalized new locale (set in onBeforeRequest, consumed in onCompleted)
const pendingTasks = [];
const LOCK_TIMEOUT = 30000;  // 30 seconds - if a task takes longer, something's wrong
let pendingRequests;
let scheduledNotifications;
let electronPollingInterval = null;
let electronPollInFlight = false;

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

	initContainerStrategy();
}

//Alarm listeners

async function handleAlarm(alarmName) {
	await Log("Alarm triggered:", alarmName);

	if (alarmName === 'checkResetNotifications') {
		// Heartbeat: the only other things that refresh a tab's usage are sending a message and
		// loading a conversation, so a tab left sitting on an expired limit has no way back on its
		// own if its refresh request failed. Push fresh data every tick regardless of whether reset
		// notifications are enabled. Electron already polls on its own interval.
		if (!isElectron) {
			try {
				await updateAllTabsWithUsage();
			} catch (error) {
				await Log("warn", "Usage heartbeat failed:", error);
			}
		}
		await checkResetNotifications();
	}
}

async function checkResetNotifications() {
	const enabled = await getStorageValue('resetNotifEnabled', false);
	if (!enabled) return;

	const entries = await scheduledNotifications.entries();
	if (!entries || entries.length === 0) return;

	const now = Date.now();
	let shouldNotify = false;

	for (const [timestampKey, orgId] of entries) {
		const resetTime = parseInt(timestampKey);
		if (resetTime > now) continue;

		// Skip if reset happened more than 10 minutes ago (stale entry)
		if (now - resetTime > 10 * 60 * 1000) {
			await scheduledNotifications.delete(timestampKey);
			continue;
		}

		// Reset time has passed — check if session usage is at 0%
		try {
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
			if (tabs.length === 0) {
				// No tabs open, remove the entry and skip
				await scheduledNotifications.delete(timestampKey);
				continue;
			}

			const tab = tabs[0];
			const tabOrgId = await requestActiveOrgId(tab);
			const api = getStrategy().apiForTab(tab, tabOrgId);
			const usageData = await api.getUsageData();

			// Only notify if session usage is at 0% (user hasn't started chatting again)
			const sessionLimit = usageData.limits.session;
			if (!sessionLimit || sessionLimit.percentage === 0) {
				shouldNotify = true;
			}
		} catch (error) {
			await Log("warn", "Error checking reset status:", error);
		}

		// Remove processed entry regardless
		await scheduledNotifications.delete(timestampKey);
	}

	if (shouldNotify) {
		try {
			const stored = await browser.storage.local.get('lastLang');
			const loc = normalizeLocale(stored.lastLang || 'en');
			await createNotification({
				type: 'basic',
				iconUrl: browser.runtime.getURL('icon128.png'),
				title: translate(loc, 'bg.reset_title'),
				message: translate(loc, 'bg.reset_message')
			});
			await Log("Reset notification sent");
		} catch (error) {
			await Log("error", "Failed to create reset notification:", error);
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
	// The active strategy knows how to read the active org for this platform's container model.
	return getStrategy().activeOrgForTab(tab);
}

//#endregion


//#region Messaging

// Updates all tabs with usage data only
async function updateAllTabsWithUsage(usageData = null) {
	await Log("Updating all tabs with usage data");
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });

	// Several tabs commonly share one org; fetch once per org rather than once per tab.
	const fetchesByOrg = new Map();

	for (const tab of tabs) {
		// One tab failing (org lookup, fetch, or a tab that closed mid-loop) must not cost every
		// remaining tab its update - this runs unattended from the heartbeat.
		try {
			let data = usageData;

			// If no usageData provided, fetch fresh
			if (!data) {
				const orgId = await requestActiveOrgId(tab);
				if (!fetchesByOrg.has(orgId)) {
					const api = getStrategy().apiForTab(tab, orgId);
					fetchesByOrg.set(orgId, api.getUsageData());
				}
				data = await fetchesByOrg.get(orgId);
			}

			sendTabMessage(tab.id, {
				type: 'updateUsage',
				data: {
					usageData: data.toJSON()
				}
			}).catch(error => Log("warn", `Failed to push usage to tab ${tab.id}:`, error));
		} catch (error) {
			await Log("warn", `Failed to update tab ${tab.id} with usage data:`, error);
		}
	}
}

// A conversation record can lag the message that created it: a freshly created chat comes back from
// the API with no model at all. getInfo() no longer papers over that with a tier default - it
// reports the model as unknown - and isCurrentlyCached refuses to claim a cache hit it cannot
// verify, so without this the indicator would stay hidden on a brand-new chat. The request body we
// captured is authoritative, so prefer it while it is fresh. Bounded by time because pending entries
// now expire rather than being deleted on use.
const PENDING_MODEL_TRUST_MS = 5 * 60 * 1000;

// pendingRequests is two layers: the outer StoredMap key is the conversation, and each value is a
// bucket of { [turn assistant uuid]: entry }.
//
// The inner key comes from turn_message_uuids.assistant_message_uuid in the completion request body
// - claude.ai pre-generates the uuid the assistant message WILL have, and it is the same uuid the
// SSE stream reports as message_start.message.uuid and the tree reports as
// current_leaf_message_uuid. So both the provisional and the authoritative pass can name exactly
// which message they are talking about, instead of "whatever is pending for this conversation".
//
// That ambiguity is what made a second message sent moments after the first read the previous
// message's prompt/tools/model and skip its own accounting. Keeping the conversation as the OUTER
// key preserves StoredMap's per-key TTL at the granularity that matters for eviction, and keeps the
// two consumers that legitimately want "the newest request here" on a single get.
// Marks a bucket key that isn't a real turn uuid — see getPendingRequest.
const SYNTHETIC_TURN_PREFIX = 'ts:';

async function getPendingBucket(orgId, conversationId) {
	const stored = await pendingRequests.get(`${orgId}:${conversationId}`);
	if (!stored || typeof stored !== 'object') return {};

	// Anything that isn't a turn entry is dropped, which is what migrates installs upgrading from
	// the single-entry shape. Those were written with no lifetime, so they never expire on their
	// own, and read as a bucket their FIELDS look like entries — `previousUsage: null` in
	// particular would throw the moment newestPending dereferenced it. They are pre-upgrade and
	// stale regardless, so discarding beats migrating.
	const bucket = {};
	for (const [key, entry] of Object.entries(stored)) {
		if (entry && typeof entry === 'object' && typeof entry.requestTimestamp === 'number') {
			bucket[key] = entry;
		}
	}
	return bucket;
}

// The one entry for a specific generation. Falls back to the newest when the caller has no uuid.
async function getPendingRequest(orgId, conversationId, turnUuid) {
	const bucket = await getPendingBucket(orgId, conversationId);
	if (turnUuid && bucket[turnUuid]) return bucket[turnUuid];
	if (!turnUuid) return newestPending(bucket);

	// Exact miss. Fall back ONLY to entries stored under a synthetic key: those are requests whose
	// body carried no turn_message_uuids, so they can never match the real uuid the callers hold and
	// would otherwise be unreachable — the fallback key would defeat the fallback. A miss against
	// real keys is left as a miss, because borrowing another turn's tools and model would be worse
	// than reporting none.
	const synthetic = Object.fromEntries(
		Object.entries(bucket).filter(([key]) => key.startsWith(SYNTHETIC_TURN_PREFIX))
	);
	return newestPending(synthetic);
}

function newestPending(bucket) {
	let newest;
	for (const entry of Object.values(bucket)) {
		if (!newest || (entry.requestTimestamp || 0) > (newest.requestTimestamp || 0)) newest = entry;
	}
	return newest;
}

// Writes one generation's entry, dropping siblings that have aged out. No size cap: entries are a
// handful of numbers and short strings now that tool definitions are stored as a count, so a burst
// of regenerations inside the TTL costs bytes rather than the ~15KB per turn it used to.
async function setPendingRequest(orgId, conversationId, turnUuid, entry) {
	// Sweep other conversations' expired buckets while we're writing anyway. Nothing else reads
	// them — a conversation you never revisit is never read, so its bucket would otherwise sit in
	// storage.local for good despite the TTL.
	await pendingRequests.prune();

	const bucket = await getPendingBucket(orgId, conversationId);
	bucket[turnUuid] = entry;

	const cutoff = Date.now() - PENDING_REQUEST_TTL;
	const kept = Object.entries(bucket).filter(([, e]) => (e.requestTimestamp || 0) > cutoff);

	await pendingRequests.set(`${orgId}:${conversationId}`, Object.fromEntries(kept), PENDING_REQUEST_TTL);
}

// Tool definitions are appended to every request, so the next message in this conversation will
// carry them whether or not we are the ones who just sent one. Reading them back from the last
// request keeps a conversation priced the same however you arrived at it.
//
// Narrower than it looks: conversationCache lives 60 minutes and pendingRequests 10, so whenever an
// entry is fresh enough to consult here, the cache is fresh too and requestData never reaches its
// miss path. The one route that does reach it is a BRANCH SWITCH, which deletes conversationCache
// explicitly — that is what this is keeping alive. Returns null once the entry expires, which is
// the honest answer: we no longer know what tools were sent.
async function lastToolTokens(orgId, conversationId) {
	const pending = newestPending(await getPendingBucket(orgId, conversationId));
	return pending?.toolTokens || 0;
}

async function applyPendingModel(conversationData, orgId, conversationId) {
	const pending = newestPending(await getPendingBucket(orgId, conversationId));
	if (!pending || Date.now() - (pending.requestTimestamp || 0) > PENDING_MODEL_TRUST_MS) return;

	if (pending.model) conversationData.model = pending.model;
	if (pending.modelVersion) conversationData.modelVersion = pending.modelVersion;
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
messageRegistry.register('getAccountLocale', async (message, sender) => {
	try {
		return await getStrategy().apiForTab(sender.tab, null).getAccountLocale();
	} catch (error) {
		await Log("warn", "Failed to fetch account locale:", error);
		return null;
	}
});
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

messageRegistry.register('getResetNotifEnabled', () => getStorageValue('resetNotifEnabled', false));
messageRegistry.register('setResetNotifEnabled', (message) => setStorageValue('resetNotifEnabled', message.value));

messageRegistry.register('getResetNotifThreshold', () => getStorageValue('resetNotifThreshold', 100));
messageRegistry.register('setResetNotifThreshold', (message) => {
	const n = Number(message.value);
	const clamped = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 100;
	return setStorageValue('resetNotifThreshold', clamped);
});

messageRegistry.register('getLanguageOverride', () => getStorageValue('languageOverride', null));
messageRegistry.register('setLanguageOverride', (message) => setStorageValue('languageOverride', message.value));

messageRegistry.register('isElectron', () => isElectron);
messageRegistry.register('getMonkeypatchPatterns', () => isElectron ? INTERCEPT_PATTERNS : false);

// The content script reports whether we're on Brave (navigator.brave.isBrave()). On Brave we can't
// read per-container cookies, so claude.ai fetches are proxied through the originating tab instead.
messageRegistry.register('reportBrave', async (message) => {
	await setBrave(message.isBrave);
	return true;
});

async function openDebugPage() {
	if (!isElectron) {
		browser.tabs.create({ url: browser.runtime.getURL('debug.html') });
		return true;
	}
	return 'fallback';
}
messageRegistry.register(openDebugPage);

// Complex handlers
async function requestData(message, sender, orgId) {
	const { conversationId } = message;

	const api = getStrategy().apiForTab(sender.tab, orgId);

	// Always fetch and send fresh usage data
	const usageData = await api.getUsageData();
	await scheduleResetNotifications(orgId, usageData);
	await updateAllTabsWithUsage(usageData);

	if (conversationId) {
		// Check conversation cache
		const cached = await conversationCache.get(conversationId);
		if (cached) {
			await Log(`Cache hit for conversation: ${conversationId}`);

			// Swap to uncached costs if prompt cache has expired
			if (cached.conversationIsCachedUntil && cached.conversationIsCachedUntil <= Date.now()) {
				cached.cost = cached.uncachedCost;
				cached.futureCost = cached.uncachedFutureCost;
				cached.conversationIsCachedUntil = null;
			}

			await sendTabMessage(sender.tab.id, {
				type: 'updateConversationData',
				data: { conversationData: cached }
			});
		} else {
			await Log(`Cache miss for conversation: ${conversationId}`);
			const conversation = await api.getConversation(conversationId);
			// Profile tokens are applied inside getInfo now — this used to add them here with
			// arithmetic that disagreed with processResponse's.
			const conversationData = await conversation.getInfo(false, {
				toolTokens: await lastToolTokens(orgId, conversationId)
			});

			if (conversationData) {
				// Before caching, so the correction sticks for the cache's lifetime too.
				await applyPendingModel(conversationData, orgId, conversationId);

				await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);
				await updateTabWithConversationData(sender.tab.id, conversationData);
			}
		}
	}

	await Log("Sent update messages to tab");
	return true;
}
messageRegistry.register(requestData);

// A provisional conversation update, built from the completion stream rather than the network, so
// the length/cost/cached figures move the moment generation ends instead of ~1-2s later. Reported
// by content-components/sse_bridge.js, which counts the reply's tokens in-page.
//
// HARD CONSTRAINT: this handler makes no network calls. Everything it needs is already in
// pendingRequests (written when the POST went out) and conversationCache (written by the last
// authoritative pass). A single fetch here would put it back in the latency it exists to avoid.
//
// It also skips every side effect the authoritative pass has - no scheduleResetNotifications, no
// addToTotalTokens, no debugLogMessageCost. An estimate must never fire a notification or land in
// the lifetime token counter.
async function reportStreamCompletion(message, sender, orgId) {
	if (!orgId || !sender?.tab) return false;

	// Persisted before the estimate's own preconditions, because the two payloads are independent:
	// on the free plan /usage reports nothing, so this snapshot is the only usage that will ever
	// exist for the account, and it must not be lost to a conversation the estimate can't price.
	//
	// Ordering note: the authoritative pass fetches usage ~0.2s later (its trigger is claude.ai's
	// post-message tree GET), so this write lands first and that fetch picks it up. If it ever lost
	// that race the bars would simply wait for the next message, which is what the free-plan hint
	// tells the user to do anyway.
	await storeSseUsage(getStrategy().apiForTab(sender.tab, orgId), message.sseLimits);

	const conversationId = message.conversationId;
	if (!conversationId || message.assistantTokens === null) return false;

	// Indexed by the assistant uuid the stream just reported, so this reads THIS generation's
	// prompt/tools/model even if the next message went out while the previous pass was still
	// running. Without the uuid (shouldn't happen - message_start always carries it) fall back to
	// the newest entry, which is the pre-uuid behaviour.
	const pending = await getPendingRequest(orgId, conversationId, message.assistantUuid);
	const cached = await conversationCache.get(conversationId);
	// No baseline, no estimate. Synthesizing one from BASE_SYSTEM_PROMPT_LENGTH would miss feature
	// costs (web search alone is 10250) and profile tokens, and read wildly wrong - a brand-new
	// conversation is better off waiting the second for the real numbers.
	if (!pending || !cached) {
		await Log("Stream completion: no baseline for", conversationId, "- skipping estimate");
		return false;
	}

	// Copy first: StoredMap.get hands back the live in-memory object, so mutating it in place
	// would quietly corrupt the cached entry for every later reader.
	const provisional = { ...cached };

	const assistantTokens = Math.max(0, message.assistantTokens || 0);
	// A regeneration has no new human message; its body carries no prompt, so this is already 0,
	// but be explicit rather than relying on that.
	const promptTokens = pending.isRetry ? 0 : Math.max(0, pending.promptTokens || 0);

	// Tool definitions are re-sent with every request at full price. Already counted when the POST
	// went out, so this stays network-free and costs nothing here.
	const toolTokens = pending.toolTokens || 0;

	// A regeneration replaces the previous reply rather than appending to it, so adding both would
	// double-count. We don't know the replaced message's size, so hold the length and let the
	// estimate asterisk say so.
	const appendOk = !pending.isRetry;
	if (appendOk) {
		provisional.length = (cached.length || 0) + promptTokens + assistantTokens;
	}

	// futureCost is NOT a running total, and this is the easiest thing in the file to get wrong.
	// getInfo adds every message on the trunk (claude-api.js:707) and then subtracts the entire
	// cached prefix straight back out (:715, since 1 - CACHING_MULTIPLIER is 1), so once a reply
	// lands the only survivor is that reply. Hence assign, never +=. Adding to the previous value
	// would carry the last turn's reply forward and roughly double the displayed cost each message.
	//
	// Tools are included because they genuinely are re-sent, appended to every request rather than
	// living in the cached prefix. The authoritative pass now prices them the same way, and no
	// longer charges profile tokens to futureCost, so the two should land on the same number
	// instead of the estimate/pass/settled disagreement this used to document.
	provisional.futureCost = Math.round((1 + CONFIG.OUTPUT_TOKEN_MULTIPLIER) * assistantTokens + toolTokens);
	provisional.cost = provisional.futureCost;

	// uncachedCost genuinely IS cumulative - it never subtracts a cached prefix - so it keeps
	// accumulating. It only surfaces while the conversation reads as uncached, which never happens
	// immediately after a reply, so its drift stays invisible until the real pass corrects it.
	provisional.uncachedFutureCost = (cached.uncachedFutureCost || 0) + promptTokens + assistantTokens;
	provisional.uncachedCost = provisional.uncachedFutureCost;

	// The reply just created an anchor at the end of the new human message, so the conversation is
	// cached from now, whatever it was before.
	provisional.conversationIsCachedUntil = Date.now() + CONFIG.TOKEN_CACHING_DURATION_MS;
	provisional.costUsedCache = true;
	provisional.lastMessageTimestamp = Date.now();
	// isCurrentlyCached() compares modelVersion against the picker, so a stale one hides the cache
	// indicator. pendingRequests took this from the request body, which is authoritative.
	provisional.model = pending.model || provisional.model;
	provisional.modelVersion = pending.modelVersion || provisional.modelVersion;
	provisional.orgId = orgId;
	provisional.conversationId = conversationId;
	provisional.lengthIsEstimate = !!(cached.lengthIsEstimate || message.unreliable ||
		pending.hasAttachments || !appendOk);

	// Short TTL, unlike the authoritative 60 minutes: if the real pass never lands, requestData
	// would otherwise serve this estimate as fact for the rest of the hour.
	await conversationCache.set(conversationId, provisional, PROVISIONAL_CACHE_TTL);

	await Log("Stream completion: provisional length", provisional.length,
		"futureCost", provisional.futureCost, "(assistant", assistantTokens,
		"prompt", promptTokens, "tools", toolTokens, ")");

	await sendTabMessage(sender.tab.id, {
		type: 'updateConversationData',
		data: { conversationData: provisional }
	});

	// Deliberately does NOT kick off the authoritative pass. That was tried, and the 200ms of head
	// start it bought (claude.ai refetches the tree ~0.2s after the stream ends) was invisible —
	// the provisional above already landed at ~50ms with values that converge exactly. What it cost
	// was a second trigger source for the same message, and with it a stale-tree retry, a dedupe
	// window, an in-flight/deferral dance, and two bugs. onCompletedHandler's tree GET is the one
	// trigger, and its completing is proof the tree exists.
	return true;
}
messageRegistry.register(reportStreamCompletion);

// Serialises the authoritative pass onto the existing task queue, one at a time per conversation.
//
// Dropping (rather than queueing) an overlapping trigger is safe here because every trigger is a
// tree GET, and overlapping tree GETs are always about the same message: claude.ai's own refetch
// and Claude QoL's TTS interceptor arrive ~0.1s apart, while the next message's GET cannot arrive
// until a whole generation later. The flag is cleared in a finally, so nothing stays suppressed.
function queueAuthoritativePass(options) {
	const conversationId = options.conversationId;
	if (authoritativeInFlight.has(conversationId)) return;
	authoritativeInFlight.add(conversationId);
	pendingTasks.push(async () => {
		try {
			await runAuthoritativePass(options);
		} catch (error) {
			await logError(error);
		} finally {
			authoritativeInFlight.delete(conversationId);
		}
	});
	processNextTask();
}

async function getPopupUsageData() {
	// The active strategy owns discovery: it returns [{ orgId, ctx }] for this platform's container model.
	const accounts = await getStrategy().listAccounts();
	if (accounts.length === 0) return [];

	// Each account resolves to a success or a structured error (never rejects), so error entries keep
	// their orgId and a cached name for the popup to render as an "unavailable" row.
	return Promise.all(accounts.map(async ({ orgId, ctx }) => {
		const api = getStrategy().apiFor(ctx, orgId);
		try {
			const usageData = await api.getUsageData();
			const org = await api.getOrgInfo(); // cache hit — getUsageData already fetched it
			return { orgId, orgName: org?.name || null, usageData: usageData.toJSON() };
		} catch (e) {
			const org = await api.getOrgInfo().catch(() => null); // cached name if available
			return { orgId, orgName: org?.name || null, error: String(e) };
		}
	}));
}
messageRegistry.register(getPopupUsageData);

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

// The authoritative pass. One per sent message, triggered by claude.ai's post-message tree GET.
//
// `api` is passed in rather than derived because the caller is a webRequest handler and has to
// build it from `details` via the active container strategy.
async function runAuthoritativePass({ orgId, conversationId, api, tabId }) {
	await Log("Running authoritative pass for", conversationId);

	// Fetch current usage limits from endpoint
	const usageData = await api.getUsageData();

	// Fetch conversation data
	const conversation = await api.getConversation(conversationId);

	// Which generation this pass is about. The tree GET that triggered us has already completed, so
	// the tree is guaranteed to contain the new reply and its leaf IS that reply — no staleness
	// check needed, which is the main reason this is triggered from the tree GET rather than from
	// the completion stream. getData memoizes per shape, so getInfo below reuses this fetch.
	const tree = await conversation.getData(true);
	const turnUuid = tree?.current_leaf_message_uuid || null;

	// Scoped to this generation rather than "whatever is pending for this conversation", so a
	// message sent while a previous pass was still running can't have its data read here.
	const pendingRequest = await getPendingRequest(orgId, conversationId, turnUuid);
	const isNewMessage = pendingRequest !== undefined;
	// The entry is no longer deleted after the first pass — deleting it is what made the second run
	// disagree with the first, dropping the tool definitions and changing the displayed cost. It is
	// marked instead, so a repeat pass over the same message still prices it identically while the
	// one-shot side effects (lifetime token counter, usage delta log) fire exactly once.
	const alreadyCounted = !!pendingRequest?.settled;

	const conversationData = await conversation.getInfo(isNewMessage, {
		toolTokens: pendingRequest?.toolTokens || 0
	});

	if (!conversationData) {
		await Log("warn", "Could not get conversation data, exiting...");
		return false;
	}

	// Profile and tool tokens are applied inside getInfo now, so there is exactly one place that
	// knows how they are priced. Nothing to patch here.
	//
	// Both model fields are overridden only when the request that triggered this pass actually knows
	// better. getInfo already derives them from the conversation's own `model`, and the pass also
	// runs on plain navigation, where there is no pendingRequest at all - assigning the tier default
	// unconditionally there replaced a correct family (Fable) with a wrong one (Opus), leaving
	// `model` and `modelVersion` describing different models.
	await Log('authoritative pass: model -',
		'from API:', conversationData.model, conversationData.modelVersion,
		'| from pendingRequest:', pendingRequest?.model, pendingRequest?.modelVersion);
	if (pendingRequest?.model) {
		conversationData.model = pendingRequest.model;
	}
	if (pendingRequest?.modelVersion) {
		conversationData.modelVersion = pendingRequest.modelVersion;
	}
	await Log('authoritative pass: model final:', conversationData.model, conversationData.modelVersion);

	// If new message: log delta and update total tokens. Once per message, never on a repeat pass.
	if (isNewMessage && !alreadyCounted && pendingRequest.previousUsage) {
		const previousUsage = UsageData.fromJSON(pendingRequest.previousUsage);
		await logUsageDelta(orgId, previousUsage, usageData, conversationData.length, conversationData.model);

		// Add message cost to total tracked
		await tokenStorageManager.addToTotalTokens(conversationData.cost);

		// Debug: log per-message cost keyed by limit reset timestamps
		await debugLogMessageCost(usageData, conversationData);
	}

	// Marks THIS generation settled and nothing else. The previous version wrote the whole
	// conversation's entry back from a snapshot taken at the top of the pass, so a message sent
	// during the pass had its freshly-stored data reverted and pre-marked settled — losing its
	// prompt/tools/model and skipping its own accounting.
	if (isNewMessage && !alreadyCounted && pendingRequest.turnUuid) {
		await setPendingRequest(orgId, conversationId, pendingRequest.turnUuid,
			{ ...pendingRequest, settled: true });
	}

	// Schedule notifications for any maxed limits
	await scheduleResetNotifications(orgId, usageData);

	// Send updates to UI
	await updateAllTabsWithUsage(usageData);
	await updateTabWithConversationData(tabId, conversationData);

	await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);

	return true;
}

async function debugLogMessageCost(usageData, conversationData) {
	if (!FORCE_DEBUG) return;

	const limitMapping = {
		session: 'debug_session',
		weekly: 'debug_weekly',
		sonnetWeekly: 'debug_sonnet_weekly',
		opusWeekly: 'debug_opus_weekly',
		fableWeekly: 'debug_fable_weekly'
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

async function scheduleResetNotifications(orgId, usageData) {
	const threshold = await getStorageValue('resetNotifThreshold', 100);
	const maxedLimits = usageData.getMaxedLimits(threshold);

	for (const limit of maxedLimits) {
		// Skip limits whose reset time has already passed
		if (limit.resetsAt <= Date.now()) continue;

		const timestampKey = limit.resetsAt.toString();

		if (await scheduledNotifications.has(timestampKey)) continue;

		const expiryTime = limit.resetsAt + (60 * 60 * 1000) - Date.now();
		await scheduledNotifications.set(timestampKey, orgId, expiryTime);

		await Log(`Stored pending reset: ${limit.key} for ${new Date(limit.resetsAt).toISOString()}`);
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
		// Tools are collapsed to a count on purpose. Their full schemas run to ~15KB, which would
		// bury everything after them under RawLog's 2000-char per-entry cap - and that cap is what
		// keeps debug_logs inside the storage quota, so trimming here beats raising it.
		await Log("Request sent - Body:", { ...requestBodyJSON, tools: requestBodyJSON?.tools?.length ?? 0 });
		// Extract IDs from URL - we can refine these regexes
		const urlParts = details.url.split('/');
		const orgId = urlParts[urlParts.indexOf('organizations') + 1];
		await tokenStorageManager.addOrgId(orgId);
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

		// Fetch current usage to snapshot before message. Also gives us the subscription
		// tier, which decides the default model when the request body doesn't name one.
		let previousUsage = null;
		let subscriptionTier = null;
		try {
			const api = getStrategy().apiForRequest(details, orgId);
			const usageData = await api.getUsageData();
			previousUsage = usageData.toJSON();
			subscriptionTier = usageData.subscriptionTier;
		} catch (error) {
			await Log("warn", "Failed to fetch pre-message usage snapshot:", error);
		}

		const modelVersion = requestBodyJSON?.model || defaultModelVersionForTier(subscriptionTier);
		const model = modelFamilyFromVersion(modelVersion) || defaultModelForTier(subscriptionTier);
		await Log("Model from request:", model, modelVersion);

		// The uuid this generation's assistant message will have, declared by the client before the
		// message exists. Present on /completion and /retry_completion alike (a regeneration gets a
		// fresh one, so retries key distinctly rather than colliding). Verified against the tree:
		// it comes back as current_leaf_message_uuid, and the SSE stream reports the same value.
		// The timestamp fallback keeps the bucket usable if the field ever disappears - exact
		// matching degrades to newest-wins, which is the old behaviour.
		let turnUuid = requestBodyJSON?.turn_message_uuids?.assistant_message_uuid;
		if (!turnUuid) {
			// Loud, because the degradation is otherwise invisible: every request would get a unique
			// key, every exact lookup would miss, and we would silently fall back to newest-wins —
			// which is the behaviour the per-turn keying exists to replace.
			await Log("warn", "No turn_message_uuids.assistant_message_uuid in the completion body —",
				"per-turn keying is degraded to newest-wins for this request");
			turnUuid = `${SYNTHETIC_TURN_PREFIX}${Date.now()}`;
		}
		await Log(`Message sent - conversation ${conversationId}, turn ${turnUuid}`);

		// Tool definitions, counted here and NOT stored. The definitions themselves run to ~15KB of
		// descriptions and JSON schemas, and the only thing anything downstream ever did with them
		// was total their tokens — so keeping the array meant parking 15KB per turn, per
		// conversation, in storage.local, which StoredMap only reclaims if that conversation is read
		// again. Same reasoning as promptTokens directly below: store the number, drop the text.
		const toolDefs = requestBodyJSON?.tools?.filter(tool =>
			tool.name && !['artifacts_v0', 'repl_v0'].includes(tool.type)
		)?.map(tool => ({
			name: tool.name,
			description: tool.description || '',
			schema: JSON.stringify(tool.input_schema || {})
		})) || [];
		await Log("Tool definitions:", toolDefs.map(t => t.name));

		let toolTokens = 0;
		try {
			for (const tool of toolDefs) {
				toolTokens += tokenCounter.countTextLocal(`${tool.name} ${tool.description} ${tool.schema}`);
			}
		} catch (error) {
			await Log("warn", "Failed to size tool definitions:", error);
		}

		// Size of the outgoing message, for the provisional estimate in reportStreamCompletion.
		// This is the only place the prompt is visible - by the time the stream ends it is gone.
		// Deliberately a COUNT and not the text: pendingRequests is a StoredMap, so anything put
		// here is written to storage.local, and PRIVACY.md promises message content never is.
		// Counted locally rather than via countText so no request body is shipped to the
		// token-count API just to feed a display estimate.
		let promptTokens = 0;
		let hasAttachments = false;
		try {
			promptTokens = tokenCounter.countTextLocal(requestBodyJSON?.prompt || '');
			// Attachments and files are real tokens the estimate can't see, so they only mark the
			// result as an estimate rather than being counted.
			hasAttachments = !!(requestBodyJSON?.attachments?.length || requestBodyJSON?.files?.length);
		} catch (error) {
			await Log("warn", "Failed to size outgoing message:", error);
		}

		// Store pending request with all data
		await Log('onBeforeRequest: storing modelVersion:', modelVersion, '| class:', model);
		await setPendingRequest(orgId, conversationId, turnUuid, {
			orgId: orgId,
			conversationId: conversationId,
			turnUuid: turnUuid,
			tabId: details.tabId,
			model: model,
			modelVersion: modelVersion,
			requestTimestamp: Date.now(),
			toolTokens: toolTokens,
			previousUsage: previousUsage,
			promptTokens: promptTokens,
			hasAttachments: hasAttachments,
			isRetry: details.url.includes("/retry_completion")
		});
	}

	if (details.method === "PUT" && details.url.includes("/account_profile")) {
		// This same request carries edited conversation preferences, which are priced into every
		// conversation, so drop the cached token count rather than waiting out its TTL.
		await invalidateProfileTokens(await requestActiveOrgId(details.tabId));

		// Read the new UI language straight from the request body — the authoritative value the
		// user just submitted, with no server-propagation lag (a GET right after the PUT can
		// briefly still return the old locale). Pin it so the post-reload boot trusts it.
		const body = await parseRequestBody(details.requestBody);
		const bodyLocale = body?.locale;
		// If the user has set an explicit language override, the account language is irrelevant to
		// the displayed UI — don't pin it or reload (applyLocale would override it on boot anyway).
		const override = await getStorageValue('languageOverride', null);
		if (bodyLocale && !override) {
			const newLoc = normalizeLocale(bodyLocale);
			const stored = await browser.storage.local.get('lastLang');
			if (normalizeLocale(stored.lastLang || 'en') !== newLoc) {
				await browser.storage.local.set({ lastLang: newLoc, lastLangPinnedUntil: Date.now() + 30000 });
				pendingLocaleReloads.set(details.tabId, newLoc);
				await Log("Account language change detected in PUT body:", newLoc);
			}
		}
	}

	// The user toggled a feature (memory, web search, ...). Drop the cached account settings
	// so the next cost computation reflects it instead of waiting out the TTL. Matching every
	// write verb rather than just one - the UI currently uses PATCH, but that's not contractual.
	if (["POST", "PATCH", "PUT"].includes(details.method) && details.url.includes("/account/settings")) {
		const orgId = await requestActiveOrgId(details.tabId);
		await invalidateAccountSettings(orgId);
	}

	if (details.method === "GET" && details.url.includes("/settings/billing")) {
		await Log("Hit the billing page, let's make sure we get the updated subscription tier in case it was changed...")
		const orgId = await requestActiveOrgId(details.tabId);
		const api = getStrategy().apiForRequest(details, orgId);
		await api.getSubscriptionTier(true);
	}

}

async function onCompletedHandler(details) {
	// The language-change PUT has completed (locale was captured from its body in
	// onBeforeRequest). Reload the originating tab so the whole UI re-renders in the new locale.
	if (details.method === "PUT" && details.url.includes("/account_profile") &&
		pendingLocaleReloads.has(details.tabId)) {
		const loc = pendingLocaleReloads.get(details.tabId);
		pendingLocaleReloads.delete(details.tabId);
		await Log("Account language changed to", loc, "- reloading tab");
		await browser.tabs.reload(details.tabId);
	}

	if (details.method === "GET" &&
		details.url.includes("/chat_conversations/") &&
		details.url.includes("tree=True") &&
		details.url.includes("render_all_tools=true")) {

		const urlParts = details.url.split('/');
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]?.split('?')[0];

		// The only trigger for the authoritative pass. claude.ai refetches the tree ~0.2s after a
		// completion stream ends, and that GET completing is proof the new reply is in the tree —
		// which is why triggering here needs no staleness check.
		//
		// Measured with every extension disabled: claude.ai issues exactly ONE of these per message
		// (plus one on page load, distinguishable by consistency=strong vs eventual). A second one
		// used to show up and get blamed on claude.ai; it is actually Claude QoL's TTS interceptor
		// (Claude-Toolbox content/main/tts-interceptor.js), which fetches the same URL shape. It
		// lands ~0.1s after claude.ai's, so the in-flight check below collapses the two.
		//
		// Deliberately matched broadly rather than on consistency=eventual: filtering on an
		// undocumented query param would silently kill the only trigger if claude.ai dropped it.
		if (authoritativeInFlight.has(conversationId)) {
			Log("Tree GET for", conversationId, "— a pass is already in flight, skipping");
			return;
		}

		const treeOrgId = urlParts[urlParts.indexOf('organizations') + 1];
		queueAuthoritativePass({
			orgId: treeOrgId,
			conversationId,
			api: getStrategy().apiForRequest(details, treeOrgId),
			tabId: details.tabId
		});
		tokenStorageManager.addOrgId(treeOrgId);
	}

	// Branch switch — debounce, then invalidate cache and fetch fresh data
	if (details.url.includes("/current_leaf_message_uuid")) {
		const urlParts = details.url.split('/');
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

		if (branchSwitchTimers.has(conversationId)) {
			clearTimeout(branchSwitchTimers.get(conversationId));
		}

		branchSwitchTimers.set(conversationId, setTimeout(() => {
			branchSwitchTimers.delete(conversationId);
			pendingTasks.push(async () => {
				const orgId = urlParts[urlParts.indexOf('organizations') + 1];

				await conversationCache.delete(conversationId);
				await Log("Branch switch detected — fetching fresh data for:", conversationId);

				const api = getStrategy().apiForRequest(details, orgId);
				const conversation = await api.getConversation(conversationId);
				// Profile tokens applied inside getInfo — see requestData.
				const conversationData = await conversation.getInfo(false, {
					toolTokens: await lastToolTokens(orgId, conversationId)
				});

				if (conversationData) {
					await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);
					await updateTabWithConversationData(details.tabId, conversationData);
				}
			});
			processNextTask();
		}, 5000));
	}

	// Claude Code session events — refresh usage
	if (details.url.includes("/v1/sessions/") && details.url.includes("/events")) {
		pendingTasks.push(async () => {
			const orgId = await requestActiveOrgId(details.tabId);
			if (!orgId) return;
			await tokenStorageManager.addOrgId(orgId);
			const api = getStrategy().apiForRequest(details, orgId);
			const usageData = await api.getUsageData();
			await updateAllTabsWithUsage(usageData);
			await scheduleResetNotifications(orgId, usageData);
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

async function electronUsagePoll() {
	if (electronPollInFlight) return;
	electronPollInFlight = true;
	try {
		await Log("Electron usage poll - fetching fresh usage data");
		await updateAllTabsWithUsage();
	} catch (error) {
		await Log("warn", "Electron usage poll failed:", error);
	} finally {
		electronPollInFlight = false;
	}
}

//#region Variable fill in and initialization
pendingRequests = new StoredMap("pendingRequests"); // conversationId -> {userId, tabId}
scheduledNotifications = new StoredMap('scheduledNotifications');
const conversationCache = new StoredMap("conversationCache");	// This is for convo stats
const CONVERSATION_CACHE_TTL = 60 * 60 * 1000; // 60 minutes
// Provisional entries written by reportStreamCompletion expire far sooner than real ones. The
// authoritative pass normally overwrites them within a second or two; this only bounds how long a
// stream-derived estimate can be served as fact if that pass never arrives.
const PROVISIONAL_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const branchSwitchTimers = new Map(); // conversationId → timeoutId (debounce)

// Conversations with a pass queued or running. Overlapping tree GETs are always about the same
// message, so a second trigger arriving while one is in flight is a duplicate and gets dropped.
const authoritativeInFlight = new Set();

// pendingRequests entries used to be deleted by the first pass that consumed them. They now expire
// instead — long enough that any fallback pass for the same message still sees the tool definitions
// and the model the request was sent with, short enough that revisiting the conversation later is
// not mistaken for a fresh send.
const PENDING_REQUEST_TTL = 10 * 60 * 1000;

// Set up repeating alarm for reset notification polling (every 3 minutes)
getAlarm('checkResetNotifications').then(existing => {
	if (!existing) {
		scheduleAlarm('checkResetNotifications', { periodInMinutes: 3 });
		Log("Created repeating checkResetNotifications alarm");
	}
});

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
Log("Done initializing.")

if (isElectron) {
	const ELECTRON_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
	electronPollingInterval = setInterval(electronUsagePoll, ELECTRON_POLL_INTERVAL_MS);
	Log("Electron usage polling started with interval:", ELECTRON_POLL_INTERVAL_MS, "ms");
}
//#endregion