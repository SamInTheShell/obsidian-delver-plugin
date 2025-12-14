/**
 * Token estimation utilities
 * Uses simple heuristic (~4 characters per token)
 * Can be upgraded to tiktoken for more accuracy in the future
 */

import { DelverMessage } from '../types/messages';

export class TokenEstimator {
	private static readonly CHARS_PER_TOKEN = 4;
	private tokenCache: Map<string, number> = new Map();

	/**
	 * Estimate token count for a single message
	 */
	estimateMessage(message: DelverMessage): number {
		// Check cache first
		const cacheKey = this.getCacheKey(message);
		if (this.tokenCache.has(cacheKey)) {
			return this.tokenCache.get(cacheKey)!;
		}

		let charCount = 0;

		// Count content
		charCount += message.content.length;

		// Count thinking (if present)
		if (message.thinking) {
			charCount += message.thinking.length;
		}

		// Count tool calls (if present)
		if (message.tool_calls) {
			charCount += JSON.stringify(message.tool_calls).length;
		}

		// Convert to tokens
		const tokenCount = Math.ceil(charCount / TokenEstimator.CHARS_PER_TOKEN);

		// Cache result
		this.tokenCache.set(cacheKey, tokenCount);

		return tokenCount;
	}

	/**
	 * Estimate token count for multiple messages
	 */
	estimateMessages(messages: DelverMessage[]): number {
		return messages.reduce((total, msg) => total + this.estimateMessage(msg), 0);
	}

	/**
	 * Clear token cache
	 */
	clearCache(): void {
		this.tokenCache.clear();
	}

	/**
	 * Generate cache key for a message
	 */
	private getCacheKey(message: DelverMessage): string {
		return `${message.id}-${message.timestamp}`;
	}
}
