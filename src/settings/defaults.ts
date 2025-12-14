/**
 * Default settings for Delver
 */

import { DelverSettings } from '../types/settings';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_COMPACTION_PROMPT } from '../prompts/system';

export const DEFAULT_SETTINGS: DelverSettings = {
	provider: {
		type: 'ollama',
		address: 'http://localhost:11434'
	},
	defaultModel: 'gpt-oss:20b',
	defaultContextMode: 'rolling',
	thinkingLevel: 'medium',
	toolPermissions: {
		'vault_file_find': 'ask',
		'vault_fuzzy_find': 'ask',
		'vault_read': 'ask',
		'list_references': 'allow'
	},
	assistantName: 'Delver',
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	compactionPrompt: DEFAULT_COMPACTION_PROMPT,
	chatSessions: {},
	openSessions: []
};
