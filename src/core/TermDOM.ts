import {LayoutEngine} from "../layout/LayoutEngine.js";
import {Renderer, type ColorDepth} from "../rendering/Renderer.js";
import {EventEmitter} from "events";
import {JSDOM} from "jsdom";
import type {DOMWindow} from "jsdom";
import {RectUtils} from "../layout/RectUtils.js";
import {resolvePropertyValue} from "../css.js";

export interface TTYWriteStream {
	write(
		chunk: any,
		encoding?: BufferEncoding | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean;
	columns: number;
	rows: number;
	isTTY: boolean;
}

// TODO: is it possible to use the WebStream interface?
export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
}

/**
 * This interface attempts to document the minimum of what we need from the
 * runtime process object to implement a terminal renderer, so that we can mock
 * it for tests.
 */
export interface ProcessLike extends EventEmitter {
	stdout: TTYWriteStream;
	stdin?: TTYReadStream;
	stderr?: TTYWriteStream;
	exit(code?: number): never;
}

export interface TermDOMOptions {
	width?: number;
	height?: number;
	/** Color depth for ANSI output */
	colorDepth?: ColorDepth;
	/** Process object for dependency injection (defaults to global process) */
	process?: ProcessLike;
}

/**
 * TermDOM - Terminal Document Object Model
 *
 * Provides a JSDOM-like API for creating HTML documents that render to terminals
 */
export class TermDOM {
	public readonly document: Document;
	public readonly window: DOMWindow;

	private readonly renderer: Renderer;
	private readonly layoutEngine: LayoutEngine;
	private readonly jsdom: JSDOM;
	private readonly observer: MutationObserver;

	private width: number;
	private height: number;
	private readonly mode: "flow" | "fullscreen";
	private readonly process: ProcessLike;

	// Render completion callbacks for waitForRender
	private renderCompleteCallbacks: Array<() => void> = [];

	// Scrollback tracking
	private commandStart: number = 0;
	private commandHeight: number = 0;
	private renderStartRow: number = 0;

	constructor(options: TermDOMOptions = {}) {
		// Set up process (defaults to global process)
		this.process = options.process || process;

		// Set up dimensions
		this.width = options.width || this.process.stdout.columns || 80;
		this.height = options.height || this.process.stdout.rows || 24;
		this.mode = "flow";

		// Create JSDOM instance
		this.jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{
				pretendToBeVisual: true,
				//resources: "usable",
			},
		);

		// Extract window and document
		this.window = this.jsdom.window;
		this.document = this.jsdom.window.document;

		this.setupDOMInspector();
		this.initializeConstructorExtensions();
		// Create renderer with our new clean implementation
		this.renderer = new Renderer(
			this.height,
			this.width,
			// TODO: we should figure out the color depth from environment
			options.colorDepth || "rgb",
		);

		this.layoutEngine = new LayoutEngine(this.jsdom.window);
		this.layoutEngine.resize(this.width, this.height);

		// Set up window properties and DOM
		this.initializeWindow();
		// CSS defaults are now handled by the css.ts module

		// Set up automatic rendering via MutationObserver
		this.observer = this.setupMutationObserver();

		// Set up process handlers
		this.setupProcessHandlers();

		// Keep event loop alive to ensure mutations are processed before exit
		setTimeout(() => {}, 0);
	}

	private initializeWindow(): void {
		const window = this.window;
		// TODO: These could be getters
		Object.defineProperty(window, "innerWidth", {
			value: this.width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "innerHeight", {
			value: this.height,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerWidth", {
			value: this.width,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(window, "outerHeight", {
			value: this.height,
			writable: false,
			configurable: true,
		});
	}

	private setupMutationObserver(): MutationObserver {
		const observer = new this.window.MutationObserver(
			(mutations: MutationRecord[]) => {
				this.render(mutations);
			},
		);

		observer.observe(this.document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});

		return observer;
	}

	private setupProcessHandlers(): void {
		const cleanup = () => this.dispose();

		this.process.on("uncaughtException", () => {
			cleanup();
			this.process.exit(1);
		});

		this.process.on("SIGINT", () => {
			cleanup();
			this.process.exit(0);
		});

		this.process.on("SIGWINCH", () => {
			this.handleResize();
		});

		// Set up raw mode for full terminal control
		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			stdin.setRawMode?.(true);
			stdin.resume();

			// Set up input handling
			stdin.on("data", (data: Buffer) => {
				// Handle Ctrl+C gracefully
				if (data[0] === 0x03) {
					this.dispose();
					this.process.exit(0);
				}
				// TODO: Handle other input events
			});
		}

		// Initialize cursor position (async)
		this.initializeCursorPosition();
	}

	/**
	 * Get cursor position to determine commandStart
	 */
	private async getCursorPosition(): Promise<{row: number; col: number}> {
		return new Promise((resolve, reject) => {
			// Check if we have TTY capabilities
			if (!this.process.stdin?.isTTY) {
				// Default to top of screen if not in TTY
				resolve({row: 1, col: 1});
				return;
			}

			// Set raw mode to capture escape sequences
			const stdin = this.process.stdin as TTYReadStream;
			const originalRawMode = (stdin as any).isRaw || false;
			stdin.setRawMode?.(true);
			stdin.resume();

			let response = "";
			const timeout = setTimeout(() => {
				cleanup();
				// Default to reasonable position if timeout
				resolve({row: 1, col: 1});
			}, 100);

			const onData = (data: Buffer) => {
				response += data.toString();

				// Look for cursor position response: \x1b[{row};{col}R
				const match = response.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					cleanup();
					clearTimeout(timeout);
					const row = parseInt(match[1], 10);
					const col = parseInt(match[2], 10);
					resolve({row, col});
				}
			};

			const cleanup = () => {
				stdin.removeListener("data", onData);
				stdin.setRawMode?.(originalRawMode);
				if (!originalRawMode) stdin.pause();
			};

			stdin.on("data", onData);

			// Query cursor position
			this.process.stdout.write("\x1b[6n");
		});
	}

	/**
	 * Initialize cursor position and command height
	 */
	private async initializeCursorPosition(): Promise<void> {
		try {
			const pos = await this.getCursorPosition();
			this.commandStart = pos.row - 1; // Convert to 0-based
			this.commandHeight = this.height - this.commandStart;
		} catch (e) {
			// Default to full screen if detection fails
			this.commandStart = 0;
			this.commandHeight = this.height;
		}
	}

	private async render(mutations = this.observer.takeRecords()): Promise<void> {
		// Process mutations and update layout
		if (mutations.length > 0) {
			this.layoutEngine.calculateLayout();
		}

		// Calculate content height and render start row
		const contentHeight = this.calculateContentHeight();
		this.renderStartRow = Math.max(
			0,
			this.commandStart - (contentHeight - this.commandHeight),
		);

		// Begin new frame
		this.renderer.beginFrame();

		// Render DOM tree to cells with coordinate transformation
		this.renderElement(this.document.documentElement, 0, -this.renderStartRow);

		// Generate ANSI output
		const ansiOutput = this.renderer.render();

		// Calculate expansion newlines if needed
		const expansionNewlines =
			contentHeight > this.commandHeight
				? "\n".repeat(contentHeight - this.commandHeight)
				: "";

		// Combine positioning, content, and expansion
		const fullOutput = ansiOutput + expansionNewlines;

		if (fullOutput) {
			await new Promise<void>((resolve, reject) => {
				this.process.stdout.write(fullOutput, "utf8", (error) => {
					if (error) {
						reject(error);
					} else {
						resolve();

						// Notify any waiting callbacks that rendering is truly complete
						const callbacks = this.renderCompleteCallbacks.splice(0);
						callbacks.forEach((callback) => callback());
					}
				});
			});
		} else {
			// No output to write, but still notify callbacks
			const callbacks = this.renderCompleteCallbacks.splice(0);
			callbacks.forEach((callback) => callback());
		}
	}

	/**
	 * Calculate total content height from layout
	 */
	private calculateContentHeight(): number {
		const body = this.document.body;
		if (!body) return 0;

		// Get the rect of the body element which should contain all content
		const rect = this.layoutEngine.getRect(body);
		if (!rect) return 0;

		// Content height is the bottom of the rect
		// Add 1 because rect is 0-indexed but we need row count
		return Math.ceil(rect.bottom) + 1;
	}

	/**
	 * Convert CSS color value to terminal color number
	 */
	private cssColorToNumber(cssColor: string): number {
		// Handle transparent/empty colors
		if (!cssColor || cssColor === "transparent" || cssColor === "none") {
			return 0;
		}

		// Use Bun.color to convert CSS color string to number
		const colorNumber = Bun.color(cssColor, "number");
		return typeof colorNumber === "number" ? colorNumber : 0;
	}

	private renderElement(element: Element): void {
		// Get computed layout rect from layout engine
		const rect = this.layoutEngine.getRect(element);
		if (!rect) return;

		// Get background color and text styling
		const color = resolvePropertyValue(element, "color");
		const backgroundColor = resolvePropertyValue(element, "background-color");
		// TODO: handle numeric font-weights?
		const bold = resolvePropertyValue(element, "font-weight") === "bold";
		const italic = resolvePropertyValue(element, "font-style") === "italic";
		const underline = resolvePropertyValue(element, "text-decoration").includes(
			"underline",
		);

		const style = {
			// TODO: what about inherit?
			fg:
				color && color !== "initial" ? this.cssColorToNumber(color) : undefined,
			bg:
				backgroundColor && backgroundColor !== "initial"
					? this.cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			italic,
			underline,
			// TODO: add other properties
		};

		// First, fill the entire element's rect with background color (if any)
		if (style.bg) {
			this.renderer.fillRect(
				rect.left,
				rect.top,
				rect.width,
				rect.height,
				style.bg,
			);
		}

		// Recursively render all child nodes in document order
		for (const childNode of element.childNodes) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				// Render child element
				const childElement = childNode as Element;
				if (childElement instanceof (this.window as any).HTMLElement) {
					this.renderElement(childElement);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				// Render text node using its associated layouts
				const textNode = childNode as Text;
				// TODO:
				//const textLayouts = this.layoutEngine.getTextNodeLayouts(textNode);

				//for (const layout of textLayouts) {
				//	debugger;
				//	//console.log({
				//	//	x: layout.rect.x,
				//	//	y: layout.rect.y,
				//	//	width: layout.rect.width,
				//	//	height: layout.rect.height,
				//	//});
				//	this.renderer.setText(
				//		x + layout.rect.x,
				//		y + layout.rect.y,
				//		layout.text,
				//		style,
				//	);
				//}
			}
		}
	}

	/**
	 * Process any pending mutations and render if needed
	 * Returns true if a render was necessary
	 */
	private processPendingMutationsAndRender(): boolean {
		const pendingMutations = this.observer.takeRecords();
		if (pendingMutations.length > 0) {
			this.render(pendingMutations);
			return true;
		}
		return false;
	}

	private handleResize(): void {
		// Update dimensions from current terminal size
		const newWidth = this.process.stdout.columns || 80;
		const newHeight = this.process.stdout.rows || 24;

		// Update internal dimensions
		this.width = newWidth;
		this.height = newHeight;

		// Update window properties
		Object.defineProperty(this.window, "innerWidth", {
			value: newWidth,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(this.window, "innerHeight", {
			value: newHeight,
			writable: false,
			configurable: true,
		});
		this.window._terminalSize = {width: newWidth, height: newHeight};

		// Resize renderer
		this.renderer.resize(newHeight, newWidth);

		// Clear previous buffer to force full redraw
		this.renderer.clearPreviousBuffer();

		// Update command height based on new terminal size
		this.commandHeight = newHeight - this.commandStart;

		// Notify layout engine of size change
		this.layoutEngine.resize(newWidth, newHeight);

		// Re-render with new dimensions
		this.render();
	}

	/**
	 * Initialize HTML extensions by monkey-patching HTMLElement prototype
	 * This should be called once at module initialization
	 */
	private initializeConstructorExtensions(): void {
		const {Element, Document, DOMRect} = this.window;

		// Store reference to TermDOM instance for methods that need it
		const termDOM = this;

		/**
		 * Get element bounds as DOMRect
		 * For elements with multiple rects (inline elements spanning lines),
		 * returns the bounding box that encompasses all rects.
		 */
		Element.prototype.getBoundingClientRect = function (
			this: Element,
		): DOMRect {
			// If element is not in document, return empty rect (like browsers do)
			if (!this.isConnected) {
				return new DOMRect(0, 0, 0, 0);
			}

			// Process any pending mutations and render if needed (like browsers do)
			termDOM.processPendingMutationsAndRender();

			// Get rect from layout engine
			const rect = termDOM.layoutEngine.getRect(this);
			return rect || new DOMRect(0, 0, 0, 0);
		};

		/**
		 * Get all client rectangles for this element
		 * For inline elements spanning multiple lines, returns multiple rects.
		 * For block elements, returns single rect.
		 */
		Element.prototype.getClientRects = function (): DOMRectList {
			// If element is not in document, return empty list
			if (!this.isConnected) {
				return RectUtils.createDOMRectList([]);
			}

			// Process any pending mutations and render if needed (like browsers do)
			termDOM.processPendingMutationsAndRender();

			// Get rects from layout engine and convert to DOMRectList for compatibility
			const rects = termDOM.layoutEngine.getRects(this);
			return RectUtils.createDOMRectList(rects);
		};

		// === Offset Properties ===
		// TODO: Implement offsetX, offsetParent
		// TODO: Implement clientX

		/**
		 * elementFromPoint - Find element at specific coordinates using Yoga layout
		 * This provides hit testing for mouse interaction with elements
		 */
		Document.prototype.elementFromPoint = function (
			x: number,
			y: number,
		): Element | null {
			// Process any pending mutations and render if needed (like browsers do)
			termDOM.processPendingMutationsAndRender();

			return findElementAtPoint(this.documentElement, x, y);
		};
	}

	/**
	 * Setup cleaner console representation for DOM elements in tests
	 */
	private setupDOMInspector(): void {
		const inspect = Symbol.for("nodejs.util.inspect.custom");

		(this.window.Element.prototype as any)[inspect] = function (this: Element) {
			const tag = this.tagName?.toLowerCase() || "element";
			const attrs = Array.from(this.attributes || [])
				.map((attr) => `${attr.name}="${attr.value}"`)
				.join(" ");
			return attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
		};
	}

	public dispose(): void {
		// Restore cooked mode before cleanup
		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		this.observer.disconnect();
		this.layoutEngine.dispose();
		this.jsdom.window.close();
	}

	/** Switch to fullscreen TUI mode */
	public requestFullScreen(): void {
		throw new Error("TODO: Implement fullscreen mode switching");
	}

	/**
	 * Wait for the next render cycle to complete
	 * Useful for testing to ensure DOM mutations have been processed
	 */
	public async waitForRender(): Promise<void> {
		return new Promise((resolve) => {
			// Process mutations and render if needed
			const didRender = this.processPendingMutationsAndRender();

			if (didRender) {
				// Add callback - render already triggered
				this.renderCompleteCallbacks.push(resolve);
			} else {
				// No work to do, resolve immediately
				resolve();
			}
		});
	}
}

/**
 * Helper function to find element at specific point using getClientRects
 * Performs depth-first search to find the deepest element at coordinates
 */
function findElementAtPoint(
	element: Element,
	x: number,
	y: number,
): Element | null {
	// Skip non-HTMLElements (text nodes, etc.)
	if (element.nodeType !== 1) {
		return null;
	}

	// Use getClientRects for accurate hit-testing (handles multi-rect inline elements)
	try {
		const rects = element.getClientRects();
		if (!RectUtils.isPointInAnyRect(x, y, rects)) {
			return null;
		}
	} catch (error) {
		// Element doesn't have layout computed yet, skip it
		return null;
	}

	// Check children first (deepest first)
	const children = Array.from(element.children);
	for (const child of children) {
		const result = findElementAtPoint(child, x, y);
		if (result) {
			return result;
		}
	}

	// If no child contains the point, this element is the target
	return element;
}
