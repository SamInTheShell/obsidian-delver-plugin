/**
 * Context manager - handles rolling, compaction, and halting modes
 */

import { DelverMessage, ChatSession } from '../types/messages';
import { ContextConfig, ContextState } from '../types/context';
import { TokenEstimator } from './token-estimation';

export class ContextManager {
	private tokenEstimator: TokenEstimator;

	constructor() {
		this.tokenEstimator = new TokenEstimator();
	}

	/**
	 * Get active messages for API based on context mode
	 * Always includes system prompt first, then applies mode logic
	 */
	getActiveMessages(session: ChatSession, maxTokens: number): DelverMessage[] {
		const config: ContextConfig = {
			mode: session.contextMode,
			maxTokens: session.contextLimit || maxTokens,
			rollingWindowSize: 20 // Default rolling window size
		};

		const allMessages = session.messages;
		const systemPrompt = allMessages.find(m => m.role === 'system');
		const conversationMessages = allMessages.filter(m => m.role !== 'system');

		let activeMessages: DelverMessage[] = [];

		switch (config.mode) {
			case 'rolling':
				activeMessages = this.applyRollingWindow(conversationMessages, config);
				break;
			case 'compaction':
				activeMessages = this.applyCompaction(conversationMessages, config);
				break;
			case 'halting':
				activeMessages = this.applyHalting(conversationMessages, config);
				break;
		}

		// Format user messages with metadata
		activeMessages = activeMessages.map(msg => {
			if (msg.role === 'user') {
				return this.formatUserMessageWithMetadata(msg);
			}
			return msg;
		});

		// Always prepend system prompt if it exists
		if (systemPrompt) {
			activeMessages.unshift(systemPrompt);
		}

		return activeMessages;
	}

	/**
	 * Get context state (for UI display)
	 */
	getContextState(session: ChatSession, maxTokens: number): ContextState {
		const activeMessages = this.getActiveMessages(session, maxTokens);
		const currentTokens = this.tokenEstimator.estimateMessages(activeMessages);

		return {
			messages: session.messages,
			activeMessages,
			currentTokens,
			maxTokens: session.contextLimit || maxTokens
		};
	}

	/**
	 * Rolling window: Keep last N messages
	 */
	private applyRollingWindow(messages: DelverMessage[], config: ContextConfig): DelverMessage[] {
		const windowSize = config.rollingWindowSize || 20;
		return messages.slice(-windowSize);
	}

	/**
	 * Compaction: Summarize older messages, keep recent ones
	 */
	private applyCompaction(messages: DelverMessage[], config: ContextConfig): DelverMessage[] {
		// Keep last 10 messages as-is
		const recentCount = 10;

		if (messages.length <= recentCount) {
			return messages;
		}

		const recent = messages.slice(-recentCount);
		const older = messages.slice(0, -recentCount);

		// Estimate tokens for recent messages
		const recentTokens = this.tokenEstimator.estimateMessages(recent);

		// Check if we need compaction
		if (recentTokens >= config.maxTokens * 0.8) {
			// Just use rolling window if recent messages alone are too large
			return this.applyRollingWindow(messages, config);
		}

		// Create compaction summary
		// TODO: This should use AI to generate a summary, for now just create a placeholder
		const summary = this.createCompactionSummary(older);

		return [summary, ...recent];
	}

	/**
	 * Halting: Use all messages, throw error if over limit
	 */
	private applyHalting(messages: DelverMessage[], config: ContextConfig): DelverMessage[] {
		const tokenCount = this.tokenEstimator.estimateMessages(messages);

		if (tokenCount > config.maxTokens) {
			throw new Error(
				`Context limit exceeded: ${tokenCount} tokens > ${config.maxTokens} tokens. ` +
				`Try switching to "rolling" or "compaction" mode, or increase the context limit.`
			);
		}

		return messages;
	}

	/**
	 * Create a summary message for compacted older messages
	 * TODO: Use AI to generate this summary
	 */
	private createCompactionSummary(messages: DelverMessage[]): DelverMessage {
		const messageCount = messages.length;
		const userMessages = messages.filter(m => m.role === 'user').length;
		const assistantMessages = messages.filter(m => m.role === 'assistant').length;

		return {
			id: `compaction-${Date.now()}`,
			role: 'system',
			content: `[Previous conversation summary: ${messageCount} messages (${userMessages} from user, ${assistantMessages} from assistant) have been compacted to save context. The key points and topics discussed are preserved above this message.]`,
			timestamp: Date.now()
		};
	}

	/**
	 * Format user message with metadata XML at the top
	 */
	private formatUserMessageWithMetadata(message: DelverMessage): DelverMessage {
		const date = new Date(message.timestamp);
		
		// Format datetime as YYYY-MM-DD HH:MM:SS
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		const seconds = String(date.getSeconds()).padStart(2, '0');
		const datetime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
		
		// Get month name (full name)
		const monthNames = [
			'January', 'February', 'March', 'April', 'May', 'June',
			'July', 'August', 'September', 'October', 'November', 'December'
		];
		const monthName = monthNames[date.getMonth()];
		
		// Get day name (full name)
		const dayNames = [
			'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
		];
		const dayName = dayNames[date.getDay()];
		
		// Create metadata XML
		const metadata = `<metadata>\n  <datetime datetime="${datetime}" month="${monthName}" day="${dayName}" />\n</metadata>\n\n`;
		
		// Return new message with metadata prepended to content
		return {
			...message,
			content: metadata + message.content
		};
	}

	/**
	 * Clear token estimation cache
	 */
	clearCache(): void {
		this.tokenEstimator.clearCache();
	}
}
