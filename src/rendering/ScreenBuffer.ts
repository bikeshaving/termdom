/**
 * TTY ScreenBuffer - Modern TypeScript adaptation of terminal-kit's ScreenBuffer
 *
 * Provides efficient terminal rendering with compositing and delta updates
 * using TTYRuntime abstraction instead of direct ANSI sequences.
 * Adapted from terminal-kit's MIT-licensed ScreenBuffer implementation.
 */

import { Node, DOMRect, Element, Text } from 'happy-dom';

export interface Cell {
  char: string;
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface ScreenBufferOptions {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  runtime?: import('../core/TTYRuntime.js').TTYRuntime;
}

/**
 * ScreenBuffer provides efficient terminal rendering with compositing
 */
export class ScreenBuffer {
  public readonly width: number;
  public readonly height: number;
  public readonly x: number;
  public readonly y: number;

  private cells: Cell[][];
  private lastFrame?: Cell[][];
  private runtime?: import('../core/TTYRuntime.js').TTYRuntime;
  private cursorX = 0;
  private cursorY = 0;

  constructor(options: ScreenBufferOptions = {}) {
    this.runtime = options.runtime;

    if (this.runtime) {
      const dimensions = this.runtime.getTerminalSize();
      this.width = options.width ?? dimensions.columns;
      this.height = options.height ?? dimensions.rows;
    } else {
      // Fallback for backward compatibility
      this.width = options.width ?? process.stdout.columns ?? 80;
      this.height = options.height ?? process.stdout.rows ?? 24;
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
      await this.render();
      return;
    }

    let hasChanges = false;
    let currentOutputStyle: Partial<Cell> = {};

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const current = this.cells[y][x];
        const last = this.lastFrame[y][x];

        if (!this.cellsEqual(current, last)) {
          hasChanges = true;

          // Move cursor to changed cell position
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

	//TODO: This should be handled by the TTYRuntime API
  /**
   * Generate ANSI escape sequence for cell styling (legacy fallback)
   */
  private generateStyleSequence(cell: Cell): string {
    let sequence = '';

    // Reset all attributes first to ensure clean state
    sequence += '\x1b[0m';

    // Use TTYRuntime for color conversion if available
    if (this.runtime) {
      if (cell.fgColor) {
        sequence += this.runtime.colorizeText('', cell.fgColor).replace(/./g, '');
      }
      if (cell.bgColor) {
        const colorCode = this.colorToAnsi(cell.bgColor, true);
        if (colorCode) sequence += colorCode;
      }
    } else {
      // Fallback for backward compatibility
      if (cell.fgColor) {
        const colorCode = this.colorToAnsi(cell.fgColor, false);
        if (colorCode) sequence += colorCode;
      }
      if (cell.bgColor) {
        const colorCode = this.colorToAnsi(cell.bgColor, true);
        if (colorCode) sequence += colorCode;
      }
    }

    if (cell.bold) sequence += '\x1b[1m';
    if (cell.italic) sequence += '\x1b[3m';
    if (cell.underline) sequence += '\x1b[4m';
    if (cell.inverse) sequence += '\x1b[7m';

    return sequence;
  }

	//TODO: This should be handled by the TTYRuntime API
  /**
   * Convert color to ANSI escape sequence using Bun's color API
   */
  private colorToAnsi(color: string, isBackground: boolean): string {
    try {
      // Use Bun's color API for efficient color conversion
      const ansiColor = Bun.color(color, 'ansi');
      if (ansiColor && isBackground) {
        // Convert foreground (38) to background (48)
        return ansiColor.replace('38;', '48;');
      } else {
        return ansiColor || '';
      }
    } catch {
      // Fallback for basic colors
      return this.basicColorToAnsi(color, isBackground);
    }
  }

	//TODO: This should be handled by the TTYRuntime API
  /**
   * Fallback basic color conversion
   */
  private basicColorToAnsi(color: string, isBackground: boolean): string {
    const colors: Record<string, number> = {
      'black': 0, 'red': 1, 'green': 2, 'yellow': 3,
      'blue': 4, 'magenta': 5, 'cyan': 6, 'white': 7
    };

    const colorCode = colors[color.toLowerCase()];
    if (colorCode !== undefined) {
      const base = isBackground ? 40 : 30;
      return `\x1b[${base + colorCode}m`;
    }

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
    this.put(bounds.x, bounds.y, text, {
      fgColor: computedStyle.getPropertyValue('color'),
      bgColor: computedStyle.getPropertyValue('background-color'),
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
    
    // Render background if specified
    const backgroundColor = computedStyle.getPropertyValue('background-color');
    if (backgroundColor && backgroundColor !== 'transparent') {
      this.fill(bounds, ' ', { bgColor: backgroundColor });
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
