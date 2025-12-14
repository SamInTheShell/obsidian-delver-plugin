/**
 * Vault search tools - simple, robust file finding
 */

import { BaseTool, ToolExecutionContext } from '../types/tools';
import { TFile } from 'obsidian';

/**
 * Simple file finder - searches filenames and paths only
 */
export class VaultFileFindTool extends BaseTool {
	readonly name = 'vault_file_find';
	readonly description = 'Find files by filename or path. Super simple: just type what you\'re looking for. Case-insensitive, matches partial names. Use this when you know part of the filename.';
	readonly parameters = {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string',
				description: 'Text to search for in filenames and paths. Just type what you want to find - no special syntax needed.'
			},
			limit: {
				type: 'number',
				description: 'Maximum number of results (default: 20)'
			}
		},
		required: ['query']
	};

	async execute(args: { query: string; limit?: number }, ctx: ToolExecutionContext): Promise<string> {
		if (!this.validateArgs(args)) {
			throw new Error('Missing required argument: query');
		}

		const query = args.query.toLowerCase().trim();
		const limit = args.limit || 20;

		if (!query) {
			return 'Error: Query cannot be empty';
		}

		const files = ctx.app.vault.getFiles();

		// Simple substring match on filename and path
		const matches = files
			.filter(file => {
				const pathLower = file.path.toLowerCase();
				const nameLower = file.name.toLowerCase();
				return pathLower.includes(query) || nameLower.includes(query);
			})
			.slice(0, limit)
			.map(file => file.path);

		if (matches.length === 0) {
			return `No files found with "${args.query}" in the name or path.`;
		}

		return JSON.stringify({
			query: args.query,
			count: matches.length,
			files: matches
		}, null, 2);
	}
}

/**
 * Fuzzy finder - searches filenames AND file content
 */
export class VaultFuzzyFindTool extends BaseTool {
	readonly name = 'vault_fuzzy_find';
	readonly description = 'Find files by searching BOTH filenames and file content. Works with messy inputs, multiple words, partial matches. Use this when you\'re not sure of the exact filename but know some words that might be in the file or its content.';
	readonly parameters = {
		type: 'object' as const,
		properties: {
			query: {
				type: 'string',
				description: 'What to search for. Can be multiple words, partial text, whatever. Searches both filenames and file content.'
			},
			limit: {
				type: 'number',
				description: 'Maximum number of results (default: 20)'
			}
		},
		required: ['query']
	};

	async execute(args: { query: string; limit?: number }, ctx: ToolExecutionContext): Promise<string> {
		if (!this.validateArgs(args)) {
			throw new Error('Missing required argument: query');
		}

		const query = args.query.toLowerCase().trim();
		const limit = args.limit || 20;

		if (!query) {
			return 'Error: Query cannot be empty';
		}

		const files = ctx.app.vault.getMarkdownFiles();

		// Split query into words for multi-word matching
		const queryWords = query.split(/\s+/).filter(w => w.length > 0);

		// Score each file
		const scoredFiles: Array<{ file: TFile; score: number; matchType: string }> = [];

		for (const file of files) {
			const pathLower = file.path.toLowerCase();
			const nameLower = file.name.toLowerCase();
			let score = 0;
			let matchType = '';

			// Check filename matches
			let filenameMatches = 0;
			for (const word of queryWords) {
				if (nameLower.includes(word)) {
					score += 10;
					filenameMatches++;
				} else if (pathLower.includes(word)) {
					score += 5;
					filenameMatches++;
				}
			}

			// If we have filename matches, that's great
			if (filenameMatches > 0) {
				matchType = 'filename';
				scoredFiles.push({ file, score, matchType });
				continue;
			}

			// Otherwise, check content
			try {
				const content = await ctx.app.vault.cachedRead(file);
				const contentLower = content.toLowerCase();

				let contentMatches = 0;
				for (const word of queryWords) {
					if (contentLower.includes(word)) {
						score += 1;
						contentMatches++;
					}
				}

				if (contentMatches > 0) {
					matchType = 'content';
					scoredFiles.push({ file, score, matchType });
				}
			} catch (e) {
				// Skip files that can't be read
				continue;
			}
		}

		// Sort by score (highest first) and take top results
		scoredFiles.sort((a, b) => b.score - a.score);
		const topResults = scoredFiles.slice(0, limit);

		if (topResults.length === 0) {
			return `No files found matching "${args.query}". Searched filenames and content.`;
		}

		const results = topResults.map(r => ({
			path: r.file.path,
			matchType: r.matchType
		}));

		return JSON.stringify({
			query: args.query,
			count: results.length,
			results: results
		}, null, 2);
	}
}
