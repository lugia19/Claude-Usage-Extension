'use strict';

// Set up Electron event listeners if we're in Electron
async function initElectronReceiver() {
	const isElectron = await browser.runtime.sendMessage({ type: 'isElectron' });
	if (!isElectron) return;

	console.log('Electron receiver initializing...');

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

	console.log('Electron receiver initialized');
}

// Initialize
initElectronReceiver();