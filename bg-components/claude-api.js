import { CONFIG, RawLog, StoredMap, getStorageValue, sleep } from './utils.js';
import { tokenCounter, getTextFromContent } from './tokenManagement.js';
import { UsageData, ConversationData, modelFamilyFromVersion } from '../shared/dataclasses.js';

// The "Inline visualizations" switch enables the `visualize` MCP server's tools; this is one of
// them. The id is name-based, the same on every account. An account that never touched the switch
// has no entry, and is priced without it.
const VISUALIZE_TOOL = "6f616b42-0ed8-571e-823f-ee4aca6b7ce9:show_widget";

// Tools that run in the conversation's workspace (sandbox): the first one on the trunk marks where it
// was upgraded to a workspace. prepare_session is the upgrade a file too big for the context forces.
const SANDBOX_TOOLS = new Set(["prepare_session", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"]);
// In a workspace, an attached text file is read into context only up to Claude Code's Read cap; a
// bigger one stays in /mnt/user-data/uploads with only its path in context.
const WORKSPACE_ATTACHMENT_MAX_TOKENS = 25000;

// Files on `trunk` (from `fromIdx` on) the model never had. The tree keeps every text attachment's
// full extracted_content and every PDF's page count, but once a conversation runs in a workspace
// (workspace_upgraded) a file can sit in the sandbox instead: the files on the turn that forced the
// upgrade and, after it, every PDF or blob (only its path reaches the context) and any text attachment over
// the Read cap. Files sent before the upgrade went in inline and stay in context; images always do.
//
// The upgrade is the earliest of, anywhere in the tree (the workspace belongs to the conversation, so
// it may have happened on a branch since retried or edited away): a reply using a sandbox tool (the
// turn it forced, if that tool is prepare_session), or a message carrying a "blob" file, one claude.ai
// can't put in context (a PDF over the page cap, an archive), whose upgrade shows no tool call.
function sandboxedFiles(messages, trunk, fromIdx, workspaceUpgraded) {
	const sandboxed = new Set();
	if (!workspaceUpgraded) return sandboxed;
	const usesTool = (m, names) => (m.content ?? []).some(c => c.type === "tool_use" && names.has(c.name));
	const upgrade = messages.flatMap(m => {
		if (m.sender === "assistant" && usesTool(m, SANDBOX_TOOLS))
			return [{ at: Date.parse(m.created_at), forcedTurn: usesTool(m, new Set(["prepare_session"])) ? m.parent_message_uuid : null }];
		if (m.sender === "human" && (m.files ?? []).some(f => f.file_kind === "blob"))
			return [{ at: Date.parse(m.created_at), forcedTurn: m.uuid }];
		return [];
	}).reduce((first, u) => !first || u.at < first.at ? u : first, null);
	if (!upgrade) return sandboxed;
	// A token is at least one UTF-8 byte, so a file under the cap in bytes is under it in tokens and
	// skips the tokenizer.
	const overCap = text => new TextEncoder().encode(text).length * CONFIG.ESTIMATION_MULTIPLIER > WORKSPACE_ATTACHMENT_MAX_TOKENS &&
		tokenCounter.countTextLocal(text) > WORKSPACE_ATTACHMENT_MAX_TOKENS;
	for (let i = fromIdx; i < trunk.length; i++) {
		const message = trunk[i];
		if (message.sender !== "human") continue;
		const forcedHere = message.uuid === upgrade.forcedTurn;
		if (!forcedHere && !(Date.parse(message.created_at) > upgrade.at)) continue;
		for (const attachment of message.attachments ?? []) {
			if (attachment.extracted_content && (forcedHere || overCap(attachment.extracted_content))) sandboxed.add(attachment);
		}
		for (const file of message.files ?? []) {
			if (file.file_kind === "document" || file.file_kind === "blob") sandboxed.add(file);
		}
	}
	return sandboxed;
}

// The fixed system prompt's total (CONFIG.SYSTEM_PROMPT_TOKENS lists it by section).
const FIXED_PROMPT_TOKENS = Object.values(CONFIG.SYSTEM_PROMPT_TOKENS).reduce((a, b) => a + b, 0);

async function Log(...args) {
	await RawLog("claude-api", ...args);
}

// Called from background.js's request handler when the user writes account settings.
export async function invalidateAccountSettings(orgId) {
	if (!orgId) return;
	await accountSettingsCache.delete(orgId);
	await Log("Invalidated account settings cache for:", orgId);
}

// Called from background.js's request handler on PUT /account_profile - the same request that
// carries a language change also carries edited conversation preferences.
export async function invalidateProfileTokens(orgId) {
	if (!orgId) return;
	await profileTokensCache.delete(orgId);
	await Log("Invalidated profile tokens cache for:", orgId);
}

// A merged-experience compaction divider as the tree shows it: an assistant message with no content
// whose parent is the turn's reply. (A turn refused as "too long" is also empty, but its parent is
// the human message.)
function isCompactionDivider(message, parent) {
	return message?.sender === "assistant" && !(message.content ?? []).length && parent?.sender === "assistant";
}

// The turn the tree ends on: its leaf, or the reply under it when a compaction divider landed on top.
export function effectiveLeaf(tree) {
	const messages = tree?.chat_messages ?? [];
	const leaf = messages.find(m => m.uuid === tree?.current_leaf_message_uuid);
	const parent = leaf && messages.find(m => m.uuid === leaf.parent_message_uuid);
	return isCompactionDivider(leaf, parent) ? parent.uuid : leaf?.uuid ?? null;
}

// getSettledTree: how often, and how far apart, to re-read the tree for a settled reply.
const SETTLED_TREE_RETRIES = 3;
const SETTLED_TREE_RETRY_MS = 700;
const subscriptionTiersCache = new StoredMap("subscriptionTiers");
const projectCache = new StoredMap("projectCache");
const accountSettingsCache = new StoredMap("accountSettings");
const profileTokensCache = new StoredMap("profileTokens");

// Feature flags change only when the user flips a switch, and background.js's request handler
// invalidates on a settings write, so the TTL only covers changes made elsewhere. Not shorter: each
// refill is the ~850KB bootstrap (see fetchBootstrap).
const ACCOUNT_SETTINGS_TTL = 30 * 60 * 1000;
const PROFILE_TOKENS_TTL = 5 * 60 * 1000;

// getContextUsage: how long to wait for the session's answer in all (0.6s warm, ~4s if the container
// has to wake), and how often to look for it.
const CONTEXT_USAGE_TIMEOUT_MS = 10000;
const CONTEXT_USAGE_POLL_MS = 250;

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
// Thrown by getRequest when claude.ai answers with something that is not a successful JSON body.
// It reports what arrived - status, content type, whether the body was HTML, and a snippet - and
// draws no conclusion about why. An HTML body is most often Cloudflare's interstitial, but it is
// also what a maintenance page, an edge error and a login redirect look like, and a diagnostic that
// names a cause it cannot see is worse than one that just shows you the evidence.
class ClaudeApiError extends Error {
	constructor(label, { status, statusText, contentType, html, snippet }) {
		const detail = [
			status ? `${status}${statusText ? ` ${statusText}` : ''}` : 'no status',
			contentType || 'no content-type',
			html ? '(HTML response, not JSON)' : null
		].filter(Boolean).join(' ');
		super(`${label} failed: ${detail}`);
		this.name = 'ClaudeApiError';
		this.status = status;
		this.contentType = contentType;
		this.html = !!html;
		this.snippet = snippet;
	}
}

// Sniff the body rather than trusting the content type, because a Response rebuilt by the Brave tab
// proxy carries no headers at all.
function looksLikeHtml(body) {
	return /^\s*<(!doctype|html)/i.test(body || '');
}

async function parseJsonResponse(response, label) {
	// Read as text and parse by hand rather than calling response.json(). It costs one extra string
	// copy of the body, which is real but small next to the network round trip, and it buys the two
	// things that make a failure legible: the same HTML sniff on every path (an HTML error page can
	// arrive with a 200, so keying detection off response.ok misses it), and a
	// snippet of what actually arrived in the log.
	const body = await response.text();

	if (response.ok) {
		try {
			return JSON.parse(body);
		} catch (cause) {
			const error = buildError(response, label, body);
			error.cause = cause;
			await Log("error", error.message, error.snippet);
			throw error;
		}
	}

	const error = buildError(response, label, body);
	await Log("error", error.message, error.snippet);
	throw error;
}

function buildError(response, label, body) {
	return new ClaudeApiError(label, {
		status: response.status,
		statusText: response.statusText,
		contentType: response.headers?.get?.('content-type') || '',
		html: looksLikeHtml(body),
		snippet: (body || '').slice(0, 200)
	});
}

class ClaudeAPI {
	// `fetchImpl(url, options) => Response` is supplied by the active ContainerStrategy, already bound
	// to this account's container. ClaudeAPI itself is container-agnostic. `pageFetchImpl`, same shape,
	// is the strategy's fetch made by a claude.ai tab rather than the background, for the endpoints
	// that refuse the extension's origin; null when there's no tab to make it.
	constructor(orgId, fetchImpl, pageFetchImpl = null) {
		this.baseUrl = 'https://claude.ai/api';
		this.orgId = orgId;
		this.fetchImpl = fetchImpl;
		this.pageFetchImpl = pageFetchImpl;
	}

	// Core methods
	//
	// Every endpoint funnels through here, so this is the one place that decides what "the call
	// failed" looks like. It throws a ClaudeApiError carrying the status and content type rather
	// than letting a non-JSON body reach JSON.parse, because the old behaviour cost days on issue
	// #90: an HTML error page surfaced as "SyntaxError: JSON.parse: unexpected character at line 1
	// column 1", which says nothing about what actually came back. It now reads
	// "GET /account_profile failed: 403 text/html; charset=UTF-8 (HTML response, not JSON)".
	//
	// Checking response.ok also closes a second hole. A 4xx/5xx whose body IS valid JSON used to be
	// parsed and handed back as data; on /usage that produced a UsageData with every limit null,
	// indistinguishable from the free plan's genuinely empty response. Callers tolerate the throw -
	// each getUsageData() caller either try/catches or runs inside a wrapper that does, since a
	// network failure already took exactly this path. One user-visible consequence: a non-ok
	// response with a JSON body used to reach the UI as an empty UsageData and render "Usage data
	// unavailable"; it now rejects before the push, so the sidebar holds its previous figures
	// instead. The popup is unaffected - getPopupUsageData already catches and renders an error row.
	async getRequest(endpoint) {
		const url = `${this.baseUrl}${endpoint}`;
		const response = await this.fetchImpl(url, {
			headers: {
				'Content-Type': 'application/json'
			},
			method: 'GET'
		});
		return parseJsonResponse(response, `GET ${endpoint}`);
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
			// The balance is supplementary: creditBalance stays null on failure and the extra-usage
			// maths falls back to the monthly cap. So a failed /credits must not take the whole
			// UsageData down - and with it every bar, plus the authoritative pass, which fetches usage
			// before the conversation. Issue #97 was a Team admin without billing rights getting a
			// permanent 403 (`billing:credit:get`) here; a transient 500 from the same endpoint blanked
			// the sidebar the same way during testing. parseJsonResponse has already logged it.
			creditsResponse = await this.getCredits().catch(() => null);
		}
		const usageData = UsageData.fromAPIResponse(usageLimitsResponse, subscriptionTier, creditsResponse);
		usageData.orgId = this.orgId;
		// Every consumer - the tab push, the popup, reset notifications - comes through here, so the
		// free-plan fallback is applied once, in the one place that owns building a UsageData.
		// The extra-usage display pref is stamped here for the same reason: the UI only ever
		// rehydrates what this returns, so no renderer has to know the setting exists. The default
		// is the new-install one; background.js pins the legacy value on update (see its
		// onInstalled handler), so an absent key here really does mean a fresh install.
		usageData.extraUsageAgainstLimit = await getStorageValue('extraUsageAgainstLimit', true);
		await applySseUsageFallback(usageData, this);
		return usageData;
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

	// The bootstrap feeds two caches, so one fetch (~850KB) refills both: the org record
	// (subscription tier) and the account flags pricing reads. Flags come from here rather than
	// /account because the merged experience's memory switches don't show in /account
	// (enabled_melange stays null with memory on); the bootstrap has them and a top-level
	// memory_mode. Only the few flags used are kept: the raw settings carry hundreds of dismissed
	// banners and per-tool MCP booleans that would bloat storage.local.
	async fetchBootstrap() {
		const data = await this.getRequest(`/bootstrap/${this.orgId}/app_start?statsig_hashing_algorithm=djb2`);
		const org = data.account?.memberships?.find(membership => membership.organization.uuid === this.orgId)?.organization;
		await subscriptionTiersCache.set(this.orgId, org, 24 * 60 * 60 * 1000);
		const settings = data.account?.settings;
		const flags = settings ? {
			memory: data.memory_mode === "melange",
			inline_visuals: settings.enabled_mcp_tools?.[VISUALIZE_TOOL] === true,
			enabled_saffron_search: settings.enabled_saffron_search,
			enabled_bananagrams: settings.enabled_bananagrams	// Drive search: only marks the length an estimate
		} : null;
		if (flags) await accountSettingsCache.set(this.orgId, flags, ACCOUNT_SETTINGS_TTL);
		await Log("Fetched bootstrap for:", this.orgId, org?.name, flags);
		return { org, flags };
	}

	// Account-level feature flags (see fetchBootstrap). The conversation payload only carries a
	// subset of these, so it can't be relied on alone for pricing. Returns null on failure rather
	// than throwing: the Brave strategy throws when a container has no open tab, and that must not
	// take down the whole cost computation.
	async getAccountSettings() {
		try {
			const cached = await accountSettingsCache.get(this.orgId);
			if (cached && typeof cached === 'object') return cached;
			return (await this.fetchBootstrap()).flags;
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
			totalTokens = await tokenCounter.countText(profileData.conversation_preferences) + CONFIG.PREFERENCES_SECTION_TOKENS;
		}
		await Log(`Profile tokens: ${totalTokens}`);
		await profileTokensCache.set(this.orgId, totalTokens, PROFILE_TOKENS_TTL);
		return totalTokens;
	}

	async getOrgInfo(skipCache = false) {
		try {
			const cached = await subscriptionTiersCache.get(this.orgId);
			if (cached && !skipCache && typeof cached === 'object' && cached.capabilities) return cached;
			return (await this.fetchBootstrap()).org;
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

	// `includeFile` picks the files that were in context (all, by default). Only images and documents
	// can be: anything else ("blob") stays in the workspace.
	async getFileTokens(includeFile = () => true) {
		const inContext = (this.data.files || [])
			.filter(file => (file.file_kind === "image" || file.file_kind === "document") && includeFile(file));
		const filePromises = inContext.map(async (file) => {
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

	// Get text content (Not tokens, so it can be done all in one call later). asOutput picks the
	// view - see getTextFromContent: context for the message's share of later prompts, output for
	// what the model generated.
	// `includeAttachment` picks the text attachments that were in context (all, by default).
	async getTextContent(asOutput = false, includeAttachment = () => true) {
		let messageContent = [];

		// Process content array
		for (const content of this.data.content || []) {
			messageContent = messageContent.concat(getTextFromContent(content, asOutput));
		}

		// Process attachments
		for (const attachment of this.data.attachments || []) {
			if (attachment.extracted_content && includeAttachment(attachment)) {
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
	//
	// `strong` asks for a read-your-writes copy (consistency=strong, which claude.ai's own page-load
	// GET uses) and `refresh` skips the memo: a pass triggered by the merged experience's stream has no
	// tree GET of claude.ai's proving the tree is current, so it checks and may refetch.
	//
	// If this legacy endpoint ever goes away (merged accounts already never call it themselves), its
	// replacement is ConversationService/ReadConversation (Connect; JSON works too: content-type
	// application/json, body {"conversationId"}): the whole tree, branches included, in one call. Not on
	// legacy accounts (403). It also rejects this background's requests, 403 "origin not allowed" (the
	// RPC endpoints check Origin, the /api ones don't), so it would need the page's origin. Its gaps: text
	// attachments come as a URL rather than `extracted_content` (fetch /files/<id>/contents), and
	// compactions made in the merged experience exist only there (as CompactionDivider extras), not
	// here. See claude-ext-common scripts/bard/README.md.
	async getData(full_tree = false, { strong = false, refresh = false } = {}) {
		const slot = full_tree ? "tree" : "flat";
		if (!this.dataCache[slot] || refresh) {
			this.dataCache[slot] = await this.api.getRequest(
				`/organizations/${this.api.orgId}/chat_conversations/${this.conversationId}?tree=${full_tree}&rendering_mode=messages&render_all_tools=true${strong ? '&consistency=strong' : ''}`
			);
		}
		return this.dataCache[slot];
	}

	// The tree for a pass triggered by the merged experience's StreamTimeline settle, which (unlike
	// claude.ai's post-message tree GET) proves nothing about the tree being current: a strong read
	// and, when the stream named the settled reply, a few short re-reads until the leaf is it. After
	// that it prices the tree as is, with a warning. Memoized like getData, so getInfo reuses it.
	async getSettledTree(expectedLeaf) {
		let tree = await this.getData(true, { strong: true });
		for (let i = 0; expectedLeaf && effectiveLeaf(tree) !== expectedLeaf; i++) {
			if (i === SETTLED_TREE_RETRIES) {
				await Log("warn", "Settled turn", expectedLeaf, "isn't the tree's leaf", tree?.current_leaf_message_uuid, "- pricing the tree as is");
				break;
			}
			await sleep(SETTLED_TREE_RETRY_MS);
			tree = await this.getData(true, { strong: true, refresh: true });
		}
		return tree;
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

		// Compaction: the trunk up to and including the latest boundary was replaced by a summary, so
		// the context starts after it, and so do the cache anchors (one from before the compaction
		// can't cover the new prefix). A pre-merge boundary carries the summary text; a merged one is a
		// divider, priced at CONFIG.COMPACTION_SUMMARY_TOKENS.
		let compactionIdx = -1;
		for (let i = currentTrunk.length - 1; i >= 0; i--) {
			if (currentTrunk[i].compaction_summary?.length || isCompactionDivider(currentTrunk[i], currentTrunk[i - 1])) {
				compactionIdx = i;
				break;
			}
		}
		const candidateHumans = allTrunkHumans.filter(h => trunkIndexMap.get(h.uuid) > compactionIdx);

		// The turn the trunk ends on (a divider lands on top of its reply), and the reply whose output
		// that turn paid for: the turn itself, or the one before a trailing human.
		const lastIdx = currentTrunk.length - 1;
		const turnIdx = isCompactionDivider(currentTrunk[lastIdx], currentTrunk[lastIdx - 1]) ? lastIdx - 1 : lastIdx;
		// (Before a trailing human, step over a divider: reply -> divider -> human right after a compaction.)
		const beforeHumanIdx = isCompactionDivider(currentTrunk[turnIdx - 1], currentTrunk[turnIdx - 2]) ? turnIdx - 2 : turnIdx - 1;
		const outputIdx = [turnIdx, beforeHumanIdx].find(i => currentTrunk[i]?.sender === "assistant") ?? -1;

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
		const next = await resolveBoundary(candidateHumans);
		const now_ = isNewMessage
			? await resolveBoundary(candidateHumans.filter(h => h !== allTrunkHumans[allTrunkHumans.length - 1]))
			: next;

		return { currentTrunk, compactionIdx, turnIdx, outputIdx, now: now_, next };
	}

	// A workspace-upgraded chat's real context size, from its Claude Code session: Claude Code's own
	// get_context_usage control request, sent through the CCR events API, with the answer polled from
	// the session's event log. Null if it can't be had within CONTEXT_USAGE_TIMEOUT_MS.
	//
	// Made by the tab (pageFetchImpl): that API refuses the extension's origin (the background's POST
	// gets 401 "Credential is invalid", though its GETs work). The request and its answer stay in the
	// session's event log for good, so getInfo asks only when the authoritative pass hands it the
	// session of a turn that just settled: never on load or on a timer.
	async getContextUsage(sessionId) {
		const pageFetch = this.api.pageFetchImpl;
		if (!pageFetch) return null;
		const deadline = Date.now() + CONTEXT_USAGE_TIMEOUT_MS;
		// The tab's fetch has no abort signal across the message boundary, so each call races the deadline.
		const beforeDeadline = (promise) => Promise.race([promise, sleep(Math.max(deadline - Date.now(), 0)).then(() => null)]);
		const url = `https://claude.ai/v1/code/sessions/${encodeURIComponent(sessionId)}/events`;
		const headers = {
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'ccr-byoc-2025-07-29',
			'anthropic-client-feature': 'ccr',
			'x-organization-uuid': this.api.orgId,
		};
		const requestId = `claude-usage-tracker-${crypto.randomUUID()}`;
		try {
			const sent = await beforeDeadline(pageFetch(url, {
				method: 'POST',
				headers: { ...headers, 'content-type': 'application/json' },
				body: JSON.stringify({ events: [{ payload: { type: 'control_request', request_id: requestId, request: { subtype: 'get_context_usage' } } }] }),
			}));
			if (!sent?.ok) {
				await Log("warn", "get_context_usage for", sessionId, "not sent:", sent ? sent.status : "timed out");
				return null; // 404: no such session, 400: malformed id
			}
			while (Date.now() < deadline) {
				await sleep(CONTEXT_USAGE_POLL_MS);
				const page = await beforeDeadline(pageFetch(`${url}?limit=10&sort_order=desc`, { method: 'GET', headers }));
				if (!page?.ok) break;
				const reply = (await page.json()).data?.find(e => e.payload?.type === 'control_response' && e.payload.response?.request_id === requestId);
				if (!reply) continue;
				const { subtype, response } = reply.payload.response;
				if (subtype !== 'success' || !response) break;
				return response;
			}
		} catch (e) {
			await Log("warn", "get_context_usage for", sessionId, "failed:", e);
			return null;
		}
		await Log("warn", "No get_context_usage answer from", sessionId);
		return null;
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
	// `sessionId`: a workspace-upgraded chat's Claude Code session, passed only by the authoritative
	// pass of a settled turn. Its real context size then replaces the estimate (see getContextUsage).
	async getInfo(isNewMessage, sessionId = null) {
		await Log("API: Requesting information for conversation:", this.conversationId);
		// Started first: it runs alongside the tokenizing below.
		const contextUsage = sessionId ? this.getContextUsage(sessionId) : null;
		const conversationData = await this.getData(true);
		const cachingInfo = await this.getCachingInfo(isNewMessage);
		if (!cachingInfo) {
			// Something is VERY wrong if we can't get caching info - return base prompt cost as fallback
			return new ConversationData({
				conversationId: this.conversationId,
				length: FIXED_PROMPT_TOKENS,
				systemPromptTokens: FIXED_PROMPT_TOKENS,
				cost: FIXED_PROMPT_TOKENS * CONFIG.CACHING_MULTIPLIER,
				futureCost: FIXED_PROMPT_TOKENS * CONFIG.CACHING_MULTIPLIER,
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

		const { currentTrunk, compactionIdx, turnIdx, outputIdx, now, next } = cachingInfo;
		const conversationIsCached = now.conversationIsCached;

		// Initialize token counting. Two cache flags walk the trunk in parallel: `now` prices this
		// message, `next` prices the one after it. They differ only in where the boundary sits.
		let cacheIsActive = now.conversationIsCached;
		let cacheIsActiveNext = next.conversationIsCached;
		let lengthTokens = FIXED_PROMPT_TOKENS;
		let costTokens = FIXED_PROMPT_TOKENS * CONFIG.CACHING_MULTIPLIER;
		let futureCostTokens = FIXED_PROMPT_TOKENS * CONFIG.CACHING_MULTIPLIER;

		// The conversation's own settings win over the account's: a flag snapshotted into the
		// conversation (code execution, artifacts) is frozen at creation, while one it doesn't carry
		// follows the account live. The flags pricing reads (memory, inline_visuals, chat search,
		// Drive) never appear in a conversation's settings, so in practice they follow the account.
		const accountSettings = await this.api.getAccountSettings();
		const effectiveSettings = {
			...(accountSettings || {}),
			...(conversationData.settings || {})
		};
		// The composer's per-chat Memory checkbox: unticked, the chat gets neither the memory
		// sections and tools nor chat search.
		if (effectiveSettings.chat_memory_mode === "disabled") {
			effectiveSettings.memory = false;
			effectiveSettings.enabled_saffron_search = false;
		}

		// The parts of the system prompt a setting switches on (prompt sections plus their tools),
		// static and in the cached prefix like the rest of it. One log line, not one per setting:
		// logging is always on and the log is capped.
		await Log("Enabled settings:", Object.keys(effectiveSettings).filter(key => effectiveSettings[key]).join(', '));
		const featureTokens = Object.entries(CONFIG.FEATURE_PROMPT_TOKENS)
			.filter(([setting]) => effectiveSettings[setting])
			.reduce((sum, [, tokens]) => sum + tokens, 0);
		lengthTokens += featureTokens;
		// The cached system prompt's share of the length: fixed part, feature sections, preferences.
		let systemPromptTokens = FIXED_PROMPT_TOKENS + featureTokens;
		costTokens += featureTokens * CONFIG.CACHING_MULTIPLIER;
		futureCostTokens += featureTokens * CONFIG.CACHING_MULTIPLIER;

		let uncachedCostTokens = costTokens; // Same — system prompts are always platform-cached
		let uncachedFutureCostTokens = costTokens;
		// Steps 7-8: Process messages and count tokens
		const humanMessageData = [];
		const assistantMessageData = [];
		let hasWebSearchResult = false;

		// The compaction summary opens the context, so it's cached exactly when the conversation is.
		// The turn that compacted is priced like any other, from the summary on. Its compaction call
		// read the whole pre-compaction prompt, but nearly all of that was cached (cache reads cost
		// nothing here), so the difference is the summary's own generation: accepted, once per compaction.
		if (compactionIdx >= 0) {
			const boundary = currentTrunk[compactionIdx];
			const summaryTokens = boundary.compaction_summary?.length
				? await tokenCounter.countText(boundary.compaction_summary.flatMap(block => getTextFromContent(block)).join("\n"))
				: CONFIG.COMPACTION_SUMMARY_TOKENS;
			await Log(`Compaction at trunk message ${compactionIdx + 1}/${currentTrunk.length}: summary ${summaryTokens} tokens`);
			lengthTokens += summaryTokens;
			costTokens += conversationIsCached ? summaryTokens * CONFIG.CACHING_MULTIPLIER : summaryTokens;
			futureCostTokens += next.conversationIsCached ? summaryTokens * CONFIG.CACHING_MULTIPLIER : summaryTokens;
			uncachedCostTokens += summaryTokens;
			uncachedFutureCostTokens += summaryTokens;
		}

		// The reply's output, priced even when a compaction has since folded it into the summary.
		// OUTPUT_TOKEN_MULTIPLIER is the surcharge on top of the reply's 1x in the walk below; a folded
		// reply isn't walked, so it takes that 1x here.
		let outputTokens = 0;
		if (outputIdx >= 0) {
			const reply = new MessageAPI(currentTrunk[outputIdx], false, this.api);
			const multiplier = CONFIG.OUTPUT_TOKEN_MULTIPLIER + (outputIdx <= compactionIdx ? 1 : 0);
			outputTokens = await tokenCounter.countText(await reply.getTextContent(true)) * multiplier;
			costTokens += outputTokens;
			futureCostTokens += outputTokens;
			uncachedCostTokens += outputTokens;
			uncachedFutureCostTokens += outputTokens;
		}

		const sandboxed = sandboxedFiles(conversationData.chat_messages, currentTrunk, compactionIdx + 1, conversationData.workspace_upgraded);

		for (let i = compactionIdx + 1; i < currentTrunk.length; i++) {
			const rawMessageData = currentTrunk[i];
			const message = new MessageAPI(rawMessageData, cacheIsActive, this.api);

			// Check for web search results in message content
			if (!hasWebSearchResult && rawMessageData.content) {
				hasWebSearchResult = rawMessageData.content.some(
					item => item.type === 'tool_result' && item.name === 'web_search'
				);
			}

			const fileTokens = await message.getFileTokens(file => !sandboxed.has(file));

			const isCachedNext = cacheIsActiveNext;

			lengthTokens += fileTokens;
			costTokens += message.isCached ? fileTokens * CONFIG.CACHING_MULTIPLIER : fileTokens;
			futureCostTokens += isCachedNext ? fileTokens * CONFIG.CACHING_MULTIPLIER : fileTokens;
			uncachedCostTokens += fileTokens; // Always full price
			uncachedFutureCostTokens += fileTokens;

			// Text content
			const textContent = await message.getTextContent(false, attachment => !sandboxed.has(attachment));

			if (message.sender === "human") {
				humanMessageData.push({ content: textContent, isCachedNow: message.isCached, isCachedNext });
			} else {
				assistantMessageData.push({ content: textContent, isCachedNow: message.isCached, isCachedNext });
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
			hasWebSearchResult ||                            // Web search result in history
			effectiveSettings.enabled_bananagrams ||         // Drive search
			effectiveSettings.memory ||                      // Memory (its files aren't counted)
			projectStats?.use_project_knowledge_search ||    // Project retrieval
			sandboxed.size > 0 ||                            // A file in the sandbox (the model may read parts)
			(compactionIdx >= 0 && !currentTrunk[compactionIdx].compaction_summary?.length) // Merged compaction summary (a constant)
		);

		// Null when the API reports no model at all, which a freshly created conversation does for a
		// short window. Substituting the tier default here used to mislabel those chats - reporting
		// Opus for a Sonnet conversation - which read as a model change and hid the cache indicator.
		// The honest answer is "we don't know yet"; runAuthoritativePass fills it in from the
		// captured request body when there is one (see applyPendingModel).
		const conversationModelVersion = conversationData.model || null;
		const conversationModelType = modelFamilyFromVersion(conversationModelVersion);

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
		systemPromptTokens += profileTokens;
		// Preferences sit in the system-prompt prefix, right next to the fixed prompt, which
		// this function already prices at CACHING_MULTIPLIER. Once anything is cached they are too,
		// and by the next message they always are.
		costTokens += conversationIsCached ? profileTokens * CONFIG.CACHING_MULTIPLIER : profileTokens;
		futureCostTokens += profileTokens * CONFIG.CACHING_MULTIPLIER;
		uncachedCostTokens += profileTokens; // the "no cache at all" figure — always full price
		uncachedFutureCostTokens += profileTokens;

		// A workspace-upgraded chat's real context size, read from its Claude Code session, replaces
		// the token figures above; the estimate still
		// supplies the reply's output surcharge, the model and the cache expiry. The last request's
		// usage (apiUsage) prices this message: its input split, plus its reply at 1x (the walk's share
		// in the estimate). The next request reads at least that input plus that reply, and totalTokens
		// doesn't always include the reply yet (measured both ways), hence the max; only what the last
		// request didn't send (the final reply, mostly) is new to the cache.
		const real = await contextUsage;
		const { input_tokens = 0, cache_creation_input_tokens = 0, cache_read_input_tokens = 0, output_tokens = 0 } = real?.apiUsage ?? {};
		const lengthIsExact = Number.isFinite(real?.totalTokens);
		if (lengthIsExact) {
			const lastInput = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
			const context = Math.max(real.totalTokens, lastInput + output_tokens);
			const used = (name) => real.categories?.find(c => c.name === name && c.kind === 'used')?.tokens ?? 0;
			await Log(`Context of ${this.conversationId} from its session: ${context} tokens (estimated ${Math.round(lengthTokens)})`);
			lengthTokens = context;
			systemPromptTokens = used('System prompt') + used('System tools') + used('Skills');
			costTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens * CONFIG.CACHING_MULTIPLIER + output_tokens + outputTokens;
			uncachedCostTokens = lastInput + output_tokens + outputTokens;
			futureCostTokens = (context - lastInput) + lastInput * CONFIG.CACHING_MULTIPLIER + outputTokens;
			uncachedFutureCostTokens = context + outputTokens;
		}

		// Step 12: Future cost — straight out of the same walk now, no second pass.
		const futureCost = Math.round(futureCostTokens);
		const uncachedFutureCost = Math.round(uncachedFutureCostTokens);
		// Forward-looking: it answers "will the NEXT message be cached", so it comes from the `next`
		// boundary, where the just-sent message is allowed to hold its anchor. Without this the first
		// message of a conversation reports uncached until a reload or a second message.
		const cachedUntil = next.conversationIsCachedUntil;

		let lastMessageTimestamp = null;
		const lastRawMessage = currentTrunk[turnIdx];
		if (lastRawMessage) {
			lastMessageTimestamp = new Date(lastRawMessage.created_at).getTime();
		}
		// Step 12: Return result
		return new ConversationData({
			conversationId: this.conversationId,
			length: Math.round(lengthTokens),
			systemPromptTokens: Math.round(systemPromptTokens),
			cost: Math.round(costTokens),
			uncachedCost: Math.round(uncachedCostTokens),
			futureCost: futureCost,
			uncachedFutureCost: uncachedFutureCost,
			model: conversationModelType,
			modelVersion: conversationModelVersion,
			lastMessageUuid: currentTrunk[turnIdx]?.uuid || null,
			costUsedCache: conversationIsCached,
			conversationIsCachedUntil: cachedUntil,
			projectUuid: conversationData.project_uuid,
			settings: effectiveSettings,
			lastMessageTimestamp: lastMessageTimestamp,
			lengthIsEstimate: lengthIsEstimate && !lengthIsExact,
			orgId: this.api.orgId
		});
	}
}

// Export the new structure
export { ClaudeAPI, ConversationAPI, MessageAPI, ClaudeApiError }