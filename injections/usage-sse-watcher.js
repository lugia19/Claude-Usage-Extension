// Reads the session usage percentage AND the reply text out of the completion SSE stream, so the
// usage bars, conversation length and next-message cost can all move as soon as generation
// finishes, instead of waiting for the page's post-stream conversation GET and the background's
// own round-trips (roughly 0.8-2s later).
//
// Runs in the page world (MAIN): MV3 webRequest cannot read response bodies, so this is the only
// place the stream is reachable. Display only - the background's full fetch stays authoritative and
// arrives shortly after with everything else (notifications, feature costs, project tokens).
//
// Emits exactly one `claudeUsageTrackerStream` postMessage per completion, once the stream ends
// (whether it ended cleanly or the user stopped generation). content-components/sse_bridge.js is
// the only consumer; it counts the reply's tokens in-page so the text itself never leaves the
// page world.
//
// ---------------------------------------------------------------------------------------------
// Stream format, as observed 2026-08-20 (claude-fable-5, Max plan), by teeing the body in the
// page world. This is not a documented API - re-verify before relying on any of it.
//
// POST /api/organizations/<org>/chat_conversations/<convo>/completion  (also retry_completion),
// Content-Type: text/event-stream. Records are an `event:` line, then a `data:` line holding the
// JSON, then a blank line closing the record. The JSON is right-padded with a variable run of
// spaces before its closing brace - valid JSON, but it means record byte lengths are not stable
// and nothing may key off them.
//
// Event order (first message of a new conversation; a follow-up is identical minus the first):
//   conversation_ready   {type}                       - new conversations only
//   message_start        {type, message:{...}, discarded_parent_message_uuid}
//   content_block_start  {type, index, content_block:{type:"thinking", summaries, cut_off, ...}}
//   content_block_delta  {type, index, delta:{type:"thinking_summary_delta", summary:{summary}}}
//   content_block_stop   {type, index, stop_timestamp}
//   content_block_start  {type, index, content_block:{type:"text", text:"", citations, ...}}
//   content_block_delta  {type, index, delta:{type:"text_delta", text}}
//   content_block_stop   {type, index, stop_timestamp}
//   message_delta        {type, delta:{stop_reason, stop_sequence, stop_details}}
//   message_limit        {type, message_limit:{...}}  - payload documented in sse_bridge.js
//   message_stop         {type}
//
// The thinking block is emitted even when the model does no visible thinking (start immediately
// followed by stop, no delta).
//
// message_start.message carries:
//   uuid         - the assistant message about to be generated
//   parent_uuid  - the human message it answers, i.e. the one just sent
//   model        - authoritative model slug for this response ("claude-fable-5"). Available here
//                  before the conversation record has one, which is the lag applyPendingModel()
//                  in background.js currently works around using the captured request body.
//   id, request_id, trace_id - server-side ids, no local use
//
// What the stream does NOT carry - the constraint on deriving length/cost from it:
//   * No token counts, anywhere. The public Anthropic API puts `usage` (input_tokens,
//     cache_read_input_tokens, output_tokens) on message_start/message_delta; claude.ai strips it
//     out. Anything derived from this stream has to be tokenized locally.
//   * No raw thinking text. The thinking block only ever produces `thinking_summary_delta`, a
//     short human-readable summary of what was thought about - not the tokens that were billed.
//     This is NOT a gap the stream introduces: the conversation API is blinder still. Fetched
//     with rendering_mode=messages it returns only `text` blocks for an assistant message that
//     demonstrably thought - no thinking block at all, not even the summary (verified
//     2026-08-20). Thinking tokens are simply never exposed anywhere, so every length/cost
//     number this extension reports already excludes them. The stream is no worse off, and is
//     the only place that even hints thinking happened.
//   * No cache information. Whether this prompt hit the cache, and how much of it did, is never
//     reported; it still has to be inferred from message timestamps (getCachingInfo).
//
// Delivery is bursty, not token-by-token: an entire short response can arrive as a single
// text_delta. Do not assume deltas are small or numerous.
// ---------------------------------------------------------------------------------------------
(function () {
	'use strict';

	const COMPLETION_RE = /^https?:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/(retry_)?completion$/;

	// Cheap reject before JSON.parse - this runs on every record of every completion stream, and
	// a long reply is thousands of records on the page's main thread. Records that pass are
	// stashed as raw strings and parsed once at the end, so no parsing happens during streaming.
	const INTERESTING_RE = /"(?:message_limit|message_start|content_block_start|text_delta|input_json_delta|message_stop)"/;

	// A runaway reply must not pin unbounded memory in the page. Past this we stop accumulating
	// and mark the result unreliable rather than truncating silently.
	const MAX_BUFFERED_CHARS = 2 * 1024 * 1024;

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
			// A send refused for hitting the limit answers with JSON, not a stream. It still reports
			// usage, and on the free plan it is the last report we will ever get for that window.
			if (!response.ok) reportRejection(response.clone(), match[1], match[2], !!match[3]);
			return response;
		}

		// Detached: never awaited, and a failure in here can never touch the response the page reads.
		pump(response.clone(), match[1], match[2], !!match[3]);
		return response;
	};

	// The refusal carries the same message_limit payload a stream would have, one level deeper and
	// double-encoded: { error: { message: "<JSON string>" } }. Observed 2026-08-22, free plan, 5h
	// exceeded:
	//
	//   {"type":"exceeded_limit","resetsAt":1787417400,"representativeClaim":"five_hour",
	//    "windows":{"5h":{"status":"exceeded_limit","resets_at":1787417400,"utilization":0.98,
	//                     "surpassed_threshold":1.0},
	//               "7d":{"status":"within_limit","resets_at":1787860800,"utilization":0.04}},
	//    "resolved":{"status":"exceeded","limit":{"kind":"session","percent":98,
	//                "severity":"critical","resets_at":"2026-08-22T16:50:00+00:00"},
	//                "notice":{"title":"Limit reached",...}}}
	//
	// Note utilization is 0.98, NOT 1.0 - the cap binds before the fraction reaches one, so `status`
	// is the only reliable "you are out" signal. parseSseWindow in sse_bridge.js clamps on it.
	//
	// Without this the free plan goes blind at exactly the wrong moment: /usage reports nothing, the
	// last stream we saw was the previous (accepted) message, and the bars would sit just under the
	// cap until the window rolls over. Only the FIRST refused send produces this - after it,
	// claude.ai blocks the composer and issues no request at all.
	async function reportRejection(clone, orgId, conversationId, isRetry) {
		let messageLimit = null;
		try {
			const body = await clone.json();
			const inner = body?.error?.message;
			messageLimit = typeof inner === 'string' ? JSON.parse(inner) : inner || null;
		} catch (e) {
			return;
		}
		if (!messageLimit?.windows) return;

		window.postMessage({
			type: 'claudeUsageTrackerStream',
			streamOrgId: orgId,
			conversationId,
			isRetry,
			messageLimit,
			// No reply was generated and no message was created, so there is nothing to price. The
			// flag is what stops sse_bridge counting an empty assistantText as a real 0-token reply
			// and charging the prompt to the conversation's length.
			rejected: true,
			assistantText: '',
			sawNonTextBlock: false,
			assistantUuid: null,
			parentUuid: null,
			model: null
		}, window.location.origin);
	}

	async function pump(clone, orgId, conversationId, isRetry) {
		const reader = clone.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		// Records are kept as raw strings and parsed once the stream is done. Parsing as they
		// arrive would put thousands of JSON.parse calls on the page's main thread while the
		// renderer is painting the reply, which is exactly the stutter this file warns about.
		const records = [];
		let buffered = 0;
		let overflowed = false;

		const collect = (raw) => {
			if (!INTERESTING_RE.test(raw)) return;
			if (buffered > MAX_BUFFERED_CHARS) {
				overflowed = true;
				return;
			}
			buffered += raw.length;
			records.push(raw);
		};

		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					buffer += decoder.decode();
					if (buffer.trim()) collect(buffer);
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				// SSE records are separated by a blank line. Splitting per read instead would drop
				// any record straddling a chunk boundary.
				let boundary;
				while ((boundary = buffer.indexOf('\n\n')) !== -1) {
					collect(buffer.slice(0, boundary));
					buffer = buffer.slice(boundary + 2);
				}
			}
		} catch (e) {
			// Aborted or errored stream. Whatever was collected still describes real billed usage,
			// so fall through and report it rather than dropping the update - stopping generation
			// must not cost the user their session-usage refresh.
		}

		let payload;
		try {
			payload = buildPayload(records, orgId, conversationId, isRetry, overflowed);
		} catch (e) {
			return;
		}
		// postMessage rather than a CustomEvent: structured clone crosses Firefox's page->content
		// Xray boundary without needing cloneInto.
		window.postMessage(payload, window.location.origin);
	}

	// Parses the buffered records into the one payload the content script consumes. Runs after the
	// stream has ended, so cost here is off the critical path.
	function buildPayload(records, orgId, conversationId, isRetry, overflowed) {
		let messageLimit = null;
		let assistantText = '';
		let sawNonTextBlock = false;
		let assistantUuid = null;
		let parentUuid = null;
		let model = null;

		for (const raw of records) {
			for (const line of raw.split('\n')) {
				if (!line.startsWith('data:')) continue;
				let evt;
				try {
					evt = JSON.parse(line.slice(5).trim());
				} catch (e) {
					continue;
				}

				if (evt?.type === 'message_limit') {
					if (evt.message_limit) messageLimit = evt.message_limit;
				} else if (evt?.type === 'message_start') {
					assistantUuid = evt.message?.uuid || null;
					parentUuid = evt.message?.parent_uuid || null;
					model = evt.message?.model || null;
				} else if (evt?.type === 'content_block_start') {
					const block = evt.content_block;
					// Thinking is excluded deliberately: the stream only ever carries a summary of
					// it, never the billed tokens. That matches the background, whose
					// getTextContent(false) also leaves thinking out of the message token count.
					if (block?.type !== 'text' && block?.type !== 'thinking') sawNonTextBlock = true;
					if (block?.text) assistantText += block.text;
					if (block?.input) assistantText += JSON.stringify(block.input);
				} else if (evt?.type === 'content_block_delta') {
					const delta = evt.delta;
					if (delta?.type === 'text_delta' && delta.text) {
						assistantText += delta.text;
					} else if (delta?.type === 'input_json_delta' && delta.partial_json) {
						// Artifacts and tool calls stream their whole body as partial JSON rather
						// than text. The background counts JSON.stringify(content.input) for those
						// (getTextFromContent in tokenManagement.js), so ignoring them here would
						// undercount an artifact by its entire length.
						assistantText += delta.partial_json;
					}
				}
			}
		}

		return {
			type: 'claudeUsageTrackerStream',
			streamOrgId: orgId,
			conversationId,
			isRetry,
			messageLimit,
			assistantText,
			// Anything the local count can't model faithfully makes the result an estimate.
			sawNonTextBlock: sawNonTextBlock || overflowed,
			assistantUuid,
			parentUuid,
			model
		};
	}
})();
