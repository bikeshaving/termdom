/**
 * The terminal's understanding of a run of text: how wide it is, where its
 * grapheme clusters break, and which direction it flows.
 *
 * A renderer that addresses cells has to answer all three before it can place a
 * character, so they live together, and depend on nothing else.
 */

import bidiFactory from "bidi-js";
import arabicPersianReshaper from "arabic-persian-reshaper";

// Bun is the only runtime with a native fast path worth branching on; Node
// and Deno both take the pure-JS fallback, so neither needs detecting.
const isBun = typeof globalThis.Bun !== "undefined";

/**
 * Combining marks and format characters -- the two Unicode categories whose
 * members add no advance of their own, because they render onto the character
 * before them (Hebrew niqqud, Arabic harakat, Cyrillic and Devanagari
 * diacritics) or are invisible controls.
 *
 * Their presence is the one thing that makes Bun.stringWidth unusable, so this
 * gate is the cheapest question that separates the two paths: matching it costs
 * ~0.03us on ASCII, against 2.2us for taking the slow path unconditionally.
 */
const COMBINING = /[\p{M}\p{Cf}]/u;

/**
 * Every other LRU cache in the JavaScript ecosystem is insane.
 *
 * Two generations instead of per-hit reordering: a young-generation hit is
 * one Map.get and moves nothing. When the young generation fills it becomes
 * the old one and the previous old generation drops wholesale; a key still
 * wanted is promoted on its next hit. Recency is approximate, the bound is
 * exact: at most 2x the limit is ever held.
 */
export class LRUCache<TKey, TValue> {
	declare limit: number;
	declare map: Map<TKey, TValue>;
	declare old: Map<TKey, TValue>;

	constructor(limit: number) {
		if (limit <= 0) {
			throw new TypeError("limit must be positive");
		}
		this.limit = limit;
		this.map = new Map();
		this.old = new Map();
	}

	get(key: TKey): TValue | undefined {
		const val = this.map.get(key);
		// The has() check only disambiguates a stored undefined from a miss.
		if (val !== undefined || this.map.has(key)) {
			return val;
		}
		if (this.old.has(key)) {
			const promoted = this.old.get(key)!;
			this.old.delete(key);
			this.set(key, promoted);
			return promoted;
		}
		return undefined;
	}

	set(key: TKey, val: TValue): void {
		if (!this.map.has(key) && this.map.size >= this.limit) {
			this.old = this.map;
			this.map = new Map();
		}
		this.map.set(key, val);
	}

	has(key: TKey): boolean {
		return this.map.has(key) || this.old.has(key);
	}

	delete(key: TKey): boolean {
		const young = this.map.delete(key);
		const old = this.old.delete(key);
		return young || old;
	}

	clear(): void {
		this.map.clear();
		this.old.clear();
	}

	get size(): number {
		return this.map.size + this.old.size;
	}

	* keys(): IterableIterator<TKey> {
		yield* this.map.keys();
		for (const key of this.old.keys()) {
			if (!this.map.has(key)) {
				yield key;
			}
		}
	}

	* values(): IterableIterator<TValue> {
		for (const [, value] of this) {
			yield value;
		}
	}

	* entries(): IterableIterator<[TKey, TValue]> {
		yield* this.map.entries();
		for (const entry of this.old.entries()) {
			if (!this.map.has(entry[0])) {
				yield entry;
			}
		}
	}

	[Symbol.iterator](): IterableIterator<[TKey, TValue]> {
		return this.entries();
	}
}

// Printable ASCII is its own width.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// Width is a pure property of the string. LRU-bounded so an endless stream
// of unique strings (a logger) cannot grow the cache without limit.
const widthCache = new LRUCache<string, number>(2 ** 14);

/**
 * Cluster advances the terminal itself reported, and only those that DISAGREE
 * with the tables below.
 *
 * The tables are a prediction: they say what a conforming terminal ought to do
 * with a cluster, and every terminal has clusters it does otherwise -- an
 * emoji-presentation selector advances one cell in Terminal.app for ☀️ and two
 * for ⛅️, and no rule separates them. The renderer asks (DSR, in frame, once
 * per distinct cluster) and writes the answer here.
 *
 * This is not a cache and must never be treated as one. A cache holds a copy
 * of something derivable and needs invalidating when the original moves; this
 * holds a measurement of the one terminal the process is attached to, taken
 * once, true for as long as that terminal is on the other end. Entries are
 * written once and never rewritten, nothing can make one stale, and there is
 * no clear() -- the process ends and the ledger ends with it. A terminal whose
 * advances match the tables leaves it empty, which is what keeps the fast
 * paths below exactly as fast as they were.
 */
const clusterAdvances = new Map<string, number>();

/**
 * Record the terminal's advance for `cluster`. Answers whether the ledger
 * changed: false when the cluster was already measured (append-only: the first
 * answer stands) or when the terminal agrees with the tables, which is the
 * common case and worth nothing to store.
 */
export function recordClusterAdvance(
	cluster: string,
	advance: number,
): boolean {
	if (clusterAdvances.has(cluster)) {
		return false;
	}
	if (advance === graphemeWidth(cluster)) {
		return false;
	}
	clusterAdvances.set(cluster, advance);
	// Widths answered before this one were answered by the tables alone.
	widthCache.clear();
	return true;
}

/** The measured advance of `cluster`, or undefined where the tables stand. */
export function clusterAdvance(cluster: string): number | undefined {
	return clusterAdvances.get(cluster);
}

/**
 * Emoji by default: a code point that renders as a colour glyph with no
 * selector asking it to. That is the property a terminal disagrees about --
 * whether such a glyph is one cell of text or two of emoji -- and it holds for
 * the regional indicators and skin-tone modifiers too, which are emoji
 * components rather than pictographs but diverge the same way on their own.
 */
const DEFAULT_EMOJI = /\p{Emoji_Presentation}/u;

/**
 * Where DEFAULT_EMOJI can possibly match: the property runs from U+231A to
 * U+2B55 and from U+1F004 to U+1FAF8, with the whole of the CJK, Hangul and
 * compatibility blocks in between holding none of it. Bounding the regex by
 * two compares is what keeps a screenful of ideographs off it.
 */
const DEFAULT_EMOJI_LOW = 0x231a;
const DEFAULT_EMOJI_BMP_HIGH = 0x2b55;
const DEFAULT_EMOJI_ASTRAL_LOW = 0x1f004;
const DEFAULT_EMOJI_HIGH = 0x1faf8;

/**
 * Whether this terminal's advance for `cluster` is worth asking about.
 *
 * Most characters have a width every terminal agrees on, and asking about them
 * spends a query and a reply to be told what the tables already said. What is
 * left over is the divergence zone, and it is small:
 *
 * - Any cluster of more than one code point. A variation selector asks for one
 *   presentation or the other and terminals honour it unevenly; a ZWJ sequence
 *   is one glyph to a terminal that ligates it and several to one that does
 *   not; a regional-indicator pair is a flag or two letters; a skin-tone
 *   modifier is absorbed or advances; and a combining mark is where the
 *   zero-versus-one-cell disagreements live.
 * - East Asian Width Ambiguous, less the scripts whose advance is not in doubt
 *   (see UNCERTAIN_RANGES). Degree signs, arrows, box drawing, block elements,
 *   geometric shapes, private use: one cell in a Latin font, two in a CJK one,
 *   and the terminal's font decides.
 * - Default emoji presentation, the class the ledger exists for.
 * - Arabic presentation forms. Text goes out shaped, and a terminal that
 *   ligates a shaped form advances differently from one that draws it whole.
 *
 * Everything else is trusted: ASCII, the Narrow scripts (Hebrew, Thai, most
 * punctuation), and the definite CJK, kana and Hangul blocks (Wide and
 * Fullwidth are two cells wherever they are drawn) with their halfwidth
 * forms. Latin outside ASCII, Greek and Cyrillic are NOT trusted where the
 * category calls them Ambiguous: an ambiguous-wide emulator advances them
 * two cells.
 *
 * This runs once per painted cell and allocates nothing: a code-point read, a
 * length compare, one bisection, and a regex confined to the two bands that
 * can hold an emoji at all.
 */
export function widthIsUncertain(cluster: string): boolean {
	const code = cluster.codePointAt(0)!;
	// More than the base: a sequence, and sequences are the divergence zone.
	if (cluster.length !== (code > 0xffff ? 2 : 1)) {
		return true;
	}
	// ASCII and the C1 controls, on their own, are one cell or none anywhere.
	if (code < 0xa1) {
		return false;
	}
	if (inRanges(code, UNCERTAIN_RANGES)) {
		return true;
	}
	// Arabic Presentation Forms-A and -B.
	if (code >= 0xfb50 && code <= 0xfdff) {
		return true;
	}
	if (code >= 0xfe70 && code <= 0xfeff) {
		return true;
	}
	if (code < DEFAULT_EMOJI_LOW || code > DEFAULT_EMOJI_HIGH) {
		return false;
	}
	if (code > DEFAULT_EMOJI_BMP_HIGH && code < DEFAULT_EMOJI_ASTRAL_LOW) {
		return false;
	}
	return DEFAULT_EMOJI.test(cluster);
}

/**
 * Get the display width of a string in terminal columns.
 *
 * Bun.stringWidth is faster and is used wherever it is right, which is
 * every string without combining marks. It is NOT right on strings with them:
 * it charges a cell per code point, so "שָׁלוֹם" -- four Hebrew letters carrying
 * three vowel points -- measures 7 instead of 4, and a box drawn round it comes
 * out three cells too wide. Width is a property of the grapheme CLUSTER, and
 * the fallback below is the implementation that knows that.
 */
export function stringWidth(str: string): number {
	if (PRINTABLE_ASCII.test(str)) {
		return str.length;
	}

	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Bun.stringWidth knows the tables, not the ledger, so a session that has
	// learned anything takes the cluster-by-cluster path -- which is where the
	// ledger is consulted. An empty ledger costs one size read.
	const width =
		isBun && clusterAdvances.size === 0 && !COMBINING.test(str) ?
				Bun.stringWidth(str) :
				stringWidthFallback(str);
	widthCache.set(str, width);
	return width;
}

/**
 * Write the per-code-unit widths of `str` into `out`, starting at `offset`.
 *
 * A grapheme cluster's whole width lands on its LAST code unit and every other
 * position of the cluster gets zero, so summing any range whose ends are cluster
 * boundaries gives that substring's width -- the property that lets a cumulative
 * array answer a range measurement in constant time. A range that ends inside a
 * cluster charges nothing for the partial cluster, which is the same answer the
 * cluster-based measurement gives for a fragment with no base character.
 *
 * Terminal cell widths are additive because a cell is a cell: no kerning, no
 * ligature across a break, nothing about the neighbours changes a cluster's
 * column count.
 */
export function writeClusterWidths(
	str: string,
	out: Float64Array,
	offset: number,
): void {
	if (PRINTABLE_ASCII.test(str)) {
		for (let i = 0; i < str.length; i++) {
			out[offset + i] = 1;
		}
		return;
	}

	if (segmenter) {
		for (const {index, segment} of segmenter.segment(str)) {
			out[offset + index + segment.length - 1] = graphemeWidth(segment);
		}
		return;
	}

	// No Intl.Segmenter: per-code-point, the same degradation stringWidthFallback
	// takes.
	let index = 0;
	for (const char of str) {
		index += char.length;
		out[offset + index - 1] = graphemeWidth(char);
	}
}

/**
 * Pure-JS string width, used on runtimes without Bun.
 *
 * Exported so tests can hold it against Bun.stringWidth directly: under Bun the
 * branch above skips this code for most strings, so little else would catch it
 * drifting. The two must agree everywhere Bun is still consulted -- width drives
 * wrapping and cell alignment, so a disagreement misrenders text on Node and
 * Deno only.
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
	typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ?
			new Intl.Segmenter("en", {granularity: "grapheme"}) :
		null;

/**
 * Spacing combining marks (general category Mc). Unlike Mn and Me, which draw
 * onto the character before them, these ADVANCE -- Devanagari's vowel signs are
 * the common case, and POSIX wcwidth gives them a column each by omitting Mc
 * from the zero-width categories.
 */
const SPACING_MARK = /\p{Mc}/gu;

/** Display width of a single grapheme cluster, in terminal cells. */
function graphemeWidth(cluster: string): number {
	// What the terminal was seen to do outranks what the tables say it should.
	if (clusterAdvances.size !== 0) {
		const measured = clusterAdvances.get(cluster);
		if (measured !== undefined) {
			return measured;
		}
	}

	const code = cluster.codePointAt(0)!;

	if (code === 0) {
		return 0;
	}
	// Control characters
	if (code < 32 || (code >= 0x7f && code < 0xa0)) {
		return 0;
	}

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
	if (inRanges(code, ZERO_WIDTH_RANGES)) {
		return 0;
	}

	// Two regional indicators form a flag, which renders as two cells; a lone
	// one is a narrow letter. The segmenter clusters them in pairs for us.
	if (code >= 0x1f1e6 && code <= 0x1f1ff) {
		return Array.from(cluster).length > 1 ? 2 : 1;
	}

	const base = inRanges(code, WIDE_RANGES) ? 2 : 1;

	// The base carries its own width, and every SPACING mark riding with it
	// carries one more. A cluster is one unit for breaking and one unit for the
	// caret, but not necessarily one column: "का" is a letter plus a spacing
	// vowel sign, and occupies two.
	//
	// Counted strictly AFTER the base, never including it -- a lone spacing
	// mark is its own base, and scanning the whole cluster charged it twice.
	const rest = cluster.slice(String.fromCodePoint(code).length);
	if (!rest) {
		return base;
	}
	SPACING_MARK.lastIndex = 0;
	let spacing = 0;
	while (SPACING_MARK.exec(rest) !== null) {
		spacing++;
	}
	return base + spacing;
}

/**
 * Grapheme-cluster boundaries for caret motion and deletion. selectionStart/
 * End stay code-unit indices, as the DOM API requires -- these only snap a
 * one-"character" step onto a boundary, so Backspace deletes a whole emoji
 * rather than half a surrogate pair, and an arrow steps over a combining
 * sequence or ZWJ join as one unit. Rebuilt per keystroke: input values are
 * short and Intl.Segmenter is cheap, so there is no cache to keep coherent.
 */
function graphemeBoundaries(value: string): number[] {
	const boundaries = [0];
	if (segmenter) {
		for (const {index, segment} of segmenter.segment(value)) {
			boundaries.push(index + segment.length);
		}
	} else {
		// No Intl.Segmenter: fall back to code-point boundaries -- a step over a
		// surrogate pair stays whole, though combining sequences split. The same
		// degradation stringWidthFallback takes.
		let i = 0;
		for (const char of value) {
			i += char.length;
			boundaries.push(i);
		}
	}
	return boundaries;
}
/** The first grapheme boundary strictly after `index` (or the end). */
export function nextGraphemeBoundary(value: string, index: number): number {
	for (const boundary of graphemeBoundaries(value)) {
		if (boundary > index) {
			return boundary;
		}
	}
	return value.length;
}
/** The last grapheme boundary strictly before `index` (or the start). */
export function prevGraphemeBoundary(value: string, index: number): number {
	let previous = 0;
	for (const boundary of graphemeBoundaries(value)) {
		if (boundary >= index) {
			break;
		}
		previous = boundary;
	}
	return previous;
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

/**
 * East Asian Width category A, entire: EastAsianWidth-17.0.0.txt, the A
 * lines merged. An ambiguous character is one cell on an ambiguous-narrow
 * emulator and two on an ambiguous-wide one (common in CJK locales), so
 * every member is a width no table can promise -- including the Latin,
 * Greek and Cyrillic letters the category contains.
 */
const UNCERTAIN_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x00a1, 0x00a1],
	[0x00a4, 0x00a4],
	[0x00a7, 0x00a8],
	[0x00aa, 0x00aa],
	[0x00ad, 0x00ae],
	[0x00b0, 0x00b4],
	[0x00b6, 0x00ba],
	[0x00bc, 0x00bf],
	[0x00c6, 0x00c6],
	[0x00d0, 0x00d0],
	[0x00d7, 0x00d8],
	[0x00de, 0x00e1],
	[0x00e6, 0x00e6],
	[0x00e8, 0x00ea],
	[0x00ec, 0x00ed],
	[0x00f0, 0x00f0],
	[0x00f2, 0x00f3],
	[0x00f7, 0x00fa],
	[0x00fc, 0x00fc],
	[0x00fe, 0x00fe],
	[0x0101, 0x0101],
	[0x0111, 0x0111],
	[0x0113, 0x0113],
	[0x011b, 0x011b],
	[0x0126, 0x0127],
	[0x012b, 0x012b],
	[0x0131, 0x0133],
	[0x0138, 0x0138],
	[0x013f, 0x0142],
	[0x0144, 0x0144],
	[0x0148, 0x014b],
	[0x014d, 0x014d],
	[0x0152, 0x0153],
	[0x0166, 0x0167],
	[0x016b, 0x016b],
	[0x01ce, 0x01ce],
	[0x01d0, 0x01d0],
	[0x01d2, 0x01d2],
	[0x01d4, 0x01d4],
	[0x01d6, 0x01d6],
	[0x01d8, 0x01d8],
	[0x01da, 0x01da],
	[0x01dc, 0x01dc],
	[0x0251, 0x0251],
	[0x0261, 0x0261],
	[0x02c4, 0x02c4],
	[0x02c7, 0x02c7],
	[0x02c9, 0x02cb],
	[0x02cd, 0x02cd],
	[0x02d0, 0x02d0],
	[0x02d8, 0x02db],
	[0x02dd, 0x02dd],
	[0x02df, 0x02df],
	[0x0300, 0x036f],
	[0x0391, 0x03a1],
	[0x03a3, 0x03a9],
	[0x03b1, 0x03c1],
	[0x03c3, 0x03c9],
	[0x0401, 0x0401],
	[0x0410, 0x044f],
	[0x0451, 0x0451],
	[0x2010, 0x2010],
	[0x2013, 0x2016],
	[0x2018, 0x2019],
	[0x201c, 0x201d],
	[0x2020, 0x2022],
	[0x2024, 0x2027],
	[0x2030, 0x2030],
	[0x2032, 0x2033],
	[0x2035, 0x2035],
	[0x203b, 0x203b],
	[0x203e, 0x203e],
	[0x2074, 0x2074],
	[0x207f, 0x207f],
	[0x2081, 0x2084],
	[0x20ac, 0x20ac],
	[0x2103, 0x2103],
	[0x2105, 0x2105],
	[0x2109, 0x2109],
	[0x2113, 0x2113],
	[0x2116, 0x2116],
	[0x2121, 0x2122],
	[0x2126, 0x2126],
	[0x212b, 0x212b],
	[0x2153, 0x2154],
	[0x215b, 0x215e],
	[0x2160, 0x216b],
	[0x2170, 0x2179],
	[0x2189, 0x2189],
	[0x2190, 0x2199],
	[0x21b8, 0x21b9],
	[0x21d2, 0x21d2],
	[0x21d4, 0x21d4],
	[0x21e7, 0x21e7],
	[0x2200, 0x2200],
	[0x2202, 0x2203],
	[0x2207, 0x2208],
	[0x220b, 0x220b],
	[0x220f, 0x220f],
	[0x2211, 0x2211],
	[0x2215, 0x2215],
	[0x221a, 0x221a],
	[0x221d, 0x2220],
	[0x2223, 0x2223],
	[0x2225, 0x2225],
	[0x2227, 0x222c],
	[0x222e, 0x222e],
	[0x2234, 0x2237],
	[0x223c, 0x223d],
	[0x2248, 0x2248],
	[0x224c, 0x224c],
	[0x2252, 0x2252],
	[0x2260, 0x2261],
	[0x2264, 0x2267],
	[0x226a, 0x226b],
	[0x226e, 0x226f],
	[0x2282, 0x2283],
	[0x2286, 0x2287],
	[0x2295, 0x2295],
	[0x2299, 0x2299],
	[0x22a5, 0x22a5],
	[0x22bf, 0x22bf],
	[0x2312, 0x2312],
	[0x2460, 0x24e9],
	[0x24eb, 0x254b],
	[0x2550, 0x2573],
	[0x2580, 0x258f],
	[0x2592, 0x2595],
	[0x25a0, 0x25a1],
	[0x25a3, 0x25a9],
	[0x25b2, 0x25b3],
	[0x25b6, 0x25b7],
	[0x25bc, 0x25bd],
	[0x25c0, 0x25c1],
	[0x25c6, 0x25c8],
	[0x25cb, 0x25cb],
	[0x25ce, 0x25d1],
	[0x25e2, 0x25e5],
	[0x25ef, 0x25ef],
	[0x2605, 0x2606],
	[0x2609, 0x2609],
	[0x260e, 0x260f],
	[0x261c, 0x261c],
	[0x261e, 0x261e],
	[0x2640, 0x2640],
	[0x2642, 0x2642],
	[0x2660, 0x2661],
	[0x2663, 0x2665],
	[0x2667, 0x266a],
	[0x266c, 0x266d],
	[0x266f, 0x266f],
	[0x269e, 0x269f],
	[0x26bf, 0x26bf],
	[0x26c6, 0x26cd],
	[0x26cf, 0x26d3],
	[0x26d5, 0x26e1],
	[0x26e3, 0x26e3],
	[0x26e8, 0x26e9],
	[0x26eb, 0x26f1],
	[0x26f4, 0x26f4],
	[0x26f6, 0x26f9],
	[0x26fb, 0x26fc],
	[0x26fe, 0x26ff],
	[0x273d, 0x273d],
	[0x2776, 0x277f],
	[0x2b56, 0x2b59],
	[0x3248, 0x324f],
	[0xe000, 0xf8ff],
	[0xfe00, 0xfe0f],
	[0xfffd, 0xfffd],
	[0x1f100, 0x1f10a],
	[0x1f110, 0x1f12d],
	[0x1f130, 0x1f169],
	[0x1f170, 0x1f18d],
	[0x1f18f, 0x1f190],
	[0x1f19b, 0x1f1ac],
	[0xe0100, 0xe01ef],
	[0xf0000, 0xffffd],
	[0x100000, 0x10fffd],
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

// ============================================================================
// Bidirectional text + Arabic shaping (UAX #9)
// ============================================================================

/**
 * Right-to-left text, for a renderer that addresses cells directly.
 *
 * A browser hands bidi to the platform. We cannot: terminals overwhelmingly do
 * not implement the Unicode bidirectional algorithm, and the ones that do
 * reorder a line as it arrives -- which is incompatible with painting single
 * cells at absolute positions and diffing frames, because a reordering terminal
 * would shuffle each fragment against a line we did not give it whole. So
 * termdom takes the other side of ECMA-48's BDSM contract (explicit mode, see
 * #negotiateBidi) and emits cells already in visual order.
 *
 * Two libraries do the standards work, both pinned:
 *
 * - `bidi-js` is UAX #9 entire -- embedding controls, isolates, the weak-type
 *   rules -- where a hand-rolled version covers the strong-direction core and
 *   quietly mishandles the rest.
 * - `arabic-persian-reshaper` picks contextual letterforms. Arabic is cursive:
 *   a letter has up to four shapes depending on its neighbours, so reordering
 *   alone leaves it in disconnected isolated forms. Hebrew does not join and
 *   needs none of this.
 */
const {ArabicShaper} = arabicPersianReshaper;

const bidi = bidiFactory();

// Written as escapes rather than literals: several of these block boundaries
// are invisible characters, and one of them (U+FEFF) is a zero-width no-break
// space that reads as stray whitespace in an editor, a diff and a linter.

/** Arabic proper, its supplement and extended blocks, and presentation forms. */
const ARABIC =
	/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Any strongly right-to-left script: Hebrew, Arabic, Syriac, Thaana, NKo,
 * Samaritan, Mandaic, and the Hebrew and Arabic presentation-form blocks.
 */
const RTL_SCRIPT =
	/[\u0590-\u05FF\u0600-\u07BF\u07C0-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** Whether any character in the string is strongly right-to-left. */
export function hasRTL(text: string): boolean {
	return RTL_SCRIPT.test(text);
}

/**
 * The direction a paragraph takes from its own content (UAX #9 §P2/P3): the
 * first strong character decides, and text with no strong character is LTR.
 */
export function inferParagraphDirection(text: string): "ltr" | "rtl" {
	if (!hasRTL(text)) {
		return "ltr";
	}
	const {paragraphs} = bidi.getEmbeddingLevels(text);
	return paragraphs[0] && paragraphs[0].level % 2 === 1 ? "rtl" : "ltr";
}

/**
 * Reorder one line from logical order into the visual order a terminal should
 * paint, and shape its Arabic.
 *
 * Shaping runs LAST, on the reordered string, and only here at the end of
 * layout -- never on the text that gets measured. It is not length-preserving:
 * a lam-alef pair collapses into one ligature codepoint, so shaping earlier
 * would slide every character offset after it, and those offsets are what the
 * caret and selection are expressed in. The cost of doing it here instead is
 * that such a line paints one cell narrower than it measured, leaving a gap --
 * a blemish, where the other way is a wrong caret.
 */
export function toVisualOrder(text: string, base: "ltr" | "rtl"): string {
	if (!text) {
		return text;
	}
	if (!hasRTL(text)) {
		return text;
	}

	// Shape FIRST, on logical order. A letter's form comes from the letters
	// beside it in READING order, so shaping a reversed string picks the wrong
	// forms and, worse, never sees a lam followed by an alef -- the pair that
	// must ligate. Reordering afterwards is safe: the presentation forms are
	// Arabic letters too, and resolve to the same direction their bases did.
	const shaped = ARABIC.test(text) ? ArabicShaper.convertArabic(text) : text;

	// §L2 (reverse each run) and §L4 (substitute mirrored characters, since a
	// terminal will not swap the GLYPH for us, so the codepoint has to change).
	const levels = bidi.getEmbeddingLevels(shaped, base);
	return bidi.getReorderedString(shaped, levels);
}

/**
 * Whether a `white-space` value keeps every space and tab as written
 * (css-text-3 §4.1.1). `pre-line` does not: it collapses spaces and tabs and
 * preserves only newlines.
 */
function preservesSpaces(whiteSpace: string): boolean {
	return whiteSpace === "pre" || whiteSpace === "pre-wrap";
}

const COLLAPSIBLE_RUN = /\s+/g;
const PRE_LINE_RUN = /[^\S\n]+/g;

// Whether a rendering would change anything: two collapsible characters in a
// row, or one that is not already the space it collapses to.
const COLLAPSES = /\s\s|[^\S ]/;
const PRE_LINE_COLLAPSES = /[^\S\n][^\S\n]|[^\S\n ]/;

/**
 * The runs a `white-space` value collapses to one space: every run the \s class
 * matches, except that `pre-line` exempts the newline it preserves. Stateful
 * (`g`), so a caller resets `lastIndex` before scanning with it.
 */
function collapsiblePattern(whiteSpace: string): RegExp {
	return whiteSpace === "pre-line" ? PRE_LINE_RUN : COLLAPSIBLE_RUN;
}

/**
 * A text node's data as it renders under a `white-space` value: each run of
 * collapsible whitespace becomes one space, `pre` and `pre-wrap` render their
 * data verbatim, and `pre-line` collapses spaces and tabs but keeps newlines.
 *
 * The single definition of that mapping. The line breaker renders whole text
 * leaves through it and records, for each line fragment, the data range the
 * fragment covers; the painter renders that range back through it to recover
 * the characters to draw. The two agree because rendering a range equals the
 * range of the rendering whenever the range begins and ends on a rendered
 * character, which is how fragment offsets are defined.
 */
export function renderWhiteSpace(data: string, whiteSpace: string): string {
	if (preservesSpaces(whiteSpace)) {
		return data;
	}
	// Text whose collapsible whitespace is already single spaces renders as
	// itself, which is most text: the question is worth asking before building
	// a second string that would equal the first.
	const collapses = whiteSpace === "pre-line" ? PRE_LINE_COLLAPSES : COLLAPSES;
	if (!collapses.test(data)) {
		return data;
	}
	return data.replace(collapsiblePattern(whiteSpace), " ");
}

/**
 * The inverse of a whitespace rendering: which data offset each rendered code
 * unit came from. Held as the collapsed runs alone -- everything between two
 * runs maps across one-for-one -- so the mapping costs a few numbers per run
 * rather than an entry per character, on text whose collapsible runs are a
 * small fraction of its length.
 *
 * `base` is added to a rendered index before lookup, which is how a rendering
 * that later loses a prefix (a run's leading whitespace, trimmed) keeps its
 * mapping without rebuilding it.
 */
export interface RenderedOffsets {
	/** Rendered index of each collapsed run's single space. */
	spaceAt: Int32Array;
	/** The data offset that space renders: the run's first character. */
	runStart: Int32Array;
	/** The data offset just past each run. */
	runEnd: Int32Array;
	base: number;
}

const NO_RUNS = new Int32Array(0);

/**
 * `renderWhiteSpace` plus the mapping back to data offsets, null when the
 * rendering is verbatim and every offset maps to itself.
 */
export function renderWhiteSpaceOffsets(
	data: string,
	whiteSpace: string,
): {text: string; offsets: RenderedOffsets | null} {
	if (preservesSpaces(whiteSpace)) {
		return {text: data, offsets: null};
	}
	const pattern = collapsiblePattern(whiteSpace);
	pattern.lastIndex = 0;
	const spaceAt: number[] = [];
	const runStart: number[] = [];
	const runEnd: number[] = [];
	// Each run of length L renders as one space, so every later character sits
	// L-1 places earlier than its data offset.
	let dropped = 0;
	// A one-character run leaves every offset where it was and still rewrites
	// the character, since a tab or a newline renders as a space.
	let rewritten = false;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(data))) {
		spaceAt.push(match.index - dropped);
		runStart.push(match.index);
		runEnd.push(match.index + match[0].length);
		dropped += match[0].length - 1;
		if (match[0] !== " ") {
			rewritten = true;
		}
	}
	return {
		text: dropped === 0 && !rewritten ? data : data.replace(pattern, " "),
		offsets: {
			spaceAt: Int32Array.from(spaceAt),
			runStart: Int32Array.from(runStart),
			runEnd: Int32Array.from(runEnd),
			base: 0,
		},
	};
}

/** The data offset a rendered code unit came from. See RenderedOffsets. */
export function dataOffsetAt(
	offsets: RenderedOffsets | null,
	index: number,
): number {
	if (!offsets) {
		return index;
	}
	const rendered = index + offsets.base;
	// The last collapsed run at or before the index: everything after that run
	// maps across one-for-one from the data just past it.
	const {spaceAt} = offsets;
	let low = 0;
	let high = spaceAt.length - 1;
	let run = -1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (spaceAt[middle] <= rendered) {
			run = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (run < 0) {
		return rendered;
	}
	if (spaceAt[run] === rendered) {
		return offsets.runStart[run];
	}
	return offsets.runEnd[run] + (rendered - spaceAt[run] - 1);
}

/**
 * The same mapping over a rendering that lost its first `by` characters. A
 * verbatim rendering needs a mapping of its own once it has: its offsets are no
 * longer the identity.
 */
export function shiftRenderedOffsets(
	offsets: RenderedOffsets | null,
	by: number,
): RenderedOffsets {
	if (!offsets) {
		return {spaceAt: NO_RUNS, runStart: NO_RUNS, runEnd: NO_RUNS, base: by};
	}
	return {...offsets, base: offsets.base + by};
}

/**
 * The characters one line fragment paints: its data range rendered under the
 * node's `white-space`, reordered into the visual order the line was laid out
 * in when the line carries bidirectional text.
 */
export function renderTextFragment(
	data: string,
	whiteSpace: string,
	startOffset: number,
	endOffset: number,
	visualBase?: "ltr" | "rtl" | null,
): string {
	const text = renderWhiteSpace(data.slice(startOffset, endOffset), whiteSpace);
	return visualBase ? toVisualOrder(text, visualBase) : text;
}
