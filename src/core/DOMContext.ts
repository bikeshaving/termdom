/**
 * DOMContext - Isolated JSDOM instance for each TTY
 * 
 * Provides isolated DOM environment for each createTTY() call to ensure
 * proper test isolation and prevent state leakage between instances.
 * 
 * Each DOMContext wraps a JSDOM instance and exposes all DOM classes
 * and constructors from that specific instance.
 */

import { JSDOM } from 'jsdom';
import type { DOMWindow } from 'jsdom';

export class DOMContext {
  private jsdom: JSDOM;
  
  // Core DOM objects - just the isolated instances, use JSDOM's DOMWindow type
  public readonly window: DOMWindow;
  public readonly document: Document;

  constructor() {
    // Create fresh JSDOM instance for this context
    this.jsdom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      // Configure JSDOM for terminal use
      pretendToBeVisual: true,
      resources: 'usable'
    });
    
    // Extract window and document - JSDOM implements the standard DOM interfaces
    this.window = this.jsdom.window;
    this.document = this.window.document;
  }
  
  /**
   * Clean up this DOM context
   */
  dispose(): void {
    // Close the JSDOM window to free resources
    this.window.close();
  }
  
  /**
   * Get a fresh document with clean state
   */
  resetDocument(): void {
    this.document.documentElement.innerHTML = '<head></head><body></body>';
  }
}