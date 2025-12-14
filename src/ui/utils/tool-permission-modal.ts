/**
 * Tool permission modal for prompting user approval
 */

import { App, Modal } from 'obsidian';
import { ToolCall } from '../../types/messages';

export class ToolPermissionModal extends Modal {
	private resolvePromise: (approved: boolean) => void;
	private toolCall: ToolCall;

	constructor(app: App, toolCall: ToolCall) {
		super(app);
		this.toolCall = toolCall;
	}

	/**
	 * Show the modal and wait for user decision
	 */
	async prompt(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl, titleEl } = this;

		titleEl.setText('Tool Permission Required');

		contentEl.empty();
		contentEl.addClass('delver-tool-permission-modal');

		// Tool name
		const toolNameEl = contentEl.createEl('h3', {
			text: `${this.toolCall.function.name}`
		});
		toolNameEl.style.marginTop = '0';
		toolNameEl.style.color = 'var(--text-accent)';

		// Description
		contentEl.createEl('p', {
			text: 'The assistant wants to execute this tool:'
		});

		// Arguments
		const argsEl = contentEl.createEl('pre');
		argsEl.style.padding = '10px';
		argsEl.style.backgroundColor = 'var(--background-secondary)';
		argsEl.style.borderRadius = '4px';
		argsEl.style.overflow = 'auto';
		argsEl.style.maxHeight = '300px';
		argsEl.setText(JSON.stringify(this.toolCall.function.arguments, null, 2));

		// Buttons
		const buttonContainer = contentEl.createEl('div');
		buttonContainer.style.display = 'flex';
		buttonContainer.style.gap = '10px';
		buttonContainer.style.marginTop = '20px';
		buttonContainer.style.justifyContent = 'flex-end';

		// Deny button
		const denyBtn = buttonContainer.createEl('button', { text: 'Deny (D)' });
		denyBtn.style.padding = '8px 16px';
		denyBtn.onclick = () => this.approve(false);

		// Allow button
		const allowBtn = buttonContainer.createEl('button', {
			text: 'Allow (A)',
			cls: 'mod-cta'
		});
		allowBtn.style.padding = '8px 16px';
		allowBtn.onclick = () => this.approve(true);

		// Keyboard shortcuts
		this.scope.register([], 'a', () => this.approve(true));
		this.scope.register([], 'd', () => this.approve(false));
		this.scope.register([], 'Escape', () => this.approve(false));

		// Focus allow button
		allowBtn.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}

	private approve(approved: boolean) {
		this.resolvePromise(approved);
		this.close();
	}
}
