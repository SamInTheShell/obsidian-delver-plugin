/**
 * Settings migration utilities
 * Migrates from old DelverSettings format to new format
 */

import { DelverSettings } from '../types/settings';
import { ChatSession, DelverMessage } from '../types/messages';
import { DEFAULT_SETTINGS } from './defaults';

interface OldChatMessage {
	role: 'user' | 'assistant';
	content: string;
}

interface OldSettings {
	selectedModel: string;
	selectedContextMode: string;
	chatSessions: Record<string, OldChatMessage[]>;
	openSessions: string[];
}

export class SettingsMigration {
	/**
	 * Migrate old settings to new format
	 */
	static migrate(oldSettings: any): DelverSettings {
		// Check if already new format (has provider field)
		if (oldSettings.provider) {
			return oldSettings as DelverSettings;
		}

		// Cast to old format
		const old = oldSettings as OldSettings;

		// Create new settings based on defaults
		const newSettings: DelverSettings = {
			...DEFAULT_SETTINGS,
			defaultModel: old.selectedModel || DEFAULT_SETTINGS.defaultModel,
			defaultContextMode: (old.selectedContextMode as any) || DEFAULT_SETTINGS.defaultContextMode,
			chatSessions: this.migrateSessions(old.chatSessions || {}),
			openSessions: old.openSessions || []
		};

		return newSettings;
	}

	/**
	 * Migrate old chat sessions to new format
	 */
	private static migrateSessions(
		oldSessions: Record<string, OldChatMessage[]>
	): Record<string, ChatSession> {
		const newSessions: Record<string, ChatSession> = {};

		for (const [id, messages] of Object.entries(oldSessions)) {
			const now = Date.now();

			newSessions[id] = {
				id,
				name: 'New Chat',          // Will be AI-generated later
				messages: messages.map((m, i) => this.migrateMessage(m, id, i)),
				contextMode: 'rolling',
				model: DEFAULT_SETTINGS.defaultModel,
				createdAt: now,
				updatedAt: now
			};
		}

		return newSessions;
	}

	/**
	 * Migrate old message to new format
	 */
	private static migrateMessage(
		oldMessage: OldChatMessage,
		sessionId: string,
		index: number
	): DelverMessage {
		return {
			id: `${sessionId}-msg-${index}`,
			role: oldMessage.role,
			content: oldMessage.content,
			timestamp: Date.now(),
			editable: true
		};
	}

	/**
	 * Check if settings need migration
	 */
	static needsMigration(settings: any): boolean {
		return !settings.provider;
	}
}
