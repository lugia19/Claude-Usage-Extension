import { CONFIG, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, getOrgStorageKey } from './utils.js';
import { tokenCounter, getTextFromContent } from './tokenManagement.js';
import { UsageData, ConversationData, modelFamilyFromVersion, defaultModelForTier, defaultModelVersionForTier } from '../shared/dataclasses.js';

const FEATURE_COSTS = {
	"enabled_artifacts_attachments": 2200,	// DEPRECATED: Analysis tool
	"preview_feature_uses_artifacts": 8400,	// Artifacts
	"preview_feature_uses_latex": 200,		// DEPRECATED: LaTeX
	"enabled_bananagrams": 750,				// Drive search
	"enabled_sourdough": 900,				// GCal or GMail search (not sure which)
	"enabled_foccacia": 1350,				// GCal or GMail search (not sure which) - note the API's spelling
	"enabled_web_search": 10250,			// Web search
	"citation_info": 450,					// Citation info
	"enabled_compass": 1000,				// Research tool
	"profile_preferences": 850,				// Base preferences cost
	"enabled_turmeric": 2000,				// AI artifacts
	"enabled_saffron": 4250,				// Memory base cost (actual memory content counted separately)
	"enabled_saffron_search": 3000,			// Memory search
	"enabled_melange": 14000,				// Per-file memory system (contents loaded dynamically, not counted)
	"enabled_monkeys_in_a_barrel": 5300		// Code Interpreter
};

async function Log(...args) {
	await RawLog("claude-api", ...args);
}

// Called from the background webRequest hook when the user writes account settings.
export async function invalidateAccountSettings(orgId) {
	if (!orgId) return;
	await accountSettingsCache.delete(orgId);
	await Log("Invalidated account settings cache for:", orgId);
}

// Called from the background webRequest hook on PUT /account_profile - the same request that
// carries a language change also carries edited conversation preferences.
export async function invalidateProfileTokens(orgId) {
	if (!orgId) return;
	await profileTokensCache.delete(orgId);
	await Log("Invalidated profile tokens cache for:", orgId);
}
const subscriptionTiersCache = new StoredMap("subscriptionTiers");
const syncTokenCache = new StoredMap("syncTokens");
const projectCache = new StoredMap("projectCache");
const accountSettingsCache = new StoredMap("accountSettings");
const profileTokensCache = new StoredMap("profileTokens");

// Short — feature flags are user-toggleable, so a stale read visibly misprices the
// conversation. This only exists to absorb the burst of getInfo() calls per message;
// the webRequest hook in background.js invalidates on an actual settings write.
const ACCOUNT_SETTINGS_TTL = 5 * 60 * 1000;
const PROFILE_TOKENS_TTL = 5 * 60 * 1000;

// Last usage the completion stream reported, per org. Not a cache of anything fetchable - on the
// free plan it is the only copy that exists, so nothing can refill it but another message.
const sseUsageCache = new StoredMap("sseUsage");

// Garbage collection, not freshness: a 7-day window's reset can be that far out, and evicting a
// still-live weekly would lose a figure no request can recover. Each limit's own resetsAt is what
// actually decides whether it still means anything - see applySseUsageFallback.
const SSE_USAGE_TTL = 8 * 24 * 60 * 60 * 1000;

// Rate limiter for recheckTierForEmptyUsage, not a cache of anything - the value is just a marker.
const tierRecheckCache = new StoredMap("tierRechecks");
const TIER_RECHECK_TTL = 60 * 60 * 1000;

// One window's worth of merge. Two rules, both about not losing information:
//
// A payload that omits a window must not erase what an earlier one told us about it, so an absent
// incoming value keeps the previous one.
//
// And within a single window the stream's figure can tick backwards by a point - both sides round a
// fractional utilization independently, and the stream is read a moment before the accounting
// settles (observed live as 37% -> 36% -> 37%). shouldApplySseSession in sse_bridge.js already
// refuses to show that in-page; persisting it would defeat that guard, because on the free plan
// nothing overwrites this value the way /usage does on a paid tier, so the regressed number would
// stand until the next message. A genuine reset also drops the number, but brings a new reset
// timestamp with it - which is what the tolerance distinguishes.
function mergeSseWindow(previous, incoming) {
	if (!incoming) return previous || null;
	if (!previous) return incoming;

	const sameWindow = Math.abs((previous.resetsAt || 0) - incoming.resetsAt) < CONFIG.SSE_SAME_WINDOW_TOLERANCE_MS;
	return sameWindow && incoming.percentage < previous.percentage ? previous : incoming;
}

// Called from background.js when the completion stream reports usage.
//
// Only ever written on the free plan, which is the only plan that reads it back. A snapshot taken
// on a paid plan describes different windows against different caps, and a paid weekly window stays
// live for seven days under the eight-day TTL - so if a subscription lapsed, the fallback would
// serve the old plan's utilization and reset times as free-plan usage until another message
// replaced them. Not writing them at all makes "this cache holds free-plan data" true by
// construction, rather than something the read side has to police.
//
// The tier read is the 24h-cached org record, so this is normally free. It does mean the first
// message after a lapse is not stored (the record still says paid); the recheck below corrects the
// tier, and the message after that lands.
export async function storeSseUsage(api, limits) {
	if (!api?.orgId || !limits) return;

	const tier = await api.getSubscriptionTier();
	if (tier !== 'claude_free') return;

	const orgId = api.orgId;
	const previous = await sseUsageCache.get(orgId) || {};
	await sseUsageCache.set(orgId, {
		session: mergeSseWindow(previous.session, limits.session),
		weekly: mergeSseWindow(previous.weekly, limits.weekly)
	}, SSE_USAGE_TTL);
	await Log("Stored stream usage for:", orgId, limits);
}

// Guards one edge case: a subscription that ended. getOrgInfo caches the org record - and with it
// the tier - for 24 hours, and the ONLY thing that forces a refresh is the user visiting the
// billing page (background.js, onBeforeRequestHandler). So a plan that lapses leaves the tier
// reading paid for up to a day, during which /usage has already switched to the free plan's empty
// response. Without this the account would sit staring at the empty usage UI for the rest of that
// day - precisely the state the free-plan fallback exists to prevent.
//
// Throttled because the condition does not clear itself when the tier really is paid: an empty
// /usage on a genuinely paid account is unexpected rather than impossible, and getUsageData runs on
// every message and every heartbeat, so an unthrottled recheck would turn one odd response into an
// app_start fetch per call. Returns null while throttled, which reads as "not free" at the caller.
async function recheckTierForEmptyUsage(api) {
	if (!api || await tierRecheckCache.has(api.orgId)) return null;

	// Marked before the fetch, so a failure throttles too rather than retrying in a tight loop.
	await tierRecheckCache.set(api.orgId, true, TIER_RECHECK_TTL);
	const tier = await api.getSubscriptionTier(true);
	await Log("Empty /usage on a non-free tier, re-resolved as:", tier);
	return tier;
}

// claude.ai reports no limits at all on the free plan - /usage answers 200 with every field null
// and an empty `limits` array - while the completion stream still carries real 5h and 7d windows.
// Stand the stored stream snapshot in when, and only when, the endpoint gave us nothing.
//
// Gated to claude_free deliberately. On any other tier an empty /usage means something unexpected
// happened, and quietly serving a snapshot of unknown age would hide that rather than surface it.
async function applySseUsageFallback(usageData, api) {
	if (!usageData.hasNoReportedUsage()) return;

	if (usageData.subscriptionTier !== 'claude_free') {
		const tier = await recheckTierForEmptyUsage(api);
		if (tier !== 'claude_free') return;
		// The org record was stale, so the tier on the object is too. Correct it before anything
		// downstream reads it - ESTIMATED_CAPS, the default model and the sidebar notice all key off it.
		usageData.subscriptionTier = tier;
	}

	const stored = await sseUsageCache.get(usageData.orgId);
	if (!stored) return;

	// A window whose reset has passed is not "stale data to refresh" - there is no active window at
	// all until the next message, and its true figure is unknowable until then. Dropping it also
	// stops UsageUI.checkExpiredLimits() asking for a refresh that can only ever return this same
	// snapshot, which would otherwise retry on its backoff up to the five-minute ceiling forever.
	const now = Date.now();
	const applied = [];
	for (const key of ['session', 'weekly']) {
		const limit = stored[key];
		if (!limit?.resetsAt || limit.resetsAt <= now) continue;
		usageData.limits[key] = { ...limit };
		applied.push(key);
	}

	// These percentages only advance when a message is sent, since sending is the only thing that
	// refreshes them. Between messages they are a floor, never an overstatement - usage within a
	// window only ever rises.
	if (applied.length) await Log("Applied stream usage fallback for:", usageData.orgId, applied);
}

// Pure HTTP/API layer
class ClaudeAPI {
	// `fetchImpl(url, options) => Response` is supplied by the active ContainerStrategy, already bound
	// to this account's container. ClaudeAPI itself is container-agnostic.
	constructor(orgId, fetchImpl) {
		this.baseUrl = 'https://claude.ai/api';
		this.orgId = orgId;
		this.fetchImpl = fetchImpl;
	}

	// Core methods
	// KNOWN: response.ok is not checked, so an HTTP error that returns a JSON body is parsed and
	// handed back as if it were data. Network failures reject and propagate; HTTP failures do not.
	//
	// It bites hardest on /usage, where a 4xx/5xx error body has no `limits` and therefore becomes a
	// UsageData with every limit null - indistinguishable from the free plan's genuinely empty
	// response. The UI accounts for that rather than pretending it cannot happen: a non-free account
	// with no limits is told "Usage data unavailable" instead of "no limits reported", since a failed
	// read is the likelier cause (see renderNotice in content-components/usage_ui.js). The free-plan
	// fallback is unaffected either way - it only ever adds limits where there were none.
	//
	// Not fixed here because it is a behaviour change across every endpoint, and some callers rely on
	// the current shape - getOrgInfo catches and returns null, which getSubscriptionTier then reads
	// as claude_free. If it is ever tightened, throwing on !ok is the right move and callers already
	// tolerate it: every getUsageData() caller either try/catches or runs inside a wrapper that does,
	// because a network failure already takes exactly that path.
	async getRequest(endpoint) {
		const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
			headers: {
				'Content-Type': 'application/json'
			},
			method: 'GET'
		});
		return response.json();
	}

	async fetchUrl(url, options = {}) {
		return this.fetchImpl(url, options);
	}

	// Factory method - returns a ConversationAPI instance
	async getConversation(conversationId) {
		return new ConversationAPI(conversationId, this);
	}

	// Fetch usage limits from the /usage endpoint
	async getUsageLimits() {
		return this.getRequest(`/organizations/${this.orgId}/usage`);
	}

	// Fetch credit balance
	async getCredits() {
		const result = await this.getRequest(`/organizations/${this.orgId}/prepaid/credits`);
		return result;
	}

	// Fetch usage limits, subscription tier, and credits, and return a UsageData object
	async getUsageData() {
		const usageLimitsResponse = await this.getUsageLimits();
		const subscriptionTier = await this.getSubscriptionTier();
		let creditsResponse = null;
		if (usageLimitsResponse.spend?.enabled || usageLimitsResponse.extra_usage?.is_enabled) {
			creditsResponse = await this.getCredits();
		}
		const usageData = UsageData.fromAPIResponse(usageLimitsResponse, subscriptionTier, creditsResponse);
		usageData.orgId = this.orgId;
		// Every consumer - the tab push, the popup, reset notifications - comes through here, so the
		// free-plan fallback is applied once, in the one place that owns building a UsageData.
		await applySseUsageFallback(usageData, this);
		return usageData;
	}

	// Platform operations
	async getGoogleDriveDocument(uri) {
		return this.getRequest(`/organizations/${this.orgId}/sync/mcp/drive/document/${uri}`);
	}

	// Platform operations with business logic
	async getProjectStats(projectId, isNewMessage = false) {
		const projectStats = await this.getRequest(`/organizations/${this.orgId}/projects/${projectId}/kb/stats`);
		const projectSize = projectStats.use_project_knowledge_search ? 0 : projectStats.knowledge_size;

		// projectCache records "knowledge of this size was last sent at time T", TTL'd to the cache
		// lifetime. Matching size means nothing has changed since, so it is still in the prefix.
		const cachedAmount = await projectCache.get(projectId) || -1;
		const isCachedNow = cachedAmount == projectSize;

		// After a new message the knowledge has just been sent, so it is in the prefix from here on
		// regardless of what it was before. This used to happen by accident: getInfo(true) wrote the
		// cache below, then its getInfo(false) recursion read the fresh value back and concluded the
		// same thing. With the recursion gone that feedback loop is gone too, so say it outright -
		// otherwise project knowledge silently starts being charged to futureCost.
		const isCachedNext = isNewMessage ? true : isCachedNow;

		// Update cache if this is a new message
		if (isNewMessage) {
			await projectCache.set(projectId, projectSize, CONFIG.TOKEN_CACHING_DURATION_MS);
		}

		return {
			...projectStats,
			tokenInfo: {
				length: projectSize,
				isCachedNow,
				isCachedNext
			}
		};
	}

	// Account UI language, e.g. "fr-FR" (null if unavailable)
	async getAccountLocale() {
		const profileData = await this.getRequest('/account_profile');
		return profileData?.locale || null;
	}

	// Account-level feature flags. The conversation payload only carries a subset of these
	// (notably it has no enabled_melange), so it can't be relied on alone for pricing.
	// Endpoint is account-scoped, not org-scoped - we key the cache by orgId only to keep
	// multi-account containers separate. Returns null on failure rather than throwing:
	// the Brave strategy throws when a container has no open tab, and that must not take
	// down the whole cost computation.
	async getAccountSettings() {
		try {
			const cached = await accountSettingsCache.get(this.orgId);
			if (cached && typeof cached === 'object') return cached;

			const accountData = await this.getRequest('/account');
			const settings = accountData?.settings;
			if (!settings) return null;

			// Keep only what we price. The raw payload carries hundreds of dismissed banners
			// and per-tool MCP booleans - persisting all of it would bloat storage.local.
			const flags = {};
			for (const key of Object.keys(FEATURE_COSTS)) {
				if (key in settings) flags[key] = settings[key];
			}

			await Log("Fetched account settings for:", this.orgId, flags);
			await accountSettingsCache.set(this.orgId, flags, ACCOUNT_SETTINGS_TTL);
			return flags;
		} catch (error) {
			await Log("error", "Failed to fetch account settings:", error);
			return null;
		}
	}

	// Cached because this is a GET *plus* a countText on a ~2k-token block that changes maybe
	// monthly, and countText is a network round trip to api.anthropic.com whenever an API key is
	// configured. Uncached that is a fetch and a round trip on every authoritative pass, i.e. every
	// message. (An earlier comment claimed it existed to absorb "the burst of calls per message" —
	// there is no burst; the pass runs once.)
	//
	// Short TTL because preferences are user-editable, and the PUT /account_profile hook in
	// background.js invalidates on an actual write, so the TTL is only a backstop for edits made
	// somewhere we don't see.
	async getProfileTokens() {
		const cached = await profileTokensCache.get(this.orgId);
		if (typeof cached === 'number') return cached;

		const profileData = await this.getRequest('/account_profile');
		let totalTokens = 0;
		if (profileData.conversation_preferences) {
			totalTokens = await tokenCounter.countText(profileData.conversation_preferences) + FEATURE_COSTS["profile_preferences"];
		}
		await Log(`Profile tokens: ${totalTokens}`);
		await profileTokensCache.set(this.orgId, totalTokens, PROFILE_TOKENS_TTL);
		return totalTokens;
	}

	async getOrgInfo(skipCache = false) {
		try {
			const cached = await subscriptionTiersCache.get(this.orgId);
			if (cached && !skipCache && typeof cached === 'object' && cached.capabilities) return cached;
			const appStartData = await this.getRequest(`/bootstrap/${this.orgId}/app_start?statsig_hashing_algorithm=djb2`);
			const memberships = appStartData.account?.memberships || [];
			const org = memberships.find(membership => membership.organization.uuid === this.orgId)?.organization;

			await Log("Fetched org info for:", this.orgId, org?.name);
			await subscriptionTiersCache.set(this.orgId, org, 24 * 60 * 60 * 1000);
			return org;
		} catch (error) {
			await Log("error", "Failed to fetch org info:", error);
			return null;
		}
	}

	async getSubscriptionTier(skipCache = false) {
		const org = await this.getOrgInfo(skipCache);
		if (!org) return "claude_free";

		// Tiers are... really weird now. I'm using a combination of many indicators to try and determine the right one.
		const hasMaxCapability = org.capabilities.includes("claude_max");
		const hasProCapability = org.capabilities.includes("claude_pro");
		const hasRavenType = !!org.raven_type // Just true if it's non-null, Raven = Claude Team
		const rateLimitTier = org?.rate_limit_tier || "default_claude_ai";
		// default_claude_ai is free AND pro, because of course it's weird
		// default_claude_max_5x is max 5x
		// default_claude_max_20x is max 20x (I think, but unverified as of now, I will just assume that if it's NOT 5x then it's 20x)

		if (hasRavenType) return "claude_team";

		if (hasMaxCapability) {
			return rateLimitTier.includes("5x") ? "claude_max_5x" : "claude_max_20x";
		}
		if (hasProCapability) return "claude_pro";

		return "claude_free";
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
		this.dataCache = { tree: null, flat: null };
	}

	// Lazy load conversation data. Memoized PER SHAPE - the flat and tree responses are different
	// documents, so one cache slot each. The previous `!this.conversationData || full_tree` defeated
	// the memo precisely in the expensive case, and one pass hits the tree several times.
	//
	// A ConversationAPI is constructed per pass, so its lifetime is a single logical read and the
	// data cannot go stale underneath it.
	async getData(full_tree = false) {
		const slot = full_tree ? "tree" : "flat";
		if (!this.dataCache[slot]) {
			this.dataCache[slot] = await this.api.getRequest(
				`/organizations/${this.api.orgId}/chat_conversations/${this.conversationId}?tree=${full_tree}&rendering_mode=messages&render_all_tools=true`
			);
		}
		return this.dataCache[slot];
	}

	async getCachingInfo(isNewMessage) {
		const conversationData = await this.getData(true);
		const now = Date.now();
		const cache_lifetime = CONFIG.TOKEN_CACHING_DURATION_MS;
		const rootId = "00000000-0000-4000-8000-000000000000";

		// Step 1: Build messageMap and childrenMap
		const messageMap = new Map();
		const childrenMap = new Map(); // parentUuid → [child messages]

		for (const rawMessage of conversationData.chat_messages) {
			messageMap.set(rawMessage.uuid, rawMessage);
			if (rawMessage.parent_message_uuid) {
				if (!childrenMap.has(rawMessage.parent_message_uuid)) {
					childrenMap.set(rawMessage.parent_message_uuid, []);
				}
				childrenMap.get(rawMessage.parent_message_uuid).push(rawMessage);
			}
		}

		// Step 2: Reconstruct trunk (same as existing)
		const currentTrunkIds = new Set();
		let currentId = conversationData.current_leaf_message_uuid;
		const tempTrunk = [];

		while (currentId && currentId !== rootId) {
			const rawMessage = messageMap.get(currentId);
			if (!rawMessage) break;
			tempTrunk.push(rawMessage);
			currentTrunkIds.add(rawMessage.uuid);
			currentId = rawMessage.parent_message_uuid;
		}
		const currentTrunk = tempTrunk.reverse();

		// Build index for O(1) trunk position lookups
		const trunkIndexMap = new Map();
		for (let i = 0; i < currentTrunk.length; i++) {
			trunkIndexMap.set(currentTrunk[i].uuid, i);
		}

		if (!currentTrunk || currentTrunk.length === 0) {
			return null;
		}

		await Log("CacheV2: Trunk has", currentTrunk.length, "messages");

		// Step 3: Collect recent off-trunk assistant leaves
		// Only leaves (no children) — one per branch tip, avoids duplicates
		const recentOffTrunkLeaves = [];
		for (const rawMessage of conversationData.chat_messages) {
			if (rawMessage.sender === "assistant" &&
				!currentTrunkIds.has(rawMessage.uuid) &&
				(now - Date.parse(rawMessage.created_at)) < cache_lifetime &&
				!childrenMap.has(rawMessage.uuid)) {
				recentOffTrunkLeaves.push(rawMessage);
			}
		}

		await Log("CacheV2: Found", recentOffTrunkLeaves.length, "recent off-trunk assistant leaves");

		// Step 4: Fast path — check if the latest trunk activity keeps the cache alive
		// If the most recent assistant on trunk is <1h from now, the latest user message has an active anchor.
		const trunkAssistants = currentTrunk.filter(m => m.sender === "assistant");
		const allTrunkHumans = currentTrunk.filter(m => m.sender === "human");

		// The boundary depends only on WHICH humans are eligible to hold the anchor; everything
		// above (tree, trunk, off-trunk leaves) is shared. So the analysis below is a function of
		// the candidate list, and we run it twice with two different lists - see the callers at the
		// bottom. It is pure computation over already-fetched data, so the second run is free.
		const resolveBoundary = async (trunkHumans) => {

			let cacheEndId = null;
			let conversationIsCached = false;
			let conversationIsCachedUntil = null;

			if (trunkAssistants.length > 0 && trunkHumans.length > 0) {
				const lastAssistant = trunkAssistants[trunkAssistants.length - 1];
				const lastAssistantTime = Date.parse(lastAssistant.created_at);

				if ((now - lastAssistantTime) < cache_lifetime) {
					// Cache is active — latest candidate human is the boundary
					const latestHuman = trunkHumans[trunkHumans.length - 1];
					cacheEndId = latestHuman.uuid;
					conversationIsCached = true;

					// Find the most recent assistant child of this human (could be off-trunk regen)
					const children = childrenMap.get(latestHuman.uuid) || [];
					let latestChildTime = lastAssistantTime;
					for (const child of children) {
						if (child.sender === "assistant") {
							const childTime = Date.parse(child.created_at);
							if (childTime > latestChildTime) latestChildTime = childTime;
						}
					}
					conversationIsCachedUntil = latestChildTime + cache_lifetime;

					await Log("CacheV2: Fast path — cache active, boundary at",
						cacheEndId.substring(0, 8), ", expires at", new Date(conversationIsCachedUntil).toISOString());
				}
			}

			// Step 5: Slow path — check off-trunk leaves for active anchors
			// For each recent off-trunk leaf, walk back to the trunk.
			// Verify the chain (assistant-to-assistant gaps <1h).
			// The trunk user message at the junction has an active anchor if chain is valid.
			// We want the LATEST such trunk human.
			if (!conversationIsCached && recentOffTrunkLeaves.length > 0) {
				await Log("CacheV2: Slow path — checking", recentOffTrunkLeaves.length, "off-trunk leaves");

				let latestTrunkIdx = -1; // index in currentTrunk of the best candidate

				for (const leaf of recentOffTrunkLeaves) {
					// Walk backwards from leaf to trunk, collecting assistants along the way
					const assistantsInPath = [leaf];
					let walkId = leaf.parent_message_uuid;

					while (walkId && walkId !== rootId && !currentTrunkIds.has(walkId)) {
						const msg = messageMap.get(walkId);
						if (!msg) break;
						if (msg.sender === "assistant") assistantsInPath.unshift(msg);
						walkId = msg.parent_message_uuid;
					}

					if (!walkId || !currentTrunkIds.has(walkId)) continue;

					// Verify chain: no >1h gaps between consecutive assistants
					let chainValid = true;
					for (let i = 1; i < assistantsInPath.length; i++) {
						const gap = Date.parse(assistantsInPath[i].created_at) - Date.parse(assistantsInPath[i - 1].created_at);
						if (gap >= cache_lifetime) {
							chainValid = false;
							break;
						}
					}
					if (!chainValid) continue;

					// Find the trunk user message at the junction
					const trunkAncestor = messageMap.get(walkId);
					const anchorHuman = trunkAncestor.sender === "human" ? trunkAncestor :
						messageMap.get(trunkAncestor.parent_message_uuid);

					if (!anchorHuman || !trunkHumans.some(h => h.uuid === anchorHuman.uuid)) continue;

					const trunkIdx = trunkIndexMap.get(anchorHuman.uuid);
					const leafTime = Date.parse(leaf.created_at);
					const leafExpiresAt = leafTime + cache_lifetime;

					if (trunkIdx > latestTrunkIdx ||
						(trunkIdx === latestTrunkIdx && leafExpiresAt > conversationIsCachedUntil)) {
						latestTrunkIdx = trunkIdx;
						cacheEndId = anchorHuman.uuid;
						conversationIsCached = true;
						conversationIsCachedUntil = leafExpiresAt;

						await Log("CacheV2: Slow path — active anchor at",
							anchorHuman.uuid.substring(0, 8), "via leaf",
							leaf.uuid.substring(0, 8), "(", Math.round((now - leafTime) / 60000), "min ago)");
					}
				}
			}

			return { conversationIsCached, cacheEndId, conversationIsCachedUntil };
		};

		// Two boundaries from one analysis.
		//
		//   next - what will be cached when the NEXT message is sent. Every trunk human is a
		//          candidate, including the most recent one. Drives futureCost.
		//   now  - what is cached for THIS message's cost. When isNewMessage, the latest human IS
		//          the trunk leaf and just sent; its anchor can't cache itself (it only benefits
		//          future messages), so it is excluded.
		//
		// When !isNewMessage the two candidate lists are identical, so resolve once and share -
		// which also preserves the old behaviour exactly, where futureCost fell out of the same
		// numbers as cost.
		const next = await resolveBoundary(allTrunkHumans);
		const now_ = isNewMessage
			? await resolveBoundary(allTrunkHumans.slice(0, -1))
			: next;

		return { currentTrunk, now: now_, next };
	}

	// Single pass. Everything the conversation costs - now and next message - comes out of one tree
	// fetch, one walk and one tokenization of each message.
	//
	// This used to call itself with isNewMessage=false purely to get futureCost, which meant
	// refetching the tree, re-counting every file and re-tokenizing the whole conversation to learn
	// one thing: where the cache boundary sits once the just-sent message is allowed to hold an
	// anchor. getCachingInfo now returns both boundaries from one analysis, so the walk below
	// accumulates the "now" and "next" figures side by side instead.
	//
	// `toolTokens` is the already-counted size of the tool definitions the request carried, taken
	// from pendingRequests. Counted at request time rather than here so the definitions themselves
	// never have to be stored - see onBeforeRequestHandler. Callers only reading a conversation
	// pass nothing.
	async getInfo(isNewMessage, { toolTokens = 0 } = {}) {
		await Log("API: Requesting information for conversation:", this.conversationId);
		const conversationData = await this.getData(true);
		const cachingInfo = await this.getCachingInfo(isNewMessage);
		if (!cachingInfo) {
			// Something is VERY wrong if we can't get caching info - return base prompt cost as fallback
			return new ConversationData({
				conversationId: this.conversationId,
				length: CONFIG.BASE_SYSTEM_PROMPT_LENGTH,
				cost: CONFIG.BASE_SYSTEM_PROMPT_LENGTH * CONFIG.CACHING_MULTIPLIER,
				futureCost: CONFIG.BASE_SYSTEM_PROMPT_LENGTH * CONFIG.CACHING_MULTIPLIER,
				model: undefined,
				costUsedCache: false,
				conversationIsCachedUntil: null,
				projectUuid: conversationData.project_uuid,
				settings: conversationData.settings,
				lastMessageTimestamp: null,
				lengthIsEstimate: false,
				orgId: this.api.orgId
			});
		}

		const { currentTrunk, now, next } = cachingInfo;
		const conversationIsCached = now.conversationIsCached;

		// Initialize token counting. Two cache flags walk the trunk in parallel: `now` prices this
		// message, `next` prices the one after it. They differ only in where the boundary sits.
		let cacheIsActive = now.conversationIsCached;
		let cacheIsActiveNext = next.conversationIsCached;
		let lengthTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH;
		let costTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH * CONFIG.CACHING_MULTIPLIER;
		let futureCostTokens = CONFIG.BASE_SYSTEM_PROMPT_LENGTH * CONFIG.CACHING_MULTIPLIER;

		// Whether a flag appears in the conversation's own settings determines how it behaves,
		// so this spread order handles both classes without special-casing:
		//   - present (artifacts, code execution, turmeric): frozen at creation. A feature off
		//     when the chat was created can't be enabled in it later, so the snapshot wins.
		//   - absent (melange, bananagrams, sourdough, foccacia, compass): no snapshot exists,
		//     so they track the account profile live and change mid-conversation.
		// Verified empirically - don't "simplify" by picking one source.
		const accountSettings = await this.api.getAccountSettings();
		const effectiveSettings = {
			...(accountSettings || {}),
			...(conversationData.settings || {})
		};

		// Add settings costs
		for (const [setting, enabled] of Object.entries(effectiveSettings)) {
			await Log("Setting:", setting, enabled);
			if (enabled && FEATURE_COSTS[setting]) {
				lengthTokens += FEATURE_COSTS[setting];
				costTokens += FEATURE_COSTS[setting] * CONFIG.CACHING_MULTIPLIER;
				futureCostTokens += FEATURE_COSTS[setting] * CONFIG.CACHING_MULTIPLIER;
			}
		}

		if (effectiveSettings.enabled_web_search || effectiveSettings.enabled_bananagrams) {
			lengthTokens += FEATURE_COSTS["citation_info"];
			costTokens += FEATURE_COSTS["citation_info"] * CONFIG.CACHING_MULTIPLIER;
			futureCostTokens += FEATURE_COSTS["citation_info"] * CONFIG.CACHING_MULTIPLIER;
		}

		let uncachedCostTokens = costTokens; // Same — system prompts are always platform-cached
		let uncachedFutureCostTokens = costTokens;
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

			const isCachedNext = cacheIsActiveNext;

			// Then apply the calculations
			lengthTokens += fileTokens + syncTokens;
			costTokens += message.isCached ?
				(fileTokens + syncTokens) * CONFIG.CACHING_MULTIPLIER :
				(fileTokens + syncTokens);
			futureCostTokens += isCachedNext ?
				(fileTokens + syncTokens) * CONFIG.CACHING_MULTIPLIER :
				(fileTokens + syncTokens);
			uncachedCostTokens += fileTokens + syncTokens; // Always full price
			uncachedFutureCostTokens += fileTokens + syncTokens;

			// Text content
			const textContent = await message.getTextContent(false, this, this.orgId);

			if (message.sender === "human") {
				humanMessageData.push({ content: textContent, isCachedNow: message.isCached, isCachedNext });
			} else {
				assistantMessageData.push({ content: textContent, isCachedNow: message.isCached, isCachedNext });
			}

			// Last message output tokens (or second to last if last is human)
			const isLastMessage = i === currentTrunk.length - 1;
			const isSecondToLast = i === currentTrunk.length - 2;

			if ((isLastMessage && message.sender === "assistant") ||
				(isSecondToLast && message.sender === "assistant" && currentTrunk[currentTrunk.length - 1].sender === "human")) {
				const lastMessageContent = await message.getTextContent(true, this, this.orgId);
				const outputTokens = await tokenCounter.countText(lastMessageContent) * CONFIG.OUTPUT_TOKEN_MULTIPLIER;
				costTokens += outputTokens;
				futureCostTokens += outputTokens;
				uncachedCostTokens += outputTokens;
				uncachedFutureCostTokens += outputTokens;
			}

			// Update cache status — each boundary flips its own flag
			if (message.uuid === now.cacheEndId) {
				cacheIsActive = false;
				await Log("Hit cache boundary at message:", message.uuid);
			}
			if (message.uuid === next.cacheEndId) {
				cacheIsActiveNext = false;
			}
		}

		// Batch token counting: the whole trunk, then each figure's cached prefix so it can be
		// subtracted back out.
		//
		// Counted as PREFIXES rather than as the three disjoint groups the two boundaries imply,
		// even though disjoint groups would touch each message only once. A cache boundary always
		// sits on a human message, so a prefix is always [human, assistant, ... human] — well-formed
		// for the count-tokens API, which requires messages to start with the user role and
		// alternate. The middle group (between the two boundaries) starts with an *assistant*, so
		// sending it alone would be rejected, and `countMessages` would silently fall back to local
		// estimation for that slice only — an API-key-only inaccuracy that would be invisible here.
		// Overlapping prefixes cost more tokenizer passes; correctness for both paths is worth it.
		const countSlice = async (predicate) => {
			const humans = humanMessageData.filter(predicate).map(m => m.content);
			const assistants = assistantMessageData.filter(predicate).map(m => m.content);
			if (humans.length === 0 && assistants.length === 0) return 0;
			return tokenCounter.countMessages(humans, assistants);
		};
		const allMessageTokens = await countSlice(() => true);
		const cachedNowTokens = await countSlice(m => m.isCachedNow);
		// Without a new message the two boundaries are literally the same object (getCachingInfo
		// resolves once and shares it), so every message has isCachedNow === isCachedNext and
		// counting again would tokenize the entire cached prefix a second time for an identical
		// answer — on every navigation and every branch switch.
		const cachedNextTokens = next === now
			? cachedNowTokens
			: await countSlice(m => m.isCachedNext);

		lengthTokens += allMessageTokens;
		costTokens += allMessageTokens;
		futureCostTokens += allMessageTokens;
		uncachedCostTokens += allMessageTokens;
		uncachedFutureCostTokens += allMessageTokens;

		// Subtract each figure's own cached prefix. `cost` gets back what is cached NOW;
		// `futureCost` gets back everything that will be cached once the next message goes out,
		// which reaches one boundary further along the trunk.
		if (cachedNowTokens > 0) {
			costTokens -= cachedNowTokens * (1 - CONFIG.CACHING_MULTIPLIER);
		}
		if (cachedNextTokens > 0) {
			futureCostTokens -= cachedNextTokens * (1 - CONFIG.CACHING_MULTIPLIER);
		}

		// Steps 9-10: Project tokens and model detection
		let projectStats = null;
		if (conversationData.project_uuid) {
			projectStats = await this.api.getProjectStats(conversationData.project_uuid, isNewMessage);
			lengthTokens += projectStats.tokenInfo.length;
			costTokens += projectStats.tokenInfo.isCachedNow ? 0 : projectStats.tokenInfo.length;
			futureCostTokens += projectStats.tokenInfo.isCachedNext ? 0 : projectStats.tokenInfo.length;
			uncachedCostTokens += projectStats.tokenInfo.length; // Always full price
			uncachedFutureCostTokens += projectStats.tokenInfo.length;
		}

		// Determine if length is an estimate (features that add unknown tokens)
		const lengthIsEstimate = !!(
			effectiveSettings.enabled_monkeys_in_a_barrel ||  // Code execution
			hasWebSearchResult ||                            // Web search result in history
			effectiveSettings.enabled_bananagrams ||         // Drive search
			effectiveSettings.enabled_melange ||             // Memory (files loaded dynamically)
			projectStats?.use_project_knowledge_search       // Project retrieval
		);

		const subscriptionTier = await this.api.getSubscriptionTier();
		const conversationModelVersion = conversationData.model || defaultModelVersionForTier(subscriptionTier);
		const conversationModelType = modelFamilyFromVersion(conversationModelVersion) || defaultModelForTier(subscriptionTier);

		await Log(`Total tokens for conversation ${this.conversationId}: ${lengthTokens} with model ${conversationModelType}`);

		// Step 11: Modifiers — the per-request extras that are not part of the message tree.
		//
		// This lives here, and not in the callers, because every caller used to patch the result
		// afterwards with slightly different arithmetic: processResponse charged profile tokens at
		// full price to all four figures, while requestData and the branch-switch handler multiplied
		// them by CACHING_MULTIPLIER and never touched the future figures at all. Same conversation,
		// different cost depending on how you arrived at it.
		const profileTokens = await this.api.getProfileTokens();
		lengthTokens += profileTokens;
		// Preferences sit in the system-prompt prefix, right next to BASE_SYSTEM_PROMPT_LENGTH, which
		// this function already prices at CACHING_MULTIPLIER. Once anything is cached they are too,
		// and by the next message they always are.
		costTokens += conversationIsCached ? profileTokens * CONFIG.CACHING_MULTIPLIER : profileTokens;
		futureCostTokens += profileTokens * CONFIG.CACHING_MULTIPLIER;
		uncachedCostTokens += profileTokens; // the "no cache at all" figure — always full price
		uncachedFutureCostTokens += profileTokens;

		// Tool definitions are appended to the CURRENT prompt rather than sitting in the cached
		// prefix, so they are re-sent uncached with every single request. Full price everywhere,
		// now and next, and no caching multiplier applies.
		if (toolTokens) {
			// Deliberately NOT added to lengthTokens: length describes the conversation, and tool
			// definitions are a property of the request, not of the thread. Matches the old
			// processResponse, which added only profileTokens to length.
			costTokens += toolTokens;
			futureCostTokens += toolTokens;
			uncachedCostTokens += toolTokens;
			uncachedFutureCostTokens += toolTokens;
		}

		// Step 12: Future cost — straight out of the same walk now, no second pass.
		const futureCost = Math.round(futureCostTokens);
		const uncachedFutureCost = Math.round(uncachedFutureCostTokens);
		// Forward-looking: it answers "will the NEXT message be cached", so it comes from the `next`
		// boundary, where the just-sent message is allowed to hold its anchor. Without this the first
		// message of a conversation reports uncached until a reload or a second message.
		const cachedUntil = next.conversationIsCachedUntil;

		let lastMessageTimestamp = null;
		const lastRawMessage = currentTrunk[currentTrunk.length - 1];
		if (lastRawMessage) {
			lastMessageTimestamp = new Date(lastRawMessage.created_at).getTime();
		}
		// Step 12: Return result
		return new ConversationData({
			conversationId: this.conversationId,
			length: Math.round(lengthTokens),
			cost: Math.round(costTokens),
			uncachedCost: Math.round(uncachedCostTokens),
			futureCost: futureCost,
			uncachedFutureCost: uncachedFutureCost,
			model: conversationModelType,
			modelVersion: conversationModelVersion,
			costUsedCache: conversationIsCached,
			conversationIsCachedUntil: cachedUntil,
			projectUuid: conversationData.project_uuid,
			settings: effectiveSettings,
			lastMessageTimestamp: lastMessageTimestamp,
			lengthIsEstimate: lengthIsEstimate,
			orgId: this.api.orgId
		});
	}
}

// Export the new structure
export { ClaudeAPI, ConversationAPI, MessageAPI }