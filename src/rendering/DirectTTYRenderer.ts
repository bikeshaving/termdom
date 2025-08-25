/**
 * DirectTTYRenderer - Simple DOM → ANSI → process.stdout pipeline
 *
 * Replaces the complex TTYRuntime + xterm architecture with direct ANSI generation.
 * Much simpler and more reliable than the abstraction layers.
 */

import type { DOMWindow } from 'jsdom';
import { GreedyTextBreaker } from '../text/index.js';
import { ELEMENT_BOUNDS, ELEMENT_RECTS, ELEMENT_TEXT_RECTS, type TextRect } from '../core/HTMLExtensions.js';
import { Attributes, FgFlags, BgFlags } from '../../xterm.js/src/common/buffer/Constants.js';

// xterm.js CellData-compatible cell representation
interface Cell {
  char: string;
  fg: number;  // Packed: attributes (bits 27-32) + color mode (bits 25-26) + RGB (bits 1-24)
  bg: number;  // Packed: attributes (bits 27-32) + color mode (bits 25-26) + RGB (bits 1-24)
}


export interface DirectTTYRendererOptions {
  width?: number;
  height?: number;
  mode?: 'flow' | 'fullscreen';
  window: DOMWindow;
}

const SYSTEM_COLORS = [
	'canvastext',
	'canvas',
	'linktext',
	'visitedtext',
	'buttontext',
	'buttonface',
	'graytext',
];

/**
 * Direct TTY renderer that converts DOM to ANSI sequences
 */
export class DirectTTYRenderer {
  public readonly width: number;
  public readonly height: number;
  public readonly mode: 'flow' | 'fullscreen';

  private cells: Cell[][];
  private previousFrame?: Cell[][];
  private window: DOMWindow;
  private textBreaker: GreedyTextBreaker;

  constructor(options: DirectTTYRendererOptions) {
    this.window = options.window;
    this.mode = options.mode ?? 'fullscreen';

    // Require explicit width/height or available terminal dimensions
    if (options.width !== undefined) {
      this.width = options.width;
    } else if (process.stdout.columns !== undefined) {
      this.width = process.stdout.columns;
    } else {
      // Temporary fallback for debugging layout overflow
      this.width = 105; // Match user's terminal width
      // Using fallback width for layout debugging
    }

    if (options.height !== undefined) {
      this.height = options.height;
    } else if (process.stdout.rows !== undefined) {
      this.height = process.stdout.rows;
    } else if (this.mode === 'flow') {
      // Flow mode can work without height since it renders incrementally
      this.height = 100; // Large default for flow mode
    } else {
      // Temporary fallback for debugging
      this.height = 28; // Match user's terminal height
      // Using fallback height for layout debugging
    }

    this.cells = this.createEmptyGrid();
    this.textBreaker = new GreedyTextBreaker();

    console.log(`DirectTTYRenderer initialized: ${this.width}x${this.height}`);
  }

  private createEmptyGrid(): Cell[][] {
    return Array(this.height).fill(null).map(() =>
      Array(this.width).fill(null).map(() => ({
        char: ' ',
        fg: Attributes.CM_DEFAULT, // Default foreground
        bg: Attributes.CM_DEFAULT  // Default background
      }))
    );
  }

  /**
   * Convert any CSS color to 24-bit RGB integer using Bun.color
   */
  private cssToRGB(color: string): number {
    try {
      // Use Bun.color with 'number' format to get the RGB integer directly
      const rgbNumber = Bun.color(color, 'number');

      if (typeof rgbNumber === 'number') {
        return rgbNumber;
      }

      return 0;
    } catch (error) {
      return 0; // Fallback for invalid colors
    }
  }

  /**
   * Create xterm.js-compatible fg/bg values from CSS colors and attributes
   */
  private createCellAttributes(options: {
    fgColor?: string;
    bgColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
    blink?: boolean;
    invisible?: boolean;
    strikethrough?: boolean;
    dim?: boolean;
    overline?: boolean;
  }): { fg: number; bg: number } {
    let fg = Attributes.CM_DEFAULT;
    let bg = Attributes.CM_DEFAULT;

    // Handle foreground color
    if (options.fgColor) {
      const rgb = this.cssToRGB(options.fgColor);
      // Always set RGB mode, even for black (0x000000)
      fg = (rgb & Attributes.RGB_MASK) | Attributes.CM_RGB;
    }

    // Handle background color
    if (options.bgColor) {
      const rgb = this.cssToRGB(options.bgColor);
      // Always set RGB mode, even for black (0x000000)
      bg = (rgb & Attributes.RGB_MASK) | Attributes.CM_RGB;
    }

    // Add foreground attributes
    if (options.bold) fg |= FgFlags.BOLD;
    if (options.underline) fg |= FgFlags.UNDERLINE;
    if (options.inverse) fg |= FgFlags.INVERSE;
    if (options.blink) fg |= FgFlags.BLINK;
    if (options.invisible) fg |= FgFlags.INVISIBLE;
    if (options.strikethrough) fg |= FgFlags.STRIKETHROUGH;

    // Add background attributes
    if (options.italic) bg |= BgFlags.ITALIC;
    if (options.dim) bg |= BgFlags.DIM;
    if (options.overline) bg |= BgFlags.OVERLINE;

    return { fg, bg };
  }

  clear(): void {
    this.cells = this.createEmptyGrid();
  }

  /**
   * Put text at coordinates with styling
   */
  put(x: number, y: number, text: string, style?: {
    fgColor?: string;
    bgColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
    blink?: boolean;
    invisible?: boolean;
    strikethrough?: boolean;
    dim?: boolean;
    overline?: boolean;
  }): void {
    if (x < 0 || y < 0 || y >= this.height) return;

    // Convert style to xterm.js attributes
    const attrs = style ? this.createCellAttributes(style) : {
      fg: Attributes.CM_DEFAULT,
      bg: Attributes.CM_DEFAULT
    };

    // Use Intl.Segmenter for proper Unicode handling
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    const segments = Array.from(segmenter.segment(text));
    let currentX = x;

    for (const segment of segments) {
      const char = segment.segment;
      if (currentX >= this.width) break;

      // Calculate character width using Bun.stringWidth (handles emojis and wide characters)
      const charWidth = Bun.stringWidth(char);
      if (currentX + charWidth > this.width) break;

      // Preserve existing background color if no new background specified
      const existingCell = this.cells[y][currentX];
      const finalBg = attrs.bg !== Attributes.CM_DEFAULT ? attrs.bg : existingCell.bg;

      // Place character in first cell
      this.cells[y][currentX] = {
        char,
        fg: attrs.fg,
        bg: finalBg
      };

      // For wide characters, fill the second cell with background and empty char
      if (charWidth === 2 && currentX + 1 < this.width) {
        this.cells[y][currentX + 1] = {
          char: '',
          fg: attrs.fg,
          bg: finalBg
        };
      }

      currentX += charWidth;
    }
  }

  /**
   * Fill rectangle with character and style
   */
  fill(x: number, y: number, width: number, height: number, char: string = ' ', style?: {
    fgColor?: string;
    bgColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
    blink?: boolean;
    invisible?: boolean;
    strikethrough?: boolean;
    dim?: boolean;
    overline?: boolean;
  }): void {
    // Convert style to xterm.js attributes
    const attrs = style ? this.createCellAttributes(style) : {
      fg: Attributes.CM_DEFAULT,
      bg: Attributes.CM_DEFAULT
    };

    for (let row = y; row < y + height && row < this.height; row++) {
      for (let col = x; col < x + width && col < this.width; col++) {
        if (row >= 0 && col >= 0) {
          this.cells[row][col] = {
            char,
            fg: attrs.fg,
            bg: attrs.bg
          };
        }
      }
    }
  }

  /**
   * Extract RGB color from xterm.js packed format
   */
  private extractRGB(packedValue: number): { r: number; g: number; b: number } | null {
    const colorMode = packedValue & Attributes.CM_MASK;
    if (colorMode !== Attributes.CM_RGB) {
      return null; // Not RGB color
    }

    const rgb = packedValue & Attributes.RGB_MASK;
    return {
      r: (rgb >>> Attributes.RED_SHIFT) & 0xFF,
      g: (rgb >>> Attributes.GREEN_SHIFT) & 0xFF,
      b: rgb & 0xFF
    };
  }

  /**
   * Generate ANSI style codes for a cell from xterm.js packed format
   */
  private generateCellStyle(cell: Cell): string {
    let style = '';

    // Reset first
    style += '\x1b[0m';

    // Foreground color
    const fgRGB = this.extractRGB(cell.fg);
    if (fgRGB) {
      style += `\x1b[38;2;${fgRGB.r};${fgRGB.g};${fgRGB.b}m`;
    }

    // Background color
    const bgRGB = this.extractRGB(cell.bg);
    if (bgRGB) {
      style += `\x1b[48;2;${bgRGB.r};${bgRGB.g};${bgRGB.b}m`;
    }

    // Foreground attributes
    if (cell.fg & FgFlags.BOLD) style += '\x1b[1m';
    if (cell.fg & FgFlags.UNDERLINE) style += '\x1b[4m';
    if (cell.fg & FgFlags.INVERSE) style += '\x1b[7m';
    if (cell.fg & FgFlags.BLINK) style += '\x1b[5m';
    if (cell.fg & FgFlags.INVISIBLE) style += '\x1b[8m';
    if (cell.fg & FgFlags.STRIKETHROUGH) style += '\x1b[9m';

    // Background attributes
    if (cell.bg & BgFlags.ITALIC) style += '\x1b[3m';
    if (cell.bg & BgFlags.DIM) style += '\x1b[2m';
    if (cell.bg & BgFlags.OVERLINE) style += '\x1b[53m';

    return style;
  }

  /**
   * Render the buffer to process.stdout
   */
  async render(): Promise<void> {
    if (this.mode === 'flow') {
      await this.renderFlow();
    } else {
      await this.renderFullscreen();
    }

    // Store frame for delta rendering
    this.previousFrame = this.cells.map(row => row.map(cell => ({ ...cell })));
  }

  /**
   * Flow mode rendering (sequential lines)
   */
  private async renderFlow(): Promise<void> {
    // Find content bounds
    let minY = this.height;
    let maxY = -1;

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.cells[y][x].char !== ' ') {
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (maxY === -1) return; // No content

    // Render line by line
    for (let y = minY; y <= maxY; y++) {
      let line = '';
      let currentStyle = { fg: Attributes.CM_DEFAULT, bg: Attributes.CM_DEFAULT };

      // Find last non-space character for trimming
      let lastNonSpace = -1;
      for (let x = this.width - 1; x >= 0; x--) {
        const cell = this.cells[y][x];
        if (cell.char !== ' ' || (cell.bg & Attributes.CM_MASK) !== Attributes.CM_DEFAULT) {
          lastNonSpace = x;
          break;
        }
      }

      // Generate line with styles
      for (let x = 0; x <= lastNonSpace; x++) {
        const cell = this.cells[y][x];

        // Apply style changes
        if (this.styleChanged(currentStyle, cell)) {
          line += this.generateCellStyle(cell);
          currentStyle = { fg: cell.fg, bg: cell.bg };
        }

        line += cell.char;
      }

      // Write line and reset
      if (line.length > 0) {
        process.stdout.write(line);
        process.stdout.write('\x1b[0m\n'); // Reset and newline
      }
    }
  }

  /**
   * Fullscreen mode rendering (absolute positioning)
   */
  private async renderFullscreen(): Promise<void> {
    // Clear screen
    process.stdout.write('\x1b[2J\x1b[H');

    for (let y = 0; y < this.height; y++) {
      // Move to line start
      process.stdout.write(`\x1b[${y + 1};1H`);

      let currentStyle = { fg: Attributes.CM_DEFAULT, bg: Attributes.CM_DEFAULT };

      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y][x];

        if (this.styleChanged(currentStyle, cell)) {
          process.stdout.write(this.generateCellStyle(cell));
          currentStyle = { fg: cell.fg, bg: cell.bg };
        }

        process.stdout.write(cell.char);
      }
    }

    process.stdout.write('\x1b[0m'); // Reset styles
  }

  /**
   * Check if cell style changed
   */
  private styleChanged(oldStyle: { fg: number; bg: number }, newStyle: { fg: number; bg: number }): boolean {
    return oldStyle.fg !== newStyle.fg || oldStyle.bg !== newStyle.bg;
  }

  /**
   * Render DOM tree to buffer
   */
  renderTree(rootElement: Element): void {
    // Debug root element layout
    const rootBounds = rootElement.getBoundingClientRect();
    // Root element bounds checked for overflow

    this._walkDOM(rootElement);
  }

  private _walkDOM(node: Node): void {
    if (node.nodeType === this.window.Node.TEXT_NODE) {
      this._renderTextNode(node as Text);
    } else if (node.nodeType === this.window.Node.ELEMENT_NODE) {
      this._renderElementNode(node as Element);
    }

    node.childNodes.forEach(child => this._walkDOM(child));
  }

  private _renderTextNode(textNode: Text): void {
    const text = textNode.textContent;
    if (!text || !text.trim()) return;

    const parentElement = textNode.parentElement;
    if (!parentElement) return;

    const computedStyle = parentElement.ownerDocument?.defaultView?.getComputedStyle(parentElement);
    if (!computedStyle) return;

    // Debug text positioning
    const bounds = parentElement.getBoundingClientRect();
    if (bounds && bounds.x + bounds.width > this.width) {
      // Text exceeds renderer width - truncated to fit
    }

    // Extract styling
    const style: {
      fgColor?: string;
      bgColor?: string;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      inverse?: boolean;
    } = {};

    const fgColor = computedStyle.getPropertyValue('color');
    const bgColor = computedStyle.getPropertyValue('background-color');

    if (fgColor && !this.isSystemColor(fgColor)) {
      style.fgColor = fgColor;
    }

    if (bgColor && !this.isSystemColor(bgColor) && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
      style.bgColor = bgColor;
    }

    style.bold = computedStyle.getPropertyValue('font-weight') === 'bold';
    style.italic = computedStyle.getPropertyValue('font-style') === 'italic';
    style.underline = computedStyle.getPropertyValue('text-decoration')?.includes('underline');

    // Check if the Text node itself has pre-computed text rectangles (multi-line text)
    const textNodeRects = (textNode as any)[ELEMENT_TEXT_RECTS];
    if (textNodeRects && textNodeRects.length > 0) {
      // Render each line fragment at its computed position
      for (const textRect of textNodeRects) {
        this.put(Math.floor(textRect.x), Math.floor(textRect.y), textRect.text, style);
      }
    } else {
      // Check if the parent element has text rectangles (inline element case)
      const parentTextRects = parentElement[ELEMENT_TEXT_RECTS];
      if (parentTextRects && parentTextRects.length > 0) {
        // Render each line fragment at its computed position
        for (const textRect of parentTextRects) {
          this.put(Math.floor(textRect.x), Math.floor(textRect.y), textRect.text, style);
        }
      } else {
        // Fall back to single-line rendering
        const bounds = parentElement.getBoundingClientRect();
        if (bounds && (bounds.width > 0 || bounds.height > 0)) {
          this.put(Math.floor(bounds.x), Math.floor(bounds.y), text, style);
        }
      }
    }
  }

  private _renderElementNode(element: Element): void {
    const computedStyle = element.ownerDocument?.defaultView?.getComputedStyle(element);
    if (!computedStyle) return;

    const bounds = element.getBoundingClientRect();
    if (!bounds || (bounds.width === 0 && bounds.height === 0)) return;

    // Debug element positioning
    if (bounds.x + bounds.width > this.width) {
      // Element exceeds renderer width - clipped to fit
    }

    const backgroundColor = computedStyle.getPropertyValue('background-color');

    if (backgroundColor && backgroundColor !== 'transparent' && backgroundColor !== 'rgba(0, 0, 0, 0)') {
      this.fill(
        Math.floor(bounds.x),
        Math.floor(bounds.y),
        Math.ceil(bounds.width),
        Math.ceil(bounds.height),
        ' ',
        { bgColor: backgroundColor }
      );
    }
  }

  private isSystemColor(color: string): boolean {
    return SYSTEM_COLORS.includes(color.toLowerCase());
  }

  dispose(): void {
    this.cells = [];
    this.previousFrame = undefined;
  }

  // Compatibility methods
  resize(width: number, height: number): void {
    (this as any).width = width;
    (this as any).height = height;
    this.cells = this.createEmptyGrid();
    this.previousFrame = undefined;
  }

  setFullscreenMode(fullscreen: boolean): void {
    (this as any).mode = fullscreen ? 'fullscreen' : 'flow';
  }

  get isFullscreen(): boolean {
    return this.mode === 'fullscreen';
  }

	// TODO: delete
  async renderDelta(): Promise<void> {
    await this.render();
  }

  async flush(): Promise<void> {
    await this.render();
  }
}
