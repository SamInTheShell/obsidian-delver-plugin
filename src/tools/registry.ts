/**
 * Tool registry for managing available tools
 */

import { BaseTool, ToolPermission } from '../types/tools';
import { ToolDefinition } from '../types/providers';

export class ToolRegistry {
	private tools: Map<string, BaseTool> = new Map();

	/**
	 * Register a tool
	 */
	register(tool: BaseTool): void {
		this.tools.set(tool.name, tool);
	}

	/**
	 * Get a tool by name
	 */
	getTool(name: string): BaseTool | undefined {
		return this.tools.get(name);
	}

	/**
	 * Get all registered tools
	 */
	getAllTools(): BaseTool[] {
		return Array.from(this.tools.values());
	}

	/**
	 * Get enabled tools based on permissions
	 * Returns tool definitions for API
	 */
	getEnabledTools(permissions: Record<string, ToolPermission>): ToolDefinition[] {
		return Array.from(this.tools.values())
			.filter(tool => {
				const permission = permissions[tool.name] || 'ask';
				return permission !== 'disabled';
			})
			.map(tool => tool.toDefinition());
	}

	/**
	 * Check if a tool exists
	 */
	has(name: string): boolean {
		return this.tools.has(name);
	}

	/**
	 * Unregister a tool
	 */
	unregister(name: string): boolean {
		return this.tools.delete(name);
	}

	/**
	 * Clear all tools
	 */
	clear(): void {
		this.tools.clear();
	}
}
