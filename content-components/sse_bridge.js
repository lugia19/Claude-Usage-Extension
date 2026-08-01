/* global Log, getActiveOrgId */
'use strict';

// Bridges the session usage that injections/usage-sse-watcher.js reads out of the completion
// stream (page world) to the UI actors, which overwrite that one field on the usage data they
// already hold. The background is deliberately not involved: it has no state the actors don't,
// and its authoritative update follows about a second later anyway.
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
// Only the 5h window is taken. `7d` moves by a fraction of a percent per message, and `7d_oi` is
// the weekly scoped to whichever model served the request - which model that is differs per
// account, and the stream never says - so both are left to the full fetch.
function parseSseSessionLimit(messageLimit) {
	const session = messageLimit?.windows?.['5h'];
	if (!session || typeof session.utilization !== 'number' || !session.resets_at) return null;
	return {
		percentage: Math.round(session.utilization * 100),
		resetsAt: session.resets_at * 1000
	};
}

// Session usage only ever rises within a window, so a lower number from the stream is noise: both
// sides quantise a fractional utilization to whole percent independently, and the stream's figure
// is taken a moment before the accounting settles, so they can disagree by one. Observed live as
// 37% -> 36% -> 37%, the bar ticking backwards for the ~3s until the full fetch corrected it.
// A genuine reset does drop the number, and that always comes with a new reset timestamp.
const SSE_SAME_WINDOW_TOLERANCE_MS = 60 * 1000;

function shouldApplySseSession(current, incoming) {
	if (!current) return true;
	const sameWindow = Math.abs((current.resetsAt || 0) - incoming.resetsAt) < SSE_SAME_WINDOW_TOLERANCE_MS;
	return !sameWindow || incoming.percentage > current.percentage;
}

function initSseBridge() {
	window.addEventListener('message', (event) => {
		if (event.source !== window || event.origin !== window.location.origin) return;
		if (event.data?.type !== 'claudeUsageTrackerSSE') return;

		// The stream came from this tab, so it is this tab's org unless the user switched orgs
		// mid-generation. Cheap to rule out.
		const myOrgId = getActiveOrgId();
		if (event.data.streamOrgId && myOrgId && event.data.streamOrgId !== myOrgId) return;

		const session = parseSseSessionLimit(event.data.messageLimit);
		if (!session) return;

		Log('SSE session usage:', session.percentage + '%');
		for (const listener of ssePartialUsageListeners) {
			try {
				listener({ session });
			} catch (error) {
				Log('warn', 'SSE partial usage listener failed:', error);
			}
		}
	});
}

initSseBridge();
