/**
 * TTYWindow - Main orchestrator for TTY Object Model
 *
 * Acts as the window-like interface for TTY applications, coordinating
 * between the document, viewport, event handling, and rendering systems.
 * Provides standard DOM APIs like innerWidth/Height, scroll methods, and events.
 */

import { Window } from 'happy-dom';
import { TTYDocument, TTYDocumentOptions } from './TTYDocument.js';
import { TTYViewport, ViewportOptions } from './TTYViewport.js';
import { TTYMouseHandler } from './TTYMouseHandler.js';
import { TTYKeyboardHandler } from './TTYKeyboardHandler.js';
import { TTYRuntime, detectTTYRuntime, type TTYDimensions } from './TTYRuntime.js';

export interface TTYWindowOptions {
  runtime?: TTYRuntime;
  width?: number;
  height?: number;
  viewport?: ViewportOptions;
  document?: TTYDocumentOptions;
}

export type ViewportMode = 'flow' | 'fullscreen';

/**
 * TTYWindow serves as the main entry point and orchestrator for TTY applications.
 * It extends HappyDOM's Window class and coordinates between all TTY subsystems.
 * 
 * Features auto-detection of TTYRuntime if none provided, making it easy to use:
 * ```typescript
 * const tty = new TTYWindow(); // Auto-detects Bun/Node/Deno runtime
 * ```
 */
export class TTYWindow extends Window implements Disposable {
  private _document: TTYDocument;
  private _viewport: TTYViewport | null = null;
  private _mouseHandler: TTYMouseHandler;
  private _keyboardHandler: TTYKeyboardHandler;
  private _runtime: TTYRuntime;
  private _mode: ViewportMode = 'flow';
  private _isExiting = false;
  private _fullscreenElement: Element | null = null;

  constructor(options: TTYWindowOptions = {}) {
    // Auto-detect runtime if not provided
    const runtime = options.runtime || detectTTYRuntime();
    
    // Get terminal dimensions for HappyDOM Window
    const dimensions = runtime.getTerminalSize();
    
    // Call HappyDOM Window constructor with terminal dimensions
    super({
      width: options.width ?? dimensions.columns,
      height: options.height ?? dimensions.rows,
      url: 'https://localhost:3000'
    });

    // Now we can assign to this
    this._runtime = runtime;
    
    // Create TTYDocument using the proper factory method (after HappyDOM document exists)
    this._document = TTYDocument.create(this, this);
    
    // Override the HappyDOM document property with our TTYDocument
    Object.defineProperty(this, 'document', {
      get: () => this._document,
      enumerable: true,
      configurable: true
    });

    // Initialize handlers with runtime
    this._mouseHandler = new TTYMouseHandler(this._runtime);
    this._keyboardHandler = new TTYKeyboardHandler(this._runtime);

    // Set up event handling
    this._setupRuntimeEventHandling();
    this._setupDefaultBehavior();
    
    // Initialize viewport if specified
    if (options.viewport) {
      this._viewport = new TTYViewport(this._runtime, options.viewport);
    }

    // Set up cleanup on exit
    this._setupCleanupHandlers();
  }

  // === Public API ===

  /**
   * Get the TTY runtime instance
   */
  get runtime(): TTYRuntime {
    return this._runtime;
  }

  /**
   * Get the TTY document
   */
  get document(): TTYDocument {
    return this._document;
  }

  /**
   * Get current viewport mode
   */
  get mode(): ViewportMode {
    return this._mode;
  }

  /**
   * Switch between flow and fullscreen modes
   */
  async setMode(mode: ViewportMode): Promise<void> {
    if (this._mode === mode) return;

    this._mode = mode;
    
    if (mode === 'fullscreen') {
      await this._enterFullscreenMode();
    } else {
      await this._exitFullscreenMode();
    }
  }

  /**
   * Request fullscreen mode for a specific element
   */
  async requestFullscreen(element?: Element): Promise<void> {
    if (this._mode !== 'fullscreen') {
      await this.setMode('fullscreen');
    }
    
    this._fullscreenElement = element || this.document.body;
    
    // Dispatch fullscreenchange event
    const event = new Event('fullscreenchange');
    super.dispatchEvent(event);
  }

  /**
   * Exit fullscreen mode
   */
  async exitFullscreen(): Promise<void> {
    if (this._mode === 'fullscreen') {
      await this.setMode('flow');
    }
    
    this._fullscreenElement = null;
    
    // Dispatch fullscreenchange event
    const event = new Event('fullscreenchange');
    super.dispatchEvent(event);
  }

  /**
   * Get the current fullscreen element
   */
  get fullscreenElement(): Element | null {
    return this._fullscreenElement;
  }

  /**
   * Standard window dimensions (in characters)
   */
  get innerWidth(): number {
    const size = this._runtime.getTerminalSize();
    return size.columns;
  }

  get innerHeight(): number {
    const size = this._runtime.getTerminalSize();
    return size.rows;
  }

  get outerWidth(): number {
    return this.innerWidth;
  }

  get outerHeight(): number {
    return this.innerHeight;
  }

  /**
   * Scroll the window/viewport
   */
  scrollTo(x: number, y: number): void {
    if (this._viewport) {
      this._viewport.scrollTo(x, y);
    }
  }

  scrollBy(deltaX: number, deltaY: number): void {
    if (this._viewport) {
      this._viewport.scrollBy(deltaX, deltaY);
    }
  }

  // === Event Handling ===

  /**
   * Enhanced dispatchEvent that properly routes events
   */
  dispatchEvent(event: Event): boolean {
    // Route window-level events to this window
    if (this._isWindowLevelEvent(event.type)) {
      return super.dispatchEvent(event);
    }
    
    // Route other events to the document
    return this._document.dispatchEvent(event);
  }

  private _isWindowLevelEvent(type: string): boolean {
    return [
      'resize', 'fullscreenchange', 'beforeunload', 'unload',
      'focus', 'blur', 'load', 'error'
    ].includes(type);
  }

  // === Cleanup ===

  /**
   * Dispose of all resources and clean up
   */
  dispose(): void {
    if (this._isExiting) return;
    this._isExiting = true;

    try {
      // Clean up viewport
      this._viewport?.dispose();
      
      // Clean up handlers  
      this._mouseHandler?.dispose();
      this._keyboardHandler?.dispose();
      
      // Clean up document
      this._document?.dispose();
      
      // Exit runtime cleanly
      this._runtime?.exit(0);
      
    } catch (error) {
      console.error('Error during TTYWindow disposal:', error);
    }
  }

  /**
   * Alias for dispose() to match Disposable interface
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  // === Private Implementation ===

  private _setupRuntimeEventHandling(): void {
    // Handle terminal resize
    this._runtime.addEventListener('resize', (event: CustomEvent<TTYDimensions>) => {
      const { columns, rows } = event.detail;
      
      // Update HappyDOM window size
      (this as any)._width = columns;
      (this as any)._height = rows;
      
      // Dispatch resize event
      const resizeEvent = new Event('resize');
      this.dispatchEvent(resizeEvent);
    });

    // Handle interrupt (Ctrl+C)
    this._runtime.addEventListener('interrupt', () => {
      // Create beforeunload event for graceful shutdown
      const beforeUnloadEvent = new Event('beforeunload');
      const shouldExit = !this.dispatchEvent(beforeUnloadEvent);
      
      if (shouldExit) {
        this.dispose();
      }
    });

    // Handle terminate signals
    this._runtime.addEventListener('terminate', () => {
      this.dispose();
    });

    // Handle terminal disconnect
    this._runtime.addEventListener('hangup', () => {
      this.dispose();
    });

    // Handle keypresses
    this._runtime.addEventListener('keypress', (event: CustomEvent) => {
      this._keyboardHandler.handleKeyEvent(event.detail);
    });

    // Handle mouse events
    this._runtime.addEventListener('mouse', (event: CustomEvent) => {
      this._mouseHandler.handleMouseEvent(event.detail);
    });
  }

  private _setupDefaultBehavior(): void {
    // Default Ctrl+C behavior - exit gracefully
    this.addEventListener('beforeunload', () => {
      // Allow graceful cleanup
      return true;
    });

    // Handle document render requests
    this._document.addEventListener('tty:needsRender', () => {
      // Trigger re-render
      this._requestRender();
    });
  }

  private _setupCleanupHandlers(): void {
    // Ensure cleanup on various exit conditions
    this._runtime.onUncaughtException((error) => {
      console.error('Uncaught exception in TTY application:', error);
      this.dispose();
    });

    this._runtime.onUnhandledRejection((reason) => {
      console.error('Unhandled promise rejection in TTY application:', reason);
      // Don't exit on unhandled rejection, just log it
    });
  }

  private async _enterFullscreenMode(): Promise<void> {
    // Enable raw mode for fullscreen interaction
    this._runtime.setRawMode(true);
    this._runtime.enableMouseTracking();
    await this._runtime.hideCursor();
    await this._runtime.clearScreen();
  }

  private async _exitFullscreenMode(): Promise<void> {
    // Restore normal mode
    await this._runtime.showCursor();
    this._runtime.disableMouseTracking();
    this._runtime.setRawMode(false);
  }

  private _requestRender(): void {
    // This will be implemented when we integrate with the renderer
    // For now, just schedule a microtask
    queueMicrotask(() => {
      // Trigger render cycle
      this._document.render();
    });
  }
}