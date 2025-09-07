import {type EventEmitter} from "events";
import {type DOMWindow, JSDOM} from "jsdom";
import {LayoutEngine, isPointInRects} from "./layout.js";
import {type ColorDepth, Renderer} from "./ansi.js";
import {
	resolvePropertyValue,
	resolveBorderStyles,
	cssColorToNumber,
	darkenColor,
	getListMarker,
	getListNestingDepth,
} from "./styles.js";
import {FullscreenManager} from "./fullscreen.js";
import {setupInspectMethods} from "./inspector.js";

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

// TODO: Can we use web streams (ReadableStream) or at least track what events we're usinh.
export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
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
			{
				pretendToBeVisual: true,
			},
		);

		this.window = this.jsdom.window;
		this.document = this.jsdom.window.document;

		// Setup DOM inspector
		setupInspectMethods(this.window);
		this.initializeConstructorExtensions();
		this.renderer = new Renderer(
			this.height,
			this.width,
			options.colorDepth || detectColorDepth(this.process),
		);

		this.layoutEngine = new LayoutEngine(this.jsdom.window);
		this.layoutEngine.resize(this.width, this.height);
		this.fullscreenManager = new FullscreenManager(this.process);

		this.initializeWindow();

		this.observer = this.setupMutationObserver();

		this.setupProcessHandlers();
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
			stdin.setRawMode?.(true);
			stdin.resume();
			stdin.on("data", (data: Buffer) => {
				if (data[0] === 0x03) {
					this.dispose();
					this.process.exit(0);
				}
				// Dispatch keyboard events globally when not in fullscreen
				if (!this.fullscreenManager.isFullscreen) {
					this.dispatchGlobalKeyboardEvent(data);
				}
			});
		}
	}

	async render(): Promise<void> {
		this.layoutEngine.calculateLayout();
		this.renderer.beginFrame();
		this.renderElement(this.document.documentElement);
		const ansi = this.renderer.render();
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
	}


	// TODO: many of the following methods do not belong on the TermDOM class
	private renderElement(element: Element): void {
		const rect = this.layoutEngine.getRect(element);

		const color = resolvePropertyValue(element, "color");
		const backgroundColor = resolvePropertyValue(element, "background-color");
		const bold = resolvePropertyValue(element, "font-weight") === "bold";
		const italic = resolvePropertyValue(element, "font-style") === "italic";
		const underline = resolvePropertyValue(element, "text-decoration").includes(
			"underline",
		);

		const style = {
			fg:
				color && color !== "initial" ? cssColorToNumber(color) : undefined,
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
			this.renderer.fillRect(
				rect.left,
				rect.top,
				rect.width,
				rect.height,
				style.bg,
			);
		}

		// Handle tables with TanStack integration
		const display = resolvePropertyValue(element, "display");
		if (display === "table" && rect) {
			this.renderTable(element, rect, style);
			return; // Table handles its own children
		}

		// Handle list items with markers
		if (element.tagName === "LI" && rect) {
			this.renderListItem(element, rect, style);
			// Continue to render children normally
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
				this.renderer.drawBorder(
					Math.round(rect.left),
					Math.round(rect.top),
					Math.round(rect.width),
					Math.round(rect.height),
					borderStyles,
					borderCellStyle,
				);
			}
		}

		for (const childNode of element.childNodes) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				const childElement = childNode as Element;
				if (childElement instanceof (this.window as any).HTMLElement) {
					this.renderElement(childElement);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				const textNode = childNode as Text;
				const textContent = textNode.textContent;
				if (!textContent) continue;

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

				const rectLengths = this.layoutEngine.getRectLengths(textNode);
				if (rectLengths.length > 0 && textContent) {
					let offset = 0;
					for (const rectLength of rectLengths) {
						if (rectLength.textLength > 0) {
							const text = textContent.slice(
								offset,
								offset + rectLength.textLength,
							);
							this.renderer.setText(
								Math.round(rectLength.rect.x),
								Math.round(rectLength.rect.y),
								text,
								textStyle,
							);
							offset += rectLength.textLength;
						}
					}
				}
			}
		}
	}



	// TODO: move this to tables.ts? or layout.ts
	private renderTable(tableElement: Element, rect: DOMRect, style: any): void {
		const tableInstance = this.layoutEngine.getTableInstance(tableElement);
		if (!tableInstance) return;

		const {tanstackTable} = tableInstance;
		// TODO: Use height?
		const {left, top, width, height: _} = rect;

		// Render table using flexbox-like approach but with TanStack data
		let currentY = Math.round(top);

		// Render headers
		tanstackTable.getHeaderGroups().forEach((headerGroup: any) => {
			let currentX = Math.round(left);
			const colWidth = Math.floor(width / headerGroup.headers.length);

			headerGroup.headers.forEach((header: any, colIndex: number) => {
				const headerText = header.column.columnDef.header;
				const cellWidth =
					colIndex === headerGroup.headers.length - 1
						? width - (currentX - left) // Last column takes remaining width
						: colWidth;

				// Render header cell background
				if (style.bg != null) {
					this.renderer.fillRect(currentX, currentY, cellWidth, 1, style.bg);
				}

				// Render header text
				if (headerText && currentX >= 0 && currentY >= 0) {
					this.renderer.setText(currentX + 1, currentY, String(headerText), {
						...style,
						bold: true,
					});
				}

				currentX += cellWidth;
			});
			currentY++;
		});

		// Render data rows
		tanstackTable.getRowModel().rows.forEach((row: any, rowIndex: number) => {
			let currentX = Math.round(left);
			const colWidth = Math.floor(width / row.getVisibleCells().length);

			row.getVisibleCells().forEach((cell: any, colIndex: number) => {
				const cellValue = String(cell.getValue());
				const cellWidth =
					colIndex === row.getVisibleCells().length - 1
						? width - (currentX - left)
						: colWidth;

				// Render cell background (alternating rows)
				const bgColor =
					rowIndex % 2 === 1 && style.bg
						? darkenColor(style.bg, 0.1)
						: style.bg;

				if (bgColor != null) {
					this.renderer.fillRect(currentX, currentY, cellWidth, 1, bgColor);
				}

				// Render cell text
				if (cellValue && currentX >= 0 && currentY >= 0) {
					this.renderer.setText(currentX + 1, currentY, cellValue, style);
				}

				currentX += cellWidth;
			});
			currentY++;
		});
	}


	// TODO: move this to layout.ts or maybe lists.ts
	private renderListItem(element: Element, rect: DOMRect, style: any): void {
		const listParent = element.parentElement;
		if (!listParent) return;

		const marker = getListMarker(element, listParent);
		if (!marker) return;

		const {left, top} = rect;
		const nestingDepth = getListNestingDepth(element);

		// Position marker in the padding area reserved by the ul/ol element
		// Now that nesting is handled by ul/ol margin, marker goes at the left edge of content
		const markerX = Math.round(left); // Marker positioned at start of content area
		const markerY = Math.round(top);

		if (markerX >= 0 && markerY >= 0 && markerX < this.width) {
			this.renderer.setText(markerX, markerY, marker, style);
		}
	}

	private processPendingMutationsAndRender(): boolean {
		const pendingMutations = this.observer.takeRecords();
		if (pendingMutations.length > 0) {
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

			const rectLengths = termDOM.layoutEngine.getRectLengths(this);
			const rects = Array.from(rectLengths, (rectLength) => rectLength.rect);
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
			return findElementAtPoint(this.documentElement, x, y);
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

	dispose(): void {
		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		this.observer.disconnect();
		this.layoutEngine.dispose();
		this.fullscreenManager.dispose();
		this.jsdom.window.close();
	}
}

function findElementAtPoint(
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

	const children = Array.from(element.children);
	for (const child of children) {
		const result = findElementAtPoint(child, x, y);
		if (result) {
			return result;
		}
	}

	return element;
}
