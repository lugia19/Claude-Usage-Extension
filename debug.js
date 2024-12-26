// debug.js
let autoRefreshInterval;

document.getElementById('refresh').addEventListener('click', showLogs);
document.getElementById('clear').addEventListener('click', clearLogs);
document.getElementById('enableDebug').addEventListener('click', toggleDebugMode);

function showLogs() {
	browser.storage.local.get('debug_logs')
		.then(result => {
			const logs = result.debug_logs || [];
			const preElement = document.getElementById('logs');

			preElement.innerHTML = '';

			logs.forEach(log => {
				const logLine = document.createElement('div');
				logLine.className = 'log-line';

				const timestamp = document.createElement('span');
				timestamp.className = 'log-timestamp';
				timestamp.textContent = log.timestamp;

				const sender = document.createElement('span');
				sender.className = 'log-sender';
				sender.dataset.sender = log.sender; // Add data attribute for CSS targeting
				sender.textContent = log.sender;

				const message = document.createElement('span');
				message.className = 'log-message';
				message.textContent = log.message;

				logLine.appendChild(timestamp);
				logLine.appendChild(sender);
				logLine.appendChild(message);
				preElement.appendChild(logLine);
			});

			scrollToBottom();
		});
}

function scrollToBottom() {
	const preElement = document.getElementById('logs');
	preElement.scrollTop = preElement.scrollHeight;
}

function clearLogs() {
	browser.storage.local.set({ debug_logs: [] })
		.then(showLogs);
}

function updateDebugStatus() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;
			const timeLeft = isEnabled ? Math.ceil((debugUntil - now) / 60000) : 0;

			// Update status text
			const statusElement = document.getElementById('debugStatus');
			statusElement.textContent = isEnabled
				? `Debug mode enabled (${timeLeft} minutes remaining)`
				: 'Debug mode disabled';

			// Update button text and onclick handler
			const debugButton = document.getElementById('enableDebug');
			debugButton.textContent = isEnabled ? 'Disable Debug Mode' : 'Enable Debug Mode (1 hour)';

			if (!isEnabled && autoRefreshInterval) {
				stopAutoRefresh();
			} else if (isEnabled && !autoRefreshInterval) {
				startAutoRefresh();
			}
		});
}

function toggleDebugMode() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;

			if (isEnabled) {
				// Disable debug mode by setting timestamp to now (expired)
				return browser.storage.local.set({ debug_mode_until: now });
			} else {
				// Enable debug mode for 1 hour
				const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).getTime();
				return browser.storage.local.set({ debug_mode_until: oneHourFromNow });
			}
		})
		.then(() => {
			updateDebugStatus();
		});
}

function startAutoRefresh() {
	if (!autoRefreshInterval) {
		autoRefreshInterval = setInterval(() => {
			showLogs();
			updateDebugStatus();
		}, 5000);
	}
}

function stopAutoRefresh() {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval);
		autoRefreshInterval = null;
	}
}

// Initial setup
showLogs();
updateDebugStatus();
startAutoRefresh();

// Clean up when the page is closed
window.addEventListener('beforeunload', stopAutoRefresh);
