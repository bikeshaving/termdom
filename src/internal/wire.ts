/**
 * The terminal protocol, encode direction: how an utterance is spelled in
 * bytes. Callers here say WHAT they want said -- move the cursor, erase below,
 * engage a mode, set the title -- and never assemble an escape themselves. A
 * spelling written anywhere else is a dialect, so the emitters route through
 * this vocabulary.
 *
 * A leaf: it knows the grammar and nothing about the engine.
 */

/** How many colors the terminal is believed to speak. */
export type ColorDepth = "ansi" | "rgb" | "256";

/* ------------------------------------------------------------- the cursor */

/** CUP: the cursor to a one-based row and column. */
export function cursorTo(row: number, col: number): string {
	return `\x1b[${row};${col}H`;
}

/** CUP with no parameters: the top-left cell. */
export function cursorHome(): string {
	return "\x1b[H";
}

/** CUF: the cursor forward by columns. */
export function cursorForward(columns: number): string {
	return `\x1b[${columns}C`;
}

/** CUD: the cursor down by rows, stopping at the bottom margin. */
export function cursorDown(rows: number): string {
	return `\x1b[${rows}B`;
}

/** DECSC: remember where the cursor is. */
export function saveCursor(): string {
	return "\x1b7";
}

/** DECRC: the cursor back to where DECSC left it. */
export function restoreCursor(): string {
	return "\x1b8";
}

/** IND: down one row, scrolling the screen when the cursor is at the end. */
export function index(): string {
	return "\x1bD";
}

/* -------------------------------------------------------------- the eraser */

/** EL 0: from the cursor to the end of its row. */
export function eraseToLineEnd(): string {
	return "\x1b[K";
}

/** ED 0: from the cursor to the end of the screen. */
export function eraseBelow(): string {
	return "\x1b[J";
}

/** ED 2: the whole screen, cursor left where it stands. */
export function eraseScreen(): string {
	return "\x1b[2J";
}

/* ------------------------------------------------------- the scroll region */

/** DECSTBM: the scrolling region, one-based rows. Homes the cursor. */
export function setScrollRegion(top: number, bottom: number): string {
	return `\x1b[${top};${bottom}r`;
}

/** DECSTBM with no parameters: the region is the whole screen again. */
export function resetScrollRegion(): string {
	return "\x1b[r";
}

/** DL: delete rows at the cursor, pulling the region up. */
export function deleteLines(count: number): string {
	return `\x1b[${count}M`;
}

/** IL: insert blank rows at the cursor, pushing the region down. */
export function insertLines(count: number): string {
	return `\x1b[${count}L`;
}

/* --------------------------------------------------------------- the style */

/** SGR with the given parameters. */
export function sgr(parameters: string): string {
	return `\x1b[${parameters}m`;
}

/** SGR 0: back to the terminal's own defaults. */
export function sgrReset(): string {
	return "\x1b[0m";
}

function rgbTo256(color: number): number {
	const r = (color >> 16) & 0xff;
	const g = (color >> 8) & 0xff;
	const b = color & 0xff;

	if (r === g && g === b) {
		if (r < 8) {
			return 0;
		}
		if (r > 248) {
			return 15;
		}
		return Math.round(((r - 8) / 247) * 23) + 232;
	}

	const r6 = Math.round((r / 255) * 5);
	const g6 = Math.round((g / 255) * 5);
	const b6 = Math.round((b / 255) * 5);
	return 16 + 36 * r6 + 6 * g6 + b6;
}

function rgbToBasic8(color: number): number {
	const r = (color >> 16) & 0xff;
	const g = (color >> 8) & 0xff;
	const b = color & 0xff;

	let ansiColor = 0;
	if (r > 127) {
		ansiColor |= 1;
	}
	if (g > 127) {
		ansiColor |= 2;
	}
	if (b > 127) {
		ansiColor |= 4;
	}
	return ansiColor;
}

/**
 * The SGR parameters naming a 24-bit color at the depth the terminal speaks:
 * stated outright, quantized to the 256-color cube, or rounded to one of the
 * eight the oldest terminals have. Parameters, not a whole SGR -- a run of
 * them shares one escape.
 */
export function sgrColor(
	color: number,
	isFg: boolean,
	colorDepth: ColorDepth,
): string {
	switch (colorDepth) {
		case "rgb": {
			const r = (color >> 16) & 0xff;
			const g = (color >> 8) & 0xff;
			const b = color & 0xff;
			return `${isFg ? 38 : 48};2;${r};${g};${b}`;
		}
		case "256":
			return `${isFg ? 38 : 48};5;${rgbTo256(color)}`;
		case "ansi":
			return String((isFg ? 30 : 40) + rgbToBasic8(color));
	}
}

/* --------------------------------------------------------------- the modes */

/** DECSET/DECRST: engage or release a private mode by number. */
export function privateMode(code: number, on: boolean): string {
	return `\x1b[?${code}${on ? "h" : "l"}`;
}

/** SM/RM: engage or release an ANSI mode by number. */
export function ansiMode(code: number, on: boolean): string {
	return `\x1b[${code}${on ? "h" : "l"}`;
}

/** DECRQM for a private mode: what is this mode set to? */
export function privateModeQuery(code: number): string {
	return `\x1b[?${code}$p`;
}

/** DECRQM for an ANSI mode. */
export function ansiModeQuery(code: number): string {
	return `\x1b[${code}$p`;
}

/** XTWINOPS 22: push the window title onto the terminal's own stack. */
export function pushTitle(): string {
	return "\x1b[22;0t";
}

/** XTWINOPS 23: pop the title the push saved. */
export function popTitle(): string {
	return "\x1b[23;0t";
}

/* --------------------------------------------------------------- the probes */

/** DSR 6: where is the cursor? Answered by a CPR report. */
export function cursorPositionQuery(): string {
	return "\x1b[6n";
}

/* ----------------------------------------------------------------- the OSC */

/** OSC 2: the window title. */
export function setWindowTitle(text: string): string {
	return `\x1b]2;${text}\x07`;
}

/** OSC 52: put base64 payload on the terminal's clipboard. */
export function clipboardWrite(payload: string): string {
	return `\x1b]52;c;${payload}\x07`;
}

/** OSC 52 with "?": ask the terminal for the clipboard's contents. */
export function clipboardQuery(): string {
	return "\x1b]52;c;?\x07";
}
