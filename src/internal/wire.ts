/**
 * The escape sequences, as text: functions that write them, and a reader that
 * turns what comes back into typed items.
 *
 * Nothing here touches a terminal. The writers are pure -- numbers and
 * strings go in, a string comes out -- and the reader holds syntactic state
 * only: the tail of an escape sequence, a paste body, or a clipboard reply
 * that a chunk boundary cut mid-utterance. A sequence can still be tested
 * without a session and read without one running.
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
function privateModeQuery(code: number): string {
	return `\x1b[?${code}$p`;
}

/** DECRQM for an ANSI mode. */
function ansiModeQuery(code: number): string {
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

/**
 * A question and the rule that knows its answer: the bytes that ask, and
 * which of the wire's items carries the reply. The asking itself -- writing
 * the request, waiting, giving up -- is the session's business; wire only
 * pairs each spelling with its match.
 */
export interface WireProbe<T> {
	/** The bytes that ask. */
	request: string;
	/** The answer an item carries, or undefined when the item is not it. */
	matches(item: WireItem): T | undefined;
}

/** Where is the cursor? Answered by the next cursor report, one-based. */
export function cursorPositionProbe(): WireProbe<{row: number; col: number}> {
	return {
		request: cursorPositionQuery(),
		matches: (item) =>
			item.kind === "cursor-report" ?
					{row: item.row, col: item.col} :
				undefined,
	};
}

/**
 * DECRQM: what is this mode set to? The mode is spelled as DECRPM answers
 * it, a private mode keeping its "?" ("8", "?2027"), and the answer is the
 * DECRPM value for that mode alone.
 */
export function modeProbe(mode: string): WireProbe<number> {
	const request = mode.startsWith("?") ?
			privateModeQuery(parseInt(mode.slice(1), 10)) :
			ansiModeQuery(parseInt(mode, 10));
	return {
		request,
		matches: (item) =>
			item.kind === "mode-report" && item.mode === mode ?
				item.value :
				undefined,
	};
}

/**
 * OSC 52 with "?": what is on the clipboard? The answer is the reply's text,
 * null when the reply outgrew the reader's held-reply limit.
 */
export function clipboardProbe(): WireProbe<string | null> {
	return {
		request: clipboardQuery(),
		matches: (item) => (item.kind === "clipboard" ? item.text : undefined),
	};
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
function clipboardQuery(): string {
	return "\x1b]52;c;?\x07";
}

/* --------------------------------------------------------- what comes back */

/** The numbers an SGR mouse escape carries. */
interface MouseEscape {
	button: number;
	col: number;
	row: number;
	release: boolean;
}

/** One SGR mouse escape, whole, or null when the token is something else. */
function decodeMouseEscape(token: string): MouseEscape | null {
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

/** The fences a terminal wraps pasted text in, DEC private mode 2004. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * The length of an incomplete escape sequence at the end of `chunk`, or 0.
 * Incomplete means a CSI (ESC [) whose final byte (0x40-0x7e) has not
 * arrived, or an SS3 (ESC O) missing its one final character. A bare
 * trailing ESC reports 0 -- it may be the Escape key itself, and holding it
 * for a continuation that never comes would swallow the keystroke.
 */
function splitTrailingEscape(chunk: string): number {
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

/* -------------------------------------------------------------- the reader */

/** The opening of an OSC 52 reply, the one OSC a terminal answers with. */
const CLIPBOARD_START = "\x1b]52;";

/**
 * A whole OSC 52 reply: the selection field, then a base64 payload, then BEL
 * or ST. The payload stops at ESC so a reply ended by ST still bounds it.
 */
const CLIPBOARD_REPLY = /^\x1b\]52;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/;

/**
 * One utterance off the wire: a key token (a CSI or SS3 sequence, or a single
 * character), an SGR mouse escape, a whole paste body, or a reply to one of
 * the probes. A clipboard reply's text is null when the reply outgrew the
 * held-reply limit before its terminator arrived.
 */
export type WireItem =
	{kind: "key"; token: string} |
	{kind: "mouse"; button: number; col: number; row: number; release: boolean} |
	{kind: "paste"; text: string} |
	{kind: "cursor-report"; row: number; col: number} |
	{kind: "mode-report"; mode: string; value: number} |
	{kind: "clipboard"; text: string | null};

/** What one CSI token means: a mouse escape, a reply, or a keystroke. */
function decodeControlToken(token: string): WireItem {
	const mouse = decodeMouseEscape(token);
	if (mouse) {
		return {kind: "mouse", ...mouse};
	}
	const cursor = token.match(/^\x1b\[(\d+);(\d+)R$/);
	if (cursor) {
		return {
			kind: "cursor-report",
			row: parseInt(cursor[1], 10),
			col: parseInt(cursor[2], 10),
		};
	}
	const mode = token.match(/^\x1b\[(\??)(\d+);(\d+)\$y$/);
	if (mode) {
		return {
			kind: "mode-report",
			mode: (mode[1] ? "?" : "") + mode[2],
			value: parseInt(mode[3], 10),
		};
	}
	return {kind: "key", token};
}

const kTail = Symbol("tail");
const kPasteBody = Symbol("pasteBody");
const kReplyBody = Symbol("replyBody");
const kReplyLimit = Symbol("replyLimit");

/**
 * The read side of the wire, chunk by chunk: feed() takes raw input as a
 * transport delivers it and returns what it means, in stream order.
 *
 * The reader owns every cut a chunk boundary can make. An escape sequence
 * split before its final byte is held for the next chunk -- but never a bare
 * trailing ESC, which may be the Escape key itself, and holding it would
 * swallow the keystroke. An open paste body is buffered until its end fence
 * and returned as one item; the body is literal text, and nothing inside it
 * is read except that fence. An open clipboard reply is buffered until its
 * terminator, and recognized whether or not anyone asked: its base64 would
 * otherwise type as keystrokes, and dropping an unasked-for answer is the
 * caller's decision to make, not a syntax accident.
 */
export class WireReader {
	// An incomplete CSI or SS3 at a chunk's end, held for the next chunk.
	declare [kTail]: string;
	// The body of an open paste; null when no paste is in flight.
	declare [kPasteBody]: string | null;
	// An open clipboard reply, from its ESC ] 52 on; null when none is.
	declare [kReplyBody]: string | null;

	/**
	 * The most of a clipboard reply held while its terminator is awaited. A
	 * larger payload is not a clipboard a terminal is answering with, and the
	 * reader gives the reply up as null rather than buffer the wire.
	 */
	static readonly [kReplyLimit] = 1 << 16;

	constructor() {
		this[kTail] = "";
		this[kPasteBody] = null;
		this[kReplyBody] = null;
	}

	/** Read one chunk, and say what arrived. */
	feed(chunk: string): WireItem[] {
		let data = this[kTail] + chunk;
		this[kTail] = "";
		// Hold a split escape for its continuation -- but only a short one:
		// what outgrows a real sequence is not going to finish, and holding
		// it would swallow input for good.
		const held = splitTrailingEscape(data);
		if (held > 0 && held <= 32) {
			this[kTail] = data.slice(-held);
			data = data.slice(0, -held);
		}

		const items: WireItem[] = [];
		let i = 0;
		while (i < data.length) {
			// Inside a paste only the end fence means anything; a start fence
			// in the body must not restart one.
			if (this[kPasteBody] !== null) {
				const end = data.indexOf(PASTE_END, i);
				if (end === -1) {
					this[kPasteBody] += data.slice(i);
					return items;
				}
				items.push({
					kind: "paste",
					text: this[kPasteBody] + data.slice(i, end),
				});
				this[kPasteBody] = null;
				i = end + PASTE_END.length;
				continue;
			}
			// Inside a clipboard reply everything belongs to it until BEL or
			// ST closes it. A payload no reading rescues answers as an empty
			// clipboard: OSC 52 has no channel for saying more.
			if (this[kReplyBody] !== null) {
				const reply = this[kReplyBody] + data.slice(i);
				this[kReplyBody] = null;
				const match = reply.match(CLIPBOARD_REPLY);
				if (!match) {
					if (reply.length <= WireReader[kReplyLimit]) {
						this[kReplyBody] = reply;
					} else {
						items.push({kind: "clipboard", text: null});
					}
					return items;
				}
				const decoded = decode64(match[1]);
				items.push({
					kind: "clipboard",
					text: decoded === null ? "" : new TextDecoder().decode(decoded),
				});
				data = reply;
				i = match[0].length;
				continue;
			}
			if (data.startsWith(PASTE_START, i)) {
				this[kPasteBody] = "";
				i += PASTE_START.length;
				continue;
			}
			if (data.startsWith(CLIPBOARD_START, i)) {
				this[kReplyBody] = "";
				continue;
			}
			if (data[i] === "\x1b" && i + 1 < data.length) {
				if (data[i + 1] === "[") {
					// CSI: parameter/intermediate bytes end at a final byte
					// 0x40-0x7e.
					let end = i + 2;
					while (
						end < data.length &&
						!(data.charCodeAt(end) >= 0x40 && data.charCodeAt(end) <= 0x7e)
					) {
						end++;
					}
					items.push(
						decodeControlToken(data.slice(i, Math.min(end + 1, data.length))),
					);
					i = end + 1;
					continue;
				}
				if (data[i + 1] === "O" && i + 2 < data.length) {
					items.push({kind: "key", token: data.slice(i, i + 3)});
					i += 3;
					continue;
				}
			}
			items.push({kind: "key", token: data[i]});
			i++;
		}
		return items;
	}
}
