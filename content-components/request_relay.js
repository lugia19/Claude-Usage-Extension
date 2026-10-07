'use strict';

// Forwards the requests injections/request-hook.js sees in the page world to the background, where
// interceptedRequest / interceptedResponse hand them to onBeforeRequestHandler / onCompletedHandler.
const RELAYED_REQUEST_TYPES = ['interceptedRequest', 'interceptedResponse'];

window.addEventListener('message', (event) => {
	if (event.source !== window || event.origin !== window.location.origin) return;
	const message = event.data?.type === 'claudeUsageTrackerRequest' ? event.data.message : null;
	if (!RELAYED_REQUEST_TYPES.includes(message?.type) || !message.details) return;
	sendBackgroundMessage({ type: message.type, details: message.details }).catch(() => { });
});
