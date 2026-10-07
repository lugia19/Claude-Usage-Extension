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
//   turnSettled          a merged-experience turn ended on the page's StreamTimeline (onTurnSettled),
//                        see watchTimeline
// Page scripts can send the same messages; the background only treats them as a cue to refetch from
// claude.ai itself, so a forged one costs at most an extra refresh.
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
	// The merged experience's timeline stream, where its turns are seen to end: see watchTimeline.
	const STREAM_TIMELINE = /\/claudeai-rpc\/anthropic\.bard\.api\.v1alpha\.ConversationService\/StreamTimeline$/;
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

	// A request body as bytes (a Connect body is usually already a Uint8Array: no copy then), inflated
	// if the page gzipped it. Null without a body.
	async function bodyBytes(source) {
		const body = source?.body;
		if (body == null) return null;
		let bytes = body instanceof ArrayBuffer ? new Uint8Array(body)
			: ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
				: new Uint8Array(await new Response(body).arrayBuffer());
		if (net.isGzipRequest(source)) bytes = await net.gunzipBytes(bytes);
		return bytes;
	}

	// PerformAction (the merged experience): protobuf. Only send_message is a send; null for every
	// other action (warm_turn, settings, feedback...).
	async function sendFromPerformAction(source) {
		const bytes = await bodyBytes(source);
		if (!bytes) return null;
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

	// Conversation states a turn is still going in (WAITING_FOR_INPUT is a pause for the user, not an
	// end), and the ones that end it.
	const BUSY = new Set(['STATUS_RUNNING', 'STATUS_RECOVERING', 'STATUS_WAITING_FOR_INPUT']);
	const ENDED = new Set(['STATUS_IDLE', 'STATUS_COMPLETED', 'STATUS_ERROR']);

	// A merged-experience compaction divider: the empty assistant message that lands after the turn's
	// reply, in the same frame as the settle.
	const isDivider = (m) => (m.extras ?? []).some(e => e['@type']?.endsWith('CompactionDivider'));

	// The stream's MessageLimit in the completion SSE's message_limit shape, the one sse_bridge.js
	// parses: same window keys and utilization, resets_at in unix seconds, and the only status it
	// reads under its old name.
	function legacyMessageLimit(limit) {
		const windows = {};
		for (const [key, win] of Object.entries(limit.windows ?? {})) {
			windows[key] = {
				status: win.status === 'MESSAGE_LIMIT_STATUS_EXCEEDED' ? 'exceeded_limit' : win.status,
				resets_at: Date.parse(win.resets_at) / 1000,
				utilization: win.utilization,
			};
		}
		return { windows };
	}

	// The merged experience has no post-message tree GET to trigger the authoritative pass; its turns
	// end on the StreamTimeline the page keeps open (reconnected every few seconds while idle). Reads
	// the page's copy of one such stream and posts turnSettled whenever a turn ends on it: the
	// conversation leaves a busy state for an ended one. The turn's assistant message is the one with
	// the highest index seen since it started; a stream that resumed mid-turn may never see it (resumes
	// send changes only), so it can be missing, and the background then uses the tree's leaf. A
	// compaction divider is skipped: it isn't the turn's reply.
	//
	// The same stream carries the turn's message_limit (usually just before the settle, sometimes
	// mid-turn, never on a stopped turn), which goes to sse_bridge like the completion SSE's.
	async function watchTimeline(response, source) {
		const orgId = new Headers(source?.headers ?? {}).get('x-organization-uuid');
		const bytes = await bodyBytes(source);
		const frame = bytes && net.splitConnectFrames(bytes)[0];
		const conversationId = frame && net.decodeBard('StreamTimelineRequest', frame.payload).conversation_id;
		if (!orgId || !conversationId) {
			response.body?.cancel().catch(() => { }); // or the unread copy keeps buffering the stream
			return;
		}
		let busy = false;
		let assistant = null;
		await net.readConnectFrames(response, (f) => {
			if (f.endStream) return;
			const event = net.decodeBard('StreamTimelineResponse', f.payload).event;
			if (event?.message_limit) {
				window.postMessage({
					type: 'claudeUsageTrackerStream',
					streamOrgId: orgId,
					messageLimit: legacyMessageLimit(event.message_limit),
					usageOnly: true,
				}, window.location.origin);
				return;
			}
			const update = event?.update;
			if (!update) return;
			const status = update.conversation?.status;
			if (BUSY.has(status) && !busy) {
				busy = true;
				assistant = null;
			}
			for (const m of update.messages ?? []) {
				if (m.role === 'ROLE_ASSISTANT' && !isDivider(m) && (!assistant || (m.index ?? 0) >= (assistant.index ?? 0))) assistant = m;
			}
			if (ENDED.has(status) && busy) {
				busy = false;
				post('turnSettled', { orgId, conversationId, assistantMessageId: assistant?.id ?? null, stopReason: assistant?.stop_reason ?? null });
			}
		});
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
		const readSend = net.isCompletionUrl(path, { retry: true }) ? sendFromCompletion
			: PERFORM_ACTION.test(path) ? sendFromPerformAction : null;
		const kind = readSend || BEFORE.some(re => re.test(path)) ? 'before'
			: STREAM_TIMELINE.test(path) ? 'timeline'
				: COMPLETED.some(re => re.test(path)) ? 'completed' : null;
		if (!kind || net.isKillSwitchOn('claude_usage_requests_off')) return prevFetch.apply(this, args);

		const method = net.getFetchMethod(args[0], args[1]);
		if (kind === 'before') {
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

		const source = kind === 'timeline' ? bodySource(args) : null; // before the call: it may tee args[1]
		const response = prevFetch.apply(this, args);
		// For the timeline, cloned before the page reads it: this callback was registered first.
		response.then(r => {
			if (kind === 'timeline') watchTimeline(r.clone(), source).catch(() => { });
			else post('interceptedResponse', { url, method });
		}, () => { });
		return response;
	};
})();
