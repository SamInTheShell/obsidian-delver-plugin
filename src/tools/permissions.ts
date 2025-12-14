/**
 * Permission manager for tool execution
 */

import { ToolPermission } from '../types/tools';

export class PermissionManager {
	private permissions: Record<string, ToolPermission>;

	constructor(permissions: Record<string, ToolPermission> = {}) {
		this.permissions = permissions;
	}

	/**
	 * Get permission for a tool
	 */
	getPermission(toolName: string): ToolPermission {
		return this.permissions[toolName] || 'ask';
	}

	/**
	 * Set permission for a tool
	 */
	setPermission(toolName: string, permission: ToolPermission): void {
		this.permissions[toolName] = permission;
	}

	/**
	 * Check if tool requires permission prompt
	 */
	requiresPrompt(toolName: string): boolean {
		return this.getPermission(toolName) === 'ask';
	}

	/**
	 * Check if tool is allowed to execute
	 */
	isAllowed(toolName: string): boolean {
		const permission = this.getPermission(toolName);
		return permission === 'allow';
	}

	/**
	 * Check if tool is denied
	 */
	isDenied(toolName: string): boolean {
		const permission = this.getPermission(toolName);
		return permission === 'deny';
	}

	/**
	 * Check if tool is disabled
	 */
	isDisabled(toolName: string): boolean {
		const permission = this.getPermission(toolName);
		return permission === 'disabled';
	}

	/**
	 * Get all permissions
	 */
	getAllPermissions(): Record<string, ToolPermission> {
		return { ...this.permissions };
	}

	/**
	 * Update all permissions
	 */
	updatePermissions(permissions: Record<string, ToolPermission>): void {
		this.permissions = { ...permissions };
	}
}
