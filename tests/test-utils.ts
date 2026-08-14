/**
 * Test utilities: the mock process, streams and transport the suite drives
 * TermDOM through, and the helpers that read a frame back off it.
 */

import {
	type ProcessLike,
	type TTYWriteStream,
	type TTYReadStream,
	type TerminalTransport,
	transportFromProcess,
} from "../src/internal/terminalsession.js";
import {EventEmitter} from "events";
import xtermPkg from "@xterm/headless";
const {Terminal} = xtermPkg;
type Terminal = InstanceType<typeof Terminal>;
import {CellGrid, type ColorDepth} from "../src/internal/ansi.js";
import {generateANSI} from "../src/internal/ansi.js";
import {stringWidth} from "../src/internal/text.js";
import {StyleManager} from "../src/internal/styles.js";
import {LayoutEngine} from "../src/internal/layout.js";
import {writeFileSync, mkdirSync, existsSync} from "fs";
import {join} from "path";

/**
 * The width tables, as the mock terminal's own measure.
 *
 * xterm-headless measures per code point out of the box, so a cluster of more
 * than one -- a ZWJ sequence, an emoji with a presentation selector -- advances
 * once per code point in it: 👨‍💻 takes four cells there and two here. A mock
 * that measured that way would put every cluster in the test suite into
 * standing disagreement with the engine, which is the one thing under test.
 * Registering this makes the mock a terminal that agrees; a test that wants
 * disagreement scripts the replies itself.
 */
const TABLE_UNICODE_VERSION = {
	version: "table",
	wcwidth(codepoint: number): 0 | 1 | 2 {
		const width = stringWidth(String.fromCodePoint(codepoint));
		return width <= 0 ? 0 : width >= 2 ? 2 : 1;
	},
	charProperties(codepoint: number, preceding: number): number {
		// xterm packs a codepoint's verdict as kind << 3 | width << 1 | joins,
		// and hands back the preceding codepoint's verdict so a cluster can be
		// assembled one codepoint at a time. Joining means "this codepoint
		// belongs to the cell before it, and the cluster's width is now what I
		// return".
		const precedingWidth = (preceding >> 1) & 3;
		const precedingKind = preceding >> 3;
		const width = TABLE_UNICODE_VERSION.wcwidth(codepoint);
		const join = (clusterWidth: number, kind = 0) =>
			(kind << 3) | ((clusterWidth & 3) << 1) | 1;

		if (preceding !== 0) {
			// A zero-width joiner keeps the cluster open and says so, so the
			// codepoint after it -- wide in its own right -- knows to join too.
			if (codepoint === 0x200d) return join(precedingWidth, ZWJ_PENDING);
			if (precedingKind === ZWJ_PENDING) {
				return join(Math.max(precedingWidth, width));
			}
			// The presentation selectors decide between the text form and the
			// emoji form, and the emoji form is the wide one.
			if (codepoint === 0xfe0f) return join(2);
			if (codepoint === 0xfe0e) return join(1);
			// Skin tone: part of the emoji before it, not a glyph of its own.
			if (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff) {
				return join(precedingWidth);
			}
			// Combining marks and the rest of the zero-width kind.
			if (width === 0 && precedingWidth !== 0) return join(precedingWidth);
		}

		return (width & 3) << 1;
	},
};

/** charProperties kind: the cluster ended on a joiner and wants what follows. */
const ZWJ_PENDING = 1;

/**
 * Mock WriteStream for testing that implements our minimal TTYWriteStream interface
 */
class MockWriteStream extends EventEmitter implements TTYWriteStream {
	columns: number;
	rows: number;
	isTTY = true;
	terminal: Terminal;
	#stdin: MockReadStream;

	constructor(
		terminal: Terminal,
		stdin: MockReadStream,
		cols: number = 80,
		rows: number = 24,
	) {
		super();
		this.terminal = terminal;
		this.#stdin = stdin;
		this.columns = cols;
		this.rows = rows;

		// Set up xterm to respond to cursor position queries
		// xterm.js automatically handles cursor position queries and responds via onData
		this.terminal.onData((data) => {
			// Forward any responses from xterm (like cursor position) to stdin
			this.#stdin.simulateResponse(data);
		});
	}

	write(
		chunk: any,
		encoding?: BufferEncoding | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean {
		// Handle overloaded signatures
		if (typeof encoding === "function") {
			callback = encoding;
			encoding = "utf8";
		}

		const data =
			typeof chunk === "string" ? chunk : chunk.toString(encoding || "utf8");

		// Feed data to xterm terminal - it will handle cursor queries automatically
		this.terminal.write(data, callback);

		return true;
	}
}

class MockReadStream extends EventEmitter implements TTYReadStream {
	isTTY = true;

	setRawMode(_mode: boolean): this {
		return this;
	}

	resume(): this {
		return this;
	}

	pause(): this {
		return this;
	}

	setEncoding(_encoding: string): this {
		return this;
	}

	simulateResponse(data: string): void {
		this.emit("data", Buffer.from(data));
	}
}

export class MockProcess extends EventEmitter implements ProcessLike {
	stdout: MockWriteStream;
	stdin: MockReadStream;
	env: Record<string, string | undefined>;
	terminal: Terminal;
	#transport: TerminalTransport | null = null;

	/** This mock as a TerminalTransport, the shape TermDOM takes. */
	get transport(): TerminalTransport {
		return (this.#transport ??= transportFromProcess(this));
	}

	/**
	 * A transport that declares prior screen content (sharesScreen), for tests
	 * exercising command-start anchoring: xterm-headless answers the DSR query.
	 * Fresh per access -- a transport's streams are one-shot, and anchor tests
	 * attach several instances to the same mock terminal in sequence.
	 */
	get sharedTransport(): TerminalTransport {
		return transportFromProcess(this, {sharesScreen: true});
	}

	constructor(
		options: {
			cols?: number;
			rows?: number;
			env?: Record<string, string | undefined>;
		} = {},
	) {
		super();

		const cols = options.cols || 80;
		const rows = options.rows || 24;

		// Set up environment for testing (defaults to 24-bit color support)
		this.env = options.env || {
			COLORTERM: "truecolor",
			TERM: "xterm-256color",
		};

		// Create headless xterm instance with standard color theme
		this.terminal = new Terminal({
			cols,
			rows,
			allowProposedApi: true,
			theme: {
				// Standard ANSI colors that match typical terminal expectations
				black: "#000000",
				red: "#ff0000",
				green: "#00ff00",
				yellow: "#ffff00",
				blue: "#0000ff",
				magenta: "#ff00ff",
				cyan: "#00ffff",
				white: "#ffffff",
				brightBlack: "#808080",
				brightRed: "#ff8080",
				brightGreen: "#80ff80",
				brightYellow: "#ffff80",
				brightBlue: "#8080ff",
				brightMagenta: "#ff80ff",
				brightCyan: "#80ffff",
				brightWhite: "#ffffff",
				foreground: "#ffffff",
				background: "#000000",
			},
		});

		this.terminal.unicode.register(TABLE_UNICODE_VERSION);
		this.terminal.unicode.activeVersion = TABLE_UNICODE_VERSION.version;

		// For headless mode, we need to manually initialize the terminal buffer
		// The terminal should be ready to receive data without needing DOM

		this.stdin = new MockReadStream();
		this.stdout = new MockWriteStream(this.terminal, this.stdin, cols, rows);
	}

	/**
	 * Mock process.exit - just throws to simulate exit
	 */
	exit(code?: number): never {
		throw new Error(`Mock process.exit(${code || 0})`);
	}

	/**
	 * Get the terminal screen contents as they would appear to a user
	 */
	getScreenContents(): string {
		const content = this.getStaticANSI();
		// Ensure trailing newline for clean snapshot output
		return content.endsWith("\n") ? content : content + "\n";
	}

	/**
	 * Get the visible text content (ANSI codes stripped)
	 */
	getVisibleText(): string {
		return this.getPlainText();
	}

	/**
	 * Resize the terminal in place
	 */
	resize(cols: number, rows: number): void {
		this.terminal.resize(cols, rows);
		this.stdout.columns = cols;
		this.stdout.rows = rows;
	}

	/**
	 * Get plain text without any ANSI codes
	 */
	getPlainText(): string {
		const buffer = this.terminal.buffer.active;
		const lines: string[] = [];

		// buffer.getLine(y) is an absolute index into the whole scrollback
		// buffer (0 = the first line ever written), not "row 0 of what's
		// currently on screen" -- viewportY is the offset that gets you there.
		// It only diverges from 0 once the terminal has real scrollback.
		for (let row = 0; row < this.terminal.rows; row++) {
			const line = buffer.getLine(buffer.viewportY + row);
			if (line) {
				const lineText = line.translateToString(true); // true = trim right
				lines.push(lineText);
			} else {
				lines.push("");
			}
		}

		// Remove trailing empty lines like bufferToVisibleText does
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		const result = lines.join("\n");
		// Ensure trailing newline for clean terminal output
		return result && !result.endsWith("\n") ? result + "\n" : result;
	}

	/**
	 * Convert xterm buffer to our cell grid
	 */
	#xtermToCellGrid(): CellGrid {
		const buffer = this.terminal.buffer.active;
		const grid = new CellGrid(this.terminal.rows, this.terminal.cols);

		for (let row = 0; row < this.terminal.rows; row++) {
			const line = buffer.getLine(buffer.viewportY + row);
			if (!line) continue;

			let outputCol = 0; // Track output column separately from xterm column

			for (
				let xtermCol = 0;
				xtermCol < this.terminal.cols && outputCol < this.terminal.cols;
				xtermCol++
			) {
				const cell = line.getCell(xtermCol);
				if (!cell) continue;

				// Skip width-0 cells (continuation cells for wide characters like emojis)
				// This is exactly how the serialize addon handles it
				if (cell.getWidth() === 0) {
					continue;
				}

				const chars = cell.getChars();
				// Handle empty chars as spaces (this happens with leading indentation)
				const actualChars = chars || " ";
				// Don't skip spaces - they're important for text layout

				// Convert xterm style to our format
				const fg = cell.getFgColor();
				const bg = cell.getBgColor();

				// Check if cell has explicit color styling - XTerm returns theme colors for default cells
				// For default cells, we want undefined colors to use the terminal's own defaults
				const hasExplicitFg = cell.getFgColorMode() !== 0; // 0 = default color mode
				const hasExplicitBg = cell.getBgColorMode() !== 0; // 0 = default color mode

				const cellStyle = {
					fg: hasExplicitFg ? fg : undefined,
					bg: hasExplicitBg ? bg : undefined,
					bold: !!cell.isBold(),
					italic: !!cell.isItalic(),
					underline: !!cell.isUnderline(),
					strikethrough: false, // xterm doesn't expose this directly
					inverse: !!cell.isInverse(),
					dim: !!cell.isDim(),
					blink: !!cell.isBlink(),
					overline: false, // xterm doesn't expose this directly
				};

				// Create the cell at the output position
				grid.setCell(
					row * this.terminal.cols + outputCol,
					actualChars,
					cellStyle,
				);
				outputCol++;

				// A wide character's continuation column stays empty; the glyph
				// to its left already covers it.
				const actualWidth = stringWidth(actualChars);
				if (actualWidth === 2 && outputCol < this.terminal.cols) {
					outputCol++;
				}
			}
		}

		return grid;
	}

	/**
	 * Get static ANSI content using Renderer's generateANSI (no cursor movements)
	 */
	getStaticANSI(): string {
		const grid = this.#xtermToCellGrid();
		// Use same color depth detection logic as TermDOM
		const colorDepth = this.#detectColorDepth();
		const fullOutput = generateANSI(grid, colorDepth);
		return stripControlCodes(fullOutput);
	}

	/**
	 * Detect color depth from environment (same logic as TermDOM)
	 */
	#detectColorDepth(): ColorDepth {
		const colorterm = this.env.COLORTERM;
		if (colorterm === "truecolor" || colorterm === "24bit") {
			return "rgb";
		}

		const term = this.env.TERM || "";
		if (term.includes("256color") || term.includes("256")) {
			return "256";
		}

		return "ansi";
	}

	/**
	 * Clear the terminal screen
	 */
	clear(): void {
		this.terminal.clear();
	}

	/**
	 * Write ANSI output to .ansi file after test passes
	 */
	writeANSI(testName: string): void {
		const ansiOutput = this.getStaticANSI();
		const ansiDir = join(process.cwd(), "tests", "__snapshots__", "ansi");
		if (!existsSync(ansiDir)) {
			mkdirSync(ansiDir, {recursive: true});
		}
		const ansiFilename = `${testName}.ansi`;
		writeFileSync(join(ansiDir, ansiFilename), ansiOutput);
	}
}

/**
 * Await the next painted frame. Rendering is automatic (the MutationObserver
 * drives it), so a test mutates the DOM and then awaits a frame -- exactly what a
 * page does with requestAnimationFrame, and the reason TermDOM has no public
 * render(). The engine's own window provides requestAnimationFrame.
 */
export function nextFrame(dom: {
	window: {requestAnimationFrame(cb: () => void): number};
	attach?(): void;
}): Promise<void> {
	// attach() is the only door to the terminal; a test awaiting a frame is
	// asking for one, so the harness makes the explicit call (idempotent).
	// The attach.test.ts contract tests exercise the unattached state by not
	// coming through here.
	dom.attach?.();
	return new Promise((resolve) =>
		dom.window.requestAnimationFrame(() => resolve()),
	);
}

/**
 * A StyleManager wired to a TermDOM's window, for the handful of tests that
 * inspect CSS parsing or pseudo-element resolution directly. styleManager is
 * #private on TermDOM; this re-parses the same document's stylesheets, so it
 * resolves the same rules.
 */
export function styleManagerFor(dom: {window: any}): StyleManager {
	const sm = new StyleManager(dom.window);
	sm.setLayoutEngine(new LayoutEngine(dom.window));
	sm.refreshStylesheets();
	return sm;
}

export function stripControlCodes(ansi: string): string {
	return ansi
		.replace(/\x1b\[\?2026[hl]/g, "") // Remove sync start/end
		.replace(/\x1b\[\?25[hl]/g, "") // Remove cursor hide/show
		.replace(/\x1b\[H/g, "") // Remove home cursor
		.replace(/\x1b\[(\d+)C/g, (_, count) => " ".repeat(parseInt(count))) // Replace cursor forward with spaces
		.replace(/\x1b\[K/g, "") // Remove clear line sequences
		.replace(/\x1b\[[0-9;]*H/g, "") // Remove cursor positioning
		.replace(/\x1b\[\d*[AB]/g, "") // Remove cursor up/down movement
		.replace(/\x1b[78]/g, "") // Remove DECSC/DECRC (save/restore cursor)
		.replace(/\r(?!\n)/g, ""); // Remove standalone carriage returns
}
