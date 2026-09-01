import type {EventHandler} from "./input.js";
import {
	closeTermDOM,
	commandStartDetected,
	frameReplaced,
	frameStanding,
	probesStarved,
	type TermDOM,
	terminalReorders,
	terminalResized,
	widthsCorrected,
} from "./termdom.js";
import {recordClusterAdvance} from "./text.js";

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
	readonly colorDepth: ColorDepth;

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
	 * A pty is established at construction. An SSH channel resolves when it
	 * opens.
	 */
	readonly ready: Promise<void>;

	/** Hangup, disconnect, process exit. */
	readonly closed: Promise<TerminalCloseInfo>;

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
function modeQuery(mode: string): string {
	return mode.startsWith("?")
		? `\x1b[?${parseInt(mode.slice(1), 10)}$p`
		: `\x1b[${parseInt(mode, 10)}$p`;
}

// C0, DEL and the C1 range. In untrusted text one would end the
// sequence around it or start one of its own.
function isControlByte(code: number): boolean {
	return code < 0x20 || (code >= 0x7f && code < 0xa0);
}

// Every mode the engine sets, so teardown can reset what was engaged
// (in this order) and the panic paths can reset the union. A mode
// written anywhere else is a restore leak.
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
	// XTWINOPS 22 and 23: push the title onto the terminal's stack and pop
	// it back.
	titleStack: {
		set: "\x1b[22;0t",
		reset: "\x1b[23;0t",
		panic: true,
	},
	// The panic spelling is ?1047, without the cursor restore. A bare
	// ?1049l restores a saved cursor even when the alternate screen is not
	// active (tmux and xterm both), which would teleport the queued output.
	altScreen: {
		set: "\x1b[?1049h",
		reset: "\x1b[?1049l",
		panic: "\x1b[?1047l",
	},
	// Negotiated. A terminal that ignored the offer must not see the reset.
	clusterWidths: {
		set: "\x1b[?2027h",
		reset: "\x1b[?2027l",
		panic: false,
	},
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

function decodeMouseEscape(token: string): {
	button: number;
	col: number;
	row: number;
	release: boolean;
} | null {
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
	{kind: "clipboard"; text: string | null};

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

const MODIFIED_CURSOR_KEYS: Record<string, string> = {
	A: "ArrowUp",
	B: "ArrowDown",
	C: "ArrowRight",
	D: "ArrowLeft",
	F: "End",
	H: "Home",
};

// xterm's modified cursor key: CSI 1 ; <mod> <letter>, e.g. Alt+Up =
// CSI 1;3A.
const MODIFIED_CURSOR_KEY = /^\x1b\[1;(\d+)([ABCDHF])$/;

function decodeKeyToken(token: string): WireKey {
	const code = token.charCodeAt(0);

	// Ctrl+<letter> is one control byte. 0x09 and 0x0d are what Tab and
	// Enter send, indistinguishable from Ctrl+I and Ctrl+M, so the named
	// key wins.
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

	const modified = token.match(MODIFIED_CURSOR_KEY);
	if (modified) {
		// mod - 1 is a bitmask: 1 Shift, 2 Alt, 4 Ctrl, 8 Meta.
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

const kTail = Symbol("tail");
const kPasteBody = Symbol("pasteBody");
const kReplyBody = Symbol("replyBody");
const kReplyLimit = Symbol("replyLimit");

/**
 * Decodes one chunk into what it meant. Keeps what a chunk boundary can
 * cut: a split escape (never a bare trailing ESC, which may be the
 * Escape key), an open paste body, and an open clipboard reply. The reply
 * is recognized whether or not anyone asked, or its base64 would be
 * typed as keystrokes.
 */
class WireReader {
	// A larger reply is not a clipboard. It is given up as null.
	static readonly [kReplyLimit] = 1 << 16;
	declare [kTail]: string;
	declare [kPasteBody]: string | null;
	declare [kReplyBody]: string | null;

	constructor() {
		this[kTail] = "";
		this[kPasteBody] = null;
		this[kReplyBody] = null;
	}

	feed(chunk: string): WireItem[] {
		let data = this[kTail] + chunk;
		this[kTail] = "";
		// Only a short one. What outgrows a real sequence will not finish.
		const held = splitTrailingEscape(data);
		if (held > 0 && held <= 32) {
			this[kTail] = data.slice(-held);
			data = data.slice(0, -held);
		}

		const items: WireItem[] = [];
		let i = 0;
		while (i < data.length) {
			// Inside a paste only the end fence means anything.
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
			// A payload no decoding rescues is reported as an empty clipboard.
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
			// A surrogate pair is one keystroke.
			const code = data.charCodeAt(i);
			const width = code >= 0xd800 && code <= 0xdbff && i + 1 < data.length
				? 2
				: 1;
			items.push(decodeKeyToken(data.slice(i, i + width)));
			i += width;
		}
		return items;
	}
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

// The length of an incomplete CSI, SS3 or clipboard-reply opening at
// the end of the chunk, or 0. A bare trailing ESC is 0, since it may be
// the Escape key.
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
			}
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
}

const kTransport = Symbol("transport");
const kInteractive = Symbol("interactive");
const kEngagedModes = Symbol("engagedModes");
const kAnchorDetectionEnabled = Symbol("anchorDetectionEnabled");
const kResizeTimer = Symbol("resizeTimer");
const kSettlingResize = Symbol("settlingResize");
const kTransportClosed = Symbol("transportClosed");
const kTermDOM = Symbol("termDOM");
const kInput = Symbol("input");

const kWriter = Symbol("writer");
const kReader = Symbol("reader");
const kResizeReader = Symbol("resizeReader");
const kStarted = Symbol("started");
const kDisposed = Symbol("disposed");
const kLastWrite = Symbol("lastWrite");

const kWireReader = Symbol("wireReader");

const kHasDetectedCommandStart = Symbol("hasDetectedCommandStart");
const kCursorDetectionPromise = Symbol("cursorDetectionPromise");
const kDsrSequence = Symbol("dsrSequence");
const kPendingReplies = Symbol("pendingReplies");

const kPriorBidiMode = Symbol("priorBidiMode");
const kGraphemeClustersNegotiated = Symbol("graphemeClustersNegotiated");

const kClipboardQueryTimeout = Symbol("clipboardQueryTimeout");

const kProbingEnded = Symbol("probingEnded");
const kWidths = Symbol("widths");
const kWidthProbeTimeout = Symbol("widthProbeTimeout");
const kWidthStarvationWait = Symbol("widthStarvationWait");

/**
 * One reader, one writer, and the demultiplexer between them. Every
 * query is bounded by a timer, since most terminals reply with nothing.
 * Silence means the terminal has no opinion and ours holds.
 */
export class TerminalExchange {
	// A terminal replying late is still replying. Only one that never
	// replies at all stops probing.
	static readonly [kWidthProbeTimeout] = 2000;
	// Long enough that anything still animating or typing carries the
	// train.
	static readonly [kWidthStarvationWait] = 500;
	// Most terminals refuse clipboard reads by silence. This is what every
	// readText() waits before rejecting.
	static readonly [kClipboardQueryTimeout] = 500;
	declare [kTransport]: TerminalTransport;
	declare [kInteractive]: boolean;
	declare [kEngagedModes]: Set<ModeName>;
	declare [kAnchorDetectionEnabled]: boolean;
	declare [kTermDOM]: TermDOM;
	declare [kResizeTimer]: ReturnType<typeof setTimeout> | null;
	// A token per resize burst, so a redraw that lands after a newer burst
	// began is abandoned. Null between bursts.
	declare [kSettlingResize]: object | null;
	declare [kTransportClosed]: boolean;
	declare [kInput]: EventHandler | null;
	declare [kWriter]: WritableStreamDefaultWriter<string> | null;
	declare [kReader]: ReadableStreamDefaultReader<string> | null;
	declare [kResizeReader]: ReadableStreamDefaultReader<TerminalSize> | null;
	declare [kStarted]: boolean;
	declare [kDisposed]: boolean;
	declare [kLastWrite]: Promise<void>;
	declare [kWireReader]: WireReader;
	// The resize re-anchor saves and restores this around its redraw.
	declare [kHasDetectedCommandStart]: boolean;
	declare [kCursorDetectionPromise]: Promise<void> | null;
	// Oldest first. Two mode negotiations can be outstanding at once. Each
	// names its mode, so neither takes the other's reply.
	declare [kPendingReplies]: PendingReply[];
	// The BDSM state the terminal reported before we touched it.
	declare [kPriorBidiMode]: number | null;
	declare [kGraphemeClustersNegotiated]: boolean;
	// A terminal replies to DSR in ask order, so this keeps cursor
	// detection and width probes from taking each other's replies.
	declare [kDsrSequence]: number;
	// Teardown has begun. No frame may send another probe.
	declare [kProbingEnded]: boolean;
	declare [kWidths]: WidthProbes;

	constructor(transport: TerminalTransport, termDOM: TermDOM) {
		const interactive = transport.interactive;
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
		this[kProbingEnded] = false;
		this[kWidths] = freshWidthProbes(interactive);
		this[kTransport] = transport;
		this[kInteractive] = interactive;
		this[kEngagedModes] = new Set<ModeName>();
		// Anchor detection only makes sense when a shell's rows are above ours.
		this[kAnchorDetectionEnabled] = transport.sharesScreen && interactive;
		this[kTermDOM] = termDOM;
		this[kInput] = null;
		this[kResizeTimer] = null;
		this[kSettlingResize] = null;
		this[kTransportClosed] = false;
	}

	get interactive(): boolean {
		return this[kInteractive];
	}

	get resizing(): boolean {
		return this[kSettlingResize] !== null;
	}

	get transportClosed(): boolean {
		return this[kTransportClosed];
	}

	/**
	 * Null once settled, so the frame adds no async hop. Its scroll clamp is
	 * synchronous by contract.
	 */
	get cursorDetectionPending(): Promise<void> | null {
		return this[kCursorDetectionPromise];
	}

	/**
	 * A terminal is behind the transport and has not proven it never replies.
	 */
	probing(): boolean {
		return this[kWidths].probing;
	}

	clusterWidthsNegotiated(): boolean {
		return this[kGraphemeClustersNegotiated];
	}

	wantsWidth(cluster: string): boolean {
		return !this[kWidths].settled.has(cluster);
	}

	/**
	 * Deferred by the margin and never probed elsewhere. Right-aligned text
	 * would wait forever in place, so a frame measures these somewhere with
	 * room.
	 */
	starvedWidths(): ReadonlySet<string> {
		return this[kWidths].starved;
	}

	/**
	 * Painted too near the last column for its reply to be readable. One
	 * deferral of a cluster never probed is starvation, because the layout
	 * that put it there will put it there again.
	 */
	deferWidth(cluster: string): void {
		const widths = this[kWidths];
		if (widths.asked.has(cluster) || widths.starved.has(cluster)) {
			return;
		}
		widths.starved.add(cluster);
		requestStarvationFrame(this);
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
		if (this[kProbingEnded]) {
			return "";
		}
		const widths = this[kWidths];
		widths.asked.add(cluster);
		widths.starved.delete(cluster);
		widths.pending.push({
			cluster,
			run,
			batch: widths.writeBatch,
			column,
			width,
			sequence: this[kDsrSequence]++,
			sentAt: Date.now(),
		});
		armWidthProbeTimer(this);
		return CURSOR_QUERY;
	}

	/** Writes on change only. Teardown restores what was engaged. */
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

	restoreEngagedModes(): void {
		for (const name of MODE_RESTORE_ORDER) {
			if (this[kEngagedModes].delete(name)) {
				void this.write(MODE_SPELLINGS[name].reset);
			}
		}
	}

	write(output: string): Promise<void> {
		// Probes taken while building one frame go out with it. A write ends
		// the batch that can share a drift correction.
		this[kWidths].writeBatch = {};
		if (this[kDisposed] && !this[kWriter]) {
			return Promise.resolve();
		}
		if (!this[kWriter]) {
			this[kWriter] = this[kTransport].writable.getWriter();
		}
		this[kLastWrite] = this[kWriter].write(output).catch(() => {
			// A transport torn down mid-write is a close, not a crash.
		});
		return this[kLastWrite];
	}

	flush(): Promise<void> {
		return this[kLastWrite];
	}

	/**
	 * Only before the session starts. It cannot change terminals under its
	 * readers.
	 */
	rebind(transport: TerminalTransport): void {
		if (this[kStarted]) {
			throw new Error("rebind(): the session has already started");
		}
		this[kTransport] = transport;
		this[kInteractive] = transport.interactive;
		this[kAnchorDetectionEnabled] =
			transport.sharesScreen && transport.interactive;
		this[kWidths] = freshWidthProbes(transport.interactive);
		terminalResized(this[kTermDOM], transport.cols, transport.rows);
	}

	start(input: EventHandler): void {
		if (this[kStarted]) {
			return;
		}
		this[kStarted] = true;
		this[kInput] = input;

		this[kReader] = this[kTransport].readable.getReader();
		void readLoop(this, this[kReader]);

		this[kResizeReader] = this[kTransport].resizes.getReader();
		void resizeLoop(this, this[kResizeReader]);

		void this[kTransport].closed.then(() => {
			if (!this[kDisposed]) {
				this[kTransportClosed] = true;
				closeTermDOM(this[kTermDOM]);
			}
		});
	}

	initializeCursorDetection(): void {
		this[kCursorDetectionPromise] = null;
		if (this[kAnchorDetectionEnabled]) {
			this[kCursorDetectionPromise] = Promise.race([
				this.detectCommandStart().then(() => {}),
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					this[kHasDetectedCommandStart] = false;
				})
				.finally(() => {
					this[kCursorDetectionPromise] = null;
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
	async negotiateBidi(): Promise<void> {
		if (!this[kInteractive]) {
			return;
		}

		const answer = await queryMode(this, "8", BIDI_EXPLICIT);
		if (answer === null || answer === 0) {
			return;
		}
		this[kPriorBidiMode] = answer;
		if (answer === 1 || answer === 3) {
			terminalReorders(this[kTermDOM]);
		}
	}

	/** A terminal without DECRQM may echo the request's final byte as text. */
	scrubProbeEcho(): void {
		if (!this[kInteractive]) {
			return;
		}
		void this.write("\r" + LINE_ERASE);
	}

	/**
	 * Mode 2027: measure by grapheme cluster, as stringWidth does, rather
	 * than per code point as wcwidth does. A terminal that does not know the
	 * mode leaves our measurements as they are. Only whether it agrees
	 * changes.
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
		this[kGraphemeClustersNegotiated] = answer === 1 || answer === 3;
		// The set went out with the query's own write. A terminal that ignored
		// it must not see the reset, so only an agreed offer is engaged.
		if (this[kGraphemeClustersNegotiated]) {
			this[kEngagedModes].add("clusterWidths");
		}
	}

	/** DSR. The cursor row is the command-start anchor. */
	detectCommandStart(): Promise<number> {
		if (!this[kInteractive]) {
			return Promise.reject(
				new Error("Cannot detect cursor position: not interactive"),
			);
		}
		// A cold start or a slow link can outlast a tighter window.
		return nextReply(this, "cursor-report", {
			ask: CURSOR_QUERY,
			timeoutMs: 1000,
			sequence: this[kDsrSequence]++,
			read: ({row}) => {
				commandStartDetected(this[kTermDOM], row);
				this[kHasDetectedCommandStart] = true;
				return row;
			},
		});
	}

	/** The 0-based cursor row, for the resize re-anchor. Rejects on timeout. */
	queryCursorRow(): Promise<number> {
		if (!this[kInteractive]) {
			return Promise.reject(new Error("not interactive"));
		}
		// Short, because the redraw should feel immediate, and a slow terminal
		// falls back to the computed re-anchor.
		return nextReply(this, "cursor-report", {
			ask: CURSOR_QUERY,
			timeoutMs: 200,
			sequence: this[kDsrSequence]++,
			read: ({row}) => row - 1,
		});
	}

	writeClipboard(text: string): Promise<void> {
		return this.write(clipboardEscape(text));
	}

	setTitle(text: string): Promise<void> {
		return this.write(titleEscape(text));
	}

	queryClipboard(): Promise<string | null> {
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve(null);
		}
		// The reply carries no sequence, so one query at a time. Asking again
		// gives the first asker silence.
		abandonClipboardQuery(this);
		return nextReply(this, "clipboard", {
			ask: CLIPBOARD_QUERY,
			timeoutMs: TerminalExchange[kClipboardQueryTimeout],
			absent: null,
			clipboard: true,
			read: ({text}) => text,
		});
	}

	clearScreen(): Promise<void> {
		return this.write(SCREEN_CLEAR);
	}

	cursorToRow(row: number): Promise<void> {
		return this.write(rowStart(row));
	}

	eraseBelow(): Promise<void> {
		return this.write(BELOW_ERASE);
	}

	/** Each line starts by erasing the rest of its row. */
	writeLines(text: string): Promise<void> {
		return this.write(
			LINE_ERASE + text.replace(/\r\n(?!$)/g, "\r\n" + LINE_ERASE),
		);
	}

	scrollUp(bottomRow: number, rows: number): Promise<void> {
		return this.write(rowStart(bottomRow) + SCROLL_STEP.repeat(rows));
	}

	/**
	 * Wait for every outstanding cursor query, or give up at the deadline. A
	 * reply after the tty is handed back is typed into the shell. Mode
	 * queries are not waited on. Their stragglers are scrubbed.
	 */
	drainQueries(deadlineMs: number): Promise<void> {
		this[kProbingEnded] = true;
		if (!this[kInteractive] || this[kDisposed]) {
			return Promise.resolve();
		}
		const settled = () =>
			this[kWidths].pending.length === 0 &&
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
			timer.unref?.();
		});
	}

	dispose(): void {
		if (this[kDisposed]) {
			return;
		}
		this[kDisposed] = true;
		this[kProbingEnded] = true;
		if (this[kResizeTimer] !== null) {
			clearTimeout(this[kResizeTimer]);
			this[kResizeTimer] = null;
		}

		// Only when it was set. Reset is where we left it anyway.
		if (this[kPriorBidiMode] === 1) {
			void this.write(BIDI_IMPLICIT);
			this[kPriorBidiMode] = null;
		}
		this.restoreEngagedModes();
		this[kGraphemeClustersNegotiated] = false;
		abandonClipboardQuery(this);
		for (const entry of this[kPendingReplies]) {
			clearTimeout(entry.timer);
		}
		this[kPendingReplies].length = 0;
		const widths = this[kWidths];
		if (widths.timer !== null) {
			clearTimeout(widths.timer);
			widths.timer = null;
		}
		if (widths.starvationTimer !== null) {
			clearTimeout(widths.starvationTimer);
			widths.starvationTimer = null;
		}
		widths.pending.length = 0;
		widths.probing = false;

		// Cancelling the readable hands a process transport its tty back. The
		// writer is released after the restores queued above.
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

function rowStart(row: number): string {
	return `\x1b[${row};1H`;
}

// Untrusted text the cell grid never sees. Rejects the same bytes a
// cell does.
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

function clipboardEscape(text: string): string {
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
	// Ever probed, from anywhere. Bounds the probe train to one per
	// cluster.
	asked: Set<string>;
	// Turned away by the margin and never probed. Waiting for a train.
	starved: Set<string>;
	starvationTimer: ReturnType<typeof setTimeout> | null;
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

function freshWidthProbes(probing: boolean): WidthProbes {
	return {
		pending: [],
		settled: new Set(),
		asked: new Set(),
		starved: new Set(),
		starvationTimer: null,
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

// Starvation is found mid-frame, past where the train would have gone.
// A document still painting carries it on the next frame for free. Only
// a quiet one needs a frame requested.
function requestStarvationFrame(session: TerminalExchange): void {
	const widths = session[kWidths];
	if (widths.starvationTimer !== null) {
		return;
	}
	widths.starvationTimer = setTimeout(() => {
		widths.starvationTimer = null;
		if (session[kDisposed] || widths.starved.size === 0) {
			return;
		}
		probesStarved(session[kTermDOM]);
	}, TerminalExchange[kWidthStarvationWait]);
}

// One deadline, timed from the oldest outstanding probe.
function armWidthProbeTimer(session: TerminalExchange): void {
	const widths = session[kWidths];
	if (widths.timer !== null) {
		return;
	}
	const oldest = widths.pending[0];
	if (oldest === undefined) {
		return;
	}
	const remaining = Math.max(
		0,
		oldest.sentAt + TerminalExchange[kWidthProbeTimeout] - Date.now(),
	);
	widths.timer = setTimeout(() => {
		widths.timer = null;
		// An abandoned probe leaves the queue that matches replies. Its cluster
		// keeps the tables' width and is not probed again.
		const deadline = Date.now() - TerminalExchange[kWidthProbeTimeout];
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
			widths.starved.clear();
			return;
		}
		widths.pending.splice(0, expired);
		armWidthProbeTimer(session);
	}, remaining);
}

// The reply's column minus the cluster's start column is the advance,
// corrected by the drift the run's earlier clusters introduced.
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
	const widths = session[kWidths];
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
	if (recordClusterAdvance(probe.cluster, advance)) {
		widthsCorrected(session[kTermDOM]);
	}
}

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
				scheduleResize(session);
			}
		}
	} catch (_err) {
		// Teardown, not error.
	}
}

const RESIZE_DEBOUNCE_MS = 40;

// A drag fires a SIGWINCH per width, and each redraw leaves reflowed
// junk in the scrollback, so the burst becomes one redraw. Renders are
// suppressed from the first SIGWINCH, or animation ticks paint at the
// stale anchor.
function scheduleResize(session: TerminalExchange): void {
	session[kSettlingResize] = {};
	if (session[kResizeTimer] !== null) {
		clearTimeout(session[kResizeTimer]);
	}
	session[kResizeTimer] = setTimeout(() => {
		session[kResizeTimer] = null;
		handleResize(session);
	}, RESIZE_DEBOUNCE_MS);
}

// The terminal has rewrapped the old frame with the text above it. The
// cursor was parked on the frame's bottom row and stayed on its line
// through the rewrap, and every painted row is a hard line, so the
// rewrapped height is computable: cursor row minus that height is the
// new top. A terminal that does not reply gets the computed re-anchor,
// exact for height changes.
function handleResize(session: TerminalExchange): void {
	const termDOM = session[kTermDOM];
	const {cols: newWidth, rows: newHeight} = session[kTransport];
	terminalResized(termDOM, newWidth, newHeight);
	const {contentHeight, wrappedRowsAbove, documentTop} = frameStanding(
		termDOM,
		newWidth,
	);
	const settling = session[kSettlingResize];

	const redraw = (startRow: number) => {
		frameReplaced(termDOM, startRow);

		// The frame is placed by the screen reset. Cursor detection is
		// suspended until it is written.
		session[kSettlingResize] = null;
		const wasDetected = session[kHasDetectedCommandStart];
		session[kHasDetectedCommandStart] = false;
		termDOM.window.requestAnimationFrame(() => {
			session[kHasDetectedCommandStart] = wasDetected;
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

	if (session[kAnchorDetectionEnabled] && wrappedRowsAbove !== null) {
		session
			.queryCursorRow()
			.then((cursorRow) => {
				if (settling !== session[kSettlingResize]) {
					return;
				}
				place(Math.max(0, cursorRow - wrappedRowsAbove));
			})
			.catch(() => {
				if (settling !== session[kSettlingResize]) {
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
function route(session: TerminalExchange, chunk: string): void {
	let keys: WireKey[] = [];
	const input = session[kInput]!;
	const flushKeys = () => {
		if (keys.length > 0) {
			input.dispatch(keys);
			keys = [];
		}
	};
	for (const item of session[kWireReader].feed(chunk)) {
		switch (item.kind) {
			case "key":
				// Raw mode delivers Ctrl-C as data. Closing is the window's
				// decision.
				if (item.ctrlKey && item.key === "c") {
					flushKeys();
					session[kTermDOM].window.close();
					break;
				}
				keys.push(item);
				break;
			case "mouse":
			case "paste":
				flushKeys();
				input.dispatch(item);
				break;
			default:
				flushKeys();
				dispatchReply(session, item);
				break;
		}
	}
	flushKeys();
}

type ReplyOf<K extends WireItem["kind"]> = Extract<WireItem, {kind: K}>;

// `read` runs where the item is dispatched, so its side effects happen
// in stream order. `absent` is the value silence produces. The cursor
// questions have none and reject instead.
function nextReply<K extends WireItem["kind"], T>(
	session: TerminalExchange,
	kind: K,
	options: {
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

function abandonClipboardQuery(session: TerminalExchange): void {
	const pending = session[kPendingReplies];
	const index = pending.findIndex((entry) => entry.clipboard);
	if (index !== -1) {
		const [entry] = pending.splice(index, 1);
		entry.giveUp();
	}
}

// A cursor report goes to whichever of the anchor queries and the width
// probes was sent first, because a terminal replies to DSR in ask order.
function dispatchReply(session: TerminalExchange, item: WireItem): void {
	const pending = session[kPendingReplies];
	let index = -1;
	for (let i = 0; i < pending.length; i++) {
		if (pending[i].kind !== item.kind) {
			continue;
		}
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
		const width = session[kWidths].pending[0];
		if (
			width !== undefined &&
			(index === -1 || width.sequence < (pending[index].sequence ?? Infinity))
		) {
			session[kWidths].pending.shift();
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
	session: TerminalExchange,
	mode: string,
	prelude: string,
): Promise<number | null> {
	return nextReply<"mode-report", number | null>(session, "mode-report", {
		ask: prelude + modeQuery(mode),
		timeoutMs: 1000,
		absent: null,
		mode,
		read: ({value}) => value,
	});
}

// The Node process shape transportFromProcess reads. Tests pass mocks.
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

// An app that exits without disposing would strand the shell with no
// cursor and the modes set. One exit hook restores every engaged process
// transport.
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
				// The stream may already be gone.
			}
		}
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
		// Synchronously. The engine's restores go through the writable's queue,
		// and `dispose(); process.exit()` exits before it flushes.
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

				undisposedProcesses.add(proc);
				installCursorRestoreOnExit();

				// A SIGINT here is an external kill, since raw mode delivers
				// Ctrl-C as data. Close, then exit once the session has
				// disposed.
				const closeOn = (signal: ProcessSignal, exitAfter: boolean) => {
					const listener = () => {
						closedResolve({});
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
			// The default high-water mark would pull at construction and take
			// the tty before attach().
		},
		{highWaterMark: 0},
	);

	const writable = new WritableStream<string>({
		// Resolved on the write callback, so awaiting a write means the
		// terminal has the bytes.
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
