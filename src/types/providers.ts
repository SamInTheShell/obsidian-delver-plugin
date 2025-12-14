/**
 * Provider abstraction types for AI API integration
 */

import { DelverMessage, ToolCall } from './messages';

export interface ProviderConfig {
	type: 'ollama' | string;        // Extensible to other providers
	address?: string;               // API endpoint (for Ollama)
	apiKey?: string;                // Authentication (for other providers)
}

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, any>;
			required: string[];
		};
	};
}

export interface GenerationRequest {
	messages: DelverMessage[];
	tools?: ToolDefinition[];
	model: string;
	options?: {
		temperature?: number;
		think?: boolean;           // For thinking models
		[key: string]: any;        // Allow additional provider-specific options
	};
}

export interface GenerationChunk {
	type: 'content' | 'thinking' | 'tool_call' | 'done' | 'error';
	content?: string;
	thinking?: string;
	tool_calls?: ToolCall[];
	done?: boolean;
	error?: string;

	// Metadata from final chunk
	totalTokens?: number;
	promptTokens?: number;
	completionTokens?: number;
}

export interface ModelInfo {
	name: string;
	contextLength: number;
	supportsThinking: boolean;
	supportsTools: boolean;
}

/**
 * Base provider interface that all AI providers must implement
 */
export abstract class BaseProvider {
	/**
	 * Generate a streaming response
	 */
	abstract generate(request: GenerationRequest): AsyncGenerator<GenerationChunk>;

	/**
	 * Get information about a specific model
	 */
	abstract getModelInfo(model: string): Promise<ModelInfo>;

	/**
	 * List available models
	 */
	abstract listModels(): Promise<string[]>;

	/**
	 * Cancel ongoing generation
	 */
	abstract cancelGeneration(): void;
}
