/**
 * Core generation function - provider-agnostic streaming bridge
 * This is a thin layer that delegates to the provider
 */

import {
	BaseProvider,
	GenerationRequest,
	GenerationChunk,
	ToolDefinition
} from '../types/providers';
import { DelverMessage } from '../types/messages';

export interface GenerateOptions {
	messages: DelverMessage[];
	tools?: ToolDefinition[];
	provider: BaseProvider;
	model: string;
	temperature?: number;
	think?: boolean;
	signal?: AbortSignal;
}

/**
 * Generate a streaming response from an AI provider
 *
 * This function is provider-agnostic and handles:
 * - Delegating to the appropriate provider
 * - Streaming chunks as they arrive
 * - Cancellation via AbortSignal
 * - Error handling
 *
 * It does NOT handle:
 * - Tool execution (that's chat-loop's responsibility)
 * - Context management (that's context-manager's responsibility)
 * - UI updates (that's chat-view's responsibility)
 */
export async function* generate(options: GenerateOptions): AsyncGenerator<GenerationChunk> {
	const { messages, tools, provider, model, temperature, think, signal } = options;

	// Build provider request
	const request: GenerationRequest = {
		messages,
		model,
		...(tools && { tools }),
		options: {
			...(temperature !== undefined && { temperature }),
			...(think !== undefined && { think })
		}
	};

	try {
		// Stream from provider
		for await (const chunk of provider.generate(request)) {
			// Check for cancellation
			if (signal?.aborted) {
				provider.cancelGeneration();
				yield { type: 'error', error: 'Generation cancelled' };
				return;
			}

			yield chunk;

			// Stop on done or error
			if (chunk.done || chunk.type === 'error') {
				return;
			}
		}
	} catch (error: any) {
		// Check if cancellation
		if (signal?.aborted) {
			yield { type: 'error', error: 'Generation cancelled' };
		} else {
			yield { type: 'error', error: error.message || 'Unknown error' };
		}
	}
}
