/**
 * Tool system types for extensible tool calling
 */

import { App } from 'obsidian';
import { ToolDefinition } from './providers';

export type ToolPermission = 'ask' | 'allow' | 'deny' | 'disabled';

export interface ToolExecutionContext {
	vaultPath: string;              // Root vault directory for security
	sessionId: string;              // Current chat session
	app: App;                       // Obsidian app instance
}

/**
 * Base class for all tools
 * Tools must validate paths and execute safely within vault boundaries
 */
export abstract class BaseTool {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly parameters: {
		type: 'object';
		properties: Record<string, any>;
		required: string[];
	};

	/**
	 * Execute the tool with given arguments
	 */
	abstract execute(args: Record<string, any>, ctx: ToolExecutionContext): Promise<string>;

	/**
	 * Validate arguments before execution
	 */
	validateArgs(args: Record<string, any>): boolean {
		const required = this.parameters.required || [];
		for (const key of required) {
			if (!(key in args)) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Convert to API tool definition format
	 */
	toDefinition(): ToolDefinition {
		return {
			type: 'function',
			function: {
				name: this.name,
				description: this.description,
				parameters: this.parameters
			}
		};
	}

	/**
	 * Validate that a path is within the vault
	 * Prevents directory traversal attacks
	 */
	protected validateVaultPath(path: string, vaultPath: string): boolean {
		const { resolve, relative } = require('path');
		const absolutePath = resolve(vaultPath, path);
		const relativePath = relative(vaultPath, absolutePath);

		// Path must not start with '..' or be absolute outside vault
		return !relativePath.startsWith('..') && !require('path').isAbsolute(relativePath);
	}
}
