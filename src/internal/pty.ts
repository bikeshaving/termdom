/**
 * <embed type="application/x-pty">: a program run in a pseudo-terminal,
 * its screen kept by the emulator in vt.ts and drawn as cells in the
 * embed's box.
 */

import {toCellColor} from "./cssvalues.ts";
import {
	ANSI_PALETTE,
	type Caret,
	CellContext,
	CellGrid,
	type CellStyle,
	clearGrid,
	drawText,
} from "./framebuffer.ts";
import type {GridImage} from "./images.ts";
import {readPlaceholder} from "./kitty.ts";
import {type ProgramImage, ProgramImages} from "./ptyimages.ts";
import {clearTimeout, setTimeout} from "./timers.ts";
import {
	BLINK,
	BOLD,
	DEFAULT_COLOR,
	type DefaultColors,
	DIM,
	DOUBLE_UNDERLINE,
	INVERSE,
	INVISIBLE,
	ITALIC,
	type Line,
	OVERLINE,
	RGB_COLOR,
	STRIKETHROUGH,
	Terminal,
	UNDERLINE,
} from "./vt.ts";

/** What a TermDOM needs from a running pseudo-terminal. */
export interface PTYProcess {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	// Hangs up, as closing a terminal window does. A shell ignores
	// SIGTERM, but never SIGHUP.
	kill(): void;
}

export interface PTYSpawnOptions {
	cols: number;
	rows: number;
	onData(data: Uint8Array | string): void;
	// The exit code, and for a program a signal ended, the signal's name,
	// with the code a shell gives it: 128 and its number.
	onExit(code: number, signal: string | null): void;
}

/** Starts `command` in a pseudo-terminal. */
export type PTYSpawner = (
	command: string,
	options: PTYSpawnOptions,
) => PTYProcess;

interface BunTerminal {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	close(): void;
}

interface BunSubprocess {
	terminal?: BunTerminal;
	exited: Promise<number | null>;
	signalCode: string | null;
	kill(signal?: string): void;
}

interface BunLike {
	spawn(
		command: string[],
		options: {
			env: Record<string, string | undefined>;
			terminal: {
				cols: number;
				rows: number;
				data(terminal: BunTerminal, data: Uint8Array): void;
			};
		},
	): BunSubprocess;
}

interface NodePTYChild {
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: {exitCode: number; signal?: number}) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}

interface NodePTY {
	spawn(
		file: string,
		args: string[],
		options: {
			name: string;
			cols: number;
			rows: number;
			env: Record<string, string | undefined>;
		},
	): NodePTYChild;
}

let replacement: PTYSpawner | null = null;

/** Stands in for the runtime's pseudo-terminal, as the tests do. */
export function replaceSpawner(spawner: PTYSpawner | null): void {
	replacement = spawner;
}

/**
 * The pseudo-terminal this runtime can use: Bun's own, or node-pty on
 * Node when it is installed. Null where there is none, and on Windows,
 * which has no /bin/sh to run the command with.
 */
export function findSpawner(): PTYSpawner | null {
	if (replacement !== null) {
		return replacement;
	}
	if (globalThis.process?.platform === "win32") {
		return null;
	}
	const bun = (globalThis as {Bun?: BunLike}).Bun;
	if (bun !== undefined && typeof bun.spawn === "function") {
		return createBunSpawner(bun);
	}
	if ("Deno" in globalThis) {
		return null;
	}
	const nodePTY = loadNodePTY();
	return nodePTY === null ? null : createNodePTYSpawner(nodePTY);
}

function createBunSpawner(bun: BunLike): PTYSpawner {
	return (command, {cols, rows, onData, onExit}) => {
		const child = bun.spawn(
			["/bin/sh", "-c", command],
			{
				env: {...process.env, TERM: "xterm-256color"},
				terminal: {cols, rows, data: (_terminal, data) => onData(data)},
			},
		);
		const terminal = child.terminal;
		if (terminal === undefined) {
			child.kill();
			throw new Error("This version of Bun has no pseudo-terminal.");
		}
		void child.exited.then((code) => {
			terminal.close();
			onExit(code ?? 0, child.signalCode);
		});
		return {
			write: (data) => terminal.write(data),
			resize: (newCols, newRows) => terminal.resize(newCols, newRows),
			kill: () => {
				child.kill("SIGHUP");
				terminal.close();
			},
		};
	};
}

interface NodeModule {
	createRequire(from: string): (id: string) => unknown;
}

function loadNodePTY(): NodePTY | null {
	const {process} =
		globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}};
	if (process === undefined || typeof process.getBuiltinModule !== "function") {
		return null;
	}
	const nodeModule = process.getBuiltinModule("node:module") as NodeModule;
	const from = typeof import.meta.url === "string"
		? import.meta.url
		: `${globalThis.process.cwd()}/`;
	try {
		return nodeModule.createRequire(from)("node-pty") as NodePTY;
	} catch (err) {
		if ((err as {code?: unknown}).code === "MODULE_NOT_FOUND") {
			return null;
		}
		throw err;
	}
}

function getSignalName(number: number): string | null {
	const {process} =
		globalThis as {process: {getBuiltinModule(id: string): unknown}};
	const os = process.getBuiltinModule("node:os") as {
		constants: {signals: Record<string, number>};
	};
	const entry = Object.entries(os.constants.signals)
		.find(([, value]) => value === number);
	return entry === undefined ? null : entry[0];
}

function createNodePTYSpawner(nodePTY: NodePTY): PTYSpawner {
	return (command, {cols, rows, onData, onExit}) => {
		const child = nodePTY.spawn(
			"/bin/sh",
			["-c", command],
			{
				name: "xterm-256color",
				cols,
				rows,
				env: {...process.env, TERM: "xterm-256color"},
			},
		);
		child.onData(onData);
		child.onExit(({exitCode, signal}) => {
			if (signal) {
				onExit(128 + signal, getSignalName(signal));
			} else {
				onExit(exitCode, null);
			}
		});
		return {
			write: (data) => child.write(data),
			resize: (newCols, newRows) => child.resize(newCols, newRows),
			kill: () => child.kill("SIGHUP"),
		};
	};
}

// The 16 colors as xterm draws them, then the 6x6x6 cube and the grays.
const PALETTE = [...ANSI_PALETTE];
const CUBE = [0, 95, 135, 175, 215, 255];
for (let index = 16; index < 232; index++) {
	const n = index - 16;
	PALETTE.push(
		(CUBE[Math.floor(n / 36)] << 16) |
			(CUBE[Math.floor(n / 6) % 6] << 8) |
			CUBE[n % 6],
	);
}
for (let index = 232; index < 256; index++) {
	const level = 8 + (index - 232) * 10;
	PALETTE.push((level << 16) | (level << 8) | level);
}

function resolveColor(color: number): number | undefined {
	if (color === DEFAULT_COLOR) {
		return undefined;
	}
	return toCellColor(color >= RGB_COLOR ? color & 0xffffff : PALETTE[color]);
}

const STYLE_FLAGS: Array<[number, keyof CellStyle]> = [
	[BOLD, "bold"],
	[ITALIC, "italic"],
	[DIM, "dim"],
	[UNDERLINE, "underline"],
	[DOUBLE_UNDERLINE, "underline"],
	[INVERSE, "inverse"],
	[STRIKETHROUGH, "strikethrough"],
	[OVERLINE, "overline"],
	[BLINK, "blink"],
];

function readCellStyle(line: Line, col: number): CellStyle {
	const style: CellStyle = {};
	const fg = resolveColor(line.fg[col]);
	const bg = resolveColor(line.bg[col]);
	if (fg !== undefined) {
		style.fg = fg;
	}
	if (bg !== undefined) {
		style.bg = bg;
	}
	const attrs = line.attrs[col];
	for (const [flag, name] of STYLE_FLAGS) {
		if (attrs & flag) {
			(style as Record<string, boolean>)[name] = true;
		}
	}
	if (attrs & DOUBLE_UNDERLINE) {
		style.underlineStyle = "double";
	}
	return style;
}

// The keys a terminal sends as CSI or SS3 and a letter, and as CSI, a
// number and a tilde. F1-F4 are SS3. F5-F12 skip 16, as xterm's do.
export const CSI_KEYS: Record<string, string> = {
	ArrowUp: "A",
	ArrowDown: "B",
	ArrowRight: "C",
	ArrowLeft: "D",
	Home: "H",
	End: "F",
};

export const TILDE_KEYS: Record<string, number> = {
	Insert: 2,
	Delete: 3,
	PageUp: 5,
	PageDown: 6,
	F5: 15,
	F6: 17,
	F7: 18,
	F8: 19,
	F9: 20,
	F10: 21,
	F11: 23,
	F12: 24,
};

export const SS3_KEYS: Record<string, string> = {
	F1: "P",
	F2: "Q",
	F3: "R",
	F4: "S",
};

// The one named spelling that carries a modifier.
export const SHIFT_TAB = "\x1b[Z";

// The fences around a bracketed paste, mode 2004.
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

interface KeyLike {
	key: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

/** A key's press, its repeat while held, or its release. */
export type KeyAction = "press" | "repeat" | "release";

// The kitty keyboard protocol's flags. The first, disambiguate, is
// what any of them asks for, as in Ghostty.
const REPORT_EVENTS = 2;
const REPORT_ALTERNATES = 4;
const REPORT_ALL = 8;
const REPORT_TEXT = 16;

const EVENT_NUMBERS: Record<KeyAction, number> = {
	press: 1,
	repeat: 2,
	release: 3,
};

// The keys the kitty keyboard protocol numbers as CSI u.
const KITTY_KEY_NUMBERS: Record<string, number> = {
	Escape: 27,
	Enter: 13,
	Tab: 9,
	Backspace: 127,
};

// The character each shifted character on a US layout comes from. A
// terminal says what a key wrote, not which key it was.
const US_UNSHIFTED: Record<string, string> = Object.fromEntries(
	[..."~!@#$%^&*()_+{}|:\"<>?"].map((shifted, index) => [
		shifted,
		"`1234567890-=[]\\;',./"[index],
	]),
);

function unshifted(key: string): string {
	return US_UNSHIFTED[key] ?? key.toLowerCase();
}

// The kitty protocol's modifier bits: shift 1, alt 2, ctrl 4, super 8.
function kittyModifiers(key: KeyLike): number {
	return (key.shiftKey ? 1 : 0) +
		(key.altKey ? 2 : 0) +
		(key.ctrlKey ? 4 : 0) +
		(key.metaKey ? 8 : 0);
}

/**
 * The bytes for a key under the kitty keyboard protocol's `flags`, as
 * Ghostty sends them, or null for a key or an action it sends nothing
 * for.
 */
export function encodeKittyKey(
	key: KeyLike,
	flags: number,
	action: KeyAction,
): string | null {
	const events = (flags & REPORT_EVENTS) !== 0;
	if (!events) {
		if (action === "release") {
			return null;
		}
		action = "press";
	}
	const modifiers = kittyModifiers(key);
	const event = EVENT_NUMBERS[action];
	const letter =
		CSI_KEYS[key.key] ?? (key.key === "F3" ? undefined : SS3_KEYS[key.key]);
	if (letter !== undefined) {
		const field = modifierField(modifiers, event, events);
		return field === "" ? `\x1b[${letter}` : `\x1b[1;${field}${letter}`;
	}
	const field = modifierField(modifiers, event, false);
	const tilde = key.key === "F3" ? 13 : TILDE_KEYS[key.key];
	if (tilde !== undefined) {
		return `\x1b[${tilde}${field === "" ? "" : `;${field}`}~`;
	}
	const function_ = /^F(\d+)$/.exec(key.key);
	if (function_ !== null && Number(function_[1]) >= 13) {
		const number = 57376 + Number(function_[1]) - 13;
		return `\x1b[${number}${field === "" ? "" : `;${field}`}u`;
	}
	const named = KITTY_KEY_NUMBERS[key.key];
	const characters = [...key.key];
	const text = named === undefined && characters.length === 1;
	if (named === undefined && !text) {
		return null;
	}
	// Shift that changes the character is in the character. Shift that
	// does not, as on Space, makes the key a modified key.
	const shiftWrites = text && key.shiftKey && unshifted(key.key) !== key.key;
	const plain = !key.ctrlKey && !key.altKey && !key.metaKey;
	if (!(flags & REPORT_ALL)) {
		if (named !== undefined && named !== 27) {
			if (action === "release") {
				return null;
			}
			if (modifiers === 0) {
				return encodeKey(key, false);
			}
		}
		if (text && plain && (shiftWrites || !key.shiftKey)) {
			if (action !== "release") {
				return key.key;
			}
		}
	}
	const base = named ?? unshifted(key.key).codePointAt(0)!;
	const alternate = flags & REPORT_ALTERNATES && shiftWrites
		? `:${key.key.codePointAt(0)}`
		: "";
	if (flags & REPORT_TEXT && text && plain && action !== "release") {
		const codes = characters.map((each) => each.codePointAt(0)).join(":");
		return `\x1b[${base}${alternate};${field};${codes}u`;
	}
	return `\x1b[${base}${alternate}${field === "" ? "" : `;${field}`}u`;
}

// The kitty protocol's field of modifiers and event: 1 plus the
// modifiers, then a colon and the event when it is not a press. Empty
// for a press with none, unless `always`.
function modifierField(
	modifiers: number,
	event: number,
	always: boolean,
): string {
	if (always) {
		return `${modifiers + 1}:${event}`;
	}
	if (modifiers === 0 && event === 1) {
		return "";
	}
	return `${modifiers + 1}${event === 1 ? "" : `:${event}`}`;
}

// xterm's modifier parameter: 1 plus shift 1, alt 2, ctrl 4.
function encodeModifier(key: KeyLike): number {
	return 1 +
		(key.shiftKey ? 1 : 0) +
		(key.altKey ? 2 : 0) +
		(key.ctrlKey ? 4 : 0);
}

/**
 * The bytes a terminal sends for a key, as xterm sends them, or null for
 * a key it sends nothing for.
 */
export function encodeKey(
	key: KeyLike,
	applicationCursor: boolean,
): string | null {
	const modifier = encodeModifier(key);
	const csi = CSI_KEYS[key.key];
	if (csi !== undefined) {
		if (modifier > 1) {
			return `\x1b[1;${modifier}${csi}`;
		}
		return applicationCursor ? `\x1bO${csi}` : `\x1b[${csi}`;
	}
	const tilde = TILDE_KEYS[key.key];
	if (tilde !== undefined) {
		return modifier > 1 ? `\x1b[${tilde};${modifier}~` : `\x1b[${tilde}~`;
	}
	const ss3 = SS3_KEYS[key.key];
	if (ss3 !== undefined) {
		return modifier > 1 ? `\x1b[1;${modifier}${ss3}` : `\x1bO${ss3}`;
	}
	const alt = key.altKey ? "\x1b" : "";
	switch (key.key) {
		case "Enter":
			return `${alt}\r`;
		case "Backspace":
			return `${alt}${key.ctrlKey ? "\b" : "\x7f"}`;
		case "Tab":
			return key.shiftKey ? SHIFT_TAB : `${alt}\t`;
		case "Escape":
			return `${alt}\x1b`;
	}
	if ([...key.key].length !== 1 || key.metaKey) {
		return null;
	}
	if (key.ctrlKey) {
		const code = key.key.toUpperCase().charCodeAt(0);
		if (code >= 0x40 && code <= 0x5f) {
			return `${alt}${String.fromCharCode(code - 0x40)}`;
		}
		if (key.key === " " || key.key === "2") {
			return `${alt}\x00`;
		}
		if (key.key === "?") {
			return `${alt}\x7f`;
		}
		return null;
	}
	return `${alt}${key.key}`;
}

/** What a session tells its embed about the program. */
export interface PTYSessionListeners {
	change(): void;
	exit(code: number, signal: string | null): void;
	titlechange(title: string): void;
	bell(): void;
	// The colors the embed draws a cell with no colors of its own in.
	colors(): DefaultColors;
	// One cell in the terminal's pixels, or null where none is known.
	cellPixels(): {width: number; height: number} | null;
	// The program put text on the clipboard, or asked for what is on it,
	// which resolves to null where the terminal does not say.
	writeClipboard(text: string): void;
	readClipboard(): Promise<string | null>;
}

// Text as the base64 of its UTF-8, which is how OSC 52 carries it.
function encodeBase64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

// Null for what is not base64.
function decodeBase64(data: string): string | null {
	let binary: string;
	try {
		binary = atob(data);
	} catch (_err) {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new TextDecoder().decode(bytes);
}

// A screen's columns or rows, at most a thousand, so that a size the
// markup asks for can't take all the memory there is.
const MAX_SIZE = 1000;

function clampSize(size: number): number {
	return Math.min(MAX_SIZE, Math.max(1, Math.floor(size) || 1));
}

let nextSessionToken = 0;

/**
 * One program on one pseudo-terminal, and the screen it draws. It draws
 * into a box as a frame's document does: fit() gives the cells at the
 * box's size, and caret says where the terminal's cursor goes. Every
 * change to the screen calls the `change` listener.
 */
export class PTYSession {
	cols: number;
	rows: number;
	version: number;
	exited: boolean;
	process: PTYProcess | null;
	terminal: Terminal;
	listeners: PTYSessionListeners;
	grid: CellGrid;
	// The version the grid was drawn at, or -1 for one not drawn yet.
	drawn: number;
	disposed: boolean;
	// How many lines of history the view is scrolled back.
	scrolled: number;
	focused: boolean;
	// What was sent before the program started, written once it has.
	pending: string[] | null;
	// While the program has synchronized output on, the timer that draws
	// what it wrote anyway, should it never turn it off.
	held: ReturnType<typeof setTimeout> | null;
	// The kitty graphics the program sent, and the ones its cells showed
	// when the grid was drawn last.
	images: ProgramImages;
	shown: GridImage[];
	// Tells this session's images from another's.
	token: number;

	constructor(cols: number, rows: number, listeners: PTYSessionListeners) {
		this.cols = clampSize(cols);
		this.rows = clampSize(rows);
		this.version = 0;
		this.exited = false;
		this.listeners = listeners;
		this.grid = new CellGrid(this.rows, this.cols);
		this.drawn = -1;
		this.disposed = false;
		this.scrolled = 0;
		this.focused = false;
		this.pending = [];
		this.held = null;
		this.process = null;
		this.terminal = new Terminal(this.cols, this.rows, (data) =>
			this.write(data),
		);
		this.terminal.colors = listeners.colors;
		this.terminal.cellPixels = listeners.cellPixels;
		this.terminal.clipboard = (selection, data) =>
			this.clipboard(selection, data);
		this.images = new ProgramImages(
			(data) => this.write(data),
			() => this.show(),
		);
		this.terminal.graphics = (command) => this.images.command(command);
		this.shown = [];
		this.token = nextSessionToken++;
	}

	/** Where the program's cursor is, or null while it is hidden or gone. */
	get caret(): Caret | null {
		const terminal = this.terminal;
		const row = terminal.y + this.scrolled;
		if (this.exited || !terminal.cursorVisible || row >= this.rows) {
			return null;
		}
		return {
			col: Math.min(terminal.x, this.cols - 1),
			row,
			shape: terminal.cursorShape,
			color: terminal.cursorColor,
		};
	}

	/** Runs `command` at the session's size. */
	start(command: string, spawn: PTYSpawner): void {
		const listeners = this.listeners;
		this.process = spawn(command, {
			cols: this.cols,
			rows: this.rows,
			onData: (data) => {
				if (this.disposed) {
					return;
				}
				const terminal = this.terminal;
				const {historyAdded: added, title, bells} = terminal;
				terminal.write(data);
				this.scrolled = terminal.alternateScreen
					? 0
					: Math.min(
						this.scrolled === 0
							? 0
							: this.scrolled + terminal.historyAdded - added,
						terminal.history.length,
					);
				this.show();
				if (terminal.title !== title) {
					listeners.titlechange(terminal.title);
				}
				if (terminal.bells !== bells) {
					listeners.bell();
				}
			},
			onExit: (code, signal) => {
				if (this.disposed) {
					return;
				}
				this.exited = true;
				this.process = null;
				this.release();
				this.version++;
				listeners.exit(code, signal);
			},
		});
		const pending = this.pending!;
		this.pending = null;
		for (const data of pending) {
			this.process.write(data);
		}
	}

	// What the program writes is drawn at once, except while it has
	// synchronized output on: then the last whole screen stays until it
	// turns it off, or for a second at most.
	show(): void {
		if (this.terminal.synchronizedOutput) {
			this.held ??= setTimeout(() => {
				this.held = null;
				this.version++;
				this.listeners.change();
			}, 1000);
			return;
		}
		this.release();
		this.version++;
		this.listeners.change();
	}

	release(): void {
		if (this.held !== null) {
			clearTimeout(this.held);
			this.held = null;
		}
	}

	// OSC 52: the clipboard's text in base64 goes to the page's terminal,
	// and ? is answered with what the terminal says is on it, or with
	// nothing where it does not say, as most do not. Only the clipboard
	// itself is kept, the selection c, which an empty one means too.
	clipboard(selection: string, data: string): void {
		if (selection !== "" && !selection.includes("c")) {
			return;
		}
		if (data === "?") {
			void this.listeners.readClipboard().then((text) => {
				if (text !== null && !this.disposed && !this.exited) {
					this.write(`\x1b]52;c;${encodeBase64(text)}\x1b\\`);
				}
			});
			return;
		}
		const text = decodeBase64(data);
		if (text !== null) {
			this.listeners.writeClipboard(text);
		}
	}

	write(data: string): void {
		if (this.pending !== null) {
			this.pending.push(data);
		} else {
			this.process?.write(data);
		}
	}

	/** Sends what the user typed, returning the view to the bottom. */
	input(data: string): void {
		this.scrollBy(-this.scrolled);
		this.write(data);
	}

	/**
	 * Takes what a page posts to the program: text, or an event, or an
	 * object shaped like one, forwarded as the user's own input would
	 * be. A keydown is the key in the program's modes, a keyup is its
	 * release when the program asked for releases, and a paste is its
	 * text. A key alone such as Shift and a key still composing send
	 * nothing.
	 */
	receive(message: unknown): void {
		if (typeof message === "string") {
			this.input(message);
			return;
		}
		if (typeof message !== "object" || message === null) {
			throw new TypeError(
				"A message is text, or a keydown, keyup or paste event",
			);
		}
		const event = message as Record<string, unknown>;
		switch (event.type) {
			case "keydown":
			case "keyup":
				if (typeof event.key !== "string") {
					throw new TypeError(`A ${event.type} message needs a key`);
				}
				if (!event.isComposing) {
					this.sendKey({
						key: event.key,
						ctrlKey: Boolean(event.ctrlKey),
						shiftKey: Boolean(event.shiftKey),
						altKey: Boolean(event.altKey),
						metaKey: Boolean(event.metaKey),
					}, event.type === "keyup"
						? "release"
						: event.repeat ? "repeat" : "press");
				}
				return;
			case "paste": {
				const data = event.clipboardData as
					{getData(format: string): string} | null | undefined;
				if (typeof data?.getData !== "function") {
					throw new TypeError("A paste message needs clipboardData");
				}
				this.paste(data.getData("text/plain"));
				return;
			}
		}
		throw new TypeError(
			"A message is text, or a keydown, keyup or paste event",
		);
	}

	/**
	 * Sends a key, or returns false for a key the terminal sends nothing
	 * for. A repeat is a press, and a release sends nothing, unless the
	 * program asked for them through the kitty keyboard protocol.
	 */
	sendKey(key: KeyLike, action: KeyAction = "press"): boolean {
		const flags = this.terminal.keyboardFlags;
		const bytes = flags !== 0
			? encodeKittyKey(key, flags, action)
			: action === "release"
				? null
				: encodeKey(key, this.terminal.applicationCursor);
		if (bytes === null) {
			return false;
		}
		this.input(bytes);
		return true;
	}

	/**
	 * Sends pasted text as a terminal would: line breaks as CR, and inside
	 * the brackets when the program asked for bracketed paste.
	 */
	paste(text: string): void {
		const body = text.replace(/\r?\n/g, "\r");
		this.input(
			this.terminal.bracketedPaste ? PASTE_START + body + PASTE_END : body,
		);
	}

	/**
	 * Sends a mouse report the program asked for, from xterm's button
	 * `code` at a cell of the box. Returns whether the program takes the
	 * mouse at all.
	 */
	sendMouse(code: number, col: number, row: number, release: boolean): boolean {
		const tracking = this.terminal.mouseTracking;
		if (tracking === 0 || this.exited) {
			return false;
		}
		const motion = (code & 32) !== 0;
		const wheel = (code & 64) !== 0;
		const held = (code & 3) !== 3;
		if (
			(tracking === 9 && (release || motion || wheel)) ||
			(tracking === 1000 && motion) ||
			(tracking === 1002 && motion && !held)
		) {
			return true;
		}
		// X10 tracking names the button and nothing else.
		const sent = tracking === 9 ? code & 3 : code;
		const encoding = this.terminal.mouseEncoding;
		if (encoding === 1006) {
			this.write(`\x1b[<${sent};${col + 1};${row + 1}${release ? "m" : "M"}`);
			return true;
		}
		// The older encodings say only that some button let go.
		const button = release ? (sent & ~3) | 3 : sent;
		if (encoding === 1015) {
			this.write(`\x1b[${button + 32};${col + 1};${row + 1}M`);
			return true;
		}
		if (col < 223 && row < 223) {
			this.write(
				`\x1b[M${String.fromCharCode(button + 32, col + 33, row + 33)}`,
			);
		}
		return true;
	}

	/**
	 * Scrolls the view back through history by `lines`, or forward for
	 * a negative count. Returns whether it moved.
	 */
	scrollBy(lines: number): boolean {
		const terminal = this.terminal;
		const scrolled = terminal.alternateScreen
			? 0
			: Math.max(0, Math.min(this.scrolled + lines, terminal.history.length));
		if (scrolled === this.scrolled) {
			return false;
		}
		this.scrolled = scrolled;
		this.version++;
		this.listeners.change();
		return true;
	}

	/** Keeps at most `limit` lines that scroll off the top. */
	setScrollback(limit: number): void {
		const terminal = this.terminal;
		terminal.setHistoryLimit(limit);
		if (this.scrolled > terminal.history.length) {
			this.scrolled = terminal.history.length;
			this.version++;
			this.listeners.change();
		}
	}

	/** Tells the program its box gained or lost focus, if it asked. */
	sendFocus(focused: boolean): void {
		if (focused === this.focused) {
			return;
		}
		this.focused = focused;
		if (this.terminal.focusReporting && !this.exited) {
			this.write(focused ? "\x1b[I" : "\x1b[O");
		}
	}

	resize(cols: number, rows: number): void {
		cols = clampSize(cols);
		rows = clampSize(rows);
		if (cols === this.cols && rows === this.rows) {
			return;
		}
		this.cols = cols;
		this.rows = rows;
		this.terminal.resize(cols, rows);
		this.process?.resize(cols, rows);
		this.grid = new CellGrid(rows, cols);
		this.version++;
	}

	/** The screen as cells at `cols` by `rows`, the program resized to it. */
	fit(cols: number, rows: number): CellGrid {
		this.resize(cols, rows);
		if (this.drawn !== this.version) {
			this.drawn = this.version;
			clearGrid(this.grid);
			this.shown = drawScreen(
				new CellContext(this.grid, this.rows, this.cols, 0),
				this.terminal,
				this.scrolled,
				this.images.images,
				this.token,
			);
		}
		return this.grid;
	}

	dispose(): void {
		this.process?.kill();
		this.process = null;
		this.release();
		this.images.dispose();
		this.disposed = true;
	}
}

// A cell with nothing in it and no background is left empty, so the
// embed's own background shows there.
function isBlank(chars: string, style: CellStyle): boolean {
	return chars === "" &&
		style.bg === undefined &&
		!style.inverse &&
		!style.underline &&
		!style.strikethrough &&
		!style.overline;
}

// The image a placeholder cell names by its foreground: 24-bit color for
// an id of three bytes, a palette index for one of one.
function getImageId(fg: number): number {
	if (fg === DEFAULT_COLOR) {
		return 0;
	}
	return fg >= RGB_COLOR ? fg & 0xffffff : fg;
}

// The screen's cells, and the images its placeholder cells show. A
// placeholder for an image the program has not placed draws nothing
// but its background.
function drawScreen(
	cells: CellContext,
	terminal: Terminal,
	scrolled: number,
	images: Map<number, ProgramImage>,
	token: number,
): GridImage[] {
	const shown = new Map<number, GridImage>();
	const {lines, history} = terminal;
	for (let row = 0; row < terminal.rows; row++) {
		const line = row < scrolled
			? history[history.length - scrolled + row]
			: lines[row - scrolled];
		const cols = Math.min(terminal.cols, line.cols);
		for (let col = 0; col < cols; col++) {
			if (line.widths[col] === 0) {
				continue;
			}
			const style = readCellStyle(line, col);
			const place = readPlaceholder(line.chars[col]);
			if (place !== null) {
				const id = getImageId(line.fg[col]);
				const image = images.get(id);
				if (
					image !== undefined &&
					place.row < image.rows &&
					place.col < image.cols
				) {
					let entry = shown.get(id);
					if (entry === undefined) {
						entry = {
							key: `pty:${token}:${id}`,
							version: image.version,
							bitmap: image.bitmap,
							cols: image.cols,
							rows: image.rows,
							cells: [],
						};
						shown.set(id, entry);
					}
					entry.cells.push({
						row,
						col,
						imageRow: place.row,
						imageCol: place.col,
						bg: style.bg ?? null,
					});
				}
				if (style.bg !== undefined) {
					drawText(cells, " ", col, row, {bg: style.bg});
				}
				continue;
			}
			const chars = line.attrs[col] & INVISIBLE ? "" : line.chars[col];
			if (!isBlank(chars, style)) {
				drawText(cells, chars === "" ? " " : chars, col, row, style);
			}
		}
	}
	return [...shown.values()];
}
