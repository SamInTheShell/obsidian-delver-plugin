/**
 * Refactored ChatView integrating the new chat system
 */

import {
	App,
	ItemView,
	WorkspaceLeaf,
	DropdownComponent,
	TextAreaComponent,
	MarkdownRenderer,
	setIcon,
	Modal
} from 'obsidian';
import { DelverMessage, ChatSession, ToolCall } from '../types/messages';
import { DelverSettings } from '../types/settings';
import { GenerationChunk } from '../types/providers';
import { ToolExecutionContext } from '../types/tools';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { PermissionManager } from '../tools/permissions';
import { ContextManager } from '../context/manager';
import { ChatLoop } from '../generation/chat-loop';
import { VaultSearchTool } from '../tools/vault-search';
import { VaultReadTool } from '../tools/vault-read';
import { ListReferencesTool } from '../tools/list-references';
import { generateMessageId, generateSessionId, formatTokenCount, calculatePercentage } from './utils/helpers';

export const CHAT_VIEW_TYPE = 'chat-view';

export class ChatView extends ItemView {
	private session: ChatSession;
	private settings: DelverSettings;
	private modelContextLength: number = 8192;
	private modelSupportsThinking: boolean = false;

	// Registries and managers
	private providerRegistry: ProviderRegistry;
	private toolRegistry: ToolRegistry;
	private permissionManager: PermissionManager;
	private contextManager: ContextManager;

	// AbortController for cancellation
	private abortController: AbortController | null = null;

	// DOM references
	private scrollContainer: HTMLElement; // Outer container with scroll
	private chatMessagesContainer: HTMLElement; // Inner container with messages
	private inputContainer: HTMLElement; // Container for the input section
	private inputTextarea: TextAreaComponent;
	private welcomeTextarea: HTMLTextAreaElement | null = null; // Welcome message input
	private contextDisplay: HTMLElement;
	private modelDropdown: DropdownComponent;
	private thinkingDropdown: DropdownComponent;
	private isEditingLimit: boolean = false;

	// Document-level ESC handler for cancellation
	private escapeHandler: ((evt: KeyboardEvent) => void) | null = null;

	// Auto-scroll management
	private shouldAutoScroll: boolean = true;
	private scrollListener: ((evt: Event) => void) | null = null;

	// Callbacks for saving
	private onSaveSession: (session: ChatSession) => Promise<void>;
	private onUpdateOpenSessions: (sessionId: string, action: 'add' | 'remove') => Promise<void>;
	private onSaveSettings: () => Promise<void>;

	constructor(
		leaf: WorkspaceLeaf,
		settings: DelverSettings,
		onSaveSession: (session: ChatSession) => Promise<void>,
		onUpdateOpenSessions: (sessionId: string, action: 'add' | 'remove') => Promise<void>,
		onSaveSettings: () => Promise<void>
	) {
		super(leaf);
		this.settings = settings;
		this.onSaveSession = onSaveSession;
		this.onUpdateOpenSessions = onUpdateOpenSessions;
		this.onSaveSettings = onSaveSettings;

		// Initialize registries and managers
		this.providerRegistry = ProviderRegistry.getInstance();
		this.toolRegistry = new ToolRegistry();
		this.permissionManager = new PermissionManager(settings.toolPermissions);
		this.contextManager = new ContextManager();

		// Register tools
		this.toolRegistry.register(new VaultSearchTool());
		this.toolRegistry.register(new VaultReadTool());
		this.toolRegistry.register(new ListReferencesTool());
	}

	/**
	 * Update settings and refresh view
	 */
	async updateSettings(settings: DelverSettings): Promise<void> {
		const assistantNameChanged = this.settings.assistantName !== settings.assistantName;
		const systemPromptChanged = this.settings.systemPrompt !== settings.systemPrompt;
		
		this.settings = settings;
		this.permissionManager.updatePermissions(settings.toolPermissions);
		
		// Update system message if assistant name or system prompt changed
		if (this.session && (assistantNameChanged || systemPromptChanged)) {
			const systemMessageIndex = this.session.messages.findIndex(m => m.role === 'system');
			if (systemMessageIndex !== -1) {
				// Replace the system message with a new one using current settings
				this.session.messages[systemMessageIndex] = this.createSystemMessage();
				this.session.updatedAt = Date.now();
				await this.onSaveSession(this.session);
			}
		}
		
		// Re-render messages to reflect new assistant name
		if (this.chatMessagesContainer && this.session) {
			this.renderMessages(false);
		}
		
		// Update the view header to reflect new assistant name
		// Obsidian will re-read getDisplayText() when we trigger a header update
		if ((this as any).headerEl) {
			const headerEl = (this as any).headerEl as HTMLElement;
			const titleEl = headerEl.querySelector('.view-header-title');
			if (titleEl) {
				titleEl.textContent = this.getDisplayText();
			}
		}
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	/**
	 * Returns the display text for the view header (shown inside the view)
	 * This shows the assistant name, not the session name
	 */
	getDisplayText(): string {
		return this.settings.assistantName || 'Delver';
	}

	getIcon(): string {
		return 'message-circle';
	}

	/**
	 * Update the tab title by manually updating the DOM
	 * Obsidian doesn't automatically refresh tab headers, so we need to manually update it.
	 * This updates the tab title to show the session name (not the assistant name).
	 */
	private updateTabTitle(): void {
		// Use session name for tab title, not assistant name
		let displayText = 'New Chat';
		if (this.session) {
			displayText = this.session.name || 'New Chat';
		}
		
		if (!displayText) {
			console.log('[ChatView] updateTabTitle: No display text');
			return;
		}
		
		console.log('[ChatView] updateTabTitle: Updating to:', displayText);
		
		// Try multiple times with delays to ensure DOM is ready
		const attemptUpdate = (attempt: number = 0) => {
			if (attempt > 5) {
				console.warn('[ChatView] updateTabTitle: Failed after 5 attempts');
				return;
			}
			
			// Use requestAnimationFrame to ensure DOM is ready
			requestAnimationFrame(() => {
				// Try to find the tab header through multiple methods
				let tabHeader: Element | null = null;
				
				// Method 1: Try accessing through leaf's tabHeaderEl (if it exists)
				if ((this.leaf as any).tabHeaderEl) {
					tabHeader = (this.leaf as any).tabHeaderEl;
					console.log('[ChatView] updateTabTitle: Found via leaf.tabHeaderEl');
				}
				
				// Method 2: Find through leaf container - traverse up from containerEl
				if (!tabHeader) {
					let current: Element | null = this.leaf.view.containerEl;
					while (current && current !== document.body) {
						const parent: Element | null = current.parentElement;
						if (parent && parent.classList.contains('workspace-leaf')) {
							tabHeader = parent.querySelector('.workspace-tab-header');
							if (tabHeader) {
								console.log('[ChatView] updateTabTitle: Found via leaf container traversal');
								break;
							}
						}
						current = parent;
					}
				}
				
				// Method 3: Find by matching leaf in all tabs
				if (!tabHeader) {
					const allTabs = document.querySelectorAll('.workspace-tab-header');
					for (const tab of Array.from(allTabs)) {
						const tabLeaf = (tab as any).view?.leaf || (tab as any).leaf || (tab as any).__leaf;
						if (tabLeaf === this.leaf) {
							tabHeader = tab;
							console.log('[ChatView] updateTabTitle: Found via leaf matching');
							break;
						}
					}
				}
				
				// Method 4: Find by traversing from leaf container (alternative path)
				if (!tabHeader) {
					const leafContainer = this.leaf.view.containerEl.closest('.workspace-leaf');
					if (leafContainer) {
						// Tab header might be a sibling, not a child
						const tabGroup = leafContainer.parentElement;
						if (tabGroup) {
							tabHeader = tabGroup.querySelector('.workspace-tab-header');
							if (tabHeader) {
								console.log('[ChatView] updateTabTitle: Found via tab group');
							}
						}
					}
				}
				
				// Method 5: Find by data attribute on leaf container
				if (!tabHeader) {
					const leafContainer = this.leaf.view.containerEl.closest('.workspace-leaf');
					if (leafContainer) {
						// Look for tab header that references this leaf
						const allTabs = document.querySelectorAll('.workspace-tab-header');
						for (const tab of Array.from(allTabs)) {
							// Check if tab's view matches our view
							if ((tab as any).view === this || (tab as any).__view === this) {
								tabHeader = tab;
								console.log('[ChatView] updateTabTitle: Found via view matching');
								break;
							}
						}
					}
				}
				
				if (!tabHeader) {
					console.warn('[ChatView] updateTabTitle: Tab header not found, retrying...', attempt);
					// Retry with a delay
					setTimeout(() => attemptUpdate(attempt + 1), 100);
					return;
				}
				
				console.log('[ChatView] updateTabTitle: Found tab header, updating title');
				
				const innerEl = tabHeader.querySelector('.workspace-tab-header-inner');
				if (!innerEl) {
					console.warn('[ChatView] updateTabTitle: Inner element not found');
					setTimeout(() => attemptUpdate(attempt + 1), 100);
					return;
				}
				
				// Find or create the title element
				let titleEl = innerEl.querySelector('.workspace-tab-header-inner-title') as HTMLElement;
				
				if (!titleEl) {
					// Look for existing text content to replace
					const textNodes = Array.from(innerEl.childNodes).filter(
						node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
					);
					if (textNodes.length > 0) {
						// Replace the text node with a span
						const textNode = textNodes[0];
						titleEl = document.createElement('span');
						titleEl.className = 'workspace-tab-header-inner-title';
						titleEl.textContent = displayText;
						textNode.replaceWith(titleEl);
						console.log('[ChatView] updateTabTitle: Created title from text node');
						return;
					}
					
					// Try to find any span that's not an icon - look more carefully
					const spans = innerEl.querySelectorAll('span');
					for (const span of Array.from(spans)) {
						// Check if it's not an icon and contains text
						if (!span.querySelector('svg') && 
							!span.classList.contains('workspace-tab-header-inner-icon') &&
							span.textContent?.trim()) {
							span.className = 'workspace-tab-header-inner-title';
							span.textContent = displayText;
							console.log('[ChatView] updateTabTitle: Updated existing span');
							return;
						}
					}
					
					// Create title element if it doesn't exist
					titleEl = document.createElement('span');
					titleEl.className = 'workspace-tab-header-inner-title';
					const icon = innerEl.querySelector('svg, .workspace-tab-header-inner-icon');
					if (icon && icon.nextSibling) {
						innerEl.insertBefore(titleEl, icon.nextSibling);
					} else if (icon) {
						innerEl.appendChild(titleEl);
					} else {
						innerEl.insertBefore(titleEl, innerEl.firstChild);
					}
					console.log('[ChatView] updateTabTitle: Created new title element');
				}
				
				// Update the text content
				if (titleEl.textContent !== displayText) {
					titleEl.textContent = displayText;
					console.log('[ChatView] updateTabTitle: Updated text content to:', displayText);
				}
				
				// Also update the data attribute if it exists (some Obsidian versions use this)
				if ((tabHeader as HTMLElement).dataset) {
					(tabHeader as HTMLElement).dataset.title = displayText;
				}
				
				// Force a repaint by triggering a style change
				titleEl.style.display = 'none';
				titleEl.offsetHeight; // Force reflow
				titleEl.style.display = '';
			});
		};
		
		attemptUpdate(0);
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();

		// Add menu actions to view header
		this.addAction('download', 'Export Chat', () => {
			this.exportChat();
		});

		this.addAction('upload', 'Import Chat', () => {
			this.importChat();
		});

		// Apply container styles
		container.setCssStyles({
			display: 'flex',
			flexDirection: 'column',
			height: '100%',
			padding: '10px',
			gap: '10px',
			backgroundColor: 'var(--background-primary)',
			color: 'var(--text-normal)'
		});

		// Create UI
		this.createChatMessagesArea(container);
		this.createInputSection(container);
		this.createToolbar(container);

		// Register keyboard shortcuts
		this.registerKeyboardShortcuts();

		// Register document-level ESC handler for generation cancellation
		this.registerEscapeHandler();

		// Register event to re-focus input when tab becomes active
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				if (leaf === this.leaf) {
					// Check if welcome message is displayed (no visible messages)
					const hasVisibleMessages = this.session && 
						this.session.messages.filter(m => m.role !== 'system').length > 0;
					
					if (!hasVisibleMessages && this.welcomeTextarea) {
						// Focus welcome input if welcome message is shown
						this.welcomeTextarea.focus();
					} else if (this.inputTextarea) {
						// Focus normal input if messages exist
						this.inputTextarea.inputEl.focus();
					}
					// Ensure tab title is correct when view becomes active
					// Obsidian might have set it to assistant name, override it
					setTimeout(() => {
						this.updateTabTitle();
					}, 50);
				}
			})
		);

		// Render messages if session loaded
		if (this.session) {
			this.renderMessages();
			await this.updateContextDisplay();
			
			// Update tab title to session name (not assistant name)
			// Use multiple delays to ensure we override Obsidian's initial title
			const delays = [50, 150, 300, 500];
			for (const delay of delays) {
				setTimeout(() => {
					this.updateTabTitle();
				}, delay);
			}
		} else {
			// Hide input if no session (will be shown when session is created)
			if (this.inputContainer) {
				this.inputContainer.style.display = 'none';
			}
		}
	}

	private registerEscapeHandler(): void {
		// Use document-level event listener with capture phase
		// This ensures we catch ESC before Obsidian's tab navigation does
		this.escapeHandler = (evt: KeyboardEvent) => {
			if (evt.key !== 'Escape') return;
			
			// Check if generation is in progress
			const abortController = this.abortController;
			if (!abortController || abortController.signal.aborted) return;
			
			// Check if this view is active - use multiple checks for reliability
			const isActive = this.leaf === this.app.workspace.activeLeaf ||
				(this.contentEl && this.contentEl.isConnected && this.contentEl.offsetParent !== null);
			
			if (isActive) {
				// Prevent Obsidian's default ESC behavior (tab switching)
				evt.preventDefault();
				evt.stopPropagation();
				evt.stopImmediatePropagation();
				
				// Cancel generation
				abortController.abort();
				this.updateLoadingIndicatorText('Cancelling...');
				console.log('[ChatView] Generation cancelled via ESC');
			}
		};

		// Use capture phase (true) to intercept before other handlers
		document.addEventListener('keydown', this.escapeHandler, true);
	}

	private registerKeyboardShortcuts(): void {
		// Hotkeys are now registered as commands in main.ts for better reliability
		// This method is kept for future view-specific shortcuts if needed
	}

	/**
	 * Check if generation is currently in progress
	 */
	isGenerationInProgress(): boolean {
		// Check both abortController and loading indicator for safety
		return !!(this.abortController && !this.abortController.signal.aborted) ||
		       !!this.chatMessagesContainer?.querySelector('[data-loading-indicator="true"]');
	}

	/**
	 * Regenerate the last message (public - called by command)
	 */
	async regenerateLastMessage(): Promise<void> {
		// Prevent regeneration if generation is already in progress
		if (this.isGenerationInProgress()) {
			return;
		}

		if (!this.session || this.session.messages.length === 0) return;

		const lastMessage = this.session.messages[this.session.messages.length - 1];

		// If last message is a tool result, continue instead of regenerate
		if (lastMessage.role === 'tool') {
			await this.continueGeneration();
			return;
		}

		if (lastMessage.role === 'assistant') {
			// Remove last assistant message
			this.session.messages.pop();
			await this.onSaveSession(this.session);
			this.renderMessages();
			await this.updateContextDisplay();

			// Regenerate
			await this.runChatLoop();
		} else if (lastMessage.role === 'user') {
			// Just regenerate a response
			await this.runChatLoop();
		}
	}

	/**
	 * Continue generation (public - called by command)
	 */
	async continueGeneration(): Promise<void> {
		// Prevent continuation if generation is already in progress
		if (this.isGenerationInProgress()) {
			return;
		}

		if (!this.session) return;

		const lastMessage = this.session.messages[this.session.messages.length - 1];

		// Only add "(continue)" if the last message is an assistant message with content
		// Skip for: user messages, tool messages, assistant messages with tool calls
		const shouldAddContinue = lastMessage && 
			lastMessage.role === 'assistant' && 
			!lastMessage.tool_calls && 
			lastMessage.content && 
			lastMessage.content.trim().length > 0;

		if (shouldAddContinue) {
			const continueMessage: DelverMessage = {
				id: generateMessageId(),
				role: 'user',
				content: '(continue)',
				timestamp: Date.now()
			};

			this.session.messages.push(continueMessage);
			await this.onSaveSession(this.session);
			this.renderMessages();
			await this.updateContextDisplay();
		}

		// Generate continuation
		await this.runChatLoop();
	}

	async setState(state: any, result: any): Promise<void> {
		await super.setState(state, result);

		if (state?.sessionId) {
			// Load or create session
			if (this.settings.chatSessions[state.sessionId]) {
				this.session = this.settings.chatSessions[state.sessionId];
			} else {
				// Create new session
				this.session = {
					id: state.sessionId,
					name: 'New Chat',
					messages: [this.createSystemMessage()],
					contextMode: this.settings.defaultContextMode,
					model: this.settings.defaultModel,
					createdAt: Date.now(),
					updatedAt: Date.now()
				};
				await this.onSaveSession(this.session);
			}

			// Update list_references tool with current session
			const listRefTool = this.toolRegistry.getTool('list_references');
			if (listRefTool && 'setSession' in listRefTool) {
				(listRefTool as any).setSession(this.session);
			}

			// Add to open sessions
			await this.onUpdateOpenSessions(this.session.id, 'add');

			// Load model context length
			await this.loadModelInfo();

			// Render if container exists
			if (this.chatMessagesContainer) {
				this.renderMessages();
				await this.updateContextDisplay();
			}
			
			// Update tab title to session name (not assistant name)
			// Use multiple delays to ensure we override Obsidian's initial title
			const delays = [50, 150, 300, 500];
			for (const delay of delays) {
				setTimeout(() => {
					this.updateTabTitle();
				}, delay);
			}
		}
	}

	getState(): any {
		return {
			type: CHAT_VIEW_TYPE,
			sessionId: this.session?.id
		};
	}

	private createSystemMessage(): DelverMessage {
		// Replace {ASSISTANT_NAME} placeholder with the configured assistant name
		const processedPrompt = (this.settings.systemPrompt || '').replace(
			/{ASSISTANT_NAME}/g,
			this.settings.assistantName || 'Delver'
		);
		
		return {
			id: generateMessageId(),
			role: 'system',
			content: processedPrompt,
			timestamp: Date.now()
		};
	}

	private createToolbar(container: HTMLElement): void {
		const toolbar = container.createEl('div');
		toolbar.setCssStyles({
			display: 'flex',
			gap: '8px',
			flexShrink: '0',
			alignItems: 'center'
		});
		
		// Context display (left)
		const contextContainer = toolbar.createEl('div');
		contextContainer.setCssStyles({
			padding: '0px 8px',
			fontSize: '0.9em',
			color: 'var(--text-muted)',
			cursor: 'pointer',
			borderRadius: '4px',
			whiteSpace: 'nowrap'
		});

		this.contextDisplay = contextContainer;

		// Click to edit context limit
		contextContainer.addEventListener('click', () => this.startEditingContextLimit());
		contextContainer.addEventListener('mouseenter', () => {
			contextContainer.style.backgroundColor = 'var(--background-modifier-hover)';
		});
		contextContainer.addEventListener('mouseleave', () => {
			if (!this.isEditingLimit) {
				contextContainer.style.backgroundColor = 'transparent';
			}
		});


		// Spacer to push everything to the left
		const spacer = toolbar.createEl('div');
		spacer.style.flex = '1';

		// Thinking level selector (with label integrated)
		this.thinkingDropdown = new DropdownComponent(toolbar);
		this.thinkingDropdown
			.addOption('off', 'Thinking: Off')
			.addOption('low', 'Thinking: Low')
			.addOption('medium', 'Thinking: Medium')
			.addOption('high', 'Thinking: High')
			.setValue(this.settings.thinkingLevel)
			.onChange(async (value: any) => {
				this.settings.thinkingLevel = value;
				// Update default setting so new chats use this value
				await this.onSaveSettings();
			});
		
		// Initially hide if model doesn't support thinking
		this.updateThinkingDropdownVisibility();

		// Context mode selector (with label integrated)
		const contextMode = new DropdownComponent(toolbar);
		contextMode
			.addOption('rolling', 'Context: Rolling')
			.addOption('compaction', 'Context: Compaction')
			.addOption('halting', 'Context: Halting')
			.setValue(this.session?.contextMode || this.settings.defaultContextMode)
			.onChange(async (value: any) => {
				if (this.session) {
					this.session.contextMode = value;
					this.session.updatedAt = Date.now();
					await this.onSaveSession(this.session);
					await this.updateContextDisplay();
				}
				// Update default setting so new chats use this value
				this.settings.defaultContextMode = value;
				await this.onSaveSettings();
			});

		// Model selector (with label integrated)
		this.modelDropdown = new DropdownComponent(toolbar);
		this.populateModelOptions();
		this.modelDropdown
			.setValue(this.session?.model || this.settings.defaultModel)
			.onChange(async (value) => {
				if (this.session) {
					this.session.model = value;
					this.session.updatedAt = Date.now();
					await this.onSaveSession(this.session);
					await this.loadModelInfo();
					await this.updateContextDisplay();
				}
				// Update default setting so new chats use this value
				this.settings.defaultModel = value;
				await this.onSaveSettings();
			});
	}

	private populateModelOptions(): void {
		// Try to load models from provider
		const provider = this.providerRegistry.getProvider(this.settings.provider);
		provider.listModels()
			.then(models => {
				this.modelDropdown.selectEl.empty();
				for (const model of models) {
					this.modelDropdown.addOption(model, `Model: ${model}`);
				}
				this.modelDropdown.setValue(this.session?.model || this.settings.defaultModel);
			})
			.catch(() => {
				// Fallback to default models
				this.modelDropdown
					.addOption('gpt-oss:20b', 'Model: gpt-oss:20b')
					.addOption('qwen3:4b', 'Model: qwen3:4b');
			});
	}

	private async loadModelInfo(): Promise<void> {
		try {
			const provider = this.providerRegistry.getProvider(this.settings.provider);
			const modelInfo = await provider.getModelInfo(this.session.model);
			this.modelContextLength = modelInfo.contextLength;
			this.modelSupportsThinking = modelInfo.supportsThinking;
		} catch (error) {
			console.error('[ChatView] Failed to load model info:', error);
			this.modelContextLength = 8192; // Default fallback
			this.modelSupportsThinking = false; // Default to no thinking support
		}
		
		// Update thinking dropdown visibility
		this.updateThinkingDropdownVisibility();
	}

	/**
	 * Update thinking dropdown visibility based on model support
	 */
	private updateThinkingDropdownVisibility(): void {
		if (!this.thinkingDropdown) return;

		if (this.modelSupportsThinking) {
			this.thinkingDropdown.selectEl.style.display = '';
		} else {
			this.thinkingDropdown.selectEl.style.display = 'none';
		}
	}

	private createChatMessagesArea(container: HTMLElement): void {
		// Outer scroll container (full width)
		this.scrollContainer = container.createEl('div');
		this.scrollContainer.setCssStyles({
			flex: '1',
			overflowY: 'auto',
			backgroundColor: 'transparent',
			minHeight: '100px',
			display: 'flex',
			justifyContent: 'center'
		});

		// Inner messages container (constrained width for readability)
		this.chatMessagesContainer = this.scrollContainer.createEl('div');
		this.chatMessagesContainer.setCssStyles({
			width: '100%',
			maxWidth: '900px',
			padding: '10px'
		});
	}

	private createInputSection(container: HTMLElement): void {
		this.inputContainer = container.createEl('div');
		this.inputContainer.style.flexShrink = '0';

		this.inputTextarea = new TextAreaComponent(this.inputContainer);
		this.inputTextarea.setPlaceholder('Enter to send, Shift+Enter for newline, Ctrl+R to regenerate, Ctrl+Shift+Enter to continue');
		this.inputTextarea.inputEl.rows = 1;

		// Style textarea
		this.inputTextarea.inputEl.setCssStyles({
			width: '100%',
			maxHeight: '200px',
			resize: 'none',
			padding: '8px',
			fontSize: '14px',
			lineHeight: '1.5'
		});

		// Keyboard handling
		this.inputTextarea.inputEl.addEventListener('keydown', async (evt: KeyboardEvent) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				await this.handleSendMessage();
			}
			// ESC is handled by the view's scope.register, not here
			// This prevents duplicate handlers and ensures proper scope management
		});

		// Auto-grow
		this.inputTextarea.inputEl.addEventListener('input', () => this.autoGrowTextarea());

		// Auto-focus
		this.inputTextarea.inputEl.focus();
	}

	private autoGrowTextarea(): void {
		const textarea = this.inputTextarea.inputEl;
		textarea.style.height = 'auto';
		const newHeight = Math.min(textarea.scrollHeight, 200);
		textarea.style.height = newHeight + 'px';
	}

	private async handleSendMessage(): Promise<void> {
		const content = this.inputTextarea.getValue().trim();
		if (!content || !this.session) return;

		// Create user message
		const userMessage: DelverMessage = {
			id: generateMessageId(),
			role: 'user',
			content,
			timestamp: Date.now()
		};

		// Add to session
		this.session.messages.push(userMessage);
		this.session.updatedAt = Date.now();

		// Always update tab title to first 45 characters of user message (strip leading whitespace)
		let title = content.trimStart(); // Strip leading whitespace only
		if (title.length > 45) {
			title = title.substring(0, 45) + '...';
		}
		// Fallback if title is empty
		if (!title) {
			title = 'New Chat';
		}
		this.session.name = title;
		
		// Trigger Obsidian to update by calling requestSave (if it exists)
		// This may cause Obsidian to re-read getDisplayText()
		if ((this as any).requestSave) {
			(this as any).requestSave();
		}
		
		// Update the tab title immediately
		this.updateTabTitle();
		
		await this.onSaveSession(this.session);

		// Clear input
		this.inputTextarea.setValue('');
		this.autoGrowTextarea();

		// Render messages
		this.renderMessages();
		await this.updateContextDisplay();
		
		// Update tab title multiple times with increasing delays to catch DOM updates
		const delays = [50, 150, 300, 500];
		for (const delay of delays) {
			setTimeout(() => {
				this.updateTabTitle();
			}, delay);
		}

		// Start generation
		await this.runChatLoop();
	}

	private async runChatLoop(): Promise<void> {
		if (!this.session) return;

		// Create abort controller
		this.abortController = new AbortController();

		// Update input placeholder
		this.inputTextarea.setPlaceholder('Press ESC to cancel...');
		this.inputTextarea.setDisabled(true);

		// Enable auto-scroll for this generation
		this.shouldAutoScroll = true;
		this.setupScrollDetection();

		// Show loading indicator
		const loadingEl = this.createLoadingIndicator();

		// Get provider
		const provider = this.providerRegistry.getProvider(this.settings.provider);

		// Create chat loop
		const chatLoop = new ChatLoop(
			provider,
			this.toolRegistry,
			this.permissionManager,
			this.contextManager,
			this.modelContextLength
		);

		// Tool execution context
		const toolContext: ToolExecutionContext = {
			vaultPath: '', // Not used - tools use app.vault for validation
			sessionId: this.session.id,
			app: this.app
		};

		// Create streaming message container
		let streamingMessageEl: HTMLElement | null = null;
		let streamingContentEl: HTMLElement | null = null;
		let streamingThinkingEl: HTMLElement | null = null;
		let accumulatedContent = '';
		let accumulatedThinking = '';
		let wasCancelled = false;
		let hasStartedContent = false; // Track if we've started content (to collapse thinking)

		try {
			await chatLoop.run(
				this.session,
				toolContext,
				{
					onChunk: (chunk: GenerationChunk) => {
						// Ensure loading indicator stays at bottom when new chunks arrive
						this.moveLoadingIndicatorToBottom();

						if (chunk.type === 'thinking') {
							// Create streaming message if it doesn't exist
							if (!streamingMessageEl) {
								streamingMessageEl = this.createStreamingMessage();
								streamingContentEl = streamingMessageEl.querySelector('.message-content') as HTMLElement;
								streamingThinkingEl = streamingMessageEl.querySelector('.streaming-thinking') as HTMLElement;
							}

						// Show and update thinking (only if we haven't started content yet)
						if (streamingThinkingEl && chunk.thinking && !hasStartedContent) {
							accumulatedThinking += chunk.thinking;
							streamingThinkingEl.style.display = 'block';
							
							// Clear and rebuild with icon
							streamingThinkingEl.empty();
							streamingThinkingEl.style.display = 'flex';
							streamingThinkingEl.style.alignItems = 'center';
							streamingThinkingEl.style.gap = '6px';
							
							const thinkingIcon = streamingThinkingEl.createSpan();
							thinkingIcon.style.display = 'flex';
							thinkingIcon.style.alignItems = 'center';
							setIcon(thinkingIcon, 'brain');
							
							streamingThinkingEl.createSpan({ text: accumulatedThinking });

								// Smart auto-scroll
								this.performAutoScroll();
							}
						} else if (chunk.type === 'content') {
							// Create streaming message if it doesn't exist
							if (!streamingMessageEl) {
								streamingMessageEl = this.createStreamingMessage();
								streamingContentEl = streamingMessageEl.querySelector('.message-content') as HTMLElement;
								streamingThinkingEl = streamingMessageEl.querySelector('.streaming-thinking') as HTMLElement;
							}

							// First content chunk? Collapse thinking!
							if (!hasStartedContent && streamingThinkingEl && accumulatedThinking) {
								hasStartedContent = true;
								
								// Convert to collapsible details
								const thinkingDetails = document.createElement('details');
								thinkingDetails.style.marginBottom = '8px';
								
				const summary = thinkingDetails.createEl('summary');
				summary.style.cursor = 'pointer';
				summary.style.color = 'var(--text-muted)';
				summary.style.userSelect = 'none';
				summary.style.display = 'flex';
				summary.style.alignItems = 'center';
				summary.style.gap = '6px';
				
				const thinkingIcon = summary.createSpan();
				thinkingIcon.style.display = 'flex';
				thinkingIcon.style.alignItems = 'center';
				setIcon(thinkingIcon, 'brain');
				
				const preview = accumulatedThinking.substring(0, 60);
				const hasMore = accumulatedThinking.length > 60;
				summary.createSpan({ text: `Thinking: ${preview}${hasMore ? '...' : ''}` });
								
								const thinkingContent = thinkingDetails.createEl('div');
								thinkingContent.style.marginTop = '4px';
								thinkingContent.style.padding = '8px';
								thinkingContent.style.backgroundColor = 'var(--background-primary)';
								thinkingContent.style.borderRadius = '4px';
								thinkingContent.style.userSelect = 'text';
								thinkingContent.style.cursor = 'text';
								thinkingContent.style.fontSize = '0.9em';
								thinkingContent.style.color = 'var(--text-muted)';
								thinkingContent.style.fontStyle = 'italic';
								thinkingContent.setText(accumulatedThinking);
								
								// Replace the streaming thinking element
								streamingThinkingEl.replaceWith(thinkingDetails);
								streamingThinkingEl = null; // Don't update it anymore
							}

							// Accumulate and render markdown
							if (streamingContentEl && chunk.content) {
								hasStartedContent = true;
								accumulatedContent += chunk.content;
								streamingContentEl.empty();
								MarkdownRenderer.renderMarkdown(
									accumulatedContent,
									streamingContentEl,
									'',
									this
								);

								// Smart auto-scroll
								this.performAutoScroll();
							}
						}
					},
					onToolPermission: async (toolCall: ToolCall) => {
						return await this.showInlineToolPermission(toolCall);
					},
					onToolCallsComplete: async (message: DelverMessage) => {
						// Save session and re-render to show tool results
						// The message with tool calls is now finalized, so remove any old streaming message element
						// A new streaming message will be created when the next content chunk arrives
						const oldStreamingEl = streamingMessageEl;
						if (oldStreamingEl && oldStreamingEl.parentElement) {
							oldStreamingEl.remove();
							streamingMessageEl = null; // Reset so a new one can be created
							streamingContentEl = null;
							streamingThinkingEl = null;
							accumulatedContent = '';
							accumulatedThinking = '';
							hasStartedContent = false;
						}
						
						// But DON'T remove the loading indicator - generation is continuing
						this.session.updatedAt = Date.now();
						await this.onSaveSession(this.session);
						
						// Re-render messages to show tool results and the finalized message
						this.renderMessages();
						await this.updateContextDisplay();
						
						// Ensure loading indicator stays at bottom after re-render
						this.moveLoadingIndicatorToBottom();
					},
					onComplete: async (message: DelverMessage) => {
						// Remove loading indicator
						if (loadingEl && loadingEl.parentElement) {
							loadingEl.remove();
						}

						// Remove streaming message element (it will be replaced by the final rendered message)
						const streamEl = streamingMessageEl;
						if (streamEl && streamEl.parentElement) {
							streamEl.remove();
						}

						// Ensure message is marked as not streaming (should already be done by chat loop, but be safe)
						message.isStreaming = false;

						// Save session (message should already be in session.messages from chat loop)
						this.session.updatedAt = Date.now();
						await this.onSaveSession(this.session);

						// Re-render all messages (this will render the final message from session data)
						this.renderMessages();
						await this.updateContextDisplay();
					},
					onError: (error: string) => {
						console.error('[ChatView] Generation error:', error);
						
						// Remove loading indicator if still present
						if (loadingEl && loadingEl.parentElement) {
							loadingEl.remove();
						}
						
						// Check if this was a cancellation
						if (error === 'Generation cancelled' || this.abortController?.signal.aborted) {
							wasCancelled = true;
							// Don't show error for cancellations
							// Keep streaming message for now - finally block will handle it
						} else {
							// Remove streaming message for real errors
							const streamEl = streamingMessageEl;
							if (streamEl && streamEl.parentElement) {
								streamEl.remove();
							}
							// Show error
							this.showError(error);
						}
					}
				},
				this.abortController.signal
			);
		} finally {
			// Capture references at start of finally block 
			// Use type assertion to work around TypeScript control flow narrowing issues
			const streamingEl = streamingMessageEl as HTMLElement | null;
			const loadingIndicator = loadingEl as HTMLElement | null;

			// Remove loading indicator if still present
			if (loadingIndicator?.parentElement) {
				loadingIndicator.remove();
			}

			// If cancelled, save what we have so far
			if (wasCancelled && (accumulatedContent || accumulatedThinking) && this.session) {
				// Remove streaming message
				if (streamingEl?.parentElement) {
					streamingEl.remove();
				}

				// Create final message with what we have
				const partialMessage: DelverMessage = {
					id: generateMessageId(),
					role: 'assistant',
					content: accumulatedContent || '(cancelled)',
					timestamp: Date.now(),
					isStreaming: false
				};

				if (accumulatedThinking) {
					partialMessage.thinking = accumulatedThinking;
				}

				// Add to session
				this.session.messages.push(partialMessage);
				this.session.updatedAt = Date.now();
				await this.onSaveSession(this.session);

				// Re-render messages
				this.renderMessages();
				await this.updateContextDisplay();

				console.log('[ChatView] Saved partial message after cancellation');
			}

			// Reset input
			this.inputTextarea.setPlaceholder('Enter to send, Shift+Enter for newline, Ctrl+R to regenerate, Ctrl+Shift+Enter to continue');
			this.inputTextarea.setDisabled(false);
			this.inputTextarea.inputEl.focus();
			this.abortController = null;

			// Clean up scroll detection
			this.cleanupScrollDetection();
		}
	}

	/**
	 * Setup scroll detection to disable auto-scroll when user manually scrolls
	 */
	private setupScrollDetection(): void {
		// Clean up any existing listener
		this.cleanupScrollDetection();

		let isScrollingProgrammatically = false;

		this.scrollListener = () => {
			// If we're currently doing a programmatic scroll, ignore
			if (isScrollingProgrammatically) {
				return;
			}

			// Calculate how far from bottom we are
			const container = this.scrollContainer;
			const scrollTop = container.scrollTop;
			const scrollHeight = container.scrollHeight;
			const clientHeight = container.clientHeight;
			const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);

			// Only disable auto-scroll if user has scrolled UP significantly (more than 100px from bottom)
			// This prevents markdown rendering height changes from falsely triggering
			if (distanceFromBottom > 100) {
				this.shouldAutoScroll = false;
				console.log('[ChatView] User scrolled up - auto-scroll disabled (distance from bottom:', distanceFromBottom, 'px)');
			}
		};

		// Store the flag so performAutoScroll can set it
		(this.scrollContainer as any)._setScrollingProgrammatically = (value: boolean) => {
			isScrollingProgrammatically = value;
		};

		this.scrollContainer.addEventListener('scroll', this.scrollListener, { passive: true });
	}

	/**
	 * Clean up scroll detection listener
	 */
	private cleanupScrollDetection(): void {
		if (this.scrollListener && this.scrollContainer) {
			this.scrollContainer.removeEventListener('scroll', this.scrollListener);
			this.scrollListener = null;
		}
	}

	/**
	 * Perform auto-scroll if enabled
	 */
	private performAutoScroll(): void {
		if (!this.shouldAutoScroll || !this.scrollContainer) return;

		// Set flag to indicate this is programmatic scrolling
		const setScrolling = (this.scrollContainer as any)._setScrollingProgrammatically;
		if (setScrolling) {
			setScrolling(true);
		}

		// Use requestAnimationFrame to ensure DOM has updated before scrolling
		requestAnimationFrame(() => {
			// Scroll to bottom
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;

			// Reset flag after scroll completes
			setTimeout(() => {
				if (setScrolling) {
					setScrolling(false);
				}
			}, 50);
		});
	}

	private createLoadingIndicator(): HTMLElement {
		const loadingEl = this.chatMessagesContainer.createEl('div');
		loadingEl.setCssStyles({
			marginBottom: '12px',
			padding: '12px',
			borderRadius: '6px',
			backgroundColor: 'transparent',
			border: '1px solid var(--text-accent)',
			color: 'var(--text-muted)',
			fontStyle: 'italic',
			display: 'flex',
			alignItems: 'center',
			gap: '8px'
		});

		// Add a data attribute to identify this as the loading indicator
		loadingEl.dataset.loadingIndicator = 'true';

		loadingEl.createSpan({ text: 'Generating response...' });

		// Scroll to bottom (respects auto-scroll setting)
		this.performAutoScroll();

		return loadingEl;
	}

	/**
	 * Move the loading indicator to the bottom of the chat container
	 * This ensures it stays visible when new content is added
	 */
	private moveLoadingIndicatorToBottom(): void {
		const loadingIndicator = this.chatMessagesContainer.querySelector('[data-loading-indicator="true"]') as HTMLElement;
		if (loadingIndicator && loadingIndicator.parentElement === this.chatMessagesContainer) {
			// Move to end of container
			this.chatMessagesContainer.appendChild(loadingIndicator);
		}
	}

	/**
	 * Update the text of the loading indicator
	 */
	private updateLoadingIndicatorText(text: string): void {
		const loadingIndicator = this.chatMessagesContainer.querySelector('[data-loading-indicator="true"]') as HTMLElement;
		if (loadingIndicator) {
			const textSpan = loadingIndicator.querySelector('span');
			if (textSpan) {
				textSpan.textContent = text;
			}
		}
	}

	private createStreamingMessage(): HTMLElement {
		const messageEl = this.chatMessagesContainer.createEl('div');
		messageEl.setCssStyles({
			marginBottom: '12px',
			padding: '12px',
			borderRadius: '6px',
			backgroundColor: 'var(--background-secondary)',
			border: '1px solid var(--background-modifier-border-active-hover)',
			boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.1)'
			// All messages: full width, no left/right spacing
		});

		// Add data attribute to identify this as a streaming message element
		messageEl.dataset.streamingMessage = 'true';

		// Thinking container (hidden initially, shown when thinking arrives)
		const thinkingEl = messageEl.createEl('div', { cls: 'streaming-thinking' });
		thinkingEl.setCssStyles({
			fontSize: '0.9em',
			color: 'var(--text-muted)',
			fontStyle: 'italic',
			marginBottom: '8px',
			padding: '8px',
			backgroundColor: 'var(--background-primary)',
			borderRadius: '4px',
			display: 'none' // Hidden until we have thinking
		});

		// Role header (appears after thinking)
		const roleEl = messageEl.createEl('div', { text: this.settings.assistantName });
		roleEl.setCssStyles({
			fontWeight: '600',
			marginBottom: '8px',
			fontSize: '0.9em'
		});

		// Content
		const contentEl = messageEl.createEl('div', { cls: 'message-content' });
		contentEl.setCssStyles({
			fontSize: '14px',
			lineHeight: '1.6',
			userSelect: 'text',
			cursor: 'text'
		});

		// Scroll to bottom (respects auto-scroll setting)
		this.performAutoScroll();

		return messageEl;
	}

	private showError(error: string): void {
		const errorEl = this.chatMessagesContainer.createEl('div');
		errorEl.setCssStyles({
			marginBottom: '12px',
			padding: '12px',
			borderRadius: '6px',
			backgroundColor: 'var(--background-modifier-error)',
			color: 'var(--text-error)',
			border: '1px solid var(--background-modifier-border)'
		});
		errorEl.setText(`Error: ${error}`);
	}

	private renderMessages(scrollToBottom: boolean = true): void {
		if (!this.chatMessagesContainer || !this.session) return;

		// Preserve loading indicator, streaming message, and permission prompts when re-rendering
		const loadingIndicator = this.chatMessagesContainer.querySelector('[data-loading-indicator="true"]') as HTMLElement;
		const streamingMessage = this.chatMessagesContainer.querySelector('[data-streaming-message="true"]') as HTMLElement;
		const permissionPrompts = Array.from(this.chatMessagesContainer.querySelectorAll('.tool-permission-request')) as HTMLElement[];

		// Remove all children EXCEPT the preserved elements to avoid resetting animations
		// This keeps the spinner's CSS animation running smoothly and preserves streaming content
		// Note: We preserve the streaming message element if it exists - it will be removed
		// by onComplete when generation finishes, or when a new streaming message is created
		const children = Array.from(this.chatMessagesContainer.children) as HTMLElement[];
		for (const child of children) {
			// Only remove if it's not a preserved element
			if (child !== loadingIndicator && 
			    child !== streamingMessage && 
			    !permissionPrompts.includes(child)) {
				child.remove();
			}
		}

		// Note: We don't need to re-append preserved elements since we didn't remove them

		// Don't render system message in UI
		const visibleMessages = this.session.messages.filter(m => m.role !== 'system');

		// Show/hide input container and welcome message based on message count
		if (visibleMessages.length === 0) {
			this.renderWelcomeMessage();
			// Hide normal input when welcome is shown
			if (this.inputContainer) {
				this.inputContainer.style.display = 'none';
			}
		} else {
			// Show normal input when messages exist
			if (this.inputContainer) {
				this.inputContainer.style.display = 'block';
			}
			// Clear welcome textarea reference when welcome is removed
			this.welcomeTextarea = null;
		}

		for (const message of visibleMessages) {
			this.renderMessage(message);
		}

		// Ensure loading indicator is at the bottom after rendering
		if (loadingIndicator) {
			this.moveLoadingIndicatorToBottom();
		}

		// Scroll to bottom if requested
		if (scrollToBottom && this.scrollContainer) {
			this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
		}
	}

	/**
	 * Render welcome message for new chats
	 */
	private renderWelcomeMessage(): void {
		if (!this.chatMessagesContainer) return;

		const welcomeEl = this.chatMessagesContainer.createEl('div');
		welcomeEl.setAttribute('data-welcome-message', 'true');
		welcomeEl.setCssStyles({
			marginBottom: '24px',
			padding: '24px',
			borderRadius: '8px',
			backgroundColor: 'var(--background-primary)',
			border: '1px solid var(--background-modifier-border)',
			textAlign: 'left'
		});

		// Welcome title
		const titleEl = welcomeEl.createEl('h2', {
			text: 'Welcome to Delver Chat'
		});
		titleEl.setCssStyles({
			margin: '0 0 12px 0',
			fontSize: '1.5em',
			fontWeight: '600',
			color: 'var(--text-normal)'
		});

		// Welcome description
		const descEl = welcomeEl.createEl('p', {
			text: 'Start a conversation by typing a message below. You can ask questions, request help with your notes, or explore your vault.'
		});
		descEl.setCssStyles({
			margin: '0 0 16px 0',
			color: 'var(--text-muted)',
			lineHeight: '1.6',
			fontSize: '0.95em'
		});

		// Tips section
		const tipsEl = welcomeEl.createEl('div');
		tipsEl.setCssStyles({
			marginTop: '20px',
			paddingTop: '20px',
			borderTop: '1px solid var(--background-modifier-border)',
			textAlign: 'left'
		});

		const tipsTitle = tipsEl.createEl('h3', {
			text: 'Getting started'
		});
		tipsTitle.setCssStyles({
			margin: '0 0 12px 0',
			fontSize: '1em',
			fontWeight: '600',
			color: 'var(--text-normal)'
		});

		const tipsList = tipsEl.createEl('ul');
		tipsList.setCssStyles({
			margin: '0',
			paddingLeft: '20px',
			color: 'var(--text-muted)',
			lineHeight: '1.8',
			fontSize: '0.9em'
		});

		const tips = [
			'Type your message and press Enter to send',
			'Use Shift+Enter for a new line',
			"Press Ctrl+Shift+C to open a new chat",
			'Press Ctrl+R to regenerate the last response',
			'Use Ctrl+Shift+Enter to continue a response',
			'Hold Ctrl while clicking delete buttons to skip confirmation',
		];

		for (const tip of tips) {
			const tipItem = tipsList.createEl('li', { text: tip });
			tipItem.style.marginBottom = '4px';
		}

		// Input section for first message
		const inputSection = welcomeEl.createEl('div');
		inputSection.setCssStyles({
			marginTop: '24px',
			paddingTop: '24px',
			borderTop: '1px solid var(--background-modifier-border)'
		});

		const welcomeInputContainer = inputSection.createEl('div');
		welcomeInputContainer.setCssStyles({
			display: 'flex',
			flexDirection: 'column',
			gap: '8px'
		});

		this.welcomeTextarea = welcomeInputContainer.createEl('textarea', {
			attr: {
				placeholder: 'Type your first message here...',
				rows: '3'
			}
		}) as HTMLTextAreaElement;
		this.welcomeTextarea.setCssStyles({
			width: '100%',
			padding: '12px',
			fontSize: '14px',
			lineHeight: '1.5',
			resize: 'vertical',
			borderRadius: '6px',
			border: '1px solid var(--background-modifier-border)',
			backgroundColor: 'var(--background-primary)',
			color: 'var(--text-normal)',
			fontFamily: 'inherit'
		});

		// Auto-focus the welcome input
		setTimeout(() => {
			this.welcomeTextarea?.focus();
		}, 100);

		// Handle Enter key (send message)
		this.welcomeTextarea.addEventListener('keydown', async (evt: KeyboardEvent) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				const content = this.welcomeTextarea?.value.trim();
				if (content && this.session) {
					// Create user message
					const userMessage: DelverMessage = {
						id: generateMessageId(),
						role: 'user',
						content,
						timestamp: Date.now()
					};

					// Add to session
					this.session.messages.push(userMessage);
					this.session.updatedAt = Date.now();

					// Update session name
					let title = content.trimStart();
					if (title.length > 45) {
						title = title.substring(0, 45) + '...';
					}
					if (!title) {
						title = 'New Chat';
					}
					this.session.name = title;

					// Trigger save
					if ((this as any).requestSave) {
						(this as any).requestSave();
					}
					
					this.updateTabTitle();
					await this.onSaveSession(this.session);

					// Clear welcome input
					if (this.welcomeTextarea) {
						this.welcomeTextarea.value = '';
					}
					// Clear reference when welcome is removed
					this.welcomeTextarea = null;

					// Render messages (this will hide welcome and show normal input)
					this.renderMessages();
					await this.updateContextDisplay();

					// Focus normal input after rendering
					setTimeout(() => {
						if (this.inputTextarea) {
							this.inputTextarea.inputEl.focus();
						}
					}, 100);

					// Start generation
					await this.runChatLoop();
				}
			}
		});
	}

	/**
	 * Render vault_read result with preview and gradient
	 */
	private renderVaultReadResult(message: DelverMessage, container: HTMLElement): void {
		// Extract file path from the session's tool calls
		let filePath = 'Unknown file';
		let isError = false;
		if (this.session) {
			// Find the corresponding tool call
			for (const msg of this.session.messages) {
				if (msg.tool_calls) {
					for (const tc of msg.tool_calls) {
						if (tc.function.name === 'vault_read') {
							// Match by result or error (when tool fails, error is in message.content)
							if (tc.result === message.content || tc.error === message.content) {
								filePath = tc.function.arguments.path;
								isError = !!tc.error || message.content.startsWith('File not found');
								break;
							}
						}
					}
				}
			}
		}

		// Check if content indicates a file not found error
		if (!isError && message.content.startsWith('File not found')) {
			isError = true;
		}

		const contentLength = message.content.length;
		
		// Custom expandable container (not using details/summary to show preview by default)
		const expandableContainer = container.createEl('div');
		expandableContainer.style.marginBottom = '8px';
		
		// Toggle header
		const header = expandableContainer.createEl('div');
		header.setCssStyles({
			cursor: 'pointer',
			userSelect: 'none',
			marginBottom: '8px',
			fontWeight: '500',
			display: 'flex',
			alignItems: 'center',
			gap: '6px'
		});
		
		const chevron = header.createSpan();
		chevron.style.display = 'flex';
		chevron.style.alignItems = 'center';
		chevron.style.transition = 'transform 0.2s';
		setIcon(chevron, 'chevron-right');

		const fileIcon = header.createSpan();
		fileIcon.style.display = 'flex';
		fileIcon.style.alignItems = 'center';
		setIcon(fileIcon, 'file-text');
		
		const fileContentsText = header.createSpan({ text: `File Contents (${contentLength.toLocaleString()} chars)` });
		fileContentsText.style.color = 'var(--text-normal)';
		fileContentsText.style.fontWeight = '500';
		
		const clickText = header.createSpan({ text: ` Click to ${contentLength > 500 ? 'view full' : 'collapse'}` });
		clickText.style.color = 'var(--text-faint)';
		clickText.style.fontWeight = '400';
		clickText.style.opacity = '0.7';

		// Preview container with gradient (shown by default)
		const previewContainer = expandableContainer.createEl('div');
		previewContainer.setCssStyles({
			position: 'relative',
			marginBottom: '8px',
			cursor: 'pointer'
		});

		const previewContent = previewContainer.createEl('div');
		previewContent.setCssStyles({
			padding: '8px',
			backgroundColor: 'var(--background-primary)',
			borderRadius: '4px',
			fontSize: '0.9em',
			lineHeight: '1.6',
			maxHeight: '150px',
			overflow: 'hidden',
			position: 'relative'
		});

		// Render markdown preview (first ~500 chars)
		const previewText = message.content.substring(0, 500);
		MarkdownRenderer.renderMarkdown(previewText, previewContent, '', this);

		// Gradient overlay to indicate more content (only if content is longer)
		if (message.content.length > 500) {
			const gradient = previewContainer.createEl('div');
			gradient.setCssStyles({
				position: 'absolute',
				bottom: '0',
				left: '0',
				right: '0',
				height: '60px',
				background: 'linear-gradient(to bottom, transparent, var(--background-primary))',
				pointerEvents: 'none'
			});
		}

		// Full content (hidden initially)
		const fullContent = expandableContainer.createEl('div');
		fullContent.setCssStyles({
			padding: '8px',
			backgroundColor: 'var(--background-primary)',
			borderRadius: '4px',
			fontSize: '14px',
			lineHeight: '1.6',
			userSelect: 'text',
			cursor: 'text',
			maxHeight: '600px',
			overflow: 'auto',
			marginBottom: '8px',
			display: 'none'
		});
		MarkdownRenderer.renderMarkdown(message.content, fullContent, '', this);
		
		// Toggle between preview and full on click
		let isExpanded = false;
		const toggleExpand = () => {
			isExpanded = !isExpanded;
			
			if (isExpanded) {
				// Show full content
				previewContainer.style.display = 'none';
				fullContent.style.display = 'block';
				chevron.style.transform = 'rotate(90deg)';
			} else {
				// Show preview
				previewContainer.style.display = 'block';
				fullContent.style.display = 'none';
				chevron.style.transform = 'rotate(0deg)';
			}
		};

		header.addEventListener('click', toggleExpand);
		previewContainer.addEventListener('click', toggleExpand);

		// Link to open file (only show if file was found successfully)
		if (!isError && filePath !== 'Unknown file') {
			const linkEl = container.createEl('a', {
				attr: { style: 'display: inline-flex; align-items: center; gap: 4px; color: var(--text-accent); cursor: pointer; font-size: 0.9em;' }
			});
			const linkIcon = linkEl.createSpan();
			linkIcon.style.display = 'flex';
			linkIcon.style.alignItems = 'center';
			setIcon(linkIcon, 'link');
			linkEl.createSpan({ text: `Open ${filePath} in Obsidian` });
			linkEl.onclick = () => {
				this.app.workspace.openLinkText(filePath, '', false);
			};
		}
	}

	/**
	 * Render tool result message with special formatting
	 */
	private renderToolResultMessage(message: DelverMessage, container: HTMLElement): void {
		const toolName = message.tool_name || 'unknown';
		
		// Handle vault_read specially with preview + gradient
		if (toolName === 'vault_read') {
			this.renderVaultReadResult(message, container);
			return;
		}
		
		// Try to parse as JSON and format nicely
		let formatted = false;
		try {
			const result = JSON.parse(message.content);
			
			// Handle vault_search results
			if (toolName === 'vault_search' && result.files && Array.isArray(result.files)) {
				const headerEl = container.createEl('div', {
					text: `Found ${result.count} file(s) matching "${result.query}"`,
					attr: { style: 'margin-bottom: 8px; font-weight: 500;' }
				});

				if (result.files.length > 0) {
					const filesContainer = container.createEl('div');
					filesContainer.setCssStyles({
						maxHeight: '200px',
						overflow: 'auto',
						padding: '4px',
						backgroundColor: 'var(--background-primary)',
						borderRadius: '4px'
					});
					
					for (const filePath of result.files) {
						const linkEl = filesContainer.createEl('a', {
							attr: { style: 'display: flex; align-items: center; gap: 4px; margin-bottom: 4px; color: var(--text-accent); cursor: pointer;' }
						});
						const fileIcon = linkEl.createSpan();
						fileIcon.style.display = 'flex';
						fileIcon.style.alignItems = 'center';
						setIcon(fileIcon, 'file-text');
						linkEl.createSpan({ text: filePath });
						linkEl.onclick = () => {
							this.app.workspace.openLinkText(filePath, '', false);
						};
					}
				}
				formatted = true;
			}
			
			// Handle list_references results
			else if (toolName === 'list_references' && result.files && Array.isArray(result.files)) {
				if (result.count === 0) {
					container.createEl('div', {
						text: result.message || 'No file references found in this conversation.',
						attr: { style: 'color: var(--text-muted); font-style: italic;' }
					});
				} else {
					container.createEl('div', {
						text: `${result.count} reference(s) (${result.unique_count} unique):`,
						attr: { style: 'margin-bottom: 8px; font-weight: 500;' }
					});

					const filesContainer = container.createEl('div');
					filesContainer.setCssStyles({
						maxHeight: '200px',
						overflow: 'auto',
						padding: '4px',
						backgroundColor: 'var(--background-primary)',
						borderRadius: '4px'
					});
					
					for (const filePath of result.files) {
						const linkEl = filesContainer.createEl('a', {
							attr: { style: 'display: flex; align-items: center; gap: 4px; margin-bottom: 4px; color: var(--text-accent); cursor: pointer;' }
						});
						const fileIcon = linkEl.createSpan();
						fileIcon.style.display = 'flex';
						fileIcon.style.alignItems = 'center';
						setIcon(fileIcon, 'file-text');
						linkEl.createSpan({ text: filePath });
						linkEl.onclick = () => {
							this.app.workspace.openLinkText(filePath, '', false);
						};
					}
				}
				formatted = true;
			}
		} catch (e) {
			// Not JSON or parsing failed, fall back to default rendering
		}

		// If we didn't format it specially, show collapsible raw content
		if (!formatted) {
			const contentDetails = container.createEl('details');
			contentDetails.style.marginBottom = '8px';

			const summary = contentDetails.createEl('summary');
			summary.style.cursor = 'pointer';
			summary.style.color = 'var(--text-muted)';
			summary.style.userSelect = 'none';

			const contentLength = message.content.length;
			const preview = message.content.substring(0, 100);
			const hasMore = contentLength > 100;
			summary.setText(`📦 Result (${contentLength.toLocaleString()} chars): ${preview}${hasMore ? '...' : ''}`);

			const contentEl = contentDetails.createEl('div', { cls: 'message-content' });
			contentEl.setCssStyles({
				marginTop: '4px',
				padding: '8px',
				backgroundColor: 'var(--background-primary)',
				borderRadius: '4px',
				fontSize: '14px',
				lineHeight: '1.6',
				userSelect: 'text',
				cursor: 'text',
				maxHeight: '400px',
				overflow: 'auto'
			});
			MarkdownRenderer.renderMarkdown(message.content, contentEl, '', this);
		}
	}

	private renderMessage(message: DelverMessage): void {
		const messageEl = this.chatMessagesContainer.createEl('div');
		messageEl.dataset.messageId = message.id; // Add data attribute for editing
		
		// Base styles
		const baseStyles: Record<string, string> = {
			marginBottom: '12px',
			padding: '12px',
			borderRadius: '6px'
		};

		// Different styling for tool messages to make them highly scannable
		if (message.role === 'assistant') {
			baseStyles.backgroundColor = 'var(--background-primary)';
			baseStyles.border = '1px solid var(--background-modifier-border-active-hover)';
			baseStyles.boxShadow = 'inset 0 0 0 1px rgba(0, 0, 0, 0.1)';
		} else {
			baseStyles.backgroundColor = message.role === 'user'
				?
				'var(--background-secondary-alt)'
				: 
				'var(--background-primary-alt)'
				;
			baseStyles.border = '1px solid var(--background-modifier-border)';
		}

		// All messages: full width, no left/right spacing

		messageEl.setCssStyles(baseStyles);
		
		// Reduce top padding for user messages since they don't have role headers
		if (message.role === 'user') {
			messageEl.style.paddingTop = '0px';
		}

		// Thinking (collapsible with preview) - render first
		if (message.thinking) {
			const thinkingContainer = messageEl.createEl('div');
			thinkingContainer.dataset.thinkingContainer = 'true';
			thinkingContainer.style.marginBottom = '8px';

			const thinkingDetails = thinkingContainer.createEl('details');

			// Create summary with preview
			const summary = thinkingDetails.createEl('summary');
			summary.style.cursor = 'pointer';
			summary.style.color = 'var(--text-faint)';
			summary.style.display = 'flex';
			summary.style.alignItems = 'center';
			summary.style.gap = '6px';

			const chevron = summary.createSpan();
			chevron.style.display = 'flex';
			chevron.style.alignItems = 'center';
			chevron.style.transition = 'transform 0.2s';
			setIcon(chevron, 'chevron-right');

			const thinkingIcon = summary.createSpan();
			thinkingIcon.style.display = 'flex';
			thinkingIcon.style.alignItems = 'center';
			setIcon(thinkingIcon, 'brain');

			const preview = message.thinking.substring(0, 60);
			const hasMore = message.thinking.length > 60;
			summary.createSpan({ text: `${preview}${hasMore ? '...' : ''}` });

			// Toggle chevron on open/close
			thinkingDetails.addEventListener('toggle', () => {
				if (thinkingDetails.open) {
					chevron.style.transform = 'rotate(90deg)';
				} else {
					chevron.style.transform = 'rotate(0deg)';
				}
			});

			const thinkingContent = thinkingDetails.createEl('div');
			thinkingContent.classList.add('thinking-content');
			thinkingContent.style.marginTop = '4px';
			thinkingContent.style.padding = '8px';
			thinkingContent.style.backgroundColor = 'var(--background-primary)';
			thinkingContent.style.borderRadius = '4px';
			thinkingContent.style.border = '1px solid var(--background-modifier-border)';
			thinkingContent.style.userSelect = 'text';
			thinkingContent.style.cursor = 'text';
			MarkdownRenderer.renderMarkdown(message.thinking, thinkingContent, '', this);

			// Thinking actions
			const thinkingActions = thinkingContainer.createEl('div');
			thinkingActions.dataset.thinkingActions = 'true';
			thinkingActions.setCssStyles({
				display: 'flex',
				gap: '6px',
				marginTop: '4px',
				justifyContent: 'flex-end',
				alignItems: 'center'
			});

			// Helper to highlight thinking section on hover (using outline to avoid layout jitter)
			// Highlight both the thinking container and message content wrapper (if it exists)
			// Find the message container and message content wrapper
			const messageContainer = thinkingContainer.closest('[data-message-id]') as HTMLElement;
			const messageContentWrapper = messageContainer?.querySelector('[data-message-content-wrapper]') as HTMLElement;
			
			const highlightThinking = () => {
				if (thinkingContainer) {
					thinkingContainer.style.outline = '2px solid var(--text-accent)';
					thinkingContainer.style.outlineOffset = '2px';
					thinkingContainer.style.borderRadius = '4px';
					thinkingContainer.style.transition = 'outline 0.2s';
				}
				if (messageContentWrapper) {
					messageContentWrapper.style.outline = '2px solid var(--text-accent)';
					messageContentWrapper.style.outlineOffset = '2px';
					messageContentWrapper.style.borderRadius = '4px';
					messageContentWrapper.style.transition = 'outline 0.2s';
				}
			};

			const unhighlightThinking = () => {
				if (thinkingContainer) {
					thinkingContainer.style.outline = '';
					thinkingContainer.style.outlineOffset = '';
					thinkingContainer.style.borderRadius = '';
				}
				if (messageContentWrapper) {
					messageContentWrapper.style.outline = '';
					messageContentWrapper.style.outlineOffset = '';
					messageContentWrapper.style.borderRadius = '';
				}
			};

			// Edit thinking
			const editThinkingBtn = thinkingActions.createEl('button', {
				attr: { 'aria-label': 'Edit thinking' }
			});
			editThinkingBtn.style.padding = '4px';
			editThinkingBtn.style.display = 'flex';
			editThinkingBtn.style.alignItems = 'center';
			editThinkingBtn.style.backgroundColor = 'transparent';
			editThinkingBtn.style.border = 'none';
			editThinkingBtn.style.boxShadow = 'none';
			editThinkingBtn.style.outline = 'none';
			editThinkingBtn.style.transition = 'background-color 0.2s';
			editThinkingBtn.onmouseenter = () => {
				editThinkingBtn.style.backgroundColor = 'var(--background-modifier-hover)';
				highlightThinking();
			};
			editThinkingBtn.onmouseleave = () => {
				editThinkingBtn.style.backgroundColor = 'transparent';
				unhighlightThinking();
			};
			setIcon(editThinkingBtn, 'pencil');
			editThinkingBtn.onclick = () => this.editThinking(message, thinkingContent, thinkingDetails);

			// Delete thinking
			const deleteThinkingBtn = thinkingActions.createEl('button', {
				attr: { 'aria-label': 'Delete thinking' }
			});
			deleteThinkingBtn.style.padding = '4px';
			deleteThinkingBtn.style.display = 'flex';
			deleteThinkingBtn.style.alignItems = 'center';
			deleteThinkingBtn.style.backgroundColor = 'transparent';
			deleteThinkingBtn.style.border = 'none';
			deleteThinkingBtn.style.boxShadow = 'none';
			deleteThinkingBtn.style.outline = 'none';
			deleteThinkingBtn.style.transition = 'background-color 0.2s';
			deleteThinkingBtn.dataset.confirmState = 'initial';
			deleteThinkingBtn.onmouseenter = () => {
				if (deleteThinkingBtn.dataset.confirmState !== 'confirming') {
					deleteThinkingBtn.style.backgroundColor = 'var(--background-modifier-hover)';
					highlightThinking();
				}
			};
			deleteThinkingBtn.onmouseleave = () => {
				if (deleteThinkingBtn.dataset.confirmState !== 'confirming') {
					deleteThinkingBtn.style.backgroundColor = 'transparent';
					unhighlightThinking();
				}
			};
			setIcon(deleteThinkingBtn, 'trash-2');
			deleteThinkingBtn.onclick = async (e: MouseEvent) => {
				if (deleteThinkingBtn.dataset.confirmState === 'initial') {
					// If CTRL is held, bypass confirmation and delete immediately
					if (e.ctrlKey || e.metaKey) {
						await this.deleteThinking(message);
						return;
					}
					deleteThinkingBtn.dataset.confirmState = 'confirming';
					deleteThinkingBtn.style.backgroundColor = 'var(--color-red)';
					deleteThinkingBtn.style.color = 'white';
					setTimeout(() => {
						if (deleteThinkingBtn.dataset.confirmState === 'confirming') {
							deleteThinkingBtn.dataset.confirmState = 'initial';
							deleteThinkingBtn.style.backgroundColor = '';
							deleteThinkingBtn.style.color = '';
						}
					}, 3000);
				} else if (deleteThinkingBtn.dataset.confirmState === 'confirming') {
					await this.deleteThinking(message);
				}
			};
		}

		// Tool calls (collapsible) - render before message content
		if (message.tool_calls) {
			for (let toolCallIndex = 0; toolCallIndex < message.tool_calls.length; toolCallIndex++) {
				const toolCall = message.tool_calls[toolCallIndex];
				// Create wrapper for tool call (details + actions outside)
				const toolCallWrapper = messageEl.createEl('div');
				toolCallWrapper.dataset.toolCallWrapper = 'true';
				toolCallWrapper.style.marginTop = '8px';
				
				const toolDetails = toolCallWrapper.createEl('details');
				toolDetails.dataset.toolCallIndex = toolCallIndex.toString();

				// Create enhanced summary with preview
				const summary = toolDetails.createEl('summary');
				summary.style.cursor = 'pointer';
				summary.style.color = 'var(--text-faint)';
				summary.style.userSelect = 'none';
				summary.style.display = 'flex';
				summary.style.alignItems = 'center';
				summary.style.gap = '6px';

				const chevron = summary.createSpan();
				chevron.style.display = 'flex';
				chevron.style.alignItems = 'center';
				chevron.style.transition = 'transform 0.2s';
				setIcon(chevron, 'chevron-right');

				const toolIcon = summary.createSpan();
				toolIcon.style.display = 'flex';
				toolIcon.style.alignItems = 'center';
				setIcon(toolIcon, 'wrench');

				// Build summary text with result size
				let summaryText = `${toolCall.function.name}`;

				// Add argument preview for certain tools
				if (toolCall.function.name === 'vault_read' && toolCall.function.arguments.path) {
					summaryText += `("${toolCall.function.arguments.path}")`;
				} else if (toolCall.function.name === 'vault_search' && toolCall.function.arguments.query) {
					summaryText += `("${toolCall.function.arguments.query}")`;
				} else if (toolCall.function.name === 'list_references') {
					summaryText += `()`;
				}

				// Add result size
				if (toolCall.result) {
					const resultSize = toolCall.result.length;
					summaryText += ` → ${resultSize.toLocaleString()} chars`;
				} else if (toolCall.error) {
					summaryText += ` → Error`;
				} else if (toolCall.permissionStatus === 'denied') {
					summaryText += ` → Denied`;
				}

				summary.createSpan({ text: summaryText });

				// Toggle chevron on open/close
				toolDetails.addEventListener('toggle', () => {
					if (toolDetails.open) {
						chevron.style.transform = 'rotate(90deg)';
					} else {
						chevron.style.transform = 'rotate(0deg)';
					}
				});

				const toolContent = toolDetails.createEl('div');
				toolContent.dataset.toolContent = 'true';
				toolContent.style.marginTop = '4px';
				toolContent.style.padding = '8px';
				toolContent.style.backgroundColor = 'var(--background-primary)';
				toolContent.style.borderRadius = '4px';
				toolContent.style.border = '1px solid var(--background-modifier-border)';

				// Arguments
				toolContent.createEl('div', {
					text: 'Arguments:',
					attr: { style: 'font-weight: 600; margin-bottom: 4px;' }
				});
				const argsEl = toolContent.createEl('pre');
				argsEl.style.fontSize = '0.9em';
				argsEl.style.userSelect = 'text';
				argsEl.style.cursor = 'text';
				argsEl.setText(JSON.stringify(toolCall.function.arguments, null, 2));

				// Status
				if (toolCall.permissionStatus) {
					const statusColor = toolCall.permissionStatus === 'approved' ? 'var(--text-success)' :
						toolCall.permissionStatus === 'denied' ? 'var(--text-error)' : 'var(--text-muted)';
					toolContent.createEl('div', {
						text: `Status: ${toolCall.permissionStatus}`,
						attr: { style: `margin-top: 8px; font-weight: 600; color: ${statusColor};` }
					});
				}

				// Result/Error
				if (toolCall.result) {
					toolContent.createEl('div', {
						text: 'Result:',
						attr: { style: 'font-weight: 600; margin-top: 8px; margin-bottom: 4px;' }
					});

					let showRawResult = true; // Flag to control raw result display

					// Special handling for vault_read - add clickable file link and size
					if (toolCall.function.name === 'vault_read' && toolCall.function.arguments.path) {
						const resultSize = toolCall.result.length;
						const fileLinkEl = toolContent.createEl('a', {
							attr: { style: 'display: flex; align-items: center; gap: 4px; margin-bottom: 8px; color: var(--text-accent); cursor: pointer;' }
						});
						const fileIcon = fileLinkEl.createSpan();
						fileIcon.style.display = 'flex';
						fileIcon.style.alignItems = 'center';
						setIcon(fileIcon, 'file-text');
						fileLinkEl.createSpan({ text: `${toolCall.function.arguments.path} (${resultSize.toLocaleString()} chars)` });
						fileLinkEl.onclick = () => {
							this.app.workspace.openLinkText(toolCall.function.arguments.path, '', false);
						};
						
						// Add note that full content is in tool result message
						toolContent.createEl('div', {
							text: '(Full content available in tool result message below)',
							attr: { style: 'font-size: 0.85em; color: var(--text-muted); margin-bottom: 8px; font-style: italic;' }
						});
						
						showRawResult = false; // Don't show massive raw result here
					}

					// Special handling for vault_search - render file links (compact)
					if (toolCall.function.name === 'vault_search') {
						try {
							const searchResult = JSON.parse(toolCall.result);
							if (searchResult.files && Array.isArray(searchResult.files)) {
								// Show count
								toolContent.createEl('div', {
									text: `Found ${searchResult.count} file(s) matching "${searchResult.query}"`,
									attr: { style: 'margin-bottom: 8px; font-weight: 500;' }
								});

								// Render clickable file links in a scrollable container
								const filesContainer = toolContent.createEl('div');
								filesContainer.setCssStyles({
									marginBottom: '8px',
									maxHeight: '200px',
									overflow: 'auto',
									padding: '4px',
									backgroundColor: 'var(--background-primary)',
									borderRadius: '4px'
								});
								
								for (const filePath of searchResult.files) {
									const linkEl = filesContainer.createEl('a', {
										attr: { style: 'display: flex; align-items: center; gap: 4px; margin-bottom: 4px; color: var(--text-accent); cursor: pointer;' }
									});
									const fileIcon = linkEl.createSpan();
									fileIcon.style.display = 'flex';
									fileIcon.style.alignItems = 'center';
									setIcon(fileIcon, 'file-text');
									linkEl.createSpan({ text: filePath });
									linkEl.onclick = () => {
										this.app.workspace.openLinkText(filePath, '', false);
									};
								}
								
								showRawResult = false; // Don't show raw JSON
							}
						} catch (e) {
							// If parsing fails, fall through to show raw result
						}
					}

					// Special handling for list_references - render file links
					if (toolCall.function.name === 'list_references') {
						try {
							const refResult = JSON.parse(toolCall.result);
							if (refResult.files && Array.isArray(refResult.files)) {
								// Handle empty results
								if (refResult.count === 0) {
									toolContent.createEl('div', {
										text: refResult.message || 'No file references found in this conversation.',
										attr: { style: 'color: var(--text-muted); font-style: italic;' }
									});
								} else {
									// Show counts
									toolContent.createEl('div', {
										text: `${refResult.count} reference(s) (${refResult.unique_count} unique):`,
										attr: { style: 'margin-bottom: 8px; font-weight: 500;' }
									});

									// Render clickable file links in a scrollable container
									const filesContainer = toolContent.createEl('div');
									filesContainer.setCssStyles({
										marginBottom: '8px',
										maxHeight: '200px',
										overflow: 'auto',
										padding: '4px',
										backgroundColor: 'var(--background-primary)',
										borderRadius: '4px'
									});
									
									for (const filePath of refResult.files) {
										const linkEl = filesContainer.createEl('a', {
											attr: { style: 'display: flex; align-items: center; gap: 4px; margin-bottom: 4px; color: var(--text-accent); cursor: pointer;' }
										});
										const fileIcon = linkEl.createSpan();
										fileIcon.style.display = 'flex';
										fileIcon.style.alignItems = 'center';
										setIcon(fileIcon, 'file-text');
										linkEl.createSpan({ text: filePath });
										linkEl.onclick = () => {
											this.app.workspace.openLinkText(filePath, '', false);
										};
									}
								}
								
								showRawResult = false; // Don't show raw JSON
							}
						} catch (e) {
							// If parsing fails, fall through to show raw result
							console.error('[ChatView] Failed to parse list_references result:', e);
						}
					}

					// Show raw result only if we didn't handle it specially
					if (showRawResult) {
						const resultEl = toolContent.createEl('pre');
						resultEl.setCssStyles({
							fontSize: '0.9em',
							maxHeight: '400px',
							overflow: 'auto',
							userSelect: 'text',
							cursor: 'text'
						});
						resultEl.setText(toolCall.result);
					}
				} else if (toolCall.error) {
					toolContent.createEl('div', {
						text: `Error: ${toolCall.error}`,
						attr: { style: 'color: var(--text-error); margin-top: 8px;' }
					});
				}

				// Tool call action buttons (outside details, always visible)
				const toolCallActions = toolCallWrapper.createEl('div');
				toolCallActions.dataset.toolCallActions = 'true';
				toolCallActions.setCssStyles({
					display: 'flex',
					gap: '6px',
					marginTop: '4px',
					justifyContent: 'flex-end',
					alignItems: 'center'
				});

				// Helper to highlight tool call section on hover (using outline to avoid layout jitter)
				// Highlight the entire toolCallWrapper to include summary/preview, content, and actions
				const highlightToolCall = () => {
					if (toolCallWrapper) {
						toolCallWrapper.style.outline = '2px solid var(--text-accent)';
						toolCallWrapper.style.outlineOffset = '2px';
						toolCallWrapper.style.borderRadius = '4px';
						toolCallWrapper.style.transition = 'outline 0.2s';
					}
				};

				const unhighlightToolCall = () => {
					if (toolCallWrapper) {
						toolCallWrapper.style.outline = '';
						toolCallWrapper.style.outlineOffset = '';
						toolCallWrapper.style.borderRadius = '';
					}
				};

				// Edit result button (only if there's a result)
				if (toolCall.result) {
					const editResultBtn = toolCallActions.createEl('button', {
						attr: { 'aria-label': 'Edit result' }
					});
					editResultBtn.style.padding = '4px';
					editResultBtn.style.display = 'flex';
					editResultBtn.style.alignItems = 'center';
					editResultBtn.style.backgroundColor = 'transparent';
					editResultBtn.style.border = 'none';
					editResultBtn.style.boxShadow = 'none';
					editResultBtn.style.outline = 'none';
					editResultBtn.style.transition = 'background-color 0.2s';
					editResultBtn.onmouseenter = () => {
						editResultBtn.style.backgroundColor = 'var(--background-modifier-hover)';
						highlightToolCall();
					};
					editResultBtn.onmouseleave = () => {
						editResultBtn.style.backgroundColor = 'transparent';
						unhighlightToolCall();
					};
					setIcon(editResultBtn, 'pencil');
					editResultBtn.onclick = () => this.editToolCallResult(message, toolCallIndex, toolDetails);
				}

				// Delete result button (only if there's a result or error)
				if (toolCall.result || toolCall.error) {
					const deleteResultBtn = toolCallActions.createEl('button', {
						attr: { 'aria-label': 'Delete result' }
					});
					deleteResultBtn.style.padding = '4px';
					deleteResultBtn.style.display = 'flex';
					deleteResultBtn.style.alignItems = 'center';
					deleteResultBtn.style.backgroundColor = 'transparent';
					deleteResultBtn.style.border = 'none';
					deleteResultBtn.style.boxShadow = 'none';
					deleteResultBtn.style.outline = 'none';
					deleteResultBtn.style.transition = 'background-color 0.2s';
					deleteResultBtn.dataset.confirmState = 'initial';
					deleteResultBtn.onmouseenter = () => {
						if (deleteResultBtn.dataset.confirmState !== 'confirming') {
							deleteResultBtn.style.backgroundColor = 'var(--background-modifier-hover)';
							highlightToolCall();
						}
					};
					deleteResultBtn.onmouseleave = () => {
						if (deleteResultBtn.dataset.confirmState !== 'confirming') {
							deleteResultBtn.style.backgroundColor = 'transparent';
							unhighlightToolCall();
						}
					};
					setIcon(deleteResultBtn, 'trash-2');
					deleteResultBtn.onclick = async (e: MouseEvent) => {
						if (deleteResultBtn.dataset.confirmState === 'initial') {
							// If CTRL is held, bypass confirmation and delete immediately
							if (e.ctrlKey || e.metaKey) {
								await this.deleteToolCallResult(message, toolCallIndex);
								return;
							}
							deleteResultBtn.dataset.confirmState = 'confirming';
							deleteResultBtn.style.backgroundColor = 'var(--color-red)';
							deleteResultBtn.style.color = 'white';
							setTimeout(() => {
								if (deleteResultBtn.dataset.confirmState === 'confirming') {
									deleteResultBtn.dataset.confirmState = 'initial';
									deleteResultBtn.style.backgroundColor = '';
									deleteResultBtn.style.color = '';
								}
							}, 3000);
						} else if (deleteResultBtn.dataset.confirmState === 'confirming') {
							await this.deleteToolCallResult(message, toolCallIndex);
						}
					};
				}
			}
		}

		// Check if message should have actions
		const visibleMessages = this.session.messages.filter(m => m.role !== 'system');
		const isLastVisibleMessage = visibleMessages.length > 0 && visibleMessages[visibleMessages.length - 1] === message;
		const isUserMessage = message.role === 'user';
		const isToolMessage = message.role === 'tool';
		
		// User messages and tool messages always get action buttons (fork, edit, delete)
		// Last visible message gets regenerate/continue buttons (if assistant)
		// Only show actions if message is not streaming and has no pending tool calls
		const shouldHaveActions = !message.isStreaming && 
			!(message.tool_calls && message.tool_calls.length > 0 && message.tool_calls.some(tc => !tc.result && !tc.error && !tc.permissionStatus)) &&
			(isUserMessage || isToolMessage || isLastVisibleMessage);

		// Determine what meaningful content exists
		const hasContent = message.content && message.content.trim().length > 0;
		const hasThinking = message.thinking && message.thinking.trim().length > 0;
		const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
		
		// Determine where to attach action buttons:
		// Priority: content > tool_calls > thinking
		// If message has content, attach to content wrapper
		// If message has no content but has tool calls, attach to last tool call
		// If message has no content and no tool calls but has thinking, attach to thinking
		// User messages always have content, so they'll always get a wrapper
		let actionContainer: HTMLElement | null = null;
		
		if (hasContent) {
			// Create wrapper for message content (role + content, excluding thinking and tool calls)
			// Create it now, after thinking and tool calls, so it appears at the bottom
			const messageContentWrapper = messageEl.createEl('div');
			messageContentWrapper.dataset.messageContentWrapper = 'true';
			
			// Remove top spacing for user messages since they don't have a role header
			if (message.role === 'user') {
				messageContentWrapper.style.marginTop = '0';
				messageContentWrapper.style.paddingTop = '0';
			}

			// Role header for assistant and tool messages (skip user messages)
			// For assistant messages: show name before content (even if already shown at top)
			// This ensures the name is visible before content when thinking separates them
			if (message.role !== 'user') {
				let roleText: string;
				if (message.role === 'tool') {
					roleText = `Tool: ${message.tool_name}`;
				} else {
					// Assistant message - use assistant name
					roleText = this.settings.assistantName || 'Delver';
				}
				
				console.log('[ChatView] renderMessage: Creating role header for', message.role, 'with text:', roleText);
				
				const roleEl = messageContentWrapper.createEl('div', { text: roleText });
				roleEl.setCssStyles({
					fontWeight: '600',
					marginBottom: '8px',
					fontSize: '0.9em',
					color: 'var(--text-normal)',
					display: 'block', // Explicitly set display to ensure visibility
					visibility: 'visible'
				});
				
				console.log('[ChatView] renderMessage: Created roleEl:', roleEl, 'with text:', roleEl.textContent);
			}

			// Content - make tool messages collapsible with preview and special formatting
			if (message.role === 'tool') {
				// Try to parse and format tool results nicely
				this.renderToolResultMessage(message, messageContentWrapper);
			} else {
				// Regular content for user/assistant messages
				const contentEl = messageContentWrapper.createEl('div', { cls: 'message-content' });
				contentEl.setCssStyles({
					fontSize: '14px',
					lineHeight: '1.6',
					userSelect: 'text',
					cursor: 'text'
				});
				// Remove top margin for user messages to eliminate extra spacing
				if (message.role === 'user') {
					contentEl.style.marginTop = '0';
					contentEl.style.paddingTop = '0';
				}
				MarkdownRenderer.renderMarkdown(message.content, contentEl, '', this);
			}
			
			actionContainer = messageContentWrapper;
		} else if (hasToolCalls && message.tool_calls && isLastVisibleMessage) {
			// No content, but has tool calls AND is last message - attach actions to last tool call
			// Only attach if this is the last message (to avoid creating empty wrappers for non-last messages)
			// Find the last tool call wrapper (it was created in the loop above)
			const toolCallWrappers = messageEl.querySelectorAll('[data-tool-call-wrapper="true"]');
			if (toolCallWrappers.length > 0) {
				const lastToolCallWrapper = toolCallWrappers[toolCallWrappers.length - 1] as HTMLElement;
				// Find the tool call actions container (where edit/delete buttons are)
				const toolCallActions = lastToolCallWrapper.querySelector('[data-tool-call-actions="true"]') as HTMLElement;
				if (toolCallActions) {
					// Create a separate container for message-level actions (regenerate/continue)
					// This creates a visual separation from tool call actions (edit/delete)
					const messageActionsContainer = lastToolCallWrapper.createEl('div');
					messageActionsContainer.style.marginTop = '8px';
					messageActionsContainer.style.display = 'flex';
					messageActionsContainer.style.gap = '6px';
					messageActionsContainer.style.justifyContent = 'flex-end';
					messageActionsContainer.style.alignItems = 'center';
					actionContainer = messageActionsContainer;
				} else {
					// Fallback: create container after tool call wrapper
					const actionsContainer = lastToolCallWrapper.createEl('div');
					actionsContainer.style.marginTop = '8px';
					actionContainer = actionsContainer;
				}
			}
		} else if (hasThinking && isLastVisibleMessage) {
			// No content, no tool calls, but has thinking AND is last message - attach actions to thinking
			// Only attach if this is the last message (to avoid creating empty wrappers for non-last messages)
			const thinkingContainer = messageEl.querySelector('[data-thinking-container]') as HTMLElement;
			if (thinkingContainer) {
				const thinkingActions = thinkingContainer.querySelector('[data-thinking-actions="true"]') as HTMLElement;
				if (thinkingActions) {
					// Create a container for message-level actions after thinking actions
					const actionsContainer = thinkingContainer.createEl('div');
					actionsContainer.style.marginTop = '8px';
					actionContainer = actionsContainer;
				}
			}
		}

		// Render action buttons on the appropriate container
		// Only render if we have a container AND the message should have actions
		if (actionContainer && shouldHaveActions) {
			this.renderMessageActions(message, actionContainer);
		}
	}

	private renderMessageActions(message: DelverMessage, container: HTMLElement): void {
		if (!this.session) return;

		// Don't show actions if message is still streaming
		if (message.isStreaming) return;

		// Don't show actions if message has tool calls that are pending execution
		if (message.tool_calls && message.tool_calls.length > 0) {
			const hasPendingToolCalls = message.tool_calls.some(tc => 
				!tc.result && !tc.error && !tc.permissionStatus
			);
			if (hasPendingToolCalls) return;
		}

		// Get visible messages (excluding system messages) to determine if this is the last visible message
		const visibleMessages = this.session.messages.filter(m => m.role !== 'system');
		const isLastMessage = visibleMessages.length > 0 && visibleMessages[visibleMessages.length - 1] === message;
		const isAssistant = message.role === 'assistant';
		const isUserMessage = message.role === 'user';
		const isToolMessage = message.role === 'tool';

		// Find the message container element (parent of container)
		const messageContainer = container.closest('[data-message-id]') as HTMLElement;
		// Find the message content wrapper (excludes thinking and tool calls)
		// This exists only if the message has content
		const messageContentWrapper = messageContainer?.querySelector('[data-message-content-wrapper]') as HTMLElement;
		// Find the thinking container (if it exists)
		const thinkingContainer = messageContainer?.querySelector('[data-thinking-container]') as HTMLElement;

		// Determine if message has content (for deciding which buttons to show)
		const hasContent = !!messageContentWrapper;
		
		// Show fork/edit/delete for:
		// - User messages (always)
		// - Tool messages (always)
		// - Assistant messages with content
		// Assistant messages with only tool calls/thinking should only show regenerate/continue
		const shouldShowForkEditDelete = isUserMessage || isToolMessage || (isAssistant && hasContent);

		// Determine which buttons we'll actually render
		const willRenderRegenerate = isLastMessage && isAssistant;
		const willRenderContinue = isLastMessage;
		const willRenderAnyButton = willRenderRegenerate || willRenderContinue || shouldShowForkEditDelete;
		
		// If no buttons will be rendered, don't create the container
		if (!willRenderAnyButton) {
			return;
		}

		// Check if container already has the right structure (for tool calls, we pre-styled it)
		// If container already has display:flex, use it directly; otherwise create actionsContainer
		const containerStyle = window.getComputedStyle(container);
		const isPreStyledContainer = containerStyle.display === 'flex' && containerStyle.gap !== 'normal';
		
		let actionsContainer: HTMLElement;
		if (isPreStyledContainer) {
			// Container is already styled (e.g., from tool call actions), use it directly
			actionsContainer = container;
		} else {
			// Create new actions container
			actionsContainer = container.createEl('div');
			actionsContainer.setCssStyles({
				display: 'flex',
				gap: '6px',
				marginTop: '8px',
				justifyContent: 'flex-end',
				alignItems: 'center'
			});
		}

		// Helper to highlight only message content (for continue and edit buttons)
		const highlightMessageOnly = () => {
			if (messageContentWrapper) {
				messageContentWrapper.style.outline = '2px solid var(--text-accent)';
				messageContentWrapper.style.outlineOffset = '2px';
				messageContentWrapper.style.borderRadius = '4px';
				messageContentWrapper.style.transition = 'outline 0.2s';
			}
		};

		const unhighlightMessageOnly = () => {
			if (messageContentWrapper) {
				messageContentWrapper.style.outline = '';
				messageContentWrapper.style.outlineOffset = '';
				messageContentWrapper.style.borderRadius = '';
			}
		};

		// Helper to highlight both message content and thinking (for delete and regenerate buttons)
		const highlightMessage = () => {
			if (messageContentWrapper) {
				messageContentWrapper.style.outline = '2px solid var(--text-accent)';
				messageContentWrapper.style.outlineOffset = '2px';
				messageContentWrapper.style.borderRadius = '4px';
				messageContentWrapper.style.transition = 'outline 0.2s';
			}
			if (thinkingContainer) {
				thinkingContainer.style.outline = '2px solid var(--text-accent)';
				thinkingContainer.style.outlineOffset = '2px';
				thinkingContainer.style.borderRadius = '4px';
				thinkingContainer.style.transition = 'outline 0.2s';
			}
			// Also highlight all tool call wrappers (regenerating will affect them)
			if (message.tool_calls && message.tool_calls.length > 0) {
				const toolCallWrappers = messageContainer?.querySelectorAll('[data-tool-call-wrapper="true"]') as NodeListOf<HTMLElement>;
				if (toolCallWrappers) {
					for (const wrapper of Array.from(toolCallWrappers)) {
						wrapper.style.outline = '2px solid var(--text-accent)';
						wrapper.style.outlineOffset = '2px';
						wrapper.style.borderRadius = '4px';
						wrapper.style.transition = 'outline 0.2s';
					}
				}
			}
		};

		const unhighlightMessage = () => {
			if (messageContentWrapper) {
				messageContentWrapper.style.outline = '';
				messageContentWrapper.style.outlineOffset = '';
				messageContentWrapper.style.borderRadius = '';
			}
			if (thinkingContainer) {
				thinkingContainer.style.outline = '';
				thinkingContainer.style.outlineOffset = '';
				thinkingContainer.style.borderRadius = '';
			}
			// Also unhighlight all tool call wrappers
			if (message.tool_calls && message.tool_calls.length > 0) {
				const toolCallWrappers = messageContainer?.querySelectorAll('[data-tool-call-wrapper="true"]') as NodeListOf<HTMLElement>;
				if (toolCallWrappers) {
					for (const wrapper of Array.from(toolCallWrappers)) {
						wrapper.style.outline = '';
						wrapper.style.outlineOffset = '';
						wrapper.style.borderRadius = '';
					}
				}
			}
		};

		// Order: Regenerate, Continue, Fork, Edit, Delete

		// Check if generation is in progress
		const isGenerating = this.isGenerationInProgress();

		// Regenerate button (for last assistant message only)
		// Don't show if generation is in progress
		if (isLastMessage && isAssistant && !isGenerating) {
			const regenBtn = actionsContainer.createEl('button', {
				attr: { 'aria-label': 'Regenerate' }
			});
			regenBtn.style.padding = '6px';
			regenBtn.style.display = 'flex';
			regenBtn.style.alignItems = 'center';
			regenBtn.style.justifyContent = 'center';
			regenBtn.style.backgroundColor = 'transparent';
			regenBtn.style.border = 'none';
			regenBtn.style.boxShadow = 'none';
			regenBtn.style.outline = 'none';
			regenBtn.style.transition = 'background-color 0.2s';
			regenBtn.onmouseenter = () => {
				regenBtn.style.backgroundColor = 'var(--background-modifier-hover)';
				highlightMessage();
			};
			regenBtn.onmouseleave = () => {
				regenBtn.style.backgroundColor = 'transparent';
				unhighlightMessage();
			};
			setIcon(regenBtn, 'refresh-cw');
			regenBtn.onclick = () => this.regenerateLastMessage();
		}

		// Continue button (for last message)
		// Don't show if generation is in progress
		if (isLastMessage && !isGenerating) {
			const continueBtn = actionsContainer.createEl('button', {
				attr: { 'aria-label': 'Continue' }
			});
			continueBtn.style.padding = '6px';
			continueBtn.style.display = 'flex';
			continueBtn.style.alignItems = 'center';
			continueBtn.style.justifyContent = 'center';
			continueBtn.style.backgroundColor = 'transparent';
			continueBtn.style.border = 'none';
			continueBtn.style.boxShadow = 'none';
			continueBtn.style.outline = 'none';
			continueBtn.style.transition = 'background-color 0.2s';
			continueBtn.onmouseenter = () => {
				continueBtn.style.backgroundColor = 'var(--background-modifier-hover)';
				highlightMessageOnly();
			};
			continueBtn.onmouseleave = () => {
				continueBtn.style.backgroundColor = 'transparent';
				unhighlightMessageOnly();
			};
			setIcon(continueBtn, 'arrow-right');
			continueBtn.onclick = () => this.continueGeneration();
		}

		// Fork button (only for user messages or assistant messages with content)
		if (shouldShowForkEditDelete) {
			const forkBtn = actionsContainer.createEl('button', {
				attr: { 'aria-label': 'Fork' }
			});
			forkBtn.style.padding = '6px';
			forkBtn.style.display = 'flex';
			forkBtn.style.alignItems = 'center';
			forkBtn.style.justifyContent = 'center';
			forkBtn.style.backgroundColor = 'transparent';
			forkBtn.style.border = 'none';
			forkBtn.style.boxShadow = 'none';
			forkBtn.style.outline = 'none';
			forkBtn.style.transition = 'background-color 0.2s';
			forkBtn.onmouseenter = () => {
				forkBtn.style.backgroundColor = 'var(--background-modifier-hover)';
				highlightMessage();
			};
			forkBtn.onmouseleave = () => {
				forkBtn.style.backgroundColor = 'transparent';
				unhighlightMessage();
			};
			setIcon(forkBtn, 'git-branch');
			forkBtn.onclick = () => this.forkChat(message);
		}

		// Edit button (only for user messages or assistant messages with content)
		if (shouldShowForkEditDelete) {
			const editBtn = actionsContainer.createEl('button', {
				attr: { 'aria-label': 'Edit' }
			});
			editBtn.style.padding = '6px';
			editBtn.style.display = 'flex';
			editBtn.style.alignItems = 'center';
			editBtn.style.justifyContent = 'center';
			editBtn.style.backgroundColor = 'transparent';
			editBtn.style.border = 'none';
			editBtn.style.boxShadow = 'none';
			editBtn.style.outline = 'none';
			editBtn.style.transition = 'background-color 0.2s';
			editBtn.onmouseenter = () => {
				editBtn.style.backgroundColor = 'var(--background-modifier-hover)';
				highlightMessageOnly();
			};
			editBtn.onmouseleave = () => {
				editBtn.style.backgroundColor = 'transparent';
				unhighlightMessageOnly();
			};
			setIcon(editBtn, 'pencil');
			editBtn.onclick = () => this.editMessage(message);
		}

		// Delete button (only for user messages or assistant messages with content) - double-click to confirm
		if (shouldShowForkEditDelete) {
			const deleteBtn = actionsContainer.createEl('button', {
				attr: { 'aria-label': 'Delete' }
			});
			deleteBtn.style.padding = '6px';
			deleteBtn.style.display = 'flex';
			deleteBtn.style.alignItems = 'center';
			deleteBtn.style.justifyContent = 'center';
			deleteBtn.style.backgroundColor = 'transparent';
			deleteBtn.style.border = 'none';
			deleteBtn.style.boxShadow = 'none';
			deleteBtn.style.outline = 'none';
			deleteBtn.style.transition = 'background-color 0.2s';
			deleteBtn.dataset.confirmState = 'initial';
			deleteBtn.onmouseenter = () => {
				if (deleteBtn.dataset.confirmState !== 'confirming') {
					deleteBtn.style.backgroundColor = 'var(--background-modifier-hover)';
					highlightMessage();
				}
			};
			deleteBtn.onmouseleave = () => {
				if (deleteBtn.dataset.confirmState !== 'confirming') {
					deleteBtn.style.backgroundColor = 'transparent';
					unhighlightMessage();
				}
			};
			setIcon(deleteBtn, 'trash-2');
			
			deleteBtn.onclick = async (e: MouseEvent) => {
				if (deleteBtn.dataset.confirmState === 'initial') {
					// If CTRL is held, bypass confirmation and delete immediately
					if (e.ctrlKey || e.metaKey) {
						await this.deleteMessage(message);
						return;
					}
					// First click - turn red and wait for confirmation
					deleteBtn.dataset.confirmState = 'confirming';
					deleteBtn.style.backgroundColor = 'var(--color-red)';
					deleteBtn.style.color = 'white';
					deleteBtn.setAttribute('aria-label', 'Click again to confirm delete');
					
					// Reset after 3 seconds if not clicked again
					setTimeout(() => {
						if (deleteBtn.dataset.confirmState === 'confirming') {
							deleteBtn.dataset.confirmState = 'initial';
							deleteBtn.style.backgroundColor = '';
							deleteBtn.style.color = '';
							deleteBtn.setAttribute('aria-label', 'Delete');
						}
					}, 3000);
				} else if (deleteBtn.dataset.confirmState === 'confirming') {
					// Second click - actually delete
					await this.deleteMessage(message);
				}
			};
		}
	}

	private editMessage(message: DelverMessage): void {
		if (!this.session) return;

		// Find the message element
		const messageElements = this.chatMessagesContainer.querySelectorAll('[data-message-id]');
		let messageEl: HTMLElement | null = null;

		for (const el of Array.from(messageElements)) {
			if ((el as HTMLElement).dataset.messageId === message.id) {
				messageEl = el as HTMLElement;
				break;
			}
		}

		if (!messageEl) return;

		// For tool messages, find the messageContentWrapper and create/edit container there
		if (message.role === 'tool') {
			const messageContentWrapper = messageEl.querySelector('[data-message-content-wrapper]') as HTMLElement;
			if (!messageContentWrapper) return;

			// Clear existing content and create edit interface
			messageContentWrapper.empty();
			
			// Re-add role header
			const roleText = `Tool: ${message.tool_name || 'unknown'}`;
			const roleEl = messageContentWrapper.createEl('div', { text: roleText });
			roleEl.setCssStyles({
				fontWeight: '600',
				marginBottom: '8px',
				fontSize: '0.9em',
				color: 'var(--text-normal)'
			});

			// Create edit container
			const editContainer = messageContentWrapper.createEl('div');
			editContainer.style.marginTop = '8px';

			const label = editContainer.createEl('div', {
				text: 'Edit Result:',
				attr: { style: 'font-weight: 600; margin-bottom: 4px;' }
			});

			const textarea = editContainer.createEl('textarea');
			textarea.value = message.content;
			textarea.style.width = '100%';
			textarea.style.minHeight = '200px';
			textarea.style.fontFamily = 'var(--font-monospace)';
			textarea.style.fontSize = '12px';
			textarea.style.padding = '8px';
			textarea.style.borderRadius = '4px';
			textarea.focus();

			const saveEdit = async () => {
				message.content = textarea.value;
				this.session!.updatedAt = Date.now();
				await this.onSaveSession(this.session!);
				this.renderMessages(false);
				await this.updateContextDisplay();
			};

			const cancelEdit = () => {
				this.renderMessages(false);
			};

			textarea.addEventListener('keydown', async (e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					await saveEdit();
				} else if (e.key === 'Escape') {
					e.preventDefault();
					cancelEdit();
				}
			});

			return;
		}

		// For regular messages, find content element
		const contentEl = messageEl.querySelector('.message-content') as HTMLElement;
		if (!contentEl) return;

		// Save original content
		const originalContent = message.content;

		// Replace with textarea
		contentEl.empty();
		const textarea = contentEl.createEl('textarea');
		textarea.value = originalContent;
		textarea.style.width = '100%';
		textarea.style.minHeight = '100px';
		textarea.style.fontFamily = 'var(--font-text)';
		textarea.style.fontSize = '14px';
		textarea.style.padding = '8px';
		textarea.focus();

		// Handle save on Enter (without Shift)
		textarea.addEventListener('keydown', async (evt) => {
			if (evt.key === 'Enter' && !evt.shiftKey) {
				evt.preventDefault();
				await this.saveMessageEdit(message, textarea.value);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				this.cancelMessageEdit(message);
			}
		});

		// Handle save on blur
		textarea.addEventListener('blur', async () => {
			await this.saveMessageEdit(message, textarea.value);
		});
	}

	private async saveMessageEdit(message: DelverMessage, newContent: string): Promise<void> {
		if (!this.session) return;

		message.content = newContent;
		message.timestamp = Date.now();
		this.session.updatedAt = Date.now();

		await this.onSaveSession(this.session);
		this.renderMessages(false); // Don't scroll
		await this.updateContextDisplay();
	}

	private cancelMessageEdit(message: DelverMessage): void {
		// Just re-render to cancel
		this.renderMessages(false);
	}

	private async deleteMessage(message: DelverMessage): Promise<void> {
		if (!this.session) return;

		// Check if we're near the bottom before deletion
		let wasNearBottom = false;
		if (this.scrollContainer) {
			const scrollTop = this.scrollContainer.scrollTop;
			const scrollHeight = this.scrollContainer.scrollHeight;
			const clientHeight = this.scrollContainer.clientHeight;
			const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
			wasNearBottom = distanceFromBottom <= 100; // Within 100px of bottom
		}

		const index = this.session.messages.indexOf(message);
		if (index > -1) {
			this.session.messages.splice(index, 1);
			this.session.updatedAt = Date.now();
			await this.onSaveSession(this.session);
			// If we were near the bottom, scroll to bottom after re-rendering
			this.renderMessages(wasNearBottom);
			await this.updateContextDisplay();
		}
	}

	private editThinking(message: DelverMessage, contentEl: HTMLElement, detailsEl: HTMLDetailsElement): void {
		if (!this.session || !message.thinking) return;

		// Open the details element so the user can see the edit
		detailsEl.open = true;

		// Save original content
		const originalContent = message.thinking;

		// Replace with textarea
		contentEl.empty();
		const textarea = contentEl.createEl('textarea');
		textarea.value = originalContent;
		textarea.style.width = '100%';
		textarea.style.minHeight = '100px';
		textarea.style.fontFamily = 'var(--font-text)';
		textarea.style.fontSize = '14px';
		textarea.style.padding = '8px';
		textarea.focus();

		const saveEdit = async () => {
			message.thinking = textarea.value;
			this.session!.updatedAt = Date.now();
			await this.onSaveSession(this.session!);
			this.renderMessages(false);
			await this.updateContextDisplay();
		};

		const cancelEdit = () => {
			this.renderMessages(false);
		};

		textarea.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				await saveEdit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				cancelEdit();
			}
		});
	}

	private async deleteThinking(message: DelverMessage): Promise<void> {
		if (!this.session) return;

		// Check if we're near the bottom before deletion
		let wasNearBottom = false;
		if (this.scrollContainer) {
			const scrollTop = this.scrollContainer.scrollTop;
			const scrollHeight = this.scrollContainer.scrollHeight;
			const clientHeight = this.scrollContainer.clientHeight;
			const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
			wasNearBottom = distanceFromBottom <= 100; // Within 100px of bottom
		}

		message.thinking = undefined;
		
		// If message is now completely empty (no content, no thinking, no tool calls), delete it
		const hasContent = message.content && message.content.trim().length > 0;
		const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
		
		if (!hasContent && !hasToolCalls) {
			// Message is empty, delete it
			const index = this.session.messages.indexOf(message);
			if (index > -1) {
				this.session.messages.splice(index, 1);
			}
		}
		
		this.session.updatedAt = Date.now();
		await this.onSaveSession(this.session);
		// If we were near the bottom, scroll to bottom after re-rendering
		this.renderMessages(wasNearBottom);
		await this.updateContextDisplay();
	}

	private editToolCallResult(message: DelverMessage, toolCallIndex: number, detailsEl: HTMLDetailsElement): void {
		if (!this.session || !message.tool_calls || !message.tool_calls[toolCallIndex]) {
			console.error('[ChatView] editToolCallResult: Invalid session or tool call');
			return;
		}

		const toolCall = message.tool_calls[toolCallIndex];
		if (!toolCall.result) {
			console.error('[ChatView] editToolCallResult: No result to edit');
			return;
		}

		// Open the details element so the user can see the edit
		detailsEl.open = true;

		// Find the tool content element - try multiple methods
		let toolContent: HTMLElement | null = null;
		
		// Method 1: Try data attribute
		toolContent = detailsEl.querySelector('[data-tool-content]') as HTMLElement;
		
		// Method 2: Try finding div with border (toolContent has a border)
		if (!toolContent) {
			const divs = detailsEl.querySelectorAll('div');
			for (const div of Array.from(divs)) {
				const style = window.getComputedStyle(div);
				if (style.border && style.border !== 'none' && style.border !== '0px') {
					toolContent = div as HTMLElement;
					break;
				}
			}
		}
		
		// Method 3: Fallback to first div child
		if (!toolContent) {
			toolContent = detailsEl.querySelector('div') as HTMLElement;
		}

		if (!toolContent) {
			console.error('[ChatView] editToolCallResult: Could not find toolContent element');
			return;
		}
		
		this.performToolCallEdit(message, toolCall, toolContent);
	}

	private performToolCallEdit(message: DelverMessage, toolCall: ToolCall, toolContent: HTMLElement): void {
		if (!this.session || !toolCall.result) return;

		// Save original content
		const originalContent = toolCall.result;

		// Hide all existing content in toolContent (we'll show the edit interface instead)
		// Action buttons are outside toolContent, so we can hide everything
		for (const child of Array.from(toolContent.children)) {
			(child as HTMLElement).style.display = 'none';
		}

		// Create edit container
		const editContainer = toolContent.createEl('div');
		editContainer.style.marginTop = '8px';

		const label = editContainer.createEl('div', {
			text: 'Edit Result:',
			attr: { style: 'font-weight: 600; margin-bottom: 4px;' }
		});

		const textarea = editContainer.createEl('textarea');
		textarea.value = originalContent;
		textarea.style.width = '100%';
		textarea.style.minHeight = '150px';
		textarea.style.fontFamily = 'var(--font-monospace)';
		textarea.style.fontSize = '12px';
		textarea.style.padding = '8px';
		textarea.style.borderRadius = '4px';
		textarea.focus();

		const saveEdit = async () => {
			toolCall.result = textarea.value;
			this.session!.updatedAt = Date.now();
			await this.onSaveSession(this.session!);
			this.renderMessages(false);
			await this.updateContextDisplay();
		};

		const cancelEdit = () => {
			this.renderMessages(false);
		};

		textarea.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				await saveEdit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				cancelEdit();
			}
		});
	}

	private async deleteToolCallResult(message: DelverMessage, toolCallIndex: number): Promise<void> {
		if (!this.session || !message.tool_calls || !message.tool_calls[toolCallIndex]) return;

		// Check if we're near the bottom before deletion
		let wasNearBottom = false;
		if (this.scrollContainer) {
			const scrollTop = this.scrollContainer.scrollTop;
			const scrollHeight = this.scrollContainer.scrollHeight;
			const clientHeight = this.scrollContainer.clientHeight;
			const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
			wasNearBottom = distanceFromBottom <= 100; // Within 100px of bottom
		}

		// Remove the tool call from the array
		message.tool_calls.splice(toolCallIndex, 1);

		// If no tool calls remain, remove the tool_calls array entirely
		if (message.tool_calls.length === 0) {
			message.tool_calls = undefined;
		}
		
		// If message is now completely empty (no content, no thinking, no tool calls), delete it
		const hasContent = message.content && message.content.trim().length > 0;
		const hasThinking = message.thinking && message.thinking.trim().length > 0;
		const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
		
		if (!hasContent && !hasThinking && !hasToolCalls) {
			// Message is empty, delete it
			const index = this.session.messages.indexOf(message);
			if (index > -1) {
				this.session.messages.splice(index, 1);
			}
		}
		
		this.session.updatedAt = Date.now();
		await this.onSaveSession(this.session);
		// If we were near the bottom, scroll to bottom after re-rendering
		this.renderMessages(wasNearBottom);
		await this.updateContextDisplay();
	}

	/**
	 * Show inline tool permission request
	 */
	private async showInlineToolPermission(toolCall: ToolCall): Promise<boolean> {
		return new Promise((resolve) => {
			// Ensure loading indicator stays at bottom
			this.moveLoadingIndicatorToBottom();

			// Create inline permission request element
			const permissionEl = this.chatMessagesContainer.createEl('div');
			permissionEl.addClass('delver-message', 'tool-permission-request');
			permissionEl.setCssStyles({
				padding: '12px',
				marginBottom: '8px',
				marginLeft: '20px',
				marginRight: '20px',
				backgroundColor: 'var(--background-modifier-form-field)',
				border: '2px solid var(--text-accent)',
				borderRadius: '4px'
			});

		// Header
		const headerEl = permissionEl.createEl('div');
		headerEl.setCssStyles({
			display: 'flex',
			alignItems: 'center',
			marginBottom: '8px'
		});

		const icon = headerEl.createSpan();
		icon.style.marginRight = '8px';
		setIcon(icon, 'lock');

			const title = headerEl.createEl('strong', { text: 'Tool Permission Required' });
			title.style.color = 'var(--text-accent)';

			// Tool name
			permissionEl.createEl('div', {
				text: `Tool: ${toolCall.function.name}`,
				attr: { style: 'margin-bottom: 8px; font-weight: 500;' }
			});

			// Arguments
			const argsContainer = permissionEl.createEl('div');
			argsContainer.style.marginBottom = '12px';

			const argsLabel = argsContainer.createEl('div', {
				text: 'Arguments:',
				attr: { style: 'font-size: 0.9em; color: var(--text-muted); margin-bottom: 4px;' }
			});

			const argsEl = argsContainer.createEl('pre');
			argsEl.setCssStyles({
				padding: '8px',
				backgroundColor: 'var(--background-secondary)',
				borderRadius: '4px',
				overflow: 'auto',
				maxHeight: '200px',
				fontSize: '0.85em'
			});
			argsEl.setText(JSON.stringify(toolCall.function.arguments, null, 2));

			// Buttons
			const buttonContainer = permissionEl.createEl('div');
			buttonContainer.setCssStyles({
				display: 'flex',
				gap: '10px',
				justifyContent: 'flex-end'
			});

			// Allow button
			const allowBtn = buttonContainer.createEl('button', {
				text: 'Allow (A)',
				cls: 'mod-cta'
			});
			allowBtn.style.padding = '6px 12px';

			// Deny button
			const denyBtn = buttonContainer.createEl('button', { text: 'Deny (D)' });
			denyBtn.style.padding = '6px 12px';

			// Keyboard shortcuts using direct event listener on the container
			// This ensures they work even when scope isn't focused
			const keyHandler = (evt: KeyboardEvent) => {
				if (evt.key.toLowerCase() === 'a') {
					evt.preventDefault();
					evt.stopPropagation();
					allowBtn.click();
				} else if (evt.key.toLowerCase() === 'd') {
					evt.preventDefault();
					evt.stopPropagation();
					denyBtn.click();
				}
			};
			
			// Add listener to the permission element itself
			permissionEl.addEventListener('keydown', keyHandler);
			
			// Also add to document for global capture
			const docKeyHandler = (evt: KeyboardEvent) => {
				// Only handle if this permission modal is still in DOM
				if (permissionEl.parentElement) {
					keyHandler(evt);
				} else {
					// Clean up if modal was removed
					document.removeEventListener('keydown', docKeyHandler);
				}
			};
			document.addEventListener('keydown', docKeyHandler);

			// Cleanup function
			const cleanup = () => {
				permissionEl.removeEventListener('keydown', keyHandler);
				document.removeEventListener('keydown', docKeyHandler);
			};

			// Set onclick handlers
			denyBtn.onclick = () => {
				cleanup();
				permissionEl.remove();
				resolve(false);
			};

			allowBtn.onclick = () => {
				cleanup();
				permissionEl.remove();
				resolve(true);
			};

			// Ensure loading indicator stays at bottom after permission prompt is added
			this.moveLoadingIndicatorToBottom();

			// Auto-scroll to show the permission request (respects auto-scroll setting)
			this.performAutoScroll();

			// Focus the permission element to receive keyboard events
			permissionEl.tabIndex = 0;
			permissionEl.focus();
		});
	}

	private async forkChat(message: DelverMessage): Promise<void> {
		if (!this.session) return;

		// Find message index
		const index = this.session.messages.indexOf(message);
		if (index === -1) return;

		// Create new session with messages up to this point
		const newSessionId = generateSessionId();
		const newSession: ChatSession = {
			id: newSessionId,
			name: `${this.session.name} (fork)`,
			messages: this.session.messages.slice(0, index + 1).map(m => ({
				...m,
				id: generateMessageId() // New IDs for forked messages
			})),
			contextMode: this.session.contextMode,
			contextLimit: this.session.contextLimit,
			model: this.session.model,
			createdAt: Date.now(),
			updatedAt: Date.now()
		};

		// Save new session
		await this.onSaveSession(newSession);

		// Open in new tab
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: CHAT_VIEW_TYPE,
			active: true,
			state: { sessionId: newSessionId }
		});
	}

	private async updateContextDisplay(): Promise<void> {
		if (!this.contextDisplay || !this.session) return;

		const state = this.contextManager.getContextState(
			this.session,
			this.session.contextLimit || this.modelContextLength
		);

		const percentage = calculatePercentage(state.currentTokens, state.maxTokens);
		this.contextDisplay.setText(
			`Context ${formatTokenCount(state.currentTokens)} / ${formatTokenCount(state.maxTokens)} (${percentage}%)`
		);
	}

	private startEditingContextLimit(): void {
		if (this.isEditingLimit || !this.session) return;

		this.isEditingLimit = true;
		this.contextDisplay.empty();

		const state = this.contextManager.getContextState(
			this.session,
			this.session.contextLimit || this.modelContextLength
		);

		const percentage = calculatePercentage(state.currentTokens, state.maxTokens);
		this.contextDisplay.createSpan({ text: `Context ${formatTokenCount(state.currentTokens)} / ` });

		const input = this.contextDisplay.createEl('input', {
			type: 'text',
			value: state.maxTokens.toString()
		});

		input.setCssStyles({
			width: '80px',
			padding: '2px 4px',
			fontSize: 'inherit'
		});

		this.contextDisplay.createSpan({ text: ` (${percentage}%)` });

		input.focus();
		input.select();

		input.addEventListener('keydown', (evt) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				this.saveContextLimit(input.value);
			} else if (evt.key === 'Escape') {
				this.cancelEditingContextLimit();
			}
		});

		input.addEventListener('blur', () => {
			this.saveContextLimit(input.value);
		});
	}

	private async saveContextLimit(value: string): Promise<void> {
		if (!this.isEditingLimit || !this.session) return;

		const newLimit = parseInt(value, 10);

		// 0 or less means reset to model default
		if (newLimit <= 0) {
			this.session.contextLimit = undefined;
		} else if (!isNaN(newLimit)) {
			this.session.contextLimit = newLimit;
		}

		this.isEditingLimit = false;
		this.contextDisplay.style.backgroundColor = 'transparent';

		this.session.updatedAt = Date.now();
		await this.onSaveSession(this.session);
		await this.updateContextDisplay();
	}

	private cancelEditingContextLimit(): void {
		this.isEditingLimit = false;
		this.contextDisplay.style.backgroundColor = 'transparent';
		this.updateContextDisplay();
	}

	/**
	 * Export the current chat session to a .delver_chat file
	 */
	private async exportChat(): Promise<void> {
		if (!this.session) {
			console.warn('[ChatView] No session to export');
			return;
		}

		try {
			// Serialize session to JSON
			const sessionData = JSON.stringify(this.session, null, 2);
			
			// Create a blob with the session data
			const blob = new Blob([sessionData], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			
			// Create a temporary anchor element to trigger download
			const a = document.createElement('a');
			a.href = url;
			
			// Generate filename from session name (sanitize for filesystem)
			const sanitizedName = this.session.name
				.replace(/[^a-z0-9]/gi, '_')
				.toLowerCase()
				.substring(0, 50) || 'chat';
			const timestamp = new Date(this.session.createdAt).toISOString().split('T')[0];
			a.download = `${sanitizedName}_${timestamp}.delver_chat`;
			
			// Trigger download
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			
			// Clean up the URL
			setTimeout(() => URL.revokeObjectURL(url), 100);
			
			console.log('[ChatView] Chat exported successfully');
		} catch (error) {
			console.error('[ChatView] Failed to export chat:', error);
			// Show error to user
			this.showError(`Failed to export chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Check if there's existing chat content (beyond system messages)
	 */
	private hasExistingChatContent(): boolean {
		if (!this.session) return false;
		
		// Count non-system messages
		const nonSystemMessages = this.session.messages.filter(m => m.role !== 'system');
		return nonSystemMessages.length > 0;
	}

	/**
	 * Show confirmation dialog for replacing existing chat
	 */
	private async confirmReplaceChat(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText('Replace Current Chat?');
			
			const contentEl = modal.contentEl;
			contentEl.createEl('p', {
				text: 'This will replace your current chat with the imported session. All current messages will be lost.'
			});
			contentEl.createEl('p', {
				text: 'Do you want to continue?',
				attr: { style: 'font-weight: 600; margin-top: 10px;' }
			});
			
			const buttonContainer = contentEl.createEl('div');
			buttonContainer.style.display = 'flex';
			buttonContainer.style.gap = '10px';
			buttonContainer.style.marginTop = '20px';
			buttonContainer.style.justifyContent = 'flex-end';
			
			const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
			cancelBtn.style.padding = '8px 16px';
			cancelBtn.onclick = () => {
				modal.close();
				resolve(false);
			};
			
			const confirmBtn = buttonContainer.createEl('button', {
				text: 'Replace Chat',
				cls: 'mod-cta'
			});
			confirmBtn.style.padding = '8px 16px';
			confirmBtn.onclick = () => {
				modal.close();
				resolve(true);
			};
			
			// Keyboard shortcuts
			modal.scope.register([], 'Escape', () => {
				modal.close();
				resolve(false);
			});
			
			modal.open();
			confirmBtn.focus();
		});
	}

	/**
	 * Import a chat session from a .delver_chat file
	 */
	private async importChat(): Promise<void> {
		try {
			// Check if there's existing chat content and show confirmation
			if (this.hasExistingChatContent()) {
				const confirmed = await this.confirmReplaceChat();
				if (!confirmed) {
					return; // User cancelled
				}
			}
			
			// Create a file input element
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = '.delver_chat,application/json';
			input.style.display = 'none';
			
			// Handle file selection
			input.onchange = async (event) => {
				const file = (event.target as HTMLInputElement).files?.[0];
				if (!file) {
					document.body.removeChild(input);
					return;
				}

				try {
					// Read file contents
					const text = await file.text();
					
					// Parse JSON
					let importedSession: ChatSession;
					try {
						importedSession = JSON.parse(text);
					} catch (parseError) {
						throw new Error('Invalid file format: not valid JSON');
					}
					
					// Validate session structure
					if (!importedSession.id || !importedSession.messages || !Array.isArray(importedSession.messages)) {
						throw new Error('Invalid file format: missing required session fields');
					}
					
					// Generate new session ID to avoid conflicts
					const newSessionId = generateSessionId();
					
					// Create new session with imported data
					const newSession: ChatSession = {
						...importedSession,
						id: newSessionId,
						name: importedSession.name || 'Imported Chat',
						createdAt: importedSession.createdAt || Date.now(),
						updatedAt: Date.now()
					};
					
					// Remove old session from open sessions if it exists
					if (this.session) {
						await this.onUpdateOpenSessions(this.session.id, 'remove');
					}
					
					// Save the imported session
					await this.onSaveSession(newSession);
					
					// Load the session into this view (replaces current session)
					this.session = newSession;
					
					// Update list_references tool with current session
					const listRefTool = this.toolRegistry.getTool('list_references');
					if (listRefTool && 'setSession' in listRefTool) {
						(listRefTool as any).setSession(this.session);
					}
					
					// Add to open sessions
					await this.onUpdateOpenSessions(this.session.id, 'add');
					
					// Load model context length
					await this.loadModelInfo();
					
					// Re-render messages (clears old and shows new)
					this.renderMessages();
					await this.updateContextDisplay();
					
					// Update tab title
					this.updateTabTitle();
					
					console.log('[ChatView] Chat imported successfully');
				} catch (error) {
					console.error('[ChatView] Failed to import chat:', error);
					this.showError(`Failed to import chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
				} finally {
					// Clean up
					document.body.removeChild(input);
				}
			};
			
			// Trigger file picker
			document.body.appendChild(input);
			input.click();
			
			// Clean up if user cancels (no file selected after a delay)
			setTimeout(() => {
				if (input.parentElement) {
					document.body.removeChild(input);
				}
			}, 1000);
		} catch (error) {
			console.error('[ChatView] Failed to open file picker:', error);
			this.showError(`Failed to import chat: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	async onClose(): Promise<void> {
		// Cancel any ongoing generation
		if (this.abortController) {
			this.abortController.abort();
		}

		// Remove document-level ESC handler
		if (this.escapeHandler) {
			document.removeEventListener('keydown', this.escapeHandler, true);
			this.escapeHandler = null;
		}

		// Remove from open sessions
		if (this.session) {
			await this.onUpdateOpenSessions(this.session.id, 'remove');

			// Delete session data
			delete this.settings.chatSessions[this.session.id];
			await this.onSaveSession(this.session);
		}

		this.contentEl.empty();
	}
}
