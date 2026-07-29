import {
	type ProcessLike,
	type TTYReadStream,
	type TTYWriteStream,
} from "./termdom.js";

export class FullscreenManager {
	#process: ProcessLike;
	#stdin: TTYReadStream;
	#stdout: TTYWriteStream;

	#fullscreenStack: Element[] = [];
	#isInFullscreenMode: boolean = false;
	#originalTtyMode: boolean = false;
	#cleanupHandlers: Array<() => void> = [];

	constructor(process: ProcessLike) {
		this.#process = process;
		this.#stdout = process.stdout;
		this.#stdin = process.stdin!;

		// Setup cleanup handlers
		this.#setupCleanupHandlers();
	}

	/**
	 * Request fullscreen mode for an element
	 */
	async requestFullscreen(
		element: Element,
		_options?: globalThis.FullscreenOptions,
	): Promise<void> {
		if (!element.isConnected) {
			const error = new Error("The element is not contained by a document.");
			error.name = "InvalidStateError";
			throw error;
		}

		try {
			// Add to fullscreen stack
			this.#fullscreenStack.push(element);

			// Enter fullscreen mode if this is the first element
			if (!this.#isInFullscreenMode) {
				await this.#enterFullscreenMode();
			}

			// Fire fullscreenchange event
			this.#fireFullscreenChangeEvent(element);
		} catch (error) {
			// Remove from stack on error
			this.#fullscreenStack.pop();

			// Fire fullscreenerror event
			this.#fireFullscreenErrorEvent(element, error as Error);
			throw error;
		}
	}

	/**
	 * Exit fullscreen mode
	 */
	async exitFullscreen(): Promise<void> {
		if (this.#fullscreenStack.length === 0) {
			return; // Already not in fullscreen
		}

		// Remove the topmost element
		const exitingElement = this.#fullscreenStack.pop()!;

		// If no more elements in stack, exit fullscreen mode
		if (this.#fullscreenStack.length === 0) {
			await this.#exitFullscreenMode();
		}

		// Fire fullscreenchange event
		this.#fireFullscreenChangeEvent(exitingElement);
	}

	/**
	 * Get the current fullscreen element
	 */
	get fullscreenElement(): Element | null {
		return this.#fullscreenStack.length > 0
			? this.#fullscreenStack[this.#fullscreenStack.length - 1]
			: null;
	}

	/**
	 * Check if currently in fullscreen mode
	 */
	get isFullscreen(): boolean {
		return this.#isInFullscreenMode;
	}

	async #enterFullscreenMode(): Promise<void> {
		// Save original TTY mode
		if (this.#stdin && this.#stdin.setRawMode) {
			this.#originalTtyMode = (this.#stdin as any).isRaw || false;
		}

		// Enter alternate screen buffer
		this.#stdout.write("\x1b[?1049h");

		// Clear screen and hide cursor
		this.#stdout.write("\x1b[2J\x1b[H\x1b[?25l");

		// Enable raw mode for input handling
		if (this.#stdin && this.#stdin.setRawMode) {
			this.#stdin.setRawMode(true);
		}
		if (this.#stdin) {
			this.#stdin.resume();
		}

		this.#isInFullscreenMode = true;

		// Setup input handling for Esc key
		this.#setupInputHandling();
	}

	async #exitFullscreenMode(): Promise<void> {
		// Restore cursor and exit alternate screen buffer
		this.#stdout.write("\x1b[?25h\x1b[?1049l");

		// Restore original TTY mode
		if (this.#stdin && this.#stdin.setRawMode) {
			this.#stdin.setRawMode(this.#originalTtyMode);
		}

		this.#isInFullscreenMode = false;

		// Remove input handling
		this.#removeInputHandling();
	}

	#inputHandler = (chunk: Buffer) => {
		const key = chunk.toString("utf8");

		// Handle Esc key to exit fullscreen
		if (key === "\x1b" || key === "\x03") {
			// Esc or Ctrl+C
			this.exitFullscreen().catch(() => {});
			return;
		}

		// Dispatch keyboard event to the fullscreen element
		if (this.fullscreenElement) {
			this.#dispatchKeyboardEvent(this.fullscreenElement, key, chunk);
		}
	};

	#setupInputHandling(): void {
		if (this.#stdin) {
			this.#stdin.on("data", this.#inputHandler);
		}
	}

	#removeInputHandling(): void {
		if (this.#stdin) {
			this.#stdin.removeListener("data", this.#inputHandler);
		}
	}

	#fireFullscreenChangeEvent(element: Element): void {
		const window = this.#getWindow(element);
		if (!window) return;

		const event = new window.CustomEvent("fullscreenchange", {
			bubbles: true,
			cancelable: false,
		});

		// Fire on both element and document
		element.dispatchEvent(event);
		element.ownerDocument?.dispatchEvent(event);
	}

	#fireFullscreenErrorEvent(element: Element, error: Error): void {
		const window = this.#getWindow(element);
		if (!window) return;

		const event = new window.CustomEvent("fullscreenerror", {
			bubbles: true,
			cancelable: false,
			detail: {error},
		});

		// Fire on both element and document
		element.dispatchEvent(event);
		element.ownerDocument?.dispatchEvent(event);
	}

	#getWindow(element?: Element): any {
		// Get window from the element's document, or from the stack
		const targetElement = element || this.#fullscreenStack[0];
		return targetElement?.ownerDocument?.defaultView;
	}

	#dispatchKeyboardEvent(element: Element, key: string, _chunk: Buffer): void {
		const window = this.#getWindow(element);
		if (!window) return;

		// Map common key codes
		let keyName = key;
		let keyCode = 0;
		let charCode = key.charCodeAt(0);

		// Handle special keys
		switch (key) {
			case "\r":
			case "\n":
				keyName = "Enter";
				keyCode = 13;
				charCode = 13;
				break;
			case "\t":
				keyName = "Tab";
				keyCode = 9;
				charCode = 9;
				break;
			case "\x7f":
				keyName = "Backspace";
				keyCode = 8;
				charCode = 8;
				break;
			case "\x1b[A":
				keyName = "ArrowUp";
				keyCode = 38;
				charCode = 0;
				break;
			case "\x1b[B":
				keyName = "ArrowDown";
				keyCode = 40;
				charCode = 0;
				break;
			case "\x1b[C":
				keyName = "ArrowRight";
				keyCode = 39;
				charCode = 0;
				break;
			case "\x1b[D":
				keyName = "ArrowLeft";
				keyCode = 37;
				charCode = 0;
				break;
			default:
				// For regular characters, keyCode is often the uppercase charCode
				if (key.length === 1) {
					keyCode = key.toUpperCase().charCodeAt(0);
				}
		}

		// Create and dispatch keydown event
		const keydownEvent = new window.KeyboardEvent("keydown", {
			key: keyName,
			code: `Key${keyName.toUpperCase()}`,
			keyCode: keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			metaKey: false,
			bubbles: true,
			cancelable: true,
		});

		const notCanceled = element.dispatchEvent(keydownEvent);

		// If keydown wasn't canceled and it's a printable character, dispatch keypress
		if (notCanceled && key.length === 1 && charCode >= 32 && charCode < 127) {
			const keypressEvent = new window.KeyboardEvent("keypress", {
				key: key,
				code: `Key${key.toUpperCase()}`,
				keyCode: charCode,
				charCode: charCode,
				which: charCode,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
				metaKey: false,
				bubbles: true,
				cancelable: true,
			});
			element.dispatchEvent(keypressEvent);
		}

		// Always dispatch keyup
		const keyupEvent = new window.KeyboardEvent("keyup", {
			key: keyName,
			code: `Key${keyName.toUpperCase()}`,
			keyCode: keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey: false,
			shiftKey: false,
			altKey: false,
			metaKey: false,
			bubbles: true,
			cancelable: true,
		});
		element.dispatchEvent(keyupEvent);
	}

	#setupCleanupHandlers(): void {
		const cleanup = () => {
			if (this.#isInFullscreenMode) {
				// Force exit fullscreen mode on process exit
				this.#stdout.write("\x1b[?25h\x1b[?1049l");

				// Restore TTY mode
				if (this.#stdin && this.#stdin.setRawMode) {
					this.#stdin.setRawMode(this.#originalTtyMode);
				}
			}
		};

		this.#process.on("exit", cleanup);
		this.#process.on("SIGINT", cleanup);
		this.#process.on("SIGTERM", cleanup);
		this.#process.on("SIGHUP", cleanup);

		this.#cleanupHandlers.push(cleanup);
	}

	dispose(): void {
		// Remove all event listeners and cleanup
		this.#removeInputHandling();

		if (this.#isInFullscreenMode) {
			this.#stdout.write("\x1b[?25h\x1b[?1049l");
			if (this.#stdin && this.#stdin.setRawMode) {
				this.#stdin.setRawMode(this.#originalTtyMode);
			}
		}

		this.#fullscreenStack = [];
		this.#isInFullscreenMode = false;
	}
}
