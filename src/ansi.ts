import LRUCache from "./utils.js";
import {BOX_DRAWING, BorderEdgeStyle} from "./styles.js";

export type ColorDepth = "ansi" | "rgb" | "256";

const enum Color {
	Mask = 0xffffff,
}

const enum FGStyle {
	Bold = 0b00000001 << 24,
	Italic = 0b00000010 << 24,
	Underline = 0b00000100 << 24,
	Strikethrough = 0b00001000 << 24,
	Overline = 0b00010000 << 24,
}

const enum BGStyle {
	Inverse = 0b00000001 << 24,
	Blink = 0b00000010 << 24,
	Dim = 0b00000100 << 24,
}

const enum BorderMask {
	Top = 0x000000ff,
	Right = 0x0000ff00,
	Bottom = 0x00ff0000,
	Left = 0xff000000,
	Edge = 0xff,
	Style = 0b00001111,
}

const enum BorderShift {
	Top = 0,
	Right = 8,
	Bottom = 16,
	Left = 24,
}

// Example per-edge values
// const EDGE_NONE = BorderEdgeStyle.None;
// const EDGE_SOLID = BorderEdgeStyle.Solid;
// const EDGE_SOLID_ROUNDED = BorderEdgeStyle.Solid | BorderEdgeStyle.Rounded;
const BORDER_EDGE_MASKS = [
	{shift: BorderShift.Top, mask: BorderMask.Top},
	{shift: BorderShift.Right, mask: BorderMask.Right},
	{shift: BorderShift.Bottom, mask: BorderMask.Bottom},
	{shift: BorderShift.Left, mask: BorderMask.Left},
];

// Edge extraction utilities
const getBorderEdge = (border: number, mask: number) => {
	// Find which byte position this mask represents
	const shift = Math.log2(mask & -mask); // Get position of lowest set bit
	return (border & mask) >> shift;
};
const setBorderEdge = (border: number, mask: number, edgeValue: number) => {
	// Find which byte position this mask represents
	const shift = Math.log2(mask & -mask); // Get position of lowest set bit
	return (border & ~mask) | ((edgeValue << shift) & mask);
};

// Style extraction from edge
const getEdgeStyle = (edgeValue: number) => edgeValue & BorderMask.Style;
const getEdgePresence = (edgeValue: number) => {
	const style = edgeValue & BorderMask.Style;
	return style !== BorderEdgeStyle.None && style !== BorderEdgeStyle.Hidden;
};
const getEdgeRounded = (edgeValue: number) =>
	(edgeValue & BorderEdgeStyle.Rounded) !== 0;

// Border style precedence is now based on bit position
// No need for a precedence map - higher value = higher priority!

/**
 * Merge two border encodings, choosing the higher precedence style for each edge
 */
export function mergeBorderEncodings(
	existing: number,
	incoming: number,
): number {
	let merged = 0;

	// Process each edge
	for (const {mask} of BORDER_EDGE_MASKS) {
		const existingEdge = getBorderEdge(existing, mask);
		const incomingEdge = getBorderEdge(incoming, mask);

		// If only one has the edge, use it
		if (!getEdgePresence(existingEdge)) {
			merged = setBorderEdge(merged, mask, incomingEdge);
		} else if (!getEdgePresence(incomingEdge)) {
			merged = setBorderEdge(merged, mask, existingEdge);
		} else {
			// Both have the edge - choose based on style priority (bit value)
			const existingStyle = getEdgeStyle(existingEdge);
			const incomingStyle = getEdgeStyle(incomingEdge);

			// Direct comparison - higher bit value = higher priority
			if (incomingStyle > existingStyle) {
				merged = setBorderEdge(merged, mask, incomingEdge);
			} else {
				merged = setBorderEdge(merged, mask, existingEdge);
			}
		}
	}

	return merged;
}

export type CellBuffer = Array<Array<Cell | null>>;

export interface CellStyle {
	grapheme?: string;
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
	border?: number;
}

export interface BorderStyle {
	top?: {width: number; style: "solid" | "double" | "none"; color?: number};
	right?: {width: number; style: "solid" | "double" | "none"; color?: number};
	bottom?: {
		width: number;
		style: "solid" | "double" | "none";
		color?: number;
	};
	left?: {width: number; style: "solid" | "double" | "none"; color?: number};
}

const cache = new LRUCache<string, Cell>(2 ** 12);

export class Cell {
	declare grapheme: string;
	declare fg: number; // RGB color (24-bit) + style flags (8-bit)
	declare bg: number; // RGB color (24-bit) + style flags (8-bit)
	declare border: number;

	constructor(options: string | CellStyle) {
		let grapheme: string;
		let cellStyle: CellStyle | undefined;

		if (typeof options === "string") {
			grapheme = options;
			cellStyle = undefined;
		} else {
			grapheme = options.grapheme ?? "┼";
			cellStyle = options;
		}

		if (grapheme === "") {
			throw new Error(
				"Cell grapheme cannot be empty - use null for empty cells",
			);
		}

		this.grapheme = grapheme;

		// Pack fg color and style flags into fg field
		let fg = (cellStyle?.fg ?? 0) & Color.Mask;
		if (cellStyle?.bold) fg |= FGStyle.Bold;
		if (cellStyle?.italic) fg |= FGStyle.Italic;
		if (cellStyle?.underline) fg |= FGStyle.Underline;
		if (cellStyle?.strikethrough) fg |= FGStyle.Strikethrough;
		if (cellStyle?.overline) fg |= FGStyle.Overline;
		this.fg = fg;

		// Pack bg color and style flags into bg field
		let bg = (cellStyle?.bg ?? 0) & Color.Mask;
		if (cellStyle?.inverse) bg |= BGStyle.Inverse;
		if (cellStyle?.blink) bg |= BGStyle.Blink;
		if (cellStyle?.dim) bg |= BGStyle.Dim;
		this.bg = bg;

		this.border = cellStyle?.border ?? 0;

		Object.freeze(this);
	}

	equals(other: Cell): boolean {
		return (
			this.grapheme === other.grapheme &&
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.border === other.border
		);
	}

	styleEquals(other: Cell): boolean {
		return (
			this.fg === other.fg &&
			this.bg === other.bg &&
			this.border === other.border
		);
	}

	get isWide(): boolean {
		return this.grapheme ? Bun.stringWidth(this.grapheme) > 1 : false;
	}

	get width(): number {
		return this.grapheme ? Bun.stringWidth(this.grapheme) : 0;
	}

	getStyleFlags() {
		return {
			bold: (this.fg & FGStyle.Bold) !== 0,
			italic: (this.fg & FGStyle.Italic) !== 0,
			underline: (this.fg & FGStyle.Underline) !== 0,
			strikethrough: (this.fg & FGStyle.Strikethrough) !== 0,
			overline: (this.fg & FGStyle.Overline) !== 0,
			inverse: (this.bg & BGStyle.Inverse) !== 0,
			blink: (this.bg & BGStyle.Blink) !== 0,
			dim: (this.bg & BGStyle.Dim) !== 0,
		};
	}

	getFgColor(): number {
		return this.fg & Color.Mask;
	}

	getBgColor(): number {
		return this.bg & Color.Mask;
	}

	static create(options: string | CellStyle): Cell | null {
		let grapheme: string;
		let cellStyle: CellStyle | undefined;

		if (typeof options === "string") {
			if (options === "") return null;
			grapheme = options;
			cellStyle = undefined;
		} else {
			grapheme = options.grapheme ?? "┼";
			if (grapheme === "") return null;
			cellStyle = options;
		}

		// Pack style flags into fg/bg fields for caching
		let fg = (cellStyle?.fg ?? 0) & Color.Mask;
		if (cellStyle?.bold) fg |= FGStyle.Bold;
		if (cellStyle?.italic) fg |= FGStyle.Italic;
		if (cellStyle?.underline) fg |= FGStyle.Underline;
		if (cellStyle?.strikethrough) fg |= FGStyle.Strikethrough;
		if (cellStyle?.overline) fg |= FGStyle.Overline;

		let bg = (cellStyle?.bg ?? 0) & Color.Mask;
		if (cellStyle?.inverse) bg |= BGStyle.Inverse;
		if (cellStyle?.blink) bg |= BGStyle.Blink;
		if (cellStyle?.dim) bg |= BGStyle.Dim;

		const border = cellStyle?.border ?? 0;
		const cacheKey = `${grapheme}:${fg}:${bg}:${border}`;

		const cached = cache.get(cacheKey);
		if (cached) {
			return cached;
		}

		const cell = new Cell(options);
		cache.set(cacheKey, cell);
		return cell;
	}
}

export function createBuffer(rows: number, cols: number): CellBuffer {
	const buffer: CellBuffer = [];
	for (let row = 0; row < rows; row++) {
		const line: Array<Cell | null> = [];
		for (let col = 0; col < cols; col++) {
			line.push(null);
		}
		buffer.push(line);
	}
	return buffer;
}

export interface RendererCellStyle {
	fg?: number | null;
	bg?: number | null;
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
	// Track which lines have been rendered to clear them on first use
	private renderedLines: Set<number> = new Set();
	// Track viewport offset for scroll command generation
	private currentViewportOffset: number = 0;
	private previousViewportOffset: number = 0;

	constructor(
		private rows: number,
		private cols: number,
		private readonly colorDepth: ColorDepth = "rgb",
	) {
		this.currentBuffer = createBuffer(rows, cols);
	}

	resize(rows: number, cols: number): void {
		this.rows = rows;
		this.cols = cols;
	}

	clearPreviousBuffer(): void {
		this.previousBuffer = null;
		this.currentViewportOffset = 0;
		this.previousViewportOffset = 0;
	}

	private clearLine(y: number): void {
		if (y < 0 || y >= this.rows) return;
		const row = this.currentBuffer[y];
		for (let x = 0; x < this.cols; x++) {
			row[x] = new Cell(" ");
		}
	}

	beginFrame(viewportOffset: number = 0): void {
		this.previousViewportOffset = this.currentViewportOffset;
		this.currentViewportOffset = viewportOffset;
		this.currentBuffer = createBuffer(this.rows, this.cols);
	}

	private setCell(
		row: number,
		col: number,
		char: string,
		style?: RendererCellStyle,
	): void {
		// Apply viewport offset to transform layout coordinates to terminal coordinates
		const terminalRow = row + this.currentViewportOffset;

		// Clip to terminal bounds - only render visible cells
		if (
			terminalRow < 0 ||
			terminalRow >= this.rows ||
			col < 0 ||
			col >= this.cols
		)
			return;

		row = terminalRow;

		let finalStyle = style;
		if (style && style.bg == null) {
			const existingCell = this.currentBuffer[row][col];
			if (existingCell) {
				finalStyle = {...style, bg: existingCell.bg};
			}
		}

		// Convert RendererCellStyle to CellStyle by filtering out null values
		const cellStyle: CellStyle | undefined = finalStyle
			? {
					fg: finalStyle.fg ?? undefined,
					bg: finalStyle.bg ?? undefined,
					bold: finalStyle.bold,
					italic: finalStyle.italic,
					underline: finalStyle.underline,
					strikethrough: finalStyle.strikethrough,
					inverse: finalStyle.inverse,
					dim: finalStyle.dim,
					blink: finalStyle.blink,
					overline: finalStyle.overline,
				}
			: undefined;

		const newCell = Cell.create({
			grapheme: char,
			...cellStyle,
		});
		this.currentBuffer[row][col] = newCell;

		// Wide character handling is done by the ANSI renderer's skipNextCol logic
		// Leave continuation positions as null - the terminal handles emoji width automatically
	}

	fillRect(
		x: number,
		y: number,
		width: number,
		height: number,
		bgColor?: number | null,
	): void {
		if (bgColor == null) {
			return;
		}

		const style: RendererCellStyle = {bg: bgColor};

		for (let row = y; row < y + height; row++) {
			for (let col = x; col < x + width; col++) {
				// setCell will handle viewport offset transformation and clipping
				this.setCell(row, col, " ", style);
			}
		}
	}

	drawBorder(
		x: number,
		y: number,
		width: number,
		height: number,
		borderStyles: {
			topEdge: number;
			rightEdge: number;
			bottomEdge: number;
			leftEdge: number;
			hasAnyBorder: boolean;
		},
		style?: RendererCellStyle,
	): void {
		// Don't render if rect is too small
		if (width < 2 || height < 2 || !borderStyles.hasAnyBorder) return;

		const right = x + width - 1;
		const bottom = y + height - 1;

		// Top edge
		if (borderStyles.topEdge > 0 && y >= 0 && y < this.rows) {
			for (let col = x; col <= right; col++) {
				if (col >= 0 && col < this.cols) {
					const cornerLeft = col === x && borderStyles.leftEdge > 0;
					const cornerRight = col === right && borderStyles.rightEdge > 0;
					const encoding = this.calculateEdgeEncoding(
						borderStyles,
						true, // hasTop
						cornerRight,
						false, // hasBottom
						cornerLeft,
					);
					this.setBorderCell(col, y, encoding, style);
				}
			}
		}

		// Bottom edge
		if (
			borderStyles.bottomEdge > 0 &&
			bottom !== y &&
			bottom >= 0 &&
			bottom < this.rows
		) {
			for (let col = x; col <= right; col++) {
				if (col >= 0 && col < this.cols) {
					const cornerLeft = col === x && borderStyles.leftEdge > 0;
					const cornerRight = col === right && borderStyles.rightEdge > 0;
					const encoding = this.calculateEdgeEncoding(
						borderStyles,
						false, // hasTop
						cornerRight,
						true, // hasBottom
						cornerLeft,
					);
					this.setBorderCell(col, bottom, encoding, style);
				}
			}
		}

		// Left edge (excluding corners)
		if (borderStyles.leftEdge > 0 && x >= 0 && x < this.cols) {
			for (let row = y + 1; row < bottom; row++) {
				if (row >= 0 && row < this.rows) {
					const encoding = this.calculateEdgeEncoding(
						borderStyles,
						false, // hasTop
						false, // hasRight
						false, // hasBottom
						true, // hasLeft
					);
					this.setBorderCell(x, row, encoding, style);
				}
			}
		}

		// Right edge (excluding corners)
		if (
			borderStyles.rightEdge > 0 &&
			right !== x &&
			right >= 0 &&
			right < this.cols
		) {
			for (let row = y + 1; row < bottom; row++) {
				if (row >= 0 && row < this.rows) {
					const encoding = this.calculateEdgeEncoding(
						borderStyles,
						false, // hasTop
						true, // hasRight
						false, // hasBottom
						false, // hasLeft
					);
					this.setBorderCell(right, row, encoding, style);
				}
			}
		}
	}

	private calculateEdgeEncoding(
		borderStyles: {
			topEdge: number;
			rightEdge: number;
			bottomEdge: number;
			leftEdge: number;
		},
		hasTop: boolean,
		hasRight: boolean,
		hasBottom: boolean,
		hasLeft: boolean,
	): number {
		// Encode which edges are present for this specific cell position
		let encoding = 0;

		if (hasTop && borderStyles.topEdge > 0) {
			encoding |= borderStyles.topEdge << BorderShift.Top;
		}
		if (hasRight && borderStyles.rightEdge > 0) {
			encoding |= borderStyles.rightEdge << BorderShift.Right;
		}
		if (hasBottom && borderStyles.bottomEdge > 0) {
			encoding |= borderStyles.bottomEdge << BorderShift.Bottom;
		}
		if (hasLeft && borderStyles.leftEdge > 0) {
			encoding |= borderStyles.leftEdge << BorderShift.Left;
		}

		return encoding;
	}

	private setBorderCell(
		x: number,
		y: number,
		borderEncoding: number,
		style?: RendererCellStyle,
	): void {
		// Apply viewport offset to transform layout coordinates to terminal coordinates
		const terminalY = y + this.currentViewportOffset;

		// Clip to terminal bounds
		if (terminalY < 0 || terminalY >= this.rows || x < 0 || x >= this.cols) {
			return;
		}

		y = terminalY;

		const buffer = this.currentBuffer;
		const existingCell = buffer[y][x];

		if (existingCell && existingCell.border > 0) {
			// Merge the border encodings using precedence rules
			const mergedBorder = mergeBorderEncodings(
				existingCell.border,
				borderEncoding,
			);
			buffer[y][x] = new Cell({
				grapheme: " ", // Space placeholder - renderer will determine correct character
				fg: style?.fg ?? undefined,
				bg: style?.bg ?? undefined,
				bold: style?.bold,
				italic: style?.italic,
				underline: style?.underline,
				strikethrough: style?.strikethrough,
				inverse: style?.inverse,
				dim: style?.dim,
				blink: style?.blink,
				overline: style?.overline,
				border: mergedBorder,
			});
		} else {
			// No existing border - just set the new one
			buffer[y][x] = new Cell({
				grapheme: " ", // Space placeholder - renderer will determine correct character
				fg: style?.fg ?? undefined,
				bg: style?.bg ?? undefined,
				bold: style?.bold,
				italic: style?.italic,
				underline: style?.underline,
				strikethrough: style?.strikethrough,
				inverse: style?.inverse,
				dim: style?.dim,
				blink: style?.blink,
				overline: style?.overline,
				border: borderEncoding,
			});
		}
	}

	setText(
		x: number,
		y: number,
		text: string,
		style?: RendererCellStyle,
	): number {
		let currentX = x;
		const segmenter = new Intl.Segmenter("en", {granularity: "grapheme"});
		const segments = Array.from(segmenter.segment(text));

		for (const segment of segments) {
			const char = segment.segment;
			const width = Bun.stringWidth(char);

			if (currentX + width > this.cols) {
				break;
			}

			this.setCell(y, currentX, char, style);
			currentX += width;
		}

		return currentX;
	}

	/**
	 * Generate ANSI scroll commands based on viewport offset changes
	 */
	private generateScrollCommands(): string {
		// Don't generate scroll commands if there's no previous buffer (first frame)
		if (!this.previousBuffer) {
			return "";
		}

		const offsetDelta =
			this.currentViewportOffset - this.previousViewportOffset;

		// No change, no scroll needed
		if (offsetDelta === 0) {
			return "";
		}

		// Positive offset means content moved down (viewport scrolled down)
		// Use scroll down command \x1b[nS
		if (offsetDelta > 0) {
			return `\x1b[${offsetDelta}S`;
		}

		// Negative offset means content moved up (viewport scrolled up)
		// Use scroll up command \x1b[nT
		else {
			return `\x1b[${Math.abs(offsetDelta)}T`;
		}
	}

	/**
	 * Transform the previous buffer to mirror terminal scroll behavior
	 * This optimizes diffs by only showing actual content changes
	 */
	private transformBufferForScroll(): void {
		if (!this.previousBuffer) return;

		const offsetDelta =
			this.currentViewportOffset - this.previousViewportOffset;
		if (offsetDelta === 0) return;

		// Create new buffer with same dimensions
		const transformedBuffer = createBuffer(this.rows, this.cols);

		if (offsetDelta > 0) {
			// Scrolling down: move content up (shift rows up)
			this.scrollBufferUp(this.previousBuffer, transformedBuffer, offsetDelta);
		} else {
			// Scrolling up: move content down (shift rows down)
			this.scrollBufferDown(
				this.previousBuffer,
				transformedBuffer,
				Math.abs(offsetDelta),
			);
		}

		this.previousBuffer = transformedBuffer;
	}

	/**
	 * Scroll buffer content up by shifting rows upward and clearing bottom rows
	 */
	private scrollBufferUp(
		source: CellBuffer,
		dest: CellBuffer,
		lines: number,
	): void {
		// Copy rows shifted up
		for (let row = 0; row < this.rows; row++) {
			const sourceRow = row + lines;
			if (sourceRow < this.rows) {
				// Copy existing row shifted up
				for (let col = 0; col < this.cols; col++) {
					dest[row][col] = source[sourceRow][col];
				}
			} else {
				// Bottom rows become null (cleared)
				for (let col = 0; col < this.cols; col++) {
					dest[row][col] = null;
				}
			}
		}
	}

	/**
	 * Scroll buffer content down by shifting rows downward and clearing top rows
	 */
	private scrollBufferDown(
		source: CellBuffer,
		dest: CellBuffer,
		lines: number,
	): void {
		// Copy rows shifted down
		for (let row = this.rows - 1; row >= 0; row--) {
			const sourceRow = row - lines;
			if (sourceRow >= 0) {
				// Copy existing row shifted down
				for (let col = 0; col < this.cols; col++) {
					dest[row][col] = source[sourceRow][col];
				}
			} else {
				// Top rows become null (cleared)
				for (let col = 0; col < this.cols; col++) {
					dest[row][col] = null;
				}
			}
		}
	}

	render(): string {
		// Transform previous buffer to mirror terminal scroll behavior
		// This must happen before diffing to optimize output
		this.transformBufferForScroll();

		const diffBuffer = createBuffer(this.rows, this.cols);

		if (!this.previousBuffer) {
			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					const currCell = this.currentBuffer[row][col];
					diffBuffer[row][col] = currCell;
				}
			}
		} else {
			const prevRows = this.previousBuffer.length;
			const prevCols = this.previousBuffer[0]?.length || 0;

			for (let row = 0; row < this.rows; row++) {
				for (let col = 0; col < this.cols; col++) {
					const prevCell =
						row < prevRows && col < prevCols
							? this.previousBuffer[row][col]
							: null;
					const currCell = this.currentBuffer[row][col];

					if (prevCell === null && currCell === null) {
						continue;
					}

					if (prevCell === null && currCell !== null) {
						diffBuffer[row][col] = currCell;
						continue;
					}

					if (prevCell !== null && currCell === null) {
						diffBuffer[row][col] = Cell.create(" ");
						continue;
					}

					if (!prevCell!.equals(currCell!)) {
						diffBuffer[row][col] = currCell!;
					}
				}
			}
		}

		// Generate scroll commands based on viewport offset changes
		const scrollCommands = this.generateScrollCommands();

		const output = generateANSI(
			diffBuffer,
			this.colorDepth,
			false, // clean
			this.renderedLines,
			scrollCommands,
		);
		this.previousBuffer = this.currentBuffer;
		return output;
	}
}

/**
 * Generate the appropriate box-drawing character for a cell based on its border encoding
 * Uses per-edge encoding to determine proper junction characters
 */
export function getBorderChar(borderEncoding: number): string {
	// Extract edge information
	const topEdge = getBorderEdge(borderEncoding, BorderMask.Top);
	const rightEdge = getBorderEdge(borderEncoding, BorderMask.Right);
	const bottomEdge = getBorderEdge(borderEncoding, BorderMask.Bottom);
	const leftEdge = getBorderEdge(borderEncoding, BorderMask.Left);

	// Check which edges are present (have non-zero style)
	const hasTop = getEdgePresence(topEdge);
	const hasRight = getEdgePresence(rightEdge);
	const hasBottom = getEdgePresence(bottomEdge);
	const hasLeft = getEdgePresence(leftEdge);

	// If no edges, return space
	if (!hasTop && !hasRight && !hasBottom && !hasLeft) {
		return " ";
	}

	// Determine dominant style for character set selection
	// Priority: double > solid > groove > ridge > dashed > dotted
	const styles = [
		hasTop ? getEdgeStyle(topEdge) : 0,
		hasRight ? getEdgeStyle(rightEdge) : 0,
		hasBottom ? getEdgeStyle(bottomEdge) : 0,
		hasLeft ? getEdgeStyle(leftEdge) : 0,
	].filter((s) => s > 0);

	const dominantStyle = Math.max(...styles);
	const hasRounded =
		(hasTop && getEdgeRounded(topEdge)) ||
		(hasRight && getEdgeRounded(rightEdge)) ||
		(hasBottom && getEdgeRounded(bottomEdge)) ||
		(hasLeft && getEdgeRounded(leftEdge));

	let charSet;
	switch (dominantStyle) {
		case BorderEdgeStyle.Solid:
			charSet = hasRounded ? BOX_DRAWING.lightRounded : BOX_DRAWING.light;
			break;
		case BorderEdgeStyle.Double:
			charSet = BOX_DRAWING.double;
			break;
		case BorderEdgeStyle.Dashed:
			charSet = BOX_DRAWING.dashed;
			break;
		case BorderEdgeStyle.Dotted:
			charSet = BOX_DRAWING.dotted;
			break;
		case BorderEdgeStyle.Groove:
			charSet = BOX_DRAWING.heavy;
			break;
		case BorderEdgeStyle.Ridge:
			charSet = BOX_DRAWING.light;
			break;
		case BorderEdgeStyle.Inset:
		case BorderEdgeStyle.Outset:
			charSet = hasRounded ? BOX_DRAWING.lightRounded : BOX_DRAWING.light;
			break;
		case BorderEdgeStyle.Hidden:
		case BorderEdgeStyle.None:
			return " ";
		default:
			charSet = BOX_DRAWING.light;
			break;
	}

	// Corner characters
	if (hasTop && hasLeft && !hasRight && !hasBottom) {
		return charSet.topLeft; // ┌
	}
	if (hasTop && hasRight && !hasLeft && !hasBottom) {
		return charSet.topRight; // ┐
	}
	if (hasBottom && hasLeft && !hasTop && !hasRight) {
		return charSet.bottomLeft; // └
	}
	if (hasBottom && hasRight && !hasTop && !hasLeft) {
		return charSet.bottomRight; // ┘
	}

	// T-junction characters
	if (hasTop && hasBottom && hasLeft && !hasRight) {
		return charSet.leftTee;
	}
	if (hasTop && hasBottom && hasRight && !hasLeft) {
		return charSet.rightTee;
	}
	if (hasLeft && hasRight && hasTop && !hasBottom) {
		return charSet.bottomTee;
	}
	if (hasLeft && hasRight && hasBottom && !hasTop) {
		return charSet.topTee;
	}

	// Cross junction
	if (hasTop && hasRight && hasBottom && hasLeft) {
		return charSet.cross;
	}

	// Straight lines
	if ((hasTop || hasBottom) && !hasLeft && !hasRight) {
		return charSet.horizontal; // Top/bottom edges use horizontal lines ─
	}
	if ((hasLeft || hasRight) && !hasTop && !hasBottom) {
		return charSet.vertical; // Left/right edges use vertical lines │
	}

	// Default to space for no borders
	return " ";
}

export function generateANSI(
	buffer: CellBuffer,
	colorDepth: ColorDepth = "rgb",
	clean: boolean = false,
	renderedLines?: Set<number>,
	scrollCommands?: string,
): string {
	const rows = buffer.length;
	const cols = buffer[0]?.length || 0;

	let output = "";
	let cursorRow = 0;
	let cursorCol = 0;
	let previousCell: Cell | null = null;
	let hasContent = false;

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			if (buffer[row][col] !== null) {
				hasContent = true;
				break;
			}
		}
		if (hasContent) break;
	}

	if (hasContent && !clean) {
		output += "\x1b[?2026h"; // Synchronized output mode
		output += "\x1b[?25l"; // Hide cursor by default
		output += "\x1b[H"; // Move cursor to home

		// Add scroll commands if provided
		if (scrollCommands) {
			output += scrollCommands;
		}
	}

	const moveCursor = (targetRow: number, targetCol: number): string => {
		let moveOutput = "";
		const rowDiff = targetRow - cursorRow;

		if (rowDiff < 0) {
			throw new Error(
				`Trying to move up from row ${cursorRow} to ${targetRow} - this should never happen in row-major processing`,
			);
		}
		if (targetCol < cursorCol && rowDiff === 0) {
			throw new Error(
				`Trying to move left from col ${cursorCol} to ${targetCol} in row ${cursorRow} - this should never happen`,
			);
		}

		if (rowDiff > 0) {
			if (targetCol === 0) {
				moveOutput += "\r\n".repeat(rowDiff);
			} else {
				moveOutput += "\r\n".repeat(rowDiff);
				moveOutput += `\x1b[${targetCol}C`;
			}
		} else if (targetCol !== cursorCol) {
			if (targetCol === 0) {
				moveOutput += "\r";
			} else {
				moveOutput += `\x1b[${targetCol - cursorCol}C`;
			}
		}

		cursorRow = targetRow;
		cursorCol = targetCol;
		return moveOutput;
	};

	const emitColor = (color: number, isFg: boolean): number[] => {
		const prefix = isFg ? 38 : 48;
		const seq: number[] = [];

		switch (colorDepth) {
			case "rgb": {
				const r = (color >> 16) & 0xff;
				const g = (color >> 8) & 0xff;
				const b = color & 0xff;
				seq.push(prefix, 2, r, g, b);
				break;
			}
			case "256": {
				const colorIndex = rgbTo256(color);
				seq.push(prefix, 5, colorIndex);
				break;
			}
			case "ansi": {
				const basicColor = rgbToBasic8(color);
				seq.push((isFg ? 30 : 40) + basicColor);
				break;
			}
		}
		return seq;
	};

	const rgbTo256 = (color: number): number => {
		const r = (color >> 16) & 0xff;
		const g = (color >> 8) & 0xff;
		const b = color & 0xff;

		if (r === g && g === b) {
			if (r < 8) return 0;
			if (r > 248) return 15;
			return Math.round(((r - 8) / 247) * 23) + 232;
		}

		const r6 = Math.round((r / 255) * 5);
		const g6 = Math.round((g / 255) * 5);
		const b6 = Math.round((b / 255) * 5);
		return 16 + 36 * r6 + 6 * g6 + b6;
	};

	const rgbToBasic8 = (color: number): number => {
		const r = (color >> 16) & 0xff;
		const g = (color >> 8) & 0xff;
		const b = color & 0xff;

		let ansiColor = 0;
		if (r > 127) ansiColor |= 1;
		if (g > 127) ansiColor |= 2;
		if (b > 127) ansiColor |= 4;
		return ansiColor;
	};

	const getStyleDiff = (cell: Cell, prev: Cell | null): number[] => {
		if (!prev) {
			const seq: number[] = [];

			const fgColor = cell.getFgColor();
			const bgColor = cell.getBgColor();

			if (fgColor !== 0) {
				seq.push(...emitColor(fgColor, true));
			}
			if (bgColor !== 0) {
				seq.push(...emitColor(bgColor, false));
			}

			const flags = cell.getStyleFlags();
			if (flags.bold) seq.push(1);
			if (flags.dim) seq.push(2);
			if (flags.italic) seq.push(3);
			if (flags.underline) seq.push(4);
			if (flags.blink) seq.push(5);
			if (flags.inverse) seq.push(7);
			if (flags.strikethrough) seq.push(9);
			if (flags.overline) seq.push(53);

			return seq;
		}

		if (cell.styleEquals(prev)) {
			return [];
		}

		const seq: number[] = [];
		const isDefault = cell.fg === 0 && cell.bg === 0;
		const wasDefault = prev.fg === 0 && prev.bg === 0;

		if (isDefault && !wasDefault) {
			seq.push(0);
			return seq;
		}

		if (cell.fg !== prev.fg) {
			const fgColor = cell.getFgColor();
			if (fgColor === 0) {
				seq.push(39);
			} else {
				seq.push(...emitColor(fgColor, true));
			}
		}

		if (cell.bg !== prev.bg) {
			const bgColor = cell.getBgColor();
			if (bgColor === 0) {
				seq.push(49);
			} else {
				seq.push(...emitColor(bgColor, false));
			}
		}

		if (cell.fg !== prev.fg || cell.bg !== prev.bg) {
			const cellFlags = cell.getStyleFlags();
			const prevFlags = prev.getStyleFlags();

			const diffFlag = (
				current: boolean,
				old: boolean,
				on: number,
				off: number,
			) => {
				if (current !== old) {
					seq.push(current ? on : off);
				}
			};

			diffFlag(cellFlags.bold, prevFlags.bold, 1, 22);
			diffFlag(cellFlags.dim, prevFlags.dim, 2, 22);
			diffFlag(cellFlags.italic, prevFlags.italic, 3, 23);
			diffFlag(cellFlags.underline, prevFlags.underline, 4, 24);
			diffFlag(cellFlags.blink, prevFlags.blink, 5, 25);
			diffFlag(cellFlags.inverse, prevFlags.inverse, 7, 27);
			diffFlag(cellFlags.strikethrough, prevFlags.strikethrough, 9, 29);
			diffFlag(cellFlags.overline, prevFlags.overline, 53, 55);
		}

		return seq;
	};

	let skipNextCol: number | null = null;

	for (let row = 0; row < rows; row++) {
		let rowHasContent = false;
		let rowHasAnsi = false;
		let isFirstRenderOfLine = false;

		// Check if this line has any content to determine if we need to process it
		for (let col = 0; col < cols; col++) {
			if (buffer[row][col] !== null) {
				rowHasContent = true;
				break;
			}
		}

		// If this line has content and we're tracking rendered lines
		if (rowHasContent && renderedLines) {
			isFirstRenderOfLine = !renderedLines.has(row);
			if (isFirstRenderOfLine) {
				renderedLines.add(row);
			}
		}

		for (let col = 0; col < cols; col++) {
			const cell = buffer[row][col];

			if (cell === null) {
				continue;
			}

			if (skipNextCol !== null && row === cursorRow && col === skipNextCol) {
				skipNextCol = null;
				continue;
			}

			skipNextCol = null;

			if (row !== cursorRow || col !== cursorCol) {
				const moveSeq = moveCursor(row, col);
				output += moveSeq;
			}

			// Clear line on first render for interactive terminal behavior
			if (isFirstRenderOfLine) {
				// Move to column 0 and clear entire line
				output += "\r\x1b[K";
				// Move back to where we need to be
				if (col > 0) {
					output += `\x1b[${col}C`;
				}
				cursorCol = col; // Update cursor tracking
				isFirstRenderOfLine = false; // Prevent clearing again on this row
			}

			const styleSeq = getStyleDiff(cell, previousCell);
			if (styleSeq.length > 0) {
				output += `\x1b[${styleSeq.join(";")}m`;
				rowHasAnsi = true;
			}

			// Use border character if cell has border, otherwise use grapheme
			let charToOutput;
			if (cell.border > 0) {
				charToOutput = getBorderChar(cell.border);
			} else {
				charToOutput = cell.grapheme;
			}

			output += charToOutput;
			cursorCol += cell.width;
			previousCell = cell;

			if (cell.width === 2) {
				skipNextCol = col + 1;
			}
		}

		if (rowHasContent) {
			previousCell = null;
			if (rowHasAnsi) {
				output += "\x1b[0m";
			}
		}
	}

	if (hasContent && !clean) {
		output += "\x1b[?25h"; // Restore cursor
		output += "\x1b[?2026l"; // Exit synchronized output mode
	}

	// Always end with newline for proper terminal output
	if (hasContent && !output.endsWith("\n")) {
		output += "\n";
	}

	return output;
}
