/**
 * contenteditable: which element a caret edits, where the caret sits, and
 * what the keys do inside one.
 *
 * The default actions here are registered on the exchange, so they run
 * after an event has finished its propagation path and a page that called
 * preventDefault has already been heard.
 */

import {getFocusedElement} from "./dom.ts";

/** A caret or selection endpoint. */
export interface EditingPoint {
	node: globalThis.Node;
	offset: number;
}

interface Motion {
	granularity: string;
	forward: boolean;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// A control edits its own value and keeps its keys, whatever it sits in.
const TEXT_CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const ARROW_MOTIONS: Record<string, Motion> = {
	ArrowLeft: {granularity: "character", forward: false},
	ArrowRight: {granularity: "character", forward: true},
	ArrowUp: {granularity: "line", forward: false},
	ArrowDown: {granularity: "line", forward: true},
	Home: {granularity: "lineboundary", forward: false},
	End: {granularity: "lineboundary", forward: true},
};

/**
 * The element a caret in `node` edits: the nearest ancestor-or-self whose
 * contenteditable state is true, or the body of a designMode document.
 */
export function getEditingHost(
	node: globalThis.Node | null,
): globalThis.HTMLElement | null {
	if (node === null) {
		return null;
	}
	for (
		let element = asElement(node) ?? node.parentElement;
		element !== null;
		element = element.parentElement
	) {
		const state = (element as globalThis.HTMLElement).contentEditable;
		if (state === "true" || state === "plaintext-only") {
			return element as globalThis.HTMLElement;
		}
		if (state === "false") {
			return null;
		}
	}
	const document = node.ownerDocument;
	const body = document === null ? null : document.body;
	if (document === null || body === null || document.designMode !== "on") {
		return null;
	}
	return body.contains(node) ? body : null;
}

/**
 * Where the terminal cursor goes: the document selection's focus, when a
 * focused editing host holds it.
 */
export function getEditingCaretPoint(
	document: globalThis.Document,
): EditingPoint | null {
	const active = getFocusedElement(document);
	if (active === null || getEditingHost(active) !== active) {
		return null;
	}
	const selection = document.getSelection();
	if (selection === null || selection.focusNode === null) {
		return null;
	}
	if (!active.contains(selection.focusNode)) {
		return null;
	}
	return {node: selection.focusNode, offset: selection.focusOffset};
}

/** Wires the editing default actions onto an attached document's exchange. */
export function installEditing(exchange: globalThis.EventTarget): void {
	exchange.addEventListener("focus", onEditingFocus);
	exchange.addEventListener("keydown", onEditingKeydown);
}

function onEditingFocus(event: globalThis.Event): void {
	const host = getEditingHost(asNode(event.target));
	if (host === null || host !== event.target) {
		return;
	}
	ensureCaretInside(host);
}

/** The selection, with its focus moved into the host if it was elsewhere. */
function ensureCaretInside(
	host: globalThis.HTMLElement,
): globalThis.Selection | null {
	const selection = host.ownerDocument.getSelection();
	if (selection === null) {
		return null;
	}
	if (selection.focusNode === null || !host.contains(selection.focusNode)) {
		collapseTo(selection, getFirstCaretPoint(host));
	}
	return selection;
}

function onEditingKeydown(event: globalThis.Event): void {
	const keyboard = event as globalThis.KeyboardEvent;
	if (keyboard.defaultPrevented || isTextControl(asNode(event.target))) {
		return;
	}
	const host = getEditingHost(asNode(event.target));
	if (host === null) {
		return;
	}
	const motion = ARROW_MOTIONS[keyboard.key];
	if (motion === undefined) {
		return;
	}
	const byWord =
		(keyboard.altKey || keyboard.ctrlKey) && motion.granularity === "character";
	moveEditingCaret(
		host,
		byWord ? "word" : motion.granularity,
		motion.forward,
		keyboard.shiftKey,
	);
}

function moveEditingCaret(
	host: globalThis.HTMLElement,
	granularity: string,
	forward: boolean,
	extend: boolean,
): void {
	const selection = ensureCaretInside(host);
	if (selection === null) {
		return;
	}
	selection.modify(
		extend ? "extend" : "move",
		forward ? "forward" : "backward",
		granularity,
	);
	skipUneditable(host, selection, forward, extend);
}

// A contenteditable="false" island is one unit: the caret lands on the
// side of it the motion came from rather than anywhere inside.
function skipUneditable(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	forward: boolean,
	extend: boolean,
): void {
	if (selection.focusNode === null) {
		return;
	}
	const island = getUneditableIsland(host, selection.focusNode);
	if (island === null || island.parentNode === null) {
		return;
	}
	const index = getChildIndex(island);
	const point = normalizeCaretPoint({
		node: island.parentNode,
		offset: forward ? index + 1 : index,
	});
	if (extend) {
		selection.extend(point.node, point.offset);
	} else {
		collapseTo(selection, point);
	}
}

/** The outermost contenteditable="false" element between `node` and `host`. */
function getUneditableIsland(
	host: globalThis.HTMLElement,
	node: globalThis.Node,
): globalThis.Element | null {
	let island: globalThis.Element | null = null;
	for (
		let element = asElement(node) ?? node.parentElement;
		element !== null && element !== host;
		element = element.parentElement
	) {
		if ((element as globalThis.HTMLElement).contentEditable === "false") {
			island = element;
		}
	}
	return island;
}

/** The first place inside an element a caret can sit. */
function getFirstCaretPoint(element: globalThis.Element): EditingPoint {
	for (
		let node = element.firstChild; node !== null; node = element.firstChild
	) {
		if (node.nodeType === TEXT_NODE) {
			return {node, offset: 0};
		}
		if (node.nodeType !== ELEMENT_NODE || node.firstChild === null) {
			return {node: element, offset: 0};
		}
		element = node as globalThis.Element;
	}
	return {node: element, offset: 0};
}

// A point in an element next to a text node is the same place as a point
// in that text node, and the layout can only draw a caret in text.
function normalizeCaretPoint(point: EditingPoint): EditingPoint {
	if (point.node.nodeType !== ELEMENT_NODE) {
		return point;
	}
	const children = point.node.childNodes;
	const before = point.offset > 0 ? children[point.offset - 1] : null;
	if (before !== null && before.nodeType === TEXT_NODE) {
		return {node: before, offset: (before as globalThis.Text).data.length};
	}
	const after = children[point.offset] ?? null;
	if (after !== null && after.nodeType === TEXT_NODE) {
		return {node: after, offset: 0};
	}
	return point;
}

function collapseTo(
	selection: globalThis.Selection,
	point: EditingPoint,
): void {
	selection.setBaseAndExtent(
		point.node,
		point.offset,
		point.node,
		point.offset,
	);
}

function isTextControl(node: globalThis.Node | null): boolean {
	const element = node === null ? null : asElement(node);
	return element !== null && TEXT_CONTROL_TAGS.has(element.tagName);
}

function getChildIndex(node: globalThis.Node): number {
	let index = 0;
	for (
		let sibling = node.previousSibling;
		sibling !== null;
		sibling = sibling.previousSibling
	) {
		index++;
	}
	return index;
}

function asNode(target: globalThis.EventTarget | null): globalThis.Node | null {
	return target !== null && "nodeType" in target
		? (target as globalThis.Node)
		: null;
}

function asElement(node: globalThis.Node): globalThis.Element | null {
	return node.nodeType === ELEMENT_NODE ? (node as globalThis.Element) : null;
}
