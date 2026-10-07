// Tells the background which claude.ai requests the page makes, on every platform. Runs in the page
// world (MAIN, document_start, after common/net/net.js and common/ext/bridge.js) and chains onto
// window.fetch: webRequest can't read what the merged experience sends (binary protobuf) or streams
// back.
//
// Each matching request goes to the background through ClaudeExtBridge (relayed by
// content-components/request_relay.js, which allow-lists these two types):
//   interceptedRequest   before the request goes out (onBeforeRequestHandler). A message send, from
//                        /completion or a merged-experience PerformAction, comes as kind: 'send'
//                        with its ids and body (see sendFromCompletion / sendFromPerformAction)
//   interceptedResponse  once the response's headers are in (onCompletedHandler). The background
//                        refetches whatever it needs, so the body is never read or waited for.
// Page scripts can send the same two messages; the background only treats them as a cue to refetch
// from claude.ai itself, so a forged one costs at most an extra refresh.
//
// The kill switch (localStorage claude_usage_requests_off = '1') turns off ALL request tracking:
// this is the only transport.
(function () {
	'use strict';

	const net = ClaudeExtNet; // common/net/net.js, loaded before this file

	const PREFIX = /^https?:\/\/claude\.ai\/(api|v1|claudeai-rpc)\//;
	// A merged-experience send (claude.ai's Connect-RPC API, binary protobuf): decoded here and
	// reported in the completion body's shape, see sendFromPerformAction.
	const PERFORM_ACTION = /\/claudeai-rpc\/anthropic\.bard\.api\.v1alpha\.ConversationService\/PerformAction$/;
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
		ClaudeExtBridge.sendBackgroundMessage('tracker', { type, details }).catch(() => { });
	}

	// The request's headers and a readable copy of its body, leaving the page's own copy unread:
	// fetch(new Request(url, { body })) is read from a clone, a stream body is teed (it can only be
	// read once; args[1] gets the other branch).
	function bodySource(args) {
		const init = args[1];
		if (init?.body == null && args[0] instanceof Request) {
			return { headers: args[0].headers, body: args[0].clone().body };
		}
		if (init?.body instanceof ReadableStream) {
			const [forPage, forUs] = init.body.tee();
			args[1] = { ...init, body: forPage };
			return { ...init, body: forUs };
		}
		return init;
	}

	// A message send, as the background's interceptedRequest reads it, whichever API sent it:
	//   { kind: 'send', orgId, conversationId, isRetry, inheritsModel, requestBody }
	// requestBody has the /completion body's fields. inheritsModel: a missing model means "the
	// conversation's own" (merged sends name it only on a conversation's first message) rather than the
	// legacy "the tier's default".

	// /completion and /retry_completion: the ids are in the URL, the body is JSON.
	async function sendFromCompletion(source, path) {
		const { orgId, conversationId } = net.getApiIds(path);
		const requestBody = source?.body != null ? await net.readJsonRequestBody(source).catch(() => null) : null;
		return { orgId, conversationId, isRetry: path.endsWith('/retry_completion'), inheritsModel: false, requestBody };
	}

	// PerformAction (the merged experience): protobuf. Only send_message is a send; null for every
	// other action (warm_turn, settings, feedback...).
	async function sendFromPerformAction(source) {
		const body = source?.body;
		if (body == null) return null;
		let bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
			: ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
				: new Uint8Array(await new Response(body).arrayBuffer());
		if (net.isGzipRequest(source)) bytes = await net.gunzipBytes(bytes);
		const action = net.decodeBard('PerformActionRequest', bytes);
		const send = action.send_message;
		if (!send) return null;
		return {
			orgId: new Headers(source.headers ?? {}).get('x-organization-uuid'),
			conversationId: action.header?.conversation_id,
			isRetry: send.input_mode === 'INPUT_MODE_RETRY',
			inheritsModel: true,
			requestBody: {
				prompt: send.text,
				model: send.model?.identifier,
				parent_message_uuid: send.parent_message_id,
				turn_message_uuids: { human_message_uuid: send.message_id, assistant_message_uuid: send.assistant_message_id },
				// Only their number reaches the background (it checks whether there are any), not their content.
				attachments: [...(send.attachments ?? []), ...(send.inline_attachments ?? [])].map(() => ({})),
			},
		};
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
		const performAction = PERFORM_ACTION.test(path);
		const before = completion || performAction || BEFORE.some(re => re.test(path));
		const completed = !before && COMPLETED.some(re => re.test(path));
		if ((!before && !completed) || net.isKillSwitchOn('claude_usage_requests_off')) return prevFetch.apply(this, args);

		const method = net.getFetchMethod(args[0], args[1]);
		if (before) {
			const readSend = completion ? sendFromCompletion : performAction ? sendFromPerformAction : null;
			if (readSend) {
				// Not awaited: reading (and decoding) the body must not hold up the real request.
				readSend(bodySource(args), path).then(
					send => { if (send) post('interceptedRequest', { url, method, kind: 'send', ...send }); },
					() => { });
			} else {
				post('interceptedRequest', { url, method });
			}
			return prevFetch.apply(this, args);
		}

		const response = prevFetch.apply(this, args);
		response.then(() => post('interceptedResponse', { url, method }), () => { });
		return response;
	};
})();
