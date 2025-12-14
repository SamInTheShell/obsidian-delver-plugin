/**
 * Settings types for Delver plugin configuration
 */

import { ChatSession, ContextMode } from './messages';
import { ProviderConfig } from './providers';
import { ToolPermission } from './tools';

export interface DelverSettings {
	// Provider configuration
	provider: ProviderConfig;

	// Model settings
	defaultModel: string;
	defaultContextMode: ContextMode;
	thinkingLevel: 'off' | 'low' | 'medium' | 'high';

	// Tool permissions (per-tool configuration)
	toolPermissions: Record<string, ToolPermission>;

	// Prompt customization
	assistantName: string;
	systemPrompt: string;
	compactionPrompt: string;        // Sub-prompt for compaction mode

	// Session data
	chatSessions: Record<string, ChatSession>;
	openSessions: string[];          // Session IDs of open tabs
}
