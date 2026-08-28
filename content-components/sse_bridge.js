/* global Log, CONFIG, getActiveOrgId, sendBackgroundMessage, GPTTokenizer_o200k_base */
'use strict';

// Consumes the single `claudeUsageTrackerStream` message that injections/usage-sse-watcher.js
// emits per completion, and splits it two ways:
//
//   * session usage -> straight to the UI actors in this same page, which overwrite that one
//     field on the usage data they already hold. No background hop, so the bars move with zero
//     added latency even if the service worker is asleep.
//   * the reply's token count -> to the background, which owns the cached ConversationData and
//     turns it into a provisional length/cost estimate (see reportStreamCompletion in
//     background.js). The background answers on the normal updateConversationData channel.
//
// The reply TEXT never leaves this file: it is tokenized here and only the resulting number is
// sent. That keeps message content out of the background's heap and off disk entirely, which is
// what PRIVACY.md promises. It also finally puts lib/o200k_base.js to use - it has been loaded
// into every claude.ai page by the manifest, and unused, all along.
//
// Plain callback registry rather than a DOM CustomEvent: every subscriber is a content script
// sharing this scope, so there is no reason to route through the page's window (which would also
// let page scripts listen in) or to worry about how detail objects cross worlds in Firefox.
// This file loads before the UI actors, so the registry exists by the time they subscribe.
const ssePartialUsageListeners = [];

function onSsePartialUsage(listener) {
	ssePartialUsageListeners.push(listener);
}

// The `windows` map in the stream is NOT shaped like the /usage endpoint's `limits` array:
// utilization is a 0-1 fraction rather than a 0-100 percent, and resets_at is unix seconds rather
// than an ISO string. ADAPT HERE if that changes.
//
// Full message_limit payload, as observed 2026-08-20 on a within-limit response (see
// injections/usage-sse-watcher.js for the surrounding stream):
//   type, overageStatus          "within_limit"; other states not captured
//   resetsAt, remaining, perModelLimit   all null while within limit
//   representativeClaim          "five_hour" - names the limit `resolved` describes
//   overageResetsAt, overageInUse
//   windows                      { "5h", "7d", "7d_oi", "overage" }, each
//                                { status, resets_at (unix seconds), utilization (0-1) }
//   resolved                     { status, limit, spend, disabled_reason, notice }
//
// `resolved.limit` is the single limit the server considers representative, and unlike `windows`
// it IS shaped like a /usage `limits[]` entry: { kind, group, percent (0-100 integer), severity,
// resets_at (ISO string), scope, is_active }. Tempting, but it only ever describes one limit, so
// it cannot stand in for the /usage fetch. (`spend` was null here even with extra usage enabled.)
//
// utilization is rounded to 2 decimals - whole-percent granularity, matching /usage's integer
// percent. Neither side is more precise than the other; they just round independently.
//
function parseSseWindow(win) {
	if (!win || typeof win.utilization !== 'number' || !win.resets_at) return null;

	// A window that has actually bound still reports a fraction below one - observed 0.98 alongside
	// status "exceeded_limit" and surpassed_threshold 1.0 (see injections/usage-sse-watcher.js).
	// So the number cannot be trusted to reach the cap on its own, and "98%" beside a composer that
	// refuses to send reads as the extension being wrong. Let status win.
	const exceeded = win.status === 'exceeded_limit';

	return {
		percentage: exceeded ? 100 : Math.round(win.utilization * 100),
		resetsAt: win.resets_at * 1000
	};
}

// The live in-page update takes the 5h window only. `7d` moves by a fraction of a percent per
// message, so refreshing it a second early buys nothing.
function parseSseSessionLimit(messageLimit) {
	return parseSseWindow(messageLimit?.windows?.['5h']);
}

// Everything the stream reports that maps cleanly onto a /usage limit key, for the background to
// persist. This exists for ONE case: the free plan, where /usage answers with every field null and
// an empty `limits` array, leaving the stream as the only place usage is ever reported. On every
// other tier the stored copy is written and never read - see applySseUsageFallback in
// bg-components/claude-api.js, which is gated to claude_free.
//
// `7d_oi` is still left alone: it looks like the weekly scoped to whichever model served the
// request - which model that is differs per account, and the stream never says - and its value
// disagreed with /usage's weekly_scoped by a point when checked (0.1 against percent 11). It does
// not appear in free-plan payloads at all. `overage` is extra-usage spend, which a free account
// cannot have (canUseExtraUsage excludes claude_free), so it has no fallback to feed.
function parseSseLimits(messageLimit) {
	const session = parseSseWindow(messageLimit?.windows?.['5h']);
	const weekly = parseSseWindow(messageLimit?.windows?.['7d']);
	if (!session && !weekly) return null;
	return { session, weekly };
}

// Session usage only ever rises within a window, so a lower number from the stream is noise: both
// sides quantise a fractional utilization to whole percent independently, and the stream's figure
// is taken a moment before the accounting settles, so they can disagree by one. Observed live as
// 37% -> 36% -> 37%, the bar ticking backwards for the ~3s until the full fetch corrected it.
// A genuine reset does drop the number, and that always comes with a new reset timestamp.
//
// This guards the in-page update only. mergeSseWindow in bg-components/claude-api.js applies the
// same rule to the snapshot the background persists, sharing the tolerance through CONFIG.
//
// CONFIG is safe to read here: both subscribers gate handleSsePartialUsage on uiReady, which their
// init() only sets after blocking on `while (!CONFIG)`.
function shouldApplySseSession(current, incoming) {
	if (!current) return true;
	const sameWindow = Math.abs((current.resetsAt || 0) - incoming.resetsAt) < CONFIG.SSE_SAME_WINDOW_TOLERANCE_MS;
	return !sameWindow || incoming.percentage > current.percentage;
}

// countTokens is synchronous and runs on the page's main thread, so a very long reply would jank
// the tab at exactly the wrong moment. Past this we count a prefix and let the caller flag the
// result as an estimate; the authoritative pass corrects it a second later either way.
const MAX_TOKENIZED_CHARS = 400 * 1000;

function countAssistantTokens(text) {
	if (!text) return { tokens: 0, truncated: false };
	const truncated = text.length > MAX_TOKENIZED_CHARS;
	const counted = truncated ? text.slice(0, MAX_TOKENIZED_CHARS) : text;
	// Same arithmetic as TokenCounter's local path in bg-components/tokenManagement.js, sharing
	// ESTIMATION_MULTIPLIER through CONFIG so the two can't drift apart.
	const tokens = Math.round(GPTTokenizer_o200k_base.countTokens(counted) * CONFIG.ESTIMATION_MULTIPLIER);
	return { tokens, truncated };
}

function initSseBridge() {
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		if (event.data?.type !== 'claudeUsageTrackerStream') return;

		// The stream came from this tab, so it is this tab's org unless the user switched orgs
		// mid-generation. Cheap to rule out.
		const myOrgId = getActiveOrgId();
		if (event.data.streamOrgId && myOrgId && event.data.streamOrgId !== myOrgId) return;

		const session = parseSseSessionLimit(event.data.messageLimit);
		if (session) {
			Log('SSE session usage:', session.percentage + '%');
			for (const listener of ssePartialUsageListeners) {
				try {
					listener({ session });
				} catch (error) {
					Log('warn', 'SSE partial usage listener failed:', error);
				}
			}
		}

		// Deferred a tick: the page is mid-repaint as the stream closes, and there is most of a
		// second of budget before the authoritative pass lands, so there is no reason to compete.
		setTimeout(() => reportStreamToBackground(event.data), 0);
	});
}

function reportStreamToBackground(data) {
	// Two independent payloads ride this one hop. The usage snapshot needs neither a conversation
	// nor CONFIG, and on the free plan it is the only usage the background will ever see, so it must
	// not be lost to the token count's preconditions - hence those guards moved inside.
	const sseLimits = parseSseLimits(data.messageLimit);

	// CONFIG arrives asynchronously at boot; without it the multiplier is unknown, and a count that
	// silently omits it would read ~17% low. With no conversation there is nothing to attach an
	// estimate to either. A refused send is skipped outright: it generated no reply and created no
	// message, so pricing its empty text would add the prompt to a conversation that never grew.
	let counted = null;
	if (!data.rejected && data.conversationId && CONFIG) {
		try {
			counted = countAssistantTokens(data.assistantText);
		} catch (error) {
			Log('warn', 'SSE token count failed:', error);
		}
	}

	if (!sseLimits && !counted) return;

	sendBackgroundMessage({
		type: 'reportStreamCompletion',
		conversationId: data.conversationId,
		isRetry: !!data.isRetry,
		sseLimits,
		// null rather than 0, so the handler can tell "no reply to price" from "an empty reply".
		assistantTokens: counted ? counted.tokens : null,
		unreliable: !!data.sawNonTextBlock || !!counted?.truncated,
		assistantUuid: data.assistantUuid || null,
		parentUuid: data.parentUuid || null
	}).catch(error => Log('warn', 'Failed to report stream completion:', error));
}

initSseBridge();
