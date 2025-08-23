/**
 * createTTYDocument - Factory function for HTML-to-Terminal rendering
 * 
 * Creates a standard HappyDOM document enhanced with terminal capabilities.
 * This replaces the custom TTY element system with familiar HTML/CSS APIs.
 * 
 * Usage:
 * ```typescript
 * const { document, runtime } = createTTYDocument();
 * const div = document.createElement('div');
 * div.textContent = 'Hello Terminal!';
 * document.body.appendChild(div);
 * await runtime.render(document);
 * ```
 */

import { Window, Document } from 'happy-dom';
import { TTYRuntime, detectTTYRuntime } from './TTYRuntime.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';
import { LayoutEngine } from '../layout/LayoutEngine.js';
import { initializeHTMLExtensions } from './HTMLExtensions.js';

export interface TTYDocumentOptions {
  runtime?: TTYRuntime;
  width?: number;
  height?: number;
}

export interface TTYDocumentResult {
  document: Document;
  runtime: TTYRuntime;
  render: () => Promise<void>;
  dispose: () => void;
}

/**
 * Create a TTY-enabled HTML document
 * 
 * Returns a standard HappyDOM document that can render to terminal output.
 * Elements created with document.createElement() will have full layout APIs.
 */
export function createTTYDocument(options: TTYDocumentOptions = {}): TTYDocumentResult {
  // Initialize HTML extensions once
  initializeHTMLExtensions();
  
  // Auto-detect runtime if not provided
  const runtime = options.runtime || detectTTYRuntime();
  
  // Create standard HappyDOM window and document
  const window = new Window({
    url: 'tty://terminal',
    width: options.width || 1024,
    height: options.height || 768
  });
  const document = window.document;
  
  // Initialize terminal dimensions
  const termSize = runtime.getTerminalSize();
  const screenBuffer = new ScreenBuffer({
    width: options.width || termSize.columns,
    height: options.height || termSize.rows,
    runtime
  });
  
  // Initialize layout engine
  const layoutEngine = new LayoutEngine();
  
  // Render function that handles layout and terminal output
  const render = async (): Promise<void> => {
    try {
      // 1. Compute layout using Yoga
      layoutEngine.computeLayout(
        document.documentElement, 
        screenBuffer.width, 
        screenBuffer.height
      );
      
      // 2. Clear screen buffer
      screenBuffer.clear();
      
      // 3. Render DOM tree to screen buffer
      screenBuffer.renderTree(document.documentElement);
      
      // 4. Send delta changes to terminal
      await screenBuffer.renderDelta();
    } catch (error) {
      console.error('TTY render error:', error);
    }
  };
  
  // Cleanup function
  const dispose = (): void => {
    try {
      screenBuffer.dispose();
      runtime.exit(0);
      window.close();
    } catch (error) {
      console.error('TTY dispose error:', error);
    }
  };
  
  // Set up automatic cleanup on exit
  runtime.onUncaughtException((error) => {
    console.error('Uncaught exception in TTY application:', error);
    dispose();
  });
  
  // Handle Ctrl+C gracefully
  runtime.addEventListener('interrupt', () => {
    dispose();
  });
  
  return {
    document,
    runtime,
    render,
    dispose
  };
}

/**
 * Convenience function that also sets up auto-rendering via MutationObserver
 */
export function createTTYDocumentWithAutoRender(options: TTYDocumentOptions = {}): TTYDocumentResult {
  const result = createTTYDocument(options);
  
  // Set up MutationObserver for automatic rendering
  const observer = new MutationObserver(async () => {
    await result.render();
  });
  
  observer.observe(result.document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });
  
  // Extend dispose to cleanup observer
  const originalDispose = result.dispose;
  result.dispose = () => {
    observer.disconnect();
    originalDispose();
  };
  
  return result;
}