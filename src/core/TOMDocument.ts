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
import { TOMMouseHandler } from './TOMMouseHandler.js';
import { TOMContainer } from '../elements/TOMContainer.js';
import { TOMText } from '../elements/TOMText.js';
import { TOMButton } from '../elements/TOMButton.js';

export interface TOMDocumentOptions {
  output?: NodeJS.WriteStream;
  width?: number;
  height?: number;
}

/**
 * TOMDocument manages the DOM tree and coordinates with HappyDOM
 */
export class TOMDocument {
  private _window: Window;
  private elementRegistry: Map<string, typeof TOMElement>;
  private renderer: TOMRenderer;
  private mouseHandler: TOMMouseHandler;
  private observer: MutationObserver;
  private _terminalWidth: number;
  private _terminalHeight: number;
  private output: NodeJS.WriteStream;
  
  // Selection and focus management
  private _activeElement: TOMElement | null = null;
  private focusableElements: TOMElement[] = [];
  private inputMode = false;
  private mouseEnabled = false;
  private isExiting = false;
  private cleanupHandlers: (() => void)[] = [];

  constructor(options: TOMDocumentOptions = {}) {
    this.output = options.output ?? process.stdout;
    this._terminalWidth = options.width ?? this.output.columns ?? 80;
    this._terminalHeight = options.height ?? this.output.rows ?? 24;
    
    // Create HappyDOM window
    this._window = new Window({
      url: 'https://localhost:3000',
      width: this._terminalWidth,
      height: this._terminalHeight
    });

    this.elementRegistry = new Map();
    this.renderer = new TOMRenderer(this, this.output);
    this.mouseHandler = new TOMMouseHandler(this);
    
    this.setupElementRegistry();
    this.setupCustomElementCreation();
    this.setupMutationObserver();
    this.setupTerminalSizeTracking();
    this.setupExitHandlers();
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
   * Track terminal size changes
   */
  private setupTerminalSizeTracking(): void {
    if (this.output === process.stdout) {
      process.stdout.on('resize', () => {
        this._terminalWidth = process.stdout.columns ?? 80;
        this._terminalHeight = process.stdout.rows ?? 24;
        this.renderer.handleResize(this._terminalWidth, this._terminalHeight);
      });
    }
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
  removeEventListener(type: string, listener: EventListener, options?: boolean | EventListenerOptions): void {
    this._window.document.removeEventListener(type, listener, options);
  }

  /**
   * Force a render of the document
   */
  render(): void {
    this.renderer.render();
  }

  /**
   * Register a custom element type
   */
  registerElement(tagName: string, elementClass: typeof TOMElement): void {
    this.elementRegistry.set(tagName.toLowerCase(), elementClass);
  }

  /**
   * Set up process exit handlers
   */
  private setupExitHandlers(): void {
    process.on('exit', () => this.cleanup());
    process.on('SIGINT', () => this.handleExit());
    process.on('SIGTERM', () => this.handleExit());
    process.on('uncaughtException', (err) => {
      console.error('Uncaught exception:', err);
      this.handleExit();
    });
  }

  /**
   * Handle process exit
   */
  private handleExit(): void {
    if (!this.isExiting) {
      this.isExiting = true;
      this.unload();
      process.exit(0);
    }
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
   * Clean up terminal state
   */
  private cleanup(): void {
    // Disable mouse tracking first (most important)
    if (this.mouseEnabled) {
      this.disableMouse();
    }
    
    // Disable input mode
    if (this.inputMode) {
      this.disableInputMode();
    }
    
    // Show cursor
    this.output.write('\x1b[?25h');
    
    // Reset all mouse modes (belt and suspenders)
    this.output.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    
    // Move cursor to bottom of screen
    if (this.output === process.stdout) {
      this.output.write(`\x1b[${process.stdout.rows};1H`);
    }
    
    // Ensure output is flushed
    if (this.output.write('')) {
      // Already flushed
    } else {
      this.output.once('drain', () => {});
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.unload();
    this.observer.disconnect();
    this.renderer.destroy();
    this._window.close();
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

  /**
   * Enable input mode for keyboard handling
   */
  enableInputMode(): void {
    if (this.inputMode) return;
    
    this.inputMode = true;
    
    // Set up raw mode if available (Bun might not support this)
    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      // Don't set encoding for mouse data - handle raw buffers
      process.stdin.on('data', (data: Buffer | string) => {
        const str = typeof data === 'string' ? data : data.toString('utf8');
        this.handleInput(str);
      });
    } catch (error) {
      console.warn('Could not enable raw input mode:', error);
    }
  }

  /**
   * Disable input mode
   */
  disableInputMode(): void {
    if (!this.inputMode) return;
    
    this.inputMode = false;
    
    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      
      process.stdin.removeAllListeners('data');
    } catch (error) {
      console.warn('Could not disable raw input mode:', error);
    }
  }

  /**
   * Enable mouse support
   */
  enableMouse(): void {
    if (this.mouseEnabled) return;
    this.mouseEnabled = true;
    this.mouseHandler.enable();
  }

  /**
   * Disable mouse support
   */
  disableMouse(): void {
    if (!this.mouseEnabled) return;
    this.mouseEnabled = false;
    this.mouseHandler.disable();
  }

  /**
   * Handle all input (keyboard and mouse)
   */
  private handleInput(data: string): void {
    // Debug: log what we receive
    if (this.mouseEnabled && data.includes('\x1b[<')) {
      // Try to handle as mouse input
      if (this.mouseHandler.handleMouseInput(data)) {
        return;
      }
    }
    
    // Otherwise handle as keyboard input
    this.handleKeyInput(data);
  }

  /**
   * Handle keyboard input and dispatch events
   */
  private handleKeyInput(data: string): void {
    const byte = data.charCodeAt(0);
    
    // Create KeyboardEvent using HappyDOM
    let key = '';
    let code = '';
    let ctrlKey = false;
    let altKey = false;
    let shiftKey = false;

    // Parse common key combinations
    if (byte === 3) { // Ctrl+C
      key = 'c';
      code = 'KeyC';
      ctrlKey = true;
    } else if (byte === 13) { // Enter
      key = 'Enter';
      code = 'Enter';
    } else if (byte === 9) { // Tab
      key = 'Tab';
      code = 'Tab';
    } else if (byte === 27) { // Escape sequences (arrow keys, etc.)
      if (data === '\u001b[A') {
        key = 'ArrowUp';
        code = 'ArrowUp';
      } else if (data === '\u001b[B') {
        key = 'ArrowDown';
        code = 'ArrowDown';
      } else if (data === '\u001b[C') {
        key = 'ArrowRight';
        code = 'ArrowRight';
      } else if (data === '\u001b[D') {
        key = 'ArrowLeft';
        code = 'ArrowLeft';
      } else {
        key = 'Escape';
        code = 'Escape';
      }
    } else if (byte >= 32 && byte <= 126) { // Printable ASCII
      key = data;
      code = `Key${data.toUpperCase()}`;
    }

    // Create and dispatch KeyboardEvent
    try {
      const KeyboardEventClass = this._window.KeyboardEvent;
      const keyboardEvent = new KeyboardEventClass('keydown', {
        key,
        code,
        ctrlKey,
        altKey,
        shiftKey,
        bubbles: true
      });

      // Default navigation behavior
      if (key === 'ArrowDown' || key === 'Tab') {
        this.focusNext();
      } else if (key === 'ArrowUp') {
        this.focusPrevious();
      } else if (key === 'Enter' && this._activeElement) {
        // Dispatch click event on active element
        const clickEvent = new this._window.MouseEvent('click', {
          bubbles: true
        });
        this._activeElement.dispatchEvent(clickEvent);
      }

      // Dispatch to active element or document
      const target = this._activeElement || this.document;
      target.dispatchEvent(keyboardEvent);
    } catch (error) {
      console.warn('Error creating keyboard event:', error);
    }
  }
}