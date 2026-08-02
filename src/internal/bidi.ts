/**
 * Right-to-left text, for a renderer that addresses cells directly.
 *
 * A browser hands bidi to the platform. We cannot: terminals overwhelmingly do
 * not implement the Unicode bidirectional algorithm, and the ones that do
 * reorder a line as it arrives -- which is incompatible with painting single
 * cells at absolute positions and diffing frames, because a reordering terminal
 * would shuffle each fragment against a line we did not give it whole. So
 * termdom takes the other side of ECMA-48's BDSM contract (explicit mode) and
 * emits cells already in visual order. This file is what puts them in that
 * order.
 *
 * Scope, stated plainly: this implements the strong-direction core of UAX #9 --
 * enough for text that is entirely RTL, and for RTL text carrying Latin words,
 * numbers and punctuation, which is the overwhelming majority of real UI
 * strings. It does NOT implement explicit embedding controls (LRE/RLE/PDF and
 * the isolate family), and it resolves neutrals by a simpler rule than the
 * algorithm's full N1/N2. Text that needs those is out of scope rather than
 * silently wrong: see isSimpleBidi().
 */

/** Character classes, reduced to what the strong-direction core needs. */
const enum Dir {
	LTR,
	RTL,
	NEUTRAL,
}

/**
 * Explicit embedding and isolate controls. Their presence means the text needs
 * the parts of UAX #9 this file does not implement.
 */
const EXPLICIT_CONTROLS = /[‪-‮⁦-⁩]/;

/** True for the RTL scripts a terminal is likely to be asked to show. */
function isStrongRTL(code: number): boolean {
	return (
		// Hebrew, plus its presentation forms
		(code >= 0x0590 && code <= 0x05ff) ||
		(code >= 0xfb1d && code <= 0xfb4f) ||
		// Arabic, Syriac, Thaana, and the Arabic supplement/extended blocks
		(code >= 0x0600 && code <= 0x07bf) ||
		(code >= 0x0860 && code <= 0x08ff) ||
		// Arabic presentation forms A and B
		(code >= 0xfb50 && code <= 0xfdff) ||
		(code >= 0xfe70 && code <= 0xfeff) ||
		// NKo, Samaritan, Mandaic
		(code >= 0x07c0 && code <= 0x085f)
	);
}

function isStrongLTR(code: number): boolean {
	return (
		(code >= 0x0041 && code <= 0x005a) ||
		(code >= 0x0061 && code <= 0x007a) ||
		(code >= 0x00c0 && code <= 0x024f) ||
		(code >= 0x0370 && code <= 0x058f) ||
		(code >= 0x0900 && code <= 0x1fff) ||
		(code >= 0x2c00 && code <= 0xd7ff) ||
		(code >= 0xf900 && code <= 0xfb17) ||
		code > 0xffff
	);
}

/**
 * Digits read left to right in every script, including the Arabic-Indic ones
 * that live inside the Arabic block. UAX #9 gives them their own weak classes
 * (EN/AN) whose effect, for our purposes, is that a number is never reversed:
 * treating them as neutral turned "Bun 2.1" into "Bun 1.2".
 */
function isDigit(code: number): boolean {
	return (
		(code >= 0x0030 && code <= 0x0039) || // ASCII
		(code >= 0x0660 && code <= 0x0669) || // Arabic-Indic
		(code >= 0x06f0 && code <= 0x06f9) // Extended Arabic-Indic
	);
}

function classify(ch: string): Dir {
	const code = ch.codePointAt(0)!;
	if (isDigit(code)) return Dir.LTR;
	if (isStrongRTL(code)) return Dir.RTL;
	if (isStrongLTR(code)) return Dir.LTR;
	return Dir.NEUTRAL;
}

/**
 * Paired characters swap when they are displayed in an RTL run: an opening
 * parenthesis in Arabic text is drawn as the closing glyph, because "opening"
 * means "on the reading-start side" and that side has moved. UAX #9 §L4.
 */
const MIRRORED = new Map<string, string>([
	["(", ")"],
	[")", "("],
	["[", "]"],
	["]", "["],
	["{", "}"],
	["}", "{"],
	["<", ">"],
	[">", "<"],
	["«", "»"],
	["»", "«"],
	["‹", "›"],
	["›", "‹"],
]);

/**
 * Whether a string is within the strong-direction core this file implements.
 * False means the caller should leave the text alone rather than reorder it
 * wrongly -- explicit embedding controls need the full algorithm.
 */
export function isSimpleBidi(text: string): boolean {
	return !EXPLICIT_CONTROLS.test(text);
}

/** Whether any character in the string is strongly right-to-left. */
export function hasRTL(text: string): boolean {
	for (const ch of text) {
		if (classify(ch) === Dir.RTL) return true;
	}
	return false;
}

/**
 * The direction a paragraph takes from its own content (UAX #9 §P2/P3): the
 * first strong character decides, and text with no strong character is LTR.
 */
export function inferParagraphDirection(text: string): "ltr" | "rtl" {
	for (const ch of text) {
		const dir = classify(ch);
		if (dir === Dir.RTL) return "rtl";
		if (dir === Dir.LTR) return "ltr";
	}
	return "ltr";
}

/**
 * Reorder one line's characters from logical order into the visual order a
 * terminal should paint, given the paragraph's base direction.
 *
 * The shape of it: split into maximal runs of one direction, attaching each
 * neutral run to its surroundings (a neutral between two runs of the same
 * direction belongs to them; otherwise it takes the paragraph's direction).
 * Then, for an RTL paragraph, lay the runs out from the right, reversing the
 * characters inside each RTL run and mirroring its paired punctuation, while
 * LTR runs keep their internal order -- which is what makes "version 2.1" read
 * correctly inside an Arabic sentence.
 */
export function toVisualOrder(text: string, base: "ltr" | "rtl"): string {
	if (!text || !isSimpleBidi(text)) return text;

	const chars = [...text];
	const dirs = chars.map(classify);

	// Resolve neutrals: between two strong characters of the SAME direction they
	// join that direction, otherwise they fall to the paragraph's.
	const baseDir = base === "rtl" ? Dir.RTL : Dir.LTR;
	for (let i = 0; i < dirs.length; i++) {
		if (dirs[i] !== Dir.NEUTRAL) continue;
		let end = i;
		while (end < dirs.length && dirs[end] === Dir.NEUTRAL) end++;
		let before = baseDir;
		for (let j = i - 1; j >= 0; j--) {
			if (dirs[j] !== Dir.NEUTRAL) {
				before = dirs[j];
				break;
			}
		}
		let after = baseDir;
		for (let j = end; j < dirs.length; j++) {
			if (dirs[j] !== Dir.NEUTRAL) {
				after = dirs[j];
				break;
			}
		}
		const resolved = before === after ? before : baseDir;
		for (let j = i; j < end; j++) dirs[j] = resolved;
		i = end - 1;
	}

	// Split into maximal same-direction runs.
	const runs: Array<{dir: Dir; chars: string[]}> = [];
	for (let i = 0; i < chars.length; i++) {
		const dir = dirs[i];
		const last = runs[runs.length - 1];
		if (last && last.dir === dir) last.chars.push(chars[i]);
		else runs.push({dir, chars: [chars[i]]});
	}

	const visual: string[] = [];
	const emit = (run: {dir: Dir; chars: string[]}) => {
		if (run.dir === Dir.RTL) {
			for (let i = run.chars.length - 1; i >= 0; i--) {
				const ch = run.chars[i];
				visual.push(MIRRORED.get(ch) ?? ch);
			}
		} else {
			visual.push(...run.chars);
		}
	};

	if (base === "rtl") {
		// Runs lay out right to left, so the LAST run is painted first.
		for (let i = runs.length - 1; i >= 0; i--) emit(runs[i]);
	} else {
		for (const run of runs) emit(run);
	}

	return visual.join("");
}
