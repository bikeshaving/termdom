/**
 * Clean cell buffer implementation
 * Each cell is represented as a Cell class instance
 */


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

export type CellBuffer = Cell[][];

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

export class Cell {
	grapheme: string;
	fg: number;
	bg: number;
	style: number;

	constructor(grapheme: string = "", cellStyle?: CellStyle) {
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
	 * Create a copy of this cell
	 */
	copy(): Cell {
		const copy = new Cell();
		copy.grapheme = this.grapheme;
		copy.fg = this.fg;
		copy.bg = this.bg;
		copy.style = this.style;
		return copy;
	}

	/**
	 * Check if this cell is empty (no character)
	 */
	isEmpty(): boolean {
		return this.grapheme === "";
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
	 * Create an empty cell
	 */
	static createNull(): Cell {
		return new Cell();
	}
}

/**
 * Create an empty cell buffer
 */
export function createBuffer(rows: number, cols: number): CellBuffer {
	const buffer: CellBuffer = [];
	for (let row = 0; row < rows; row++) {
		const line: Cell[] = [];
		for (let col = 0; col < cols; col++) {
			line.push(Cell.createNull());
		}
		buffer.push(line);
	}
	return buffer;
}

