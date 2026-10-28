/**
 * The terminal a program in <embed type="application/x-pty"> writes to.
 * It reads the program's output, escape sequences and all, and keeps the
 * screen the program expects, as xterm would show it. The parser is the
 * DEC state machine (vt100.net/emu/dec_ansi_parser), and the sequences
 * are the ones xterm documents in ctlseqs that full-screen programs use.
 */

import {getStringWidth} from "./text.ts";

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const BLINK = 16;
export const INVERSE = 32;
export const INVISIBLE = 64;
export const STRIKETHROUGH = 128;
export const OVERLINE = 256;
export const DOUBLE_UNDERLINE = 512;

// A color is DEFAULT_COLOR, an index into the 256 colors, or RGB_COLOR
// with the red, green and blue bytes below it. Keeping the index lets
// the 16 basic colors follow the outer terminal's palette later.
export const DEFAULT_COLOR = -1;
export const RGB_COLOR = 0x1000000;

const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTERMEDIATE = 5;
const CSI_IGNORE = 6;
const OSC_STRING = 7;
const IGNORED_STRING = 8;
const DCS_STRING = 9;

const MAX_PARAMS = 32;
const MAX_SUBPARAMS = 8;
const MAX_OSC = 4096;
const MAX_DCS = 64;

// The DEC special graphics set, for line drawing, from _ to ~.
const DEC_GRAPHICS =
	" ◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·";

/** One row of the screen. A wide character takes two cells, the second with width 0. */
export class Line {
	chars: string[];
	widths: Uint8Array;
	fg: Int32Array;
	bg: Int32Array;
	attrs: Uint16Array;

	constructor(cols: number, bg: number) {
		this.chars = new Array<string>(cols).fill("");
		this.widths = new Uint8Array(cols).fill(1);
		this.fg = new Int32Array(cols).fill(DEFAULT_COLOR);
		this.bg = new Int32Array(cols).fill(bg);
		this.attrs = new Uint16Array(cols);
	}

	get cols(): number {
		return this.chars.length;
	}
}

function eraseCells(line: Line, start: number, end: number, bg: number): void {
	start = Math.max(0, start);
	end = Math.min(line.cols, end);
	if (start >= end) {
		return;
	}
	if (start > 0 && line.widths[start] === 0) {
		start--;
	}
	if (end < line.cols && line.widths[end] === 0) {
		end++;
	}
	line.chars.fill("", start, end);
	line.widths.fill(1, start, end);
	line.fg.fill(DEFAULT_COLOR, start, end);
	line.bg.fill(bg, start, end);
	line.attrs.fill(0, start, end);
}

// After cells shift, a wide character can lose either half. The half
// left behind becomes a blank in the given colors and attributes.
function repairWide(line: Line, fg: number, bg: number, attrs: number): void {
	const {widths, chars} = line;
	for (let col = 0; col < line.cols; col++) {
		const broken = widths[col] === 2
			? col + 1 >= line.cols || widths[col + 1] !== 0
			: widths[col] === 0 && (col === 0 || widths[col - 1] !== 2);
		if (broken) {
			widths[col] = 1;
			chars[col] = "";
			line.fg[col] = fg;
			line.bg[col] = bg;
			line.attrs[col] = attrs;
		}
	}
}

function shiftCells(line: Line, from: number, to: number, count: number): void {
	line.chars.copyWithin(to, from, from + count);
	line.widths.copyWithin(to, from, from + count);
	line.fg.copyWithin(to, from, from + count);
	line.bg.copyWithin(to, from, from + count);
	line.attrs.copyWithin(to, from, from + count);
}

function resizeLine(line: Line, cols: number): Line {
	const resized = new Line(cols, DEFAULT_COLOR);
	const count = Math.min(cols, line.cols);
	for (let col = 0; col < count; col++) {
		resized.chars[col] = line.chars[col];
	}
	resized.widths.set(line.widths.subarray(0, count));
	resized.fg.set(line.fg.subarray(0, count));
	resized.bg.set(line.bg.subarray(0, count));
	resized.attrs.set(line.attrs.subarray(0, count));
	repairWide(resized, DEFAULT_COLOR, DEFAULT_COLOR, 0);
	return resized;
}

interface SavedCursor {
	x: number;
	y: number;
	fg: number;
	bg: number;
	attrs: number;
	originMode: boolean;
	charsets: string[];
	shift: number;
}

interface ScreenBuffer {
	lines: Line[];
	saved: SavedCursor | null;
}

function createBuffer(cols: number, rows: number): ScreenBuffer {
	return {
		lines: Array.from({length: rows}, () => new Line(cols, DEFAULT_COLOR)),
		saved: null,
	};
}

function defaultTabStops(cols: number): boolean[] {
	return Array.from({length: cols}, (_value, col) => col > 0 && col % 8 === 0);
}

/**
 * A terminal's screen and modes, changed by what the program writes.
 * Answers to the program's questions, such as where the cursor is, go to
 * `reply`. Lines that scroll off the top of the normal screen go into
 * `history`, up to `historyLimit` of them.
 */
export class Terminal {
	cols: number;
	rows: number;
	x: number;
	y: number;
	// Set after a character lands in the last column: the next one wraps
	// first, so a program can fill the last column without scrolling.
	wrapPending: boolean;
	fg: number;
	bg: number;
	attrs: number;
	scrollTop: number;
	scrollBottom: number;
	normal: ScreenBuffer;
	alternate: ScreenBuffer;
	buffer: ScreenBuffer;
	history: Line[];
	historyLimit: number;
	// Every line that ever went into history, so a view of it can stay put.
	historyAdded: number;
	tabStops: boolean[];
	charsets: string[];
	shift: number;

	applicationCursor: boolean;
	applicationKeypad: boolean;
	originMode: boolean;
	autowrap: boolean;
	cursorVisible: boolean;
	// DECSCUSR's shape: 0 for the terminal's own, 1 to 6 for a blinking or
	// steady block, underline or bar.
	cursorShape: number;
	// The window title the program set with OSC 0 or 2.
	title: string;
	// How many times the program rang the bell.
	bells: number;
	insertMode: boolean;
	newlineMode: boolean;
	bracketedPaste: boolean;
	focusReporting: boolean;
	synchronizedOutput: boolean;
	// Whether an OSC 8 link is open, which underlines what is printed.
	link: boolean;
	// The character printed last, which a mark, a joiner or a selector
	// after it joins, and REP repeats. Anything but printing forgets it.
	preceding: {col: number; width: number; joining: boolean} | null;
	// 0 for none, or the DECSET number that turned it on: 9, 1000, 1002 or
	// 1003.
	mouseTracking: number;
	// 0 for the default encoding, or 1005, 1006 or 1015.
	mouseEncoding: number;

	reply: (data: string) => void;

	state: number;
	params: number[][];
	prefix: string;
	intermediates: string;
	osc: string;
	dcs: string;
	highSurrogate: number;
	decoder: TextDecoder;

	constructor(cols: number, rows: number, reply: (data: string) => void) {
		this.cols = Math.max(1, cols);
		this.rows = Math.max(1, rows);
		this.reply = reply;
		this.decoder = new TextDecoder();
		this.normal = createBuffer(this.cols, this.rows);
		this.alternate = createBuffer(this.cols, this.rows);
		this.buffer = this.normal;
		this.history = [];
		this.historyLimit = 0;
		this.historyAdded = 0;
		this.x = 0;
		this.y = 0;
		this.wrapPending = false;
		this.fg = DEFAULT_COLOR;
		this.bg = DEFAULT_COLOR;
		this.attrs = 0;
		this.scrollTop = 0;
		this.scrollBottom = this.rows - 1;
		this.tabStops = defaultTabStops(this.cols);
		this.charsets = ["B", "B", "B", "B"];
		this.shift = 0;
		this.applicationCursor = false;
		this.applicationKeypad = false;
		this.originMode = false;
		this.autowrap = true;
		this.cursorVisible = true;
		this.cursorShape = 0;
		this.title = "";
		this.bells = 0;
		this.insertMode = false;
		this.newlineMode = false;
		this.bracketedPaste = false;
		this.focusReporting = false;
		this.synchronizedOutput = false;
		this.link = false;
		this.preceding = null;
		this.mouseTracking = 0;
		this.mouseEncoding = 0;
		this.state = GROUND;
		this.params = [[0]];
		this.prefix = "";
		this.intermediates = "";
		this.osc = "";
		this.dcs = "";
		this.highSurrogate = 0;
	}

	get lines(): Line[] {
		return this.buffer.lines;
	}

	get alternateScreen(): boolean {
		return this.buffer === this.alternate;
	}

	setHistoryLimit(limit: number): void {
		this.historyLimit = Math.max(0, limit);
		this.trimHistory();
	}

	keepHistory(lines: Line[]): void {
		if (this.historyLimit === 0) {
			return;
		}
		this.history.push(...lines);
		this.historyAdded += lines.length;
		this.trimHistory();
	}

	trimHistory(): void {
		const excess = this.history.length - this.historyLimit;
		if (excess > 0) {
			this.history.splice(0, excess);
		}
	}

	write(data: Uint8Array | string): void {
		const text = typeof data === "string"
			? data
			: this.decoder.decode(data, {stream: true});
		for (let index = 0; index < text.length; index++) {
			let code = text.charCodeAt(index);
			if (this.highSurrogate !== 0) {
				if (code >= 0xdc00 && code <= 0xdfff) {
					code =
						((this.highSurrogate - 0xd800) << 10) + (code - 0xdc00) + 0x10000;
				} else {
					this.consume(0xfffd);
				}
				this.highSurrogate = 0;
			} else if (code >= 0xd800 && code <= 0xdbff) {
				this.highSurrogate = code;
				continue;
			}
			this.consume(code);
		}
	}

	resize(cols: number, rows: number): void {
		cols = Math.max(1, cols);
		rows = Math.max(1, rows);
		if (cols === this.cols && rows === this.rows) {
			return;
		}
		for (const buffer of [this.normal, this.alternate]) {
			let lines = buffer.lines.map((line) =>
				line.cols === cols ? line : resizeLine(line, cols),
			);
			const active = buffer === this.buffer;
			if (lines.length > rows) {
				// Rows below the cursor go first, then rows off the top, so
				// the cursor's row stays on screen.
				let excess = lines.length - rows;
				const cursor = active
					? this.y
					: buffer === this.normal ? (buffer.saved?.y ?? this.y) : null;
				const below = cursor === null ? excess : lines.length - 1 - cursor;
				const fromBottom = Math.min(excess, Math.max(0, below));
				lines = lines.slice(0, lines.length - fromBottom);
				excess -= fromBottom;
				if (buffer === this.normal) {
					this.keepHistory(lines.slice(0, excess));
				}
				lines = lines.slice(excess);
				if (active) {
					this.y -= excess;
				}
				if (buffer.saved !== null) {
					buffer.saved.y = Math.max(0, buffer.saved.y - excess);
				}
			}
			while (lines.length < rows) {
				lines.push(new Line(cols, DEFAULT_COLOR));
			}
			buffer.lines = lines;
			if (buffer.saved !== null) {
				buffer.saved.x = Math.min(buffer.saved.x, cols - 1);
				buffer.saved.y = Math.min(buffer.saved.y, rows - 1);
			}
		}
		const stops = defaultTabStops(cols);
		for (let col = 0; col < Math.min(cols, this.cols); col++) {
			stops[col] = this.tabStops[col];
		}
		this.tabStops = stops;
		this.cols = cols;
		this.rows = rows;
		this.scrollTop = 0;
		this.scrollBottom = rows - 1;
		this.x = Math.min(this.x, cols - 1);
		this.y = Math.max(0, Math.min(this.y, rows - 1));
		this.wrapPending = false;
	}

	consume(code: number): void {
		if (
			this.state === GROUND &&
			(code >= 0x20 && code !== 0x7f) &&
			(code < 0x80 || code >= 0xa0)
		) {
			this.print(code);
			return;
		}
		if (code === 0x18 || code === 0x1a) {
			this.preceding = null;
			this.state = GROUND;
			return;
		}
		if (code === 0x1b || code === 0x9c) {
			this.endString();
			this.state = code === 0x1b ? ESCAPE : GROUND;
			this.intermediates = "";
			return;
		}
		if (code >= 0x80 && code < 0xa0) {
			this.consumeC1(code);
			return;
		}
		switch (this.state) {
			case GROUND:
				if (code < 0x20) {
					this.execute(code);
				}
				return;
			case ESCAPE:
				if (code < 0x20) {
					this.execute(code);
				} else if (code < 0x30) {
					this.intermediates += String.fromCharCode(code);
					this.state = ESCAPE_INTERMEDIATE;
				} else if (code === 0x5b) {
					this.params = [[0]];
					this.prefix = "";
					this.intermediates = "";
					this.state = CSI_ENTRY;
				} else if (code === 0x5d) {
					this.osc = "";
					this.state = OSC_STRING;
				} else if (code === 0x50) {
					this.dcs = "";
					this.state = DCS_STRING;
				} else if (code === 0x58 || code === 0x5e || code === 0x5f) {
					this.state = IGNORED_STRING;
				} else {
					this.state = GROUND;
					this.dispatchEscape(String.fromCharCode(code));
				}
				return;
			case ESCAPE_INTERMEDIATE:
				if (code < 0x20) {
					this.execute(code);
				} else if (code < 0x30) {
					this.intermediates += String.fromCharCode(code);
				} else if (code < 0x7f) {
					this.state = GROUND;
					this.dispatchEscape(String.fromCharCode(code));
				}
				return;
			case CSI_ENTRY:
			case CSI_PARAM:
				if (code < 0x20) {
					this.execute(code);
				} else if (code >= 0x30 && code <= 0x39) {
					const param = this.params[this.params.length - 1];
					const last = param.length - 1;
					param[last] = Math.min(param[last] * 10 + code - 0x30, 0xffff);
					this.state = CSI_PARAM;
				} else if (code === 0x3b) {
					if (this.params.length < MAX_PARAMS) {
						this.params.push([0]);
					}
					this.state = CSI_PARAM;
				} else if (code === 0x3a) {
					const param = this.params[this.params.length - 1];
					if (param.length < MAX_SUBPARAMS) {
						param.push(0);
					}
					this.state = CSI_PARAM;
				} else if (code >= 0x3c && code <= 0x3f) {
					if (this.state === CSI_ENTRY) {
						this.prefix = String.fromCharCode(code);
						this.state = CSI_PARAM;
					} else {
						this.state = CSI_IGNORE;
					}
				} else if (code >= 0x20 && code < 0x30) {
					this.intermediates += String.fromCharCode(code);
					this.state = CSI_INTERMEDIATE;
				} else if (code >= 0x40 && code < 0x7f) {
					this.state = GROUND;
					this.dispatchCSI(String.fromCharCode(code));
				}
				return;
			case CSI_INTERMEDIATE:
				if (code < 0x20) {
					this.execute(code);
				} else if (code < 0x30) {
					this.intermediates += String.fromCharCode(code);
				} else if (code < 0x40) {
					this.state = CSI_IGNORE;
				} else if (code < 0x7f) {
					this.state = GROUND;
					this.dispatchCSI(String.fromCharCode(code));
				}
				return;
			case CSI_IGNORE:
				if (code < 0x20) {
					this.execute(code);
				} else if (code >= 0x40 && code < 0x7f) {
					this.state = GROUND;
				}
				return;
			case OSC_STRING:
				if (code === 0x07) {
					this.dispatchOSC();
					this.preceding = null;
					this.state = GROUND;
				} else if (code >= 0x20 && this.osc.length < MAX_OSC) {
					this.osc += String.fromCodePoint(code);
				}
				return;
			case IGNORED_STRING:
				if (code === 0x07) {
					this.state = GROUND;
				}
				return;
			case DCS_STRING:
				if (this.dcs.length < MAX_DCS) {
					this.dcs += String.fromCodePoint(code);
				}
				return;
		}
	}

	// ESC or ST ends a string, and an OSC or a DCS takes effect.
	endString(): void {
		if (this.state === OSC_STRING) {
			this.dispatchOSC();
			this.preceding = null;
		} else if (this.state === DCS_STRING) {
			this.dispatchDCS();
			this.preceding = null;
		}
	}

	// The 8-bit controls, as xterm reads them: CSI, OSC and DCS start
	// their sequences, and IND, NEL and HTS act as their ESC forms do.
	consumeC1(code: number): void {
		switch (code) {
			case 0x9b:
				this.params = [[0]];
				this.prefix = "";
				this.intermediates = "";
				this.state = CSI_ENTRY;
				return;
			case 0x9d:
				this.osc = "";
				this.state = OSC_STRING;
				return;
			case 0x90:
				this.dcs = "";
				this.state = DCS_STRING;
				return;
			case 0x98:
			case 0x9e:
			case 0x9f:
				this.state = IGNORED_STRING;
				return;
		}
		this.state = GROUND;
		this.preceding = null;
		if (code === 0x84) {
			this.lineFeed();
		} else if (code === 0x85) {
			this.x = 0;
			this.lineFeed();
		} else if (code === 0x88) {
			this.tabStops[this.x] = true;
		}
	}

	execute(code: number): void {
		this.runControl(code);
		this.preceding = null;
	}

	runControl(code: number): void {
		switch (code) {
			case 0x07:
				this.bells++;
				return;
			case 0x08:
				this.wrapPending = false;
				if (this.x > 0) {
					this.x--;
				}
				return;
			case 0x09:
				this.tab(1);
				return;
			case 0x0a:
			case 0x0b:
			case 0x0c:
				if (this.newlineMode) {
					this.x = 0;
				}
				this.lineFeed();
				return;
			case 0x0d:
				this.x = 0;
				this.wrapPending = false;
				return;
			case 0x0e:
				this.shift = 1;
				return;
			case 0x0f:
				this.shift = 0;
				return;
		}
	}

	print(code: number): void {
		let char = String.fromCodePoint(code);
		let width = 1;
		if (code >= 0x5f && code <= 0x7e && this.charsets[this.shift] === "0") {
			char = DEC_GRAPHICS[code - 0x5f];
		} else if (code >= 0x7f) {
			width = Math.min(getStringWidth(char), 2);
		}
		const preceding = this.preceding;
		if (preceding !== null) {
			const joined = joinedWidth(code, width, preceding);
			if (joined !== null) {
				this.join(char, joined, code === 0x200d);
				return;
			}
		}
		if (width === 0) {
			this.combine(char);
			return;
		}
		if (this.wrapPending) {
			this.wrapPending = false;
			if (this.autowrap) {
				this.x = 0;
				this.lineFeed();
			}
		}
		if (width === 2 && this.x === this.cols - 1) {
			if (!this.autowrap || this.cols < 2) {
				this.preceding = null;
				return;
			}
			this.fillBlank(this.lines[this.y], this.x, this.x + 1);
			this.x = 0;
			this.lineFeed();
		}
		const line = this.lines[this.y];
		if (this.insertMode) {
			const count = this.cols - this.x - width;
			if (count > 0) {
				shiftCells(line, this.x, this.x + width, count);
			}
		}
		if (this.x > 0 && line.widths[this.x - 1] === 2) {
			this.fillBlank(line, this.x - 1, this.x);
		}
		const attrs = this.printedAttrs();
		line.chars[this.x] = char;
		line.widths[this.x] = width;
		line.fg[this.x] = this.fg;
		line.bg[this.x] = this.bg;
		line.attrs[this.x] = attrs;
		if (width === 2) {
			line.chars[this.x + 1] = "";
			line.widths[this.x + 1] = 0;
			line.fg[this.x + 1] = this.fg;
			line.bg[this.x + 1] = this.bg;
			line.attrs[this.x + 1] = attrs;
		}
		if (this.insertMode) {
			repairWide(line, this.fg, this.bg, attrs);
		}
		this.preceding = {col: this.x, width, joining: false};
		this.advance(width);
	}

	// What a printed cell takes: the SGR attributes, underlined in a link.
	printedAttrs(): number {
		return this.link ? this.attrs | UNDERLINE : this.attrs;
	}

	// Past the last column the cursor waits there, and the next character
	// wraps, or with autowrap off, writes over the last cell. An orphaned
	// second half of a wide character after the cursor becomes a blank.
	advance(width: number): void {
		this.x += width;
		if (this.x >= this.cols) {
			this.x = this.cols - 1;
			this.wrapPending = true;
			return;
		}
		const line = this.lines[this.y];
		if (line.widths[this.x] === 0) {
			this.fillBlank(line, this.x, this.x + 1);
		}
	}

	// Blank cells in the current colors and attributes, as xterm leaves
	// where a wide character did not fit or was cut.
	fillBlank(line: Line, start: number, end: number): void {
		line.chars.fill("", start, end);
		line.widths.fill(1, start, end);
		line.fg.fill(this.fg, start, end);
		line.bg.fill(this.bg, start, end);
		line.attrs.fill(this.printedAttrs(), start, end);
	}

	// Adds a character to the one printed before it, which grows to
	// `width` cells. One that no longer fits wraps to the next line.
	join(char: string, width: number, joining: boolean): void {
		const preceding = this.preceding!;
		let line = this.lines[this.y];
		let col = preceding.col;
		const grow = width - preceding.width;
		if (grow > 0 && col + width > this.cols) {
			if (!this.autowrap) {
				return;
			}
			const cluster = line.chars[col];
			const fg = line.fg[col];
			const bg = line.bg[col];
			const attrs = line.attrs[col];
			this.fillBlank(line, col, this.cols);
			this.wrapPending = false;
			this.x = 0;
			this.lineFeed();
			line = this.lines[this.y];
			col = 0;
			eraseCells(line, 0, preceding.width, this.bg);
			line.chars[0] = cluster;
			line.fg[0] = fg;
			line.bg[0] = bg;
			line.attrs[0] = attrs;
			this.x = preceding.width;
		}
		line.chars[col] += char;
		if (grow > 0) {
			line.widths[col] = width;
			const from = col + preceding.width;
			eraseCells(line, from, from + grow, this.bg);
			line.chars.fill("", from, from + grow);
			line.widths.fill(0, from, from + grow);
			line.fg.fill(this.fg, from, from + grow);
			line.bg.fill(this.bg, from, from + grow);
			line.attrs.fill(this.printedAttrs(), from, from + grow);
			this.wrapPending = false;
			this.x = col + preceding.width;
			this.preceding = {col, width, joining};
			this.advance(grow);
			return;
		}
		this.preceding = {col, width: preceding.width, joining};
	}

	// A mark, a variation selector, or a joiner and what follows it, joins
	// the cell before the cursor.
	combine(char: string): void {
		let col = this.wrapPending ? this.x : this.x - 1;
		const line = this.lines[this.y];
		if (col >= 0 && line.widths[col] === 0) {
			col--;
		}
		if (col < 0 || line.chars[col] === "") {
			return;
		}
		line.chars[col] += char;
	}

	lineFeed(): void {
		this.wrapPending = false;
		if (this.y === this.scrollBottom) {
			if (this.scrollTop === 0 && this.buffer === this.normal) {
				this.keepHistory([this.lines[0]]);
			}
			this.scrollUp(1);
		} else if (this.y < this.rows - 1) {
			this.y++;
		}
	}

	reverseIndex(): void {
		this.wrapPending = false;
		if (this.y === this.scrollTop) {
			this.scrollDown(1);
		} else if (this.y > 0) {
			this.y--;
		}
	}

	scrollUp(count: number, top = this.scrollTop): void {
		const lines = this.lines;
		const bottom = this.scrollBottom;
		count = Math.min(count, bottom - top + 1);
		lines.splice(top, count);
		for (let index = 0; index < count; index++) {
			lines.splice(bottom - count + 1 + index, 0, new Line(this.cols, this.bg));
		}
	}

	scrollDown(count: number, top = this.scrollTop): void {
		const lines = this.lines;
		const bottom = this.scrollBottom;
		count = Math.min(count, bottom - top + 1);
		lines.splice(bottom - count + 1, count);
		for (let index = 0; index < count; index++) {
			lines.splice(top, 0, new Line(this.cols, this.bg));
		}
	}

	tab(count: number): void {
		if (this.wrapPending) {
			return;
		}
		while (count > 0 && this.x < this.cols - 1) {
			this.x++;
			if (this.tabStops[this.x]) {
				count--;
			}
		}
	}

	backTab(count: number): void {
		if (this.wrapPending) {
			return;
		}
		while (count > 0 && this.x > 0) {
			this.x--;
			if (this.tabStops[this.x]) {
				count--;
			}
		}
	}

	moveTo(x: number, y: number): void {
		this.wrapPending = false;
		const top = this.originMode ? this.scrollTop : 0;
		const bottom = this.originMode ? this.scrollBottom : this.rows - 1;
		this.x = Math.max(0, Math.min(x, this.cols - 1));
		this.y = Math.max(top, Math.min(y + top, bottom));
	}

	// Up stops at the top margin and down at the bottom one, when the
	// cursor starts on the margin's side of them.
	moveVertically(delta: number): void {
		this.wrapPending = false;
		const top = this.y >= this.scrollTop ? this.scrollTop : 0;
		const bottom = this.y <= this.scrollBottom
			? this.scrollBottom
			: this.rows - 1;
		this.y = Math.max(top, Math.min(this.y + delta, bottom));
	}

	// VPR moves down past the margins, to the edge of the screen, or of
	// the region in origin mode.
	moveRelative(delta: number): void {
		this.wrapPending = false;
		const top = this.originMode ? this.scrollTop : 0;
		const bottom = this.originMode ? this.scrollBottom : this.rows - 1;
		this.y = Math.max(top, Math.min(this.y + delta, bottom));
	}

	saveCursor(): void {
		this.buffer.saved = {
			x: this.x,
			y: this.y,
			fg: this.fg,
			bg: this.bg,
			attrs: this.attrs,
			originMode: this.originMode,
			charsets: [...this.charsets],
			shift: this.shift,
		};
	}

	restoreCursor(): void {
		const saved = this.buffer.saved;
		this.wrapPending = false;
		if (saved === null) {
			this.x = 0;
			this.y = 0;
			this.fg = DEFAULT_COLOR;
			this.bg = DEFAULT_COLOR;
			this.attrs = 0;
			this.originMode = false;
			this.charsets = ["B", "B", "B", "B"];
			this.shift = 0;
			return;
		}
		this.x = Math.min(saved.x, this.cols - 1);
		this.y = Math.min(saved.y, this.rows - 1);
		this.fg = saved.fg;
		this.bg = saved.bg;
		this.attrs = saved.attrs;
		this.originMode = saved.originMode;
		this.charsets = [...saved.charsets];
		this.shift = saved.shift;
	}

	// Entering the alternate screen clears it in the current background,
	// as xterm.js does for all three modes.
	useAlternate(on: boolean): void {
		const target = on ? this.alternate : this.normal;
		if (target === this.buffer) {
			return;
		}
		this.buffer = target;
		if (on) {
			for (const line of this.alternate.lines) {
				eraseCells(line, 0, this.cols, this.bg);
			}
		}
		this.wrapPending = false;
	}

	softReset(): void {
		this.cursorVisible = true;
		this.originMode = false;
		this.autowrap = true;
		this.insertMode = false;
		this.applicationCursor = false;
		this.applicationKeypad = false;
		this.scrollTop = 0;
		this.scrollBottom = this.rows - 1;
		this.fg = DEFAULT_COLOR;
		this.bg = DEFAULT_COLOR;
		this.attrs = 0;
		this.charsets = ["B", "B", "B", "B"];
		this.shift = 0;
		this.normal.saved = null;
		this.alternate.saved = null;
		this.wrapPending = false;
		this.preceding = null;
	}

	fullReset(): void {
		this.softReset();
		this.normal = createBuffer(this.cols, this.rows);
		this.alternate = createBuffer(this.cols, this.rows);
		this.buffer = this.normal;
		this.tabStops = defaultTabStops(this.cols);
		this.newlineMode = false;
		this.bracketedPaste = false;
		this.focusReporting = false;
		this.synchronizedOutput = false;
		this.link = false;
		this.mouseTracking = 0;
		this.mouseEncoding = 0;
		this.cursorShape = 0;
		this.x = 0;
		this.y = 0;
	}

	dispatchEscape(final: string): void {
		this.runEscape(final);
		this.preceding = null;
	}

	runEscape(final: string): void {
		const intermediates = this.intermediates;
		if (intermediates === "") {
			switch (final) {
				case "7":
					this.saveCursor();
					return;
				case "8":
					this.restoreCursor();
					return;
				case "D":
					this.lineFeed();
					return;
				case "E":
					this.x = 0;
					this.lineFeed();
					return;
				case "M":
					this.reverseIndex();
					return;
				case "H":
					this.tabStops[this.x] = true;
					return;
				case "c":
					this.fullReset();
					return;
				case "=":
					this.applicationKeypad = true;
					return;
				case ">":
					this.applicationKeypad = false;
					return;
			}
			return;
		}
		const slot = "()*+".indexOf(intermediates);
		if (slot !== -1) {
			this.charsets[slot] = final;
			return;
		}
		if (intermediates === "#" && final === "8") {
			for (const line of this.lines) {
				eraseCells(line, 0, this.cols, DEFAULT_COLOR);
				line.chars.fill("E");
			}
			this.scrollTop = 0;
			this.scrollBottom = this.rows - 1;
			this.moveTo(0, 0);
		}
	}

	param(index: number, fallback: number): number {
		const value = this.params[index]?.[0] ?? 0;
		return value === 0 ? fallback : value;
	}

	dispatchCSI(final: string): void {
		this.runCSI(final);
		this.preceding = null;
	}

	runCSI(final: string): void {
		const {prefix, intermediates} = this;
		if (prefix === "?" && intermediates === "") {
			if (final === "h" || final === "l") {
				for (const [mode] of this.params) {
					this.setPrivateMode(mode, final === "h");
				}
			} else if (final === "J") {
				this.eraseDisplay(this.param(0, 0));
			} else if (final === "K") {
				this.eraseLine(this.param(0, 0));
			} else if (final === "n" && this.param(0, 0) === 6) {
				this.reply(`\x1b[?${this.reportedRow()};${this.x + 1}R`);
			}
			return;
		}
		if (
			intermediates === "$" &&
			final === "p" &&
			(prefix === "?" || prefix === "")
		) {
			const mode = this.param(0, 0);
			const state = prefix === "?"
				? this.privateModeState(mode)
				: this.ansiModeState(mode);
			this.reply(`\x1b[${prefix}${mode};${state}$y`);
			return;
		}
		if (prefix === ">") {
			if (final === "c") {
				this.reply("\x1b[>0;276;0c");
			}
			return;
		}
		if (prefix !== "") {
			return;
		}
		if (intermediates === "!" && final === "p") {
			this.softReset();
			return;
		}
		if (intermediates === " " && final === "q") {
			const shape = this.param(0, 0);
			this.cursorShape = shape <= 6 ? shape : 0;
			return;
		}
		if (intermediates !== "") {
			return;
		}
		const n = this.param(0, 1);
		switch (final) {
			case "@":
				this.insertChars(n);
				return;
			case "A":
				this.moveVertically(-n);
				return;
			case "B":
				this.moveVertically(n);
				return;
			case "e":
				this.moveRelative(n);
				return;
			case "C":
			case "a":
				this.wrapPending = false;
				this.x = Math.min(this.x + n, this.cols - 1);
				return;
			case "D":
				this.wrapPending = false;
				this.x = Math.max(this.x - n, 0);
				return;
			case "E":
				this.x = 0;
				this.moveVertically(n);
				return;
			case "F":
				this.x = 0;
				this.moveVertically(-n);
				return;
			case "G":
			case "`":
				this.wrapPending = false;
				this.x = Math.min(n - 1, this.cols - 1);
				return;
			case "H":
			case "f":
				this.moveTo(this.param(1, 1) - 1, n - 1);
				return;
			case "I":
				this.tab(n);
				return;
			case "J":
				this.eraseDisplay(this.param(0, 0));
				return;
			case "K":
				this.eraseLine(this.param(0, 0));
				return;
			case "L":
				this.insertLines(n);
				return;
			case "M":
				this.deleteLines(n);
				return;
			case "P":
				this.deleteChars(n);
				return;
			case "S":
				this.scrollUp(n);
				return;
			case "T":
				this.scrollDown(n);
				return;
			case "X":
				this.wrapPending = false;
				eraseCells(this.lines[this.y], this.x, this.x + n, this.bg);
				return;
			case "Z":
				this.backTab(n);
				return;
			case "b":
				this.repeat(n, this.preceding);
				return;
			case "c":
				if (this.param(0, 0) === 0) {
					this.reply("\x1b[?1;2c");
				}
				return;
			case "d":
				this.moveTo(this.x, n - 1);
				return;
			case "g":
				if (this.param(0, 0) === 0) {
					this.tabStops[this.x] = false;
				} else if (this.param(0, 0) === 3) {
					this.tabStops.fill(false);
				}
				return;
			case "h":
			case "l":
				for (const [mode] of this.params) {
					if (mode === 4) {
						this.insertMode = final === "h";
					} else if (mode === 20) {
						this.newlineMode = final === "h";
					}
				}
				return;
			case "m":
				this.setGraphics();
				return;
			case "n":
				if (this.param(0, 0) === 5) {
					this.reply("\x1b[0n");
				} else if (this.param(0, 0) === 6) {
					this.reply(`\x1b[${this.reportedRow()};${this.x + 1}R`);
				}
				return;
			case "r": {
				const top = n - 1;
				const bottom = Math.min(this.param(1, this.rows), this.rows) - 1;
				if (top < bottom) {
					this.scrollTop = top;
					this.scrollBottom = bottom;
					this.moveTo(0, 0);
				}
				return;
			}
			case "s":
				this.saveCursor();
				return;
			case "u":
				this.restoreCursor();
				return;
			case "t":
				if (this.param(0, 0) === 18) {
					this.reply(`\x1b[8;${this.rows};${this.cols}t`);
				}
				return;
		}
	}

	reportedRow(): number {
		return this.y + 1 - (this.originMode ? this.scrollTop : 0);
	}

	privateModeState(mode: number): number {
		const states: Record<number, boolean> = {
			1: this.applicationCursor,
			6: this.originMode,
			7: this.autowrap,
			25: this.cursorVisible,
			47: this.alternateScreen,
			1047: this.alternateScreen,
			1049: this.alternateScreen,
			2004: this.bracketedPaste,
			2026: this.synchronizedOutput,
			1004: this.focusReporting,
			1048: true,
			9: this.mouseTracking === 9,
			1000: this.mouseTracking === 1000,
			1002: this.mouseTracking === 1002,
			1003: this.mouseTracking === 1003,
			1005: this.mouseEncoding === 1005,
			1006: this.mouseEncoding === 1006,
			1015: this.mouseEncoding === 1015,
		};
		if (mode === 8) {
			return 3;
		}
		if (mode === 67) {
			return 4;
		}
		return mode in states ? states[mode] ? 1 : 2 : 0;
	}

	ansiModeState(mode: number): number {
		const states: Record<number, number> = {
			2: 4,
			4: this.insertMode ? 1 : 2,
			12: 3,
			20: this.newlineMode ? 1 : 2,
		};
		return states[mode] ?? 0;
	}

	setPrivateMode(mode: number, on: boolean): void {
		switch (mode) {
			case 1:
				this.applicationCursor = on;
				return;
			case 6:
				this.originMode = on;
				this.moveTo(0, 0);
				return;
			case 7:
				this.autowrap = on;
				return;
			case 25:
				this.cursorVisible = on;
				return;
			case 47:
			case 1047:
				this.useAlternate(on);
				return;
			case 1048:
				if (on) {
					this.saveCursor();
				} else {
					this.restoreCursor();
				}
				return;
			case 1049:
				if (on) {
					this.saveCursor();
					this.useAlternate(true);
				} else {
					this.useAlternate(false);
					this.restoreCursor();
				}
				return;
			case 9:
			case 1000:
			case 1002:
			case 1003:
				this.mouseTracking = on ? mode : 0;
				return;
			case 1005:
			case 1006:
			case 1015:
				this.mouseEncoding = on ? mode : 0;
				return;
			case 1004:
				this.focusReporting = on;
				return;
			case 2004:
				this.bracketedPaste = on;
				return;
			case 2026:
				this.synchronizedOutput = on;
				return;
		}
	}

	// From past the last column, which is where the cursor waits after
	// writing there, erasing to the right erases nothing on its row.
	eraseStart(): number {
		return this.wrapPending ? this.cols : this.x;
	}

	eraseDisplay(mode: number): void {
		const lines = this.lines;
		if (mode === 0) {
			eraseCells(lines[this.y], this.eraseStart(), this.cols, this.bg);
			for (let row = this.y + 1; row < this.rows; row++) {
				eraseCells(lines[row], 0, this.cols, this.bg);
			}
		} else if (mode === 1) {
			for (let row = 0; row < this.y; row++) {
				eraseCells(lines[row], 0, this.cols, this.bg);
			}
			eraseCells(lines[this.y], 0, this.eraseStart() + 1, this.bg);
		} else if (mode === 2) {
			for (const line of lines) {
				eraseCells(line, 0, this.cols, this.bg);
			}
		} else if (mode === 3) {
			this.history = [];
		}
	}

	eraseLine(mode: number): void {
		const line = this.lines[this.y];
		if (mode === 0) {
			eraseCells(line, this.eraseStart(), this.cols, this.bg);
		} else if (mode === 1) {
			eraseCells(line, 0, this.eraseStart() + 1, this.bg);
		} else if (mode === 2) {
			eraseCells(line, 0, this.cols, this.bg);
		}
	}

	insertChars(count: number): void {
		this.wrapPending = false;
		const line = this.lines[this.y];
		count = Math.min(count, this.cols - this.x);
		shiftCells(line, this.x, this.x + count, this.cols - this.x - count);
		line.chars.fill("", this.x, this.x + count);
		line.widths.fill(1, this.x, this.x + count);
		line.fg.fill(DEFAULT_COLOR, this.x, this.x + count);
		line.bg.fill(this.bg, this.x, this.x + count);
		line.attrs.fill(0, this.x, this.x + count);
		repairWide(line, DEFAULT_COLOR, this.bg, 0);
	}

	deleteChars(count: number): void {
		this.wrapPending = false;
		const line = this.lines[this.y];
		count = Math.min(count, this.cols - this.x);
		shiftCells(line, this.x + count, this.x, this.cols - this.x - count);
		line.chars.fill("", this.cols - count);
		line.widths.fill(1, this.cols - count);
		line.fg.fill(DEFAULT_COLOR, this.cols - count);
		line.bg.fill(this.bg, this.cols - count);
		line.attrs.fill(0, this.cols - count);
		repairWide(line, DEFAULT_COLOR, this.bg, 0);
	}

	insertLines(count: number): void {
		if (this.y < this.scrollTop || this.y > this.scrollBottom) {
			return;
		}
		this.scrollDown(count, this.y);
		this.x = 0;
		this.wrapPending = false;
	}

	deleteLines(count: number): void {
		if (this.y < this.scrollTop || this.y > this.scrollBottom) {
			return;
		}
		this.scrollUp(count, this.y);
		this.x = 0;
		this.wrapPending = false;
	}

	// REP repeats the character printed just before it, marks and all.
	repeat(count: number, preceding: Terminal["preceding"]): void {
		if (preceding === null) {
			return;
		}
		const cluster = this.lines[this.y].chars[preceding.col];
		if (cluster === "") {
			return;
		}
		this.preceding = preceding;
		for (let index = 0; index < Math.min(count, 0xffff); index++) {
			for (const char of cluster) {
				this.print(char.codePointAt(0)!);
			}
		}
	}

	setGraphics(): void {
		const params = this.params;
		for (let index = 0; index < params.length; index++) {
			const param = params[index];
			const n = param[0];
			if (n >= 30 && n <= 37) {
				this.fg = n - 30;
			} else if (n >= 40 && n <= 47) {
				this.bg = n - 40;
			} else if (n >= 90 && n <= 97) {
				this.fg = n - 90 + 8;
			} else if (n >= 100 && n <= 107) {
				this.bg = n - 100 + 8;
			} else if (n === 38 || n === 48 || n === 58) {
				const {color, used} = readExtendedColor(params, index);
				index += used;
				if (color !== null) {
					if (n === 38) {
						this.fg = color;
					} else if (n === 48) {
						this.bg = color;
					}
				}
			} else {
				this.setAttribute(n, param[1]);
			}
		}
	}

	setAttribute(n: number, sub: number | undefined): void {
		switch (n) {
			case 0:
				this.fg = DEFAULT_COLOR;
				this.bg = DEFAULT_COLOR;
				this.attrs = 0;
				return;
			case 1:
				this.attrs |= BOLD;
				return;
			case 2:
				this.attrs |= DIM;
				return;
			case 3:
				this.attrs |= ITALIC;
				return;
			case 4:
				this.attrs &= ~(UNDERLINE | DOUBLE_UNDERLINE);
				if (sub === 2) {
					this.attrs |= DOUBLE_UNDERLINE;
				} else if (sub !== 0) {
					this.attrs |= UNDERLINE;
				}
				return;
			case 5:
			case 6:
				this.attrs |= BLINK;
				return;
			case 7:
				this.attrs |= INVERSE;
				return;
			case 8:
				this.attrs |= INVISIBLE;
				return;
			case 9:
				this.attrs |= STRIKETHROUGH;
				return;
			case 21:
				this.attrs = (this.attrs & ~UNDERLINE) | DOUBLE_UNDERLINE;
				return;
			case 22:
				this.attrs &= ~(BOLD | DIM);
				return;
			case 23:
				this.attrs &= ~ITALIC;
				return;
			case 24:
				this.attrs &= ~(UNDERLINE | DOUBLE_UNDERLINE);
				return;
			case 25:
				this.attrs &= ~BLINK;
				return;
			case 27:
				this.attrs &= ~INVERSE;
				return;
			case 28:
				this.attrs &= ~INVISIBLE;
				return;
			case 29:
				this.attrs &= ~STRIKETHROUGH;
				return;
			case 39:
				this.fg = DEFAULT_COLOR;
				return;
			case 49:
				this.bg = DEFAULT_COLOR;
				return;
			case 53:
				this.attrs |= OVERLINE;
				return;
			case 55:
				this.attrs &= ~OVERLINE;
				return;
		}
	}

	dispatchOSC(): void {
		const match = /^([02]);(.*)$/s.exec(this.osc);
		if (match !== null) {
			this.title = match[2];
		}
		const link = /^8;([^;]*);(.*)$/s.exec(this.osc);
		if (link !== null && (link[2] !== "" || link[1].trim() === "")) {
			this.link = link[2] !== "";
		}
		this.osc = "";
	}

	// DECRQSS: the SGR, the margins, the cursor's shape, and the fixed
	// answers xterm gives for protection and the conformance level.
	dispatchDCS(): void {
		const request = /^\$q(.*)$/s.exec(this.dcs)?.[1];
		this.dcs = "";
		if (request === undefined) {
			return;
		}
		const answers: Record<string, string> = {
			m: `${this.describeGraphics()}m`,
			r: `${this.scrollTop + 1};${this.scrollBottom + 1}r`,
			" q": `${this.cursorShape === 0 ? 2 : this.cursorShape} q`,
			"\"q": "0\"q",
			"\"p": "61;1\"p",
		};
		const answer = answers[request];
		this.reply(
			answer === undefined ? "\x1bP0$r\x1b\\" : `\x1bP1$r${answer}\x1b\\`,
		);
	}

	// The SGR parameters that give the current attributes and colors.
	describeGraphics(): string {
		const params = ["0"];
		const names: Array<[number, number]> = [
			[BOLD, 1],
			[DIM, 2],
			[ITALIC, 3],
			[UNDERLINE, 4],
			[BLINK, 5],
			[INVERSE, 7],
			[INVISIBLE, 8],
			[STRIKETHROUGH, 9],
			[DOUBLE_UNDERLINE, 21],
			[OVERLINE, 53],
		];
		for (const [bit, param] of names) {
			if ((this.attrs & bit) !== 0) {
				params.push(String(param));
			}
		}
		const color = (value: number, base: number, bright: number) => {
			if (value === DEFAULT_COLOR) {
				return;
			}
			if ((value & RGB_COLOR) !== 0) {
				params.push(
					`${base + 8};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`,
				);
			} else if (value < 8) {
				params.push(String(base + value));
			} else if (value < 16) {
				params.push(String(bright + value - 8));
			} else {
				params.push(`${base + 8};5;${value}`);
			}
		};
		color(this.fg, 30, 90);
		color(this.bg, 40, 100);
		return params.join(";");
	}
}

// How wide the character before grows to with `code` joined to it, as
// termdom measures a cluster, or null for a character that starts a cell
// of its own. A joiner keeps the cluster open for whatever follows.
function joinedWidth(
	code: number,
	width: number,
	preceding: {width: number; joining: boolean},
): number | null {
	if (code === 0x200d) {
		return preceding.width;
	}
	if (preceding.joining) {
		return Math.max(preceding.width, width);
	}
	if (code === 0xfe0f) {
		return 2;
	}
	if (code === 0xfe0e || (code >= 0x1f3fb && code <= 0x1f3ff) || width === 0) {
		return preceding.width;
	}
	return null;
}

const clampByte = (value: number | undefined) =>
	Math.max(0, Math.min(value ?? 0, 255));

// SGR 38, 48 and 58, in both forms: 38;5;n and 38;2;r;g;b with
// semicolons, where the color takes the parameters that follow, and
// 38:5:n and 38:2:space:r:g:b with colons, where it is all one
// parameter and the color space, often left empty, comes first.
function readExtendedColor(
	params: number[][],
	index: number,
): {color: number | null; used: number} {
	const param = params[index];
	if (param.length > 1) {
		if (param[1] === 5 && param.length > 2) {
			return {color: clampByte(param[2]), used: 0};
		}
		if (param[1] === 2) {
			return {
				color:
					RGB_COLOR |
					(clampByte(param[3]) << 16) |
					(clampByte(param[4]) << 8) |
					clampByte(param[5]),
				used: 0,
			};
		}
		return {color: null, used: 0};
	}
	const mode = params[index + 1]?.[0];
	if (mode === 5) {
		return {color: clampByte(params[index + 2]?.[0]), used: 2};
	}
	if (mode === 2) {
		return {
			color:
				RGB_COLOR |
				(clampByte(params[index + 2]?.[0]) << 16) |
				(clampByte(params[index + 3]?.[0]) << 8) |
				clampByte(params[index + 4]?.[0]),
			used: 4,
		};
	}
	return {color: null, used: 0};
}
