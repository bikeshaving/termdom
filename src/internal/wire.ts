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
