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
import { LayoutEngine } from '../layout/LayoutEngine.js';
import { initializeHTMLExtensions, YOGA_NODE, ELEMENT_BOUNDS, ELEMENT_RECTS } from './HTMLExtensions.js';
import { window, HTMLElement } from '../dom.js';

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
  initializeHTMLExtensions(window as any);

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
  
  // Set CSSOM-compliant window dimensions to match terminal viewport
  // These are read-only properties that reflect the actual terminal size
  Object.defineProperty(window, 'innerWidth', {
    value: termSize.columns,
    writable: false,
    configurable: true
  });
  Object.defineProperty(window, 'innerHeight', {
    value: termSize.rows,
    writable: false,
    configurable: true
  });
  // In terminals, outer dimensions are the same as inner dimensions
  Object.defineProperty(window, 'outerWidth', {
    value: termSize.columns,
    writable: false,
    configurable: true
  });
  Object.defineProperty(window, 'outerHeight', {
    value: termSize.rows,
    writable: false,
    configurable: true
  });

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

  // We'll set up the observer first, then define processPendingMutations
  let observer: MutationObserver;
  
  // Track dirty root nodes to minimize layout recomputation
  const dirtyRoots = new Set<HTMLElement>();
  
  // Track if initial layout has been computed
  let initialLayoutComputed = false;
  
  // Process pending mutations and invalidate layout intelligently
  const processPendingMutations = (): void => {
    // Take any pending mutations
    const mutations = observer.takeRecords();
    if (mutations.length === 0) return;
    
    // Process mutations to find dirty nodes
    for (const mutation of mutations) {
      let targetElement: HTMLElement | null = null;
      
      if (mutation.target instanceof HTMLElement) {
        targetElement = mutation.target;
      } else if (mutation.type === 'characterData' && mutation.target.nodeType === Node.TEXT_NODE) {
        // Text content changes target the text node, we need the parent element
        targetElement = mutation.target.parentElement as HTMLElement;
      }
      
      if (!targetElement) continue;
      
      if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
        // Style change - only affects this specific element (no inherited layout properties in TUI)
        // TODO: When we add white-space support, may need to check for inherited text properties
        markDirtySingle(targetElement);
      } else if (mutation.type === 'childList') {
        // DOM structure change - affects parent's layout (children need to be re-added to Yoga tree)
        // For inline elements, this could be text content changes (textContent setter creates childList mutations)
        if (!targetElement[YOGA_NODE]) {
          // Inline element content changed - treat like text change
          markDirtySingle(targetElement);
        } else {
          // Block element structure changed
          markDirtyWithBubbling(targetElement);
        }
      } else if (mutation.type === 'characterData') {
        // Text content change - only affects this node (measure function)
        markDirtySingle(targetElement);
      }
    }
    
    // Clean up redundant dirty roots after processing all mutations
    pruneRedundantDirtyRoots();
  };
  
  // Mark a single node as dirty (for text changes)
  const markDirtySingle = (element: HTMLElement): void => {
    if (!element[YOGA_NODE]) {
      // For inline elements without Yoga nodes, mark their parent for re-layout
      // This will trigger processInlineLayout for the parent container
      const parent = element.parentElement as HTMLElement;
      if (parent && parent[YOGA_NODE]) {
        // Clear cached bounds for the inline element
        delete element[ELEMENT_BOUNDS];
        delete element[ELEMENT_RECTS];
        
        // Mark parent dirty for re-layout
        if (!isAncestorDirty(parent)) {
          dirtyRoots.add(parent);
        }
      }
      return;
    }
    
    // If this node or an ancestor is already in dirtyRoots, skip
    if (isAncestorDirty(element)) return;
    
    // Only call markDirty on leaf nodes with measure functions
    // For other nodes, just add them to dirtyRoots for full recomputation
    dirtyRoots.add(element);
  };
  
  // Mark node as dirty and bubble up until we find an already-dirty ancestor
  const markDirtyWithBubbling = (element: HTMLElement): void => {
    let current: HTMLElement | null = element;
    
    while (current && current[YOGA_NODE]) {
      // If this node is already dirty, stop bubbling
      if (dirtyRoots.has(current)) break;
      
      // Add to dirty roots but don't call markDirty - let full recomputation handle it
      dirtyRoots.add(current);
      
      // Move up to parent
      current = current.parentElement;
    }
  };
  
  // Check if any ancestor of this element is already marked dirty
  const isAncestorDirty = (element: HTMLElement): boolean => {
    let current: HTMLElement | null = element.parentElement;
    while (current) {
      if (dirtyRoots.has(current)) return true;
      current = current.parentElement;
    }
    return false;
  };
  
  // Clean up dirty roots by removing children of dirty parents
  const pruneRedundantDirtyRoots = (): void => {
    const toRemove = new Set<HTMLElement>();
    
    for (const root of dirtyRoots) {
      // If any ancestor is also dirty, this one is redundant
      if (isAncestorDirty(root)) {
        toRemove.add(root);
      }
    }
    
    for (const element of toRemove) {
      dirtyRoots.delete(element);
    }
  };

  // Internal render function for MutationObserver
  const internalRender = async (): Promise<void> => {
    try {
      // Always compute layout if it's the first time or if there are dirty nodes
      if (!initialLayoutComputed || dirtyRoots.size > 0) {
        // For now, recompute the entire tree (can optimize later to compute only dirty subtrees)
        layoutEngine.computeLayout(
          document.documentElement,
          screenBuffer.width,
          screenBuffer.height
        );
        
        // Clear dirty roots after layout computation
        dirtyRoots.clear();
        initialLayoutComputed = true;
      }

      // Clear screen buffer and render DOM tree
      screenBuffer.clear();
      screenBuffer.renderTree(document.documentElement);

      // Render using mode-appropriate strategy
      await screenBuffer.renderDelta();
    } catch (error) {
      console.error('TTY render error:', error);
    }
  };
  
  // Make processPendingMutations available to layout system
  (window as any)._processPendingMutations = processPendingMutations;
  
  // Also expose dirtyRoots and layout computation for on-demand layout
  (window as any)._dirtyRoots = dirtyRoots;
  
  (window as any)._computeLayoutIfNeeded = () => {
    // Always compute layout if it's the first time or if there are dirty nodes
    if (!initialLayoutComputed || dirtyRoots.size > 0) {
      layoutEngine.computeLayout(
        document.documentElement,
        screenBuffer.width,
        screenBuffer.height
      );
      dirtyRoots.clear();
      initialLayoutComputed = true;
    }
  };

  // Set up MutationObserver for automatic rendering (like browsers)
  observer = new window.MutationObserver(async (mutations) => {
    // Process mutations and render
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

  // Handle terminal resize (CSSOM-compliant)
  runtime.addEventListener('resize', (event: any) => {
    const newDimensions = event.detail as { columns: number; rows: number };
    handleTerminalResize(newDimensions);
  });

  // CSSOM-compliant resize handler
  const handleTerminalResize = (newSize: { columns: number; rows: number }): void => {
    console.log('handleTerminalResize called with:', newSize);
    // Temporarily disconnect observer to prevent mutations during resize
    observer.disconnect();

    // 1. Update ScreenBuffer dimensions
    screenBuffer.resize(newSize.columns, newSize.rows);

    // 2. Update CSSOM window properties (redefine since they're not writable)
    Object.defineProperty(window, 'innerWidth', {
      value: newSize.columns,
      writable: false,
      configurable: true
    });
    Object.defineProperty(window, 'innerHeight', {
      value: newSize.rows,
      writable: false,
      configurable: true
    });
    Object.defineProperty(window, 'outerWidth', {
      value: newSize.columns,
      writable: false,
      configurable: true
    });
    Object.defineProperty(window, 'outerHeight', {
      value: newSize.rows,
      writable: false,
      configurable: true
    });

    // 3. Update document root styles to match new terminal size
    document.documentElement.style.setProperty('width', `${newSize.columns}ch`);
    if (renderMode === 'fullscreen') {
      document.documentElement.style.setProperty('height', `${newSize.rows}ch`);
    }

    // 4. Store new terminal size
    (window as any)._terminalSize = newSize;

    // 5. Force complete layout recomputation with new viewport
    // Mark entire layout tree as dirty for recomputation
    dirtyRoots.clear();
    dirtyRoots.add(document.documentElement as HTMLElement);
    initialLayoutComputed = false;

    // 6. Fire standard DOM resize event on window (after updates are complete)
    const resizeEvent = new Event('resize', {
      bubbles: false,
      cancelable: false
    });
    console.log('Dispatching DOM resize event on window:', window === window.window);
    console.log('Window dispatchEvent function:', typeof window.dispatchEvent);
    const result = window.dispatchEvent(resizeEvent);
    console.log('Event dispatch result:', result);

    // 7. Force immediate layout recomputation with new dimensions
    // We need to compute layout synchronously before any rendering can happen
    layoutEngine.computeLayout(
      document.documentElement,
      newSize.columns,
      newSize.rows
    );
    dirtyRoots.clear();
    initialLayoutComputed = true;

    // 8. Reconnect observer after resize is complete
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  };

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
    window: window as any,
    runtime,
    dispose,
    requestFullScreen: !screenBuffer.isFullscreen ? requestFullScreen : undefined
  };
}

