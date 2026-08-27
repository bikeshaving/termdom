/**
 * String renderings of DOM objects, for debugging.
 */

// ANSI color codes for pretty printing
import {
	Comment,
	DOMRect,
	Document,
	DocumentFragment,
	Element,
	NodeList,
	Text,
	type Node,
} from "./dom.js";

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

interface NodeInspectOptions {
	colors?: boolean;
}

interface InspectorOptions {
	maxDepth?: number;
	colorize?: boolean;
}

function inspectElement(
	element: Element,
	options: InspectorOptions = {},
): string {
	return formatElement(element, options);
}

function inspectDocument(
	doc: Document,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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
			"\n" +
			formatElement(doc.documentElement as unknown as Element, {
				...options,
				currentDepth: 0,
			});
	}

	return output;
}

function inspectNode(
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

function formatElement(
	element: Element,
	options: InspectorOptions & {currentDepth?: number} = {},
): string {
	const {maxDepth = 2, colorize = true, currentDepth = 0} = options;
	const c = colorize ?
		colors :
			{
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
	const attrs = formatAttributes(element, {colorize});
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

		output += childrenStr;
	} else if (element.childNodes.length > 0) {
		output += `${c.dim}...${c.reset}`;
	}

	output += `${c.tag}</${tagName}>${c.reset}`;
	return output;
}

function formatAttributes(
	element: Element,
	options: {colorize?: boolean} = {},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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

	return attrs.join(" ");
}

function formatChildren(
	element: Element,
	options: InspectorOptions & {currentDepth?: number},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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
		const childStr = inspectNode(child as unknown as Node, options);
		if (childStr.trim()) {
			parts.push("\n" + indent + childStr);
		}
	}

	if (parts.length === 0) {
		return "";
	}

	return parts.join("") + "\n" + "  ".repeat((options.currentDepth || 1) - 1);
}

function inspectText(
	text: Text,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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

function inspectComment(
	comment: Comment,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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

function inspectFragment(
	fragment: DocumentFragment,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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
		const childStr = inspectNode(child as unknown as Node, options);
		if (childStr) {
			output += "\n" + childStr;
		}
	}

	return output;
}

function inspectDOMRect(
	rect: any,
	options: InspectorOptions = {},
): string {
	const {colorize = true} = options;
	const c = colorize ?
		colors :
			{
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

function inspectNodeList(
	nodeList: any,
	options: InspectorOptions = {},
): string {
	const {colorize = true, maxDepth = 0} = options;
	const c = colorize ?
		colors :
			{
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
				if (!node) {
					return "null";
				}
				return node.tagName ? `<${node.tagName.toLowerCase()}>` : node.nodeName;
			});
		const previewStr = preview.join(", ");
		const more = length > 3 ? `, ...${length - 3} more` : "";
		return `${c.comment}${typeName}(${length})${c.reset} [${previewStr}${more}]`;
	}

	let result = `${c.comment}${typeName}(${length})${c.reset} [\n`;

	for (let i = 0; i < length; i++) {
		const node = nodeList[i];
		if (!node) {
			result += `  ${c.value}${i}${c.reset}: null\n`;
		} else {
			const nodeStr = inspectNode(node, {...options, maxDepth: maxDepth - 1});
			result += `  ${c.value}${i}${c.reset}: ${nodeStr}\n`;
		}
	}

	result += "]";
	return result;
}

const kNodeInspect = Symbol.for("nodejs.util.inspect.custom");
function hook(
	prototype: object,
	render: (
		target: never,
		depth: number,
		options: NodeInspectOptions,
	) => string,
): void {
	Object.defineProperty(prototype, kNodeInspect, {
		value(this: never, depth: number, options: NodeInspectOptions) {
			return render(this, depth, options);
		},
		writable: true,
		configurable: true,
	});
}

hook(Element.prototype, (element: Element, depth, options) =>
	inspectElement(element, {
		maxDepth: depth,
		colorize: options.colors !== false,
	}),
);

hook(Text.prototype, (text: Text, _depth, options) =>
	inspectText(text, {colorize: options.colors !== false}),
);

hook(Comment.prototype, (comment: Comment, _depth, options) =>
	inspectComment(comment, {colorize: options.colors !== false}),
);

hook(DocumentFragment.prototype, (fragment: DocumentFragment, depth, options) =>
	inspectFragment(fragment, {
		maxDepth: depth,
		colorize: options.colors !== false,
	}),
);

hook(Document.prototype, (document: Document, depth, options) =>
	inspectDocument(document, {
		maxDepth: depth,
		colorize: options.colors !== false,
	}),
);

hook(DOMRect.prototype, (rect: DOMRect, _depth, options) =>
	inspectDOMRect(rect, {colorize: options.colors !== false}),
);

hook(NodeList.prototype, (list: NodeList, depth, options) =>
	inspectNodeList(list, {
		maxDepth: depth,
		colorize: options.colors !== false,
	}),
);
