/**
 * Model selection modal with fuzzy search
 */

import { App, FuzzySuggestModal } from 'obsidian';

export class ModelSuggestModal extends FuzzySuggestModal<string> {
	private models: string[];
	private onSelect: (model: string) => void;
	private currentModel: string;

	constructor(app: App, models: string[], currentModel: string, onSelect: (model: string) => void) {
		super(app);
		this.models = models;
		this.currentModel = currentModel;
		this.onSelect = onSelect;

		// Set modal title
		this.setPlaceholder('Search for a model...');
	}

	getItems(): string[] {
		return this.models;
	}

	getItemText(model: string): string {
		return model;
	}

	onChooseItem(model: string): void {
		this.onSelect(model);
	}

	// Override to highlight current selection
	renderSuggestion(match: { item: string }, el: HTMLElement): void {
		el.createEl('div', { text: match.item });

		// Highlight the currently selected model
		if (match.item === this.currentModel) {
			el.addClass('is-selected');
			el.style.backgroundColor = 'var(--background-modifier-active-hover)';
		}
	}
}
