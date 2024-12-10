//I have to include this because screw you, chrome decided to be buggy.

// webextension-polyfill v.0.12.0 (https://github.com/mozilla/webextension-polyfill)
(function (a, b) { if ("function" == typeof define && define.amd) define("webextension-polyfill", ["module"], b); else if ("undefined" != typeof exports) b(module); else { var c = { exports: {} }; b(c), a.browser = c.exports } })("undefined" == typeof globalThis ? "undefined" == typeof self ? this : self : globalThis, function (a) { "use strict"; if (!(globalThis.chrome && globalThis.chrome.runtime && globalThis.chrome.runtime.id)) throw new Error("This script should only be loaded in a browser extension."); if (!(globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.id)) { a.exports = (a => { const b = { alarms: { clear: { minArgs: 0, maxArgs: 1 }, clearAll: { minArgs: 0, maxArgs: 0 }, get: { minArgs: 0, maxArgs: 1 }, getAll: { minArgs: 0, maxArgs: 0 } }, bookmarks: { create: { minArgs: 1, maxArgs: 1 }, get: { minArgs: 1, maxArgs: 1 }, getChildren: { minArgs: 1, maxArgs: 1 }, getRecent: { minArgs: 1, maxArgs: 1 }, getSubTree: { minArgs: 1, maxArgs: 1 }, getTree: { minArgs: 0, maxArgs: 0 }, move: { minArgs: 2, maxArgs: 2 }, remove: { minArgs: 1, maxArgs: 1 }, removeTree: { minArgs: 1, maxArgs: 1 }, search: { minArgs: 1, maxArgs: 1 }, update: { minArgs: 2, maxArgs: 2 } }, browserAction: { disable: { minArgs: 0, maxArgs: 1, fallbackToNoCallback: !0 }, enable: { minArgs: 0, maxArgs: 1, fallbackToNoCallback: !0 }, getBadgeBackgroundColor: { minArgs: 1, maxArgs: 1 }, getBadgeText: { minArgs: 1, maxArgs: 1 }, getPopup: { minArgs: 1, maxArgs: 1 }, getTitle: { minArgs: 1, maxArgs: 1 }, openPopup: { minArgs: 0, maxArgs: 0 }, setBadgeBackgroundColor: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, setBadgeText: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, setIcon: { minArgs: 1, maxArgs: 1 }, setPopup: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, setTitle: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 } }, browsingData: { remove: { minArgs: 2, maxArgs: 2 }, removeCache: { minArgs: 1, maxArgs: 1 }, removeCookies: { minArgs: 1, maxArgs: 1 }, removeDownloads: { minArgs: 1, maxArgs: 1 }, removeFormData: { minArgs: 1, maxArgs: 1 }, removeHistory: { minArgs: 1, maxArgs: 1 }, removeLocalStorage: { minArgs: 1, maxArgs: 1 }, removePasswords: { minArgs: 1, maxArgs: 1 }, removePluginData: { minArgs: 1, maxArgs: 1 }, settings: { minArgs: 0, maxArgs: 0 } }, commands: { getAll: { minArgs: 0, maxArgs: 0 } }, contextMenus: { remove: { minArgs: 1, maxArgs: 1 }, removeAll: { minArgs: 0, maxArgs: 0 }, update: { minArgs: 2, maxArgs: 2 } }, cookies: { get: { minArgs: 1, maxArgs: 1 }, getAll: { minArgs: 1, maxArgs: 1 }, getAllCookieStores: { minArgs: 0, maxArgs: 0 }, remove: { minArgs: 1, maxArgs: 1 }, set: { minArgs: 1, maxArgs: 1 } }, devtools: { inspectedWindow: { eval: { minArgs: 1, maxArgs: 2, singleCallbackArg: !1 } }, panels: { create: { minArgs: 3, maxArgs: 3, singleCallbackArg: !0 }, elements: { createSidebarPane: { minArgs: 1, maxArgs: 1 } } } }, downloads: { cancel: { minArgs: 1, maxArgs: 1 }, download: { minArgs: 1, maxArgs: 1 }, erase: { minArgs: 1, maxArgs: 1 }, getFileIcon: { minArgs: 1, maxArgs: 2 }, open: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, pause: { minArgs: 1, maxArgs: 1 }, removeFile: { minArgs: 1, maxArgs: 1 }, resume: { minArgs: 1, maxArgs: 1 }, search: { minArgs: 1, maxArgs: 1 }, show: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 } }, extension: { isAllowedFileSchemeAccess: { minArgs: 0, maxArgs: 0 }, isAllowedIncognitoAccess: { minArgs: 0, maxArgs: 0 } }, history: { addUrl: { minArgs: 1, maxArgs: 1 }, deleteAll: { minArgs: 0, maxArgs: 0 }, deleteRange: { minArgs: 1, maxArgs: 1 }, deleteUrl: { minArgs: 1, maxArgs: 1 }, getVisits: { minArgs: 1, maxArgs: 1 }, search: { minArgs: 1, maxArgs: 1 } }, i18n: { detectLanguage: { minArgs: 1, maxArgs: 1 }, getAcceptLanguages: { minArgs: 0, maxArgs: 0 } }, identity: { launchWebAuthFlow: { minArgs: 1, maxArgs: 1 } }, idle: { queryState: { minArgs: 1, maxArgs: 1 } }, management: { get: { minArgs: 1, maxArgs: 1 }, getAll: { minArgs: 0, maxArgs: 0 }, getSelf: { minArgs: 0, maxArgs: 0 }, setEnabled: { minArgs: 2, maxArgs: 2 }, uninstallSelf: { minArgs: 0, maxArgs: 1 } }, notifications: { clear: { minArgs: 1, maxArgs: 1 }, create: { minArgs: 1, maxArgs: 2 }, getAll: { minArgs: 0, maxArgs: 0 }, getPermissionLevel: { minArgs: 0, maxArgs: 0 }, update: { minArgs: 2, maxArgs: 2 } }, pageAction: { getPopup: { minArgs: 1, maxArgs: 1 }, getTitle: { minArgs: 1, maxArgs: 1 }, hide: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, setIcon: { minArgs: 1, maxArgs: 1 }, setPopup: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, setTitle: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 }, show: { minArgs: 1, maxArgs: 1, fallbackToNoCallback: !0 } }, permissions: { contains: { minArgs: 1, maxArgs: 1 }, getAll: { minArgs: 0, maxArgs: 0 }, remove: { minArgs: 1, maxArgs: 1 }, request: { minArgs: 1, maxArgs: 1 } }, runtime: { getBackgroundPage: { minArgs: 0, maxArgs: 0 }, getPlatformInfo: { minArgs: 0, maxArgs: 0 }, openOptionsPage: { minArgs: 0, maxArgs: 0 }, requestUpdateCheck: { minArgs: 0, maxArgs: 0 }, sendMessage: { minArgs: 1, maxArgs: 3 }, sendNativeMessage: { minArgs: 2, maxArgs: 2 }, setUninstallURL: { minArgs: 1, maxArgs: 1 } }, sessions: { getDevices: { minArgs: 0, maxArgs: 1 }, getRecentlyClosed: { minArgs: 0, maxArgs: 1 }, restore: { minArgs: 0, maxArgs: 1 } }, storage: { local: { clear: { minArgs: 0, maxArgs: 0 }, get: { minArgs: 0, maxArgs: 1 }, getBytesInUse: { minArgs: 0, maxArgs: 1 }, remove: { minArgs: 1, maxArgs: 1 }, set: { minArgs: 1, maxArgs: 1 } }, managed: { get: { minArgs: 0, maxArgs: 1 }, getBytesInUse: { minArgs: 0, maxArgs: 1 } }, sync: { clear: { minArgs: 0, maxArgs: 0 }, get: { minArgs: 0, maxArgs: 1 }, getBytesInUse: { minArgs: 0, maxArgs: 1 }, remove: { minArgs: 1, maxArgs: 1 }, set: { minArgs: 1, maxArgs: 1 } } }, tabs: { captureVisibleTab: { minArgs: 0, maxArgs: 2 }, create: { minArgs: 1, maxArgs: 1 }, detectLanguage: { minArgs: 0, maxArgs: 1 }, discard: { minArgs: 0, maxArgs: 1 }, duplicate: { minArgs: 1, maxArgs: 1 }, executeScript: { minArgs: 1, maxArgs: 2 }, get: { minArgs: 1, maxArgs: 1 }, getCurrent: { minArgs: 0, maxArgs: 0 }, getZoom: { minArgs: 0, maxArgs: 1 }, getZoomSettings: { minArgs: 0, maxArgs: 1 }, goBack: { minArgs: 0, maxArgs: 1 }, goForward: { minArgs: 0, maxArgs: 1 }, highlight: { minArgs: 1, maxArgs: 1 }, insertCSS: { minArgs: 1, maxArgs: 2 }, move: { minArgs: 2, maxArgs: 2 }, query: { minArgs: 1, maxArgs: 1 }, reload: { minArgs: 0, maxArgs: 2 }, remove: { minArgs: 1, maxArgs: 1 }, removeCSS: { minArgs: 1, maxArgs: 2 }, sendMessage: { minArgs: 2, maxArgs: 3 }, setZoom: { minArgs: 1, maxArgs: 2 }, setZoomSettings: { minArgs: 1, maxArgs: 2 }, update: { minArgs: 1, maxArgs: 2 } }, topSites: { get: { minArgs: 0, maxArgs: 0 } }, webNavigation: { getAllFrames: { minArgs: 1, maxArgs: 1 }, getFrame: { minArgs: 1, maxArgs: 1 } }, webRequest: { handlerBehaviorChanged: { minArgs: 0, maxArgs: 0 } }, windows: { create: { minArgs: 0, maxArgs: 1 }, get: { minArgs: 1, maxArgs: 2 }, getAll: { minArgs: 0, maxArgs: 1 }, getCurrent: { minArgs: 0, maxArgs: 1 }, getLastFocused: { minArgs: 0, maxArgs: 1 }, remove: { minArgs: 1, maxArgs: 1 }, update: { minArgs: 2, maxArgs: 2 } } }; if (0 === Object.keys(b).length) throw new Error("api-metadata.json has not been included in browser-polyfill"); class c extends WeakMap { constructor(a, b = void 0) { super(b), this.createItem = a } get(a) { return this.has(a) || this.set(a, this.createItem(a)), super.get(a) } } const d = a => a && "object" == typeof a && "function" == typeof a.then, e = (b, c) => (...d) => { a.runtime.lastError ? b.reject(new Error(a.runtime.lastError.message)) : c.singleCallbackArg || 1 >= d.length && !1 !== c.singleCallbackArg ? b.resolve(d[0]) : b.resolve(d) }, f = a => 1 == a ? "argument" : "arguments", g = (a, b) => function (c, ...d) { if (d.length < b.minArgs) throw new Error(`Expected at least ${b.minArgs} ${f(b.minArgs)} for ${a}(), got ${d.length}`); if (d.length > b.maxArgs) throw new Error(`Expected at most ${b.maxArgs} ${f(b.maxArgs)} for ${a}(), got ${d.length}`); return new Promise((f, g) => { if (b.fallbackToNoCallback) try { c[a](...d, e({ resolve: f, reject: g }, b)) } catch (e) { console.warn(`${a} API method doesn't seem to support the callback parameter, ` + "falling back to call it without a callback: ", e), c[a](...d), b.fallbackToNoCallback = !1, b.noCallback = !0, f() } else b.noCallback ? (c[a](...d), f()) : c[a](...d, e({ resolve: f, reject: g }, b)) }) }, h = (a, b, c) => new Proxy(b, { apply(b, d, e) { return c.call(d, a, ...e) } }); let i = Function.call.bind(Object.prototype.hasOwnProperty); const j = (a, b = {}, c = {}) => { let d = Object.create(null), e = Object.create(a); return new Proxy(e, { has(b, c) { return c in a || c in d }, get(e, f) { if (f in d) return d[f]; if (!(f in a)) return; let k = a[f]; if ("function" == typeof k) { if ("function" == typeof b[f]) k = h(a, a[f], b[f]); else if (i(c, f)) { let b = g(f, c[f]); k = h(a, a[f], b) } else k = k.bind(a); } else if ("object" == typeof k && null !== k && (i(b, f) || i(c, f))) k = j(k, b[f], c[f]); else if (i(c, "*")) k = j(k, b[f], c["*"]); else return Object.defineProperty(d, f, { configurable: !0, enumerable: !0, get() { return a[f] }, set(b) { a[f] = b } }), k; return d[f] = k, k }, set(b, c, e) { return c in d ? d[c] = e : a[c] = e, !0 }, defineProperty(a, b, c) { return Reflect.defineProperty(d, b, c) }, deleteProperty(a, b) { return Reflect.deleteProperty(d, b) } }) }, k = a => ({ addListener(b, c, ...d) { b.addListener(a.get(c), ...d) }, hasListener(b, c) { return b.hasListener(a.get(c)) }, removeListener(b, c) { b.removeListener(a.get(c)) } }), l = new c(a => "function" == typeof a ? function (b) { const c = j(b, {}, { getContent: { minArgs: 0, maxArgs: 0 } }); a(c) } : a), m = new c(a => "function" == typeof a ? function (b, c, e) { let f, g, h = !1, i = new Promise(a => { f = function (b) { h = !0, a(b) } }); try { g = a(b, c, f) } catch (a) { g = Promise.reject(a) } const j = !0 !== g && d(g); if (!0 !== g && !j && !h) return !1; const k = a => { a.then(a => { e(a) }, a => { let b; b = a && (a instanceof Error || "string" == typeof a.message) ? a.message : "An unexpected error occurred", e({ __mozWebExtensionPolyfillReject__: !0, message: b }) }).catch(a => { console.error("Failed to send onMessage rejected reply", a) }) }; return j ? k(g) : k(i), !0 } : a), n = ({ reject: b, resolve: c }, d) => { a.runtime.lastError ? a.runtime.lastError.message === "The message port closed before a response was received." ? c() : b(new Error(a.runtime.lastError.message)) : d && d.__mozWebExtensionPolyfillReject__ ? b(new Error(d.message)) : c(d) }, o = (a, b, c, ...d) => { if (d.length < b.minArgs) throw new Error(`Expected at least ${b.minArgs} ${f(b.minArgs)} for ${a}(), got ${d.length}`); if (d.length > b.maxArgs) throw new Error(`Expected at most ${b.maxArgs} ${f(b.maxArgs)} for ${a}(), got ${d.length}`); return new Promise((a, b) => { const e = n.bind(null, { resolve: a, reject: b }); d.push(e), c.sendMessage(...d) }) }, p = { devtools: { network: { onRequestFinished: k(l) } }, runtime: { onMessage: k(m), onMessageExternal: k(m), sendMessage: o.bind(null, "sendMessage", { minArgs: 1, maxArgs: 3 }) }, tabs: { sendMessage: o.bind(null, "sendMessage", { minArgs: 2, maxArgs: 3 }) } }, q = { clear: { minArgs: 1, maxArgs: 1 }, get: { minArgs: 1, maxArgs: 1 }, set: { minArgs: 1, maxArgs: 1 } }; return b.privacy = { network: { "*": q }, services: { "*": q }, websites: { "*": q } }, j(a, p, b) })(chrome) } else a.exports = globalThis.browser });
//# sourceMappingURL=browser-polyfill.min.js.map

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */



const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
let defaultConfig = null;
const STORAGE_KEY = "claudeUsageTracker_v3"
const CONFIG_URL = 'https://raw.githubusercontent.com/lugia19/Claude-Toolbox/refs/heads/main/constants.json';

browser.action.onClicked.addListener(() => {
    browser.tabs.create({
        url: "https://github.com/lugia19/Claude-Toolbox"
    });
});

// Load default config before doing anything else
async function initializeConfig() {
	try {
		const response = await fetch(browser.runtime.getURL('default-config.json'));
		defaultConfig = await response.json();
		configReady = true;
		console.log("Default config loaded:", defaultConfig);
	} catch (error) {
		console.error("Failed to load default config:", error);
	}
}

// Helper for deep merging
function mergeDeep(target, source) {
	for (const key in source) {
		if (source[key] instanceof Object && key in target) {
			target[key] = mergeDeep(target[key], source[key]);
		} else {
			target[key] = source[key];
		}
	}
	return target;
}

// Function to get fresh config
async function getFreshConfig() {
	if (!defaultConfig) {
		await initializeConfig();
	}

	try {
		const response = await fetch(CONFIG_URL);
		if (!response.ok) {
			console.warn('Failed to load remote config, using defaults');
			return defaultConfig;
		}

		const remoteConfig = await response.json();
		console.log('Loaded remote config:', remoteConfig);
		return mergeDeep(structuredClone(defaultConfig), remoteConfig);
	} catch (error) {
		console.warn('Error loading remote config:', error);
		return defaultConfig;
	}
}



class TokenStorageManager {
	constructor() {
		this.syncInterval = 1; // 1m
		this.isSyncingFirebase = false;
		this.storageLock = false;
		this.userId = null;

		browser.alarms.create('firebaseSync', { periodInMinutes: this.syncInterval });
		console.log("Alarm created, syncing every", this.syncInterval, "minutes");
		browser.alarms.onAlarm.addListener((alarm) => {
			console.log("Alarm triggered:", alarm);
			if (alarm.name === 'firebaseSync' && this.userId) {
				this.syncWithFirebase();
			}
		});
	}


	// Helper methods for browser.storage
	async #setValue(key, value) {
		await browser.storage.local.set({ [key]: value });
		// Read back and verify
		/*const readBack = await browser.storage.local.get(key);
		const storedValue = readBack[key];

		if (JSON.stringify(storedValue) !== JSON.stringify(value)) {
			console.error("Storage verification failed for key:", key);
			console.error("Tried to write:", value);
			console.error("Read back:", storedValue);
			//throw new Error("Storage verification failed");
		}*/

		console.log("Storage verified for key:", key);
		return true;
	}

	async #getValue(key, defaultValue = null) {
		const result = await browser.storage.local.get(key) || {};
		return result[key] ?? defaultValue;
	}

	setUserId(newId) {
		if (newId) {
			console.log("Setting new userID:", newId);
			this.userId = newId;
		}
	}

	async syncWithFirebase() {
		if (!this.userId) return;	// Just in case something weird happens

		if (this.isSyncingFirebase) {
			console.log("Sync already in progress, skipping");
			return;
		}

		this.isSyncingFirebase = true;
		console.log("=== FIREBASE SYNC STARTING ===");
		console.log("Using hashed ID:", this.userId);

		try {
			// Get local data
			const localModels = await this.#getValue(`${STORAGE_KEY}_models`) || {};
			console.log("Local models:", localModels);

			// Get remote data
			const url = `${defaultConfig.FIREBASE_BASE_URL}/users/${this.userId}/models.json`;
			console.log("Fetching from:", url);

			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status}`);
			}
			const firebaseModels = await response.json() || {};
			console.log("Firebase models:", firebaseModels);

			// Merge data
			const mergedModels = this.mergeModelData(localModels, firebaseModels);
			console.log("Merged result:", mergedModels);

			// Write merged data back
			console.log("Writing merged data back to Firebase...");
			const writeResponse = await fetch(url, {
				method: 'PUT',
				body: JSON.stringify(mergedModels)
			});

			if (!writeResponse.ok) {
				throw new Error(`Write failed! status: ${writeResponse.status}`);
			}

			// Update local storage
			console.log("Updating local storage...");
			await this.#setValue(`${STORAGE_KEY}_models`, mergedModels);
			console.log("=== SYNC COMPLETED SUCCESSFULLY ===");

		} catch (error) {
			console.error('=== SYNC FAILED ===');
			console.error('Error details:', error);
			console.error('Stack:', error.stack);
		} finally {
			this.isSyncingFirebase = false;
		}
	}

	mergeModelData(localModels = {}, firebaseModels = {}) {
		console.log("MERGING...")
		const merged = {};
		const allModelKeys = new Set([
			...Object.keys(localModels),
			...Object.keys(firebaseModels)
		]);

		const currentTime = new Date().getTime();

		allModelKeys.forEach(model => {
			const local = localModels[model];
			const remote = firebaseModels[model];

			if (!remote) {
				merged[model] = local;
			} else if (!local) {
				merged[model] = remote;
			} else {
				// If reset times match, take the highest counts as before
				if (local.resetTimestamp === remote.resetTimestamp) {
					console.log("TIMESTAMP MATCHES, TAKING HIGHEST COUNTS!")
					merged[model] = {
						total: Math.max(local.total, remote.total),
						messageCount: Math.max(local.messageCount, remote.messageCount),
						resetTimestamp: local.resetTimestamp
					};
				} else {
					// Get the earlier and later timestamps
					const earlier = local.resetTimestamp < remote.resetTimestamp ? local : remote;
					const later = local.resetTimestamp < remote.resetTimestamp ? remote : local;

					// If earlier timestamp is still valid (not in past)
					if (earlier.resetTimestamp > currentTime) {
						console.log("EARLIER TIMESTAMP STILL VALID, COMBINING COUNTS!")
						merged[model] = {
							total: earlier.total + later.total,
							messageCount: earlier.messageCount + later.messageCount,
							resetTimestamp: earlier.resetTimestamp
						};
					} else {
						// If earlier timestamp is expired, use later one
						console.log("EARLIER TIMESTAMP EXPIRED, USING LATER ONE!")
						merged[model] = later;
					}
				}
			}
		});

		return merged;
	}


	async getCheckboxStates() {
		const storedStates = await this.#getValue(`${STORAGE_KEY}_checkbox_states`, {});
		// Create an object with all checkbox options set to false
		const defaultStates = Object.keys(defaultConfig.FEATURE_CHECKBOXES).reduce((acc, key) => {
			acc[key] = false;
			return acc;
		}, {});
		// Merge with any stored states
		return { ...defaultStates, ...storedStates };
	}

	async setCheckboxState(key, checked) {
		const states = await this.getCheckboxStates();
		states[key] = checked;
		await this.#setValue(`${STORAGE_KEY}_checkbox_states`, states);
	}

	async getExtraCost() {
		const states = await this.getCheckboxStates();
		return Object.entries(defaultConfig.FEATURE_CHECKBOXES).reduce((total, [key, option]) => total + (states[key] ? option.cost : 0), 0);
	}

	async getCollapsedState() {
		return await this.#getValue(`${STORAGE_KEY}_collapsed`, false);
	}

	async setCollapsedState(isCollapsed) {
		await this.#setValue(`${STORAGE_KEY}_collapsed`, isCollapsed);
	}

	async #checkAndCleanExpiredData() {
		const allModelData = await this.#getValue(`${STORAGE_KEY}_models`);
		if (!allModelData) return;

		const currentTime = new Date();
		let hasChanges = false;

		for (const model in allModelData) {
			const resetTime = new Date(allModelData[model].resetTimestamp);
			if (currentTime >= resetTime) {
				delete allModelData[model];
				hasChanges = true;
			}
		}

		if (hasChanges) {
			await this.#setValue(`${STORAGE_KEY}_models`, allModelData);
		}
	}

	async getModelData(model) {
		await this.#checkAndCleanExpiredData();
		const allModelData = await this.#getValue(`${STORAGE_KEY}_models`);
		return allModelData?.[model];
	}

	async addTokensToModel(model, newTokens) {
		// Wait if sync is in progress
		while (this.isSyncingFirebase) {
			await sleep(100);
		}

		while (this.storageLock) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}

		try {
			this.storageLock = true;
			let allModelData = await this.#getValue(`${STORAGE_KEY}_models`, {});
			const stored = allModelData[model];

			const currentMessageCount = (stored?.messageCount || 0) + 1;
			const totalTokenCount = stored ? stored.total + newTokens : newTokens;

			allModelData[model] = {
				total: totalTokenCount,
				messageCount: currentMessageCount,
				resetTimestamp: stored?.resetTimestamp || this.#getResetFromNow(new Date()).getTime()
			};

			await this.#setValue(`${STORAGE_KEY}_models`, allModelData);

			return {
				totalTokenCount,
				messageCount: currentMessageCount
			};
		} finally {
			this.storageLock = false;
		}
	}

	#getResetFromNow(currentTime) {
		const hourStart = new Date(currentTime);
		hourStart.setMinutes(0, 0, 0);
		const resetTime = new Date(hourStart);
		resetTime.setHours(hourStart.getHours() + 5);
		return resetTime;
	}

	async getFormattedTimeRemaining(model) {
		const stored = await this.getModelData(model);
		if (!stored) return 'Reset in: Not set';

		const now = new Date();
		const resetTime = new Date(stored.resetTimestamp);
		const diff = resetTime - now;

		if (diff <= 0) return 'Reset pending...';

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

		return hours > 0 ? `Reset in: ${hours}h ${minutes}m` : `Reset in: ${minutes}m`;
	}

	async calculateMessagesLeft(model, conversationLength = 0) {
		console.log("Calculating messages left for model:", model);
		console.log("Conversation length:", conversationLength);
		if (model === "default") return "Loading...";

		const maxTokens = defaultConfig.MODEL_TOKEN_CAPS[model] || defaultConfig.MODEL_TOKEN_CAPS.default;
		const stored = await this.getModelData(model);
		const modelTotal = stored?.total || 0;
		const remainingTokens = maxTokens - modelTotal;

		if (conversationLength === 0) {
			return "Loading...";
		}

		return Math.max(0, remainingTokens / conversationLength).toFixed(1);
	}

	// File storage methods
	#getFileKey(conversationId) {
		return `${STORAGE_KEY}_files_${conversationId}`;
	}

	async getFileTokens(conversationId, filename, fileType) {
		const allFileData = await this.#getValue(this.#getFileKey(conversationId), {});
		const fileKey = `${fileType}_${filename}`;
		return allFileData[fileKey];
	}

	async saveFileTokens(conversationId, filename, tokens, fileType) {
		if (tokens <= 0) return;

		const allFileData = await this.#getValue(this.#getFileKey(conversationId), {});
		const fileKey = `${fileType}_${filename}`;

		allFileData[fileKey] = tokens;
		await this.#setValue(this.#getFileKey(conversationId), allFileData);
	}
}

const tokenStorageManager = new TokenStorageManager();

async function handleMessage(message) {
	console.log("📥 Received message:", message);
	const response = await (async () => {
		switch (message.type) {
			case 'getFileTokens':
				return await tokenStorageManager.getFileTokens(message.conversationId, message.filename, message.fileType);
			case 'saveFileTokens':
				return await tokenStorageManager.saveFileTokens(message.conversationId, message.filename, message.tokens, message.fileType);
			case 'getCheckboxStates':
				return await tokenStorageManager.getCheckboxStates();
			case 'setCheckboxState':
				return await tokenStorageManager.setCheckboxState(message.key, message.checked);
			case 'getCollapsedState':
				return await tokenStorageManager.getCollapsedState();
			case 'setCollapsedState':
				return await tokenStorageManager.setCollapsedState(message.isCollapsed);
			case 'calculateMessagesLeft':
				return await tokenStorageManager.calculateMessagesLeft(message.model, message.conversationLength);
			case 'getModelData':
				return await tokenStorageManager.getModelData(message.model);
			case 'getFormattedTimeRemaining':
				return await tokenStorageManager.getFormattedTimeRemaining(message.model);
			case 'getExtraCost':
				return await tokenStorageManager.getExtraCost();
			case 'addTokensToModel':
				return await tokenStorageManager.addTokensToModel(message.model, message.newTokens);
			case 'getConfig':
				return await getFreshConfig();
			case 'setUserId':
				return tokenStorageManager.setUserId(message.userId);
		}
	})();
	console.log("📤 Sending response:", response);
	return response;
}


browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
	handleMessage(message).then(sendResponse);
	return true;
});