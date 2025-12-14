/**
 * Vault search tool - search for files in the vault by name or pattern
 */

import { BaseTool, ToolExecutionContext } from '../types/tools';

export class VaultSearchTool extends BaseTool {
	readonly name = 'vault_search';
	readonly description = 'Search for files in the Obsidian vault by name or path pattern. Returns a list of matching file paths.';
	readonly parameters = {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string',
				description: 'Search query or pattern to match against file names and paths'
			},
			limit: {
				type: 'number',
				description: 'Maximum number of results to return (default: 10)'
			}
		},
		required: ['query']
	};

	async execute(args: { query: string; limit?: number }, ctx: ToolExecutionContext): Promise<string> {
		// Validate arguments
		if (!this.validateArgs(args)) {
			throw new Error('Missing required argument: query');
		}

		const query = args.query.toLowerCase();
		const limit = args.limit || 10;

		// Get all files from vault
		const files = ctx.app.vault.getFiles();

		// Search for matches
		const matches = files
			.filter(file => {
				// Match against file name and path
				const path = file.path.toLowerCase();
				return path.includes(query);
			})
			.slice(0, limit)
			.map(file => file.path);

		if (matches.length === 0) {
			return `No files found matching "${args.query}"`;
		}

		return JSON.stringify({
			query: args.query,
			count: matches.length,
			files: matches
		}, null, 2);
	}
}
