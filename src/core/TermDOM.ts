import {LayoutEngine} from "../layout/LayoutEngine.js";
import {Renderer, type ColorDepth} from "../rendering/Renderer.js";
import {type EventEmitter} from "events";
import {JSDOM} from "jsdom";
import {type DOMWindow} from "jsdom";
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
 * This interface attempts to document the minimal API needed from the process
 * object to implement a terminal renderer, so that we can mock it for tests.
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
		const observer = new this.window.MutationObserver(() => this.render());
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
	}

	private async render(): Promise<void> {
		// Always calculate layout to ensure it's up to date
		this.layoutEngine.calculateLayout();

		// Begin new frame
		this.renderer.beginFrame();

		// Render DOM tree to cells with coordinate transformation
		this.renderElement(this.document.documentElement);

		// Generate ANSI output
		const ansiOutput = this.renderer.render();

		// Output directly without expansion
		const fullOutput = ansiOutput;

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
			fg:
				color && color !== "initial" ? this.cssColorToNumber(color) : undefined,
			bg:
				backgroundColor &&
				backgroundColor !== "initial" &&
				backgroundColor !== "transparent"
					? this.cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			italic,
			underline,
			// TODO: add other properties
		};

		// First, fill the entire element's rect with background color (if any)
		if (rect && style.bg != null) {
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
				// Render text node using rects from inline layout
				const textNode = childNode as Text;
				const textContent = textNode.textContent;
				if (!textContent) continue;

				// Get style from the text node's parent element
				const parentElement = textNode.parentElement;
				if (!parentElement) continue;

				const textColor = resolvePropertyValue(parentElement, "color");
				const textBgColor = resolvePropertyValue(
					parentElement,
					"background-color",
				);
				const textBold =
					resolvePropertyValue(parentElement, "font-weight") === "bold";
				const textItalic =
					resolvePropertyValue(parentElement, "font-style") === "italic";
				const textUnderline = resolvePropertyValue(
					parentElement,
					"text-decoration",
				).includes("underline");

				const textStyle = {
					fg:
						textColor && textColor !== "initial"
							? this.cssColorToNumber(textColor)
							: undefined,
					bg:
						textBgColor &&
						textBgColor !== "initial" &&
						textBgColor !== "transparent"
							? this.cssColorToNumber(textBgColor)
							: undefined,
					bold: textBold,
					italic: textItalic,
					underline: textUnderline,
				};

				// Get rects for this text node
				const rects = this.layoutEngine.getRects(textNode) as Array<
					DOMRect & {text?: string}
				>;
				if (rects.length > 0) {
					// Render each text segment
					for (const textRect of rects) {
						if (textRect.text) {
							this.renderer.setText(
								Math.round(textRect.x),
								Math.round(textRect.y),
								textRect.text,
								textStyle,
							);
						}
					}
				}
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
			this.render();
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
	setupDOMInspector(): void {
		const inspect = Symbol.for("nodejs.util.inspect.custom");

		(this.window.Element.prototype as any)[inspect] = function (this: Element) {
			const tag = this.tagName?.toLowerCase() || "element";
			const attrs = Array.from(this.attributes || [])
				.map((attr) => `${attr.name}="${attr.value}"`)
				.join(" ");
			return attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
		};
	}

	dispose(): void {
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
	requestFullScreen(): void {
		throw new Error("TODO: Implement fullscreen mode switching");
	}

	/**
	 * Wait for the next render cycle to complete
	 * Useful for testing to ensure DOM mutations have been processed
	 */
	async waitForRender(): Promise<void> {
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
