/**
 * Clean cell buffer implementation
 * Each cell is represented as [char, fg, bg, style]
 */

// Cell array indices
export const CELL_CHAR = 0;
export const CELL_FG = 1;
export const CELL_BG = 2;
export const CELL_STYLE = 3;

// Style flags (all in one field)
export const STYLE_BOLD = 1 << 0;
export const STYLE_ITALIC = 1 << 1;
export const STYLE_UNDERLINE = 1 << 2;
export const STYLE_STRIKETHROUGH = 1 << 3;
export const STYLE_INVERSE = 1 << 4;
export const STYLE_BLINK = 1 << 5;
export const STYLE_DIM = 1 << 6;
export const STYLE_INVISIBLE = 1 << 7;
export const STYLE_OVERLINE = 1 << 8;

export type Cell = [string, number, number, number];
export type CellBuffer = Cell[][];

/**
 * Create an empty cell buffer
 */
export function createBuffer(rows: number, cols: number): CellBuffer {
  const buffer: CellBuffer = [];
  for (let row = 0; row < rows; row++) {
    const line: Cell[] = [];
    for (let col = 0; col < cols; col++) {
      line.push(createNullCell());
    }
    buffer.push(line);
  }
  return buffer;
}

/**
 * Create a null (empty) cell
 */
export function createNullCell(): Cell {
  return ['', 0, 0, 0];
}

/**
 * Check if a cell is empty
 */
export function isCellEmpty(cell: Cell): boolean {
  return cell[CELL_CHAR] === '';
}

/**
 * Get character from cell
 */
export function getCellChar(cell: Cell): string {
  return cell[CELL_CHAR];
}

/**
 * Get cell width (using Bun.stringWidth)
 */
export function getCellWidth(cell: Cell): number {
  return cell[CELL_CHAR] ? Bun.stringWidth(cell[CELL_CHAR]) : 0;
}

/**
 * Set cell character
 */
export function setCellChar(cell: Cell, char: string): void {
  cell[CELL_CHAR] = char;
}

/**
 * Set cell foreground color (24-bit RGB)
 */
export function setCellFg(cell: Cell, color: number): void {
  cell[CELL_FG] = color & 0xFFFFFF;
}

/**
 * Set cell background color (24-bit RGB)
 */
export function setCellBg(cell: Cell, color: number): void {
  cell[CELL_BG] = color & 0xFFFFFF;
}

/**
 * Copy cell data
 */
export function copyCell(src: Cell, dest: Cell): void {
  dest[CELL_CHAR] = src[CELL_CHAR];
  dest[CELL_FG] = src[CELL_FG];
  dest[CELL_BG] = src[CELL_BG];
  dest[CELL_STYLE] = src[CELL_STYLE];
}

/**
 * Check if two cells are equal
 */
export function cellsEqual(cell1: Cell, cell2: Cell): boolean {
  return cell1[CELL_CHAR] === cell2[CELL_CHAR] &&
         cell1[CELL_FG] === cell2[CELL_FG] &&
         cell1[CELL_BG] === cell2[CELL_BG] &&
         cell1[CELL_STYLE] === cell2[CELL_STYLE];
}