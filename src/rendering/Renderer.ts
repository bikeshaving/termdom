/**
 * Minimal delta renderer using extracted cell buffer and serializer
 */

import {
  CellBuffer, Cell,
  createBuffer, createNullCell, copyCell, cellsEqual,
  setCellChar, setCellFg, setCellBg,
  CELL_CHAR, CELL_FG, CELL_BG, CELL_STYLE,
  STYLE_BOLD, STYLE_ITALIC, STYLE_UNDERLINE, STYLE_STRIKETHROUGH,
  STYLE_INVERSE, STYLE_DIM, STYLE_BLINK, STYLE_OVERLINE,
  isCellEmpty
} from './CellBuffer.js';
import { ANSIGenerator, ColorDepth } from './ANSIGenerator.js';

export interface CellStyle {
  fg?: string | number;
  bg?: string | number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
  dim?: boolean;
  blink?: boolean;
  overline?: boolean;
}

export class Renderer {
  private previousBuffer: CellBuffer | null = null;
  private currentBuffer: CellBuffer;
  private generator: ANSIGenerator;
  
  constructor(
    private readonly rows: number,
    private readonly cols: number,
    colorDepth: ColorDepth = 'rgb'
  ) {
    this.currentBuffer = createBuffer(rows, cols);
    this.generator = new ANSIGenerator(rows, cols, colorDepth);
  }
  
  /**
   * Begin a new frame - creates fresh buffer
   */
  beginFrame(): void {
    this.currentBuffer = createBuffer(this.rows, this.cols);
  }
  
  /**
   * Set a cell with character and style
   */
  setCell(row: number, col: number, char: string, style?: CellStyle): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
    
    const cell = this.currentBuffer[row][col];
    
    // Set character
    setCellChar(cell, char);
    
    // Set foreground color
    if (style?.fg !== undefined) {
      const fgColor = typeof style.fg === 'string' 
        ? Bun.color(style.fg, 'number')
        : style.fg;
      setCellFg(cell, fgColor);
    }
    
    // Set background color
    if (style?.bg !== undefined) {
      const bgColor = typeof style.bg === 'string'
        ? Bun.color(style.bg, 'number')
        : style.bg;
      setCellBg(cell, bgColor);
    }
    
    // Apply style flags (all in one field now!)
    if (style?.bold) cell[CELL_STYLE] |= STYLE_BOLD;
    if (style?.italic) cell[CELL_STYLE] |= STYLE_ITALIC;
    if (style?.underline) cell[CELL_STYLE] |= STYLE_UNDERLINE;
    if (style?.strikethrough) cell[CELL_STYLE] |= STYLE_STRIKETHROUGH;
    if (style?.inverse) cell[CELL_STYLE] |= STYLE_INVERSE;
    if (style?.blink) cell[CELL_STYLE] |= STYLE_BLINK;
    if (style?.dim) cell[CELL_STYLE] |= STYLE_DIM;
    if (style?.overline) cell[CELL_STYLE] |= STYLE_OVERLINE;
  }
  
  /**
   * Render the current frame and return ANSI diff
   */
  render(): string {
    // Create diff buffer
    const diffBuffer = createBuffer(this.rows, this.cols);
    
    if (!this.previousBuffer) {
      // First frame - everything is new
      for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
          copyCell(this.currentBuffer[row][col], diffBuffer[row][col]);
        }
      }
    } else {
      // Compare buffers and create diff
      for (let row = 0; row < this.rows; row++) {
        for (let col = 0; col < this.cols; col++) {
          const prevCell = this.previousBuffer[row][col];
          const currCell = this.currentBuffer[row][col];
          
          if (!cellsEqual(prevCell, currCell)) {
            // If previous cell had content but current doesn't, we need to clear it
            const prevEmpty = isCellEmpty(prevCell);
            const currEmpty = isCellEmpty(currCell);
            
            if (!prevEmpty && currEmpty) {
              // Create a space character to clear the cell
              const clearCell = createNullCell();
              setCellChar(clearCell, ' ');
              // Copy style from current cell (in case background changed)
              clearCell[CELL_FG] = currCell[CELL_FG];
              clearCell[CELL_BG] = currCell[CELL_BG];
              clearCell[CELL_STYLE] = currCell[CELL_STYLE];
              copyCell(clearCell, diffBuffer[row][col]);
            } else {
              // Normal change, copy current cell
              copyCell(currCell, diffBuffer[row][col]);
            }
          }
        }
      }
    }
    
    // Generate ANSI from diff
    const output = this.generator.serialize(diffBuffer);
    
    // Current becomes previous
    this.previousBuffer = this.currentBuffer;
    
    return output;
  }
  
  /**
   * Clean up
   */
  dispose(): void {
    // Nothing to dispose with simple arrays
  }
}