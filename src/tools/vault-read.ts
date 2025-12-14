/**
 * Vault read tool - read the contents of a file in the vault
 */

import { TFile } from 'obsidian';
import { BaseTool, ToolExecutionContext } from '../types/tools';

export class VaultReadTool extends BaseTool {
	readonly name = 'vault_read';
	readonly description = 'Read the contents of a file in the Obsidian vault. Provide the file path to read its contents.';
	readonly parameters = {
		type: 'object' as const,
		properties: {
			path: {
				type: 'string',
				description: 'Path to the file to read (relative to vault root)'
			}
		},
		required: ['path']
	};

	async execute(args: { path: string }, ctx: ToolExecutionContext): Promise<string> {
		// Validate arguments
		if (!this.validateArgs(args)) {
			throw new Error('Missing required argument: path');
		}

		// Get file from vault (vault.getAbstractFileByPath already ensures path is within vault)
		const file = ctx.app.vault.getAbstractFileByPath(args.path);

		if (!file) {
			throw new Error(`File not found: ${args.path}`);
		}

		if (!(file instanceof TFile)) {
			throw new Error(`Path is not a file: ${args.path}`);
		}

		// Read file contents
		try {
			const content = await ctx.app.vault.read(file);
			return content;
		} catch (error: any) {
			throw new Error(`Failed to read file: ${error.message}`);
		}
	}
}
