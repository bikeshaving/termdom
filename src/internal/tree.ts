/**
 * The node tree as the engine reads it: node types, namespaces, the links
 * between nodes and an element's attributes, read straight from their
 * slots. Nothing here builds or changes a tree, so every module that walks
 * one can import it without importing the DOM.
 */
import type {
	Attr,
	AttributeSlots,
	CharacterData,
	Document,
	Element,
	Node,
} from "./dom.ts";
import type {Exchange} from "./exchange.ts";
import {
	_,
	_maybe,
	getObject,
	getSlots,
	rememberObject,
	type Slots,
} from "./slots.ts";
import {toASCIILowercase} from "./text.ts";
import type {CellSizeSetting} from "./units.ts";

export const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
export const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
export const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
export const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

export const ELEMENT_NODE = 1;
export const ATTRIBUTE_NODE = 2;
export const TEXT_NODE = 3;
export const CDATA_SECTION_NODE = 4;
export const ENTITY_REFERENCE_NODE = 5;
export const ENTITY_NODE = 6;
export const PROCESSING_INSTRUCTION_NODE = 7;
export const COMMENT_NODE = 8;
export const DOCUMENT_NODE = 9;
export const DOCUMENT_TYPE_NODE = 10;
export const DOCUMENT_FRAGMENT_NODE = 11;
export const NOTATION_NODE = 12;

export function getRoot(node: Node): Node {
	return _(node).treeRoot;
}

export function isInclusiveAncestor(ancestor: Node, node: Node): boolean {
	let current: Node | null = node;
	while (current !== null) {
		if (current === ancestor) {
			return true;
		}
		current = getObject(_(current).parent);
	}
	return false;
}

/** The next node in tree order, or null once the walk leaves the root. */
export function nextInTree(node: Node, root: Node): Node | null {
	const nodeSlots = getSlots(node);
	if (nodeSlots.firstChild !== null) {
		return rememberObject(nodeSlots.firstChild);
	}
	// The root is compared, not looked up, so a walk that calls this for
	// every node keeps the node it is on in the lookup cache.
	let current: Slots<Node> | null = nodeSlots;
	while (current !== null && getObject(current) !== root) {
		if (current.next !== null) {
			return rememberObject(current.next);
		}
		current = current.parent;
	}
	return null;
}

export function nextSlotsInTree(
	node: Slots<Node>,
	root: Slots<Node>,
): Slots<Node> | null {
	if (node.firstChild !== null) {
		return node.firstChild;
	}
	let current: Slots<Node> | null = node;
	while (current !== null && current !== root) {
		if (current.next !== null) {
			return current.next;
		}
		current = current.parent;
	}
	return null;
}

export function getParentNode(node: Node): Node | null {
	return getObject(_(node).parent);
}

export function getFirstChildNode(node: Node): Node | null {
	return getObject(_(node).firstChild);
}

export function getNextSiblingNode(node: Node): Node | null {
	return getObject(_(node).next);
}

export function getPreviousSiblingNode(node: Node): Node | null {
	return getObject(_(node).previous);
}

export function getElementChildren(parent: Node): Element[] {
	const elements: Element[] = [];
	for (let nodeSlots = _(parent).firstChild;
		nodeSlots !== null;
		nodeSlots = nodeSlots.next) {
		const node = getObject(nodeSlots);
		if (getNodeType(node) === ELEMENT_NODE) {
			elements.push(node as Element);
		}
	}
	return elements;
}

/**
 * An element's attributes, as their slots, for engine code that reads
 * them. `attributes` would build a live NamedNodeMap to hand out.
 */
export function getAttributeList(
	element: globalThis.Element,
): readonly AttributeSlots[] {
	return _(element as Element).attributeList;
}

export function getAttributeByName(
	element: Element,
	qualifiedName: string,
): Attr | null {
	let name = qualifiedName;
	const elementSlots = _(element);
	if (
		elementSlots.namespace === HTML_NAMESPACE &&
		isHTMLDocument(elementSlots.document)
	) {
		name = toASCIILowercase(name);
	}
	for (const attribute of elementSlots.attributeList) {
		if (attribute._qualifiedName === name) {
			return getObject(attribute);
		}
	}
	return null;
}

export function isHTMLDocument(document: Document): boolean {
	return _(document).extra.type === "html";
}

export function isElement(node: Node): node is Element {
	return _(node).nodeType === ELEMENT_NODE;
}

/** The node's nodeType, read without going through the page's binding. */
export function getNodeType(node: globalThis.Node): number {
	return _(node as Node).nodeType;
}

/** The node's ownerDocument, read without going through its binding. */
export function getOwnerDocument(node: globalThis.Node): Document | null {
	const document = _(node as Node).document;
	return document === (node as unknown) ? null : document;
}

/** The document's window, read without going through its binding. */
export function getDefaultView(
	document: globalThis.Document,
): (globalThis.Window & typeof globalThis) | null {
	return _(document as unknown as Document).extra.defaultView as
		(globalThis.Window & typeof globalThis) | null;
}

/** A Text or comment node's data, read without going through its binding. */
export function getCharacterData(node: globalThis.CharacterData): string {
	return _(node as unknown as CharacterData).data;
}

/** The element's localName, read without going through its binding. */
export function getLocalName(element: globalThis.Element): string {
	return _(element as Element).localName;
}

/** Node's contains, for the engine's own calls. */
export function nodeContains(
	node: globalThis.Node,
	other: globalThis.Node | null | undefined,
): boolean {
	return other != null &&
		isInclusiveAncestor(node as unknown as Node, other as unknown as Node);
}

/** The element's attribute's value, read without going through its binding. */
export function getAttributeValue(
	element: globalThis.Element,
	qualifiedName: string,
): string | null {
	const attribute = getAttributeByName(element as Element, qualifiedName);
	return attribute === null ? null : _(attribute).extra.value;
}

/** Whether the element has the attribute, without going through its binding. */
export function hasAttributeByName(
	element: globalThis.Element,
	qualifiedName: string,
): boolean {
	return getAttributeByName(element as Element, qualifiedName) !== null;
}

/** The element's namespaceURI, read without going through its binding. */
export function getNamespace(element: globalThis.Element): string | null {
	return _(element as Element).namespace;
}

export function parentElement(node: Node): Element | null {
	const parent = getObject(_(node).parent);
	return parent !== null && isElement(parent) ? parent : null;
}

/** The terminal behind a document, while it is attached to one. */
export function getDocumentExchange(
	document: globalThis.Document | null,
): Exchange | null {
	if (document === null) {
		return null;
	}
	const attached = getAttachedDocument(document as unknown as Document);
	return attached === undefined ? null : _(attached).extra.exchange;
}

// A document that has been adopted. It renders, and knows what it
// renders through.
export type AttachedDocument = Document;

export function getAttachedDocument(
	node: globalThis.Node,
): AttachedDocument | undefined {
	const document = _(node as Node).document;
	return _(document).extra.exchange !== undefined
		? (document as AttachedDocument)
		: undefined;
}

/** The cellSize option of the TermDOM drawing the node's document. */
export function getCellSizeSetting(
	node: globalThis.Node,
): CellSizeSetting | undefined {
	return _maybe(getAttachedDocument(node))?.extra.cellSize;
}

/**
 * One cell in the terminal's pixels, as the framebuffer drawing the
 * node's document has it, or null for a document no TermDOM draws.
 */
export function getCellPixels(
	node: globalThis.Node,
): Readonly<{width: number; height: number}> | null {
	return _maybe(getAttachedDocument(node))?.extra.framebuffer.cellPixels ??
		null;
}
