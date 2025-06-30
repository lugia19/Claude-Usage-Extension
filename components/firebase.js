import { CONFIG, sleep, RawLog, StoredMap } from './utils.js';

// Create component-specific logger
async function Log(...args) {
	await RawLog("firebase", ...args)
}

// Firebase sync manager
class FirebaseSyncManager {
	constructor(tokenStorageManager, updateAllTabsCallback) {
		this.tokenStorage = tokenStorageManager;
		this.updateAllTabs = updateAllTabsCallback;
		this.firebase_base_url = "https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app";
		this.isSyncing = false;
		this.isSyncingCapHits = false;
		this.deviceStateMap = new StoredMap("deviceStates"); // Unified map for device states
		this.resetCounters = new StoredMap("resetCounters");
	}

	async triggerReset(orgId) {
		await Log(`Triggering reset for org ${orgId}`);

		// Get current local counter
		const localCounter = await this.resetCounters.get(orgId) || 0;
		const newCounter = localCounter + 1;

		// Update local counter immediately
		await this.resetCounters.set(orgId, newCounter);

		// Clear our own data
		await this.clearOrgData(orgId, true);
		await this.updateAllTabs();

		// Attempt to update remote counter if we're not a lone device
		const isLoneDevice = await this.checkDevices(orgId);
		if (!isLoneDevice) {
			const resetCounterUrl = `${this.firebase_base_url}/users/${orgId}/reset_counter.json`;
			await fetch(resetCounterUrl, {
				method: 'PUT',
				body: JSON.stringify({
					value: newCounter,
					lastReset: Date.now(),
					triggeredBy: await this.ensureDeviceId()
				})
			});
		}

		await Log(`Reset completed for org ${orgId}, new counter: ${newCounter}`);
		return true;
	}

	async clearOrgData(orgId, cleanRemote = false) {
		// Clear models data
		await this.tokenStorage.setValue(
			this.tokenStorage.getStorageKey(orgId, 'models'),
			{}
		);

		// Clear related data
		await this.tokenStorage.setValue(
			this.tokenStorage.getStorageKey(orgId, 'lastSyncHash'),
			null
		);

		// Write empty data back to Firebase
		if (cleanRemote) {
			await this.uploadData(orgId, {}, await this.ensureDeviceId());
		}

		await Log(`Cleared all data for org ${orgId}`);
	}

	async syncWithFirebase() {
		if (this.isSyncing) {
			await Log("Sync already in progress, skipping");
			return;
		}

		this.isSyncing = true;
		this.tokenStorage.setExternalLock(true);
		await Log("=== FIREBASE SYNC STARTING ===");

		try {
			await this.tokenStorage.ensureOrgIds();
			const deviceId = await this.ensureDeviceId();
			await Log("Syncing device ID:", deviceId);
			for (const orgId of this.tokenStorage.orgIds) {
				await this.syncSingleOrg(orgId, deviceId);
			}

			await Log("=== SYNC COMPLETED SUCCESSFULLY, UPDATING TABS ===");
			await this.updateAllTabs();
		} catch (error) {
			await Log("error", '=== SYNC FAILED ===');
			await Log("error", 'Error details:', error);
			await Log("error", 'Stack:', error.stack);
		} finally {
			this.isSyncing = false;
			this.tokenStorage.setExternalLock(false);
		}
	}

	async checkDevices(orgId) {
		const now = Date.now();
		const deviceState = await this.deviceStateMap.get(orgId) || {
			lastCheckTime: 0,
			isLoneDevice: true,
			lastUploadTime: 0
		};
		if (deviceState.isLoneDevice === undefined) deviceState.isLoneDevice = true;

		const deviceId = await this.ensureDeviceId();
		const devicesUrl = `${this.firebase_base_url}/users/${orgId}/devices_seen.json`;

		// PART 1: Update our own device presence if needed (once per 24h)
		const UPLOAD_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

		if (!deviceState.lastUploadTime || now - deviceState.lastUploadTime > UPLOAD_INTERVAL) {
			await Log(`Updating our device presence for ${orgId} (hasn't been updated in 24h)`);

			// Use PATCH to only update our specific device
			const devicePatchUrl = `${this.firebase_base_url}/users/${orgId}/devices_seen/${deviceId}.json`;

			await fetch(devicePatchUrl, {
				method: 'PATCH',
				body: JSON.stringify({
					timestamp: now
				})
			});

			// Update our last upload time
			deviceState.lastUploadTime = now;
			await this.deviceStateMap.set(orgId, deviceState);
		}

		// PART 2: Check for other devices with adaptive interval
		// Use shorter interval (15min) for lone devices, longer (60min) for multi-device
		const MULTI_DEVICE_CHECK_INTERVAL = 60 * 60 * 1000; // 60 minutes
		const DEVICE_CHECK_INTERVAL = 5 * 60 * 1000;
		const checkInterval = deviceState.isLoneDevice ?
			DEVICE_CHECK_INTERVAL : // 15 minutes for lone devices
			MULTI_DEVICE_CHECK_INTERVAL; // 60 minutes for multi-device setups

		if (now - deviceState.lastCheckTime < checkInterval) {
			await Log(`Using cached device state for ${orgId}: isLoneDevice=${deviceState.isLoneDevice}, last checked ${Math.round((now - deviceState.lastCheckTime) / 1000)}s ago, next check in ${Math.round((checkInterval - (now - deviceState.lastCheckTime)) / 1000)}s`);
			return deviceState.isLoneDevice;
		}

		try {
			// Download all devices
			const response = await fetch(devicesUrl);
			const devices = await response.json() || {};

			// Filter out stale devices (older than 7 days)
			const cutoffTime = now - (7 * 24 * 60 * 60 * 1000);
			let deviceCount = 0;

			for (const [id, data] of Object.entries(devices)) {
				if (data.timestamp > cutoffTime) {
					deviceCount++;
				}
			}

			// Determine if we're the only active device
			const wasLoneDevice = deviceState.isLoneDevice;
			deviceState.isLoneDevice = deviceCount === 1;
			deviceState.lastCheckTime = now;

			await this.deviceStateMap.set(orgId, deviceState);

			await Log(`Device check for ${orgId}: ${deviceCount} active devices, isLoneDevice: ${deviceState.isLoneDevice}, was lone device: ${wasLoneDevice}, next check in ${deviceState.isLoneDevice ? '15min' : '60min'}`);
			return deviceState.isLoneDevice;
		} catch (error) {
			await Log("error", "Error checking devices:", error);
			return false; // Default to false on error (do sync)
		}
	}

	async syncCapHits() {
		if (this.isSyncingCapHits) {
			await Log("Cap hits sync already in progress, skipping");
			return;
		}

		this.isSyncingCapHits = true;
		await Log("=== CAP HITS SYNC STARTING ===");
		try {
			// Group all entries by orgId
			const groupedResets = {};
			for (const [key, value] of (await this.tokenStorage.resetsHit.entries())) {
				const orgId = key.split(':')[0];
				if (!groupedResets[orgId]) {
					groupedResets[orgId] = {};
				}
				groupedResets[orgId][key] = value;
			}
			// Sync each orgId's data to Firebase
			for (const [orgId, resets] of Object.entries(groupedResets)) {
				// Transform the data to use model:timestamp as keys
				const transformedResets = {};
				for (const [_, resetData] of Object.entries(resets)) {
					const newKey = `${resetData.model}:${resetData.reset_time}`;
					transformedResets[newKey] = {
						total: resetData.total,
						reset_time: resetData.reset_time,
						warning_time: resetData.warning_time,
						model: resetData.model,
						tier: resetData.tier,
						accurateCount: resetData.accurateCount
					};
				}
				await Log("Transformed cap hits:", transformedResets)

				const url = `${this.firebase_base_url}/users/${orgId}/cap_hits.json`;
				await Log("Writing cap hits for orgId:", orgId);

				const writeResponse = await fetch(url, {
					method: 'PUT',
					body: JSON.stringify(transformedResets)
				});
				if (!writeResponse.ok) {
					throw new Error(`Write failed! status: ${writeResponse.status}`);
				}
			}
			await Log("=== CAP HITS SYNC COMPLETED SUCCESSFULLY ===");
		} catch (error) {
			await Log("error", '=== CAP HITS SYNC FAILED ===');
			await Log("error", 'Error details:', error);
		} finally {
			this.isSyncingCapHits = false;
		}
	}

	// Helper methods
	async ensureDeviceId() {
		let deviceId = await browser.storage.local.get('deviceId');
		if (!deviceId?.deviceId) {
			deviceId = crypto.randomUUID();
			await browser.storage.local.set({ deviceId });
		} else {
			deviceId = deviceId.deviceId;
		}
		return deviceId;
	}

	async syncResetCounter(orgId) {
		const resetCounterUrl = `${this.firebase_base_url}/users/${orgId}/reset_counter.json`;
		const response = await fetch(resetCounterUrl);
		const remoteData = await response.json();
		const remoteCounter = remoteData?.value || 0;

		// Get local counter
		const localCounter = await this.resetCounters.get(orgId) || 0;

		await Log(`Reset counters for ${orgId}: local=${localCounter}, remote=${remoteCounter}`);

		if (localCounter > remoteCounter) {
			// If our local counter is higher, update the remote
			await Log(`Local reset counter is higher, updating remote to ${localCounter}`);
			await fetch(resetCounterUrl, {
				method: 'PUT',
				body: JSON.stringify({
					value: localCounter,
					lastReset: Date.now(),
					triggeredBy: await this.ensureDeviceId()
				})
			});
			// We've already reset our data when the trigger happened locally
			return true;

		} else if (remoteCounter > localCounter) {
			// If remote counter is higher, we need to reset
			await Log(`Remote reset counter is higher, resetting local data`);

			// Clear our data
			await this.clearOrgData(orgId);

			// Update our local counter
			await this.resetCounters.set(orgId, remoteCounter);

			return true;
		}

		// Counters are equal, no reset needed
		return false;
	}

	async syncSingleOrg(orgId, deviceId) {
		if (!orgId) return
		try {
			// Check if we're the only device
			const isLoneDevice = await this.checkDevices(orgId);

			if (isLoneDevice) {
				await Log(`Lone device for org ${orgId}, skipping sync entirely.`);
				return;
			}

			// Check for resets before doing normal sync
			const resetProcessed = await this.syncResetCounter(orgId);

			// If we just processed a reset, we should still continue with sync
			// to get any other changes, but log it for debugging
			if (resetProcessed) {
				await Log(`Reset processed for org ${orgId}, continuing with sync`);
			}

			// Get local state + remote info
			const localState = await this.prepareLocalState(orgId);
			const lastUpdateInfo = await this.getLastUpdateInfo(orgId);
			await Log("Remote info for org", orgId, ":", lastUpdateInfo);

			// Determine sync strategy
			const strategy = await this.determineSyncStrategy(localState, lastUpdateInfo, deviceId);
			let mergedModels = localState.localModels;

			if (strategy.shouldDownload) {
				mergedModels = await this.downloadAndMerge(orgId, localState.localModels);
			}

			if (strategy.shouldUpload) {
				await this.uploadData(orgId, mergedModels, deviceId);
			}

			// Update local storage
			await this.tokenStorage.setValue(
				this.tokenStorage.getStorageKey(orgId, 'models'),
				mergedModels
			);
			await this.tokenStorage.setValue(
				this.tokenStorage.getStorageKey(orgId, 'lastSyncHash'),
				localState.currentHashString
			);

		} catch (error) {
			await Log("error", `Error syncing org ${orgId}:`, error);
			throw error; // Re-throw to handle it in the caller
		}
	}

	async determineSyncStrategy(localState, remoteInfo, deviceId) {
		const noRemoteData = !remoteInfo.deviceId;
		const isAnotherDeviceData = remoteInfo.deviceId !== deviceId;
		const hasLocalChanges = localState.hasLocalChanges;

		const shouldDownload = noRemoteData || isAnotherDeviceData || hasLocalChanges;

		let shouldUpload = false;
		let uploadReason = "";

		if (noRemoteData) {
			shouldUpload = true;
			uploadReason = "noRemoteData";
		} else {
			shouldUpload = hasLocalChanges;
			uploadReason = "localChanges";
		}

		await Log("Sync decisions:", {
			shouldDownload,
			shouldUpload,
			uploadReason,
			reasons: {
				noRemoteData,
				isAnotherDeviceData,
				hasLocalChanges
			}
		});

		return { shouldDownload, shouldUpload, uploadReason };
	}

	async prepareLocalState(orgId) {
		const localModels = await this.tokenStorage.getValue(
			this.tokenStorage.getStorageKey(orgId, 'models')
		) || {};

		const currentHash = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify(localModels))
		);

		const currentHashString = Array.from(new Uint8Array(currentHash))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');

		const lastSyncHash = await this.tokenStorage.getValue(
			this.tokenStorage.getStorageKey(orgId, 'lastSyncHash')
		);

		const hasLocalChanges = !lastSyncHash || currentHashString !== lastSyncHash;
		await Log("We have local changes:", hasLocalChanges);
		return {
			localModels,
			currentHashString,
			hasLocalChanges
		};
	}

	async getLastUpdateInfo(orgId) {
		const lastUpdateUrl = `${this.firebase_base_url}/users/${orgId}/last_update.json`;
		const response = await fetch(lastUpdateUrl);
		const remoteUpdate = await response.json();

		return {
			deviceId: remoteUpdate?.deviceId,
			timestamp: remoteUpdate?.timestamp
		};
	}

	async downloadAndMerge(orgId, localModels) {
		await Log("Downloading remote data");
		const usageUrl = `${this.firebase_base_url}/users/${orgId}/usage.json`;
		const usageResponse = await fetch(usageUrl);
		const remoteUsage = await usageResponse.json() || {};

		const mergedModels = await this.tokenStorage.mergeModelData(localModels, remoteUsage);
		return mergedModels;
	}

	async uploadData(orgId, models, deviceId) {
		await Log("Uploading data and updating device ID");

		// Calculate weighted total before uploading
		let weightedTotal = 0;
		for (const [modelName, modelData] of Object.entries(models)) {
			if (modelName !== 'resetTimestamp' && modelData?.total) {
				const weight = CONFIG.MODEL_WEIGHTS[modelName] || 1;
				weightedTotal += modelData.total * weight;
			}
		}

		// Add weighted total to the data structure
		const dataToUpload = {
			...models,
			weightedTotal: Math.round(weightedTotal)
		};

		// Upload models with weighted total
		const usageUrl = `${this.firebase_base_url}/users/${orgId}/usage.json`;
		const writeResponse = await fetch(usageUrl, {
			method: 'PUT',
			body: JSON.stringify(dataToUpload)
		});

		if (!writeResponse.ok) {
			throw new Error(`Write failed! status: ${writeResponse.status}`);
		}

		// Update last update info
		const lastUpdateUrl = `${this.firebase_base_url}/users/${orgId}/last_update.json`;
		await fetch(lastUpdateUrl, {
			method: 'PUT',
			body: JSON.stringify({
				deviceId: deviceId,
				timestamp: Date.now()
			})
		});
	}
}

export { FirebaseSyncManager };