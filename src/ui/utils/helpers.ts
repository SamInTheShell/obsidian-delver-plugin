/**
 * Helper utilities for UI
 */

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
	return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
	return `chat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Truncate text to a maximum length
 */
export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.substring(0, maxLength) + '...';
}

/**
 * Format token count with commas
 */
export function formatTokenCount(count: number): string {
	return count.toLocaleString();
}

/**
 * Calculate percentage
 */
export function calculatePercentage(current: number, max: number): number {
	if (max === 0) return 0;
	return Math.round((current / max) * 100);
}
