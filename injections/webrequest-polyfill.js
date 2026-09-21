(function () {
	// Get patterns from the script element's data attribute
	const script = document.currentScript;
	const patterns = JSON.parse(script.dataset.patterns);

	if (!patterns) return;

	const originalFetch = window.fetch;

	// The background expects `raw[0].bytes` to be plain text (it crosses sendMessage), so every
	// body type is normalised to a string here. claude.ai gzips the completion upload itself
	// before calling fetch (Content-Encoding: gzip), so a binary body is sniffed and inflated
	// page-side. DecompressionStream only knows gzip/deflate; br or zstd would need a JS
	// decompressor instead.
	async function getBodyDetails(body) {
		if (!body) return null;

		try {
			let text;
			if (typeof body === 'string') {
				text = body;
			} else if (body instanceof FormData) {
				text = Array.from(body.entries())
					.map(entry => entry[0] + '=' + entry[1])
					.join('&');
			} else if (body instanceof URLSearchParams) {
				text = body.toString();
			} else if (body instanceof Blob || body instanceof ArrayBuffer ||
				ArrayBuffer.isView(body) || body instanceof ReadableStream) {
				let bytes = new Uint8Array(await new Response(body).arrayBuffer());
				if (isGzip(bytes)) bytes = await gunzip(bytes);
				text = new TextDecoder().decode(bytes);
			} else {
				text = JSON.stringify(body);
			}
			return { raw: [{ bytes: text }], fromMonkeypatch: true };
		} catch (e) {
			console.error('Failed to serialize body:', e);
			return null;
		}
	}

	function isGzip(bytes) {
		return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	}

	async function gunzip(bytes) {
		const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	window.fetch = async (...args) => {
		const [input, config] = args;

		let url;
		if (input instanceof URL) {
			url = input.href;
		} else if (typeof input === 'string') {
			url = input;
		} else if (input instanceof Request) {
			url = input.url;
		}
		if (url.startsWith('/')) {
			url = 'https://claude.ai' + url;
		}

		// Only intercepted requests get their body read. Materialising a Blob or stream is a full
		// read of the payload before the real request can go out - not a cost to pay on every
		// unrelated fetch (file uploads in particular).
		const intercepted = patterns.onBeforeRequest.regexes.some(pattern => new RegExp(pattern).test(url));
		let body = null;
		if (intercepted) {
			body = config?.body;
			// A stream body can only be read once. Tee it so the real request still gets an
			// unconsumed copy; everything else can be read without affecting the original.
			if (body instanceof ReadableStream) {
				const [forApp, forUs] = body.tee();
				args[1] = { ...config, body: forApp };
				body = forUs;
			}
		}

		const details = {
			url: url,
			method: config?.method || 'GET',
			requestBody: await getBodyDetails(body)
		};

		if (intercepted) {
			window.dispatchEvent(new CustomEvent('interceptedRequest', { detail: details }));
		}

		const response = await originalFetch(...args);

		if (patterns.onCompleted.regexes.some(pattern => new RegExp(pattern).test(url))) {
			window.dispatchEvent(new CustomEvent('interceptedResponse', {
				detail: {
					...details,
					status: response.status,
					statusText: response.statusText
				}
			}));
		}

		return response;
	};
})();