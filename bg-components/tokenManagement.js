import { CONFIG, RawLog, StoredMap, getStorageValue, setStorageValue } from './utils.js';

// Create component-specific logger
async function Log(...args) {
	await RawLog("tokenManagement", ...args);
}
const API_MODEL_SLUG = "claude-opus-5";
// Text of one content block, for token counting, in one of two views:
//
// - Context (asOutput = false): what later turns send back to the model. Thinking drops out after
//   its own turn; tool results do NOT. Verified 2026-10-07 (merged experience, Haiku 4.5): with
//   tools forbidden, the model quoted lines from a file it had Read two turns earlier, and listed
//   all ten results of an earlier web search, not just the one it cited.
// - Output (asOutput = true): what the model generated - text, thinking and tool inputs. Tool
//   results are excluded: they are fed to the model, not produced by it.
//
// Web-search results only carry title/url here; the page text the model saw is never exposed, so
// it can't be counted.
function getTextFromContent(content, asOutput = false) {
	let textPieces = [];

	if (content.text) {
		textPieces.push(content.text);
	}

	if (content.thinking && asOutput) {
		textPieces.push(content.thinking);
	}

	if (content.input) {
		textPieces.push(JSON.stringify(content.input));
	}

	if (content.type === "tool_result" && asOutput) {
		return textPieces;
	}

	if (Array.isArray(content.content)) {
		for (const nestedContent of content.content) {
			textPieces = textPieces.concat(getTextFromContent(nestedContent, asOutput));
		}
	} else if (content.content && typeof content.content === 'object') {
		textPieces = textPieces.concat(getTextFromContent(content.content, asOutput));
	}

	return textPieces;
}

class TokenCounter {
	constructor() {
		this.tokenizer = GPTTokenizer_o200k_base;
		this.ESTIMATION_MULTIPLIER = CONFIG.ESTIMATION_MULTIPLIER;
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

	// Local-only count: synchronous, never touches the network. For the provisional SSE estimate,
	// where a round-trip would defeat the whole point of being fast. countText's API path gives a
	// truer number when a key is set, so the two can disagree slightly - that's fine here, the
	// authoritative pass follows moments later.
	countTextLocal(text) {
		if (!text) return 0;
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
				model: API_MODEL_SLUG
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
				model: API_MODEL_SLUG
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

// How long an org stays "known" without being seen again. Refreshed on every sighting so active
// accounts persist; idle ones drop out so the popup doesn't keep listing accounts you no longer use.
const KNOWN_ORG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Token storage manager (simplified - only org ID tracking and total tokens)
class TokenStorageManager {
	constructor() {
		// TTL'd set of orgs we've seen recently (value is unused; the key + expiry is the data).
		this.knownOrgs = new StoredMap('knownOrgsV2');
	}

	async addOrgId(orgId) {
		// Always write to refresh the TTL on every sighting.
		await this.knownOrgs.set(orgId, true, KNOWN_ORG_TTL_MS);
	}

	// Non-expired orgs we've seen recently (entries() prunes expired keys on read).
	async getKnownOrgIds() {
		return (await this.knownOrgs.entries()).map(([orgId]) => orgId);
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