/**
 * createTTY - Factory function for creating TTY applications
 * 
 * Provides a convenient way to create TTYWindow instances with sensible defaults.
 * This function is kept for backwards compatibility, but the preferred approach
 * is to use `new TTYWindow()` directly with auto-detection.
 */

import { TTYWindow, type TTYWindowOptions } from './TTYWindow.js';

/**
 * Create a new TTY window - convenience function
 * 
 * @param options - TTY window options
 * @returns TTYWindow instance
 * 
 * @example
 * ```typescript
 * // Simple usage
 * const tty = createTTY();
 * 
 * // With options
 * const tty = createTTY({
 *   width: 80,
 *   height: 24
 * });
 * ```
 */
export function createTTY(options?: TTYWindowOptions): TTYWindow {
  return new TTYWindow(options);
}