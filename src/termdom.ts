import {LayoutEngine} from "./layout.js";
import {Renderer, type ColorDepth, Cell, mergeBorderEncodings} from "./ansi.js";
import {type EventEmitter} from "events";
import {JSDOM} from "jsdom";
import {type DOMWindow} from "jsdom";
import {RectUtils} from "./layout.js";
import {resolvePropertyValue, resolveBorderStyles} from "./styles.js";

function detectColorDepth(process: ProcessLike): ColorDepth {
	const colorterm = process.env.COLORTERM;
	if (colorterm === "truecolor" || colorterm === "24bit") {
		return "rgb";
	}

	const term = process.env.TERM || "";
	if (term.includes("256color") || term.includes("256")) {
		return "256";
	}

	if (term.includes("color")) {
		return "ansi";
	}

	return "ansi";
}

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

export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
}

export interface ProcessLike extends EventEmitter {
	stdout: TTYWriteStream;
	stdin?: TTYReadStream;
	stderr?: TTYWriteStream;
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
	private readonly jsdom: JSDOM;
	private readonly observer: MutationObserver;

	private width: number;
	private height: number;
	private readonly mode: "flow" | "fullscreen";
	private readonly process: ProcessLike;

	private renderCompleteCallbacks: Array<() => void> = [];

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

		this.setupDOMInspector();
		this.initializeConstructorExtensions();
		this.renderer = new Renderer(
			this.height,
			this.width,
			options.colorDepth || detectColorDepth(this.process),
		);

		this.layoutEngine = new LayoutEngine(this.jsdom.window);
		this.layoutEngine.resize(this.width, this.height);

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

		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			stdin.setRawMode?.(true);
			stdin.resume();

			stdin.on("data", (data: Buffer) => {
				if (data[0] === 0x03) {
					this.dispose();
					this.process.exit(0);
				}
			});
		}
	}

	private async render(): Promise<void> {
		this.layoutEngine.calculateLayout();

		this.renderer.beginFrame();

		this.renderElement(this.document.documentElement);

		const ansiOutput = this.renderer.render();

		const fullOutput = ansiOutput;

		if (fullOutput) {
			await new Promise<void>((resolve, reject) => {
				this.process.stdout.write(fullOutput, "utf8", (error) => {
					if (error) {
						reject(error);
					} else {
						resolve();

						const callbacks = this.renderCompleteCallbacks.splice(0);
						callbacks.forEach((callback) => callback());
					}
				});
			});
		} else {
			const callbacks = this.renderCompleteCallbacks.splice(0);
			callbacks.forEach((callback) => callback());
		}
	}

	private cssColorToNumber(cssColor: string): number {
		if (!cssColor || cssColor === "transparent" || cssColor === "none") {
			return 0;
		}

		const colorNumber = Bun.color(cssColor, "number");
		return typeof colorNumber === "number" ? colorNumber : 0;
	}

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
				this.renderBorders(rect, borderStyles, style);
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

				const rects = this.layoutEngine.getRects(textNode) as Array<
					DOMRect & {text?: string}
				>;
				if (rects.length > 0) {
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

	private renderBorders(
		rect: DOMRect,
		borderStyles: {
			topEdge: number;
			rightEdge: number;
			bottomEdge: number;
			leftEdge: number;
			hasAnyBorder: boolean;
		},
		cellStyle: any,
	): void {
		const {left, top, width, height} = rect;

		// Don't render if rect is too small
		if (width < 2 || height < 2) return;

		const right = left + width - 1;
		const bottom = top + height - 1;

		// Use foreground color for borders, inherit element's background color
		const borderCellStyle = {
			fg: cellStyle.fg || 0xffffff, // Default to white if no color
			bg: cellStyle.bg, // Inherit element's background color
		};

		// Encode borders based on position
		// Top edge
		if (borderStyles.topEdge > 0) {
			for (let x = left; x <= right; x++) {
				if (top >= 0 && top < this.height) {
					const cornerLeft = x === left && borderStyles.leftEdge > 0;
					const cornerRight = x === right && borderStyles.rightEdge > 0;
					const edgeEncoding = this.calculateEdgeEncoding(
						borderStyles,
						true,
						cornerRight,
						false,
						cornerLeft,
					);
					this.setBorderCell(x, top, edgeEncoding, borderCellStyle);
				}
			}
		}

		// Bottom edge
		if (
			borderStyles.bottomEdge > 0 &&
			bottom !== top &&
			bottom >= 0 &&
			bottom < this.height
		) {
			for (let x = left; x <= right; x++) {
				const cornerLeft = x === left && borderStyles.leftEdge > 0;
				const cornerRight = x === right && borderStyles.rightEdge > 0;
				const edgeEncoding = this.calculateEdgeEncoding(
					borderStyles,
					false,
					cornerRight,
					true,
					cornerLeft,
				);
				this.setBorderCell(x, bottom, edgeEncoding, borderCellStyle);
			}
		}

		// Left edge (excluding corners)
		if (borderStyles.leftEdge > 0) {
			for (let y = top + 1; y < bottom; y++) {
				if (left >= 0 && left < this.width) {
					const edgeEncoding = this.calculateEdgeEncoding(
						borderStyles,
						false,
						false,
						false,
						true,
					);
					this.setBorderCell(left, y, edgeEncoding, borderCellStyle);
				}
			}
		}

		// Right edge (excluding corners)
		if (
			borderStyles.rightEdge > 0 &&
			right !== left &&
			right >= 0 &&
			right < this.width
		) {
			for (let y = top + 1; y < bottom; y++) {
				const edgeEncoding = this.calculateEdgeEncoding(
					borderStyles,
					false,
					true,
					false,
					false,
				);
				this.setBorderCell(right, y, edgeEncoding, borderCellStyle);
			}
		}
	}

	private calculateEdgeEncoding(
		borderStyles: {
			topEdge: number;
			rightEdge: number;
			bottomEdge: number;
			leftEdge: number;
		},
		hasTop: boolean,
		hasRight: boolean,
		hasBottom: boolean,
		hasLeft: boolean,
	): number {
		// Encode which edges are present for this specific cell position
		let encoding = 0;

		if (hasTop && borderStyles.topEdge > 0) {
			encoding |= borderStyles.topEdge << 24; // BORDER_EDGE_TOP_SHIFT
		}
		if (hasRight && borderStyles.rightEdge > 0) {
			encoding |= borderStyles.rightEdge << 16; // BORDER_EDGE_RIGHT_SHIFT
		}
		if (hasBottom && borderStyles.bottomEdge > 0) {
			encoding |= borderStyles.bottomEdge << 8; // BORDER_EDGE_BOTTOM_SHIFT
		}
		if (hasLeft && borderStyles.leftEdge > 0) {
			encoding |= borderStyles.leftEdge << 0; // BORDER_EDGE_LEFT_SHIFT
		}

		return encoding;
	}

	private renderTable(tableElement: Element, rect: DOMRect, style: any): void {
		const tableInstance = this.layoutEngine.getTableInstance(tableElement);
		if (!tableInstance) return;

		const {tanstackTable} = tableInstance;
		const {left, top, width, height} = rect;

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
						? this.darkenColor(style.bg, 0.1)
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

	private darkenColor(color: number, factor: number): number {
		const r = (color >> 16) & 0xff;
		const g = (color >> 8) & 0xff;
		const b = color & 0xff;

		return (
			(Math.floor(r * (1 - factor)) << 16) |
			(Math.floor(g * (1 - factor)) << 8) |
			Math.floor(b * (1 - factor))
		);
	}

	private renderListItem(element: Element, rect: DOMRect, style: any): void {
		const listParent = element.parentElement;
		if (!listParent) return;

		const marker = this.getListMarker(element, listParent);
		if (!marker) return;

		const {left, top} = rect;
		const nestingDepth = this.getListNestingDepth(element);

		// Position marker in the padding area reserved for it
		// The list item has left padding that includes nesting indent + marker space
		const nestingIndent = nestingDepth * 2;
		const markerX = Math.round(left + nestingIndent); // Position marker in the reserved space
		const markerY = Math.round(top);

		if (markerX >= 0 && markerY >= 0 && markerX < this.width) {
			this.renderer.setText(markerX, markerY, marker, style);
		}
	}

	private getListNestingDepth(listItem: Element): number {
		let depth = 0;
		let current = listItem.parentElement;

		while (current) {
			if (current.tagName === "UL" || current.tagName === "OL") {
				depth++;
			}
			current = current.parentElement;
		}

		return depth - 1; // Subtract 1 because we want 0-based depth (first level = 0)
	}

	// TODO: move this to styles.ts
	private getListMarker(listItem: Element, listParent: Element): string {
		const listType = listParent.tagName.toLowerCase();
		const listStyleType = resolvePropertyValue(listParent, "list-style-type");
		const nestingDepth = this.getListNestingDepth(listItem);

		if (listType === "ol") {
			// Ordered list - get the item index and format as number
			const items = Array.from(listParent.querySelectorAll("li"));
			const index = items.indexOf(listItem as HTMLLIElement);
			if (index === -1) return "";

			const start = parseInt(listParent.getAttribute("start") || "1", 10);
			const itemNumber = start + index;

			switch (listStyleType) {
				case "decimal":
				default:
					return `${itemNumber}.`;
				case "lower-alpha":
					return `${String.fromCharCode(96 + (itemNumber % 26))}.`;
				case "upper-alpha":
					return `${String.fromCharCode(64 + (itemNumber % 26))}.`;
				case "lower-roman":
					return `${this.toRoman(itemNumber).toLowerCase()}.`;
				case "upper-roman":
					return `${this.toRoman(itemNumber)}.`;
			}
		} else if (listType === "ul") {
			// Unordered list - use bullet characters based on nesting depth if no explicit style
			if (listStyleType === "disc" || !listStyleType) {
				// Auto-select bullet based on nesting level
				const bullets = ["•", "◦", "▪", "▫"];
				return bullets[nestingDepth % bullets.length];
			}

			switch (listStyleType) {
				case "disc":
					return "•";
				case "circle":
					return "◦";
				case "square":
					return "▪";
			}
		}

		return "";
	}

	private toRoman(num: number): string {
		const romanNumerals = [
			{value: 1000, symbol: "M"},
			{value: 900, symbol: "CM"},
			{value: 500, symbol: "D"},
			{value: 400, symbol: "CD"},
			{value: 100, symbol: "C"},
			{value: 90, symbol: "XC"},
			{value: 50, symbol: "L"},
			{value: 40, symbol: "XL"},
			{value: 10, symbol: "X"},
			{value: 9, symbol: "IX"},
			{value: 5, symbol: "V"},
			{value: 4, symbol: "IV"},
			{value: 1, symbol: "I"},
		];

		let result = "";
		for (const {value, symbol} of romanNumerals) {
			while (num >= value) {
				result += symbol;
				num -= value;
			}
		}
		return result;
	}

	private setBorderCell(
		x: number,
		y: number,
		borderEncoding: number,
		style: any,
	): void {
		// Get the renderer buffer
		const buffer = (this.renderer as any).currentBuffer;
		if (!buffer[y]) {
			buffer[y] = [];
		}

		// Check if there's an existing cell
		const existingCell = buffer[y][x];
		if (existingCell) {
			if (existingCell.border > 0) {
				// Merge the border encodings using precedence rules
				const mergedBorder = mergeBorderEncodings(
					existingCell.border,
					borderEncoding,
				);

				// Create a new cell with merged border
				const borderCell = new Cell({
					grapheme: "┼", // Placeholder - renderer will determine correct character
					...style,
					border: mergedBorder,
				});
				buffer[y][x] = borderCell;
			} else {
				// Existing cell but no border - just overwrite
				const borderCell = new Cell({
					grapheme: "┼", // Placeholder - renderer will determine correct character
					...style,
					border: borderEncoding,
				});
				buffer[y][x] = borderCell;
			}
		} else {
			// No existing cell - create new cell
			const borderCell = new Cell({
				grapheme: "┼", // Placeholder - renderer will determine correct character
				...style,
				border: borderEncoding,
			});
			buffer[y][x] = borderCell;
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

	private initializeConstructorExtensions(): void {
		const {Element, Document, DOMRect} = this.window;

		const termDOM = this;

		Element.prototype.getBoundingClientRect = function (
			this: Element,
		): DOMRect {
			if (!this.isConnected) {
				return new DOMRect(0, 0, 0, 0);
			}

			termDOM.processPendingMutationsAndRender();

			const rect = termDOM.layoutEngine.getRect(this);
			return rect || new DOMRect(0, 0, 0, 0);
		};

		Element.prototype.getClientRects = function (): DOMRectList {
			if (!this.isConnected) {
				return RectUtils.createDOMRectList([]);
			}

			termDOM.processPendingMutationsAndRender();

			const rects = termDOM.layoutEngine.getRects(this);
			return RectUtils.createDOMRectList(rects);
		};

		Document.prototype.elementFromPoint = function (
			x: number,
			y: number,
		): Element | null {
			termDOM.processPendingMutationsAndRender();
			return findElementAtPoint(this.documentElement, x, y);
		};
	}

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
		if (this.process.stdin?.isTTY) {
			const stdin = this.process.stdin as TTYReadStream;
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		this.observer.disconnect();
		this.layoutEngine.dispose();
		this.jsdom.window.close();
	}

	requestFullScreen(): void {
		throw new Error("TODO: Implement fullscreen mode switching");
	}

	async waitForRender(): Promise<void> {
		return new Promise((resolve) => {
			const didRender = this.processPendingMutationsAndRender();

			if (didRender) {
				this.renderCompleteCallbacks.push(resolve);
			} else {
				resolve();
			}
		});
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
		const rects = element.getClientRects();
		if (!RectUtils.isPointInAnyRect(x, y, rects)) {
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
