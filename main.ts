/**
 * Delver Plugin - Main entry point
 * An AI-powered chat assistant for Obsidian with tool calling and context management
 */

import { Plugin, WorkspaceLeaf } from 'obsidian';
import { ChatView, CHAT_VIEW_TYPE } from './src/ui/chat-view';
import { DelverSettings } from './src/types/settings';
import { ChatSession } from './src/types/messages';
import { DEFAULT_SETTINGS } from './src/settings/defaults';
import { SettingsMigration } from './src/settings/migration';
import { DelverSettingTab } from './src/settings/settings-tab';
import { generateSessionId } from './src/ui/utils/helpers';

export default class DelverPlugin extends Plugin {
	settings: DelverSettings;

	async onload() {
		await this.loadSettings();

		// Register chat view
		this.registerView(
			CHAT_VIEW_TYPE,
			(leaf) => new ChatView(
				leaf,
				this.settings,
				(session) => this.saveSession(session),
				(sessionId, action) => this.updateOpenSessions(sessionId, action),
				() => this.saveSettings()
			)
		);

		// Auto-restore open chat sessions
		this.app.workspace.onLayoutReady(() => {
			this.restoreOpenSessions();
		});

		// Add ribbon icon
		this.addRibbonIcon('message-circle', 'Open Delver Chat', async () => {
			await this.openNewChat();
		});

		// Add commands
		this.addCommand({
			id: 'open-chat',
			name: 'Open new chat',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'c' }],
			callback: async () => {
				await this.openNewChat();
			}
		});

		// Regenerate last message
		this.addCommand({
			id: 'regenerate-last-message',
			name: 'Regenerate last message',
			hotkeys: [{ modifiers: ['Mod'], key: 'r' }],
			checkCallback: (checking: boolean) => {
				const activeView = this.getActiveChatView();
				if (activeView) {
					// Don't allow regeneration if generation is in progress
					if (activeView.isGenerationInProgress()) {
						return false;
					}
					if (!checking) {
						activeView.regenerateLastMessage();
					}
					return true;
				}
				return false;
			}
		});

		// Continue generation
		this.addCommand({
			id: 'continue-generation',
			name: 'Continue generation',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'r' }],
			checkCallback: (checking: boolean) => {
				const activeView = this.getActiveChatView();
				if (activeView) {
					// Don't allow continuation if generation is in progress
					if (activeView.isGenerationInProgress()) {
						return false;
					}
					if (!checking) {
						activeView.continueGeneration();
					}
					return true;
				}
				return false;
			}
		});

		// Open settings
		this.addCommand({
			id: 'open-settings',
			name: 'Open Delver settings',
			callback: () => {
				// Open settings and navigate to this plugin's tab
				(this.app as any).setting.open();
				(this.app as any).setting.openTabById('delver-plugin');
			}
		});

		// Add settings tab
		this.addSettingTab(new DelverSettingTab(this.app, this));
	}

	onunload() {
		console.log('[Delver] Plugin unloaded');
	}

	async loadSettings() {
		const data = await this.loadData();

		// Migrate if needed
		if (data && SettingsMigration.needsMigration(data)) {
			console.log('[Delver] Migrating settings from old format');
			this.settings = SettingsMigration.migrate(data);
			await this.saveSettings();
		} else {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		
		// Update all open chat views with new settings
		const chatLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		for (const leaf of chatLeaves) {
			const view = leaf.view;
			if (view instanceof ChatView) {
				await view.updateSettings(this.settings);
			}
		}
	}

	async saveSession(session: ChatSession) {
		this.settings.chatSessions[session.id] = session;
		await this.saveSettings();
	}

	async updateOpenSessions(sessionId: string, action: 'add' | 'remove') {
		if (action === 'add') {
			if (!this.settings.openSessions.includes(sessionId)) {
				this.settings.openSessions.push(sessionId);
				await this.saveSettings();
			}
		} else {
			const index = this.settings.openSessions.indexOf(sessionId);
			if (index > -1) {
				this.settings.openSessions.splice(index, 1);
				await this.saveSettings();
			}
		}
	}

	async openNewChat(): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		const sessionId = generateSessionId();

		await leaf.setViewState({
			type: CHAT_VIEW_TYPE,
			active: true,
			state: { sessionId }
		});

		this.app.workspace.revealLeaf(leaf);
	}

	async restoreOpenSessions(): Promise<void> {
		console.log('[Delver] Restoring open sessions:', this.settings.openSessions);

		// Clean up sessions with no data
		const validSessions = this.settings.openSessions.filter(sessionId => {
			return !!this.settings.chatSessions[sessionId];
		});

		if (validSessions.length !== this.settings.openSessions.length) {
			this.settings.openSessions = validSessions;
			await this.saveSettings();
		}

		// Get existing chat view leaves
		const existingLeaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		const restoredSessions = new Set<string>();

		// Assign sessions to existing leaves
		const sessionsToRestore = [...this.settings.openSessions];
		for (const leaf of existingLeaves) {
			if (sessionsToRestore.length > 0) {
				const sessionId = sessionsToRestore.shift()!;
				if (this.settings.chatSessions[sessionId]) {
					await leaf.setViewState({
						type: CHAT_VIEW_TYPE,
						state: { sessionId }
					});
					restoredSessions.add(sessionId);
				}
			}
		}

		// Create new tabs for remaining sessions
		for (const sessionId of sessionsToRestore) {
			if (this.settings.chatSessions[sessionId] && !restoredSessions.has(sessionId)) {
				await this.restoreSession(sessionId);
			}
		}

		// Clean up orphaned sessions
		const allSessionIds = Object.keys(this.settings.chatSessions);
		for (const sessionId of allSessionIds) {
			if (!this.settings.openSessions.includes(sessionId)) {
				delete this.settings.chatSessions[sessionId];
			}
		}

		await this.saveSettings();
	}

	async restoreSession(sessionId: string): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: CHAT_VIEW_TYPE,
			active: false,
			state: { sessionId }
		});
	}

	/**
	 * Get the currently active chat view (if any)
	 */
	getActiveChatView(): ChatView | null {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (activeLeaf?.view?.getViewType() === CHAT_VIEW_TYPE) {
			return activeLeaf.view as ChatView;
		}
		return null;
	}
}
