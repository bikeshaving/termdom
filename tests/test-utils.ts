/**
 * Test Utilities for TTYOM
 *
 * Shared utilities for terminal testing with unified TestTerminal class
 */

import {type ProcessLike, type TTYWriteStream} from "../src/index.js";
import {EventEmitter} from "events";
import {Terminal} from "@xterm/headless";

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
	private terminal: Terminal;

	constructor(options: {cols?: number; rows?: number} = {}) {
		super();

		const cols = options.cols || 80;
		const rows = options.rows || 24;

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
				lines.push('');
			}
		}
		
		// Remove trailing empty lines like bufferToVisibleText does
		while (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}
		
		return lines.join('\n');
	}

	/**
	 * Get static ANSI content (styling preserved, no cursor movements)
	 */
	getStaticANSI(): string {
		const buffer = this.terminal.buffer.active;
		const lines: string[] = [];
		
		for (let row = 0; row < this.terminal.rows; row++) {
			const line = buffer.getLine(row);
			if (!line) {
				lines.push('');
				continue;
			}
			
			let lineOutput = '';
			let lastFg = -1;
			let lastBg = -1;
			let lastFlags = 0;
			
			for (let col = 0; col < this.terminal.cols; col++) {
				const cell = line.getCell(col);
				if (!cell) {
					lineOutput += ' ';
					continue;
				}
				
				const fg = cell.getFgColor();
				const bg = cell.getBgColor();
				const flags = (cell.isBold() ? 1 : 0) | 
							  (cell.isItalic() ? 2 : 0) | 
							  (cell.isUnderline() ? 4 : 0);
				
				// Emit style changes only when needed
				let styleChange = '';
				
				if (fg !== lastFg || bg !== lastBg || flags !== lastFlags) {
					// Reset if needed
					if (lastFg !== -1 || lastBg !== -1 || lastFlags !== 0) {
						styleChange += '\x1b[0m';
					}
					
					// Set new styles
					if (flags & 1) styleChange += '\x1b[1m'; // bold
					if (flags & 2) styleChange += '\x1b[3m'; // italic  
					if (flags & 4) styleChange += '\x1b[4m'; // underline
					
					// Foreground color
					if (fg !== 0) {
						if ((fg & 0xFF000000) === 0x02000000) {
							// RGB mode
							const r = (fg >> 16) & 0xFF;
							const g = (fg >> 8) & 0xFF;
							const b = fg & 0xFF;
							styleChange += `\x1b[38;2;${r};${g};${b}m`;
						} else if (fg < 16) {
							// Basic colors
							styleChange += `\x1b[${fg < 8 ? 30 + fg : 90 + fg - 8}m`;
						} else {
							// 256-color mode
							styleChange += `\x1b[38;5;${fg}m`;
						}
					}
					
					// Background color  
					if (bg !== 0) {
						if ((bg & 0xFF000000) === 0x02000000) {
							const r = (bg >> 16) & 0xFF;
							const g = (bg >> 8) & 0xFF;
							const b = bg & 0xFF;
							styleChange += `\x1b[48;2;${r};${g};${b}m`;
						} else if (bg < 16) {
							styleChange += `\x1b[${bg < 8 ? 40 + bg : 100 + bg - 8}m`;
						} else {
							styleChange += `\x1b[48;5;${bg}m`;
						}
					}
					
					lastFg = fg;
					lastBg = bg;
					lastFlags = flags;
				}
				
				lineOutput += styleChange + (cell.getChars() || ' ');
			}
			
			// Reset at end of line if we had styling
			if (lastFg !== -1 || lastBg !== -1 || lastFlags !== 0) {
				lineOutput += '\x1b[0m';
			}
			
			lines.push(lineOutput.trimEnd());
		}
		
		// Remove trailing empty lines
		while (lines.length > 0 && lines[lines.length - 1] === '') {
			lines.pop();
		}
		
		return lines.join('\n');
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
