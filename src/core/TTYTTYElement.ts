/**
 * TTYTTYElement - The root <tty> element that manages the entire TTY context
 * 
 * This is the main API surface for TTY applications. It manages:
 * - Terminal setup/teardown (raw mode, mouse tracking, signals)  
 * - Element creation within the TTY namespace
 * - Event handling and runtime management
 * - Automatic rendering via MutationObserver (setup externally)
 */

import { TTYElement } from './TTYElement.js';
import { TTYRuntime, detectTTYRuntime, type TTYDimensions } from './TTYRuntime.js';
import { TTYMouseHandler } from './TTYMouseHandler.js';
import { TTYKeyboardHandler } from './TTYKeyboardHandler.js';
import { TTYViewport, type ViewportOptions } from './TTYViewport.js';
// @ts-ignore - HappyDOM Event class for proper event creation
import Event from 'happy-dom/lib/event/Event.js';
// @ts-ignore - NodeFactory not exported from main module
import NodeFactory from 'happy-dom/lib/nodes/NodeFactory.js';
// @ts-ignore - PropertySymbol not exported from main module
import * as PropertySymbol from 'happy-dom/lib/PropertySymbol.js';

// Import element constructors
import { TTYContainerElement } from '../elements/TTYContainer.js';
import { TTYTextElement } from '../elements/TTYTextElement.js';

export interface TTYOptions {
  runtime?: TTYRuntime;
  width?: number;
  height?: number;
  viewport?: ViewportOptions;
}

export type ViewportMode = 'flow' | 'fullscreen';

/**
 * TTYTTYElement - The root <tty> element that contains all TTY functionality
 * 
 * This element acts like an <svg> element - it creates a contained namespace
 * where all TTY-specific elements live and provides the primary API surface.
 */
export class TTYTTYElement extends TTYElement implements Disposable {
  private _runtime: TTYRuntime;
  private _document: Document;
  private _viewport: TTYViewport | null = null;
  private _mouseHandler: TTYMouseHandler;
  private _keyboardHandler: TTYKeyboardHandler;
  private _mode: ViewportMode = 'flow';
  private _isExiting = false;
  private _fullscreenElement: Element | null = null;

  constructor() {
    super();
    
    // Will be initialized in initialize() method
    this._runtime = null as any;
    this._document = null as any;
    this._mouseHandler = null as any;
    this._keyboardHandler = null as any;
  }

  /**
   * Initialize the TTY element with runtime and document context
   * Called by createTTY() factory function
   */
  initialize(options: TTYOptions = {}, document: Document): void {
    this._document = document;
    
    // Auto-detect runtime if not provided
    this._runtime = options.runtime || detectTTYRuntime();
    
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

  // === Element Creation API ===

  /**
   * Create TTY elements using NodeFactory
   * This is the main element creation API for TTY applications
   */
  createElement(tagName: string): TTYElement {
    if (!this._document) {
      throw new Error('TTYTTYElement not properly initialized - call initialize() first');
    }

    const tagLower = tagName.toLowerCase();
    let elementClass: typeof TTYElement;

    // Select the appropriate element class based on tag name
    switch (tagLower) {
      case 'container':
      case 'div':
      case 'section':
      case 'article':
      case 'header':
      case 'footer':
      case 'main':
      case 'nav':
        elementClass = TTYContainerElement;
        break;
      
      case 'text':
      case 'span':
      case 'p':
        elementClass = TTYTextElement;
        break;
      
      default:
        // Generic TTY element for unknown tags
        elementClass = TTYElement;
        break;
    }

    // Create element using NodeFactory to avoid constructor restrictions
    const element = NodeFactory.createNode(this._document as any, elementClass);
    
    // Set up the element with proper DOM properties for HappyDOM compatibility (following Document.createElementNS pattern)
    element[PropertySymbol.tagName] = tagName.toUpperCase();
    element[PropertySymbol.localName] = tagName.toLowerCase(); 
    element[PropertySymbol.prefix] = null; // No prefix for simple tagNames
    element[PropertySymbol.namespaceURI] = null; // HTML namespace is null
    element[PropertySymbol.isValue] = null; // Not a custom element
    
    return element;
  }

  // === Window-like Properties ===

  /**
   * Get the TTY runtime instance
   */
  get runtime(): TTYRuntime {
    return this._runtime;
  }

  /**
   * Get computed styles for an element - convenience method like window.getComputedStyle
   */
  getComputedStyle(element: Element): CSSStyleDeclaration {
    const window = this._document.defaultView;
    if (!window) {
      throw new Error('No window available for getComputedStyle');
    }
    return window.getComputedStyle(element);
  }

  /**
   * Terminal dimensions (in characters)
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

  // === Viewport Management ===

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
  override async requestFullscreen(element?: Element): Promise<void> {
    if (this._mode !== 'fullscreen') {
      await this.setMode('fullscreen');
    }

    this._fullscreenElement = element || (this as unknown as Element);

    // Dispatch fullscreenchange event
    const event = new Event('fullscreenchange');
    this.dispatchEvent(event);
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
    this.dispatchEvent(event);
  }

  /**
   * Get the current fullscreen element
   */
  get fullscreenElement(): Element | null {
    return this._fullscreenElement;
  }

  /**
   * Scroll the viewport
   */
  override scrollTo(x: number, y: number): void {
    if (this._viewport) {
      this._viewport.scrollTo(x, y);
    }
  }

  override scrollBy(deltaX: number, deltaY: number): void {
    if (this._viewport) {
      this._viewport.scrollBy(deltaX, deltaY);
    }
  }

  // === Rendering API ===

  /**
   * Render the TTY content to the terminal
   * Called automatically by MutationObserver or manually by user
   */
  render(): void {
    // TODO: Implement full rendering pipeline
    // This will coordinate with TTYRenderer, ScreenBuffer, etc.
    console.log('TTYTTYElement.render() - rendering TTY tree');

    // For now, just trigger a simple render cycle
    this._renderElements();
  }

  /**
   * Simple element rendering (placeholder implementation)
   */
  private _renderElements(): void {
    // TODO: Walk the TTY element tree and render
    // This will be implemented when we have TTYRenderer ready

    if (this._runtime) {
      // Simple test - just write some content
      this._runtime.writeStdout('TTYTTYElement rendered!\\n').catch(console.error);
    }
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

      // Exit runtime cleanly
      this._runtime?.exit(0);

    } catch (error) {
      console.error('Error during TTYTTYElement disposal:', error);
    }
  }

  /**
   * Disposable interface implementation
   */
  [Symbol.dispose](): void {
    this.dispose();
  }

  // === Private Implementation ===

  private _setupRuntimeEventHandling(): void {
    // Handle terminal resize
    this._runtime.addEventListener('resize', ((event: CustomEvent<TTYDimensions>) => {
      const { columns, rows } = event.detail;

      // Dispatch resize event
      const resizeEvent = new Event('resize');
      this.dispatchEvent(resizeEvent);
    }) as EventListener);

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
    this._runtime.addEventListener('keypress', ((event: CustomEvent) => {
      this._keyboardHandler.handleKeyEvent(event.detail);
    }) as EventListener);

    // Handle mouse events
    this._runtime.addEventListener('mouse', ((event: CustomEvent) => {
      this._mouseHandler.handleMouseEvent(event.detail);
    }) as EventListener);
  }

  private _setupDefaultBehavior(): void {
    // Default Ctrl+C behavior - exit gracefully
    this.addEventListener('beforeunload', () => {
      // Allow graceful cleanup
      return true;
    });

    // TODO: Remove this when we implement MutationObserver-based rendering
    // Handle render requests (temporary)
    this.addEventListener('tty:needsRender', () => {
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
    // This will be replaced by MutationObserver-based rendering
    // For now, just schedule a microtask
    queueMicrotask(() => {
      this.render();
    });
  }
}