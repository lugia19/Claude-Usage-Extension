// bg-dataclasses.js - ES6 module version for background/service worker
// IMPORTANT: Keep in sync with ui_dataclasses.js

import { CONFIG, sleep, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, getOrgStorageKey } from './utils.js';

async function Log(...args) {
	await RawLog("dataclasses-bg", ...args);
}
export class UsageData {
	constructor(data = {}) {
		// Raw model data (e.g., { Sonnet: { total: 1000, messageCount: 5 }, Opus: {...} })
		this.modelData = data.modelData || {};
		this.resetTimestamp = data.resetTimestamp || null;
		this.usageCap = data.usageCap || 0;
		this.subscriptionTier = data.subscriptionTier || 'claude_free';
		this.isTimestampAuthoritative = data.isTimestampAuthoritative || false;
	}

	// Calculate weighted total on demand
	getWeightedTotal() {
		let weightedTotal = 0;
		for (const [modelName, data] of Object.entries(this.modelData)) {
			if (data?.total) {
				const weight = CONFIG.MODEL_WEIGHTS[modelName] || 1;
				weightedTotal += data.total * weight;
			}
		}
		return Math.round(weightedTotal);
	}

	// Get percentage used
	getUsagePercentage() {
		if (!this.usageCap) return 0;
		return (this.getWeightedTotal() / this.usageCap) * 100;
	}

	// Check if approaching or exceeding limit
	isNearLimit() {
		return this.getUsagePercentage() >= (CONFIG.WARNING_THRESHOLD * 100);
	}

	// Get time until reset
	getResetTimeInfo() {
		return {
			timestamp: this.resetTimestamp,
			expired: this.resetTimestamp ? this.resetTimestamp <= Date.now() : false
		};
	}

	// Check if data is expired
	isExpired() {
		return this.resetTimestamp && Date.now() >= this.resetTimestamp;
	}

	// Get model-specific data
	getModelData(modelName) {
		return this.modelData[modelName] || { total: 0, messageCount: 0 };
	}

	// Get total for a specific model (raw, not weighted)
	getModelTotal(modelName) {
		return this.getModelData(modelName).total;
	}

	// Create from storage format (Model data + reset timestamp)
	static fromModelData(storageData, usageCap, subscriptionTier) {
		return new UsageData({
			modelData: storageData || {},
			resetTimestamp: storageData?.resetTimestamp,
			isTimestampAuthoritative: storageData?.isTimestampAuthoritative || false,
			usageCap: usageCap,
			subscriptionTier: subscriptionTier
		});
	}

	toModelData() {
		// Convert to the format used in browser.storage (Model data only)
		return {
			...this.modelData,
			resetTimestamp: this.resetTimestamp,
			isTimestampAuthoritative: this.isTimestampAuthoritative 
		};
	}

	toJSON() {
		return {
			modelData: this.modelData,
			resetTimestamp: this.resetTimestamp,
			usageCap: this.usageCap,
			subscriptionTier: this.subscriptionTier,
			isTimestampAuthoritative: this.isTimestampAuthoritative 
		};
	}

	static fromJSON(json) {
		return new UsageData(json);
	}

	addTokensToModel(model, newTokens) {
		const currentData = this.getModelData(model);
		this.modelData[model] = {
			total: currentData.total + newTokens,
			messageCount: currentData.messageCount + 1
		};
	}

	async getHash() {
		// Create a consistent object for hashing
		const hashObject = {
			modelData: this.modelData,
			resetTimestamp: this.resetTimestamp,
			isTimestampAuthoritative: this.isTimestampAuthoritative // Include in hash
		};

		const hash = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify(hashObject))
		);

		return Array.from(new Uint8Array(hash))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
	}

	static merge(localUsageData, remoteUsageData) {
		// Check which data is still valid
		const localExpired = localUsageData.isExpired();
		const remoteExpired = remoteUsageData.isExpired();

		// If both expired, return null
		if (localExpired && remoteExpired) {
			return new UsageData();
		}

		// If one is expired, return the other
		if (localExpired) {
			return remoteUsageData;
		}
		if (remoteExpired) {
			return localUsageData;
		}

		// Both are valid, merge them
		// Determine which timestamp to use based on authoritative flag
		let mergedResetTimestamp;
		let mergedIsAuthoritative;
		
		if (remoteUsageData.isTimestampAuthoritative && !localUsageData.isTimestampAuthoritative) {
			// Remote is authoritative, local is not - use remote
			mergedResetTimestamp = remoteUsageData.resetTimestamp;
			mergedIsAuthoritative = true;
		} else if (localUsageData.isTimestampAuthoritative && !remoteUsageData.isTimestampAuthoritative) {
			// Local is authoritative, remote is not - use local
			mergedResetTimestamp = localUsageData.resetTimestamp;
			mergedIsAuthoritative = true;
		} else {
			// Both are authoritative (shouldn't happen) or neither is - use max as before
			mergedResetTimestamp = Math.max(
				localUsageData.resetTimestamp || 0,
				remoteUsageData.resetTimestamp || 0
			);
			// Keep authoritative flag if either had it
			mergedIsAuthoritative = localUsageData.isTimestampAuthoritative || remoteUsageData.isTimestampAuthoritative;
		}

		// Merge model data
		const mergedModelData = {};
		const allModels = new Set([
			...Object.keys(localUsageData.modelData),
			...Object.keys(remoteUsageData.modelData)
		]);

		for (const model of allModels) {
			const local = localUsageData.getModelData(model);
			const remote = remoteUsageData.getModelData(model);

			mergedModelData[model] = {
				total: Math.max(local.total, remote.total),
				messageCount: Math.max(local.messageCount, remote.messageCount)
			};
		}

		return new UsageData({
			modelData: mergedModelData,
			resetTimestamp: mergedResetTimestamp,
			isTimestampAuthoritative: mergedIsAuthoritative,
			usageCap: Math.max(localUsageData.usageCap, remoteUsageData.usageCap),
			subscriptionTier: localUsageData.subscriptionTier || remoteUsageData.subscriptionTier
		});
	}
}

export class ConversationData {
	constructor(data = {}) {
		this.conversationId = data.conversationId;
		this.messages = data.messages || [];

		// Calculated metrics
		this.length = data.length || 0;  // Total tokens in conversation
		this.cost = data.cost || 0;      // Token cost (with caching considered)
		this.futureCost = data.futureCost || 0; // Estimated cost of future messages
		this.model = data.model || 'Sonnet';

		// Cache status
		this.costUsedCache = data.costUsedCache || false;	//Currently unused, since now we show future_cost rather than past cost
		this.conversationIsCachedUntil = data.conversationIsCachedUntil || null;

		// Associated metadata
		this.projectUuid = data.projectUuid || null;
		this.styleId = data.styleId || null;
		this.settings = data.settings || {};
		this.lastMessageTimestamp = data.lastMessageTimestamp || null; // Timestamp of the last message in the conversation
	}

	// Add helper method to check if currently cached
	isCurrentlyCached() {
		return this.conversationIsCachedUntil && this.conversationIsCachedUntil > Date.now();
	}

	// Add method to get time until cache expires
	getTimeUntilCacheExpires() {
		if (!this.conversationIsCachedUntil) return null;

		const now = Date.now();
		const diff = this.conversationIsCachedUntil - now;

		if (diff <= 0) return { expired: true, minutes: 0 };

		return {
			expired: false,
			minutes: Math.ceil(diff / (1000 * 60))  // Round up to nearest minute
		};
	}


	// Calculate weighted cost based on model
	getWeightedCost(modelOverride) {
		let model = this.model;
		if (modelOverride) model = modelOverride;
		const weight = CONFIG.MODEL_WEIGHTS[model] || 1;
		return Math.round(this.cost * weight);
	}

	getWeightedFutureCost(modelOverride) {
		let model = this.model;
		if (modelOverride) model = modelOverride;
		const weight = CONFIG.MODEL_WEIGHTS[model] || 1;
		return Math.round(this.futureCost * weight);
	}

	// Check if conversation is expensive
	isExpensive() {
		return this.cost >= CONFIG.WARNING.COST;
	}

	// Check if conversation is long
	isLong() {
		return this.length >= CONFIG.WARNING.LENGTH;
	}

	toJSON() {
		return {
			conversationId: this.conversationId,
			messages: this.messages,
			length: this.length,
			cost: this.cost,
			futureCost: this.futureCost,
			model: this.model,
			costUsedCache: this.costUsedCache,
			conversationIsCachedUntil: this.conversationIsCachedUntil,
			projectUuid: this.projectUuid,
			styleId: this.styleId,
			settings: this.settings,
			lastMessageTimestamp: this.lastMessageTimestamp
		};
	}

	static fromJSON(json) {
		return new ConversationData(json);
	}
}