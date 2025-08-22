/**
 * TOMWindow - Main orchestrator for Terminal Object Model
 *
 * Acts as the window-like interface for TOM applications, coordinating
 * between the document, viewport, event handling, and rendering systems.
 * Provides standard DOM APIs like innerWidth/Height, scroll methods, and events.
 */

import { Window } from 'happy-dom';
import { TOMDocument, TOMDocumentOptions } from './TOMDocument.js';
import { TOMViewport, ViewportOptions } from './TOMViewport.js';
import { TOMMouseHandler } from './TOMMouseHandler.js';
import { TOMKeyboardHandler } from './TOMKeyboardHandler.js';
import { TerminalInterface, ProcessTerminal } from './TerminalInterface.js';

export interface TOMWindowOptions {
  terminal?: TerminalInterface;
  output?: NodeJS.WriteStream;  // Deprecated, use terminal
  width?: number;
  height?: number;
  viewport?: ViewportOptions;
}

export type ViewportMode = 'flow' | 'fullscreen';

// TODO: can we make this extend Window?
/**
 * TOMWindow serves as the main entry point and orchestrator for TOM applications.
 * It implements window-like APIs and coordinates between all TOM subsystems.
 */
export class TOMWindow implements Disposable {
  private _document: TOMDocument;
  private _viewport: TOMViewport | null = null;
  private _mouseHandler: TOMMouseHandler;
  private _keyboardHandler: TOMKeyboardHandler;
  private _terminal: TerminalInterface;
  private _mode: ViewportMode = 'flow';
  private _isExiting = false;
  private _fullscreenElement: Element | null = null;

  constructor(options: TOMWindowOptions = {}) {
    // Set up terminal interface
    if (options.terminal) {
      this._terminal = options.terminal;
    } else if (options.output) {
      this._terminal = new ProcessTerminal(options.output, process.stdin);
    } else {
      this._terminal = new ProcessTerminal();
    }

    // Create document with terminal interface (without input management)
    this._document = new TOMDocument({
      terminal: this._terminal,
      width: options.width,
      height: options.height,
      viewport: options.viewport
    });

    // Set reference so TOMElements can find their window
    (this._document.document as any)._tomDocument = this._document;
    (this._document as any)._tomWindow = this;

    // Set up viewport if specified
    if (options.viewport) {
      const dimensions = this._terminal.getDimensions();
      this._viewport = new TOMViewport({
        width: options.width ?? dimensions.columns,
        height: options.height ?? dimensions.rows,
        ...options.viewport
      });
    }

    // Create event handlers (managed by TOMWindow)
    this._mouseHandler = new TOMMouseHandler(this._document, this._terminal);
    this._keyboardHandler = new TOMKeyboardHandler(this._document, this._terminal);

    this.setupEventHandling();
    this.setupExitHandlers();
  }

  /**
   * Window-like properties for terminal dimensions
   */
  get innerWidth(): number {
    return this._terminal.getDimensions().columns;
  }

  get innerHeight(): number {
    return this._terminal.getDimensions().rows;
  }

  /**
   * Scroll position (delegates to viewport or document)
   */
  get scrollX(): number {
    return this._viewport?.getDocument().scrollLeft ?? 0;
  }

  get scrollY(): number {
    return this._viewport?.getDocument().scrollTop ?? 0;
  }

  /**
   * Access to document (main content tree)
   */
  get document(): TOMDocument {
    return this._document;
  }

  /**
   * Quick access to document.body (for convenience)
   */
  get body(): Element {
    return this._document.body;
  }

  /**
   * Current viewport mode
   */
  get mode(): ViewportMode {
    return this._mode;
  }

  /**
   * Currently fullscreen element (null if in flow mode)
   */
  get fullscreenElement(): Element | null {
    return this._fullscreenElement;
  }

  /**
   * Whether fullscreen is supported (always true in TOM)
   */
  get fullscreenEnabled(): boolean {
    return true;
  }

  /**
   * Scroll the viewport (window-level scrolling)
   */
  scroll(x: number, y: number): void {
    if (this._viewport) {
      this._viewport.scrollTo(x, y);
      this.dispatchEvent(new this._document.window.CustomEvent('scroll'));
    }
  }

  /**
   * Scroll by delta amounts
   */
  scrollBy(deltaX: number, deltaY: number): void {
    if (this._viewport) {
      this._viewport.scroll(deltaX, deltaY);
      this.dispatchEvent(new this._document.window.CustomEvent('scroll'));
    }
  }

  /**
   * Scroll to specific coordinates
   */
  scrollTo(x: number, y: number): void {
    this.scroll(x, y);
  }

  /**
   * Enter fullscreen mode for a specific element
   */
  async requestFullscreen(element: Element): Promise<void> {
    if (this._mode === 'fullscreen') {
      throw new Error('Already in fullscreen mode');
    }

    const oldMode = this._mode;
    this._mode = 'fullscreen';
    this._fullscreenElement = element;

    try {
      // Transition to fullscreen mode
      await this.transitionToFullscreen();

      // Dispatch fullscreen change event
      const changeEvent = new this._document.window.CustomEvent('fullscreenchange', {
        bubbles: true,
        cancelable: false
      });
      this._document.dispatchEvent(changeEvent);

    } catch (error) {
      // Revert on error
      this._mode = oldMode;
      this._fullscreenElement = null;

      const errorEvent = new this._document.window.CustomEvent('fullscreenerror', {
        bubbles: true,
        cancelable: false
      });
      this._document.dispatchEvent(errorEvent);

      throw error;
    }
  }

  /**
   * Exit fullscreen mode back to flow mode
   */
  async exitFullscreen(): Promise<void> {
    if (this._mode !== 'fullscreen') {
      return; // Already in flow mode
    }

    this._mode = 'flow';
    this._fullscreenElement = null;

    try {
      // Transition to flow mode
      await this.transitionToFlow();

      // Dispatch fullscreen change event
      const changeEvent = new this._document.window.CustomEvent('fullscreenchange', {
        bubbles: true,
        cancelable: false
      });
      this._document.dispatchEvent(changeEvent);

    } catch (error) {
      const errorEvent = new this._document.window.CustomEvent('fullscreenerror', {
        bubbles: true,
        cancelable: false
      });
      this._document.dispatchEvent(errorEvent);

      throw error;
    }
  }

  /**
   * Delegate event methods to document
   */
  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    this._document.addEventListener(type, listener, options);
  }

  removeEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    this._document.removeEventListener(type, listener, options);
  }

  dispatchEvent(event: Event): boolean {
    return this._document.dispatchEvent(event);
  }

  /**
   * Delegate DOM methods to document
   */
  createElement(tagName: string): Element {
    return this._document.createElement(tagName);
  }

  createTextNode(data: string): Text {
    return this._document.createTextNode(data);
  }

  querySelector(selectors: string): Element | null {
    return this._document.querySelector(selectors);
  }

  querySelectorAll(selectors: string): NodeList {
    return this._document.querySelectorAll(selectors);
  }

  getElementById(id: string): Element | null {
    return this._document.getElementById(id);
  }

  /**
   * Trigger a render
   */
  render(): void {
    this._document.render();
  }

  /**
   * Set up event handling coordination
   */
  private setupEventHandling(): void {
    // Enable mouse and keyboard handlers
    this._mouseHandler.enable();
    this._keyboardHandler.enable();

    // Set up terminal input coordination
    if (this._terminal.on) {
      this._terminal.on('data', (data: Buffer) => {
        const input = data.toString();

        // Try mouse input first
        const mouseHandled = this._mouseHandler.handleMouseInput(input);

        // If not mouse input, try keyboard
        if (!mouseHandled) {
          this._keyboardHandler.handleKeyboardInput(input);
        }
      });

      // Handle terminal resize events
      this._terminal.on('resize', () => {
        this.handleResize();
      });
    }
  }

  /**
   * Handle terminal resize
   */
  private handleResize(): void {
    const dimensions = this._terminal.getDimensions();

    // Update viewport if present
    if (this._viewport) {
      this._viewport.handleResize(dimensions.columns, dimensions.rows);
    }

    // Notify document
    this._document.handleResize(dimensions.columns, dimensions.rows);

    // Dispatch resize event
    const resizeEvent = new this._document.window.CustomEvent('resize', {
      detail: { width: dimensions.columns, height: dimensions.rows }
    });
    this.dispatchEvent(resizeEvent);
  }

  /**
   * Transition to fullscreen mode
   */
  private async transitionToFullscreen(): Promise<void> {
    // Set up fullscreen viewport to take over entire terminal
    const dimensions = this._terminal.getDimensions();

    if (!this._viewport) {
      this._viewport = new TOMViewport({
        width: dimensions.columns,
        height: dimensions.rows,
        overflow: 'hidden',
        position: 'fixed'
      });
    } else {
      // Update existing viewport for fullscreen
      this._viewport.handleResize(dimensions.columns, dimensions.rows);
    }

    // Clear screen and position cursor at top-left
    this._terminal.write('\x1b[2J\x1b[H');

    // Force immediate render in fullscreen mode
    this._document.render();
  }

  /**
   * Transition to flow mode
   */
  private async transitionToFlow(): Promise<void> {
    // Preserve final state as static terminal output
    this.preserveFinalState();

    // If we have a viewport, update it for flow mode
    if (this._viewport) {
      const dimensions = this._terminal.getDimensions();

      // Create new flow viewport that doesn't take over the terminal
      this._viewport = new TOMViewport({
        width: dimensions.columns,
        height: 'auto',
        overflow: 'visible',
        position: 'relative'
      });
    }

    // Position cursor at bottom for next command
    const dimensions = this._terminal.getDimensions();
    this._terminal.write(`\x1b[${dimensions.rows};1H\n`);
  }

  /**
   * Set up process exit handlers
   */
  private setupExitHandlers(): void {
    process.on('exit', () => {
      if (!this._isExiting) {
        this.cleanup();
      }
    });

    process.on('SIGTERM', () => {
      if (!this._isExiting) {
        const dimensions = this._terminal.getDimensions();
        this._terminal.write(`\x1b[${dimensions.rows};1H\n📡 Received SIGTERM, gracefully exiting...\n`);
        this.destroy();
        process.exit(0);
      }
    });

    process.on('SIGINT', () => {
      if (!this._isExiting) {
        const dimensions = this._terminal.getDimensions();
        this._terminal.write(`\x1b[${dimensions.rows};1H\n📡 Received SIGINT (backup handler), gracefully exiting...\n`);
        this.destroy();
        process.exit(0);
      }
    });

    process.on('uncaughtException', (error) => {
      console.error('💥 Uncaught exception:', error);
      if (!this._isExiting) {
        this.cleanup();
        process.exit(1);
      }
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('💥 Unhandled promise rejection at:', promise, 'reason:', reason);
      if (!this._isExiting) {
        this.cleanup();
        process.exit(1);
      }
    });
  }

  /**
   * Clean up terminal state
   */
  private cleanup(): void {
    if (this._isExiting) return;
    this._isExiting = true;

    try {
      // Disable handlers first
      this._mouseHandler?.disable();
      this._keyboardHandler?.disable();

      // Clean up document
      this._document?.cleanup();

      // Reset terminal state
      this.resetTerminalState();

    } catch (error) {
      console.warn('TOMWindow cleanup error:', error);
      this.emergencyTerminalReset();
    }
  }

  /**
   * Reset terminal to clean state while preserving final UI as static output
   */
  private resetTerminalState(): void {
    try {
      // Perform final render to preserve the last UI state as terminal output
      this.preserveFinalState();

      // Show cursor
      this._terminal.write('\x1b[?25h');

      // Reset all mouse modes (comprehensive)
      this._terminal.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l');

      // Reset colors and attributes
      this._terminal.write('\x1b[0m');

      // Position cursor at bottom of terminal for next command
      const dimensions = this._terminal.getDimensions();
      this._terminal.write(`\x1b[${dimensions.rows};1H`);

      // Reset character set
      this._terminal.write('\x1b(B');
    } catch (error) {
      console.warn('Failed to reset terminal state:', error);
    }
  }

  /**
   * Preserve the final UI state as static terminal output
   */
  private preserveFinalState(): void {
    try {
      // Render one final time to ensure we have the latest state
      this._document.render();

      // The rendered content is already on screen as interactive UI
      // We just need to "commit" it as static output by:
      // 1. Disabling interactive features (mouse tracking, etc.)
      // 2. Positioning cursor appropriately
      // 3. The content remains visible as if it were regular terminal output

      // This approach leaves the final UI visible in terminal history,
      // making TOM apps feel integrated with the terminal workflow
    } catch (error) {
      console.warn('Failed to preserve final state:', error);
    }
  }

  /**
   * Emergency terminal reset if normal cleanup fails
   */
  private emergencyTerminalReset(): void {
    try {
      // Try to use the terminal interface first, fallback to process.stdout only if needed
      if (this._terminal && typeof this._terminal.write === 'function') {
        this._terminal.write('\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m');
      } else {
        // Last resort fallback for environments where terminal interface is not available
        process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m');
      }
    } catch (error) {
      console.warn('Emergency reset also failed:', error);
    }
  }

  /**
   * Destroy the window and all associated resources
   */
  destroy(): void {
    this.cleanup();
    this._document?.destroy();
  }

  /**
   * Symbol.dispose implementation for automatic cleanup
   */
  [Symbol.dispose](): void {
    this.destroy();
  }
}
