/**
 * The terminal's understanding of a run of text: how wide it is, where its
 * grapheme clusters break, and which direction it flows.
 *
 * A renderer that addresses cells has to answer all three before it can place
 * a character, so they live together. Width and cluster breaking are this
 * file's own work, over the generated tables and a ledger of what the attached
 * terminal was actually seen to do -- start at stringWidth and graphemeWidth,
 * and read clusterAdvances for why a prediction is not the last word.
 * Direction is two pinned libraries' work, introduced where the bidi section
 * begins.
 */
import arabicPersianReshaper from "arabic-persian-reshaper";
import bidiFactory from "bidi-js";

import {
	UNCERTAIN_RANGES,
	WIDE_RANGES,
	ZERO_WIDTH_RANGES,
} from "../generated/widthtables.js";

// Bun is the only runtime with a native fast path worth branching on; Node
// and Deno both take the pure-JS fallback, so neither needs detecting. The
// global itself rather than a flag, so its absence narrows the call away.
const bun = globalThis.Bun;

/** ASCII-only lowercasing: what HTML and CSS case-fold with, never locale. */
export function asciiLowercase(value: string): string {
	return value.replace(/[A-Z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) + 32),
	);
}

/**
 * One shared grapheme segmenter: what the terminal treats as one character.
 * Constructing one is expensive, so the whole engine reads through this.
 */
export const graphemeSegmenter = new Intl.Segmenter("en", {
	granularity: "grapheme",
});

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
 * Two generations instead of per-hit reordering: a young-generation hit is
 * one Map.get and moves nothing. When the young generation fills it becomes
 * the old one and the previous old generation drops wholesale; a key still
 * wanted is promoted on its next hit. Recency is approximate, the bound is
 * exact: at most 2x the limit is ever held.
 */
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

	clear(): void {
		this.map.clear();
		this.old.clear();
	}
}

/** Printable ASCII is its own width. */
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

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
	if (clusterAdvances.has(cluster) || advance === graphemeWidth(cluster)) {
		return false;
	}

	clusterAdvances.set(cluster, advance);
	// Widths answered before this one were answered by the tables alone.
	widthCache.clear();
	return true;
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
		bun !== undefined && clusterAdvances.size === 0 && !COMBINING.test(str)
			? bun.stringWidth(str)
			: stringWidthFallback(str);
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

	for (const {index, segment} of graphemeSegmenter.segment(str)) {
		out[offset + index + segment.length - 1] = graphemeWidth(segment);
	}
}

/**
 * Pure-JS string width, used on runtimes without Bun.
 *
 * Under Bun the branch above skips this for most strings, so little catches it
 * drifting. It must agree with Bun.stringWidth everywhere Bun is still
 * consulted -- width drives wrapping and cell alignment, so a disagreement
 * misrenders text on Node and Deno only.
 */
function stringWidthFallback(str: string): number {
	let width = 0;
	for (const {segment} of graphemeSegmenter.segment(str)) {
		width += graphemeWidth(segment);
	}
	return width;
}

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
	// one is a narrow letter. The graphemeSegmenter clusters them in pairs for us.
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
	for (const {index, segment} of graphemeSegmenter.segment(value)) {
		boundaries.push(index + segment.length);
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

// ---------------------------------------------------------------------------
// Bidirectional text and Arabic shaping (UAX #9)
// ---------------------------------------------------------------------------

/**
 * Right-to-left text, for a renderer that addresses cells directly.
 *
 * A browser hands bidi to the platform. We cannot: terminals overwhelmingly do
 * not implement the Unicode bidirectional algorithm, and the ones that do
 * reorder a line as it arrives -- which is incompatible with painting single
 * cells at absolute positions and diffing frames, because a reordering terminal
 * would shuffle each fragment against a line we did not give it whole. So
 * termdom takes the other side of ECMA-48's BDSM contract (explicit mode, see
 * negotiateBidi) and emits cells already in visual order.
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
 * Shaping runs LAST -- here, at the end of layout, never on the text that gets
 * measured. It is not length-preserving:
 * a lam-alef pair collapses into one ligature codepoint, so shaping earlier
 * would slide every character offset after it, and those offsets are what the
 * caret and selection are expressed in. The cost of doing it here instead is
 * that such a line paints one cell narrower than it measured, leaving a gap --
 * a blemish, where the other way is a wrong caret.
 */
export function toVisualOrder(text: string, base: "ltr" | "rtl"): string {
	if (!text || !hasRTL(text)) {
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
