/**
 * Factory functions for creating TOM instances with different viewport modes
 */

import { TOMDocument } from './TOMDocument.js';
import { ViewportOptions } from './TOMViewport.js';

export interface TOMOptions extends ViewportOptions {
  /** Output stream (defaults to stdout) */
  output?: NodeJS.WriteStream;
}

/**
 * Create a fullscreen TOM instance (takes over entire terminal)
 */
export function createTOM(options?: TOMOptions): TOMDocument {
  return new TOMDocument({
    width: options?.width ?? process.stdout.columns ?? 80,
    height: options?.height ?? process.stdout.rows ?? 24,
    output: options?.output ?? process.stdout,
    viewportOptions: {
      position: 'fixed',
      overflow: options?.overflow ?? 'hidden',
      ...options
    }
  });
}

/**
 * Create a flow-based TOM instance (renders inline with terminal content)
 */
export function createTOMFlow(options?: TOMOptions): TOMDocument {
  return new TOMDocument({
    width: options?.width ?? process.stdout.columns ?? 80,
    height: 1, // Will auto-expand
    output: options?.output ?? process.stdout,
    viewportOptions: {
      position: 'relative',
      height: 'auto',
      overflow: options?.overflow ?? 'visible',
      ...options
    }
  });
}

/**
 * Create a windowed TOM instance (fixed size box in terminal flow)
 */
export function createTOMWindow(options: TOMOptions & { height: number }): TOMDocument {
  return new TOMDocument({
    width: options.width ?? process.stdout.columns ?? 80,
    height: options.height,
    output: options.output ?? process.stdout,
    viewportOptions: {
      position: 'relative',
      height: options.height,
      overflow: options.overflow ?? 'auto',
      ...options
    }
  });
}