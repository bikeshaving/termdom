/**
 * String renderings of DOM objects, for debugging.
 */

// ANSI color codes for pretty printing
const colors = {
	attr: "\x1b[36m", // Cyan for attributes
	bold: "\x1b[1m",
	comment: "\x1b[90m", // Gray for comments
	dim: "\x1b[2m",
	reset: "\x1b[0m",
	tag: "\x1b[35m", // Magenta for tags
	text: "\x1b[37m", // White for text content
	value: "\x1b[32m", // Green for values
};

export interface InspectorOptions {
	maxDepth?: number;
	colorize?: boolean;
	compact?: boolean;
	showStyles?: boolean;
	showAll?: boolean; // Show all attributes, not just important ones
}

/**
 * Inspect a DOM element and return a string representation
 */
export function inspectElement(
	element: Element,
	options: InspectorOptions = {},
): string {
	return formatElement(element, options);
}

/**
 * Inspect a DOM document
 */
export function inspectDocument(
	doc: Document,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	let output = `${c.comment}#document${c.reset}`;

	if (doc.doctype) {
		output += `\n${c.comment}<!DOCTYPE ${doc.doctype.name}>${c.reset}`;
	}

	if (doc.documentElement) {
		output +=
			"\n" + formatElement(doc.documentElement, {...options, currentDepth: 0});
	}

	return output;
}

/**
 * Inspect any DOM node
 */
export function inspectNode(
	node: Node,
	options: InspectorOptions = {},
): string {
	switch (node.nodeType) {
		case 1: // ELEMENT_NODE
			return inspectElement(node as Element, options);
		case 3: // TEXT_NODE
			return inspectText(node as Text, options);
		case 8: // COMMENT_NODE
			return inspectComment(node as Comment, options);
		case 9: // DOCUMENT_NODE
			return inspectDocument(node as Document, options);
		case 11: // DOCUMENT_FRAGMENT_NODE
			return inspectFragment(node as DocumentFragment, options);
		default:
			return `${node.nodeName}`;
	}
}

/**
 * Format an element as HTML-like string
 */
function formatElement(
	element: Element,
	options: InspectorOptions & {currentDepth?: number} = {},
): string {
	const {
		maxDepth = 2,
		colorize = true,
		compact = false,
		showStyles = false,
		showAll = false,
		currentDepth = 0,
	} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	const tagName = element.tagName.toLowerCase();
	let output = `${c.tag}<${tagName}${c.reset}`;

	// Add attributes
	const attrs = formatAttributes(element, {colorize, showAll, showStyles});
	if (attrs) {
		output += " " + attrs;
	}

	// Self-closing tags
	const selfClosing = [
		"area",
		"base",
		"br",
		"col",
		"embed",
		"hr",
		"img",
		"input",
		"link",
		"meta",
		"source",
		"track",
		"wbr",
	];
	if (selfClosing.includes(tagName)) {
		output += `${c.tag}>${c.reset}`;
		return output;
	}

	output += `${c.tag}>${c.reset}`;

	// Add children if within depth limit
	if (currentDepth < maxDepth && element.childNodes.length > 0) {
		const childrenStr = formatChildren(element, {
			...options,
			currentDepth: currentDepth + 1,
		});

		if (compact && childrenStr.includes("\n")) {
			// In compact mode, show ellipsis for multi-line content
			output += `${c.dim}...${c.reset}`;
		} else {
			output += childrenStr;
		}
	} else if (element.childNodes.length > 0) {
		output += `${c.dim}...${c.reset}`;
	}

	output += `${c.tag}</${tagName}>${c.reset}`;
	return output;
}

/**
 * Format element attributes
 */
function formatAttributes(
	element: Element,
	options: {colorize?: boolean; showAll?: boolean; showStyles?: boolean} = {},
): string {
	const {colorize = true, showAll = false, showStyles = false} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	const attrs: string[] = [];

	// Always show id and class
	if (element.id) {
		attrs.push(`${c.attr}id${c.reset}=${c.value}"${element.id}"${c.reset}`);
	}

	if (element.className) {
		attrs.push(
			`${c.attr}class${c.reset}=${c.value}"${element.className}"${c.reset}`,
		);
	}

	if (showAll) {
		// Show all attributes
		for (const attr of Array.from(element.attributes)) {
			if (
				attr.name !== "id" &&
				attr.name !== "class" &&
				attr.name !== "style"
			) {
				attrs.push(
					`${c.attr}${attr.name}${c.reset}=${c.value}"${attr.value}"${c.reset}`,
				);
			}
		}
	} else {
		// Show only important attributes
		const importantAttrs = [
			"href",
			"src",
			"type",
			"name",
			"value",
			"disabled",
			"checked",
			"selected",
			"readonly",
			"placeholder",
			"alt",
			"title",
		];
		for (const attrName of importantAttrs) {
			if (element.hasAttribute(attrName)) {
				const value = element.getAttribute(attrName);
				if (value !== null && value.length < 50) {
					attrs.push(
						`${c.attr}${attrName}${c.reset}=${c.value}"${value}"${c.reset}`,
					);
				}
			}
		}
	}

	// Handle style attribute
	if (showStyles && element.hasAttribute("style")) {
		const style = element.getAttribute("style");
		if (style && style.length < 100) {
			attrs.push(`${c.attr}style${c.reset}=${c.value}"${style}"${c.reset}`);
		} else if (style) {
			attrs.push(
				`${c.attr}style${c.reset}=${c.value}"${style.substring(0, 97)}..."${c.reset}`,
			);
		}
	}

	return attrs.join(" ");
}

/**
 * Format children nodes
 */
function formatChildren(
	element: Element,
	options: InspectorOptions & {currentDepth?: number},
): string {
	const {colorize = true, compact = false} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	const children = Array.from(element.childNodes);

	// Single text node - inline it
	if (children.length === 1 && children[0].nodeType === 3) {
		const text = children[0].textContent || "";
		if (text.trim() && text.length < 50) {
			return `${c.text}${text.trim()}${c.reset}`;
		} else if (text.trim()) {
			return `${c.text}${text.substring(0, 47).trim()}...${c.reset}`;
		}
		return "";
	}

	// Multiple children
	const parts: string[] = [];
	const indent = "  ".repeat(options.currentDepth || 0);

	for (const child of children) {
		const childStr = inspectNode(child, options);
		if (childStr.trim()) {
			if (compact) {
				parts.push(childStr);
			} else {
				parts.push("\n" + indent + childStr);
			}
		}
	}

	if (parts.length === 0) {
		return "";
	}

	if (compact) {
		return parts.join("");
	} else {
		return parts.join("") + "\n" + "  ".repeat((options.currentDepth || 1) - 1);
	}
}

/**
 * Inspect a text node
 */
function inspectText(text: Text, options: InspectorOptions = {}): string {
	const {colorize = true} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	const content = text.textContent || "";
	if (!content.trim()) {
		return "";
	}

	if (content.length > 80) {
		return `${c.text}${content.substring(0, 77).trim()}...${c.reset}`;
	}

	return `${c.text}${content.trim()}${c.reset}`;
}

/**
 * Inspect a comment node
 */
function inspectComment(
	comment: Comment,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	const content = comment.textContent || "";
	return `${c.comment}<!--${content}-->${c.reset}`;
}

/**
 * Inspect a document fragment
 */
function inspectFragment(
	fragment: DocumentFragment,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	let output = `${c.comment}#document-fragment${c.reset}`;

	for (const child of Array.from(fragment.childNodes)) {
		const childStr = inspectNode(child, options);
		if (childStr) {
			output += "\n" + childStr;
		}
	}

	return output;
}

/**
 * Inspect a CSSStyleDeclaration, as the properties it actually declares
 */
export function inspectCSSStyleDeclaration(
	styles: any,
	options: InspectorOptions = {},
): string {
	const {colorize = true, compact = false} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	// Get only the properties that have values
	const setProps: string[] = [];
	const limit = compact ? 5 : styles.length; // Only truncate when nested/compact

	for (let i = 0; i < Math.min(styles.length, limit); i++) {
		const prop = styles[i];
		const value = styles.getPropertyValue(prop);
		if (value) {
			setProps.push(`${c.attr}${prop}${c.reset}: ${c.value}${value}${c.reset}`);
		}
	}

	const totalProps = styles.length;

	if (setProps.length === 0) {
		return `${c.comment}CSSStyleDeclaration(${totalProps} properties)${c.reset} {}`;
	}

	let result = `${c.comment}CSSStyleDeclaration(${totalProps} properties)${c.reset} {\n`;
	result += setProps.map((prop) => `  ${prop}`).join(",\n");

	// Only show truncation when in compact mode
	if (compact && totalProps > limit) {
		result += `,\n  ${c.dim}... ${totalProps - limit} more properties${c.reset}`;
	}

	result += "\n}";
	return result;
}

/**
 * Inspect a DOMRect - much more concise than default
 */
export function inspectDOMRect(
	rect: any,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	return `${c.comment}DOMRect${c.reset} { ${c.attr}x${c.reset}: ${c.value}${rect.x}${c.reset}, ${c.attr}y${c.reset}: ${c.value}${rect.y}${c.reset}, ${c.attr}width${c.reset}: ${c.value}${rect.width}${c.reset}, ${c.attr}height${c.reset}: ${c.value}${rect.height}${c.reset} }`;
}

/**
 * Inspect a NodeList/HTMLCollection - more concise than default
 */
export function inspectNodeList(
	nodeList: any,
	options: InspectorOptions = {},
): string {
	const {colorize = true, maxDepth = 0, compact = false} = options;
	const c = colorize
		? colors
		: {
				tag: "",
				attr: "",
				value: "",
				text: "",
				comment: "",
				reset: "",
				dim: "",
				bold: "",
			};

	const typeName = nodeList.constructor.name;
	const length = nodeList.length;

	if (length === 0) {
		return `${c.comment}${typeName}(0)${c.reset} []`;
	}

	if (maxDepth === 0) {
		// Just show count and first few tag names
		const preview = Array.from(nodeList)
			.slice(0, 3)
			.map((node: any) => {
				if (!node) return "null";
				return node.tagName ? `<${node.tagName.toLowerCase()}>` : node.nodeName;
			});
		const previewStr = preview.join(", ");
		const more = length > 3 ? `, ...${length - 3} more` : "";
		return `${c.comment}${typeName}(${length})${c.reset} [${previewStr}${more}]`;
	}

	// Full inspection - only truncate if compact
	const limit = compact ? 5 : length;
	let result = `${c.comment}${typeName}(${length})${c.reset} [\n`;

	for (let i = 0; i < Math.min(length, limit); i++) {
		const node = nodeList[i];
		if (!node) {
			result += `  ${c.value}${i}${c.reset}: null\n`;
		} else {
			const nodeStr = inspectNode(node, {...options, maxDepth: maxDepth - 1});
			result += `  ${c.value}${i}${c.reset}: ${nodeStr}\n`;
		}
	}

	if (compact && length > limit) {
		result += `  ${c.dim}... ${length - limit} more items${c.reset}\n`;
	}

	result += "]";
	return result;
}

/**
 * Setup inspect methods on DOM prototypes
 */
export function setupInspectMethods(window: any): void {
	const inspect = Symbol.for("nodejs.util.inspect.custom");

	// Element
	if (!window.Element.prototype[inspect]) {
		window.Element.prototype[inspect] = function (
			this: Element,
			depth: number,
			options: any,
		) {
			return inspectElement(this, {
				maxDepth: depth,
				colorize: options.colors !== false,
				compact: !options.breakLength || options.breakLength === Infinity,
				showStyles: options.showHidden,
			});
		};
	}

	// Document
	if (!window.Document.prototype[inspect]) {
		window.Document.prototype[inspect] = function (
			this: Document,
			depth: number,
			options: any,
		) {
			return inspectDocument(this, {
				maxDepth: depth,
				colorize: options.colors !== false,
				compact: !options.breakLength || options.breakLength === Infinity,
			});
		};
	}

	// Text
	if (!window.Text.prototype[inspect]) {
		window.Text.prototype[inspect] = function (
			this: Text,
			depth: number,
			options: any,
		) {
			return inspectText(this, {
				colorize: options.colors !== false,
			});
		};
	}

	// Comment
	if (!window.Comment.prototype[inspect]) {
		window.Comment.prototype[inspect] = function (
			this: Comment,
			depth: number,
			options: any,
		) {
			return inspectComment(this, {
				colorize: options.colors !== false,
			});
		};
	}

	// DocumentFragment
	if (!window.DocumentFragment.prototype[inspect]) {
		window.DocumentFragment.prototype[inspect] = function (
			this: DocumentFragment,
			depth: number,
			options: any,
		) {
			return inspectFragment(this, {
				maxDepth: depth,
				colorize: options.colors !== false,
			});
		};
	}

	// CSSStyleDeclaration, as the properties it actually declares
	if (
		window.CSSStyleDeclaration &&
		!window.CSSStyleDeclaration.prototype[inspect]
	) {
		window.CSSStyleDeclaration.prototype[inspect] = function (
			this: any,
			depth: number,
			options: any,
		) {
			// Only compact when nested (depth less than 2 means we're nested)
			const isNested = depth < 2;

			return inspectCSSStyleDeclaration(this, {
				colorize: options.colors !== false,
				compact: isNested,
			});
		};
	}

	// NodeList - Make more concise
	if (window.NodeList && !window.NodeList.prototype[inspect]) {
		window.NodeList.prototype[inspect] = function (
			this: any,
			depth: number,
			options: any,
		) {
			const isNested = depth < 2;
			const explicitlyCompact = options.compact;
			const hasBreakLength =
				options.breakLength && options.breakLength !== Infinity;

			return inspectNodeList(this, {
				maxDepth: depth,
				colorize: options.colors !== false,
				compact: explicitlyCompact || (isNested && hasBreakLength),
			});
		};
	}

	// HTMLCollection - Make more concise
	if (window.HTMLCollection && !window.HTMLCollection.prototype[inspect]) {
		window.HTMLCollection.prototype[inspect] = function (
			this: any,
			depth: number,
			options: any,
		) {
			const isNested = depth < 2;
			const explicitlyCompact = options.compact;
			const hasBreakLength =
				options.breakLength && options.breakLength !== Infinity;

			return inspectNodeList(this, {
				maxDepth: depth,
				colorize: options.colors !== false,
				compact: explicitlyCompact || (isNested && hasBreakLength),
			});
		};
	}

	// DOMRect - Make much more concise
	if (window.DOMRect && !window.DOMRect.prototype[inspect]) {
		window.DOMRect.prototype[inspect] = function (
			this: any,
			depth: number,
			options: any,
		) {
			return inspectDOMRect(this, {
				colorize: options.colors !== false,
			});
		};
	}
}
