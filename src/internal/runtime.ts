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
 * Parse a CSS color string to 24-bit RGB (0xRRGGBB), or null if unrecognized.
 */
export function cssColorToNumber(cssColor: string): number | null {
	return parseColorFallback(cssColor);
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

// Named CSS colors, 24-bit RGB (0xRRGGBB), matching Bun.color(name, "number").
// Generated from Bun.color so the two agree exactly.
const NAMED_COLORS: Record<string, number> = {
	aliceblue: 0xf0f8ff,
	antiquewhite: 0xfaebd7,
	aqua: 0x00ffff,
	aquamarine: 0x7fffd4,
	azure: 0xf0ffff,
	beige: 0xf5f5dc,
	bisque: 0xffe4c4,
	black: 0x000000,
	blanchedalmond: 0xffebcd,
	blue: 0x0000ff,
	blueviolet: 0x8a2be2,
	brown: 0xa52a2a,
	burlywood: 0xdeb887,
	cadetblue: 0x5f9ea0,
	chartreuse: 0x7fff00,
	chocolate: 0xd2691e,
	coral: 0xff7f50,
	cornflowerblue: 0x6495ed,
	cornsilk: 0xfff8dc,
	crimson: 0xdc143c,
	cyan: 0x00ffff,
	darkblue: 0x00008b,
	darkcyan: 0x008b8b,
	darkgoldenrod: 0xb8860b,
	darkgray: 0xa9a9a9,
	darkgreen: 0x006400,
	darkgrey: 0xa9a9a9,
	darkkhaki: 0xbdb76b,
	darkmagenta: 0x8b008b,
	darkolivegreen: 0x556b2f,
	darkorange: 0xff8c00,
	darkorchid: 0x9932cc,
	darkred: 0x8b0000,
	darksalmon: 0xe9967a,
	darkseagreen: 0x8fbc8f,
	darkslateblue: 0x483d8b,
	darkslategray: 0x2f4f4f,
	darkslategrey: 0x2f4f4f,
	darkturquoise: 0x00ced1,
	darkviolet: 0x9400d3,
	deeppink: 0xff1493,
	deepskyblue: 0x00bfff,
	dimgray: 0x696969,
	dimgrey: 0x696969,
	dodgerblue: 0x1e90ff,
	firebrick: 0xb22222,
	floralwhite: 0xfffaf0,
	forestgreen: 0x228b22,
	fuchsia: 0xff00ff,
	gainsboro: 0xdcdcdc,
	ghostwhite: 0xf8f8ff,
	gold: 0xffd700,
	goldenrod: 0xdaa520,
	gray: 0x808080,
	green: 0x008000,
	greenyellow: 0xadff2f,
	grey: 0x808080,
	honeydew: 0xf0fff0,
	hotpink: 0xff69b4,
	indianred: 0xcd5c5c,
	indigo: 0x4b0082,
	ivory: 0xfffff0,
	khaki: 0xf0e68c,
	lavender: 0xe6e6fa,
	lavenderblush: 0xfff0f5,
	lawngreen: 0x7cfc00,
	lemonchiffon: 0xfffacd,
	lightblue: 0xadd8e6,
	lightcoral: 0xf08080,
	lightcyan: 0xe0ffff,
	lightgoldenrodyellow: 0xfafad2,
	lightgray: 0xd3d3d3,
	lightgreen: 0x90ee90,
	lightgrey: 0xd3d3d3,
	lightpink: 0xffb6c1,
	lightsalmon: 0xffa07a,
	lightseagreen: 0x20b2aa,
	lightskyblue: 0x87cefa,
	lightslategray: 0x778899,
	lightslategrey: 0x778899,
	lightsteelblue: 0xb0c4de,
	lightyellow: 0xffffe0,
	lime: 0x00ff00,
	limegreen: 0x32cd32,
	linen: 0xfaf0e6,
	magenta: 0xff00ff,
	maroon: 0x800000,
	mediumaquamarine: 0x66cdaa,
	mediumblue: 0x0000cd,
	mediumorchid: 0xba55d3,
	mediumpurple: 0x9370db,
	mediumseagreen: 0x3cb371,
	mediumslateblue: 0x7b68ee,
	mediumspringgreen: 0x00fa9a,
	mediumturquoise: 0x48d1cc,
	mediumvioletred: 0xc71585,
	midnightblue: 0x191970,
	mintcream: 0xf5fffa,
	mistyrose: 0xffe4e1,
	moccasin: 0xffe4b5,
	navajowhite: 0xffdead,
	navy: 0x000080,
	oldlace: 0xfdf5e6,
	olive: 0x808000,
	olivedrab: 0x6b8e23,
	orange: 0xffa500,
	orangered: 0xff4500,
	orchid: 0xda70d6,
	palegoldenrod: 0xeee8aa,
	palegreen: 0x98fb98,
	paleturquoise: 0xafeeee,
	palevioletred: 0xdb7093,
	papayawhip: 0xffefd5,
	peachpuff: 0xffdab9,
	peru: 0xcd853f,
	pink: 0xffc0cb,
	plum: 0xdda0dd,
	powderblue: 0xb0e0e6,
	purple: 0x800080,
	rebeccapurple: 0x663399,
	red: 0xff0000,
	rosybrown: 0xbc8f8f,
	royalblue: 0x4169e1,
	saddlebrown: 0x8b4513,
	salmon: 0xfa8072,
	sandybrown: 0xf4a460,
	seagreen: 0x2e8b57,
	seashell: 0xfff5ee,
	sienna: 0xa0522d,
	silver: 0xc0c0c0,
	skyblue: 0x87ceeb,
	slateblue: 0x6a5acd,
	slategray: 0x708090,
	slategrey: 0x708090,
	snow: 0xfffafa,
	springgreen: 0x00ff7f,
	steelblue: 0x4682b4,
	tan: 0xd2b48c,
	teal: 0x008080,
	thistle: 0xd8bfd8,
	tomato: 0xff6347,
	transparent: 0x000000,
	turquoise: 0x40e0d0,
	violet: 0xee82ee,
	wheat: 0xf5deb3,
	white: 0xffffff,
	whitesmoke: 0xf5f5f5,
	yellow: 0xffff00,
	yellowgreen: 0x9acd32,
};

/**
 * Parse a CSS color to 24-bit RGB (0xRRGGBB): named colors, #hex, rgb()/rgba(),
 * and hsl()/hsla(). Returns null for anything unrecognized.
 */
export function parseColorFallback(color: string): number | null {
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

	// hsl()/hsla()
	const hslMatch = color.match(
		/hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+%?)?\s*\)/,
	);
	if (hslMatch) {
		const h = ((parseFloat(hslMatch[1]) % 360) + 360) % 360;
		const s = Math.min(100, Math.max(0, parseFloat(hslMatch[2]))) / 100;
		const l = Math.min(100, Math.max(0, parseFloat(hslMatch[3]))) / 100;
		const c = (1 - Math.abs(2 * l - 1)) * s;
		const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
		const m = l - c / 2;
		let r1 = 0,
			g1 = 0,
			b1 = 0;
		if (h < 60) [r1, g1, b1] = [c, x, 0];
		else if (h < 120) [r1, g1, b1] = [x, c, 0];
		else if (h < 180) [r1, g1, b1] = [0, c, x];
		else if (h < 240) [r1, g1, b1] = [0, x, c];
		else if (h < 300) [r1, g1, b1] = [x, 0, c];
		else [r1, g1, b1] = [c, 0, x];
		const r = Math.round((r1 + m) * 255);
		const g = Math.round((g1 + m) * 255);
		const b = Math.round((b1 + m) * 255);
		return (r << 16) | (g << 8) | b;
	}

	return null;
}

// Export runtime detection for conditional logic
export {isBun, isDeno};
