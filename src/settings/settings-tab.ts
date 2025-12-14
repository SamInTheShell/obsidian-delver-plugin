/**
 * Settings tab for Delver plugin
 */

import { App, PluginSettingTab, Setting, Notice, setIcon } from 'obsidian';
import { DelverSettings } from '../types/settings';
import DelverPlugin from '../../main';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts/system';

export class DelverSettingTab extends PluginSettingTab {
	plugin: DelverPlugin;

	constructor(app: App, plugin: DelverPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Save settings when the settings tab is closed
	 */
	hide(): void {
		super.hide();
		// Save all settings when the tab is closed
		this.plugin.saveSettings();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Header
		containerEl.createEl('h2', { text: 'Delver Settings' });

		// Provider Settings Section
		containerEl.createEl('h3', { text: 'Provider Settings' });

		new Setting(containerEl)
			.setName('Ollama Address')
			.setDesc('The address of your Ollama API endpoint')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.provider.address || 'http://localhost:11434')
				.onChange((value) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.provider.address = value;
				}));

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Optional API key for authentication (leave empty for local Ollama)')
			.addText(text => {
				text
					.setPlaceholder('Optional')
					.setValue(this.plugin.settings.provider.apiKey || '')
					.onChange((value) => {
						// Update in memory only, save when tab closes
						this.plugin.settings.provider.apiKey = value || undefined;
					});
				text.inputEl.type = 'password';
			});

		// Model Settings Section
		containerEl.createEl('h3', { text: 'Model Settings', attr: { style: 'margin-top: 30px;' } });

		// Explanation about auto-updating defaults
		containerEl.createEl('p', {
			text: 'When you change the model, thinking level, or context mode in a chat, these values automatically update as the defaults for new chats. This ensures new chats start with your most recent preferences.',
			attr: { style: 'color: var(--text-muted); margin-bottom: 15px; font-style: italic;' }
		});

		new Setting(containerEl)
			.setName('Default Model')
			.setDesc('The default model for new chats')
			.addText(text => text
				.setPlaceholder('gpt-oss:20b')
				.setValue(this.plugin.settings.defaultModel)
				.onChange((value) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.defaultModel = value;
				}));

		const contextModeSetting = new Setting(containerEl)
			.setName('Default Context Mode')
			.setDesc('How to manage context when it exceeds the limit')
			.addDropdown(dropdown => dropdown
				.addOption('rolling', 'Rolling (keep last N messages)')
				.addOption('compaction', 'Compaction (summarize older messages)')
				.addOption('halting', 'Halting (error when exceeded)')
				.setValue(this.plugin.settings.defaultContextMode)
				.onChange((value: any) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.defaultContextMode = value;
				}));

		// Add detailed explanation about context modes
		const contextModeDesc = containerEl.createEl('div', {
			attr: { style: 'margin-top: 8px; margin-bottom: 15px; padding: 12px; background-color: var(--background-secondary); border-radius: 6px; font-size: 0.9em;' }
		});

		const currentMode = this.plugin.settings.defaultContextMode;
		let explanation = '';

		if (currentMode === 'rolling') {
			explanation = 'Rolling mode keeps the last 20 messages and drops older ones. This ensures the conversation stays within context limits by maintaining only the most recent exchange.';
		} else if (currentMode === 'compaction') {
			explanation = 'Compaction mode keeps the last 10 messages as-is and summarizes older messages into a single summary. Compaction is triggered when your conversation has more than 10 messages. If the recent 10 messages alone exceed 80% of the token limit, it falls back to rolling mode.';
		} else if (currentMode === 'halting') {
			explanation = 'Halting mode uses all messages and throws an error if the context limit is exceeded. Use this mode when you want to ensure all conversation history is preserved, or when you want to be notified if context limits are reached.';
		}

		contextModeDesc.createEl('p', {
			text: explanation,
			attr: { style: 'margin: 0; color: var(--text-muted); line-height: 1.5;' }
		});

		// Update explanation when mode changes
		const dropdown = contextModeSetting.controlEl.querySelector('select') as HTMLSelectElement;
		if (dropdown) {
			dropdown.addEventListener('change', () => {
				const newMode = dropdown.value;
				let newExplanation = '';

				if (newMode === 'rolling') {
					newExplanation = 'Rolling mode keeps the last 20 messages and drops older ones. This ensures the conversation stays within context limits by maintaining only the most recent exchange.';
				} else if (newMode === 'compaction') {
					newExplanation = 'Compaction mode keeps the last 10 messages as-is and summarizes older messages into a single summary. Compaction is triggered when your conversation has more than 10 messages. If the recent 10 messages alone exceed 80% of the token limit, it falls back to rolling mode.';
				} else if (newMode === 'halting') {
					newExplanation = 'Halting mode uses all messages and throws an error if the context limit is exceeded. Use this mode when you want to ensure all conversation history is preserved, or when you want to be notified if context limits are reached.';
				}

				const explanationEl = contextModeDesc.querySelector('p');
				if (explanationEl) {
					explanationEl.textContent = newExplanation;
				}
			});
		}

		new Setting(containerEl)
			.setName('Thinking Level')
			.setDesc('How much thinking models should do (for models like gpt-oss, qwen3)')
			.addDropdown(dropdown => dropdown
				.addOption('off', 'Off')
				.addOption('low', 'Low')
				.addOption('medium', 'Medium')
				.addOption('high', 'High')
				.setValue(this.plugin.settings.thinkingLevel)
				.onChange((value: any) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.thinkingLevel = value;
				}));

		// Prompt Customization Section
		containerEl.createEl('h3', { text: 'Prompt Customization', attr: { style: 'margin-top: 30px;' } });

		new Setting(containerEl)
			.setName('Assistant Name')
			.setDesc('The name of the AI assistant')
			.addText(text => text
				.setPlaceholder('Delver')
				.setValue(this.plugin.settings.assistantName)
				.onChange((value) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.assistantName = value;
				}));

		const systemPromptSetting = new Setting(containerEl)
			.setName('System Prompt')
			.setDesc('The system prompt that defines the assistant\'s behavior');
		
		let textareaComponent: any;
		systemPromptSetting.addTextArea(text => {
			textareaComponent = text;
			text
				.setPlaceholder('System prompt...')
				.setValue(this.plugin.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT)
				.onChange((value) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.systemPrompt = value;
				});
			text.inputEl.rows = 6;
			text.inputEl.style.width = '100%';
		});
		
		// Get the control container and set up flex layout with button on left
		const controlContainer = systemPromptSetting.controlEl;
		const textareaEl = textareaComponent.inputEl;
		
		// Create a wrapper for the layout
		const wrapper = controlContainer.createEl('div');
		wrapper.style.display = 'flex';
		wrapper.style.gap = '8px';
		wrapper.style.alignItems = 'flex-start';
		wrapper.style.width = '100%';
		
		// Create reset button on the left
		const resetButton = wrapper.createEl('button', {
			cls: 'clickable-icon',
			attr: { 
				'aria-label': 'Reset to default',
				'title': 'Reset to default'
			}
		});
		resetButton.style.flexShrink = '0';
		resetButton.style.marginTop = '2px';
		setIcon(resetButton, 'rotate-ccw');
		
		// Move textarea into wrapper and make it flexible
		const textareaWrapper = wrapper.createEl('div');
		textareaWrapper.style.flex = '1';
		textareaWrapper.style.minWidth = '0';
		textareaWrapper.appendChild(textareaEl);
		textareaEl.style.width = '100%';
		
		// Reset button functionality
		resetButton.addEventListener('click', async () => {
			this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
			textareaComponent.setValue(DEFAULT_SYSTEM_PROMPT);
			await this.plugin.saveSettings();
			new Notice('System prompt reset to default');
		});

		// Tool Permissions Section
		containerEl.createEl('h3', { text: 'Tool Permissions', attr: { style: 'margin-top: 30px;' } });
		containerEl.createEl('p', {
			text: 'Control how tools can be used by the AI assistant',
			attr: { style: 'color: var(--text-muted); margin-bottom: 10px;' }
		});

		// Vault File Find Tool
		new Setting(containerEl)
			.setName('Vault File Find')
			.setDesc('Find files by filename or path (simple, fast)')
			.addDropdown(dropdown => dropdown
				.addOption('ask', 'Ask (prompt before use)')
				.addOption('allow', 'Allow (use without asking)')
				.addOption('deny', 'Deny (never allow)')
				.addOption('disabled', 'Disabled (hide from AI)')
				.setValue(this.plugin.settings.toolPermissions['vault_file_find'] || 'ask')
				.onChange((value: any) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.toolPermissions['vault_file_find'] = value;
				}));

		// Vault Fuzzy Find Tool
		new Setting(containerEl)
			.setName('Vault Fuzzy Find')
			.setDesc('Find files by searching filenames AND file content (slower but more thorough)')
			.addDropdown(dropdown => dropdown
				.addOption('ask', 'Ask (prompt before use)')
				.addOption('allow', 'Allow (use without asking)')
				.addOption('deny', 'Deny (never allow)')
				.addOption('disabled', 'Disabled (hide from AI)')
				.setValue(this.plugin.settings.toolPermissions['vault_fuzzy_find'] || 'ask')
				.onChange((value: any) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.toolPermissions['vault_fuzzy_find'] = value;
				}));

		// Vault Read Tool
		new Setting(containerEl)
			.setName('Vault Read')
			.setDesc('Read the contents of files in your vault')
			.addDropdown(dropdown => dropdown
				.addOption('ask', 'Ask (prompt before use)')
				.addOption('allow', 'Allow (use without asking)')
				.addOption('deny', 'Deny (never allow)')
				.addOption('disabled', 'Disabled (hide from AI)')
				.setValue(this.plugin.settings.toolPermissions['vault_read'] || 'ask')
				.onChange((value: any) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.toolPermissions['vault_read'] = value;
				}));

		// List References Tool
		new Setting(containerEl)
			.setName('List References')
			.setDesc('List all file references from the current conversation')
			.addDropdown(dropdown => dropdown
				.addOption('ask', 'Ask (prompt before use)')
				.addOption('allow', 'Allow (use without asking)')
				.addOption('deny', 'Deny (never allow)')
				.addOption('disabled', 'Disabled (hide from AI)')
				.setValue(this.plugin.settings.toolPermissions['list_references'] || 'allow')
				.onChange((value: any) => {
					// Update in memory only, save when tab closes
					this.plugin.settings.toolPermissions['list_references'] = value;
				}));

		// Session Management Section
		containerEl.createEl('h3', { text: 'Chat Session Management', attr: { style: 'margin-top: 30px;' } });

		const sessionCount = Object.keys(this.plugin.settings.chatSessions).length;
		const openCount = this.plugin.settings.openSessions.length;

		containerEl.createEl('p', {
			text: `Total sessions: ${sessionCount} | Open sessions: ${openCount}`,
			attr: { style: 'color: var(--text-muted); margin-bottom: 10px;' }
		});

		if (openCount === 0) {
			containerEl.createEl('p', {
				text: 'No open chat sessions.',
				attr: { style: 'color: var(--text-muted); font-style: italic;' }
			});
		} else {
			// Clear all sessions button
			new Setting(containerEl)
				.setName('Clear All Sessions')
				.setDesc(`Close all ${openCount} open chat session(s) and delete their data`)
				.addButton(button => button
					.setButtonText('Clear All')
					.setWarning()
					.onClick(async () => {
						// Confirm
						if (!confirm(`Are you sure you want to delete all ${openCount} open sessions?`)) {
							return;
						}

						// Close all chat tabs
						const leaves = this.app.workspace.getLeavesOfType('chat-view');
						for (const leaf of leaves) {
							leaf.detach();
						}

						// Clear sessions
						for (const sessionId of this.plugin.settings.openSessions) {
							delete this.plugin.settings.chatSessions[sessionId];
						}
						this.plugin.settings.openSessions = [];
						await this.plugin.saveSettings();

						new Notice('All chat sessions cleared');
						this.display(); // Refresh
					}));

			// Individual session management
			for (const sessionId of this.plugin.settings.openSessions) {
				const session = this.plugin.settings.chatSessions[sessionId];
				if (!session) continue;

				const messageCount = session.messages.length;
				const preview = session.name !== 'New Chat' ? session.name :
					session.messages.find(m => m.role === 'user')?.content.substring(0, 50) || 'Empty';

				new Setting(containerEl)
					.setName(session.name)
					.setDesc(`${messageCount} messages | ${preview}${preview.length >= 50 ? '...' : ''}`)
					.addButton(button => button
						.setButtonText('Remove')
						.setWarning()
						.onClick(async () => {
							// Find and close the tab
							const leaves = this.app.workspace.getLeavesOfType('chat-view');
							for (const leaf of leaves) {
								const view = leaf.view as any;
								if (view && view.session && view.session.id === sessionId) {
									leaf.detach();
									break;
								}
							}

							// Remove from settings
							const index = this.plugin.settings.openSessions.indexOf(sessionId);
							if (index > -1) {
								this.plugin.settings.openSessions.splice(index, 1);
							}
							delete this.plugin.settings.chatSessions[sessionId];
							await this.plugin.saveSettings();

							new Notice('Session removed');
							this.display(); // Refresh
						}));
			}
		}

		// Info Section
		containerEl.createEl('h3', { text: 'About', attr: { style: 'margin-top: 30px;' } });
		containerEl.createEl('p', {
			text: 'Delver is an AI-powered chat assistant that helps you leverage your Obsidian notes for knowledge recall, learning, and strategy.',
			attr: { style: 'color: var(--text-muted);' }
		});
	}
}
