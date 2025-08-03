import { CONFIG, sleep, RawLog, StoredMap, getStorageValue, setStorageValue, getOrgStorageKey } from './utils.js';
import { UsageData, ConversationData } from './bg-dataclasses.js';
import { tokenStorageManager } from './tokenManagement.js';
// Create component-specific logger
async function Log(...args) {
	await RawLog("firebase", ...args)
}

// Firebase sync manager
class FirebaseSyncManager {
	constructor() {
		this.firebase_base_url = "https://claude-usage-tracker-default-rtdb.europe-west1.firebasedatabase.app";
		this.isSyncing = false;
		this.isSyncingCapHits = false;
		this.deviceStateMap = new StoredMap("deviceStates"); // Unified map for device states
		this.resetCounters = new StoredMap("resetCounters");
		this.updateCallback = async () => { };  // Default no-op callback
	}

	setUpdateAllTabsCallback(callback) {
		this.updateAllTabs = callback;
	}

	async triggerReset(orgId) {
		await Log(`Triggering reset for org ${orgId}`);

		// Get current local counter
		const localCounter = await this.resetCounters.get(orgId) || 0;
		const newCounter = localCounter + 1;
		await this.resetCounters.set(orgId, newCounter);

		const lockerId = `firebase_reset_${Date.now()}`;

		try {
			await tokenStorageManager.acquireLock(lockerId);
			await this.clearOrgData(orgId, true, lockerId);
			await this.updateAllTabs();

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
		} finally {
			tokenStorageManager.releaseLock(lockerId);
		}
	}

	async clearOrgData(orgId, cleanRemote = false, lockerId = null) {
		await tokenStorageManager.clearModelData(orgId, lockerId);
		await setStorageValue(
			getOrgStorageKey(orgId, 'lastSyncHash'),
			null
		);
		if (cleanRemote) {
			const emptyUsageData = new UsageData({ usageCap: 0 });
			await this.uploadData(orgId, emptyUsageData, await this.ensureDeviceId());
		}

		await Log(`Cleared all data for org ${orgId}`);
	}

	async syncWithFirebase() {
		if (this.isSyncing) {
			await Log("Sync already in progress, skipping");
			return;
		}

		this.isSyncing = true;
		const lockerId = `firebase_sync_${Date.now()}`;

		try {
			await tokenStorageManager.acquireLock(lockerId);
			await tokenStorageManager.ensureOrgIds();
			const deviceId = await this.ensureDeviceId();

			for (const orgId of tokenStorageManager.orgIds) {
				await this.syncSingleOrg(orgId, deviceId, lockerId);
			}

			await Log("=== SYNC COMPLETED SUCCESSFULLY, UPDATING TABS ===");
			await this.updateAllTabs();
		} catch (error) {
			await Log("error", '=== SYNC FAILED ===');
			await Log("error", 'Error details:', error);
			await Log("error", 'Stack:', error.stack);
		} finally {
			this.isSyncing = false;
			tokenStorageManager.releaseLock(lockerId);
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
			const groupedCapHits = {};
			for (const [key, value] of (await tokenStorageManager.capHits.entries())) {
				const orgId = key.split(':')[0];
				if (!groupedCapHits[orgId]) {
					groupedCapHits[orgId] = {};
				}
				groupedCapHits[orgId][key] = value;
			}

			// Sync each orgId's data to Firebase
			for (const [orgId, capHits] of Object.entries(groupedCapHits)) {
				// Transform the data
				const transformedCapHits = {};
				for (const [_, capHitData] of Object.entries(capHits)) {
					const newKey = `${capHitData.model}:${capHitData.reset_time}`;
					transformedCapHits[newKey] = {
						total: capHitData.total,
						reset_time: capHitData.reset_time,
						warning_time: capHitData.warning_time,
						model: capHitData.model,
						tier: capHitData.tier,
						accurateCount: capHitData.accurateCount
					};
				}

				const url = `${this.firebase_base_url}/users/${orgId}/cap_hits.json`;

				// Use PATCH instead of PUT
				const writeResponse = await fetch(url, {
					method: 'PATCH',  // ← Changed from PUT
					body: JSON.stringify(transformedCapHits)
				});

				if (!writeResponse.ok) {
					throw new Error(`Write failed! status: ${writeResponse.status}`);
				}
			}

			// Clear the local map after successful sync
			await tokenStorageManager.capHits.clear();  // ← Add this method to StoredMap

			await Log("=== CAP HITS SYNC COMPLETED, LOCAL MAP CLEARED ===");
		} catch (error) {
			await Log("error", '=== CAP HITS SYNC FAILED ===');
			await Log("error", 'Error details:', error);
		} finally {
			this.isSyncingCapHits = false;
		}
	}

	// Helper methods
	async ensureDeviceId() {
		let deviceId = await getStorageValue('deviceId');
		if (!deviceId) {
			deviceId = crypto.randomUUID();
			await setStorageValue('deviceId', deviceId);
		}
		return deviceId;
	}

	async syncResetCounter(orgId, lockerId) {
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
			await this.clearOrgData(orgId, false, lockerId);
			// Update our local counter
			await this.resetCounters.set(orgId, remoteCounter);
			return true;
		}

		// Counters are equal, no reset needed
		return false;
	}

	async syncSingleOrg(orgId, deviceId, lockerId) {
		if (!orgId) return;

		try {
			// Check if we're the only device
			const isLoneDevice = await this.checkDevices(orgId);

			if (isLoneDevice) {
				await Log(`Lone device for org ${orgId}, skipping sync entirely.`);
				return;
			}

			// Check for resets before doing normal sync
			const resetProcessed = await this.syncResetCounter(orgId, lockerId);
			if (resetProcessed) {
				await Log(`Reset processed for org ${orgId}, continuing with sync`);
			}

			// Get local state + remote info
			const localState = await this.prepareLocalState(orgId, lockerId);
			const lastUpdateInfo = await this.getLastUpdateInfo(orgId);
			await Log("Remote info for org", orgId, ":", lastUpdateInfo);

			// Determine sync strategy
			const strategy = await this.determineSyncStrategy(localState, lastUpdateInfo, deviceId);
			let mergedUsageData = localState.localUsageData;

			if (strategy.shouldDownload) {
				mergedUsageData = await this.downloadAndMerge(orgId, localState.localUsageData);
			}

			if (strategy.shouldUpload) {
				await this.uploadData(orgId, mergedUsageData, deviceId);
			}

			// Update local storage - convert UsageData back to storage format
			await tokenStorageManager.setUsageData(orgId, mergedUsageData, lockerId);

			await setStorageValue(
				getOrgStorageKey(orgId, 'lastSyncHash'),
				localState.currentHashString
			);

		} catch (error) {
			await Log("error", `Error syncing org ${orgId}:`, error);
			throw error;
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

	async prepareLocalState(orgId, lockerId) {
		const localUsageData = await tokenStorageManager.getUsageData(orgId, 'claude_free', lockerId);
		const currentHashString = await localUsageData.getHash();

		const lastSyncHash = await getStorageValue(
			getOrgStorageKey(orgId, 'lastSyncHash')
		);

		const hasLocalChanges = !lastSyncHash || currentHashString !== lastSyncHash;
		await Log("We have local changes:", hasLocalChanges);

		return {
			localUsageData,
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

	async downloadAndMerge(orgId, localUsageData) {
		await Log("Downloading remote data");
		const usageUrl = `${this.firebase_base_url}/users/${orgId}/usage.json`;
		const usageResponse = await fetch(usageUrl);
		const remoteData = await usageResponse.json() || {};

		// Create UsageData from remote data
		const remoteUsageData = UsageData.fromModelData(
			remoteData,
			localUsageData.usageCap,  // Use local cap as source of truth
			"claude_free" // Dummy tier - not used for merging
		);

		// Use the static merge method
		const mergedUsageData = UsageData.merge(localUsageData, remoteUsageData);
		return mergedUsageData;
	}

	async uploadData(orgId, usageData, deviceId) {
		await Log("Uploading data and updating device ID");

		// Convert UsageData to storage format
		const dataToUpload = {
			...usageData.toModelData(),
			weightedTotal: usageData.getWeightedTotal()
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
const firebaseSyncManager = new FirebaseSyncManager()

export { firebaseSyncManager };