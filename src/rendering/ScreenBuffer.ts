/**
 * TOM ScreenBuffer - Modern TypeScript adaptation of terminal-kit's ScreenBuffer
 * 
 * Provides efficient terminal rendering with compositing and delta updates.
 * Adapted from terminal-kit's MIT-licensed ScreenBuffer implementation.
 */

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
  output?: NodeJS.WriteStream;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  private output: NodeJS.WriteStream;
  private cursorX = 0;
  private cursorY = 0;

  constructor(options: ScreenBufferOptions = {}) {
    this.width = options.width ?? process.stdout.columns ?? 80;
    this.height = options.height ?? process.stdout.rows ?? 24;
    this.x = options.x ?? 0;
    this.y = options.y ?? 0;
    this.output = options.output ?? process.stdout;
    
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
    
    // Use Bun's string width for proper Unicode handling
    const chars = [...text]; // Handle multi-byte Unicode properly
    let currentX = x;
    
    for (const char of chars) {
      if (currentX >= this.width) break;
      
      // Place the character
      this.cells[y][currentX] = {
        char: char,
        ...style
      };
      
      // Get the width of this character and advance cursor
      const charWidth = Bun.stringWidth(char);
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
  fill(bounds: Rect, char: string = ' ', style?: Partial<Cell>): void {
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
  render(): void {
    let output = '';
    
    for (let y = 0; y < this.height; y++) {
      // Move cursor to line start
      output += `\x1b[${this.y + y + 1};${this.x + 1}H`;
      
      let currentStyle: Partial<Cell> = {};
      
      for (let x = 0; x < this.width; x++) {
        const cell = this.cells[y][x];
        
        // Apply style changes
        if (this.styleChanged(currentStyle, cell)) {
          output += this.generateStyleSequence(cell);
          currentStyle = { ...cell };
        }
        
        output += cell.char;
      }
      
      // Reset styles at end of line
      output += '\x1b[0m';
    }
    
    this.output.write(output);
    this.lastFrame = this.copyFrame(this.cells);
  }

  /**
   * Render only changed cells (delta update) - much more efficient
   */
  renderDelta(): void {
    if (!this.lastFrame) {
      this.render();
      return;
    }
    
    let output = '';
    
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const current = this.cells[y][x];
        const last = this.lastFrame[y][x];
        
        if (!this.cellsEqual(current, last)) {
          // Move cursor to changed cell position
          output += `\x1b[${this.y + y + 1};${this.x + x + 1}H`;
          output += this.generateStyleSequence(current);
          output += current.char;
        }
      }
    }
    
    if (output) {
      output += '\x1b[0m'; // Reset styles
      this.output.write(output);
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
   * Generate ANSI escape sequence for cell styling
   */
  private generateStyleSequence(cell: Cell): string {
    let sequence = '';
    
    // Use Bun's color API for efficient color handling
    if (cell.fgColor) {
      const colorCode = this.colorToAnsi(cell.fgColor, false);
      if (colorCode) sequence += colorCode;
    }
    
    if (cell.bgColor) {
      const colorCode = this.colorToAnsi(cell.bgColor, true);
      if (colorCode) sequence += colorCode;
    }
    
    if (cell.bold) sequence += '\x1b[1m';
    if (cell.italic) sequence += '\x1b[3m';
    if (cell.underline) sequence += '\x1b[4m';
    if (cell.inverse) sequence += '\x1b[7m';
    
    return sequence;
  }

  /**
   * Convert color to ANSI escape sequence using Bun's color API
   */
  private colorToAnsi(color: string, isBackground: boolean): string {
    try {
      // Use Bun's color API for efficient color conversion
      const ansiColor = Bun.color(color, 'ansi');
      if (isBackground) {
        // Convert foreground (38) to background (48)
        return ansiColor.replace('38;', '48;');
      } else {
        return ansiColor;
      }
    } catch {
      // Fallback for basic colors
      return this.basicColorToAnsi(color, isBackground);
    }
  }

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
  moveCursorToTerminal(): void {
    this.output.write(`\x1b[${this.y + this.cursorY + 1};${this.x + this.cursorX + 1}H`);
  }
}