// Headless Chrome harness for checking the extension against the live claude.ai UI.
//
// Runs Chrome on a dedicated, logged-in profile (not the default one: Chrome ignores
// --remote-debugging-port there since 136) with debug\chrome installed unpacked in it, so no
// --load-extension (dropped from branded Chrome in 137) is needed. The same profile can be used
// for interactive debugging; a run while it is open is skipped rather than fought over.
//
//   node scripts/chrome-harness.mjs login   one-time, windowed: log into claude.ai and load
//                                           debug\chrome unpacked (developer mode), then close it
//   node scripts/chrome-harness.mjs smoke   headless: checks the login and that the extension mounts
//
// As a module: `const chrome = await launchChrome(); const page = await chrome.openPage(url);
// await page.evaluate(expr); await chrome.close();`. Run mirror-debug.js first so debug\chrome is current.
//
// Exit codes: 0 ok, 1 check failed, 2 setup problem (no profile, not logged in, no extension),
// 3 skipped because the profile is in use.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Holds the profile, plus the UI checks' config, reports and run stamp (scripts/ui-tests.mjs).
export const HARNESS_DIR = process.env.UT_HARNESS_DIR
	|| path.join(process.env.LOCALAPPDATA || os.homedir(), 'ChromeDebug');
export const PROFILE_DIR = process.env.UT_CHROME_PROFILE || path.join(HARNESS_DIR, 'profile');
export const CHROME_EXE = process.env.UT_CHROME_EXE
	|| 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

export class HarnessError extends Error {
	constructor(code, message) { super(message); this.code = code; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Chrome holds <profile>\lockfile open without sharing while it runs on that profile, so failing
// to open it means another instance owns the profile. Launching anyway would hand our URL to that
// instance (opening a window in it) and exit.
export function profileInUse(dir = PROFILE_DIR) {
	const lock = path.join(dir, 'lockfile');
	if (!fs.existsSync(lock)) return false;
	try {
		fs.closeSync(fs.openSync(lock, 'r+'));
		return false;
	} catch (e) {
		return e.code === 'EBUSY' || e.code === 'EPERM';
	}
}

// The user agent a windowed Chrome of this install sends (reduced form: major version only). The
// install folder holds one directory per installed version, named like 158.0.8127.36.
function normalUserAgent() {
	const dir = path.dirname(CHROME_EXE);
	const versions = fs.readdirSync(dir).filter(n => /^\d+\.\d+\.\d+\.\d+$/.test(n));
	const major = Math.max(...versions.map(v => Number(v.split('.')[0])));
	return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

class Cdp {
	constructor(wsUrl) {
		this.ws = new WebSocket(wsUrl);
		this.nextId = 0;
		this.pending = new Map();
		this.listeners = new Set();
		this.ws.onmessage = e => {
			const msg = JSON.parse(e.data);
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
				else resolve(msg.result);
			} else if (msg.method) {
				for (const l of this.listeners) l(msg);
			}
		};
		this.ready = new Promise((resolve, reject) => {
			this.ws.onopen = resolve;
			this.ws.onerror = () => reject(new Error(`CDP connection to ${wsUrl} failed`));
		});
		// A crashed Chrome or a dropped connection must fail every outstanding command, or callers
		// (waitFor's polling, close()'s kill fallback) wait on them forever.
		this.ws.onclose = () => {
			const err = new Error('CDP connection closed');
			for (const { reject } of this.pending.values()) reject(err);
			this.pending.clear();
		};
	}
	send(method, params = {}, sessionId) {
		if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection closed'));
		const id = ++this.nextId;
		this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}
	waitFor(predicate, timeoutMs) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.listeners.delete(l); reject(new Error('timed out waiting for CDP event')); }, timeoutMs);
			const l = msg => { if (predicate(msg)) { clearTimeout(timer); this.listeners.delete(l); resolve(msg); } };
			this.listeners.add(l);
		});
	}
	close() { this.ws.close(); }
}

class Page {
	constructor(cdp, targetId, sessionId) { Object.assign(this, { cdp, targetId, sessionId }); }
	send(method, params) { return this.cdp.send(method, params, this.sessionId); }

	async navigate(url, { timeoutMs = 30000 } = {}) {
		// Both awaited together, so the load timeout is handled even while Page.navigate is still
		// pending (awaiting the command first left the timeout's rejection unhandled, killing the
		// process before cleanup). The timeout bounds the whole navigation, command included.
		const loaded = this.cdp.waitFor(m => m.sessionId === this.sessionId && m.method === 'Page.loadEventFired', timeoutMs);
		await Promise.all([this.send('Page.navigate', { url }), loaded]);
	}

	// Evaluates an expression (or a function, called with `arg`) in the page's MAIN world.
	async evaluate(fnOrExpr, arg) {
		const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr})(${JSON.stringify(arg)})` : fnOrExpr;
		const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
		return r.result.value;
	}

	// Polls fnOrExpr until it returns something truthy; returns that, or null on timeout.
	async waitFor(fnOrExpr, { timeoutMs = 15000, intervalMs = 250, arg } = {}) {
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			const v = await this.evaluate(fnOrExpr, arg).catch(() => null);
			if (v) return v;
			await sleep(intervalMs);
		}
		return null;
	}

	async screenshot(file) {
		const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
		fs.writeFileSync(file, Buffer.from(data, 'base64'));
	}

	close() { return this.cdp.send('Target.closeTarget', { targetId: this.targetId }); }
}

export async function launchChrome({ headless = true, width = 1600, height = 1000, startUrl } = {}) {
	if (!fs.existsSync(PROFILE_DIR) && headless) {
		throw new HarnessError(2, `No profile at ${PROFILE_DIR}: run "node scripts/chrome-harness.mjs login" first`);
	}
	if (profileInUse()) throw new HarnessError(3, `Profile ${PROFILE_DIR} is in use by another Chrome; skipping`);

	const portFile = path.join(PROFILE_DIR, 'DevToolsActivePort');
	fs.rmSync(portFile, { force: true });

	const args = [
		`--user-data-dir=${PROFILE_DIR}`,
		// Headless Chrome says "HeadlessChrome" in its user agent, which Cloudflare challenges.
		// Set as a flag rather than per page so the extension's background fetches carry it too.
		...(headless ? [`--user-agent=${normalUserAgent()}`] : []),
		'--remote-debugging-port=0',
		'--no-first-run',
		'--no-default-browser-check',
		`--window-size=${width},${height}`,
		...(headless ? ['--headless=new'] : []),
		startUrl || 'about:blank',
	];
	const proc = spawn(CHROME_EXE, args, { stdio: 'ignore' });
	let exited = false;
	proc.on('exit', () => { exited = true; });

	let wsUrl;
	for (let i = 0; i < 100 && !wsUrl; i++) {
		if (exited) throw new HarnessError(2, 'Chrome exited during startup');
		if (fs.existsSync(portFile)) {
			const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
			if (port && wsPath) wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
		}
		if (!wsUrl) await sleep(100);
	}
	if (!wsUrl) { proc.kill(); throw new HarnessError(2, 'Chrome never opened its debugging port'); }

	const cdp = new Cdp(wsUrl);
	await cdp.ready;

	return {
		proc,
		cdp,
		async openPage(url = 'about:blank', opts) {
			const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
			const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
			const page = new Page(cdp, targetId, sessionId);
			await page.send('Page.enable');
			await page.send('Runtime.enable');
			if (url !== 'about:blank') await page.navigate(url, opts);
			return page;
		},
		// Ids of the installed extensions that have a live service worker or background page.
		async extensionTargets() {
			const { targetInfos } = await cdp.send('Target.getTargets');
			return targetInfos.filter(t => t.url.startsWith('chrome-extension://'));
		},
		async close() {
			await cdp.send('Browser.close').catch(() => {});
			cdp.close();
			for (let i = 0; i < 50 && !exited; i++) await sleep(100);
			if (!exited) proc.kill();
		},
	};
}

// ---- CLI ----

async function login() {
	// A plain Chrome, with no debugging port: with one open, Cloudflare's challenge loops forever.
	fs.mkdirSync(PROFILE_DIR, { recursive: true });
	if (profileInUse()) throw new HarnessError(3, `Profile ${PROFILE_DIR} is already open`);
	const proc = spawn(CHROME_EXE, [`--user-data-dir=${PROFILE_DIR}`, '--no-first-run', 'https://claude.ai/login'], { stdio: 'ignore' });
	console.log(`Chrome is open on ${PROFILE_DIR}.`);
	console.log('1. Log into claude.ai.');
	console.log('2. chrome://extensions -> Developer mode -> Load unpacked -> debug\\chrome');
	console.log('3. Close the window. This script exits with it.');
	await new Promise(r => proc.on('exit', r));
}

async function smoke() {
	const chrome = await launchChrome();
	try {
		const page = await chrome.openPage('https://claude.ai/new');
		const ua = await page.evaluate('navigator.userAgent');
		const state = await page.waitFor(() => {
			if (document.title.includes('Just a moment')) return null;
			if (location.pathname.startsWith('/login')) return { loggedIn: false };
			const input = document.querySelector('[data-testid="chat-input"]');
			return input ? { loggedIn: true } : null;
		}, { timeoutMs: 30000 });

		const report = { url: await page.evaluate('location.href'), title: await page.evaluate('document.title'), ua };
		if (!state) {
			await page.screenshot(path.join(os.tmpdir(), 'ut-smoke.png'));
			throw new HarnessError(2, `claude.ai never showed a composer (Cloudflare challenge?) ${JSON.stringify(report)}; screenshot at ${path.join(os.tmpdir(), 'ut-smoke.png')}`);
		}
		if (!state.loggedIn) throw new HarnessError(2, `Not logged in: run the login step. ${JSON.stringify(report)}`);

		const mounted = await page.waitFor(() => !!document.querySelector('.ut-usage-sidebar'), { timeoutMs: 15000 });
		if (!mounted) {
			throw new HarnessError(2, 'Logged in, but the tracker never mounted: is debug\\chrome loaded (and enabled) in this profile?');
		}
		console.log('OK: logged in, extension mounted.', JSON.stringify(report));
	} finally {
		await chrome.close();
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	const cmd = process.argv[2];
	const run = { login, smoke }[cmd];
	if (!run) {
		console.error('usage: node scripts/chrome-harness.mjs <login|smoke>');
		process.exit(2);
	}
	run().then(() => process.exit(0), e => {
		console.error(e.message);
		process.exit(e instanceof HarnessError ? e.code : 1);
	});
}
