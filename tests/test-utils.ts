/**
 * Test Utilities for TTYOM
 *
 * Shared utilities for terminal testing with unified TestTerminal class
 */

import {type ProcessLike, type TTYWriteStream} from "../src/index.js";
import {EventEmitter} from "events";
import {Terminal} from "@xterm/headless";
import {SerializeAddon} from "@xterm/addon-serialize";

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
	private serializeAddon: SerializeAddon;

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

		// Add serialize addon to get terminal contents
		this.serializeAddon = new SerializeAddon();
		this.terminal.loadAddon(this.serializeAddon);

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
		return this.serializeAddon.serialize();
	}

	/**
	 * Get the visible text content (ANSI codes stripped)
	 */
	getVisibleText(): string {
		return Bun.stripANSI(this.getScreenContents());
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
