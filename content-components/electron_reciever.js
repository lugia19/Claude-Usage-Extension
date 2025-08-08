'use strict';

// Set up Electron event listeners if we're in Electron
async function initElectronReceiver() {
	const isElectron = await browser.runtime.sendMessage({ type: 'isElectron' });
	if (!isElectron) return;

	console.log('Electron receiver initializing...');

	// Get monkeypatch patterns for request interception
	const patterns = await browser.runtime.sendMessage({
		type: 'getMonkeypatchPatterns'
	});

	if (patterns) {
		setupRequestInterception(patterns);
	}

	// Alarm events from Node
	window.addEventListener('electronAlarmFired', (event) => {
		chrome.runtime.sendMessage({
			type: 'electron-alarm',
			name: event.detail.name
		});
	});

	// Tab activity events from Node
	window.addEventListener('electronTabActivated', (event) => {
		chrome.runtime.sendMessage({
			type: 'electronTabActivated',
			details: event.detail
		});
	});

	window.addEventListener('electronTabDeactivated', (event) => {
		chrome.runtime.sendMessage({
			type: 'electronTabDeactivated',
			details: event.detail
		});
	});

	window.addEventListener('electronTabRemoved', (event) => {
		chrome.runtime.sendMessage({
			type: 'electronTabRemoved',
			details: event.detail
		});
	});

	// Request/Response interception events
	window.addEventListener('interceptedRequest', async (event) => {
		browser.runtime.sendMessage({
			type: 'interceptedRequest',
			details: event.detail
		});
	});

	window.addEventListener('interceptedResponse', async (event) => {
		browser.runtime.sendMessage({
			type: 'interceptedResponse',
			details: event.detail
		});
	});

	console.log('Electron receiver initialized');
}

function setupRequestInterception(patterns) {
	// Inject external request interception script with patterns as data attribute
	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/webrequest-polyfill.js');
	script.dataset.patterns = JSON.stringify(patterns);
	script.onload = function () {
		this.remove();
	};
	(document.head || document.documentElement).appendChild(script);
}

// Initialize
initElectronReceiver();