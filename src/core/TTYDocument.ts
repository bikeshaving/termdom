/**
 * TTYDocument - HappyDOM Document extension for TTY applications
 * 
 * Extends HappyDOM's Document class using the proper NodeFactory pattern
 * to bypass constructor restrictions and provide TTY-specific functionality.
 */

import { Document, Window } from 'happy-dom';
// @ts-ignore - NodeFactory not exported from main module
import NodeFactory from 'happy-dom/lib/nodes/NodeFactory.js';
// @ts-ignore - PropertySymbol not exported from main module
import * as PropertySymbol from 'happy-dom/lib/PropertySymbol.js';
import { TTYRuntime } from './TTYRuntime.js';
import { TTYElement } from './TTYElement.js';
import { TTYTextElement } from '../elements/TTYTextElement.js';

export interface TTYDocumentOptions {
  window?: any; // TTYWindow instance
}

/**
 * TTYDocument extends HappyDOM's Document with TTY-specific functionality
 * Uses NodeFactory.createNode() to bypass HappyDOM's constructor restrictions
 */
export class TTYDocument extends Document {
  private _ttyWindow: any;
  private _ttyRuntime?: TTYRuntime;

  constructor(options: TTYDocumentOptions = {}) {
    // This constructor should never be called directly!
    // Use TTYDocument.create() instead
    super();
    this._ttyWindow = options.window;
  }

  /**
   * Static factory method to properly create TTYDocument instances
   * Uses HappyDOM's internal mechanism to bypass constructor restrictions
   */
  static create(window: Window, ttyWindow?: any): TTYDocument {
    // Create a class that has the window symbol set on the prototype
    class WindowedTTYDocument extends TTYDocument {
      constructor() {
        super({ window: ttyWindow });
        
        // Set up HappyDOM internal properties after super()
        this[PropertySymbol.window] = window;
        this[PropertySymbol.ownerDocument] = this; // Documents own themselves
        this._ttyWindow = ttyWindow;
        if (ttyWindow && ttyWindow.runtime) {
          this._ttyRuntime = ttyWindow.runtime;
        }
      }
    }

    // Set the window symbol on the prototype to satisfy HappyDOM's check
    WindowedTTYDocument.prototype[PropertySymbol.window] = window;

    const doc = new WindowedTTYDocument();
    doc._initializeHTMLStructure();
    return doc;
  }

  /**
   * Get the associated TTYWindow
   */
  get ttyWindow(): any {
    return this._ttyWindow;
  }

  /**
   * Get the TTYRuntime instance
   */
  get runtime(): TTYRuntime | undefined {
    return this._ttyRuntime;
  }

  /**
   * Initialize proper HTML structure for HappyDOM compatibility
   * Creates <html> and <body> elements so document.body works
   */
  private _initializeHTMLStructure(): void {
    // Only create structure if it doesn't already exist
    if (!this.documentElement) {
      // Create <html> element
      const html = this.createElement('html');
      this.appendChild(html);
      
      // Create <body> element inside <html>
      const body = this.createElement('body');
      html.appendChild(body);
    }
  }

  /**
   * Override createElement to return TTYElement instances or subtypes
   * This ensures all elements created have TTY-specific functionality
   */
  createElement(tagName: string): TTYElement {
    const tagLower = tagName.toLowerCase();
    let elementClass: typeof TTYElement;
    
    // Select the appropriate element class based on tag name
    switch (tagLower) {
      case 'text':
        elementClass = TTYTextElement;
        break;
      case 'input':
      case 'button':
      case 'textarea':
        // These could have specific implementations in the future
        // For now, use base TTYElement
        elementClass = TTYElement;
        break;
      default:
        // Generic container elements
        elementClass = TTYElement;
        break;
    }
    
    // Use NodeFactory to create the element properly to avoid constructor restrictions
    const element = <TTYElement>NodeFactory.createNode(this, elementClass);
    
    // Set up the element with proper tag name
    element[PropertySymbol.tagName] = tagName.toUpperCase();
    
    return element;
  }

  /**
   * Enhanced addEventListener that can route TTY-specific events
   */
  addEventListener(
    type: string, 
    listener: EventListenerOrEventListenerObject, 
    options?: boolean | AddEventListenerOptions
  ): void {
    // Route TTY-specific events through TTYWindow if available
    if (type.startsWith('tty:') && this._ttyWindow) {
      this._ttyWindow.addEventListener(type, listener, options);
      return;
    }
    
    // Use normal HappyDOM event handling
    super.addEventListener(type, listener, options);
  }

  /**
   * Render the document to the terminal
   * This is called by TTYWindow when the document needs to be rendered
   */
  render(): void {
    // TODO: Implement full rendering pipeline
    // This will coordinate with TTYRenderer, ScreenBuffer, etc.
    console.log('TTYDocument.render() - rendering document tree');
    
    // For now, just trigger a simple render cycle
    this._renderElements();
  }

  /**
   * Simple element rendering (placeholder implementation)
   */
  private _renderElements(): void {
    // TODO: Walk the document tree and render TTY elements
    // This will be implemented when we have TTYElement and TTYRenderer ready
    
    if (this.body && this._ttyRuntime) {
      // Simple test - just write some content
      this._ttyRuntime.writeStdout('TTYDocument rendered!\n').catch(console.error);
    }
  }

  /**
   * Clean up TTY-specific resources
   */
  dispose(): void {
    // Clean up any TTY-specific resources
    this._ttyWindow = null;
    this._ttyRuntime = undefined;
    
    // Note: We don't dispose the HappyDOM document itself since
    // it's managed by the Window lifecycle
  }

  /**
   * Disposable interface implementation
   */
  [Symbol.dispose](): void {
    this.dispose();
  }
}