/**
 * Chat loop orchestration
 * Manages the full conversation flow including tool calls and permissions
 */

import { BaseProvider, GenerationChunk } from '../types/providers';
import { DelverMessage, ChatSession, ToolCall } from '../types/messages';
import { ToolExecutionContext } from '../types/tools';
import { ToolRegistry } from '../tools/registry';
import { PermissionManager } from '../tools/permissions';
import { ContextManager } from '../context/manager';
import { generate } from './generate';

export interface ChatLoopCallbacks {
	/**
	 * Called when a chunk is received (content, thinking, etc.)
	 */
	onChunk: (chunk: GenerationChunk) => void;

	/**
	 * Called when tool permission is required
	 * Should return true if approved, false if denied
	 */
	onToolPermission: (toolCall: ToolCall) => Promise<boolean>;

	/**
	 * Called when tool calls are complete and generation is continuing
	 * This allows the UI to save and re-render tool results without removing the loading indicator
	 */
	onToolCallsComplete?: (message: DelverMessage) => void;

	/**
	 * Called when generation is complete
	 */
	onComplete?: (message: DelverMessage) => void;

	/**
	 * Called when an error occurs
	 */
	onError?: (error: string) => void;
}

export class ChatLoop {
	constructor(
		private provider: BaseProvider,
		private toolRegistry: ToolRegistry,
		private permissionManager: PermissionManager,
		private contextManager: ContextManager,
		private modelMaxTokens: number
	) {}

	/**
	 * Run the chat loop for a session
	 */
	async run(
		session: ChatSession,
		systemPrompt: DelverMessage,
		toolExecutionContext: ToolExecutionContext,
		callbacks: ChatLoopCallbacks,
		signal?: AbortSignal
	): Promise<void> {
		// Get active messages from context manager
		const activeMessages = this.contextManager.getActiveMessages(
			session,
			this.modelMaxTokens,
			systemPrompt
		);

		// Get enabled tools
		const tools = this.toolRegistry.getEnabledTools(
			this.permissionManager.getAllPermissions()
		);

		// Check if model supports thinking
		const supportsThinking = await this.checkThinkingSupport(session.model);

		// Create assistant message
		let assistantMessage: DelverMessage = {
			id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
			role: 'assistant',
			content: '',
			timestamp: Date.now(),
			isStreaming: true
		};

		try {
			// Start generation
			const genOptions = {
				messages: activeMessages,
				tools,
				provider: this.provider,
				model: session.model,
				think: supportsThinking,
				signal
			};

			// Stream response
			for await (const chunk of generate(genOptions)) {
				// Handle different chunk types
				if (chunk.type === 'content') {
					assistantMessage.content += chunk.content || '';
					callbacks.onChunk(chunk);
				} else if (chunk.type === 'thinking') {
					assistantMessage.thinking = (assistantMessage.thinking || '') + (chunk.thinking || '');
					callbacks.onChunk(chunk);
				} else if (chunk.type === 'tool_call') {
					assistantMessage.tool_calls = chunk.tool_calls;
					assistantMessage.isStreaming = false;
					callbacks.onChunk(chunk);

					// Add assistant message with tool calls
					session.messages.push(assistantMessage);
					
					// Handle tool calls BEFORE calling onComplete
					// This ensures the message is fully processed before rendering
					await this.handleToolCalls(
						session,
						systemPrompt,
						assistantMessage,
						toolExecutionContext,
						callbacks,
						signal
					);
					return;
				} else if (chunk.type === 'done') {
					assistantMessage.isStreaming = false;
					callbacks.onChunk(chunk);
				} else if (chunk.type === 'error') {
					assistantMessage.isStreaming = false;
					if (callbacks.onError) {
						callbacks.onError(chunk.error || 'Unknown error');
					}
					return;
				}
			}

			// Add final assistant message
			session.messages.push(assistantMessage);
			if (callbacks.onComplete) {
				callbacks.onComplete(assistantMessage);
			}
		} catch (error: any) {
			if (callbacks.onError) {
				callbacks.onError(error.message || 'Unknown error');
			}
		}
	}

	/**
	 * Handle tool calls with permission checking
	 */
	private async handleToolCalls(
		session: ChatSession,
		systemPrompt: DelverMessage,
		message: DelverMessage,
		toolExecutionContext: ToolExecutionContext,
		callbacks: ChatLoopCallbacks,
		signal?: AbortSignal
	): Promise<void> {
		if (!message.tool_calls) return;
		
		console.log('[ChatLoop] handleToolCalls starting with', message.tool_calls.length, 'tool calls');

		// Execute each tool call
		for (const toolCall of message.tool_calls) {
			const toolName = toolCall.function.name;
			console.log('[ChatLoop] Processing tool call:', toolName);

			// Check if tool exists
			const tool = this.toolRegistry.getTool(toolName);
			if (!tool) {
				console.log('[ChatLoop] Tool not found:', toolName);
				toolCall.permissionStatus = 'denied';
				toolCall.error = `Tool not found: ${toolName}`;
				continue;
			}

			// Check permission
			if (this.permissionManager.isDisabled(toolName)) {
				console.log('[ChatLoop] Tool is disabled:', toolName);
				toolCall.permissionStatus = 'denied';
				toolCall.error = `Tool is disabled: ${toolName}`;
				continue;
			}

			if (this.permissionManager.isDenied(toolName)) {
				console.log('[ChatLoop] Tool is denied:', toolName);
				toolCall.permissionStatus = 'denied';
				toolCall.error = `Tool is denied: ${toolName}`;
				continue;
			}

			// Ask for permission if required
			if (this.permissionManager.requiresPrompt(toolName)) {
				console.log('[ChatLoop] Requesting permission for:', toolName);
				const approved = await callbacks.onToolPermission(toolCall);
				console.log('[ChatLoop] Permission', approved ? 'approved' : 'denied', 'for:', toolName);
				toolCall.permissionStatus = approved ? 'approved' : 'denied';
				if (!approved) {
					toolCall.error = 'Permission denied by user';
					continue;
				}
			} else {
				// Auto-approved
				console.log('[ChatLoop] Auto-approved:', toolName);
				toolCall.permissionStatus = 'approved';
			}

			// Execute tool
			try {
				console.log('[ChatLoop] Executing tool:', toolName);
				toolCall.result = await tool.execute(
					toolCall.function.arguments,
					toolExecutionContext
				);
				console.log('[ChatLoop] Tool execution successful:', toolName, '- result length:', toolCall.result?.length);
			} catch (error: any) {
				console.error('[ChatLoop] Tool execution failed:', toolName, error);
				toolCall.error = error.message || 'Tool execution failed';
			}

			// Add tool result message
			session.messages.push({
				id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
				role: 'tool',
				content: toolCall.result || toolCall.error || 'No result',
				tool_name: toolName,
				timestamp: Date.now()
			});
		}

		console.log('[ChatLoop] All tool calls processed, continuing generation...');

		// Call onToolCallsComplete to allow UI to save and re-render tool results
		// without removing the loading indicator (since generation is continuing)
		if (callbacks.onToolCallsComplete) {
			await callbacks.onToolCallsComplete(message);
		}

		// Continue generation with tool results
		await this.run(session, systemPrompt, toolExecutionContext, callbacks, signal);
	}

	/**
	 * Check if model supports thinking
	 */
	private async checkThinkingSupport(model: string): Promise<boolean> {
		try {
			const modelInfo = await this.provider.getModelInfo(model);
			return modelInfo.supportsThinking;
		} catch (error) {
			// Default to false if we can't get model info
			return false;
		}
	}
}
