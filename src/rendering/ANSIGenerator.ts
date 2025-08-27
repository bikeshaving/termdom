/**
 * ANSI Generator - converts cell buffers to minimal ANSI escape sequences
 * Skips null/empty cells (codepoint 0) and only emits content for cells with data
 */

import {
  Cell, CellBuffer,
  CELL_CHAR, CELL_FG, CELL_BG, CELL_STYLE,
  STYLE_INVERSE, STYLE_BOLD, STYLE_UNDERLINE, STYLE_BLINK, 
  STYLE_INVISIBLE, STYLE_STRIKETHROUGH, STYLE_ITALIC, STYLE_DIM, STYLE_OVERLINE, STYLE_WIDE,
  getCellChar, getCellWidth, isCellEmpty, createNullCell
} from './CellBuffer.js';

interface NonEmptyCell {
  row: number;
  col: number;
  cell: Cell;
}

export type ColorDepth = 'ansi' | '256' | 'rgb';

export class ANSIGenerator {
  private _cursorRow: number = 0;
  private _cursorCol: number = 0;
  private _cursorStyle: Cell = createNullCell();
  
  constructor(
    private readonly rows: number,
    private readonly cols: number,
    private readonly colorDepth: ColorDepth = 'rgb'
  ) {}
  
  /**
   * Serialize a cell buffer to ANSI escape sequences
   * Null cells (codepoint 0) are skipped, all other cells (including spaces) are emitted
   */
  serialize(buffer: CellBuffer): string {
    let output = '';
    this._cursorRow = 0;
    this._cursorCol = 0;
    this._cursorStyle = createNullCell();
    
    // Collect all non-empty cells
    const nonEmptyCells: NonEmptyCell[] = [];
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const cell = buffer[row][col];
        if (!isCellEmpty(cell)) {
          nonEmptyCells.push({ row, col, cell });
        }
      }
    }
    
    // Process cells in order, skipping positions occupied by wide characters
    let skipNextCol: number | null = null;
    
    for (const { row, col, cell } of nonEmptyCells) {
      // Skip this cell if it's the second column of a wide character
      if (skipNextCol !== null && row === this._cursorRow && col === skipNextCol) {
        skipNextCol = null;
        continue;
      }
      skipNextCol = null;
      
      // Move cursor if needed
      if (row !== this._cursorRow || col !== this._cursorCol) {
        output += this._moveCursor(row, col);
      }
      
      // Apply style changes
      const sgrSeq = this._diffStyle(cell, this._cursorStyle);
      if (sgrSeq.length > 0) {
        output += `\x1b[${sgrSeq.join(';')}m`;
        this._cursorStyle = [...cell] as Cell;
      }
      
      // Write character
      output += getCellChar(cell);
      
      // Handle wide characters - they occupy 2 columns
      const cellWidth = getCellWidth(cell);
      this._cursorCol += cellWidth;
      
      // If this is a wide character, skip the next column position
      if ((cell[CELL_STYLE] & STYLE_WIDE) && cellWidth === 2) {
        skipNextCol = col + 1;
      }
    }
    
    return output;
  }
  
  private _moveCursor(targetRow: number, targetCol: number): string {
    let output = '';
    
    const rowDiff = targetRow - this._cursorRow;
    const colDiff = targetCol - this._cursorCol;
    
    // Handle row movement
    if (rowDiff > 0) {
      // Moving down
      if (targetCol === 0 && this._cursorCol > 0) {
        // Use \r\n for efficiency when moving to start of next lines
        output += '\r\n'.repeat(rowDiff);
        this._cursorRow = targetRow;
        this._cursorCol = 0;
        return output;
      } else {
        output += `\x1b[${rowDiff}B`;
      }
    } else if (rowDiff < 0) {
      output += `\x1b[${-rowDiff}A`;
    }
    
    // Handle column movement
    if (targetCol !== this._cursorCol || rowDiff !== 0) {
      if (targetCol === 0) {
        output += '\r';
      } else if (targetCol > this._cursorCol) {
        output += `\x1b[${targetCol - this._cursorCol}C`;
      } else if (targetCol < this._cursorCol) {
        output += `\x1b[${this._cursorCol - targetCol}D`;
      } else if (rowDiff !== 0) {
        // Row changed but column same - need to set absolute position
        output += `\x1b[${targetCol}G`;
      }
    }
    
    this._cursorRow = targetRow;
    this._cursorCol = targetCol;
    
    return output;
  }
  
  private _isAttributeDefault(cell: Cell): boolean {
    return cell[CELL_FG] === 0 && cell[CELL_BG] === 0 && cell[CELL_STYLE] === 0;
  }
  
  private _diffStyle(cell: Cell, oldCell: Cell): number[] {
    const seq: number[] = [];
    
    const fgChanged = cell[CELL_FG] !== oldCell[CELL_FG];
    const bgChanged = cell[CELL_BG] !== oldCell[CELL_BG];
    const styleChanged = cell[CELL_STYLE] !== oldCell[CELL_STYLE];
    
    if (!fgChanged && !bgChanged && !styleChanged) {
      return seq;
    }
    
    // Check if resetting to default
    if (this._isAttributeDefault(cell)) {
      if (!this._isAttributeDefault(oldCell)) {
        seq.push(0);
      }
      return seq;
    }
    
    // Handle foreground color changes
    if (fgChanged) {
      const fgColor = cell[CELL_FG];
      
      if (fgColor === 0) {
        seq.push(39); // Default foreground
      } else {
        // Emit color based on color depth setting
        this._emitColor(seq, fgColor, true);
      }
    }
    
    // Handle background color changes
    if (bgChanged) {
      const bgColor = cell[CELL_BG];
      
      if (bgColor === 0) {
        seq.push(49); // Default background
      } else {
        // Emit color based on color depth setting
        this._emitColor(seq, bgColor, false);
      }
    }
    
    // Handle style changes (all flags in one field now!)
    if (styleChanged) {
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_BOLD, 1, 22);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_DIM, 2, 22);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_ITALIC, 3, 23);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_UNDERLINE, 4, 24);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_BLINK, 5, 25);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_INVERSE, 7, 27);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_INVISIBLE, 8, 28);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_STRIKETHROUGH, 9, 29);
      this._diffFlags(seq, cell[CELL_STYLE], oldCell[CELL_STYLE], STYLE_OVERLINE, 53, 55);
    }
    
    return seq;
  }
  
  private _emitColor(seq: number[], color: number, isFg: boolean): void {
    const prefix = isFg ? 38 : 48;
    
    switch (this.colorDepth) {
      case 'rgb':
        // Use Bun.color for RGB mode
        const rgbCode = Bun.color(color, 'ansi-16m');
        if (rgbCode) {
          const match = rgbCode.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m$/);
          if (match) {
            const [, r, g, b] = match.map(Number);
            seq.push(prefix, 2, r, g, b);
          }
        }
        break;
      
      case '256':
        // Use Bun.color for 256-color mode  
        const color256Code = Bun.color(color, 'ansi-256');
        if (color256Code) {
          const match = color256Code.match(/\x1b\[38;5;(\d+)m$/);
          if (match) {
            const colorIndex = Number(match[1]);
            seq.push(prefix, 5, colorIndex);
          }
        }
        break;
      
      case 'ansi':
        // Use Bun.color for basic ANSI (falls back to 256-color)
        const ansiCode = Bun.color(color, 'ansi');  
        if (ansiCode) {
          const match = ansiCode.match(/\x1b\[38;5;(\d+)m$/);
          if (match) {
            // Convert to basic 8 colors by masking
            const colorIndex = Number(match[1]) & 7;
            seq.push((isFg ? 30 : 40) + colorIndex);
          }
        }
        break;
    }
  }
  
  private _diffFlags(seq: number[], flags: number, oldFlags: number, mask: number, on: number, off: number): void {
    if ((flags & mask) !== (oldFlags & mask)) {
      seq.push((flags & mask) ? on : off);
    }
  }
}