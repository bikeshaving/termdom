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

import { TTYRuntime, detectTTYRuntime } from './TTYRuntime.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';
import { FlowRenderer } from '../rendering/FlowRenderer.js';
import { LayoutEngine } from '../layout/LayoutEngine.js';
import { initializeHTMLExtensions } from './HTMLExtensions.js';
import { window } from '../dom.js';

export interface TTYDocumentOptions {
  runtime?: TTYRuntime;
  width?: number;
  height?: number;
  /** Render mode: 'flow' for inline CLI output, 'fullscreen' for TUI apps */
  mode?: 'flow' | 'fullscreen';
}

export interface TTYResult {
  document: Document;
  window: Window;
  runtime: TTYRuntime;
  dispose: () => void;
  /** Switch to fullscreen TUI mode */
  requestFullScreen?: () => void;
}

/**
 * Create a TTY-enabled HTML document with automatic rendering
 * 
 * Returns a standard HappyDOM document that automatically renders to terminal
 * when the DOM changes (just like a real browser). No manual render() calls needed.
 */
export function createTTY(options: TTYDocumentOptions = {}): TTYResult {
  // Auto-detect runtime if not provided
  const runtime = options.runtime || detectTTYRuntime();
  
  // Use singleton window and reset its document
  const document = window.document;
  
  // Clear the document for a fresh start
  document.documentElement.innerHTML = '<head></head><body></body>';
  
  // Initialize HTML extensions with the JSDOM window
  initializeHTMLExtensions(window);
  
  // Initialize rendering mode (default to flow for CLI-like behavior)
  const renderMode = options.mode || 'flow';
  const termSize = runtime.getTerminalSize();
  
  // Create ScreenBuffer with mode support
  const screenBuffer = new ScreenBuffer({
    width: options.width || termSize.columns,
    height: options.height || termSize.rows,
    mode: renderMode,
    runtime
  });
  
  // Initialize layout engine
  const layoutEngine = new LayoutEngine();
  
  // Make layout engine and terminal size available for on-demand layout computation
  // (use the imported window object, not document.defaultView)
  (window as any)._layoutEngine = layoutEngine;
  (window as any)._terminalSize = termSize;
  
  // Reset default browser styles for consistent terminal behavior
  document.documentElement.style.setProperty('margin', '0');
  document.documentElement.style.setProperty('padding', '0');
  document.body.style.setProperty('margin', '0');
  document.body.style.setProperty('padding', '0');
  
  // Both modes use flexbox layout (required for Yoga engine)
  document.documentElement.style.setProperty('display', 'flex');
  document.documentElement.style.setProperty('flex-direction', 'column');
  document.body.style.setProperty('display', 'flex');
  document.body.style.setProperty('flex-direction', 'column');
  
  if (renderMode === 'flow') {
    // Flow mode: flexible dimensions, content-driven size
    document.documentElement.style.setProperty('width', `${screenBuffer.width}ch`);
    // No fixed height - let content determine height
    document.body.style.setProperty('flex', '1');
  } else {
    // Fullscreen mode: fixed dimensions matching terminal
    document.documentElement.style.setProperty('width', `${screenBuffer.width}ch`);
    document.documentElement.style.setProperty('height', `${screenBuffer.height}ch`);
    document.body.style.setProperty('flex', '1');
  }
  
  // Internal render function for MutationObserver
  const internalRender = async (): Promise<void> => {
    try {
      // Always use LayoutEngine to compute layout (respects existing architecture)
      layoutEngine.computeLayout(
        document.documentElement, 
        screenBuffer.width, 
        screenBuffer.height
      );
      
      // Clear screen buffer and render DOM tree
      screenBuffer.clear();
      screenBuffer.renderTree(document.documentElement);
      
      // Render using mode-appropriate strategy
      await screenBuffer.renderDelta();
    } catch (error) {
      console.error('TTY render error:', error);
    }
  };
  
  // Set up MutationObserver for automatic rendering (like browsers)
  const observer = new window.MutationObserver(async (mutations) => {
    console.log(`🔄 JSDOM render triggered: ${mutations.length} mutations`);
    await internalRender();
  });
  
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });
  
  // Cleanup function
  const dispose = (): void => {
    try {
      // Disconnect and clear MutationObserver
      observer.disconnect();
      // Clear any pending mutation records
      observer.takeRecords();
      
      screenBuffer.dispose();
      runtime.exit(0);
      
      // Reset the singleton DOM to clean state
      document.documentElement.innerHTML = '<head></head><body></body>';
      
      // Note: Don't close the window since it's a singleton
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
  
  // Function to switch to fullscreen mode
  const requestFullScreen = () => {
    if (screenBuffer.isFullscreen) return; // Already in fullscreen mode
    
    screenBuffer.setFullscreenMode(true);
    
    // Update document layout for fullscreen
    document.documentElement.style.setProperty('display', 'flex');
    document.documentElement.style.setProperty('flex-direction', 'column');
    document.documentElement.style.setProperty('width', `${screenBuffer.width}ch`);
    document.documentElement.style.setProperty('height', `${screenBuffer.height}ch`);
    
    document.body.style.setProperty('display', 'flex');
    document.body.style.setProperty('flex-direction', 'column');
    document.body.style.setProperty('flex', '1');
  };
  
  return {
    document,
    window,
    runtime,
    dispose,
    requestFullScreen: !screenBuffer.isFullscreen ? requestFullScreen : undefined
  };
}

