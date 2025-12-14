/**
 * Context management types
 */

import { DelverMessage, ContextMode } from './messages';

export interface ContextConfig {
	mode: ContextMode;
	maxTokens: number;              // From model info or user override
	rollingWindowSize?: number;     // Number of messages to keep in rolling mode
}

export interface ContextState {
	messages: DelverMessage[];      // Full conversation history
	activeMessages: DelverMessage[]; // Messages sent to API (after mode processing)
	currentTokens: number;          // Estimated token count
	maxTokens: number;              // Maximum allowed tokens
}
