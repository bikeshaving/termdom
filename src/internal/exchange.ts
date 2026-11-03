import type {Cascade} from "./cssom.ts";
import {
	constructInternal,
	dispatchAsUserAgent,
	Event,
	EventTarget,
	type EventTargetSlots,
	focusTakesInterrupt,
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
import {CSI_KEYS, PASTE_END, SS3_KEYS, TILDE_KEYS} from "./pty.ts";
import {_, type internals} from "./slots.ts";
import {isControlByte, recordClusterAdvance} from "./text.ts";
import {
	clearInterval,
	clearTimeout,
	queueMicrotask,
	setInterval,
	setTimeout,
} from "./timers.ts";
import {OSC_LIMIT, Parser, type ParserHandlers} from "./vt.ts";

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
	focusReporting: {set: "\x1b[?1004h", reset: "\x1b[?1004l", panic: true},
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

const CURSOR_SHAPE_RESET = "\x1b[0 q";
// OSC 112.
const CURSOR_COLOR_RESET = "\x1b]112\x07";

// Written engaged or not, so each reset must be a no-op on a terminal
// the mode never touched.
const PANIC_RESTORE = MODE_RESTORE_ORDER.filter(
	(name) => MODE_SPELLINGS[name].panic,
).map((name) => {
	const {panic, reset} = MODE_SPELLINGS[name];
	return typeof panic === "string" ? panic : reset;
}).join("");

const CLIPBOARD_START = "\x1b]52;";

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

// Mode 1004's report that the terminal, or the tmux pane, gained or lost
// focus.
export interface WireFocus {
	kind: "focus";
	focused: boolean;
}

// A clipboard reply's text is null when it outgrew the parser's
// string limit for input.
type WireItem =
	WireKey |
	WireMouse |
	WirePaste |
	WireFocus |
	{kind: "cursor-report"; row: number; col: number} |
	{kind: "mode-report"; mode: string; value: number} |
	{kind: "cell-size"; width: number; height: number} |
	{kind: "clipboard"; text: string | null} |
	{kind: "sgr-report"; params: string | null} |
	{kind: "capability-report"; known: boolean} |
	{kind: "secondary-attributes"; params: string} |
	{kind: "background"; red: number; green: number; blue: number} |
	{kind: "device-attributes"};

// Line feed is not here. It is the Ctrl+J chord. A lone ESC is the
// Escape key, since the reader peels CSI and SS3 off whole.
const KEY_BY_TOKEN: Record<string, string> = {
	"\r": "Enter",
	"\t": "Tab",
	"\x7f": "Backspace",
	"\x1b": "Escape",
};

// The keys that CSI <letter> and xterm's CSI 1 ; <mod> <letter> name by
// their final byte, and CSI <code> ~ and CSI <code> ; <mod> ~ by their
// code. CSI 1 ~ and CSI 4 ~ are Home and End from the VT220 editing
// keypad.
const KEY_BY_FINAL: Record<string, string> = {};
const KEY_BY_TILDE_CODE: Record<number, string> = {1: "Home", 4: "End"};

for (const [key, letter] of Object.entries({...CSI_KEYS, ...SS3_KEYS})) {
	KEY_BY_FINAL[letter] = key;
	KEY_BY_TOKEN[`\x1bO${letter}`] = key;
}
for (const [key, code] of Object.entries(TILDE_KEYS)) {
	KEY_BY_TILDE_CODE[code] = key;
}

// The keys CSI u names by their control code rather than a character.
const KEY_BY_CODE: Record<number, string> = {
	8: "Backspace",
	9: "Tab",
	13: "Enter",
	27: "Escape",
	127: "Backspace",
};

// mod - 1 is a bitmask: 1 Shift, 2 Alt, 4 Ctrl, 8 Super, and in CSI u 32
// Meta. Super is the Meta key a browser reports. An empty mod is 0.
function decodeModifiers(mod: number): Omit<WireKey, "kind" | "key" | "char"> {
	const bits = Math.max(mod - 1, 0);
	return {
		shiftKey: (bits & 1) !== 0,
		altKey: (bits & 2) !== 0,
		ctrlKey: (bits & 4) !== 0,
		metaKey: (bits & 40) !== 0,
	};
}

function decodeNamedKey(key: string | undefined, mod: number): WireKey | null {
	return key === undefined
		? null
		: {kind: "key", key, char: "", ...decodeModifiers(mod)};
}

function decodeCodedKey(codepoint: number, mod: number): WireKey {
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

	// A character outside the basic plane is one character across two
	// units.
	const astral = token.length === 2 && code >= 0xd800 && code <= 0xdbff;
	const printable =
		astral || (token.length === 1 && code >= 32 && code !== 127);
	return {
		kind: "key",
		key: KEY_BY_TOKEN[token] ?? token,
		char: printable ? token : "",
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
	};
}

/**
 * What a whole CSI the terminal sent means: a key, a report, or for
 * CSI 200 ~, a paste's opening fence, as an empty paste. None takes
 * subparameters but CSI u, a key with its modifiers spelled out, sent by
 * a terminal that reports them all: CSI <code>[:...] ; <mod>[:<event>]
 * [; <text>] u (fixterms and kitty). xterm's modifyOtherKeys sends
 * CSI 27 ; <mod> ; <code> ~.
 */
function decodeCSI(parser: Parser, final: string): WireItem | null {
	const {prefix, params, intermediates} = parser;
	const [a, b = 0, c = 0] = params.map(([value]) => value);
	const count = params.every((param) => param.length === 1) ? params.length : 0;
	switch (prefix + intermediates + final) {
		case "<M":
		case "<m":
			return count === 3
				? {
					kind: "mouse",
					button: a,
					col: b,
					row: c,
					release: final === "m",
					ticks: 1,
				}
				: null;
		case "I":
		case "O":
			return count === 1 && a === 0
				? {kind: "focus", focused: final === "I"}
				: null;
		case "?c":
			return count === 0 ? null : {kind: "device-attributes"};
		case ">c":
			return count === 0
				? null
				: {kind: "secondary-attributes", params: params.join(";")};
		case "$y":
		case "?$y":
			return count === 2
				? {kind: "mode-report", mode: prefix + a, value: b}
				: null;
		// XTWINOPS reports the cell height before its width.
		case "t":
			return count === 3 && a === 6
				? {kind: "cell-size", height: b, width: c}
				: null;
		case "u":
			return a > 0 && params.length <= 3 && (params[1]?.length ?? 0) <= 2
				? decodeCodedKey(a, b)
				: null;
		case "~":
			if (count === 1 && a === 200) {
				return {kind: "paste", text: ""};
			}
			if (count === 3 && a === 27) {
				return decodeCodedKey(c, b);
			}
			return count === 1 || count === 2
				? decodeNamedKey(KEY_BY_TILDE_CODE[a], b)
				: null;
		case "Z":
			return count === 1 && a === 0 ? decodeNamedKey("Tab", 2) : null;
		// A cursor report has the shape of xterm's modified F3, and wins.
		case "R":
			if (count === 2) {
				return {kind: "cursor-report", row: a, col: b};
			}
	}
	const key = prefix + intermediates === "" ? KEY_BY_FINAL[final] : undefined;
	if (count === 2 && a === 1) {
		return decodeNamedKey(key, b);
	}
	return count === 1 && a === 0 && key !== undefined && CSI_KEYS[key] === final
		? decodeNamedKey(key, 0)
		: null;
}

// A paste this large is delivered as it stands, and the rest of it as it
// arrives, up to the end fence: as paste, never as keystrokes.
const PASTE_LIMIT = 1 << 20;
// A split sequence longer than this is not one a terminal sends.
const HOLD_LIMIT = 4096;

const STRING_OPENERS = "]P_^X";

// OSC 11 answered: the default background, each channel one to four hex
// digits.
const BACKGROUND_REPLY =
	/^11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?$/i;

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
const SGR_REPORT = /^([01])\$r([\d;:]*)m?$/;

// XTGETTCAP answered: DCS 1 + r for a capability the terminal has, with
// its value when it has one, and DCS 0 + r for one it does not.
const CAPABILITY_REPORT = /^([01])\+r/;

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
 * Escape key), an open paste body, and a clipboard reply while a query is
 * waiting for it. Nothing here may hold the keystrokes that follow it for
 * long: a paste that grows past a size is delivered in parts, and a
 * sequence that never finishes is dropped at a size.
 */
class WireReader implements ParserHandlers {
	tail: string;
	pasteBody: string | null;
	pasteOverflowed: boolean;
	expectingReply: boolean;
	parser: Parser;
	// What the sequence the parser read last meant, when it was a reply or
	// a key.
	item: WireItem | null;

	constructor() {
		this.tail = "";
		this.pasteBody = null;
		this.pasteOverflowed = false;
		this.expectingReply = false;
		this.parser = new Parser(this);
		this.item = null;
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
		if (!expecting && this.tail.startsWith(CLIPBOARD_START)) {
			this.tail = "";
		}
	}

	/**
	 * `holdEscape` is for when a reply is due: a bare trailing ESC is then
	 * more likely a reply cut after its first byte than the Escape key, so
	 * it waits for the next chunk or for release().
	 */
	feed(chunk: string, holdEscape = false): WireItem[] {
		const data = this.tail + chunk;
		this.tail = "";
		const items: WireItem[] = [];
		let i = 0;
		while (i < data.length) {
			// Inside a paste only the end fence means anything.
			if (this.pasteBody !== null) {
				const end = data.indexOf(PASTE_END, i);
				if (end === -1) {
					const kept = findFenceStart(data, i, holdEscape);
					this.tail = data.slice(kept);
					this.pasteBody += data.slice(i, kept);
					if (this.pasteOverflowed || this.pasteBody.length > PASTE_LIMIT) {
						if (this.pasteBody !== "") {
							items.push({kind: "paste", text: this.pasteBody});
						}
						this.pasteBody = "";
						this.pasteOverflowed = true;
					}
					return items;
				}
				const text = this.pasteBody + data.slice(i, end);
				if (!this.pasteOverflowed || text !== "") {
					items.push({kind: "paste", text});
				}
				this.pasteBody = null;
				this.pasteOverflowed = false;
				i = end + PASTE_END.length;
				continue;
			}
			i = data[i] === "\x1b"
				? this.readEscape(data, i, holdEscape, items)
				: readKey(data, i, items);
		}
		return items;
	}

	// The keys or the sequence that the ESC at `i` starts, and the index
	// past them.
	readEscape(
		data: string,
		i: number,
		replyDue: boolean,
		items: WireItem[],
	): number {
		const next = data[i + 1];
		// A lone ESC at the end is the Escape key, unless a reply is due.
		if (next === undefined) {
			if (replyDue && data[i - 1] !== "\x1b") {
				this.tail = "\x1b";
			} else {
				items.push(decodeKeyToken("\x1b"));
			}
			return i + 1;
		}
		if (next === "[" || STRING_OPENERS.includes(next)) {
			this.item = null;
			const end = this.parser.parse(data, i, "input");
			if (end !== -1) {
				// A sequence nothing here names is not a keystroke.
				if (this.item !== null) {
					items.push(this.item);
				}
				return end;
			}
			// A CSI the chunk cuts waits for the rest of it. OSC, DCS, APC,
			// PM and SOS are strings a terminal writes, not keys it sends.
			// One with no terminator in the same write is keys: Escape and
			// then a bracket is what a person typing sends too.
			const opened = data.slice(i);
			if (next === "[") {
				if (opened.length <= HOLD_LIMIT) {
					this.tail = opened;
				}
				return data.length;
			}
			if (this.expectingReply && opened.startsWith(CLIPBOARD_START)) {
				if (opened.length < OSC_LIMIT.input) {
					this.tail = opened;
				} else {
					items.push({kind: "clipboard", text: null});
				}
				return data.length;
			}
			if (isHeldString(opened, replyDue)) {
				this.tail = opened;
				return data.length;
			}
			items.push({...decodeKeyToken(next), char: "", altKey: true});
			return i + 2;
		}
		if (next === "O") {
			if (i + 2 === data.length) {
				this.tail = "\x1bO";
				return data.length;
			}
			const item = decodeKeyToken(data.slice(i, i + 3));
			if (!item.key.includes("\x1b")) {
				items.push(item);
			}
			return i + 3;
		}
		// ESC and a key in one write is that key with Alt, the way a
		// terminal sends it. A person pressing Escape and then a key sends
		// two writes.
		const code = data.charCodeAt(i + 1);
		if (code === 0x1b || (code >= 0x80 && code <= 0x9f)) {
			items.push(decodeKeyToken("\x1b"));
			return i + 1;
		}
		const width = getKeyWidth(data, i + 1);
		const item = decodeKeyToken(data.slice(i + 1, i + 1 + width));
		items.push({...item, char: "", altKey: true});
		return i + 1 + width;
	}

	print(): void {}

	execute(): void {}

	esc(): void {}

	csi(final: string): void {
		const item = decodeCSI(this.parser, final);
		if (item?.kind === "paste") {
			this.pasteBody = "";
		} else {
			this.item = item;
		}
	}

	// A whole string is a reply, or is discarded.
	osc(text: string): void {
		if (this.expectingReply && text.startsWith("52;")) {
			const decoded = decode64(text.slice(text.indexOf(";", 3) + 1));
			this.item = {
				kind: "clipboard",
				text: text.length >= OSC_LIMIT.input
					? null
					: decoded === null ? "" : new TextDecoder().decode(decoded),
			};
			return;
		}
		const background = BACKGROUND_REPLY.exec(text);
		if (background !== null) {
			this.item = {
				kind: "background",
				red: readChannel(background[1]),
				green: readChannel(background[2]),
				blue: readChannel(background[3]),
			};
		}
	}

	dcs(text: string): void {
		const report = SGR_REPORT.exec(text);
		if (report !== null) {
			this.item = {
				kind: "sgr-report",
				params: report[1] === "1" ? report[2] : null,
			};
		}
		const capability = CAPABILITY_REPORT.exec(text);
		if (capability !== null) {
			this.item = {kind: "capability-report", known: capability[1] === "1"};
		}
	}
}

// The key at `i`, and the index past it. A C1 control is not a keystroke
// a terminal sends.
function readKey(data: string, i: number, items: WireItem[]): number {
	const code = data.charCodeAt(i);
	if (code >= 0x80 && code <= 0x9f) {
		return i + 1;
	}
	const width = getKeyWidth(data, i);
	items.push(decodeKeyToken(data.slice(i, i + width)));
	return i + width;
}

// A surrogate pair is one keystroke.
function getKeyWidth(data: string, i: number): number {
	const code = data.charCodeAt(i);
	return code >= 0xd800 && code <= 0xdbff && i + 1 < data.length ? 2 : 1;
}

/**
 * Whether a string the chunk cuts waits for the rest of it. While a reply
 * is due an OSC or a DCS does, even cut between the ESC and backslash of
 * its ST. Otherwise a DCS does, and the start of a clipboard reply's
 * opener.
 */
function isHeldString(opened: string, replyDue: boolean): boolean {
	if (opened.length > HOLD_LIMIT) {
		return false;
	}
	const inner = opened.indexOf("\x1b", 2);
	if (replyDue) {
		return (opened[1] === "]" || opened[1] === "P") &&
			(inner === -1 || inner === opened.length - 1);
	}
	return inner === -1 && (
		opened[1] === "P" ||
		(opened.length < CLIPBOARD_START.length &&
			CLIPBOARD_START.startsWith(opened))
	);
}

// Where a paste body the chunk cuts may start its end fence, or the end
// of `data`. A lone ESC there waits only while a reply is due.
function findFenceStart(data: string, from: number, replyDue: boolean): number {
	const esc = data.lastIndexOf("\x1b");
	if (esc < from) {
		return data.length;
	}
	const held = esc === data.length - 1
		? replyDue && data[esc - 1] !== "\x1b"
		: PASTE_END.startsWith(data.slice(esc));
	return held ? esc : data.length;
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

// Whether the page has styled the cursor shape or color of a process
// transport's terminal, so the panic paths reset those too, and only
// those, since a reset takes back what the shell itself set. A flag stays
// set once the page has styled, because the reset the page writes later
// may still be queued when the panic path runs.
interface CursorStyled {
	shape: boolean;
	color: boolean;
}

const kCursorStyled = Symbol("cursorStyled");

type ProcessTransport =
	TerminalTransport &
	{[kReadsNoReplies]: boolean; [kCursorStyled]: CursorStyled};

function setCursorStyled(exchange: Exchange): void {
	const slots = _(exchange);
	const styled = (slots.transport as Partial<ProcessTransport>)[kCursorStyled];
	if (styled !== undefined) {
		styled.shape ||= slots.cursorShape !== 0;
		styled.color ||= slots.cursorColor !== null;
	}
}

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
	// The cursor style and color the terminal last got: a DECSCUSR style,
	// 0 for its own, and 0xRRGGBB, null for its own.
	cursorShape: number;
	cursorColor: number | null;
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
		slots.cursorShape = 0;
		slots.cursorColor = null;
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
		const widths = slots.widths;
		clearTimeout(slots.resizeTimer ?? undefined);
		clearTimeout(slots.escapeTimer ?? undefined);
		clearTimeout(widths.timer ?? undefined);
		clearTimeout(widths.deferralTimer ?? undefined);
		slots.resizeTimer = null;
		slots.escapeTimer = null;
		widths.timer = null;
		widths.deferralTimer = null;

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

/** Whether the display type is engaged, including while suspended. */
export function hasDisplayType(exchange: Exchange, name: ModeName): boolean {
	return _(exchange).engagedModes.has(name);
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
 * DECSCUSR, CSI Ps SP q, for the cursor's style, and OSC 12 for its
 * color. Each is written when it changes, so a terminal the page never
 * styled the cursor of is never reset either.
 */
function getCursorShapeEscape(shape: number): string {
	return `\x1b[${shape} q`;
}

function getCursorColorEscape(color: number | null): string {
	if (color === null) {
		return CURSOR_COLOR_RESET;
	}
	const channel = (shift: number) =>
		((color >> shift) & 0xff).toString(16).padStart(2, "0");
	return `\x1b]12;rgb:${channel(16)}/${channel(8)}/${channel(0)}\x07`;
}

/** Draws the cursor as the caret asks, writing only what changed. */
export function setCursorStyle(
	exchange: Exchange,
	shape: number,
	color: number | null,
): void {
	const slots = _(exchange);
	if (!slots.interactive) {
		return;
	}
	if (shape !== slots.cursorShape) {
		slots.cursorShape = shape;
		void exchange.write(getCursorShapeEscape(shape));
	}
	if (color !== slots.cursorColor) {
		slots.cursorColor = color;
		void exchange.write(getCursorColorEscape(color));
	}
	setCursorStyled(exchange);
}

function resetCursorStyle(exchange: Exchange): void {
	const slots = _(exchange);
	if (slots.cursorShape !== 0) {
		void exchange.write(CURSOR_SHAPE_RESET);
	}
	if (slots.cursorColor !== null) {
		void exchange.write(CURSOR_COLOR_RESET);
	}
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
	resetCursorStyle(exchange);
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
	if (slots.cursorShape !== 0) {
		void exchange.write(getCursorShapeEscape(slots.cursorShape));
	}
	if (slots.cursorColor !== null) {
		void exchange.write(getCursorColorEscape(slots.cursorColor));
	}
}

export function restoreEngagedModes(exchange: Exchange): void {
	for (const name of MODE_RESTORE_ORDER) {
		if (_(exchange).engagedModes.delete(name)) {
			void exchange.write(MODE_SPELLINGS[name].reset);
		}
	}
	resetCursorStyle(exchange);
	_(exchange).cursorShape = 0;
	_(exchange).cursorColor = null;
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
				// decision, and a close it allows is an interrupt. A focused
				// program's embed takes it as a key, for its own program.
				if (
					item.ctrlKey &&
					item.key === "c" &&
					!focusTakesInterrupt(sessionSlots.window.document)
				) {
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
			case "focus":
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
const engagedProcesses = new Map<ProcessLike, Set<CursorStyled>>();

function getPanicRestore(styles: Iterable<CursorStyled>): string {
	let shape = false;
	let color = false;
	for (const styled of styles) {
		shape ||= styled.shape;
		color ||= styled.color;
	}
	return PANIC_RESTORE +
		(shape ? CURSOR_SHAPE_RESET : "") +
		(color ? CURSOR_COLOR_RESET : "");
}

const ownSignalListeners = new WeakSet<object>();
let exitHookInstalled = false;

function restoreEngagedProcesses(): void {
	for (const [proc, styles] of engagedProcesses) {
		if (proc.stdout.isTTY !== true) {
			continue;
		}
		try {
			proc.stdout.write(getPanicRestore(styles));
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

// The terminal's size, each time SIGWINCH says it changed.
function watchResizes(proc: ProcessLike): ReadableStream<TerminalSize> {
	let resizeListener: (() => void) | null = null;
	return new ReadableStream<TerminalSize>(
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
}

// Job control stops a job with SIGTSTP, which raw mode keeps the
// terminal from sending, so the process sends it to its process
// group, as the terminal would. A launcher that runs it as a child
// and waits on it stops too, and the shell sees the job stop.
// Windows has no such signal.
function createSuspend(
	proc: ProcessLike,
	isEngaged: () => boolean,
): (() => Promise<void>) | undefined {
	if (
		proc.kill === undefined || (proc.platform ?? process.platform) === "win32"
	) {
		return undefined;
	}
	return () => new Promise<void>((resolve) => {
		const stdin = proc.stdin;
		if (!isEngaged() || stdin === undefined) {
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
	});
}

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

	const styled: CursorStyled = {shape: false, color: false};
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
		const others = engagedProcesses.get(proc);
		others?.delete(styled);
		if (others !== undefined && others.size > 0) {
			return;
		}
		engagedProcesses.delete(proc);
		// Synchronously. The engine's restores go through the writable's queue,
		// and `dispose(); process.exit()` exits before it flushes. Only a
		// terminal had modes to restore.
		if (proc.stdout.isTTY === true) {
			try {
				proc.stdout.write(getPanicRestore([styled]));
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

				const others = engagedProcesses.get(proc) ?? new Set();
				engagedProcesses.set(proc, others.add(styled));
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

	const transport: ProcessTransport = {
		get cols() {
			return proc.stdout.columns || DEFAULT_COLS;
		},
		get rows() {
			return proc.stdout.rows || DEFAULT_ROWS;
		},
		sharesScreen,
		interactive: proc.stdout.isTTY === true,
		[kReadsNoReplies]: proc.stdin?.isTTY !== true,
		[kCursorStyled]: styled,
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
		suspend: createSuspend(proc, () => engaged),
		ready: Promise.resolve(),
		readable,
		writable,
		resizes: watchResizes(proc),
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
