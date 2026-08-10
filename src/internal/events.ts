/**
 * The input layer: what the terminal's bytes mean, and which element they
 * belong to.
 *
 * Decoding and focus policy live here. Constructing the DOM events and
 * dispatching them belongs to the engine, because that half is the render loop.
 */

import type {EngineWindow} from "./termdom.js";
import {flatParentElement} from "./dom.js";
import type {LayoutEngine} from "./layout.js";
import {computedStyleOf} from "./styles.js";

/**
 * The DOM `code` values for the keys whose physical identity a terminal escape
 * sequence pins down exactly, independent of any US-QWERTY assumption.
 */
const NAMED_KEY_CODES: Record<string, string> = {
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Escape: "Escape",
	ArrowUp: "ArrowUp",
	ArrowDown: "ArrowDown",
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	Home: "Home",
	End: "End",
	Insert: "Insert",
	Delete: "Delete",
	PageUp: "PageUp",
	PageDown: "PageDown",
	F1: "F1",
	F2: "F2",
	F3: "F3",
	F4: "F4",
	F5: "F5",
	F6: "F6",
	F7: "F7",
	F8: "F8",
	F9: "F9",
	F10: "F10",
	F11: "F11",
	F12: "F12",
	" ": "Space",
};

/**
 * The DOM `code` for a resolved key name -- physical key identity, independent
 * of modifiers. Exact for named/special keys (the escape sequence uniquely
 * identifies the physical key) and for letters/digits under the near-universal
 * assumption of a US QWERTY layout. Not exact for punctuation: a terminal only
 * ever tells us the character a key combination *produced* ("!" from Shift+1
 * on US layout, but a different physical key entirely on others), never which
 * physical key+modifiers produced it -- there is no protocol-level signal for
 * that, unlike the modifier bits `ctrlKey`/`altKey`/`shiftKey` decode from.
 * Falls back to the previous (also approximate) `Key<X>` guess for those.
 */
export function domCodeFor(keyName: string): string {
	const named = NAMED_KEY_CODES[keyName];
	if (named) return named;
	if (keyName.length === 1) {
		const upper = keyName.toUpperCase();
		if (upper >= "A" && upper <= "Z") return `Key${upper}`;
		if (keyName >= "0" && keyName <= "9") return `Digit${keyName}`;
	}
	return `Key${keyName.toUpperCase()}`;
}

/**
 * Split raw terminal input into key tokens: CSI sequences (ESC [ ... final
 * byte), SS3 sequences (ESC O x), and single characters.
 *
 * Fast input arrives batched -- a held arrow key delivers
 * "\x1b[B\x1b[B\x1b[B" in one chunk, and a terminal report can land glued to
 * ordinary keystrokes. Anything that treats a chunk as one key swallows
 * everything after the first token: a held arrow repeated once per chunk
 * instead of once per press, and a stray cursor report ate every key packed
 * behind it.
 */
export function* tokenizeInput(input: string): Generator<string> {
	let i = 0;
	while (i < input.length) {
		if (input[i] === "\x1b" && i + 1 < input.length) {
			if (input[i + 1] === "[") {
				// CSI: parameter/intermediate bytes end at a final byte 0x40-0x7e.
				let end = i + 2;
				while (
					end < input.length &&
					!(input.charCodeAt(end) >= 0x40 && input.charCodeAt(end) <= 0x7e)
				) {
					end++;
				}
				yield input.slice(i, Math.min(end + 1, input.length));
				i = end + 1;
				continue;
			}
			if (input[i + 1] === "O" && i + 2 < input.length) {
				yield input.slice(i, i + 3);
				i += 3;
				continue;
			}
		}
		yield input[i];
		i++;
	}
}

/** A single decoded keystroke: the semantics of one key token. */
export interface KeyStroke {
	/** The named key (`"ArrowUp"`, `"Enter"`, or the literal character). */
	keyName: string;
	keyCode: number;
	/** The character code, for the keypress default only; 0 for non-printing. */
	charCode: number;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

/**
 * Resolve one key token into a KeyStroke, or null if the token is a terminal
 * reply rather than a keystroke.
 *
 * A cursor-position report (CSI row;col R) with no query outstanding is a late
 * or duplicate answer, not a key the user pressed -- decoding it as one would
 * dispatch a nonsense event, so it is dropped.
 */
export function decodeKey(token: string): KeyStroke | null {
	if (/^\x1b\[\d+;\d+R$/.test(token)) {
		return null;
	}

	let keyName = token;
	let keyCode = 0;
	let charCode = token.charCodeAt(0);
	let shiftKey = false;
	let ctrlKey = false;
	let altKey = false;
	let metaKey = false;

	// Ctrl+<letter> arrives as a single raw ASCII control byte (Ctrl+A=0x01
	// ... Ctrl+Z=0x1A) -- there is no escape sequence, and no way to combine
	// it with Shift (the terminal only ever sends the one byte). Tab(0x09) and
	// Enter(0x0D) are excluded even though they fall in this range: those bytes
	// are what the physical Tab and Enter keys send, indistinguishable from
	// Ctrl+I and Ctrl+M, so the named key wins. Line feed(0x0A) collides with
	// no key and stays the Ctrl+J chord. Ctrl+C(0x03) never reaches here: it is
	// intercepted earlier, unconditionally, for SIGINT.
	const modifiedArrow = token.match(/^\x1b\[1;(\d+)([ABCDHF])$/);
	if (charCode >= 1 && charCode <= 26 && charCode !== 9 && charCode !== 13) {
		keyName = String.fromCharCode(charCode + 96); // 0x01 -> 'a' ... 0x1A -> 'z'
		keyCode = charCode + 64; // 'A'..'Z', the DOM keyCode for the letter itself
		ctrlKey = true;
	} else if (modifiedArrow) {
		// xterm's extended CSI encoding for a modified cursor key: CSI 1 ;
		// <mod> <letter>, e.g. Alt+Up = \x1b[1;3A, Shift+Home = \x1b[1;2H.
		// The tokenizer already yields this whole sequence as one token
		// unchanged -- it scans for the CSI final byte regardless of what
		// parameters precede it -- so this is pure decoding, no parsing
		// changes needed. mod-1 is a bitmask: 1=Shift, 2=Alt, 4=Ctrl,
		// 8=Meta (metaKey included for spec-completeness; nothing on macOS
		// actually sends it, since Cmd+key never reaches the PTY at all).
		const modifierBits = parseInt(modifiedArrow[1], 10) - 1;
		shiftKey = (modifierBits & 1) !== 0;
		altKey = (modifierBits & 2) !== 0;
		ctrlKey = (modifierBits & 4) !== 0;
		metaKey = (modifierBits & 8) !== 0;
		const cursorKeyByLetter: Record<string, [string, number]> = {
			A: ["ArrowUp", 38],
			B: ["ArrowDown", 40],
			C: ["ArrowRight", 39],
			D: ["ArrowLeft", 37],
			H: ["Home", 36],
			F: ["End", 35],
		};
		[keyName, keyCode] = cursorKeyByLetter[modifiedArrow[2]];
		charCode = 0;
	} else {
		switch (token) {
			// Enter is carriage return. Line feed is the Ctrl+J chord, which a
			// terminal sends as its control byte like any other letter's, and
			// which an application binds if it wants a soft newline where Enter
			// already means something else.
			case "\r":
				keyName = "Enter";
				keyCode = 13;
				charCode = 13;
				break;
			case "\t":
				keyName = "Tab";
				keyCode = 9;
				charCode = 9;
				break;
			case "\x1b[Z":
				// Shift+Tab
				keyName = "Tab";
				keyCode = 9;
				charCode = 9;
				shiftKey = true;
				break;
			case "\x7f":
				keyName = "Backspace";
				keyCode = 8;
				charCode = 8;
				break;
			case "\x1b":
				// A lone Escape -- not the start of a CSI/SS3 sequence, since the
				// tokenizer already peels those off as their own multi-char tokens.
				keyName = "Escape";
				keyCode = 27;
				charCode = 0;
				break;
			case "\x1b[A":
				keyName = "ArrowUp";
				keyCode = 38;
				charCode = 0;
				break;
			case "\x1b[B":
				keyName = "ArrowDown";
				keyCode = 40;
				charCode = 0;
				break;
			case "\x1b[C":
				keyName = "ArrowRight";
				keyCode = 39;
				charCode = 0;
				break;
			case "\x1b[D":
				keyName = "ArrowLeft";
				keyCode = 37;
				charCode = 0;
				break;
			case "\x1b[H":
			case "\x1b[1~":
				keyName = "Home";
				keyCode = 36;
				charCode = 0;
				break;
			case "\x1b[F":
			case "\x1b[4~":
				keyName = "End";
				keyCode = 35;
				charCode = 0;
				break;
			case "\x1b[2~":
				keyName = "Insert";
				keyCode = 45;
				charCode = 0;
				break;
			case "\x1b[3~":
				keyName = "Delete";
				keyCode = 46;
				charCode = 0;
				break;
			case "\x1b[5~":
				keyName = "PageUp";
				keyCode = 33;
				charCode = 0;
				break;
			case "\x1b[6~":
				keyName = "PageDown";
				keyCode = 34;
				charCode = 0;
				break;
			// F1-F4: SS3 encoding, the modern xterm default. F5-F12: CSI-tilde --
			// note the historical gap (no ~16), a quirk of the original xterm
			// numbering every terminal descended from it still follows.
			case "\x1bOP":
				keyName = "F1";
				keyCode = 112;
				charCode = 0;
				break;
			case "\x1bOQ":
				keyName = "F2";
				keyCode = 113;
				charCode = 0;
				break;
			case "\x1bOR":
				keyName = "F3";
				keyCode = 114;
				charCode = 0;
				break;
			case "\x1bOS":
				keyName = "F4";
				keyCode = 115;
				charCode = 0;
				break;
			case "\x1b[15~":
				keyName = "F5";
				keyCode = 116;
				charCode = 0;
				break;
			case "\x1b[17~":
				keyName = "F6";
				keyCode = 117;
				charCode = 0;
				break;
			case "\x1b[18~":
				keyName = "F7";
				keyCode = 118;
				charCode = 0;
				break;
			case "\x1b[19~":
				keyName = "F8";
				keyCode = 119;
				charCode = 0;
				break;
			case "\x1b[20~":
				keyName = "F9";
				keyCode = 120;
				charCode = 0;
				break;
			case "\x1b[21~":
				keyName = "F10";
				keyCode = 121;
				charCode = 0;
				break;
			case "\x1b[23~":
				keyName = "F11";
				keyCode = 122;
				charCode = 0;
				break;
			case "\x1b[24~":
				keyName = "F12";
				keyCode = 123;
				charCode = 0;
				break;
			default:
				// For regular characters, keyCode is often the uppercase charCode
				if (token.length === 1) {
					keyCode = token.toUpperCase().charCodeAt(0);
				}
		}
	}

	return {keyName, keyCode, charCode, shiftKey, ctrlKey, altKey, metaKey};
}

/** A single decoded SGR mouse report: the semantics of the report bits. */
export interface MouseReport {
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	/** A motion report (a drag or hover), rather than a press/release. */
	isMotion: boolean;
	/** The button/wheel code with the modifier and motion bits stripped. */
	base: number;
	/**
	 * The wheel notch in DOM_DELTA_LINE rows (one notch = three rows, the
	 * browser's line-mode convention), or null when the report is not a wheel.
	 */
	wheelDeltaY: number | null;
	/** The MouseEvent `button`, valid when base <= 2. */
	button: number;
	/** The MouseEvent `buttons` bitmask for this phase, valid when base <= 2. */
	buttons: number;
}

/**
 * Decode one SGR mouse report's code byte into its modifiers, phase, and button
 * mapping. The report's row/column and the dispatch itself stay with the
 * caller, which owns the hit-test and the render loop.
 */
export function decodeMouseReport(
	code: number,
	isRelease: boolean,
): MouseReport {
	const shiftKey = (code & 4) !== 0;
	const altKey = (code & 8) !== 0;
	const ctrlKey = (code & 16) !== 0;
	const isMotion = (code & 32) !== 0;
	const base = code & ~(4 | 8 | 16 | 32);

	// Wheel: 64 = up, 65 = down.
	const wheelDeltaY = base === 64 ? -3 : base === 65 ? 3 : null;

	// Buttons: 0/1/2 = left/middle/right.
	const button = base === 1 ? 1 : base === 2 ? 2 : 0;
	const buttons = isRelease ? 0 : base === 1 ? 4 : base === 2 ? 2 : 1;

	return {
		shiftKey,
		altKey,
		ctrlKey,
		isMotion,
		base,
		wheelDeltaY,
		button,
		buttons,
	};
}

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
//
// `a[href]` is in the list because an anchor WITH an href is focusable and
// sequentially reachable per HTML, and an anchor without one is not -- the
// attribute qualifier draws that line for free. Leaving links out made
// navigation link-shaped UI (TodoMVC's All/Active/Completed filters) reachable
// only by mouse.
export const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

/**
 * Get all focusable elements in tab order
 */
export function getFocusableElements(
	document: Document,
	window: EngineWindow,
	layoutEngine: LayoutEngine,
): Element[] {
	const elements = Array.from(
		document.querySelectorAll(FOCUSABLE_SELECTOR),
	).filter((element) => {
		// Browsers keep unrendered elements out of tab order: a hidden
		// edit-row checkbox must not swallow a Tab press invisibly. An
		// element is rendered when nothing on its flat-tree chain is
		// display:none and it produced boxes.
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = flatParentElement<Element>(ancestor)
		) {
			if (computedStyleOf(ancestor).computedValueOf("display") === "none") {
				return false;
			}
		}
		try {
			return layoutEngine.getRects(element).length > 0;
		} catch {
			return false;
		}
	});
	return elements.sort((a, b) => {
		const aTab = parseInt(a.getAttribute("tabindex") || "0", 10);
		const bTab = parseInt(b.getAttribute("tabindex") || "0", 10);
		if (aTab !== bTab) {
			if (aTab > 0 && bTab > 0) return aTab - bTab;
			if (aTab > 0) return -1;
			if (bTab > 0) return 1;
		}
		return 0;
	});
}

/**
 * The `autofocus` default action: an element with the attribute set gets
 * focused as soon as it's connected, the same as a browser does at initial
 * page load -- generalized here to any insertion, which is what lets a
 * dynamically-created element (e.g. an edit input that only exists while
 * editing) still autofocus itself. Scoped to newly added nodes only, not
 * later attribute changes, matching the spec's "insertion" trigger. If a
 * batch inserts more than one autofocus element, the later mutation wins
 * (processed in order, each call simply moves focus again) -- same
 * ambiguity a real page with more than one autofocus element already has.
 */
export function focusAutofocusedNodes(mutations: MutationRecord[]): void {
	for (const record of mutations) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== node.ELEMENT_NODE) continue;
			const element = node as Element;
			const candidate = (element as any).autofocus
				? element
				: element.querySelector?.("[autofocus]");
			(candidate as HTMLElement | null)?.focus?.();
		}
	}
}

/** Input types that are buttons rather than fields. */
const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);

/**
 * Does a keypress on this element activate it, the way a click would?
 *
 * Buttons do, on Enter and on Space. Links do, on Enter only -- Space scrolls
 * the page in a browser rather than following the link, and the difference is
 * observable enough to be worth keeping.
 */
export function keyboardActivation(
	element: Element,
): {enter: boolean; space: boolean} | null {
	const tag = element.tagName;
	if (tag === "BUTTON") {
		return {enter: true, space: true};
	}
	if (tag === "INPUT") {
		const type = (element as HTMLInputElement).type;
		return BUTTON_INPUT_TYPES.has(type) ? {enter: true, space: true} : null;
	}
	if (tag === "A" && element.hasAttribute("href")) {
		return {enter: true, space: false};
	}
	// A summary activates on both keys, and activation is what opens the
	// disclosure; whether this summary is its details' summary is the
	// activation behavior's own question.
	if (tag === "SUMMARY") {
		return {enter: true, space: true};
	}
	return null;
}
