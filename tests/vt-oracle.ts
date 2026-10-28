/**
 * xterm.js as the standard for the pty embed's emulator: the same bytes
 * go to both, and every cell, color, attribute, mode, the cursor, the
 * title and the replies are compared.
 */
import xtermPkg from "@xterm/headless";

import {
	BLINK,
	BOLD,
	DEFAULT_COLOR,
	DIM,
	DOUBLE_UNDERLINE,
	INVERSE,
	INVISIBLE,
	ITALIC,
	OVERLINE,
	RGB_COLOR,
	STRIKETHROUGH,
	Terminal,
	UNDERLINE,
} from "../src/internal/vt.ts";
import {TABLE_UNICODE_VERSION} from "./test-utils.ts";

const {Terminal: XTerm} = xtermPkg;

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
	modes: Record<string, string | number | boolean>;
	title: string;
	replies: string;
}

const ATTRIBUTES: Array<[number, string]> = [
	[BOLD, "bold"],
	[DIM, "dim"],
	[ITALIC, "italic"],
	[UNDERLINE | DOUBLE_UNDERLINE, "underline"],
	[BLINK, "blink"],
	[INVERSE, "inverse"],
	[INVISIBLE, "invisible"],
	[STRIKETHROUGH, "strikethrough"],
	[OVERLINE, "overline"],
];

const MOUSE_MODES: Record<number, string> = {
	0: "none",
	9: "x10",
	1000: "vt200",
	1002: "drag",
	1003: "any",
};

function snapshotOurs(
	data: string | Uint8Array,
	cols: number,
	rows: number,
	scrollback: number,
): Snapshot {
	const replies: string[] = [];
	const term = new Terminal(cols, rows, (reply) => replies.push(reply));
	term.setHistoryLimit(scrollback);
	term.write(data);
	const toCells = (line: Terminal["lines"][number]) =>
		line.chars.map((char, col) => ({
			char: line.widths[col] === 0 ? "" : char || " ",
			width: line.widths[col],
			fg: line.fg[col],
			bg: line.bg[col],
			attrs: ATTRIBUTES.filter(([bit]) => (line.attrs[col] & bit) !== 0)
				.map(([, name]) => name)
				.join(" "),
		}));
	return {
		rows: term.lines.map(toCells),
		history: term.history.map((line) =>
			toCells(line).map((cell) => cell.char).join("").trimEnd(),
		),
		cursor: `${Math.min(term.x, cols - 1)},${term.y}`,
		modes: {
			alternateScreen: term.alternateScreen,
			applicationCursor: term.applicationCursor,
			bracketedPaste: term.bracketedPaste,
			focusReporting: term.focusReporting,
			insertMode: term.insertMode,
			mouseTracking: MOUSE_MODES[term.mouseTracking] ?? term.mouseTracking,
			originMode: term.originMode,
			autowrap: term.autowrap,
			cursorVisible: term.cursorVisible,
		},
		title: term.title,
		replies: replies.join(""),
	};
}

function toColor(
	mode: {isRGB: boolean; isPalette: boolean; isDefault: boolean},
	color: number,
): number {
	if (mode.isDefault) {
		return DEFAULT_COLOR;
	}
	return mode.isRGB ? RGB_COLOR | color : color;
}

async function snapshotXterm(
	data: string | Uint8Array,
	cols: number,
	rows: number,
	scrollback: number,
): Promise<Snapshot> {
	const xterm = new XTerm({
		cols,
		rows,
		scrollback,
		// eslint-disable-next-line acrocase/acrocase -- xterm's own option name
		allowProposedApi: true,
	});
	xterm.unicode.register(TABLE_UNICODE_VERSION);
	xterm.unicode.activeVersion = TABLE_UNICODE_VERSION.version;
	let title = "";
	const replies: string[] = [];
	xterm.onTitleChange((value) => {
		title = value;
	});
	xterm.onData((reply) => replies.push(reply));
	await new Promise<void>((resolve) => xterm.write(data, resolve));
	const buffer = xterm.buffer.active;
	const cell = buffer.getNullCell();
	const toCells = (y: number): Cell[] => {
		const line = buffer.getLine(y)!;
		const cells: Cell[] = [];
		for (let x = 0; x < cols; x++) {
			line.getCell(x, cell);
			const attrs: string[] = [];
			if (cell.isBold()) attrs.push("bold");
			if (cell.isDim()) attrs.push("dim");
			if (cell.isItalic()) attrs.push("italic");
			if (cell.isUnderline()) attrs.push("underline");
			if (cell.isBlink()) attrs.push("blink");
			if (cell.isInverse()) attrs.push("inverse");
			if (cell.isInvisible()) attrs.push("invisible");
			if (cell.isStrikethrough()) attrs.push("strikethrough");
			if (cell.isOverline()) attrs.push("overline");
			cells.push({
				char: cell.getWidth() === 0 ? "" : cell.getChars() || " ",
				width: cell.getWidth(),
				fg: toColor({
					isRGB: cell.isFgRGB(),
					isPalette: cell.isFgPalette(),
					isDefault: cell.isFgDefault(),
				}, cell.getFgColor()),
				bg: toColor({
					isRGB: cell.isBgRGB(),
					isPalette: cell.isBgPalette(),
					isDefault: cell.isBgDefault(),
				}, cell.getBgColor()),
				attrs: attrs.join(" "),
			});
		}
		return cells;
	};
	const screen: Cell[][] = [];
	for (let y = 0; y < rows; y++) {
		screen.push(toCells(buffer.baseY + y));
	}
	const history: string[] = [];
	if (buffer.type === "normal") {
		for (let y = 0; y < buffer.baseY; y++) {
			history.push(toCells(y).map((each) => each.char).join("").trimEnd());
		}
	}
	const core = (xterm as unknown as {
		_core: {coreService: {isCursorHidden: boolean}};
	})._core;
	const modes = xterm.modes;
	const snapshot: Snapshot = {
		rows: screen,
		history,
		cursor: `${Math.min(buffer.cursorX, cols - 1)},${buffer.cursorY}`,
		modes: {
			alternateScreen: buffer.type === "alternate",
			applicationCursor: modes.applicationCursorKeysMode,
			bracketedPaste: modes.bracketedPasteMode,
			focusReporting: modes.sendFocusMode,
			insertMode: modes.insertMode,
			mouseTracking: modes.mouseTrackingMode,
			originMode: modes.originMode,
			autowrap: modes.wraparoundMode,
			cursorVisible: !core.coreService.isCursorHidden,
		},
		title,
		replies: replies.join(""),
	};
	xterm.dispose();
	return snapshot;
}

function show(value: unknown): string {
	return JSON.stringify(value);
}

// xterm.js answers a DECRQSS for the SGR with 0m whatever is set, as
// its source admits. The emulator reports the real attributes, which is
// how nvim learns it can use 24-bit color.
const SGR_REPORT = /\x1bP1\$r[\d;:]*m\x1b\\/g;

/**
 * The ways the emulator's state after `data` differs from xterm.js's,
 * one line each, or none when they agree. With `sgrReports: "ignore"`,
 * answers to a DECRQSS for the SGR are left out of the replies.
 */
export async function compareWithXterm(
	data: string | Uint8Array,
	{cols = 20, rows = 6, scrollback = 0, sgrReports = "compare"}: {
		cols?: number;
		rows?: number;
		scrollback?: number;
		sgrReports?: "compare" | "ignore";
	} = {},
): Promise<string[]> {
	const ours = snapshotOurs(data, cols, rows, scrollback);
	const theirs = await snapshotXterm(data, cols, rows, scrollback);
	if (sgrReports === "ignore") {
		ours.replies = ours.replies.replace(SGR_REPORT, "");
		theirs.replies = theirs.replies.replace(SGR_REPORT, "");
	}
	const differences: string[] = [];
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const a = ours.rows[y][x];
			const b = theirs.rows[y][x];
			for (const key of ["char", "width", "fg", "bg", "attrs"] as const) {
				if (a[key] !== b[key]) {
					differences.push(
						`cell ${x},${y} ${key}: ours ${show(a[key])}, xterm ${show(b[key])}`,
					);
				}
			}
		}
	}
	if (show(ours.history) !== show(theirs.history)) {
		differences.push(
			`history: ours ${show(ours.history)}, xterm ${show(theirs.history)}`,
		);
	}
	if (ours.cursor !== theirs.cursor) {
		differences.push(`cursor: ours ${ours.cursor}, xterm ${theirs.cursor}`);
	}
	for (const key of Object.keys(ours.modes)) {
		if (ours.modes[key] !== theirs.modes[key]) {
			differences.push(
				`${key}: ours ${show(ours.modes[key])}, xterm ${show(theirs.modes[key])}`,
			);
		}
	}
	if (ours.title !== theirs.title) {
		differences.push(
			`title: ours ${show(ours.title)}, xterm ${show(theirs.title)}`,
		);
	}
	if (ours.replies !== theirs.replies) {
		differences.push(
			`replies: ours ${show(ours.replies)}, xterm ${show(theirs.replies)}`,
		);
	}
	return differences;
}
