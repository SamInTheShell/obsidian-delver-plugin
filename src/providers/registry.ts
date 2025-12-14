/**
 * Provider registry for managing AI provider instances
 */

import { BaseProvider, ProviderConfig } from '../types/providers';
import { OllamaProvider } from './ollama';

export class ProviderRegistry {
	private static instance: ProviderRegistry;
	private currentProvider: BaseProvider | null = null;

	private constructor() {}

	static getInstance(): ProviderRegistry {
		if (!ProviderRegistry.instance) {
			ProviderRegistry.instance = new ProviderRegistry();
		}
		return ProviderRegistry.instance;
	}

	/**
	 * Get or create provider based on configuration
	 */
	getProvider(config: ProviderConfig): BaseProvider {
		// For now, we only support Ollama
		// In the future, add support for other providers here
		switch (config.type) {
			case 'ollama':
				this.currentProvider = new OllamaProvider(config);
				break;
			default:
				throw new Error(`Unsupported provider type: ${config.type}`);
		}

		return this.currentProvider;
	}

	/**
	 * Get currently active provider
	 */
	getCurrentProvider(): BaseProvider | null {
		return this.currentProvider;
	}

	/**
	 * Clear current provider
	 */
	clearProvider(): void {
		if (this.currentProvider) {
			this.currentProvider.cancelGeneration();
			this.currentProvider = null;
		}
	}
}
