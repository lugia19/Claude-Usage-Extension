// Reads the session usage percentage out of the completion SSE stream so the bars can move as soon
// as generation finishes, instead of waiting for the page's post-stream conversation GET and the
// background's own /usage round-trips (roughly 0.8-2s later).
//
// Runs in the page world (MAIN): MV3 webRequest cannot read response bodies, so this is the only
// place the stream is reachable. Display only - the background's full fetch stays authoritative and
// arrives shortly after with everything else (conversation length, cost, notifications).
(function () {
	'use strict';

	const COMPLETION_RE = /^https?:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/[^/]+\/(?:retry_)?completion$/;

	// Cheap reject before JSON.parse - this runs on every record of every completion stream.
	const INTERESTING_RE = /"type":\s*"message_limit"/;

	// Claude-Toolbox patches window.fetch on this same page (several times over). Chain onto
	// whatever is already installed rather than calling window.fetch, or we recurse.
	const prevFetch = window.fetch;

	window.fetch = async function (...args) {
		const response = await prevFetch.apply(this, args);

		let match;
		try {
			const input = args[0];
			let url = input instanceof Request ? input.url
				: input instanceof URL ? input.href
					: String(input ?? '');
			if (url.startsWith('/')) url = 'https://claude.ai' + url;
			match = COMPLETION_RE.exec(url.split('?')[0]);
		} catch (e) {
			return response;
		}
		if (!match) return response;

		// Kill-switch, mirroring Claude-Toolbox's convention: teeing the completion body can make
		// the renderer receive data in bursts, so leave a way to A/B it without a rebuild.
		try {
			if (localStorage.getItem('claude_usage_sse_off') === '1') return response;
		} catch (e) { /* storage blocked - carry on */ }

		if (!response.body || !response.headers.get('content-type')?.includes('event-stream')) {
			return response;
		}

		// Detached: never awaited, and a failure in here can never touch the response the page reads.
		pump(response.clone(), match[1]);
		return response;
	};

	async function pump(clone, orgId) {
		const reader = clone.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		const handle = (raw) => {
			if (!INTERESTING_RE.test(raw)) return;
			for (const line of raw.split('\n')) {
				if (!line.startsWith('data:')) continue;
				let evt;
				try {
					evt = JSON.parse(line.slice(5).trim());
				} catch (e) {
					continue;
				}
				if (evt?.type !== 'message_limit' || !evt.message_limit) continue;
				// postMessage rather than a CustomEvent: structured clone crosses Firefox's
				// page->content Xray boundary without needing cloneInto.
				window.postMessage({
					type: 'claudeUsageTrackerSSE',
					streamOrgId: orgId,
					messageLimit: evt.message_limit
				}, window.location.origin);
			}
		};

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					buffer += decoder.decode();
					if (buffer.trim()) handle(buffer);
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				// SSE records are separated by a blank line. Splitting per read instead would drop
				// any record straddling a chunk boundary.
				let boundary;
				while ((boundary = buffer.indexOf('\n\n')) !== -1) {
					handle(buffer.slice(0, boundary));
					buffer = buffer.slice(boundary + 2);
				}
			}
		} catch (e) {
			// Aborted or errored stream - the page has its own copy, nothing to recover here.
		}
	}
})();
