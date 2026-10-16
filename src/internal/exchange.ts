import type {Cascade} from "./cssom.ts";
import {
	constructInternal,
	dispatchAsUserAgent,
	Event,
	EventTarget,
	type EventTargetSlots,
	requestRender,
	syncMediaQueries,
	type Window,
} from "./dom.ts";
import {
	adoptCellPixels,
	flushProbes,
	type Framebuffer,
	repaintAll,
	replaced,
	resize,
	scrolled,
	wrappedRowsAbovePark,
} from "./framebuffer.ts";
import {dispatchInput, type Input} from "./input.ts";
import {
	adoptTerminalReordering,
	invalidateTextMeasurement,
	type Layout,
} from "./layout.ts";
import {_, type internals} from "./slots.ts";
import {isControlByte, recordClusterAdvance} from "./text.ts";
import {
	clearInterval,
	clearTimeout,
	queueMicrotask,
	setInterval,
	setTimeout,
} from "./timers.ts";

export type ColorDepth = "ansi" | "rgb" | "256";

export interface TerminalSize {
	cols: number;
	rows: number;
}

export interface TerminalCloseInfo {

	/** The process wrapper passes it to process.exit. SSH sends exit-status. */
	status?: number;
}

/**
 * A terminal as duplex streams plus lifecycle. Anything Node-specific
 * (raw mode, signals, env) belongs in a wrapper, not here.
 */
export interface TerminalTransport {

	/** Live. After `resizes` emits, these return the new size. */
	readonly cols: number;
	readonly rows: number;

	/**
	 * Chunks are strings, so code points never split. Escape sequences may
	 * split, and the exchange reassembles them.
	 */
	readonly readable: ReadableStream<string>;
	readonly writable: WritableStream<string>;
	readonly resizes: ReadableStream<TerminalSize>;

	/**
	 * The screen holds content above the app (a shell prompt), so rendering
	 * anchors at the cursor rather than row 0.
	 */
	readonly sharesScreen: boolean;

	/** False for a pipe or a file. Rendering degrades to appended lines. */
	readonly interactive: boolean;

	/**
	 * Writes an error's text somewhere the frame does not share, such as a
	 * stderr that is not the terminal. True when it did. The engine holds
	 * what the transport cannot place until the session ends, and prints
	 * it below the document then.
	 */
	logError?(text: string): boolean;

	/**
	 * Writes to the terminal at once, ahead of anything still queued, for
	 * what has to reach it as the process ends. Absent on a transport that
	 * cannot write synchronously.
	 */
	writeSync?(text: string): void;

	/**
	 * A pty is established at construction. An SSH channel resolves when it
	 * opens.
	 */
	readonly ready: Promise<void>;

	/** Hangup, disconnect, process exit. */
	readonly closed: Promise<TerminalCloseInfo>;

	/**
	 * Stops the program as a shell's job control does, and resolves when it
	 * continues. The engine hands the terminal back before it calls this
	 * and takes it again after. Absent where nothing can suspend the
	 * program, and Ctrl+Z is then an ordinary key.
	 */
	suspend?(): Promise<void>;

	/**
	 * window.close()'s last act, after the engine has flushed and disposed. A
	 * transport that owns its medium ends it. One that does not (an embedded
	 * pane, a test) does nothing.
	 */
	close(info?: TerminalCloseInfo): void;
}

const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_CODES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
	BASE64_CODES[BASE64_ALPHABET.charCodeAt(i)] = i;
}

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

// Tolerant, since terminals differ. Bytes outside the alphabet are
// skipped and an unpadded tail decodes. Null when the digit count
// carries no byte.
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

const CURSOR_QUERY = "\x1b[6n";
const CLIPBOARD_QUERY = "\x1b]52;c;?\x07";
// BDSM (mode 8). Reset means the application orders bidi text. Set
// means the terminal does.
const BIDI_EXPLICIT = "\x1b[8l";
const BIDI_IMPLICIT = "\x1b[8h";
const LINE_ERASE = "\x1b[K";
const BELOW_ERASE = "\x1b[J";
const SCREEN_CLEAR = "\x1b[2J\x1b[H";
const SCROLL_STEP = "\x1bD";

/** DECRQM. The mode is spelled as DECRPM reports it: "8", "?2027". */
function createModeQuery(mode: string): string {
	return mode.startsWith("?")
		? `\x1b[?${parseInt(mode.slice(1), 10)}$p`
		: `\x1b[${parseInt(mode, 10)}$p`;
}

// Every mode the engine sets, so teardown can reset what was engaged
// (in this order) and the panic paths can reset the union. A mode
// written anywhere else is a restore leak.
const MODE_SPELLINGS = {
	motionReporting: {set: "\x1b[?1003h", reset: "\x1b[?1003l", panic: true},
	mouseCapture: {
		set: "\x1b[?1002h\x1b[?1006h",
		reset: "\x1b[?1006l\x1b[?1002l",
		panic: true,
	},
	cursorHidden: {set: "\x1b[?25l", reset: "\x1b[?25h", panic: true},
	bracketedPaste: {set: "\x1b[?2004h", reset: "\x1b[?2004l", panic: true},
	// XTWINOPS 22 and 23: push the title onto the terminal's stack and pop
	// it back.
	titleStack: {set: "\x1b[22;0t", reset: "\x1b[23;0t", panic: true},
	// The panic spelling is ?1047, without the cursor restore. A bare
	// ?1049l restores a saved cursor even when the alternate screen is not
	// active (tmux and xterm both), which would teleport the queued output.
	altScreen: {set: "\x1b[?1049h", reset: "\x1b[?1049l", panic: "\x1b[?1047l"},
	// Negotiated. A terminal that ignored the offer must not see the reset.
	clusterWidths: {set: "\x1b[?2027h", reset: "\x1b[?2027l", panic: false},
} as const;

type ModeName = keyof typeof MODE_SPELLINGS;

const MODE_RESTORE_ORDER = Object.keys(MODE_SPELLINGS) as ModeName[];

// Written engaged or not, so each reset must be a no-op on a terminal
// the mode never touched.
const PANIC_RESTORE = MODE_RESTORE_ORDER.filter(
	(name) => MODE_SPELLINGS[name].panic,
).map((name) => {
	const {panic, reset} = MODE_SPELLINGS[name];
	return typeof panic === "string" ? panic : reset;
}).join("");

function decodeMouseEscape(
	token: string,
): {button: number; col: number; row: number; release: boolean} | null {
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

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CLIPBOARD_START = "\x1b]52;";
// The payload stops at ESC so a reply ended by ST is still bounded.
const CLIPBOARD_REPLY = /^\x1b\]52;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/;

/**
 * `key` is a name ("ArrowUp") or the character itself. `char` is empty when the
 * key produces none.
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

export interface WireMouse {
	kind: "mouse";
	button: number;
	col: number;
	row: number;
	release: boolean;
	// Wheel notches reported back to back at one cell, taken as one.
	ticks: number;
}

export interface WirePaste {
	kind: "paste";
	text: string;
}

// A clipboard reply's text is null when it outgrew the held-reply
// limit.
type WireItem =
	WireKey |
	WireMouse |
	WirePaste |
	{kind: "cursor-report"; row: number; col: number} |
	{kind: "mode-report"; mode: string; value: number} |
	{kind: "cell-size"; width: number; height: number} |
	{kind: "clipboard"; text: string | null} |
	{kind: "sgr-report"; params: string | null} |
	{kind: "capability-report"; known: boolean} |
	{kind: "secondary-attributes"; params: string} |
	{kind: "background"; red: number; green: number; blue: number} |
	{kind: "device-attributes"};

// The one named spelling that carries a modifier.
const SHIFT_TAB = "\x1b[Z";

// Line feed is not here. It is the Ctrl+J chord. A lone ESC is the
// Escape key, since the reader peels CSI and SS3 off whole. F1-F4 are
// SS3. F5-F12 are CSI-tilde with xterm's historical gap at 16.
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
	"\x1bOA": "ArrowUp",
	"\x1bOB": "ArrowDown",
	"\x1bOC": "ArrowRight",
	"\x1bOD": "ArrowLeft",
	"\x1b[H": "Home",
	"\x1b[1~": "Home",
	"\x1bOH": "Home",
	"\x1b[F": "End",
	"\x1b[4~": "End",
	"\x1bOF": "End",
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

const MODIFIED_CURSOR_KEYS: Record<string, string> = {
	A: "ArrowUp",
	B: "ArrowDown",
	C: "ArrowRight",
	D: "ArrowLeft",
	F: "End",
	H: "Home",
	P: "F1",
	Q: "F2",
	R: "F3",
	S: "F4",
};

// xterm's modified cursor and F1-F4 keys: CSI 1 ; <mod> <letter>, e.g.
// Alt+Up = CSI 1;3A.
const MODIFIED_CURSOR_KEY = /^\x1b\[1;(\d+)([ABCDHFPQRS])$/;

// xterm's modified tilde keys: CSI <n> ; <mod> ~, e.g. Ctrl+Delete =
// CSI 3;5~.
const MODIFIED_TILDE_KEY = /^\x1b\[(\d+);(\d+)~$/;

// A key with its modifiers spelled out, sent by a terminal that reports
// them all: CSI u (fixterms and kitty) as CSI <code>[:...] ; <mod>[:...]
// [; <text>] u, and xterm's modifyOtherKeys as CSI 27 ; <mod> ; <code> ~.
const CSI_U_KEY = /^\x1b\[(\d+)(?::[\d:]*)?(?:;(\d*)(?::\d*)?)?(?:;[\d:]*)?u$/;
const OTHER_KEY = /^\x1b\[27;(\d+);(\d+)~$/;

// The keys CSI u names by their control code rather than a character.
const KEY_BY_CODE: Record<number, string> = {
	8: "Backspace",
	9: "Tab",
	13: "Enter",
	27: "Escape",
	127: "Backspace",
};

// mod - 1 is a bitmask: 1 Shift, 2 Alt, 4 Ctrl, 8 Super, and in CSI u 32
// Meta. Super is the Meta key a browser reports.
function decodeModifiers(
	mod: string | undefined,
): {shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean} {
	const bits = mod === undefined || mod === "" ? 0 : parseInt(mod, 10) - 1;
	return {
		shiftKey: (bits & 1) !== 0,
		altKey: (bits & 2) !== 0,
		ctrlKey: (bits & 4) !== 0,
		metaKey: (bits & 40) !== 0,
	};
}

function decodeCodedKey(codepoint: number, mod: string | undefined): WireKey {
	const modifiers = decodeModifiers(mod);
	const named = KEY_BY_CODE[codepoint];
	let key = named ?? String.fromCodePoint(codepoint);
	if (named === undefined && modifiers.shiftKey) {
		key = key.toUpperCase();
	}
	const printable = named === undefined || key === " ";
	return {
		kind: "key",
		key,
		char:
			printable &&
				!modifiers.ctrlKey &&
				!modifiers.altKey &&
				!modifiers.metaKey
				? key
				: "",
		...modifiers,
	};
}

function decodeKeyToken(token: string): WireKey {
	const code = token.charCodeAt(0);

	// Ctrl+<letter> is one control byte. 0x09 and 0x0d are what Tab and
	// Enter send, indistinguishable from Ctrl+I and Ctrl+M, so the named
	// key wins. NUL is Ctrl+Space, and 0x1c to 0x1f are Ctrl with the four
	// punctuation keys after Z.
	if (code >= 1 && code <= 26 && code !== 9 && code !== 13) {
		return {
			kind: "key",
			key: String.fromCharCode(code + 96),
			char: "",
			shiftKey: false,
			ctrlKey: true,
			altKey: false,
			metaKey: false,
		};
	}
	if (code === 0 || (code >= 0x1c && code <= 0x1f)) {
		return {
			kind: "key",
			key: code === 0 ? " " : String.fromCharCode(code + 64),
			char: "",
			shiftKey: false,
			ctrlKey: true,
			altKey: false,
			metaKey: false,
		};
	}

	const modified = token.match(MODIFIED_CURSOR_KEY);
	if (modified) {
		return {
			kind: "key",
			key: MODIFIED_CURSOR_KEYS[modified[2]],
			char: "",
			...decodeModifiers(modified[1]),
		};
	}
	const other = token.match(OTHER_KEY);
	if (other) {
		return decodeCodedKey(parseInt(other[2], 10), other[1]);
	}
	const tilde = token.match(MODIFIED_TILDE_KEY);
	if (tilde && KEY_BY_TOKEN[`\x1b[${tilde[1]}~`] !== undefined) {
		return {
			kind: "key",
			key: KEY_BY_TOKEN[`\x1b[${tilde[1]}~`],
			char: "",
			...decodeModifiers(tilde[2]),
		};
	}
	const coded = token.match(CSI_U_KEY);
	if (coded) {
		return decodeCodedKey(parseInt(coded[1], 10), coded[2]);
	}

	// A character outside the basic plane is one character across two
	// units.
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

// A larger reply is not a clipboard. It is given up as null.
const REPLY_LIMIT = 1 << 16;
// A paste this large is delivered as it stands and the fence forgotten.
const PASTE_LIMIT = 1 << 20;
// A split sequence longer than this is not one a terminal sends.
const HOLD_LIMIT = 4096;

const STRING_OPENERS = new Set(["]", "P", "_", "^", "X"]);

// OSC 11 answered: the default background, each channel one to four hex
// digits, ended by BEL or ST.
const BACKGROUND_REPLY =
	/^\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i;

const BACKGROUND_QUERY = "\x1b]11;?\x1b\\";

const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
const SECONDARY_ATTRIBUTES_QUERY = "\x1b[>c";

// XTGETTCAP names its capabilities in hex.
const RGB_CAPABILITY = "524742";
const TC_CAPABILITY = "5463";

function readChannel(hex: string): number {
	return parseInt(hex, 16) / (16 ** hex.length - 1);
}

// DECRQSS answered for SGR: the parameters of the terminal's current
// style, as `0;53`, between DCS 1 $ r and m ST. DCS 0 $ r is a terminal
// (tmux, say) that has no answer for the request.
const SGR_REPORT = /^\x1bP([01])\$r([\d;:]*)m?\x1b\\/;

// XTGETTCAP answered: DCS 1 + r for a capability the terminal has, with
// its value when it has one, and DCS 0 + r for one it does not.
const CAPABILITY_REPORT = /^\x1bP([01])\+r[^\x1b]*\x1b\\/;

// Asked after setting a 24-bit color: the color comes back in the
// terminal's style when it keeps 24-bit color. Some write the color space
// slot of the colon form empty and iTerm2 writes 1, so only the last
// three numbers are read. A terminal without 24-bit color can read each
// number as an attribute of its own, so the channels are past every
// attribute's number and only the 2 lands, as faint, which 22 undoes.
const RGB_PROBE = "\x1b[38;2;111;122;133m\x1bP$qm\x1b\\\x1b[39;22m";
const RGB_STYLE =
	/(?:^|;)[34]8[:;]2(?:[:;]\d*)?[:;]111[:;]122[:;]133(?:;|$)/;

// The secondary device attributes tmux answers with, 84 being "T". No
// other terminal sends it.
const TMUX_ATTRIBUTES = /^84;/;

/**
 * Decodes one chunk into what it meant. Keeps what a chunk boundary can
 * cut: a split escape (never a bare trailing ESC, which may be the
 * Escape key), an open paste body, and an open clipboard reply. Nothing
 * here may hold the keystrokes that follow it for long: a paste that
 * never closes is delivered at a size, a sequence that never finishes is
 * dropped at a size, and a clipboard reply is only kept open while a
 * query is waiting for it.
 */
class WireReader {
	tail: string;
	pasteBody: string | null;
	replyBody: string | null;
	expectingReply: boolean;

	constructor() {
		this.tail = "";
		this.pasteBody = null;
		this.replyBody = null;
		this.expectingReply = false;
	}

	holdsEscape(): boolean {
		return this.tail === "\x1b";
	}

	/** What a held ESC meant once nothing followed it: the Escape key. */
	release(): WireItem[] {
		return this.feed("");
	}

	/**
	 * A clipboard reply nobody asked for is discarded whole rather than
	 * typed as keystrokes, and one still open when the asker gives up is
	 * discarded so the keystrokes behind it get through.
	 */
	expectClipboardReply(expecting: boolean): void {
		this.expectingReply = expecting;
		if (!expecting) {
			this.replyBody = null;
		}
	}

	/**
	 * `holdEscape` is for when a reply is due: a bare trailing ESC is then
	 * more likely a reply cut after its first byte than the Escape key, so
	 * it waits for the next chunk or for release().
	 */
	feed(chunk: string, holdEscape = false): WireItem[] {
		let data = this.tail + chunk;
		this.tail = "";
		const held = splitTrailingEscape(data, holdEscape);
		if (held > 0 && held <= HOLD_LIMIT) {
			this.tail = data.slice(-held);
			data = data.slice(0, -held);
		}

		const items: WireItem[] = [];
		let i = 0;
		while (i < data.length) {
			// Inside a paste only the end fence means anything.
			if (this.pasteBody !== null) {
				const end = data.indexOf(PASTE_END, i);
				if (end === -1) {
					this.pasteBody += data.slice(i);
					if (this.pasteBody.length > PASTE_LIMIT) {
						items.push({kind: "paste", text: this.pasteBody});
						this.pasteBody = null;
					}
					return items;
				}
				items.push({kind: "paste", text: this.pasteBody + data.slice(i, end)});
				this.pasteBody = null;
				i = end + PASTE_END.length;
				continue;
			}
			// A payload no decoding rescues is reported as an empty clipboard.
			if (this.replyBody !== null) {
				const reply = this.replyBody + data.slice(i);
				this.replyBody = null;
				const match = reply.match(CLIPBOARD_REPLY);
				if (!match) {
					if (reply.length <= REPLY_LIMIT) {
						this.replyBody = reply;
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
				this.pasteBody = "";
				i += PASTE_START.length;
				continue;
			}
			if (data.startsWith(CLIPBOARD_START, i) && this.expectingReply) {
				this.replyBody = "";
				continue;
			}
			// OSC, DCS, APC, PM and SOS are strings a terminal writes, not
			// keys it sends. One that arrives whole is discarded through its
			// terminator. One with no terminator in the same write is keys:
			// Escape and then a bracket is what a person typing sends too.
			if (data[i] === "\x1b" && data[i + 1] === "P") {
				const report = SGR_REPORT.exec(data.slice(i));
				if (report !== null) {
					items.push({
						kind: "sgr-report",
						params: report[1] === "1" ? report[2] : null,
					});
					i += report[0].length;
					continue;
				}
				const capability = CAPABILITY_REPORT.exec(data.slice(i));
				if (capability !== null) {
					items.push({kind: "capability-report", known: capability[1] === "1"});
					i += capability[0].length;
					continue;
				}
			}
			if (data[i] === "\x1b" && data[i + 1] === "]") {
				const background = BACKGROUND_REPLY.exec(data.slice(i));
				if (background !== null) {
					items.push({
						kind: "background",
						red: readChannel(background[1]),
						green: readChannel(background[2]),
						blue: readChannel(background[3]),
					});
					i += background[0].length;
					continue;
				}
			}
			if (
				data[i] === "\x1b" &&
				i + 1 < data.length &&
				STRING_OPENERS.has(data[i + 1])
			) {
				const end = findStringTerminator(data, i + 2);
				if (end !== -1) {
					i = end;
					continue;
				}
			}
			if (data[i] === "\x1b" && i + 1 < data.length) {
				if (data[i + 1] === "[") {
					let end = i + 2;
					while (
						end < data.length &&
						!(data.charCodeAt(end) >= 0x40 && data.charCodeAt(end) <= 0x7e)
					) {
						end++;
					}
					// A sequence with no final byte, or one nothing here names,
					// is not a keystroke.
					if (end < data.length) {
						const item = decodeControlToken(data.slice(i, end + 1));
						if (item.kind !== "key" || !item.key.includes("\x1b")) {
							items.push(item);
						}
					}
					i = end + 1;
					continue;
				}
				if (data[i + 1] === "O" && i + 2 < data.length) {
					const item = decodeKeyToken(data.slice(i, i + 3));
					if (!item.key.includes("\x1b")) {
						items.push(item);
					}
					i += 3;
					continue;
				}
				// ESC and a key in one write is that key with Alt, the way a
				// terminal sends it. A person pressing Escape and then a key
				// sends two writes.
				const next = data.charCodeAt(i + 1);
				if (next !== 0x1b && !(next >= 0x80 && next <= 0x9f)) {
					const width = next >= 0xd800 && next <= 0xdbff && i + 2 < data.length
						? 2
						: 1;
					const item = decodeKeyToken(data.slice(i + 1, i + 1 + width));
					items.push({...item, char: "", altKey: true});
					i += 1 + width;
					continue;
				}
			}
			// A C1 control is not a keystroke a terminal sends.
			const code = data.charCodeAt(i);
			if (code >= 0x80 && code <= 0x9f) {
				i++;
				continue;
			}
			// A surrogate pair is one keystroke.
			const width = code >= 0xd800 && code <= 0xdbff && i + 1 < data.length
				? 2
				: 1;
			items.push(decodeKeyToken(data.slice(i, i + width)));
			i += width;
		}
		return items;
	}
}

/** The index just past BEL or ST, or -1 when neither closes the string. */
function findStringTerminator(data: string, from: number): number {
	for (let i = from; i < data.length; i++) {
		if (data[i] === "\x07") {
			return i + 1;
		}
		if (data[i] === "\x1b" && data[i + 1] === "\\") {
			return i + 2;
		}
	}
	return -1;
}

function splitTrailingEscape(chunk: string, replyDue: boolean): number {
	// While a reply is due, an OSC or DCS cut before its terminator, even
	// between the ESC and backslash of its ST, is a reply.
	if (replyDue) {
		const opener = Math.max(
			chunk.lastIndexOf("\x1b]"),
			chunk.lastIndexOf("\x1bP"),
		);
		const inner = chunk.indexOf("\x1b", opener + 2);
		if (
			opener !== -1 &&
			findStringTerminator(chunk, opener + 2) === -1 &&
			(inner === -1 || inner === chunk.length - 1)
		) {
			return chunk.length - opener;
		}
		if (chunk.endsWith("\x1b") && !chunk.endsWith("\x1b\x1b")) {
			return 1;
		}
	}
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
			}
		}
		return chunk.length - esc;
	}
	if (kind === "O" && esc + 2 >= chunk.length) {
		return chunk.length - esc;
	}
	// A DCS reply cut before its terminator.
	if (kind === "P" && findStringTerminator(chunk, esc + 2) === -1) {
		return chunk.length - esc;
	}
	const tail = chunk.slice(esc);
	if (
		tail.length < CLIPBOARD_START.length && CLIPBOARD_START.startsWith(tail)
	) {
		return tail.length;
	}
	return 0;
}

function decodeControlToken(token: string): WireItem {
	const mouse = decodeMouseEscape(token);
	if (mouse) {
		return {kind: "mouse", ...mouse, ticks: 1};
	}
	if (/^\x1b\[\?[\d;]*c$/.test(token)) {
		return {kind: "device-attributes"};
	}
	const secondary = token.match(/^\x1b\[>([\d;]*)c$/);
	if (secondary) {
		return {kind: "secondary-attributes", params: secondary[1]};
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
	// XTWINOPS reports the cell height before its width.
	const cell = token.match(/^\x1b\[6;(\d+);(\d+)t$/);
	if (cell) {
		return {
			kind: "cell-size",
			height: parseInt(cell[1], 10),
			width: parseInt(cell[2], 10),
		};
	}
	return decodeKeyToken(token);
}

// A question awaiting its reply. The first pending question an item
// fits takes it. An item fitting none is a late or duplicate reply, and
// is dropped.
interface PendingReply {
	kind: WireItem["kind"];
	// Mode questions only: the mode a DECRPM reply must name.
	mode?: string;
	settle(item: WireItem): void;
	// Called on silence: the deadline, a replacement question, or dispose.
	giveUp(): void;
	timer: ReturnType<typeof setTimeout>;
	// Cursor questions only: DSR send order, shared with the width probes.
	sequence?: number;
	clipboard?: boolean;
	// The questions given up together, as the color depth's are.
	group?: string;
}

// Set on a process transport whose stdin is no terminal, so that what the
// terminal answers cannot be read, and nothing is asked of it.
const kReadsNoReplies = Symbol("readsNoReplies");

// How long a question to the terminal waits for an answer before it is
// taken as unanswered. A terminal that answers DA1 asked after it ends the
// wait sooner.
const QUERY_TIMEOUT_MS = 1000;

// Most terminals refuse clipboard reads by silence. This is what every
// readText() waits before rejecting.
const CLIPBOARD_QUERY_TIMEOUT_MS = 500;

// XTWINOPS 16: report the cell's size in pixels, as CSI 6 ; height ;
// width t.
const CELL_SIZE_QUERY = "\x1b[16t";

// A terminal replying late is still replying. Only one that never
// replies at all stops probing.
const WIDTH_PROBE_TIMEOUT_MS = 2000;
// Long enough that anything still animating or typing carries the probes.
const WIDTH_DEFERRAL_WAIT_MS = 500;
// A reply cut after its ESC has the rest in the next read. A person's
// Escape waits this long while a reply is due.
const ESCAPE_HOLD_MS = 50;
// How long dispose reads the cursor replies still owed.
const REPLY_DRAIN_MS = 200;

export interface ExchangeSlots extends EventTargetSlots {
	transport: TerminalTransport;
	escapeTimer: ReturnType<typeof setTimeout> | null;
	interactive: boolean;
	// Whether the terminal's answers can be read, so it is asked anything.
	asking: boolean;
	// The cell size asked for and not yet answered, which every caller
	// waits on rather than asking again.
	cellQuery: Promise<{width: number; height: number} | null> | null;
	engagedModes: Set<ModeName>;
	anchorDetectionEnabled: boolean;
	window: Window;
	layout: Layout;
	cascade: Cascade;
	framebuffer: Framebuffer;
	resizeTimer: ReturnType<typeof setTimeout> | null;
	// A token per resize burst, so a redraw that lands after a newer burst
	// began is abandoned. Null between bursts.
	settlingResize: object | null;
	transportClosed: boolean;
	defersResize: boolean;
	input: Input | null;
	writer: WritableStreamDefaultWriter<string> | null;
	reader: ReadableStreamDefaultReader<string> | null;
	resizeReader: ReadableStreamDefaultReader<TerminalSize> | null;
	started: boolean;
	disposed: boolean;
	lastWrite: Promise<void>;
	wireReader: WireReader;
	// The resize re-anchor saves and restores Exchange around its redraw.
	hasDetectedAnchor: boolean;
	cursorDetectionPromise: Promise<void> | null;
	// Oldest first. Two mode negotiations can be outstanding at once. Each
	// names its mode, so neither takes the other's reply.
	pendingReplies: PendingReply[];
	colorScheme: "light" | "dark" | null;
	interrupted: boolean;
	statedColorScheme: "light" | "dark" | undefined;
	terminalBackground: number | null;
	// The BDSM state the terminal reported before we touched it.
	priorBidiMode: number | null;
	graphemeClustersNegotiated: boolean;
	overlineNegotiated: boolean;
	// A terminal replies to DSR in ask order, so Exchange keeps cursor
	// detection and width probes from taking each other's replies.
	dsrSequence: number;
	// Teardown has begun. No frame may send another probe.
	probingEnded: boolean;
	widths: WidthProbes;
	owedReplies: number;
	endDrain: (() => void) | null;
	drained: Promise<void>;
}

export interface Exchange {
	readonly [internals]: ExchangeSlots;
}

/**
 * One reader, one writer, and the demultiplexer between them. Every
 * query is bounded by a timer, since most terminals reply with nothing.
 * Silence means the terminal has no opinion and ours holds. What the
 * terminal reports is applied to the screen and layout here. As an event
 * target it receives every event dispatched in the document after the
 * event's path, and dispatches seal and terminalclose on itself.
 */
export class Exchange extends EventTarget {
	constructor(
		transport: TerminalTransport,
		window: Window,
		layout: Layout,
		styles: Cascade,
		framebuffer: Framebuffer,
		colorScheme?: "light" | "dark",
	) {
		super();
		const slots = _(this);
		slots.statedColorScheme = colorScheme;
		const interactive = transport.interactive;
		const asking =
			interactive &&
			(transport as {[kReadsNoReplies]?: boolean})[kReadsNoReplies] !== true;
		slots.writer = null;
		slots.reader = null;
		slots.resizeReader = null;
		slots.started = false;
		slots.disposed = false;
		slots.lastWrite = Promise.resolve();
		slots.wireReader = new WireReader();
		slots.escapeTimer = null;
		slots.hasDetectedAnchor = false;
		slots.cursorDetectionPromise = null;
		slots.pendingReplies = [];
		slots.colorScheme = null;
		slots.interrupted = false;
		slots.terminalBackground = null;
		slots.priorBidiMode = null;
		slots.graphemeClustersNegotiated = false;
		slots.overlineNegotiated = false;
		slots.dsrSequence = 0;
		slots.probingEnded = false;
		slots.widths = createWidthProbes(asking);
		slots.owedReplies = 0;
		slots.endDrain = null;
		slots.drained = Promise.resolve();
		slots.transport = transport;
		slots.interactive = interactive;
		slots.asking = asking;
		slots.cellQuery = null;
		slots.engagedModes = new Set<ModeName>();
		// Anchor detection only makes sense when a shell's rows are above ours.
		slots.anchorDetectionEnabled = transport.sharesScreen && asking;
		slots.window = window;
		slots.layout = layout;
		slots.cascade = styles;
		slots.framebuffer = framebuffer;
		slots.input = null;
		slots.resizeTimer = null;
		slots.settlingResize = null;
		slots.transportClosed = false;
		slots.defersResize = false;
	}

	get interactive(): boolean {
		return _(this).interactive;
	}

	get resizing(): boolean {
		return _(this).settlingResize !== null;
	}

	get transportClosed(): boolean {
		return _(this).transportClosed;
	}

	/** Whether Ctrl-C closed the window. */
	get interrupted(): boolean {
		return _(this).interrupted;
	}

	/** The terminal's background as packed RGB, once it has said. */
	get terminalBackground(): number | null {
		return _(this).terminalBackground;
	}

	/**
	 * Whether the terminal's background is light or dark: what the terminal
	 * said, or before it has, what the program stated, and light without
	 * either.
	 */
	get colorScheme(): "light" | "dark" {
		const slots = _(this);
		return slots.statedColorScheme ?? slots.colorScheme ?? "light";
	}

	/**
	 * Null once settled, so the frame adds no async hop. Its scroll clamp is
	 * synchronous by contract.
	 */
	get cursorDetectionPending(): Promise<void> | null {
		return _(this).cursorDetectionPromise;
	}

	/**
	 * A terminal is behind the transport and has not proven it never replies.
	 */
	probing(): boolean {
		return _(this).widths.probing;
	}

	clusterWidthsNegotiated(): boolean {
		return _(this).graphemeClustersNegotiated;
	}

	overlineNegotiated(): boolean {
		return _(this).overlineNegotiated;
	}

	wantsWidth(cluster: string): boolean {
		return !_(this).widths.settled.has(cluster);
	}

	/**
	 * Deferred by the margin and never probed elsewhere. Right-aligned text
	 * would wait forever in place, so a frame measures these somewhere with
	 * room.
	 */
	deferredWidths(): ReadonlySet<string> {
		return _(this).widths.deferred;
	}

	/**
	 * Painted too near the last column for its reply to be readable. A
	 * cluster never probed that is deferred once is deferred every frame,
	 * because the layout that put it there will put it there again.
	 */
	deferWidth(cluster: string): void {
		const widths = _(this).widths;
		if (widths.asked.has(cluster) || widths.deferred.has(cluster)) {
			return;
		}
		widths.deferred.add(cluster);
		requestDeferredProbeFrame(this);
	}

	/**
	 * The bytes a frame appends after the cluster's glyph, painted at 0-based
	 * `column`. Probes sharing a `run` reached their columns by advancing
	 * through glyphs, so each one's divergence carries into the next. A
	 * cursor move starts a new run.
	 */
	probeWidth(
		cluster: string,
		run: number,
		column: number,
		width: number,
	): string {
		// A reply after the tty is handed back is typed into the next shell.
		const slots = _(this);
		if (slots.probingEnded) {
			return "";
		}
		const widths = slots.widths;
		widths.asked.add(cluster);
		widths.deferred.delete(cluster);
		widths.pending.push({
			cluster,
			run,
			batch: widths.writeBatch,
			column,
			width,
			sequence: slots.dsrSequence++,
			sentAt: Date.now(),
		});
		armWidthProbeTimer(this);
		return CURSOR_QUERY;
	}

	write(output: string): Promise<void> {
		// Probes taken while building one frame go out with it. A write ends
		// the batch that can share a drift correction.
		const slots = _(this);
		slots.widths.writeBatch = {};
		if (slots.disposed && !slots.writer) {
			return Promise.resolve();
		}
		if (!slots.writer) {
			slots.writer = slots.transport.writable.getWriter();
		}
		slots.lastWrite = slots.writer.write(output).catch(() => {
			// A transport torn down mid-write is a close, not a crash.
		});
		return slots.lastWrite;
	}

	writeClipboard(text: string): Promise<void> {
		return this.write(createClipboardEscape(text));
	}

	setTitle(text: string): Promise<void> {
		return this.write(createTitleEscape(text));
	}

	queryClipboard(): Promise<string | null> {
		const slots = _(this);
		if (!slots.interactive || slots.disposed) {
			return Promise.resolve(null);
		}
		// The reply carries no sequence, so one query at a time. Asking again
		// gives the first asker silence.
		abandonClipboardQuery(this);
		return nextReply(this, "clipboard", {
			ask: CLIPBOARD_QUERY,
			timeoutMs: CLIPBOARD_QUERY_TIMEOUT_MS,
			absent: null,
			clipboard: true,
			read: ({text}) => text,
		});
	}

	/**
	 * Hand the transport back. Cursor replies still owed are read for a
	 * while first, because a reply after the tty is handed back is typed
	 * into the shell. Mode queries are not waited on. Their stragglers are
	 * scrubbed. Resolves once the reader is let go.
	 */
	dispose(): Promise<void> {
		const slots = _(this);
		if (slots.disposed) {
			return slots.drained;
		}
		slots.disposed = true;
		const owed =
			slots.widths.pending.length +
			slots.pendingReplies.filter((entry) => entry.sequence !== undefined)
				.length;
		slots.probingEnded = true;
		if (slots.resizeTimer !== null) {
			clearTimeout(slots.resizeTimer);
			slots.resizeTimer = null;
		}
		if (slots.escapeTimer !== null) {
			clearTimeout(slots.escapeTimer);
			slots.escapeTimer = null;
		}

		// Only when it was set. Reset is where we left it anyway.
		if (slots.priorBidiMode === 1) {
			void this.write(BIDI_IMPLICIT);
			slots.priorBidiMode = null;
		}
		restoreEngagedModes(this);
		slots.graphemeClustersNegotiated = false;
		slots.overlineNegotiated = false;
		abandonClipboardQuery(this);
		for (const entry of slots.pendingReplies.splice(0)) {
			entry.giveUp();
		}
		const widths = slots.widths;
		if (widths.timer !== null) {
			clearTimeout(widths.timer);
			widths.timer = null;
		}
		if (widths.deferralTimer !== null) {
			clearTimeout(widths.deferralTimer);
			widths.deferralTimer = null;
		}
		widths.pending.length = 0;
		widths.probing = false;

		// Cancelling the readable hands a process transport its tty back. The
		// writer is released after the restores queued above.
		slots.drained = new Promise((resolve) => {
			const timer = setTimeout(() => slots.endDrain?.(), REPLY_DRAIN_MS);
			slots.owedReplies = owed;
			slots.endDrain = () => {
				clearTimeout(timer);
				slots.endDrain = null;
				if (slots.reader) {
					void slots.reader.cancel().catch(() => {});
					slots.reader = null;
				}
				resolve();
			};
		});
		if (owed === 0 || !slots.interactive || slots.transportClosed) {
			slots.endDrain?.();
		}
		if (slots.resizeReader) {
			void slots.resizeReader.cancel().catch(() => {});
			slots.resizeReader = null;
		}
		if (slots.writer) {
			const writer = slots.writer;
			slots.writer = null;
			void slots.lastWrite.then(() => writer.releaseLock());
		}
		return slots.drained;
	}
}

/** Leave the page's resize event to whoever handles terminalresize. */
export function deferResizeEvent(exchange: Exchange): void {
	_(exchange).defersResize = true;
}

/** Writes on change only. Teardown restores what was engaged. */
export function setDisplayType(
	exchange: Exchange,
	name: ModeName,
	on: boolean,
): void {
	const slots = _(exchange);
	if (!slots.interactive || on === slots.engagedModes.has(name)) {
		return;
	}
	if (on) {
		slots.engagedModes.add(name);
	} else {
		slots.engagedModes.delete(name);
	}
	let output = on ? MODE_SPELLINGS[name].set : MODE_SPELLINGS[name].reset;
	// tmux clears every mouse mode when any one of ?1000 to ?1003 is
	// reset, so turning motion reporting off took the button mode with
	// it and clicks stopped arriving. The base capture is asserted again.
	if (
		name === "motionReporting" && !on && slots.engagedModes.has("mouseCapture")
	) {
		output += MODE_SPELLINGS.mouseCapture.set;
	}
	void exchange.write(output);
}

/**
 * Resets every engaged mode without forgetting it, so the terminal is
 * the shell's while the program is suspended.
 */
export function releaseModes(exchange: Exchange): void {
	const slots = _(exchange);
	for (const name of MODE_RESTORE_ORDER) {
		if (slots.engagedModes.has(name)) {
			void exchange.write(MODE_SPELLINGS[name].reset);
		}
	}
	if (slots.priorBidiMode === 1) {
		void exchange.write(BIDI_IMPLICIT);
	}
}

/** Sets every engaged mode again once a suspended program continues. */
export function reclaimModes(exchange: Exchange): void {
	const slots = _(exchange);
	if (slots.priorBidiMode === 1) {
		void exchange.write(BIDI_EXPLICIT);
	}
	for (const name of MODE_RESTORE_ORDER) {
		if (slots.engagedModes.has(name)) {
			void exchange.write(MODE_SPELLINGS[name].set);
		}
	}
}

export function restoreEngagedModes(exchange: Exchange): void {
	for (const name of MODE_RESTORE_ORDER) {
		if (_(exchange).engagedModes.delete(name)) {
			void exchange.write(MODE_SPELLINGS[name].reset);
		}
	}
}

export function flushExchange(exchange: Exchange): Promise<void> {
	return _(exchange).lastWrite;
}

export function startExchange(exchange: Exchange, input: Input): void {
	const slots = _(exchange);
	if (slots.started) {
		return;
	}
	slots.started = true;
	slots.input = input;

	// A transport that learns its size while it gets ready, as an SSH
	// session does from its pty request, starts at that size.
	const transport = slots.transport;
	const framebuffer = slots.framebuffer;
	if (
		transport.cols !== framebuffer.cols || transport.rows !== framebuffer.rows
	) {
		terminalResized(exchange, transport.cols, transport.rows);
	}

	slots.reader = slots.transport.readable.getReader();
	void readLoop(exchange, slots.reader);

	slots.resizeReader = slots.transport.resizes.getReader();
	void resizeLoop(exchange, slots.resizeReader);

	void slots.transport.closed.then(() => {
		if (!slots.disposed) {
			slots.transportClosed = true;
			exchange.dispatchEvent(
				constructInternal(() => new Event("terminalclose")),
			);
		}
	});
}

export function initializeCursorDetection(exchange: Exchange): void {
	const slots = _(exchange);
	slots.cursorDetectionPromise = null;
	if (slots.anchorDetectionEnabled) {
		slots.cursorDetectionPromise = Promise.race([
			detectAnchor(exchange).then(() => {}),
			new Promise<void>((resolve) => setTimeout(resolve, QUERY_TIMEOUT_MS)),
		])
			.catch(() => {
				slots.hasDetectedAnchor = false;
			})
			.finally(() => {
				slots.cursorDetectionPromise = null;
			});
	}
}

/**
 * Ask for explicit bidi (mode 8 reset) and then ask what we got. The
 * diff hands the terminal single cells at absolute positions, which a
 * terminal reordering implicitly would scramble. A terminal that keeps
 * reordering anyway (1 or 3) is given logical order instead. Silence and
 * 0 mean no bidi, which is the contract explicit gives.
 */
export async function negotiateBidi(exchange: Exchange): Promise<void> {
	const slots = _(exchange);
	if (!slots.interactive) {
		return;
	}

	const answer = await queryMode(exchange, "8", BIDI_EXPLICIT);
	if (answer === null || answer === 0) {
		return;
	}
	slots.priorBidiMode = answer;
	if (answer === 1 || answer === 3) {
		adoptTerminalReordering(slots.layout);
	}
}

/**
 * What one cell measures in pixels. Silence leaves the guessed cell
 * standing, which is the contract an unanswered question gives
 * everywhere else here. A DA1 asked behind it ends the wait on a
 * terminal that does not answer. True when the cell changed.
 */
export async function negotiateCellPixels(
	exchange: Exchange,
): Promise<boolean> {
	const slots = _(exchange);
	const answer = await queryCellPixels(exchange);
	return (
		answer !== null &&
		!slots.disposed &&
		adoptCellPixels(slots.framebuffer, answer.width, answer.height)
	);
}

/**
 * One cell in the terminal's pixels, as it answers CSI 16 t, or null
 * when nothing can be asked or it does not say. A question already
 * asked is waited on, not asked again.
 */
export function queryCellPixels(
	exchange: Exchange,
): Promise<{width: number; height: number} | null> {
	const slots = _(exchange);
	if (!slots.interactive || slots.disposed) {
		return Promise.resolve(null);
	}
	slots.cellQuery ??= askCellPixels(exchange).finally(() => {
		slots.cellQuery = null;
	});
	return slots.cellQuery;
}

// The terminal answers its device attributes after anything asked before
// them, so no cell size by then is none.
function askCellPixels(
	exchange: Exchange,
): Promise<{width: number; height: number} | null> {
	let answered!: () => void;
	const until = new Promise<void>((resolve) => (answered = resolve));
	const cell = nextReply<"cell-size", {width: number; height: number} | null>(
		exchange,
		"cell-size",
		{
			ask: CELL_SIZE_QUERY,
			timeoutMs: QUERY_TIMEOUT_MS,
			absent: null,
			until,
			// A terminal with no window reports zeroes. That is not a cell.
			read: ({width, height}) =>
				width > 0 && height > 0 ? {width, height} : null,
		},
	);
	void queryDeviceAttributes(exchange).then(answered);
	return cell;
}

/**
 * The terminal's default background, as light or dark. Asked before
 * the cursor's position, which a terminal answers after it, so the
 * first frame's wait for the cursor covers this answer too.
 */
export async function negotiateColorScheme(
	exchange: Exchange,
): Promise<"light" | "dark" | null> {
	const slots = _(exchange);
	if (!slots.interactive) {
		return null;
	}
	return await nextReply<"background", "light" | "dark" | null>(
		exchange,
		"background",
		{
			ask: BACKGROUND_QUERY,
			timeoutMs: QUERY_TIMEOUT_MS,
			absent: null,
			read: ({red, green, blue}) => {
				slots.terminalBackground =
					(Math.round(red * 255) << 16) |
					(Math.round(green * 255) << 8) |
					Math.round(blue * 255);
				return (
					slots.colorScheme =
						0.2126 * red + 0.7152 * green + 0.0722 * blue <
					0.5
							? "dark"
							: "light"
				);
			},
		},
	);
}

/**
 * DA1, which every terminal answers, and answers after whatever it was
 * asked before: a marker that the questions ahead of it are settled.
 */
export function queryDeviceAttributes(exchange: Exchange): Promise<void> {
	if (!_(exchange).interactive) {
		return Promise.resolve();
	}
	return nextReply<"device-attributes", boolean>(
		exchange,
		"device-attributes",
		{
			ask: DEVICE_ATTRIBUTES_QUERY,
			timeoutMs: QUERY_TIMEOUT_MS,
			absent: false,
			read: () => true,
		},
	).then(() => {});
}

/**
 * Whether the terminal shows 24-bit color, from what it says over the
 * wire. It does when it keeps a 24-bit color in its style, or answers
 * XTGETTCAP for RGB or Tc. tmux says neither, but converts 24-bit color
 * for whatever terminal it runs in, so it counts too. Anything else gets
 * 256 colors, which every terminal in use draws.
 */
export async function negotiateColorDepth(
	exchange: Exchange,
): Promise<ColorDepth> {
	if (!_(exchange).interactive) {
		return "256";
	}
	const ask = <K extends WireItem["kind"]>(
		kind: K,
		question: string,
		read: (item: ReplyItem<K>) => boolean,
	) =>
		nextReply<K, boolean>(exchange, kind, {
			ask: question,
			timeoutMs: QUERY_TIMEOUT_MS,
			absent: false,
			read,
			group: "color-depth",
		});
	const answers = await Promise.all([
		ask(
			"sgr-report",
			RGB_PROBE,
			({params}) => params !== null && RGB_STYLE.test(params),
		),
		ask(
			"capability-report",
			`\x1bP+q${RGB_CAPABILITY}\x1b\\`,
			({known}) => known,
		),
		ask(
			"capability-report",
			`\x1bP+q${TC_CAPABILITY}\x1b\\`,
			({known}) => known,
		),
		ask("secondary-attributes", SECONDARY_ATTRIBUTES_QUERY, ({params}) =>
			TMUX_ATTRIBUTES.test(params)),
	]);
	return answers.includes(true) ? "rgb" : "256";
}

/** A terminal that answered a later question will not answer these. */
export function abandonColorDepthQuery(exchange: Exchange): void {
	const pending = _(exchange).pendingReplies;
	for (const entry of pending.filter(
		(entry) => entry.group === "color-depth",
	)) {
		pending.splice(pending.indexOf(entry), 1);
		entry.giveUp();
	}
}

/** A terminal that answered a later question will not answer this. */
export function abandonColorSchemeQuery(exchange: Exchange): void {
	const pending = _(exchange).pendingReplies;
	const index = pending.findIndex((entry) => entry.kind === "background");
	if (index !== -1) {
		const [entry] = pending.splice(index, 1);
		entry.giveUp();
	}
}

/** A terminal without DECRQM may echo the request's final byte as text. */
export function scrubProbeEcho(exchange: Exchange): void {
	if (!_(exchange).asking) {
		return;
	}
	void exchange.write("\r" + LINE_ERASE);
}

/**
 * Mode 2027: measure by grapheme cluster, as getStringWidth does, rather
 * than per code point as wcwidth does. A terminal that does not know the
 * mode leaves our measurements as they are. Only whether it agrees
 * changes.
 */
export async function negotiateGraphemeClusters(
	exchange: Exchange,
): Promise<void> {
	const slots = _(exchange);
	if (!slots.interactive) {
		return;
	}

	const answer = await queryMode(
		exchange,
		"?2027",
		MODE_SPELLINGS.clusterWidths.set,
	);
	slots.graphemeClustersNegotiated = answer === 1 || answer === 3;
	// The set went out with the query's own write. A terminal that ignored
	// it must not see the reset, so only an agreed offer is engaged.
	if (slots.graphemeClustersNegotiated) {
		slots.engagedModes.add("clusterWidths");
	}
}

/**
 * SGR 53, overline. No terminal advertises it, but one that draws it
 * keeps it in its style, and DECRQSS reports the style back. The
 * probe sets it, asks, and resets it in one write, so the terminal's
 * style is what it was. A terminal that says nothing draws none.
 */
export async function negotiateOverline(exchange: Exchange): Promise<boolean> {
	const slots = _(exchange);
	if (!slots.interactive) {
		return false;
	}
	const answer = await nextReply<"sgr-report", boolean>(
		exchange,
		"sgr-report",
		{
			ask: "\x1b[53m\x1bP$qm\x1b\\\x1b[55m",
			timeoutMs: QUERY_TIMEOUT_MS,
			absent: false,
			read: ({params}) =>
				params !== null && params.split(";").includes("53"),
		},
	);
	slots.overlineNegotiated = answer;
	return answer;
}

/**
 * DSR. The cursor row is the anchor. With `silence`, a terminal that
 * does not answer in time resolves to it, and the anchor stays.
 */
export function detectAnchor(
	exchange: Exchange,
	silence?: number,
): Promise<number> {
	const slots = _(exchange);
	if (!slots.interactive) {
		return Promise.reject(
			new Error("Cannot detect cursor position: not interactive"),
		);
	}
	// A cold start or a slow link can outlast a tighter window.
	return nextReply(exchange, "cursor-report", {
		ask: CURSOR_QUERY,
		timeoutMs: QUERY_TIMEOUT_MS,
		absent: silence,
		sequence: slots.dsrSequence++,
		// The 1-based row the command started on becomes the 0-based
		// anchor.
		read: ({row}) => {
			slots.framebuffer.documentTop = row - 1;
			slots.hasDetectedAnchor = true;
			return row;
		},
	});
}

/** The 0-based cursor row, for the resize re-anchor. Rejects on timeout. */
function queryCursorRow(exchange: Exchange): Promise<number> {
	const slots = _(exchange);
	if (!slots.interactive) {
		return Promise.reject(new Error("not interactive"));
	}
	// Short, because the redraw should feel immediate, and a slow terminal
	// falls back to the computed re-anchor.
	return nextReply(exchange, "cursor-report", {
		ask: CURSOR_QUERY,
		timeoutMs: 200,
		sequence: slots.dsrSequence++,
		read: ({row}) => row - 1,
	});
}

export function clearScreen(exchange: Exchange): Promise<void> {
	return exchange.write(SCREEN_CLEAR);
}

export function cursorToRow(exchange: Exchange, row: number): Promise<void> {
	return exchange.write(getRowStart(row));
}

export function eraseBelow(exchange: Exchange): Promise<void> {
	return exchange.write(BELOW_ERASE);
}

/** Each line starts by erasing the rest of its row. */
export function writeLines(exchange: Exchange, text: string): Promise<void> {
	return exchange.write(
		LINE_ERASE + text.replace(/\r\n(?!$)/g, "\r\n" + LINE_ERASE),
	);
}

/**
 * Room below the anchor for `rows` comes from scrolling earlier output
 * into the scrollback, never from painting over it. Returns the screen
 * row the region starts at.
 */
export function reserveRows(exchange: Exchange, rows: number): number {
	const framebuffer = _(exchange).framebuffer;
	const overflow = framebuffer.documentTop + rows - framebuffer.rows;
	const push = overflow <= 0 ? 0 : Math.min(overflow, framebuffer.documentTop);
	if (push > 0) {
		framebuffer.documentTop -= push;
		// The scroll moves the cursor to the bottom row first. Hidden, or
		// it shows there until the frame places it.
		setDisplayType(exchange, "cursorHidden", true);
		void scrollUp(exchange, framebuffer.rows, push);
		// The previous buffer is not shifted. Its rows are region-relative
		// and the region top moved by exactly the scroll. A pending
		// post-resize reset is screen-absolute and does shift.
		scrolled(framebuffer, push);
	}
	return framebuffer.documentTop;
}

/**
 * The scroll is IND (ESC D) from the bottom row. A bare LF after an
 * absolute CUP does not scroll (tmux and xterm-headless both), and CSI n S
 * scrolls without adding the rows to xterm-headless's scrollback, which
 * would make this untestable.
 */
function scrollUp(
	exchange: Exchange,
	bottomRow: number,
	rows: number,
): Promise<void> {
	return exchange.write(getRowStart(bottomRow) + SCROLL_STEP.repeat(rows));
}

function getRowStart(row: number): string {
	return `\x1b[${row};1H`;
}

// Untrusted text the cell grid never sees. Rejects the same bytes a
// cell does.
function createTitleEscape(text: string): string {
	let safe = "";
	for (const char of text) {
		if (isControlByte(char.codePointAt(0)!)) {
			continue;
		}
		safe += char;
	}
	return `\x1b]2;${safe}\x07`;
}

function createClipboardEscape(text: string): string {
	return `\x1b]52;c;${encode64(new TextEncoder().encode(text))}\x07`;
}

interface WidthProbes {
	// Oldest first.
	pending: Array<{
		cluster: string;
		run: number;
		batch: object;
		column: number;
		width: number;
		sequence: number;
		sentAt: number;
	}>;

	// Entered only on a reply, never on a probe. A cluster painted twice
	// before its reply is probed twice, which keeps a run's column
	// arithmetic whole.
	settled: Set<string>;
	// Ever probed, from anywhere. Bounds the probes to one per cluster.
	asked: Set<string>;
	// Turned away by the margin and never probed. Waiting for the deferral
	// timer.
	deferred: Set<string>;
	deferralTimer: ReturnType<typeof setTimeout> | null;
	// False for good once the terminal proves it does not reply.
	probing: boolean;
	answered: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	// Within one run each cluster's cells are reached by advancing through
	// the ones before, so an earlier miscount displaces every later column
	// by the drift. An unbelievable reading loses the rest of the run.
	driftBatch: object | null;
	run: number;
	drift: number;
	runLost: boolean;
	// Replaced by every write. Probes from one frame are distinguished
	// from the next's.
	writeBatch: object;
}

function createWidthProbes(probing: boolean): WidthProbes {
	return {
		pending: [],
		settled: new Set(),
		asked: new Set(),
		deferred: new Set(),
		deferralTimer: null,
		probing,
		answered: false,
		timer: null,
		driftBatch: null,
		run: -1,
		drift: 0,
		runLost: false,
		writeBatch: {},
	};
}

// Deferral is found mid-frame, past where the probes would have gone.
// A document still painting carries it on the next frame for free. Only
// a quiet one needs a frame requested.
function requestDeferredProbeFrame(session: Exchange): void {
	const sessionSlots = _(session);
	const widths = sessionSlots.widths;
	if (widths.deferralTimer !== null) {
		return;
	}
	widths.deferralTimer = setTimeout(() => {
		widths.deferralTimer = null;
		if (sessionSlots.disposed || widths.deferred.size === 0) {
			return;
		}
		// Deferred probes go out with the next frame even if nothing changed.
		flushProbes(sessionSlots.framebuffer);
		requestRender(sessionSlots.window.document);
	}, WIDTH_DEFERRAL_WAIT_MS);
}

// One deadline, timed from the oldest outstanding probe.
function armWidthProbeTimer(session: Exchange): void {
	const widths = _(session).widths;
	if (widths.timer !== null) {
		return;
	}
	const oldest = widths.pending[0];
	if (oldest === undefined) {
		return;
	}
	const remaining = Math.max(
		0,
		oldest.sentAt + WIDTH_PROBE_TIMEOUT_MS - Date.now(),
	);
	widths.timer = setTimeout(() => {
		widths.timer = null;
		// An abandoned probe leaves the queue that matches replies. Its cluster
		// keeps the tables' width and is not probed again.
		const deadline = Date.now() - WIDTH_PROBE_TIMEOUT_MS;
		let expired = 0;
		while (
			expired < widths.pending.length &&
			widths.pending[expired].sentAt <= deadline
		) {
			widths.settled.add(widths.pending[expired].cluster);
			expired++;
		}
		// Nothing has ever come back. This terminal does not reply to DSR.
		if (expired > 0 && !widths.answered) {
			widths.probing = false;
			widths.pending.length = 0;
			widths.deferred.clear();
			return;
		}
		widths.pending.splice(0, expired);
		armWidthProbeTimer(session);
	}, remaining);
}

// The reply's column minus the cluster's start column is the advance,
// corrected by the drift the run's earlier clusters introduced.
function settleWidthProbe(
	session: Exchange,
	probe: {
		cluster: string;
		run: number;
		batch: object;
		column: number;
		width: number;
	},
	replyColumn: number,
): void {
	const sessionSlots = _(session);
	const widths = sessionSlots.widths;
	widths.answered = true;
	if (widths.timer !== null) {
		clearTimeout(widths.timer);
		widths.timer = null;
	}
	armWidthProbeTimer(session);

	if (probe.batch !== widths.driftBatch || probe.run !== widths.run) {
		widths.driftBatch = probe.batch;
		widths.run = probe.run;
		widths.drift = 0;
		widths.runLost = false;
	}

	if (widths.runLost) {
		return;
	}

	const advance = replyColumn - 1 - (probe.column + widths.drift);
	// No cluster advances that far. The reply describes something else, a
	// scroll under the frame or a terminal replying out of turn.
	if (advance < 0 || advance > 4) {
		widths.runLost = true;
		return;
	}

	widths.settled.add(probe.cluster);
	widths.drift += advance - probe.width;
	// A cluster measured wider or narrower than the tables said, so every
	// column after it on a painted row is off. The previous frame described
	// a screen that was never drawn. Drop it and paint again from the
	// corrected measurements.
	if (recordClusterAdvance(probe.cluster, advance)) {
		invalidateTextMeasurement(sessionSlots.layout);
		repaintAll(sessionSlots.framebuffer);
		requestRender(sessionSlots.window.document);
	}
}

async function readLoop(
	session: Exchange,
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
				routeChunk(session, value);
			} catch (err) {
				// A throw from a listener costs its chunk, not the read. Raised
				// out of band rather than swallowed.
				queueMicrotask(() => {
					throw err;
				});
			}
		}
	} catch (_err) {
		// Cancelled by dispose, or the transport died.
	}
}

async function resizeLoop(
	session: Exchange,
	reader: ReadableStreamDefaultReader<TerminalSize>,
): Promise<void> {
	try {
		for (;;) {
			const {done, value} = await reader.read();
			if (done) {
				return;
			}
			if (value) {
				scheduleResize(session);
			}
		}
	} catch (_err) {
		// Teardown, not error.
	}
}

export class TerminalResizeEvent extends Event {
	readonly sizeChanged: boolean;
	constructor(sizeChanged: boolean) {
		super("terminalresize");
		this.sizeChanged = sizeChanged;
	}
}

const RESIZE_DEBOUNCE_MS = 40;

// A drag fires a SIGWINCH per width, and each redraw leaves reflowed
// junk in the scrollback, so the burst becomes one redraw. Renders are
// suppressed from the first SIGWINCH, or animation ticks paint at the
// stale anchor.
function scheduleResize(session: Exchange): void {
	const sessionSlots = _(session);
	sessionSlots.settlingResize = {};
	if (sessionSlots.resizeTimer !== null) {
		clearTimeout(sessionSlots.resizeTimer);
	}
	sessionSlots.resizeTimer = setTimeout(() => {
		sessionSlots.resizeTimer = null;
		handleResize(session);
	}, RESIZE_DEBOUNCE_MS);
}

function terminalResized(
	session: Exchange,
	width: number,
	height: number,
): void {
	const sessionSlots = _(session);
	const framebuffer = sessionSlots.framebuffer;
	// A SIGWINCH with an unchanged size still redraws but fires no event.
	const sizeChanged = width !== framebuffer.cols || height !== framebuffer.rows;
	resize(framebuffer, height, width);
	sessionSlots.layout.resize(width, height);
	// A size change can flip any @media result and every vw/vh value.
	sessionSlots.cascade.syncStylesheets();
	const window = sessionSlots.window;
	if (sizeChanged && !sessionSlots.defersResize) {
		dispatchAsUserAgent(
			window,
			constructInternal(() => new window.Event("resize")),
		);
	}
	syncMediaQueries(window.document);
	session.dispatchEvent(
		constructInternal(() => new TerminalResizeEvent(sizeChanged)),
	);
}

// The terminal has rewrapped the old frame with the text above it. The
// cursor was parked on the frame's bottom row and stayed on its line
// through the rewrap, and every painted row is a hard line, so the
// rewrapped height is computable: cursor row minus that height is the
// new top. A terminal that does not reply gets the computed re-anchor,
// exact for height changes.
function handleResize(session: Exchange): void {
	const sessionSlots = _(session);
	const {cols: newWidth, rows: newHeight} = sessionSlots.transport;
	terminalResized(session, newWidth, newHeight);
	// Where the frame is after the resize, for the re-anchor.
	const framebuffer = sessionSlots.framebuffer;
	const layout = sessionSlots.layout;
	layout.performLayout();
	const contentHeight = layout.documentPaintHeight();
	const wrappedRowsAbove = wrappedRowsAbovePark(framebuffer, newWidth);
	const documentTop = framebuffer.documentTop;
	const settling = sessionSlots.settlingResize;

	// The frame now starts at startRow. Repaint it from there.
	const redraw = (startRow: number) => {
		framebuffer.documentTop = startRow;
		replaced(framebuffer, startRow);
		requestRender(sessionSlots.window.document);

		// The frame is placed by the screen reset. Cursor detection is
		// suspended until it is written.
		sessionSlots.settlingResize = null;
		const wasDetected = sessionSlots.hasDetectedAnchor;
		sessionSlots.hasDetectedAnchor = false;
		sessionSlots.window.requestAnimationFrame(() => {
			sessionSlots.hasDetectedAnchor = wasDetected;
		});
	};

	const computedReanchor = () => {
		const scrolledUp = Math.max(0, documentTop + contentHeight - newHeight);
		return Math.max(0, documentTop - scrolledUp);
	};

	// The anchor holds only while the frame fits below it. When it does
	// not, the terminal scrolled by an amount DSR cannot report, and making
	// room on the mis-anchor strands a copy of our rows. Start at the top,
	// at the cost of the output above.
	const place = (startRow: number) => {
		redraw(startRow + contentHeight <= newHeight ? startRow : 0);
	};

	if (sessionSlots.anchorDetectionEnabled && wrappedRowsAbove !== null) {
		queryCursorRow(session)
			.then((cursorRow) => {
				if (settling !== sessionSlots.settlingResize) {
					return;
				}
				place(Math.max(0, cursorRow - wrappedRowsAbove));
			})
			.catch(() => {
				if (settling !== sessionSlots.settlingResize) {
					return;
				}
				place(computedReanchor());
			});
	} else {
		place(computedReanchor());
	}
}

// Contiguous keystrokes are one dispatch. Everything else is dispatched
// in place, so a report glued to fast keystrokes eats neither side.
function routeChunk(session: Exchange, chunk: string): void {
	const sessionSlots = _(session);
	if (sessionSlots.disposed) {
		drainChunk(session, chunk);
		return;
	}
	if (sessionSlots.escapeTimer !== null) {
		clearTimeout(sessionSlots.escapeTimer);
		sessionSlots.escapeTimer = null;
	}
	const reader = sessionSlots.wireReader;
	const replyDue =
		sessionSlots.widths.pending.length > 0 ||
		sessionSlots.pendingReplies.length > 0;
	routeItems(session, reader.feed(chunk, replyDue));
	if (reader.holdsEscape()) {
		sessionSlots.escapeTimer = setTimeout(() => {
			sessionSlots.escapeTimer = null;
			routeItems(session, reader.release());
		}, ESCAPE_HOLD_MS);
	}
}

// After dispose, only the cursor replies still owed are read, and the
// reader is let go once they are in.
function drainChunk(session: Exchange, chunk: string): void {
	const sessionSlots = _(session);
	for (const item of sessionSlots.wireReader.feed(chunk, true)) {
		if (item.kind === "cursor-report") {
			sessionSlots.owedReplies--;
		}
	}
	if (sessionSlots.owedReplies <= 0) {
		sessionSlots.endDrain?.();
	}
}

// A chunk is dispatched in one pass, so a burst of keys or wheel ticks
// costs one round of the page's microtasks and one layout, not one each.
// A reply is read where it falls in the stream.
function routeItems(session: Exchange, items: WireItem[]): void {
	let keys: WireKey[] = [];
	const sessionSlots = _(session);
	const input = sessionSlots.input!;
	const flushKeys = () => {
		if (keys.length > 0) {
			dispatchInput(input, keys);
			keys = [];
		}
	};
	for (let i = 0; i < items.length; i++) {
		if (sessionSlots.disposed) {
			return;
		}
		const item = items[i];
		switch (item.kind) {
			case "key":
				// Raw mode delivers Ctrl-C as data. Closing is the window's
				// decision, and a close it allows is an interrupt.
				if (item.ctrlKey && item.key === "c") {
					flushKeys();
					sessionSlots.interrupted = true;
					sessionSlots.window.close();
					if (!sessionSlots.window.closed) {
						sessionSlots.interrupted = false;
					}
					break;
				}
				keys.push(item);
				break;
			case "mouse": {
				flushKeys();
				let ticks = 1;
				while (isSameWheelNotch(item, items[i + ticks])) {
					ticks++;
				}
				i += ticks - 1;
				dispatchInput(input, ticks === 1 ? item : {...item, ticks});
				break;
			}
			case "paste":
				flushKeys();
				dispatchInput(input, item);
				break;
			default:
				flushKeys();
				dispatchReply(session, item);
				break;
		}
	}
	flushKeys();
}

// A trackpad reports a notch at a time, dozens to a chunk. As a browser
// coalesces wheel events, notches in a row at one cell are one wheel event
// that scrolls by all of them.
function isSameWheelNotch(
	wheel: WireMouse,
	next: WireItem | undefined,
): boolean {
	return (
		(wheel.button & 64) !== 0 &&
		next?.kind === "mouse" &&
		next.button === wheel.button &&
		next.col === wheel.col &&
		next.row === wheel.row &&
		next.release === wheel.release
	);
}

type ReplyItem<K extends WireItem["kind"]> = Extract<WireItem, {kind: K}>;

// `read` runs where the item is dispatched, so its side effects happen
// in stream order. `absent` is the value silence produces. The cursor
// questions have none and reject instead. A question whose answer has not
// come by the time `until` settles is given up then.
function nextReply<K extends WireItem["kind"], T>(
	session: Exchange,
	kind: K,
	options: {
		ask: string;
		timeoutMs: number;
		read: (item: ReplyItem<K>) => T;
		absent?: T;
		until?: Promise<unknown>;
		mode?: string;
		sequence?: number;
		clipboard?: boolean;
		group?: string;
	},
): Promise<T> {
	const sessionSlots = _(session);
	if (!sessionSlots.asking) {
		return options.absent !== undefined
			? Promise.resolve(options.absent)
			: Promise.reject(new Error("The terminal's replies cannot be read"));
	}
	return new Promise<T>((resolve, reject) => {
		const entry: PendingReply = {
			kind,
			mode: options.mode,
			sequence: options.sequence,
			clipboard: options.clipboard,
			group: options.group,
			settle: (item) => {
				clearTimeout(entry.timer);
				if (options.clipboard) {
					sessionSlots.wireReader.expectClipboardReply(false);
				}
				resolve(options.read(item as ReplyItem<K>));
			},
			giveUp: () => {
				clearTimeout(entry.timer);
				if (options.clipboard) {
					sessionSlots.wireReader.expectClipboardReply(false);
				}
				if (options.absent !== undefined) {
					resolve(options.absent);
				} else {
					reject(new Error("Timeout waiting for cursor position response"));
				}
			},
			timer: setTimeout(() => {
				const index = sessionSlots.pendingReplies.indexOf(entry);
				if (index !== -1) {
					sessionSlots.pendingReplies.splice(index, 1);
				}
				entry.giveUp();
			}, options.timeoutMs),
		};
		sessionSlots.pendingReplies.push(entry);
		if (options.clipboard) {
			sessionSlots.wireReader.expectClipboardReply(true);
		}
		void session.write(options.ask);
		void options.until?.then(() => {
			const index = sessionSlots.pendingReplies.indexOf(entry);
			if (index !== -1) {
				sessionSlots.pendingReplies.splice(index, 1);
				entry.giveUp();
			}
		});
	});
}

function abandonClipboardQuery(session: Exchange): void {
	const pending = _(session).pendingReplies;
	const index = pending.findIndex((entry) => entry.clipboard);
	if (index !== -1) {
		const [entry] = pending.splice(index, 1);
		entry.giveUp();
	}
}

// A cursor report goes to whichever of the anchor queries and the width
// probes was sent first, because a terminal replies to DSR in ask order.
function dispatchReply(session: Exchange, item: WireItem): void {
	const sessionSlots = _(session);
	const pending = sessionSlots.pendingReplies;
	let index = -1;
	for (let i = 0; i < pending.length; i++) {
		if (pending[i].kind !== item.kind) {
			continue;
		}
		if (item.kind === "mode-report" && pending[i].mode !== item.mode) {
			continue;
		}
		index = i;
		break;
	}
	if (item.kind === "cursor-report") {
		const width = sessionSlots.widths.pending[0];
		if (
			width !== undefined &&
			(index === -1 || width.sequence < (pending[index].sequence ?? Infinity))
		) {
			sessionSlots.widths.pending.shift();
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

// `prelude` goes in the same write as the DECRQM. DECRPM values: 0 not
// recognised, 1 set, 2 reset, 3 permanently set, 4 permanently reset.
// Null when the terminal says nothing.
function queryMode(
	session: Exchange,
	mode: string,
	prelude: string,
): Promise<number | null> {
	return nextReply<"mode-report", number | null>(session, "mode-report", {
		ask: prelude + createModeQuery(mode),
		timeoutMs: QUERY_TIMEOUT_MS,
		absent: null,
		mode,
		read: ({value}) => value,
	});
}

// The Node process shape transportFromProcess reads. Tests pass mocks.
type ProcessSignal =
	"SIGWINCH" | "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGCONT" | "exit";

export interface ProcessLike {
	stdin?: {
		isTTY: boolean;
		on(
			event: "data",
			listener: (chunk: string | Uint8Array | ArrayBuffer) => void,
		): unknown;
		on(event: "error", listener: (error: unknown) => void): unknown;
		removeListener?(
			event: "data",
			listener: (chunk: string | Uint8Array | ArrayBuffer) => void,
		): unknown;
		removeListener?(event: "error", listener: (
			error: unknown,
		) => void): unknown;
		setRawMode?(mode: boolean): unknown;
		resume(): unknown;
		pause(): unknown;
		setEncoding?(encoding?: string): unknown;
	};
	stdout: {
		write(
			chunk: any,
			encoding?: string | ((error?: Error) => void),
			callback?: (error?: Error) => void,
		): boolean;
		columns: number;
		rows: number;
		isTTY: boolean;
		on?(event: "error", listener: (error: unknown) => void): unknown;
		removeListener?(event: "error", listener: (
			error: unknown,
		) => void): unknown;
	};
	stderr?: {isTTY?: boolean; write(chunk: string): unknown};
	on(event: ProcessSignal, listener: () => void): unknown;
	removeListener?(event: ProcessSignal, listener: () => void): unknown;
	// For leaving a signal to the app when it listens for one too.
	listeners?(event: ProcessSignal): unknown[];
	exit(code?: number): never;
	exitCode?: number | string | null;
	// For ending a session without a terminal when its parent dies.
	ppid?: number;
	platform?: string;
	kill?(pid: number, signal: string): unknown;
}

// An app that exits without disposing would strand the shell with no
// cursor and the modes set. One exit hook restores every engaged process
// transport. Each process counts its engaged transports, and only the
// last to let go hands its terminal back.
const engagedProcesses = new Map<ProcessLike, number>();
const ownSignalListeners = new WeakSet<object>();
let exitHookInstalled = false;

function restoreEngagedProcesses(): void {
	for (const proc of engagedProcesses.keys()) {
		if (proc.stdout.isTTY !== true) {
			continue;
		}
		try {
			proc.stdout.write(PANIC_RESTORE);
		} catch (_err) {
			// The stream may already be gone.
		}
	}
	engagedProcesses.clear();
}

function installCursorRestoreOnExit(): void {
	if (exitHookInstalled) {
		return;
	}
	exitHookInstalled = true;
	process.on("exit", restoreEngagedProcesses);
	// An exception nothing handles ends the process. Bun prints it before
	// the exit hook runs, and Deno runs none, so the restore goes first
	// here, or the error is printed on the alternate screen and lost with
	// it. Only watching, this changes nothing about whether the process
	// dies.
	process.on("uncaughtExceptionMonitor", () => {
		if (process.listenerCount("uncaughtException") === 0) {
			restoreEngagedProcesses();
		}
	});
}

const ORPHAN_CHECK = 1000;

// Without a terminal, a session has no hangup to end it when the process
// that started it dies. That process's death shows as a new parent, which
// is watched for, leaving stdin to the app.
function watchForOrphaning(proc: ProcessLike, close: () => void): () => void {
	const parent = proc.ppid;
	if (parent === undefined) {
		return () => {};
	}
	const watch = setInterval(() => {
		if (proc.ppid !== parent) {
			clearInterval(watch);
			close();
		}
	}, ORPHAN_CHECK);
	(watch as {unref?(): void}).unref?.();
	return () => clearInterval(watch);
}

// How soon after SIGTSTP a process that was not stopped looks again, and
// how late that look may be while still finding it never stopped.
const STOP_CHECK = 50;
const STOP_GRACE = 1000;

// The size a terminal that reports none is taken to have, as a VT100's.
const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * Inert until the first read of `readable` engages raw mode and the
 * listeners. Cancelling it hands the tty back.
 */
export function transportFromProcess(
	proc: ProcessLike = process as unknown as ProcessLike,
	// The global process sits below a shell. A mock or relay owns its
	// screen.
	options: {sharesScreen?: boolean} = {},
): TerminalTransport {
	const sharesScreen =
		options.sharesScreen ?? proc === (process as unknown as ProcessLike);
	let closedResolve!: (info: TerminalCloseInfo) => void;
	const closed = new Promise<TerminalCloseInfo>((resolve) => {
		closedResolve = resolve;
	});

	// A stream that fails (EPIPE when the reading end of a pipe has gone,
	// EIO when the terminal has) is a terminal that is gone. The session
	// closes as when its input ends, instead of crashing or hanging. This
	// holds from the session's first read until it has ended and written
	// its last bytes, whose failure exits nothing.
	let broken = false;
	let released = false;
	const onBroken = () => {
		if (broken || released) {
			return;
		}
		broken = true;
		closedResolve({});
		setImmediate(() => proc.exit(0));
	};
	let listening = false;
	const listen = () => {
		if (listening) {
			return;
		}
		listening = true;
		proc.stdout.on?.("error", onBroken);
		if (typeof proc.stdin?.on === "function") {
			proc.stdin.on("error", onBroken);
		}
	};
	let writes = 0;
	let lastWrite = Promise.resolve();
	const unlistenOnceWritten = () => {
		const seen = writes;
		void lastWrite.then(() => setImmediate(() => {
			if (writes !== seen) {
				unlistenOnceWritten();
				return;
			}
			listening = false;
			proc.stdout.removeListener?.("error", onBroken);
			if (proc.stdin !== undefined) {
				proc.stdin.removeListener?.("error", onBroken);
			}
		}));
	};

	let engaged = false;
	let stopWatching: (() => void) | undefined;
	let dataListener:
		((chunk: string | Uint8Array | ArrayBuffer) => void) | null = null;
	const signalListeners: Array<[ProcessSignal, () => void]> = [];

	const disengage = () => {
		if (!engaged) {
			return;
		}
		engaged = false;
		if (dataListener && proc.stdin) {
			proc.stdin.removeListener?.("data", dataListener);
			dataListener = null;
		}
		for (const [signal, listener] of signalListeners) {
			proc.removeListener?.(signal, listener);
		}
		signalListeners.length = 0;
		const others = (engagedProcesses.get(proc) ?? 1) - 1;
		if (others > 0) {
			engagedProcesses.set(proc, others);
			return;
		}
		engagedProcesses.delete(proc);
		// Synchronously. The engine's restores go through the writable's queue,
		// and `dispose(); process.exit()` exits before it flushes. Only a
		// terminal had modes to restore.
		if (proc.stdout.isTTY === true) {
			try {
				proc.stdout.write(PANIC_RESTORE);
			} catch (_err) {
				// The terminal is gone, and its modes with it.
			}
		}
		const stdin = proc.stdin;
		if (stdin !== undefined) {
			stdin.setRawMode?.(false);
			stdin.pause();
		}
	};

	const readable = new ReadableStream<string>(
		{
			pull: (controller) => {
				if (engaged) {
					return;
				}
				listen();
				if (!proc.stdin?.isTTY) {
					stopWatching ??= watchForOrphaning(proc, () => {
						closedResolve({});
						setImmediate(() => proc.exit(0));
					});
					return;
				}
				engaged = true;

				const stdin = proc.stdin;
				stdin.setRawMode?.(true);
				stdin.resume();
				stdin.setEncoding?.("utf8");
				// A streaming decoder keeps a code point split across chunks whole.
				const decoder = new TextDecoder();
				dataListener = (chunk: string | Uint8Array | ArrayBuffer) => {
					controller.enqueue(
						typeof chunk === "string"
							? chunk
							: decoder.decode(chunk, {stream: true}),
					);
				};
				stdin.on("data", dataListener);

				engagedProcesses.set(proc, (engagedProcesses.get(proc) ?? 0) + 1);
				installCursorRestoreOnExit();

				// A SIGINT here is an external kill, since raw mode delivers
				// Ctrl-C as data. Close, then exit once the session has
				// disposed.
				// A process a signal ends exits with 128 plus the signal's
				// number, as a shell reports it. An app that listens for the
				// signal itself has taken over the exit, as in Node.
				const closeOn = (signal: ProcessSignal, status: number | null) => {
					const listener = () => {
						closedResolve({status: status ?? undefined});
						const others = (proc.listeners?.(signal) ?? []).filter(
							(other) => !ownSignalListeners.has(other as object),
						);
						if (status !== null && others.length === 0) {
							setImmediate(() => proc.exit(status));
						}
					};
					ownSignalListeners.add(listener);
					signalListeners.push([signal, listener]);
					proc.on(signal, listener);
				};
				closeOn("SIGINT", 130);
				closeOn("SIGTERM", 143);
				closeOn("SIGHUP", 129);
				closeOn("exit", null);
			},
			cancel: () => {
				stopWatching?.();
				disengage();
				released = true;
				if (listening) {
					unlistenOnceWritten();
				}
			},
			// The default high-water mark would pull at construction and take
			// the tty before attach().
		},
		{highWaterMark: 0},
	);

	const writable = new WritableStream<string>({
		// Resolved on the write callback, so awaiting a write means the
		// terminal has the bytes.
		write: (chunk) => {
			writes++;
			const written = new Promise<void>((resolve, reject) => {
				proc.stdout.write(chunk, "utf8", (error?: Error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
			lastWrite = written.catch(() => {});
			return written;
		},
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
						cols: proc.stdout.columns || DEFAULT_COLS,
						rows: proc.stdout.rows || DEFAULT_ROWS,
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

	const transport: TerminalTransport & {[kReadsNoReplies]: boolean} = {
		get cols() {
			return proc.stdout.columns || DEFAULT_COLS;
		},
		get rows() {
			return proc.stdout.rows || DEFAULT_ROWS;
		},
		sharesScreen,
		interactive: proc.stdout.isTTY === true,
		[kReadsNoReplies]: proc.stdin?.isTTY !== true,
		writeSync(text: string): void {
			try {
				proc.stdout.write(text);
			} catch (_err) {
				// The stream may already be gone.
			}
		},
		// A stderr that is a terminal is the one the frame is on.
		logError(text: string): boolean {
			const stderr = proc.stderr;
			if (stderr === undefined || stderr.isTTY) {
				return false;
			}
			stderr.write(text + "\n");
			return true;
		},
		// Job control stops a job with SIGTSTP, which raw mode keeps the
		// terminal from sending, so the process sends it to its process
		// group, as the terminal would. A launcher that runs it as a child
		// and waits on it stops too, and the shell sees the job stop.
		// Windows has no such signal.
		suspend:
			proc.kill === undefined ||
			(proc.platform ?? process.platform) === "win32"
				? undefined
				: () => new Promise<void>((resolve) => {
					const stdin = proc.stdin;
					if (!engaged || stdin === undefined) {
						resolve();
						return;
					}
					stdin.setRawMode?.(false);
					stdin.pause();
					// The timer holds the process open while it waits, as paused
					// stdin no longer does. A process the signal did not stop,
					// as the kernel discards it for a session leader, finds the
					// timer on time, and goes on.
					const sent = performance.now();
					let continued = false;
					const onContinue = () => {
						continued = true;
						proc.removeListener?.("SIGCONT", onContinue);
						stdin.setRawMode?.(true);
						stdin.resume();
						resolve();
					};
					const watch = setInterval(() => {
						if (!continued && performance.now() - sent < STOP_GRACE) {
							onContinue();
						}
						if (continued) {
							clearInterval(watch);
						}
					}, STOP_CHECK);
					proc.on("SIGCONT", onContinue);
					proc.kill!(0, "SIGTSTP");
				}),
		ready: Promise.resolve(),
		readable,
		writable,
		resizes,
		closed,
		close(info?: TerminalCloseInfo) {
			disengage();
			proc.exit(info?.status || Number(proc.exitCode ?? 0) || 0);
		},
	};
	return transport;
}

// The shape transportFromSSH reads: an ssh2 session, with the channel its
// shell request opens.
export interface SSHSessionLike {
	on(
		event: "pty",
		listener: (
			accept: (() => void) | undefined,
			reject: (() => void) | undefined,
			info: TerminalSize,
		) => void,
	): unknown;
	on(
		event: "window-change",
		listener: (
			accept: (() => void) | undefined,
			reject: (() => void) | undefined,
			info: TerminalSize,
		) => void,
	): unknown;
	on(
		event: "shell",
		listener: (
			accept: () => {
				write(chunk: string, callback: (error?: Error | null) => void): unknown;
				on(
					event: "data",
					listener: (chunk: Uint8Array | string) => void,
				): unknown;
				on(event: "end" | "close", listener: () => void): unknown;
				on(event: "error", listener: (error: unknown) => void): unknown;
				exit(status: number): unknown;
				end(): unknown;
			} | undefined,
			reject: (() => void) | undefined,
		) => void,
	): unknown;
	on(event: "close", listener: () => void): unknown;
}

/**
 * An SSH session as a terminal. It takes the session's pty request for
 * the size, its window changes as resizes, and its shell request for the
 * channel, and is ready once that channel opens. The other requests a
 * session can make, such as exec, are left to the SSH library, which
 * refuses them. The session closes when the client's input ends or the
 * channel closes, and closing it sends the exit status and ends the
 * channel.
 */
export function transportFromSSH(
	session: SSHSessionLike,
	// The client's shell sits above the ssh command, as a local one does
	// above a program, so the document anchors below it.
	options: {sharesScreen?: boolean} = {},
): TerminalTransport {
	let cols = DEFAULT_COLS;
	let rows = DEFAULT_ROWS;
	let channel: {
		write(chunk: string, callback: (error?: Error | null) => void): unknown;
		exit(status: number): unknown;
		end(): unknown;
	} | null = null;
	let onInput: ((chunk: string) => void) | null = null;
	let onResize: ((size: TerminalSize) => void) | null = null;
	let inputEnded = false;
	let pending = 0;
	const finish = (status: number) => {
		if (channel !== null) {
			channel.exit(status);
			channel.end();
			channel = null;
		}
	};

	let closedResolve!: (info: TerminalCloseInfo) => void;
	const closed = new Promise<TerminalCloseInfo>((resolve) => {
		closedResolve = resolve;
	});
	let readyResolve!: () => void;
	const ready = new Promise<void>((resolve) => {
		readyResolve = resolve;
	});
	// A session that closes before its shell opens still lets attach()
	// go on, to find it closed.
	session.on("close", () => {
		closedResolve({});
		readyResolve();
	});

	session.on("pty", (accept, _reject, info) => {
		cols = info.cols || DEFAULT_COLS;
		rows = info.rows || DEFAULT_ROWS;
		accept?.();
	});
	session.on("window-change", (accept, _reject, info) => {
		cols = info.cols || cols;
		rows = info.rows || rows;
		onResize?.({cols, rows});
		accept?.();
	});
	session.on("shell", (accept) => {
		const opened = accept();
		if (opened === undefined) {
			return;
		}
		channel = opened;
		// A streaming decoder keeps a code point split across chunks whole.
		const decoder = new TextDecoder();
		opened.on("data", (chunk) => {
			onInput?.(
				typeof chunk === "string"
					? chunk
					: decoder.decode(chunk, {stream: true}),
			);
		});
		// A client whose input ends, as `ssh host < /dev/null`, or whose
		// connection drops, ends the channel's input. The session closes,
		// and the channel ends once the restores have gone out.
		opened.on("end", () => {
			inputEnded = true;
			closedResolve({});
		});
		opened.on("close", () => closedResolve({}));
		opened.on("error", () => closedResolve({}));
		readyResolve();
	});

	return {
		get cols() {
			return cols;
		},
		get rows() {
			return rows;
		},
		sharesScreen: options.sharesScreen ?? true,
		interactive: true,
		ready,
		readable: new ReadableStream<string>({
			start(controller) {
				onInput = (chunk) => controller.enqueue(chunk);
			},
			async cancel() {
				onInput = null;
				if (!inputEnded) {
					return;
				}
				// The restores are queued behind the writes in flight.
				do {
					await new Promise((resolve) => setTimeout(resolve, 10));
				} while (pending > 0);
				finish(0);
			},
		}),
		writable: new WritableStream<string>({
			// Resolved on the write callback, so awaiting a write means the
			// channel has taken the bytes.
			write: (chunk) => new Promise<void>((resolve, reject) => {
				if (channel === null) {
					resolve();
					return;
				}
				pending++;
				channel.write(chunk, (error) => {
					pending--;
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			}),
		}),
		resizes: new ReadableStream<TerminalSize>({
			start(controller) {
				onResize = (size) => controller.enqueue(size);
			},
			cancel() {
				onResize = null;
			},
		}),
		closed,
		close(info?: TerminalCloseInfo) {
			finish(info?.status ?? 0);
		},
	};
}
