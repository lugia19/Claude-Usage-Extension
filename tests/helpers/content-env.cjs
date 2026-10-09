'use strict';

// A jsdom page that runs the extension's real content scripts, in the order manifest_chrome.json
// loads them, so a test drives the same UsageUI / LengthUI / LayoutManager code claude.ai gets.
//
// What is faked, and why:
//   - the browser extension APIs (browser/chrome/ClaudeExtBridge): there is no background here
//   - the logger: replaced by a recorder so a test can assert on what was logged
//   - the clock: a test can advance Date.now() without waiting
//   - requestAnimationFrame: a manual queue, so a test decides when a "frame" happens (a hidden tab
//     is simply a test that doesn't call frame())
//   - the tokenizer: only the stream bridge uses it, and no test here sends a stream
//
// Needs `common/` (git submodule update --init) and `node scripts/build-dataclasses.js` first.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const CONVERSATION_ID = '11111111-2222-3333-4444-555555555555';

// The isolated-world scripts, straight from the manifest, minus the ones replaced by fakes above.
const FAKED = new Set(['lib/browser-polyfill.min.js', 'lib/o200k_base.js', 'common/log/logger.js']);
function contentScriptFiles() {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest_chrome.json'), 'utf8'));
	const group = manifest.content_scripts.find(g => g.js.includes('content-components/usage_ui.js'));
	return group.js.filter(file => !FAKED.has(file));
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// The composer getChatAreaRegularAnchor() resolves against.
const COMPOSER = `
	<div class="bg-surface-3"><div class="relative w-full min-w-0"><div data-testid="chat-input"></div></div></div>
	<button data-testid="model-selector-dropdown" aria-label="Model: Sonnet 5 · High">Sonnet 5</button>`;

// The sidebar markup getSidebarRegularAnchor() resolves against on the web layouts.
const WEB_SIDEBAR = `
	<nav class="flex">
		<div class="flex flex-grow flex-col overflow-y-auto">
			<div class="flex-1 relative"><div class="px-2 mt-4"><div class="flex flex-col mb-4"></div><ul id="recents"></ul></div></div>
		</div>
	</nav>`;

// The same nav with its scroll wrapper present but holding none of the `.flex-1.relative` blocks the
// anchor looks for: what the DOM is mid-render, or after claude.ai renames those classes.
const WEB_SIDEBAR_EMPTY_WRAPPER = `
	<nav class="flex">
		<div class="flex flex-grow flex-col overflow-y-auto"></div>
	</nav>`;

function createEnv({ path: urlPath = `/chat/${CONVERSATION_ID}`, sidebar = WEB_SIDEBAR, load = true } = {}) {
	const dom = new JSDOM(`<!doctype html><html><head></head><body><div id="sidebar-host">${sidebar}</div><main>${COMPOSER}</main></body></html>`, {
		url: `https://claude.ai${urlPath}`,
		runScripts: 'outside-only',
	});
	const { window } = dom;
	const context = dom.getInternalVMContext();

	const logs = [];
	// What the browser console would show as "Uncaught (in promise)".
	const uncaught = [];
	const record = (level, args) => logs.push({ level, text: args.map(a => (a instanceof Error ? a.message : String(a))).join(' ') });
	const rafQueue = [];
	let rafId = 0;
	let time = 0;

	const noEvent = { addListener() { }, removeListener() { } };
	const storageArea = { get: async () => ({}), set: async () => { }, remove: async () => { } };
	window.browser = window.chrome = {
		runtime: { id: 'test', onMessage: noEvent, getURL: file => `chrome-extension://test/${file}`, sendMessage: async () => { }, getManifest: () => ({ version: '0.0.0' }) },
		storage: { local: storageArea, onChanged: noEvent },
	};
	window.ClaudeExtBridge = { sendBackgroundMessage: async (_ns, message) => (message.type === 'isElectron' ? false : undefined) };
	window.GPTTokenizer_o200k_base = { countTokens: () => 0 };
	window.configureLogger = () => { };
	window.createLogger = () => {
		const log = (...args) => record(['debug', 'warn', 'error'].includes(args[0]) ? args.shift() : 'debug', args);
		log.debug = (...args) => record('debug', args);
		log.warn = (...args) => record('warn', args);
		log.error = (...args) => record('error', args);
		return log;
	};
	// A desktop pointer: isMobileLayout() (common/ui/components.js) reads matchMedia, which jsdom lacks.
	window.matchMedia = () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
	window.requestAnimationFrame = (callback) => { rafQueue.push(callback); return ++rafId; };
	// initExtension() would talk to a background that doesn't exist; the tests drive the UI actors directly.
	window.claudeTrackerInstance = true;
	// Cookie initExtension()/getActiveOrgId() read.
	window.document.cookie = 'lastActiveOrg=org-1';

	const run = (code, filename) => vm.runInContext(code, context, { filename });

	// Date.now() as the page sees it, plus an offset a test can advance (for "missing for N seconds").
	window.__clockOffset = 0;
	run('{ const realNow = Date.now; Date.now = () => realNow() + window.__clockOffset; }', 'test-clock');

	const env = {
		window,
		document: window.document,
		logs,
		uncaught,
		run,
		// What claude.ai's React does to the sidebar on a re-render: the old subtree is thrown away.
		replaceSidebar(markup) { window.document.getElementById('sidebar-host').innerHTML = markup; },
		flush,
		// One animation frame, `ms` after the previous one. Resolves once the callbacks (and anything
		// they awaited) have settled.
		async frame(ms = 1000) {
			time += ms;
			const callbacks = rafQueue.splice(0);
			for (const callback of callbacks) {
				const result = callback(time);
				if (result?.catch) result.catch(error => uncaught.push(error));
			}
			await flush();
			await flush();
		},
		pendingFrames: () => rafQueue.length,
		advanceClock(ms) { window.__clockOffset += ms; },
		logsAt: level => logs.filter(entry => entry.level === level).map(entry => entry.text),
		setConfig() {
			run(`CONFIG = {
				ESTIMATED_CAPS: {}, WARNING_THRESHOLD: 0.9, PEAK_SESSION_MULTIPLIER: 1, MODEL_VERSION_MAP: {},
				WARNING: { PERCENT_THRESHOLD: 0.9 }, SSE_SAME_WINDOW_TOLERANCE_MS: 1000,
			}`, 'test-config');
		},
	};

	if (load) {
		for (const file of contentScriptFiles()) {
			run(fs.readFileSync(path.join(ROOT, file), 'utf8'), file);
		}
	}
	return env;
}

module.exports = { createEnv, WEB_SIDEBAR, WEB_SIDEBAR_EMPTY_WRAPPER, CONVERSATION_ID };
