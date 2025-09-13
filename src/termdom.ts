import {type EventEmitter} from "events";
import {type DOMWindow, JSDOM} from "jsdom";
import {LayoutEngine, isPointInRects} from "./layout.js";
import {type ColorDepth, Renderer} from "./ansi.js";
import {
	StyleManager,
	resolveBorderStyles,
	cssColorToNumber,
} from "./styles.js";
import {FullscreenManager} from "./fullscreen.js";
import {setupInspectMethods} from "./inspector.js";
// import {registerListElements} from "./elements/lists.js";

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
	private readonly styleManager: StyleManager;

	// Shadow DOM support
	private readonly shadowMap = new WeakMap<Element, ShadowRoot>();
	private readonly mergedTreeCache = new WeakMap<Element, DocumentFragment>();
	private readonly cloneToOriginalMap = new WeakMap<Node, Node>();
	private originalAttachShadow!: typeof Element.prototype.attachShadow;
	// private upgradeListElements!: (root?: Element | Document) => void;

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

		// Setup style management with caching
		this.styleManager = new StyleManager(this.window);

		// Setup DOM inspector
		setupInspectMethods(this.window);

		// Setup shadow DOM support
		this.setupShadowDOMSupport();

		// Register custom list elements
		// const listEnhancer = registerListElements(this.window);
		// this.upgradeListElements = listEnhancer.enhanceListElement;

		this.initializeConstructorExtensions();
		this.renderer = new Renderer(
			this.height,
			this.width,
			options.colorDepth || detectColorDepth(this.process),
		);

		this.layoutEngine = new LayoutEngine(
			this.jsdom.window,
			(element) => this.getShadowRoot(element),
			(element) => this.getMergedTree(element),
			(node) => this.cloneToOriginalMap.get(node) || null,
		);
		this.layoutEngine.resize(this.width, this.height);
		this.fullscreenManager = new FullscreenManager(this.process);

		this.initializeWindow();

		this.observer = this.setupMutationObserver();

		this.setupProcessHandlers();
	}

	/**
	 * Setup shadow DOM support by monkey-patching attachShadow
	 */
	private setupShadowDOMSupport(): void {
		// Store original method
		this.originalAttachShadow = this.window.Element.prototype.attachShadow;

		const shadowMap = this.shadowMap;
		const originalAttachShadow = this.originalAttachShadow;

		// Monkey-patch attachShadow to cache shadow roots
		this.window.Element.prototype.attachShadow = function (
			this: Element,
			options: ShadowRootInit,
		): ShadowRoot {
			let shadowRoot: ShadowRoot;

			try {
				// Call original method
				shadowRoot = originalAttachShadow.call(this, options);
			} catch (e) {
				// JSDOM doesn't support attachShadow on built-in elements
				// Create a mock shadow root for testing/compatibility
				const childNodes: Node[] = [];
				const children: Element[] = [];

				shadowRoot = {
					mode: options.mode,
					get childNodes() {
						return childNodes;
					},
					get children() {
						return children;
					},
					get firstChild() {
						return childNodes[0] || null;
					},
					get lastChild() {
						return childNodes[childNodes.length - 1] || null;
					},
					appendChild: function (node: Node) {
						childNodes.push(node);
						if (node.nodeType === 1) children.push(node as Element);
						return node;
					},
					querySelector: function (selector: string) {
						return (
							children.find((child: Element) => {
								if (selector === "style" && child.tagName === "STYLE")
									return child;
								if (selector === "slot" && child.tagName === "SLOT")
									return child;
								if (
									selector.startsWith(".") &&
									child.className &&
									child.className.includes(selector.slice(1))
								)
									return child;
								return null;
							}) || null
						);
					},
					querySelectorAll: function (selector: string) {
						return children.filter((child: Element) => {
							if (selector === "style" && child.tagName === "STYLE")
								return true;
							if (selector === "slot" && child.tagName === "SLOT") return true;
							if (
								selector.startsWith(".") &&
								child.className &&
								child.className.includes(selector.slice(1))
							)
								return true;
							return false;
						});
					},
					// Make it iterable
					[Symbol.iterator]: function* () {
						yield* childNodes;
					},
				} as any;
			}

			// Cache the shadow root in our WeakMap
			shadowMap.set(this, shadowRoot);

			return shadowRoot;
		};
	}

	/**
	 * Get cached shadow root for an element (works with both open and closed shadows)
	 */
	getShadowRoot(element: Element): ShadowRoot | null {
		return this.shadowMap.get(element) || null;
	}

	/**
	 * Get cached merged DOM tree for an element with shadow DOM
	 * Creates the merged tree on-demand if element has shadow DOM but no cached tree
	 */
	getMergedTree(element: Element): DocumentFragment | null {
		let mergedTree = this.mergedTreeCache.get(element);
		if (!mergedTree) {
			// Check if element has shadow DOM and create merged tree on-demand
			const shadowRoot = this.getShadowRoot(element);
			if (shadowRoot) {
				mergedTree = this.createMergedDOMTree(shadowRoot, element);
				this.mergedTreeCache.set(element, mergedTree);
			}
		}
		return mergedTree || null;
	}

	/**
	 * Check if an element has a shadow root
	 */
	hasShadowRoot(element: Element): boolean {
		return this.shadowMap.has(element);
	}

	/**
	 * Resolve slot assignments for shadow DOM content projection
	 * Supports both named slots and anonymous/default slots
	 */
	private resolveSlotAssignments(
		shadowRoot: ShadowRoot,
		lightDOMElement: Element,
	): Map<Element, Node[]> {
		const slotAssignments = new Map<Element, Node[]>();

		// Find all slots in shadow DOM
		const slots = shadowRoot.querySelectorAll("slot");

		for (const slot of slots) {
			const slotName = slot.getAttribute("name");
			const assignedContent: Node[] = [];

			if (slotName) {
				// Named slot - find light DOM children with matching slot attribute
				for (const childNode of lightDOMElement.childNodes) {
					if (childNode.nodeType === childNode.ELEMENT_NODE) {
						const childElement = childNode as Element;
						if (childElement.getAttribute("slot") === slotName) {
							assignedContent.push(childNode);
						}
					}
				}
			} else {
				// Anonymous slot - collect content without slot attributes
				for (const childNode of lightDOMElement.childNodes) {
					let shouldAssign = false;

					if (childNode.nodeType === childNode.ELEMENT_NODE) {
						const childElement = childNode as Element;
						shouldAssign = !childElement.hasAttribute("slot");
					} else if (childNode.nodeType === childNode.TEXT_NODE) {
						shouldAssign = true;
					}

					if (shouldAssign) {
						assignedContent.push(childNode);
					}
				}
			}

			if (assignedContent.length > 0) {
				slotAssignments.set(slot, assignedContent);
			} else {
				// No assigned content - use slot's fallback content
				slotAssignments.set(slot, Array.from(slot.childNodes));
			}
		}

		return slotAssignments;
	}

	/**
	 * Find the first anonymous slot in a shadow root using DOM query
	 */
	private findAnonymousSlot(shadowRoot: ShadowRoot): Element | null {
		// Query for slot elements without a name attribute
		return shadowRoot.querySelector("slot:not([name])");
	}

	/**
	 * Recursively map cloned nodes to their originals for layout calculations
	 */
	private mapClonedTree(clonedNode: Node, originalNode: Node): void {
		// Map the nodes
		this.cloneToOriginalMap.set(clonedNode, originalNode);

		// Recursively map children
		if (clonedNode.childNodes.length === originalNode.childNodes.length) {
			for (let i = 0; i < clonedNode.childNodes.length; i++) {
				this.mapClonedTree(
					clonedNode.childNodes[i],
					originalNode.childNodes[i],
				);
			}
		}
	}

	/**
	 * Transform a cloned LI element to include its shadow DOM marker structure
	 */
	private applyLIShadowDOMTransform(
		clonedLI: Element,
		originalLI: Element,
	): void {
		// Get the parent list to determine marker type
		const parentList = originalLI.parentElement;
		if (
			!parentList ||
			(parentList.tagName !== "UL" && parentList.tagName !== "OL")
		) {
			return;
		}

		// Store the original text content
		const textContent = clonedLI.textContent || "";

		// Clear the cloned LI's content
		clonedLI.textContent = "";

		// Create marker element
		const markerElement = this.document.createElement("span");
		markerElement.style.setProperty("position", "absolute");
		markerElement.style.setProperty("top", "0");
		markerElement.style.setProperty("text-align", "right");

		// Generate marker content based on parent list type
		if (parentList.tagName === "UL") {
			markerElement.textContent = "•";
			markerElement.style.setProperty("left", "-2ch");
			markerElement.style.setProperty("width", "2ch");
		} else if (parentList.tagName === "OL") {
			const items = Array.from(parentList.children).filter(
				(child: Element) => child.tagName === "LI",
			);
			const index = items.indexOf(originalLI);
			if (index !== -1) {
				const start = parseInt(parentList.getAttribute("start") || "1", 10);
				const itemNumber = start + index;
				markerElement.textContent = `${itemNumber}.`;

				// Calculate marker width for proper alignment
				const maxNumber = start + items.length - 1;
				const markerWidth = maxNumber.toString().length + 1;
				markerElement.style.setProperty("left", `-${markerWidth}ch`);
				markerElement.style.setProperty("width", `${markerWidth}ch`);
			}
		}

		// Create content wrapper
		const contentWrapper = this.document.createElement("div");
		contentWrapper.style.setProperty("display", "block");
		contentWrapper.textContent = textContent;

		// Set positioning styles on the LI
		(clonedLI as HTMLElement).style.setProperty("display", "block");
		(clonedLI as HTMLElement).style.setProperty("position", "relative");

		// Add marker and content to the cloned LI
		clonedLI.appendChild(markerElement);
		clonedLI.appendChild(contentWrapper);
	}

	/**
	 * Apply shadow DOM styles from <style> elements to the host element
	 * This is a simplified implementation for list elements
	 */
	private applyShadowDOMStyles(
		element: Element,
		_shadowRoot: ShadowRoot,
	): void {
		if (element.tagName === "UL") {
			// Apply UL shadow DOM styles
			(element as HTMLElement).style.setProperty("display", "block");
			(element as HTMLElement).style.setProperty("padding-left", "2ch");
			(element as HTMLElement).style.setProperty("margin", "0");
			(element as HTMLElement).style.setProperty("list-style", "none");
		} else if (element.tagName === "OL") {
			// Apply OL shadow DOM styles with dynamic padding
			const items = Array.from(element.children).filter(
				(child) => child.tagName === "LI",
			);
			const start = parseInt(element.getAttribute("start") || "1", 10);
			const maxNumber = start + items.length - 1;
			const markerWidth = maxNumber.toString().length + 1;

			(element as HTMLElement).style.setProperty("display", "block");
			(element as HTMLElement).style.setProperty(
				"padding-left",
				`${markerWidth}ch`,
			);
			(element as HTMLElement).style.setProperty("margin", "0");
			(element as HTMLElement).style.setProperty("list-style", "none");
		}
		// Note: LI elements in merged tree don't need styles applied here
		// since they're already properly slotted and should render their text content
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
			this.renderer.fillRect(
				rect.left,
				rect.top,
				rect.width,
				rect.height,
				style.bg,
			);
		}

		// Handle tables with TanStack integration
		const display = this.window
			.getComputedStyle(element)
			.getPropertyValue("display");
		if (display === "table" && rect) {
			this.renderTable(element, rect, style);
			return; // Table handles its own children
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

		// Ensure list elements are initialized with shadow DOM
		// Only initialize if this element is in the original DOM tree, not in merged trees
		if (
			(element.tagName === "UL" ||
				element.tagName === "OL" ||
				element.tagName === "LI") &&
			element.isConnected &&
			element.ownerDocument === this.document
		) {
			if ((element as any).connectedCallback && !this.getShadowRoot(element)) {
				(element as any).connectedCallback();
			}
		}

		// Check for shadow root first - if present, render shadow DOM with slot projection
		const shadowRoot = this.getShadowRoot(element);
		if (shadowRoot) {
			// Apply shadow DOM styles manually for list elements
			this.applyShadowDOMStyles(element, shadowRoot);
			this.renderShadowDOM(shadowRoot, element);
			// Don't render light DOM children when shadow DOM is present
			return;
		}

		// Render light DOM children
		for (const childNode of element.childNodes) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				const childElement = childNode as Element;
				if (childElement instanceof (this.window as any).HTMLElement) {
					this.renderElement(childElement);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				const textNode = childNode as Text;
				this.renderTextNode(textNode);
			}
		}
	}

	/**
	 * Render shadow DOM with slot content projection using cached merged DOM tree
	 */
	private renderShadowDOM(
		shadowRoot: ShadowRoot,
		lightDOMElement: Element,
	): void {
		// Refresh the merged tree cache on each render
		const mergedTree = this.createMergedDOMTree(shadowRoot, lightDOMElement);
		this.mergedTreeCache.set(lightDOMElement, mergedTree);

		// Render the cached merged tree (layout can reuse cached rects)
		for (const childNode of mergedTree.childNodes) {
			if (childNode.nodeType === childNode.ELEMENT_NODE) {
				const childElement = childNode as Element;
				if (childElement instanceof (this.window as any).HTMLElement) {
					this.renderElement(childElement);
				}
			} else if (childNode.nodeType === childNode.TEXT_NODE) {
				const textNode = childNode as Text;
				this.renderTextNode(textNode);
			}
		}
	}

	/**
	 * Create a merged DOM tree by cloning shadow DOM and replacing slots with light DOM content
	 */
	private createMergedDOMTree(
		shadowRoot: ShadowRoot,
		lightDOMElement: Element,
	): DocumentFragment {
		const mergedTree = this.document.createDocumentFragment();

		// Clone all shadow DOM children
		for (const childNode of shadowRoot.childNodes) {
			const clonedChild = this.cloneNodeWithSlotSubstitution(
				childNode,
				lightDOMElement,
			);
			if (clonedChild) {
				if (clonedChild.nodeType === clonedChild.DOCUMENT_FRAGMENT_NODE) {
					// If it's a fragment (from slot substitution), append all its children
					while (clonedChild.firstChild) {
						mergedTree.appendChild(clonedChild.firstChild);
					}
				} else {
					mergedTree.appendChild(clonedChild);
				}
			}
		}

		return mergedTree;
	}

	/**
	 * Clone a shadow DOM node, replacing slots with cloned light DOM content
	 */
	private cloneNodeWithSlotSubstitution(
		node: Node,
		lightDOMElement: Element,
	): Node | null {
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;

			// If this is a slot element, replace with cloned light DOM content
			if (element.tagName === "SLOT") {
				const slotName = element.getAttribute("name");
				const container = this.document.createDocumentFragment();

				if (slotName) {
					// Named slot - find light DOM children with matching slot attribute
					for (const lightChild of lightDOMElement.childNodes) {
						if (lightChild.nodeType === lightChild.ELEMENT_NODE) {
							const lightElement = lightChild as Element;
							if (lightElement.getAttribute("slot") === slotName) {
								const clonedLight = lightChild.cloneNode(true);
								// Track the relationship between cloned and original nodes (including text nodes)
								this.mapClonedTree(clonedLight, lightChild);

								container.appendChild(clonedLight);
							}
						}
					}
				} else {
					// Anonymous slot - take all light DOM children without slot attribute
					for (const lightChild of lightDOMElement.childNodes) {
						let shouldSlot = false;

						if (lightChild.nodeType === lightChild.ELEMENT_NODE) {
							const lightElement = lightChild as Element;
							// Only slot if no slot attribute (anonymous content)
							shouldSlot = !lightElement.hasAttribute("slot");
						} else if (lightChild.nodeType === lightChild.TEXT_NODE) {
							// All text nodes go to anonymous slot (including whitespace)
							shouldSlot = true;
						}

						if (shouldSlot) {
							const clonedLight = lightChild.cloneNode(true);
							// Track the relationship between cloned and original nodes (including text nodes)
							this.mapClonedTree(clonedLight, lightChild);

							container.appendChild(clonedLight);
						}
					}
				}

				// If no light DOM content was slotted, use slot's fallback content
				if (!container.hasChildNodes()) {
					for (const fallbackChild of element.childNodes) {
						const clonedFallback = fallbackChild.cloneNode(true);
						container.appendChild(clonedFallback);
					}
				}

				return container; // Return the entire container with all children
			} else {
				// Regular element - clone and recursively process children
				const clonedElement = element.cloneNode(false) as Element;

				// Process children with slot substitution
				for (const childNode of element.childNodes) {
					const clonedChild = this.cloneNodeWithSlotSubstitution(
						childNode,
						lightDOMElement,
					);
					if (clonedChild) {
						if (clonedChild.nodeType === clonedChild.DOCUMENT_FRAGMENT_NODE) {
							// If it's a fragment (from slot substitution), append all its children
							while (clonedChild.firstChild) {
								clonedElement.appendChild(clonedChild.firstChild);
							}
						} else {
							clonedElement.appendChild(clonedChild);
						}
					}
				}

				return clonedElement;
			}
		} else {
			// Text nodes and other nodes - just clone
			return node.cloneNode(true);
		}
	}

	/**
	 * Render a shadow DOM node, handling slot substitution
	 */
	private renderShadowNode(
		node: Node,
		slotAssignments: Map<Element, Node[]>,
	): void {
		if (node.nodeType === node.ELEMENT_NODE) {
			const element = node as Element;

			// Check if this is a slot element
			if (element.tagName === "SLOT") {
				// Render the assigned content instead of the slot
				const assignedContent = slotAssignments.get(element) || [];

				for (const assignedNode of assignedContent) {
					if (assignedNode.nodeType === assignedNode.ELEMENT_NODE) {
						const assignedElement = assignedNode as Element;
						if (assignedElement instanceof (this.window as any).HTMLElement) {
							this.renderElement(assignedElement);
						}
					} else if (assignedNode.nodeType === assignedNode.TEXT_NODE) {
						const assignedTextNode = assignedNode as Text;
						this.renderTextNode(assignedTextNode);
					}
				}
			} else {
				// Regular shadow DOM element - render normally, but check for slots in children
				if (element instanceof (this.window as any).HTMLElement) {
					// Before rendering this element, check if it contains any slots in its children
					this.renderElementWithSlotSubstitution(element, slotAssignments);
				}
			}
		} else if (node.nodeType === node.TEXT_NODE) {
			const textNode = node as Text;
			this.renderTextNode(textNode);
		}
	}

	/**
	 * Render an element, recursively handling any slot elements in its descendants
	 */
	private renderElementWithSlotSubstitution(
		element: Element,
		slotAssignments: Map<Element, Node[]>,
	): void {
		// Get the element's rect and styling like normal rendering
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

		// Background fill
		if (rect && style.bg != null) {
			this.renderer.fillRect(
				rect.left,
				rect.top,
				rect.width,
				rect.height,
				style.bg,
			);
		}

		// Handle borders
		if (rect) {
			const borderStyles = resolveBorderStyles(element);
			if (borderStyles.hasAnyBorder) {
				const borderCellStyle = {
					fg: style.fg || 0xffffff,
					bg: style.bg,
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

		// Process children with slot substitution
		for (const childNode of element.childNodes) {
			this.renderShadowNode(childNode, slotAssignments);
		}
	}

	/**
	 * Render a text node with proper styling from its parent element
	 */
	private renderTextNode(textNode: Text): void {
		const textContent = textNode.data;
		if (!textContent) return;

		const parentElement = textNode.parentElement;
		if (!parentElement) return;

		const textColor = this.window
			.getComputedStyle(parentElement)
			.getPropertyValue("color");
		const textBgColor = this.window
			.getComputedStyle(parentElement)
			.getPropertyValue("background-color");
		const textBold =
			this.window
				.getComputedStyle(parentElement)
				.getPropertyValue("font-weight") === "bold";
		const textItalic =
			this.window
				.getComputedStyle(parentElement)
				.getPropertyValue("font-style") === "italic";
		const textUnderline = this.window
			.getComputedStyle(parentElement)
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

	// TODO: move this to tables.ts? or layout.ts
	private renderTable(
		_tableElement: Element,
		_rect: DOMRect,
		_style: any,
	): void {
		// TODO: Re-implement table rendering - getTableInstance method doesn't exist
		// const tableInstance = this.layoutEngine.getTableInstance(tableElement);
		// if (!tableInstance) return;
		return;

		/*
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
		*/
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

		// Restore original attachShadow method
		if (this.originalAttachShadow) {
			this.window.Element.prototype.attachShadow = this.originalAttachShadow;
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
