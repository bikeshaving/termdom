import {LayoutEngine} from "../layout/LayoutEngine.js";
import {Renderer} from "../rendering/Renderer.js";
import {type ColorDepth} from "../rendering/ANSIGenerator.js";
import {EventEmitter} from "events";
import {JSDOM} from "jsdom";
import type {DOMWindow} from "jsdom";
import type * as Yoga from "yoga-layout";
import {RectUtils} from "../layout/RectUtils.js";

// Symbol properties for storing layout data
export const ELEMENT_BOUNDS = Symbol("elementBounds"); // Single bounding rect for all elements
export const ELEMENT_RECTS = Symbol("elementRects"); // Multiple rects for inline elements spanning lines
export const ELEMENT_TEXT_RECTS = Symbol("elementTextRects"); // Text content for each rect in ELEMENT_RECTS
export const YOGA_NODE = Symbol("yogaNode"); // Yoga layout node (block/flex elements only)

// TODO: let’s avoid exstending DOMRect and create a composition instead
// Interface for text rectangles with content
export interface TextRect extends DOMRect {
	text: string; // The text content for this line fragment
}

// Augment global DOM types with our extensions
declare global {
	interface Element {
		[ELEMENT_BOUNDS]?: DOMRect;
		[ELEMENT_RECTS]?: DOMRect[];
		[ELEMENT_TEXT_RECTS]?: TextRect[];
		[YOGA_NODE]?: Yoga.Node;
	}
}

/**
 * Minimal TTY-like interface for what TermDOM actually needs
 */
export interface TTYWriteStream extends EventEmitter {
	write(
		chunk: any,
		encoding?: BufferEncoding | ((error?: Error) => void),
		callback?: (error?: Error) => void,
	): boolean;
	columns: number;
	rows: number;
	isTTY: boolean;
}

export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
}

/**
 * Process-like interface for dependency injection
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
	/** Render mode: 'flow' for inline CLI output, 'fullscreen' for TUI apps */
	mode?: "flow" | "fullscreen";
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

	private readonly width: number;
	private readonly height: number;
	private readonly mode: "flow" | "fullscreen";
	private readonly process: ProcessLike;

	// Dirty tracking for efficient layout updates
	private readonly dirtyRoots = new Set<HTMLElement>();
	private initialLayoutComputed = false;

	// Render completion callbacks for waitForRender
	private renderCompleteCallbacks: Array<() => void> = [];
	// Track processed elements to prevent duplicates
	private processedElements = new WeakSet<HTMLElement>();

	constructor(options: TermDOMOptions = {}) {
		// Set up process (defaults to global process)
		this.process = options.process || process;

		// Set up dimensions
		this.width = options.width || this.process.stdout.columns || 80;
		this.height = options.height || this.process.stdout.rows || 24;
		this.mode = options.mode || "flow";

		// Create JSDOM instance
		this.jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{
				pretendToBeVisual: true,
				resources: "usable",
			},
		);

		// Extract window and document
		this.document = this.jsdom.window.document;
		this.window = this.jsdom.window;

		// Setup cleaner console representation for DOM elements
		this.setupDOMInspector();

		// Initialize HTML extensions
		this.initializeHTMLExtensions();

		// Create renderer with our new clean implementation
		this.renderer = new Renderer(
			this.height,
			this.width,
			options.colorDepth || "rgb",
		);

		// Create layout engine
		this.layoutEngine = new LayoutEngine(this.jsdom.window);

		// Set up window properties and DOM
		this.initializeWindow();
		this.initializeDocument();

		// Set up automatic rendering via MutationObserver
		this.observer = this.setupMutationObserver();

		// Initialize Yoga nodes for initial DOM tree
		this.initializeYogaTree();

		// Set up process handlers
		this.setupProcessHandlers();
	}

	private initializeWindow(): void {
		const window = this.window as any;

		// Make layout engine and terminal size available
		window._layoutEngine = this.layoutEngine;
		window._terminalSize = {width: this.width, height: this.height};

		// Set CSSOM-compliant window dimensions
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

		// Expose internal methods for layout system
		window._processPendingMutations = this.processPendingMutations.bind(this);
		window._dirtyRoots = this.dirtyRoots;
		window._computeLayoutIfNeeded = this.computeLayoutIfNeeded.bind(this);
	}

	private initializeDocument(): void {
		const document = this.document;

		// Reset default browser styles for consistent terminal behavior
		document.documentElement.style.setProperty("margin", "0");
		document.documentElement.style.setProperty("padding", "0");
		document.body.style.setProperty("margin", "0");
		document.body.style.setProperty("padding", "0");

		// Use flexbox layout (required for Yoga engine)
		document.documentElement.style.setProperty("display", "flex");
		document.documentElement.style.setProperty("flex-direction", "column");
		document.body.style.setProperty("display", "flex");
		document.body.style.setProperty("flex-direction", "column");
		document.body.style.setProperty("flex", "1");
	}

	private setupMutationObserver(): MutationObserver {
		const observer = new this.window.MutationObserver(
			(mutations: MutationRecord[]) => {
				// Store mutations and mark for rendering - don't process immediately
				// Processing happens in render() or when getBoundingClientRect is called
				this.render();
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

	/**
	 * Initialize Yoga nodes for the initial DOM tree
	 */
	private initializeYogaTree(): void {
		// Start with document.documentElement - this will recursively handle all children
		this.handleElementAdded(
			this.document.documentElement as HTMLElement,
			null as any,
		);
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
	}

	private async render(): Promise<void> {
		// Process pending mutations to mark dirty nodes
		this.processPendingMutations();

		// Compute layout if needed
		this.computeLayoutIfNeeded();

		// Begin new frame
		this.renderer.beginFrame();

		// Render DOM tree to cells
		this.renderElement(this.document.documentElement, 0, 0);

		// Generate ANSI output and write to terminal
		const ansiOutput = this.renderer.render();
		if (ansiOutput) {
			await new Promise<void>((resolve, reject) => {
				this.process.stdout.write(ansiOutput, "utf8", (error) => {
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
		if (!cssColor || cssColor === 'transparent' || cssColor === 'none') {
			return 0;
		}

		// Use Bun.color to convert CSS color string to number
		const colorNumber = Bun.color(cssColor, "number");
		return typeof colorNumber === 'number' ? colorNumber : 0;
	}

	private renderElement(element: Element, x: number, y: number): void {
		// Get computed layout bounds
		const bounds = element[ELEMENT_BOUNDS];
		if (!bounds) return;

		// Get background color and text styling
		const computedStyle = (this.window as any).getComputedStyle(element);
		const color = computedStyle.color;
		const backgroundColor = computedStyle.backgroundColor;
		const bold =
			computedStyle.fontWeight === "bold" ||
			parseInt(computedStyle.fontWeight) >= 600;
		const italic = computedStyle.fontStyle === "italic";
		const underline = computedStyle.textDecoration?.includes("underline");

		// Determine effective background color - walk up DOM tree for transparent backgrounds
		const effectiveBg = this.getEffectiveBackgroundColor(element);

		const style = {
			fg: color && color !== "initial" ? this.cssColorToNumber(color) : undefined,
			bg: effectiveBg && effectiveBg !== "initial" ? this.cssColorToNumber(effectiveBg) : undefined,
			bold,
			italic,
			underline,
		};

		// First, fill the entire element's bounding box with background color (if any)
		if (style.bg) {
			this.renderer.fillRect(
				x + bounds.left,
				y + bounds.top,
				bounds.width,
				bounds.height,
				{bg: style.bg},
			);
		}

		// Then render text content on top, using proper Unicode width calculation
		// Check if element has TEXT_RECTS (wrapped text with content)
		if (element[ELEMENT_TEXT_RECTS] && element[ELEMENT_TEXT_RECTS].length > 0) {
			// Element has wrapped text with pre-calculated content - use it directly
			const textRects = element[ELEMENT_TEXT_RECTS];
			for (const textRect of textRects) {
				this.renderer.setText(
					x + textRect.x,
					y + textRect.y,
					textRect.text,
					style,
				);
			}
		} else if (element[ELEMENT_RECTS] && element[ELEMENT_RECTS].length > 1) {
			// Fallback: Element has multiple rects but no text content stored
			// This shouldn't happen in normal flow but keep for safety
			const textContent = this.getTextContent(element);
			if (textContent) {
				const breakResult = this.layoutEngine.textBreaker.breakText(
					textContent,
					{
						maxWidth: bounds.width,
						breakWords: true,
					},
				);

				const rects = element[ELEMENT_RECTS];
				for (let i = 0; i < breakResult.lines.length && i < rects.length; i++) {
					const line = breakResult.lines[i];
					const rect = rects[i];
					this.renderer.setText(x + rect.x, y + rect.y, line.text, style);
				}
			}
		} else {
			// Single rect - render normally
			const textContent = this.getTextContent(element);
			if (textContent) {
				const lines = textContent.split("\n");
				for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
					const line = lines[lineIdx];
					const renderY = y + bounds.top + lineIdx;
					const renderX = x + bounds.left;

					// Use the high-level setText method with automatic wide character handling
					this.renderer.setText(renderX, renderY, line, style);
				}
			}
		}

		// Recursively render children
		for (const child of element.children) {
			if (child instanceof (this.window as any).HTMLElement) {
				this.renderElement(child, x, y);
			}
		}
	}

	/**
	 * Walk up the DOM tree to find the effective background color
	 * Mimics CSS background inheritance behavior
	 */
	private getEffectiveBackgroundColor(element: Element): string | undefined {
		let current: Element | null = element;
		while (current) {
			const computedStyle = this.window.getComputedStyle(current);
			const bgColor = computedStyle.backgroundColor;

			// If this element has a non-transparent background, use it
			if (
				bgColor &&
				bgColor !== "initial" &&
				bgColor !== "rgba(0, 0, 0, 0)" &&
				bgColor !== "transparent"
			) {
				return bgColor;
			}

			// Move up to parent element
			current = current.parentElement;
		}

		// No background found up the tree
		return undefined;
	}

	private getTextContent(element: HTMLElement): string {
		// Get direct text content, not including children
		let text = "";
		for (const node of element.childNodes) {
			if (node.nodeType === (this.window as any).Node.TEXT_NODE) {
				text += node.textContent || "";
			}
		}
		return text;
	}

	private computeLayoutIfNeeded(): void {
		if (!this.initialLayoutComputed || this.dirtyRoots.size > 0) {
			this.layoutEngine.computeLayout(
				this.document.documentElement,
				this.width,
				this.height,
				!this.initialLayoutComputed, // isInitialLayout
			);
			this.dirtyRoots.clear();
			this.initialLayoutComputed = true;
		}
	}

	private processPendingMutations(
		mutations: MutationRecord[] = this.observer.takeRecords(),
	): void {
		if (mutations.length === 0) return;

		// Process mutations to find dirty nodes
		for (const mutation of mutations) {
			let targetElement: HTMLElement | null = null;

			if (mutation.target instanceof (this.window as any).HTMLElement) {
				targetElement = mutation.target;
			} else if (
				mutation.type === "characterData" &&
				mutation.target.nodeType === (this.window as any).Node.TEXT_NODE
			) {
				targetElement = mutation.target.parentElement as HTMLElement;
			}

			if (!targetElement) continue;

			if (
				mutation.type === "attributes" &&
				mutation.attributeName === "style"
			) {
				this.markDirtySingle(targetElement);
			} else if (mutation.type === "childList") {
				// Handle removed nodes first - clean up old parent relationships
				for (const removedNode of mutation.removedNodes) {
					if (removedNode.nodeType === this.window.Node.ELEMENT_NODE) {
						this.handleElementRemoved(removedNode as HTMLElement);
					}
				}

				// Handle added nodes second - create new parent relationships
				for (const addedNode of mutation.addedNodes) {
					if (addedNode.nodeType === this.window.Node.ELEMENT_NODE) {
						this.handleElementAdded(addedNode as HTMLElement, targetElement);
					}
				}

				// Mark parent dirty since child structure changed
				this.markDirtySingle(targetElement);
			} else if (mutation.type === "characterData") {
				this.markDirtySingle(targetElement);
			}
		}

		this.pruneRedundantDirtyRoots();
	}

	/**
	 * Handle element added to DOM - create Yoga node if it's a block-like element
	 */
	private handleElementAdded(element: HTMLElement, parent: HTMLElement): void {
		// Skip if already processed (prevent duplicate processing)
		if (this.processedElements.has(element)) {
			return;
		}

		// Mark as processed immediately
		this.processedElements.add(element);

		// Determine if this element should have a Yoga node
		const computedStyle = this.window.getComputedStyle(element);
		const display = computedStyle.display;

		if (display === "inline" || display === "inline-block" || display === "") {
			// Inline elements don't get Yoga nodes - handled by text layout
			return;
		}

		// Create Yoga node for this element
		this.layoutEngine.setupYogaNode(element);

		// Attach to parent's Yoga tree if parent has a Yoga node
		if (parent && parent[YOGA_NODE] && element[YOGA_NODE]) {
			this.attachYogaNodeToParent(element, parent);
		}

		// Recursively handle any existing children (for initial DOM build)
		for (const child of element.children) {
			if (child.nodeType === this.window.Node.ELEMENT_NODE) {
				this.handleElementAdded(child as HTMLElement, element);
			}
		}
	}

	/**
	 * Handle element removed from DOM - destroy Yoga node
	 */
	private handleElementRemoved(element: HTMLElement): void {
		if (!element[YOGA_NODE]) return;

		const yogaNode = element[YOGA_NODE];

		// Remove from parent if it has one
		const parent = yogaNode.getParent();
		if (parent) {
			parent.removeChild(yogaNode);
		}

		// Recursively clean up children
		this.layoutEngine.clearYogaNodes(element);
	}

	/**
	 * Attach element's Yoga node to parent's Yoga node at correct position
	 */
	private attachYogaNodeToParent(
		element: HTMLElement,
		parent: HTMLElement,
	): void {
		const parentYoga = parent[YOGA_NODE];
		const elementYoga = element[YOGA_NODE];

		if (!parentYoga || !elementYoga) return;

		// Find the correct insertion index based on DOM order
		let insertIndex = 0;
		const siblings = Array.from(parent.children) as HTMLElement[];
		const elementIndex = siblings.indexOf(element);

		for (let i = 0; i < elementIndex; i++) {
			if (siblings[i][YOGA_NODE]) {
				insertIndex++;
			}
		}

		// Only insert if not already a child of this parent
		if (elementYoga.getParent() !== parentYoga) {
			parentYoga.insertChild(elementYoga, insertIndex);
		}
	}

	private markDirtySingle(element: HTMLElement): void {
		if (!element[YOGA_NODE]) {
			const parent = element.parentElement as HTMLElement;
			if (parent && parent[YOGA_NODE]) {
				delete element[ELEMENT_BOUNDS];
				delete element[ELEMENT_RECTS];
				if (!this.isAncestorDirty(parent)) {
					this.dirtyRoots.add(parent);
				}
			}
			return;
		}

		if (this.isAncestorDirty(element)) return;
		this.dirtyRoots.add(element);
	}

	private markDirtyWithBubbling(element: HTMLElement): void {
		let current: HTMLElement | null = element;

		while (current && current[YOGA_NODE]) {
			if (this.dirtyRoots.has(current)) break;
			this.dirtyRoots.add(current);
			current = current.parentElement;
		}
	}

	private isAncestorDirty(element: HTMLElement): boolean {
		let current: HTMLElement | null = element.parentElement;
		while (current) {
			if (this.dirtyRoots.has(current)) return true;
			current = current.parentElement;
		}
		return false;
	}

	private pruneRedundantDirtyRoots(): void {
		const toRemove = new Set<HTMLElement>();

		for (const root of this.dirtyRoots) {
			if (this.isAncestorDirty(root)) {
				toRemove.add(root);
			}
		}

		for (const element of toRemove) {
			this.dirtyRoots.delete(element);
		}
	}

	private handleResize(): void {
		// For now, just re-render with current dimensions
		// TODO: Implement proper resize handling
		this.render();
	}

	/**
	 * Initialize HTML extensions by monkey-patching HTMLElement prototype
	 * This should be called once at module initialization
	 */
	private initializeHTMLExtensions(): void {
		const {HTMLElement, Document, DOMRect} = this.window;

		// Store reference to TermDOM instance for methods that need it
		const termdom = this;

		// === DOM Layout APIs (Yoga-powered) ===

		/**
		 * Get element bounds as DOMRect
		 * For elements with multiple rects (inline elements spanning lines),
		 * returns the bounding box that encompasses all rects.
		 */
		HTMLElement.prototype.getBoundingClientRect = function (
			this: HTMLElement,
		): DOMRect {
			// If element is not in document, return empty rect (like browsers do)
			if (!this.isConnected) {
				return new DOMRect(0, 0, 0, 0);
			}

			// Process any pending mutations first (like browsers do)
			const processPendingMutations = (termdom.window as any)
				._processPendingMutations;
			const computeLayoutIfNeeded = (termdom.window as any)
				._computeLayoutIfNeeded;

			if (processPendingMutations) {
				processPendingMutations();
			}

			// Now compute layout only if there are dirty nodes
			if (computeLayoutIfNeeded) {
				computeLayoutIfNeeded();
			}

			// Check for multiple rects first (inline elements)
			if (this[ELEMENT_RECTS] && this[ELEMENT_RECTS].length > 0) {
				return RectUtils.computeBoundingRect(
					this[ELEMENT_RECTS],
					termdom.window,
				);
			}

			// Fall back to single rect (block/flex elements)
			if (!this[ELEMENT_BOUNDS]) {
				throw new Error(
					"Layout computation did not set ELEMENT_BOUNDS for element",
				);
			}

			return this[ELEMENT_BOUNDS];
		};

		/**
		 * Get all client rectangles for this element
		 * For inline elements spanning multiple lines, returns multiple rects.
		 * For block elements, returns single rect.
		 */
		HTMLElement.prototype.getClientRects = function (): DOMRectList {
			// If element is not in document, return empty list
			if (!this.isConnected) {
				return RectUtils.createDOMRectList([]);
			}

			// Process mutations and compute layout (same as getBoundingClientRect)
			const processPendingMutations = (termdom.window as any)
				._processPendingMutations;
			const computeLayoutIfNeeded = (termdom.window as any)
				._computeLayoutIfNeeded;

			if (processPendingMutations) {
				processPendingMutations();
			}

			if (computeLayoutIfNeeded) {
				computeLayoutIfNeeded();
			}

			// Return multiple rects if available (inline elements)
			if (this[ELEMENT_RECTS] && this[ELEMENT_RECTS].length > 0) {
				return RectUtils.createDOMRectList(this[ELEMENT_RECTS]);
			}

			// Fall back to single rect (block/flex elements)
			if (this[ELEMENT_BOUNDS]) {
				return RectUtils.createDOMRectList([this[ELEMENT_BOUNDS]]);
			}

			// No layout computed yet
			throw new Error("Layout computation did not set element bounds");
		};

		// === Offset Properties ===

		Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
			get: function (this: HTMLElement) {
				if (!this.isConnected) return 0;
				return this.getBoundingClientRect().x;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "offsetTop", {
			get: function (this: HTMLElement) {
				if (!this.isConnected) return 0;
				return this.getBoundingClientRect().y;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
			get: function (this: HTMLElement) {
				if (!this.isConnected) return 0;
				return this.getBoundingClientRect().width;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
			get: function (this: HTMLElement) {
				if (!this.isConnected) return 0;
				return this.getBoundingClientRect().height;
			},
			enumerable: true,
			configurable: true,
		});

		// === Client Properties ===

		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			get: function (this: HTMLElement) {
				if (!this.isConnected) return 0;
				// For terminals, client area is same as offset (no borders/scrollbars)
				return this.getBoundingClientRect().width;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			get: function (this: HTMLElement) {
				if (!this.isConnected) return 0;
				// For terminals, client area is same as offset (no borders/scrollbars)
				return this.getBoundingClientRect().height;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "clientLeft", {
			get: function (this: HTMLElement) {
				// No borders in terminal context
				return 0;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "clientTop", {
			get: function (this: HTMLElement) {
				// No borders in terminal context
				return 0;
			},
			enumerable: true,
			configurable: true,
		});

		// === Scroll Properties ===

		Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
			get: function (this: HTMLElement) {
				// TODO: Return actual content width when scrolling is implemented
				return this.clientWidth;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
			get: function (this: HTMLElement) {
				// TODO: Return actual content height when scrolling is implemented
				return this.clientHeight;
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
			get: function (this: HTMLElement) {
				// TODO: Implement when we add scrolling
				return 0;
			},
			set: function (this: HTMLElement, _value: number) {
				// TODO: Implement when we add scrolling
			},
			enumerable: true,
			configurable: true,
		});

		Object.defineProperty(HTMLElement.prototype, "scrollTop", {
			get: function (this: HTMLElement) {
				// TODO: Implement when we add scrolling
				return 0;
			},
			set: function (this: HTMLElement, _value: number) {
				// TODO: Implement when we add scrolling
			},
			enumerable: true,
			configurable: true,
		});

		// === Document API Extensions ===

		/**
		 * elementFromPoint - Find element at specific coordinates using Yoga layout
		 * This provides hit testing for mouse interaction with elements
		 */
		Document.prototype.elementFromPoint = function (
			x: number,
			y: number,
		): Element | null {
			// Process any pending mutations first (like browsers do)
			const processPendingMutations = (termdom.window as any)
				._processPendingMutations;
			const computeLayoutIfNeeded = (termdom.window as any)
				._computeLayoutIfNeeded;

			if (processPendingMutations) {
				processPendingMutations();
			}

			// Now compute layout only if there are dirty nodes
			if (computeLayoutIfNeeded) {
				computeLayoutIfNeeded();
			}

			return findElementAtPoint(this.documentElement, x, y);
		};

		// === Element Navigation APIs ===

		/**
		 * Check if this element contains another element
		 */
		HTMLElement.prototype.contains = function (other: Node | null): boolean {
			if (!other || other === this) return other === this;

			let current: Node | null = other;
			while (current && current !== this) {
				current = current.parentNode;
			}
			return current === this;
		};

		/**
		 * Find closest ancestor matching selector
		 * For now, just supports simple tag name selectors
		 */
		HTMLElement.prototype.closest = function (
			selector: string,
		): Element | null {
			let current: Element | null = this;

			// Simple tag name matching (can be enhanced later)
			const tagName = selector.toUpperCase();

			while (current) {
				if (current.tagName === tagName) {
					return current;
				}
				current = current.parentElement;
			}
			return null;
		};
	}

	/**
	 * Setup cleaner console representation for DOM elements in tests
	 */
	private setupDOMInspector(): void {
		const inspect = Symbol.for("nodejs.util.inspect.custom");

		this.window.HTMLElement.prototype[inspect] = function () {
			const tag = this.tagName?.toLowerCase() || "element";
			const attrs = Array.from(this.attributes || [])
				.map((attr) => `${attr.name}="${attr.value}"`)
				.join(" ");
			return attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
		};
	}

	public dispose(): void {
		this.observer.disconnect();
		this.renderer.dispose();
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
			// Check if there are pending mutations or dirty nodes (without consuming them)
			const pendingMutations = this.observer.takeRecords();
			const hasDirtyNodes = this.dirtyRoots.size > 0;

			if (pendingMutations.length > 0) {
				// There are pending mutations, need to process them
				this.processPendingMutations(pendingMutations);

				// Add callback and trigger render
				this.renderCompleteCallbacks.push(resolve);
				this.render();
			} else if (hasDirtyNodes) {
				// There are dirty nodes but no new mutations, still need to render
				this.renderCompleteCallbacks.push(resolve);
				this.render();
			} else if (!this.initialLayoutComputed) {
				// Initial layout not computed yet, need to render
				this.renderCompleteCallbacks.push(resolve);
				this.render();
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

	const htmlElement = element;

	// Use getClientRects for accurate hit-testing (handles multi-rect inline elements)
	try {
		const rects = htmlElement.getClientRects();
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
