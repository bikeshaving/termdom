/**
 * Ghostty's libghostty-vt, built to WebAssembly, as the standard for the
 * pty embed's emulator: both take one stream of bytes, and their cells,
 * colors, attributes, cursors, histories and modes are compared. Colors
 * compare as RGB, with defaults Ghostty is given that no program writes.
 */
import {readFileSync} from "node:fs";

import {Ghostty} from "ghostty-web";

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
	RGB_COLOR,
	STRIKETHROUGH,
	Terminal,
	UNDERLINE,
} from "../src/internal/vt.ts";

const WASM = readFileSync(
	new URL("../node_modules/ghostty-web/ghostty-vt.wasm", import.meta.url),
);
const MODULE = await WebAssembly.compile(WASM);

const DEFAULT_FG = 0x010203;
const DEFAULT_BG = 0x040506;

const XTERM_16 = [
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
const PALETTE = [...XTERM_16];
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

// Ghostty's cell flags, from ghostty-web's CellFlags.
const GHOSTTY_FLAGS: Array<[number, string]> = [
	[1, "bold"],
	[128, "dim"],
	[2, "italic"],
	[4, "underline"],
	[64, "blink"],
	[16, "inverse"],
	[32, "invisible"],
	[8, "strikethrough"],
];

const OUR_FLAGS: Array<[number, string]> = [
	[BOLD, "bold"],
	[DIM, "dim"],
	[ITALIC, "italic"],
	[UNDERLINE | DOUBLE_UNDERLINE, "underline"],
	[BLINK, "blink"],
	[INVERSE, "inverse"],
	[INVISIBLE, "invisible"],
	[STRIKETHROUGH, "strikethrough"],
];

const MODES: Array<[string, number, boolean]> = [
	["applicationCursor", 1, false],
	["originMode", 6, false],
	["autowrap", 7, false],
	["cursorVisible", 25, false],
	["focusReporting", 1004, false],
	["bracketedPaste", 2004, false],
	["synchronizedOutput", 2026, false],
	["insertMode", 4, true],
];

interface Cell {
	char: string;
	width: number;
	fg: number;
	bg: number;
	attrs: string;
}

interface Snapshot {
	rows: Cell[][];
	history: string[];
	cursor: string;
	modes: Record<string, boolean>;
}

function resolve(color: number, fallback: number): number {
	if (color === DEFAULT_COLOR) {
		return fallback;
	}
	return color >= RGB_COLOR ? color & 0xffffff : PALETTE[color];
}

function ourCells(line: Line): Cell[] {
	return line.chars.map((char, col) => ({
		char: line.widths[col] === 0 ? "" : char || " ",
		width: line.widths[col],
		fg: resolve(line.fg[col], DEFAULT_FG),
		bg: resolve(line.bg[col], DEFAULT_BG),
		attrs: OUR_FLAGS.filter(([bit]) => (line.attrs[col] & bit) !== 0)
			.map(([, name]) => name)
			.join(" "),
	}));
}

function snapshotOurs(
	data: string | Uint8Array,
	cols: number,
	rows: number,
	scrollback: number,
): Snapshot {
	const term = new Terminal(cols, rows, () => {});
	term.setHistoryLimit(scrollback);
	term.write(data);
	const modes: Record<string, boolean> = {
		applicationCursor: term.applicationCursor,
		originMode: term.originMode,
		autowrap: term.autowrap,
		cursorVisible: term.cursorVisible,
		focusReporting: term.focusReporting,
		bracketedPaste: term.bracketedPaste,
		synchronizedOutput: term.synchronizedOutput,
		insertMode: term.insertMode,
		alternateScreen: term.alternateScreen,
	};
	return {
		rows: term.lines.map(ourCells),
		history: term.history.map((line) =>
			ourCells(line).map((cell) => cell.char).join("").trimEnd(),
		),
		cursor: `${Math.min(term.x, cols - 1)},${term.y}`,
		modes,
	};
}

interface GhosttyCellLike {
	codepoint: number;
	fg_r: number;
	fg_g: number;
	fg_b: number;
	bg_r: number;
	bg_g: number;
	bg_b: number;
	flags: number;
	width: number;
	grapheme_len: number;
}

function theirCells(
	cells: GhosttyCellLike[],
	grapheme: (col: number) => string,
): Cell[] {
	return cells.map((cell, col) => {
		const char = cell.width === 0
			? ""
			: cell.grapheme_len > 0
					? grapheme(col)
					: cell.codepoint === 0 ? " " : String.fromCodePoint(cell.codepoint);
		return {
			char,
			width: cell.width,
			fg: (cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b,
			bg: (cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b,
			attrs: GHOSTTY_FLAGS.filter(([bit]) => (cell.flags & bit) !== 0)
				.map(([, name]) => name)
				.join(" "),
		};
	});
}

function snapshotGhostty(
	data: string | Uint8Array,
	cols: number,
	rows: number,
	scrollback: number,
): Snapshot {
	// One instance per terminal: ghostty-web leaves a freed terminal's
	// cells in memory a later terminal reads.
	const instance = new WebAssembly.Instance(MODULE, {env: {log() {}}});
	const term = new Ghostty(instance).createTerminal(cols, rows, {
		scrollbackLimit: scrollback,
		fgColor: DEFAULT_FG,
		bgColor: DEFAULT_BG,
		palette: PALETTE.slice(0, 16),
	});
	try {
		term.write(data);
		const screen: Cell[][] = [];
		for (let y = 0; y < rows; y++) {
			const cells = theirCells(term.getLine(y) ?? [], (col) =>
				term.getGraphemeString(y, col),
			);
			// A wide character that wraps leaves the column it did not fit
			// in as a blank. Ghostty marks that blank with no width.
			const last = cells[cols - 1];
			if (last?.width === 0 && cells[cols - 2]?.width !== 2) {
				last.char = " ";
				last.width = 1;
			}
			screen.push(cells);
		}
		const history: string[] = [];
		// Ghostty keeps one page of history whatever the limit, so with
		// none asked for there is none to compare.
		if (scrollback > 0 && !term.isAlternateScreen()) {
			const length = term.getScrollbackLength();
			for (let offset = 0; offset < length; offset++) {
				history.push(
					theirCells(term.getScrollbackLine(offset) ?? [], (col) =>
						term.getScrollbackGraphemeString(offset, col),
					).map((cell) => cell.char).join("").trimEnd(),
				);
			}
		}
		const cursor = term.getCursor();
		const modes: Record<string, boolean> = {};
		for (const [name, number, ansi] of MODES) {
			modes[name] = term.getMode(number, ansi);
		}
		modes.alternateScreen = term.isAlternateScreen();
		return {
			rows: screen,
			history,
			cursor: `${Math.min(cursor.x, cols - 1)},${cursor.y}`,
			modes,
		};
	} finally {
		term.free();
	}
}

function show(value: unknown): string {
	return JSON.stringify(value);
}

function hex(value: number): string {
	return `#${value.toString(16).padStart(6, "0")}`;
}

/**
 * The ways the emulator's state after `data` differs from Ghostty's, one
 * line each, or none when they agree.
 */
export function compareWithGhostty(
	data: string | Uint8Array,
	{cols = 20, rows = 6, scrollback = 0}: {
		cols?: number;
		rows?: number;
		scrollback?: number;
	} = {},
): string[] {
	const ours = snapshotOurs(data, cols, rows, scrollback);
	const theirs = snapshotGhostty(data, cols, rows, scrollback);
	const differences: string[] = [];
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const a = ours.rows[y][x];
			const b = theirs.rows[y][x];
			for (const key of ["char", "width", "fg", "bg", "attrs"] as const) {
				if (a[key] !== b[key]) {
					const [mine, other] = key === "fg" || key === "bg"
						? [hex(a[key]), hex(b[key])]
						: [show(a[key]), show(b[key])];
					differences.push(
						`cell ${x},${y} ${key}: ours ${mine}, ghostty ${other}`,
					);
				}
			}
		}
	}
	if (show(ours.history) !== show(theirs.history)) {
		differences.push(
			`history: ours ${show(ours.history)}, ghostty ${show(theirs.history)}`,
		);
	}
	if (ours.cursor !== theirs.cursor) {
		differences.push(`cursor: ours ${ours.cursor}, ghostty ${theirs.cursor}`);
	}
	for (const key of Object.keys(ours.modes)) {
		if (ours.modes[key] !== theirs.modes[key]) {
			differences.push(
				`${key}: ours ${ours.modes[key]}, ghostty ${theirs.modes[key]}`,
			);
		}
	}
	return differences;
}

const TYPES = readFileSync(
	new URL("../node_modules/ghostty-web/dist/index.d.ts", import.meta.url),
	"utf8",
);
const KEY_ENUM = TYPES.slice(
	TYPES.indexOf("export declare enum Key {"),
	TYPES.indexOf("\n}", TYPES.indexOf("export declare enum Key {")),
);
// ghostty-web's Key enum, which it declares and does not export.
const GHOSTTY_KEYS = new Map(
	[...KEY_ENUM.matchAll(/(\w+) = (\d+)/g)].map((match) => [
		match[1],
		Number(match[2]),
	]),
);

const DIGIT_NAMES = [
	"ZERO",
	"ONE",
	"TWO",
	"THREE",
	"FOUR",
	"FIVE",
	"SIX",
	"SEVEN",
	"EIGHT",
	"NINE",
];

// The US layout's keys, as Ghostty names them, for each character.
const PUNCTUATION_KEYS: Record<string, string> = {
	"`": "GRAVE",
	"~": "GRAVE",
	"-": "MINUS",
	_: "MINUS",
	"=": "EQUAL",
	"+": "EQUAL",
	"[": "BRACKET_LEFT",
	"{": "BRACKET_LEFT",
	"]": "BRACKET_RIGHT",
	"}": "BRACKET_RIGHT",
	"\\": "BACKSLASH",
	"|": "BACKSLASH",
	";": "SEMICOLON",
	":": "SEMICOLON",
	"'": "QUOTE",
	'"': "QUOTE",
	",": "COMMA",
	"<": "COMMA",
	".": "PERIOD",
	">": "PERIOD",
	"/": "SLASH",
	"?": "SLASH",
	" ": "SPACE",
	"!": "ONE",
	"@": "TWO",
	"#": "THREE",
	$: "FOUR",
	"%": "FIVE",
	"^": "SIX",
	"&": "SEVEN",
	"*": "EIGHT",
	"(": "NINE",
	")": "ZERO",
};

const NAMED_KEYS: Record<string, string> = {
	ArrowUp: "UP",
	ArrowDown: "DOWN",
	ArrowLeft: "LEFT",
	ArrowRight: "RIGHT",
	PageUp: "PAGE_UP",
	PageDown: "PAGE_DOWN",
};

function ghosttyKeyName(key: string): string {
	if (/^[a-z]$/i.test(key)) {
		return key.toUpperCase();
	}
	if (/^\d$/.test(key)) {
		return DIGIT_NAMES[Number(key)];
	}
	return PUNCTUATION_KEYS[key] ?? NAMED_KEYS[key] ?? key.toUpperCase();
}

export interface OracleKey {
	key: string;
	base: string;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	metaKey: boolean;
}

/**
 * The bytes Ghostty's key encoder sends for `key`, pressed, repeated or
 * released, under the kitty keyboard protocol's `flags`. `base` is the
 * character the key writes without Shift.
 */
export function encodeWithGhostty(
	key: OracleKey,
	{flags = 0, applicationCursor = false, action = "press"}: {
		flags?: number;
		applicationCursor?: boolean;
		action?: "press" | "repeat" | "release";
	} = {},
): string {
	const name = ghosttyKeyName(key.key);
	const physical = GHOSTTY_KEYS.get(name);
	if (physical === undefined) {
		throw new Error(`Ghostty has no key ${name}`);
	}
	const instance = new WebAssembly.Instance(MODULE, {env: {log() {}}});
	const encoder = new Ghostty(instance).createKeyEncoder();
	// ghostty-web's encode() drops the unshifted character and the
	// modifiers the character took, so the event is built here.
	const exports = instance.exports as unknown as GhosttyKeyExports;
	const handle = (encoder as unknown as {encoder: number}).encoder;
	const slot = exports.ghostty_wasm_alloc_opaque();
	exports.ghostty_key_event_new(0, slot);
	const event = new DataView(exports.memory.buffer).getUint32(slot, true);
	exports.ghostty_wasm_free_opaque(slot);
	try {
		encoder.setOption(0, applicationCursor);
		encoder.setOption(3, true);
		encoder.setOption(5, flags);
		const printable = [...key.key].length === 1;
		exports.ghostty_key_event_set_action(
			event,
			action === "release" ? 0 : action === "press" ? 1 : 2,
		);
		exports.ghostty_key_event_set_key(event, physical);
		exports.ghostty_key_event_set_mods(
			event,
			(key.shiftKey ? 1 : 0) |
			(key.ctrlKey ? 2 : 0) |
				(key.altKey ? 4 : 0) |
			(key.metaKey ? 8 : 0),
		);
		exports.ghostty_key_event_set_consumed_mods(
			event,
			printable && key.shiftKey && key.key !== key.base ? 1 : 0,
		);
		exports.ghostty_key_event_set_unshifted_codepoint(
			event,
			printable ? key.base.codePointAt(0)! : 0,
		);
		// The character the layout makes, Shift applied and Ctrl not, as
		// Ghostty's own apps pass it.
		if (printable) {
			const text = new TextEncoder().encode(key.key);
			const pointer = exports.ghostty_wasm_alloc_u8_array(text.length);
			new Uint8Array(exports.memory.buffer).set(text, pointer);
			exports.ghostty_key_event_set_utf8(event, pointer, text.length);
			exports.ghostty_wasm_free_u8_array(pointer, text.length);
		}
		const size = 128;
		const output = exports.ghostty_wasm_alloc_u8_array(size);
		const written = exports.ghostty_wasm_alloc_usize();
		const status = exports.ghostty_key_encoder_encode(
			handle,
			event,
			output,
			size,
			written,
		);
		const length = new DataView(exports.memory.buffer).getUint32(written, true);
		const bytes = new Uint8Array(exports.memory.buffer, output, length)
			.slice();
		exports.ghostty_wasm_free_u8_array(output, size);
		exports.ghostty_wasm_free_usize(written);
		if (status !== 0) {
			throw new Error(`Ghostty could not encode ${key.key}: ${status}`);
		}
		return new TextDecoder().decode(bytes);
	} finally {
		exports.ghostty_key_event_free(event);
		encoder.dispose();
	}
}

interface GhosttyKeyExports {
	memory: WebAssembly.Memory;
	ghostty_wasm_alloc_opaque(): number;
	ghostty_wasm_free_opaque(pointer: number): void;
	ghostty_wasm_alloc_u8_array(length: number): number;
	ghostty_wasm_free_u8_array(pointer: number, length: number): void;
	ghostty_wasm_alloc_usize(): number;
	ghostty_wasm_free_usize(pointer: number): void;
	ghostty_key_event_new(allocator: number, out: number): number;
	ghostty_key_event_free(event: number): void;
	ghostty_key_event_set_action(event: number, action: number): void;
	ghostty_key_event_set_key(event: number, key: number): void;
	ghostty_key_event_set_mods(event: number, mods: number): void;
	ghostty_key_event_set_consumed_mods(event: number, mods: number): void;
	ghostty_key_event_set_unshifted_codepoint(
		event: number,
		codepoint: number,
	): void;
	ghostty_key_event_set_utf8(
		event: number,
		pointer: number,
		length: number,
	): void;
	ghostty_key_encoder_encode(
		encoder: number,
		event: number,
		output: number,
		size: number,
		written: number,
	): number;
}
