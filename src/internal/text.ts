import arabicPersianReshaper from "arabic-persian-reshaper";
import bidiFactory from "bidi-js";

import {
	UNCERTAIN_RANGES,
	WIDE_RANGES,
	ZERO_WIDTH_RANGES,
} from "../generated/widthtables.js";

// Bun has a native getStringWidth. Node and Deno use the fallback.
const bun = globalThis.Bun;

// What HTML and CSS case-fold with. Never the locale.
export function toASCIILowercase(value: string): string {
	return value.replace(/[A-Z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) + 32),
	);
}

// Constructing a segmenter is expensive; the whole engine shares this one.
export const graphemeSegmenter = new Intl.Segmenter("en", {
	granularity: "grapheme",
});

// Marks and format characters are what Bun.stringWidth gets wrong.
const COMBINING = /[\p{M}\p{Cf}]/u;

// Two generations. A hit in the young one moves nothing. When it fills
// it becomes the old one and the previous old generation is dropped. At
// most twice the limit is ever held.
class LRUCache<TKey, TValue> {
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

	clear(): void {
		this.map.clear();
		this.old.clear();
	}
}

export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// Bounded, so a stream of unique strings (a logger) cannot grow it.
const widthCache = new LRUCache<string, number>(2 ** 14);

// Advances the attached terminal reported that disagree with the tables
// (Terminal.app advances ☀️ one cell and ⛅️ two, and no rule separates
// them). Not a cache: a measurement of the one terminal, written once,
// never stale.
const clusterAdvances = new Map<string, number>();

// Returns whether the ledger changed. The first reading is kept, and
// agreement with the tables is not stored.
export function recordClusterAdvance(
	cluster: string,
	advance: number,
): boolean {
	if (clusterAdvances.has(cluster) || advance === getGraphemeWidth(cluster)) {
		return false;
	}

	clusterAdvances.set(cluster, advance);
	widthCache.clear();
	return true;
}

// Whether a glyph is one cell of text or two of emoji is what terminals
// disagree about.
const DEFAULT_EMOJI = /\p{Emoji_Presentation}/u;

// The property's two bands, with the CJK and Hangul blocks between them
// holding none of it. Two compares keep a screenful of ideographs off
// the regex.
const DEFAULT_EMOJI_LOW = 0x231a;
const DEFAULT_EMOJI_BMP_HIGH = 0x2b55;
const DEFAULT_EMOJI_ASTRAL_LOW = 0x1f004;
const DEFAULT_EMOJI_HIGH = 0x1faf8;

// Whether terminals disagree about this cluster's advance: any sequence
// (selectors, ZWJ, flags, modifiers, marks), East Asian Ambiguous
// outside the scripts not in doubt, default emoji presentation, and
// Arabic presentation forms, which a ligating terminal advances
// differently. Runs once per painted cell and allocates nothing.
export function isWidthUncertain(cluster: string): boolean {
	const code = cluster.codePointAt(0)!;
	if (cluster.length !== (code > 0xffff ? 2 : 1)) {
		return true;
	}
	if (code < 0xa1) {
		return false;
	}
	if (inRanges(code, UNCERTAIN_RANGES)) {
		return true;
	}
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

// Bun.stringWidth charges a cell per code point, so "שָׁלוֹם" measures 7
// instead of 4. It is used only where no mark can be.
export function getStringWidth(str: string): number {
	if (PRINTABLE_ASCII.test(str)) {
		return str.length;
	}

	const cached = widthCache.get(str);
	if (cached !== undefined) {
		return cached;
	}

	// Bun knows the tables, not the ledger.
	const width =
		bun !== undefined && clusterAdvances.size === 0 && !COMBINING.test(str)
			? bun.stringWidth(str)
			: getStringWidthFallback(str);
	widthCache.set(str, width);
	return width;
}

// A cluster's whole width lands on its last code unit and the rest get
// zero, so a cumulative array can answer any range at cluster
// boundaries.
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

	for (const {index, segment} of graphemeSegmenter.segment(str)) {
		out[offset + index + segment.length - 1] = getGraphemeWidth(segment);
	}
}

// Must agree with Bun.stringWidth wherever Bun is still consulted, or
// text misrenders on Node and Deno only.
function getStringWidthFallback(str: string): number {
	let width = 0;
	for (const {segment} of graphemeSegmenter.segment(str)) {
		width += getGraphemeWidth(segment);
	}
	return width;
}

// Mc marks advance, unlike Mn and Me: Devanagari's vowel signs.
const SPACING_MARK = /\p{Mc}/gu;

function getGraphemeWidth(cluster: string): number {
	if (clusterAdvances.size !== 0) {
		const measured = clusterAdvances.get(cluster);
		if (measured !== undefined) {
			return measured;
		}
	}

	const code = cluster.codePointAt(0)!;

	if (code < 32 || (code >= 0x7f && code < 0xa0)) {
		return 0;
	}

	// U+FE0F after a non-ASCII base asks for emoji presentation: two cells.
	// Checked after the base, so a cluster led by a bare U+FE0F does not
	// promote itself.
	if (code >= 0x80 && cluster.indexOf("\uFE0F") > 0) {
		return 2;
	}

	if (inRanges(code, ZERO_WIDTH_RANGES)) {
		return 0;
	}

	// A regional-indicator pair is a flag. A lone one is a narrow letter.
	if (code >= 0x1f1e6 && code <= 0x1f1ff) {
		return Array.from(cluster).length > 1 ? 2 : 1;
	}

	const base = inRanges(code, WIDE_RANGES) ? 2 : 1;

	// Every spacing mark after the base adds a cell: "का" occupies two.
	// After the base only, or a lone spacing mark is charged twice.
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

// For caret motion and deletion. A step snaps to a cluster boundary, so
// Backspace deletes a whole emoji.
function getGraphemeBoundaries(value: string): number[] {
	const boundaries = [0];
	for (const {index, segment} of graphemeSegmenter.segment(value)) {
		boundaries.push(index + segment.length);
	}
	return boundaries;
}

export function getNextGraphemeBoundary(value: string, index: number): number {
	for (const boundary of getGraphemeBoundaries(value)) {
		if (boundary > index) {
			return boundary;
		}
	}
	return value.length;
}

export function getPreviousGraphemeBoundary(
	value: string,
	index: number,
): number {
	let previous = 0;
	for (const boundary of getGraphemeBoundaries(value)) {
		if (boundary >= index) {
			break;
		}
		previous = boundary;
	}
	return previous;
}

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

// Terminals mostly do not implement UAX #9, and one that does reorders
// a line as it arrives, which a diff of single cells cannot survive, so
// cells go out in visual order (see negotiateBidi). bidi-js is UAX #9
// entire. arabic-persian-reshaper picks the contextual letterforms
// reordering alone would leave isolated.
const {ArabicShaper} = arabicPersianReshaper;

const bidi = bidiFactory();

// Escapes, not literals. U+FEFF looks like stray whitespace in an
// editor.
const ARABIC =
	/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const RTL_SCRIPT =
	/[\u0590-\u05FF\u0600-\u07BF\u07C0-\u085F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export function hasRTL(text: string): boolean {
	return RTL_SCRIPT.test(text);
}

// UAX #9 P2/P3: the first strong character decides.
export function getParagraphDirection(text: string): "ltr" | "rtl" {
	if (!hasRTL(text)) {
		return "ltr";
	}
	const {paragraphs} = bidi.getEmbeddingLevels(text);
	return paragraphs[0] && paragraphs[0].level % 2 === 1 ? "rtl" : "ltr";
}

// Shaping is not length-preserving (lam-alef becomes one code point),
// so it runs here on the painted line, never on the measured text. A
// gap beats a wrong caret.
export function toVisualOrder(text: string, base: "ltr" | "rtl"): string {
	if (!text || !hasRTL(text)) {
		return text;
	}

	// Shape in reading order, or a lam is never seen followed by an alef.
	const shaped = ARABIC.test(text) ? ArabicShaper.convertArabic(text) : text;

	// L2 and L4. A terminal will not mirror a glyph, so the code point
	// changes.
	const levels = bidi.getEmbeddingLevels(shaped, base);
	return bidi.getReorderedString(shaped, levels);
}
