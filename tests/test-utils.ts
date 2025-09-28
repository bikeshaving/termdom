/**
 * Test Utilities for TTYOM
 *
 * Shared utilities for terminal testing with unified TestTerminal class
 */

import {
	type ProcessLike,
	type TTYWriteStream,
	type TTYReadStream,
} from "../src/termdom.js";
import {EventEmitter} from "events";
import {Terminal} from "@xterm/headless";
import {type CellBuffer, Cell, createBuffer, type ColorDepth} from "../src/ansi.js";
import {generateANSI} from "../src/ansi.js";
import {writeFileSync, mkdirSync, existsSync} from "fs";
import {join} from "path";

/**
 * Unified test terminal that handles process mocking and output capture
 */
/**
 * Mock WriteStream for testing that implements our minimal TTYWriteStream interface
 */
class MockWriteStream extends EventEmitter implements TTYWriteStream {
	columns: number;
	rows: number;
	isTTY = true;
	private terminal: Terminal;
	private stdin: MockReadStream;

	constructor(
		terminal: Terminal,
		stdin: MockReadStream,
		cols: number = 80,
		rows: number = 24,
	) {
		super();
		this.terminal = terminal;
		this.stdin = stdin;
		this.columns = cols;
		this.rows = rows;

		// Set up xterm to respond to cursor position queries
		// xterm.js automatically handles cursor position queries and responds via onData
		this.terminal.onData((data) => {
			// Forward any responses from xterm (like cursor position) to stdin
			this.stdin.simulateResponse(data);
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

export class TestTerminal extends EventEmitter implements ProcessLike {
	stdout: MockWriteStream;
	stdin: MockReadStream;
	env: Record<string, string | undefined>;
	private terminal: Terminal;

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
				black: '#000000',
				red: '#ff0000',
				green: '#00ff00', 
				yellow: '#ffff00',
				blue: '#0000ff',
				magenta: '#ff00ff',
				cyan: '#00ffff',
				white: '#ffffff',
				brightBlack: '#808080',
				brightRed: '#ff8080',
				brightGreen: '#80ff80',
				brightYellow: '#ffff80',
				brightBlue: '#8080ff',
				brightMagenta: '#ff80ff',
				brightCyan: '#80ffff',
				brightWhite: '#ffffff',
				foreground: '#ffffff',
				background: '#000000'
			}
		});

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

		for (let row = 0; row < this.terminal.rows; row++) {
			const line = buffer.getLine(row);
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
	 * Convert xterm buffer to our CellBuffer format
	 */
	private xtermToCellBuffer(): CellBuffer {
		const buffer = this.terminal.buffer.active;
		const cellBuffer = createBuffer(this.terminal.rows, this.terminal.cols);

		for (let row = 0; row < this.terminal.rows; row++) {
			const line = buffer.getLine(row);
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
				cellBuffer[row][outputCol] = Cell.create({
					grapheme: actualChars,
					...cellStyle,
				});
				outputCol++;

				// If this is a wide character, create a continuation cell at the next output position
				const actualWidth = Bun.stringWidth(actualChars);
				if (actualWidth === 2 && outputCol < this.terminal.cols) {
					cellBuffer[row][outputCol] = null; // Continuation cell
					outputCol++;
				}
			}
		}

		return cellBuffer;
	}

	/**
	 * Get static ANSI content using Renderer's generateANSI (no cursor movements)
	 */
	getStaticANSI(): string {
		const cellBuffer = this.xtermToCellBuffer();
		// Use same color depth detection logic as TermDOM
		const colorDepth = this.detectColorDepth();
		const fullOutput = generateANSI(cellBuffer, colorDepth);
		return stripControlCodes(fullOutput);
	}

	/**
	 * Detect color depth from environment (same logic as TermDOM)
	 */
	private detectColorDepth(): ColorDepth {
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
		const ansiDir = join(import.meta.dir, "__snapshots__", "ansi");
		if (!existsSync(ansiDir)) {
			mkdirSync(ansiDir, {recursive: true});
		}
		const ansiFilename = `${testName}.ansi`;
		writeFileSync(join(ansiDir, ansiFilename), ansiOutput);
	}
}

export function stripControlCodes(ansi: string): string {
	return ansi
		.replace(/\x1b\[\?2026[hl]/g, "") // Remove sync start/end
		.replace(/\x1b\[\?25[hl]/g, "") // Remove cursor hide/show
		.replace(/\x1b\[H/g, "") // Remove home cursor
		.replace(/\x1b\[(\d+)C/g, (_, count) => " ".repeat(parseInt(count))) // Replace cursor forward with spaces
		.replace(/\x1b\[K/g, "") // Remove clear line sequences
		.replace(/\x1b\[[0-9;]*H/g, "") // Remove cursor positioning
		.replace(/\r(?!\n)/g, ""); // Remove standalone carriage returns
}
