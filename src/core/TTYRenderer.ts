/**
 * TTYRenderer - Orchestrates layout calculation and terminal rendering
 * 
 * Coordinates between HappyDOM's tree structure, Yoga layout engine,
 * and ScreenBuffer rendering to efficiently update the terminal through TTYRuntime.
 */

import { HTMLElement } from '../dom.js';
import { TTYRuntime } from './TTYRuntime.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';
import { LayoutEngine } from '../layout/LayoutEngine.js';
import { YOGA_BOUNDS } from './HTMLExtensions.js';

export interface TTYMouseEvent {
  x: number;
  y: number;
  button: number;
  type: 'click' | 'mousedown' | 'mouseup' | 'mousemove';
}

export interface TTYKeyboardEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * TTYRenderer orchestrates the rendering pipeline using TTYRuntime
 */
export class TTYRenderer {
  private document: any; // TTYDocument reference
  private rootBuffer: ScreenBuffer;
  // private layoutEngine: LayoutEngine; // Temporarily disabled
  // private textBreaker: SimpleGreedyTextBreaker; // Temporarily disabled
  private renderScheduled = false;
  private destroyed = false;
  private runtime: TTYRuntime;
  

  constructor(document: any, runtime: TTYRuntime) {
    this.document = document;
    this.runtime = runtime;
    
    const dimensions = runtime.getTerminalSize();
    this.rootBuffer = new ScreenBuffer({
      width: dimensions.columns,
      height: dimensions.rows,
      runtime: runtime // Pass runtime to ScreenBuffer
    });
    
    // this.layoutEngine = new LayoutEngine(); // Temporarily disabled
    // this.textBreaker = new SimpleGreedyTextBreaker(); // Temporarily disabled
  }

  /**
   * Render the entire document to terminal
   */
  async render(): Promise<void> {
    if (this.destroyed) return;

    try {
      // Clear previous render
      this.rootBuffer.clear();
      
      // Get current terminal size (in case it changed)
      const dimensions = this.runtime.getTerminalSize();
      if (dimensions.columns !== this.rootBuffer.width || 
          dimensions.rows !== this.rootBuffer.height) {
        this.rootBuffer.resize(dimensions.columns, dimensions.rows);
      }

      // Render document body if it exists
      const body = this.document.body;
      if (body && body instanceof HTMLElement) {
        await this._renderElement(body, 0, 0);
      }

      // Flush buffer to terminal through runtime
      await this.rootBuffer.flush();
      
    } catch (error) {
      console.error('TTYRenderer: Error during render:', error);
    }
  }

  /**
   * Schedule a render for next tick
   */
  scheduleRender(): void {
    if (this.renderScheduled || this.destroyed) return;
    
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      this.render().catch(console.error);
    });
  }

  /**
   * Render a specific element and its children
   */
  private async _renderElement(element: HTMLElement, x: number, y: number): Promise<void> {
    // Get bounds from Yoga layout (if available)
    const bounds = element[YOGA_BOUNDS];
    if (!bounds) {
      // No layout computed yet, skip rendering
      return;
    }

    // Render using ScreenBuffer's compositeElement method
    this.rootBuffer.compositeElement(element);

    // Render children
    const children = Array.from(element.children) as HTMLElement[];
    for (const child of children) {
      if (child instanceof HTMLElement) {
        await this._renderElement(child, bounds.x, bounds.y);
      }
    }
  }

  /**
   * Handle mouse events from TTYRuntime
   */
  handleMouseEvent(event: TTYMouseEvent): void {
    // TODO: Implement mouse event handling
    // - Hit testing against element bounds
    // - Event dispatching to appropriate elements
    console.log('TTYRenderer: Mouse event:', event);
  }

  /**
   * Handle keyboard events from TTYRuntime
   */
  handleKeyboardEvent(event: TTYKeyboardEvent): void {
    // TODO: Implement keyboard event handling  
    // - Focus management
    // - Key event dispatching
    console.log('TTYRenderer: Keyboard event:', event);
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.destroyed = true;
    this.rootBuffer?.dispose();
    // this.layoutEngine?.dispose(); // Temporarily disabled
  }
}