/**
 * <embed type="application/x-pty">: a program run in a pseudo-terminal,
 * its screen kept by the emulator in vt.ts and drawn as cells in the
 * embed's box.
 */

import {
	type Caret,
	CellContext,
	CellGrid,
	type CellStyle,
	clearGrid,
	drawText,
} from "./framebuffer.ts";
import {
	BLINK,
	BOLD,
	DEFAULT_COLOR,
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
export interface PtyProcess {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	// Hangs up, as closing a terminal window does. A shell ignores
	// SIGTERM, but never SIGHUP.
	kill(): void;
}

export interface PtySpawnOptions {
	cols: number;
	rows: number;
	onData(data: Uint8Array | string): void;
	onExit(code: number | null): void;
}

/** Starts `command` in a pseudo-terminal. */
export type PtySpawner = (
	command: string,
	options: PtySpawnOptions,
) => PtyProcess;

interface BunTerminal {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	close(): void;
}

interface BunSubprocess {
	terminal?: BunTerminal;
	exited: Promise<number | null>;
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

interface NodePtyChild {
	onData(listener: (data: string) => void): void;
	onExit(listener: (event: {exitCode: number}) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}

interface NodePty {
	spawn(
		file: string,
		args: string[],
		options: {
			name: string;
			cols: number;
			rows: number;
			env: Record<string, string | undefined>;
		},
	): NodePtyChild;
}

let replacement: PtySpawner | null = null;

/** Stands in for the runtime's pseudo-terminal, as the tests do. */
export function replaceSpawner(spawner: PtySpawner | null): void {
	replacement = spawner;
}

/**
 * The pseudo-terminal this runtime can use: Bun's own, or node-pty on
 * Node when it is installed. Null where there is none.
 */
export function findSpawner(): PtySpawner | null {
	if (replacement !== null) {
		return replacement;
	}
	const bun = (globalThis as {Bun?: BunLike}).Bun;
	if (bun !== undefined && typeof bun.spawn === "function") {
		return createBunSpawner(bun);
	}
	if ("Deno" in globalThis) {
		return null;
	}
	const nodePty = loadNodePty();
	return nodePty === null ? null : createNodePtySpawner(nodePty);
}

function createBunSpawner(bun: BunLike): PtySpawner {
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
			onExit(code);
		});
		return {
			write: (data) => terminal.write(data),
			resize: (newCols, newRows) => terminal.resize(newCols, newRows),
			kill: () => child.kill("SIGHUP"),
		};
	};
}

interface NodeModule {
	createRequire(from: string): (id: string) => unknown;
}

function loadNodePty(): NodePty | null {
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
		return nodeModule.createRequire(from)("node-pty") as NodePty;
	} catch (err) {
		if ((err as {code?: unknown}).code === "MODULE_NOT_FOUND") {
			return null;
		}
		throw err;
	}
}

function createNodePtySpawner(nodePty: NodePty): PtySpawner {
	return (command, {cols, rows, onData, onExit}) => {
		const child = nodePty.spawn(
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
		child.onExit(({exitCode}) => onExit(exitCode));
		return {
			write: (data) => child.write(data),
			resize: (newCols, newRows) => child.resize(newCols, newRows),
			kill: () => child.kill("SIGHUP"),
		};
	};
}

// The 16 colors as xterm draws them, then the 6x6x6 cube and the grays.
const PALETTE: number[] = [
	0x000000,
	0xcd0000,
	0x00cd00,
	0xcdcd00,
	0x0000ee,
	0xcd00cd,
	0x00cdcd,
	0xe5e5e5,
	0x7f7f7f,
	0xff0000,
	0x00ff00,
	0xffff00,
	0x5c5cff,
	0xff00ff,
	0x00ffff,
	0xffffff,
];
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
	return color >= RGB_COLOR ? color & 0xffffff : PALETTE[color];
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

const CSI_KEYS: Record<string, string> = {
	ArrowUp: "A",
	ArrowDown: "B",
	ArrowRight: "C",
	ArrowLeft: "D",
	Home: "H",
	End: "F",
};

const TILDE_KEYS: Record<string, number> = {
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

const SS3_KEYS: Record<string, string> = {F1: "P", F2: "Q", F3: "R", F4: "S"};

interface KeyLike {
	key: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
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
			return key.shiftKey ? "\x1b[Z" : `${alt}\t`;
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
export interface PtySessionListeners {
	change(): void;
	exit(code: number | null): void;
	titlechange(title: string): void;
	bell(): void;
}

/**
 * One program on one pseudo-terminal, and the screen it draws. It draws
 * into a box as a frame's document does: fit() gives the cells at the
 * box's size, and caret says where the terminal's cursor goes. Every
 * change to the screen calls the `change` listener.
 */
export class PtySession {
	cols: number;
	rows: number;
	version: number;
	exited: boolean;
	process: PtyProcess | null;
	terminal: Terminal;
	listeners: PtySessionListeners;
	grid: CellGrid;
	// The version the grid was drawn at, or -1 for one not drawn yet.
	drawn: number;
	disposed: boolean;
	// How many lines of history the view is scrolled back.
	scrolled: number;

	constructor(
		command: string,
		spawn: PtySpawner,
		cols: number,
		rows: number,
		listeners: PtySessionListeners,
	) {
		this.cols = Math.max(1, cols);
		this.rows = Math.max(1, rows);
		this.version = 0;
		this.exited = false;
		this.listeners = listeners;
		this.grid = new CellGrid(this.rows, this.cols);
		this.drawn = -1;
		this.disposed = false;
		this.scrolled = 0;
		this.terminal = new Terminal(this.cols, this.rows, (data) =>
			this.write(data),
		);
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
				this.version++;
				listeners.change();
				if (terminal.title !== title) {
					listeners.titlechange(terminal.title);
				}
				if (terminal.bells !== bells) {
					listeners.bell();
				}
			},
			onExit: (code) => {
				this.exited = true;
				this.process = null;
				this.version++;
				listeners.exit(code);
			},
		});
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
			color: null,
		};
	}

	write(data: string): void {
		this.process?.write(data);
	}

	/** Sends what the user typed, returning the view to the bottom. */
	input(data: string): void {
		this.scrollBy(-this.scrolled);
		this.write(data);
	}

	/**
	 * Takes what a page posts to the program: text, or an event, or an
	 * object shaped like one, forwarded as the user's own input would
	 * be. A keydown is the key in the program's modes and a paste is
	 * its text. A keyup, a key alone such as Shift, and a key still
	 * composing send nothing.
	 */
	receive(message: unknown): void {
		if (typeof message !== "object" || message === null) {
			this.input(String(message));
			return;
		}
		const event = message as Record<string, unknown>;
		switch (event.type) {
			case "keydown":
				if (typeof event.key !== "string") {
					throw new TypeError("A keydown message needs a key");
				}
				if (!event.isComposing) {
					this.sendKey({
						key: event.key,
						ctrlKey: Boolean(event.ctrlKey),
						shiftKey: Boolean(event.shiftKey),
						altKey: Boolean(event.altKey),
						metaKey: Boolean(event.metaKey),
					});
				}
				return;
			case "keyup":
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

	/** Sends a key, or returns false for a key the terminal sends nothing for. */
	sendKey(key: KeyLike): boolean {
		const bytes = encodeKey(key, this.terminal.applicationCursor);
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
			this.terminal.bracketedPaste ? `\x1b[200~${body}\x1b[201~` : body,
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
		if (this.terminal.focusReporting && !this.exited) {
			this.write(focused ? "\x1b[I" : "\x1b[O");
		}
	}

	resize(cols: number, rows: number): void {
		cols = Math.max(1, cols);
		rows = Math.max(1, rows);
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
			drawScreen(
				new CellContext(this.grid, this.rows, this.cols, 0),
				this.terminal,
				this.scrolled,
			);
		}
		return this.grid;
	}

	dispose(): void {
		this.process?.kill();
		this.process = null;
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

function drawScreen(
	cells: CellContext,
	terminal: Terminal,
	scrolled: number,
): void {
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
			const chars = line.attrs[col] & INVISIBLE ? "" : line.chars[col];
			if (!isBlank(chars, style)) {
				drawText(cells, chars === "" ? " " : chars, col, row, style);
			}
		}
	}
}
