/**
 * TOMDocument - HappyDOM integration for terminal UIs
 *
 * Provides a DOM-like API for terminal applications using HappyDOM's
 * tree structure and event system, with custom terminal rendering.
 */

import { Window } from 'happy-dom';
// @ts-ignore - NodeFactory not exported from main module
import NodeFactory from 'happy-dom/lib/nodes/NodeFactory.js';
// @ts-ignore - PropertySymbol not exported from main module
import * as PropertySymbol from 'happy-dom/lib/PropertySymbol.js';
import { TOMElement } from './TOMElement.js';
import { TOMRenderer } from './TOMRenderer.js';
import { TOMViewport, ViewportOptions } from './TOMViewport.js';
import { TOMContainer } from '../elements/TOMContainer.js';
import { TOMText } from '../elements/TOMText.js';
import { TOMButton } from '../elements/TOMButton.js';
import { TerminalInterface, ProcessTerminal } from './TerminalInterface.js';

export interface TOMDocumentOptions {
  terminal?: TerminalInterface;
  output?: NodeJS.WriteStream;  // Deprecated, use terminal
  width?: number;
  height?: number;
  viewport?: ViewportOptions;
}

// TODO: can we make this extend Document?
/**
 * TOMDocument manages the DOM tree and coordinates with HappyDOM
 * Implements Disposable for automatic resource cleanup with `using` statements
 */
export class TOMDocument implements Disposable {
  private _window: Window;
  private elementRegistry: Map<string, typeof TOMElement>;
  private renderer: TOMRenderer;
  private viewport: TOMViewport | null = null;
  private observer: MutationObserver;
  private _terminalWidth: number;
  private _terminalHeight: number;
  private terminal: TerminalInterface;

  // Selection and focus management
  private _activeElement: TOMElement | null = null;
  private focusableElements: TOMElement[] = [];
  private cleanupHandlers: (() => void)[] = [];

  constructor(options: TOMDocumentOptions = {}) {
    // Accept either terminal interface or legacy output stream
    if (options.terminal) {
      this.terminal = options.terminal;
    } else if (options.output) {
      this.terminal = new ProcessTerminal(options.output, process.stdin);
    } else {
      this.terminal = new ProcessTerminal();
    }

    const dimensions = this.terminal.getDimensions();
    this._terminalWidth = options.width ?? dimensions.columns;
    this._terminalHeight = options.height ?? dimensions.rows;

    // Create HappyDOM window
    this._window = new Window({
      url: 'https://localhost:3000',
      width: this._terminalWidth,
      height: this._terminalHeight
    });

    this.elementRegistry = new Map();

    // Initialize viewport if specified
    if (options.viewport) {
      this.viewport = new TOMViewport({
        width: this._terminalWidth,
        height: this._terminalHeight,
        ...options.viewport
      });
    }

    this.renderer = new TOMRenderer(this, this.terminal);

    this.setupElementRegistry();
    this.setupCustomElementCreation();
    this.setupMutationObserver();
  }

  /**
   * Terminal dimensions
   */
  get terminalWidth(): number {
    return this._terminalWidth;
  }

  get terminalHeight(): number {
    return this._terminalHeight;
  }

  /**
   * Access to HappyDOM document
   */
  get document() {
    return this._window.document;
  }

  /**
   * Access to HappyDOM window
   */
  get window() {
    return this._window;
  }

  /**
   * Access to document body
   */
  get body() {
    return this._window.document.body;
  }


  /**
   * Access to viewport (if enabled)
   */
  get viewport() {
    return this.viewport;
  }

  /**
   * Access to terminal interface
   */
  get terminal() {
    return this.terminal;
  }

  /**
   * Register default TOM elements
   */
  private setupElementRegistry(): void {
    this.elementRegistry.set('container', TOMContainer);
    this.elementRegistry.set('text', TOMText);
    this.elementRegistry.set('button', TOMButton);
  }

  /**
   * Override HappyDOM's createElement to use our registry
   */
  private setupCustomElementCreation(): void {
    const originalCreateElement = this._window.document.createElement.bind(this._window.document);

    this._window.document.createElement = (tagName: string): Element => {
      const ElementClass = this.elementRegistry.get(tagName.toLowerCase());

      if (ElementClass) {
        // Use HappyDOM's NodeFactory to create the element with proper context
        const element = NodeFactory.createNode(this._window.document, ElementClass) as TOMElement;

        // Set the tag name properties like HappyDOM does for SVG elements
        (element as any)[PropertySymbol.tagName] = tagName.toUpperCase();
        (element as any)[PropertySymbol.localName] = tagName.toLowerCase();
        (element as any)[PropertySymbol.prefix] = null;

        // Initialize TOM-specific properties
        element.initializeTOM?.();

        return element;
      }

      // Fall back to default HappyDOM behavior for unknown elements
      return originalCreateElement(tagName);
    };
  }

  /**
   * Set up MutationObserver for automatic re-rendering
   */
  private setupMutationObserver(): void {
    this.observer = new this._window.MutationObserver((mutations) => {
      // Check if any mutations affect our TOM elements
      let needsRender = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          // Check added/removed nodes
          for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
            if (node instanceof TOMElement) {
              needsRender = true;
              break;
            }
          }
        } else if (mutation.type === 'attributes') {
          // Check if attribute change affects a TOM element
          if (mutation.target instanceof TOMElement) {
            needsRender = true;
          }
        } else if (mutation.type === 'characterData') {
          // Check if text change affects a TOM element
          if (mutation.target.parentNode instanceof TOMElement) {
            needsRender = true;
          }
        }

        if (needsRender) break;
      }

      if (needsRender) {
        this.renderer.scheduleRender();
      }
    });

    // Observe the entire document for changes
    this.observer.observe(this._window.document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true
    });
  }

  /**
   * Handle terminal resize (called by TOMWindow)
   */
  handleResize(width: number, height: number): void {
    this._terminalWidth = width;
    this._terminalHeight = height;

    // Update viewport if present
    if (this.viewport) {
      this.viewport.handleResize(width, height);
    }

    this.renderer.handleResize(width, height);
  }

  /**
   * DOM API: Create element
   */
  createElement(tagName: string): Element {
    return this._window.document.createElement(tagName);
  }

  /**
   * DOM API: Create text node
   */
  createTextNode(data: string): Text {
    return this._window.document.createTextNode(data);
  }

  /**
   * DOM API: Query selector
   */
  querySelector(selectors: string): Element | null {
    return this._window.document.querySelector(selectors);
  }

  /**
   * DOM API: Query selector all
   */
  querySelectorAll(selectors: string): NodeList {
    return this._window.document.querySelectorAll(selectors);
  }

  /**
   * DOM API: Get element by ID
   */
  getElementById(id: string): Element | null {
    return this._window.document.getElementById(id);
  }

  /**
   * DOM API: Add event listener
   */
  addEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    this._window.document.addEventListener(type, listener, options);
  }

  /**
   * DOM API: Remove event listener
   */
  removeEventListener(type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    this._window.document.removeEventListener(type, listener, options);
  }

  /**
   * DOM API: Dispatch event
   */
  dispatchEvent(event: Event): boolean {
    return this._window.document.dispatchEvent(event);
  }

  /**
   * Exit fullscreen mode (DOM API)
   */
  async exitFullscreen(): Promise<void> {
    const tomWindow = (this as any)._tomWindow;
    if (!tomWindow) {
      throw new Error('Document is not connected to a TOM window');
    }

    return tomWindow.exitFullscreen();
  }

  /**
   * Get the currently fullscreen element (DOM API)
   */
  get fullscreenElement(): Element | null {
    const tomWindow = (this as any)._tomWindow;
    return tomWindow?.fullscreenElement || null;
  }

  /**
   * Check if fullscreen is enabled (DOM API)
   */
  get fullscreenEnabled(): boolean {
    return true; // Always supported in TOM
  }


  /**
   * Force a render of the document
   */
  render(): void {
    this.renderer.render();
  }

  /**
   * Register a cleanup handler to be called when the document is destroyed
   * Best practice: Use this to save state, close connections, etc.
   */
  onCleanup(handler: () => void): void {
    this.cleanupHandlers.push(handler);
  }

  /**
   * Gracefully destroy the document and clean up resources
   */
  destroy(): void {
    if (this.isExiting) return; // Prevent double cleanup
    this.isExiting = true;

    try {
      // Dispatch beforeunload event for cleanup hooks
      const beforeUnloadEvent = new this._window.Event('beforeunload', { cancelable: true });
      this._window.document.dispatchEvent(beforeUnloadEvent);

      // Clean up handlers
      if (this.mouseHandler) {
        this.mouseHandler.disable();
      }
      if (this.keyboardHandler) {
        this.keyboardHandler.disable();
      }

      // Clean up terminal state
      this.cleanup();

      // Destroy renderer
      if (this.renderer && typeof this.renderer.destroy === 'function') {
        this.renderer.destroy();
      }

      // Disconnect mutation observer
      if (this.observer) {
        this.observer.disconnect();
      }

      // Run custom cleanup handlers
      for (const handler of this.cleanupHandlers) {
        try {
          handler();
        } catch (error) {
          console.warn('Cleanup handler error:', error);
        }
      }

    } catch (error) {
      console.warn('Error during TOM cleanup:', error);
    }
  }

  /**
   * Register a custom element type
   */
  registerElement(tagName: string, elementClass: typeof TOMElement): void {
    this.elementRegistry.set(tagName.toLowerCase(), elementClass);
  }


  /**
   * Register a cleanup handler to run on document unload
   */
  registerCleanupHandler(handler: () => void): void {
    this.cleanupHandlers.push(handler);
  }

  /**
   * Dispatch unload event and run cleanup
   */
  unload(): void {
    // Dispatch unload event to window
    const unloadEvent = new this._window.Event('unload', {
      bubbles: false,
      cancelable: false
    });
    this._window.dispatchEvent(unloadEvent);

    // Run all registered cleanup handlers
    for (const handler of this.cleanupHandlers) {
      try {
        handler();
      } catch (e) {
        console.error('Cleanup handler error:', e);
      }
    }

    // Clear handlers
    this.cleanupHandlers = [];

    // Do final cleanup
    this.cleanup();
  }

  /**
   * Clean up document resources (called by TOMWindow)
   */
  cleanup(): void {
    // Run custom cleanup handlers
    for (const handler of this.cleanupHandlers) {
      try {
        handler();
      } catch (error) {
        console.warn('Cleanup handler error:', error);
      }
    }
    this.cleanupHandlers = [];
  }

  /**
   * Symbol.dispose implementation for automatic resource management
   * This allows TOMDocument to be used with `using` statements for automatic cleanup
   */
  [Symbol.dispose](): void {
    this.destroy();
  }


  /**
   * Get the renderer instance (for advanced use cases)
   */
  getRenderer(): TOMRenderer {
    return this.renderer;
  }

  /**
   * Selection and focus management
   */
  get activeElement(): TOMElement | null {
    return this._activeElement;
  }

  /**
   * Set the active (focused) element
   */
  setActiveElement(element: TOMElement | null): void {
    if (this._activeElement === element) return;

    // Blur current active element
    if (this._activeElement) {
      const blurEvent = new this._window.FocusEvent('blur', {
        bubbles: true,
        relatedTarget: element
      });
      this._activeElement.dispatchEvent(blurEvent);
      this._activeElement.tomSetFocused(false);
    }

    this._activeElement = element;

    // Focus new active element
    if (element) {
      const focusEvent = new this._window.FocusEvent('focus', {
        bubbles: true,
        relatedTarget: this._activeElement
      });
      element.dispatchEvent(focusEvent);
      element.tomSetFocused(true);
    }

    // Trigger re-render to show focus changes
    this.render();
  }

  /**
   * Navigate to next focusable element
   */
  focusNext(): void {
    this.updateFocusableElements();

    if (this.focusableElements.length === 0) return;

    const currentIndex = this._activeElement ?
      this.focusableElements.indexOf(this._activeElement) : -1;

    const nextIndex = (currentIndex + 1) % this.focusableElements.length;
    this.setActiveElement(this.focusableElements[nextIndex]);
  }

  /**
   * Navigate to previous focusable element
   */
  focusPrevious(): void {
    this.updateFocusableElements();

    if (this.focusableElements.length === 0) return;

    const currentIndex = this._activeElement ?
      this.focusableElements.indexOf(this._activeElement) : -1;

    const prevIndex = currentIndex <= 0 ?
      this.focusableElements.length - 1 : currentIndex - 1;
    this.setActiveElement(this.focusableElements[prevIndex]);
  }

  /**
   * Update the list of focusable elements
   */
  private updateFocusableElements(): void {
    this.focusableElements = [];
    this.collectFocusableElements(this.body);
  }

  /**
   * Recursively collect focusable elements
   */
  private collectFocusableElements(element: Element): void {
    if (element instanceof TOMElement && element.tomIsFocusable()) {
      this.focusableElements.push(element);
    }

    for (const child of element.children) {
      this.collectFocusableElements(child);
    }
  }


}
