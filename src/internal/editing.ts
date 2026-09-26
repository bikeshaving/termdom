/**
 * contenteditable: which element a caret edits, where the caret sits, and
 * what the keys do inside one.
 *
 * The default actions here are registered on the exchange, so they run
 * after an event has finished its propagation path and a page that called
 * preventDefault has already been heard.
 */

import {dispatchAsUserAgent, getFocusedElement} from "./dom.ts";
import {getNextGraphemeBoundary, getPreviousGraphemeBoundary} from "./text.ts";

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

const SPACE = " ";
const NBSP = "\u00a0";

// Text made only of these renders nothing under a collapsing
// white-space, so it is not content a space can sit beside.
const COLLAPSIBLE_ONLY = /^[ \t\n\r\f]*$/;

// A control edits its own value and keeps its keys, whatever it sits in.
const TEXT_CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// The elements a caret's line is bounded by. The editing host itself
// bounds a line whatever its tag.
const BLOCK_TAGS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"dd",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"td",
	"th",
	"tr",
	"ul",
]);

// Nothing inside these is a place for a caret, so a delete takes the
// whole element.
const ATOMIC_TAGS = new Set(["br", "hr", "img", "input", "select", "textarea"]);

// White-space values that keep every space the tree holds. Under the
// rest an inserted space has to be written as a non-breaking space where
// a collapsible one would render as nothing.
const PRESERVED_WHITE_SPACE = new Set(["pre", "pre-wrap", "break-spaces"]);

// What a keystroke in a host asks for, before anything in the tree moves.
const EDIT_CHORDS: Record<string, string> = {
	"alt+Backspace": "deleteWordBackward",
	"ctrl+w": "deleteWordBackward",
	"ctrl+u": "deleteSoftLineBackward",
	"ctrl+k": "deleteSoftLineForward",
};

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
	exchange.addEventListener("beforeinput", onEditingBeforeInput);
}

/**
 * Asks an editing host to insert text, as the default action of the
 * keypress or paste the text came from. False when the target edits
 * nothing.
 */
export function requestEditingInsert(
	target: globalThis.Node,
	inputType: string,
	data: string,
): boolean {
	const host = isTextControl(target) ? null : getEditingHost(target);
	if (host === null) {
		return false;
	}
	requestEditingInput(host, inputType, data);
	return true;
}

// beforeinput is where a page cancels an edit, so every edit is asked
// for here and carried out by the exchange's listener below.
function requestEditingInput(
	host: globalThis.HTMLElement,
	inputType: string,
	data: string | null,
): void {
	const view = host.ownerDocument.defaultView;
	if (view === null) {
		return;
	}
	dispatchAsUserAgent(
		getInputTarget(host),
		new view.InputEvent("beforeinput", {
			inputType,
			data,
			bubbles: true,
			composed: true,
			cancelable: true,
		}),
	);
}

function onEditingBeforeInput(event: globalThis.Event): void {
	const request = event as globalThis.InputEvent;
	if (request.defaultPrevented || isTextControl(asNode(event.target))) {
		return;
	}
	const host = getEditingHost(asNode(event.target));
	const view = host === null ? null : host.ownerDocument.defaultView;
	if (host === null || view === null) {
		return;
	}
	if (!applyEditingInput(host, request.inputType, request.data)) {
		return;
	}
	dispatchAsUserAgent(
		getInputTarget(host),
		new view.InputEvent("input", {
			inputType: request.inputType,
			data: request.data,
			bubbles: true,
			composed: true,
		}),
	);
}

/** The deepest element around the caret, which is where an edit happens. */
function getInputTarget(host: globalThis.HTMLElement): globalThis.Element {
	const selection = host.ownerDocument.getSelection();
	const focus = selection === null ? null : selection.focusNode;
	if (focus === null || !host.contains(focus)) {
		return host;
	}
	return asElement(focus) ?? focus.parentElement ?? host;
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
	if (motion !== undefined) {
		const byWord =
			(keyboard.altKey || keyboard.ctrlKey) &&
			motion.granularity === "character";
		moveEditingCaret(
			host,
			byWord ? "word" : motion.granularity,
			motion.forward,
			keyboard.shiftKey,
		);
		return;
	}
	const inputType = getEditInputType(keyboard);
	if (inputType !== null) {
		requestEditingInput(host, inputType, null);
	}
}

function getEditInputType(keyboard: globalThis.KeyboardEvent): string | null {
	if (keyboard.ctrlKey || keyboard.altKey) {
		const modifier = keyboard.ctrlKey ? "ctrl" : "alt";
		return EDIT_CHORDS[`${modifier}+${keyboard.key}`] ?? null;
	}
	if (keyboard.key === "Backspace") {
		return "deleteContentBackward";
	}
	if (keyboard.key === "Delete") {
		return "deleteContentForward";
	}
	if (keyboard.key === "Enter") {
		return keyboard.shiftKey ? "insertLineBreak" : "insertParagraph";
	}
	return null;
}

function moveEditingCaret(
	host: globalThis.HTMLElement,
	granularity: string,
	forward: boolean,
	extend: boolean,
): void {
	const selection = ensureCaretInside(host);
	if (selection === null || selection.focusNode === null) {
		return;
	}
	const alter = extend ? "extend" : "move";
	const direction = forward ? "forward" : "backward";
	const from = {node: selection.focusNode, offset: selection.focusOffset};
	selection.modify(alter, direction, granularity);
	if (selection.focusNode !== null && !host.contains(selection.focusNode)) {
		if (extend) {
			selection.extend(from.node, from.offset);
		} else {
			collapseTo(selection, from);
		}
		selection.modify(alter, direction, "lineboundary");
	}
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
/** The first place the caret can show: the first text with something in it. */
function getFirstCaretPoint(element: globalThis.Element): EditingPoint {
	let fallback: EditingPoint | null = null;
	let node: globalThis.Node | null = element.firstChild;
	while (node !== null) {
		if (node.nodeType === TEXT_NODE) {
			const data = (node as globalThis.Text).data;
			if (!COLLAPSIBLE_ONLY.test(data)) {
				return {node, offset: data.search(/[^ \t\n\r\f]/)};
			}
			fallback ??= {node, offset: 0};
		} else if (node.nodeType === ELEMENT_NODE && node.firstChild === null) {
			fallback ??= {node, offset: 0};
		}
		if (node.firstChild !== null) {
			node = node.firstChild;
		} else {
			while (node !== null && node !== element && node.nextSibling === null) {
				node = node.parentNode;
			}
			node = node === null || node === element ? null : node.nextSibling;
		}
	}
	return fallback ?? {node: element, offset: 0};
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

// Every edit an uncanceled beforeinput asks for. True when the tree
// changed, which is what decides whether an input event follows.
function applyEditingInput(
	host: globalThis.HTMLElement,
	inputType: string,
	data: string | null,
): boolean {
	const selection = ensureCaretInside(host);
	if (selection === null) {
		return false;
	}
	switch (inputType) {
		case "insertText":
			return data !== null &&
				data !== "" &&
				insertEditingText(host, selection, data);
		case "insertFromPaste":
			return data !== null &&
				data !== "" &&
				insertPastedText(host, selection, data);
		case "insertParagraph":
			return insertEditingParagraph(host, selection);
		case "insertLineBreak":
			return insertEditingLineBreak(host, selection);
		case "deleteContentBackward":
			return deleteEditingContent(host, selection, false);
		case "deleteContentForward":
			return deleteEditingContent(host, selection, true);
		case "deleteWordBackward":
			return deleteEditingBy(host, selection, "word", false);
		case "deleteSoftLineBackward":
			return deleteEditingBy(host, selection, "lineboundary", false);
		case "deleteSoftLineForward":
			return deleteEditingBy(host, selection, "lineboundary", true);
		default:
			return false;
	}
}

function insertEditingText(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	text: string,
): boolean {
	deleteSelectionContents(host, selection);
	const point = openTextAt(host, getCaretPoint(selection));
	point.node.insertData(point.offset, text);
	const end = point.offset + text.length;
	// Before the caret moves: rewriting the run moves a boundary point
	// inside it back to where the run began.
	normalizeSpaces(host, point.node, point.offset, end);
	collapseTo(selection, {node: point.node, offset: end});
	return true;
}

// A pasted line break is a new block, the way Enter's is. HTML on the
// clipboard is not read.
function insertPastedText(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	text: string,
): boolean {
	deleteSelectionContents(host, selection);
	const lines = text.split("\n");
	for (let at = 0; at < lines.length; at++) {
		if (at > 0) {
			insertEditingParagraph(host, selection);
		}
		if (lines[at] !== "") {
			insertEditingText(host, selection, lines[at]);
		}
	}
	return true;
}

// Enter splits the caret's block in two. The inline elements around the
// caret are split with it, because the range takes a copy of every
// element it is only partly inside.
function insertEditingParagraph(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
): boolean {
	deleteSelectionContents(host, selection);
	let point = getCaretPoint(selection);
	let block = getBlockContainer(host, point.node);
	if (block === host) {
		block = wrapLineInBlock(host, point);
		if (point.node === host) {
			point = {node: block, offset: block.childNodes.length};
		}
	}
	if (block.localName === "li" && !hasRenderedContent(block)) {
		return leaveList(selection, block);
	}
	const document = host.ownerDocument;
	const created = document.createElement(
		getSeparatorTag(block, isAtBlockEnd(host, point)),
	);
	const tail = document.createRange();
	tail.setStart(point.node, point.offset);
	tail.setEnd(block, block.childNodes.length);
	created.appendChild(tail.extractContents());
	block.parentNode!.insertBefore(created, block.nextSibling);
	fillEmptyBlock(block);
	fillEmptyBlock(created);
	collapseTo(selection, normalizeCaretPoint(getFirstCaretPoint(created)));
	return true;
}

function insertEditingLineBreak(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
): boolean {
	deleteSelectionContents(host, selection);
	const document = host.ownerDocument;
	const lineBreak = document.createElement("br");
	insertNodeAt(getCaretPoint(selection), lineBreak);
	const after = {
		node: lineBreak.parentNode!,
		offset: getChildIndex(lineBreak) + 1,
	};
	// A break with nothing after it opens a line the layout has no reason
	// to keep, so it gets the same placeholder an empty block gets.
	if (isAtBlockEnd(host, after)) {
		lineBreak.parentNode!.insertBefore(
			document.createElement("br"),
			lineBreak.nextSibling,
		);
	}
	collapseTo(selection, after);
	return true;
}

// Chrome ends the list rather than making another empty item, and the
// items below the one left behind carry on in a list of their own.
function leaveList(
	selection: globalThis.Selection,
	item: globalThis.Element,
): boolean {
	const list = item.parentElement;
	if (list === null || list.parentNode === null) {
		return false;
	}
	const document = item.ownerDocument;
	const block = document.createElement("div");
	list.parentNode.insertBefore(block, list.nextSibling);
	if (item.nextSibling !== null) {
		const rest = document.createElement(list.localName);
		while (item.nextSibling !== null) {
			rest.appendChild(item.nextSibling);
		}
		block.parentNode!.insertBefore(rest, block.nextSibling);
	}
	item.remove();
	fillEmptyBlock(block);
	if (list.firstChild === null) {
		list.remove();
	}
	collapseTo(selection, {node: block, offset: 0});
	return true;
}

// Chrome's default paragraph separator is a div. A paragraph and a list
// item split into their own kind; a heading does too, except at its end,
// where what follows a heading is body text.
function getSeparatorTag(block: globalThis.Element, atEnd: boolean): string {
	const tag = block.localName;
	if (tag === "li" || tag === "p") {
		return tag;
	}
	if (HEADING_TAGS.has(tag)) {
		return atEnd ? "div" : tag;
	}
	return "div";
}

// Enter with the caret in the host itself has no block to split, so the
// line the caret is on becomes one, which is what Chrome does.
function wrapLineInBlock(
	host: globalThis.HTMLElement,
	point: EditingPoint,
): globalThis.Element {
	const block = host.ownerDocument.createElement("div");
	let top: globalThis.Node | null = point.node === host
		? (host.childNodes[point.offset] ?? host.lastChild)
		: point.node;
	while (top !== null && top.parentNode !== host) {
		top = top.parentNode;
	}
	if (top === null) {
		host.appendChild(block);
		return block;
	}
	let first = top;
	while (
		first.previousSibling !== null &&
		!isBlockElement(host, first.previousSibling)
	) {
		first = first.previousSibling;
	}
	let last = top;
	while (last.nextSibling !== null && !isBlockElement(host, last.nextSibling)) {
		last = last.nextSibling;
	}
	host.insertBefore(block, first);
	for (let node: globalThis.Node = first; ;) {
		const next = node.nextSibling;
		block.appendChild(node);
		if (node === last || next === null) {
			break;
		}
		node = next;
	}
	return block;
}

// Backspace at a block's start, or Delete at its end, runs the two
// blocks together and takes the emptied one out.
function mergeBlocks(
	first: globalThis.Element,
	second: globalThis.Element,
	selection: globalThis.Selection,
): void {
	const placeholder = getPlaceholderBreak(first);
	if (placeholder !== null) {
		placeholder.remove();
	}
	const at =
		normalizeCaretPoint({node: first, offset: first.childNodes.length});
	while (second.firstChild !== null) {
		first.appendChild(second.firstChild);
	}
	removeWithEmptiedAncestors(second);
	fillEmptyBlock(first);
	collapseTo(selection, at);
}

function removeWithEmptiedAncestors(element: globalThis.Element): void {
	const parent = element.parentElement;
	element.remove();
	if (
		parent !== null &&
		parent.firstChild === null &&
		getEditingHost(parent) !== parent
	) {
		removeWithEmptiedAncestors(parent);
	}
}

/** The block that renders just before this one inside the host. */
function getNeighborBlock(
	host: globalThis.HTMLElement,
	block: globalThis.Element,
	forward: boolean,
): globalThis.Element | null {
	for (
		let node: globalThis.Node = block;
		node !== host && node.parentNode !== null;
		node = node.parentNode
	) {
		for (
			let sibling = forward ? node.nextSibling : node.previousSibling;
			sibling !== null;
			sibling = forward ? sibling.nextSibling : sibling.previousSibling
		) {
			const found = getEdgeBlockIn(host, sibling, forward);
			if (found !== null) {
				return found;
			}
		}
	}
	return null;
}

function getEdgeBlockIn(
	host: globalThis.HTMLElement,
	node: globalThis.Node,
	forward: boolean,
): globalThis.Element | null {
	if (node.nodeType !== ELEMENT_NODE) {
		return null;
	}
	const element = node as globalThis.Element;
	for (
		let child = forward ? element.firstChild : element.lastChild;
		child !== null;
		child = forward ? child.nextSibling : child.previousSibling
	) {
		const found = getEdgeBlockIn(host, child, forward);
		if (found !== null) {
			return found;
		}
	}
	return isBlockElement(host, element) ? element : null;
}

/** A <br> whose only job is to give an empty line its height. */
function getPlaceholderBreak(
	block: globalThis.Element,
): globalThis.Element | null {
	const last = block.lastChild;
	if (last === null || !isBreak(last)) {
		return null;
	}
	for (
		let node = last.previousSibling; node !== null; node = node.previousSibling
	) {
		if (isBreak(node)) {
			return last as globalThis.Element;
		}
		if (isRenderedNode(node)) {
			return null;
		}
	}
	return last as globalThis.Element;
}

function fillEmptyBlock(block: globalThis.Element): void {
	if (hasRenderedContent(block) || getPlaceholderBreak(block) !== null) {
		return;
	}
	block.appendChild(block.ownerDocument.createElement("br"));
}

function hasRenderedContent(element: globalThis.Element): boolean {
	for (
		let child = element.firstChild; child !== null; child = child.nextSibling
	) {
		if (isRenderedNode(child)) {
			return true;
		}
	}
	return false;
}

function insertNodeAt(point: EditingPoint, node: globalThis.Node): void {
	if (point.node.nodeType === TEXT_NODE) {
		const text = point.node as globalThis.Text;
		const parent = text.parentNode!;
		if (point.offset === 0) {
			parent.insertBefore(node, text);
		} else if (point.offset >= text.data.length) {
			parent.insertBefore(node, text.nextSibling);
		} else {
			parent.insertBefore(node, text.splitText(point.offset));
		}
		return;
	}
	const element = point.node as globalThis.Element;
	element.insertBefore(node, element.childNodes[point.offset] ?? null);
}

/** Whether nothing the layout would draw sits after the point in its block. */
function isAtBlockEnd(
	host: globalThis.HTMLElement,
	point: EditingPoint,
): boolean {
	if (point.node.nodeType === TEXT_NODE) {
		if (point.offset < (point.node as globalThis.Text).data.length) {
			return false;
		}
	} else {
		const children = point.node.childNodes;
		for (let at = point.offset; at < children.length; at++) {
			if (isRenderedNode(children[at])) {
				return false;
			}
		}
	}
	return !hasRenderedSibling(host, point.node, true);
}

function deleteEditingContent(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	forward: boolean,
): boolean {
	if (!selection.isCollapsed) {
		return deleteSelectionContents(host, selection);
	}
	const point = getCaretPoint(selection);
	const text = point.node.nodeType === TEXT_NODE
		? (point.node as globalThis.Text)
		: null;
	if (
		text !== null &&
		(forward ? point.offset < text.data.length : point.offset > 0)
	) {
		return cutGrapheme(host, selection, text, point.offset, forward);
	}
	const neighbor = getAdjacentNode(host, point, forward);
	if (neighbor === null) {
		return mergeAcrossBlocks(host, selection, point, forward);
	}
	if (neighbor.nodeType === TEXT_NODE) {
		const data = neighbor as globalThis.Text;
		return data.data.length > 0 &&
			cutGrapheme(
				host,
				selection,
				data,
				forward ? 0 : data.data.length,
				forward,
			);
	}
	const at = normalizeCaretPoint({
		node: neighbor.parentNode!,
		offset: getChildIndex(neighbor),
	});
	(neighbor as globalThis.ChildNode).remove();
	collapseTo(selection, at);
	fillEmptyBlock(getBlockContainer(host, at.node));
	return true;
}

// Backspace at a block's start takes the break before it, which is the
// block boundary: the two blocks become one.
function mergeAcrossBlocks(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	point: EditingPoint,
	forward: boolean,
): boolean {
	const block = getBlockContainer(host, point.node);
	if (block === host) {
		return false;
	}
	const other = getNeighborBlock(host, block, forward);
	if (other === null || other === host) {
		return false;
	}
	if (forward) {
		mergeBlocks(block, other, selection);
	} else {
		mergeBlocks(other, block, selection);
	}
	return true;
}

// The readline chords delete what the same motion would have selected.
// With nothing between the caret and the line's end there is only the
// break to take, so a character delete stands in.
function deleteEditingBy(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	granularity: string,
	forward: boolean,
): boolean {
	if (selection.isCollapsed) {
		selection.modify("extend", forward ? "forward" : "backward", granularity);
		clampSelectionToHost(host, selection, forward);
	}
	if (selection.isCollapsed) {
		return deleteEditingContent(host, selection, forward);
	}
	return deleteSelectionContents(host, selection);
}

function deleteSelectionContents(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
): boolean {
	if (selection.isCollapsed || selection.rangeCount === 0) {
		return false;
	}
	const range = selection.getRangeAt(0);
	if (!host.contains(range.startContainer)) {
		range.setStart(host, 0);
	}
	if (!host.contains(range.endContainer)) {
		range.setEnd(host, host.childNodes.length);
	}
	const first = getBlockContainer(host, range.startContainer);
	const last = getBlockContainer(host, range.endContainer);
	range.deleteContents();
	if (first !== last && host.contains(first) && host.contains(last)) {
		mergeBlocks(first, last, selection);
	} else {
		fillEmptyBlock(first);
	}
	return true;
}

function cutGrapheme(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	text: globalThis.Text,
	at: number,
	forward: boolean,
): boolean {
	const from = forward ? at : getPreviousGraphemeBoundary(text.data, at);
	const to = forward ? getNextGraphemeBoundary(text.data, at) : at;
	if (to <= from) {
		return false;
	}
	text.deleteData(from, to - from);
	normalizeSpaces(host, text, from, from);
	collapseTo(selection, {node: text, offset: from});
	fillEmptyBlock(getBlockContainer(host, text));
	return true;
}

// A caret in an element has no text to write into. One next to a text
// node belongs in it; anywhere else a text node is made for it.
function openTextAt(
	host: globalThis.HTMLElement,
	point: EditingPoint,
): {node: globalThis.Text; offset: number} {
	takePlaceholderBreak(host, point);
	if (point.node.nodeType === TEXT_NODE) {
		return {node: point.node as globalThis.Text, offset: point.offset};
	}
	const inside = normalizeCaretPoint(point);
	if (inside.node.nodeType === TEXT_NODE) {
		return {node: inside.node as globalThis.Text, offset: inside.offset};
	}
	const parent = point.node as globalThis.Element;
	const created = parent.ownerDocument.createTextNode("");
	parent.insertBefore(created, parent.childNodes[point.offset] ?? null);
	return {node: created, offset: 0};
}

// The <br> that holds an empty line open goes as soon as text lands in
// front of it, which is Chrome's placeholder br. Removing it leaves the
// caret where it was, since the caret is what the break sat behind.
function takePlaceholderBreak(
	host: globalThis.HTMLElement,
	point: EditingPoint,
): void {
	const block = getBlockContainer(host, point.node);
	const placeholder = getPlaceholderBreak(block);
	if (
		placeholder !== null && getAdjacentNode(host, point, true) === placeholder
	) {
		placeholder.remove();
	}
}

/** The element whose line the caret sits on: a block, or the host. */
function getBlockContainer(
	host: globalThis.HTMLElement,
	node: globalThis.Node,
): globalThis.Element {
	for (
		let element = asElement(node) ?? node.parentElement;
		element !== null;
		element = element.parentElement
	) {
		if (element === host || BLOCK_TAGS.has(element.localName)) {
			return element;
		}
	}
	return host;
}

// The node a delete takes when there is no text left on the caret's own
// side of its block.
function getAdjacentNode(
	host: globalThis.HTMLElement,
	point: EditingPoint,
	forward: boolean,
): globalThis.Node | null {
	let node = point.node;
	let candidate: globalThis.Node | null = node.nodeType === TEXT_NODE
		? (forward ? node.nextSibling : node.previousSibling)
		: (node.childNodes[forward ? point.offset : point.offset - 1] ?? null);
	while (candidate === null) {
		const parent = node.parentNode;
		if (node === host || parent === null || isBlockElement(host, node)) {
			return null;
		}
		candidate = forward ? node.nextSibling : node.previousSibling;
		node = parent;
	}
	let found: globalThis.Node = candidate;
	while (found.nodeType === ELEMENT_NODE && !isAtomic(found)) {
		const child = forward ? found.firstChild : found.lastChild;
		if (child === null) {
			break;
		}
		found = child;
	}
	return found;
}

// Chrome writes a non-breaking space wherever a collapsible one would
// render as nothing, and writes it back as a plain space once something
// follows it. Only the run the edit touched is rewritten, so a
// non-breaking space the page put there stays where it is.
function normalizeSpaces(
	host: globalThis.HTMLElement,
	text: globalThis.Text,
	from: number,
	to: number,
): void {
	if (!isCollapsibleWhiteSpace(text)) {
		return;
	}
	const data = text.data;
	let start = from;
	let end = to;
	while (start > 0 && isSpace(data[start - 1])) {
		start--;
	}
	while (end < data.length && isSpace(data[end])) {
		end++;
	}
	const atLineStart = !hasRenderedSibling(host, text, false);
	const atLineEnd = !hasRenderedSibling(host, text, true);
	let rewritten = "";
	for (let at = start; at < end;) {
		if (!isSpace(data[at])) {
			rewritten += data[at];
			at++;
			continue;
		}
		let runEnd = at;
		while (runEnd < end && isSpace(data[runEnd])) {
			runEnd++;
		}
		for (; at < runEnd; at++) {
			const collapses =
				(at === 0 && atLineStart) || (at === data.length - 1 && atLineEnd);
			rewritten += at === runEnd - 1 && !collapses ? SPACE : NBSP;
		}
	}
	if (rewritten !== data.slice(start, end)) {
		text.replaceData(start, end - start, rewritten);
	}
}

function isCollapsibleWhiteSpace(text: globalThis.Text): boolean {
	const parent = text.parentElement;
	const view = parent === null ? null : parent.ownerDocument.defaultView;
	if (parent === null || view === null) {
		return true;
	}
	return !PRESERVED_WHITE_SPACE.has(view.getComputedStyle(parent).whiteSpace);
}

function hasRenderedSibling(
	host: globalThis.HTMLElement,
	from: globalThis.Node,
	forward: boolean,
): boolean {
	const block = getBlockContainer(host, from);
	for (
		let node: globalThis.Node | null = from;
		node !== null && node !== block;
		node = node.parentNode
	) {
		for (
			let sibling = forward ? node.nextSibling : node.previousSibling;
			sibling !== null;
			sibling = forward ? sibling.nextSibling : sibling.previousSibling
		) {
			if (isRenderedNode(sibling)) {
				return true;
			}
		}
	}
	return false;
}

// A line break holds no text of its own, so a space next to one still
// collapses away and an empty block that ends in one is still empty.
function isRenderedNode(node: globalThis.Node): boolean {
	return node.nodeType === ELEMENT_NODE
		? !isBreak(node)
		: !COLLAPSIBLE_ONLY.test(node.textContent ?? "");
}

function clampSelectionToHost(
	host: globalThis.HTMLElement,
	selection: globalThis.Selection,
	forward: boolean,
): void {
	const focus = selection.focusNode;
	if (focus !== null && host.contains(focus)) {
		return;
	}
	const edge = forward
		? {node: host as globalThis.Node, offset: host.childNodes.length}
		: {node: host as globalThis.Node, offset: 0};
	const point = normalizeCaretPoint(edge);
	selection.extend(point.node, point.offset);
}

function getCaretPoint(selection: globalThis.Selection): EditingPoint {
	return {node: selection.focusNode!, offset: selection.focusOffset};
}

function isSpace(character: string): boolean {
	return character === SPACE || character === NBSP;
}

function isBreak(node: globalThis.Node): boolean {
	return node.nodeType === ELEMENT_NODE &&
		(node as globalThis.Element).localName === "br";
}

function isBlockElement(
	host: globalThis.HTMLElement,
	node: globalThis.Node,
): boolean {
	return node === host ||
		(node.nodeType === ELEMENT_NODE &&
			BLOCK_TAGS.has((node as globalThis.Element).localName));
}

function isAtomic(node: globalThis.Node): boolean {
	const element = node as globalThis.Element;
	return ATOMIC_TAGS.has(element.localName) ||
		(element as globalThis.HTMLElement).contentEditable === "false";
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
