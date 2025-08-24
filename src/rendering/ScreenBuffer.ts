/**
 * TTY ScreenBuffer - Modern TypeScript adaptation of terminal-kit's ScreenBuffer
 *
 * Provides efficient terminal rendering with compositing and delta updates
 * using TTYRuntime abstraction instead of direct ANSI sequences.
 * Adapted from terminal-kit's MIT-licensed ScreenBuffer implementation.
 */

import { Node, DOMRect, Element } from '../dom.js';

export interface Cell {
  char: string;
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

export interface ScreenBufferOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  runtime?: import('../core/TTYRuntime.js').TTYRuntime;
  /** Render mode: 'flow' for inline CLI output, 'fullscreen' for TUI apps */
  mode?: 'flow' | 'fullscreen';
}

/**
 * ScreenBuffer provides efficient terminal rendering with compositing
 */
export class ScreenBuffer {
  public readonly width: number;
  public readonly height: number;
  public readonly x: number;
  public readonly y: number;
  public readonly isFullscreen: boolean;

  private cells: Cell[][];
  private lastFrame?: Cell[][];
  private runtime?: import('../core/TTYRuntime.js').TTYRuntime;
  private cursorX = 0;
  private cursorY = 0;
  private mode: 'flow' | 'fullscreen';
  private contentStartLine = 0; // Track where our content started in flow mode

  constructor(options: ScreenBufferOptions = {}) {
    this.runtime = options.runtime;
    this.mode = options.mode ?? 'fullscreen';
    this.isFullscreen = this.mode === 'fullscreen';

    if (this.runtime) {
      const dimensions = this.runtime.getTerminalSize();
      this.width = options.width ?? dimensions.columns;
      if (this.mode === 'flow') {
        // Flow mode: dynamic height based on content, start with reasonable default
        this.height = options.height ?? 100; // Will grow as needed
      } else {
        // Fullscreen mode: fixed height matching terminal
        this.height = options.height ?? dimensions.rows;
      }
    } else {
      // Fallback for backward compatibility
      this.width = options.width ?? process.stdout.columns ?? 80;
      this.height = options.height ?? (this.mode === 'flow' ? 100 : 24);
    }

    this.x = options.x ?? 0;
    this.y = options.y ?? 0;

    this.cells = this.createEmptyCells();
  }

  /**
   * Create empty cell grid
   */
  private createEmptyCells(): Cell[][] {
    return Array(this.height).fill(null).map(() =>
      Array(this.width).fill(null).map(() => ({ char: ' ' }))
    );
  }

  /**
   * Clear the buffer with empty cells
   */
  clear(): void {
    this.cells = this.createEmptyCells();
  }

  /**
   * Put text at specific coordinates with styling
   */
  put(x: number, y: number, text: string, style?: Partial<Cell>): void {
    // Handle clipping
    if (x < 0 || y < 0 || y >= this.height) return;

    // Use Intl.Segmenter for proper grapheme cluster segmentation
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(text));
    let currentX = x;

    for (const segment of segments) {
      const char = segment.segment;
      if (currentX >= this.width) break;

      // Place the character
      this.cells[y][currentX] = {
        char: char,
        ...style
      };

      // Get the width of this character and advance cursor
      const charWidth = this.runtime ? this.runtime.measureTextWidth(char) : char.length;
      currentX += charWidth;

      // For wide characters, fill the extra cell with empty space
      // to prevent other characters from overlapping
      if (charWidth > 1) {
        for (let j = 1; j < charWidth && currentX - charWidth + j < this.width; j++) {
          this.cells[y][currentX - charWidth + j] = {
            char: '', // Empty placeholder for wide character continuation
            ...style
          };
        }
      }
    }
  }

  /**
   * Fill a rectangular region with character and style
   */
  fill(bounds: DOMRect, char: string = ' ', style?: Partial<Cell>): void {
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
        if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
          this.cells[y][x] = { char, ...style };
        }
      }
    }
  }

  /**
   * Composite another ScreenBuffer onto this one
   */
  composite(source: ScreenBuffer, offsetX: number, offsetY: number): void {
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const targetX = offsetX + x;
        const targetY = offsetY + y;

        if (targetX >= 0 && targetX < this.width && targetY >= 0 && targetY < this.height) {
          const sourceCell = source.cells[y][x];
          // Only composite non-empty cells or cells with background colors
          if (sourceCell.char !== ' ' || sourceCell.bgColor) {
            this.cells[targetY][targetX] = { ...sourceCell };
          }
        }
      }
    }
  }

  /**
   * Render the entire buffer to terminal (full redraw)
   */
  async render(): Promise<void> {
    if (!this.runtime) {
      console.warn('ScreenBuffer: No TTYRuntime available, skipping render');
      return;
    }

    for (let y = 0; y < this.height; y++) {
      // Move cursor to line start
      await this.runtime.cursorTo(this.x, this.y + y);

      let currentStyle: Partial<Cell> = {};

      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y][x];

        // Apply style changes using TTYRuntime
        if (this.styleChanged(currentStyle, cell)) {
          this.applyStyleToRuntime(cell);
          currentStyle = { ...cell };
        }

        await this.runtime.writeStdout(cell.char);
      }

      // Reset styles at end of line
      this.runtime.resetStyle();
    }

    this.lastFrame = this.copyFrame(this.cells);
  }

  /**
   * Render only changed cells (delta update) - much more efficient
   */
  async renderDelta(): Promise<void> {
    if (!this.runtime) {
      console.warn('ScreenBuffer: No TTYRuntime available, skipping delta render');
      return;
    }

    if (!this.lastFrame) {
      if (this.mode === 'flow') {
        await this.renderFlow();
      } else {
        await this.render();
      }
      return;
    }

    if (this.mode === 'flow') {
      await this.renderFlowDelta();
    } else {
      await this.renderFullscreenDelta();
    }
  }

  /**
   * Render in flow mode (sequential output, no absolute positioning)
   */
  private async renderFlow(): Promise<void> {
    if (!this.runtime) return;

    let currentOutputStyle: Partial<Cell> = {};

    // Find the actual content bounds (non-empty cells)
    let minY = this.height;
    let maxY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.cells[y][x].char !== ' ' && this.cells[y][x].char !== '') {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (maxY === -1) {
      // No content
      this.lastFrame = this.copyFrame(this.cells);
      return;
    }

    // Render content sequentially, line by line
    for (let y = minY; y <= maxY; y++) {
      let lineHasContent = false;
      let lineContent = '';
      let currentLineStyle: Partial<Cell> = {};
      let lastNonSpaceX = -1;

      // First pass: find the last non-space character position
      for (let x = this.width - 1; x >= 0; x--) {
        if (this.cells[y][x].char !== ' ') {
          lastNonSpaceX = x;
          break;
        }
      }

      // Second pass: render with proper style management
      // Need to check for background colors beyond text
      let renderToX = lastNonSpaceX;
      
      // Check if any cell in this line has a background color
      for (let x = 0; x < this.width; x++) {
        if (this.cells[y][x].bgColor) {
          renderToX = Math.max(renderToX, x);
        }
      }
      
      
      for (let x = 0; x <= renderToX; x++) {
        const cell = this.cells[y][x];
        if (this.styleChanged(currentLineStyle, cell)) {
          // Generate and append style sequence directly to lineContent
          const styleSeq = this.generateStyleSequence(cell);
          lineContent += styleSeq;
          currentLineStyle = { ...cell };
        }
        lineContent += cell.char;
        lineHasContent = true;
      }

      if (lineHasContent) {
        // Don't trim if the line has background colors that need to extend to the right
        const shouldTrim = renderToX === lastNonSpaceX;
        await this.runtime.writeStdout(shouldTrim ? lineContent.trimEnd() : lineContent);
        // Reset style before newline to prevent bleeding
        this.runtime.resetStyle();
        await this.runtime.writeStdout('\n');
      }
    }

    this.runtime.resetStyle();
    this.lastFrame = this.copyFrame(this.cells);
  }

  /**
   * Render delta changes in flow mode
   */
  private async renderFlowDelta(): Promise<void> {
    // For now, just re-render everything in flow mode
    // TODO: Implement proper flow delta updates using relative cursor positioning
    await this.renderFlow();
  }

  /**
   * Render delta changes in fullscreen mode (original behavior)
   */
  private async renderFullscreenDelta(): Promise<void> {
    if (!this.runtime || !this.lastFrame) return;

    let hasChanges = false;
    let currentOutputStyle: Partial<Cell> = {};

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const current = this.cells[y][x];
        const last = this.lastFrame[y][x];

        if (!this.cellsEqual(current, last)) {
          hasChanges = true;

          // Move cursor to changed cell position (absolute positioning)
          await this.runtime.cursorTo(this.x + x, this.y + y);

          // Only apply style if style actually changed
          if (this.styleChanged(currentOutputStyle, current)) {
            this.applyStyleToRuntime(current);
            currentOutputStyle = { ...current };
          }

          await this.runtime.writeStdout(current.char);
        }
      }
    }

    if (hasChanges) {
      this.runtime.resetStyle();
    }

    this.lastFrame = this.copyFrame(this.cells);
  }

  /**
   * Check if cell styling has changed
   */
  private styleChanged(oldStyle: Partial<Cell>, newStyle: Partial<Cell>): boolean {
    return (
      oldStyle.fgColor !== newStyle.fgColor ||
      oldStyle.bgColor !== newStyle.bgColor ||
      oldStyle.bold !== newStyle.bold ||
      oldStyle.italic !== newStyle.italic ||
      oldStyle.underline !== newStyle.underline ||
      oldStyle.inverse !== newStyle.inverse
    );
  }

  /**
   * Apply cell styling to TTYRuntime
   */
  private applyStyleToRuntime(cell: Cell): void {
    if (!this.runtime) return;

    // Reset styles first
    this.runtime.resetStyle();

    // Apply colors
    if (cell.fgColor || cell.bgColor) {
      this.runtime.setColor(cell.fgColor, cell.bgColor);
    }

    // Apply text styling
    if (cell.bold) this.runtime.setBold(true);
    if (cell.italic) this.runtime.setItalic(true);
    if (cell.underline) this.runtime.setUnderline(true);
    if (cell.inverse) this.runtime.setReverse(true);
  }

  /**
   * Generate ANSI escape sequence for cell styling using TTYRuntime
   */
  private generateStyleSequence(cell: Cell): string {
    if (this.runtime) {
      // Use TTYRuntime for proper ANSI generation
      return this.runtime.generateCellStyle({
        fgColor: cell.fgColor,
        bgColor: cell.bgColor,
        bold: cell.bold,
        italic: cell.italic,
        underline: cell.underline,
        inverse: cell.inverse,
        dim: cell.dim,
        strikethrough: cell.strikethrough
      });
    }

    // Fallback for when no runtime is available (shouldn't happen in normal usage)
    console.warn('ScreenBuffer: No TTYRuntime available for style generation');
    return '';
  }


  /**
   * Check if two cells are equal
   */
  private cellsEqual(a: Cell, b: Cell): boolean {
    return (
      a.char === b.char &&
      a.fgColor === b.fgColor &&
      a.bgColor === b.bgColor &&
      a.bold === b.bold &&
      a.italic === b.italic &&
      a.underline === b.underline &&
      a.inverse === b.inverse
    );
  }

  /**
   * Create a deep copy of the cell grid
   */
  private copyFrame(cells: Cell[][]): Cell[][] {
    return cells.map(row => row.map(cell => ({ ...cell })));
  }

  /**
   * Get cell at coordinates
   */
  getCell(x: number, y: number): Cell | null {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return null;
    }
    return { ...this.cells[y][x] };
  }

  /**
   * Set cursor position
   */
  setCursor(x: number, y: number): void {
    this.cursorX = Math.max(0, Math.min(x, this.width - 1));
    this.cursorY = Math.max(0, Math.min(y, this.height - 1));
  }

  /**
   * Get cursor position
   */
  getCursor(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY };
  }

  /**
   * Switch to fullscreen mode (for requestFullScreen())
   */
  setFullscreenMode(fullscreen: boolean): void {
    if (fullscreen === this.isFullscreen) return;
    
    (this as any).isFullscreen = fullscreen;
    this.mode = fullscreen ? 'fullscreen' : 'flow';
    
    if (fullscreen) {
      // Switch to fullscreen: clear screen and enable absolute positioning
      if (this.runtime) {
        this.runtime.writeStdout('\x1b[2J\x1b[H'); // Clear screen and move to top
      }
    } else {
      // Switch to flow: just continue with current content
      this.contentStartLine = 0; // Reset content tracking
    }
  }

  /**
   * Move cursor to terminal position
   */
  async moveCursorToTerminal(): Promise<void> {
    if (this.runtime) {
      await this.runtime.cursorTo(this.x + this.cursorX, this.y + this.cursorY);
    }
  }

  /**
   * Flush the buffer to terminal (convenience method for delta rendering)
   */
  async flush(): Promise<void> {
    await this.renderDelta();
  }

  /**
   * Resize the buffer
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;

    // Cast to mutable for resize
    (this as any).width = width;
    (this as any).height = height;

    // Create new cell grid
    const newCells = this.createEmptyCells();

    // Copy existing cells that fit
    for (let y = 0; y < Math.min(this.cells.length, height); y++) {
      for (let x = 0; x < Math.min(this.cells[y].length, width); x++) {
        newCells[y][x] = this.cells[y][x];
      }
    }

    this.cells = newCells;
    this.lastFrame = undefined; // Force full redraw on next render
  }

  /**
   * Render a DOM tree to the screen buffer
   * This is the main entry point for TTY DOM rendering
   */
  renderTree(rootElement: Element): void {
    // TODO: Implement sophisticated rendering pipeline:
    // 1. Layout phase: Calculate bounds for all elements
    // 2. Invalidation phase: Find elements that changed
    // 3. Clear phase: Clear old positions for moved elements  
    // 4. Render phase: Walk tree and render each node
    // 5. Delta phase: Only send changes to terminal
    
    this._walkDOMTree(rootElement);
  }

  /**
   * Composite a single element and its children to the buffer
   * Used by TTYRenderer for direct element rendering
   */
  compositeElement(element: Element): void {
    this._renderElementNode(element);
    // Recurse into children
    Array.from(element.childNodes).forEach(child => this._walkDOMTree(child));
  }

  /**
   * Walk the DOM tree and render each node appropriately
   */
  private _walkDOMTree(node: Node): void {
    // Handle different node types using Node constants
    if (node.nodeType === Node.TEXT_NODE) {
      this._renderTextNode(node as Text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      this._renderElementNode(node as Element);
    }
    
    // Recurse into child nodes
    node.childNodes.forEach(child => this._walkDOMTree(child));
  }

  /**
   * Render a text node to the buffer
   */
  private _renderTextNode(textNode: Text): void {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;
    
    // Get parent element for styling and bounds
    const parentElement = textNode.parentElement;
    if (!parentElement) return;
    
    // Use computed style for proper CSS cascade
    const computedStyle = parentElement.ownerDocument?.defaultView?.getComputedStyle(parentElement);
    if (!computedStyle) return;
    
    // Get bounds from element's getBoundingClientRect (Yoga-powered)
    const bounds = parentElement.getBoundingClientRect();
    if (!bounds || (bounds.width === 0 && bounds.height === 0)) return;
    
    // Render text with computed styles
    const rawFgColor = computedStyle.getPropertyValue('color');
    const rawBgColor = computedStyle.getPropertyValue('background-color');
    
    // Filter out CSS system colors that we don't want to render as literal text
    const isSystemColor = (color: string) => {
      const systemColors = ['canvastext', 'canvas', 'linktext', 'visitedtext', 'buttontext', 'buttonface', 'graytext'];
      return systemColors.includes(color.toLowerCase());
    };
    
    const fgColor = rawFgColor && !isSystemColor(rawFgColor) ? rawFgColor : undefined;
    const bgColor = rawBgColor && !isSystemColor(rawBgColor) && rawBgColor !== 'rgba(0, 0, 0, 0)' && rawBgColor !== 'transparent' ? rawBgColor : undefined;
    
    this.put(bounds.x, bounds.y, text, {
      fgColor,
      bgColor,
      bold: computedStyle.getPropertyValue('font-weight') === 'bold',
      italic: computedStyle.getPropertyValue('font-style') === 'italic',
      underline: computedStyle.getPropertyValue('text-decoration')?.includes('underline')
    });
  }

  /**
   * Render an element node to the buffer
   */
  private _renderElementNode(element: Element): void {
    // Use computed style for proper CSS cascade
    const computedStyle = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!computedStyle) return;
    
    // Get bounds from element's getBoundingClientRect (Yoga-powered)
    const bounds = element.getBoundingClientRect();
    if (!bounds || (bounds.width === 0 && bounds.height === 0)) return;
    
    // For block elements with background colors, we need to fill the entire width
    const backgroundColor = computedStyle.getPropertyValue('background-color');
    const display = computedStyle.getPropertyValue('display');
    
    if (backgroundColor && backgroundColor !== 'transparent' && backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        (display === 'block' || display === 'flex')) {
      
      
      // Fill the entire width of the block element with spaces that have the background color
      for (let y = Math.floor(bounds.y); y < Math.ceil(bounds.y + bounds.height); y++) {
        for (let x = Math.floor(bounds.x); x < Math.ceil(bounds.x + bounds.width); x++) {
          if (x >= 0 && x < this.width && y >= 0 && y < this.height) {
            // Only fill if the cell is empty (preserve text)
            if (this.cells[y][x].char === ' ') {
              this.cells[y][x] = { char: ' ', bgColor: backgroundColor };
            }
          }
        }
      }
    }
    
    // Render borders if specified
    const borderWidth = parseInt(computedStyle.getPropertyValue('border-width')) || 0;
    if (borderWidth > 0) {
      const borderColor = computedStyle.getPropertyValue('border-color');
      // TODO: Implement border rendering
    }
  }


  /**
   * Dispose of resources
   */
  dispose(): void {
    // Clear references
    this.cells = [];
    this.lastFrame = undefined;
    this.runtime = undefined;
  }
}
