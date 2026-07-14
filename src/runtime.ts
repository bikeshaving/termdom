/**
 * Runtime abstraction layer for Bun-specific APIs.
 * Provides fallbacks for Node.js and Deno environments.
 */

// Detect runtime
const isBun = typeof globalThis.Bun !== "undefined";
const isDeno = typeof (globalThis as any).Deno !== "undefined";

/**
 * Get the display width of a string in terminal columns.
 * Uses Bun.stringWidth when available, otherwise falls back to a pure-JS
 * implementation that agrees with it.
 */
export function stringWidth(str: string): number {
	if (isBun) {
		return Bun.stringWidth(str);
	}

	return stringWidthFallback(str);
}

/**
 * Pure-JS string width, used on runtimes without Bun.
 *
 * Exported so tests can hold it against Bun.stringWidth directly: under Bun the
 * branch above means this code never runs, so nothing else would catch it
 * drifting. It has to agree exactly -- width drives wrapping and cell
 * alignment, so a disagreement silently misrenders text on Node and Deno only.
 */
export function stringWidthFallback(str: string): number {
	// Width is a property of the grapheme cluster, not the code point: a ZWJ
	// emoji family and a combining accent are each one cluster occupying one
	// cell's worth of base character, however many code points they contain.
	if (segmenter) {
		let width = 0;
		for (const {segment} of segmenter.segment(str)) {
			width += graphemeWidth(segment);
		}
		return width;
	}

	// No Intl.Segmenter: fall back to per-code-point, which mismeasures
	// clusters but keeps ASCII and plain CJK correct.
	let width = 0;
	for (const char of str) {
		width += graphemeWidth(char);
	}
	return width;
}

const segmenter =
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
		? new Intl.Segmenter("en", {granularity: "grapheme"})
		: null;

/** Display width of a single grapheme cluster, in terminal cells. */
function graphemeWidth(cluster: string): number {
	const code = cluster.codePointAt(0)!;

	if (code === 0) return 0;
	// Control characters
	if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;

	// A U+FE0F *after* the base requests emoji presentation, which is two cells
	// even when the base is narrow on its own (\u2764 is one cell, \u2764\uFE0F is
	// two). It promotes any non-ASCII base; an ASCII one stays narrow ("b\uFE0F"
	// is one cell). Testing for it after the base rather than anywhere in the
	// cluster is what keeps a cluster *led* by a bare U+FE0F from promoting
	// itself -- that one is not a base at all and falls through to zero width.
	if (code >= 0x80 && cluster.indexOf("\uFE0F") > 0) {
		return 2;
	}

	// Otherwise the base carries the width, and a cluster led by a combining
	// mark or a lone variation selector occupies no cells.
	if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;

	// Two regional indicators form a flag, which renders as two cells; a lone
	// one is a narrow letter. The segmenter clusters them in pairs for us.
	if (code >= 0x1f1e6 && code <= 0x1f1ff) {
		return Array.from(cluster).length > 1 ? 2 : 1;
	}

	if (inRanges(code, WIDE_RANGES)) return 2;

	return 1;
}

/**
 * Parse a CSS color string to a numeric RGBA value.
 * Uses Bun.color when available, otherwise falls back to a basic parser.
 */
export function cssColorToNumber(cssColor: string): number | null {
	if (isBun) {
		return Bun.color(cssColor, "number") ?? null;
	}

	return parseColor(cssColor);
}

/**
 * Codepoint ranges that occupy two terminal cells (East Asian Wide and
 * Fullwidth, plus default-emoji-presentation symbols).
 *
 * Sorted and non-overlapping, searched by bisection. Generated from the
 * Unicode East Asian Width data so that the fallback agrees with
 * Bun.stringWidth exactly -- a mismatch here silently misaligns every
 * wrapped line and table border on runtimes without Bun.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x20e3, 0x20e3],
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x2e80, 0x2e99],
	[0x2e9b, 0x2ef3],
	[0x2f00, 0x2fd5],
	[0x2ff0, 0x303e],
	[0x3041, 0x3096],
	[0x3099, 0x30ff],
	[0x3105, 0x312f],
	[0x3131, 0x318e],
	[0x3190, 0x31e3],
	[0x31ef, 0x321e],
	[0x3220, 0x3247],
	[0x3250, 0x4dbf],
	[0x4e00, 0xa48c],
	[0xa490, 0xa4c6],
	[0xa960, 0xa97c],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe52],
	[0xfe54, 0xfe66],
	[0xfe68, 0xfe6b],
	[0xff01, 0xff60],
	[0xffe0, 0xffe6],
	[0x16fe0, 0x16fe4],
	[0x16ff0, 0x16ff1],
	[0x17000, 0x187f7],
	[0x18800, 0x18cd5],
	[0x18d00, 0x18d08],
	[0x1aff0, 0x1aff3],
	[0x1aff5, 0x1affb],
	[0x1affd, 0x1affe],
	[0x1b000, 0x1b122],
	[0x1b132, 0x1b132],
	[0x1b150, 0x1b152],
	[0x1b155, 0x1b155],
	[0x1b164, 0x1b167],
	[0x1b170, 0x1b2fb],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f202],
	[0x1f210, 0x1f23b],
	[0x1f240, 0x1f248],
	[0x1f250, 0x1f251],
	[0x1f260, 0x1f265],
	[0x1f300, 0x1f320],
	[0x1f32d, 0x1f335],
	[0x1f337, 0x1f37c],
	[0x1f37e, 0x1f393],
	[0x1f3a0, 0x1f3ca],
	[0x1f3cf, 0x1f3d3],
	[0x1f3e0, 0x1f3f0],
	[0x1f3f4, 0x1f3f4],
	[0x1f3f8, 0x1f43e],
	[0x1f440, 0x1f440],
	[0x1f442, 0x1f4fc],
	[0x1f4ff, 0x1f53d],
	[0x1f54b, 0x1f54e],
	[0x1f550, 0x1f567],
	[0x1f57a, 0x1f57a],
	[0x1f595, 0x1f596],
	[0x1f5a4, 0x1f5a4],
	[0x1f5fb, 0x1f64f],
	[0x1f680, 0x1f6c5],
	[0x1f6cc, 0x1f6cc],
	[0x1f6d0, 0x1f6d2],
	[0x1f6d5, 0x1f6d7],
	[0x1f6dc, 0x1f6df],
	[0x1f6eb, 0x1f6ec],
	[0x1f6f4, 0x1f6fc],
	[0x1f7e0, 0x1f7eb],
	[0x1f7f0, 0x1f7f0],
	[0x1f90c, 0x1f93a],
	[0x1f93c, 0x1f945],
	[0x1f947, 0x1f9ff],
	[0x1fa70, 0x1fa7c],
	[0x1fa80, 0x1fa88],
	[0x1fa90, 0x1fabd],
	[0x1fabf, 0x1fac5],
	[0x1face, 0x1fadb],
	[0x1fae0, 0x1fae8],
	[0x1faf0, 0x1faf8],
	[0x20000, 0x2fffd],
	[0x30000, 0x3fffd],
];

/** Codepoint ranges that occupy no cells: combining marks, joiners, format characters. */
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0xad, 0xad],
	[0x300, 0x36f],
	[0x600, 0x605],
	[0x6dd, 0x6dd],
	[0x70f, 0x70f],
	[0x8e2, 0x8e2],
	[0x900, 0x902],
	[0x93a, 0x93c],
	[0x93e, 0x94d],
	[0x951, 0x957],
	[0x962, 0x963],
	[0x980, 0x982],
	[0x9ba, 0x9bc],
	[0x9be, 0x9cd],
	[0x9d1, 0x9d7],
	[0x9e2, 0x9e3],
	[0xa00, 0xa02],
	[0xa3a, 0xa3c],
	[0xa3e, 0xa4d],
	[0xa51, 0xa57],
	[0xa62, 0xa63],
	[0xa80, 0xa82],
	[0xaba, 0xabc],
	[0xabe, 0xacd],
	[0xad1, 0xad7],
	[0xae2, 0xae3],
	[0xb00, 0xb02],
	[0xb3a, 0xb3c],
	[0xb3e, 0xb4d],
	[0xb51, 0xb57],
	[0xb62, 0xb63],
	[0xb80, 0xb82],
	[0xbba, 0xbbc],
	[0xbbe, 0xbcd],
	[0xbd1, 0xbd7],
	[0xbe2, 0xbe3],
	[0xc00, 0xc02],
	[0xc3a, 0xc3c],
	[0xc3e, 0xc4d],
	[0xc51, 0xc57],
	[0xc62, 0xc63],
	[0xc80, 0xc82],
	[0xcba, 0xcbc],
	[0xcbe, 0xccd],
	[0xcd1, 0xcd7],
	[0xce2, 0xce3],
	[0xd00, 0xd02],
	[0xd3a, 0xd3c],
	[0xd3e, 0xd4d],
	[0xe31, 0xe31],
	[0xe34, 0xe3a],
	[0xe47, 0xe4e],
	[0xeb1, 0xeb1],
	[0xeb4, 0xebc],
	[0xec8, 0xecd],
	[0x1ab0, 0x1aff],
	[0x1dc0, 0x1dff],
	[0x200b, 0x200f],
	[0x2060, 0x2064],
	[0x20d0, 0x20e2],
	[0x20e4, 0x20ff],
	[0xfe00, 0xfe0f],
	[0xfe20, 0xfe2f],
	[0xfeff, 0xfeff],
];

/** Bisect a sorted, non-overlapping range table. */
function inRanges(
	code: number,
	ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
	let low = 0;
	let high = ranges.length - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const [start, end] = ranges[mid];
		if (code < start) {
			high = mid - 1;
		} else if (code > end) {
			low = mid + 1;
		} else {
			return true;
		}
	}
	return false;
}

// Named CSS colors (subset of most common)
// Named CSS colors - 24-bit RGB (0xRRGGBB) to match Bun.color("...", "number")
const NAMED_COLORS: Record<string, number> = {
	black: 0x000000,
	white: 0xffffff,
	red: 0xff0000,
	green: 0x008000,
	blue: 0x0000ff,
	yellow: 0xffff00,
	cyan: 0x00ffff,
	magenta: 0xff00ff,
	orange: 0xffa500,
	purple: 0x800080,
	pink: 0xffc0cb,
	gray: 0x808080,
	grey: 0x808080,
	silver: 0xc0c0c0,
	maroon: 0x800000,
	olive: 0x808000,
	lime: 0x00ff00,
	aqua: 0x00ffff,
	teal: 0x008080,
	navy: 0x000080,
	fuchsia: 0xff00ff,
	transparent: 0x000000,
};

function parseColor(color: string): number | null {
	color = color.trim().toLowerCase();

	// Named colors
	if (color in NAMED_COLORS) {
		return NAMED_COLORS[color];
	}

	// Hex colors - return 24-bit RGB
	if (color.startsWith("#")) {
		const hex = color.slice(1);
		let r: number, g: number, b: number;
		if (hex.length === 3 || hex.length === 4) {
			r = parseInt(hex[0] + hex[0], 16);
			g = parseInt(hex[1] + hex[1], 16);
			b = parseInt(hex[2] + hex[2], 16);
		} else if (hex.length === 6 || hex.length === 8) {
			r = parseInt(hex.slice(0, 2), 16);
			g = parseInt(hex.slice(2, 4), 16);
			b = parseInt(hex.slice(4, 6), 16);
		} else {
			return null;
		}
		if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
		return (r << 16) | (g << 8) | b;
	}

	// rgb()/rgba()
	const rgbMatch = color.match(
		/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/,
	);
	if (rgbMatch) {
		const r = parseInt(rgbMatch[1], 10);
		const g = parseInt(rgbMatch[2], 10);
		const b = parseInt(rgbMatch[3], 10);
		return (r << 16) | (g << 8) | b;
	}

	return null;
}

// Export runtime detection for conditional logic
export {isBun, isDeno};
