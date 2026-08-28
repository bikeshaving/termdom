/**
 * The escape sequences, as text: one duplex object that writes them and reads
 * what comes back.
 *
 * Nothing here touches a terminal. A Wire is a buffer and a lexer: the writer
 * half spells sequences into a buffer that take() drains, and the reader half
 * holds syntactic state only -- the tail of an escape sequence, a paste body,
 * or a clipboard reply that a chunk boundary cut mid-utterance. A sequence can
 * still be spelled without a session and read without one running.
 */

import {type ColorDepth, rgbTo256, rgbToBasic8} from "./color.js";

/* --------------------------------------------------------------- the style */

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
function sgrStyle(run: StyleRun, colorDepth: ColorDepth): string {
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

/* ------------------------------------------------------------ the refusals */

/**
 * The characters no payload may put on the wire: C0, DEL, and the C1 range
 * whose single bytes are CSI, OSC and DCS. One of these in untrusted text
 * would end the sequence around it or start one of its own, so everything
 * that writes text to the terminal refuses them.
 */
function isControlByte(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
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

/** The opening of an OSC 52 reply, the one OSC a terminal answers with. */
const CLIPBOARD_START = "\x1b]52;";

/**
 * The length of an incomplete escape sequence at the end of `chunk`, or 0.
 * Incomplete means a CSI (ESC [) whose final byte (0x40-0x7e) has not
 * arrived, an SS3 (ESC O) missing its one final character, or as much of the
 * clipboard reply's opening as has come -- past that opening the reply holds
 * itself, since its own terminator is what ends it. A bare trailing ESC
 * reports 0 -- it may be the Escape key itself, and holding it for a
 * continuation that never comes would swallow the keystroke.
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
	const tail = chunk.slice(esc);
	if (
		tail.length < CLIPBOARD_START.length &&
		CLIPBOARD_START.startsWith(tail)
	) {
		return tail.length;
	}
	return 0;
}

/**
 * A whole OSC 52 reply: the selection field, then a base64 payload, then BEL
 * or ST. The payload stops at ESC so a reply ended by ST still bounds it.
 */
const CLIPBOARD_REPLY = /^\x1b\]52;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/;

/**
 * One keystroke, read: the key its spelling names and the modifiers that
 * spelling carries. `key` is a name for the keys a terminal spells out
 * ("ArrowUp", "Enter") and the character itself for the rest; `char` is the
 * character the keystroke produces, empty when it produces none.
 */
export interface WireKey {
	kind: "key";
	key: string;
	char: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

/**
 * One utterance off the wire: a keystroke, an SGR mouse escape, a whole paste
 * body, or a reply to one of the probes. A clipboard reply's text is null when
 * the reply outgrew the held-reply limit before its terminator arrived.
 */
export type WireItem =
	WireKey |
	{kind: "mouse"; button: number; col: number; row: number; release: boolean} |
	{kind: "paste"; text: string} |
	{kind: "cursor-report"; row: number; col: number} |
	{kind: "mode-report"; mode: string; value: number} |
	{kind: "clipboard"; text: string | null};

/**
 * The rule that knows a question's answer: which of the wire's items carries
 * the reply, and what it says. The asking itself -- writing the request,
 * waiting, giving up -- is the session's business; the wire puts the request
 * in its buffer and hands back the match.
 */
export interface WireProbe<T> {
	/** The answer an item carries, or undefined when the item is not it. */
	matches(item: WireItem): T | undefined;
}

/** Shift+Tab: CSI Z, the one named spelling carrying a modifier of its own. */
const SHIFT_TAB = "\x1b[Z";

/**
 * The key each spelled-out token names. Enter is carriage return; line feed is
 * the Ctrl+J chord, which a terminal sends as its control byte like any other
 * letter's, and which an application binds if it wants a soft newline where
 * Enter already means something else. A lone ESC is the Escape key -- not the
 * start of a CSI or SS3 sequence, since the reader peels those off whole.
 *
 * F1-F4 arrive in the SS3 encoding, the modern xterm default. F5-F12 arrive as
 * CSI-tilde -- note the historical gap (no ~16), a quirk of the original xterm
 * numbering every terminal descended from it still follows.
 */
const KEY_BY_TOKEN: Record<string, string> = {
	"\r": "Enter",
	"\t": "Tab",
	[SHIFT_TAB]: "Tab",
	"\x7f": "Backspace",
	"\x1b": "Escape",
	"\x1b[A": "ArrowUp",
	"\x1b[B": "ArrowDown",
	"\x1b[C": "ArrowRight",
	"\x1b[D": "ArrowLeft",
	"\x1b[H": "Home",
	"\x1b[1~": "Home",
	"\x1b[F": "End",
	"\x1b[4~": "End",
	"\x1b[2~": "Insert",
	"\x1b[3~": "Delete",
	"\x1b[5~": "PageUp",
	"\x1b[6~": "PageDown",
	"\x1bOP": "F1",
	"\x1bOQ": "F2",
	"\x1bOR": "F3",
	"\x1bOS": "F4",
	"\x1b[15~": "F5",
	"\x1b[17~": "F6",
	"\x1b[18~": "F7",
	"\x1b[19~": "F8",
	"\x1b[20~": "F9",
	"\x1b[21~": "F10",
	"\x1b[23~": "F11",
	"\x1b[24~": "F12",
};

/** The cursor keys xterm's modified spelling names, by its final letter. */
const MODIFIED_CURSOR_KEYS: Record<string, string> = {
	A: "ArrowUp",
	B: "ArrowDown",
	C: "ArrowRight",
	D: "ArrowLeft",
	F: "End",
	H: "Home",
};

/**
 * xterm's extended CSI encoding for a modified cursor key: CSI 1 ; <mod>
 * <letter>, e.g. Alt+Up = CSI 1;3A, Shift+Home = CSI 1;2H. The reader yields
 * the whole sequence as one token -- it scans for the CSI final byte whatever
 * parameters precede it -- so this is pure decoding, no parsing changes.
 */
const MODIFIED_CURSOR_KEY = /^\x1b\[1;(\d+)([ABCDHF])$/;

/** What one key token means: the key it names, and its modifiers. */
function decodeKeyToken(token: string): WireKey {
	const code = token.charCodeAt(0);

	// Ctrl+<letter> arrives as a single raw ASCII control byte (Ctrl+A=0x01
	// ... Ctrl+Z=0x1A) -- there is no escape sequence, and no way to combine
	// it with Shift (the terminal only ever sends the one byte). Tab(0x09) and
	// Enter(0x0D) are excluded even though they fall in this range: those bytes
	// are what the physical Tab and Enter keys send, indistinguishable from
	// Ctrl+I and Ctrl+M, so the named key wins. Line feed(0x0A) collides with
	// no key and stays the Ctrl+J chord.
	if (code >= 1 && code <= 26 && code !== 9 && code !== 13) {
		return {
			kind: "key",
			key: String.fromCharCode(code + 96), // 0x01 -> 'a' ... 0x1A -> 'z'
			char: "",
			shiftKey: false,
			ctrlKey: true,
			altKey: false,
			metaKey: false,
		};
	}

	const modified = token.match(MODIFIED_CURSOR_KEY);
	if (modified) {
		// mod-1 is a bitmask: 1=Shift, 2=Alt, 4=Ctrl, 8=Meta (meta included for
		// spec-completeness; nothing on macOS actually sends it, since Cmd+key
		// never reaches the PTY at all).
		const bits = parseInt(modified[1], 10) - 1;
		return {
			kind: "key",
			key: MODIFIED_CURSOR_KEYS[modified[2]],
			char: "",
			shiftKey: (bits & 1) !== 0,
			altKey: (bits & 2) !== 0,
			ctrlKey: (bits & 4) !== 0,
			metaKey: (bits & 8) !== 0,
		};
	}

	// A token this table does not name is passed along as it arrived. What is
	// left produces a character when it is one character wide and neither a
	// control byte nor DEL -- every printable character, not only the ASCII
	// ones.
	return {
		kind: "key",
		key: KEY_BY_TOKEN[token] ?? token,
		char: token.length === 1 && code >= 32 && code !== 127 ? token : "",
		shiftKey: token === SHIFT_TAB,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
	};
}

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
	return decodeKeyToken(token);
}

/* ---------------------------------------------------------------- the wire */

const kOut = Symbol("out");
const kColorDepth = Symbol("colorDepth");
const kTail = Symbol("tail");
const kPasteBody = Symbol("pasteBody");
const kReplyBody = Symbol("replyBody");
const kReplyLimit = Symbol("replyLimit");

/**
 * The wire, both ways: a buffer of sequences waiting to go out, and the lexer
 * that says what came back.
 *
 * The writer half is fluent and every method returns the wire, so a frame's
 * bytes are spelled rather than concatenated -- `wire.cursorTo(row, 1)
 * .style(run).text(glyphs).eraseToLineEnd()` -- and take() hands the caller
 * everything spelled since the last one. Where a call site wants a single
 * spelling as a string, `wire.privateMode(2004, true).take()` is the idiom.
 *
 * The writer half is also the only door untrusted text has onto the wire.
 * text(), title() and clipboardWrite() are the three that carry a document's
 * own characters, and each makes what it carries safe: the first two drop the
 * bytes a terminal would read as commands, and the third base64s its payload
 * out of the question entirely. A cell's grapheme is refused earlier still --
 * carry() is where the screen asks, since a cell is a column and a refused
 * byte must be turned away before it takes one -- so the glyphs a frame emits
 * are safe before they ever reach text().
 *
 * The reader half owns every cut a chunk boundary can make. An escape sequence
 * split before its final byte is held for the next chunk -- but never a bare
 * trailing ESC, which may be the Escape key itself, and holding it would
 * swallow the keystroke. An open paste body is buffered until its end fence
 * and returned as one item; the body is literal text, and nothing inside it
 * is read except that fence. An open clipboard reply is buffered until its
 * terminator, and recognized whether or not anyone asked: its base64 would
 * otherwise type as keystrokes, and dropping an unasked-for answer is the
 * caller's decision to make, not a syntax accident.
 *
 * The two halves share an object and nothing else, and their lifecycles say
 * so. take() drains the write buffer and only the write buffer. Read state
 * survives everything except construction -- there is no reset -- because a
 * held tail or an open paste must never be droppable mid-stream.
 */
export class Wire {
	/** Everything spelled since the last take(), in order. */
	declare [kOut]: string[];
	/** What the terminal can display; style() spells colors at this depth. */
	declare [kColorDepth]: ColorDepth;
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

	/** A reader-only wire has no colors to spell and omits the depth. */
	constructor(colorDepth: ColorDepth = "rgb") {
		this[kOut] = [];
		this[kColorDepth] = colorDepth;
		this[kTail] = "";
		this[kPasteBody] = null;
		this[kReplyBody] = null;
	}

	/**
	 * What the wire will carry of one grapheme: the grapheme itself, or "" for
	 * one of the bytes no payload may put on the wire. The screen's cell writer
	 * asks here -- a cell is a column, and a control character taking one would
	 * leave the column holding an invisible byte.
	 */
	static carry(grapheme: string): string {
		return isControlByte(grapheme.codePointAt(0)!) ? "" : grapheme;
	}

	/** Everything spelled since the last take, and the buffer is empty again. */
	take(): string {
		const out = this[kOut].join("");
		this[kOut].length = 0;
		return out;
	}

	/* ---------------------------------------------------------- the cursor */

	/** CUP: the cursor to a one-based row and column. */
	cursorTo(row: number, col: number): this {
		this[kOut].push(`\x1b[${row};${col}H`);
		return this;
	}

	/** CUP with no parameters: the top-left cell. */
	cursorHome(): this {
		this[kOut].push("\x1b[H");
		return this;
	}

	/** CUF: the cursor forward by columns. */
	cursorForward(columns: number): this {
		this[kOut].push(`\x1b[${columns}C`);
		return this;
	}

	/** CUD: the cursor down by rows, stopping at the bottom margin. */
	cursorDown(rows: number): this {
		this[kOut].push(`\x1b[${rows}B`);
		return this;
	}

	/** DECSC: remember where the cursor is. */
	saveCursor(): this {
		this[kOut].push("\x1b7");
		return this;
	}

	/** DECRC: the cursor back to where DECSC left it. */
	restoreCursor(): this {
		this[kOut].push("\x1b8");
		return this;
	}

	/** IND: down one row, scrolling the screen when the cursor is at the end. */
	index(): this {
		this[kOut].push("\x1bD");
		return this;
	}

	/* ---------------------------------------------------------- the eraser */

	/** EL 0: from the cursor to the end of its row. */
	eraseToLineEnd(): this {
		this[kOut].push("\x1b[K");
		return this;
	}

	/** ED 0: from the cursor to the end of the screen. */
	eraseBelow(): this {
		this[kOut].push("\x1b[J");
		return this;
	}

	/** ED 2: the whole screen, cursor left where it stands. */
	eraseScreen(): this {
		this[kOut].push("\x1b[2J");
		return this;
	}

	/* --------------------------------------------------- the scroll region */

	/** DECSTBM: the scrolling region, one-based rows. Homes the cursor. */
	setScrollRegion(top: number, bottom: number): this {
		this[kOut].push(`\x1b[${top};${bottom}r`);
		return this;
	}

	/** DECSTBM with no parameters: the region is the whole screen again. */
	resetScrollRegion(): this {
		this[kOut].push("\x1b[r");
		return this;
	}

	/** DL: delete rows at the cursor, pulling the region up. */
	deleteLines(count: number): this {
		this[kOut].push(`\x1b[${count}M`);
		return this;
	}

	/** IL: insert blank rows at the cursor, pushing the region down. */
	insertLines(count: number): this {
		this[kOut].push(`\x1b[${count}L`);
		return this;
	}

	/* ----------------------------------------------------------- the style */

	/** SGR 0: back to the terminal's own defaults. */
	sgrReset(): this {
		this[kOut].push("\x1b[0m");
		return this;
	}

	/**
	 * SGR: the escape a run of style spells, at the wire's own color depth.
	 * A run that says nothing writes nothing -- no escape is ever emitted
	 * empty, since an empty SGR is the terminal's reset.
	 */
	style(run: StyleRun): this {
		const escape = sgrStyle(run, this[kColorDepth]);
		if (escape !== "") {
			this[kOut].push(escape);
		}
		return this;
	}

	/* ----------------------------------------------------------- the modes */

	/** DECSET/DECRST: engage or release a private mode by number. */
	privateMode(code: number, on: boolean): this {
		this[kOut].push(`\x1b[?${code}${on ? "h" : "l"}`);
		return this;
	}

	/** SM/RM: engage or release an ANSI mode by number. */
	ansiMode(code: number, on: boolean): this {
		this[kOut].push(`\x1b[${code}${on ? "h" : "l"}`);
		return this;
	}

	/** XTWINOPS 22: push the window title onto the terminal's own stack. */
	pushTitle(): this {
		this[kOut].push("\x1b[22;0t");
		return this;
	}

	/** XTWINOPS 23: pop the title the push saved. */
	popTitle(): this {
		this[kOut].push("\x1b[23;0t");
		return this;
	}

	/* --------------------------------------------------------- the payload */

	/**
	 * Glyphs, as themselves. The bytes the wire refuses are dropped: text is a
	 * document's, so a control character in it would end whatever sequence
	 * surrounds it and leave the rest of the string to the terminal as its own
	 * commands.
	 */
	text(glyphs: string): this {
		let safe = "";
		for (const char of glyphs) {
			if (isControlByte(char.codePointAt(0)!)) {
				continue;
			}
			safe += char;
		}
		this[kOut].push(safe);
		return this;
	}

	/**
	 * OSC 2: the window title. Untrusted text going somewhere the cell grid
	 * never sees, so it is refused the same characters a cell is.
	 */
	title(text: string): this {
		this[kOut].push("\x1b]2;");
		this.text(text);
		this[kOut].push("\x07");
		return this;
	}

	/**
	 * OSC 52: put text on the terminal's clipboard. Base64 puts the payload
	 * beyond refusing -- there is nothing in the alphabet to refuse.
	 */
	clipboardWrite(text: string): this {
		this[kOut].push(
			`\x1b]52;c;${encode64(new TextEncoder().encode(text))}\x07`,
		);
		return this;
	}

	/* ---------------------------------------------------------- the probes */

	/**
	 * DSR 6: where is the cursor? Answered by the next cursor report,
	 * one-based.
	 */
	cursorPositionProbe(): WireProbe<{row: number; col: number}> {
		this[kOut].push("\x1b[6n");
		return {
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
	modeProbe(mode: string): WireProbe<number> {
		this[kOut].push(
			mode.startsWith("?") ?
				`\x1b[?${parseInt(mode.slice(1), 10)}$p` :
				`\x1b[${parseInt(mode, 10)}$p`,
		);
		return {
			matches: (item) =>
				item.kind === "mode-report" && item.mode === mode ?
					item.value :
					undefined,
		};
	}

	/**
	 * OSC 52 with "?": what is on the clipboard? The answer is the reply's
	 * text, null when the reply outgrew the reader's held-reply limit.
	 */
	clipboardProbe(): WireProbe<string | null> {
		this[kOut].push("\x1b]52;c;?\x07");
		return {
			matches: (item) => (item.kind === "clipboard" ? item.text : undefined),
		};
	}

	/* ---------------------------------------------------------- the reader */

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
					if (reply.length <= Wire[kReplyLimit]) {
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
					items.push(decodeKeyToken(data.slice(i, i + 3)));
					i += 3;
					continue;
				}
			}
			items.push(decodeKeyToken(data[i]));
			i++;
		}
		return items;
	}
}
