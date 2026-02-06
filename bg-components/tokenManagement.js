/* global GPTTokenizer_o200k_base */
import { CONFIG, sleep, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, removeStorageValue } from './utils.js';

// Create component-specific logger
async function Log(...args) {
	await RawLog("tokenManagement", ...args);
}

// Move getTextFromContent here since it's token-related
async function getTextFromContent(content, includeEphemeral = false, api = null, orgId = null) {
	let textPieces = [];

	if (content.text) {
		textPieces.push(content.text);
	}

	if (content.thinking && includeEphemeral) {
		textPieces.push(content.thinking);
	}

	if (content.input) {
		textPieces.push(JSON.stringify(content.input));
	}
	if (content.content) {
		if (Array.isArray(content.content)) {
			if (content.type !== "tool_result" || includeEphemeral) {
				for (const nestedContent of content.content) {
					textPieces = textPieces.concat(await getTextFromContent(nestedContent, includeEphemeral, api, orgId));
				}
			}
		}
		else if (typeof content.content === 'object') {
			textPieces = textPieces.concat(await getTextFromContent(content.content, includeEphemeral, api, orgId));
		}
	}

	if (content.type === "knowledge" && includeEphemeral) {
		if (content.url && content.url.length > 0) {
			if (content.url.includes("docs.google.com")) {
				if (api && orgId) {
					const docUuid = content.metadata?.uri;
					if (docUuid) {
						const syncObj = { type: "gdrive", config: { uri: docUuid } };
						await Log("Fetching Google Drive document content:", content.url, "with sync object:", syncObj);
						try {
							const syncText = await api.getSyncText(syncObj);
							if (syncText) {
								textPieces.push(syncText);
								await Log("Retrieved Google Drive document content successfully:", syncText);
							}
						} catch (error) {
							await Log("error", "Error fetching Google Drive document:", error);
						}
					} else {
						await Log("error", "Could not extract document UUID from URL or metadata");
					}
				} else {
					await Log("warn", "API or orgId not provided, cannot fetch Google Drive document");
				}
			}
		}
	}

	return textPieces;
}

class TokenCounter {
	constructor() {
		this.tokenizer = GPTTokenizer_o200k_base;
		this.ESTIMATION_MULTIPLIER = 1.2;
		this.fileTokenCache = new StoredMap("fileTokens");
	}

	// Core text counting - the main workhorse
	async countText(text) {
		if (!text) return 0;

		// Try API first if available
		const apiKey = await this.getApiKey();
		if (apiKey) {
			try {
				const tokens = await this.callMessageAPI([text], [], apiKey);
				if (tokens > 0) return tokens;
			} catch (error) {
				await Log("warn", "API token counting failed, falling back to estimation:", error);
			}
		}

		// Fallback to local estimation
		return Math.round(this.tokenizer.countTokens(text) * this.ESTIMATION_MULTIPLIER);
	}

	// Count a conversation's messages
	async countMessages(userMessages, assistantMessages) {
		const apiKey = await this.getApiKey();
		if (apiKey) {
			try {
				const tokens = await this.callMessageAPI(userMessages, assistantMessages, apiKey);
				if (tokens > 0) return tokens;
			} catch (error) {
				await Log("warn", "API message counting failed, falling back to estimation:", error);
			}
		}

		// Fallback: sum all messages using local estimation directly
		let total = 0;
		for (const msg of [...userMessages, ...assistantMessages]) {
			// Use the tokenizer directly to avoid redundant API attempts
			total += Math.round(this.tokenizer.countTokens(msg) * this.ESTIMATION_MULTIPLIER);
		}
		return total;
	}

	// Count file tokens with caching
	async getNonTextFileTokens(fileContent, mediaType, fileMetadata, orgId) {
		// Check cache first
		const cacheKey = `${orgId}:${fileMetadata.file_uuid}`;
		const cachedValue = await this.fileTokenCache.get(cacheKey);
		if (cachedValue !== undefined) {
			await Log(`Using cached token count for file ${fileMetadata.file_uuid}: ${cachedValue}`);
			return cachedValue;
		}

		const apiKey = await this.getApiKey();
		let tokens = 0;

		if (apiKey && fileContent) {
			try {
				tokens = await this.callFileAPI(fileContent, mediaType, apiKey);
				if (tokens > 0) {
					await this.fileTokenCache.set(cacheKey, tokens);
					return tokens;
				}
			} catch (error) {
				await Log("warn", "API file counting failed, falling back to estimation:", error);
			}
		}

		// Fallback to estimation using file metadata
		tokens = this.estimateFileTokens(fileMetadata);
		await this.fileTokenCache.set(cacheKey, tokens);
		return tokens;
	}

	// Estimate file tokens based on type
	estimateFileTokens(fileMetadata) {
		if (fileMetadata.file_kind === "image") {
			const width = fileMetadata.preview_asset.image_width;
			const height = fileMetadata.preview_asset.image_height;
			return Math.min(1600, Math.ceil((width * height) / 750));
		} else if (fileMetadata.file_kind === "document") {
			return 2250 * fileMetadata.document_asset.page_count;
		}
		return 0;
	}

	async callMessageAPI(userMessages, assistantMessages, apiKey) {
		const messages = this.formatMessagesForAPI(userMessages, assistantMessages);

		const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'Access-Control-Allow-Origin': '*',
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify({
				messages,
				model: "claude-sonnet-4-5"
			})
		});

		const data = await response.json();
		if (data.error) {
			throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
		}

		return data.input_tokens || 0;
	}

	// API call for files
	async callFileAPI(fileContent, mediaType, apiKey) {
		const fileData = {
			type: mediaType.startsWith('image/') ? 'image' : 'document',
			source: {
				type: 'base64',
				media_type: mediaType,
				data: fileContent
			}
		};

		const messages = [{
			role: "user",
			content: [
				fileData,
				{ type: "text", text: "1" } // Minimal text required
			]
		}];

		const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
			method: 'POST',
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'Access-Control-Allow-Origin': '*',
				"anthropic-dangerous-direct-browser-access": "true"
			},
			body: JSON.stringify({
				messages,
				model: "claude-sonnet-4-5"
			})
		});

		const data = await response.json();
		if (data.error) {
			throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
		}

		return data.input_tokens || 0;
	}

	// Format messages for the API
	formatMessagesForAPI(userMessages, assistantMessages) {
		const messages = [];
		const maxLength = Math.max(userMessages.length, assistantMessages.length);

		for (let i = 0; i < maxLength; i++) {
			if (i < userMessages.length) {
				messages.push({ role: "user", content: userMessages[i] });
			}
			if (i < assistantMessages.length) {
				messages.push({ role: "assistant", content: assistantMessages[i] });
			}
		}

		return messages;
	}

	// Helper to get API key
	async getApiKey() {
		return await getStorageValue('apiKey');
	}

	// Test if API key is valid
	async testApiKey(apiKey) {
		try {
			const tokens = await this.callMessageAPI(["Test"], [], apiKey);
			return tokens > 0;
		} catch (error) {
			await Log("error", "API key test failed:", error);
			return false;
		}
	}
}

// Token storage manager (simplified - only org ID tracking and total tokens)
class TokenStorageManager {
	constructor() {
		this.orgIds = undefined;
	}

	async ensureOrgIds() {
		if (this.orgIds) return;
		try {
			const orgIds = await getStorageValue('orgIds', []);
			this.orgIds = new Set(orgIds);
		} catch (error) {
			this.orgIds = new Set();
		}
	}

	async addOrgId(orgId) {
		await this.ensureOrgIds();
		if (!this.orgIds.has(orgId)) {
			this.orgIds.add(orgId);
			await setStorageValue('orgIds', Array.from(this.orgIds));
		}
	}

	async getTotalTokens() {
		return await getStorageValue('totalTokensTracked', 0);
	}

	async addToTotalTokens(tokens) {
		const current = await this.getTotalTokens();
		await setStorageValue('totalTokensTracked', current + tokens);
	}
}

const tokenCounter = new TokenCounter();
const tokenStorageManager = new TokenStorageManager();
export { getTextFromContent, tokenCounter, tokenStorageManager };