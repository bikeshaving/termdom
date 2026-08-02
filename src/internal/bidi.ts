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

import bidiFactory from "bidi-js";
import {ArabicShaper} from "arabic-persian-reshaper";

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
	if (!hasRTL(text)) return "ltr";
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
	if (!text) return text;
	if (!hasRTL(text)) return text;

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
