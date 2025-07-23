(function () {
	const originalFetch = window.fetch;

	window.fetch = async function (...args) {
		const response = await originalFetch.apply(this, args);

		if (response.headers.get('content-type')?.includes('event-stream')) {
			const clone = response.clone();
			const reader = clone.body.getReader();
			const decoder = new TextDecoder();

			const readStream = async () => {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					const chunk = decoder.decode(value);
					const lines = chunk.split('\\n');

					for (const line of lines) {
						if (line.startsWith('data:')) {
							const data = line.substring(5).trim();
							try {
								const json = JSON.parse(data);
								if (json.type === 'message_limit' && (json.message_limit?.type === 'exceeded_limit' || json.message_limit?.type === 'approaching_limit')) {
									window.dispatchEvent(new CustomEvent('rateLimitExceeded', {
										detail: json.message_limit
									}));
									// Timestamp is in json.message_limit.resetsAt
								}
							} catch (e) {
								// Not JSON, ignore
							}
						}
					}
				}
			};

			readStream().catch(err => err.name !== 'AbortError' && console.error('Rate limit stream reading error:', err));
		}

		if (response.status === 429) {
			try {
				const clone = response.clone();
				const errorData = await clone.json();

				if (errorData.type === 'error' &&
					errorData.error?.type === 'rate_limit_error' &&
					errorData.error?.message) {

					// Parse the nested JSON message
					try {
						const limitDetails = JSON.parse(errorData.error.message);
						// Dispatch the same event as SSE rate limits
						window.dispatchEvent(new CustomEvent('rateLimitExceeded', {
							detail: limitDetails
						}));
					} catch (e) {
						//Not JSON, ignore
					}
				}
			} catch (error) {
				console.error('Failed to parse 429 rate limit error:', error);
			}
		}

		return response;
	};
})();