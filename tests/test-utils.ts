/**
 * Test Utilities for TTYOM
 *
 * Shared utilities for terminal testing with unified TestTerminal class
 */

import {type ProcessLike, type TTYWriteStream} from "../src/termdom.js";
import {EventEmitter} from "events";
import {Terminal} from "@xterm/headless";
import {type CellBuffer, Cell, createBuffer} from "../src/ansi.js";
import {generateANSI, type ColorDepth} from "../src/ansi.js";

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

	constructor(terminal: Terminal, cols: number = 80, rows: number = 24) {
		super();
		this.terminal = terminal;
		this.columns = cols;
		this.rows = rows;
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

		// Use xterm's write callback to know when processing is complete
		this.terminal.write(data, callback);

		return true;
	}
}

export class TestTerminal extends EventEmitter implements ProcessLike {
	stdout: MockWriteStream;
	env: Record<string, string | undefined>;
	private terminal: Terminal;

	constructor(options: {cols?: number; rows?: number; env?: Record<string, string | undefined>} = {}) {
		super();

		const cols = options.cols || 80;
		const rows = options.rows || 24;
		
		// Set up environment for testing (defaults to 24-bit color support)
		this.env = options.env || {
			COLORTERM: "truecolor",
			TERM: "xterm-256color",
		};

		// Create headless xterm instance
		this.terminal = new Terminal({
			cols,
			rows,
			allowProposedApi: true,
		});

		// No need for serialize addon - we use direct buffer access

		this.stdout = new MockWriteStream(this.terminal, cols, rows);
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
		return this.getStaticANSI();
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
				lines.push(line.translateToString(true)); // true = trim right
			} else {
				lines.push("");
			}
		}

		// Remove trailing empty lines like bufferToVisibleText does
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		return lines.join("\n");
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

			for (let col = 0; col < this.terminal.cols; col++) {
				const cell = line.getCell(col);
				if (!cell) continue;

				const chars = cell.getChars();
				if (!chars) continue;
				// Don't skip spaces - they're important for text layout

				// Convert xterm style to our format
				const fg = cell.getFgColor();
				const bg = cell.getBgColor();
				
				const cellStyle = {
					fg: fg !== 0 ? fg : undefined,
					bg: bg !== 0 ? bg : undefined,
					bold: cell.isBold(),
					italic: cell.isItalic(), 
					underline: cell.isUnderline(),
					strikethrough: false, // xterm doesn't expose this directly
					inverse: cell.isInverse(),
					dim: cell.isDim(),
					blink: cell.isBlink(),
					overline: false, // xterm doesn't expose this directly
				};

				cellBuffer[row][col] = Cell.create(chars, cellStyle);
			}
		}

		return cellBuffer;
	}

	/**
	 * Get static ANSI content using Renderer's generateANSI (no cursor movements)
	 */
	getStaticANSI(): string {
		const cellBuffer = this.xtermToCellBuffer();
		// Use RGB color depth to match our test environment
		const fullOutput = generateANSI(cellBuffer, "rgb");
		
		// Strip terminal control sequences for cleaner test output
		return fullOutput
			.replace(/\x1b\[\?2026[hl]/g, "") // Remove sync start/end
			.replace(/\x1b\[\?25[hl]/g, "")   // Remove cursor hide/show  
			.replace(/\x1b\[H/g, "")          // Remove home cursor
			.replace(/\x1b\[\d+C/g, "");      // Remove cursor forward
	}

	/**
	 * Clear the terminal screen
	 */
	clear(): void {
		this.terminal.clear();
	}

	/**
	 * Get access to the underlying xterm terminal for advanced operations
	 */
	getTerminal(): Terminal {
		return this.terminal;
	}
}
