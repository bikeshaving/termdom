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
