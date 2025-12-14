/**
 * Message and conversation types for Delver chat system
 */

export interface ToolCall {
	function: {
		name: string;
		arguments: Record<string, any>;
	};

	// UI metadata
	permissionStatus?: 'pending' | 'approved' | 'denied';
	result?: string;
	error?: string;
}

export interface DelverMessage {
	id: string;
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;

	// Optional fields based on role and model capabilities
	thinking?: string;              // For thinking models (gpt-oss, qwen3, etc.)
	tool_calls?: ToolCall[];        // Assistant requesting tool execution
	tool_name?: string;             // Tool response identifier (for role='tool')

	// Metadata
	timestamp: number;
	isStreaming?: boolean;          // Currently being streamed
	editable?: boolean;             // User can edit this message
}

export type ContextMode = 'rolling' | 'compaction' | 'halting';

export interface ChatSession {
	id: string;
	name: string;                   // AI-generated or user-set tab name
	messages: DelverMessage[];
	contextMode: ContextMode;       // Can override global setting
	contextLimit?: number;          // Override limit, 0 or undefined = reset to model default
	model: string;                  // Model identifier (e.g., 'gpt-oss:20b')
	createdAt: number;
	updatedAt: number;
}
