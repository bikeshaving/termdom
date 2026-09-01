/**
 * The terminal session: what the terminal can do, what it has been told, and
 * what it says back.
 *
 * Everything above this file works in cells and events. The exchange asks the
 * terminal what it supports, keeps the ledger of every mode it put the
 * terminal into so they can all be undone on the way out, spells what it has
 * to say, and sorts what comes back into input for the engine and answers for
 * the queries it is still waiting on. Start at TerminalExchange.
 *
 * The sections in front of it are the conversation as text: the spellings
 * this side writes, and the reader that says what a chunk from the other side
 * meant. A sequence can be spelled with no session and read with none
 * running.
 *
 * The one terminal this engine ships a wrapper for -- a Node process -- is
 * written as an ordinary TerminalTransport at the end of the module, where
 * raw mode, the stdin listener and the signal handlers are all it can reach:
 * nothing above transportFromProcess names Node.
 */

import {recordClusterAdvance, type WidthMeasurer} from "./text.js";

/* -------------------------------------------------- the transport contract */

/** How many colors the terminal is believed to speak. */
export type ColorDepth = "ansi" | "rgb" | "256";

/** The terminal's dimensions, in cells. */
export interface TerminalSize {
	cols: number;
	rows: number;
}

export interface TerminalCloseInfo {
	/**
	 * Exit status, process semantics: the process wrapper hands it to
	 * process.exit; an SSH wrapper sends it as exit-status.
	 */
	status?: number;
	/** The signal that ended the session ("SIGHUP", "SIGTERM"), when one did. */
	signal?: string;
	reason?: string;
}

/**
 * The wire between the engine and a terminal: an established session as
 * duplex streams plus lifecycle, the common subset of WebTransport and
 * WebSocketStream. Everything Node-flavored -- raw mode, signals, env
 * sniffing -- belongs inside a wrapper, never in this contract.
 */
export interface TerminalTransport {
	/**
	 * The current size, as LIVE getters: after `resizes` emits, these answer
	 * with the new size. `resizes` is the notification, these are the value.
	 */
	readonly cols: number;
	readonly rows: number;
	/** What the terminal can display; the wrapper knows its terminal. */
	readonly colorDepth: ColorDepth;
	/**
	 * User input: keys, replies to queries, paste bursts. Chunks are strings,
	 * so code points never split; escape sequences MAY split across chunks
	 * (a network transport fragments arbitrarily), and the session
	 * reassembles them.
	 */
	readonly readable: ReadableStream<string>;
	/** Frames out. */
	readonly writable: WritableStream<string>;
	readonly resizes: ReadableStream<TerminalSize>;
	/**
	 * The screen holds prior content the app must not paint over (a shell
	 * prompt above), so rendering anchors at the cursor rather than row 0.
	 * True for a terminal shared with a shell; false for one the app owns
	 * from row 0 (an xterm embed, a fresh SSH pty).
	 */
	readonly sharesScreen: boolean;
	/**
	 * Whether the far end is a screen that interprets cursor movement.
	 * False for a pipe or a file; rendering degrades to plain appended
	 * lines.
	 */
	readonly interactive: boolean;
	/**
	 * Resolves when the transport is established. A process's tty and an
	 * xterm instance are established at construction (Promise.resolve());
	 * an SSH wrapper resolves it when its channel opens.
	 */
	readonly ready: Promise<void>;
	/**
	 * The terminal went away: hangup, disconnect, process exit. Always
	 * fulfills with a TerminalCloseInfo; fields may be absent.
	 */
	readonly closed: Promise<TerminalCloseInfo>;
	/**
	 * The app is done with the terminal (window.close()'s last act). A
	 * transport that owns its medium ends it -- the process transport exits
	 * the process with info's status; an SSH transport would end the channel.
	 * One that doesn't (an embedded pane, a test harness) implements this as
	 * a no-op: the engine has already flushed and disposed by the time it
	 * calls here.
	 */
	close(info?: TerminalCloseInfo): void;
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

/* ----------------------------------------------------------- the spellings */

/** DSR 6: where is the cursor? Answered by a cursor report, one-based. */
const CURSOR_QUERY = "\x1b[6n";
/** OSC 52 with "?": what is on the clipboard? */
const CLIPBOARD_QUERY = "\x1b]52;c;?\x07";
/** BDSM reset: the application decides the order of bidirectional text. */
const BIDI_EXPLICIT = "\x1b[8l";
/** BDSM set: the terminal reorders bidirectional text itself. */
const BIDI_IMPLICIT = "\x1b[8h";
/** EL 0: from the cursor to the end of its row. */
const LINE_ERASE = "\x1b[K";
/** ED 0: from the cursor to the end of the screen. */
const BELOW_ERASE = "\x1b[J";
/** ED 2 then CUP with no parameters: the screen blank, the cursor home. */
const SCREEN_CLEAR = "\x1b[2J\x1b[H";
/** IND: down one row, scrolling the screen when the cursor is at the end. */
const SCROLL_STEP = "\x1bD";

/** CUP: the cursor to the first column of a one-based row. */
function rowStart(row: number): string {
	return `\x1b[${row};1H`;
}

/**
 * DECRQM: what is this mode set to? The mode is spelled as DECRPM answers it,
 * a private mode keeping its "?" ("8", "?2027").
 */
function modeQuery(mode: string): string {
	return mode.startsWith("?") ?
		`\x1b[?${parseInt(mode.slice(1), 10)}$p` :
		`\x1b[${parseInt(mode, 10)}$p`;
}

/**
 * The characters no payload may put on the wire: C0, DEL, and the C1 range
 * whose single bytes are CSI, OSC and DCS. One of these in untrusted text
 * would end the sequence around it or start one of its own.
 */
function isControlByte(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

/**
 * OSC 2: the window title. Untrusted text going somewhere the cell grid never
 * sees, so it is refused the same characters a cell is -- dropped, since the
 * rest of the title is still the title.
 */
function titleEscape(text: string): string {
	let safe = "";
	for (const char of text) {
		if (isControlByte(char.codePointAt(0)!)) {
			continue;
		}
		safe += char;
	}
	return `\x1b]2;${safe}\x07`;
}

/**
 * OSC 52: put text on the terminal's clipboard. Base64 puts the payload
 * beyond refusing -- there is nothing in the alphabet to refuse.
 */
function clipboardEscape(text: string): string {
	return `\x1b]52;c;${encode64(new TextEncoder().encode(text))}\x07`;
}

/* --------------------------------------------------------- the mode ledger */

/**
 * The private modes and stack controls this engine sets, named once. `set`
 * engages, `reset` hands the terminal back. An orderly teardown resets what
 * was engaged, in this declaration order; the transport's panic paths
 * blanket-reset the union. A mode written anywhere else is a restore leak
 * waiting -- new modes are added here, and set through
 * TerminalExchange.setMode.
 */
const MODE_SPELLINGS = {
	motionReporting: {
		set: "\x1b[?1003h",
		reset: "\x1b[?1003l",
		panic: true,
	},
	mouseCapture: {
		set: "\x1b[?1002h\x1b[?1006h",
		reset: "\x1b[?1006l\x1b[?1002l",
		panic: true,
	},
	cursorHidden: {
		set: "\x1b[?25l",
		reset: "\x1b[?25h",
		panic: true,
	},
	bracketedPaste: {
		set: "\x1b[?2004h",
		reset: "\x1b[?2004l",
		panic: true,
	},
	// XTWINOPS 22 and 23: the window title onto the terminal's own stack, and
	// back off it.
	titleStack: {
		set: "\x1b[22;0t",
		reset: "\x1b[23;0t",
		panic: true,
	},
	// The Fullscreen API's screen switch. The panic spelling is ?1047, the
	// switch WITHOUT the cursor restore: a bare ?1049l restores a saved
	// cursor even when the alternate screen is not active (tmux and xterm
	// both), and the saved slot outlives whichever program set it. The
	// blanket restore cuts ahead of the queued payout, so a cursor-moving
	// reset there teleports the payout onto rows the app never owned.
	altScreen: {
		set: "\x1b[?1049h",
		reset: "\x1b[?1049l",
		panic: "\x1b[?1047l",
	},
	// Negotiated, not imposed: a terminal that ignored the offer must not
	// see the reset, so only the engaged-tracking restore may write it.
	clusterWidths: {
		set: "\x1b[?2027h",
		reset: "\x1b[?2027l",
		panic: false,
	},
} as const;

type ModeName = keyof typeof MODE_SPELLINGS;

const MODE_RESTORE_ORDER = Object.keys(MODE_SPELLINGS) as ModeName[];

/**
 * The blanket restore the panic paths write: each panic-marked mode's reset,
 * engaged or not -- a panic path cannot know, and each must therefore hold as
 * a no-op on a terminal the mode never touched. A mode whose ordinary reset
 * is not that no-op carries its own panic spelling instead.
 */
export const PANIC_RESTORE = MODE_RESTORE_ORDER.filter(
	(name) => MODE_SPELLINGS[name].panic,
).map((name) => {
	const {panic, reset} = MODE_SPELLINGS[name];
	return typeof panic === "string" ? panic : reset;
}).join("");

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
 * body, or a reply to one of the queries. A clipboard reply's text is null
 * when the reply outgrew the held-reply limit before its terminator arrived.
 */
type WireItem =
	WireKey |
	{kind: "mouse"; button: number; col: number; row: number; release: boolean} |
	{kind: "paste"; text: string} |
	{kind: "cursor-report"; row: number; col: number} |
	{kind: "mode-report"; mode: string; value: number} |
	{kind: "clipboard"; text: string | null};

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
	// ones, and a character outside the basic plane is one character across
	// the two code units that spell it.
	const astral = token.length === 2 && code >= 0xd800 && code <= 0xdbff;
	const printable =
		astral || (token.length === 1 && code >= 32 && code !== 127);
	return {
		kind: "key",
		key: KEY_BY_TOKEN[token] ?? token,
		char: printable ? token : "",
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

const kTail = Symbol("tail");
const kPasteBody = Symbol("pasteBody");
const kReplyBody = Symbol("replyBody");
const kReplyLimit = Symbol("replyLimit");

/**
 * The reader: one chunk in, what it meant out.
 *
 * It holds syntactic state and nothing else, and owns every cut a chunk
 * boundary can make. An escape sequence split before its final byte is held
 * for the next chunk -- but never a bare trailing ESC, which may be the
 * Escape key itself, and holding it would swallow the keystroke. An open
 * paste body is buffered until its end fence and returned as one item; the
 * body is literal text, and nothing inside it is read except that fence. An
 * open clipboard reply is buffered until its terminator, and recognized
 * whether or not anyone asked: its base64 would otherwise type as keystrokes,
 * and dropping an unasked-for answer is the session's decision to make, not a
 * syntax accident.
 *
 * State survives everything except construction -- there is no reset --
 * because a held tail or an open paste must never be droppable mid-stream.
 * One is built bare, with no session behind it, wherever a chunk needs
 * reading on its own.
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
					items.push(decodeKeyToken(data.slice(i, i + 3)));
					i += 3;
					continue;
				}
			}
			// A character outside the basic plane arrives as two code units,
			// and it is one keystroke: split, its halves are lone surrogates,
			// which name no key and spell no character.
			const code = data.charCodeAt(i);
			const width = code >= 0xd800 && code <= 0xdbff && i + 1 < data.length ?
				2 :
				1;
			items.push(decodeKeyToken(data.slice(i, i + width)));
			i += width;
		}
		return items;
	}
}

/* ------------------------------------------------------------ the exchange */

/** What the exchange tells the engine, as it works out what arrived. */
interface ExchangeHandlers {
	/** One chunk's contiguous keystrokes, as the reader decoded them. */
	onKeys(keys: WireKey[]): void;
	onMouse(button: number, x: number, y: number, release: boolean): void;
	onPaste(text: string): void;
	/**
	 * The terminal resized. A notification and nothing more: the transport's
	 * `cols`/`rows` are the value, and by the time this runs they answer with
	 * the new one.
	 */
	onResize(): void;
	/** Ctrl-C with no listener claiming it: the default action is window.close(). */
	onCloseRequest(): void;
	/** Where the region's start row is, once cursor detection lands. */
	onCommandStart(screenTop: number): void;
	/**
	 * The terminal answered that it reorders bidirectional text itself, so the
	 * renderer must hand it logical order.
	 */
	onTerminalReordersText(): void;
	/**
	 * The terminal reported an advance the width tables did not predict. Every
	 * width answered so far may have been answered wrongly, so the rows holding
	 * that cluster need repainting against the corrected measurement.
	 */
	onWidthCorrection(): void;
	/**
	 * A cluster the margin keeps turning away needs a frame to carry its probe
	 * train, and the document is not producing one. Repaint the least that
	 * gives the train a row to stand on.
	 */
	onWidthStarvation(): void;
	/** The transport's `closed` settled: the terminal is gone. */
	onClosed(info: TerminalCloseInfo): void;
}

/**
 * One question awaiting its answer: the kind of item that carries the reply,
 * the deadline, and for cursor questions the DSR send order that keeps them
 * and the width probes from taking each other's replies. Oldest first: the
 * first pending question an item fits is the one it answers, and an item
 * fitting none is a late or duplicate reply, dropped.
 */
interface PendingReply {
	/** The item kind that answers this question. */
	kind: WireItem["kind"];
	/** The mode a DECRPM answer must name; mode questions only. */
	mode?: string;
	/** Answer the asker with the item that fit, clearing the deadline. */
	settle(item: WireItem): void;
	/** Answer the asker with silence: the deadline, a replacement, dispose. */
	giveUp(): void;
	timer: ReturnType<typeof setTimeout>;
	/** DSR send order, cursor questions only. */
	sequence?: number;
	/** The clipboard question: one at a time, and dispose answers it null. */
	clipboard?: boolean;
}

const kTransport = Symbol("transport");
const kInteractive = Symbol("interactive");
const kEngagedModes = Symbol("engagedModes");
const kAnchorDetectionEnabled = Symbol("anchorDetectionEnabled");
const kHandlers = Symbol("handlers");

const kWriter = Symbol("writer");
const kReader = Symbol("reader");
const kResizeReader = Symbol("resizeReader");
const kStarted = Symbol("started");
const kDisposed = Symbol("disposed");
const kLastWrite = Symbol("lastWrite");
const kWriteBatch = Symbol("writeBatch");

const kWireReader = Symbol("wireReader");

const kHasDetectedCommandStart = Symbol("hasDetectedCommandStart");
const kCursorDetectionPromise = Symbol("cursorDetectionPromise");
const kDsrSequence = Symbol("dsrSequence");
const kPendingReplies = Symbol("pendingReplies");

const kPriorBidiMode = Symbol("priorBidiMode");
const kGraphemeClustersNegotiated = Symbol("graphemeClustersNegotiated");

const kClipboardQueryTimeout = Symbol("clipboardQueryTimeout");

const kProbingEnded = Symbol("probingEnded");
const kWidthProbes = Symbol("widthProbes");
const kWidthSettled = Symbol("widthSettled");
const kWidthAsked = Symbol("widthAsked");
const kWidthAnswered = Symbol("widthAnswered");
const kWidthProbing = Symbol("widthProbing");
const kWidthProbeTimer = Symbol("widthProbeTimer");
const kWidthProbeTimeout = Symbol("widthProbeTimeout");
const kWidthMeasurer = Symbol("widthMeasurer");

const kWidthStarved = Symbol("widthStarved");
const kStarvationTimer = Symbol("starvationTimer");
const kWidthStarvationWait = Symbol("widthStarvationWait");

const kDriftBatch = Symbol("driftBatch");
const kWidthRun = Symbol("widthRun");
const kWidthDrift = Symbol("widthDrift");
const kWidthRunLost = Symbol("widthRunLost");

/**
 * The conversation held over a transport: one reader, one writer, and the
 * demultiplexer between them.
 *
 * Everything the wire carries arrives interleaved on one byte stream -- that
 * is the terminal protocol's nature. The reader above says what each chunk
 * meant, and this is where the items fan out: pastes, DECRPM mode replies and
 * DSR cursor replies to whichever query waits, mouse reports, keystrokes. The
 * engine sees typed callbacks and dispatches DOM events; no other layer
 * parses input.
 *
 * The query half is the round-trips the engine cannot have synchronously. A
 * DSR cursor query locates the command-start row so the painted region
 * anchors correctly; DECRQM queries settle capabilities the renderer's
 * contract depends on (explicit bidi, grapheme-cluster widths). Answers may
 * never come -- most terminals implement no such modes -- so every query is
 * bounded by a timer, and silence is a valid answer meaning "no opinion,
 * ours stands". Every timer is tracked so dispose() can clear it; a live one
 * keeps the event loop open, which across a test suite is fatal.
 */
export class TerminalExchange {
	declare [kTransport]: TerminalTransport;
	declare [kInteractive]: boolean;
	// The modes currently set on the terminal, the source restore derives from.
	declare [kEngagedModes]: Set<ModeName>;
	declare [kAnchorDetectionEnabled]: boolean;
	declare [kHandlers]: ExchangeHandlers;

	declare [kWriter]: WritableStreamDefaultWriter<string> | null;
	declare [kReader]: ReadableStreamDefaultReader<string> | null;
	declare [kResizeReader]: ReadableStreamDefaultReader<TerminalSize> | null;
	declare [kStarted]: boolean;
	declare [kDisposed]: boolean;
	// The last queued write, so flush() can await everything before it.
	declare [kLastWrite]: Promise<void>;

	// The session's reader, one per session: the syntax and cross-chunk state
	// of what comes back -- split escapes, an open paste body, an open
	// clipboard reply -- live there, and this class only dispatches the items
	// it returns.
	declare [kWireReader]: WireReader;

	// Command start was resolved (even if at row 1). The resize re-anchor saves
	// and restores this around its redraw.
	declare [kHasDetectedCommandStart]: boolean;
	// Resolves when startup command-start detection settles (or times out), so
	// the first frame waits for the anchor rather than painting at row 0 first.
	declare [kCursorDetectionPromise]: Promise<void> | null;

	/**
	 * Every question written and not yet answered or given up on, oldest
	 * first: the anchor and re-anchor cursor queries, the DECRQM
	 * negotiations, the clipboard read. Each item off the wire answers the
	 * first question here that it fits. Two mode negotiations run
	 * concurrently at startup and their answers can arrive in either order --
	 * each names its own mode number, so neither takes the other's.
	 */
	declare [kPendingReplies]: PendingReply[];
	/** The BDSM state the terminal reported before we touched it, for dispose. */
	declare [kPriorBidiMode]: number | null;
	/** Whether the terminal agreed to grapheme-cluster widths (mode 2027). */
	declare [kGraphemeClustersNegotiated]: boolean;

	/**
	 * DSR queries in the order they went out. A terminal answers them in that
	 * order, so the sequence number is what keeps cursor detection and width
	 * measurement from taking each other's replies.
	 */
	declare [kDsrSequence]: number;
	/** Width probes written and not yet answered, oldest first. */
	declare [kProbingEnded]: boolean;
	declare [kWidthProbes]: Array<{
		cluster: string;
		run: number;
		batch: object;
		column: number;
		width: number;
		sequence: number;
		sentAt: number;
	}>;

	/**
	 * Clusters whose advance this session no longer wonders about: the terminal
	 * answered for them, or answered unreadably and the tables keep them.
	 *
	 * A cluster leaves this set never, and enters it only on a reply -- not on
	 * a probe. So a cluster the frame paints twice before either answer is
	 * asked about twice, which is what keeps a run's column arithmetic whole:
	 * every glyph whose advance is still in question carries its own query, and
	 * the replies come back in the same order the glyphs were painted.
	 */
	declare [kWidthSettled]: Set<string>;
	/**
	 * Every cluster that has ever carried a query, wherever it was asked from.
	 * A cluster in here is not starved however often the margin turns it away:
	 * it has had its question put, and the answer's fate is the queue's
	 * business. This is what bounds the probe train to one per cluster.
	 */
	declare [kWidthAsked]: Set<string>;
	/**
	 * Clusters the margin guard turned away that have never been asked about
	 * at all, waiting for a frame to carry their probe train. Right-aligned
	 * text is what fills this: its clusters land against the last column every
	 * time they are painted, so in place they would be deferred for the whole
	 * session.
	 */
	declare [kWidthStarved]: Set<string>;
	/** The wait for a frame the starved clusters could have ridden. */
	declare [kStarvationTimer]: ReturnType<typeof setTimeout> | null;
	/**
	 * Whether frames may still probe: false from the start when nothing
	 * interactive is behind the transport, and false for good once the
	 * terminal proves it does not answer.
	 */
	declare [kWidthProbing]: boolean;
	/** Whether the terminal has ever answered a width probe. */
	declare [kWidthAnswered]: boolean;
	declare [kWidthProbeTimer]: ReturnType<typeof setTimeout> | null;
	// The write batch and emission run the running divergence belongs to, and
	// the divergence itself: within one run each cluster's cells are reached by
	// advancing through the ones before it, so an earlier miscount displaces
	// every column after it by exactly this much. A reading that cannot be
	// believed leaves the drift unknown, and the rest of that run unreadable
	// with it.
	declare [kDriftBatch]: object | null;
	declare [kWidthRun]: number;
	declare [kWidthDrift]: number;
	declare [kWidthRunLost]: boolean;
	// Replaced by every write, so probes taken while building one frame are
	// told apart from probes taken while building the next.
	declare [kWriteBatch]: object;
	declare [kWidthMeasurer]: WidthMeasurer;

	/**
	 * Generous: the reply crosses whatever the transport is, and a terminal
	 * answering late is still answering. Only a session that gets NOTHING back
	 * gives up probing, and it can afford to wait to be sure.
	 */
	static readonly [kWidthProbeTimeout] = 2000;
	/**
	 * How long a starved cluster waits for a frame of the document's own
	 * before one is asked for on its behalf. Long enough that anything still
	 * animating, typing or scrolling carries the train for free.
	 */
	static readonly [kWidthStarvationWait] = 500;
	/**
	 * How long a clipboard query waits. Short on purpose: most terminals
	 * refuse clipboard reads and refusing is silence, so this is the delay
	 * every navigator.clipboard.readText() pays before rejecting. A terminal
	 * that does answer answers at typing latency.
	 */
	static readonly [kClipboardQueryTimeout] = 500;

	/**
	 * The frame's channel for measuring cluster advances. Whether asking is
	 * worth anything is not decided here: the channel reports this session's
	 * facts and the width authority judges them (see probingTeaches).
	 */
	get widthMeasurer(): WidthMeasurer {
		return this[kWidthMeasurer];
	}

	constructor(deps: {
		transport: TerminalTransport;
		handlers: ExchangeHandlers;
	}) {
		const interactive = deps.transport.interactive;
		this[kWriter] = null;
		this[kReader] = null;
		this[kResizeReader] = null;
		this[kStarted] = false;
		this[kDisposed] = false;
		this[kLastWrite] = Promise.resolve();
		this[kWireReader] = new WireReader();
		this[kHasDetectedCommandStart] = false;
		this[kCursorDetectionPromise] = null;
		this[kPendingReplies] = [];
		this[kPriorBidiMode] = null;
		this[kGraphemeClustersNegotiated] = false;
		this[kDsrSequence] = 0;
		this[kWidthProbes] = [];
		this[kProbingEnded] = false;
		this[kWidthSettled] = new Set<string>();
		this[kWidthProbing] = interactive;
		this[kWidthAnswered] = false;
		this[kWidthProbeTimer] = null;
		this[kDriftBatch] = null;
		this[kWidthRun] = -1;
		this[kWidthDrift] = 0;
		this[kWidthRunLost] = false;
		this[kWriteBatch] = {};
		this[kWidthAsked] = new Set();
		this[kWidthStarved] = new Set();
		this[kStarvationTimer] = null;
		this[kWidthMeasurer] = {
			probing: () => this[kWidthProbing],
			clusterWidthsNegotiated: () => this[kGraphemeClustersNegotiated],
			wants: (cluster: string) => !this[kWidthSettled].has(cluster),
			starved: () => this[kWidthStarved],
			defer: (cluster: string) => {
				// A cluster that has been asked about somewhere is not
				// starving, whatever this frame's margin did to it. So one
				// deferral of a cluster nothing has ever asked about IS the
				// starvation: the layout that put it there will put it there
				// again.
				if (
					this[kWidthAsked].has(cluster) ||
					this[kWidthStarved].has(cluster)
				) {
					return;
				}
				this[kWidthStarved].add(cluster);
				requestStarvationFrame(this);
			},
			probe: (cluster: string, run: number, column: number, width: number) => {
				// A teardown frame asks nothing: the reply would arrive
				// after the tty is handed back, typed into the next shell,
				// and the width it names will never be reused.
				if (this[kProbingEnded]) {
					return "";
				}
				this[kWidthAsked].add(cluster);
				this[kWidthStarved].delete(cluster);
				this[kWidthProbes].push({
					cluster,
					run,
					batch: this[kWriteBatch],
					column,
					width,
					sequence: this[kDsrSequence]++,
					sentAt: Date.now(),
				});
				armWidthProbeTimer(this);
				// The bytes go back to the caller rather than out: this ask
				// rides the frame that paints the cluster. Nothing joins the
				// pending table for it -- a width reply is claimed by the
				// queue above, in the DSR send order the sequence number
				// keeps.
				return CURSOR_QUERY;
			},
		};
		this[kTransport] = deps.transport;
		this[kInteractive] = interactive;
		this[kEngagedModes] = new Set<ModeName>();
		// A shared screen is one with a shell's rows above ours, which is what
		// there is an anchor to find; a terminal that answers nothing has none.
		this[kAnchorDetectionEnabled] = deps.transport.sharesScreen && interactive;
		this[kHandlers] = deps.handlers;
	}

	/**
	 * Write a mode's set or reset and track the engagement, so teardown can
	 * restore what was engaged and nothing else. Writing on change only makes
	 * re-deciding callers free.
	 */
	setMode(name: ModeName, on: boolean): void {
		if (on === this[kEngagedModes].has(name)) {
			return;
		}
		if (on) {
			this[kEngagedModes].add(name);
		} else {
			this[kEngagedModes].delete(name);
		}
		void this.write(
			on ? MODE_SPELLINGS[name].set : MODE_SPELLINGS[name].reset,
		);
	}

	/**
	 * Record an engagement whose set bytes ride another write -- frames hide
	 * the cursor as part of painting -- so the restore still covers it.
	 */
	markModeEngaged(name: ModeName): void {
		this[kEngagedModes].add(name);
	}

	/**
	 * Write a mode's set bytes and record the engagement, whether or not it
	 * was recorded already. A mode marked engaged because its bytes ride
	 * another write has none on the wire until that write happens, and a
	 * caller that needs the mode NOW cannot wait for it.
	 */
	engageMode(name: ModeName): void {
		this[kEngagedModes].add(name);
		void this.write(MODE_SPELLINGS[name].set);
	}

	/**
	 * Reset the engaged modes, in the table's order. The orderly half of the
	 * restore guarantee; the panic paths write the blanket union instead.
	 */
	restoreEngagedModes(): void {
		for (const name of MODE_RESTORE_ORDER) {
			if (this[kEngagedModes].delete(name)) {
				void this.write(MODE_SPELLINGS[name].reset);
			}
		}
	}

	/** Whether command-start anchoring runs: the default process transport only. */
	get anchorDetectionEnabled(): boolean {
		return this[kAnchorDetectionEnabled];
	}

	/**
	 * Whether command start was resolved. The resize re-anchor saves this,
	 * clears it across its redraw so the frame is placed by the screen reset
	 * rather than a stale detection, then restores it.
	 */
	get hasDetectedCommandStart(): boolean {
		return this[kHasDetectedCommandStart];
	}

	set hasDetectedCommandStart(value: boolean) {
		this[kHasDetectedCommandStart] = value;
	}

	/**
	 * Queue output on the transport, in order. The writer engages lazily on
	 * the first write. Returns the chunk's flush promise; flush() awaits the
	 * queue's tail.
	 */
	write(output: string): Promise<void> {
		// Probes are taken while a frame is being built and go out with it, so
		// each write ends the batch that can share a drift correction.
		this[kWriteBatch] = {};
		// A disposed session has released the wire; late writes are dropped.
		if (this[kDisposed] && !this[kWriter]) {
			return Promise.resolve();
		}
		if (!this[kWriter]) {
			this[kWriter] = this[kTransport].writable.getWriter();
		}
		this[kLastWrite] = this[kWriter].write(output).catch(() => {
			// A transport torn down mid-write (disconnect) is a close, not a
			// crash; the closed promise carries the real signal.
		});
		return this[kLastWrite];
	}

	/** Resolves when everything written so far has reached the transport. */
	flush(): Promise<void> {
		return this[kLastWrite];
	}

	/** Whether the transport takes input -- a pipe does not. */
	get interactive(): boolean {
		return this[kInteractive];
	}

	/**
	 * Adopt a different transport, in place. Only before the conversation
	 * begins: a rebind re-derives what the terminal decides -- whether it
	 * takes input, whether an anchor is findable -- and a live session
	 * cannot change terminals under its readers.
	 */
	rebind(transport: TerminalTransport): void {
		if (this[kStarted]) {
			throw new Error("rebind(): the session has already started");
		}
		this[kTransport] = transport;
		this[kInteractive] = transport.interactive;
		this[kAnchorDetectionEnabled] =
			transport.sharesScreen && transport.interactive;
	}

	/**
	 * Begin the conversation: acquire the readers and route input, resizes and
	 * closure to the engine's handlers. Idempotent.
	 */
	start(): void {
		if (this[kStarted]) {
			return;
		}
		this[kStarted] = true;

		this[kReader] = this[kTransport].readable.getReader();
		void readLoop(this, this[kReader]);

		this[kResizeReader] = this[kTransport].resizes.getReader();
		void resizeLoop(this, this[kResizeReader]);

		void this[kTransport].closed.then((info) => {
			if (!this[kDisposed]) {
				this[kHandlers].onClosed(info);
			}
		});
	}

	/**
	 * The outstanding startup command-start detection, or null once it has
	 * settled. The first interactive frame awaits this so it anchors at the
	 * resolved row rather than painting at row 0 first -- but only when one is
	 * actually pending. A settled probe returns null so the caller adds no
	 * async hop: an unconditional await would defer the rest of that frame a
	 * microtask even with nothing to wait for, and a synchronous scroll clamp
	 * depends on the frame running straight through.
	 */
	get cursorDetectionPending(): Promise<void> | null {
		return this[kCursorDetectionPromise];
	}

	/** Startup command-start detection, awaited by the first frame's anchor. */
	initializeCursorDetection(): void {
		this[kCursorDetectionPromise] = null;
		if (this[kAnchorDetectionEnabled]) {
			this[kCursorDetectionPromise] = Promise.race([
				this.detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it.
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					this[kHasDetectedCommandStart] = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait.
					this[kCursorDetectionPromise] = null;
				});
		}
	}

	/**
	 * Settle who reorders bidirectional text, us or the terminal.
	 *
	 * ECMA-48 mode 8 (BDSM) has two sides: *implicit*, where the terminal runs
	 * the bidi algorithm over what it receives, and *explicit*, where the
	 * application decides the order and the terminal paints cells as given. We
	 * need explicit, and not by preference: this renderer addresses cells
	 * directly and diffs frames, so it hands the terminal single cells at
	 * absolute positions. A terminal reordering each of those against a line it
	 * was never given whole would scramble the frame. So we ask for explicit
	 * and then ask what we got (DECRQM), rather than assuming either.
	 *
	 * The answer is a DECRPM value: 0 means the terminal does not recognise the
	 * mode at all -- no bidi, cells land as written, which is the same contract
	 * explicit gives us. 2 or 4 confirm explicit. 1 or 3 mean it intends to
	 * reorder anyway, and 3 (permanently set) means our request was refused; in
	 * that case we stop reordering and emit logical order, because the terminal
	 * doing it once beats both of us doing it.
	 *
	 * Silence is the common case -- most terminals answer nothing at all -- and
	 * is treated as "no bidi", which is what silence has always meant here.
	 */
	async negotiateBidi(): Promise<void> {
		if (!this[kInteractive]) {
			return;
		}

		// Explicit mode, then "what is mode 8 now?" in one write.
		const answer = await queryMode(this, "8", BIDI_EXPLICIT);

		// No bidi at all: cells land as written, which is the contract we want.
		if (answer === null || answer === 0) {
			return;
		}
		this[kPriorBidiMode] = answer;

		// 1 = still set, 3 = permanently set. Either way it reorders regardless
		// of what we asked, so hand it text in the order it expects.
		if (answer === 1 || answer === 3) {
			this[kHandlers].onTerminalReordersText();
		}
	}

	/**
	 * A terminal that does not implement a mode report may echo the
	 * request's final byte as text. Homing and erasing the line disposes
	 * of any echo, so the first frame starts on a clean row.
	 */
	scrubProbeEcho(): void {
		if (!this[kInteractive]) {
			return;
		}
		void this.write("\r" + LINE_ERASE);
	}

	/**
	 * Ask the terminal to measure text in grapheme CLUSTERS rather than by code
	 * point (DEC private mode 2027, the terminal-unicode-core specification).
	 *
	 * The default a terminal implements is POSIX wcwidth, which is per code
	 * point and predates emoji: it cannot express that a ZWJ family sequence or
	 * an emoji with a variation selector is one indivisible unit, so it
	 * advances the cursor once per code point in them. We measure by cluster --
	 * that is what stringWidth does -- so on such a terminal every cluster of
	 * more than one code point is a standing disagreement about where the next
	 * cell is.
	 *
	 * Mode 2027 is the fix the terminal community landed on, and it is asked
	 * for the same way as bidi: set it, then query it. A terminal that does not
	 * know the mode answers 0 or says nothing, and we simply carry on -- our
	 * measurements do not change, because they were already cluster-based; what
	 * changes is only whether the terminal agrees with them.
	 */
	async negotiateGraphemeClusters(): Promise<void> {
		if (!this[kInteractive]) {
			return;
		}

		const answer = await queryMode(
			this,
			"?2027",
			MODE_SPELLINGS.clusterWidths.set,
		);
		// 1 = set (it agrees now), 3 = permanently set (it always did).
		this[kGraphemeClustersNegotiated] = answer === 1 || answer === 3;
		if (this[kGraphemeClustersNegotiated]) {
			this.markModeEngaged("clusterWidths");
		}
	}

	/**
	 * Detect the current cursor position and set the viewport's command-start
	 * anchor. Sends DSR (`ESC[6n`) and waits for the `ESC[row;colR` reply.
	 */
	detectCommandStart(): Promise<number> {
		if (!this[kInteractive]) {
			return Promise.reject(
				new Error("Cannot detect cursor position: not interactive"),
			);
		}
		// The same second the mode queries allow: a cold start or a slow SSH
		// link can outlast a tighter window, and answering late is answering.
		return nextReply(this, "cursor-report", {
			ask: CURSOR_QUERY,
			timeoutMs: 1000,
			sequence: this[kDsrSequence]++,
			read: ({row}) => {
				// Convert 1-based terminal row to the 0-based anchor.
				this[kHandlers].onCommandStart(row - 1);
				this[kHasDetectedCommandStart] = true;
				return row;
			},
		});
	}

	/**
	 * Ask the terminal where the cursor is (DSR) and resolve with its 0-based
	 * row.
	 *
	 * Used by the resize re-anchor: the cursor is parked on our content's
	 * bottom row after every frame, so after a rewrap its position names where
	 * the frame actually ended up. Rejects on timeout so the caller can fall
	 * back to a computed anchor.
	 */
	queryCursorRow(): Promise<number> {
		if (!this[kInteractive]) {
			return Promise.reject(new Error("not interactive"));
		}
		// Queries can overlap: a drag fires resizes faster than the terminal
		// answers, and each handleResize issues its own. Each is its own
		// pending question, and DSR answers arrive in ask order, so every
		// query gets its own reply.
		//
		// Short timeout: the redraw should feel immediate, and a terminal
		// that does not answer promptly falls back to the computed re-anchor.
		return nextReply(this, "cursor-report", {
			ask: CURSOR_QUERY,
			timeoutMs: 200,
			sequence: this[kDsrSequence]++,
			read: ({row}) => row - 1,
		});
	}

	/** OSC 52: replace the terminal's clipboard with `text`. */
	writeClipboard(text: string): Promise<void> {
		return this.write(clipboardEscape(text));
	}

	/** OSC 2: set the terminal's title (the stack holds the prior one). */
	setTitle(text: string): Promise<void> {
		return this.write(titleEscape(text));
	}

	/** OSC 52 with "?": what is on the terminal's clipboard? */
	queryClipboard(): Promise<string | null> {
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve(null);
		}
		// One query at a time -- the reply carries no sequence, so a second
		// would have nothing to be told apart by. Asking again answers the
		// first asker with silence.
		abandonClipboardQuery(this);
		return nextReply(this, "clipboard", {
			ask: CLIPBOARD_QUERY,
			timeoutMs: TerminalExchange[kClipboardQueryTimeout],
			absent: null,
			clipboard: true,
			read: ({text}) => text,
		});
	}

	/** ED 2 then CUP: the screen blank, the cursor at its top-left cell. */
	clearScreen(): Promise<void> {
		return this.write(SCREEN_CLEAR);
	}

	/** CUP: the cursor to the first column of a one-based row. */
	cursorToRow(row: number): Promise<void> {
		return this.write(rowStart(row));
	}

	/** ED 0: from the cursor to the end of the screen. */
	eraseBelow(): Promise<void> {
		return this.write(BELOW_ERASE);
	}

	/**
	 * Lines that clear themselves: each opens by erasing the rest of its row,
	 * so nothing an older frame left beside it survives. The text's own last
	 * ending is left alone -- it ends the last line rather than opening
	 * another.
	 */
	writeLines(text: string): Promise<void> {
		return this.write(
			LINE_ERASE + text.replace(/\r\n(?!$)/g, "\r\n" + LINE_ERASE),
		);
	}

	/**
	 * Push the screen up by `rows`: from the bottom row a step down scrolls,
	 * one row at a time, and what leaves the top goes to the scrollback.
	 */
	scrollUp(bottomRow: number, rows: number): Promise<void> {
		return this.write(rowStart(bottomRow) + SCROLL_STEP.repeat(rows));
	}

	/**
	 * Wait for the reply of every outstanding cursor-position query --
	 * width probes, an anchor query -- or give up when the deadline
	 * passes. A reply that lands after the tty is handed back is typed
	 * into the caller's shell, so teardown holds the wire until the debt
	 * is paid or forfeited. Mode probes are not waited on: they belong to
	 * attach, and their stragglers have erase handling of their own.
	 */
	drainQueries(deadlineMs: number): Promise<void> {
		this[kProbingEnded] = true;
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve();
		}
		const settled = () =>
			this[kWidthProbes].length === 0 &&
			!this[kPendingReplies].some((entry) => entry.sequence !== undefined);
		if (settled()) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const deadline = Date.now() + deadlineMs;
			const timer = setInterval(() => {
				if (settled() || Date.now() >= deadline) {
					clearInterval(timer);
					resolve();
				}
			}, 10);
			// A process with nothing else to do may exit instead of
			// waiting out a forfeited deadline.
			timer.unref?.();
		});
	}

	dispose(): void {
		if (this[kDisposed]) {
			return;
		}
		this[kDisposed] = true;
		this[kProbingEnded] = true;

		// We asked for explicit bidi on the way in; give the terminal back the
		// mode it reported, so the next command inherits its own settings rather
		// than ours. Only when it was SET -- reset is where we left it anyway.
		if (this[kPriorBidiMode] === 1) {
			void this.write(BIDI_IMPLICIT);
			this[kPriorBidiMode] = null;
		}
		// The engaged modes go back too -- 2027 among them, for a terminal
		// that agreed to it. A terminal that never had a mode does not see
		// its reset, having never been set.
		this.restoreEngagedModes();
		this[kGraphemeClustersNegotiated] = false;
		// The clipboard read is answered with silence; the rest of the pending
		// questions are simply dropped, their timers cleared so nothing keeps
		// the event loop alive.
		abandonClipboardQuery(this);
		for (const entry of this[kPendingReplies]) {
			clearTimeout(entry.timer);
		}
		this[kPendingReplies].length = 0;
		if (this[kWidthProbeTimer] !== null) {
			clearTimeout(this[kWidthProbeTimer]);
			this[kWidthProbeTimer] = null;
		}
		if (this[kStarvationTimer] !== null) {
			clearTimeout(this[kStarvationTimer]);
			this[kStarvationTimer] = null;
		}
		this[kWidthProbes].length = 0;
		this[kWidthProbing] = false;

		// Release the wire: cancelling the readable is what hands a process
		// transport its tty back (raw mode off, stdin paused). The writer is
		// released after the restores above have been queued on it.
		if (this[kReader]) {
			void this[kReader].cancel().catch(() => {});
			this[kReader] = null;
		}
		if (this[kResizeReader]) {
			void this[kResizeReader].cancel().catch(() => {});
			this[kResizeReader] = null;
		}
		if (this[kWriter]) {
			const writer = this[kWriter];
			this[kWriter] = null;
			void this[kLastWrite].then(() => writer.releaseLock());
		}
	}
}

/* ------------------------------------------------------------ width probes */

/**
 * Wait for a frame the starved clusters can ride, and ask for one if none
 * comes.
 *
 * Starvation is discovered while a frame is being emitted, and that frame is
 * already past the point where its train would have gone -- so the clusters
 * need a later frame. A document still painting gives them one for nothing:
 * every frame carries whatever is starved when it starts. Only a document
 * that has gone quiet needs to be made to paint, and the wait is what tells
 * the two apart.
 */
function requestStarvationFrame(session: TerminalExchange): void {
	if (session[kStarvationTimer] !== null) {
		return;
	}
	session[kStarvationTimer] = setTimeout(() => {
		session[kStarvationTimer] = null;
		if (session[kDisposed] || session[kWidthStarved].size === 0) {
			return;
		}
		session[kHandlers].onWidthStarvation();
	}, TerminalExchange[kWidthStarvationWait]);
}

/**
 * Keep a deadline running for as long as any probe is outstanding, timed
 * from the oldest of them.
 */
function armWidthProbeTimer(session: TerminalExchange): void {
	if (session[kWidthProbeTimer] !== null) {
		return;
	}
	const oldest = session[kWidthProbes][0];
	if (oldest === undefined) {
		return;
	}
	const remaining = Math.max(
		0,
		oldest.sentAt + TerminalExchange[kWidthProbeTimeout] - Date.now(),
	);
	session[kWidthProbeTimer] = setTimeout(() => {
		session[kWidthProbeTimer] = null;
		// Unanswered this long is unanswered. The queue is what matches
		// replies to probes, so an abandoned probe must leave it; its
		// cluster keeps the tables' answer and is not asked again. Probes
		// written since the deadline was set are not late yet and keep
		// their place -- the deadline is per probe, and re-arms for the
		// oldest one still waiting.
		const deadline = Date.now() - TerminalExchange[kWidthProbeTimeout];
		let expired = 0;
		while (
			expired < session[kWidthProbes].length &&
			session[kWidthProbes][expired].sentAt <= deadline
		) {
			session[kWidthSettled].add(session[kWidthProbes][expired].cluster);
			expired++;
		}
		// Nothing has ever come back: this terminal does not answer DSR,
		// and asking it again each frame is asking forever. Fall open to
		// the tables.
		if (expired > 0 && !session[kWidthAnswered]) {
			session[kWidthProbing] = false;
			session[kWidthProbes].length = 0;
			session[kWidthStarved].clear();
			return;
		}
		session[kWidthProbes].splice(0, expired);
		armWidthProbeTimer(session);
	}, remaining);
}

/**
 * Settle one width probe against the column the terminal reports.
 *
 * The probe rode the frame that painted the cluster, so the reply's column
 * minus the column the cluster started from IS the advance -- corrected by
 * the drift the earlier unmeasured clusters of the same run introduced,
 * which their own replies have just established.
 */
function settleWidthProbe(
	session: TerminalExchange,
	probe: {
		cluster: string;
		run: number;
		batch: object;
		column: number;
		width: number;
	},
	replyColumn: number,
): void {
	session[kWidthAnswered] = true;
	// The deadline belonged to the probe just answered; whatever is still
	// waiting gets its own.
	if (session[kWidthProbeTimer] !== null) {
		clearTimeout(session[kWidthProbeTimer]);
		session[kWidthProbeTimer] = null;
	}
	armWidthProbeTimer(session);

	if (
		probe.batch !== session[kDriftBatch] || probe.run !== session[kWidthRun]
	) {
		session[kDriftBatch] = probe.batch;
		session[kWidthRun] = probe.run;
		session[kWidthDrift] = 0;
		session[kWidthRunLost] = false;
	}

	// An earlier reading in this run could not be believed, so the drift the
	// glyphs before this one introduced is unknown and its column means
	// nothing. Wait for a run whose arithmetic is whole.
	if (session[kWidthRunLost]) {
		return;
	}

	// Terminal columns are 1-based; the ledger counts cells.
	const advance = replyColumn - 1 - (probe.column + session[kWidthDrift]);
	// A reading no cluster could produce means the reply describes
	// something else -- a screen that scrolled under the frame, a terminal
	// answering out of turn. The tables keep the cluster, and the rest of
	// the run is read against a drift this reading did not establish.
	if (advance < 0 || advance > 4) {
		session[kWidthRunLost] = true;
		return;
	}

	session[kWidthSettled].add(probe.cluster);
	session[kWidthDrift] += advance - probe.width;
	if (recordClusterAdvance(probe.cluster, advance)) {
		session[kHandlers].onWidthCorrection();
	}
}

/* ---------------------------------------------------- input demultiplexing */

async function readLoop(
	session: TerminalExchange,
	reader: ReadableStreamDefaultReader<string>,
): Promise<void> {
	try {
		for (;;) {
			const {done, value} = await reader.read();
			if (done) {
				return;
			}
			if (!value) {
				continue;
			}
			try {
				route(session, value);
			} catch (err) {
				// Only the read can tell the conversation is over, so a
				// throw from routing -- a decode, a listener -- costs its
				// chunk and no more. Nothing here reports an error to the
				// document and swallowing one would hide it, so it is
				// raised again out of band while the read goes on.
				queueMicrotask(() => {
					throw err;
				});
			}
		}
	} catch (_err) {
		// Reader cancelled by dispose, or the transport died; either way the
		// conversation is over and closed/dispose carry the follow-up.
	}
}

async function resizeLoop(
	session: TerminalExchange,
	reader: ReadableStreamDefaultReader<TerminalSize>,
): Promise<void> {
	try {
		for (;;) {
			const {done, value} = await reader.read();
			if (done) {
				return;
			}
			if (value) {
				session[kHandlers].onResize();
			}
		}
	} catch (_err) {
		// As above: teardown, not error.
	}
}

/**
 * The demultiplexer: one pass over what the reader says a chunk meant, in
 * stream order. Contiguous keystrokes are batched into one onKeys call;
 * everything else is dispatched where it stands, so a report glued to fast
 * keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side.
 */
function route(session: TerminalExchange, chunk: string): void {
	let keys: WireKey[] = [];
	const flushKeys = () => {
		if (keys.length > 0) {
			session[kHandlers].onKeys(keys);
			keys = [];
		}
	};
	for (const item of session[kWireReader].feed(chunk)) {
		switch (item.kind) {
			case "key":
				// Ctrl-C: raw mode delivers it as data, and its default action
				// is the engine's to decide (window.close()), not this layer's.
				// Ctrl+c and nothing else is that one byte: no other spelling
				// decodes to the letter with the control modifier.
				if (item.ctrlKey && item.key === "c") {
					flushKeys();
					session[kHandlers].onCloseRequest();
					break;
				}
				keys.push(item);
				break;
			case "mouse":
				flushKeys();
				session[kHandlers].onMouse(
					item.button,
					item.col,
					item.row,
					item.release,
				);
				break;
			case "paste":
				flushKeys();
				session[kHandlers].onPaste(item.text);
				break;
			default:
				flushKeys();
				dispatchReply(session, item);
				break;
		}
	}
	flushKeys();
}

/* ------------------------------------------------------- query correlation */

/** The item of a given kind, for the reader that takes the answer out of it. */
type ReplyOf<K extends WireItem["kind"]> = Extract<WireItem, {kind: K}>;

/**
 * Ask, and answer with the reply.
 *
 * The question joins the pending table, the request goes out, and `read`
 * takes the answer out of whichever item comes back for it -- running where
 * the item is dispatched, so what it does besides reading happens in stream
 * order. The deadline is what ends a question no reply comes for: `absent`
 * names what silence answers with, and the only questions with no such answer
 * are the cursor ones, which reject instead.
 */
function nextReply<K extends WireItem["kind"], T>(
	session: TerminalExchange,
	kind: K,
	options: {
		/** The bytes that ask, whatever they ride behind. */
		ask: string;
		timeoutMs: number;
		read: (item: ReplyOf<K>) => T;
		absent?: T;
		mode?: string;
		sequence?: number;
		clipboard?: boolean;
	},
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const entry: PendingReply = {
			kind,
			mode: options.mode,
			sequence: options.sequence,
			clipboard: options.clipboard,
			settle: (item) => {
				clearTimeout(entry.timer);
				resolve(options.read(item as ReplyOf<K>));
			},
			giveUp: () => {
				clearTimeout(entry.timer);
				if (options.absent !== undefined) {
					resolve(options.absent);
				} else {
					reject(new Error("Timeout waiting for cursor position response"));
				}
			},
			timer: setTimeout(() => {
				const index = session[kPendingReplies].indexOf(entry);
				if (index !== -1) {
					session[kPendingReplies].splice(index, 1);
				}
				entry.giveUp();
			}, options.timeoutMs),
		};
		session[kPendingReplies].push(entry);
		void session.write(options.ask);
	});
}

/**
 * Answer the outstanding clipboard query with silence and forget it. Called
 * wherever the query ends without a reply: a replacement query, dispose.
 */
function abandonClipboardQuery(session: TerminalExchange): void {
	const pending = session[kPendingReplies];
	const index = pending.findIndex((entry) => entry.clipboard);
	if (index !== -1) {
		const [entry] = pending.splice(index, 1);
		entry.giveUp();
	}
}

/**
 * Route one reply item to whichever question it answers: the first pending
 * one it fits, and an item fitting none is dropped as a late, duplicate or
 * unasked-for answer.
 *
 * Cursor reports need one more rule. Two kinds of query share that reply
 * shape -- the anchor queries here and the width probes a frame appends
 * after a cluster -- and a terminal answers DSR in the order it was asked,
 * so the oldest outstanding query owns the reply and neither kind can take
 * the other's.
 */
function dispatchReply(session: TerminalExchange, item: WireItem): void {
	const pending = session[kPendingReplies];
	let index = -1;
	for (let i = 0; i < pending.length; i++) {
		if (pending[i].kind !== item.kind) {
			continue;
		}
		// Two mode negotiations can be outstanding at once, so a DECRPM answer
		// belongs to the one that asked about that mode.
		if (
			item.kind === "mode-report" &&
			pending[i].mode !== item.mode
		) {
			continue;
		}
		index = i;
		break;
	}
	if (item.kind === "cursor-report") {
		const width = session[kWidthProbes][0];
		if (
			width !== undefined &&
			(index === -1 || width.sequence < (pending[index].sequence ?? Infinity))
		) {
			session[kWidthProbes].shift();
			settleWidthProbe(session, width, item.col);
			return;
		}
	}
	if (index === -1) {
		return;
	}
	const [entry] = pending.splice(index, 1);
	entry.settle(item);
}

/**
 * Set a terminal mode and ask what it actually is now (DECRQM), resolving
 * with the reported value -- or null if the terminal says nothing, which is
 * the common case, since most implement no such mode and answer only the
 * queries they know. `prelude` is the set bytes the query rides behind, in
 * one write.
 *
 * The reply values are DECRPM's: 0 not recognised, 1 set, 2 reset, 3
 * permanently set, 4 permanently reset. 0 and silence mean the same thing
 * to every caller here -- the terminal has no opinion, so ours stands.
 */
function queryMode(
	session: TerminalExchange,
	mode: string,
	prelude: string,
): Promise<number | null> {
	// The same second the cursor query allows: a cold start or a slow SSH
	// link can outlast a tighter window, and answering late is answering.
	return nextReply<"mode-report", number | null>(session, "mode-report", {
		ask: prelude + modeQuery(mode),
		timeoutMs: 1000,
		absent: null,
		mode,
		read: ({value}) => value,
	});
}

/* --------------------------------------------------- the process transport */

// The Node process shape the default wrapper consumes. The engine itself
// never touches these: they exist so `transportFromProcess` can be typed
// against exactly the members it reads, and so tests can hand it mocks.
export interface TTYWriteStream {
	write(
		chunk: any,
		encoding?: string | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean;
	columns: number;
	rows: number;
	isTTY: boolean;
}

export interface TTYReadStream {
	isTTY: boolean;
	on(
		event: "data",
		listener: (chunk: string | Uint8Array | ArrayBuffer) => void,
	): unknown;
	removeListener?(
		event: "data",
		listener: (chunk: string | Uint8Array | ArrayBuffer) => void,
	): unknown;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
	setEncoding?(encoding?: string): this;
}

type ProcessSignal = "SIGWINCH" | "SIGINT" | "SIGTERM" | "SIGHUP" | "exit";

export interface ProcessLike {
	stdin?: TTYReadStream;
	stdout: TTYWriteStream;
	on(event: ProcessSignal, listener: () => void): unknown;
	removeListener?(event: ProcessSignal, listener: () => void): unknown;
	exit(code?: number): never;
	env: Record<string, string | undefined>;
}

function detectColorDepth(proc: ProcessLike): ColorDepth {
	const colorterm = proc.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "rgb";
	}

	const term = proc.env.TERM || "";
	if (term.includes("256color") || term.includes("256")) {
		return "256";
	}

	return "ansi";
}

// Frames keep the terminal cursor hidden, and dispose() shows it again -- but
// an app that calls process.exit() without disposing would strand the user's
// shell with no cursor. One process-level exit hook restores it for any
// process transport still engaged. Registered lazily, only once a transport
// actually takes its terminal.
const undisposedProcesses = new Set<ProcessLike>();
let exitHookInstalled = false;

function installCursorRestoreOnExit(): void {
	if (exitHookInstalled) {
		return;
	}
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const proc of undisposedProcesses) {
			try {
				proc.stdout.write(PANIC_RESTORE);
			} catch (_err) {
				// The stream may already be gone; the shell will survive.
			}
		}
	});
}

/**
 * A Node-process-shaped object as a TerminalTransport. Inert until used:
 * raw mode, the stdin listener, and the signal listeners engage on the
 * first read of `readable`. Cancelling the readable hands the tty back.
 */
export function transportFromProcess(
	proc: ProcessLike = process as unknown as ProcessLike,
	// The global process sits below a shell; a wrapped mock or relay owns
	// its screen unless the caller says otherwise.
	options: {sharesScreen?: boolean} = {},
): TerminalTransport {
	const sharesScreen =
		options.sharesScreen ?? proc === (process as unknown as ProcessLike);
	let closedResolve!: (info: TerminalCloseInfo) => void;
	const closed = new Promise<TerminalCloseInfo>((resolve) => {
		closedResolve = resolve;
	});

	let engaged = false;
	let dataListener:
		((chunk: string | Uint8Array | ArrayBuffer) => void) |
		null = null;
	const signalListeners: Array<[ProcessSignal, () => void]> = [];

	const disengage = () => {
		if (!engaged) {
			return;
		}
		engaged = false;
		undisposedProcesses.delete(proc);
		// Restore SYNCHRONOUSLY: the engine's own restores ride the writable's
		// queue, and `dispose(); process.exit()` exits before it flushes.
		// These are the modes whose survival breaks the user's shell; each is
		// idempotent, so the queued restores repeating them is harmless.
		proc.stdout.write(PANIC_RESTORE);
		if (dataListener && proc.stdin) {
			proc.stdin.removeListener?.("data", dataListener);
			dataListener = null;
		}
		const stdin = proc.stdin;
		if (stdin !== undefined) {
			stdin.setRawMode?.(false);
			stdin.pause();
		}
		for (const [signal, listener] of signalListeners) {
			proc.removeListener?.(signal, listener);
		}
		signalListeners.length = 0;
	};

	const readable = new ReadableStream<string>(
		{
			pull: (controller) => {
				if (engaged || !proc.stdin?.isTTY) {
					return;
				}
				engaged = true;

				const stdin = proc.stdin;
				stdin.setRawMode?.(true);
				stdin.resume();
				stdin.setEncoding?.("utf8");
				// Hosts without setEncoding deliver bytes; a streaming decoder
				// keeps a code point split across two chunks whole.
				const decoder = new TextDecoder();
				dataListener = (chunk: string | Uint8Array | ArrayBuffer) => {
					controller.enqueue(
						typeof chunk === "string" ?
							chunk :
								decoder.decode(chunk, {stream: true}),
					);
				};
				stdin.on("data", dataListener);

				// If the app dies without dispose, the exit hook restores the cursor.
				undisposedProcesses.add(proc);
				installCursorRestoreOnExit();

				// A SIGINT here is an external kill, never Ctrl-C -- raw mode delivers
				// that as \x03 on stdin. Resolve `closed` so the session disposes
				// (microtasks), then exit; SIGTERM/SIGHUP/exit likewise close, with
				// the process runtime handling the actual termination.
				const closeOn = (signal: ProcessSignal, exitAfter: boolean) => {
					const listener = () => {
						closedResolve({reason: signal});
						if (exitAfter) {
							setImmediate(() => proc.exit(0));
						}
					};
					signalListeners.push([signal, listener]);
					proc.on(signal, listener);
				};
				closeOn("SIGINT", true);
				closeOn("SIGTERM", true);
				closeOn("SIGHUP", true);
				closeOn("exit", false);
			},
			cancel: disengage,
			// HWM 0: pull only when a read is pending. The default (1) would pull at
			// construction, engaging the tty before attach -- the exact takeover the
			// attach() contract forbids.
		},
		{highWaterMark: 0},
	);

	const writable = new WritableStream<string>({
		// Resolve on the stream's own completion callback: awaiting a write
		// means the terminal HAS the bytes (a mock's emulator has ingested
		// them, a real stdout has flushed), which is what frame ordering and
		// "await a painted frame" rest on.
		write: (chunk) =>
			new Promise<void>((resolve, reject) => {
				proc.stdout.write(chunk, "utf8", (error?: Error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			}),
	});

	let resizeListener: (() => void) | null = null;
	const resizes = new ReadableStream<TerminalSize>(
		{
			pull: (controller) => {
				if (resizeListener) {
					return;
				}
				resizeListener = () => {
					controller.enqueue({
						cols: proc.stdout.columns || 80,
						rows: proc.stdout.rows || 24,
					});
				};
				proc.on("SIGWINCH", resizeListener);
			},
			cancel: () => {
				if (resizeListener) {
					proc.removeListener?.("SIGWINCH", resizeListener);
					resizeListener = null;
				}
			},
		},
		{highWaterMark: 0},
	);

	return {
		get cols() {
			return proc.stdout.columns || 80;
		},
		get rows() {
			return proc.stdout.rows || 24;
		},
		sharesScreen,
		interactive: proc.stdout.isTTY !== false,
		colorDepth: detectColorDepth(proc),
		ready: Promise.resolve(),
		readable,
		writable,
		resizes,
		closed,
		close(info?: TerminalCloseInfo) {
			disengage();
			proc.exit(info?.status ?? 0);
		},
	};
}
