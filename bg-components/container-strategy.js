// The single boundary that owns all platform/container reasoning. The rest of the codebase is
// container-agnostic: it asks the active strategy to list accounts, resolve a tab's active org, or
// build a ClaudeAPI bound to an account — without ever touching cookieStoreId, tabId-as-transport,
// contextualIdentities, X-Container, or "is this Brave".
//
// `ctx` is an opaque per-account token only the producing strategy understands.

import { isElectron, RawLog, sendTabMessage, getStorageValue, setStorageValue } from './utils.js';
import { ClaudeAPI } from './claude-api.js';
import { tokenStorageManager } from './tokenManagement.js';

async function Log(...args) {
	await RawLog("container", ...args);
}

function isClaudeUrl(url) {
	try {
		return new URL(url).hostname === 'claude.ai';
	} catch {
		return false;
	}
}

// --- shared helpers --------------------------------------------------------

async function contentScriptActiveOrg(tab) {
	try {
		const response = await sendTabMessage(tab.id, { action: "getOrgID" });
		return response?.orgId || null;
	} catch (e) {
		await Log("error", "activeOrgForTab (content script) failed:", e);
		return null;
	}
}

// Base64 <-> bytes, chunked so large file downloads don't blow the call stack.
function bytesToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToBytes(base64) {
	const binary = atob(base64 || '');
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// --- base strategy: plain background fetch (Chrome + Electron) --------------

class ContainerStrategy {
	async init() { /* no-op */ }

	// The one transport. Default: a plain background fetch (default container / single profile).
	async fetch(ctx, url, options = {}) {
		return fetch(url, options);
	}

	ctxForTab(_tab) { return null; }
	ctxForRequest(_details) { return null; }

	async activeOrgForTab(tab) {
		return contentScriptActiveOrg(tab);
	}

	// Discovery: open claude.ai tabs (live) ∪ TTL'd known orgs (no transport → "unavailable" rows).
	async listAccounts() {
		const byOrg = new Map();
		const add = (orgId, ctx) => { if (orgId && !byOrg.has(orgId)) byOrg.set(orgId, { orgId, ctx }); };

		try {
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
			for (const tab of tabs) {
				try {
					add(await this.activeOrgForTab(tab), this.ctxForTab(tab));
				} catch (e) {
					await Log("warn", `Tab ${tab.id} org lookup failed:`, e);
				}
			}
		} catch (e) {
			await Log("warn", "Tab enumeration failed:", e);
		}

		try {
			for (const orgId of await tokenStorageManager.getKnownOrgIds()) add(orgId, null);
		} catch (e) {
			await Log("warn", "Known-org enumeration failed:", e);
		}

		return [...byOrg.values()];
	}

	apiFor(ctx, orgId) {
		return new ClaudeAPI(orgId, (url, options) => this.fetch(ctx, url, options));
	}

	apiForTab(tab, orgId) {
		return this.apiFor(tab ? this.ctxForTab(tab) : null, orgId);
	}

	apiForRequest(details, orgId) {
		return this.apiFor(this.ctxForRequest(details), orgId);
	}
}

// --- Brave: containers are invisible to extension APIs; proxy via the tab ---

class BraveStrategy extends ContainerStrategy {
	async fetch(ctx, url, options = {}) {
		// Public URLs (e.g. github) go through a plain fetch — a content-script fetch would hit CORS.
		if (!isClaudeUrl(url)) return fetch(url, options);
		// A specific container's tab → proxy through it (its cookies).
		const tabId = ctx?.tabId;
		if (tabId != null && tabId >= 0) return proxyFetchViaTab(tabId, url, options);
		// The default container is the one a plain background fetch can reach.
		if (ctx?.default) return fetch(url, options);
		// Otherwise it's a non-default container with no open tab — unreachable. A plain fetch would
		// silently hit the DEFAULT container (wrong account → bogus "no limits"), so throw instead and
		// let the popup render it as "open a tab".
		throw new Error('Brave: no open tab for this container');
	}

	ctxForTab(tab) { return { tabId: tab?.id }; }
	ctxForRequest(details) { return { tabId: details?.tabId }; }

	async listAccounts() {
		const byOrg = new Map();
		const add = (orgId, ctx) => { if (orgId && !byOrg.has(orgId)) byOrg.set(orgId, { orgId, ctx }); };

		// Open tabs → reachable via proxy (their own container).
		try {
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
			for (const tab of tabs) {
				try { add(await this.activeOrgForTab(tab), { tabId: tab.id }); }
				catch (e) { await Log("warn", `Tab ${tab.id} org lookup failed:`, e); }
			}
		} catch (e) {
			await Log("warn", "Tab enumeration failed:", e);
		}

		// The default container's orgs → reachable via a plain background fetch (no tab needed).
		try {
			const resp = await fetch('https://claude.ai/api/organizations', {
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' }
			});
			if (resp.ok) {
				const orgs = await resp.json();
				if (Array.isArray(orgs)) for (const o of orgs) add(o.uuid, { default: true });
			}
		} catch (e) {
			await Log("warn", "Default-container org fetch failed:", e);
		}

		// Remaining TTL'd known orgs → a non-default container with no open tab (unreachable → "open a tab").
		try {
			for (const orgId of await tokenStorageManager.getKnownOrgIds()) add(orgId, null);
		} catch (e) {
			await Log("warn", "Known-org enumeration failed:", e);
		}

		return [...byOrg.values()];
	}
}

// Brave transport: ask the tab's content script to perform the fetch (in its container context) and
// rebuild a real Response, so every caller (.json()/.text()/.blob()) works unchanged.
async function proxyFetchViaTab(tabId, url, options = {}) {
	const result = await sendTabMessage(tabId, {
		type: 'proxyFetch',
		url,
		options: {
			method: options.method || 'GET',
			headers: options.headers || undefined,
			body: options.body || undefined
		}
	});
	if (!result) throw new Error(`proxyFetch via tab ${tabId} returned no result`);
	return new Response(base64ToBytes(result.body), {
		status: result.status || 0,
		statusText: result.statusText || ''
	});
}

// --- Firefox: real container cookie stores + X-Container header injection ---

class FirefoxStrategy extends ContainerStrategy {
	async fetch(ctx, url, options = {}) {
		const cookieStoreId = ctx?.cookieStoreId;
		if (!cookieStoreId || cookieStoreId === "0") return fetch(url, options);
		const headers = options.headers || {};
		headers['X-Container'] = cookieStoreId;
		options.headers = headers;
		return fetch(url, options);
	}

	ctxForTab(tab) { return { cookieStoreId: tab?.cookieStoreId }; }
	ctxForRequest(details) { return { cookieStoreId: details?.cookieStoreId }; }

	async activeOrgForTab(tab) {
		try {
			const cookie = await browser.cookies.get({
				name: 'lastActiveOrg',
				url: tab.url,
				storeId: tab.cookieStoreId
			});
			if (cookie?.value) return cookie.value;
		} catch (e) {
			await Log("error", "Firefox activeOrgForTab cookie read failed:", e);
		}
		return contentScriptActiveOrg(tab);
	}

	// Discovery: enumerate all containers (open AND closed) via contextualIdentities + per-store cookie.
	async listAccounts() {
		const byOrg = new Map();
		const add = (orgId, ctx) => { if (orgId && !byOrg.has(orgId)) byOrg.set(orgId, { orgId, ctx }); };

		try {
			const storeIds = new Set(['firefox-default']);
			for (const c of await browser.contextualIdentities.query({})) storeIds.add(c.cookieStoreId);
			for (const storeId of storeIds) {
				try {
					const cookie = await browser.cookies.get({ name: 'lastActiveOrg', url: 'https://claude.ai', storeId });
					if (cookie?.value) add(cookie.value, { cookieStoreId: storeId });
				} catch (e) {
					await Log("warn", `Cookie read failed for store ${storeId}:`, e);
				}
			}
		} catch (e) {
			await Log("warn", "contextualIdentities enumeration failed:", e);
		}

		// Fallback to stored orgs (default store) only if nothing was found.
		if (byOrg.size === 0) {
			try {
				for (const orgId of await tokenStorageManager.getKnownOrgIds()) {
					add(orgId, { cookieStoreId: 'firefox-default' });
				}
			} catch (e) {
				await Log("warn", "Known-org enumeration failed:", e);
			}
		}

		return [...byOrg.values()];
	}

	async init() {
		// Move per-container cookies into the right store: read them for outgoing requests carrying an
		// X-Container header, and redirect Set-Cookie responses back to that store. (Blocking webRequest.)
		browser.webRequest.onBeforeSendHeaders.addListener(
			async (details) => {
				// Only ever touch the extension's own (background) requests — never page requests.
				if (details.tabId !== -1) return;
				const containerStore = details.requestHeaders.find(h => h.name === 'X-Container')?.value;
				if (containerStore) {
					containerRequestMap.set(details.requestId, containerStore);
					const domain = new URL(details.url).hostname;
					const domainCookies = await browser.cookies.getAll({ domain, storeId: containerStore });
					if (domainCookies.length > 0) {
						let cookieHeader = details.requestHeaders.find(h => h.name === 'Cookie');
						if (!cookieHeader) {
							cookieHeader = { name: 'Cookie', value: '' };
							details.requestHeaders.push(cookieHeader);
						}
						cookieHeader.value = domainCookies.map(c => `${c.name}=${c.value}`).join('; ');
					}
					details.requestHeaders = details.requestHeaders.filter(h => h.name !== 'X-Container');
				}
				return { requestHeaders: details.requestHeaders };
			},
			{ urls: ["*://claude.ai/*"] },
			["blocking", "requestHeaders"]
		);

		browser.webRequest.onHeadersReceived.addListener(
			async (details) => {
				// Only act on the extension's own (background) requests, so a page request can never
				// false-match a stale/reused requestId and have its own Set-Cookie redirected.
				if (details.tabId !== -1) return;
				const containerStore = containerRequestMap.get(details.requestId);
				if (!containerStore) return;
				containerRequestMap.delete(details.requestId);

				const setCookieHeaders = details.responseHeaders.filter(h => h.name.toLowerCase() === 'set-cookie');
				if (setCookieHeaders.length === 0) return;

				for (const header of setCookieHeaders) {
					await redirectCookie(header.value, details.url, containerStore);
				}
				return {
					responseHeaders: details.responseHeaders.filter(h => h.name.toLowerCase() !== 'set-cookie')
				};
			},
			{ urls: ["*://claude.ai/*"] },
			["blocking", "responseHeaders"]
		);

		browser.webRequest.onErrorOccurred.addListener(
			(details) => { if (details.tabId === -1) containerRequestMap.delete(details.requestId); },
			{ urls: ["*://claude.ai/*"] }
		);
		await Log("Firefox container listeners registered");
	}
}

const containerRequestMap = new Map();

async function redirectCookie(setCookieStr, requestUrl, storeId) {
	const parts = setCookieStr.split(';').map(p => p.trim());
	const [nameValue, ...attrs] = parts;
	const eqIdx = nameValue.indexOf('=');
	const name = nameValue.substring(0, eqIdx);
	const value = nameValue.substring(eqIdx + 1);

	const cookieDetails = { url: requestUrl, name, value, storeId };

	for (const attr of attrs) {
		const lower = attr.toLowerCase();
		if (lower.startsWith('domain=')) cookieDetails.domain = attr.split('=')[1];
		else if (lower.startsWith('path=')) cookieDetails.path = attr.split('=')[1];
		else if (lower.startsWith('expires=')) {
			cookieDetails.expirationDate = Math.floor(new Date(attr.substring(8)).getTime() / 1000);
		}
		else if (lower === 'secure') cookieDetails.secure = true;
		else if (lower === 'httponly') cookieDetails.httpOnly = true;
		else if (lower.startsWith('samesite=')) {
			const val = attr.split('=')[1].toLowerCase();
			cookieDetails.sameSite = val === 'none' ? 'no_restriction' : val;
		}
	}

	await Log("Redirecting cookie", name, "to store:", storeId);
	await browser.cookies.set(cookieDetails);
}

// --- selection -------------------------------------------------------------

let isBrave = false;
let strategy = null;

function pick() {
	if (isElectron) return new ContainerStrategy();
	if (browser.contextualIdentities) return new FirefoxStrategy();
	if (isBrave) return new BraveStrategy();
	return new ContainerStrategy(); // Chrome
}

// Called once at startup: load the persisted Brave flag, select the strategy, run one-time init.
async function initContainerStrategy() {
	isBrave = await getStorageValue('isBrave', false);
	strategy = pick();
	await strategy.init();
	await Log("Container strategy:", strategy.constructor.name);
	return strategy;
}

function getStrategy() {
	if (!strategy) strategy = pick();
	return strategy;
}

// The content script reports Brave (navigator.brave.isBrave()). This only decides which strategy loads.
async function setBrave(value) {
	const v = !!value;
	await setStorageValue('isBrave', v);
	if (v === isBrave) return;
	isBrave = v;
	// Only chromium switches between Chrome/Brave; electron and firefox are unaffected.
	if (!isElectron && !browser.contextualIdentities) {
		strategy = pick();
		await strategy.init();
		await Log("Container strategy switched to:", strategy.constructor.name);
	}
}

export { getStrategy, initContainerStrategy, setBrave };
