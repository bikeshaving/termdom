/**
 * DirectBuffer - Virtual scrollback buffer implementation extending DirectTTYRenderer
 * 
 * This implements the fully virtual scrollback model described in SCROLLBACK.md:
 * - Virtual buffer holds ALL content (can exceed terminal height)
 * - Viewport window into virtual buffer
 * - All content remains mutable at any time
 * - Efficient ANSI delta generation
 */

import { DirectTTYRenderer, type DirectTTYRendererOptions } from './DirectTTYRenderer.js';
import type { DOMWindow } from 'jsdom';
import { Attributes, FgFlags, BgFlags } from '../../vendor/xterm.js/src/common/buffer/Constants.js';

interface ViewportWindow {
  scrollOffset: number;  // Top line of virtual buffer visible in terminal
  height: number;        // Terminal rows  
  width: number;         // Terminal columns
}

interface DirectBufferOptions extends DirectTTYRendererOptions {
  scrollback?: number;   // Maximum virtual scrollback lines
}

// Virtual buffer cell (extends DirectTTYRenderer's Cell)
interface VirtualCell {
  char: string;
  fg: number;  // Packed xterm.js format
  bg: number;  // Packed xterm.js format
}

/**
 * DirectBuffer provides a fully virtual scrollback buffer for TTY rendering
 */
export class DirectBuffer extends DirectTTYRenderer {
  // Virtual buffer that can grow beyond viewport
  private virtualBuffer: VirtualCell[][];
  private maxScrollback: number;
  
  // Viewport into virtual buffer
  private viewport: ViewportWindow;
  
  // Current rendering mode
  private renderMode: 'anchored' | 'managed';
  
  // Command start tracking for anchored mode
  private commandStartRow: number = 0;
  
  // Track current content height
  private contentHeight: number = 0;
  
  // Mouse tracking enabled
  private mouseTrackingEnabled: boolean = false;

  constructor(options: DirectBufferOptions) {
    super(options);
    
    this.renderMode = options.mode === 'fullscreen' ? 'managed' : 'anchored';
    this.maxScrollback = options.scrollback ?? Number.MAX_SAFE_INTEGER;
    
    // Initialize viewport
    this.viewport = {
      scrollOffset: 0,
      height: this.height,
      width: this.width
    };
    
    // Initialize virtual buffer with current terminal size
    this.virtualBuffer = this.createVirtualBuffer(this.height);
    
    // If in managed mode, enter alternate screen immediately
    if (this.renderMode === 'managed') {
      this.enterAlternateScreen();
    } else {
      // In anchored mode, get current cursor position as command start
      this.captureCommandStart();
    }
  }

  /**
   * Create empty virtual buffer
   */
  private createVirtualBuffer(rows: number): VirtualCell[][] {
    return Array(rows).fill(null).map(() =>
      Array(this.width).fill(null).map(() => ({
        char: ' ',
        fg: Attributes.CM_DEFAULT,
        bg: Attributes.CM_DEFAULT
      }))
    );
  }

  /**
   * Expand virtual buffer to accommodate more content
   */
  private expandVirtualBuffer(newRows: number): void {
    while (this.virtualBuffer.length < newRows && this.virtualBuffer.length < this.maxScrollback) {
      this.virtualBuffer.push(
        Array(this.width).fill(null).map(() => ({
          char: ' ',
          fg: Attributes.CM_DEFAULT,
          bg: Attributes.CM_DEFAULT
        }))
      );
    }
  }

  /**
   * Capture command start position
   */
  private captureCommandStart(): void {
    // In real implementation, would query cursor position
    // For now, assume we start at current cursor
    this.commandStartRow = 1;
  }

  /**
   * Enter alternate screen buffer
   */
  private enterAlternateScreen(): void {
    process.stdout.write('\x1b[?1049h'); // Enter alternate screen
    process.stdout.write('\x1b[2J\x1b[H'); // Clear and home
  }

  /**
   * Exit alternate screen buffer
   */
  private exitAlternateScreen(): void {
    process.stdout.write('\x1b[?1049l'); // Exit alternate screen
  }

  /**
   * Override renderTree to update virtual buffer instead of direct cells
   */
  override renderTree(rootElement: Element): void {
    // Clear virtual buffer for fresh render
    this.contentHeight = 0;
    
    // Walk DOM and populate virtual buffer
    this._walkVirtualDOM(rootElement);
    
    // Handle content growth
    if (this.contentHeight > this.viewport.height && this.renderMode === 'anchored') {
      this.handleContentGrowth(this.contentHeight);
    }
    
    // Copy viewport slice to rendering cells
    this.copyViewportToCells();
  }

  /**
   * Walk DOM and populate virtual buffer
   */
  private _walkVirtualDOM(node: Node): void {
    const window = (this as any).window;
    if (node.nodeType === window.Node.TEXT_NODE) {
      this._renderTextToVirtual(node as Text);
    } else if (node.nodeType === window.Node.ELEMENT_NODE) {
      this._renderElementToVirtual(node as Element);
    }

    node.childNodes.forEach(child => this._walkVirtualDOM(child));
  }

  /**
   * Render text node to virtual buffer
   */
  private _renderTextToVirtual(textNode: Text): void {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;

    const parentElement = textNode.parentElement;
    if (!parentElement) return;

    const computedStyle = parentElement.ownerDocument?.defaultView?.getComputedStyle(parentElement);
    if (!computedStyle) return;

    const bounds = parentElement.getBoundingClientRect();
    if (!bounds || (bounds.width === 0 && bounds.height === 0)) return;

    // Extract styling
    const style = this.extractStyle(computedStyle);
    const attrs = (this as any).createCellAttributes(style);
    
    // Calculate position in virtual buffer
    const y = Math.floor(bounds.y);
    const x = Math.floor(bounds.x);
    
    // Update content height
    this.contentHeight = Math.max(this.contentHeight, y + 1);
    
    // Ensure virtual buffer is large enough
    if (y >= this.virtualBuffer.length) {
      this.expandVirtualBuffer(y + 1);
    }
    
    // Write to virtual buffer
    if (y >= 0 && x >= 0 && x < this.width) {
      const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
      const segments = Array.from(segmenter.segment(text));
      
      let currentX = x;
      for (const segment of segments) {
        if (currentX >= this.width) break;
        
        const char = segment.segment;
        const charWidth = Bun.stringWidth(char);
        
        if (currentX + charWidth <= this.width && y < this.virtualBuffer.length) {
          this.virtualBuffer[y][currentX] = {
            char,
            fg: attrs.fg,
            bg: attrs.bg
          };
          
          // Handle wide characters
          if (charWidth === 2 && currentX + 1 < this.width) {
            this.virtualBuffer[y][currentX + 1] = {
              char: '',
              fg: attrs.fg,
              bg: attrs.bg
            };
          }
          
          currentX += charWidth;
        }
      }
    }
  }

  /**
   * Render element to virtual buffer (backgrounds)
   */
  private _renderElementToVirtual(element: Element): void {
    const computedStyle = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!computedStyle) return;

    const bounds = element.getBoundingClientRect();
    if (!bounds || (bounds.width === 0 && bounds.height === 0)) return;

    const backgroundColor = computedStyle.getPropertyValue('background-color');
    if (!backgroundColor || backgroundColor === 'transparent' || backgroundColor === 'rgba(0, 0, 0, 0)') return;

    const attrs = (this as any).createCellAttributes({ bgColor: backgroundColor });
    
    const startY = Math.floor(bounds.y);
    const endY = Math.ceil(bounds.y + bounds.height);
    const startX = Math.floor(bounds.x);
    const endX = Math.ceil(bounds.x + bounds.width);
    
    // Update content height
    this.contentHeight = Math.max(this.contentHeight, endY);
    
    // Ensure virtual buffer is large enough
    if (endY > this.virtualBuffer.length) {
      this.expandVirtualBuffer(endY);
    }
    
    // Fill background in virtual buffer
    for (let y = startY; y < endY && y < this.virtualBuffer.length; y++) {
      if (y >= 0) {
        for (let x = startX; x < endX && x < this.width; x++) {
          if (x >= 0) {
            // Preserve text but update background
            const existing = this.virtualBuffer[y][x];
            this.virtualBuffer[y][x] = {
              char: existing.char,
              fg: existing.fg,
              bg: attrs.bg
            };
          }
        }
      }
    }
  }

  /**
   * Extract style from computed style
   */
  private extractStyle(computedStyle: CSSStyleDeclaration): any {
    return {
      fgColor: computedStyle.getPropertyValue('color'),
      bgColor: computedStyle.getPropertyValue('background-color'),
      bold: computedStyle.getPropertyValue('font-weight') === 'bold',
      italic: computedStyle.getPropertyValue('font-style') === 'italic',
      underline: computedStyle.getPropertyValue('text-decoration')?.includes('underline')
    };
  }

  /**
   * Copy viewport slice from virtual buffer to rendering cells
   */
  private copyViewportToCells(): void {
    this.clear(); // Clear rendering cells
    
    for (let y = 0; y < this.viewport.height; y++) {
      const virtualY = y + this.viewport.scrollOffset;
      if (virtualY >= 0 && virtualY < this.virtualBuffer.length) {
        for (let x = 0; x < this.viewport.width; x++) {
          const virtualCell = this.virtualBuffer[virtualY][x];
          if (virtualCell) {
            // Direct assignment to cells array
            (this as any).cells[y][x] = {
              char: virtualCell.char,
              fg: virtualCell.fg,
              bg: virtualCell.bg
            };
          }
        }
      }
    }
  }

  /**
   * Handle content growth beyond viewport
   */
  private handleContentGrowth(newHeight: number): void {
    if (!this.mouseTrackingEnabled) {
      // Enable virtual scrolling
      this.enableVirtualScrolling();
      
      // Adjust viewport to show bottom of content
      this.viewport.scrollOffset = Math.max(0, newHeight - this.viewport.height);
    }
  }

  /**
   * Enable virtual scrolling
   */
  private enableVirtualScrolling(): void {
    this.mouseTrackingEnabled = true;
    // Note: In a real implementation, we'd enable mouse tracking here
    // process.stdout.write('\x1b[?1000h'); // Mouse button reporting
  }

  /**
   * Override render to use viewport-aware rendering
   */
  override async render(): Promise<void> {
    if (this.renderMode === 'managed') {
      // In managed mode, render with absolute positioning
      await super.render();
    } else {
      // In anchored mode, render relative to command start
      await this.renderAnchored();
    }
  }

  /**
   * Render in anchored mode
   */
  private async renderAnchored(): Promise<void> {
    // Calculate where to position our content
    const viewportTop = this.calculateViewportTop();
    
    // Position cursor and render
    process.stdout.write(`\x1b[${viewportTop};1H`);
    
    // Use parent's flow rendering
    await (this as any).renderFlow();
  }

  /**
   * Calculate viewport top position
   */
  private calculateViewportTop(): number {
    if (this.contentHeight <= this.viewport.height) {
      // Content fits - render at command start
      return Math.max(1, this.commandStartRow);
    }
    
    // Content exceeds viewport - render at bottom
    return Math.max(1, this.height - this.viewport.height + 1);
  }

  /**
   * Scroll the viewport
   */
  scroll(delta: number): void {
    const maxOffset = Math.max(0, this.virtualBuffer.length - this.viewport.height);
    this.viewport.scrollOffset = Math.max(0, 
      Math.min(maxOffset, this.viewport.scrollOffset + delta));
    
    // Re-render with new viewport
    this.copyViewportToCells();
  }

  /**
   * Handle explicit fullscreen request
   */
  requestFullscreen(): void {
    if (this.renderMode === 'anchored') {
      this.enterAlternateScreen();
      this.renderMode = 'managed';
      (this as any).mode = 'fullscreen';
    }
  }

  /**
   * Exit fullscreen mode
   */
  exitFullscreen(): void {
    if (this.renderMode === 'managed') {
      this.exitAlternateScreen();
      this.renderMode = 'anchored';
      (this as any).mode = 'flow';
    }
  }

  /**
   * Handle terminal resize
   */
  override resize(width: number, height: number): void {
    super.resize(width, height);
    
    // Update viewport
    this.viewport.width = width;
    this.viewport.height = height;
    
    // Resize virtual buffer columns
    for (let y = 0; y < this.virtualBuffer.length; y++) {
      const newRow = Array(width).fill(null).map(() => ({
        char: ' ',
        fg: Attributes.CM_DEFAULT,
        bg: Attributes.CM_DEFAULT
      }));
      
      // Copy existing content
      for (let x = 0; x < Math.min(width, this.virtualBuffer[y].length); x++) {
        newRow[x] = this.virtualBuffer[y][x];
      }
      
      this.virtualBuffer[y] = newRow;
    }
  }

  /**
   * Dispose and cleanup
   */
  override dispose(): void {
    if (this.renderMode === 'managed') {
      this.exitAlternateScreen();
    }
    this.virtualBuffer = [];
    super.dispose();
  }
}