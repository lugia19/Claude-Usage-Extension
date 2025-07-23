(function () {
	// Get patterns from the script element's data attribute
	const script = document.currentScript;
	const patterns = JSON.parse(script.dataset.patterns);

	if (!patterns) return;

	const originalFetch = window.fetch;

	async function getBodyDetails(body) {
		if (!body) return null;

		// If it's already a string (like JSON), just pass it through
		if (typeof body === 'string') {
			return { raw: [{ bytes: body }], fromMonkeypatch: true };
		}

		// Handle FormData and other complex types
		if (body instanceof FormData) {
			const text = Array.from(body.entries())
				.map(entry => entry[0] + '=' + entry[1])
				.join('&');
			return { raw: [{ bytes: text }], fromMonkeypatch: true };
		}

		// For everything else, try to stringify
		try {
			return { raw: [{ bytes: JSON.stringify(body) }], fromMonkeypatch: true };
		} catch (e) {
			console.error('Failed to serialize body:', e);
			return null;
		}
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

		const details = {
			url: url,
			method: config?.method || 'GET',
			requestBody: config?.body ? await getBodyDetails(config.body) : null
		};

		if (patterns.onBeforeRequest.regexes.some(pattern => new RegExp(pattern).test(url))) {
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