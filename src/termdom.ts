import {type EventEmitter} from "events";
import {type DOMWindow, JSDOM} from "jsdom";
import {LayoutEngine, isPointInRects} from "./layout.js";
import {type ColorDepth, Renderer} from "./ansi.js";
import {StyleManager, resolveBorderStyles, cssColorToNumber, getBoxModel} from "./styles.js";
import {FullscreenManager} from "./fullscreen.js";
import {setupInspectMethods} from "./inspector.js";
import {ScrollingManager} from "./scrolling.js";
import {
	createExpandedTreeWalker,
	type ExpandedTreeWalker,
	getShadowRoot,
	hasShadowRoot,
	initializeShadowDOM,
	getPseudoMetadata,
} from "./composition.js";

function detectColorDepth(process: ProcessLike): ColorDepth {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "rgb";
	}

	const term = process.env.TERM || "";
	if (term.includes("256color") || term.includes("256")) {
		return "256";
	}

	return "ansi";
}

// TODO: Can we use web streams (WritableStream)
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

// TODO: Can we use web streams (ReadableStream) or at least track what events we're using?
export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
	setEncoding?(encoding?: string): this;
}

export interface ProcessLike extends EventEmitter {
	stdin?: TTYReadStream;
	stdout: TTYWriteStream;
	exit(code?: number): never;
	env: Record<string, string | undefined>;
}

export interface TermDOMOptions {
	width?: number;
	height?: number;
	colorDepth?: ColorDepth;
	process?: ProcessLike;
}

export class TermDOM {
	public readonly document: Document;
	public readonly window: DOMWindow;

	private readonly renderer: Renderer;
	private readonly layoutEngine: LayoutEngine;
	// TODO: Should we expose the JSDOM instance?
	private readonly jsdom: JSDOM;
	private readonly observer: MutationObserver;
	private readonly fullscreenManager: FullscreenManager;
	public readonly styleManager: StyleManager;
	private readonly scrollingManager: ScrollingManager;

	// Guard against re-entrant rendering
	private isRendering = false;

	// Track whether command start was explicitly detected (even if at row 1)
	private hasDetectedCommandStart: boolean = false;

	// Unified stdin handling
	private cursorDetectionHandler: ((data: string) => void) | null = null;

	// Promise that resolves when cursor detection completes (or times out)
	private cursorDetectionPromise: Promise<void> | null = null;

	private width: number;
	private height: number;
	// TODO: use this
	private readonly mode: "flow" | "fullscreen";
	private readonly process: ProcessLike;

	constructor(options: TermDOMOptions = {}) {
		this.process = options.process || process;

		this.width = options.width || this.process.stdout.columns || 80;
		this.height = options.height || this.process.stdout.rows || 24;
		this.mode = "flow";

		this.jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{pretendToBeVisual: true},
		);

		this.window = this.jsdom.window;
		this.document = this.jsdom.window.document;

		// Setup DOM inspector
		setupInspectMethods(this.window);

		// Setup shadow DOM support
		initializeShadowDOM(this.window);

		this.initializeConstructorExtensions();
		this.renderer = new Renderer(
			this.height,
			this.width,
			options.colorDepth || detectColorDepth(this.process),
		);

		// Setup style management FIRST to override getComputedStyle before LayoutEngine uses it
		this.styleManager = new StyleManager(this.window);

		// Create layout engine after StyleManager overrides getComputedStyle
		this.layoutEngine = new LayoutEngine(this.jsdom.window);
		this.styleManager.setLayoutEngine(this.layoutEngine);
		this.layoutEngine.resize(this.width, this.height);
		this.fullscreenManager = new FullscreenManager(this.process);

		this.initializeWindow();

		// Initialize scrolling management after window setup
		this.scrollingManager = new ScrollingManager(this.window, this.document);

		this.observer = this.setupMutationObserver();

		this.setupProcessHandlers();

		// Initial processing of all elements is handled by StyleManager's constructor

		// Initialize cursor position detection if in a TTY environment
		this.initializeCursorDetection();
	}

	/**
	 * Get cached shadow root for an element (works with both open and closed shadows)
	 */
	getShadowRoot(element: Element): ShadowRoot | null {
		return getShadowRoot(element);
	}

	/**
	 * Check if an element has a shadow root
	 */
	hasShadowRoot(element: Element): boolean {
		return hasShadowRoot(element);
	}

	/**
	 * Create an ExpandedTreeWalker that can traverse pseudo-elements, shadow DOM, and slot content
	 */
	createExpandedTreeWalker(root: Node): ExpandedTreeWalker {
		return createExpandedTreeWalker(this.window, root);
	}

	private initializeWindow(): void {
		const window = this.window;
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

		// Initialize screenTop for terminal viewport positioning (readonly like browsers)
		Object.defineProperty(window, "screenTop", {
			value: 0,
			writable: false,
			configurable: true,
			enumerable: true,
		});

		// Implement standard DOM scrollHeight properties
		const termDOM = this;
		Object.defineProperty(this.document.body, "scrollHeight", {
			get() {
				return termDOM.layoutEngine.getContentHeight();
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.document.documentElement, "scrollHeight", {
			get() {
				return termDOM.layoutEngine.getContentHeight();
			},
			configurable: true,
			enumerable: true,
		});

		// clientHeight is the viewport height (terminal height)
		Object.defineProperty(this.document.body, "clientHeight", {
			get() {
				return termDOM.height;
			},
			configurable: true,
			enumerable: true,
		});

		Object.defineProperty(this.document.documentElement, "clientHeight", {
			get() {
				return termDOM.height;
			},
			configurable: true,
			enumerable: true,
		});
	}

	private setupMutationObserver(): MutationObserver {
		const observer = new this.window.MutationObserver((mutations) => {
			// Process mutations in correct order to avoid race conditions
			this.styleManager.handleMutations(mutations); // First: attach pseudo-elements, invalidate caches
			this.layoutEngine.handleMutations(mutations); // Second: process DOM changes for layout
			this.render(); // Finally: render with fully processed DOM
		});

		observer.observe(this.document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});

		return observer;
	}

	// TODO: This should be put in an event translator abstraction
	private setupProcessHandlers(): void {
		const cleanup = () => this.dispose();
		this.process.on("SIGINT", () => {
			cleanup();
			this.process.exit(0);
		});

		this.process.on("SIGWINCH", () => {
			this.handleResize();
		});

		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin;
			if (!stdin) return;

			// Configure terminal for proper input handling (once)
			stdin.setRawMode?.(true);
			stdin.resume();
			stdin.setEncoding?.("utf8");

			// Single unified handler for all stdin data
			stdin.on("data", (chunk: string | Buffer) => {
				// Ensure we have both string and buffer representations
				const data = Buffer.isBuffer(chunk)
					? chunk
					: Buffer.from(chunk, "utf8");
				const dataStr = data.toString("utf8");

				// Route 1: Cursor position responses (highest priority)
				if (this.cursorDetectionHandler && dataStr.match(/\x1b\[\d+;\d+R/)) {
					this.cursorDetectionHandler(dataStr);
					return;
				}

				// Route 2: Ctrl-C handling (high priority) - check raw bytes
				if (data.length > 0 && data[0] === 0x03) {
					this.dispose();
					return this.process.exit(0);
				}

				// TODO: Why does this filter on fullscreen????
				// Route 3: General keyboard events (when not in fullscreen)
				if (!this.fullscreenManager.isFullscreen) {
					this.dispatchGlobalKeyboardEvent(data);
				}
			});
		}
	}

	async render(): Promise<void> {
		// Prevent re-entrant rendering
		if (this.isRendering) {
			return;
		}
		// Wait for cursor detection to complete before first render
		if (this.cursorDetectionPromise) {
			//await this.cursorDetectionPromise;
		}

		// Process any pending mutations first (for direct render() calls)
		const pendingMutations = this.observer.takeRecords();
		if (pendingMutations.length > 0) {
			this.styleManager.handleMutations(pendingMutations);
			this.layoutEngine.handleMutations(pendingMutations);
		}

		this.isRendering = true;
		// Clear the rendered markers set for this frame
		this.renderedOutsideMarkers = new WeakSet<Element>();
		
		// Note: refreshStylesheets() is called by mutation observer when stylesheets change

		// Always use auto height for natural content sizing and scrolling
		this.layoutEngine.calculateLayout();

		// Calculate push-up offset if command start was detected
		if (this.hasDetectedCommandStart) {
			this.calculatePushUpOffset();
		}
		// Get viewport offset from raw internal scrollTop
		// When cursor is detected, content starts at buffer row 0 (cursor positioning handles terminal placement)
		const viewportOffset = this.hasDetectedCommandStart
			? 0
			: -this.scrollingManager.getScrollTop();

		// When cursor is detected, pass the cursor position explicitly
		const cursorPosition = this.hasDetectedCommandStart
			? this.scrollingManager.getScreenTop()
			: undefined;

		const ansi = this.renderer.renderFrame(
			viewportOffset,
			(ctx) => {
				this.renderElement(this.document.body, ctx);
			},
			cursorPosition,
		);

		if (ansi) {
			await new Promise<void>((resolve, reject) => {
				this.process.stdout.write(ansi, "utf8", (error) => {
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				});
			});
		}

		this.isRendering = false;
	}

	// TODO: many of the following methods do not belong on the TermDOM class
	private renderElement(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const rect = this.layoutEngine.getRect(element);

		const color = this.window
			.getComputedStyle(element)
			.getPropertyValue("color");
		const backgroundColor = this.window
			.getComputedStyle(element)
			.getPropertyValue("background-color");
		const bold =
			this.window.getComputedStyle(element).getPropertyValue("font-weight") ===
			"bold";
		const italic =
			this.window.getComputedStyle(element).getPropertyValue("font-style") ===
			"italic";
		const underline = this.window
			.getComputedStyle(element)
			.getPropertyValue("text-decoration")
			.includes("underline");

		const style = {
			fg: color && color !== "initial" ? cssColorToNumber(color) : undefined,
			bg:
				backgroundColor &&
				backgroundColor !== "initial" &&
				backgroundColor !== "transparent"
					? cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			italic,
			underline,
		};

		if (rect && style.bg != null) {
			ctx.fillRect(rect.left, rect.top, rect.width, rect.height, style.bg);
		}

		// Handle tables with TanStack integration
		const display = this.window
			.getComputedStyle(element)
			.getPropertyValue("display");
		if (display === "table" && rect) {
			this.renderTable(element, rect, style);
			// Continue with normal child rendering
		}

		// Handle borders
		if (rect) {
			const borderStyles = resolveBorderStyles(element);
			if (borderStyles.hasAnyBorder) {
				// Use foreground color for borders, inherit element's background color
				const borderCellStyle = {
					fg: style.fg || 0xffffff, // Default to white if no color
					bg: style.bg, // Inherit element's background color
				};
				ctx.drawBorder(
					Math.round(rect.left),
					Math.round(rect.top),
					Math.round(rect.width),
					Math.round(rect.height),
					borderStyles,
					borderCellStyle,
				);
			}
		}

		// Handle list-style-position: outside markers
		this.renderOutsideMarker(element, ctx);

		// Note: JSDOM automatically calls connectedCallback() when elements are added to DOM
		// No manual lifecycle management needed

		// Use ExpandedTreeWalker to render all children including pseudo-elements and shadow DOM
		const walker = this.createExpandedTreeWalker(element);

		// Skip the current element and start with first child
		let childNode = walker.firstChild();
		while (childNode) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				const childElement = childNode as Element;
				if (childElement instanceof (this.window as any).HTMLElement) {
					this.renderElement(childElement, ctx);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				const textNode = childNode as Text;
				this.renderText(textNode, ctx);
			}
			childNode = walker.nextSibling();
		}
	}

	/**
	 * Render outside positioned markers for list items
	 */
	private renderedOutsideMarkers = new WeakSet<Element>();

	private renderOutsideMarker(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const computedStyle = this.window.getComputedStyle(element);
		const display = computedStyle.getPropertyValue("display");
		
		// Only handle list items
		if (display !== "list-item") {
			return;
		}

		const listStylePosition = computedStyle.getPropertyValue("list-style-position") || "outside";
		
		// Only handle outside positioning
		if (listStylePosition !== "outside") {
			return;
		}

		// Prevent duplicate rendering in the same frame
		if (this.renderedOutsideMarkers.has(element)) {
			return;
		}
		this.renderedOutsideMarkers.add(element);

		// Get marker content from StyleManager
		const markerContent = this.styleManager.getMarkerContent(element);
		if (!markerContent) {
			return;
		}

		const rect = this.layoutEngine.getRect(element);
		if (!rect) {
			return;
		}

		// Calculate available space for marker (margin + border + padding)
		const boxModel = getBoxModel(element);
		const availableSpace = (boxModel.marginLeft || 0) + (boxModel.borderLeftWidth || 0) + (boxModel.paddingLeft || 0);
		
		// Calculate marker width (approximate - 1 character per character)
		const markerWidth = markerContent.length;
		
		// Get marker styles
		const markerStyle = this.window.getComputedStyle(element, "::marker");
		const markerColor = markerStyle.getPropertyValue("color");
		const markerBold = markerStyle.getPropertyValue("font-weight") === "bold";
		const markerItalic = markerStyle.getPropertyValue("font-style") === "italic";
		const markerUnderline = markerStyle.getPropertyValue("text-decoration").includes("underline");

		const markerTextStyle = {
			fg: markerColor && markerColor !== "initial" ? cssColorToNumber(markerColor) : undefined,
			bold: markerBold,
			italic: markerItalic,
			underline: markerUnderline,
		};

		// Position marker at absolute left edge (outside positioning)
		const markerX = 0; // Always at absolute position 0 for outside positioning
		const markerY = Math.round(rect.top);

		// Handle marker overflow by adding spaces to content if needed  
		if (markerWidth > availableSpace) {
			const shortage = markerWidth - availableSpace;
			this.addLeadingSpacesToListItem(element, shortage);
		}

		// Render the marker
		ctx.setText(markerX, markerY, markerContent, markerTextStyle);
	}

	/**
	 * Add non-breaking spaces to the beginning of list item content to prevent marker overlap
	 */
	private addLeadingSpacesToListItem(element: Element, spaceCount: number): void {
		// Find the first text node in the element's content
		const walker = this.createExpandedTreeWalker(element);
		let node = walker.firstChild();
		
		while (node) {
			if (node.nodeType === node.TEXT_NODE) {
				const textNode = node as Text;
				// Don't modify pseudo-element text nodes
				const pseudoMetadata = getPseudoMetadata(textNode);
				if (!pseudoMetadata) {
					// Add non-breaking spaces to the beginning
					const spaces = '\u00A0'.repeat(spaceCount); // Non-breaking spaces
					textNode.data = spaces + textNode.data;
					break;
				}
			}
			node = walker.nextNode();
		}
	}

	/**
	 * Render a text node with proper styling from its parent element or pseudo-element
	 */
	private renderText(
		textNode: Text,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const textContent = textNode.data;
		if (!textContent) return;

		// Check if this is a pseudo-element node
		const pseudoMetadata = getPseudoMetadata(textNode);


		// For pseudo elements, we don't have a parentElement, but we have hostElement
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: textNode.parentElement;
		if (!parentElement) return;

		let computedStyle: CSSStyleDeclaration;

		if (pseudoMetadata) {
			// For pseudo-elements, get the computed style with the pseudo-element selector
			computedStyle = this.window.getComputedStyle(
				pseudoMetadata.hostElement,
				pseudoMetadata.pseudoType,
			);
		} else {
			// For regular text nodes, use the parent element's style
			computedStyle = this.window.getComputedStyle(parentElement);
		}

		const textColor = computedStyle.getPropertyValue("color");
		const textBgColor = computedStyle.getPropertyValue("background-color");
		const textBold = computedStyle.getPropertyValue("font-weight") === "bold";
		const textItalic =
			computedStyle.getPropertyValue("font-style") === "italic";
		const textUnderline = computedStyle
			.getPropertyValue("text-decoration")
			.includes("underline");

		const textStyle = {
			fg:
				textColor && textColor !== "initial"
					? cssColorToNumber(textColor)
					: undefined,
			bg:
				textBgColor &&
				textBgColor !== "initial" &&
				textBgColor !== "transparent"
					? cssColorToNumber(textBgColor)
					: undefined,
			bold: textBold,
			italic: textItalic,
			underline: textUnderline,
		};

		const rectTexts = this.layoutEngine.getRectTexts(textNode);
		if (rectTexts.length > 0) {
			for (const rectText of rectTexts) {
				if (rectText.text.length > 0) {
					ctx.setText(
						Math.round(rectText.rect.x),
						Math.round(rectText.rect.y),
						rectText.text,
						textStyle,
					);
				}
			}
		}
	}

	// TODO: move this to tables.ts? or layout.ts
	private renderTable(
		tableElement: Element,
		rect: DOMRect,
		style: any,
	): void {
		// For now, let's fall back to normal rendering and let CSS handle table layout
		// The layout engine should already handle display: table properly
		// TODO: Implement table-specific optimizations like borders between cells
		
		// Check if we have proper table children, if not, render as normal element
		const hasTableStructure = this.hasTableStructure(tableElement);
		if (!hasTableStructure) {
			// Render children normally
			return;
		}
		
		// For tables with proper structure, add table-specific border rendering
		this.renderTableBorders(tableElement, rect, style);
	}

	private hasTableStructure(tableElement: Element): boolean {
		// Check if element has table-like children (thead, tbody, tr, etc.)
		const tableElements = ['thead', 'tbody', 'tfoot', 'tr', 'th', 'td'];
		return Array.from(tableElement.children).some(child => 
			tableElements.includes(child.tagName?.toLowerCase() || '')
		);
	}

	private renderTableBorders(
		tableElement: Element,
		rect: DOMRect,
		style: any,
	): void {
		// Add borders between table cells
		// This could be enhanced to draw proper table borders
		// For now, this is a placeholder for table-specific rendering
		
		// Check if border-collapse is set
		const borderCollapse = this.window
			.getComputedStyle(tableElement)
			.getPropertyValue('border-collapse');
			
		if (borderCollapse === 'collapse') {
			// TODO: Implement collapsed border model
			// This would require drawing borders between cells
		}
	}

	private processPendingMutationsAndRender(): boolean {
		const pendingMutations = this.observer.takeRecords();
		if (pendingMutations.length > 0) {
			// Process mutations in the same order as MutationObserver callback
			this.styleManager.handleMutations(pendingMutations);
			this.layoutEngine.handleMutations(pendingMutations);
			this.render();
			return true;
		}
		return false;
	}

	private handleResize(): void {
		const newWidth = this.process.stdout.columns || 80;
		const newHeight = this.process.stdout.rows || 24;

		this.width = newWidth;
		this.height = newHeight;

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

		this.renderer.resize(newHeight, newWidth);

		this.renderer.clearPreviousBuffer();

		this.layoutEngine.resize(newWidth, newHeight);

		this.render();
	}

	// TODO: Move these somewhere?
	private initializeConstructorExtensions(): void {
		const {Element, Document} = this.window;
		const termDOM = this;

		Element.prototype.getBoundingClientRect = function (
			this: Element,
		): DOMRect {
			if (!this.isConnected) {
				return termDOM.layoutEngine.createDOMRect(0, 0, 0, 0);
			}

			termDOM.processPendingMutationsAndRender();

			const rect = termDOM.layoutEngine.getRect(this);
			return rect || termDOM.layoutEngine.createDOMRect(0, 0, 0, 0);
		};

		Element.prototype.getClientRects = function (): DOMRectList {
			if (!this.isConnected) {
				return termDOM.layoutEngine.createDOMRectList();
			}

			termDOM.processPendingMutationsAndRender();

			const rects = termDOM.layoutEngine.getRects(this);
			return termDOM.layoutEngine.createDOMRectList(rects);
		};

		// Fullscreen API methods
		Element.prototype.requestFullscreen = function (
			this: Element,
			options?: FullscreenOptions,
		): Promise<void> {
			return termDOM.fullscreenManager.requestFullscreen(this, options);
		};

		Document.prototype.exitFullscreen = function (
			this: Document,
		): Promise<void> {
			return termDOM.fullscreenManager.exitFullscreen();
		};

		Object.defineProperty(Document.prototype, "fullscreenElement", {
			get: function (this: Document) {
				return termDOM.fullscreenManager.fullscreenElement;
			},
			configurable: true,
		});

		Document.prototype.elementFromPoint = function (
			x: number,
			y: number,
		): Element | null {
			termDOM.processPendingMutationsAndRender();
			return findElementAtPoint(termDOM, this.documentElement, x, y);
		};
	}

	// TODO: move this to events.ts
	private dispatchGlobalKeyboardEvent(chunk: Buffer): void {
		const key = chunk.toString("utf8");

		// Find the focused element or use document.body
		let targetElement = this.document.activeElement || this.document.body;

		// Map common key codes (reuse logic from fullscreen manager)
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
		const keydownEvent = new this.window.KeyboardEvent("keydown", {
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

		const notCanceled = targetElement.dispatchEvent(keydownEvent);

		// If keydown wasn't canceled and it's a printable character, dispatch keypress
		if (notCanceled && key.length === 1 && charCode >= 32 && charCode < 127) {
			const keypressEvent = new this.window.KeyboardEvent("keypress", {
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
			targetElement.dispatchEvent(keypressEvent);
		}

		// Always dispatch keyup
		const keyupEvent = new this.window.KeyboardEvent("keyup", {
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
		targetElement.dispatchEvent(keyupEvent);
	}

	/**
	 * Calculate push-up offset when content exceeds available terminal space
	 * Updates scrollY to position content to fit in terminal
	 */
	private calculatePushUpOffset(): void {
		// Use standard DOM property for content height
		const documentHeight = this.document.body.scrollHeight;

		// Calculate current viewport position from scrolling manager (0-based)
		// When scrollTop is negative, content starts below terminal top
		const currentRow = -this.scrollingManager.getScrollTop();

		// Calculate available space from current position to bottom of terminal
		const availableSpace = this.height - currentRow;

		// If content fits in available space, no push-up needed
		if (documentHeight <= availableSpace) {
			return;
		}

		// Calculate how much to push up
		const pushUpAmount = documentHeight - availableSpace;

		// Update screenTop to reflect new terminal cursor position
		const newScreenTop = this.scrollingManager.getScreenTop() - pushUpAmount;
		this.scrollingManager.setScreenTop(Math.max(0, newScreenTop));

		// Update scrollTop to push content up (make scrollTop less negative)
		// Increase scrollTop by pushUpAmount to shift content start position up
		this.scrollingManager.scrollBy(pushUpAmount, true);
	}

	/**
	 * Initialize cursor position detection for TTY environments
	 * This runs asynchronously during construction to set up proper viewport positioning
	 */
	private initializeCursorDetection(): void {
		this.cursorDetectionPromise = null;
		//return;
		// Only detect cursor position in TTY environments
		if (this.process.stdin?.isTTY) {
			// Set up cursor detection promise that render() will wait for
			this.cursorDetectionPromise = Promise.race([
				this.detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					// If cursor detection fails, continue without it
					this.hasDetectedCommandStart = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait
					this.cursorDetectionPromise = null;
				});
		} else {
			// In non-TTY environments, don't set up cursor detection at all
			this.cursorDetectionPromise = null;
		}
	}

	/**
	 * Detect current cursor position and set window.screenTop
	 * Sends \x1b[6n and waits for response \x1b[row;colR
	 */
	detectCommandStart(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.process.stdin?.isTTY) {
				reject(new Error("Cannot detect cursor position: stdin is not a TTY"));
				return;
			}

			let responseBuffer = "";

			// Set up cursor detection handler for unified stdin
			this.cursorDetectionHandler = (dataStr: string) => {
				responseBuffer += dataStr;

				// Look for cursor position response pattern: \x1b[row;colR
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					// Cleanup
					this.cursorDetectionHandler = null;

					const row = parseInt(match[1], 10);
					// Set window.screenTop (convert 1-based terminal row to 0-based)
					const screenTop = row - 1;
					this.scrollingManager.setScreenTop(screenTop);

					// Set scrollTop to command start position (browser behavior)
					// For command start, we want content to shift up to terminal top
					this.scrollingManager.scrollToCommandStart();

					this.hasDetectedCommandStart = true;
					resolve(row);
				}
			};

			// Send cursor position query with proper flushing
			this.process.stdout.write("\x1b[6n");

			// Force flush the output buffer (critical for cursor queries)
			if (typeof (this.process.stdout as any)._flush === "function") {
				(this.process.stdout as any)._flush();
			}

			// Timeout after 1000ms (reasonable balance for reliability)
			setTimeout(() => {
				if (this.cursorDetectionHandler) {
					this.cursorDetectionHandler = null;
					reject(new Error("Timeout waiting for cursor position response"));
				}
			}, 1000);
		});
	}

	dispose(): void {
		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		// Shadow DOM cleanup is automatic with symbol-based storage

		this.observer.disconnect();
		this.styleManager.dispose();
		this.layoutEngine.dispose();
		this.fullscreenManager.dispose();
		this.jsdom.window.close();
	}
}

function findElementAtPoint(
	termDOM: TermDOM,
	element: Element,
	x: number,
	y: number,
): Element | null {
	if (element.nodeType !== 1) {
		return null;
	}

	try {
		const rects = Array.from(element.getClientRects());
		if (!isPointInRects(x, y, rects)) {
			return null;
		}
	} catch (error) {
		return null;
	}

	// Use ExpandedTreeWalker to traverse children (including shadow DOM)
	const walker = termDOM.createExpandedTreeWalker(element);

	let child = walker.nextNode() as Element;
	while (child) {
		const result = findElementAtPoint(termDOM, child, x, y);
		if (result) {
			return result;
		}
		child = walker.nextNode() as Element;
	}

	return element;
}
