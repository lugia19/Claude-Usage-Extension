// Tells the background which claude.ai requests the page makes, on every platform. Runs in the page
// world (MAIN, document_start, after common/net/net.js) and chains onto window.fetch: webRequest
// can't read what the merged experience sends (binary protobuf) or streams back.
//
// Each matching request is posted to the window as { type: 'claudeUsageTrackerRequest', message },
// and content-components/request_relay.js forwards `message` to the background as is:
//   interceptedRequest   before the request goes out (onBeforeRequestHandler); the completion POSTs
//                        carry their parsed JSON body as `requestBody`
//   interceptedResponse  once the response's headers are in (onCompletedHandler). The background
//                        refetches whatever it needs, so the body is never read or waited for.
// Page scripts can post the same message; the background only treats it as a cue to refetch from
// claude.ai itself, so a forged one costs at most an extra refresh.
//
// The kill switch (localStorage claude_usage_requests_off = '1') turns off ALL request tracking:
// this is the only transport.
(function () {
	'use strict';

	const net = ClaudeExtNet; // common/net/net.js, loaded before this file

	const PREFIX = /^https?:\/\/claude\.ai\/(api|v1)\//;
	// What onBeforeRequestHandler looks at, besides the completion POSTs (net.isCompletionUrl).
	const BEFORE = [
		/\/api\/settings\/billing/,
		/\/api\/account_profile$/,
		/\/api\/account\/settings/,
	];
	// What onCompletedHandler looks at: the conversation tree GET, a branch switch, and Claude Code
	// session events.
	const COMPLETED = [
		/\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+$/,
		/\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/current_leaf_message_uuid$/,
		/\/v1\/sessions\/[^/]+\/events$/,
	];

	function post(type, details) {
		// postMessage rather than a CustomEvent: structured clone crosses Firefox's page->content
		// Xray boundary without needing cloneInto.
		window.postMessage({ type: 'claudeUsageTrackerRequest', message: { type, details } }, window.location.origin);
	}

	// Claude-Toolbox patches window.fetch on this same page too. Chain onto whatever is installed
	// rather than calling window.fetch, or we recurse. Not async: an unmatched fetch is handed
	// straight through without an extra promise.
	const prevFetch = window.fetch;

	window.fetch = function (...args) {
		let url, path;
		try {
			url = net.getFetchUrl(args[0]);
			path = url.split('?', 1)[0];
		} catch (e) {
			return prevFetch.apply(this, args);
		}
		if (!PREFIX.test(path)) return prevFetch.apply(this, args);
		const completion = net.isCompletionUrl(path, { retry: true });
		const before = completion || BEFORE.some(re => re.test(path));
		const completed = !before && COMPLETED.some(re => re.test(path));
		if ((!before && !completed) || net.isKillSwitchOn('claude_usage_requests_off')) return prevFetch.apply(this, args);

		const method = net.getFetchMethod(args[0], args[1]);
		if (before) {
			let readBody = Promise.resolve(null);
			if (completion && args[1]?.body != null) {
				let init = args[1];
				// A stream body can only be read once: tee it so the real request gets an unread copy.
				if (init.body instanceof ReadableStream) {
					const [forPage, forUs] = init.body.tee();
					args[1] = { ...init, body: forPage };
					init = { ...init, body: forUs };
				}
				readBody = net.readJsonRequestBody(init).catch(() => null);
			}
			// Not awaited: reading (and inflating) the body must not hold up the real request.
			readBody.then(requestBody => post('interceptedRequest', { url, method, requestBody }));
			return prevFetch.apply(this, args);
		}

		const response = prevFetch.apply(this, args);
		response.then(() => post('interceptedResponse', { url, method }), () => { });
		return response;
	};
})();
