/**
 * Clean cell buffer implementation
 * Each cell is represented as a Cell class instance
 */

import LRUCache from "../lru.js";


// Style flags (internal implementation)
const STYLE_BOLD = 1 << 0;
const STYLE_ITALIC = 1 << 1;
const STYLE_UNDERLINE = 1 << 2;
const STYLE_STRIKETHROUGH = 1 << 3;
const STYLE_INVERSE = 1 << 4;
const STYLE_BLINK = 1 << 5;
const STYLE_DIM = 1 << 6;
const STYLE_INVISIBLE = 1 << 7;
const STYLE_OVERLINE = 1 << 8;

export type CellBuffer = (Cell | null)[][];

export interface CellStyle {
	fg?: number;
	bg?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
	dim?: boolean;
	blink?: boolean;
	overline?: boolean;
}

const cache = new LRUCache<string, Cell>(2 ** 12);

export class Cell {
	declare grapheme: string;
	declare fg: number;
	declare bg: number;
	declare style: number;

	// LRU cache for Cell interning (matrix rain proof!)
	constructor(grapheme: string, cellStyle?: CellStyle) {
		if (grapheme === "") {
			throw new Error("Cell grapheme cannot be empty - use null for empty cells");
		}

		this.grapheme = grapheme;
		this.fg = cellStyle?.fg ?? 0;
		this.bg = cellStyle?.bg ?? 0;

		// Convert boolean flags to bit flags
		let styleFlags = 0;
		if (cellStyle?.bold) styleFlags |= STYLE_BOLD;
		if (cellStyle?.italic) styleFlags |= STYLE_ITALIC;
		if (cellStyle?.underline) styleFlags |= STYLE_UNDERLINE;
		if (cellStyle?.strikethrough) styleFlags |= STYLE_STRIKETHROUGH;
		if (cellStyle?.inverse) styleFlags |= STYLE_INVERSE;
		if (cellStyle?.blink) styleFlags |= STYLE_BLINK;
		if (cellStyle?.dim) styleFlags |= STYLE_DIM;
		if (cellStyle?.overline) styleFlags |= STYLE_OVERLINE;
		this.style = styleFlags;

		// Freeze for immutability - crucial for interning!
		Object.freeze(this);
	}

	/**
	 * Check if this cell equals another (including character)
	 */
	equals(other: Cell): boolean {
		return (
			this.grapheme === other.grapheme &&
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.style === other.style
		);
	}

	/**
	 * Check if this cell has the same style as another (ignoring character)
	 * Useful for identifying runs of text with the same formatting
	 */
	styleEquals(other: Cell): boolean {
		return (
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.style === other.style
		);
	}

	/**
	 * Check if this cell represents a wide character (occupies 2 columns)
	 */
	get isWide(): boolean {
		return this.grapheme ? Bun.stringWidth(this.grapheme) > 1 : false;
	}

	/**
	 * Get the display width of this cell
	 */
	get width(): number {
		return this.grapheme ? Bun.stringWidth(this.grapheme) : 0;
	}

	/**
	 * Get the cell's style flags as boolean properties
	 */
	getStyleFlags() {
		return {
			bold: (this.style & STYLE_BOLD) !== 0,
			italic: (this.style & STYLE_ITALIC) !== 0,
			underline: (this.style & STYLE_UNDERLINE) !== 0,
			strikethrough: (this.style & STYLE_STRIKETHROUGH) !== 0,
			inverse: (this.style & STYLE_INVERSE) !== 0,
			blink: (this.style & STYLE_BLINK) !== 0,
			dim: (this.style & STYLE_DIM) !== 0,
			overline: (this.style & STYLE_OVERLINE) !== 0,
		};
	}

	/**
	 * Factory method for creating cells with automatic interning
	 * This is the preferred way to create Cell instances
	 */
	static create(grapheme: string, cellStyle?: CellStyle): Cell {
		// Create cache key from grapheme and style properties
		const fg = cellStyle?.fg ?? 0;
		const bg = cellStyle?.bg ?? 0;

		let styleFlags = 0;
		if (cellStyle?.bold) styleFlags |= STYLE_BOLD;
		if (cellStyle?.italic) styleFlags |= STYLE_ITALIC;
		if (cellStyle?.underline) styleFlags |= STYLE_UNDERLINE;
		if (cellStyle?.strikethrough) styleFlags |= STYLE_STRIKETHROUGH;
		if (cellStyle?.inverse) styleFlags |= STYLE_INVERSE;
		if (cellStyle?.blink) styleFlags |= STYLE_BLINK;
		if (cellStyle?.dim) styleFlags |= STYLE_DIM;
		if (cellStyle?.overline) styleFlags |= STYLE_OVERLINE;

		const cacheKey = `${grapheme}:${fg}:${bg}:${styleFlags}`;

		// Check cache first
		const cached = cache.get(cacheKey);
		if (cached) {
			return cached;
		}

		// Create new instance and cache it
		const cell = new Cell(grapheme, cellStyle);
		cache.set(cacheKey, cell);
		return cell;
	}
}

/**
 * Create an empty cell buffer
 */
export function createBuffer(rows: number, cols: number): CellBuffer {
	const buffer: CellBuffer = [];
	for (let row = 0; row < rows; row++) {
		const line: (Cell | null)[] = [];
		for (let col = 0; col < cols; col++) {
			line.push(null);
		}
		buffer.push(line);
	}
	return buffer;
}

