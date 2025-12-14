/**
 * Ollama provider implementation
 * Integrates with Ollama API for chat completion with streaming
 */

import { requestUrl } from 'obsidian';
import {
	BaseProvider,
	GenerationRequest,
	GenerationChunk,
	ModelInfo,
	ProviderConfig
} from '../types/providers';

export class OllamaProvider extends BaseProvider {
	private config: { address: string; apiKey?: string };
	private abortController: AbortController | null = null;

	constructor(config: ProviderConfig) {
		super();
		this.config = {
			address: config.address || 'http://localhost:11434',
			apiKey: config.apiKey
		};
	}

	async *generate(request: GenerationRequest): AsyncGenerator<GenerationChunk> {
		const url = `${this.config.address}/api/chat`;

		// Create abort controller for this generation
		this.abortController = new AbortController();

		const body = {
			model: request.model,
			messages: request.messages.map(m => ({
				role: m.role,
				content: m.content,
				...(m.thinking && { thinking: m.thinking }),
				...(m.tool_calls && { tool_calls: m.tool_calls }),
				...(m.tool_name && { tool_name: m.tool_name })
			})),
			...(request.tools && { tools: request.tools }),
			stream: true,
			...(request.options?.think !== undefined && { think: request.options.think })
		};

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.config.apiKey && { 'Authorization': `Bearer ${this.config.apiKey}` })
				},
				body: JSON.stringify(body),
				signal: this.abortController.signal
			});

			if (!response.ok) {
				yield {
					type: 'error',
					error: `HTTP ${response.status}: ${response.statusText}`
				};
				return;
			}

			// Parse streaming response
			const reader = response.body?.getReader();
			if (!reader) {
				yield { type: 'error', error: 'No response body' };
				return;
			}

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');

				// Keep last incomplete line in buffer
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (!line.trim()) continue;

					try {
						const data = JSON.parse(line);

						// Content chunk
						if (data.message?.content) {
							yield {
								type: 'content',
								content: data.message.content
							};
						}

						// Thinking chunk
						if (data.message?.thinking) {
							yield {
								type: 'thinking',
								thinking: data.message.thinking
							};
						}

						// Tool calls
						if (data.message?.tool_calls) {
							yield {
								type: 'tool_call',
								tool_calls: data.message.tool_calls
							};
						}

						// Done
						if (data.done) {
							yield {
								type: 'done',
								done: true,
								totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
								promptTokens: data.prompt_eval_count,
								completionTokens: data.eval_count
							};
						}
					} catch (parseError) {
						console.error('[Ollama] Failed to parse line:', line, parseError);
					}
				}
			}
		} catch (error: any) {
			if (error.name === 'AbortError') {
				yield { type: 'error', error: 'Generation cancelled' };
			} else {
				yield { type: 'error', error: error.message || 'Unknown error' };
			}
		} finally {
			this.abortController = null;
		}
	}

	async getModelInfo(model: string): Promise<ModelInfo> {
		const url = `${this.config.address}/api/show`;

		try {
			const response = await requestUrl({
				url,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model })
			});

			const data = JSON.parse(response.text);
			const modelInfo = data.model_info;

			// Extract architecture to build context length key
			const arch = modelInfo['general.architecture'];
			const contextLength = modelInfo[`${arch}.context_length`] || 8192;

			return {
				name: model,
				contextLength,
				supportsThinking: this.checkThinkingSupport(model),
				supportsTools: true // Ollama supports tools for most models
			};
		} catch (error: any) {
			throw new Error(`Failed to get model info: ${error.message}`);
		}
	}

	async listModels(): Promise<string[]> {
		const url = `${this.config.address}/api/tags`;

		try {
			const response = await requestUrl({ url });
			const data = JSON.parse(response.text);
			return data.models.map((m: any) => m.name);
		} catch (error: any) {
			throw new Error(`Failed to list models: ${error.message}`);
		}
	}

	cancelGeneration(): void {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	/**
	 * Check if model supports thinking based on name
	 */
	private checkThinkingSupport(model: string): boolean {
		const thinkingModels = ['gpt-oss', 'qwen3', 'qwen2.5', 'deepseek-r1'];
		return thinkingModels.some(name => model.toLowerCase().includes(name));
	}
}
