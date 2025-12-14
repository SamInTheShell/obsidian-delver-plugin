/**
 * List references tool - list all file references from the conversation
 */

import { BaseTool, ToolExecutionContext } from '../types/tools';
import { ChatSession } from '../types/messages';

export class ListReferencesTool extends BaseTool {
	readonly name = 'list_references';
	readonly description = 'List all file references from the current conversation. Shows files that have been searched for or read during this chat session.';
	readonly parameters = {
		type: 'object' as const,
		properties: {
			unique_only: {
				type: 'boolean',
				description: 'If true, only return unique file paths (default: true)'
			}
		},
		required: []
	};

	private session: ChatSession | null = null;

	/**
	 * Set the current chat session (injected by ChatView)
	 */
	setSession(session: ChatSession) {
		this.session = session;
	}

	async execute(args: { unique_only?: boolean }, ctx: ToolExecutionContext): Promise<string> {
		if (!this.session) {
			throw new Error('No active chat session');
		}

		const uniqueOnly = args.unique_only !== false; // Default to true
		const references: string[] = [];
		const seenPaths = new Set<string>();

		// Scan all messages for tool calls
		for (const message of this.session.messages) {
			if (message.tool_calls) {
				for (const toolCall of message.tool_calls) {
					// Extract file paths from vault_read calls
					if (toolCall.function.name === 'vault_read' && toolCall.function.arguments.path) {
						const path = toolCall.function.arguments.path;
						if (!uniqueOnly || !seenPaths.has(path)) {
							references.push(path);
							seenPaths.add(path);
						}
					}

					// Extract file paths from vault_search results
					if (toolCall.function.name === 'vault_search' && toolCall.result) {
						try {
							const searchResult = JSON.parse(toolCall.result);
							if (searchResult.files && Array.isArray(searchResult.files)) {
								for (const filePath of searchResult.files) {
									if (!uniqueOnly || !seenPaths.has(filePath)) {
										references.push(filePath);
										seenPaths.add(filePath);
									}
								}
							}
						} catch (e) {
							// Skip if can't parse
						}
					}
				}
			}
		}

		// Always return consistent JSON format
		return JSON.stringify({
			count: references.length,
			unique_count: seenPaths.size,
			files: references,
			message: references.length === 0 ? 'No file references found in this conversation.' : undefined
		}, null, 2);
	}
}
