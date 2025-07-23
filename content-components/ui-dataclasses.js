/* global config */
// ui-dataclasses.js - Global version for content scripts

class UsageData {
	constructor(data = {}) {
		// Raw model data (e.g., { Sonnet: { total: 1000, messageCount: 5 }, Opus: {...} })
		this.modelData = data.modelData || {};
		this.resetTimestamp = data.resetTimestamp || null;
		this.usageCap = data.usageCap || 0;
		this.subscriptionTier = data.subscriptionTier || 'claude_free';
	}

	// Calculate weighted total on demand
	getWeightedTotal() {
		let weightedTotal = 0;
		for (const [modelName, data] of Object.entries(this.modelData)) {
			if (data?.total) {
				const weight = config.MODEL_WEIGHTS[modelName] || 1;
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
		return this.getUsagePercentage() >= (config.WARNING_THRESHOLD * 100);
	}

	// Get time until reset
	getTimeUntilReset() {
		if (!this.resetTimestamp) return null;

		const now = Date.now();
		const diff = this.resetTimestamp - now;

		if (diff <= 0) return { expired: true, hours: 0, minutes: 0 };

		return {
			expired: false,
			hours: Math.floor(diff / (1000 * 60 * 60)),
			minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
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
			usageCap: usageCap,
			subscriptionTier: subscriptionTier
		});
	}

	toModelData() {
		// Convert to the format used in browser.storage (Model data only)
		return {
			...this.modelData,
			resetTimestamp: this.resetTimestamp
		};
	}

	toJSON() {
		return {
			modelData: this.modelData,
			resetTimestamp: this.resetTimestamp,
			usageCap: this.usageCap,
			subscriptionTier: this.subscriptionTier
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
			resetTimestamp: this.resetTimestamp
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
		const currentTime = Date.now();

		// Determine which reset timestamp to use
		let mergedResetTimestamp;
		if (!remoteUsageData.resetTimestamp ||
			(localUsageData.resetTimestamp && localUsageData.resetTimestamp > remoteUsageData.resetTimestamp)) {
			mergedResetTimestamp = localUsageData.resetTimestamp;
		} else {
			mergedResetTimestamp = remoteUsageData.resetTimestamp;
		}

		// If the merged reset timestamp is in the past, return empty data
		if (mergedResetTimestamp && mergedResetTimestamp < currentTime) {
			return new UsageData({
				resetTimestamp: mergedResetTimestamp,
				usageCap: localUsageData.usageCap,
				subscriptionTier: localUsageData.subscriptionTier
			});
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
			usageCap: Math.max(localUsageData.usageCap, remoteUsageData.usageCap),
			subscriptionTier: localUsageData.subscriptionTier || remoteUsageData.subscriptionTier
		});
	}
}

class ConversationData {
	constructor(data = {}) {
		this.conversationId = data.conversationId;
		this.messages = data.messages || [];

		// Calculated metrics
		this.length = data.length || 0;  // Total tokens in conversation
		this.cost = data.cost || 0;      // Token cost (with caching considered)
		this.futureCost = data.futureCost || 0; // Estimated cost of future messages
		this.model = data.model || 'Sonnet';

		// Cache status
		this.costUsedCache = data.costUsedCache || false;
		this.conversationIsCachedUntil = data.conversationIsCachedUntil || null;

		// Associated metadata
		this.projectUuid = data.projectUuid || null;
		this.styleId = data.styleId || null;
		this.settings = data.settings || {};
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
	getWeightedCost() {
		const weight = config.MODEL_WEIGHTS[this.model] || 1;
		return Math.round(this.cost * weight);
	}

	getWeightedFutureCost() {
		const weight = config.MODEL_WEIGHTS[this.model] || 1;
		return Math.round(this.futureCost * weight);
	}

	// Check if conversation is expensive
	isExpensive() {
		return this.cost >= config.WARNING.COST;
	}

	// Check if conversation is long
	isLong() {
		return this.length >= config.WARNING.LENGTH;
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
			settings: this.settings
		};
	}

	static fromJSON(json) {
		return new ConversationData(json);
	}
}