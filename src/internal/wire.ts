/**
 * The escape sequences, as text: functions that write them and functions that
 * read them back.
 *
 * Nothing here holds state or touches a terminal. Numbers and strings go in,
 * a string or a parsed record comes out, so a sequence can be tested without
 * a session and read without one running.
 */

import {type ColorDepth, rgbTo256, rgbToBasic8} from "./color.js";

/* -------------------------------------------------------------- the cursor */

/** CUP: the cursor to a one-based row and column. */
export function cursorTo(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

/** CUP with no parameters: the top-left cell. */
export function cursorHome(): string {
	return "\x1b[H";
}

/** CUF: the cursor forward by columns. */
export function cursorForward(columns: number): string {
	return `\x1b[${columns}C`;
}

/** CUD: the cursor down by rows, stopping at the bottom margin. */
export function cursorDown(rows: number): string {
	return `\x1b[${rows}B`;
}

/** DECSC: remember where the cursor is. */
export function saveCursor(): string {
	return "\x1b7";
}

/** DECRC: the cursor back to where DECSC left it. */
export function restoreCursor(): string {
	return "\x1b8";
}

/** IND: down one row, scrolling the screen when the cursor is at the end. */
export function index(): string {
	return "\x1bD";
}

/* -------------------------------------------------------------- the eraser */

/** EL 0: from the cursor to the end of its row. */
export function eraseToLineEnd(): string {
	return "\x1b[K";
}

/** ED 0: from the cursor to the end of the screen. */
export function eraseBelow(): string {
	return "\x1b[J";
}

/** ED 2: the whole screen, cursor left where it stands. */
export function eraseScreen(): string {
	return "\x1b[2J";
}

/* ------------------------------------------------------- the scroll region */

/** DECSTBM: the scrolling region, one-based rows. Homes the cursor. */
export function setScrollRegion(top: number, bottom: number): string {
	return `\x1b[${top};${bottom}r`;
}

/** DECSTBM with no parameters: the region is the whole screen again. */
export function resetScrollRegion(): string {
	return "\x1b[r";
}

/** DL: delete rows at the cursor, pulling the region up. */
export function deleteLines(count: number): string {
	return `\x1b[${count}M`;
}

/** IL: insert blank rows at the cursor, pushing the region down. */
export function insertLines(count: number): string {
	return `\x1b[${count}L`;
}

/* --------------------------------------------------------------- the style */

/** SGR 0: back to the terminal's own defaults. */
export function sgrReset(): string {
	return "\x1b[0m";
}

/**
 * The SGR parameters naming a 24-bit color at the depth the terminal speaks:
 * stated outright, quantized to the 256-color cube, or rounded to one of the
 * eight the oldest terminals have. Parameters, not a whole SGR -- a run of
 * them shares one escape.
 */
function sgrColor(
	color: number,
	isFg: boolean,
	colorDepth: ColorDepth,
): string {
	switch (colorDepth) {
		case "rgb": {
			const r = (color >> 16) & 0xff;
			const g = (color >> 8) & 0xff;
			const b = color & 0xff;
			return `${isFg ? 38 : 48};2;${r};${g};${b}`;
		}
		case "256":
			return `${isFg ? 38 : 48};5;${rgbTo256(color)}`;
		case "ansi":
			return String((isFg ? 30 : 40) + rgbToBasic8(color));
	}
}

/** The attributes an SGR run states by name, apart from the underline. */
export type StyleAttribute =
	"bold" |
	"dim" |
	"italic" |
	"blink" |
	"inverse" |
	"strikethrough" |
	"overline";

/** Wanted states by name; an absent name is left as the terminal has it. */
export type StyleAttributes = {[K in StyleAttribute]?: boolean};

/** No underline, one line, or the styled double line of SGR 4:2. */
export type UnderlineStyle = "none" | "single" | "double";

/**
 * What a run of SGR parameters says. A color is a 24-bit value, `null` for
 * the terminal's own default, absent to leave standing. The underline is a
 * move from one style to another, because which codes spell the move depends
 * on where it starts.
 */
export interface StyleRun {
	fg?: number | null;
	bg?: number | null;
	attributes?: StyleAttributes;
	underline?: {from: UnderlineStyle; to: UnderlineStyle};
}

/**
 * The codes taking the underline from one style to another. A plain 4 comes
 * before 4:2 so a terminal that ignores the styled underline still draws a
 * line, and a plain 4 on its own downgrades a double to a single (ECMA-48,
 * and what tmux tracks).
 */
function underlineCodes(from: UnderlineStyle, to: UnderlineStyle): string[] {
	if (from === to) {
		return [];
	}
	if (to === "none") {
		return ["24"];
	}
	if (to === "double") {
		return from === "none" ? ["4", "4:2"] : ["4:2"];
	}
	return ["4"];
}

/**
 * The SGR spelling a run, parameters in the order a terminal wants to hear
 * them: colors, then attributes. "" when the run says nothing -- no escape
 * is ever emitted empty, since an empty SGR is the terminal's reset.
 */
export function sgrStyle(run: StyleRun, colorDepth: ColorDepth): string {
	const codes: string[] = [];
	if (run.fg !== undefined) {
		codes.push(run.fg === null ? "39" : sgrColor(run.fg, true, colorDepth));
	}
	if (run.bg !== undefined) {
		codes.push(run.bg === null ? "49" : sgrColor(run.bg, false, colorDepth));
	}

	const wanted = run.attributes;
	const state = (name: StyleAttribute, on: string, off: string) => {
		const want = wanted?.[name];
		if (want !== undefined) {
			codes.push(want ? on : off);
		}
	};

	state("bold", "1", "22");
	state("dim", "2", "22");
	state("italic", "3", "23");
	if (run.underline) {
		codes.push(...underlineCodes(run.underline.from, run.underline.to));
	}
	state("blink", "5", "25");
	state("inverse", "7", "27");
	state("strikethrough", "9", "29");
	state("overline", "53", "55");

	return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

/* --------------------------------------------------------------- the modes */

/** DECSET/DECRST: engage or release a private mode by number. */
export function privateMode(code: number, on: boolean): string {
	return `\x1b[?${code}${on ? "h" : "l"}`;
}

/** SM/RM: engage or release an ANSI mode by number. */
export function ansiMode(code: number, on: boolean): string {
	return `\x1b[${code}${on ? "h" : "l"}`;
}

/** DECRQM for a private mode: what is this mode set to? */
export function privateModeQuery(code: number): string {
	return `\x1b[?${code}$p`;
}

/** DECRQM for an ANSI mode. */
export function ansiModeQuery(code: number): string {
	return `\x1b[${code}$p`;
}

/** XTWINOPS 22: push the window title onto the terminal's own stack. */
export function pushTitle(): string {
	return "\x1b[22;0t";
}

/** XTWINOPS 23: pop the title the push saved. */
export function popTitle(): string {
	return "\x1b[23;0t";
}

/* -------------------------------------------------------------- the probes */

/** DSR 6: where is the cursor? Answered by a CPR report. */
export function cursorPositionQuery(): string {
	return "\x1b[6n";
}

/* -------------------------------------------------------------- the base64 */

const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
	BASE64_CODES[BASE64_ALPHABET.charCodeAt(i)] = i;
}

/** Padded base64, as OSC 52 carries a clipboard payload. */
function encode64(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out +=
			BASE64_ALPHABET[n >> 18] +
			BASE64_ALPHABET[(n >> 12) & 63] +
			BASE64_ALPHABET[(n >> 6) & 63] +
			BASE64_ALPHABET[n & 63];
	}
	const rest = bytes.length - i;
	if (rest === 1) {
		const n = bytes[i] << 16;
		out += BASE64_ALPHABET[n >> 18] + BASE64_ALPHABET[(n >> 12) & 63] + "==";
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out +=
			BASE64_ALPHABET[n >> 18] +
			BASE64_ALPHABET[(n >> 12) & 63] +
			BASE64_ALPHABET[(n >> 6) & 63] +
			"=";
	}
	return out;
}

/**
 * Tolerant base64, as terminals answer OSC 52: bytes outside the alphabet
 * are skipped and an unpadded tail still decodes, since terminals differ on
 * both. Null for a payload no reading rescues -- a digit count of one past
 * a four-digit boundary carries no byte.
 */
function decode64(text: string): Uint8Array | null {
	const bytes = new Uint8Array((text.length * 3) >> 2);
	let held = 0;
	let bits = 0;
	let length = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		const value = code < 128 ? BASE64_CODES[code] : -1;
		if (value < 0) {
			continue;
		}
		held = (held << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[length++] = (held >> bits) & 0xff;
		}
	}
	if (bits >= 6) {
		return null;
	}
	return bytes.subarray(0, length);
}

/* ----------------------------------------------------------------- the OSC */

/**
 * OSC 2: the window title.
 *
 * The title is a document's, so it is untrusted text going somewhere the cell
 * grid never sees. A control character in it would end this sequence early and
 * leave the rest of the string to the terminal as its own commands, so the
 * same characters the grid refuses in a cell are dropped here: C0, DEL, and
 * the C1 range whose single bytes are CSI, OSC and DCS.
 */
export function setWindowTitle(text: string): string {
	let title = "";
	for (const char of text) {
		const code = char.codePointAt(0)!;
		if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
			continue;
		}
		title += char;
	}
	return `\x1b]2;${title}\x07`;
}

/** OSC 52: put text on the terminal's clipboard. */
export function clipboardWrite(text: string): string {
	return `\x1b]52;c;${encode64(new TextEncoder().encode(text))}\x07`;
}

/** OSC 52 with "?": ask the terminal for the clipboard's contents. */
export function clipboardQuery(): string {
	return "\x1b]52;c;?\x07";
}

/* --------------------------------------------------------- what comes back */

/**
 * The DOM `code` values for the keys whose physical identity a terminal escape
 * sequence pins down exactly, independent of any US-QWERTY assumption.
 */
const NAMED_KEY_CODES: Record<string, string> = {
	"Enter": "Enter",
	"Tab": "Tab",
	"Backspace": "Backspace",
	"Escape": "Escape",
	"ArrowUp": "ArrowUp",
	"ArrowDown": "ArrowDown",
	"ArrowLeft": "ArrowLeft",
	"ArrowRight": "ArrowRight",
	"Home": "Home",
	"End": "End",
	"Insert": "Insert",
	"Delete": "Delete",
	"PageUp": "PageUp",
	"PageDown": "PageDown",
	"F1": "F1",
	"F2": "F2",
	"F3": "F3",
	"F4": "F4",
	"F5": "F5",
	"F6": "F6",
	"F7": "F7",
	"F8": "F8",
	"F9": "F9",
	"F10": "F10",
	"F11": "F11",
	"F12": "F12",
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
 * Falls back to `Key<uppercased character>`, which is a guess.
 */
export function domCodeFor(keyName: string): string {
	const named = NAMED_KEY_CODES[keyName];
	if (named) {
		return named;
	}
	if (keyName.length === 1) {
		const upper = keyName.toUpperCase();
		if (upper >= "A" && upper <= "Z") {
			return `Key${upper}`;
		}
		if (keyName >= "0" && keyName <= "9") {
			return `Digit${keyName}`;
		}
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
interface KeyStroke {
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
			F: ["End", 35],
			H: ["Home", 36],
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
interface MouseReport {
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

/** The fences a terminal wraps pasted text in, DEC private mode 2004. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** The numbers an SGR mouse escape carries. */
interface MouseEscape {
	button: number;
	col: number;
	row: number;
	release: boolean;
}

/** One SGR mouse escape, whole, or null when the token is something else. */
export function decodeMouseEscape(token: string): MouseEscape | null {
	const match = token.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) {
		return null;
	}
	return {
		button: parseInt(match[1], 10),
		col: parseInt(match[2], 10),
		row: parseInt(match[3], 10),
		release: match[4] === "m",
	};
}

/** A CPR reply, as it was spelled, and where in the chunk it sat. */
interface CursorReport {
	text: string;
	row: number;
	col: number;
	index: number;
	length: number;
}

/**
 * The first cursor-position reply in a chunk that may also hold typing --
 * "jjj\x1b[12;1Rjjj" is one chunk -- so the caller can splice it out and let
 * the keystrokes through.
 */
export function decodeCursorReport(chunk: string): CursorReport | null {
	const match = chunk.match(/\x1b\[(\d+);(\d+)R/);
	if (!match) {
		return null;
	}
	return {
		text: match[0],
		row: parseInt(match[1], 10),
		col: parseInt(match[2], 10),
		index: match.index ?? 0,
		length: match[0].length,
	};
}

/** A DECRPM reply: the mode asked about, private modes keeping their "?". */
interface ModeReport {
	mode: string;
	value: number;
	index: number;
	length: number;
}

/** The first mode reply in a chunk, spliced the way a cursor report is. */
export function decodeModeReport(chunk: string): ModeReport | null {
	const match = chunk.match(/\x1b\[(\??)(\d+);(\d+)\$y/);
	if (!match) {
		return null;
	}
	return {
		mode: (match[1] ? "?" : "") + match[2],
		value: parseInt(match[3], 10),
		index: match.index ?? 0,
		length: match[0].length,
	};
}

/**
 * An OSC 52 clipboard reply found in a chunk. `text` is null while the
 * terminator has not arrived, and `end` is then the chunk's length: the
 * caller holds the tail and tries again with the next chunk.
 */
interface ClipboardReply {
	start: number;
	end: number;
	text: string | null;
}

/**
 * The clipboard reply a chunk carries, or null when it carries none. An OSC
 * ends in BEL or ST, and its body is base64 that no other reader would
 * survive tokenizing, so the whole utterance is read here.
 */
export function decodeClipboardReply(chunk: string): ClipboardReply | null {
	const start = chunk.indexOf("\x1b]52;");
	if (start === -1) {
		return null;
	}
	const reply = chunk
		.slice(start)
		.match(/^\x1b\]52;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/);
	if (!reply) {
		return {start, end: chunk.length, text: null};
	}
	// A payload no reading rescues answers as an empty clipboard: OSC 52
	// has no channel for saying more.
	const decoded = decode64(reply[1]);
	const text = decoded === null ? "" : new TextDecoder().decode(decoded);
	return {start, end: start + reply[0].length, text};
}

/**
 * The length of an incomplete escape sequence at the end of `chunk`, or 0.
 * Incomplete means a CSI (ESC [) whose final byte (0x40-0x7e) has not
 * arrived, or an SS3 (ESC O) missing its one final character. A bare
 * trailing ESC reports 0 -- it may be the Escape key itself, and holding it
 * for a continuation that never comes would swallow the keystroke.
 */
export function splitTrailingEscape(chunk: string): number {
	const esc = chunk.lastIndexOf("\x1b");
	if (esc === -1 || esc === chunk.length - 1) {
		return 0;
	}
	const kind = chunk[esc + 1];
	if (kind === "[") {
		for (let i = esc + 2; i < chunk.length; i++) {
			const code = chunk.charCodeAt(i);
			if (code >= 0x40 && code <= 0x7e) {
				return 0;
			} // finished
		}
		return chunk.length - esc;
	}
	if (kind === "O" && esc + 2 >= chunk.length) {
		return chunk.length - esc;
	}
	return 0;
}
