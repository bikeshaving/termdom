import bidiFactory from "bidi-js";
import * as CSSTree from "css-tree";
import * as Parse5 from "parse5";

import {
	adoptStyleSheets,
	type Cascade,
	getAdoptedStyleSheets,
	getBoxModel,
	getInlineStyle,
	getStyleSheets,
	styleAttributeChanged,
	styleElementSheet,
	styleShadowAttached,
} from "./cssom.js";
import type {Exchange} from "./exchange.js";
import {
	ARIA_ELEMENT_REFLECTIONS,
	ARIA_STRING_REFLECTIONS,
	DOCUMENT_AND_ELEMENT_EVENT_HANDLERS,
	DOCUMENT_EVENT_HANDLERS,
	FORWARDED_BODY_EVENT_HANDLERS,
	GLOBAL_EVENT_HANDLERS,
	HTML_ELEMENT_REFLECTIONS,
	HTML_ELEMENT_TAGS,
	HTML_INTERFACES,
	HTML_UNKNOWN_TAGS,
	type ReflectSpec,
	WINDOW_EVENT_HANDLERS,
} from "./htmltables.js";
import type {Layout} from "./layout.js";
import type {Screen} from "./screen.js";
import {
	closeTermDOM,
	isAttached,
	render,
	sealTermDOM,
	type TermDOM,
} from "./termdom.js";
import {
	getNextGraphemeBoundary,
	getPreviousGraphemeBoundary,
	getStringWidth,
	toASCIILowercase,
} from "./text.js";
import {
	DETAILS_UA_STYLES,
	METER_UA_STYLES,
	PROGRESS_UA_STYLES,
	SELECT_UA_STYLES,
	TEXT_CONTROL_UA_STYLES,
	TEXTAREA_UA_STYLES,
} from "./useragent.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

const kEnsureUAShadowTree = Symbol("build a control's UA shadow tree");

// Safe to call more than once, and synchronous: the shadow tree exists
// when this returns. A control that was removed and re-inserted keeps its
// tree and only updates the state it missed.
function ensureUAShadowTree(element: globalThis.Element): void {
	(element as unknown as Record<symbol, (() => void) | undefined>)[
		kEnsureUAShadowTree
	]?.();
}

// Built-in tags that get a UA UA shadow tree when they connect.
const UPGRADEABLE_CONTROLS = new Set([
	"DETAILS",
	"INPUT",
	"METER",
	"PROGRESS",
	"SELECT",
	"TEXTAREA",
]);
const kNext = Symbol("next sibling link");
const kFirstChild = Symbol("first child");

// Walks the child links directly instead of running a selector query.
// This runs on every insertion, so ordinary markup should cost no more
// than one tag comparison per element.
function ensureUAShadowTrees(root: globalThis.Node): void {
	const stack: Element[] = [root as Element];
	while (stack.length > 0) {
		const element = stack.pop()!;
		if (UPGRADEABLE_CONTROLS.has(element.tagName)) {
			ensureUAShadowTree(element);
		}
		for (let node = element[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType === ELEMENT_NODE) {
				stack.push(node as Element);
			}
		}
	}
}

/** A listener as this file's dispatch calls it. */
type UAListener = (event: Event) => void;
const kUASelection = Symbol("a control's selection, whatever its type");

/**
 * A text control's selection record, without the type check authors get.
 * Per spec selectionStart is null on a number input, but the UA still needs
 * to draw a caret there. Returns null for a control with no selection.
 */
export function getSelectionRecord(
	control: globalThis.Element,
): {start: number; end: number; direction: string} | null {
	const record = (
		control as unknown as {
			[kUASelection]?: () => ReturnType<typeof getSelectionRecord>;
		}
	)[kUASelection];
	return record ? record.call(control) : null;
}

const kSetUASelection = Symbol("move a control's selection, whatever its type");

/** Set a text control's selection, without the type check authors get. */
export function setUASelection(
	control: globalThis.Element,
	start: number,
	end: number,
	direction?: string,
): void {
	(
		control as unknown as {
			[kSetUASelection](
				start: number,
				end: number,
				direction?: string,
			): void;
		}
	)[kSetUASelection]!(start, end, direction);
}

const kSyncUAShadowTree = Symbol("bring a control's UA tree back into step");

/** Notify a control that its state changed so its UA shadow tree can update. */
function syncUAShadowTree(element: Element): void {
	(element as unknown as Record<symbol, (() => void) | undefined>)[
		kSyncUAShadowTree
	]?.();
}

// The single definition of which elements are text controls. Painting, caret
// scrolling and the mousedown default action all use it, so they agree.
// checkbox and radio render a toggle, and hidden renders nothing.
function isTextControl(element: {
	tagName: string;
	type?: string;
}): boolean {
	if (element.tagName === "TEXTAREA") {
		return true;
	}
	if (element.tagName !== "INPUT") {
		return false;
	}
	const type = element.type;
	return type !== "checkbox" && type !== "radio" && type !== "hidden";
}

const kUAValueText = Symbol(
	"the text node a control's editable value lives in",
);

/**
 * The text node holding a form control's value inside its UA shadow tree,
 * or null before the tree is built. The editable text lives at
 * `[part="value"]` in the closed tree. The renderer reads it to place the
 * caret, and the editing code reads it to hit-test a point.
 */
export function getTextControlValueText(
	textControl: globalThis.Element,
): globalThis.Text |
	null {
	return (
		(textControl as unknown as Record<
			symbol,
			globalThis.Text | null | undefined
		>)[kUAValueText] ??
		null
	);
}

const kTermDOM = Symbol("termDOM");
const kLayout = Symbol("layout");
const kCascade = Symbol("cascade");
const kExchange = Symbol("exchange");
const kScreen = Symbol("screen");

/**
 * The focus offset of a control's selection record, in offsets of the
 * value text. Null for an element with no selection record.
 */
export function getSelectionFocus(element: globalThis.Element): number | null {
	const record = getSelectionRecord(element);
	if (record === null) {
		return null;
	}
	return record.direction === "backward" ? record.start : record.end;
}

/**
 * The value offset under a document-space point in a text text control. Accounts
 * for cell widths and clamps to the nearest offset, so a drag that leaves
 * the text control still resolves. That matches browsers: a selection started in
 * a text control belongs to the text control until release.
 */
export function getTextControlCaretOffset(
	element: globalThis.Element,
	x: number,
	y: number,
): number | null {
	// Measure against the value's own text. For a password text control that
	// text is the bullets, which is what was painted, so that is what the point
	// lands on.
	const valueText = getTextControlValueText(element);
	if (!valueText) {
		return null;
	}
	const attached = getAttachedDocument(element);
	if (attached === undefined) {
		return null;
	}
	const found = attached[kLayout].caretPositionFromPoint(
		x,
		y,
		valueText,
		true,
	);
	if (!found) {
		return null;
	}
	return Math.min(found.offset, valueText.data.length);
}

/**
 * The mousedown default action in a text text control: put the caret at the
 * pressed character. Returns the text control and the offset so the caller can
 * use them as a drag anchor, or null if the press was not on a text control.
 * checkbox, radio and hidden render no text, so a press on them returns
 * null.
 */
export function placeTextControlCaret(
	target: globalThis.Element,
	x: number,
	y: number,
): {textControl: globalThis.Element; offset: number} | null {
	if (!isTextControl(target)) {
		return null;
	}
	const offset = getTextControlCaretOffset(target, x, y);
	if (offset === null) {
		return null;
	}
	setUASelection(target, offset, offset);
	return {textControl: target, offset};
}

/**
 * The focused text text control's selection over this text node, or null. Per
 * spec a control's selection is invisible to getSelection(), so this is
 * the only way the highlight can find it. The range refers to the text
 * node the control renders its value through, so a node identity check is
 * enough.
 */
export function getTextControlSelectionRange(
	document: globalThis.Document,
	textNode: globalThis.Text,
): {range: globalThis.Range; textControl: globalThis.Element} | null {
	const active = document.activeElement;
	if (!active || !isTextControl(active)) {
		return null;
	}
	const range = getUASelectionRange(active);
	if (!range || range.startContainer !== textNode) {
		return null;
	}
	return {range, textControl: active};
}

/**
 * Keep the focused single-line input's caret inside its box by setting
 * scrollLeft on the value part. Layout reads scrollLeft live, so this
 * causes no relayout. Measured in cells. Recomputed every frame as derived
 * state.
 */
export function revealTextControlCaret(document: globalThis.Document): void {
	const active = document.activeElement;
	if (!active || active.localName !== "input" || !isTextControl(active)) {
		return;
	}
	const valueText = getTextControlValueText(active);
	const valueSpan = valueText?.parentElement;
	if (!valueText || !valueSpan) {
		return;
	}
	const attached = getAttachedDocument(active);
	if (attached === undefined) {
		return;
	}
	const content = attached[kLayout].contentRect(active);
	if (!content) {
		return;
	}
	const contentWidth = Math.round(content.width);
	if (contentWidth <= 0) {
		return;
	}

	const shown = valueText.data;
	// Seed from the current scrollLeft so a settled window doesn't jitter.
	const currentScroll = Math.max(0, Math.round(valueSpan.scrollLeft));
	let scrollOffset = 0;
	for (let acc = 0; scrollOffset < shown.length && acc < currentScroll;) {
		acc += getStringWidth(shown[scrollOffset]);
		scrollOffset++;
	}
	// The caret offset is in the value text's own offsets, the same text
	// `shown` was read from.
	const cursor = getSelectionFocus(active);
	if (cursor === null) {
		return;
	}
	// Keep the caret's cell in the box, then pull back when a deletion left
	// slack.
	if (cursor < scrollOffset) {
		scrollOffset = cursor;
	}
	while (
		scrollOffset < cursor &&
		getStringWidth(shown.slice(scrollOffset, cursor)) > contentWidth
	) {
		scrollOffset++;
	}
	while (
		scrollOffset > 0 &&
		getStringWidth(shown.slice(scrollOffset - 1)) < contentWidth
	) {
		scrollOffset--;
	}
	const scrollLeft = getStringWidth(shown.slice(0, scrollOffset));
	if (scrollLeft !== currentScroll) {
		valueSpan.scrollLeft = scrollLeft;
	}
}

const kUASelectionRange = Symbol("what an element's own selection covers");

// Per spec a form control's selection is invisible to getSelection(), so
// this is the only way to measure it. The range belongs to the document
// and is valid until the next selection read.
function getUASelectionRange(
	element: globalThis.Element,
): globalThis.Range | null {
	return (
		(element as unknown as Record<
			symbol,
			(() => globalThis.Range | null) | undefined
		>)[
			kUASelectionRange
		]?.() ?? null
	);
}

/** The range each document reuses for control-selection queries. */
const selectionRanges = new WeakMap<globalThis.Document, globalThis.Range>();

// Null when the selection is collapsed, since there is nothing to
// highlight. Offsets are clamped into the text, so a selection recorded
// against a longer value still measures.
function getTextSelectionRange(
	control: HTMLInputElement | HTMLTextAreaElement,
	valueText: globalThis.Text | null,
): globalThis.Range | null {
	if (!valueText) {
		return null;
	}
	const {start, end} = getSelectionRecord(control)!;
	const length = valueText.data.length;
	const from = Math.max(0, Math.min(start, length));
	const to = Math.max(0, Math.min(end, length));
	if (to <= from) {
		return null;
	}
	const document = getUADocument(control);
	let range = selectionRanges.get(document);
	if (range === undefined) {
		range = document.createRange();
		selectionRanges.set(document, range);
	}
	range.setStart(valueText, from);
	range.setEnd(valueText, to);
	return range;
}

/** A node's document, as the tree-building code below needs it. */
function getUADocument(node: globalThis.Node): globalThis.Document {
	return (node as Node).ownerDocument as unknown as globalThis.Document;
}

/** A textControl's value and selection after an editing key. */
interface TextControlEditResult {
	value: string;
	start: number;
	end: number;
	direction: "forward" | "backward" | "none";
}

// With Shift the selection extends from the fixed anchor, like the
// browser's anchor/focus model. Without Shift the selection collapses at
// the target. A move never edits text.
function moveTextControlSelection(
	value: string,
	anchor: number,
	target: number,
	shiftKey: boolean,
): TextControlEditResult {
	const clamped = Math.max(0, Math.min(target, value.length));
	if (shiftKey) {
		return {
			value,
			start: Math.min(anchor, clamped),
			end: Math.max(anchor, clamped),
			direction: clamped < anchor ? "backward" : "forward",
		};
	}
	return {value, start: clamped, end: clamped, direction: "none"};
}

const kUAValue = Symbol("a text control's value, beneath the IDL attribute");

// Handles Backspace, Delete, the horizontal arrows and the readline chords,
// grapheme-aware. Returns null for any other key. Enter, vertical motion
// and Home/End are left to the control, which knows where its lines end,
// and printable insertion is a keypress action.
function applySharedTextControlEdit(
	textControl: HTMLInputElement | HTMLTextAreaElement,
	key: string,
	shiftKey: boolean,
	ctrlKey: boolean,
): TextControlEditResult | null {
	const value = textControl[kUAValue]!;
	const {start, end, direction} = getSelectionRecord(textControl)!;
	const backward = direction === "backward";
	const caret = backward ? start : end;
	const anchor = backward ? end : start;
	const hasSelection = start !== end;

	// The readline chords a terminal user expects: caret motion or deletion,
	// never a browser shortcut. Ctrl+A, Ctrl+E, Ctrl+K and Ctrl+U depend on
	// line bounds, so the control handles those. These are the rest.
	if (ctrlKey && key === "b") {
		return moveTextControlSelection(
			value,
			anchor,
			hasSelection ? start : getPreviousGraphemeBoundary(value, caret),
			false,
		);
	}
	if (ctrlKey && key === "f") {
		return moveTextControlSelection(
			value,
			anchor,
			hasSelection ? end : getNextGraphemeBoundary(value, caret),
			false,
		);
	}
	if (ctrlKey && key === "d") {
		if (hasSelection) {
			return createCollapsedEdit(
				value.slice(0, start) + value.slice(end),
				start,
			);
		}
		if (caret < value.length) {
			const to = getNextGraphemeBoundary(value, caret);
			return createCollapsedEdit(
				value.slice(0, caret) + value.slice(to),
				caret,
			);
		}
		return {value, start, end, direction: "none"};
	}
	if (ctrlKey && key === "w") {
		if (hasSelection) {
			return createCollapsedEdit(
				value.slice(0, start) + value.slice(end),
				start,
			);
		}
		const from = getWordStart(value, caret);
		return createCollapsedEdit(value.slice(0, from) + value.slice(caret), from);
	}
	if (key === "Backspace") {
		if (hasSelection) {
			return createCollapsedEdit(
				value.slice(0, start) + value.slice(end),
				start,
			);
		}
		if (caret > 0) {
			const from = getPreviousGraphemeBoundary(value, caret);
			return createCollapsedEdit(
				value.slice(0, from) + value.slice(caret),
				from,
			);
		}
		return {value, start, end, direction: "none"};
	}
	if (key === "Delete") {
		if (hasSelection) {
			return createCollapsedEdit(
				value.slice(0, start) + value.slice(end),
				start,
			);
		}
		if (caret < value.length) {
			const to = getNextGraphemeBoundary(value, caret);
			return createCollapsedEdit(
				value.slice(0, caret) + value.slice(to),
				caret,
			);
		}
		return {value, start, end, direction: "none"};
	}
	if (key === "ArrowLeft") {
		if (shiftKey) {
			return moveTextControlSelection(
				value,
				anchor,
				getPreviousGraphemeBoundary(value, caret),
				true,
			);
		}
		// An arrow with a selection collapses to that edge, not one past it,
		// which is what browsers do.
		const target = hasSelection
			? start
			: getPreviousGraphemeBoundary(value, caret);
		return moveTextControlSelection(value, anchor, target, false);
	}
	if (key === "ArrowRight") {
		if (shiftKey) {
			return moveTextControlSelection(
				value,
				anchor,
				getNextGraphemeBoundary(value, caret),
				true,
			);
		}
		const target = hasSelection ? end : getNextGraphemeBoundary(value, caret);
		return moveTextControlSelection(value, anchor, target, false);
	}
	return null;
}

// Called from beforeinput, as in a browser: insertion is the keypress
// default action, and the text control's input event follows.
function printableTextControlEdit(
	textControl: HTMLInputElement | HTMLTextAreaElement,
	text: string,
): TextControlEditResult {
	const value = textControl[kUAValue]!;
	const {start, end} = getSelectionRecord(textControl)!;
	return createCollapsedEdit(
		value.slice(0, start) + text + value.slice(end),
		start + text.length,
	);
}

// Whitespace before the caret is consumed with the word, so a chord at
// the end of "one two " lands where "two" began.
function getWordStart(value: string, caret: number): number {
	let at = caret;
	while (at > 0 && /\s/.test(value[at - 1])) {
		at--;
	}
	while (at > 0 && !/\s/.test(value[at - 1])) {
		at--;
	}
	return at;
}

/** The mirror of getWordStart: where a forward word move lands. */
function getWordEnd(value: string, caret: number): number {
	let at = caret;
	while (at < value.length && /\s/.test(value[at])) {
		at++;
	}
	while (at < value.length && !/\s/.test(value[at])) {
		at++;
	}
	return at;
}

/** An edit result with the caret collapsed at `pos`. */
function createCollapsedEdit(
	value: string,
	pos: number,
): TextControlEditResult {
	const clamped = Math.max(0, Math.min(pos, value.length));
	return {value, start: clamped, end: clamped, direction: "none"};
}

const kSetUAValue = Symbol("write a text control's value, as a user edit does");

// Fires input when the value actually changed and select when the user
// moved the selection. Writes to the control's value directly, never
// through the value IDL setter. In a browser a user edit changes the value
// without running the setter, and frameworks rely on that to tell user
// input from the page's own writes.
function applyTextControlEdit(
	textControl: HTMLInputElement | HTMLTextAreaElement,
	result: TextControlEditResult,
): void {
	const value = textControl[kUAValue]!;
	const {start, end, direction} = getSelectionRecord(textControl)!;
	if (result.value !== value) {
		textControl[kSetUAValue]!(result.value);
		textControl[kSetUASelection]!(result.start, result.end, result.direction);
		dispatch(
			textControl,
			new Event("input", {bubbles: true, cancelable: false}),
		);
	} else if (
		result.start !== start ||
		result.end !== end ||
		(result.start !== result.end && result.direction !== direction)
	) {
		textControl[kSetUASelection]!(result.start, result.end, result.direction);
		dispatch(
			textControl,
			new Event("select", {bubbles: true, cancelable: false}),
		);
	}
}

/**
 * Add a span with a `part` attribute and one empty text node to a UA shadow
 * tree.
 */
function addPart(
	root: globalThis.ShadowRoot,
	part: string,
): globalThis.HTMLElement {
	const document = getUADocument(root);
	const span = document.createElement("span");
	span.setAttribute("part", part);
	span.appendChild(document.createTextNode(""));
	root.appendChild(span);
	return span;
}

// Per spec a document-rooted observer never sees inside a shadow root, so
// each root is observed on its own.
function observeShadowRoot(
	document: Document,
	root: globalThis.ShadowRoot,
): void {
	engineObservers.get(document)?.observe(root as unknown as Node, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeOldValue: true,
		characterData: true,
	});
}

const kDocument = Symbol("node document");

// The root is registered with the cascade BEFORE it is populated, so
// populating it is the invalidation that swaps in the new composed tree.
function buildUAShadowTree(
	host: Element,
	attached: AttachedDocument,
	styles: string,
): globalThis.ShadowRoot {
	const root = attachUAShadowTree<globalThis.ShadowRoot>(host);
	attached[kLayout].invalidate();
	observeShadowRoot(host[kDocument]!, root);
	// The sheet has to be in the root BEFORE the cascade is told about the
	// root, so the registration's incremental parse picks it up. Registering
	// first and populating after left the cascade to notice the sheet by count
	// drift, which forced a full rebuild of every sheet per UA shadow tree.
	root.appendChild(createUAStyleElement(host, styles));
	attached[kCascade].registerShadowRoot(root);
	return root;
}

/** The `<style>` element that carries a widget's UA stylesheet. */
function createUAStyleElement(
	host: Element,
	styles: string,
): globalThis.HTMLElement {
	const style = getUADocument(host).createElement("style");
	style.textContent = styles;
	return style;
}

// Applies the text selection API's clamping and direction rules. The
// event is queued rather than fired, so several writes in one turn report
// once with the final selection.
function setTextSelection(
	control: Element,
	start: number,
	end: number,
	direction: string | undefined,
	length: number,
	store: (selection: [number, number, string]) => void,
): void {
	const clampedEnd = Math.min(end, length);
	const clampedStart = Math.min(Math.min(start, length), clampedEnd);
	const named = direction === undefined ? "none" : direction;
	const kept =
		named === "forward" || named === "backward" || named === "none"
			? named
			: "none";
	store([clampedStart, clampedEnd, kept]);
	scheduleTextSelectionChange(control);
}

const kTextSelectionChangeScheduled = Symbol("has scheduled selectionchange");

/** Queue the selectionchange event a text control fires at itself. */
function scheduleTextSelectionChange(control: Element): void {
	const scheduled = control as unknown as Record<symbol, boolean>;
	if (scheduled[kTextSelectionChangeScheduled]!) {
		return;
	}
	scheduled[kTextSelectionChangeScheduled] = true;
	queueMicrotask(() => {
		scheduled[kTextSelectionChangeScheduled] = false;
		dispatch(control, new Event("selectionchange", {bubbles: true}));
	});
}

/** The setRangeText algorithm applied to a raw value. */
function replaceTextRange(
	value: string,
	replacement: string,
	start: number,
	end: number,
	selectMode: string,
	selectionStart: number,
	selectionEnd: number,
): {value: string; start: number; end: number} {
	if (start > end) {
		throw indexSizeError("A range cannot end before it starts");
	}
	const length = value.length;
	const from = Math.min(start, length);
	const to = Math.min(end, length);
	let selectionFrom = selectionStart;
	let selectionTo = selectionEnd;
	const next = value.slice(0, from) + replacement + value.slice(to);
	const newLength = replacement.length;
	const oldLength = to - from;
	const delta = newLength - oldLength;
	if (selectionFrom > to) {
		selectionFrom += delta;
	} else if (selectionFrom > from) {
		selectionFrom = from;
	}
	if (selectionTo > to) {
		selectionTo += delta;
	} else if (selectionTo > from) {
		selectionTo = from + newLength;
	}
	switch (selectMode) {
		case "select":
			return {value: next, start: from, end: from + newLength};
		case "start":
			return {value: next, start: from, end: from};
		case "end":
			return {value: next, start: from + newLength, end: from + newLength};
		case "preserve":
			return {value: next, start: selectionFrom, end: selectionTo};
		default:
			throw new TypeError(`${selectMode} is not a selection mode`);
	}
}

// Use the platform's DOMException so a caller's `instanceof DOMException`
// and `error.code` checks work.
const PlatformDOMException: typeof DOMException = (
	globalThis as unknown as {DOMException: typeof DOMException}
).DOMException;

function domError(name: string, message: string): DOMException {
	return new PlatformDOMException(message, name);
}

function hierarchyRequestError(message: string): DOMException {
	return domError("HierarchyRequestError", message);
}

function notFoundError(message: string): DOMException {
	return domError("NotFoundError", message);
}

function indexSizeError(message: string): DOMException {
	return domError("IndexSizeError", message);
}

// The DOM Standard's name productions, from strictest to loosest. A
// doctype name may even be empty.
const VALID_ELEMENT_LOCAL_NAME =
	/^(?:[A-Za-z][^\0\t\n\f\r />]*|[:_\u0080-\u{10FFFF}][A-Za-z0-9\-.:_\u0080-\u{10FFFF}]*)$/u;
const VALID_ATTRIBUTE_LOCAL_NAME = /^[^\0\t\n\f\r /=>]+$/u;
const VALID_NAMESPACE_PREFIX = /^[^\0\t\n\f\r />]+$/u;
const VALID_DOCTYPE_NAME = /^[^\0\t\n\f\r >]*$/u;

// XML 1.0 (5th ed) Name, which a processing instruction's target must match.
// Surrogates are matched as pairs so an astral character counts as one.
const NAME_START =
	"A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D" +
	"\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF" +
	"\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD:";
const NAME_REST = `${NAME_START}\\-.0-9\u00B7\u0300-\u036F\u203F-\u2040`;
// The combining-mark ranges come from the production itself and are meant
// to match a combining mark on its own, not as part of a grapheme.

/* eslint-disable no-misleading-character-class -- the XML Name production
   matches lone combining marks by definition */
const XML_NAME = new RegExp(
	`^(?:[${NAME_START}]|[\uD800-\uDBFF][\uDC00-\uDFFF])` +
	`(?:[${NAME_REST}]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$`,
);

function isValidLocalName(name: string, forAttribute: boolean): boolean {
	return forAttribute
		? VALID_ATTRIBUTE_LOCAL_NAME.test(name)
		: VALID_ELEMENT_LOCAL_NAME.test(name);
}

function validateAttributeLocalName(name: string): void {
	if (!VALID_ATTRIBUTE_LOCAL_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid attribute name`,
		);
	}
}

/**
 * Split a qualified name against a namespace, throwing the errors the
 * spec's name and namespace constraints require.
 */
function validateAndExtract(
	namespace: string | null,
	getQualifiedName: string,
	forAttribute: boolean,
): {namespace: string | null; prefix: string | null; localName: string} {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	let prefix: string | null = null;
	let localName = getQualifiedName;
	const colon = getQualifiedName.indexOf(":");
	if (colon !== -1) {
		prefix = getQualifiedName.slice(0, colon);
		localName = getQualifiedName.slice(colon + 1);
		if (!VALID_NAMESPACE_PREFIX.test(prefix)) {
			throw domError(
				"InvalidCharacterError",
				`"${prefix}" is not a valid namespace prefix`,
			);
		}
	}
	if (!isValidLocalName(localName, forAttribute)) {
		throw domError(
			"InvalidCharacterError",
			`"${localName}" is not a valid local name`,
		);
	}
	if (prefix !== null && ns === null) {
		throw domError(
			"NamespaceError",
			"A prefixed name needs a non-null namespace",
		);
	}
	if (prefix === "xml" && ns !== XML_NAMESPACE) {
		throw domError("NamespaceError", "The xml prefix needs the XML namespace");
	}
	if (
		(getQualifiedName === "xmlns" || prefix === "xmlns") &&
		ns !== XMLNS_NAMESPACE
	) {
		throw domError(
			"NamespaceError",
			"The xmlns name needs the XMLNS namespace",
		);
	}
	if (
		ns === XMLNS_NAMESPACE &&
		getQualifiedName !== "xmlns" &&
		prefix !== "xmlns"
	) {
		throw domError(
			"NamespaceError",
			"The XMLNS namespace needs the xmlns name",
		);
	}
	return {namespace: ns, prefix, localName};
}

interface EventInit {
	bubbles?: boolean;
	cancelable?: boolean;
	composed?: boolean;
}

interface CustomEventInit<T = unknown> extends EventInit {
	detail?: T;
}

const NONE = 0;
const CAPTURING_PHASE = 1;
const AT_TARGET = 2;
const BUBBLING_PHASE = 3;

// The shadow members (the adjusted target and the two closed-tree flags)
// are what composedPath() uses to decide how much of the path a listener
// may see. Retargeting fills them in while the path is built.
interface PathItem {
	invocationTarget: EventTarget;
	invocationTargetInShadowTree: boolean;
	shadowAdjustedTarget: EventTarget | null;
	relatedTarget: EventTarget | null;
	rootOfClosedTree: boolean;
	slotInClosedTree: boolean;
}

// The spec's internal slots and flags, kept in one object behind a module
// symbol because dispatch is a module function that reads and writes them
// for every target in the path.
interface DispatchState {
	target: EventTarget | null;
	relatedTarget: EventTarget | null;
	currentTarget: EventTarget | null;
	eventPhase: number;
	path: PathItem[];
	initialized: boolean;
	dispatch: boolean;
	stopPropagation: boolean;
	stopImmediate: boolean;
	canceled: boolean;
	inPassiveListener: boolean;
	trusted: boolean;

	// True when the event is a platform event rather than one of ours. A
	// listener sets flags on the platform object, so dispatch reads them back
	// from the event after every listener call.
	foreign: boolean;
}

// If a trusted animation or transition event finds no listener for its
// modern type at a target, it is dispatched again there under the
// prefixed name.
const LEGACY_EVENT_TYPES = new Map([
	["animationend", "webkitAnimationEnd"],
	["animationiteration", "webkitAnimationIteration"],
	["animationstart", "webkitAnimationStart"],
	["transitionend", "webkitTransitionEnd"],
]);

/** A dictionary argument per Web IDL: absent, null, or an object. */
function toDictionary<T extends object>(value: unknown, what: string): T {
	if (value === undefined || value === null) {
		return {} as T;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		throw new TypeError(`${what} must be an object`);
	}
	return value as T;
}

// Events constructed here are instances of the global Event, and events
// constructed with the global Event dispatch through this DOM. Either
// kind works on both sides.
const HostEvent = globalThis.Event as unknown as {
	new (type: string, eventInitDict?: EventInit): HostEventInstance;
	prototype: HostEventInstance;
};

// The members that dispatch owns are omitted because they are typed
// against the platform's EventTarget, and the targets here are this DOM's.
interface HostEventInstance
	extends Omit<
		globalThis.Event,
		"target" |
		"srcElement" |
		"currentTarget" |
		"composedPath" |
		"stopPropagation" |
		"stopImmediatePropagation" |
		"preventDefault" |
		"initEvent"
	> {
	stopPropagation(): void;
	stopImmediatePropagation(): void;
	preventDefault(): void;
	initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void;
}
const kState = Symbol("state");

// One accessor shared by every event and installed as an own property on
// each. The interface declares isTrusted unforgeable, so it cannot live on
// the prototype or be redefined.
function isTrustedGetter(this: Event): boolean {
	return this[kState]!.trusted;
}

const isTrustedProperty: PropertyDescriptor = {
	get: isTrustedGetter,
	enumerable: true,
	configurable: false,
};

// The prototype chain reaches the platform's Event, but the platform
// constructor never runs. Some platforms install isTrusted as an
// unforgeable own property that always reads false, and a user-agent
// dispatch here needs it to read true.
const EventBase = function EventBase(): void {} as unknown as {
	new (): HostEventInstance;
	prototype: HostEventInstance;
};

EventBase.prototype = Object.create(HostEvent.prototype) as HostEventInstance;

const kBubbles = Symbol("bubbles");
const kCancelable = Symbol("cancelable");
const kComposed = Symbol("composed");
const kTimeStamp = Symbol("timeStamp");
const kIsMouseEvent = Symbol("is a mouse event");
const kType = Symbol("document type");

/** An event, plus the flags listeners set on it during dispatch. */
export class Event extends EventBase implements globalThis.Event {
	static readonly NONE = NONE;
	static readonly CAPTURING_PHASE = CAPTURING_PHASE;
	static readonly AT_TARGET = AT_TARGET;
	static readonly BUBBLING_PHASE = BUBBLING_PHASE;
	declare [kType]?: string;
	declare [kBubbles]?: boolean;
	declare [kCancelable]?: boolean;
	declare [kComposed]?: boolean;
	declare [kTimeStamp]?: number;
	declare [kState]?: DispatchState;

	constructor(type: string, eventInitDict: EventInit = {}) {
		if (arguments.length < 1) {
			throw new TypeError("Event constructor needs a type");
		}
		// Convert the dictionary once, here. An accessor member is read exactly
		// once, by this conversion.
		const name = String(type);
		const init = toDictionary<EventInit>(eventInitDict, "An event init");
		const bubbles = Boolean(init.bubbles);
		const cancelable = Boolean(init.cancelable);
		const composed = Boolean(init.composed);
		super();
		this[kState] = {
			target: null,
			relatedTarget: null,
			currentTarget: null,
			eventPhase: NONE,
			path: [],
			initialized: false,
			dispatch: false,
			stopPropagation: false,
			stopImmediate: false,
			canceled: false,
			inPassiveListener: false,
			trusted: false,
			foreign: false,
		};
		this[kType] = name;
		this[kBubbles] = bubbles;
		this[kCancelable] = cancelable;
		this[kComposed] = composed;
		this[kTimeStamp] = performance.now();
		this[kState]!.initialized = true;
		Object.defineProperty(this, "isTrusted", isTrustedProperty);
	}

	override get type(): string {
		return this[kType]!;
	}

	// The members that dispatch owns (the path and the flags listeners set)
	// come from the state this DOM keeps. The flags are also written to the
	// platform base, so an event handed back to platform code reads the same
	// through either half of its interface.

	get target(): EventTarget | null {
		return this[kState]!.target;
	}

	get srcElement(): EventTarget | null {
		return this[kState]!.target;
	}

	get currentTarget(): EventTarget | null {
		return this[kState]!.currentTarget;
	}

	override get eventPhase(): number {
		return this[kState]!.eventPhase;
	}

	override get bubbles(): boolean {
		return this[kBubbles]!;
	}

	override get cancelable(): boolean {
		return this[kCancelable]!;
	}

	override get composed(): boolean {
		return this[kComposed]!;
	}

	override get defaultPrevented(): boolean {
		return this[kState]!.canceled;
	}

	override get timeStamp(): number {
		return this[kTimeStamp]!;
	}

	override get returnValue(): boolean {
		return !this[kState]!.canceled;
	}

	override set returnValue(value: boolean) {
		if (!value) {
			setCanceledFlag(this);
		}
	}

	override get cancelBubble(): boolean {
		return this[kState]!.stopPropagation;
	}

	override set cancelBubble(value: boolean) {
		if (value) {
			this[kState]!.stopPropagation = true;
		}
	}

	// Decides whether a "click" runs activation behavior. MouseEvent
	// overrides it.
	get [kIsMouseEvent](): boolean {
		return false;
	}

	composedPath(): EventTarget[] {
		return getComposedPath(this[kState]!);
	}

	override stopPropagation(): void {
		this[kState]!.stopPropagation = true;
	}

	override stopImmediatePropagation(): void {
		this[kState]!.stopPropagation = true;
		this[kState]!.stopImmediate = true;
	}

	override preventDefault(): void {
		setCanceledFlag(this);
	}

	override initEvent(type: string, bubbles = false, cancelable = false): void {
		if (arguments.length < 1) {
			throw new TypeError("initEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this[kType] = String(type);
		this[kBubbles] = Boolean(bubbles);
		this[kCancelable] = Boolean(cancelable);
		this[kState]!.initialized = true;
		this[kState]!.stopPropagation = false;
		this[kState]!.stopImmediate = false;
		this[kState]!.canceled = false;
		this[kState]!.trusted = false;
		this[kState]!.target = null;
	}
}

/** Change the type dispatch uses for listener lookup, for the legacy pass. */
function setEventType(event: Event, type: string): void {
	event[kType] = type;
}

Object.defineProperties(Event.prototype, {
	NONE: {value: NONE, enumerable: true},
	CAPTURING_PHASE: {value: CAPTURING_PHASE, enumerable: true},
	AT_TARGET: {value: AT_TARGET, enumerable: true},
	BUBBLING_PHASE: {value: BUBBLING_PHASE, enumerable: true},
	[Symbol.toStringTag]: {value: "Event", configurable: true},
});

/**
 * An event is canceled only if it is cancelable and no passive listener is
 * running.
 */
function setCanceledFlag(event: Event): void {
	const state = event[kState]!;
	if (event.cancelable && !state.inPassiveListener) {
		state.canceled = true;
		// A platform event keeps its canceled flag on the platform object,
		// because that is where whoever passed it in will read it.
		if (state.foreign) {
			HostEvent.prototype.preventDefault.call(event);
		}
	}
}

// Walks outward from the current target. It stops crossing into a closed
// tree it did not start inside, and counts the closed roots and slots it
// passes.
function getComposedPath(state: DispatchState): EventTarget[] {
	const path = state.path;
	if (path.length === 0) {
		return [];
	}
	const currentTarget = state.currentTarget as EventTarget;
	const composed: EventTarget[] = [currentTarget];
	let currentTargetIndex = 0;
	let currentTargetHiddenSubtreeLevel = 0;
	for (let index = path.length - 1; index >= 0; index--) {
		if (path[index].rootOfClosedTree) {
			currentTargetHiddenSubtreeLevel++;
		}
		if (path[index].invocationTarget === currentTarget) {
			currentTargetIndex = index;
			break;
		}
		if (path[index].slotInClosedTree) {
			currentTargetHiddenSubtreeLevel--;
		}
	}
	let currentHiddenLevel = currentTargetHiddenSubtreeLevel;
	let maxHiddenLevel = currentTargetHiddenSubtreeLevel;
	for (let index = currentTargetIndex - 1; index >= 0; index--) {
		if (path[index].rootOfClosedTree) {
			currentHiddenLevel++;
		}
		if (currentHiddenLevel <= maxHiddenLevel) {
			composed.unshift(path[index].invocationTarget);
		}
		if (path[index].slotInClosedTree) {
			currentHiddenLevel--;
			if (currentHiddenLevel < maxHiddenLevel) {
				maxHiddenLevel = currentHiddenLevel;
			}
		}
	}
	currentHiddenLevel = currentTargetHiddenSubtreeLevel;
	maxHiddenLevel = currentTargetHiddenSubtreeLevel;
	for (let index = currentTargetIndex + 1; index < path.length; index++) {
		if (path[index].slotInClosedTree) {
			currentHiddenLevel++;
		}
		if (currentHiddenLevel <= maxHiddenLevel) {
			composed.push(path[index].invocationTarget);
		}
		if (path[index].rootOfClosedTree) {
			currentHiddenLevel--;
			if (currentHiddenLevel < maxHiddenLevel) {
				maxHiddenLevel = currentHiddenLevel;
			}
		}
	}
	return composed;
}

const kDetail = Symbol("detail");

// Extends this DOM's Event (which carries the dispatch state) rather than
// the platform's CustomEvent. An instance is a platform Event but not a
// platform CustomEvent.
export class CustomEvent<T = unknown>
	extends Event
	implements globalThis.CustomEvent<T> {
	declare [kDetail]?: T | null;

	constructor(type: string, eventInitDict: CustomEventInit<T> = {}) {
		super(type, eventInitDict);
		const init = toDictionary<CustomEventInit<T>>(
			eventInitDict,
			"An event init",
		);
		this[kDetail] = init.detail ?? null;
	}

	// lib.dom types this as T even though it is null until an init sets it.
	// Every browser's types have the same problem.
	get detail(): T {
		return this[kDetail]! as T;
	}

	initCustomEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		detail: T | null = null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initCustomEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		this[kDetail] = detail;
	}
}

Object.defineProperty(CustomEvent.prototype, Symbol.toStringTag, {
	value: "CustomEvent",
	configurable: true,
});

const kReturnValue = Symbol("returnValue");

// The interface declares no constructor, so `new` throws for authors.
// Teardown treats two things as cancellation: preventDefault(), and a
// returnValue set to anything but the empty string.
class BeforeUnloadEvent extends Event {
	declare [kReturnValue]?: string;

	constructor(
		type = "beforeunload",
		eventInitDict: EventInit = {cancelable: true},
	) {
		super(type, eventInitDict);
		this[kReturnValue] = "";
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
	}

	// Shadows Event's boolean returnValue with a DOMString. Typed `any`
	// because a narrower type is not assignable over the boolean it shadows.
	// The platform's own types do the same.
	override get returnValue(): any {
		return this[kReturnValue]!;
	}

	override set returnValue(value: any) {
		this[kReturnValue] = String(value);
	}
}

Object.defineProperty(BeforeUnloadEvent.prototype, Symbol.toStringTag, {
	value: "BeforeUnloadEvent",
	configurable: true,
});

/** Build one of this file's objects whose constructor authors cannot call. */
function constructInternal<T>(build: () => T): T {
	const previous = internalConstruction;
	internalConstruction = true;
	try {
		return build();
	} finally {
		internalConstruction = previous;
	}
}

interface MessageEventInit<T = unknown> extends EventInit {
	data?: T;
	origin?: string;
	lastEventId?: string;
	source?: null;
	ports?: unknown[];
}

const kMessageData = Symbol("message data");
const kOrigin = Symbol("origin");
const kLastEventId = Symbol("last event id");
const kMessageSource = Symbol("message source");
const kPorts = Symbol("ports");

// Nothing in a terminal posts one yet, but the interface is a constructor
// authors can call and createEvent can name, so it is implemented fully.
class MessageEvent<T = unknown> extends Event {
	declare [kMessageData]?: T;
	declare [kOrigin]?: string;
	declare [kLastEventId]?: string;
	declare [kMessageSource]?: null;
	declare [kPorts]?: readonly unknown[];

	constructor(type: string, eventInitDict: MessageEventInit<T> = {}) {
		super(type, eventInitDict);
		const init = toDictionary<MessageEventInit<T>>(
			eventInitDict,
			"An event init",
		);
		this[kMessageData] = (init.data ?? null) as T;
		this[kOrigin] = String(init.origin ?? "");
		this[kLastEventId] = String(init.lastEventId ?? "");
		this[kMessageSource] = init.source ?? null;
		this[kPorts] = Object.freeze([...(init.ports ?? [])]);
	}

	get data(): T {
		return this[kMessageData]!;
	}

	get origin(): string {
		return this[kOrigin]!;
	}

	get lastEventId(): string {
		return this[kLastEventId]!;
	}

	get source(): null {
		return this[kMessageSource]!;
	}

	get ports(): readonly unknown[] {
		return this[kPorts]!;
	}

	initMessageEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		data: T = null as T,
		origin = "",
		lastEventId = "",
		source = null,
		ports: unknown[] = [],
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initMessageEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		this[kMessageData] = data;
		this[kOrigin] = String(origin);
		this[kLastEventId] = String(lastEventId);
		this[kMessageSource] = source;
		this[kPorts] = Object.freeze([...ports]);
	}
}

Object.defineProperty(MessageEvent.prototype, Symbol.toStringTag, {
	value: "MessageEvent",
	configurable: true,
});

interface HashChangeEventInit extends EventInit {
	oldURL?: string;
	newURL?: string;
}

const kOldURL = Symbol("old URL");
const kNewURL = Symbol("new URL");

/** Fired when a document's fragment identifier changes. */
class HashChangeEvent extends Event {
	declare [kOldURL]?: string;
	declare [kNewURL]?: string;

	constructor(type: string, eventInitDict: HashChangeEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<HashChangeEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kOldURL] = String(init.oldURL ?? "");
		this[kNewURL] = String(init.newURL ?? "");
	}

	get oldURL(): string {
		return this[kOldURL]!;
	}

	get newURL(): string {
		return this[kNewURL]!;
	}
}

Object.defineProperty(HashChangeEvent.prototype, Symbol.toStringTag, {
	value: "HashChangeEvent",
	configurable: true,
});

interface StorageEventInit extends EventInit {
	key?: string | null;
	oldValue?: string | null;
	newValue?: string | null;
	url?: string;
	storageArea?: null;
}

const kStorageKey = Symbol("storage key");
const kStorageOldValue = Symbol("storage old value");
const kStorageNewValue = Symbol("storage new value");
const kStorageURL = Symbol("storage url");
const kStorageArea = Symbol("storage area");

// There is no storage area in a terminal, but the interface is a
// constructor authors can call and createEvent can name.
class StorageEvent extends Event {
	declare [kStorageKey]?: string | null;
	declare [kStorageOldValue]?: string | null;
	declare [kStorageNewValue]?: string | null;
	declare [kStorageURL]?: string;
	declare [kStorageArea]?: null;

	constructor(type: string, eventInitDict: StorageEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<StorageEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kStorageKey] = init.key == null ? null : String(init.key);
		this[kStorageOldValue] =
			init.oldValue == null ? null : String(init.oldValue);
		this[kStorageNewValue] =
			init.newValue == null ? null : String(init.newValue);
		this[kStorageURL] = String(init.url ?? "");
		this[kStorageArea] = init.storageArea ?? null;
	}

	get key(): string | null {
		return this[kStorageKey]!;
	}

	get oldValue(): string | null {
		return this[kStorageOldValue]!;
	}

	get newValue(): string | null {
		return this[kStorageNewValue]!;
	}

	get url(): string {
		return this[kStorageURL]!;
	}

	get storageArea(): null {
		return this[kStorageArea]!;
	}

	initStorageEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		key: string | null = null,
		oldValue: string | null = null,
		newValue: string | null = null,
		url = "",
		storageArea = null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initStorageEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		this[kStorageKey] = key == null ? null : String(key);
		this[kStorageOldValue] = oldValue == null ? null : String(oldValue);
		this[kStorageNewValue] = newValue == null ? null : String(newValue);
		this[kStorageURL] = String(url);
		this[kStorageArea] = storageArea ?? null;
	}
}

Object.defineProperty(StorageEvent.prototype, Symbol.toStringTag, {
	value: "StorageEvent",
	configurable: true,
});

interface UIEventInit extends EventInit {
	view?: null;
	detail?: number;
	which?: number;
}

interface EventModifierInit extends UIEventInit {
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	modifierAltGraph?: boolean;
	modifierCapsLock?: boolean;
	modifierFn?: boolean;
	modifierFnLock?: boolean;
	modifierHyper?: boolean;
	modifierNumLock?: boolean;
	modifierScrollLock?: boolean;
	modifierSuper?: boolean;
	modifierSymbol?: boolean;
	modifierSymbolLock?: boolean;
}

interface MouseEventInit extends EventModifierInit {
	screenX?: number;
	screenY?: number;
	clientX?: number;
	clientY?: number;
	movementX?: number;
	movementY?: number;
	button?: number;
	buttons?: number;
	relatedTarget?: EventTarget | null;
}

interface FocusEventInit extends UIEventInit {
	relatedTarget?: EventTarget | null;
}

interface KeyboardEventInit extends EventModifierInit {
	key?: string;
	code?: string;
	location?: number;
	repeat?: boolean;
	isComposing?: boolean;
	charCode?: number;
	keyCode?: number;
}

interface CompositionEventInit extends UIEventInit {
	data?: string;
}

interface InputEventInit extends UIEventInit {
	data?: string | null;
	isComposing?: boolean;
	inputType?: string;
}

interface WheelEventInit extends MouseEventInit {
	deltaX?: number;
	deltaY?: number;
	deltaZ?: number;
	deltaMode?: number;
}

/** Convert to a WebIDL long: truncate and wrap into 32 signed bits. */
function toLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return 0;
	}
	return Math.trunc(number) | 0;
}

/** Convert to a WebIDL double: any finite number; throw for the rest. */
function toDouble(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new TypeError("That value is not a finite double");
	}
	return number;
}

/** Convert an EventTarget? argument per Web IDL: null or an event target. */
function toEventTarget(value: unknown): EventTarget | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!(value instanceof EventTarget)) {
		throw new TypeError("That is not an event target");
	}
	return value;
}

/** The modifier key names an event's init dictionary sets. */
function getInitModifiers(init: EventModifierInit): Set<string> {
	const modifiers = new Set<string>();
	if (init.ctrlKey) {
		modifiers.add("Control");
	}
	if (init.shiftKey) {
		modifiers.add("Shift");
	}
	if (init.altKey) {
		modifiers.add("Alt");
	}
	if (init.metaKey) {
		modifiers.add("Meta");
	}
	if (init.modifierAltGraph) {
		modifiers.add("AltGraph");
	}
	if (init.modifierCapsLock) {
		modifiers.add("CapsLock");
	}
	if (init.modifierFn) {
		modifiers.add("Fn");
	}
	if (init.modifierFnLock) {
		modifiers.add("FnLock");
	}
	if (init.modifierHyper) {
		modifiers.add("Hyper");
	}
	if (init.modifierNumLock) {
		modifiers.add("NumLock");
	}
	if (init.modifierScrollLock) {
		modifiers.add("ScrollLock");
	}
	if (init.modifierSuper) {
		modifiers.add("Super");
	}
	if (init.modifierSymbol) {
		modifiers.add("Symbol");
	}
	if (init.modifierSymbolLock) {
		modifiers.add("SymbolLock");
	}
	return modifiers;
}

const kWhich = Symbol("which");

// `view` is always null here because a window is not the global object.
// An init that passes one is a type error, not a value silently dropped.
class UIEvent extends Event {
	declare [kDetail]?: number;
	declare [kWhich]?: number;

	constructor(type: string, eventInitDict: UIEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<UIEventInit>(eventInitDict, "An event init");
		if (init.view !== undefined && init.view !== null) {
			throw new TypeError("There is no window for an event to come through");
		}
		this[kDetail] = toLong(init.detail ?? 0);
		this[kWhich] = toUnsignedLong(init.which ?? 0);
	}

	get view(): null {
		return null;
	}

	get detail(): number {
		return this[kDetail]!;
	}

	get which(): number {
		return this[kWhich]!;
	}

	initUIEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		detail = 0,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initUIEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initEvent(type, bubbles, cancelable);
		if (view !== undefined && view !== null) {
			throw new TypeError("There is no window for an event to come through");
		}
		this[kDetail] = toLong(detail);
	}
}

Object.defineProperty(UIEvent.prototype, Symbol.toStringTag, {
	value: "UIEvent",
	configurable: true,
});

const kScreenX = Symbol("screenX");
const kScreenY = Symbol("screenY");
const kClientX = Symbol("clientX");
const kMovementX = Symbol("movementX");
const kMovementY = Symbol("movementY");
const kEventView = Symbol("eventView");
const kTargetRect = Symbol("targetRect");
const kClientY = Symbol("clientY");
const kButton = Symbol("button");
const kButtons = Symbol("buttons");
const kModifiers = Symbol("modifiers");

const kDefaultView = Symbol("the window this document is attached in");

// Dispatch runs activation behavior for a click that is a MouseEvent.
// [kIsMouseEvent] is how it checks.
class MouseEvent extends UIEvent implements globalThis.MouseEvent {
	declare [kScreenX]?: number;
	declare [kScreenY]?: number;
	declare [kClientX]?: number;
	declare [kClientY]?: number;
	declare [kButton]?: number;
	declare [kButtons]?: number;
	declare [kMovementX]?: number;
	declare [kMovementY]?: number;
	declare [kModifiers]?: Set<string>;

	constructor(type: string, eventInitDict: MouseEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<MouseEventInit>(eventInitDict, "An event init");
		this[kScreenX] = toLong(init.screenX ?? 0);
		this[kScreenY] = toLong(init.screenY ?? 0);
		this[kClientX] = toLong(init.clientX ?? 0);
		this[kClientY] = toLong(init.clientY ?? 0);
		this[kMovementX] = toLong(init.movementX ?? 0);
		this[kMovementY] = toLong(init.movementY ?? 0);
		this[kButton] = toShort(init.button ?? 0);
		this[kButtons] = toUnsignedShort(init.buttons ?? 0);
		this[kModifiers] = getInitModifiers(init);
		this[kState]!.relatedTarget = toEventTarget(init.relatedTarget);
	}

	get screenX(): number {
		return this[kScreenX]!;
	}

	get screenY(): number {
		return this[kScreenY]!;
	}

	get clientX(): number {
		return this[kClientX]!;
	}

	get clientY(): number {
		return this[kClientY]!;
	}

	/** Aliases of clientX/clientY, per CSSOM View. */
	get x(): number {
		return this[kClientX]!;
	}

	get y(): number {
		return this[kClientY]!;
	}

	// Client coordinates plus the document scroll, read live. Dispatch is
	// synchronous, so a listener sees the scroll the event was created under.
	get pageX(): number {
		return this[kClientX]! + (this[kEventView]?.scrollX ?? 0);
	}

	get pageY(): number {
		return this[kClientY]! + (this[kEventView]?.scrollY ?? 0);
	}

	// Client coordinates relative to the target's box. Uses the border edge
	// where the spec says padding edge, a one-cell difference.
	get offsetX(): number {
		const rect = this[kTargetRect]!;
		return rect === null ? this[kClientX]! : this[kClientX]! - rect.left;
	}

	get offsetY(): number {
		const rect = this[kTargetRect]!;
		return rect === null ? this[kClientY]! : this[kClientY]! - rect.top;
	}

	// Pre-standard, no spec. Browsers report the offset from the nearest
	// positioned ancestor, which for an unpositioned target is what
	// offsetX/offsetY already return.
	get layerX(): number {
		return this.offsetX;
	}

	get layerY(): number {
		return this.offsetY;
	}

	get movementX(): number {
		return this[kMovementX]!;
	}

	get movementY(): number {
		return this[kMovementY]!;
	}

	get ctrlKey(): boolean {
		return this[kModifiers]!.has("Control");
	}

	get shiftKey(): boolean {
		return this[kModifiers]!.has("Shift");
	}

	get altKey(): boolean {
		return this[kModifiers]!.has("Alt");
	}

	get metaKey(): boolean {
		return this[kModifiers]!.has("Meta");
	}

	get button(): number {
		return this[kButton]!;
	}

	get buttons(): number {
		return this[kButtons]!;
	}

	get relatedTarget(): EventTarget | null {
		return this[kState]!.relatedTarget;
	}

	override get which(): number {
		return this[kButton]! + 1;
	}

	override get [kIsMouseEvent](): boolean {
		return true;
	}

	/** The scroll offsets of the window the target renders in, or null. */
	get [kEventView](): {scrollX: number; scrollY: number} | null {
		const target = this[kState]!.target as Node | null;
		if (target === null || target.ownerDocument === null) {
			return null;
		}
		const view = target.ownerDocument[kDefaultView]!;
		return (view ?? null) as {scrollX: number; scrollY: number} | null;
	}

	/**
	 * The target's viewport-space rect, or null if no engine can measure it.
	 */
	get [kTargetRect](): {left: number; top: number} | null {
		const target = this[kState]!.target as Element | null;
		if (
			target === null ||
			typeof (target as {getBoundingClientRect?: unknown})
				.getBoundingClientRect !== "function"
		) {
			return null;
		}
		return target.getBoundingClientRect();
	}

	getModifierState(keyArg: string): boolean {
		if (arguments.length < 1) {
			throw new TypeError("getModifierState needs a key");
		}
		return this[kModifiers]!.has(String(keyArg));
	}

	initMouseEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		detail = 0,
		screenX = 0,
		screenY = 0,
		clientX = 0,
		clientY = 0,
		ctrlKey = false,
		altKey = false,
		shiftKey = false,
		metaKey = false,
		button = 0,
		relatedTarget: globalThis.EventTarget | null = null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initMouseEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, detail);
		this[kScreenX] = toLong(screenX);
		this[kScreenY] = toLong(screenY);
		this[kClientX] = toLong(clientX);
		this[kClientY] = toLong(clientY);
		this[kModifiers] = getInitModifiers({ctrlKey, altKey, shiftKey, metaKey});
		this[kButton] = toShort(button);
		this[kState]!.relatedTarget = toEventTarget(relatedTarget);
	}
}

/** Convert to a WebIDL short: the long, wrapped into 16 signed bits. */
function toShort(value: unknown): number {
	return (toLong(value) << 16) >> 16;
}

Object.defineProperty(MouseEvent.prototype, Symbol.toStringTag, {
	value: "MouseEvent",
	configurable: true,
});

/** Fired when focus moves. relatedTarget is the element on the other side. */
export class FocusEvent extends UIEvent {
	constructor(type: string, eventInitDict: FocusEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<FocusEventInit>(eventInitDict, "An event init");
		this[kState]!.relatedTarget = toEventTarget(init.relatedTarget);
	}

	get relatedTarget(): EventTarget | null {
		return this[kState]!.relatedTarget;
	}
}

Object.defineProperty(FocusEvent.prototype, Symbol.toStringTag, {
	value: "FocusEvent",
	configurable: true,
});

const DOM_KEY_LOCATION_STANDARD = 0;
const DOM_KEY_LOCATION_LEFT = 1;
const DOM_KEY_LOCATION_RIGHT = 2;
const DOM_KEY_LOCATION_NUMPAD = 3;

const kKey = Symbol("key");
const kCode = Symbol("code");
const kLocation = Symbol("location");
const kRepeat = Symbol("repeat");
const kIsComposing = Symbol("isComposing");
const kCharCode = Symbol("charCode");
const kKeyCode = Symbol("keyCode");

/** A key event, identified by the character it types and the physical key. */
class KeyboardEvent extends UIEvent implements globalThis.KeyboardEvent {
	static readonly DOM_KEY_LOCATION_STANDARD = DOM_KEY_LOCATION_STANDARD;
	static readonly DOM_KEY_LOCATION_LEFT = DOM_KEY_LOCATION_LEFT;
	static readonly DOM_KEY_LOCATION_RIGHT = DOM_KEY_LOCATION_RIGHT;
	static readonly DOM_KEY_LOCATION_NUMPAD = DOM_KEY_LOCATION_NUMPAD;
	declare [kKey]?: string;
	declare [kCode]?: string;
	declare [kLocation]?: number;
	declare [kRepeat]?: boolean;
	declare [kIsComposing]?: boolean;
	declare [kCharCode]?: number;
	declare [kKeyCode]?: number;
	declare [kModifiers]?: Set<string>;

	constructor(type: string, eventInitDict: KeyboardEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<KeyboardEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kKey] = String(init.key ?? "");
		this[kCode] = String(init.code ?? "");
		this[kLocation] = toUnsignedLong(init.location ?? 0);
		this[kRepeat] = Boolean(init.repeat);
		this[kIsComposing] = Boolean(init.isComposing);
		this[kCharCode] = toUnsignedLong(init.charCode ?? 0);
		this[kKeyCode] = toUnsignedLong(init.keyCode ?? 0);
		this[kModifiers] = getInitModifiers(init);
	}

	get key(): string {
		return this[kKey]!;
	}

	get code(): string {
		return this[kCode]!;
	}

	get location(): number {
		return this[kLocation]!;
	}

	get ctrlKey(): boolean {
		return this[kModifiers]!.has("Control");
	}

	get shiftKey(): boolean {
		return this[kModifiers]!.has("Shift");
	}

	get altKey(): boolean {
		return this[kModifiers]!.has("Alt");
	}

	get metaKey(): boolean {
		return this[kModifiers]!.has("Meta");
	}

	get repeat(): boolean {
		return this[kRepeat]!;
	}

	get isComposing(): boolean {
		return this[kIsComposing]!;
	}

	get charCode(): number {
		return this[kCharCode]!;
	}

	get keyCode(): number {
		return this[kKeyCode]!;
	}

	override get which(): number {
		return this[kKeyCode]!;
	}

	getModifierState(keyArg: string): boolean {
		if (arguments.length < 1) {
			throw new TypeError("getModifierState needs a key");
		}
		return this[kModifiers]!.has(String(keyArg));
	}

	initKeyboardEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		key = "",
		location = 0,
		ctrlKey = false,
		altKey = false,
		shiftKey = false,
		metaKey = false,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initKeyboardEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kKey] = String(key);
		this[kLocation] = toUnsignedLong(location);
		this[kModifiers] = getInitModifiers({ctrlKey, altKey, shiftKey, metaKey});
	}
}

/** The key-location constants, installed on the prototype. */
interface KeyboardEvent
	extends Pick<
		globalThis.KeyboardEvent,
		"DOM_KEY_LOCATION_STANDARD" |
		"DOM_KEY_LOCATION_LEFT" |
		"DOM_KEY_LOCATION_RIGHT" |
		"DOM_KEY_LOCATION_NUMPAD"
	> {}

Object.defineProperties(KeyboardEvent.prototype, {
	DOM_KEY_LOCATION_STANDARD: {
		value: DOM_KEY_LOCATION_STANDARD,
		enumerable: true,
	},
	DOM_KEY_LOCATION_LEFT: {value: DOM_KEY_LOCATION_LEFT, enumerable: true},
	DOM_KEY_LOCATION_RIGHT: {value: DOM_KEY_LOCATION_RIGHT, enumerable: true},
	DOM_KEY_LOCATION_NUMPAD: {value: DOM_KEY_LOCATION_NUMPAD, enumerable: true},
	[Symbol.toStringTag]: {value: "KeyboardEvent", configurable: true},
});

const kData = Symbol("data");

/** Fired while an input method composes text. */
class CompositionEvent extends UIEvent {
	declare [kData]?: string;

	constructor(type: string, eventInitDict: CompositionEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<CompositionEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kData] = String(init.data ?? "");
	}

	get data(): string {
		return this[kData]!;
	}

	initCompositionEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		data = "",
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initCompositionEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kData] = String(data);
	}
}

Object.defineProperty(CompositionEvent.prototype, Symbol.toStringTag, {
	value: "CompositionEvent",
	configurable: true,
});

// DOM Level 3's legacy text-input event. The interface declares no
// constructor, so createEvent("TextEvent") is the only way to make one.
class TextEvent extends UIEvent {
	declare [kData]?: string;

	constructor(type = "", eventInitDict: UIEventInit = {}) {
		super(type, eventInitDict);
		this[kData] = "";
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
	}

	get data(): string {
		return this[kData]!;
	}

	initTextEvent(
		type: string,
		bubbles = false,
		cancelable = false,
		view: globalThis.Window | null = null,
		data = "",
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initTextEvent needs a type");
		}
		if (this[kState]!.dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kData] = String(data);
	}
}

Object.defineProperty(TextEvent.prototype, Symbol.toStringTag, {
	value: "TextEvent",
	configurable: true,
});

const kInputType = Symbol("inputType");

/** Fired when an editing host's text changes, with the kind of change. */
class InputEvent extends UIEvent {
	declare [kData]?: string | null;
	declare [kIsComposing]?: boolean;
	declare [kInputType]?: string;

	constructor(type: string, eventInitDict: InputEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<InputEventInit>(eventInitDict, "An event init");
		this[kData] =
			init.data === undefined || init.data === null ? null : String(init.data);
		this[kIsComposing] = Boolean(init.isComposing);
		this[kInputType] = String(init.inputType ?? "");
	}

	get data(): string | null {
		return this[kData]!;
	}

	get isComposing(): boolean {
		return this[kIsComposing]!;
	}

	get inputType(): string {
		return this[kInputType]!;
	}
}

Object.defineProperty(InputEvent.prototype, Symbol.toStringTag, {
	value: "InputEvent",
	configurable: true,
});

// A transfer here carries text under format names and nothing else. There
// is no drag and drop in a terminal and no files to hand over, so
// `dropEffect`, `effectAllowed`, `setDragImage()` and `files` exist,
// return what the interface specifies, and do nothing.

// The platform's two shorthands map to the media types they stand for,
// so `"TEXT/Plain "` and `"text"` name the same entry.
function normalizeTransferFormat(format: unknown): string {
	const name = String(format).trim().toLowerCase();
	if (name === "text") {
		return "text/plain";
	}
	if (name === "url") {
		return "text/uri-list";
	}
	return name;
}

/** The brand used to construct an interface that declares no constructor. */
const kInternalConstruction = Symbol("internal construction");

/** A list of files. Always empty, since nothing in a terminal produces one. */
class FileList {
	get length(): number {
		return 0;
	}

	item(_index: number): null {
		return null;
	}

	* [Symbol.iterator](): Generator<never, void, unknown> {}
}

Object.defineProperty(FileList.prototype, Symbol.toStringTag, {
	value: "FileList",
	configurable: true,
});

const kItemType = Symbol("type");
const kItemData = Symbol("data");

/** One entry of a transfer: a string under a format name. */
class DataTransferItem {
	declare [kItemType]?: string;
	declare [kItemData]?: string;

	constructor(brand?: unknown, type?: string, data?: string) {
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kItemType] = String(type);
		this[kItemData] = String(data);
	}

	get kind(): string {
		return "string";
	}

	get type(): string {
		return this[kItemType]!;
	}

	getAsString(callback: unknown): void {
		if (callback === null || callback === undefined) {
			return;
		}
		if (typeof callback !== "function") {
			throw new TypeError("getAsString needs a function");
		}
		const data = this[kItemData]!;
		queueMicrotask(() => {
			(callback as (data: string) => void)(data);
		});
	}

	getAsFile(): null {
		return null;
	}
}

Object.defineProperty(DataTransferItem.prototype, Symbol.toStringTag, {
	value: "DataTransferItem",
	configurable: true,
});

const kListOwner = Symbol("owner");
const kListIndices = Symbol("indices");
const kTransferMode = Symbol("mode");

const kTransferEntries = Symbol("entries");

/** The entries of a transfer, as an indexed, mutable list. */
class DataTransferItemList {
	declare [kListOwner]?: DataTransfer;
	declare [kListIndices]?: number;

	constructor(brand?: unknown, owner?: DataTransfer) {
		if (brand !== kInternalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kListOwner] = owner as DataTransfer;
		this[kListIndices] = 0;
	}

	get length(): number {
		return this[kListOwner]![kTransferEntries]!.size;
	}

	add(data: unknown, type?: unknown): DataTransferItem | null {
		const owner = this[kListOwner]!;
		if (owner[kTransferMode] !== "readwrite") {
			return null;
		}
		if (type === undefined) {
			throw new TypeError("Adding a string entry needs a format");
		}
		const format = normalizeTransferFormat(type);
		if (owner[kTransferEntries]!.has(format)) {
			throw domError(
				"NotSupportedError",
				`The transfer already carries a ${format} entry`,
			);
		}
		owner[kTransferEntries]!.set(format, String(data));
		syncTransferItems(owner);
		return (this as unknown as Record<number, DataTransferItem>)[
			owner[kTransferEntries]!.size - 1
		];
	}

	remove(index: number): void {
		const owner = this[kListOwner]!;
		if (owner[kTransferMode] !== "readwrite") {
			throw domError(
				"InvalidStateError",
				"That transfer cannot be modified",
			);
		}
		const formats = Array.from(owner[kTransferEntries]!.keys());
		const at = toLong(index);
		if (at < 0 || at >= formats.length) {
			return;
		}
		owner[kTransferEntries]!.delete(formats[at]);
		syncTransferItems(owner);
	}

	clear(): void {
		const owner = this[kListOwner]!;
		if (owner[kTransferMode] !== "readwrite") {
			return;
		}
		owner[kTransferEntries]!.clear();
		syncTransferItems(owner);
	}
}

Object.defineProperty(DataTransferItemList.prototype, Symbol.toStringTag, {
	value: "DataTransferItemList",
	configurable: true,
});
const kTransferItems = Symbol("items");

/** Update a list's indexed properties to match the entries behind it. */
function syncTransferItems(transfer: DataTransfer): void {
	const list = transfer[kTransferItems]! as unknown as Record<number, unknown>;
	const formats = Array.from(transfer[kTransferEntries]!.keys());
	for (let i = 0; i < transfer[kTransferItems]![kListIndices]!; i++) {
		delete list[i];
	}
	for (let i = 0; i < formats.length; i++) {
		Object.defineProperty(list, i, {
			value: new DataTransferItem(
				kInternalConstruction,
				formats[i],
				transfer[kTransferEntries]!.get(formats[i]),
			),
			configurable: true,
			enumerable: true,
		});
	}
	transfer[kTransferItems]![kListIndices] = formats.length;
}

const kTransferFiles = Symbol("files");
const kDropEffect = Symbol("dropEffect");
const kEffectAllowed = Symbol("effectAllowed");

/** The payload a clipboard event carries: text under format names. */
class DataTransfer {
	declare [kTransferEntries]?: Map<string, string>;
	declare [kTransferItems]?: DataTransferItemList;
	declare [kTransferFiles]?: FileList;
	declare [kTransferMode]?: "readwrite" | "readonly" | "protected";
	declare [kDropEffect]?: string;
	declare [kEffectAllowed]?: string;

	constructor() {
		this[kTransferEntries] = new Map();
		this[kTransferItems] = new DataTransferItemList(
			kInternalConstruction,
			this,
		);
		this[kTransferFiles] = new FileList();
		this[kTransferMode] = "readwrite";
		this[kDropEffect] = "none";
		this[kEffectAllowed] = "uninitialized";
	}

	get dropEffect(): string {
		return this[kDropEffect]!;
	}

	set dropEffect(value: string) {
		const effect = String(value);
		if (["none", "copy", "link", "move"].includes(effect)) {
			this[kDropEffect] = effect;
		}
	}

	get effectAllowed(): string {
		return this[kEffectAllowed]!;
	}

	set effectAllowed(value: string) {
		this[kEffectAllowed] = String(value);
	}

	get items(): DataTransferItemList {
		return this[kTransferItems]!;
	}

	get types(): readonly string[] {
		if (this[kTransferMode] === "protected") {
			return Object.freeze([]);
		}
		return Object.freeze(Array.from(this[kTransferEntries]!.keys()));
	}

	get files(): FileList {
		return this[kTransferFiles]!;
	}

	setDragImage(_image: unknown, _x: unknown, _y: unknown): void {}

	getData(format: unknown): string {
		if (this[kTransferMode] === "protected") {
			return "";
		}
		return this[kTransferEntries]!.get(normalizeTransferFormat(format)) ?? "";
	}

	setData(format: unknown, data: unknown): void {
		if (this[kTransferMode] !== "readwrite") {
			return;
		}
		this[kTransferEntries]!.set(normalizeTransferFormat(format), String(data));
		syncTransferItems(this);
	}

	clearData(format?: unknown): void {
		if (this[kTransferMode] !== "readwrite") {
			return;
		}
		if (format === undefined) {
			this[kTransferEntries]!.clear();
		} else {
			this[kTransferEntries]!.delete(normalizeTransferFormat(format));
		}
		syncTransferItems(this);
	}
}

Object.defineProperty(DataTransfer.prototype, Symbol.toStringTag, {
	value: "DataTransfer",
	configurable: true,
});

/**
 * Put a transfer into the read-only mode `paste` gives its listeners.
 * Listeners can read the text but cannot change the clipboard through the
 * event.
 */
export function lockDataTransfer(transfer: DataTransfer): void {
	transfer[kTransferMode] = "readonly";
}

// Listeners can read a clipboard event's payload only while the event is
// dispatching, as in a browser. This is for conformance, not security: an
// app can still read the clipboard through navigator.clipboard.
function protectClipboardData(event: Event): void {
	if (!(event instanceof ClipboardEvent)) {
		return;
	}
	const transfer = event.clipboardData;
	if (transfer !== null) {
		transfer[kTransferMode] = "protected";
	}
}

interface ClipboardEventInit extends EventInit {
	clipboardData?: DataTransfer | null;
}

const kClipboardData = Symbol("clipboardData");

/** Fired for a clipboard gesture, carrying the data it moves. */
class ClipboardEvent extends Event {
	declare [kClipboardData]?: DataTransfer | null;

	constructor(type: string, eventInitDict: ClipboardEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<ClipboardEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kClipboardData] =
			init.clipboardData === undefined || init.clipboardData === null
				? null
				: init.clipboardData;
	}

	get clipboardData(): DataTransfer | null {
		return this[kClipboardData]!;
	}
}

Object.defineProperty(ClipboardEvent.prototype, Symbol.toStringTag, {
	value: "ClipboardEvent",
	configurable: true,
});

interface TransitionEventInit extends EventInit {
	propertyName?: string;
	elapsedTime?: number;
	pseudoElement?: string;
}

const kPropertyName = Symbol("propertyName");
const kElapsedTime = Symbol("elapsedTime");
const kEventPseudoElement = Symbol("pseudoElement");

/** Fired when a CSS transition changes phase (css-transitions-1 §6). */
export class TransitionEvent extends Event {
	declare [kPropertyName]?: string;
	declare [kElapsedTime]?: number;
	declare [kEventPseudoElement]?: string;

	constructor(type: string, eventInitDict: TransitionEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<TransitionEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kPropertyName] =
			init.propertyName === undefined ? "" : String(init.propertyName);
		this[kElapsedTime] =
			init.elapsedTime === undefined ? 0 : Number(init.elapsedTime);
		this[kEventPseudoElement] =
			init.pseudoElement === undefined ? "" : String(init.pseudoElement);
	}

	get propertyName(): string {
		return this[kPropertyName]!;
	}

	get elapsedTime(): number {
		return this[kElapsedTime]!;
	}

	get pseudoElement(): string {
		return this[kEventPseudoElement]!;
	}
}

Object.defineProperty(TransitionEvent.prototype, Symbol.toStringTag, {
	value: "TransitionEvent",
	configurable: true,
});

interface AnimationEventInit extends EventInit {
	animationName?: string;
	elapsedTime?: number;
	pseudoElement?: string;
}

const kAnimationName = Symbol("animationName");

// css-animations-1 §4. The engine does not run @keyframes animations
// yet. The interface exists because the platform defines it.
class AnimationEvent extends Event {
	declare [kAnimationName]?: string;
	declare [kElapsedTime]?: number;
	declare [kEventPseudoElement]?: string;

	constructor(type: string, eventInitDict: AnimationEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<AnimationEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kAnimationName] =
			init.animationName === undefined ? "" : String(init.animationName);
		this[kElapsedTime] =
			init.elapsedTime === undefined ? 0 : Number(init.elapsedTime);
		this[kEventPseudoElement] =
			init.pseudoElement === undefined ? "" : String(init.pseudoElement);
	}

	get animationName(): string {
		return this[kAnimationName]!;
	}

	get elapsedTime(): number {
		return this[kElapsedTime]!;
	}

	get pseudoElement(): string {
		return this[kEventPseudoElement]!;
	}
}

Object.defineProperty(AnimationEvent.prototype, Symbol.toStringTag, {
	value: "AnimationEvent",
	configurable: true,
});

const DOM_DELTA_PIXEL = 0x00;
const DOM_DELTA_LINE = 0x01;
const DOM_DELTA_PAGE = 0x02;

const kDeltaX = Symbol("deltaX");
const kDeltaY = Symbol("deltaY");
const kDeltaZ = Symbol("deltaZ");
const kDeltaMode = Symbol("deltaMode");

/** Fired when the wheel turns over a target. */
class WheelEvent extends MouseEvent {
	static readonly DOM_DELTA_PIXEL = DOM_DELTA_PIXEL;
	static readonly DOM_DELTA_LINE = DOM_DELTA_LINE;
	static readonly DOM_DELTA_PAGE = DOM_DELTA_PAGE;
	declare [kDeltaX]?: number;
	declare [kDeltaY]?: number;
	declare [kDeltaZ]?: number;
	declare [kDeltaMode]?: number;

	constructor(type: string, eventInitDict: WheelEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<WheelEventInit>(eventInitDict, "An event init");
		this[kDeltaX] = toDouble(init.deltaX ?? 0);
		this[kDeltaY] = toDouble(init.deltaY ?? 0);
		this[kDeltaZ] = toDouble(init.deltaZ ?? 0);
		this[kDeltaMode] = toUnsignedLong(init.deltaMode ?? 0);
	}

	get deltaX(): number {
		return this[kDeltaX]!;
	}

	get deltaY(): number {
		return this[kDeltaY]!;
	}

	get deltaZ(): number {
		return this[kDeltaZ]!;
	}

	get deltaMode(): number {
		return this[kDeltaMode]!;
	}
}

Object.defineProperties(WheelEvent.prototype, {
	DOM_DELTA_PIXEL: {value: DOM_DELTA_PIXEL, enumerable: true},
	DOM_DELTA_LINE: {value: DOM_DELTA_LINE, enumerable: true},
	DOM_DELTA_PAGE: {value: DOM_DELTA_PAGE, enumerable: true},
	[Symbol.toStringTag]: {value: "WheelEvent", configurable: true},
});

interface PointerEventInit extends MouseEventInit {
	pointerId?: number;
	width?: number;
	height?: number;
	pressure?: number;
	tangentialPressure?: number;
	tiltX?: number;
	tiltY?: number;
	twist?: number;
	altitudeAngle?: number;
	azimuthAngle?: number;
	pointerType?: string;
	isPrimary?: boolean;
	coalescedEvents?: PointerEvent[];
	predictedEvents?: PointerEvent[];
}

const kPointerId = Symbol("pointerId");
const kWidth = Symbol("width");
const kHeight = Symbol("height");
const kPressure = Symbol("pressure");
const kTangentialPressure = Symbol("tangentialPressure");
const kTiltX = Symbol("tiltX");
const kTiltY = Symbol("tiltY");
const kTwist = Symbol("twist");
const kAltitudeAngle = Symbol("altitudeAngle");
const kAzimuthAngle = Symbol("azimuthAngle");
const kPointerType = Symbol("pointerType");
const kIsPrimary = Symbol("isPrimary");
const kCoalesced = Symbol("coalesced");
const kPredicted = Symbol("predicted");

// `element.click()` fires one of these. It is a MouseEvent, so dispatch
// runs any activation behavior it reaches.
class PointerEvent extends MouseEvent {
	declare [kPointerId]?: number;
	declare [kWidth]?: number;
	declare [kHeight]?: number;
	declare [kPressure]?: number;
	declare [kTangentialPressure]?: number;
	declare [kTiltX]?: number | null;
	declare [kTiltY]?: number | null;
	declare [kTwist]?: number;
	declare [kAltitudeAngle]?: number | null;
	declare [kAzimuthAngle]?: number | null;
	declare [kPointerType]?: string;
	declare [kIsPrimary]?: boolean;
	declare [kCoalesced]?: PointerEvent[];
	declare [kPredicted]?: PointerEvent[];

	constructor(type: string, eventInitDict: PointerEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<PointerEventInit>(eventInitDict, "An event init");
		this[kPointerId] = toLong(init.pointerId ?? 0);
		this[kWidth] = toDouble(init.width ?? 1);
		this[kHeight] = toDouble(init.height ?? 1);
		this[kPressure] = toDouble(init.pressure ?? 0);
		this[kTangentialPressure] = toDouble(init.tangentialPressure ?? 0);
		this[kTiltX] = init.tiltX === undefined ? null : toLong(init.tiltX);
		this[kTiltY] = init.tiltY === undefined ? null : toLong(init.tiltY);
		this[kTwist] = toLong(init.twist ?? 0);
		this[kAltitudeAngle] =
			init.altitudeAngle === undefined ? null : toDouble(init.altitudeAngle);
		this[kAzimuthAngle] =
			init.azimuthAngle === undefined ? null : toDouble(init.azimuthAngle);
		this[kPointerType] = String(init.pointerType ?? "");
		this[kIsPrimary] = Boolean(init.isPrimary);
		this[kCoalesced] = [...(init.coalescedEvents ?? [])];
		this[kPredicted] = [...(init.predictedEvents ?? [])];
	}

	get pointerId(): number {
		return this[kPointerId]!;
	}

	get width(): number {
		return this[kWidth]!;
	}

	get height(): number {
		return this[kHeight]!;
	}

	get pressure(): number {
		return this[kPressure]!;
	}

	get tangentialPressure(): number {
		return this[kTangentialPressure]!;
	}

	// The tilt pair and the altitude/azimuth pair describe the same angle two
	// ways. If an init gives one, the other is computed from it. If it gives
	// neither, the pen is upright.
	get tiltX(): number {
		if (this[kTiltX] !== null) {
			return this[kTiltX]!;
		}
		if (this[kAltitudeAngle] === null && this[kAzimuthAngle] === null) {
			return 0;
		}
		return sphericalToTilt(
			this[kAltitudeAngle] ?? Math.PI / 2,
			this[kAzimuthAngle] ?? 0,
		)[0];
	}

	get tiltY(): number {
		if (this[kTiltY] !== null) {
			return this[kTiltY]!;
		}
		if (this[kAltitudeAngle] === null && this[kAzimuthAngle] === null) {
			return 0;
		}
		return sphericalToTilt(
			this[kAltitudeAngle] ?? Math.PI / 2,
			this[kAzimuthAngle] ?? 0,
		)[1];
	}

	get twist(): number {
		return this[kTwist]!;
	}

	get altitudeAngle(): number {
		if (this[kAltitudeAngle] !== null) {
			return this[kAltitudeAngle]!;
		}
		if (this[kTiltX] === null && this[kTiltY] === null) {
			return Math.PI / 2;
		}
		return tiltToSpherical(this[kTiltX] ?? 0, this[kTiltY] ?? 0)[0];
	}

	get azimuthAngle(): number {
		if (this[kAzimuthAngle] !== null) {
			return this[kAzimuthAngle]!;
		}
		if (this[kTiltX] === null && this[kTiltY] === null) {
			return 0;
		}
		return tiltToSpherical(this[kTiltX] ?? 0, this[kTiltY] ?? 0)[1];
	}

	get pointerType(): string {
		return this[kPointerType]!;
	}

	get isPrimary(): boolean {
		return this[kIsPrimary]!;
	}

	getCoalescedEvents(): PointerEvent[] {
		return [...this[kCoalesced]!];
	}

	getPredictedEvents(): PointerEvent[] {
		return [...this[kPredicted]!];
	}
}

Object.defineProperty(PointerEvent.prototype, Symbol.toStringTag, {
	value: "PointerEvent",
	configurable: true,
});

interface DragEventInit extends MouseEventInit {
	dataTransfer?: DataTransfer | null;
}

const kEventDataTransfer = Symbol("event data transfer");

/** A drag-and-drop event, carrying its drag session's data transfer. */
class DragEvent extends MouseEvent {
	declare [kEventDataTransfer]?: DataTransfer | null;

	constructor(type: string, eventInitDict: DragEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<DragEventInit>(eventInitDict, "An event init");
		this[kEventDataTransfer] = init.dataTransfer ?? null;
	}

	get dataTransfer(): DataTransfer | null {
		return this[kEventDataTransfer]!;
	}
}

Object.defineProperty(DragEvent.prototype, Symbol.toStringTag, {
	value: "DragEvent",
	configurable: true,
});

/** Convert a pen's altitude and azimuth to tilt angles in degrees. */
function sphericalToTilt(altitude: number, azimuth: number): [number, number] {
	if (altitude === 0) {
		if (azimuth === 0 || azimuth === 2 * Math.PI) {
			return [90, 0];
		}
		if (azimuth === Math.PI / 2) {
			return [0, 90];
		}
		if (azimuth === Math.PI) {
			return [-90, 0];
		}
		if (azimuth === (3 * Math.PI) / 2) {
			return [0, -90];
		}
	}
	const tiltX = Math.round(
		(Math.atan(Math.cos(azimuth) / Math.tan(altitude)) * 180) / Math.PI,
	);
	const tiltY = Math.round(
		(Math.atan(Math.sin(azimuth) / Math.tan(altitude)) * 180) / Math.PI,
	);
	return [tiltX, tiltY];
}

/** Convert a pen's tilt angles to altitude and azimuth in radians. */
function tiltToSpherical(tiltX: number, tiltY: number): [number, number] {
	const radiansX = (tiltX * Math.PI) / 180;
	const radiansY = (tiltY * Math.PI) / 180;
	const tanX = Math.tan(radiansX);
	const tanY = Math.tan(radiansY);
	let azimuth = Math.atan2(tanY, tanX);
	if (azimuth < 0) {
		azimuth += 2 * Math.PI;
	}
	const altitude = Math.atan(1 / Math.sqrt(tanX * tanX + tanY * tanY));
	return [
		Math.abs(tiltX) === 90 || Math.abs(tiltY) === 90 ? 0 : altitude,
		azimuth,
	];
}

// The legacy interface table createEvent builds from. Sensor and touch
// names are left out on purpose: they describe hardware a terminal does
// not have, so createEvent throws for them.
const LEGACY_EVENT_INTERFACES = new Map<string, () => Event>([
	["beforeunloadevent", () => new BeforeUnloadEvent("", {})],
	["compositionevent", () => new CompositionEvent("")],
	["customevent", () => new CustomEvent("")],
	["dragevent", () => new DragEvent("")],
	["event", () => new Event("")],
	["events", () => new Event("")],
	["focusevent", () => new FocusEvent("")],
	["hashchangeevent", () => new HashChangeEvent("")],
	["htmlevents", () => new Event("")],
	["keyboardevent", () => new KeyboardEvent("")],
	["messageevent", () => new MessageEvent("")],
	["mouseevent", () => new MouseEvent("")],
	["mouseevents", () => new MouseEvent("")],
	["storageevent", () => new StorageEvent("")],
	["svgevents", () => new Event("")],
	["textevent", () => new TextEvent("")],
	["uievent", () => new UIEvent("")],
	["uievents", () => new UIEvent("")],
]);

type EventListener = (event: Event) => void;

interface EventListenerObject {
	handleEvent(event: Event): void;
}

type EventListenerOrEventListenerObject = EventListener | EventListenerObject;

/** What an AbortSignal must provide for a listener to use it. */
interface ListenerSignal {
	aborted: boolean;
	addEventListener(type: string, callback: () => void): void;
}

interface AddEventListenerOptions {
	capture?: boolean;
	once?: boolean;
	passive?: boolean;
	signal?: ListenerSignal;
}

interface EventListenerOptions {
	capture?: boolean;
}

/** Event types whose listeners mean the document observes pointer hover. */
const HOVER_EVENT_TYPES = new Set([
	"mousemove",
	"mouseover",
	"mouseout",
	"mouseenter",
	"mouseleave",
]);

// The engine checks this count to decide whether the terminal should
// report pointer motion. Motion reporting floods stdin, so it stays off
// until a listener can actually use the events.
interface HoverListenerCount {
	count: number;
	onChange: (() => void) | null;
}

const hoverListenerCounters = new WeakMap<Document, HoverListenerCount>();

function getHoverCount(document: Document): HoverListenerCount {
	let hoverCount = hoverListenerCounters.get(document);
	if (hoverCount === undefined) {
		hoverCount = {count: 0, onChange: null};
		hoverListenerCounters.set(document, hoverCount);
	}
	return hoverCount;
}

// Returns null when the type is not a hover type or the target belongs to
// no document.
function getListenerHoverCount(
	target: EventTarget,
	type: string,
): HoverListenerCount | null {
	if (!HOVER_EVENT_TYPES.has(type)) {
		return null;
	}
	if (target instanceof Node) {
		return getHoverCount(target[kDocument]!);
	}
	// A window is an EventTarget with a document. Anything else is not
	// counted.
	const document = (target as {document?: unknown}).document;
	return document instanceof Document ? getHoverCount(document) : null;
}

function countHoverListener(target: EventTarget, listener: Listener): void {
	const hoverCount = getListenerHoverCount(target, listener.type);
	if (hoverCount !== null) {
		listener.hoverCount = hoverCount;
		hoverCount.count++;
		hoverCount.onChange?.();
	}
}

// One watcher per document, which is the engine displaying it. The
// returned function reads the current count.
function watchHoverListeners(
	document: Document,
	onChange: () => void,
): () => number {
	const hoverCount = getHoverCount(document);
	hoverCount.onChange = onChange;
	return () => hoverCount.count;
}

interface Listener {
	type: string;
	callback: EventListenerOrEventListenerObject;
	capture: boolean;
	once: boolean;
	passive: boolean;
	removed: boolean;

	/** The hover count this listener is counted in, if any. */
	hoverCount?: HoverListenerCount;
}

/**
 * The platform's AbortSignal, which a listener's signal must be an instance of.
 */
const PlatformAbortSignal = (
	globalThis as unknown as {AbortSignal?: new () => ListenerSignal}
).AbortSignal;

const kHandlers = Symbol("handlers");
const kListeners = Symbol("event listener list");
const kGetTheParent = Symbol("get the parent");

/** An event target: a listener list, and the parent dispatch walks to. */
class EventTarget implements globalThis.EventTarget {
	declare [kListeners]?: Listener[];

	/** Null until this target is given an event handler. Most never are. */
	declare [kHandlers]?: Map<string, EventHandlerRecord> | null;
	constructor() {
		this[kListeners] = [];
		this[kHandlers] = null;
	}

	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		listener: EventListener | EventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("addEventListener needs a type and a callback");
		}
		const name = String(type);
		const listenerCallback = toEventListener(callback);
		const flat = flattenMore(options);
		if (flat.signal !== null && flat.signal.aborted) {
			return;
		}
		if (listenerCallback === null) {
			return;
		}
		const passive =
			flat.passive === null ? getDefaultPassiveValue(name, this) : flat.passive;
		for (const existing of this[kListeners]!) {
			if (
				existing.type === name &&
				existing.callback === listenerCallback &&
				existing.capture === flat.capture
			) {
				return;
			}
		}
		const listener: Listener = {
			type: name,
			callback: listenerCallback,
			capture: flat.capture,
			once: flat.once,
			passive,
			removed: false,
		};
		this[kListeners]!.push(listener);
		countHoverListener(this, listener);
		if (flat.signal !== null) {
			flat.signal.addEventListener("abort", () => {
				removeListener(this[kListeners]!, listener);
			});
		}
	}

	removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		listener: EventListener | EventListenerObject,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		if (arguments.length < 2) {
			throw new TypeError("removeEventListener needs a type and a callback");
		}
		const name = String(type);
		const listenerCallback = toEventListener(callback);
		const capture = flattenCapture(options);
		if (listenerCallback === null) {
			return;
		}
		for (const listener of this[kListeners]!) {
			if (
				listener.type === name &&
				listener.callback === listenerCallback &&
				listener.capture === capture
			) {
				removeListener(this[kListeners]!, listener);
				return;
			}
		}
	}

	dispatchEvent(event: Event): boolean {
		return dispatchFromOutside(this, event, false);
	}

	// A bare event target ends the path. A node returns its parent.
	[kGetTheParent]?(_event: Event): EventTarget | null {
		return null;
	}
}

function flattenMore(
	options: boolean | AddEventListenerOptions | undefined,
): {
	capture: boolean;
	once: boolean;

	/** Null until the type and target decide it, which the spec defers. */
	passive: boolean | null;
	signal: ListenerSignal | null;
} {
	if (
		options !== null &&
		options !== undefined &&
		typeof options !== "object" &&
		typeof options !== "function"
	) {
		return {
			capture: Boolean(options),
			once: false,
			passive: null,
			signal: null,
		};
	}
	const dictionary = toDictionary<AddEventListenerOptions>(
		options,
		"Listener options",
	);
	let signal: ListenerSignal | null = null;
	if (dictionary.signal !== undefined) {
		if (
			PlatformAbortSignal === undefined ||
			!(dictionary.signal instanceof PlatformAbortSignal)
		) {
			throw new TypeError("A listener's signal must be an AbortSignal");
		}
		signal = dictionary.signal;
	}
	return {
		capture: Boolean(dictionary.capture),
		once: Boolean(dictionary.once),
		passive:
			dictionary.passive === undefined ? null : Boolean(dictionary.passive),
		signal,
	};
}

/** A capture-only options argument, for removeEventListener. */
function flattenCapture(
	options: boolean | EventListenerOptions | undefined,
): boolean {
	if (
		options !== null &&
		options !== undefined &&
		typeof options !== "object" &&
		typeof options !== "function"
	) {
		return Boolean(options);
	}
	return Boolean(
		toDictionary<EventListenerOptions>(options, "Listener options").capture,
	);
}

/** Convert a listener callback per Web IDL: null, or a callable object. */
function toEventListener(
	callback: unknown,
): EventListenerOrEventListenerObject | null {
	if (callback === null || callback === undefined) {
		return null;
	}
	if (typeof callback === "function" || typeof callback === "object") {
		return callback as EventListenerOrEventListenerObject;
	}
	throw new TypeError("An event listener must be an object or a function");
}

// Scroll-blocking event types are passive by default at the roots a page
// scrolls through, so a listener there cannot cancel a scroll it only
// meant to observe.
function getDefaultPassiveValue(type: string, target: EventTarget): boolean {
	if (
		type !== "touchstart" &&
		type !== "touchmove" &&
		type !== "wheel" &&
		type !== "mousewheel"
	) {
		return false;
	}
	if (!(target instanceof Node)) {
		return false;
	}
	const document = target[kDocument]!;
	return (
		target === (document as EventTarget) ||
		target === (document.documentElement as EventTarget | null) ||
		target === (document.body as EventTarget | null)
	);
}

// Created only when a handler is set. Reading a handler from a target
// that has none allocates nothing.
function getEventHandlerMap(
	target: EventTarget,
	create: boolean,
): Map<string, EventHandlerRecord> | null {
	if (target[kHandlers] === null && create) {
		target[kHandlers] = new Map();
	}
	return target[kHandlers]!;
}

Object.defineProperty(EventTarget.prototype, Symbol.toStringTag, {
	value: "EventTarget",
	configurable: true,
});

/**
 * Remove a listener from a list and mark it so an in-progress dispatch skips
 * it.
 */
function removeListener(listeners: Listener[], listener: Listener): void {
	listener.removed = true;
	const index = listeners.indexOf(listener);
	if (index !== -1) {
		listeners.splice(index, 1);
		if (listener.hoverCount !== undefined) {
			listener.hoverCount.count--;
			listener.hoverCount.onChange?.();
		}
	}
}

// LegacyTreatNonObjectAsNull: a non-object is stored as null. A
// non-callable object is stored and throws when the event arrives.
type EventHandlerValue = ((event: Event) => unknown) | object;

// The listener is registered on the first non-null assignment and stays
// registered, which fixes the handler's position among listeners added
// around it. Reassigning `onclick` changes what runs, never when. A null
// assignment removes it, so a later assignment goes to the end.
interface EventHandlerRecord {
	value: EventHandlerValue | null;
	listener: Listener | null;
}

/** The value an event handler attribute holds, or null. */
function getEventHandlerValue(
	target: EventTarget,
	type: string,
): EventHandlerValue | null {
	const handlers = getEventHandlerMap(target, false);
	if (handlers === null) {
		return null;
	}
	return handlers.get(type)?.value ?? null;
}

// Activate the handler on a value. Deactivate it on null.
function setEventHandler(
	target: EventTarget,
	type: string,
	value: unknown,
): void {
	const handler =
		typeof value === "function" ||
		(typeof value === "object" && value !== null)
			? (value as EventHandlerValue)
			: null;
	const handlers = getEventHandlerMap(target, handler !== null);
	if (handlers === null) {
		return;
	}
	const record = handlers.get(type);
	if (handler === null) {
		if (record === undefined) {
			return;
		}
		record.value = null;
		if (record.listener !== null) {
			removeListener(target[kListeners]!, record.listener);
			record.listener = null;
		}
		return;
	}
	if (record !== undefined) {
		record.value = handler;
		if (record.listener === null) {
			record.listener = registerHandlerListener(target, type, record);
		}
		return;
	}
	const created: EventHandlerRecord = {value: handler, listener: null};
	handlers.set(type, created);
	created.listener = registerHandlerListener(target, type, created);
}

// Writes the list directly, as the spec's "add an event listener" does.
// Setting a handler is not an addEventListener call and does not go
// through one.
function registerHandlerListener(
	target: EventTarget,
	type: string,
	record: EventHandlerRecord,
): Listener {
	const listener: Listener = {
		type,
		callback: (event: Event): void => {
			invokeEventHandler(target, type, record, event);
		},
		capture: false,
		once: false,
		passive: false,
		removed: false,
	};
	target[kListeners]!.push(listener);
	countHoverListener(target, listener);
	return listener;
}

// This DOM defines no ErrorEvent interface, so this tests for the shape
// of an ErrorEvent dispatched from outside.
function isErrorEvent(event: Event): boolean {
	return (
		"message" in event &&
		"filename" in event &&
		"lineno" in event &&
		"colno" in event &&
		"error" in event
	);
}

// The event handler processing algorithm. If a handler throws, the
// exception is reported instead of propagating into the dispatch.
function invokeEventHandler(
	target: EventTarget,
	type: string,
	record: EventHandlerRecord,
	event: Event,
): void {
	const callback = record.value;
	if (callback === null) {
		return;
	}
	// A window's error handler receives the ErrorEvent's text controls as
	// separate arguments and returns true to cancel, the inverse of every other
	// handler. A document's or element's error handler is an ordinary one.
	const errorHandling =
		type === "error" && !(target instanceof Node) && isErrorEvent(event);
	let result: unknown;
	try {
		const called = callback as (...args: unknown[]) => unknown;
		result = errorHandling
			? called.call(
				target,
				(event as unknown as {message: unknown}).message,
				(event as unknown as {filename: unknown}).filename,
				(event as unknown as {lineno: unknown}).lineno,
				(event as unknown as {colno: unknown}).colno,
				(event as unknown as {error: unknown}).error,
			)
			: called.call(target, event);
	} catch (error) {
		reportError(error);
		return;
	}
	if (errorHandling ? result === true : result === false) {
		setCanceledFlag(event);
	}
}

// The prefixed animation handlers listen for the mixed-case legacy types
// (HTML's event handler table).
const PREFIXED_HANDLER_TYPES = new Map([
	["onwebkitanimationend", "webkitAnimationEnd"],
	["onwebkitanimationiteration", "webkitAnimationIteration"],
	["onwebkitanimationstart", "webkitAnimationStart"],
	["onwebkittransitionend", "webkitTransitionEnd"],
]);

// Per spec a handler IS a listener. It goes through the same listener
// list as any other, so dispatch order and dedup are the same.
function installEventHandler(prototype: object, name: string): void {
	const type = PREFIXED_HANDLER_TYPES.get(name) ?? name.slice(2);
	Object.defineProperty(prototype, name, {
		get(this: EventTarget): EventHandlerValue | null {
			return getEventHandlerValue(this, type);
		},
		set(this: EventTarget, value: unknown): void {
			setEventHandler(this, type, value);
		},
		enumerable: true,
		configurable: true,
	});
}

function installEventHandlers(
	prototype: object,
	names: readonly string[],
): void {
	for (const name of names) {
		installEventHandler(prototype, name);
	}
}

// The handlers `body` and `frameset` forward to the window. With no
// window, writes are dropped and reads return null.
function installForwardedEventHandler(prototype: object, name: string): void {
	Object.defineProperty(prototype, name, {
		get(this: Element): unknown {
			const view = this[kDocument]![kDefaultView]! as Record<
				string,
				unknown
			> | null;
			return view === null ? null : (view[name] ?? null);
		},
		set(this: Element, value: unknown): void {
			const view = this[kDocument]![kDefaultView]! as Record<
				string,
				unknown
			> | null;
			if (view === null) {
				return;
			}
			view[name] = value;
		},
		enumerable: true,
		configurable: true,
	});
}

const kHost = Symbol("host");

// Walk out of any shadow trees the other object cannot see into.
function retarget(
	object: EventTarget | null,
	against: EventTarget,
): EventTarget | null {
	let current = object;
	for (;;) {
		if (!(current instanceof Node)) {
			return current;
		}
		const root = getRoot(current);
		if (!isShadowRoot(root)) {
			return current;
		}
		// Uses shadow-including ancestry. A tree the other object reaches
		// through its own host is one it can see into, so a related target
		// inside a nested shadow tree is not retargeted for a listener in the
		// tree above.
		if (
			against instanceof Node &&
			isShadowIncludingInclusiveAncestor(root, against)
		) {
			return current;
		}
		current = (root as DocumentFragment)[kHost]!;
	}
}

/** Whether a root is a shadow root, meaning a fragment with a host. */
function isShadowRoot(root: Node): boolean {
	return root instanceof ShadowRoot;
}

const kShadowMode = Symbol("shadow root mode");

function appendToPath(
	state: DispatchState,
	invocationTarget: EventTarget,
	shadowAdjustedTarget: EventTarget | null,
	relatedTarget: EventTarget | null,
	slotInClosedTree: boolean,
): void {
	const inShadowTree =
		invocationTarget instanceof Node && isShadowRoot(getRoot(invocationTarget));
	const rootOfClosedTree =
		invocationTarget instanceof ShadowRoot &&
		invocationTarget[kShadowMode] === "closed";
	state.path.push({
		invocationTarget,
		invocationTargetInShadowTree: inShadowTree,
		shadowAdjustedTarget,
		relatedTarget,
		rootOfClosedTree,
		slotInClosedTree,
	});
}

// A platform event's prototype getters know nothing about a tree, so an
// own property shadows each member that dispatch controls. The properties
// stay on the event afterwards and read the cleared state.
function adoptForeignEvent(event: Event): void {
	if (Object.prototype.hasOwnProperty.call(event, kState)) {
		return;
	}
	const state: DispatchState = {
		target: null,
		relatedTarget: null,
		currentTarget: null,
		eventPhase: NONE,
		path: [],
		initialized: true,
		dispatch: false,
		stopPropagation: false,
		stopImmediate: false,
		canceled: Boolean(event.defaultPrevented),
		inPassiveListener: false,
		trusted: false,
		foreign: true,
	};
	Object.defineProperty(event, kState, {value: state});
	defineDispatchAccessor(event, "target", () => state.target);
	defineDispatchAccessor(event, "srcElement", () => state.target);
	defineDispatchAccessor(event, "currentTarget", () => state.currentTarget);
	defineDispatchAccessor(event, "eventPhase", () => state.eventPhase);
	Object.defineProperty(event, "composedPath", {
		value: () => getComposedPath(state),
		configurable: true,
	});
}

function defineDispatchAccessor(
	event: Event,
	name: string,
	get: () => unknown,
): void {
	Object.defineProperty(event, name, {get, configurable: true});
}

// Read back the flags a listener set on the platform object.
// stopImmediatePropagation is not distinguishable from stopPropagation
// there, so it stops the targets after this one while the remaining
// listeners at this target still run.
function syncForeignFlags(event: Event, state: DispatchState): void {
	if (event.defaultPrevented) {
		setCanceledFlag(event);
	}
	if ((event as {cancelBubble?: boolean}).cancelBubble) {
		state.stopPropagation = true;
	}
}

// The one place an event's trust is decided. dispatchEvent() is never
// trusted. dispatchAsUserAgent() and dispatch() below (the spec's "fire an
// event") are always trusted.
function dispatchFromOutside(
	target: EventTarget,
	event: Event,
	trusted: boolean,
): boolean {
	if (!(event instanceof HostEvent)) {
		throw new TypeError("dispatchEvent needs an Event");
	}
	if (!(event instanceof Event)) {
		adoptForeignEvent(event);
	}
	const state = event[kState]!;
	if (state.dispatch || !state.initialized) {
		throw domError(
			"InvalidStateError",
			"That event is already being dispatched",
		);
	}
	return dispatch(target, event, trusted);
}

// Pressing a bare modifier key is not a request for anything.
const BARE_MODIFIER_KEYS = new Set([
	"Alt",
	"AltGraph",
	"CapsLock",
	"Control",
	"Fn",
	"FnLock",
	"Hyper",
	"Meta",
	"NumLock",
	"ScrollLock",
	"Shift",
	"Super",
	"Symbol",
	"SymbolLock",
]);

// Events that represent the user asking for something, as opposed to
// something happening to them. The list is the spec's. A paste's default
// action forwards the text as a beforeinput, so that counts too.
function isActivationTriggering(event: {
	type: string;
	key?: string;
	inputType?: string;
}): boolean {
	switch (event.type) {
		case "keydown":
			return event.key !== "Escape" && !BARE_MODIFIER_KEYS.has(event.key!);
		case "mousedown":
		case "mouseup":
		case "click":
		case "paste":
			return true;
		case "beforeinput":
			return event.inputType === "insertFromPaste";
		default:
			return false;
	}
}

/** How many activation-triggering dispatches are running, per document. */
const activationDepths = new WeakMap<Document, number>();

/** Documents the user has ever acted on. */
const everActivatedDocuments = new WeakSet<Document>();

/** The document a user-agent dispatch counts its activation in. */
function getActivationDocument(target: EventTarget): Document | null {
	const shaped = target as {
		nodeType?: number;
		ownerDocument?: Document | null;
		document?: Document;
	};
	if (shaped.nodeType === DOCUMENT_NODE) {
		return target as unknown as Document;
	}
	return shaped.ownerDocument ?? shaped.document ?? null;
}

/** Whether an activation-triggering event is being dispatched right now. */
function isUserActive(document: Document): boolean {
	return (activationDepths.get(document) ?? 0) > 0;
}

/**
 * Dispatch a trusted event, as the user agent.
 *
 * The engine calls this when decoded terminal input, a viewport change or
 * a focus move becomes a DOM event. That covers everything the user or the
 * terminal caused, as opposed to events an application constructs and
 * dispatches itself. An activation-triggering event keeps user activation
 * open for as long as its dispatch runs, which the clipboard checks.
 */
export function dispatchAsUserAgent(
	target: globalThis.EventTarget,
	event: globalThis.Event,
): boolean {
	const document = getActivationDocument(target as EventTarget);
	if (document === null || !isActivationTriggering(event)) {
		return dispatchFromOutside(target as EventTarget, event as Event, true);
	}
	activationDepths.set(document, (activationDepths.get(document) ?? 0) + 1);
	everActivatedDocuments.add(document);
	try {
		return dispatchFromOutside(target as EventTarget, event as Event, true);
	} finally {
		activationDepths.set(document, activationDepths.get(document)! - 1);
	}
}

// Builds the path once, from the target outward, then walks it twice:
// capture in, bubble out. A struct with a shadow-adjusted target is a
// target of this dispatch and is walked both ways whether or not the
// event bubbles. The spec's legacy target override flag (HTML's load
// event) has no use here. Trusted unless the caller says otherwise;
// click() fires a synthetic, untrusted pointer event.
function dispatch(
	target: EventTarget,
	event: Event,
	trusted = true,
): boolean {
	const state = event[kState]!;
	state.trusted = trusted;
	state.dispatch = true;
	let activationTarget: EventTarget | null = null;
	let relatedTarget = retarget(state.relatedTarget, target);
	let clearTargets = false;
	if (target !== relatedTarget || target === state.relatedTarget) {
		let eventTarget = target;
		const isActivationEvent =
			event[kIsMouseEvent] && event.type === "click";
		appendToPath(state, eventTarget, eventTarget, relatedTarget, false);
		// An assigned slottable's next target is its slot, and the slot's tree
		// may be closed to the tree the event started in. The slot's struct
		// records that so composedPath can count the boundary.
		let slottable: Node | null = isAssigned(eventTarget)
			? (eventTarget as Node)
			: null;
		let slotInClosedTree = false;
		if (isActivationEvent && hasActivationBehavior(eventTarget)) {
			activationTarget = eventTarget;
		}
		let parent = eventTarget[kGetTheParent]!(event);
		while (parent !== null) {
			if (slottable !== null) {
				slottable = null;
				const slotRoot = getRoot(parent as Node);
				if (
					slotRoot instanceof ShadowRoot &&
					slotRoot[kShadowMode] === "closed"
				) {
					slotInClosedTree = true;
				}
			}
			if (isAssigned(parent)) {
				slottable = parent as Node;
			}
			relatedTarget = retarget(state.relatedTarget, parent);
			if (
				parent instanceof Node &&
				eventTarget instanceof Node &&
				isShadowIncludingInclusiveAncestor(getRoot(eventTarget), parent)
			) {
				if (
					isActivationEvent &&
					event.bubbles &&
					activationTarget === null &&
					hasActivationBehavior(parent)
				) {
					activationTarget = parent;
				}
				appendToPath(state, parent, null, relatedTarget, slotInClosedTree);
			} else if (parent === relatedTarget) {
				parent = null;
			} else {
				eventTarget = parent;
				if (
					isActivationEvent &&
					activationTarget === null &&
					hasActivationBehavior(eventTarget)
				) {
					activationTarget = eventTarget;
				}
				appendToPath(
					state,
					parent,
					eventTarget,
					relatedTarget,
					slotInClosedTree,
				);
			}
			if (parent !== null) {
				parent = parent[kGetTheParent]!(event);
			}
			slotInClosedTree = false;
		}
		for (let index = state.path.length - 1; index >= 0; index--) {
			const struct = state.path[index];
			if (struct.shadowAdjustedTarget !== null) {
				if (isShadowRootTarget(struct.shadowAdjustedTarget)) {
					clearTargets = true;
				}
				if (isShadowRootTarget(struct.relatedTarget)) {
					clearTargets = true;
				}
				break;
			}
		}
		if (activationTarget instanceof HTMLInputElement) {
			legacyPreActivationBehavior(activationTarget);
		}
		for (let index = state.path.length - 1; index >= 0; index--) {
			const struct = state.path[index];
			state.eventPhase =
				struct.shadowAdjustedTarget !== null ? AT_TARGET : CAPTURING_PHASE;
			invokeListeners(event, index, true);
		}
		for (let index = 0; index < state.path.length; index++) {
			const struct = state.path[index];
			if (struct.shadowAdjustedTarget !== null) {
				state.eventPhase = AT_TARGET;
			} else {
				if (!event.bubbles) {
					continue;
				}
				state.eventPhase = BUBBLING_PHASE;
			}
			invokeListeners(event, index, false);
		}
	}
	state.eventPhase = NONE;
	state.currentTarget = null;
	state.path = [];
	state.dispatch = false;
	state.stopPropagation = false;
	state.stopImmediate = false;
	if (clearTargets) {
		state.target = null;
		state.relatedTarget = null;
	}
	if (activationTarget !== null) {
		if (!state.canceled) {
			runActivationBehavior(activationTarget, event);
		} else if (activationTarget instanceof HTMLInputElement) {
			legacyCanceledActivationBehavior(activationTarget);
		}
	}
	protectClipboardData(event);
	return !state.canceled;
}

/** Whether a target is a node inside a shadow tree. */
function isShadowRootTarget(target: EventTarget | null): boolean {
	return target instanceof Node && isShadowRoot(getRoot(target));
}

// Dispatch walks the path looking for a target with activation
// behavior, then runs it after the walk.
function hasActivationBehavior(target: EventTarget): boolean {
	return (
		target instanceof HTMLAnchorElement ||
		target instanceof HTMLAreaElement ||
		target instanceof HTMLButtonElement ||
		target instanceof HTMLInputElement ||
		target instanceof HTMLLabelElement ||
		isDetailsSummary(target)
	);
}

// A hyperlink's activation behavior is to follow it, which this engine
// never does. An anchor or area is an activation target that does
// nothing.
function runActivationBehavior(target: EventTarget, event: Event): void {
	if (target instanceof HTMLButtonElement) {
		activateButton(target, event);
	} else if (target instanceof HTMLInputElement) {
		activateInput(target, event);
	} else if (target instanceof HTMLLabelElement) {
		activateLabel(target, event);
	} else if (isDetailsSummary(target)) {
		toggleTheDetails(target);
	}
}

/** Input types that are buttons rather than text controls. */
const BUTTON_INPUT_TYPES = new Set(["button", "image", "reset", "submit"]);

/**
 * Which keys activate an element the way a click does, or null for an
 * element no keystroke activates.
 *
 * Buttons take Enter and Space. Links take Enter only, because in a
 * browser Space scrolls the page instead of following the link, and the
 * difference is observable enough to keep. A summary takes both; whether
 * it is its details' first summary is checked by the activation behavior
 * above.
 *
 * The elements are the ones hasActivationBehavior lists, minus label,
 * whose behavior is a click forwarded to its control rather than a key of
 * its own. The input interpreter decides which keys a terminal sends. This
 * file decides which elements they apply to.
 */
export function getKeyboardActivation(
	target: globalThis.Element,
): {enter: boolean; space: boolean} | null {
	const element = target as Element;
	const tag = element.tagName;
	if (tag === "BUTTON") {
		return {enter: true, space: true};
	}
	if (tag === "INPUT") {
		const type = (element as HTMLInputElement).type;
		return BUTTON_INPUT_TYPES.has(type) ? {enter: true, space: true} : null;
	}
	if (tag === "A" && element.hasAttribute("href")) {
		return {enter: true, space: false};
	}
	if (tag === "SUMMARY") {
		return {enter: true, space: true};
	}
	return null;
}

const kNamespace = Symbol("namespace");

const kLocalName = Symbol("local name");

const kParent = Symbol("parent");

// HTML gives summary no interface of its own, and only the first summary
// of a details toggles that details.
function isDetailsSummary(target: EventTarget): target is HTMLElement {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (
		target[kNamespace] !== HTML_NAMESPACE ||
		target[kLocalName] !== "summary"
	) {
		return false;
	}
	const parent = target[kParent]!;
	return (
		parent instanceof HTMLDetailsElement &&
		getFirstChildElement(parent, "summary") === target
	);
}

function toggleTheDetails(summary: HTMLElement): void {
	const details = summary[kParent]! as HTMLDetailsElement;
	details.toggleAttribute("open", !details.hasAttribute("open"));
}

function activateButton(button: HTMLButtonElement, event: Event): void {
	if (isActuallyDisabled(button)) {
		return;
	}
	const form = getFormOwner(button);
	if (form !== null) {
		if (button.type === "submit") {
			submitForm(form, button, false);
		} else if (button.type === "reset") {
			form.reset();
		}
	}
	popoverTargetActivationBehavior(button, event.target);
}

function activateInput(input: HTMLInputElement, event: Event): void {
	if (isActuallyDisabled(input)) {
		return;
	}
	const type = input.type;
	if (type === "checkbox" || type === "radio") {
		// A control outside a document reports nothing. The checkedness the
		// legacy-pre-activation behavior already flipped stays, and the events
		// that would announce it are not fired.
		if (!input.isConnected) {
			return;
		}
		dispatch(input, new Event("input", {bubbles: true, composed: true}));
		dispatch(input, new Event("change", {bubbles: true}));
		return;
	}
	const form = getFormOwner(input);
	if (form !== null) {
		if (type === "submit" || type === "image") {
			submitForm(form, input, false);
		} else if (type === "reset") {
			form.reset();
		}
	}
	popoverTargetActivationBehavior(input, event.target);
}

const kClickInProgress = Symbol("click in progress");

// A click on a label is a click on its control, unless the click
// originated inside that control.
function activateLabel(label: HTMLLabelElement, event: Event): void {
	const control = label.control;
	if (control === null) {
		return;
	}
	for (const target of event.composedPath()) {
		if (target === control) {
			return;
		}
	}
	if (control[kClickInProgress]!) {
		return;
	}
	control.click();
}

// The event's target is the nearest target at or before this struct, so
// a listener on an ancestor sees the node the event was dispatched at.
function invokeListeners(
	event: Event,
	index: number,
	capturing: boolean,
): void {
	const state = event[kState]!;
	const struct = state.path[index];
	for (let i = index; i >= 0; i--) {
		const adjusted = state.path[i].shadowAdjustedTarget;
		if (adjusted !== null) {
			state.target = adjusted;
			break;
		}
	}
	state.relatedTarget = struct.relatedTarget;
	if (state.stopPropagation) {
		return;
	}
	state.currentTarget = struct.invocationTarget;
	const listeners = struct.invocationTarget[kListeners]!.slice();
	const found = innerInvoke(event, listeners, capturing);
	if (!found && state.trusted) {
		const legacyType = LEGACY_EVENT_TYPES.get(event.type);
		if (legacyType !== undefined) {
			const originalType = event.type;
			setEventType(event, legacyType);
			innerInvoke(event, listeners, capturing);
			setEventType(event, originalType);
		}
	}
}

// Returns whether anything was listening for this type at all. If a
// target had no listener, a trusted event is dispatched to it again under
// its legacy type.
function innerInvoke(
	event: Event,
	listeners: Listener[],
	capturing: boolean,
): boolean {
	const state = event[kState]!;
	let found = false;
	for (const listener of listeners) {
		if (listener.removed) {
			continue;
		}
		if (listener.type !== event.type) {
			continue;
		}
		found = true;
		if (capturing && !listener.capture) {
			continue;
		}
		if (!capturing && listener.capture) {
			continue;
		}
		if (listener.once) {
			const target = state.currentTarget as EventTarget;
			removeListener(target[kListeners]!, listener);
		}
		if (listener.passive) {
			state.inPassiveListener = true;
		}
		try {
			callListener(listener.callback, state.currentTarget, event);
		} catch (error) {
			reportError(error);
		}
		if (state.foreign) {
			syncForeignFlags(event, state);
		}
		state.inPassiveListener = false;
		if (state.stopImmediate) {
			break;
		}
	}
	return found;
}

// For an object callback, handleEvent is looked up at call time.
function callListener(
	callback: EventListenerOrEventListenerObject,
	thisArg: EventTarget | null,
	event: Event,
): void {
	if (typeof callback === "function") {
		callback.call(thisArg, event);
		return;
	}
	const handleEvent = (callback as {handleEvent?: unknown}).handleEvent;
	if (typeof handleEvent !== "function") {
		throw new TypeError("An event listener object needs a handleEvent method");
	}
	(handleEvent as (event: Event) => void).call(callback, event);
}

function reportError(error: unknown): void {
	const report = (globalThis as {reportError?: (e: unknown) => void})
		.reportError;
	if (report) {
		report(error);
	} else {
		console.error(error);
	}
}

const kSync = Symbol("resynchronize own properties");
const kChildrenChangedSteps = Symbol("children changed steps");
const kAttributeSync = Symbol("resynchronize after an attribute change");

interface LiveCollection {
	[kSync]?(): void;
	[kChildrenChangedSteps]?(
		point: Node,
		changed: readonly Node[] | null,
		added: boolean,
	): void;
	[kAttributeSync]?(element: Element, localName: string): void;
}

const kDocumentWideLists = Symbol("live collections over a whole document");

// A collection's indexed and named properties are own properties rather
// than proxy traps, so they are observable without reading the
// collection. So once a collection has been read, every relevant change
// must notify it, and each collection updates as cheaply as it can. A
// collection listing what one node contains registers on that node under
// kLiveLists. A collection whose members can be anywhere in the document
// (a form's controls, for example) registers on the document under
// kDocumentWideLists.
const kLiveLists = Symbol("live collections this node is the root of");

// A collection stays registered for its owner's lifetime, so this only
// grows. A change in a document that never registered a collection skips
// the ancestor climb.
const heldListDocuments = new WeakSet<Document>();

function registerLiveCollection(collection: LiveCollection, owner: Node): void {
	heldListDocuments.add(owner[kDocument]!);
	const held = owner[kLiveLists]!;
	if (held === null) {
		owner[kLiveLists] = new Set([collection]);
	} else {
		held.add(collection);
	}
}

function registerDocumentWide(
	collection: LiveCollection,
	document: Document,
): void {
	const held = document[kDocumentWideLists]!;
	if (held === null) {
		document[kDocumentWideLists] = new Set([collection]);
	} else {
		held.add(collection);
	}
}

// Stored as a flag because it is checked constantly and computing it
// means a climb that is memory-bound on a deep tree. Insertion sets it
// over the inserted subtree, removal clears it, and a move never changes
// it.
const kConnected = Symbol("connected");

// Stored for the same reason as the flag above. Insertion and removal
// already walk the subtree, and they update this as they go.
const kTreeRoot = Symbol("tree root");

// Walking the change's inclusive ancestors reaches exactly the
// collections whose node contains the change. That keeps the document's
// collections out of trees the document composes but does not contain (a
// subtree under construction, a shadow tree, a pseudo-element's source)
// and makes a discarded tree cost nothing.
//
// `changed` is the nodes `point` gained or lost, empty when nothing
// moved. Null means only that something moved, and every collection
// reached recomputes. A collection given the nodes inspects them instead
// of walking the tree again. A document-wide collection is reached through
// the document of the change's point, because a tree under construction
// outside the document can still contain its members.
function runChildrenChangedSteps(
	point: Node,
	changed: readonly Node[] | null,
	added: boolean,
): void {
	if (heldListDocuments.has(point[kDocument]!)) {
		for (let node: Node | null = point; node !== null; node = node[kParent]!) {
			const held = node[kLiveLists]!;
			if (held === null) {
				continue;
			}
			for (const collection of held) {
				childrenChangedMethod.call(collection, point, changed, added);
			}
		}
	}
	const wide = point[kDocument]![kDocumentWideLists]!;
	if (wide !== null) {
		for (const collection of wide) {
			childrenChangedMethod.call(collection, point, changed, added);
		}
	}
}

const kClassList = Symbol("classList");
const kAttributesMap = Symbol("attributes");
const kTokenLists = Symbol("reflected token lists");

// An attribute is an input to three kinds of collection: the element's
// attribute map, the token lists over its attributes, and the collections
// registered over the trees it sits in. The last kind is asked about the
// one element instead of being walked.
function syncAttributeCollections(element: Element, localName: string): void {
	const map = element[kAttributesMap]!;
	if (map !== null) {
		syncMethod.call(map);
	}
	const classList = element[kClassList]!;
	if (classList !== null) {
		syncMethod.call(classList);
	}
	const lists = element[kTokenLists]!;
	if (lists !== null) {
		for (const list of lists.values()) {
			syncMethod.call(list);
		}
	}
	if (heldListDocuments.has(element[kDocument]!)) {
		for (let node: Node | null = element;
			node !== null;
			node = node[kParent]!) {
			const held = node[kLiveLists]!;
			if (held === null) {
				continue;
			}
			for (const collection of held) {
				collection[kAttributeSync]!(element, localName);
			}
		}
	}
	const wide = element[kDocument]![kDocumentWideLists]!;
	if (wide !== null) {
		for (const collection of wide) {
			collection[kAttributeSync]!(element, localName);
		}
	}
}

const ELEMENT_NODE = 1;
const ATTRIBUTE_NODE = 2;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const ENTITY_REFERENCE_NODE = 5;
const ENTITY_NODE = 6;
const PROCESSING_INSTRUCTION_NODE = 7;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;
const DOCUMENT_TYPE_NODE = 10;
const DOCUMENT_FRAGMENT_NODE = 11;
const NOTATION_NODE = 12;

const DOCUMENT_POSITION_DISCONNECTED = 0x01;
const DOCUMENT_POSITION_PRECEDING = 0x02;
const DOCUMENT_POSITION_FOLLOWING = 0x04;
const DOCUMENT_POSITION_CONTAINS = 0x08;
const DOCUMENT_POSITION_CONTAINED_BY = 0x10;
const DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = 0x20;

/** A stable per-node serial, so disconnected nodes order consistently. */
let nodeSerial = 0;
const kSerial = Symbol("node serial");

const kInsertionSteps = Symbol("insertion steps");
const kRemovingSteps = Symbol("removing steps");
const kAdoptingSteps = Symbol("adopting steps");
const kCloningSteps = Symbol("cloning steps");
const kCloneSingle = Symbol("clone a single node");
const kLastChild = Symbol("last child");
const kPrevious = Symbol("previous sibling link");
const kChildNodes = Symbol("childNodes");
const kRegisteredObservers = Symbol("registered observer list");
const kRegistry = Symbol("custom element registry");
const kAttributeList = Symbol("attribute list");
const kDocumentURL = Symbol("document URL");

export class Node extends EventTarget implements globalThis.Node {
	static readonly ELEMENT_NODE = ELEMENT_NODE;
	static readonly ATTRIBUTE_NODE = ATTRIBUTE_NODE;
	static readonly TEXT_NODE = TEXT_NODE;
	static readonly CDATA_SECTION_NODE = CDATA_SECTION_NODE;
	static readonly ENTITY_REFERENCE_NODE = ENTITY_REFERENCE_NODE;
	static readonly ENTITY_NODE = ENTITY_NODE;
	static readonly PROCESSING_INSTRUCTION_NODE = PROCESSING_INSTRUCTION_NODE;
	static readonly COMMENT_NODE = COMMENT_NODE;
	static readonly DOCUMENT_NODE = DOCUMENT_NODE;
	static readonly DOCUMENT_TYPE_NODE = DOCUMENT_TYPE_NODE;
	static readonly DOCUMENT_FRAGMENT_NODE = DOCUMENT_FRAGMENT_NODE;
	static readonly NOTATION_NODE = NOTATION_NODE;
	static readonly DOCUMENT_POSITION_DISCONNECTED =
		DOCUMENT_POSITION_DISCONNECTED;

	static readonly DOCUMENT_POSITION_PRECEDING = DOCUMENT_POSITION_PRECEDING;
	static readonly DOCUMENT_POSITION_FOLLOWING = DOCUMENT_POSITION_FOLLOWING;
	static readonly DOCUMENT_POSITION_CONTAINS = DOCUMENT_POSITION_CONTAINS;
	static readonly DOCUMENT_POSITION_CONTAINED_BY =
		DOCUMENT_POSITION_CONTAINED_BY;

	static readonly DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC =
		DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC;

	[kRegistry]?: CustomElementRegistry | null;
	[kParent]?: Node | null;
	[kConnected]?: boolean;
	[kTreeRoot]?: Node;
	[kFirstChild]?: Node | null;
	[kLastChild]?: Node | null;
	[kPrevious]?: Node | null;
	[kNext]?: Node | null;
	[kDocument]?: Document;
	[kChildNodes]?: NodeList | null;
	[kLiveLists]?: Set<LiveCollection> | null;
	[kSerial]?: number;
	[kRegisteredObservers]?: RegisteredObserver[] | null;

	constructor() {
		super();
		this[kRegistry] = null;
		this[kParent] = null;
		this[kConnected] = false;
		this[kTreeRoot] = this;
		this[kFirstChild] = null;
		this[kLastChild] = null;
		this[kPrevious] = null;
		this[kNext] = null;
		this[kChildNodes] = null;
		this[kLiveLists] = null;
		this[kSerial] = ++nodeSerial;
		this[kRegisteredObservers] = null;
		if (new.target === Node) {
			throw new TypeError("Illegal constructor");
		}
		// A Document is its own node document. Every other node gets one from
		// the algorithm that creates it.
		this[kDocument] = this as unknown as Document;
	}

	get nodeType(): number {
		return 0;
	}

	get nodeName(): string {
		return "";
	}

	get baseURI(): string {
		return this[kDocument]![kDocumentURL]!;
	}

	get isConnected(): boolean {
		return this[kConnected]!;
	}

	get ownerDocument(): Document | null {
		return this.nodeType === DOCUMENT_NODE
			? null
			: (this[kDocument]! as Document);
	}

	/** lib.dom types this as ParentNode, the mixin a parent carries. */
	get parentNode(): globalThis.ParentNode | null {
		return this[kParent]! as unknown as globalThis.ParentNode | null;
	}

	// lib.dom types this as HTMLElement where the spec says Element. An SVG
	// or MathML parent is not an HTMLElement. Every browser's types have the
	// same problem, and this follows them rather than being right alone.
	get parentElement(): globalThis.HTMLElement | null {
		const parent = this[kParent]!;
		return parent !== null && parent.nodeType === ELEMENT_NODE
			? (parent as unknown as globalThis.HTMLElement)
			: null;
	}

	get childNodes(): NodeListOf<globalThis.ChildNode> {
		let list = this[kChildNodes]!;
		if (list === null) {
			list = createChildNodeList(this);
			this[kChildNodes] = list;
		}
		return list as unknown as NodeListOf<globalThis.ChildNode>;
	}

	get firstChild(): globalThis.ChildNode | null {
		return this[kFirstChild]! as unknown as globalThis.ChildNode | null;
	}

	get lastChild(): globalThis.ChildNode | null {
		return this[kLastChild]! as unknown as globalThis.ChildNode | null;
	}

	get previousSibling(): globalThis.ChildNode | null {
		return this[kPrevious]! as unknown as globalThis.ChildNode | null;
	}

	get nextSibling(): globalThis.ChildNode | null {
		return this[kNext]! as unknown as globalThis.ChildNode | null;
	}

	get nodeValue(): string | null {
		return null;
	}

	set nodeValue(_value: string | null) {
		// Overridden where a node has a value.
	}

	get textContent(): string | null {
		return null;
	}

	set textContent(_value: string | null) {
		// Overridden where a node has text content.
	}

	getRootNode(options?: globalThis.GetRootNodeOptions): globalThis.Node {
		const init = toDictionary<{composed?: boolean}>(
			options ?? {},
			"A GetRootNodeOptions",
		);
		return (
			init.composed ? getShadowIncludingRoot(this) : getRoot(this)
		) as unknown as globalThis.Node;
	}

	hasChildNodes(): boolean {
		return this[kFirstChild] !== null;
	}

	normalize(): void {
		const texts: Text[] = [];
		for (
			let node: Node | null = this[kFirstChild]!;
			node !== null;
			node = nextInTree(node, this)
		) {
			if (node.nodeType === TEXT_NODE) {
				texts.push(node as Text);
			}
		}
		for (const text of texts) {
			if (text[kParent] === null) {
				continue;
			}
			if ((text as CharacterData)[kData]!.length === 0) {
				removeNode(text);
				continue;
			}
			let length = (text as CharacterData)[kData]!.length;
			let data = "";
			let sibling = text[kNext]!;
			while (sibling !== null && isExclusiveText(sibling)) {
				data += (sibling as CharacterData)[kData]!;
				sibling = sibling[kNext]!;
			}
			if (data !== "") {
				replaceData(text as CharacterData, length, 0, data);
			}
			let current = text[kNext]!;
			while (current !== null && isExclusiveText(current)) {
				liveRangeNormalizeSteps(text, current as Text, length);
				length += (current as CharacterData)[kData]!.length;
				current = current[kNext]!;
			}
			current = text[kNext]!;
			while (current !== null && isExclusiveText(current)) {
				const next = current[kNext]!;
				removeNode(current);
				current = next;
			}
		}
	}

	cloneNode(deep = false): globalThis.Node {
		if (isShadowRoot(this)) {
			throw domError("NotSupportedError", "A shadow root cannot be cloned");
		}
		return cloneNode(
			this,
			undefined,
			Boolean(deep),
		) as unknown as globalThis.Node;
	}

	isEqualNode(otherNode: globalThis.Node | null): boolean {
		return otherNode != null && equalNodes(this, otherNode as unknown as Node);
	}

	isSameNode(otherNode: globalThis.Node | null): boolean {
		return (this as unknown as globalThis.Node) === otherNode;
	}

	compareDocumentPosition(other: globalThis.Node): number {
		if ((this as unknown as globalThis.Node) === other) {
			return 0;
		}
		let node1: Node | null = other as unknown as Node;
		let node2: Node | null = this;
		let attr1: Attr | null = null;
		let attr2: Attr | null = null;
		if (node1.nodeType === ATTRIBUTE_NODE) {
			attr1 = node1 as Attr;
			node1 = attr1.ownerElement;
		}
		if (node2.nodeType === ATTRIBUTE_NODE) {
			attr2 = node2 as Attr;
			node2 = attr2.ownerElement;
			if (attr1 !== null && node1 !== null && node1 === node2) {
				for (const attr of (node2 as Element)[kAttributeList]!) {
					if (attr === attr1) {
						return (
							DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC +
							DOCUMENT_POSITION_PRECEDING
						);
					}
					if (attr === attr2) {
						return (
							DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC +
							DOCUMENT_POSITION_FOLLOWING
						);
					}
				}
			}
		}
		if (node1 === null || node2 === null || getRoot(node1) !== getRoot(node2)) {
			const first =
				node1 === null || node2 === null
					? this[kSerial]! < (other as unknown as Node)[kSerial]!
					: getRoot(node2)[kSerial]! < getRoot(node1)[kSerial]!;
			return (
				DOCUMENT_POSITION_DISCONNECTED +
				DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC +
				(first ? DOCUMENT_POSITION_FOLLOWING : DOCUMENT_POSITION_PRECEDING)
			);
		}
		if (
			(isInclusiveAncestor(node1, node2) && attr1 === null) ||
			(node1 === node2 && attr2 !== null)
		) {
			return DOCUMENT_POSITION_CONTAINS + DOCUMENT_POSITION_PRECEDING;
		}
		if (
			(isInclusiveAncestor(node2, node1) && attr2 === null) ||
			(node1 === node2 && attr1 !== null)
		) {
			return DOCUMENT_POSITION_CONTAINED_BY + DOCUMENT_POSITION_FOLLOWING;
		}
		return isPrecedingInTree(node1, node2)
			? DOCUMENT_POSITION_PRECEDING
			: DOCUMENT_POSITION_FOLLOWING;
	}

	contains(other: globalThis.Node | null): boolean {
		return (
			other != null && isInclusiveAncestor(this, other as unknown as Node)
		);
	}

	lookupPrefix(namespace: string | null): string | null {
		if (namespace == null || namespace === "") {
			return null;
		}
		switch (this.nodeType) {
			case ELEMENT_NODE:
				return locateNamespacePrefix(this as unknown as Element, namespace);
			case DOCUMENT_NODE: {
				const element =
					(this as unknown as Document).documentElement as unknown as Element |
					null;
				return element === null
					? null
					: locateNamespacePrefix(element, namespace);
			}
			case DOCUMENT_TYPE_NODE:
			case DOCUMENT_FRAGMENT_NODE:
				return null;
			case ATTRIBUTE_NODE: {
				const owner = (this as unknown as Attr).ownerElement;
				return owner === null ? null : locateNamespacePrefix(owner, namespace);
			}
			default: {
				const parent = this.parentElement;
				return parent === null
					? null
					: locateNamespacePrefix(parent as unknown as Element, namespace);
			}
		}
	}

	lookupNamespaceURI(prefix: string | null): string | null {
		const name = prefix == null || prefix === "" ? null : String(prefix);
		return locateNamespace(this, name);
	}

	isDefaultNamespace(namespace: string | null): boolean {
		const ns = namespace === "" ? null : namespace;
		return locateNamespace(this, null) === ns;
	}

	insertBefore<T extends globalThis.Node>(
		node: T,
		child: globalThis.Node | null,
	): T {
		if (arguments.length < 2) {
			throw new TypeError("insertBefore needs a node and a child");
		}
		return preInsert(
			node as unknown as Node,
			this,
			child as unknown as Node | null,
		) as unknown as T;
	}

	appendChild<T extends globalThis.Node>(node: T): T {
		if (arguments.length < 1) {
			throw new TypeError("appendChild needs a node");
		}
		return preInsert(node as unknown as Node, this, null) as unknown as T;
	}

	replaceChild<T extends globalThis.Node>(node: globalThis.Node, child: T): T {
		if (arguments.length < 2) {
			throw new TypeError("replaceChild needs a node and a child");
		}
		return replaceChild(
			child as unknown as Node,
			node as unknown as Node,
			this,
		) as unknown as T;
	}

	removeChild<T extends globalThis.Node>(child: T): T {
		if (arguments.length < 1) {
			throw new TypeError("removeChild needs a child");
		}
		return preRemove(child as unknown as Node, this) as unknown as T;
	}

	// An assigned slottable overrides this to return its slot, where the
	// composed tree continues.
	override [kGetTheParent]?(_event: Event): EventTarget | null {
		return this[kParent]!;
	}

	// The spec's per-node steps. Subclasses override them; the algorithms
	// call them.

	[kInsertionSteps]?(): void {}

	[kRemovingSteps]?(_oldParent: Node): void {}

	[kAdoptingSteps]?(_oldDocument: Document): void {}

	[kCloningSteps]?(_copy: Node, _document: Document, _deep: boolean): void {}

	[kCloneSingle]?(_document: Document): Node {
		throw domError("NotSupportedError", "That node cannot be cloned");
	}
}

/** The node-type constants, installed on the prototype below. */
export interface Node extends Pick<globalThis.Node, NodeConstants> {}

for (const [name, value] of [
	["ELEMENT_NODE", ELEMENT_NODE],
	["ATTRIBUTE_NODE", ATTRIBUTE_NODE],
	["TEXT_NODE", TEXT_NODE],
	["CDATA_SECTION_NODE", CDATA_SECTION_NODE],
	["ENTITY_REFERENCE_NODE", ENTITY_REFERENCE_NODE],
	["ENTITY_NODE", ENTITY_NODE],
	["PROCESSING_INSTRUCTION_NODE", PROCESSING_INSTRUCTION_NODE],
	["COMMENT_NODE", COMMENT_NODE],
	["DOCUMENT_NODE", DOCUMENT_NODE],
	["DOCUMENT_TYPE_NODE", DOCUMENT_TYPE_NODE],
	["DOCUMENT_FRAGMENT_NODE", DOCUMENT_FRAGMENT_NODE],
	["NOTATION_NODE", NOTATION_NODE],
	["DOCUMENT_POSITION_DISCONNECTED", DOCUMENT_POSITION_DISCONNECTED],
	["DOCUMENT_POSITION_PRECEDING", DOCUMENT_POSITION_PRECEDING],
	["DOCUMENT_POSITION_FOLLOWING", DOCUMENT_POSITION_FOLLOWING],
	["DOCUMENT_POSITION_CONTAINS", DOCUMENT_POSITION_CONTAINS],
	["DOCUMENT_POSITION_CONTAINED_BY", DOCUMENT_POSITION_CONTAINED_BY],
	[
		"DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC",
		DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC,
	],
] as Array<[string, number]>) {
	Object.defineProperty(Node.prototype, name, {value, enumerable: true});
}

Object.defineProperty(Node.prototype, Symbol.toStringTag, {
	value: "Node",
	configurable: true,
});

function getRoot(node: Node): Node {
	return node[kTreeRoot]!;
}

function isInclusiveAncestor(ancestor: Node, node: Node): boolean {
	let current: Node | null = node;
	while (current !== null) {
		if (current === ancestor) {
			return true;
		}
		current = current[kParent]!;
	}
	return false;
}

function isHostIncludingInclusiveAncestor(ancestor: Node, node: Node): boolean {
	let root = node;
	for (
		let current: Node | null = node;
		current !== null;
		current = current[kParent]!
	) {
		if (current === ancestor) {
			return true;
		}
		root = current;
	}
	if (root.nodeType === DOCUMENT_FRAGMENT_NODE) {
		const host = (root as DocumentFragment)[kHost]!;
		if (host != null) {
			return isHostIncludingInclusiveAncestor(ancestor, host);
		}
	}
	return false;
}

const kShadowRoot = Symbol("shadow root");

// A node with no children and no hosted tree is an ancestor of nothing,
// so the climb that would prove it is skipped.
function canBeAncestor(node: Node): boolean {
	return (
		node[kFirstChild] !== null ||
		(node.nodeType === ELEMENT_NODE &&
			((node as Element)[kShadowRoot] !== null ||
				node instanceof HTMLTemplateElement))
	);
}

function getShadowIncludingRoot(node: Node): Node {
	const root = getRoot(node);
	return isShadowRoot(root)
		? getShadowIncludingRoot((root as ShadowRoot)[kHost]! as Element)
		: root;
}

function isShadowIncludingInclusiveAncestor(
	ancestor: Node,
	node: Node,
): boolean {
	if (isInclusiveAncestor(ancestor, node)) {
		return true;
	}
	const root = getRoot(node);
	if (isShadowRoot(root)) {
		return isShadowIncludingInclusiveAncestor(
			ancestor,
			(root as ShadowRoot)[kHost]! as Element,
		);
	}
	return false;
}

// Shadow-including tree order: the node, then its shadow root's tree,
// then its children's.
function* shadowIncludingInclusiveDescendants(node: Node): Generator<Node> {
	yield node;
	if (node.nodeType === ELEMENT_NODE) {
		const shadow = (node as Element)[kShadowRoot]!;
		if (shadow !== null) {
			yield* shadowIncludingInclusiveDescendants(shadow);
		}
	}
	for (let child = node[kFirstChild]!; child !== null; child = child[kNext]!) {
		yield* shadowIncludingInclusiveDescendants(child);
	}
}

/** The next node in tree order, or null once the walk leaves the root. */
function nextInTree(node: Node, root: Node): Node | null {
	if (node[kFirstChild] !== null) {
		return node[kFirstChild]!;
	}
	let current: Node | null = node;
	while (current !== null && current !== root) {
		if (current[kNext] !== null) {
			return current[kNext]!;
		}
		current = current[kParent]!;
	}
	return null;
}

function* inclusiveDescendants(node: Node): Generator<Node> {
	let current: Node | null = node;
	while (current !== null) {
		yield current;
		current = nextInTree(current, node);
	}
}

function* descendants(node: Node): Generator<Node> {
	let current: Node | null = node[kFirstChild]!;
	while (current !== null) {
		yield current;
		current = nextInTree(current, node);
	}
}

/** Whether node1 precedes node2 in tree order. Both must share a root. */
function isPrecedingInTree(node1: Node, node2: Node): boolean {
	const root = getRoot(node1);
	for (const node of inclusiveDescendants(root)) {
		if (node === node1) {
			return true;
		}
		if (node === node2) {
			return false;
		}
	}
	return false;
}

function isExclusiveText(node: Node): boolean {
	return node.nodeType === TEXT_NODE;
}

function isCharacterData(node: Node): boolean {
	const type = node.nodeType;
	return (
		type === TEXT_NODE ||
		type === CDATA_SECTION_NODE ||
		type === COMMENT_NODE ||
		type === PROCESSING_INSTRUCTION_NODE
	);
}

function countChildren(parent: Node, type: number): number {
	let count = 0;
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType === type) {
			count++;
		}
	}
	return count;
}

function hasFollowing(child: Node | null, type: number): boolean {
	for (let node = child; node !== null; node = node[kNext]!) {
		if (node.nodeType === type) {
			return true;
		}
	}
	return false;
}

function hasPreceding(child: Node | null, type: number): boolean {
	if (child === null) {
		return false;
	}
	for (let node = child[kPrevious]!; node !== null; node = node[kPrevious]!) {
		if (node.nodeType === type) {
			return true;
		}
	}
	return false;
}

// Steps 1-5 of both "ensure pre-insertion validity" and "replace" (DOM
// §4.2.3), which the standard writes out twice. They diverge at step 6,
// where a document's one-element rule counts the replaced child
// differently. `absentChild` is the one error message the two do not
// share.
function validateInsertion(
	node: Node,
	parent: Node,
	child: Node | null,
	absentChild: string,
): void {
	const parentType = parent.nodeType;
	if (
		parentType !== DOCUMENT_NODE &&
		parentType !== DOCUMENT_FRAGMENT_NODE &&
		parentType !== ELEMENT_NODE
	) {
		throw hierarchyRequestError("That parent cannot have children");
	}
	if (
		canBeAncestor(node)
			? isHostIncludingInclusiveAncestor(node, parent)
			: node === parent
	) {
		throw hierarchyRequestError("A node cannot be inserted into itself");
	}
	if (child !== null && child[kParent] !== parent) {
		throw notFoundError(absentChild);
	}
	const type = node.nodeType;
	if (
		type !== DOCUMENT_FRAGMENT_NODE &&
		type !== DOCUMENT_TYPE_NODE &&
		type !== ELEMENT_NODE &&
		!isCharacterData(node)
	) {
		throw hierarchyRequestError("That node cannot be inserted");
	}
	if (
		(type === TEXT_NODE && parentType === DOCUMENT_NODE) ||
		(type === DOCUMENT_TYPE_NODE && parentType !== DOCUMENT_NODE)
	) {
		throw hierarchyRequestError("That node cannot go there");
	}
}

function ensurePreInsertionValidity(
	node: Node,
	parent: Node,
	child: Node | null,
	replacingAll = false,
): void {
	validateInsertion(
		node,
		parent,
		child,
		"The reference child is not a child of that parent",
	);
	const parentType = parent.nodeType;
	const type = node.nodeType;
	if (parentType !== DOCUMENT_NODE) {
		return;
	}
	const elements = replacingAll ? 0 : countChildren(parent, ELEMENT_NODE);
	const doctypes = replacingAll ? 0 : countChildren(parent, DOCUMENT_TYPE_NODE);
	if (type === DOCUMENT_FRAGMENT_NODE) {
		const elementCount = countChildren(node, ELEMENT_NODE);
		if (elementCount > 1 || countChildren(node, TEXT_NODE) > 0) {
			throw hierarchyRequestError("That fragment cannot go in a document");
		}
		if (
			elementCount === 1 &&
			(elements > 0 ||
				(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
				hasFollowing(child, DOCUMENT_TYPE_NODE))
		) {
			throw hierarchyRequestError("A document can have one element child");
		}
	} else if (type === ELEMENT_NODE) {
		if (
			elements > 0 ||
			(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
			hasFollowing(child, DOCUMENT_TYPE_NODE)
		) {
			throw hierarchyRequestError("A document can have one element child");
		}
	} else if (type === DOCUMENT_TYPE_NODE) {
		if (
			doctypes > 0 ||
			(child !== null && hasPreceding(child, ELEMENT_NODE)) ||
			(child === null && elements > 0)
		) {
			throw hierarchyRequestError("A document can have one doctype child");
		}
	}
}

function preInsert(node: Node, parent: Node, child: Node | null): Node {
	if (!(node instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	if (child !== null && child !== undefined && !(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	const reference = child ?? null;
	ensurePreInsertionValidity(node, parent, reference);
	let referenceChild = reference;
	if (referenceChild === node) {
		referenceChild = node[kNext]!;
	}
	insertNode(node, parent, referenceChild, false);
	return node;
}

const kSlotAssignment = Symbol("slot assignment");
const kAssignedNodes = Symbol("assigned nodes");
const kCustomState = Symbol("custom element state");

const kAssignedSlot = Symbol("assigned slot");
const kDefinition = Symbol("element definition");

// Held the same way as the ranges below and re-homed by the same moves.
const nodeIteratorsByRoot = new WeakMap<Node, Set<NodeIterator>>();

// Leaves the tree as remove-then-insert would, but as one primitive: no
// removing or insertion steps run, no disconnected or connected callbacks
// fire, and everything the node carries (shadow trees, selection, focus,
// live ranges, iterators) moves with it. A custom element gets
// connectedMoveCallback instead, or the disconnected/connected pair if it
// declares no move callback.
function moveNode(node: Node, newParent: Node, child: Node | null): void {
	if (getShadowIncludingRoot(newParent) !== getShadowIncludingRoot(node)) {
		throw hierarchyRequestError(
			"A node can only move within the tree it is already in",
		);
	}
	if (isHostIncludingInclusiveAncestor(node, newParent)) {
		throw hierarchyRequestError("A node cannot be moved into itself");
	}
	if (child !== null && child[kParent] !== newParent) {
		throw notFoundError("The reference child is not a child of that parent");
	}
	if (node.nodeType !== ELEMENT_NODE && !isCharacterData(node)) {
		throw hierarchyRequestError("That node cannot be moved");
	}
	if (node.nodeType === TEXT_NODE && newParent.nodeType === DOCUMENT_NODE) {
		throw hierarchyRequestError("That node cannot go there");
	}
	if (
		newParent.nodeType === DOCUMENT_NODE &&
		node.nodeType === ELEMENT_NODE &&
		(countChildren(newParent, ELEMENT_NODE) > 0 ||
			(child !== null && child.nodeType === DOCUMENT_TYPE_NODE) ||
			hasFollowing(child, DOCUMENT_TYPE_NODE))
	) {
		throw hierarchyRequestError("A document can have one element child");
	}
	const oldParent = node[kParent]! as Node;
	liveRangePreRemoveSteps(node);
	const iterators = nodeIteratorsByRoot.get(getRoot(node));
	if (iterators !== undefined) {
		for (const iterator of iterators) {
			preRemoveFromIterator(iterator, node);
		}
	}
	const oldPreviousSibling = node[kPrevious]!;
	const oldNextSibling = node[kNext]!;
	unlinkChild(node);
	const assignedSlot = isSlottable(node)
		? (node as Slottable)[kAssignedSlot]!
		: null;
	if (assignedSlot !== null) {
		assignSlottables(assignedSlot);
	}
	if (
		isShadowRoot(getRoot(oldParent)) &&
		oldParent instanceof HTMLSlotElement &&
		oldParent[kAssignedNodes]!.length === 0
	) {
		signalASlotChange(oldParent);
	}
	if (hasInclusiveDescendantSlot(node)) {
		assignSlottablesForTree(getRoot(oldParent));
		assignSlottablesForTree(node);
	}
	if (child !== null) {
		liveRangeInsertSteps(newParent, child, 1);
	}
	const newPreviousSibling =
		child !== null ? child[kPrevious]! : newParent[kLastChild]!;
	linkChild(node, newParent, child);
	const shadow =
		newParent.nodeType === ELEMENT_NODE
			? (newParent as Element)[kShadowRoot]!
			: null;
	if (shadow !== null && shadow[kSlotAssignment] === "named") {
		if (isSlottable(node)) {
			assignASlot(node as Slottable);
		}
	}
	if (
		isShadowRoot(getRoot(newParent)) &&
		newParent instanceof HTMLSlotElement &&
		newParent[kAssignedNodes]!.length === 0
	) {
		signalASlotChange(newParent);
	}
	assignSlottablesForTree(getRoot(node));
	if (newParent.isConnected) {
		for (const descendant of shadowIncludingInclusiveDescendants(node)) {
			if (
				descendant.nodeType !== ELEMENT_NODE ||
				(descendant as Element)[kCustomState] !== "custom"
			) {
				continue;
			}
			const element = descendant as Element;
			const definition = element[kDefinition]!;
			if (definition?.lifecycleCallbacks.get("connectedMoveCallback")) {
				enqueueCallbackReaction(element, "connectedMoveCallback", []);
			} else {
				enqueueCallbackReaction(element, "disconnectedCallback", []);
				enqueueCallbackReaction(element, "connectedCallback", []);
			}
		}
	}
	runChildrenChangedSteps(oldParent, [node], false);
	runChildrenChangedSteps(newParent, [node], true);
	queueTreeMutationRecord(
		oldParent,
		[],
		[node],
		oldPreviousSibling,
		oldNextSibling,
	);
	queueTreeMutationRecord(newParent, [node], [], newPreviousSibling, child);
}

// Both boundaries always share one root, because the boundary setters
// collapse the other point on a root change, as the spec says. The root
// is held weakly, so an unreachable tree takes its ranges with it. The
// ranges are held strongly, which keeps garbage collection unobservable
// where a WeakRef would expose it.
const liveRangesByRoot = new WeakMap<Node, Set<Range>>();

function insertNode(
	node: Node,
	parent: Node,
	child: Node | null,
	suppressObservers: boolean,
): void {
	const nodes =
		node.nodeType === DOCUMENT_FRAGMENT_NODE ? getChildNodeArray(node) : [node];
	const count = nodes.length;
	if (count === 0) {
		return;
	}
	if (node.nodeType === DOCUMENT_FRAGMENT_NODE) {
		for (const child_ of nodes) {
			removeNode(child_, true);
		}
		queueTreeMutationRecord(node, [], nodes, null, null);
	}
	if (child !== null) {
		liveRangeInsertSteps(parent, child, count);
	}
	const previousSibling =
		child !== null ? child[kPrevious]! : parent[kLastChild]!;
	const document = parent[kDocument]!;
	const connected = parent[kConnected]!;
	for (const inserted of nodes) {
		// The inserted node was its own tree's root. Everything registered
		// under it now belongs to the tree it is joining.
		const carriedRanges = liveRangesByRoot.get(inserted);
		const carriedIterators = nodeIteratorsByRoot.get(inserted);
		if (carriedRanges !== undefined || carriedIterators !== undefined) {
			const newRoot = getRoot(parent);
			if (carriedRanges !== undefined && inserted !== newRoot) {
				liveRangesByRoot.delete(inserted);
				const set = liveRangesByRoot.get(newRoot);
				if (set === undefined) {
					liveRangesByRoot.set(newRoot, carriedRanges);
				} else {
					for (const range of carriedRanges) {
						set.add(range);
					}
				}
			}
			if (carriedIterators !== undefined && inserted !== newRoot) {
				nodeIteratorsByRoot.delete(inserted);
				for (const iterator of carriedIterators) {
					registerNodeIterator(newRoot, iterator);
				}
			}
		}
		adoptNode(inserted, document);
		linkChild(inserted, parent, child);
		// The inserted tree's root is now the parent's. The walk follows the
		// light tree only. A shadow tree under it keeps its own root.
		const treeRoot = parent[kTreeRoot]!;
		for (
			let joined: Node | null = inserted;
			joined !== null;
			joined = nextInTree(joined, inserted)
		) {
			joined[kTreeRoot] = treeRoot;
		}
		const shadow =
			parent.nodeType === ELEMENT_NODE
				? (parent as Element)[kShadowRoot]!
				: null;
		if (shadow !== null) {
			if (shadow[kSlotAssignment] === "named") {
				if (isSlottable(inserted)) {
					assignASlot(inserted as Slottable);
				}
			} else {
				// A manual assignment names nodes rather than finding them, and
				// only a node the host still has counts. So a change to the
				// host's child list is what makes an assignment appear or
				// disappear.
				assignSlottablesForTree(shadow);
			}
		}
		if (
			parent instanceof HTMLSlotElement &&
			parent[kAssignedNodes]!.length === 0 &&
			isShadowRoot(getRoot(parent))
		) {
			signalASlotChange(parent);
		}
		// A slot assigns the host's children, which this insertion did not
		// change unless it brought slots of its own into the tree. Those are
		// the only assignments in the root the insertion can have changed.
		if (hasInclusiveDescendantSlot(inserted)) {
			assignSlottablesForTree(getRoot(inserted));
		}
		for (const descendant of shadowIncludingInclusiveDescendants(inserted)) {
			descendant[kConnected] = connected;
			descendant[kInsertionSteps]!();
			if (!connected) {
				continue;
			}
			if (descendant.nodeType !== ELEMENT_NODE) {
				continue;
			}
			const element = descendant as Element;
			if (element[kCustomState] === "custom") {
				enqueueCallbackReaction(element, "connectedCallback", []);
			} else {
				tryToUpgrade(element);
			}
		}
	}
	runChildrenChangedSteps(parent, nodes, true);
	if (!suppressObservers) {
		queueTreeMutationRecord(parent, nodes, [], previousSibling, child);
	}
}

function linkChild(node: Node, parent: Node, before: Node | null): void {
	node[kParent] = parent;
	if (before === null) {
		const last = parent[kLastChild]!;
		node[kPrevious] = last;
		node[kNext] = null;
		if (last === null) {
			parent[kFirstChild] = node;
		} else {
			last[kNext] = node;
		}
		parent[kLastChild] = node;
	} else {
		const previous = before[kPrevious]!;
		node[kPrevious] = previous;
		node[kNext] = before;
		before[kPrevious] = node;
		if (previous === null) {
			parent[kFirstChild] = node;
		} else {
			previous[kNext] = node;
		}
	}
}

function unlinkChild(node: Node): void {
	const parent = node[kParent]! as Node;
	const previous = node[kPrevious]!;
	const next = node[kNext]!;
	if (previous === null) {
		parent[kFirstChild] = next;
	} else {
		previous[kNext] = next;
	}
	if (next === null) {
		parent[kLastChild] = previous;
	} else {
		next[kPrevious] = previous;
	}
	node[kParent] = null;
	node[kPrevious] = null;
	node[kNext] = null;
}

function getChildNodeArray(parent: Node): Node[] {
	const nodes: Node[] = [];
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		nodes.push(node);
	}
	return nodes;
}

function appendNode(node: Node, parent: Node): Node {
	return preInsert(node, parent, null);
}

function replaceChild(child: Node, node: Node, parent: Node): Node {
	if (!(node instanceof Node) || !(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	validateInsertion(
		node,
		parent,
		child,
		"The replaced child is not a child of that parent",
	);
	const parentType = parent.nodeType;
	const type = node.nodeType;
	if (parentType === DOCUMENT_NODE) {
		if (type === DOCUMENT_FRAGMENT_NODE) {
			const elementCount = countChildren(node, ELEMENT_NODE);
			if (elementCount > 1 || countChildren(node, TEXT_NODE) > 0) {
				throw hierarchyRequestError("That fragment cannot go in a document");
			}
			if (
				elementCount === 1 &&
				(hasOtherElementChild(parent, child) ||
					hasFollowing(child[kNext]!, DOCUMENT_TYPE_NODE))
			) {
				throw hierarchyRequestError("A document can have one element child");
			}
		} else if (type === ELEMENT_NODE) {
			if (
				hasOtherElementChild(parent, child) ||
				hasFollowing(child[kNext]!, DOCUMENT_TYPE_NODE)
			) {
				throw hierarchyRequestError("A document can have one element child");
			}
		} else if (type === DOCUMENT_TYPE_NODE) {
			if (
				hasOtherDoctypeChild(parent, child) ||
				hasPreceding(child, ELEMENT_NODE)
			) {
				throw hierarchyRequestError("A document can have one doctype child");
			}
		}
	}
	let referenceChild = child[kNext]!;
	if (referenceChild === node) {
		referenceChild = node[kNext]!;
	}
	const previousSibling = child[kPrevious]!;
	const removedNodes: Node[] = [];
	// Adopting removes the replacement from its current tree, which is a
	// removal of its own and is reported as one. It happens before the
	// replaced child is removed, so that removal reports the siblings an
	// observer saw before any of this began.
	adoptNode(node, parent[kDocument]!);
	if (child[kParent] !== null) {
		removedNodes.push(child);
		removeNode(child, true);
	}
	const nodes =
		node.nodeType === DOCUMENT_FRAGMENT_NODE ? getChildNodeArray(node) : [node];
	insertNode(node, parent, referenceChild, true);
	queueTreeMutationRecord(
		parent,
		nodes,
		removedNodes,
		previousSibling,
		referenceChild,
	);
	return child;
}

function hasOtherElementChild(parent: Node, exclude: Node): boolean {
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node !== exclude && node.nodeType === ELEMENT_NODE) {
			return true;
		}
	}
	return false;
}

function hasOtherDoctypeChild(parent: Node, exclude: Node): boolean {
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node !== exclude && node.nodeType === DOCUMENT_TYPE_NODE) {
			return true;
		}
	}
	return false;
}

function replaceAll(node: Node | null, parent: Node): void {
	const removedNodes = getChildNodeArray(parent);
	const addedNodes =
		node === null
			? []
			: node.nodeType === DOCUMENT_FRAGMENT_NODE
				? getChildNodeArray(node)
				: [node];
	for (const child of removedNodes) {
		removeNode(child, true);
	}
	if (node !== null) {
		insertNode(node, parent, null, true);
	}
	if (removedNodes.length > 0 || addedNodes.length > 0) {
		queueTreeMutationRecord(parent, addedNodes, removedNodes, null, null);
	}
}

function preRemove(child: Node, parent: Node): Node {
	if (!(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	if (child[kParent] !== parent) {
		throw notFoundError("The removed child is not a child of that parent");
	}
	removeNode(child);
	return child;
}

const kRoot = Symbol("root");

const kActiveElement = Symbol("focused area");

function removeNode(node: Node, suppressObservers = false): void {
	const parent = node[kParent]!;
	if (parent === null) {
		return;
	}
	liveRangePreRemoveSteps(node);
	const iterators = nodeIteratorsByRoot.get(getRoot(node));
	if (iterators !== undefined) {
		for (const iterator of iterators) {
			preRemoveFromIterator(iterator, node);
			// The removal makes `node` a root. An iterator rooted inside the
			// removed subtree now belongs to that new tree.
			if (isInclusiveAncestor(node, iterator[kRoot]!)) {
				iterators.delete(iterator);
				registerNodeIterator(node, iterator);
			}
		}
	}
	const oldPreviousSibling = node[kPrevious]!;
	const oldNextSibling = node[kNext]!;
	unlinkChild(node);
	for (
		let removed: Node | null = node;
		removed !== null;
		removed = nextInTree(removed, node)
	) {
		removed[kTreeRoot] = node;
	}
	const assignedSlot = isSlottable(node)
		? (node as Slottable)[kAssignedSlot]!
		: null;
	if (assignedSlot !== null) {
		assignSlottables(assignedSlot);
	}
	const hostShadow =
		parent.nodeType === ELEMENT_NODE ? (parent as Element)[kShadowRoot]! : null;
	if (hostShadow !== null && hostShadow[kSlotAssignment] === "manual") {
		assignSlottablesForTree(hostShadow);
	}
	if (
		isShadowRoot(getRoot(parent)) &&
		parent instanceof HTMLSlotElement &&
		parent[kAssignedNodes]!.length === 0
	) {
		signalASlotChange(parent);
	}
	if (hasInclusiveDescendantSlot(node)) {
		assignSlottablesForTree(getRoot(parent));
		assignSlottablesForTree(node);
	}
	// The focus fixup for a removal. Focus does not survive leaving the tree,
	// and no blur fires for an element that is already gone. The state resets
	// silently so the next focus() starts fresh.
	const document = node[kDocument]!;
	const active = document[kActiveElement]!;
	if (active !== null) {
		for (const descendant of shadowIncludingInclusiveDescendants(node)) {
			if (descendant === active) {
				document[kActiveElement] = null;
				break;
			}
		}
	}
	const parentWasConnected = parent[kConnected]!;
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
		descendant[kConnected] = false;
		descendant[kRemovingSteps]!(parent);
		if (
			parentWasConnected &&
			descendant.nodeType === ELEMENT_NODE &&
			(descendant as Element)[kCustomState] === "custom"
		) {
			enqueueCallbackReaction(
				descendant as Element,
				"disconnectedCallback",
				[],
			);
		}
	}
	runChildrenChangedSteps(parent, [node], false);
	addTransientObservers(node, parent);
	if (!suppressObservers) {
		queueTreeMutationRecord(
			parent,
			[],
			[node],
			oldPreviousSibling,
			oldNextSibling,
		);
	}
}

function adoptNode(node: Node, document: Document): void {
	const oldDocument = node[kDocument]!;
	if (node[kParent] !== null) {
		removeNode(node);
	}
	if (oldDocument === document) {
		return;
	}
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
		descendant[kDocument] = document;
		if (descendant.nodeType === ELEMENT_NODE) {
			for (const attr of (descendant as Element)[kAttributeList]!) {
				attr[kDocument] = document;
			}
		}
	}
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
		if (
			descendant.nodeType === ELEMENT_NODE &&
			(descendant as Element)[kCustomState] === "custom"
		) {
			enqueueCallbackReaction(descendant as Element, "adoptedCallback", [
				oldDocument,
				document,
			]);
		}
		descendant[kAdoptingSteps]!(oldDocument);
	}
}

interface MutationObserverInit {
	childList?: boolean;
	attributes?: boolean;
	characterData?: boolean;
	subtree?: boolean;
	attributeOldValue?: boolean;
	characterDataOldValue?: boolean;
	attributeFilter?: Iterable<string>;
}

type MutationCallback = (
	records: MutationRecord[],
	observer: MutationObserver,
) => void;

// attributes, characterData and their old-value members stay tri-state.
// A member never given is different from one given as false, and both the
// defaulting rules and the record filter depend on the difference.
interface ObserverOptions {
	childList: boolean;
	attributes: boolean | undefined;
	characterData: boolean | undefined;
	subtree: boolean;
	attributeOldValue: boolean | undefined;
	characterDataOldValue: boolean | undefined;
	attributeFilter: string[] | undefined;
}

// An entry with a source is transient. It was copied onto the node when
// the node was removed from a tree an observer was watching with subtree,
// so mutations inside the removed subtree still reach that observer until
// it is next notified.
interface RegisteredObserver {
	observer: MutationObserver;
	options: ObserverOptions;
	source: RegisteredObserver | null;
}

// While this is zero, the three queueing call sites return before
// walking any ancestors, so an unobserved tree pays nothing.
let registeredObserverCount = 0;

let mutationObserverMicrotaskQueued = false;

const pendingMutationObservers = new Set<MutationObserver>();

// Held until the observers that would report on them have been notified.
// The list turns over every checkpoint.
const transientNodes: Node[] = [];

function queueMutationObserverMicrotask(): void {
	if (mutationObserverMicrotaskQueued) {
		return;
	}
	mutationObserverMicrotaskQueued = true;
	queueMicrotask(notifyMutationObservers);
}

const kNodes = Symbol("nodes");

// Runs as a microtask, so a script sees the records for everything it
// did before yielding, in one callback per observer.
function notifyMutationObservers(): void {
	mutationObserverMicrotaskQueued = false;
	const notifySet = [...pendingMutationObservers];
	pendingMutationObservers.clear();
	const signalSet = signalSlots.splice(0, signalSlots.length);
	for (const observer of notifySet) {
		notifyObserver(observer);
	}
	// What remains carries transient registrations for observers this
	// checkpoint had nothing to deliver to. Those last until their observer
	// is next notified. A node whose observer is already queued again stays
	// here; the rest go back to their observer's own node list.
	let write = 0;
	for (const node of transientNodes) {
		const list = node[kRegisteredObservers]!;
		if (list === null) {
			continue;
		}
		let queued = false;
		for (const registered of list) {
			if (registered.source === null) {
				continue;
			}
			if (pendingMutationObservers.has(registered.observer)) {
				queued = true;
			} else {
				registered.observer[kNodes]!.add(node);
			}
		}
		if (queued) {
			transientNodes[write++] = node;
		}
	}
	transientNodes.length = write;
	for (const slot of signalSet) {
		const event = new Event("slotchange", {bubbles: true});
		dispatch(slot, event);
	}
}

function getRegisteredObserverList(node: Node): RegisteredObserver[] {
	let list = node[kRegisteredObservers]!;
	if (list === null) {
		list = [];
		node[kRegisteredObservers] = list;
	}
	return list;
}

// One transient entry per source is enough. Two with the same source
// would report the same mutation to the same observer, and the record
// queue collapses that anyway.
function addTransientObservers(node: Node, parent: Node): void {
	if (registeredObserverCount === 0) {
		return;
	}
	for (
		let ancestor: Node | null = parent;
		ancestor !== null;
		ancestor = ancestor[kParent]!
	) {
		const list = ancestor[kRegisteredObservers]!;
		if (list === null) {
			continue;
		}
		for (const registered of list) {
			if (registered.options.subtree !== true) {
				continue;
			}
			appendTransientObserver(node, registered);
		}
	}
}

function appendTransientObserver(node: Node, source: RegisteredObserver): void {
	const list = getRegisteredObserverList(node);
	for (const existing of list) {
		if (existing.source === source) {
			return;
		}
	}
	list.push({observer: source.observer, options: source.options, source});
	registeredObserverCount++;
	// The ancestor walk adds every source of one node consecutively, so the
	// node is already last here whenever it has more than one transient
	// entry.
	if (transientNodes[transientNodes.length - 1] !== node) {
		transientNodes.push(node);
	}
	queueMutationObserverMicrotask();
}

function removeTransientObservers(
	node: Node,
	matches: (registered: RegisteredObserver) => boolean,
): void {
	const list = node[kRegisteredObservers]!;
	if (list === null) {
		return;
	}
	for (let index = list.length - 1; index >= 0; index--) {
		const registered = list[index];
		if (registered.source === null || !matches(registered)) {
			continue;
		}
		list.splice(index, 1);
		registeredObserverCount--;
	}
}

const kAttributeName = Symbol("attributeName");
const kAttributeNamespace = Symbol("attributeNamespace");
const kOldValue = Symbol("oldValue");
const kAddedNodes = Symbol("addedNodes");
const kRemovedNodes = Symbol("removedNodes");
const kPreviousSibling = Symbol("previousSibling");
const kNextSibling = Symbol("nextSibling");
const kTarget = Symbol("processing instruction target");

class MutationRecord implements globalThis.MutationRecord {
	declare [kType]?: string;
	declare [kTarget]?: Node;
	declare [kAddedNodes]?: NodeList;
	declare [kRemovedNodes]?: NodeList;
	declare [kPreviousSibling]?: Node | null;
	declare [kNextSibling]?: Node | null;
	declare [kAttributeName]?: string | null;
	declare [kAttributeNamespace]?: string | null;
	declare [kOldValue]?: string | null;

	constructor(
		type: string,
		target: Node,
		attributeName: string | null,
		attributeNamespace: string | null,
		oldValue: string | null,
		addedNodes: Node[],
		removedNodes: Node[],
		previousSibling: Node | null,
		nextSibling: Node | null,
	) {
		this[kType] = type;
		this[kTarget] = target;
		this[kAttributeName] = attributeName;
		this[kAttributeNamespace] = attributeNamespace;
		this[kOldValue] = oldValue;
		this[kAddedNodes] = createStaticNodeList(addedNodes);
		this[kRemovedNodes] = createStaticNodeList(removedNodes);
		this[kPreviousSibling] = previousSibling;
		this[kNextSibling] = nextSibling;
	}

	get type(): globalThis.MutationRecordType {
		return this[kType]! as globalThis.MutationRecordType;
	}

	get target(): globalThis.Node {
		return this[kTarget]! as unknown as globalThis.Node;
	}

	get addedNodes(): globalThis.NodeList {
		return this[kAddedNodes]! as unknown as globalThis.NodeList;
	}

	get removedNodes(): globalThis.NodeList {
		return this[kRemovedNodes]! as unknown as globalThis.NodeList;
	}

	get previousSibling(): globalThis.Node | null {
		return this[kPreviousSibling]! as unknown as globalThis.Node | null;
	}

	get nextSibling(): globalThis.Node | null {
		return this[kNextSibling]! as unknown as globalThis.Node | null;
	}

	get attributeName(): string | null {
		return this[kAttributeName]!;
	}

	get attributeNamespace(): string | null {
		return this[kAttributeNamespace]!;
	}

	get oldValue(): string | null {
		return this[kOldValue]!;
	}
}

Object.defineProperty(MutationRecord.prototype, Symbol.toStringTag, {
	value: "MutationRecord",
	configurable: true,
});

/** Convert a sequence<DOMString> argument per Web IDL: anything iterable. */
function toStringSequence(value: Iterable<string>): string[] {
	if (
		value === null ||
		typeof value !== "object" ||
		typeof (value as {[Symbol.iterator]?: unknown})[Symbol.iterator] !==
		"function"
	) {
		throw new TypeError("That is not a sequence of strings");
	}
	return [...value].map((entry) => String(entry));
}

const kCallback = Symbol("callback");
const kRecords = Symbol("records");

/** Observes a tree and delivers mutation records. */
export class MutationObserver implements globalThis.MutationObserver {
	declare [kCallback]?: MutationCallback;

	// Held strongly. Each node's registered observer list holds this
	// observer too, and the cycle is collected once both sides are
	// unreachable.
	declare [kNodes]?: Set<Node>;
	declare [kRecords]?: MutationRecord[];

	constructor(callback: MutationCallback) {
		this[kNodes] = new Set();
		this[kRecords] = [];
		if (arguments.length < 1) {
			throw new TypeError("MutationObserver needs a callback");
		}
		if (typeof callback !== "function") {
			throw new TypeError("A MutationObserver callback must be a function");
		}
		this[kCallback] = callback;
	}

	observe(target: Node, options: MutationObserverInit = {}): void {
		if (arguments.length < 1) {
			throw new TypeError("observe needs a target");
		}
		if (!(target instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		const normalized = normalizeObserverOptions(options);
		const list = getRegisteredObserverList(target);
		for (const registered of list) {
			if (registered.observer !== this || registered.source !== null) {
				continue;
			}
			for (const node of [...this[kNodes]!, ...transientNodes]) {
				removeTransientObservers(node, (entry) => entry.source === registered);
			}
			registered.options = normalized;
			return;
		}
		list.push({observer: this, options: normalized, source: null});
		registeredObserverCount++;
		this[kNodes]!.add(target);
	}

	disconnect(): void {
		for (const node of [...this[kNodes]!, ...transientNodes]) {
			const list = node[kRegisteredObservers]!;
			if (list === null) {
				continue;
			}
			for (let index = list.length - 1; index >= 0; index--) {
				if (list[index].observer !== this) {
					continue;
				}
				list.splice(index, 1);
				registeredObserverCount--;
			}
		}
		this[kNodes]!.clear();
		this[kRecords]!.length = 0;
	}

	takeRecords(): MutationRecord[] {
		const records = this[kRecords]!;
		this[kRecords] = [];
		return records;
	}
}

// Asking for an old value or a filter implies observing that kind of
// mutation, so it turns that observation on. Asking for an old value of
// something explicitly not observed is a contradiction and throws.
function normalizeObserverOptions(
	options: MutationObserverInit,
): ObserverOptions {
	const init = toDictionary<MutationObserverInit>(options, "Observe options");
	const attributeFilter =
		init.attributeFilter === undefined
			? undefined
			: toStringSequence(init.attributeFilter);
	const attributeOldValue =
		init.attributeOldValue === undefined
			? undefined
			: Boolean(init.attributeOldValue);
	const characterDataOldValue =
		init.characterDataOldValue === undefined
			? undefined
			: Boolean(init.characterDataOldValue);
	let attributes =
		init.attributes === undefined ? undefined : Boolean(init.attributes);
	let characterData =
		init.characterData === undefined ? undefined : Boolean(init.characterData);
	const childList = Boolean(init.childList);
	if (
		(attributeOldValue !== undefined || attributeFilter !== undefined) &&
		attributes === undefined
	) {
		attributes = true;
	}
	if (characterDataOldValue !== undefined && characterData === undefined) {
		characterData = true;
	}
	if (!childList && attributes !== true && characterData !== true) {
		throw new TypeError("observe needs childList, attributes or characterData");
	}
	if (attributeOldValue === true && attributes === false) {
		throw new TypeError("attributeOldValue needs attributes");
	}
	if (attributeFilter !== undefined && attributes === false) {
		throw new TypeError("attributeFilter needs attributes");
	}
	if (characterDataOldValue === true && characterData === false) {
		throw new TypeError("characterDataOldValue needs characterData");
	}
	return {
		childList,
		attributes,
		characterData,
		subtree: Boolean(init.subtree),
		attributeOldValue,
		characterDataOldValue,
		attributeFilter,
	};
}

function notifyObserver(observer: MutationObserver): void {
	const records = observer[kRecords]!;
	observer[kRecords] = [];
	for (const node of [...observer[kNodes]!]) {
		removeTransientObservers(node, () => true);
	}
	for (const node of transientNodes) {
		removeTransientObservers(node, (entry) => entry.observer === observer);
	}
	if (records.length === 0) {
		return;
	}
	try {
		observer[kCallback]!.call(observer, records, observer);
	} catch (error) {
		reportError(error);
	}
}

Object.defineProperty(MutationObserver.prototype, Symbol.toStringTag, {
	value: "MutationObserver",
	configurable: true,
});

// A registration on the node itself always matches. One further up
// matches only if it was made with subtree. An observer that matches more
// than once still gets one record, with an old value if any matching
// registration asked for one.
function queueMutationRecord(
	type: string,
	target: Node,
	name: string | null,
	namespace: string | null,
	oldValue: string | null,
	addedNodes: Node[],
	removedNodes: Node[],
	previousSibling: Node | null,
	nextSibling: Node | null,
): void {
	if (registeredObserverCount === 0) {
		return;
	}
	let interested: Map<MutationObserver, string | null> | null = null;
	for (let node: Node | null = target; node !== null; node = node[kParent]!) {
		const list = node[kRegisteredObservers]!;
		if (list === null) {
			continue;
		}
		for (const registered of list) {
			const options = registered.options;
			if (node !== target && options.subtree !== true) {
				continue;
			}
			if (type === "attributes") {
				if (options.attributes !== true) {
					continue;
				}
				if (
					options.attributeFilter !== undefined &&
					(namespace !== null ||
						!options.attributeFilter.includes(name as string))
				) {
					continue;
				}
			} else if (type === "characterData") {
				if (options.characterData !== true) {
					continue;
				}
			} else if (!options.childList) {
				continue;
			}
			const observer = registered.observer;
			if (interested === null) {
				interested = new Map();
			}
			if (!interested.has(observer)) {
				interested.set(observer, null);
			}
			if (
				(type === "attributes" && options.attributeOldValue === true) ||
				(type === "characterData" && options.characterDataOldValue === true)
			) {
				interested.set(observer, oldValue);
			}
		}
	}
	if (interested === null) {
		return;
	}
	for (const [observer, mappedOldValue] of interested) {
		observer[kRecords]!.push(
			new MutationRecord(
				type,
				target,
				name,
				namespace,
				mappedOldValue,
				addedNodes,
				removedNodes,
				previousSibling,
				nextSibling,
			),
		);
		pendingMutationObservers.add(observer);
	}
	queueMutationObserverMicrotask();
}

function queueTreeMutationRecord(
	target: Node,
	addedNodes: Node[],
	removedNodes: Node[],
	previousSibling: Node | null,
	nextSibling: Node | null,
): void {
	queueMutationRecord(
		"childList",
		target,
		null,
		null,
		null,
		addedNodes,
		removedNodes,
		previousSibling,
		nextSibling,
	);
}

const kMembersMoved = Symbol("members moved");

const kLive = Symbol("live");
const kOwner = Symbol("owner");
const kChildMember = Symbol("childMember");
const kExact = Symbol("exact");
const kItems = Symbol("items");
const kRegistered = Symbol("registered at");
const kDocumentWide = Symbol("over a whole document");
const kWatched = Symbol("watched attribute");
const kDefined = Symbol("defined");
const kNames = Symbol("names");

const anyAttribute = Symbol("any attribute");

// The list is computed once and kept until a change invalidates it. A
// collection registers wherever the changes that can affect it are
// announced, and drops or patches its list when one arrives. Indexed
// access is an own accessor rather than a proxy trap, and the accessors
// recompute the list if it was dropped, so reads always see a live
// collection. The own properties themselves (which indices and names are
// defined) are what a change resynchronizes, because they are observable
// without a read.
abstract class LiveList implements LiveCollection {
	declare [kItems]?: Node[];
	declare [kDefined]?: number;
	declare [kRegistered]?: Node | null;
	declare [kExact]?: boolean;
	declare [kLive]?: boolean;
	declare [kOwner]?: Node | null;
	declare [kChildMember]?: ((node: Node) => boolean) | null;
	declare [kDocumentWide]?: boolean;
	declare [kWatched]?: string | symbol | null;
	declare [kNames]?: string[];

	// childMember: the list draws only from the owner's direct children, so
	// a change anywhere deeper in the owner's tree leaves it untouched, and
	// the children a change carries are exactly the members it carries.
	// watched: the attribute the list reads, `anyAttribute` if it reads any,
	// null if none. wide: the members come from anywhere in the document
	// rather than from under the owner.
	constructor(
		live: boolean,
		owner: Node | null = null,
		childMember: ((node: Node) => boolean) | null = null,
		watched: string | symbol | null = null,
		wide = false,
	) {
		this[kItems] = [];
		this[kDefined] = 0;
		this[kRegistered] = null;
		this[kExact] = false;
		this[kNames] = [];
		this[kLive] = live;
		this[kOwner] = owner;
		this[kChildMember] = childMember;
		this[kWatched] = watched;
		this[kDocumentWide] = wide;
	}

	abstract compute(): Node[];

	namedProperties(_items: Node[]): Map<string, Node> | null {
		return null;
	}

	// The members the changed nodes carry, if the collection can determine
	// that from those nodes alone and knows its named properties did not
	// move. Null if the list has to be recomputed to find out.
	getChangedMembers(changed: readonly Node[]): Node[] | null {
		const member = this[kChildMember]!;
		if (member === null) {
			return null;
		}
		const members: Node[] = [];
		for (const node of changed) {
			if (member(node)) {
				members.push(node);
			}
		}
		return members;
	}

	// The list cannot tell its members moved, because a splice moves them
	// within the one array the collection holds.
	[kMembersMoved]?(): void {}

	[kSync]?(): void {
		if (this[kRegistered] === null) {
			return;
		}
		if (this[kDocumentWide]!) {
			dropList(this);
			return;
		}
		recomputeList(this);
	}

	// A collection over one node's children is unaffected by a change to
	// some other node's children. A collection that can tell what the changed
	// nodes carry is unaffected if they carry none of its members. In both
	// cases the list stays. Members the change carried are spliced in or out
	// if the collection can place them, which costs proportional to what
	// moved rather than the tree size. Otherwise the list is recomputed,
	// except for a document-wide list, which is dropped and recomputed on the
	// next read, because a document sees far more changes than reads of such
	// a list.
	[kChildrenChangedSteps]?(
		point: Node,
		changed: readonly Node[] | null,
		added: boolean,
	): void {
		if (this[kRegistered] === null) {
			return;
		}
		if (this[kDocumentWide]!) {
			dropList(this);
			return;
		}
		if (this[kExact]!) {
			if (this[kChildMember] !== null && point !== this[kOwner]!) {
				return;
			}
			if (changed !== null) {
				const members = this.getChangedMembers(changed);
				if (members !== null && splice(this, point, changed, members, added)) {
					return;
				}
			}
		}
		recomputeList(this);
	}

	// A list that reads none of the element's attributes is unaffected.
	[kAttributeSync]?(_element: Element, localName: string): void {
		const watched = this[kWatched]!;
		if (watched === localName || watched === anyAttribute) {
			this[kSync]!();
		}
	}
}

// The own properties stay defined. An index reads through to the list
// the next read computes, and that read fixes the count.
function dropList(list: LiveList): void {
	if (!list[kExact]!) {
		return;
	}
	list[kExact] = false;
	list[kMembersMoved]!();
}

function recomputeList(list: LiveList): void {
	list[kItems] = list.compute();
	list[kExact] = true;
	list[kMembersMoved]!();
	defineListProperties(list);
}

// Returns whether the members' position could be determined from the
// change alone. Arriving members go where the sibling they were placed
// before is. Members placed last among their parent's children go after
// every member the list holds, as long as the last of those is under that
// parent. Any other case requires asking the tree. Leaving members are
// contiguous, so finding the first locates the run.
function splice(
	list: LiveList,
	point: Node,
	changed: readonly Node[],
	members: readonly Node[],
	added: boolean,
): boolean {
	const items = list[kItems]!;
	if (members.length === 0) {
		return true;
	}
	if (added) {
		const next = changed[changed.length - 1][kNext]!;
		if (next !== null) {
			const at = items.indexOf(next);
			if (at === -1) {
				return false;
			}
			// One member at a time. A change can carry any number of nodes, and
			// a spread would put them all in an argument list.
			const rest = items.splice(at);
			for (const member of members) {
				items.push(member);
			}
			for (const node of rest) {
				items.push(node);
			}
		} else {
			const last = items[items.length - 1];
			if (last !== undefined && !isInclusiveAncestor(point, last)) {
				return false;
			}
			for (const member of members) {
				items.push(member);
			}
		}
	} else {
		const at = items.indexOf(members[0]);
		if (at === -1) {
			return false;
		}
		for (let i = 1; i < members.length; i++) {
			if (items[at + i] !== members[i]) {
				return false;
			}
		}
		items.splice(at, members.length);
	}
	list[kMembersMoved]!();
	defineIndices(list, items.length);
	return true;
}

function defineIndices(list: LiveList, length: number): void {
	const indexed = list as unknown as Record<number | string, unknown>;
	for (let index = list[kDefined]!; index < length; index++) {
		const at = index;
		Object.defineProperty(indexed, at, {
			// Calls the recompute through the captured method, not through the
			// prototype. A caller may replace the prototype, and an indexed
			// property must survive that.
			get(): unknown {
				return ensureList(list)[at] ?? undefined;
			},
			enumerable: true,
			configurable: true,
		});
	}
	for (let index = length; index < list[kDefined]!; index++) {
		delete indexed[index];
	}
	list[kDefined] = length;
}

function defineListProperties(list: LiveList): void {
	const items = list[kItems]!;
	const record = list as unknown as Record<number | string, unknown>;
	defineIndices(list, items.length);
	for (const name of list[kNames]!) {
		delete record[name];
	}
	list[kNames] = [];
	const named = list.namedProperties(items);
	if (named !== null) {
		for (const [name, node] of named) {
			if (
				name === "" ||
				Object.prototype.hasOwnProperty.call(list, name)
			) {
				continue;
			}
			if (name in (list.constructor as {prototype: object}).prototype) {
				continue;
			}
			list[kNames]!.push(name);
			Object.defineProperty(record, name, {
				value: node,
				enumerable: false,
				configurable: true,
				writable: false,
			});
		}
	}
}

// The indices a collection defines are observable without reading it, so
// this runs when the collection is created rather than on first read.
function ensureList(list: LiveList): Node[] {
	if (!list[kLive]!) {
		if (!list[kExact]!) {
			recomputeList(list);
		}
		return list[kItems]!;
	}
	const owner = list[kOwner]!;
	if (owner === null) {
		// A list with nowhere to register is never notified of changes, so it
		// keeps only what it computes for this read.
		recomputeList(list);
		return list[kItems]!;
	}
	if (list[kDocumentWide]!) {
		// A list's document is the one its owner belongs to. Adopting the owner
		// moves the list to the other document.
		const document = owner[kDocument]!;
		const registered = list[kRegistered]! as Document | null;
		if (registered !== document) {
			if (registered !== null) {
				registered[kDocumentWideLists]?.delete(list);
			}
			list[kRegistered] = document;
			registerDocumentWide(list, document);
		}
	} else if (list[kRegistered] === null) {
		list[kRegistered] = owner;
		registerLiveCollection(list, owner);
	}
	if (!list[kExact]!) {
		recomputeList(list);
	}
	return list[kItems]!;
}

const syncMethod = (
	LiveList.prototype as unknown as Record<symbol, () => void>
)[kSync]!;
const childrenChangedMethod = (
	LiveList.prototype as unknown as Record<
		symbol,
		(point: Node, changed: readonly Node[] | null, added: boolean) => void
	>
)[kChildrenChangedSteps]!;

const kCompute = Symbol("compute");

export class NodeList extends LiveList {
	declare forEach: (
		callback: (
			node: globalThis.Node,
			index: number,
			list: NodeList,
		) => void,
		thisArg?: unknown,
	) => void;

	declare keys: () => ArrayIterator<number>;
	declare values: () => ArrayIterator<globalThis.Node>;
	declare entries: () => ArrayIterator<[number, globalThis.Node]>;
	declare [Symbol.iterator]: () => ArrayIterator<globalThis.Node>;

	declare [kCompute]?: () => Node[];

	constructor(
		compute: () => Node[],
		live: boolean,
		owner: Node | null = null,
		childMember: ((node: Node) => boolean) | null = null,
		watched: string | symbol | null = null,
		wide = false,
	) {
		super(live, owner, childMember, watched, wide);
		this[kCompute] = compute;
	}

	get length(): number {
		return ensureList(this).length;
	}

	override compute(): Node[] {
		return this[kCompute]!();
	}

	item(index: number): globalThis.Node | null {
		const items = ensureList(this);
		const at = toUnsignedLong(index);
		return at < items.length
			? (items[at] as unknown as globalThis.Node)
			: null;
	}
}

Object.defineProperty(NodeList.prototype, Symbol.toStringTag, {
	value: "NodeList",
	configurable: true,
});

// lib.dom's NodeListOf: the members are known, so `item` never returns
// null. The engine's own NodeList is the general one.
interface NodeListOf<T extends globalThis.Node> extends NodeList {
	item(index: number): T;
	[index: number]: T;
	forEach(
		callback: (node: T, index: number, list: NodeListOf<T>) => void,
		thisArg?: unknown,
	): void;
	keys(): ArrayIterator<number>;
	values(): ArrayIterator<T>;
	entries(): ArrayIterator<[number, T]>;
	[Symbol.iterator](): ArrayIterator<T>;
}

class HTMLCollection extends LiveList {
	[index: number]: Element;

	declare [Symbol.iterator]: () => ArrayIterator<Element>;

	declare [kCompute]?: () => Element[];

	constructor(
		compute: () => Element[],
		owner: Node | null = null,
		childMember: ((node: Node) => boolean) | null = null,
		watched: string | symbol | null = null,
		wide = false,
	) {
		super(true, owner, childMember, watched, wide);
		this[kCompute] = compute;
	}

	get length(): number {
		return ensureList(this).length;
	}

	override compute(): Node[] {
		return this[kCompute]!();
	}

	override getChangedMembers(changed: readonly Node[]): Node[] | null {
		const members = super.getChangedMembers(changed);
		if (members === null || isNameless(members)) {
			return members;
		}
		return null;
	}

	override namedProperties(items: Node[]): Map<string, Node> {
		const named = new Map<string, Node>();
		for (const item of items) {
			const element = item as Element;
			const id = element.getAttribute("id");
			if (id !== null && id !== "" && !named.has(id)) {
				named.set(id, element);
			}
			if (element.namespaceURI === HTML_NAMESPACE) {
				const name = element.getAttribute("name");
				if (name !== null && name !== "" && !named.has(name)) {
					named.set(name, element);
				}
			}
		}
		return named;
	}

	item(index: number): Element | null {
		const items = ensureList(this);
		const at = toUnsignedLong(index);
		return at < items.length ? (items[at] as Element) : null;
	}

	namedItem(name: string): Element | null {
		if (name === "") {
			return null;
		}
		const key = String(name);
		for (const item of ensureList(this)) {
			const element = item as Element;
			if (element.getAttribute("id") === key) {
				return element;
			}
			if (
				element.namespaceURI === HTML_NAMESPACE &&
				element.getAttribute("name") === key
			) {
				return element;
			}
		}
		return null;
	}

	// A collection is addressable by the id and name of its members, so a
	// change to either moves its named properties. No collection here selects
	// members by id or name, so the members stay and only the names are
	// rebuilt.
	override [kAttributeSync]?(element: Element, localName: string): void {
		if (localName !== "id" && localName !== "name") {
			super[kAttributeSync]!(element, localName);
			return;
		}
		if (this[kChildMember] !== null && element[kParent] !== this[kOwner]!) {
			return;
		}
		if (this[kDocumentWide]!) {
			dropList(this);
		} else if (this[kExact]!) {
			defineListProperties(this);
		}
	}
}

Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, {
	value: "HTMLCollection",
	configurable: true,
});

interface HTMLCollectionOf<T> {
	readonly length: number;
	item(index: number): T | null;
	namedItem(name: string): T | null;
	[index: number]: T;
	[Symbol.iterator](): ArrayIterator<T>;
}

function toUnsignedLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return 0;
	}
	const truncated = Math.trunc(number);
	return ((truncated % 4294967296) + 4294967296) % 4294967296;
}

/**
 * Convert to a WebIDL unsigned short: the unsigned long, wrapped into 16 bits.
 */
function toUnsignedShort(value: unknown): number {
	return toUnsignedLong(value) % 65536;
}

function createChildNodeList(node: Node): NodeList {
	const list = new NodeList(
		() => getChildNodeArray(node),
		true,
		node,
		() => true,
	);
	ensureList(list);
	return list;
}

function createStaticNodeList(nodes: Node[]): NodeList {
	const list = new NodeList(() => nodes, false);
	ensureList(list);
	return list;
}

const kCollectionCaches = Symbol("collection caches");

// Keyed by kind and name, so identity is stable across calls.
function getCollectionCache(node: Node): Map<string, HTMLCollection> {
	const owner = node as unknown as Record<symbol, unknown>;
	let cache = owner[kCollectionCaches]! as
		Map<string, HTMLCollection> |
		undefined;
	if (cache === undefined) {
		cache = new Map();
		owner[kCollectionCaches] = cache;
	}
	return cache;
}

function getElementChildren(parent: Node): Element[] {
	const elements: Element[] = [];
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType === ELEMENT_NODE) {
			elements.push(node as Element);
		}
	}
	return elements;
}

// A name belongs to the first member in tree order that carries it,
// which depends on the whole list. So a collection splices members in and
// out only when no name is affected.
function isNameless(members: readonly Node[]): boolean {
	for (const member of members) {
		if (member.nodeType !== ELEMENT_NODE) {
			continue;
		}
		for (const attribute of (member as Element)[kAttributeList]!) {
			const name = attribute[kLocalName]!;
			if (name === "id" || name === "name") {
				return false;
			}
		}
	}
	return true;
}

const kMatches = Symbol("matches");
const kMembers = Symbol("members");

// The test is per element, so an attribute change checks the one element
// that changed instead of walking the tree again.
class MatchingCollection extends HTMLCollection {
	declare [kRoot]?: Node;
	declare [kMatches]?: (element: Element) => boolean;
	declare [kMembers]?: Set<Node> | null;

	// watched: the attribute the test reads, if any.
	constructor(
		root: Node,
		watched: string | null,
		matches: (element: Element) => boolean,
	) {
		super(
			() => {
				const found: Element[] = [];
				for (const element of getDescendantElements(root, [])) {
					if (matches(element)) {
						found.push(element);
					}
				}
				return found;
			},
			root,
			null,
			watched,
		);
		this[kMembers] = null;
		this[kRoot] = root;
		this[kMatches] = matches;
	}

	// Runs the test over the changed subtree rather than over the tree it
	// moved in or out of.
	override getChangedMembers(changed: readonly Node[]): Node[] | null {
		const members: Node[] = [];
		for (const node of changed) {
			const elements =
				node.nodeType === ELEMENT_NODE
					? getDescendantElements(node, [node as Element])
					: getDescendantElements(node, []);
			for (const element of elements) {
				if (this[kMatches]!(element)) {
					members.push(element);
				}
			}
		}
		return isNameless(members) ? members : null;
	}

	override [kMembersMoved]?(): void {
		this[kMembers] = null;
	}

	override [kAttributeSync]?(element: Element, localName: string): void {
		if (localName !== this[kWatched]!) {
			super[kAttributeSync]!(element, localName);
			return;
		}
		const items = computed(this);
		if (items !== null) {
			let members = this[kMembers]!;
			if (members === null) {
				members = new Set(items);
				this[kMembers] = members;
			}
			if (
				this[kMatches]!(element) === members.has(element) ||
				!isInclusiveAncestor(this[kRoot]!, element)
			) {
				return;
			}
		}
		this[kSync]!();
	}
}

function getDescendantElements(root: Node, into: Element[]): Element[] {
	let current: Node | null = root[kFirstChild]!;
	while (current !== null) {
		if (current.nodeType === ELEMENT_NODE) {
			into.push(current as Element);
		}
		current = nextInTree(current, root);
	}
	return into;
}

// Null if the tree has changed since the list was last computed.
function computed(list: LiveList): Node[] | null {
	return list[kExact]! ? list[kItems]! : null;
}

const kPrefix = Symbol("prefix");

function createTagNameCollection(
	root: Node,
	getQualifiedName: string,
): HTMLCollection {
	const cache = getCollectionCache(root);
	const key = `tag:${getQualifiedName}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		const lowered = toASCIILowercase(getQualifiedName);
		collection = new MatchingCollection(root, null, (element) => {
			if (getQualifiedName === "*") {
				return true;
			}
			const name =
				element[kPrefix] === null
					? element[kLocalName]!
					: `${element[kPrefix]!}:${element[kLocalName]!}`;
			return element[kNamespace] === HTML_NAMESPACE
				? name === lowered
				: name === getQualifiedName;
		});
		ensureList(collection);
		cache.set(key, collection);
	}
	return collection;
}

function createTagNameNSCollection(
	root: Node,
	namespace: string | null,
	localName: string,
): HTMLCollection {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	const cache = getCollectionCache(root);
	const key = `tagns:${ns}:${localName}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		collection = new MatchingCollection(
			root,
			null,
			(element) =>
				(ns === "*" || element[kNamespace] === ns) &&
				(localName === "*" || element[kLocalName] === localName),
		);
		ensureList(collection);
		cache.set(key, collection);
	}
	return collection;
}

const kClassTokens = Symbol("the parsed class attribute");

// The parsed set is cached on the element and discarded by the class
// attribute's change steps, so a walk asking every element for its
// classes pays only for attributes that changed.
function getClassTokens(element: Element): ReadonlySet<string> {
	let tokens = element[kClassTokens]!;
	if (tokens === null) {
		const value = element.getAttribute("class");
		tokens = new Set(value === null ? [] : splitOnASCIIWhitespace(value));
		element[kClassTokens] = tokens;
	}
	return tokens;
}

const kMode = Symbol("document mode");

function createClassNameCollection(
	root: Node,
	classNames: string,
): HTMLCollection {
	const cache = getCollectionCache(root);
	const key = `class:${classNames}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		const classes = splitOnASCIIWhitespace(classNames);
		const quirks =
			root[kDocument]![kMode] === "quirks"
				? classes.map((name) => toASCIILowercase(name))
				: classes;
		collection = new MatchingCollection(root, "class", (element) => {
			if (classes.length === 0) {
				return false;
			}
			const isQuirks = root[kDocument]![kMode] === "quirks";
			let tokens: ReadonlySet<string>;
			if (isQuirks) {
				const value = element.getAttribute("class");
				if (value === null) {
					return false;
				}
				tokens = new Set(splitOnASCIIWhitespace(toASCIILowercase(value)));
			} else {
				tokens = getClassTokens(element);
			}
			for (const name of isQuirks ? quirks : classes) {
				if (!tokens.has(name)) {
					return false;
				}
			}
			return true;
		});
		ensureList(collection);
		cache.set(key, collection);
	}
	return collection;
}

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

function splitOnASCIIWhitespace(value: string): string[] {
	const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	if (trimmed === "") {
		return [];
	}
	return trimmed.split(ASCII_WHITESPACE);
}

function toASCIIUppercase(value: string): string {
	return value.replace(/[a-z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) - 32),
	);
}

const kElement = Symbol("element");
const kAttribute = Symbol("attribute");
const kSupported = Symbol("supported");
const kTokens = Symbol("tokens");

class DOMTokenList extends LiveList implements globalThis.DOMTokenList {
	declare forEach: (
		callback: (token: string, index: number, list: DOMTokenList) => void,
		thisArg?: unknown,
	) => void;

	declare keys: () => ArrayIterator<number>;
	declare values: () => ArrayIterator<string>;
	declare entries: () => ArrayIterator<[number, string]>;
	declare [Symbol.iterator]: () => ArrayIterator<string>;

	declare [kElement]?: Element;
	declare [kAttribute]?: string;
	declare [kSupported]?: Set<string> | null;

	constructor(element: Element, attribute: string, supported?: string[]) {
		super(true, element);
		this[kElement] = element;
		this[kAttribute] = attribute;
		this[kSupported] = supported === undefined ? null : new Set(supported);
	}

	get length(): number {
		return this[kTokens]!.length;
	}

	get value(): string {
		return this[kElement]!.getAttribute(this[kAttribute]!) ?? "";
	}

	set value(value: string) {
		this[kElement]!.setAttribute(this[kAttribute]!, String(value));
	}

	get [kTokens](): string[] {
		return ensureList(this) as unknown as string[];
	}

	// An attribute's tokens are not part of the tree's shape.
	override getChangedMembers(): Node[] {
		return [];
	}

	override compute(): Node[] {
		const value = this[kElement]!.getAttribute(this[kAttribute]!);
		const tokens = value === null ? [] : splitOnASCIIWhitespace(value);
		const ordered: string[] = [];
		for (const token of tokens) {
			if (!ordered.includes(token)) {
				ordered.push(token);
			}
		}
		return ordered as unknown as Node[];
	}

	item(index: number): string | null {
		const tokens = this[kTokens]!;
		const at = toUnsignedLong(index);
		return at < tokens.length ? tokens[at] : null;
	}

	contains(token: string): boolean {
		return this[kTokens]!.includes(String(token));
	}

	add(...tokens: string[]): void {
		validateTokens(tokens);
		const current = this[kTokens]!.slice();
		for (const token of tokens) {
			if (!current.includes(token)) {
				current.push(String(token));
			}
		}
		writeTokenList(this, current);
	}

	remove(...tokens: string[]): void {
		validateTokens(tokens);
		const current = this[kTokens]!.filter(
			(each) => !tokens.some((token) => String(token) === each),
		);
		writeTokenList(this, current);
	}

	toggle(token: string, force?: boolean): boolean {
		validateTokens([token]);
		const name = String(token);
		const current = this[kTokens]!.slice();
		const index = current.indexOf(name);
		if (index !== -1) {
			if (force === undefined || force === false) {
				current.splice(index, 1);
				writeTokenList(this, current);
				return false;
			}
			return true;
		}
		if (force === undefined || force === true) {
			current.push(name);
			writeTokenList(this, current);
			return true;
		}
		return false;
	}

	replace(token: string, newToken: string): boolean {
		validateTokens([token, newToken]);
		const name = String(token);
		const replacement = String(newToken);
		const current = this[kTokens]!.slice();
		if (!current.includes(name)) {
			return false;
		}
		// The ordered set replacement: the first occurrence of either token
		// becomes the replacement, and every other occurrence of either is
		// removed.
		const first = Math.min(
			...[current.indexOf(name), current.indexOf(replacement)].filter(
				(index) => index !== -1,
			),
		);
		const replaced: string[] = [];
		for (let index = 0; index < current.length; index++) {
			if (index === first) {
				replaced.push(replacement);
			} else if (current[index] !== name && current[index] !== replacement) {
				replaced.push(current[index]);
			}
		}
		writeTokenList(this, replaced);
		return true;
	}

	supports(token: string): boolean {
		if (this[kSupported] === null) {
			throw new TypeError(`${this[kAttribute]!} has no supported tokens`);
		}
		return this[kSupported]!.has(toASCIILowercase(String(token)));
	}

	override toString(): string {
		return this.value;
	}
}

function writeTokenList(list: DOMTokenList, tokens: string[]): void {
	if (
		tokens.length === 0 &&
		list[kElement]!.getAttributeNode(list[kAttribute]!) === null
	) {
		return;
	}
	list[kElement]!.setAttribute(list[kAttribute]!, tokens.join(" "));
}

Object.defineProperty(DOMTokenList.prototype, Symbol.toStringTag, {
	value: "DOMTokenList",
	configurable: true,
});

interface DOMTokenList {
	[index: number]: string;
}

// An interface with an indexed property getter and a length gets
// %Array.prototype%'s own functions, the same function objects rather
// than copies, so comparing them finds them equal. Iteration reads length
// and index on each step, which keeps it live.
function installArrayIteration(
	prototype: object,
	valueIterator: boolean,
): void {
	const members: Record<string | symbol, unknown> = {
		[Symbol.iterator]: Array.prototype[Symbol.iterator],
	};
	if (valueIterator) {
		members.keys = Array.prototype.keys;
		members.values = Array.prototype.values;
		members.entries = Array.prototype.entries;
		members.forEach = Array.prototype.forEach;
	}
	for (const key of Reflect.ownKeys(members)) {
		Object.defineProperty(prototype, key, {
			value: members[key as string],
			writable: true,
			enumerable: typeof key === "string",
			configurable: true,
		});
	}
}

function validateTokens(tokens: string[]): void {
	for (const token of tokens) {
		if (String(token) === "") {
			throw domError("SyntaxError", "A token cannot be the empty string");
		}
	}
	for (const token of tokens) {
		if (/[\t\n\f\r ]/.test(String(token))) {
			throw domError(
				"InvalidCharacterError",
				"A token cannot contain ASCII whitespace",
			);
		}
	}
}

class CharacterData extends Node implements globalThis.CharacterData {
	[kData]?: string;

	constructor(data: string) {
		super();
		this[kData] = data;
	}

	get data(): string {
		return this[kData]!;
	}

	set data(value: string) {
		replaceData(
			this,
			0,
			this[kData]!.length,
			value === null ? "" : String(value),
		);
	}

	get length(): number {
		return this[kData]!.length;
	}

	override get nodeValue(): string | null {
		return this[kData]!;
	}

	override set nodeValue(value: string | null) {
		replaceData(this, 0, this[kData]!.length, nullableString(value));
	}

	override get textContent(): string {
		return this[kData]!;
	}

	override set textContent(value: string | null) {
		replaceData(this, 0, this[kData]!.length, nullableString(value));
	}

	substringData(offset: number, count: number): string {
		if (arguments.length < 2) {
			throw new TypeError("substringData needs an offset and a count");
		}
		const length = this[kData]!.length;
		const start = toUnsignedLong(offset);
		if (start > length) {
			throw indexSizeError("The offset is past the end");
		}
		const size = toUnsignedLong(count);
		if (start + size > length) {
			return this[kData]!.slice(start);
		}
		return this[kData]!.slice(start, start + size);
	}

	appendData(data: string): void {
		if (arguments.length < 1) {
			throw new TypeError("appendData needs data");
		}
		replaceData(this, this[kData]!.length, 0, String(data));
	}

	insertData(offset: number, data: string): void {
		if (arguments.length < 2) {
			throw new TypeError("insertData needs an offset and data");
		}
		replaceData(this, toUnsignedLong(offset), 0, String(data));
	}

	deleteData(offset: number, count: number): void {
		if (arguments.length < 2) {
			throw new TypeError("deleteData needs an offset and a count");
		}
		replaceData(this, toUnsignedLong(offset), toUnsignedLong(count), "");
	}

	replaceData(offset: number, count: number, data: string): void {
		if (arguments.length < 3) {
			throw new TypeError("replaceData needs an offset, a count and data");
		}
		replaceData(
			this,
			toUnsignedLong(offset),
			toUnsignedLong(count),
			String(data),
		);
	}
}

interface CharacterData
	extends Pick<globalThis.CharacterData, ChildNodeMixin> {

	get ownerDocument(): Document;
}

Object.defineProperty(CharacterData.prototype, Symbol.toStringTag, {
	value: "CharacterData",
	configurable: true,
});

function nullableString(value: string | null | undefined): string {
	return value == null ? "" : String(value);
}

function replaceData(
	node: CharacterData,
	offset: number,
	count: number,
	data: string,
): void {
	const length = node[kData]!.length;
	if (offset > length) {
		throw indexSizeError("The offset is past the end");
	}
	const size = offset + count > length ? length - offset : count;
	const oldValue = node[kData]!;
	node[kData] =
		oldValue.slice(0, offset) + data + oldValue.slice(offset + size);
	liveRangeReplaceDataSteps(node, offset, size, data.length);
	queueCharacterDataMutationRecord(node, oldValue);
}

function queueCharacterDataMutationRecord(
	node: CharacterData,
	oldValue: string,
): void {
	queueMutationRecord(
		"characterData",
		node,
		null,
		null,
		oldValue,
		[],
		[],
		null,
		null,
	);
}

const kManualSlot = Symbol("manual slot assignment");

export class Text extends CharacterData implements globalThis.Text {
	[kAssignedSlot]?: HTMLSlotElement | null;
	[kManualSlot]?: HTMLSlotElement | null;

	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kAssignedSlot] = null;
		this[kManualSlot] = null;
		this[kDocument] = getCurrentDocument();
	}

	get assignedSlot(): globalThis.HTMLSlotElement | null {
		return findASlot(
			this,
			true,
		) as unknown as globalThis.HTMLSlotElement | null;
	}

	override get nodeType(): number {
		return TEXT_NODE;
	}

	override get nodeName(): string {
		return "#text";
	}

	get wholeText(): string {
		let start: Node = this;
		while (
			start[kPrevious] !== null &&
			isExclusiveText(start[kPrevious]! as Node)
		) {
			start = start[kPrevious]! as Node;
		}
		let text = "";
		for (
			let node: Node | null = start;
			node !== null && isExclusiveText(node);
			node = node[kNext]!
		) {
			text += (node as CharacterData)[kData]!;
		}
		return text;
	}

	splitText(offset: number): Text {
		if (arguments.length < 1) {
			throw new TypeError("splitText needs an offset");
		}
		const start = toUnsignedLong(offset);
		const length = this[kData]!.length;
		if (start > length) {
			throw indexSizeError("The offset is past the end");
		}
		const count = length - start;
		const data = this.substringData(start, count);
		const created = new Text(data);
		created[kDocument] = this[kDocument]!;
		const parent = this[kParent]!;
		if (parent !== null) {
			insertNode(created, parent, this[kNext]!, false);
			liveRangeSplitSteps(this, created, start, parent);
		}
		replaceData(this, start, count, "");
		return created;
	}

	override [kGetTheParent]?(_event: Event): EventTarget | null {
		return this[kAssignedSlot] ?? this[kParent]!;
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new Text(this[kData]!);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(Text.prototype, Symbol.toStringTag, {
	value: "Text",
	configurable: true,
});

class CDATASection extends Text {
	override get nodeType(): number {
		return CDATA_SECTION_NODE;
	}

	override get nodeName(): string {
		return "#cdata-section";
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new CDATASection(this[kData]!);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(CDATASection.prototype, Symbol.toStringTag, {
	value: "CDATASection",
	configurable: true,
});

export class Comment extends CharacterData implements globalThis.Comment {
	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kDocument] = getCurrentDocument();
	}

	override get nodeType(): number {
		return COMMENT_NODE;
	}

	override get nodeName(): string {
		return "#comment";
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new Comment(this[kData]!);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(Comment.prototype, Symbol.toStringTag, {
	value: "Comment",
	configurable: true,
});

class ProcessingInstruction extends CharacterData {
	[kTarget]?: string;

	constructor(target: string, data: string) {
		super(data);
		this[kTarget] = target;
	}

	get target(): string {
		return this[kTarget]!;
	}

	override get nodeType(): number {
		return PROCESSING_INSTRUCTION_NODE;
	}

	override get nodeName(): string {
		return this[kTarget]!;
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new ProcessingInstruction(this[kTarget]!, this[kData]!);
		copy[kDocument] = document;
		return copy;
	}
}

interface ProcessingInstruction {
	get ownerDocument(): Document;
}

Object.defineProperty(ProcessingInstruction.prototype, Symbol.toStringTag, {
	value: "ProcessingInstruction",
	configurable: true,
});

const kName = Symbol("doctype name");
const kPublicId = Symbol("public id");
const kSystemId = Symbol("system id");

class DocumentType extends Node {
	[kName]?: string;
	[kPublicId]?: string;
	[kSystemId]?: string;

	constructor(name: string, publicId: string, systemId: string) {
		super();
		this[kName] = name;
		this[kPublicId] = publicId;
		this[kSystemId] = systemId;
	}

	get name(): string {
		return this[kName]!;
	}

	get publicId(): string {
		return this[kPublicId]!;
	}

	get systemId(): string {
		return this[kSystemId]!;
	}

	override get nodeType(): number {
		return DOCUMENT_TYPE_NODE;
	}

	override get nodeName(): string {
		return this[kName]!;
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new DocumentType(
			this[kName]!,
			this[kPublicId]!,
			this[kSystemId]!,
		);
		copy[kDocument] = document;
		return copy;
	}
}

interface DocumentType {

	get ownerDocument(): Document;

	get textContent(): null;
}

Object.defineProperty(DocumentType.prototype, Symbol.toStringTag, {
	value: "DocumentType",
	configurable: true,
});

export class DocumentFragment extends Node implements globalThis.DocumentFragment {
	[kHost]?: Element | null;

	constructor() {
		super();
		this[kHost] = null;
		this[kDocument] = getCurrentDocument();
	}

	override get nodeType(): number {
		return DOCUMENT_FRAGMENT_NODE;
	}

	override get nodeName(): string {
		return "#document-fragment";
	}

	override get textContent(): string {
		return getDescendantText(this);
	}

	override set textContent(value: string | null) {
		setDescendantText(this, value);
	}

	getElementById(elementId: string): globalThis.HTMLElement | null {
		const id = String(elementId);
		if (id === "") {
			return null;
		}
		for (const node of descendants(this)) {
			if (node.nodeType === ELEMENT_NODE) {
				if ((node as Element).getAttribute("id") === id) {
					return node as unknown as globalThis.HTMLElement;
				}
			}
		}
		return null;
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new DocumentFragment();
		copy[kDocument] = document;
		return copy;
	}
}

export interface DocumentFragment
	extends Pick<globalThis.DocumentFragment, ParentNodeMixin> {

	get ownerDocument(): Document;
}

Object.defineProperty(DocumentFragment.prototype, Symbol.toStringTag, {
	value: "DocumentFragment",
	configurable: true,
});

function getDescendantText(node: Node): string {
	let text = "";
	let current: Node | null = node[kFirstChild]!;
	while (current !== null) {
		const type = current.nodeType;
		if (type === TEXT_NODE || type === CDATA_SECTION_NODE) {
			text += (current as CharacterData)[kData]!;
		}
		current = nextInTree(current, node);
	}
	return text;
}

function setDescendantText(node: Node, value: string | null): void {
	const string = nullableString(value);
	let replacement: Node | null = null;
	if (string !== "") {
		replacement = new Text(string);
		replacement[kDocument] = node[kDocument]!;
	}
	replaceAll(replacement, node);
}

const kValue = Symbol("attribute value");
const kOwnerElement = Symbol("owner element");
const kQualifiedName = Symbol("qualified name");

class Attr extends Node implements globalThis.Attr {
	[kNamespace]?: string | null;
	[kPrefix]?: string | null;
	[kLocalName]?: string;
	[kValue]?: string;
	[kOwnerElement]?: Element | null;

	constructor(
		namespace: string | null,
		prefix: string | null,
		localName: string,
		value: string,
	) {
		super();
		this[kOwnerElement] = null;
		this[kNamespace] = namespace;
		this[kPrefix] = prefix;
		this[kLocalName] = localName;
		this[kValue] = value;
	}

	get namespaceURI(): string | null {
		return this[kNamespace]!;
	}

	get prefix(): string | null {
		return this[kPrefix]!;
	}

	get localName(): string {
		return this[kLocalName]!;
	}

	get name(): string {
		return this[kQualifiedName]!;
	}

	get value(): string {
		return this[kValue]!;
	}

	set value(value: string) {
		setExistingAttributeValue(this, value === null ? "null" : String(value));
	}

	get ownerElement(): Element | null {
		return this[kOwnerElement]!;
	}

	get specified(): boolean {
		return true;
	}

	override get nodeType(): number {
		return ATTRIBUTE_NODE;
	}

	override get nodeName(): string {
		return this[kQualifiedName]!;
	}

	override get nodeValue(): string | null {
		return this[kValue]!;
	}

	override set nodeValue(value: string | null) {
		setExistingAttributeValue(this, nullableString(value));
	}

	override get textContent(): string {
		return this[kValue]!;
	}

	override set textContent(value: string | null) {
		setExistingAttributeValue(this, nullableString(value));
	}

	get [kQualifiedName](): string {
		return this[kPrefix] === null
			? this[kLocalName]!
			: `${this[kPrefix]!}:${this[kLocalName]!}`;
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = new Attr(
			this[kNamespace]!,
			this[kPrefix]!,
			this[kLocalName]!,
			this[kValue]!,
		);
		copy[kDocument] = document;
		return copy;
	}
}

Object.defineProperty(Attr.prototype, Symbol.toStringTag, {
	value: "Attr",
	configurable: true,
});

interface Attr {

	get ownerDocument(): Document;
}

function setExistingAttributeValue(attribute: Attr, value: string): void {
	const element = attribute[kOwnerElement]!;
	if (element === null) {
		attribute[kValue] = value;
		return;
	}
	changeAttribute(attribute, value);
}

// The steps run AFTER the change is applied, as the DOM Standard orders
// them. An element's own steps read the element, and they must see the
// tree the rest of the world will see.
function notifyAttributeChange(element: Element, localName: string): void {
	styleAttributeChanged(element, localName);
}

const kAttributeChangeSteps = Symbol("attribute change steps");

function changeAttribute(attribute: Attr, value: string): void {
	const element = attribute[kOwnerElement]! as Element;
	const oldValue = attribute[kValue]!;
	queueAttributeMutationRecord(element, attribute, oldValue);
	attribute[kValue] = value;
	element[kAttributeChangeSteps]!(
		attribute[kLocalName]!,
		oldValue,
		value,
		attribute[kNamespace]!,
	);
	syncAttributeCollections(element, attribute[kLocalName]!);
	notifyAttributeChange(element, attribute[kLocalName]!);
}

function appendAttribute(element: Element, attribute: Attr): void {
	queueAttributeMutationRecord(element, attribute, null);
	element[kAttributeList]!.push(attribute);
	attribute[kOwnerElement] = element;
	attribute[kDocument] = element[kDocument]!;
	element[kAttributeChangeSteps]!(
		attribute[kLocalName]!,
		null,
		attribute[kValue]!,
		attribute[kNamespace]!,
	);
	syncAttributeCollections(element, attribute[kLocalName]!);
	notifyAttributeChange(element, attribute[kLocalName]!);
}

function removeAttributeNode(element: Element, attribute: Attr): void {
	const oldValue = attribute[kValue]!;
	queueAttributeMutationRecord(element, attribute, oldValue);
	const list = element[kAttributeList]!;
	const index = list.indexOf(attribute);
	if (index !== -1) {
		list.splice(index, 1);
	}
	attribute[kOwnerElement] = null;
	element[kAttributeChangeSteps]!(
		attribute[kLocalName]!,
		oldValue,
		null,
		attribute[kNamespace]!,
	);
	syncAttributeCollections(element, attribute[kLocalName]!);
	notifyAttributeChange(element, attribute[kLocalName]!);
}

function replaceAttribute(
	element: Element,
	oldAttribute: Attr,
	newAttribute: Attr,
): void {
	queueAttributeMutationRecord(element, oldAttribute, oldAttribute[kValue]!);
	const list = element[kAttributeList]!;
	list[list.indexOf(oldAttribute)] = newAttribute;
	newAttribute[kOwnerElement] = element;
	newAttribute[kDocument] = element[kDocument]!;
	oldAttribute[kOwnerElement] = null;
	element[kAttributeChangeSteps]!(
		newAttribute[kLocalName]!,
		oldAttribute[kValue]!,
		newAttribute[kValue]!,
		newAttribute[kNamespace]!,
	);
	syncAttributeCollections(element, newAttribute[kLocalName]!);
	notifyAttributeChange(element, newAttribute[kLocalName]!);
}

function queueAttributeMutationRecord(
	element: Element,
	attribute: Attr,
	oldValue: string | null,
): void {
	queueMutationRecord(
		"attributes",
		element,
		attribute[kLocalName]!,
		attribute[kNamespace]!,
		oldValue,
		[],
		[],
		null,
		null,
	);
}

function getAttributeByName(
	element: Element,
	getQualifiedName: string,
): Attr | null {
	let name = getQualifiedName;
	if (
		element[kNamespace] === HTML_NAMESPACE &&
		isHTMLDocument(element[kDocument]!)
	) {
		name = toASCIILowercase(name);
	}
	for (const attribute of element[kAttributeList]!) {
		if (attribute[kQualifiedName] === name) {
			return attribute;
		}
	}
	return null;
}

function getAttributeByNamespace(
	element: Element,
	namespace: string | null,
	localName: string,
): Attr | null {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	for (const attribute of element[kAttributeList]!) {
		if (attribute[kNamespace] === ns && attribute[kLocalName] === localName) {
			return attribute;
		}
	}
	return null;
}

function setAttributeNode(element: Element, attribute: Attr): Attr | null {
	if (
		attribute[kOwnerElement] !== null &&
		attribute[kOwnerElement] !== element
	) {
		throw domError(
			"InUseAttributeError",
			"That attribute already belongs to an element",
		);
	}
	const existing = getAttributeByNamespace(
		element,
		attribute[kNamespace]!,
		attribute[kLocalName]!,
	);
	if (existing === attribute) {
		return attribute;
	}
	if (existing !== null) {
		replaceAttribute(element, existing, attribute);
		return existing;
	}
	appendAttribute(element, attribute);
	return null;
}

class NamedNodeMap extends LiveList implements globalThis.NamedNodeMap {
	declare [Symbol.iterator]: () => ArrayIterator<Attr>;

	declare [kElement]?: Element;

	constructor(element: Element) {
		super(true, element);
		this[kElement] = element;
	}

	get length(): number {
		return ensureList(this).length;
	}

	// An element's attributes are not part of the tree's shape.
	override getChangedMembers(): Node[] {
		return [];
	}

	override compute(): Node[] {
		return this[kElement]![kAttributeList]!.slice();
	}

	override namedProperties(items: Node[]): Map<string, Node> {
		const named = new Map<string, Node>();
		const html =
			this[kElement]![kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kElement]![kDocument]!);
		for (const item of items) {
			const attribute = item as Attr;
			const name = attribute[kQualifiedName]!;
			if (html && toASCIILowercase(name) !== name) {
				continue;
			}
			if (!named.has(name)) {
				named.set(name, attribute);
			}
		}
		return named;
	}

	item(index: number): Attr | null {
		const items = ensureList(this);
		const at = toUnsignedLong(index);
		return at < items.length ? (items[at] as Attr) : null;
	}

	getNamedItem(getQualifiedName: string): Attr | null {
		return getAttributeByName(this[kElement]!, String(getQualifiedName));
	}

	getNamedItemNS(namespace: string | null, localName: string): Attr | null {
		return getAttributeByNamespace(
			this[kElement]!,
			namespace,
			String(localName),
		);
	}

	setNamedItem(attr: Attr): Attr | null {
		return setAttributeNode(this[kElement]!, attr);
	}

	setNamedItemNS(attr: Attr): Attr | null {
		return setAttributeNode(this[kElement]!, attr);
	}

	removeNamedItem(getQualifiedName: string): Attr {
		const attribute = getAttributeByName(
			this[kElement]!,
			String(getQualifiedName),
		);
		if (attribute === null) {
			throw notFoundError("There is no such attribute");
		}
		removeAttributeNode(this[kElement]!, attribute);
		return attribute;
	}

	removeNamedItemNS(namespace: string | null, localName: string): Attr {
		const attribute = getAttributeByNamespace(
			this[kElement]!,
			namespace,
			String(localName),
		);
		if (attribute === null) {
			throw notFoundError("There is no such attribute");
		}
		removeAttributeNode(this[kElement]!, attribute);
		return attribute;
	}
}

Object.defineProperty(NamedNodeMap.prototype, Symbol.toStringTag, {
	value: "NamedNodeMap",
	configurable: true,
});

interface NamedNodeMap {
	[index: number]: Attr;
}

installArrayIteration(NodeList.prototype, true);
installArrayIteration(DOMTokenList.prototype, true);
installArrayIteration(HTMLCollection.prototype, false);
installArrayIteration(NamedNodeMap.prototype, false);

type CustomElementState =
	"uncustomized" |
	"undefined" |
	"failed" |
	"custom" |
	"precustomized";

const kByName = Symbol("byName");

// A name the DOM Standard gives its own behavior (slot, and template,
// whose content the parser fills) is created through the class that
// implements that behavior. Every other name maps to one of the four
// namespace interfaces. Author definitions live in a
// CustomElementRegistry, a separate table with a separate lifetime.
class ElementRegistry {
	declare [kByName]?: Map<string, new () => Element>;
	constructor() {
		this[kByName] = new Map<string, new () => Element>();
	}

	define(
		namespace: string | null,
		localName: string,
		constructor: new () => Element,
	): void {
		this[kByName]!.set(`${namespace}|${localName}`, constructor);
	}

	lookup(
		namespace: string | null,
		localName: string,
	): (new () => Element) | null {
		return this[kByName]!.get(`${namespace}|${localName}`) ?? null;
	}
}

const builtinRegistry = new ElementRegistry();

// The HTML element constructor is an author-facing algorithm: it looks
// up which custom element definition `new.target` names and throws if
// there is none. The tree's own creation path needs the same classes
// without that check, and this flag tells the constructor which case it
// is in.
let internalConstruction = false;

const kChildren = Symbol("children");
const kSlottableName = Symbol("slottable name");
const kReactionQueue = Symbol("custom element reaction queue");
const kPseudoElements = Symbol("user-agent pseudo-element slots");
const kPseudoHost = Symbol("the element a pseudo-element originates from");
const kPseudoName = Symbol("the pseudo-element a slot node fills");
const kIsValue = Symbol("is value");
const kARIAElements = Symbol("explicitly set attr-elements");
const kDataset = Symbol("dataset");
const kInternals = Symbol("element internals");

type ScrollMethod = (
	xOrOptions?: number | globalThis.ScrollToOptions,
	y?: number,
) => void;

export class Element extends Node implements globalThis.Element {
	// Installed on the prototype, where the engine that implements them is.
	declare getBoundingClientRect: () => globalThis.DOMRect;
	declare getClientRects: () => globalThis.DOMRectList;
	declare scrollLeft: number;
	declare scrollTop: number;
	declare scroll: ScrollMethod;
	declare scrollTo: ScrollMethod;
	declare scrollBy: ScrollMethod;
	[kNamespace]?: string | null;
	[kPrefix]?: string | null;
	[kLocalName]?: string;
	[kAttributeList]?: Attr[];
	[kCustomState]?: CustomElementState;
	[kDefinition]?: CustomElementDefinition | null;
	[kIsValue]?: string | null;
	[kClassList]?: DOMTokenList | null;
	[kClassTokens]?: Set<string> | null;
	[kTokenLists]?: Map<string, DOMTokenList> | null;
	[kARIAElements]?: Map<string, Element[]> | null;
	[kDataset]?: DOMStringMap | null;
	[kClickInProgress]?: boolean;
	[kInternals]?: ElementInternals | null;
	[kAttributesMap]?: NamedNodeMap | null;
	[kChildren]?: HTMLCollection | null;
	[kShadowRoot]?: ShadowRoot | null;
	[kSlottableName]?: string;
	[kAssignedSlot]?: HTMLSlotElement | null;
	[kManualSlot]?: HTMLSlotElement | null;
	[kReactionQueue]?: Reaction[] | null;
	[kPseudoElements]?: Map<string, Element> | null;
	[kPseudoHost]?: Element | null;
	[kPseudoName]?: string | null;

	constructor() {
		super();
		this[kNamespace] = null;
		this[kPrefix] = null;
		this[kLocalName] = "";
		this[kAttributeList] = [];
		this[kCustomState] = "uncustomized";
		this[kDefinition] = null;
		this[kIsValue] = null;
		this[kClassList] = null;
		this[kClassTokens] = null;
		this[kTokenLists] = null;
		this[kARIAElements] = null;
		this[kDataset] = null;
		this[kClickInProgress] = false;
		this[kInternals] = null;
		this[kAttributesMap] = null;
		this[kChildren] = null;
		this[kShadowRoot] = null;
		this[kSlottableName] = "";
		this[kAssignedSlot] = null;
		this[kManualSlot] = null;
		this[kReactionQueue] = null;
		this[kPseudoElements] = null;
		this[kPseudoHost] = null;
		this[kPseudoName] = null;
		this[kDocument] = getCurrentDocument();
	}

	override get nodeType(): number {
		return ELEMENT_NODE;
	}

	override get nodeName(): string {
		return this.tagName;
	}

	get namespaceURI(): string | null {
		return this[kNamespace]!;
	}

	get prefix(): string | null {
		return this[kPrefix]!;
	}

	get localName(): string {
		return this[kLocalName]!;
	}

	get tagName(): string {
		const qualified = this[kQualifiedName]!;
		return this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
			? toASCIIUppercase(qualified)
			: qualified;
	}

	get id(): string {
		return this.getAttribute("id") ?? "";
	}

	set id(value: string) {
		this.setAttribute("id", String(value));
	}

	get className(): string {
		return this.getAttribute("class") ?? "";
	}

	set className(value: string) {
		this.setAttribute("class", String(value));
	}

	get classList(): DOMTokenList {
		let list = this[kClassList]!;
		if (list === null) {
			list = new DOMTokenList(this, "class");
			ensureList(list);
			this[kClassList] = list;
		}
		return list;
	}

	set classList(value: string) {
		this.setAttribute("class", String(value));
	}

	get slot(): string {
		return this.getAttribute("slot") ?? "";
	}

	set slot(value: string) {
		this.setAttribute("slot", String(value));
	}

	get assignedSlot(): HTMLSlotElement | null {
		return findASlot(this, true);
	}

	get customElementRegistry(): CustomElementRegistry | null {
		return this[kRegistry]!;
	}

	get shadowRoot(): globalThis.ShadowRoot | null {
		const shadow = this[kShadowRoot]!;
		if (shadow === null || shadow[kShadowMode] !== "open") {
			return null;
		}
		return shadow as unknown as globalThis.ShadowRoot | null;
	}

	get attributes(): globalThis.NamedNodeMap {
		let map = this[kAttributesMap]!;
		if (map === null) {
			map = new NamedNodeMap(this);
			ensureList(map);
			this[kAttributesMap] = map;
		}
		return map as unknown as globalThis.NamedNodeMap;
	}

	override get textContent(): string {
		return getDescendantText(this);
	}

	override set textContent(value: string | null) {
		setDescendantText(this, value);
	}

	// A template's markup is its content fragment's. The parser never puts
	// its children in the tree, and neither does a write.
	get innerHTML(): string {
		return serializeFragment(getMarkupHost(this), false);
	}

	set innerHTML(value: string) {
		const fragment = parseHTMLFragment(String(value ?? ""), this);
		replaceAll(fragment, getMarkupHost(this));
	}

	get outerHTML(): string {
		return serializeNode(this, false, []);
	}

	set outerHTML(value: string) {
		const parent = this[kParent]!;
		if (parent === null) {
			return;
		}
		if (parent.nodeType === DOCUMENT_NODE) {
			throw domError(
				"NoModificationAllowedError",
				"A document element has no outer HTML to replace",
			);
		}
		const context =
			parent.nodeType === DOCUMENT_FRAGMENT_NODE
				? createElementInternal(this[kDocument]!, "body", HTML_NAMESPACE)
				: (parent as Element);
		const fragment = parseHTMLFragment(String(value ?? ""), context);
		replaceChild(this, fragment, parent);
	}

	/** A terminal has no zoom, so this is always 1. */
	get currentCSSZoom(): number {
		return 1;
	}

	get [kQualifiedName](): string {
		return this[kPrefix] === null
			? this[kLocalName]!
			: `${this[kPrefix]!}:${this[kLocalName]!}`;
	}

	attachShadow(init: globalThis.ShadowRootInit): globalThis.ShadowRoot {
		const options = toDictionary<ShadowRootInit>(init, "A ShadowRootInit");
		const mode = String(options.mode);
		if (mode !== "open" && mode !== "closed") {
			throw new TypeError(`${mode} is not a shadow root mode`);
		}
		const slotAssignment =
			options.slotAssignment === undefined
				? "named"
				: String(options.slotAssignment);
		if (slotAssignment !== "named" && slotAssignment !== "manual") {
			throw new TypeError(`${slotAssignment} is not a slot assignment mode`);
		}
		const registry = extractRegistry(options);
		attachShadowRoot(
			this,
			mode,
			Boolean(options.clonable),
			Boolean(options.serializable),
			Boolean(options.delegatesFocus),
			slotAssignment,
			registry === undefined ? globalCustomElements : registry,
		);
		const root = this[kShadowRoot]! as ShadowRoot;
		const attached = getAttachedDocument(this);
		if (attached !== undefined) {
			observeShadowRoot(this[kDocument]!, root);
			// Attaching a shadow root recomposes the host's subtree without a
			// mutation record, so every cached box enumeration is stale.
			attached[kLayout].invalidate();
			// The root's <style> elements join the cascade, scoped to this
			// tree. The sync happens on the STYLE mutation records the
			// observer registration above will deliver.
			attached[kCascade].registerShadowRoot(root);
			// attachShadow is not a DOM mutation, so no observer record fires
			// for it. But on a CONNECTED host the composed tree just changed
			// wholesale: light children stop rendering as soon as the root
			// exists, even while it is empty. Rebuild the host's composed
			// subtree and repaint.
			if (this.isConnected) {
				attached[kLayout].invalidate(this);
				attached[kScreen].invalidate();
				void render(attached[kTermDOM]);
			}
		}
		return root as unknown as globalThis.ShadowRoot;
	}

	// A headless document has no viewport to fill, so this rejects the way
	// the spec's no-browsing-context document does.
	requestFullscreen(_options?: globalThis.FullscreenOptions): Promise<void> {
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return Promise.reject(
				new TypeError("The element's document is not attached"),
			);
		}
		// Fullscreen switches to the alternate screen, and attach() is the only
		// consent for that. A browser rejects without a user gesture; this is
		// the terminal equivalent.
		if (!isAttached(attached[kTermDOM])) {
			return Promise.reject(
				new Error("requestFullscreen(): attach() the terminal first"),
			);
		}
		try {
			enterFullscreen(this);
		} catch (error) {
			return Promise.reject(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
		// The element's UA styles changed (it now fills the viewport) and
		// neither a mutation nor a focus move fired to notify the cascade.
		attached[kCascade].handleFocusChange(this);
		attached[kLayout].invalidate(this);
		// The screen switch happens on the next frame so no frame straddles it.
		// The promise resolves once that frame is written.
		return frameSettled(this[kDocument]!, attached);
	}

	hasAttributes(): boolean {
		return this[kAttributeList]!.length > 0;
	}

	getAttributeNames(): string[] {
		return this[kAttributeList]!.map((attribute) => attribute[kQualifiedName]!);
	}

	getAttribute(getQualifiedName: string): string | null {
		const attribute = getAttributeByName(this, String(getQualifiedName));
		return attribute === null ? null : attribute[kValue]!;
	}

	getAttributeNS(namespace: string | null, localName: string): string | null {
		const attribute = getAttributeByNamespace(
			this,
			namespace,
			String(localName),
		);
		return attribute === null ? null : attribute[kValue]!;
	}

	setAttribute(getQualifiedName: string, value: string): void {
		if (arguments.length < 2) {
			throw new TypeError("setAttribute needs a name and a value");
		}
		let name = String(getQualifiedName);
		validateAttributeLocalName(name);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
		) {
			name = toASCIILowercase(name);
		}
		const string = value === null ? "null" : String(value);
		for (const attribute of this[kAttributeList]!) {
			if (attribute[kQualifiedName] === name) {
				changeAttribute(attribute, string);
				return;
			}
		}
		const attribute = new Attr(null, null, name, string);
		attribute[kDocument] = this[kDocument]!;
		appendAttribute(this, attribute);
	}

	setAttributeNS(
		namespace: string | null,
		getQualifiedName: string,
		value: string,
	): void {
		if (arguments.length < 3) {
			throw new TypeError("setAttributeNS needs a namespace, name and value");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(getQualifiedName),
			true,
		);
		setAttributeValue(
			this,
			extracted.localName,
			value === null ? "null" : String(value),
			extracted.prefix,
			extracted.namespace,
		);
	}

	removeAttribute(getQualifiedName: string): void {
		const attribute = getAttributeByName(this, String(getQualifiedName));
		if (attribute !== null) {
			removeAttributeNode(this, attribute);
		}
	}

	removeAttributeNS(namespace: string | null, localName: string): void {
		const attribute = getAttributeByNamespace(
			this,
			namespace,
			String(localName),
		);
		if (attribute !== null) {
			removeAttributeNode(this, attribute);
		}
	}

	toggleAttribute(getQualifiedName: string, force?: boolean): boolean {
		let name = String(getQualifiedName);
		validateAttributeLocalName(name);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
		) {
			name = toASCIILowercase(name);
		}
		const attribute = getAttributeByName(this, name);
		if (attribute === null) {
			if (force === undefined || force === true) {
				const created = new Attr(null, null, name, "");
				created[kDocument] = this[kDocument]!;
				appendAttribute(this, created);
				return true;
			}
			return false;
		}
		if (force === undefined || force === false) {
			removeAttributeNode(this, attribute);
			return false;
		}
		return true;
	}

	hasAttribute(getQualifiedName: string): boolean {
		let name = String(getQualifiedName);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
		) {
			name = toASCIILowercase(name);
		}
		for (const attribute of this[kAttributeList]!) {
			if (attribute[kQualifiedName] === name) {
				return true;
			}
		}
		return false;
	}

	hasAttributeNS(namespace: string | null, localName: string): boolean {
		return getAttributeByNamespace(this, namespace, String(localName)) !== null;
	}

	getAttributeNode(getQualifiedName: string): globalThis.Attr | null {
		return getAttributeByName(
			this,
			String(getQualifiedName),
		) as unknown as globalThis.Attr |
		null;
	}

	getAttributeNodeNS(
		namespace: string | null,
		localName: string,
	): globalThis.Attr | null {
		return getAttributeByNamespace(
			this,
			namespace,
			String(localName),
		) as unknown as globalThis.Attr |
		null;
	}

	setAttributeNode(attr: globalThis.Attr): globalThis.Attr | null {
		if (!(attr instanceof Attr)) {
			throw new TypeError("That is not an Attr");
		}
		return setAttributeNode(this, attr) as unknown as globalThis.Attr | null;
	}

	setAttributeNodeNS(attr: globalThis.Attr): globalThis.Attr | null {
		if (!(attr instanceof Attr)) {
			throw new TypeError("That is not an Attr");
		}
		return setAttributeNode(this, attr) as unknown as globalThis.Attr | null;
	}

	removeAttributeNode(attr: globalThis.Attr): globalThis.Attr {
		if (!(attr instanceof Attr)) {
			throw new TypeError("That is not an Attr");
		}
		if (!this[kAttributeList]!.includes(attr)) {
			throw notFoundError("That attribute is not on this element");
		}
		removeAttributeNode(this, attr);
		return attr as unknown as globalThis.Attr;
	}

	getElementsByTagName<K extends keyof globalThis.HTMLElementTagNameMap>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.HTMLElementTagNameMap[K]>;
	getElementsByTagName<K extends keyof globalThis.SVGElementTagNameMap>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.SVGElementTagNameMap[K]>;
	getElementsByTagName<K extends keyof globalThis.MathMLElementTagNameMap>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.MathMLElementTagNameMap[K]>;
	getElementsByTagName<
		K extends keyof globalThis.HTMLElementDeprecatedTagNameMap,
	>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.HTMLElementDeprecatedTagNameMap[K]>;
	getElementsByTagName(getQualifiedName: string): HTMLCollectionOf<
		globalThis.Element
	>;
	getElementsByTagName(getQualifiedName: string): HTMLCollectionOf<
		globalThis.Element
	> {
		return createTagNameCollection(
			this,
			String(getQualifiedName),
		) as unknown as HTMLCollectionOf<globalThis.Element>;
	}

	getElementsByTagNameNS(
		namespaceURI: "http://www.w3.org/1999/xhtml",
		localName: string,
	): HTMLCollectionOf<globalThis.HTMLElement>;
	getElementsByTagNameNS(
		namespaceURI: "http://www.w3.org/2000/svg",
		localName: string,
	): HTMLCollectionOf<globalThis.SVGElement>;
	getElementsByTagNameNS(
		namespaceURI: "http://www.w3.org/1998/Math/MathML",
		localName: string,
	): HTMLCollectionOf<globalThis.MathMLElement>;
	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollectionOf<globalThis.Element>;
	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollectionOf<globalThis.Element> {
		return createTagNameNSCollection(
			this,
			namespace,
			String(localName),
		) as unknown as HTMLCollectionOf<globalThis.Element>;
	}

	getElementsByClassName(
		classNames: string,
	): HTMLCollectionOf<globalThis.Element> {
		return createClassNameCollection(
			this,
			String(classNames),
		) as unknown as HTMLCollectionOf<globalThis.Element>;
	}

	getHTML(options?: globalThis.GetHTMLOptions): string {
		const init = toDictionary<{
			serializableShadowRoots?: boolean;
			shadowRoots?: ShadowRoot[];
		}>(options ?? {}, "A GetHTMLOptions");
		return serializeFragment(
			getMarkupHost(this),
			Boolean(init.serializableShadowRoots),
			init.shadowRoots ?? [],
		);
	}

	setHTMLUnsafe(html: string): void {
		const fragment = parseHTMLFragment(String(html ?? ""), this, true);
		replaceAll(fragment, getMarkupHost(this));
	}

	insertAdjacentElement(
		where: InsertPosition,
		element: globalThis.Element,
	): globalThis.Element | null {
		return insertAdjacent(
			this,
			String(where),
			element as unknown as Element,
		) as unknown as globalThis.Element | null;
	}

	insertAdjacentText(where: InsertPosition, data: string): void {
		const text = new Text(String(data));
		text[kDocument] = this[kDocument]!;
		insertAdjacent(this, String(where), text);
	}

	insertAdjacentHTML(position: string, text: string): void {
		const where = toASCIILowercase(String(position));
		let context: Node;
		switch (where) {
			case "beforebegin":
			case "afterend": {
				const parent = this[kParent]!;
				if (parent === null || parent.nodeType === DOCUMENT_NODE) {
					throw domError(
						"NoModificationAllowedError",
						"There is nowhere to insert that HTML",
					);
				}
				context =
					parent.nodeType === ELEMENT_NODE
						? parent
						: createElementInternal(this[kDocument]!, "body", HTML_NAMESPACE);
				break;
			}
			case "afterbegin":
			case "beforeend":
				context = this;
				break;
			default:
				throw domError("SyntaxError", `"${position}" is not a position`);
		}
		let element = context as Element;
		if (
			element.nodeType !== ELEMENT_NODE ||
			(isHTMLDocument(element[kDocument]!) &&
				element[kLocalName] === "html" &&
				element[kNamespace] === HTML_NAMESPACE)
		) {
			element = createElementInternal(this[kDocument]!, "body", HTML_NAMESPACE);
		}
		const fragment = parseHTMLFragment(String(text), element);
		switch (where) {
			case "beforebegin":
				preInsert(fragment, this[kParent]! as Node, this);
				break;
			case "afterbegin":
				preInsert(fragment, this, this[kFirstChild]!);
				break;
			case "beforeend":
				preInsert(fragment, this, null);
				break;
			case "afterend":
				preInsert(fragment, this[kParent]! as Node, this[kNext]!);
				break;
		}
	}

	// The Typed OM is not implemented. Every computed value here is a
	// string, and returning a CSSStyleValue would mean parsing into a type
	// nothing else here uses.
	computedStyleMap(): never {
		throw domError(
			"NotSupportedError",
			"Typed OM is not implemented; use getComputedStyle",
		);
	}

	// Web Animations needs a timeline, and this engine has none. Frames come
	// from terminal input and layout invalidation, not from a clock a running
	// animation could sample.
	animate(): never {
		throw domError(
			"NotSupportedError",
			"Web Animations is not implemented",
		);
	}

	getAnimations(): globalThis.Animation[] {
		return [];
	}

	hasPointerCapture(_pointerId: number): boolean {
		return false;
	}

	// Pointer capture and pointer lock both need a pointer that keeps
	// reporting after it leaves a box. A terminal reports the cell the mouse
	// is over and stops at the screen edge, so there is nothing to capture
	// and nowhere to lock to.
	setPointerCapture(_pointerId: number): never {
		throw domError("NotSupportedError", "Pointer capture is not implemented");
	}

	releasePointerCapture(_pointerId: number): never {
		throw domError("NotSupportedError", "Pointer capture is not implemented");
	}

	requestPointerLock(): never {
		throw domError("NotSupportedError", "Pointer lock is not implemented");
	}

	/** An assigned slottable returns its slot instead of its parent. */
	override [kGetTheParent]?(_event: Event): EventTarget | null {
		return this[kAssignedSlot] ?? this[kParent]!;
	}

	override [kInsertionSteps]?(): void {
		const root = getRoot(this);
		if (root.nodeType === DOCUMENT_NODE) {
			addToIdMap(root as Document, this);
		}
		// The steps run once for every element of an inserted tree, so this
		// element only claims itself.
		if (this[kRegistry] === null && root[kRegistry] !== null) {
			this[kRegistry] = root[kRegistry]!;
			tryToUpgrade(this);
		}
		resetTheFormOwner(this);
		syncFormDisabled(this);
		// A form that joins a tree becomes the owner of everything already in
		// the tree that names it, and a fieldset applies its disabling to what
		// it contains.
		if (
			this instanceof HTMLFormElement ||
			this instanceof HTMLFieldSetElement
		) {
			resetFormOwners(root);
		}
	}

	override [kRemovingSteps]?(oldParent: Node): void {
		const root = getRoot(oldParent);
		if (root.nodeType === DOCUMENT_NODE) {
			removeFromIdMap(root as Document, this);
		}
		resetFormOwners(this);
		if (
			this instanceof HTMLFormElement ||
			this instanceof HTMLFieldSetElement
		) {
			resetFormOwners(root);
		}
	}

	[kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		if (localName === "class" && namespace === null) {
			this[kClassTokens] = null;
		}
		if (localName === "id" && namespace === null) {
			const root = getRoot(this);
			if (root.nodeType === DOCUMENT_NODE) {
				const document = root as Document;
				if (oldValue !== null) {
					removeIdEntry(document, oldValue, this);
				}
				if (value !== null && value !== "") {
					addIdEntry(document, value, this);
				}
			}
		}
		if (namespace === null && localName === "slot") {
			updateSlottableName(this, oldValue, value);
		}
		if (
			namespace === null &&
			localName === "name" &&
			this instanceof HTMLSlotElement
		) {
			updateSlotName(this, oldValue, value);
		}
		if (namespace === null && (localName === "form" || localName === "id")) {
			resetFormOwners(getRoot(this));
		}
		if (namespace === null && localName === "disabled") {
			syncFormDisabled(this);
			if (this instanceof HTMLFieldSetElement) {
				for (const node of descendants(this)) {
					if (node.nodeType === ELEMENT_NODE) {
						syncFormDisabled(node as Element);
					}
				}
			}
		}
		if (this[kCustomState] === "custom") {
			enqueueCallbackReaction(this, "attributeChangedCallback", [
				localName,
				oldValue,
				value,
				namespace,
			]);
		}
		syncUAShadowTree(this);
	}

	override [kCloneSingle]?(document: Document): Node {
		const copy = createElementInternal(
			document,
			this[kLocalName]!,
			this[kNamespace]!,
			this[kPrefix]!,
			this[kIsValue]!,
			false,
			document === this[kDocument]! ? this[kRegistry]! : undefined,
		);
		for (const attribute of this[kAttributeList]!) {
			const copiedAttribute = new Attr(
				attribute[kNamespace]!,
				attribute[kPrefix]!,
				attribute[kLocalName]!,
				attribute[kValue]!,
			);
			copiedAttribute[kDocument] = document;
			appendAttribute(copy, copiedAttribute);
		}
		return copy;
	}
}

/** The scroll offsets of every box that has been scrolled. */
const scrollOffsets = new WeakMap<
	globalThis.Element,
	{left: number; top: number}
>();

/**
 * The members the tables and the engine give an element, which installing
 * them says nothing about: the mixins, the reflected members, and the
 * geometry the engine measures. Declared with Pick so a declaration
 * cannot drift from the member it stands for. The two written out are
 * exceptions: a Pick would make them properties, and subclasses declare
 * each as a method.
 */
export interface Element
	extends Pick<
		globalThis.Element,
		// `remove` and `scrollIntoView` are written out below rather than
		// Picked. A Pick yields a property, and subclasses declare each of them
		// as a method, which cannot override a property.
		Exclude<ChildNodeMixin, "remove"> |
		ParentNodeMixin |
		SelectorSurface |
		FullscreenSurface |
		"part" |
		"checkVisibility" |
		"clientWidth" |
		"clientHeight" |
		"scrollWidth" |
		"scrollHeight" |
		"clientLeft" |
		"clientTop" |
		"scrollIntoView" |
		Extract<keyof globalThis.Element, ARIAReflection>
	> {
	remove(): void;

	get ownerDocument(): Document;
}

Object.defineProperty(Element.prototype, Symbol.toStringTag, {
	value: "Element",
	configurable: true,
});

function elementMatches(this: Element, selectors: string): boolean {
	if (arguments.length < 1) {
		throw new TypeError("matches needs a selector");
	}
	try {
		return matchesSelector(this, String(selectors), {scope: this});
	} catch (error) {
		throw asSyntaxError(error);
	}
}

Object.defineProperties(Element.prototype, {
	matches: {
		value: elementMatches,
		configurable: true,
		enumerable: true,
		writable: true,
	},
	webkitMatchesSelector: {
		value: elementMatches,
		configurable: true,
		enumerable: true,
		writable: true,
	},
	closest: {
		value(this: Element, selectors: string): Element | null {
			if (arguments.length < 1) {
				throw new TypeError("closest needs a selector");
			}
			try {
				// `:scope` refers to the element closest() was called on, for
				// every ancestor it tries.
				return closestSelector(this, String(selectors), {scope: this});
			} catch (error) {
				throw asSyntaxError(error);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	// How far a box is scrolled from its content origin. html and body scroll
	// the document itself, so their offset is the document scroll's. On a
	// headless document a write is stored and read back but moves nothing.
	scrollLeft: {
		get(this: Element): number {
			return isDocumentScroller(this)
				? 0
				: (scrollOffsets.get(this)?.left ?? 0);
		},
		set(this: Element, value: number) {
			setScrollOffset(this, "left", value);
		},
		configurable: true,
		enumerable: true,
	},
	scrollTop: {
		get(this: Element): number {
			const attached = isDocumentScroller(this)
				? getAttachedDocument(this)
				: undefined;
			return attached
				? attached[kScreen].scrollTop
				: (scrollOffsets.get(this)?.top ?? 0);
		},
		set(this: Element, value: number) {
			setScrollOffset(this, "top", value);
		},
		configurable: true,
		enumerable: true,
	},
	// scrollTo/scroll/scrollBy, in both argument forms. Assignment through the
	// accessors above does the rounding, clamping and repainting. html and
	// body's scrollTop maps to the terminal's document scroll, so scrolling
	// them scrolls the document.
	scrollTo: {
		value: scrollElementTo,
		configurable: true,
		enumerable: true,
		writable: true,
	},
	scroll: {
		value: scrollElementTo,
		configurable: true,
		enumerable: true,
		writable: true,
	},
	scrollBy: {
		value(
			this: Element,
			xOrOptions?: number | globalThis.ScrollToOptions,
			y?: number,
		): void {
			const target = getScrollTarget(xOrOptions, y);
			if (target.left) {
				this.scrollLeft = this.scrollLeft + target.left;
			}
			if (target.top) {
				this.scrollTop = this.scrollTop + target.top;
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
});

function createRectList(
	rects: readonly globalThis.DOMRect[],
): globalThis.DOMRectList {
	const list = new DOMRectList();
	list.push(...rects);
	return list;
}

// An empty set gives a zero rect at the origin, which is what both public
// APIs return for no geometry.
function unionRect(
	rects: readonly globalThis.DOMRect[],
): globalThis.DOMRect {
	if (rects.length === 0) {
		return new DOMRect();
	}
	let left = Infinity;
	let top = Infinity;
	let right = -Infinity;
	let bottom = -Infinity;
	for (const rect of rects) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}
	return new DOMRect(left, top, right - left, bottom - top);
}

// Viewport-relative, as CSSOM View specifies: a box the document scroll has
// scrolled past reports a negative top. Layout works in document space
// and the renderer applies the document scroll once at paint, so this function
// subtracts the document scroll. It is the one place every client rect goes
// through. A position:fixed subtree is already laid out in viewport
// space, and per spec its client rect does not change with scroll.
function toViewportRect(
	attached: AttachedDocument,
	rect: globalThis.DOMRect,
	element: Element | null,
): globalThis.DOMRect {
	if (element !== null && attached[kLayout].isInFixedSpace(element)) {
		return rect;
	}
	return new DOMRect(
		rect.x,
		rect.y - attached[kScreen].scrollTop,
		rect.width,
		rect.height,
	);
}

// The geometry surface. The APIs are the DOM's, the measurements come from the
// layout, and the document scroll converts between them. Writable so a
// test can stub a measurement, as on the platform.
Object.defineProperties(Element.prototype, {
	getBoundingClientRect: {
		value(this: Element): globalThis.DOMRect {
			const attached = getAttachedDocument(this);
			if (attached === undefined || !this.isConnected) {
				return new DOMRect(0, 0, 0, 0);
			}
			flushLayout(this);
			return toViewportRect(
				attached,
				attached[kLayout].getRect(this) ?? new DOMRect(),
				this,
			);
		},
		writable: true,
		configurable: true,
	},
	getClientRects: {
		value(this: Element): globalThis.DOMRectList {
			const attached = getAttachedDocument(this);
			if (attached === undefined || !this.isConnected) {
				return new DOMRectList();
			}
			flushLayout(this);
			return createRectList(
				attached[kLayout]
					.getRects(this)
					.map((rect) => toViewportRect(attached, rect, this)),
			);
		},
		writable: true,
		configurable: true,
	},
});

const alreadyConstructed = Symbol("already constructed");

export class HTMLElement extends Element {
	// Installed on the prototype, where the engine that measures them is.
	declare readonly offsetWidth: number;
	declare readonly offsetHeight: number;
	declare readonly offsetTop: number;
	declare readonly offsetLeft: number;
	declare readonly offsetParent: globalThis.Element | null;
	declare readonly clientWidth: number;
	declare readonly clientHeight: number;
	declare readonly scrollWidth: number;
	declare readonly scrollHeight: number;
	declare checkVisibility: (
		options?: globalThis.CheckVisibilityOptions,
	) => boolean;

	constructor() {
		if (internalConstruction) {
			super();
			return;
		}
		// The checks run before allocation. A constructor that names no
		// definition throws without allocating anything, and an upgrade never
		// allocates: it returns the element already in the tree. So super()
		// runs only on the branch that builds a new element.
		const target = new.target as unknown as CustomElementConstructor;
		if (target === (HTMLElement as unknown as CustomElementConstructor)) {
			throw new TypeError("Illegal constructor");
		}
		const definition = getConstructorDefinition(target);
		if (definition === null) {
			throw new TypeError("This constructor is not a custom element's");
		}
		if (definition.localName !== definition.name) {
			throw new TypeError(
				"A customized built-in element is not implemented here",
			);
		}
		const stack = definition.constructionStack;
		if (stack.length > 0) {
			// A prototype that is not an object means the interface's own
			// prototype, which is what allocating from this constructor would
			// have given the element anyway.
			const named = (target as unknown as {prototype: unknown}).prototype;
			const prototype =
				named !== null && typeof named === "object"
					? (named as object)
					: HTMLElement.prototype;
			const element = stack[stack.length - 1];
			if (element === alreadyConstructed) {
				throw domError(
					"InvalidStateError",
					"That custom element is already being constructed",
				);
			}
			Object.setPrototypeOf(element, prototype);
			stack[stack.length - 1] = alreadyConstructed;

			return element as HTMLElement;
		}
		super();
		this[kNamespace] = HTML_NAMESPACE;
		this[kPrefix] = null;
		this[kLocalName] = definition.localName;
		this[kCustomState] = "custom";
		this[kDefinition] = definition;
		this[kIsValue] = null;
		this[kRegistry] = getDefinitionRegistry(definition);
	}

	get style(): globalThis.CSSStyleDeclaration {
		return getInlineStyle(this);
	}

	set style(value: unknown) {
		getInlineStyle(this).cssText = value == null ? "" : `${value}`;
	}

	// Inherited. An element that sets no mode takes its parent's, and the
	// root of a tree that sets none is translated.
	get translate(): boolean {
		const value = this.getAttribute("translate");
		if (value !== null) {
			const mode = toASCIILowercase(value);
			if (mode === "" || mode === "yes") {
				return true;
			}
			if (mode === "no") {
				return false;
			}
		}
		const parent = this[kParent]!;
		if (parent !== null && parent.nodeType === ELEMENT_NODE) {
			return (parent as HTMLElement).translate ?? true;
		}
		return true;
	}

	set translate(value: boolean) {
		this.setAttribute("translate", value ? "yes" : "no");
	}

	// An element that sets neither state falls back to the two elements HTML
	// makes draggable by default.
	get draggable(): boolean {
		const value = this.getAttribute("draggable");
		if (value !== null) {
			const state = toASCIILowercase(value);
			if (state === "true") {
				return true;
			}
			if (state === "false") {
				return false;
			}
		}
		if (this[kNamespace] !== HTML_NAMESPACE) {
			return false;
		}
		if (this[kLocalName] === "img") {
			return true;
		}
		return this[kLocalName] === "a" && this.hasAttribute("href");
	}

	set draggable(value: boolean) {
		this.setAttribute("draggable", value ? "true" : "false");
	}

	/** Inherited, like translate. */
	get spellcheck(): boolean {
		const value = this.getAttribute("spellcheck");
		if (value !== null) {
			const state = toASCIILowercase(value);
			if (state === "" || state === "true") {
				return true;
			}
			if (state === "false") {
				return false;
			}
		}
		const parent = this[kParent]!;
		if (parent !== null && parent.nodeType === ELEMENT_NODE) {
			return (parent as HTMLElement).spellcheck ?? true;
		}
		return true;
	}

	set spellcheck(value: boolean) {
		this.setAttribute("spellcheck", value ? "true" : "false");
	}

	get autocapitalize(): string {
		const value = this.getAttribute("autocapitalize");
		if (value === null) {
			return "";
		}
		const state = toASCIILowercase(value);
		if (state === "off" || state === "none") {
			return "none";
		}
		if (state === "on" || state === "sentences") {
			return "sentences";
		}
		if (state === "words" || state === "characters") {
			return state;
		}
		return "sentences";
	}

	set autocapitalize(value: string) {
		this.setAttribute("autocapitalize", String(value));
	}

	/** Every value except "off" means on. */
	get autocorrect(): boolean {
		const value = this.getAttribute("autocorrect");
		return value === null || toASCIILowercase(value) !== "off";
	}

	set autocorrect(value: boolean) {
		this.setAttribute("autocorrect", value ? "on" : "off");
	}

	get inert(): boolean {
		return this.hasAttribute("inert");
	}

	set inert(value: boolean) {
		if (value) {
			this.setAttribute("inert", "");
		} else {
			this.removeAttribute("inert");
		}
	}

	// Typed boolean, as lib.dom types it, even though the third state
	// returns "until-found". Browsers do the same: they implement the state
	// and their types still say boolean.
	get hidden(): boolean {
		const value = this.getAttribute("hidden");
		if (value === null) {
			return false;
		}
		return (
			toASCIILowercase(value) === "until-found" ? "until-found" : true
		) as boolean;
	}

	set hidden(value: boolean) {
		if (
			typeof value === "string" && toASCIILowercase(value) === "until-found"
		) {
			this.setAttribute("hidden", "until-found");
		} else if (value) {
			this.setAttribute("hidden", "");
		} else {
			this.removeAttribute("hidden");
		}
	}

	get contentEditable(): string {
		const value = this.getAttribute("contenteditable");
		if (value === null) {
			return "inherit";
		}
		const state = toASCIILowercase(value);
		if (state === "" || state === "true") {
			return "true";
		}
		if (state === "false") {
			return "false";
		}
		if (state === "plaintext-only") {
			return "plaintext-only";
		}
		return "inherit";
	}

	set contentEditable(value: string) {
		const state = toASCIILowercase(String(value));
		if (state === "inherit") {
			this.removeAttribute("contenteditable");
			return;
		}
		if (state !== "true" && state !== "false" && state !== "plaintext-only") {
			throw domError("SyntaxError", `"${value}" is not an editability`);
		}
		this.setAttribute("contenteditable", state);
	}

	get isContentEditable(): boolean {
		for (
			let node: Node | null = this;
			node !== null && node.nodeType === ELEMENT_NODE;
			node = node[kParent]!
		) {
			const state = (node as HTMLElement).contentEditable;
			if (state === "true" || state === "plaintext-only") {
				return true;
			}
			if (state === "false") {
				return false;
			}
		}
		return false;
	}

	// The default comes from the attribute's definition: zero for elements
	// that are in the tab order without an attribute, minus one for the
	// rest.
	get tabIndex(): number {
		const value = this.getAttribute("tabindex");
		const parsed = value === null ? null : parseInteger(value);
		if (parsed !== null && parsed >= -2147483648 && parsed <= 2147483647) {
			return parsed;
		}
		return getDefaultTabIndex(this);
	}

	set tabIndex(value: number) {
		this.setAttribute("tabindex", String(toLong(value)));
	}

	get dataset(): DOMStringMap {
		let map = this[kDataset]!;
		if (map === null) {
			map = new DOMStringMap(this);
			this[kDataset] = map;
		}
		syncDataset(map);
		return map;
	}

	// A terminal has no modifier convention to name the key with. A browser
	// also returns empty when it has nothing to report.
	get accessKeyLabel(): string {
		return "";
	}

	// The RENDERED text, which differs from textContent: it respects
	// display, collapses white space and inserts the line breaks layout
	// chose. This engine computes all of that, but reading it back through
	// this property is not wired up.
	get innerText(): string {
		throw domError("NotSupportedError", "innerText is not implemented");
	}

	set innerText(_value: string) {
		throw domError("NotSupportedError", "innerText is not implemented");
	}

	get outerText(): string {
		throw domError("NotSupportedError", "outerText is not implemented");
	}

	set outerText(_value: string) {
		throw domError("NotSupportedError", "outerText is not implemented");
	}

	get attributeStyleMap(): globalThis.StylePropertyMap {
		throw domError("NotSupportedError", "Typed OM is not implemented");
	}

	// The event is a pointer event and untrusted, so a listener can tell it
	// from a real one, and dispatch runs whatever activation behavior it
	// reaches. A disabled form control is not clicked at all.
	click(): void {
		if (isActuallyDisabled(this)) {
			return;
		}
		if (this[kClickInProgress]!) {
			return;
		}
		this[kClickInProgress] = true;
		try {
			const event = new PointerEvent("click", {
				bubbles: true,
				cancelable: true,
				composed: true,
			});
			dispatch(this, event, false);
		} finally {
			this[kClickInProgress] = false;
		}
	}

	attachInternals(): globalThis.ElementInternals {
		return attachElementInternals(
			this,
		) as unknown as globalThis.ElementInternals;
	}

	// Moves the focus STATE and fires the four events HTML's focus update
	// steps fire. A headless document paints nothing, so it only moves the
	// state.
	focus(): void {
		const document = this[kDocument]!;
		const previous = getInnermostActive(document);
		// Uses shadow-including connectedness. A node whose tree root is a
		// shadow root is focusable when its host chain reaches the document.
		// The node-tree root test rejected every element in a shadow tree.
		if (isFocusableArea(this) && this.isConnected) {
			document[kActiveElement] = this;
		}
		if (previous === this || getInnermostActive(document) !== this) {
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		// :focus rules match live and a focus move is not a mutation, so both
		// elements' resolved styles are stale whether or not a listener changes
		// anything.
		attached[kCascade].handleFocusChange(previous, this);
		attached[kScreen].invalidate();
		void render(attached[kTermDOM]);
		// The body holds focus whenever nothing else does, so moving focus off
		// the body fires no blur.
		if (previous !== null && previous !== (document.body as unknown)) {
			dispatchAsUserAgent(
				previous,
				new FocusEvent("blur", {relatedTarget: this, bubbles: false}),
			);
			dispatchAsUserAgent(
				previous,
				new FocusEvent("focusout", {relatedTarget: this, bubbles: true}),
			);
		}
		dispatchAsUserAgent(
			this,
			new FocusEvent("focus", {relatedTarget: previous, bubbles: false}),
		);
		dispatchAsUserAgent(
			this,
			new FocusEvent("focusin", {relatedTarget: previous, bubbles: true}),
		);
	}

	blur(): void {
		const document = this[kDocument]!;
		const wasFocused = getInnermostActive(document) === this;
		if (document[kActiveElement] === this) {
			document[kActiveElement] = null;
		}
		const attached = wasFocused ? getAttachedDocument(this) : undefined;
		if (attached === undefined) {
			return;
		}
		attached[kCascade].handleFocusChange(this, null);
		attached[kScreen].invalidate();
		void render(attached[kTermDOM]);
		dispatchAsUserAgent(
			this,
			new FocusEvent("blur", {relatedTarget: null, bubbles: false}),
		);
		dispatchAsUserAgent(
			this,
			new FocusEvent("focusout", {relatedTarget: null, bubbles: true}),
		);
	}

	// Adds the element to the top layer, above everything else the document
	// paints, and the UA sheet stops hiding it.
	showPopover(options?: {source?: Element | null}): void {
		const init =
			options === undefined
				? {}
				: toDictionary<{source?: Element | null}>(options, "Show options");
		showPopover(this, true, init.source ?? null);
	}

	hidePopover(): void {
		hidePopover(this, true, true, true, null);
	}

	// force: true only ever shows and force: false only ever hides, so a
	// caller that knows the state it wants can say so.
	togglePopover(
		options?: boolean | {force?: boolean; source?: Element | null},
	): boolean {
		let force: boolean | null = null;
		let source: Element | null = null;
		if (typeof options === "boolean") {
			force = options;
		} else if (options !== undefined) {
			const init = toDictionary<{force?: boolean; source?: Element | null}>(
				options,
				"Toggle options",
			);
			if (init.force !== undefined) {
				force = Boolean(init.force);
			}
			source = init.source ?? null;
		}
		const showing = isShowingPopover(this);
		if (showing && force !== true) {
			hidePopover(this, true, true, true, null);
		} else if (!showing && force !== false) {
			showPopover(this, true, source);
		} else {
			// Neither half runs, but the state still has to be legal. Toggling
			// something that is not a popover throws either way.
			const validity = checkPopoverValidity(this, showing, null);
			if (isPopoverException(validity)) {
				throw validity;
			}
		}
		return isShowingPopover(this);
	}

	// A popover whose attribute changes state is no longer the popover it
	// was showing as, so it closes. It closes silently, because the author
	// who changed the attribute is not asking to be told about the old
	// popover.
	override [kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChangeSteps]!(localName, oldValue, value, namespace);
		if (namespace !== null || localName !== "popover") {
			return;
		}
		if (getPopoverValueState(oldValue) === getPopoverValueState(value)) {
			return;
		}
		if (!isShowingPopover(this)) {
			return;
		}
		hidePopover(this, true, true, false, null);
	}

	// The top layer holds nothing that is off the tree, and there is no page
	// for the popover to be above anymore.
	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		if (!isShowingPopover(this)) {
			return;
		}
		const state = getPopoverState(this);
		getTopLayer(this[kDocument]!).delete(this);
		state.visibility = "hidden";
		state.mode = null;
		state.trigger = null;
		state.previouslyFocused = null;
		popoverStateChanged(this);
	}
}

// document.activeElement retargets through the host chain, so a focus
// move inside a shadow tree is invisible through it. The raw state is at
// the bottom of each root's own activeElement chain.
function getInnermostActive(document: Document): Element | null {
	let current = document.activeElement as unknown as Element | null;
	while (current !== null) {
		const inner = (current[kShadowRoot]?.activeElement ??
			null) as unknown as Element | null;
		if (inner === null) {
			break;
		}
		current = inner;
	}
	return current;
}

// A tabindex attribute makes any element focusable whatever its value.
// A negative value only removes the element from sequential navigation,
// not from focus(). Elements focusable without an attribute say so
// through their default tabindex. A disabled control is focusable by
// neither route.
function isFocusableArea(element: Element): boolean {
	if (isActuallyDisabled(element)) {
		return false;
	}
	if (isInertTree(element)) {
		return false;
	}
	if (element.hasAttribute("tabindex")) {
		return true;
	}
	if (element.hasAttribute("contenteditable")) {
		return true;
	}
	return getDefaultTabIndex(element) >= 0;
}

Object.defineProperty(HTMLElement.prototype, Symbol.toStringTag, {
	value: "HTMLElement",
	configurable: true,
});

/**
 * The members the tables and the cascade give an HTML element: the event
 * handler attributes, the reflected attributes, and `style`, which the
 * cascade installs when it loads.
 */
export interface HTMLElement
	extends Pick<
		globalThis.HTMLElement,
		Extract<keyof globalThis.HTMLElement, `on${string}`> |
		"accessKey" |
		"autofocus" |
		"dir" |
		"enterKeyHint" |
		"inputMode" |
		"lang" |
		"nonce" |
		"popover" |
		"title" |
		"writingSuggestions" |
		"style"
	> {}

// Settles everything a geometry read must see: pending mutation records
// are delivered and the layout they invalidated is recomputed. Returns
// undefined when there is nothing to measure (a headless document, or an
// element outside one), and every caller then falls back to the zero the
// spec gives an element with no box.
function getSettledLayout(element: Element): Layout | undefined {
	const attached = getAttachedDocument(element);
	if (attached === undefined || !element.isConnected) {
		return undefined;
	}
	flushLayout(element);
	return attached[kLayout];
}

Object.defineProperties(HTMLElement.prototype, {
	offsetWidth: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.offsetSize(this).width ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetHeight: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.offsetSize(this).height ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetTop: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.offsetPosition(this).top ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetLeft: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.offsetPosition(this).left ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	// This walk reads style, not geometry, so it does not flush layout,
	// unlike every other member around it.
	offsetParent: {
		get(this: HTMLElement): Element | null {
			const attached = getAttachedDocument(this);
			if (attached === undefined) {
				return null;
			}
			return attached[kLayout].offsetParent(this) as Element | null;
		},
		configurable: true,
		enumerable: true,
	},
	clientWidth: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.clientSize(this).width ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	clientHeight: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.clientSize(this).height ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	// The border widths, which only the cascade decides.
	clientLeft: {
		get(this: HTMLElement): number {
			return getBoxModel(this).borderLeftWidth;
		},
		configurable: true,
		enumerable: true,
	},
	clientTop: {
		get(this: HTMLElement): number {
			return getBoxModel(this).borderTopWidth;
		},
		configurable: true,
		enumerable: true,
	},
	scrollWidth: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.scrollSize(this).width ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	scrollHeight: {
		get(this: HTMLElement): number {
			return getSettledLayout(this)?.scrollSize(this).height ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	// Reveals the element: every scroll box between it and the document
	// scrolls it into view, and so does the screen. A headless document shows
	// nothing, so there is nothing to reveal. The options are ignored; every
	// move is the minimal one, block "nearest".
	scrollIntoView: {
		value(this: HTMLElement): void {
			const attached = getAttachedDocument(this);
			if (attached === undefined || !this.isConnected) {
				return;
			}
			flushLayout(this);
			attached[kLayout].revealInScrollPorts(this);
			// The scroll boxes around the element have already revealed it
			// within themselves. What remains is the document scroll, which
			// shows [scrollTop, scrollTop + region). Move it the minimal
			// amount, the standard block: "nearest" behavior. The rect is
			// document-relative, so it compares directly against the document
			// scroll offset.
			const rect = attached[kLayout].getRect(this);
			if (!rect) {
				return;
			}
			const document = this[kDocument]!;
			const flow = attached[kLayout].getRect(document.documentElement);
			const regionHeight =
				getFullscreenElement(document) !== null
					? attached[kScreen].rows
					: Math.min(
						attached[kScreen].rows,
						flow ? Math.ceil(flow.height) : 0,
					);
			const top = attached[kScreen].scrollTop;
			if (rect.top < top) {
				attached[kScreen].scrollTo(rect.top);
				void render(attached[kTermDOM]);
			} else if (rect.bottom > top + regionHeight) {
				attached[kScreen].scrollTo(rect.bottom - regionHeight);
				void render(attached[kTermDOM]);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	// Uses the same definition as the focus walk: a rendered element
	// (nothing on its flat chain is display:none, and it produced boxes),
	// plus the visibility check the options ask for. Nothing in a headless
	// document is rendered.
	checkVisibility: {
		value(
			this: HTMLElement,
			options?: globalThis.CheckVisibilityOptions,
		): boolean {
			const attached = getAttachedDocument(this);
			if (attached === undefined || !this.isConnected) {
				return false;
			}
			const view = this.ownerDocument!.defaultView as unknown as {
				getComputedStyle(element: object): {
					display: string;
					visibility: string;
				};
			};
			for (
				let ancestor: Element | null = this;
				ancestor !== null;
				ancestor = flatParentElement<Element>(ancestor)
			) {
				if (view.getComputedStyle(ancestor).display === "none") {
					return false;
				}
			}
			if (
				(options?.checkVisibilityCSS || options?.visibilityProperty) &&
				view.getComputedStyle(this).visibility !== "visible"
			) {
				return false;
			}
			return attached[kLayout].getRects(this).length > 0;
		},
		writable: true,
		configurable: true,
		enumerable: true,
	},
});

// Inert removes an element from every focusable area, so focus() refuses
// it and the focus walk skips it, wherever in a shadow tree it is.
function isInertTree(element: Element): boolean {
	let node: Element | null = element;
	while (node !== null) {
		if (node.hasAttribute("inert")) {
			return true;
		}
		const parent = node.parentElement as unknown as Element | null;
		if (parent !== null) {
			node = parent;
			continue;
		}
		const root = getRoot(node);
		node = isShadowRoot(root)
			? ((root as ShadowRoot)[kHost]! as Element)
			: null;
	}
	return false;
}

// Zero for elements that are in the sequential focus navigation order
// without an attribute, minus one for every other element.
function getDefaultTabIndex(element: Element): number {
	if (element[kNamespace] !== HTML_NAMESPACE) {
		return -1;
	}
	switch (element[kLocalName]!) {
		case "a":
		case "area":
		case "button":
		case "frame":
		case "iframe":
		case "input":
		case "object":
		case "select":
		case "textarea":
			return 0;
		case "summary": {
			const parent = element[kParent]!;
			return parent !== null &&
				parent.nodeType === ELEMENT_NODE &&
				(parent as Element)[kNamespace] === HTML_NAMESPACE &&
				(parent as Element)[kLocalName] === "details" &&
				getFirstChildElement(parent, "summary") === element
				? 0
				: -1;
		}
		default:
			return -1;
	}
}

function getFirstChildElement(parent: Node, localName: string): Element | null {
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = node as Element;
		if (
			element[kNamespace] === HTML_NAMESPACE &&
			element[kLocalName] === localName
		) {
			return element;
		}
	}
	return null;
}

class HTMLUnknownElement extends HTMLElement {}

Object.defineProperty(HTMLUnknownElement.prototype, Symbol.toStringTag, {
	value: "HTMLUnknownElement",
	configurable: true,
});

export class SVGElement extends Element {
	get style(): globalThis.CSSStyleDeclaration {
		return getInlineStyle(this);
	}

	set style(value: unknown) {
		getInlineStyle(this).cssText = value == null ? "" : `${value}`;
	}
}

Object.defineProperty(SVGElement.prototype, Symbol.toStringTag, {
	value: "SVGElement",
	configurable: true,
});

class MathMLElement extends Element {}

Object.defineProperty(MathMLElement.prototype, Symbol.toStringTag, {
	value: "MathMLElement",
	configurable: true,
});

function getMarkupHost(element: Element): Node {
	return element instanceof HTMLTemplateElement ? element.content : element;
}

function setAttributeValue(
	element: Element,
	localName: string,
	value: string,
	prefix: string | null,
	namespace: string | null,
): void {
	const attribute = getAttributeByNamespace(element, namespace, localName);
	if (attribute === null) {
		const created = new Attr(namespace, prefix, localName, value);
		created[kDocument] = element[kDocument]!;
		appendAttribute(element, created);
		return;
	}
	changeAttribute(attribute, value);
}

function getElementInterface(
	namespace: string | null,
	localName: string,
): new () => Element {
	const builtin = builtinRegistry.lookup(namespace, localName);
	if (builtin !== null) {
		return builtin;
	}
	if (namespace === HTML_NAMESPACE) {
		return isValidCustomElementName(localName)
			? HTMLElement
			: HTMLUnknownElement;
	}
	if (namespace === SVG_NAMESPACE) {
		return SVGElement;
	}
	if (namespace === MATHML_NAMESPACE) {
		return MathMLElement;
	}
	return Element;
}

function buildElement(
	document: Document,
	constructor: new () => Element,
	localName: string,
	namespace: string | null,
	prefix: string | null,
	is: string | null,
): Element {
	const previousDocument = currentDocumentForConstruction;
	const previousInternal = internalConstruction;
	currentDocumentForConstruction = document;
	internalConstruction = true;
	let element: Element;
	try {
		element = new constructor();
	} finally {
		currentDocumentForConstruction = previousDocument;
		internalConstruction = previousInternal;
	}
	element[kDocument] = document;
	element[kNamespace] = namespace;
	element[kPrefix] = prefix;
	element[kLocalName] = localName;
	element[kIsValue] = is;
	return element;
}

// With the synchronous flag (createElement and its kin), the author's
// constructor runs here and the result is checked to be a bare element of
// the right name. Without it (the parser), the element is created
// undefined and an upgrade reaction is queued, so the parser never
// re-enters script.
function createElementInternal(
	document: Document,
	localName: string,
	namespace: string | null,
	prefix: string | null = null,
	is: string | null = null,
	synchronous = true,
	registry: CustomElementRegistry | null | undefined = undefined,
): Element {
	const inRegistry = registry === undefined ? document[kRegistry]! : registry;
	const definition = lookUpCustomElementDefinition(
		inRegistry,
		namespace,
		localName,
		is,
	);
	if (definition !== null && definition.name !== definition.localName) {
		throw domError(
			"NotSupportedError",
			"A customized built-in element is not implemented here",
		);
	}
	if (definition !== null) {
		if (!synchronous) {
			const element = buildElement(
				document,
				getElementInterface(namespace, localName),
				localName,
				namespace,
				prefix,
				is,
			);
			element[kRegistry] = inRegistry;
			element[kCustomState] = "undefined";
			enqueueUpgradeReaction(element, definition);
			return element;
		}
		let result: Element;
		try {
			result = constructCustomElement(definition);
			if (result[kCustomState] !== "custom" || result[kDefinition] === null) {
				throw new TypeError("That constructor did not build a custom element");
			}
			if (result[kAttributeList]!.length > 0) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not set attributes",
				);
			}
			if (result[kFirstChild] !== null) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not append children",
				);
			}
			if (result[kParent] !== null) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not insert the element",
				);
			}
			if (result[kDocument] !== document) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not change the node document",
				);
			}
			if (result[kNamespace] !== HTML_NAMESPACE) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not change the namespace",
				);
			}
			if (result[kLocalName] !== localName) {
				throw domError(
					"NotSupportedError",
					"A custom element constructor may not change the local name",
				);
			}
		} catch (error) {
			reportError(error);
			const failed = buildElement(
				document,
				getElementInterface(namespace, localName),
				localName,
				namespace,
				prefix,
				null,
			);
			failed[kRegistry] = inRegistry;
			failed[kCustomState] = "failed";
			return failed;
		}
		result[kPrefix] = prefix;
		result[kIsValue] = null;
		result[kRegistry] = inRegistry;
		return result;
	}
	const element = buildElement(
		document,
		getElementInterface(namespace, localName),
		localName,
		namespace,
		prefix,
		is,
	);
	element[kRegistry] = inRegistry;
	element[kCustomState] =
		namespace === HTML_NAMESPACE &&
		(isValidCustomElementName(localName) || is !== null)
			? "undefined"
			: "uncustomized";
	return element;
}

const RESERVED_CUSTOM_NAMES = new Set([
	"annotation-xml",
	"color-profile",
	"font-face",
	"font-face-src",
	"font-face-uri",
	"font-face-format",
	"font-face-name",
	"missing-glyph",
]);

// Must start with a lower-case letter, contain a hyphen, contain no
// upper-case letter, and not be one of the hyphenated names SVG and
// MathML define.
function isValidCustomElementName(name: string): boolean {
	return (
		VALID_ELEMENT_LOCAL_NAME.test(name) &&
		name.charCodeAt(0) >= 0x61 &&
		name.charCodeAt(0) <= 0x7a &&
		!/[A-Z]/.test(name) &&
		name.includes("-") &&
		!RESERVED_CUSTOM_NAMES.has(name)
	);
}

type CustomElementConstructor = new () => Element;

interface CustomElementDefinition {
	registry: CustomElementRegistry;
	name: string;
	localName: string;
	constructor: CustomElementConstructor;
	observedAttributes: Set<string>;
	lifecycleCallbacks: Map<string, ((...args: unknown[]) => void) | null>;
	constructionStack: Array<Element | typeof alreadyConstructed>;
	formAssociated: boolean;
	disableInternals: boolean;
	disableShadow: boolean;
}

type Reaction =
	{upgrade: CustomElementDefinition} |
	{callback: (...args: unknown[]) => void; args: unknown[]};

// Author code must see a lifecycle callback after the mutation that
// caused it finishes, never in the middle of it. A queue is pushed when
// an API marked [CEReactions] in the IDL is entered and drained when it
// returns, so a script that appends a subtree gets one connectedCallback
// per element, in tree order, after the whole subtree is in place.
const reactionsStack: Element[][] = [];

// Where a reaction goes when nothing on the stack claims it, meaning a
// mutation the tree makes on its own. The queue drains on a microtask,
// and the flag stops a reaction queued by that drain from starting a
// second one.
const backupElementQueue: Element[] = [];
let processingBackupElementQueue = false;

function enqueueOnAppropriateElementQueue(element: Element): void {
	if (reactionsStack.length === 0) {
		backupElementQueue.push(element);
		if (processingBackupElementQueue) {
			return;
		}
		processingBackupElementQueue = true;
		queueMicrotask(() => {
			invokeReactions(backupElementQueue);
			processingBackupElementQueue = false;
		});
		return;
	}
	reactionsStack[reactionsStack.length - 1].push(element);
}

function getElementReactionQueue(element: Element): Reaction[] {
	let queue = element[kReactionQueue]!;
	if (queue === null) {
		queue = [];
		element[kReactionQueue] = queue;
	}
	return queue;
}

function enqueueCallbackReaction(
	element: Element,
	callbackName: string,
	args: unknown[],
): void {
	const definition = element[kDefinition]!;
	if (definition === null) {
		return;
	}
	const callback = definition.lifecycleCallbacks.get(callbackName) ?? null;
	if (callback === null) {
		return;
	}
	if (
		callbackName === "attributeChangedCallback" &&
		!definition.observedAttributes.has(args[0] as string)
	) {
		return;
	}
	getElementReactionQueue(element).push({callback, args});
	enqueueOnAppropriateElementQueue(element);
}

function enqueueUpgradeReaction(
	element: Element,
	definition: CustomElementDefinition,
): void {
	getElementReactionQueue(element).push({upgrade: definition});
	enqueueOnAppropriateElementQueue(element);
}

function invokeReactions(queue: Element[]): void {
	while (queue.length > 0) {
		const element = queue.shift() as Element;
		const reactions = element[kReactionQueue]!;
		if (reactions === null) {
			continue;
		}
		while (reactions.length > 0) {
			const reaction = reactions.shift() as Reaction;
			try {
				if ("upgrade" in reaction) {
					upgradeElement(element, reaction.upgrade);
				} else {
					reaction.callback.apply(element, reaction.args);
				}
			} catch (error) {
				reportError(error);
			}
		}
	}
}

function withReactions<T>(steps: () => T): T {
	reactionsStack.push([]);
	try {
		return steps();
	} finally {
		invokeReactions(reactionsStack.pop() as Element[]);
	}
}

// A getter is never a reactions boundary, because the extended attribute
// cannot appear on a readonly attribute. So only values and setters are
// wrapped.
function ceReactions(prototype: object, names: string[]): void {
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (descriptor === undefined) {
			continue;
		}
		if (typeof descriptor.value === "function") {
			descriptor.value = wrapWithReactions(
				descriptor.value as (...args: unknown[]) => unknown,
			);
		} else if (typeof descriptor.set === "function") {
			descriptor.set = wrapWithReactions(descriptor.set) as (
				value: unknown,
			) => void;
		} else {
			continue;
		}
		Object.defineProperty(prototype, name, descriptor);
	}
}

function wrapWithReactions(
	steps: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
	function wrapper(this: unknown, ...args: unknown[]): unknown {
		return withReactions(() => steps.apply(this, args));
	}

	Object.defineProperty(wrapper, "length", {
		value: steps.length,
		configurable: true,
	});
	Object.defineProperty(wrapper, "name", {
		value: steps.name,
		configurable: true,
	});
	return wrapper;
}

const LIFECYCLE_CALLBACK_NAMES = [
	"connectedCallback",
	"disconnectedCallback",
	"connectedMoveCallback",
	"adoptedCallback",
	"attributeChangedCallback",
];

const FORM_CALLBACK_NAMES = [
	"formAssociatedCallback",
	"formResetCallback",
	"formDisabledCallback",
	"formStateRestoreCallback",
];

const registries: CustomElementRegistry[] = [];

const kDefinitions = Symbol("definitions");
const kDefinitionIsRunning = Symbol("definitionIsRunning");
const kWhenDefined = Symbol("whenDefined");
const kScoped = Symbol("scoped");

class CustomElementRegistry {
	// The registry the realm gives every document is not scoped, and it is
	// the only one a document may hold.
	declare [kScoped]?: boolean;
	declare [kDefinitions]?: CustomElementDefinition[];
	declare [kDefinitionIsRunning]?: boolean;

	declare [kWhenDefined]?: Map<string, {
		promise: Promise<CustomElementConstructor>;
		resolve: (value: CustomElementConstructor) => void;
	}>;

	constructor() {
		this[kScoped] = !internalConstruction;
		this[kDefinitions] = [];
		this[kDefinitionIsRunning] = false;
		this[kWhenDefined] = new Map<
			string,
			{
				promise: Promise<CustomElementConstructor>;
				resolve: (value: CustomElementConstructor) => void;
			}
		>();
		registries.push(this);
	}

	define(
		name: string,
		constructor: CustomElementConstructor,
		options?: {extends?: string},
	): void {
		if (arguments.length < 2) {
			throw new TypeError("define needs a name and a constructor");
		}
		if (!isConstructor(constructor)) {
			throw new TypeError("That is not a constructor");
		}
		const localName = String(name);
		if (!isValidCustomElementName(localName)) {
			throw domError(
				"SyntaxError",
				`"${localName}" is not a valid custom element name`,
			);
		}
		if (this[kDefinitions]!.some((entry) => entry.name === localName)) {
			throw domError("NotSupportedError", `"${localName}" is already defined`);
		}
		if (
			this[kDefinitions]!.some((entry) => entry.constructor === constructor)
		) {
			throw domError(
				"NotSupportedError",
				"That constructor is already defining an element",
			);
		}
		const init = toDictionary<{extends?: string}>(
			options ?? {},
			"An ElementDefinitionOptions",
		);
		if (init.extends !== undefined && init.extends !== null) {
			throw domError(
				"NotSupportedError",
				"A customized built-in element is not implemented here",
			);
		}
		if (this[kDefinitionIsRunning]!) {
			throw domError("NotSupportedError", "A definition is already being read");
		}
		this[kDefinitionIsRunning] = true;
		let observedAttributes: string[] = [];
		let formAssociated = false;
		let disableInternals = false;
		let disableShadow = false;
		const lifecycleCallbacks = new Map<
			string,
			((...args: unknown[]) => void) | null
		>();
		try {
			const source = constructor as unknown as Record<string, unknown>;
			const prototype = source.prototype;
			if (
				prototype === null ||
				(typeof prototype !== "object" && typeof prototype !== "function")
			) {
				throw new TypeError("That constructor has no prototype object");
			}
			const proto = prototype as Record<string, unknown>;
			for (const callbackName of LIFECYCLE_CALLBACK_NAMES) {
				lifecycleCallbacks.set(
					callbackName,
					toCallback(proto[callbackName], callbackName),
				);
			}
			if (lifecycleCallbacks.get("attributeChangedCallback") !== null) {
				const observed = source.observedAttributes;
				if (observed !== undefined) {
					observedAttributes = toStringSequenceStrict(
						observed,
						"observedAttributes",
					);
				}
			}
			const disabled = source.disabledFeatures;
			if (disabled !== undefined) {
				const features = toStringSequenceStrict(disabled, "disabledFeatures");
				disableInternals = features.includes("internals");
				disableShadow = features.includes("shadow");
			}
			formAssociated = Boolean(source.formAssociated);
			if (formAssociated) {
				for (const callbackName of FORM_CALLBACK_NAMES) {
					lifecycleCallbacks.set(
						callbackName,
						toCallback(proto[callbackName], callbackName),
					);
				}
			}
		} finally {
			this[kDefinitionIsRunning] = false;
		}
		const definition: CustomElementDefinition = {
			registry: this,
			name: localName,
			localName,
			constructor,
			observedAttributes: new Set(observedAttributes),
			lifecycleCallbacks,
			constructionStack: [],
			formAssociated,
			disableInternals,
			disableShadow,
		};
		this[kDefinitions]!.push(definition);
		const document = getCurrentDocument();
		for (const candidate of shadowIncludingInclusiveDescendants(document)) {
			if (candidate.nodeType !== ELEMENT_NODE) {
				continue;
			}
			const element = candidate as Element;
			if (element[kRegistry] !== this) {
				continue;
			}
			if (element[kNamespace] !== HTML_NAMESPACE) {
				continue;
			}
			if (element[kLocalName] !== localName) {
				continue;
			}
			enqueueUpgradeReaction(element, definition);
		}
		const pending = this[kWhenDefined]!.get(localName);
		if (pending !== undefined) {
			pending.resolve(constructor);
			this[kWhenDefined]!.delete(localName);
		}
	}

	get(name: string): CustomElementConstructor | undefined {
		const localName = String(name);
		const definition = this[kDefinitions]!.find(
			(entry) => entry.name === localName,
		);
		return definition === undefined ? undefined : definition.constructor;
	}

	getName(constructor: CustomElementConstructor): string | null {
		if (arguments.length < 1) {
			throw new TypeError("getName needs a constructor");
		}
		if (typeof constructor !== "function") {
			throw new TypeError("That is not a constructor");
		}
		const definition = this[kDefinitions]!.find(
			(entry) => entry.constructor === constructor,
		);
		return definition === undefined ? null : definition.name;
	}

	whenDefined(name: string): Promise<CustomElementConstructor> {
		const localName = String(name);
		if (!isValidCustomElementName(localName)) {
			return Promise.reject(
				domError(
					"SyntaxError",
					`"${localName}" is not a valid custom element name`,
				),
			);
		}
		const defined = this[kDefinitions]!.find(
			(entry) => entry.name === localName,
		);
		if (defined !== undefined) {
			return Promise.resolve(defined.constructor);
		}
		let pending = this[kWhenDefined]!.get(localName);
		if (pending === undefined) {
			let resolve: (value: CustomElementConstructor) => void = () => {};
			const promise = new Promise<CustomElementConstructor>((settle) => {
				resolve = settle;
			});
			pending = {promise, resolve};
			this[kWhenDefined]!.set(localName, pending);
		}
		return pending.promise;
	}

	upgrade(root: Node): void {
		if (!(root instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		for (const candidate of shadowIncludingInclusiveDescendants(root)) {
			if (candidate.nodeType !== ELEMENT_NODE) {
				continue;
			}
			tryToUpgrade(candidate as Element);
		}
	}

	// The realm's document registry cannot claim a document, because a
	// document holds that registry from the moment it exists.
	initialize(root: Node): void {
		if (!(root instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (!this[kScoped] && root.nodeType === DOCUMENT_NODE) {
			throw domError(
				"NotSupportedError",
				"A document already holds the registry of its realm",
			);
		}
		const upgrades: Element[] = [];
		associateRegistry(root, this, upgrades);
		for (const element of upgrades) {
			tryToUpgrade(element);
		}
	}
}

// Constructs a proxy of the value with a construct trap, so
// nothing on the value itself is read. A proxy is constructible exactly
// when its target is, and the trap returns before the object it would
// build needs a prototype. Constructing with the value as new.target
// would read its `prototype`, which the caller could observe.
function isConstructor(value: unknown): boolean {
	if (typeof value !== "function") {
		return false;
	}
	try {
		Reflect.construct(
			// There is no other way to test whether a registered constructor is
			// constructible.
			// eslint-disable-next-line no-restricted-globals
			new Proxy(value as new () => unknown, {construct: () => ({})}),
			[],
		);
		return true;
	} catch (_err) {
		return false;
	}
}

function toStringSequenceStrict(value: unknown, what: string): string[] {
	if (value === null || typeof value !== "object") {
		if (typeof value !== "string") {
			throw new TypeError(`${what} is not a list`);
		}
	}
	const iterator = (value as Iterable<unknown>)[Symbol.iterator];
	if (typeof iterator !== "function") {
		throw new TypeError(`${what} is not a list`);
	}
	const strings: string[] = [];
	for (const entry of value as Iterable<unknown>) {
		strings.push(String(entry));
	}
	return strings;
}

function toCallback(
	value: unknown,
	name: string,
): ((...args: unknown[]) => void) | null {
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "function") {
		throw new TypeError(`${name} is not callable`);
	}
	return value as (...args: unknown[]) => void;
}

function getDefinition(
	registry: CustomElementRegistry,
	constructor: CustomElementConstructor,
): CustomElementDefinition | null {
	return (
		registry[kDefinitions]!.find(
			(entry) => entry.constructor === constructor,
		) ??
		null
	);
}

function lookUpDefinition(
	registry: CustomElementRegistry,
	namespace: string | null,
	localName: string,
	is: string | null,
): CustomElementDefinition | null {
	if (namespace !== HTML_NAMESPACE) {
		return null;
	}
	for (const definition of registry[kDefinitions]!) {
		if (definition.name === localName && definition.localName === localName) {
			return definition;
		}
	}
	for (const definition of registry[kDefinitions]!) {
		if (definition.name === is && definition.localName === localName) {
			return definition;
		}
	}
	return null;
}

Object.defineProperty(CustomElementRegistry.prototype, Symbol.toStringTag, {
	value: "CustomElementRegistry",
	configurable: true,
});

// HTML's element constructors look the constructor up in the registry
// whose upgrade is in flight, and otherwise in the current global
// object's document registry. Every document here shares one realm, so
// there is no second global for an iframe's script to run under. The
// last branch stands in for it: a constructor known only to an iframe's
// registry resolves as it would from that iframe's own global
// (custom-elements/htmlconstructor/newtarget.html).
function getConstructorDefinition(
	constructor: CustomElementConstructor,
): CustomElementDefinition | null {
	for (const registry of registries) {
		const definition = getDefinition(registry, constructor);
		if (definition !== null && definition.constructionStack.length > 0) {
			return definition;
		}
	}
	const global = getDefinition(globalCustomElements, constructor);
	if (global !== null) {
		return global;
	}
	for (const registry of registries) {
		const definition = getDefinition(registry, constructor);
		if (definition !== null) {
			return definition;
		}
	}
	return null;
}

// Definitions are per realm because the classes that carry them are, so
// one registry serves every document. A document reaches it through the
// algorithms below rather than a global, so a tree with no window behind
// it still resolves its definitions.
const globalCustomElements = constructInternal(
	() => new CustomElementRegistry(),
);

// Every node has a registry. An element takes its document's when
// created and the tree's when inserted. A shadow root takes its host's
// unless the caller named another. A node created for a registry that
// has not been assigned one yet has null, which matches no definition
// until a registry claims it.
function lookUpCustomElementDefinition(
	registry: CustomElementRegistry | null,
	namespace: string | null,
	localName: string,
	is: string | null,
): CustomElementDefinition | null {
	if (registry === null) {
		return null;
	}
	return lookUpDefinition(registry, namespace, localName, is);
}

// Walks the node tree only. A shadow tree under an element keeps
// whatever registry it was given, which is the point of scoping one.
function associateRegistry(
	node: Node,
	registry: CustomElementRegistry,
	upgrades: Element[],
): void {
	if (node[kRegistry] !== null) {
		return;
	}
	node[kRegistry] = registry;
	if (node.nodeType === ELEMENT_NODE) {
		upgrades.push(node as Element);
	}
	for (let child = node[kFirstChild]!; child !== null; child = child[kNext]!) {
		associateRegistry(child, registry, upgrades);
	}
}

function constructCustomElement(definition: CustomElementDefinition): Element {
	return Reflect.construct(
		definition.constructor,
		[],
		definition.constructor,
	) as Element;
}

// The element is already in the tree. What changes is its prototype, its
// state, and the callbacks it owes. The reactions for the attributes it
// already has and for being connected are queued before the constructor
// runs, so the author's constructor sees them arrive afterwards.
function upgradeElement(
	element: Element,
	definition: CustomElementDefinition,
): void {
	const state = element[kCustomState]!;
	if (state !== "undefined" && state !== "uncustomized") {
		return;
	}
	element[kDefinition] = definition;
	element[kCustomState] = "failed";
	for (const attribute of element[kAttributeList]!) {
		enqueueCallbackReaction(element, "attributeChangedCallback", [
			attribute[kLocalName]!,
			null,
			attribute[kValue]!,
			attribute[kNamespace]!,
		]);
	}
	if (element.isConnected) {
		enqueueCallbackReaction(element, "connectedCallback", []);
	}
	definition.constructionStack.push(element);
	try {
		if (definition.disableShadow && element[kShadowRoot] !== null) {
			throw domError(
				"NotSupportedError",
				"That definition disabled shadow roots",
			);
		}
		element[kCustomState] = "precustomized";
		const result = constructCustomElement(definition);
		if (result !== element) {
			throw new TypeError("That constructor built a different element");
		}
	} catch (error) {
		// If the constructor threw, the element is failed and the callbacks it
		// had not run yet are dropped. The definition stays, because the
		// element belongs to that definition and failed is a state of it, not
		// the absence of one. Whoever runs the reaction reports the exception.
		definition.constructionStack.pop();
		element[kCustomState] = "failed";
		element[kReactionQueue] = null;
		throw error;
	}
	definition.constructionStack.pop();
	element[kCustomState] = "custom";
	// A form-associated element learns its owner and its disabled state as
	// it becomes one, which is the first moment it has internals to notify.
	if (definition.formAssociated) {
		resetTheFormOwner(element);
		syncFormDisabled(element);
	}
}

function getDefinitionRegistry(
	definition: CustomElementDefinition,
): CustomElementRegistry | null {
	return definition.registry;
}

// Elements inside template contents never upgrade, including ones moved
// in that already carry a registry (custom-elements/registries/upgrade.html).
// Parser-built contents already resolve to no definition, because the
// template contents owner document has no registry; this check covers
// the moved-in case.
function getUpgradeDefinition(
	element: Element,
): CustomElementDefinition | null {
	// A template's contents never upgrade. A connected element's root is a
	// document, so only a detached one has to climb to find out.
	if (!element[kConnected]) {
		const root = getRoot(element);
		if (
			root.nodeType === DOCUMENT_FRAGMENT_NODE &&
			(root as DocumentFragment)[kHost]! instanceof HTMLTemplateElement
		) {
			return null;
		}
	}
	return lookUpCustomElementDefinition(
		element[kRegistry]!,
		element[kNamespace]!,
		element[kLocalName]!,
		element[kIsValue]!,
	);
}

function tryToUpgrade(element: Element): void {
	const definition = getUpgradeDefinition(element);
	if (definition !== null) {
		enqueueUpgradeReaction(element, definition);
	}
}

const SHADOW_HOST_NAMES = new Set([
	"article",
	"aside",
	"blockquote",
	"body",
	"div",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"main",
	"nav",
	"p",
	"section",
	"span",
]);

// Named slots sort children by their `slot` attribute, but author content
// does not carry that attribute and the UA must not write onto author
// nodes. A UA shadow tree that sorts children by what they are (details sends
// its first summary to one slot and everything else to the other) uses
// this function instead. findSlottables calls it on every assignment
// pass, so it always reads the current child list.
const kUASlotting = Symbol("UA slot distribution");

interface ShadowRootInit {
	customElementRegistry?: unknown;
	mode: "open" | "closed";
	delegatesFocus?: boolean;
	slotAssignment?: "named" | "manual";
	clonable?: boolean;
	serializable?: boolean;
}

const kDelegatesFocus = Symbol("delegates focus");
const kClonable = Symbol("clonable");
const kSerializable = Symbol("serializable");
const kDeclarative = Symbol("declarative");
const kUAShadowTree = Symbol("user-agent shadow root");
const kAvailableToInternals = Symbol("available to element internals");

/**
 * A document fragment with a host. Every algorithm that already steps
 * from a fragment to its host (pre-insertion validity, retargeting, the
 * composed path) works across it without a second concept.
 */
export class ShadowRoot extends DocumentFragment implements globalThis.ShadowRoot {
	[kShadowMode]?: "open" | "closed";
	[kUAShadowTree]?: boolean;
	[kDelegatesFocus]?: boolean;
	[kSlotAssignment]?: "named" | "manual";
	[kUASlotting]?: ((slot: object) => Slottable[]) | null;
	[kClonable]?: boolean;
	[kSerializable]?: boolean;
	[kDeclarative]?: boolean;
	[kAvailableToInternals]?: boolean;

	constructor() {
		super();
		this[kShadowMode] = "open";
		this[kUAShadowTree] = false;
		this[kDelegatesFocus] = false;
		this[kSlotAssignment] = "named";
		this[kUASlotting] = null;
		this[kClonable] = false;
		this[kSerializable] = false;
		this[kDeclarative] = false;
		this[kAvailableToInternals] = false;
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
	}

	get styleSheets(): globalThis.StyleSheetList {
		return getStyleSheets(this);
	}

	get adoptedStyleSheets(): globalThis.CSSStyleSheet[] {
		return getAdoptedStyleSheets(this);
	}

	set adoptedStyleSheets(value: globalThis.CSSStyleSheet[]) {
		adoptStyleSheets(this, value);
	}

	// Retargeted into this tree: the shadow-including ancestor of the
	// focused element that is a descendant of THIS root, or null when the
	// focus is elsewhere entirely.
	get activeElement(): globalThis.Element | null {
		const document = this.ownerDocument as Document | null;
		// Start from the RAW focus, not the document's retargeted result, which
		// has already collapsed shadow content to its host.
		let current: Node | null = ((document ? document[kActiveElement]! : null) ??
			null) as Node | null;
		while (current !== null) {
			const root = current.getRootNode() as Node;
			if (root === (this as unknown as Node)) {
				return current as unknown as globalThis.Element;
			}
			current =
				root instanceof ShadowRoot
					? ((root.host ?? null) as Node | null)
					: null;
		}
		return null;
	}

	get mode(): "open" | "closed" {
		return this[kShadowMode]!;
	}

	get customElementRegistry(): CustomElementRegistry | null {
		return this[kRegistry]!;
	}

	get delegatesFocus(): boolean {
		return this[kDelegatesFocus]!;
	}

	get slotAssignment(): "named" | "manual" {
		return this[kSlotAssignment]!;
	}

	get clonable(): boolean {
		return this[kClonable]!;
	}

	get serializable(): boolean {
		return this[kSerializable]!;
	}

	get host(): Element {
		return this[kHost]! as Element;
	}

	get innerHTML(): string {
		return serializeFragment(this, false);
	}

	set innerHTML(value: string) {
		const fragment = parseHTMLFragment(
			String(value ?? ""),
			this[kHost]! as Element,
			false,
		);
		replaceAll(fragment, this);
	}

	// The DocumentOrShadowRoot surface, SCOPED to this root. Nothing in this
	// engine ever puts these inside a shadow root. Fullscreen, pointer lock
	// and picture-in-picture belong to the document, and hit testing runs
	// against the document because that is where the boxes were painted.
	get fullscreenElement(): globalThis.Element | null {
		return null;
	}

	get pointerLockElement(): globalThis.Element | null {
		return null;
	}

	get pictureInPictureElement(): globalThis.Element | null {
		return null;
	}

	getHTML(options?: globalThis.GetHTMLOptions): string {
		const init = toDictionary<{
			serializableShadowRoots?: boolean;
			shadowRoots?: ShadowRoot[];
		}>(options ?? {}, "A GetHTMLOptions");
		return serializeFragment(
			this,
			Boolean(init.serializableShadowRoots),
			init.shadowRoots ?? [],
		);
	}

	setHTMLUnsafe(html: string): void {
		const fragment = parseHTMLFragment(
			String(html ?? ""),
			this[kHost]! as Element,
			true,
		);
		replaceAll(fragment, this);
	}

	elementFromPoint(_x: number, _y: number): Element | null {
		return null;
	}

	elementsFromPoint(_x: number, _y: number): Element[] {
		return [];
	}

	getAnimations(): globalThis.Animation[] {
		return [];
	}

	// Dispatch leaves a shadow tree through the host, unless the event was
	// dispatched inside this tree and is not composed.
	override [kGetTheParent]?(event: Event): EventTarget | null {
		const path = event[kState]!.path;
		if (
			!event.composed &&
			path.length > 0 &&
			path[0].invocationTarget instanceof Node &&
			getRoot(path[0].invocationTarget) === this
		) {
			return null;
		}
		return this[kHost]!;
	}

	override [kCloneSingle]?(_document: Document): Node {
		throw domError("NotSupportedError", "A shadow root cannot be cloned");
	}
}

export interface ShadowRoot
	extends Pick<globalThis.ShadowRoot, ParentNodeMixin | "onslotchange"> {}

installEventHandler(ShadowRoot.prototype, "onslotchange");

Object.defineProperty(ShadowRoot.prototype, Symbol.toStringTag, {
	value: "ShadowRoot",
	configurable: true,
});

function attachShadowRoot(
	element: Element,
	mode: "open" | "closed",
	clonable: boolean,
	serializable: boolean,
	delegatesFocus: boolean,
	slotAssignment: "named" | "manual",
	registry: CustomElementRegistry | null,
): void {
	if (element[kNamespace] !== HTML_NAMESPACE) {
		throw domError(
			"NotSupportedError",
			"Only an HTML element can host a shadow tree",
		);
	}
	const localName = element[kLocalName]!;
	if (
		!SHADOW_HOST_NAMES.has(localName) &&
		!isValidCustomElementName(localName)
	) {
		throw domError(
			"NotSupportedError",
			`A ${localName} cannot host a shadow tree`,
		);
	}
	if (isValidCustomElementName(localName) || element[kIsValue] !== null) {
		const definition = lookUpCustomElementDefinition(
			element[kRegistry]!,
			element[kNamespace]!,
			localName,
			element[kIsValue]!,
		);
		if (definition !== null && definition.disableShadow) {
			throw domError(
				"NotSupportedError",
				"That definition disabled shadow roots",
			);
		}
	}
	const existing = element[kShadowRoot]!;
	if (existing !== null) {
		if (!existing[kDeclarative] || existing[kShadowMode] !== mode) {
			throw domError(
				"NotSupportedError",
				"That element already hosts a shadow tree",
			);
		}
		for (const child of getChildNodeArray(existing)) {
			removeNode(child);
		}
		existing[kDeclarative] = false;
		return;
	}
	const shadow = constructInternal(() => new ShadowRoot());
	shadow[kDocument] = element[kDocument]!;
	shadow[kHost] = element;
	shadow[kConnected] = element[kConnected]!;
	shadow[kShadowMode] = mode;
	shadow[kDelegatesFocus] = delegatesFocus;
	const state = element[kCustomState]!;
	shadow[kAvailableToInternals] =
		state === "precustomized" || state === "custom";
	shadow[kSlotAssignment] = slotAssignment;
	shadow[kDeclarative] = false;
	shadow[kClonable] = clonable;
	shadow[kSerializable] = serializable;
	shadow[kRegistry] = registry;
	element[kShadowRoot] = shadow;
	styleShadowAttached(shadow);
}

// The same ShadowRoot an author's attachShadow builds, so slot
// assignment, retargeting, `isConnected` and the selector engine's tree
// scoping all work across it. Attached past the check that stops authors
// from hosting a tree on an `<input>`. Closed and not marked declarative
// or clonable, so `element.shadowRoot` stays null, `attachShadow` still
// throws the NotSupportedError the spec requires, `cloneNode` copies
// nothing, and serialization never includes it. Reachable only through
// getShadowRoot and the control that built it.
function attachUAShadowTree<T>(target: Element): T {
	const host = target as Element;
	const shadow = constructInternal(() => new ShadowRoot());
	shadow[kDocument] = host[kDocument]!;
	shadow[kHost] = host;
	shadow[kConnected] = host[kConnected]!;
	shadow[kShadowMode] = "closed";
	shadow[kUAShadowTree] = true;
	shadow[kRegistry] = globalCustomElements;
	host[kShadowRoot] = shadow;
	return shadow as T;
}

/**
 * The cascade checks this: a rule from a UA shadow tree's stylesheet is a
 * UA rule, which every author rule outranks whatever its specificity.
 */
export function isUAShadowTree(node: globalThis.Node): boolean {
	return node instanceof ShadowRoot && node[kUAShadowTree]!;
}

/**
 * The shadow tree an element renders, including closed ones. The engine
 * composes through this. `Element.shadowRoot` is the author-facing view
 * and shows only an open tree.
 */
export function getShadowRoot<T>(element: globalThis.Element): T | null {
	return ((element as Element)[kShadowRoot]! as T) ?? null;
}

type Slottable = Element | Text;

function isSlottable(node: Node): boolean {
	return node.nodeType === ELEMENT_NODE || node.nodeType === TEXT_NODE;
}

function isAssigned(target: EventTarget | null): boolean {
	return (
		target instanceof Node &&
		isSlottable(target) &&
		(target as Slottable)[kAssignedSlot] !== null
	);
}

function getSlottableName(slottable: Slottable): string {
	return slottable.nodeType === ELEMENT_NODE
		? (slottable as Element)[kSlottableName]!
		: "";
}

function hasInclusiveDescendantSlot(node: Node): boolean {
	let current: Node | null = node;
	while (current !== null) {
		if (current instanceof HTMLSlotElement) {
			return true;
		}
		current = nextInTree(current, node);
	}
	return false;
}

const kSlotName = Symbol("slot name");
const kManualAssignment = Symbol("manually assigned nodes");

function findASlot(slottable: Slottable, open = false): HTMLSlotElement | null {
	const parent = slottable[kParent]!;
	if (parent === null || parent.nodeType !== ELEMENT_NODE) {
		return null;
	}
	const shadow = (parent as Element)[kShadowRoot]!;
	if (shadow === null) {
		return null;
	}
	if (open && shadow[kShadowMode] !== "open") {
		return null;
	}
	if (shadow[kSlotAssignment] === "manual") {
		for (const descendant of descendants(shadow)) {
			if (
				descendant instanceof HTMLSlotElement &&
				descendant[kManualAssignment]!.includes(slottable)
			) {
				return descendant;
			}
		}
		return null;
	}
	const name = getSlottableName(slottable);
	for (const descendant of descendants(shadow)) {
		if (
			descendant instanceof HTMLSlotElement &&
			descendant[kSlotName] === name
		) {
			return descendant;
		}
	}
	return null;
}

function findSlottables(slot: HTMLSlotElement): Slottable[] {
	const result: Slottable[] = [];
	const root = getRoot(slot);
	if (!isShadowRoot(root)) {
		return result;
	}
	const shadow = root as ShadowRoot;
	const host = shadow[kHost]! as Element;
	const slotting = shadow[kUASlotting]!;
	if (slotting !== null) {
		return slotting(slot);
	}
	if (shadow[kSlotAssignment] === "manual") {
		for (const slottable of slot[kManualAssignment]!) {
			if (slottable[kParent] === host) {
				result.push(slottable);
			}
		}
		return result;
	}
	for (let child = host[kFirstChild]!; child !== null; child = child[kNext]!) {
		if (!isSlottable(child)) {
			continue;
		}
		if (findASlot(child as Slottable) === slot) {
			result.push(child as Slottable);
		}
	}
	return result;
}

function assignSlottables(slot: HTMLSlotElement): void {
	const slottables = findSlottables(slot);
	const assigned = slot[kAssignedNodes]!;
	const identical =
		slottables.length === assigned.length &&
		slottables.every((node, index) => node === assigned[index]);
	if (!identical) {
		signalASlotChange(slot);
	}
	for (const previous of assigned) {
		if (previous[kAssignedSlot] === slot && !slottables.includes(previous)) {
			previous[kAssignedSlot] = null;
		}
	}
	slot[kAssignedNodes] = slottables;
	for (const slottable of slottables) {
		slottable[kAssignedSlot] = slot;
	}
}

function assignSlottablesForTree(root: Node): void {
	for (const node of inclusiveDescendants(root)) {
		if (node instanceof HTMLSlotElement) {
			assignSlottables(node);
		}
	}
}

function assignASlot(slottable: Slottable): void {
	const slot = findASlot(slottable);
	if (slot !== null) {
		assignSlottables(slot);
	}
}

// slotchange is signalled here rather than fired. The spec fires it from
// the same microtask that delivers mutation records, after them, so a
// script observing both sees the records first.
const signalSlots: HTMLSlotElement[] = [];

function signalASlotChange(slot: HTMLSlotElement): void {
	if (!signalSlots.includes(slot)) {
		signalSlots.push(slot);
	}
	queueMutationObserverMicrotask();
}

function updateSlottableName(
	element: Element,
	oldValue: string | null,
	value: string | null,
): void {
	if (value === oldValue) {
		return;
	}
	if (value === null && oldValue === "") {
		return;
	}
	if (value === "" && oldValue === null) {
		return;
	}
	element[kSlottableName] = value === null || value === "" ? "" : value;
	const assigned = element[kAssignedSlot]!;
	if (assigned !== null) {
		assignSlottables(assigned);
	}
	assignASlot(element);
}

function updateSlotName(
	slot: HTMLSlotElement,
	oldValue: string | null,
	value: string | null,
): void {
	if (value === oldValue) {
		return;
	}
	if (value === null && oldValue === "") {
		return;
	}
	if (value === "" && oldValue === null) {
		return;
	}
	slot[kSlotName] = value === null || value === "" ? "" : value;
	assignSlottablesForTree(getRoot(slot));
}

// Assignment is recomputed rather than patched incrementally. Every
// input to it (the host's children, their slot attributes, the slot names
// in the tree) can change from any of a dozen mutation entry points. One
// recomputation per changed tree is both the spec's shape and the only
// one that cannot drift.
class HTMLSlotElement extends HTMLElement {
	[kSlotName]?: string;
	[kAssignedNodes]?: Slottable[];
	[kManualAssignment]?: Slottable[];
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kSlotName] = "";
		this[kAssignedNodes] = [];
		this[kManualAssignment] = [];
	}

	get name(): string {
		return this.getAttribute("name") ?? "";
	}

	set name(value: string) {
		this.setAttribute("name", String(value));
	}

	assignedNodes(options?: globalThis.AssignedNodesOptions): globalThis.Node[] {
		const init = toDictionary<{flatten?: boolean}>(
			options ?? {},
			"An AssignedNodesOptions",
		);
		if (!init.flatten) {
			return [...this[kAssignedNodes]!] as unknown as globalThis.Node[];
		}
		return findFlattenedSlottables(this) as unknown as globalThis.Node[];
	}

	assignedElements(
		options?: globalThis.AssignedNodesOptions,
	): globalThis.Element[] {
		return this.assignedNodes(options).filter(
			(node) => node.nodeType === ELEMENT_NODE,
		) as globalThis.Element[];
	}

	// Recomputes every tree in which a slot lost or gained a node. The
	// spec's own step covers this slot's tree, but a node taken from a slot
	// in another shadow tree leaves that tree's assignment stale until its
	// slots are recomputed too.
	assign(...nodes: Array<globalThis.Element | globalThis.Text>): void {
		for (const node of nodes) {
			if (!(node instanceof Node) || !isSlottable(node)) {
				throw new TypeError("Only an element or a text node can be assigned");
			}
		}
		const roots: Node[] = [getRoot(this)];
		for (const slottable of this[kManualAssignment]!) {
			slottable[kManualSlot] = null;
		}
		const assigned: Slottable[] = [];
		for (const node of nodes) {
			const slottable = node as unknown as Slottable;
			if (assigned.includes(slottable)) {
				continue;
			}
			const previous = slottable[kManualSlot]!;
			if (previous !== null && previous !== this) {
				const index = previous[kManualAssignment]!.indexOf(slottable);
				if (index >= 0) {
					previous[kManualAssignment]!.splice(index, 1);
				}
				const root = getRoot(previous);
				if (!roots.includes(root)) {
					roots.push(root);
				}
			}
			slottable[kManualSlot] = this;
			assigned.push(slottable);
		}
		this[kManualAssignment] = assigned;
		for (const root of roots) {
			assignSlottablesForTree(root);
		}
	}
}

function findFlattenedSlottables(slot: HTMLSlotElement): Slottable[] {
	const result: Slottable[] = [];
	if (!isShadowRoot(getRoot(slot))) {
		return result;
	}
	let slottables = findSlottables(slot);
	if (slottables.length === 0) {
		slottables = [];
		for (let child = slot[kFirstChild]!;
			child !== null;
			child = child[kNext]!) {
			if (isSlottable(child)) {
				slottables.push(child as Slottable);
			}
		}
	}
	for (const node of slottables) {
		if (node instanceof HTMLSlotElement && isShadowRoot(getRoot(node))) {
			result.push(...findFlattenedSlottables(node));
		} else {
			result.push(node);
		}
	}
	return result;
}

Object.defineProperty(HTMLSlotElement.prototype, Symbol.toStringTag, {
	value: "HTMLSlotElement",
	configurable: true,
});

builtinRegistry.define(HTML_NAMESPACE, "slot", HTMLSlotElement);

const kTemplateContent = Symbol("template content");

const kTemplateDocument = Symbol("templateDocument");

// The fragment is the form a shadow tree is written in (a declarative
// shadow root is a template), so the element that owns the fragment
// belongs next to the slot. The fragment's host is the template, which is
// what stops a template from being appended into its own contents.
class HTMLTemplateElement extends HTMLElement {
	[kTemplateContent]?: DocumentFragment | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kTemplateContent] = null;
	}

	get content(): DocumentFragment {
		let content = this[kTemplateContent]!;
		if (content === null) {
			content = new DocumentFragment();
			content[kDocument] = getTemplateContentsOwner(this[kDocument]!);
			content[kHost] = this;
			this[kTemplateContent] = content;
		}
		return content;
	}

	get shadowRootMode(): string {
		const value = this.getAttribute("shadowrootmode");
		if (value === null) {
			return "";
		}
		const mode = toASCIILowercase(value);
		return mode === "open" || mode === "closed" ? mode : "";
	}

	set shadowRootMode(value: string) {
		this.setAttribute("shadowrootmode", String(value));
	}

	get shadowRootDelegatesFocus(): boolean {
		return this.hasAttribute("shadowrootdelegatesfocus");
	}

	set shadowRootDelegatesFocus(value: boolean) {
		this.toggleAttribute("shadowrootdelegatesfocus", Boolean(value));
	}

	get shadowRootClonable(): boolean {
		return this.hasAttribute("shadowrootclonable");
	}

	set shadowRootClonable(value: boolean) {
		this.toggleAttribute("shadowrootclonable", Boolean(value));
	}

	get shadowRootSerializable(): boolean {
		return this.hasAttribute("shadowrootserializable");
	}

	set shadowRootSerializable(value: boolean) {
		this.toggleAttribute("shadowrootserializable", Boolean(value));
	}

	override [kAdoptingSteps]?(_oldDocument: Document): void {
		const content = this[kTemplateContent]!;
		if (content !== null) {
			adoptNode(content, this[kDocument]!);
		}
	}

	override [kCloningSteps]?(
		copy: Node,
		document: Document,
		_deep: boolean,
	): void {
		const content = this[kTemplateContent]!;
		if (content === null) {
			return;
		}
		const target = (copy as HTMLTemplateElement).content;
		for (
			let child = content[kFirstChild]!;
			child !== null;
			child = child[kNext]!
		) {
			appendNode(cloneNode(child, document, true), target);
		}
	}
}

// An inert document, one per document, that holds every template's
// content fragment. That is why a template's content has a different
// ownerDocument than the element. A contents owner owns its own
// templates' contents itself.
function getTemplateContentsOwner(document: Document): Document {
	if (document[kTemplateDocument] === document) {
		return document;
	}
	let owner = document[kTemplateDocument]!;
	if (owner === null) {
		owner = constructInternal(() => new Document());
		owner[kTemplateDocument] = owner;
		document[kTemplateDocument] = owner;
	}
	return owner;
}

Object.defineProperty(HTMLTemplateElement.prototype, Symbol.toStringTag, {
	value: "HTMLTemplateElement",
	configurable: true,
});

builtinRegistry.define(HTML_NAMESPACE, "template", HTMLTemplateElement);

function parseURL(value: string, base: string): string | null {
	try {
		return new URL(value, base).href;
	} catch (_err) {
		return null;
	}
}

// The href of the first base element that has one, resolved against the
// document's URL. Falls back to the document's URL when there is no such
// element or its href does not parse.
function getDocumentBaseURL(document: Document): string {
	const fallback = document[kDocumentURL]!;
	for (const node of descendants(document)) {
		if (node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = node as Element;
		if (element[kNamespace] !== HTML_NAMESPACE) {
			continue;
		}
		if (element[kLocalName] !== "base") {
			continue;
		}
		const href = element.getAttribute("href");
		if (href === null) {
			continue;
		}
		return parseURL(href, fallback) ?? fallback;
	}
	return fallback;
}

function parseInteger(value: string): number | null {
	const match = /^[\t\n\f\r ]*([+-]?[0-9]+)/.exec(value);
	if (match === null) {
		return null;
	}
	const number = Number(match[1]);
	return Number.isSafeInteger(number) ? number : null;
}

/** A sign is not allowed in a non-negative integer. */
function parseNonNegativeInteger(value: string): number | null {
	const match = /^[\t\n\f\r ]*([0-9]+)/.exec(value);
	if (match === null) {
		return null;
	}
	const number = Number(match[1]);
	return Number.isSafeInteger(number) ? number : null;
}

function getReflectedTokenList(
	element: Element,
	property: string,
	attribute: string,
	supported: readonly string[],
): DOMTokenList {
	let lists = element[kTokenLists]!;
	if (lists === null) {
		lists = new Map<string, DOMTokenList>();
		element[kTokenLists] = lists;
	}
	let list = lists.get(property);
	if (list === undefined) {
		// An attribute with no supported tokens is one whose supports() throws,
		// which is what a list built without them does.
		list = new DOMTokenList(
			element,
			attribute,
			supported.length === 0 ? undefined : [...supported],
		);
		ensureList(list);
		lists.set(property, list);
	}
	return list;
}

// Every setter writes through setAttribute, which already runs the
// attribute change steps, mutation records and custom element reactions.
// So a reflected write is indistinguishable from the attribute write it
// stands for.
function installReflection(prototype: object, spec: ReflectSpec): void {
	const attribute = spec.attribute;
	let get: () => unknown;
	let set: ((value: unknown) => void) | undefined;
	switch (spec.kind) {
		case "string":
			get = function (this: Element): string {
				return this.getAttribute(attribute) ?? "";
			};
			set = function (this: Element, value: unknown): void {
				this.setAttribute(attribute, String(value));
			};
			break;
		case "nullable-string":
			get = function (this: Element): string | null {
				return this.getAttribute(attribute);
			};
			set = function (this: Element, value: unknown): void {
				if (value === null || value === undefined) {
					this.removeAttribute(attribute);
				} else {
					this.setAttribute(attribute, String(value));
				}
			};
			break;
		case "url":
			get = function (this: Element): string {
				const value = this.getAttribute(attribute);
				if (value === null) {
					return "";
				}
				const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
				return parseURL(trimmed, getDocumentBaseURL(this[kDocument]!)) ??
					trimmed;
			};
			set = function (this: Element, value: unknown): void {
				this.setAttribute(attribute, String(value));
			};
			break;
		case "boolean":
			get = function (this: Element): boolean {
				return this.hasAttribute(attribute);
			};
			set = function (this: Element, value: unknown): void {
				this.toggleAttribute(attribute, Boolean(value));
			};
			break;
		case "long": {
			const fallback = spec.fallback ?? 0;
			get = function (this: Element): number {
				const value = this.getAttribute(attribute);
				const parsed = value === null ? null : parseInteger(value);
				if (parsed === null) {
					return fallback;
				}
				if (parsed < -2147483648 || parsed > 2147483647) {
					return fallback;
				}
				if (spec.nonNegative && parsed < 0) {
					return fallback;
				}
				return parsed;
			};
			set = function (this: Element, value: unknown): void {
				const number = toLong(value);
				if (spec.nonNegative && number < 0) {
					throw indexSizeError(`${spec.property} cannot be negative`);
				}
				this.setAttribute(attribute, String(number));
			};
			break;
		}
		case "unsigned-long": {
			const fallback = spec.fallback ?? 0;
			get = function (this: Element): number {
				const value = this.getAttribute(attribute);
				let parsed = value === null ? null : parseNonNegativeInteger(value);
				if (parsed !== null && parsed > 2147483647) {
					parsed = null;
				}
				if (parsed !== null && spec.greaterThanZero && parsed === 0) {
					parsed = null;
				}
				if (parsed === null) {
					if (spec.clampMin === undefined) {
						return fallback;
					}
					parsed = fallback;
				}
				if (spec.clampMin !== undefined) {
					parsed = Math.max(
						spec.clampMin,
						Math.min(spec.clampMax ?? parsed, parsed),
					);
				}
				return parsed;
			};
			set = function (this: Element, value: unknown): void {
				const number = toUnsignedLong(value);
				if (spec.greaterThanZero && number === 0) {
					throw indexSizeError(`${spec.property} cannot be zero`);
				}
				this.setAttribute(
					attribute,
					String(number > 2147483647 ? fallback : number),
				);
			};
			break;
		}
		case "enum": {
			const keywords = spec.keywords ?? [];
			const missing = spec.missing ?? "";
			const invalid = spec.invalid ?? "";
			get = function (this: Element): string | null {
				const value = this.getAttribute(attribute);
				if (value === null) {
					return spec.nullable ? null : missing;
				}
				// If the empty string is one of the attribute's own keywords,
				// it maps to the state that keyword names.
				if (value === "" && spec.empty !== undefined) {
					return spec.empty;
				}
				const lowered = toASCIILowercase(value);
				for (const candidate of keywords) {
					if (toASCIILowercase(candidate) === lowered) {
						return candidate;
					}
				}
				return invalid;
			};
			set = function (this: Element, value: unknown): void {
				if (spec.nullable && (value === null || value === undefined)) {
					this.removeAttribute(attribute);
					return;
				}
				this.setAttribute(attribute, String(value));
			};
			break;
		}
		case "tokenlist": {
			const supported = spec.supported ?? [];
			get = function (this: Element): DOMTokenList {
				return getReflectedTokenList(this, spec.property, attribute, supported);
			};
			set = function (this: Element, value: unknown): void {
				this.setAttribute(attribute, String(value));
			};
			break;
		}
		default:
			throw new TypeError(`${spec.kind} is not a way to reflect an attribute`);
	}
	Object.defineProperty(prototype, spec.property, {
		get,
		set: set === undefined ? undefined : wrapWithReactions(set),
		enumerable: true,
		configurable: true,
	});
}

// The HTML Standard's element interfaces, each filled in from the table.
// The reflecting members come from `HTML_INTERFACES`. Members that are
// not reflections are written in the class body. A class with an empty
// body only reflects, which is all its interface does.
class HTMLAnchorElement extends HTMLElement {
	get text(): string {
		return getDescendantText(this);
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}
}

// Written out rather than picked. A computed projection satisfies keyof
// but not assignability, and assignability is what this is for.
interface HTMLAnchorElement {
	hash: string;
	host: string;
	hostname: string;
	href: string;
	toString(): string;
	readonly origin: string;
	password: string;
	pathname: string;
	port: string;
	protocol: string;
	search: string;
	username: string;
	charset: string;
	coords: string;
	download: string;
	hreflang: string;
	name: string;
	ping: string;
	referrerPolicy: string;
	rel: string;
	get relList(): DOMTokenList;
	set relList(value: string);
	rev: string;
	shape: string;
	target: string;
	text: string;
	type: string;
}

function createHyperlinkPart(
	read: (url: URL) => string,
	write: (url: URL, value: string) => void,
	absent: string,
): PropertyDescriptor {
	return {
		get(this: Element): string {
			const url = getHyperlinkURL(this);
			return url === null ? absent : read(url);
		},
		set(this: Element, value: string): void {
			writeHyperlink(this, (url) => write(url, String(value)));
		},
		enumerable: true,
		configurable: true,
	};
}

const hyperlinkMembers: PropertyDescriptorMap = {
	href: {
		get(this: Element): string {
			const value = this.getAttribute("href");
			if (value === null) {
				return "";
			}
			const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
			return parseURL(trimmed, getDocumentBaseURL(this[kDocument]!)) ?? trimmed;
		},
		set(this: Element, value: string): void {
			this.setAttribute("href", String(value));
		},
		enumerable: true,
		configurable: true,
	},
	origin: {
		get(this: Element): string {
			const url = getHyperlinkURL(this);
			return url === null ? "" : url.origin;
		},
		enumerable: true,
		configurable: true,
	},
	protocol: createHyperlinkPart(
		(url) => url.protocol,
		(url, value) => {
			url.protocol = value;
		},
		":",
	),
	username: createHyperlinkPart(
		(url) => url.username,
		(url, value) => {
			url.username = value;
		},
		"",
	),
	password: createHyperlinkPart(
		(url) => url.password,
		(url, value) => {
			url.password = value;
		},
		"",
	),
	host: createHyperlinkPart(
		(url) => url.host,
		(url, value) => {
			url.host = value;
		},
		"",
	),
	hostname: createHyperlinkPart(
		(url) => url.hostname,
		(url, value) => {
			url.hostname = value;
		},
		"",
	),
	port: createHyperlinkPart(
		(url) => url.port,
		(url, value) => {
			url.port = value;
		},
		"",
	),
	pathname: createHyperlinkPart(
		(url) => url.pathname,
		(url, value) => {
			url.pathname = value;
		},
		"",
	),
	search: createHyperlinkPart(
		(url) => (url.search === "?" ? "" : url.search),
		(url, value) => {
			url.search = value;
		},
		"",
	),
	hash: createHyperlinkPart(
		(url) => (url.hash === "#" ? "" : url.hash),
		(url, value) => {
			url.hash = value;
		},
		"",
	),
	toString: {
		value: function toString(this: Element): string {
			const value = this.getAttribute("href");
			if (value === null) {
				return "";
			}
			const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
			return parseURL(trimmed, getDocumentBaseURL(this[kDocument]!)) ?? trimmed;
		},
		writable: true,
		enumerable: true,
		configurable: true,
	},
};

function getHyperlinkURL(element: Element): URL | null {
	const value = element.getAttribute("href");
	if (value === null) {
		return null;
	}
	const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	try {
		return new URL(trimmed, getDocumentBaseURL(element[kDocument]!));
	} catch (_err) {
		return null;
	}
}

function writeHyperlink(element: Element, change: (url: URL) => void): void {
	const url = getHyperlinkURL(element);
	if (url === null) {
		return;
	}
	try {
		change(url);
	} catch (_err) {
		return;
	}
	element.setAttribute("href", url.href);
}

Object.defineProperties(HTMLAnchorElement.prototype, hyperlinkMembers);

class HTMLAreaElement extends HTMLElement {}

interface HTMLAreaElement
	extends Pick<
		globalThis.HTMLAreaElement,
		"alt" |
		"coords" |
		"download" |
		"hash" |
		"host" |
		"hostname" |
		"href" |
		"noHref" |
		"origin" |
		"password" |
		"pathname" |
		"ping" |
		"port" |
		"protocol" |
		"referrerPolicy" |
		"rel" |
		"relList" |
		"search" |
		"shape" |
		"target" |
		"toString" |
		"username"
	> {}
Object.defineProperties(HTMLAreaElement.prototype, hyperlinkMembers);

// Its own href is the exception: it resolves against the document's URL
// rather than the base, because it is the base.
interface HTMLBaseElement
	extends Pick<
		globalThis.HTMLBaseElement,
		"target"
	> {}

class HTMLBaseElement extends HTMLElement {
	get href(): string {
		const value = this.getAttribute("href");
		const fallback = this[kDocument]![kDocumentURL]!;
		if (value === null) {
			return fallback;
		}
		return parseURL(value, fallback) ?? fallback;
	}

	set href(value: string) {
		this.setAttribute("href", String(value));
	}
}

interface HTMLBodyElement
	extends Pick<
		globalThis.HTMLBodyElement,
		"aLink" |
		"background" |
		"bgColor" |
		"link" |
		"text" |
		"vLink"
	> {}

interface HTMLBodyElement
	extends Pick<
		globalThis.HTMLBodyElement,
		"onafterprint" |
		"onbeforeprint" |
		"onbeforeunload" |
		"ongamepadconnected" |
		"ongamepaddisconnected" |
		"onhashchange" |
		"onlanguagechange" |
		"onmessage" |
		"onmessageerror" |
		"onoffline" |
		"ononline" |
		"onpagehide" |
		"onpagereveal" |
		"onpageshow" |
		"onpageswap" |
		"onpopstate" |
		"onrejectionhandled" |
		"onstorage" |
		"onunhandledrejection" |
		"onunload"
	> {}

class HTMLBodyElement extends HTMLElement {}

interface HTMLBRElement
	extends Pick<
		globalThis.HTMLBRElement,
		"clear"
	> {}

class HTMLBRElement extends HTMLElement {}

interface HTMLButtonElement
	extends Pick<
		globalThis.HTMLButtonElement,
		"disabled" |
		"name" |
		"value"
	> {}

interface HTMLButtonElement
	extends Pick<
		globalThis.HTMLButtonElement,
		"formAction" |
		"formEnctype" |
		"formMethod" |
		"formNoValidate" |
		"formTarget" |
		"popoverTargetAction"
	> {}

class HTMLButtonElement extends HTMLElement {
	// Installed from the element table and read by the algorithms below.
	declare type: string;

	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get labels(): NodeList {
		return getLabels(this);
	}

	get popoverTargetElement(): Element | null {
		return getPopoverTargetAttributeElement(this);
	}

	set popoverTargetElement(value: Element | null) {
		setPopoverTargetAttributeElement(this, value);
	}
}

// A rendering context is a bitmap, and there is none. getContext
// returns null exactly as it does for an unsupported context type.
interface HTMLCanvasElement
	extends Pick<
		globalThis.HTMLCanvasElement,
		"height" |
		"width"
	> {}

class HTMLCanvasElement extends HTMLElement {
	getContext(contextId: string): null {
		if (arguments.length < 1) {
			throw new TypeError("getContext needs a context id");
		}
		void contextId;
		return null;
	}
}

interface HTMLDataElement
	extends Pick<
		globalThis.HTMLDataElement,
		"value"
	> {}

class HTMLDataElement extends HTMLElement {}

const kOptions = Symbol("options");

class HTMLDataListElement extends HTMLElement {
	declare [kOptions]?: HTMLCollection | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kOptions] = null;
	}

	get options(): HTMLCollection {
		let options = this[kOptions]!;
		if (options === null) {
			options = new HTMLCollection(() => {
				const found: Element[] = [];
				for (const node of descendants(this)) {
					if (node instanceof HTMLOptionElement) {
						found.push(node);
					}
				}
				return found;
			}, this);
			this[kOptions] = options;
		}
		return options;
	}
}

const kToggleQueued = Symbol("toggleQueued");
const kStateAtQueue = Symbol("stateAtQueue");

const kContent = Symbol("content");

const kUpgraded = Symbol("upgraded");

// The toggle event is queued rather than fired when the attribute
// changes, so several changes in one turn report only the final state.
// The element renders a closed shadow tree it owns, like the form
// controls: a slot the first summary child projects through, and a
// content container (part=details-content) whose slot takes every other
// child, including text nodes, which no light-tree selector could reach.
// Hiding a closed details' body is then one display flip on that
// container.
interface HTMLDetailsElement
	extends Pick<
		globalThis.HTMLDetailsElement,
		"name" |
		"open"
	> {}

class HTMLDetailsElement extends HTMLElement {
	declare [kToggleQueued]?: boolean;
	declare [kStateAtQueue]?: string;

	declare [kUpgraded]?: boolean;
	declare [kContent]?: globalThis.HTMLElement | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kToggleQueued] = false;
		this[kStateAtQueue] = "closed";
		this[kUpgraded] = false;
		this[kContent] = null;
	}

	[kEnsureUAShadowTree]?(): void {
		if (this[kUpgraded]) {
			this[kSyncUAShadowTree]!();
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		this[kUpgraded] = true;
		const document = getUADocument(this);
		const root = buildUAShadowTree(this, attached, DETAILS_UA_STYLES);
		const shadow = root as unknown as ShadowRoot;
		const summarySlot = document.createElement("slot");
		const content = document.createElement("div");
		content.setAttribute("part", "details-content");
		content.appendChild(document.createElement("slot"));
		// The distribution function must be in place before the slots enter the
		// tree, because inserting each slot runs the assignment pass that fills
		// it.
		shadow[kSlotAssignment] = "manual";
		shadow[kUASlotting] = (slot) =>
			getDetailsSlottables(this, slot === summarySlot);
		root.appendChild(summarySlot);
		root.appendChild(content);
		this[kContent] = content;
		this[kSyncUAShadowTree]!();
	}

	[kSyncUAShadowTree]?(): void {
		const content = this[kContent]!;
		if (content === null) {
			return;
		}
		const display = this.hasAttribute("open") ? "block" : "none";
		if (content.style.display !== display) {
			content.style.display = display;
		}
	}

	override [kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChangeSteps]!(localName, oldValue, value, namespace);
		if (namespace !== null || localName !== "open") {
			return;
		}
		if ((oldValue === null) === (value === null)) {
			return;
		}
		if (!this[kToggleQueued]!) {
			this[kToggleQueued] = true;
			this[kStateAtQueue] = oldValue === null ? "closed" : "open";
			queueMicrotask(() => {
				this[kToggleQueued] = false;
				const now = this.hasAttribute("open") ? "open" : "closed";
				if (now === this[kStateAtQueue]!) {
					return;
				}
				dispatch(
					this,
					new ToggleEvent("toggle", {
						oldState: this[kStateAtQueue]!,
						newState: now,
					}),
				);
			});
		}
	}
}

// The first summary element child goes to the summary slot and every
// other slottable child to the content slot. Recomputed from the child
// list on each assignment pass.
function getDetailsSlottables(
	host: HTMLDetailsElement,
	toSummary: boolean,
): Slottable[] {
	const summary = getFirstChildElement(host, "summary");
	const result: Slottable[] = [];
	for (let child = host[kFirstChild]!; child !== null; child = child[kNext]!) {
		if (isSlottable(child) && (child === summary) === toSummary) {
			result.push(child as Slottable);
		}
	}
	return result;
}

interface ToggleEventInit extends EventInit {
	oldState?: string;
	newState?: string;
	source?: Element | null;
}

const kOldState = Symbol("oldState");
const kNewState = Symbol("newState");
const kSource = Symbol("source");

class ToggleEvent extends Event {
	declare [kOldState]?: string;
	declare [kNewState]?: string;
	declare [kSource]?: Element | null;

	constructor(type: string, eventInitDict: ToggleEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<ToggleEventInit>(eventInitDict, "An event init");
		this[kOldState] = String(init.oldState ?? "");
		this[kNewState] = String(init.newState ?? "");
		this[kSource] = init.source ?? null;
	}

	get oldState(): string {
		return this[kOldState]!;
	}

	get newState(): string {
		return this[kNewState]!;
	}

	get source(): Element | null {
		return this[kSource]!;
	}
}

Object.defineProperty(ToggleEvent.prototype, Symbol.toStringTag, {
	value: "ToggleEvent",
	configurable: true,
});

const kPreviouslyFocused = Symbol("previouslyFocused");

// showModal() puts the dialog in the document's top layer, above every
// stacking context and outside the flow it was written in, and makes the
// rest of the document unreachable until it closes. show() leaves it
// where it is, as an ordinary visible box.
interface HTMLDialogElement
	extends Pick<
		globalThis.HTMLDialogElement,
		"open"
	> {}

class HTMLDialogElement extends HTMLElement {
	declare [kReturnValue]?: string;
	// Where focus was when the dialog took it, so closing can restore it.
	declare [kPreviouslyFocused]?: Element | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kReturnValue] = "";
		this[kPreviouslyFocused] = null;
	}

	get returnValue(): string {
		return this[kReturnValue]!;
	}

	set returnValue(value: string) {
		this[kReturnValue] = String(value);
	}

	show(): void {
		if (this.hasAttribute("open")) {
			if (isModalDialog(this)) {
				throw domError(
					"InvalidStateError",
					"That dialog is already showing modally",
				);
			}
			return;
		}
		this.setAttribute("open", "");
		focusDialog(this);
	}

	showModal(): void {
		if (this.hasAttribute("open")) {
			throw domError("InvalidStateError", "That dialog is already showing");
		}
		if (!isConnectedNode(this)) {
			throw domError(
				"InvalidStateError",
				"A dialog must be connected to show modally",
			);
		}
		// Top layer membership IS the modality. Everything else (`:modal`, the
		// backdrop, the hit testing that stops clicks reaching the page) reads
		// membership rather than a separate flag.
		getTopLayer(this[kDocument]!).add(this);
		this.setAttribute("open", "");
		focusDialog(this);
	}

	close(returnValue?: string): void {
		closeDialog(this, returnValue);
	}

	requestClose(returnValue?: string): void {
		if (!this.hasAttribute("open")) {
			return;
		}
		const canceled = !dispatch(this, new Event("cancel", {cancelable: true}));
		if (canceled) {
			return;
		}
		closeDialog(this, returnValue);
	}

	// Nothing off the tree can render above the document, and a detached
	// dialog is no longer modal.
	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		getTopLayer(this[kDocument]!).delete(this);
	}
}

// HTML's dialog focusing steps: the descendant with `autofocus`, else
// the first descendant that can take focus, else the dialog itself. The
// dialog is focusable exactly while it is the modal one, so a dialog of
// plain text still takes keys away from the page.
function focusDialog(
	dialog: HTMLDialogElement,
): void {
	dialog[kPreviouslyFocused] = dialog[kDocument]![kActiveElement]!;
	const walker = shadowIncludingInclusiveDescendants(dialog);
	let fallback: Element | null = null;
	for (const node of walker) {
		if (node === dialog || node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = node as Element;
		if (!isFocusableArea(element)) {
			continue;
		}
		if (element.hasAttribute("autofocus")) {
			(element as HTMLElement).focus();
			return;
		}
		if (fallback === null) {
			fallback = element;
		}
	}
	if (fallback !== null) {
		(fallback as HTMLElement).focus();
		return;
	}
	if (isModalDialog(dialog)) {
		dialog[kDocument]![kActiveElement] = dialog;
	}
}

function closeDialog(
	dialog: HTMLDialogElement,
	returnValue: string | undefined,
): void {
	if (!dialog.hasAttribute("open")) {
		return;
	}
	const document = dialog[kDocument]!;
	const wasModal = isModalDialog(dialog);
	dialog.removeAttribute("open");
	getTopLayer(document).delete(dialog);
	// Restore focus to where the dialog took it from, if the dialog holds
	// focus or held the whole page inert as the modal one.
	const previous = dialog[kPreviouslyFocused]!;
	dialog[kPreviouslyFocused] = null;
	const active = document[kActiveElement]!;
	const heldFocus =
		active !== null && isShadowIncludingInclusiveAncestor(dialog, active);
	if (previous !== null && (wasModal || heldFocus)) {
		(previous as HTMLElement).focus();
	}
	// focus() refuses a target that left the tree or stopped being
	// focusable. Focus still inside the closed dialog falls back to the body.
	const after = document[kActiveElement]!;
	if (after !== null && isShadowIncludingInclusiveAncestor(dialog, after)) {
		(after as HTMLElement).blur();
	}
	if (returnValue !== undefined) {
		dialog[kReturnValue] = String(returnValue);
	}
	dispatch(dialog, new Event("close"));
}

const kTopLayer = Symbol("the document's top layer");

/**
 * The elements that render above every stacking context of the document,
 * in the order they entered. `showModal` adds to it, `close` removes from
 * it, and the renderer paints it last.
 */
export function getTopLayer(document: globalThis.Document): Set<Element> {
	return (document as Document)[kTopLayer]!;
}

/**
 * The top layer's members that are on screen, in the order they joined. A
 * member not in the flat tree is skipped rather than removed. Whether it
 * comes back is the tree's decision, not the reader's.
 */
export function renderedTopLayer(
	document: globalThis.Document,
): globalThis.Element[] {
	const rendered: Element[] = [];
	for (const element of getTopLayer(document)) {
		// Uses flat-tree connectedness. A UA part (the select's picker) lives
		// in a fragment and is never DOM-connected while very much on screen.
		if (flatIsConnected(element)) {
			rendered.push(element);
		}
	}
	return rendered;
}

/**
 * The state `:modal` matches. A dialog is modal exactly while it is in its
 * document's top layer. `show()` never adds it and `closeDialog()` removes it,
 * so no second flag needs to be kept in sync.
 */
export function isModalDialog(node: globalThis.Node): boolean {
	return (
		node instanceof HTMLDialogElement &&
		getTopLayer(node[kDocument]!).has(node as Element)
	);
}

function isConnectedNode(node: Node): boolean {
	return node[kConnected]!;
}

interface HTMLDirectoryElement
	extends Pick<
		globalThis.HTMLDirectoryElement,
		"compact"
	> {}

class HTMLDirectoryElement extends HTMLElement {}

interface HTMLDivElement
	extends Pick<
		globalThis.HTMLDivElement,
		"align"
	> {}

class HTMLDivElement extends HTMLElement {}

interface HTMLDListElement
	extends Pick<
		globalThis.HTMLDListElement,
		"compact"
	> {}

class HTMLDListElement extends HTMLElement {}

/** Never loads, so it has no SVG document. */
class HTMLEmbedElement extends HTMLElement {
	getSVGDocument(): null {
		return null;
	}
}

interface HTMLEmbedElement
	extends Pick<
		globalThis.HTMLEmbedElement,
		"align" |
		"getSVGDocument" |
		"height" |
		"name" |
		"src" |
		"type" |
		"width"
	> {}

const kElements = Symbol("elements");

interface HTMLFieldSetElement
	extends Pick<
		globalThis.HTMLFieldSetElement,
		"disabled" |
		"name"
	> {}

class HTMLFieldSetElement extends HTMLElement {
	declare [kElements]?: HTMLCollection | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kElements] = null;
	}

	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get type(): string {
		return "fieldset";
	}

	get elements(): HTMLCollection {
		let elements = this[kElements]!;
		if (elements === null) {
			elements = new HTMLCollection(() => {
				const listed: Element[] = [];
				for (const node of descendants(this)) {
					if (node.nodeType !== ELEMENT_NODE) {
						continue;
					}
					if (isListed(node as Element)) {
						listed.push(node as Element);
					}
				}
				return listed;
			}, this);
			this[kElements] = elements;
		}
		return elements;
	}
}

interface HTMLFontElement
	extends Pick<
		globalThis.HTMLFontElement,
		"color" |
		"face" |
		"size"
	> {}

class HTMLFontElement extends HTMLElement {}

const kFiringReset = Symbol("firingReset");

// Submission navigates, and this DOM does not navigate. `submit()` runs
// the steps up to the navigation and stops. `requestSubmit()` fires the
// submit event those steps fire first. `reset()` fires its event and
// restores every control the form owns to its default.
class HTMLFormElement extends HTMLElement {
	declare [kElements]?: HTMLFormControlsCollection | null;
	declare [kFiringReset]?: boolean;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kElements] = null;
		this[kFiringReset] = false;
	}

	get elements(): HTMLFormControlsCollection {
		let elements = this[kElements]!;
		if (elements === null) {
			elements = new HTMLFormControlsCollection(
				() => getListedElements(this),
				this,
			);
			this[kElements] = elements;
		}
		return elements;
	}

	get length(): number {
		return this.elements.length;
	}

	/** An alias of enctype, per spec. */
	get encoding(): string {
		return this.enctype;
	}

	set encoding(value: string) {
		this.enctype = value;
	}

	submit(): void {
		submitForm(this, null, true);
	}

	requestSubmit(submitter: HTMLElement | null = null): void {
		if (submitter !== null && submitter !== undefined) {
			if (!(submitter instanceof Element) || !isSubmitButton(submitter)) {
				throw new TypeError("That element is not a submit button");
			}
			if (getFormOwner(submitter) !== this) {
				throw notFoundError("That button does not belong to this form");
			}
		} else {
			submitter = null;
		}
		submitForm(this, submitter, false);
	}

	reset(): void {
		if (this[kFiringReset]!) {
			return;
		}
		this[kFiringReset] = true;
		let canceled: boolean;
		try {
			canceled = !dispatch(
				this,
				new Event("reset", {bubbles: true, cancelable: true}),
			);
		} finally {
			this[kFiringReset] = false;
		}
		if (canceled) {
			return;
		}
		for (const control of getListedElements(this)) {
			resetControl(control);
		}
	}

	checkValidity(): boolean {
		for (const control of this.elements) {
			if (!checkValidity(control as Element)) {
				return false;
			}
		}
		return true;
	}

	// A terminal has no validation bubble to show, so there is nothing to do
	// beyond the check.
	reportValidity(): boolean {
		return this.checkValidity();
	}

	[Symbol.iterator](): ArrayIterator<Element> {
		return this.elements[Symbol.iterator]();
	}
}

interface HTMLFormElement {
	acceptCharset: string;
	action: string;
	autocomplete: AutoFillBase;
	elements: HTMLFormControlsCollection;
	encoding: string;
	enctype: string;
	length: number;
	method: string;
	name: string;
	noValidate: boolean;
	rel: string;
	get relList(): DOMTokenList;
	set relList(value: string);
	target: string;
	checkValidity(): boolean;
	reportValidity(): boolean;
	requestSubmit(submitter?: HTMLElement | null): void;
	reset(): void;
	submit(): void;
}

function getListedElements(form: HTMLFormElement): Element[] {
	const controls: Element[] = [];
	const root = getRoot(form);
	for (const node of descendants(root)) {
		if (node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = node as Element;
		if (!isListed(element)) {
			continue;
		}
		if (getFormOwner(element) !== form) {
			continue;
		}
		if (element instanceof HTMLInputElement && element.type === "image") {
			continue;
		}
		controls.push(element);
	}
	return controls;
}

function isSubmitButton(element: Element): boolean {
	if (element instanceof HTMLButtonElement) {
		return element.type === "submit";
	}
	if (element instanceof HTMLInputElement) {
		const type = element.type;
		return type === "submit" || type === "image";
	}
	return false;
}

// Fires the submit event unless the caller was `submit()`, which the
// spec defines as skipping it. The navigation itself is the one step this
// DOM does not have.
function submitForm(
	form: HTMLFormElement,
	submitter: Element | null,
	skipEvent: boolean,
): void {
	// A form outside a document cannot submit, because submission ends in a
	// navigation and there is nothing to navigate. The submit event does not
	// fire either.
	if (!form.isConnected) {
		return;
	}
	if (skipEvent) {
		return;
	}
	const event = new SubmitEvent("submit", {
		bubbles: true,
		cancelable: true,
		submitter: submitter as HTMLElement | null,
	});
	dispatch(form, event);
}

const kResetControl = Symbol("put a control back to its default");

function resetControl(control: Element): void {
	const resettable = control as unknown as Record<symbol, () => void>;
	if (typeof resettable[kResetControl] === "function") {
		resettable[kResetControl]!();
	} else if (isFormAssociatedCustom(control)) {
		enqueueCallbackReaction(control, "formResetCallback", []);
	}
}

interface SubmitEventInit extends EventInit {
	submitter?: HTMLElement | null;
}

const kSubmitter = Symbol("submitter");

class SubmitEvent extends Event {
	declare [kSubmitter]?: HTMLElement | null;

	constructor(type: string, eventInitDict: SubmitEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<SubmitEventInit>(eventInitDict, "An event init");
		this[kSubmitter] = init.submitter ?? null;
	}

	get submitter(): HTMLElement | null {
		return this[kSubmitter]!;
	}
}

Object.defineProperty(SubmitEvent.prototype, Symbol.toStringTag, {
	value: "SubmitEvent",
	configurable: true,
});

// WebIDL has this inherit HTMLCollection, so it does. What it returns
// for a shared name is wider than the inherited return type, which a
// subclass cannot declare in TypeScript, so the merged interface below
// declares it instead. lib.dom gets the same result by splitting the base
// in two, which no engine does.
class HTMLFormControlsCollection extends HTMLCollection {
	declare [kOwner]?: Node | null;

	constructor(compute: () => Element[], owner: Node | null = null) {
		// The form attribute can associate a control anywhere in the tree, and
		// what counts as a control depends on its attributes, so the list is
		// document-wide and any attribute is an input to it.
		super(compute, owner, null, anyAttribute, true);
		this[kOwner] = owner;
	}

	override namedItem(name: string): Element | null {
		const key = String(name);
		if (key === "") {
			return null;
		}
		const matches = createMatchingCollection(this, key);
		if (matches.length === 0) {
			return null;
		}
		if (matches.length === 1) {
			return matches[0] as Element;
		}
		// A shared name returns the list of everything that shares it.
		return new RadioNodeList(
			() => createMatchingCollection(this, key),
			this[kOwner]!,
		) as unknown as Element;
	}

	override namedProperties(items: Node[]): Map<string, Node> {
		const counts = new Map<string, Node[]>();
		for (const item of items) {
			const element = item as Element;
			for (const key of [
				element.getAttribute("id"),
				element.getAttribute("name"),
			]) {
				if (key === null || key === "") {
					continue;
				}
				const list = counts.get(key);
				if (list === undefined) {
					counts.set(key, [element]);
				} else if (!list.includes(element)) {
					list.push(element);
				}
			}
		}
		const named = new Map<string, Node>();
		for (const [key, list] of counts) {
			named.set(
				key,
				list.length === 1
					? list[0]
					: (new RadioNodeList(
						() => createMatchingCollection(this, key),
						this[kOwner]!,
					) as unknown as Node),
			);
		}
		return named;
	}
}

function createMatchingCollection(
	collection: HTMLFormControlsCollection,
	key: string,
): Node[] {
	const matches: Node[] = [];
	for (const item of ensureList(collection)) {
		const element = item as Element;
		if (
			element.getAttribute("id") === key ||
			element.getAttribute("name") === key
		) {
			matches.push(element);
		}
	}
	return matches;
}

interface HTMLFormControlsCollection {
	namedItem(name: string): RadioNodeList | Element | null;
}

Object.defineProperty(
	HTMLFormControlsCollection.prototype,
	Symbol.toStringTag,
	{value: "HTMLFormControlsCollection", configurable: true},
);

class RadioNodeList extends NodeList {
	constructor(compute: () => Node[], owner: Node | null = null) {
		super(compute, true, owner, null, anyAttribute, true);
	}

	get value(): string {
		for (const node of ensureList(this)) {
			if (!(node instanceof HTMLInputElement)) {
				continue;
			}
			if (node.type !== "radio" || !node.checked) {
				continue;
			}
			return node.getAttribute("value") ?? "on";
		}
		return "";
	}

	set value(value: string) {
		const wanted = String(value);
		for (const node of ensureList(this)) {
			if (!(node instanceof HTMLInputElement)) {
				continue;
			}
			if (node.type !== "radio") {
				continue;
			}
			if ((node.getAttribute("value") ?? "on") !== wanted) {
				continue;
			}
			node.checked = true;
			return;
		}
	}
}

Object.defineProperty(RadioNodeList.prototype, Symbol.toStringTag, {
	value: "RadioNodeList",
	configurable: true,
});

/** Has no browsing context here either. */
interface HTMLFrameElement
	extends Pick<
		globalThis.HTMLFrameElement,
		"frameBorder" |
		"longDesc" |
		"marginHeight" |
		"marginWidth" |
		"name" |
		"noResize" |
		"scrolling" |
		"src"
	> {}

class HTMLFrameElement extends HTMLElement {
	get contentDocument(): null {
		return null;
	}

	get contentWindow(): null {
		return null;
	}
}

interface HTMLFrameSetElement
	extends Pick<
		globalThis.HTMLFrameSetElement,
		"cols" |
		"rows"
	> {}

interface HTMLFrameSetElement
	extends Pick<
		globalThis.HTMLFrameSetElement,
		"onafterprint" |
		"onbeforeprint" |
		"onbeforeunload" |
		"ongamepadconnected" |
		"ongamepaddisconnected" |
		"onhashchange" |
		"onlanguagechange" |
		"onmessage" |
		"onmessageerror" |
		"onoffline" |
		"ononline" |
		"onpagehide" |
		"onpagereveal" |
		"onpageshow" |
		"onpageswap" |
		"onpopstate" |
		"onrejectionhandled" |
		"onstorage" |
		"onunhandledrejection" |
		"onunload"
	> {}

class HTMLFrameSetElement extends HTMLElement {}

class HTMLHeadElement extends HTMLElement {}

interface HTMLHeadingElement
	extends Pick<
		globalThis.HTMLHeadingElement,
		"align"
	> {}

class HTMLHeadingElement extends HTMLElement {}

interface HTMLHRElement
	extends Pick<
		globalThis.HTMLHRElement,
		"align" |
		"color" |
		"noShade" |
		"size" |
		"width"
	> {}

class HTMLHRElement extends HTMLElement {}

interface HTMLHtmlElement
	extends Pick<
		globalThis.HTMLHtmlElement,
		"version"
	> {}

class HTMLHtmlElement extends HTMLElement {}

const kContentDocument = Symbol("contentDocument");
const kContentWindow = Symbol("contentWindow");
const kFrameDocumentRun = Symbol("frameDocumentRun");

interface FrameWindowLike {
	document: Document;
	customElements: CustomElementRegistry;
	frameElement: HTMLIFrameElement;
	HTMLElement: typeof HTMLElement;
}

// A nested document without a browsing context. On insertion the iframe
// gets a content document (its srcdoc parsed, or about:blank) with its
// own registry, and fires load. Removal discards it, as removal discards a
// browsing context. The src attribute does nothing, because this engine
// performs no fetches, so a src iframe holds about:blank, the same
// document a browser shows before navigation. There is no second realm;
// the frame's constructors are this realm's.
interface HTMLIFrameElement
	extends Pick<
		globalThis.HTMLIFrameElement,
		"align" |
		"allow" |
		"allowFullscreen" |
		"frameBorder" |
		"height" |
		"longDesc" |
		"marginHeight" |
		"marginWidth" |
		"name" |
		"referrerPolicy" |
		"sandbox" |
		"scrolling" |
		"src" |
		"srcdoc" |
		"width"
	> {}

interface HTMLIFrameElement
	extends Pick<
		globalThis.HTMLIFrameElement,
		"loading"
	> {}

class HTMLIFrameElement extends HTMLElement {
	declare [kContentDocument]?: Document | null;
	declare [kContentWindow]?: FrameWindowLike | null;
	// Identifies the stretch of connectedness the current content document
	// belongs to. Each removal and insertion starts a new one, so the load
	// task fires only for the insertion that scheduled it.
	declare [kFrameDocumentRun]?: object;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kContentDocument] = null;
		this[kContentWindow] = null;
		this[kFrameDocumentRun] = {};
	}

	get contentDocument(): Document | null {
		ensureFrameDocument(this);
		return this[kContentDocument]!;
	}

	get contentWindow(): FrameWindowLike | null {
		ensureFrameDocument(this);
		return this[kContentWindow]!;
	}

	getSVGDocument(): null {
		return null;
	}

	override [kInsertionSteps]?(): void {
		super[kInsertionSteps]!();
		if (!this.isConnected) {
			return;
		}
		// The document is built lazily on first access. Building it here would
		// re-enter the parser while a parse containing this iframe is still
		// running. The load event fires from a task, after the insertion has
		// finished and its listeners are attached.
		const run = (this[kFrameDocumentRun] = {});
		setTimeout(() => {
			if (this.isConnected && this[kFrameDocumentRun] === run) {
				this.dispatchEvent(new Event("load"));
			}
		}, 0);
	}

	override [kRemovingSteps]?(parent: Node): void {
		super[kRemovingSteps]!(parent);
		this[kContentDocument] = null;
		this[kContentWindow] = null;
		this[kFrameDocumentRun] = {};
	}
}

function ensureFrameDocument(frame: HTMLIFrameElement): void {
	if (!frame.isConnected || frame[kContentDocument] !== null) {
		return;
	}
	const srcdoc = frame.getAttribute("srcdoc");
	const contentDocument = parseHTMLDocument(
		srcdoc ?? "",
		srcdoc === null ? "about:blank" : "about:srcdoc",
	);
	contentDocument[kRegistry] = constructInternal(
		() => new CustomElementRegistry(),
	);
	frame[kContentDocument] = contentDocument;
	frame[kContentWindow] = {
		document: contentDocument,
		customElements: contentDocument[kRegistry]!,
		frameElement: frame,
		HTMLElement,
	};
}

// Nothing is fetched, so image data is never available. The natural
// dimensions are zero, the current source is empty, and decoding
// rejects. The width and height an author reads are the attributes,
// which is what the spec returns for an image that is not rendered.
class HTMLImageElement extends HTMLElement {
	get naturalWidth(): number {
		return 0;
	}

	get naturalHeight(): number {
		return 0;
	}

	get currentSrc(): string {
		return "";
	}

	get complete(): boolean {
		return !this.hasAttribute("src") && !this.hasAttribute("srcset");
	}

	// Deprecated members that report the rendered position. This engine
	// implements them through the geometry surface instead.
	get x(): number {
		return 0;
	}

	get y(): number {
		return 0;
	}

	decode(): Promise<void> {
		return Promise.reject(
			domError("EncodingError", "There is no image data to decode"),
		);
	}
}

interface HTMLImageElement
	extends Pick<
		globalThis.HTMLImageElement,
		"align" |
		"alt" |
		"border" |
		"complete" |
		"crossOrigin" |
		"currentSrc" |
		"decode" |
		"decoding" |
		"fetchPriority" |
		"height" |
		"hspace" |
		"isMap" |
		"loading" |
		"longDesc" |
		"lowsrc" |
		"name" |
		"naturalHeight" |
		"naturalWidth" |
		"referrerPolicy" |
		"sizes" |
		"src" |
		"srcset" |
		"useMap" |
		"vspace" |
		"width" |
		"x" |
		"y"
	> {}

const kDirtyValue = Symbol("dirtyValue");
const kSelectionStart = Symbol("selectionStart");
const kSelectionEnd = Symbol("selectionEnd");
const kSelectionDirection = Symbol("selectionDirection");
const kChecked = Symbol("checked");
const kDirtyChecked = Symbol("dirtyChecked");
const kIndeterminate = Symbol("indeterminate");
const kPreviousRadio = Symbol("previousRadio");
const kPreviouslyChecked = Symbol("previouslyChecked");
const kPreviouslyIndeterminate = Symbol("previouslyIndeterminate");
const kValueText = Symbol("valueText");
const kOnKeydown = Symbol("onKeydown");
const kOnBeforeInput = Symbol("onBeforeInput");
const kKind = Symbol("kind");
const kPlaceholderText = Symbol("placeholderText");
const kGlyphText = Symbol("glyphText");

// The value model is the spec's: an attribute holds the default, a
// separate value holds what was written, and a dirty flag decides which
// one the control reports. Checkedness works the same way. What the
// control RENDERS is a closed shadow tree it owns: a value part and a
// placeholder part for a text-like input, or a single glyph part for a
// checkbox or radio. The tree is derived from the value, which is the
// only state. The editing keys are the control's own default action,
// implemented as a keydown listener like a browser's editing internals.
interface HTMLInputElement
	extends Pick<
		globalThis.HTMLInputElement,
		"accept" |
		"align" |
		"alt" |
		"defaultChecked" |
		"defaultValue" |
		"dirName" |
		"disabled" |
		"max" |
		"maxLength" |
		"min" |
		"minLength" |
		"multiple" |
		"name" |
		"pattern" |
		"placeholder" |
		"readOnly" |
		"required" |
		"src" |
		"step" |
		"useMap"
	> {}

interface HTMLInputElement
	extends Pick<
		globalThis.HTMLInputElement,
		"autocomplete" |
		"formAction" |
		"formEnctype" |
		"formMethod" |
		"formNoValidate" |
		"formTarget" |
		"height" |
		"popoverTargetAction" |
		"size" |
		"width"
	> {}

const SELECTABLE_INPUT_TYPES = new Set([
	"text",
	"search",
	"url",
	"tel",
	"password",
]);

class HTMLInputElement extends HTMLElement {
	// Installed from the element table and read by the algorithms below.
	declare type: string;

	declare [kValue]?: string;
	declare [kDirtyValue]?: boolean;
	declare [kChecked]?: boolean;
	declare [kDirtyChecked]?: boolean;
	declare [kIndeterminate]?: boolean;
	declare [kSelectionStart]?: number;
	declare [kSelectionEnd]?: number;
	declare [kSelectionDirection]?: string;
	declare [kPreviouslyChecked]?: boolean;
	declare [kPreviouslyIndeterminate]?: boolean;
	declare [kPreviousRadio]?: HTMLInputElement | null;

	// The rendered tree and what it was built for: "text control" for a
	// text-like input, "toggle" for checkbox/radio, null until built. The two
	// are different trees, so a type change rebuilds.
	declare [kUpgraded]?: boolean;
	declare [kKind]?: "textControl" | "toggle" | null;
	declare [kRoot]?: globalThis.ShadowRoot | null;
	declare [kValueText]?: globalThis.Text | null;
	declare [kPlaceholderText]?: globalThis.Text | null;
	declare [kGlyphText]?: globalThis.Text | null;

	// A typed character arrives as insertText. A paste arrives as
	// insertFromPaste, and a single-line input strips its line breaks (HTML
	// value sanitization). A toggle accepts neither, since it holds no text.
	declare [kOnBeforeInput]?: (event: InputEvent) => void;

	// A checkbox or radio activates on Space or Enter and never accepts typed
	// text. Home and End move to the ends of the whole value, since an input
	// has no visual lines. Everything else is the shared text control logic.
	declare [kOnKeydown]?: (event: KeyboardEvent) => void;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kValue] = "";
		this[kDirtyValue] = false;
		this[kChecked] = false;
		this[kDirtyChecked] = false;
		this[kIndeterminate] = false;
		this[kSelectionStart] = 0;
		this[kSelectionEnd] = 0;
		this[kSelectionDirection] = "none";
		this[kPreviouslyChecked] = false;
		this[kPreviouslyIndeterminate] = false;
		this[kPreviousRadio] = null;
		this[kUpgraded] = false;
		this[kKind] = null;
		this[kRoot] = null;
		this[kValueText] = null;
		this[kPlaceholderText] = null;
		this[kGlyphText] = null;
		this[kOnBeforeInput] = (event: InputEvent): void => {
			if (event.defaultPrevented || event.data == null) {
				return;
			}
			if (getInputKind(this) !== "textControl") {
				return;
			}
			if (event.inputType === "insertText") {
				event.preventDefault();
				insertTextControlText(this, event.data);
				return;
			}
			if (event.inputType !== "insertFromPaste") {
				return;
			}
			event.preventDefault();
			insertTextControlText(this, event.data.replace(/[\r\n]+/g, ""));
		};
		this[kOnKeydown] = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) {
				return;
			}
			const {key, shiftKey, ctrlKey} = event;

			if (this.type === "checkbox" || this.type === "radio") {
			// Either key activates the control, and activation is what toggles
			// it: the pre-activation behavior flips checkedness, the activation
			// behavior fires input then change, and a canceled click restores
			// checkedness.
			//
			// Enter toggles here, where a browser does nothing. In a browser
			// Enter on a checkbox submits the form the control belongs to, and
			// does nothing outside a form. A terminal has no implicit
			// submission, so the key would be inert on a focused control. It
			// toggles for the same reason the readline chords edit.
				if (key === " " || key === "Enter") {
					this.click();
				}
				return;
			}

			// ArrowUp and ArrowDown step a number input, replacing the up/down
			// buttons a browser draws. A terminal has none, and every hand is
			// already on the keyboard. Stepping is a user edit, so it fires
			// input then change, as pressing those buttons does.
			if (
				this.type === "number" &&
				(key === "ArrowUp" || key === "ArrowDown")
			) {
				const stepped = getSteppedValue(this, key === "ArrowUp" ? 1 : -1);
				if (stepped !== null) {
					applyTextControlEdit(
						this,
						createCollapsedEdit(stepped, stepped.length),
					);
					dispatch(this, new Event("change", {bubbles: true}));
				}
				return;
			}

			const value = this[kUAValue]!;
			const {start, end, direction} = getSelectionRecord(this)!;
			const anchor = direction === "backward" ? end : start;
			const caret = direction === "backward" ? start : end;

			let result: TextControlEditResult | null;
			if (key === "Home" || (ctrlKey && key === "a")) {
				result = moveTextControlSelection(value, anchor, 0, shiftKey);
			} else if (key === "End" || (ctrlKey && key === "e")) {
				result = moveTextControlSelection(
					value,
					anchor,
					value.length,
					shiftKey,
				);
			} else if (ctrlKey && key === "k") {
				result = createCollapsedEdit(value.slice(0, caret), caret);
			} else if (ctrlKey && key === "u") {
				result = createCollapsedEdit(value.slice(caret), 0);
			} else {
				result = applySharedTextControlEdit(this, key, shiftKey, ctrlKey);
			}
			if (result) {
				applyTextControlEdit(this, result);
			}
		};
	}

	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get labels(): NodeList {
		return this.type === "hidden" ? createStaticNodeList([]) : getLabels(this);
	}

	get list(): HTMLDataListElement | null {
		const id = this.getAttribute("list");
		if (id === null || id === "") {
			return null;
		}
		const root = getRoot(this);
		for (const node of descendants(root)) {
			if (node.nodeType !== ELEMENT_NODE) {
				continue;
			}
			const element = node as Element;
			if (element.getAttribute("id") !== id) {
				continue;
			}
			return element instanceof HTMLDataListElement ? element : null;
		}
		return null;
	}

	get value(): string {
		switch (getInputValueMode(this.type)) {
			case "value":
				// A number input mid-edit holds text on its way to being a
				// number ("4.", "4e-"), which the control keeps and renders.
				// The IDL attribute reports the empty string until the text is
				// a number, as a browser's does.
				if (
					this.type === "number" &&
					parseFloatingPoint(this[kValue]!) === null
				) {
					return "";
				}
				return this[kValue]!;
			case "default":
				return this.getAttribute("value") ?? "";
			case "on":
				return this.getAttribute("value") ?? "on";
			default:
				return "";
		}
	}

	set value(value: string) {
		const string = value === null ? "" : String(value);
		switch (getInputValueMode(this.type)) {
			case "value": {
				const previous = this[kValue]!;
				this[kValue] = sanitizeInputValue(this, string);
				this[kDirtyValue] = true;
				if (previous !== this[kValue]!) {
					this[kSelectionStart] = this[kValue]!.length;
					this[kSelectionEnd] = this[kValue]!.length;
					this[kSelectionDirection] = "none";
				}
				break;
			}
			case "filename":
				if (string !== "") {
					throw domError(
						"InvalidStateError",
						"A file input's value can only be emptied",
					);
				}
				break;
			default:
				this.setAttribute("value", string);
		}
		syncUAShadowTree(this);
	}

	// NaN when the value does not parse. Only the numeric types return a
	// number. Assigning NaN empties the text control. Assigning a non-finite
	// number throws the TypeError the spec requires.
	get valueAsNumber(): number {
		if (this.type !== "number" && this.type !== "range") {
			return NaN;
		}
		return parseFloatingPoint(this.value) ?? NaN;
	}

	set valueAsNumber(value: number) {
		if (this.type !== "number" && this.type !== "range") {
			throw domError(
				"InvalidStateError",
				"This input type does not hold a number",
			);
		}
		const number = Number(value);
		if (Number.isNaN(number)) {
			this.value = "";
			return;
		}
		if (!Number.isFinite(number)) {
			throw new TypeError("valueAsNumber must be finite");
		}
		this.value = String(number);
	}

	get checked(): boolean {
		return this[kChecked]!;
	}

	set checked(value: boolean) {
		this[kDirtyChecked] = true;
		setCheckedness(this, Boolean(value));
	}

	get indeterminate(): boolean {
		return this[kIndeterminate]!;
	}

	set indeterminate(value: boolean) {
		this[kIndeterminate] = Boolean(value);
	}

	get selectionStart(): number | null {
		if (!SELECTABLE_INPUT_TYPES.has(this.type)) {
			return null;
		}
		return this[kSelectionStart]!;
	}

	set selectionStart(value: number | null) {
		requireSelectable(this);
		const start = toUnsignedLong(value ?? 0);
		this.setSelectionRange(
			start,
			Math.max(start, this[kSelectionEnd]!),
			this[kSelectionDirection]!,
		);
	}

	get selectionEnd(): number | null {
		if (!SELECTABLE_INPUT_TYPES.has(this.type)) {
			return null;
		}
		return this[kSelectionEnd]!;
	}

	set selectionEnd(value: number | null) {
		requireSelectable(this);
		this.setSelectionRange(
			this[kSelectionStart]!,
			toUnsignedLong(value ?? 0),
			this[kSelectionDirection]!,
		);
	}

	get selectionDirection(): string | null {
		if (!SELECTABLE_INPUT_TYPES.has(this.type)) {
			return null;
		}
		return this[kSelectionDirection]!;
	}

	set selectionDirection(value: string | null) {
		requireSelectable(this);
		this.setSelectionRange(
			this[kSelectionStart]!,
			this[kSelectionEnd]!,
			value === null ? undefined : String(value),
		);
	}

	// Only the types that render as a button can invoke a popover.
	get popoverTargetElement(): Element | null {
		return getPopoverTargetAttributeElement(this);
	}

	set popoverTargetElement(value: Element | null) {
		setPopoverTargetAttributeElement(this, value);
	}

	// The value the UA shadow tree renders and edits. The IDL attribute above
	// returns an attribute for the types that have no value of their own. Those
	// types render no text control, so their value here is the empty string a
	// caret would sit in.
	get [kUAValue](): string {
		return getInputValueMode(this.type) === "value" ? this[kValue]! : "";
	}

	get [kUAValueText](): globalThis.Text | null {
		return this[kValueText]!;
	}

	// The programmatic equivalents of the arrow keys: move along the step
	// grid without firing events. A step of "any" defines no grid, which is
	// the InvalidStateError the spec requires.
	stepUp(n = 1): void {
		stepInput(this, Math.trunc(Number(n)));
	}

	stepDown(n = 1): void {
		stepInput(this, -Math.trunc(Number(n)));
	}

	select(): void {
		if (!SELECTABLE_INPUT_TYPES.has(this.type)) {
			return;
		}
		this.setSelectionRange(0, this[kValue]!.length, "none");
	}

	setSelectionRange(start: number, end: number, direction?: string): void {
		if (arguments.length < 2) {
			throw new TypeError("setSelectionRange needs a start and an end");
		}
		requireSelectable(this);
		this[kSetUASelection]!(start, end, direction);
	}

	setRangeText(
		replacement: string,
		start?: number,
		end?: number,
		selectMode?: string,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("setRangeText needs a replacement");
		}
		requireSelectable(this);
		this[kDirtyValue] = true;
		const result = replaceTextRange(
			this[kValue]!,
			String(replacement),
			start === undefined ? this[kSelectionStart]! : toUnsignedLong(start),
			end === undefined ? this[kSelectionEnd]! : toUnsignedLong(end),
			selectMode === undefined ? "preserve" : String(selectMode),
			this[kSelectionStart]!,
			this[kSelectionEnd]!,
		);
		this[kValue] = result.value;
		this[kSelectionStart] = result.start;
		this[kSelectionEnd] = result.end;
		this[kSelectionDirection] = "none";
		syncUAShadowTree(this);
		scheduleTextSelectionChange(this);
	}

	// A user edit: sets the value and the dirty value flag, and nothing
	// else. The edit places the selection itself, where the IDL setter would
	// collapse it to the end. A control with no value of its own (a file
	// input's filename list) has nothing a keystroke can write, as in a
	// browser, where its UI accepts no typing.
	[kSetUAValue]?(value: string): void {
		if (getInputValueMode(this.type) !== "value") {
			return;
		}
		// A user edit passes through the states a number passes through on its
		// way to being one ("4.", "4e-"), which full sanitization would empty
		// on every keystroke. So the edit keeps its text (the insertion filter
		// has already limited the characters), and the value getter reports the
		// empty string until the text is a number. Programmatic writes get full
		// sanitization.
		this[kValue] = this.type === "number"
			? value.replace(/[\r\n]/g, "")
			: sanitizeInputValue(this, value);
		this[kDirtyValue] = true;
		syncUAShadowTree(this);
	}

	// The selection APIs work for the five types the HTML Standard lists and
	// throw for the rest. But the caret in an email or number text control is
	// real, and the UA shadow tree behind the control edits through it. This is
	// the same algorithm without the type check an author gets.
	[kUASelection]?(): {start: number; end: number; direction: string} {
		return {
			start: this[kSelectionStart]!,
			end: this[kSelectionEnd]!,
			direction: this[kSelectionDirection]!,
		};
	}

	[kSetUASelection]?(start: number, end: number, direction?: string): void {
		setTextSelection(
			this,
			toUnsignedLong(start),
			toUnsignedLong(end),
			direction,
			this[kValue]!.length,
			(selection) => {
				this[kSelectionStart] = selection[0];
				this[kSelectionEnd] = selection[1];
				this[kSelectionDirection] = selection[2];
			},
		);
	}

	override [kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChangeSteps]!(localName, oldValue, value, namespace);
		if (namespace !== null) {
			return;
		}
		if (localName === "value" && !this[kDirtyValue]!) {
			this[kValue] = sanitizeInputValue(this, value ?? "");
		} else if (localName === "checked" && !this[kDirtyChecked]!) {
			setCheckedness(this, value !== null);
		} else if (localName === "type") {
			this[kValue] = sanitizeInputValue(this, this[kValue]!);
		}
	}

	override [kCloningSteps]?(copy: Node): void {
		const clone = copy as HTMLInputElement;
		clone[kValue] = this[kValue]!;
		clone[kDirtyValue] = this[kDirtyValue]!;
		clone[kChecked] = this[kChecked]!;
		clone[kDirtyChecked] = this[kDirtyChecked]!;
	}

	[kResetControl]?(): void {
		this[kValue] = sanitizeInputValue(this, this.getAttribute("value") ?? "");
		this[kDirtyValue] = false;
		this[kChecked] = this.hasAttribute("checked");
		this[kDirtyChecked] = false;
		this[kIndeterminate] = false;
		syncUAShadowTree(this);
	}

	[kUASelectionRange]?(): globalThis.Range | null {
		return getTextSelectionRange(this, this[kValueText]!);
	}

	[kEnsureUAShadowTree]?(): void {
		if (this[kUpgraded]) {
			// A control that left the tree and came back keeps its tree. Only
			// the state it missed needs updating.
			this[kSyncUAShadowTree]!();
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		this[kUpgraded] = true;
		buildInputWidget(this);
		// Editing is the control's own default action, like a browser input's,
		// implemented as a keydown listener. Typed characters and pastes arrive
		// as beforeinput, which is the default action of the keypress or paste
		// that produced them.
		this.addEventListener("keydown", this[kOnKeydown]! as UAListener);
		this.addEventListener("beforeinput", this[kOnBeforeInput]! as UAListener);
	}

	// Updates the rendered content model a width:auto input measures
	// against. The value text paints through the normal walk. The
	// placeholder shows only when the value is empty. A toggle's glyph shows
	// whether it is checked, which is state like any other: it is written
	// here, where the state changes, so the frame that shows it is scheduled
	// by the same mutation as every other change.
	[kSyncUAShadowTree]?(): void {
		if (!this[kUpgraded]) {
			return;
		}
		// A type change means a different tree, not a different value.
		if (getInputKind(this) !== this[kKind]!) {
			buildInputWidget(this);
			return;
		}
		if (this[kKind] !== "textControl") {
			if (this[kGlyphText]!) {
				const mark =
					this.type === "checkbox"
						? this.checked
							? "[x]"
							: "[ ]"
						: this.checked
							? "(x)"
							: "( )";
				if (this[kGlyphText]!.data !== mark) {
					this[kGlyphText]!.data = mark;
				}
			}
			return;
		}
		if (!this[kValueText]!) {
			return;
		}
		const value = this[kUAValue]!;
		const placeholder = this.getAttribute("placeholder") ?? "";
		// A password puts one bullet per code unit into the shadow tree, never
		// the real value. So what lays out, paints and can be selected is only
		// the mask, and the value stays in .value alone. Offsets stay 1:1 with
		// .value on the BMP, which keeps caret and scroll window aligned.
		const shown = this.type === "password" ? "•".repeat(value.length) : value;
		let changed = false;
		if (this[kValueText]!.data !== shown) {
			this[kValueText]!.data = shown;
			changed = true;
		}
		if (this[kPlaceholderText]!.data !== placeholder) {
			this[kPlaceholderText]!.data = placeholder;
			changed = true;
		}
		// Exactly one occupies the slot: the value when present, else the
		// placeholder.
		const valueDisplay = value ? "inline-block" : "none";
		const placeholderDisplay = value ? "none" : "inline-block";
		const valueSpan = this[kValueText]!.parentElement!;
		const placeholderSpan = this[kPlaceholderText]!.parentElement!;
		if (valueSpan.style.display !== valueDisplay) {
			valueSpan.style.display = valueDisplay;
			changed = true;
		}
		if (placeholderSpan.style.display !== placeholderDisplay) {
			placeholderSpan.style.display = placeholderDisplay;
			changed = true;
		}
		// A width:auto input sizes to its composed content. Nothing else
		// invalidates the measure, and the observer would only see it on a
		// microtask.
		if (changed) {
			getAttachedDocument(this)![kLayout].invalidate(this);
		}
	}
}

// A number input's text can be any prefix of a valid floating-point
// number and nothing else. An insertion that would break the grammar is
// refused whole, the way a browser's number text control refuses a second
// decimal point. Deletions are never blocked, so text a deletion leaves
// outside the grammar can always be cleared.
function insertTextControlText(
	textControl: HTMLInputElement,
	text: string,
): void {
	if (!text) {
		return;
	}
	const value = textControl[kUAValue]!;
	const {start, end} = getSelectionRecord(textControl)!;
	const next = value.slice(0, start) + text + value.slice(end);
	if (textControl.type === "number" && !isFloatPrefix(next)) {
		return;
	}
	applyTextControlEdit(
		textControl,
		createCollapsedEdit(next, start + text.length),
	);
}

// A checkbox or radio button changes before the click is dispatched, so
// a listener sees the new state, and changes back if the click is
// canceled.
function legacyPreActivationBehavior(
	input: HTMLInputElement,
): void {
	// The canceled half restores this click's reference, so a click that
	// records none leaves none behind.
	input[kPreviousRadio] = null;
	if (input.type === "checkbox") {
		input[kPreviouslyChecked] = input[kChecked]!;
		input[kPreviouslyIndeterminate] = input[kIndeterminate]!;
		input[kIndeterminate] = false;
		input[kDirtyChecked] = true;
		setCheckedness(input, !input[kChecked]!);
	} else if (input.type === "radio") {
		input[kPreviousRadio] = getCheckedRadio(input) ?? null;
		input[kDirtyChecked] = true;
		setCheckedness(input, true);
	}
}

// Reads the type again rather than remembering it. A listener may have
// changed it during the click, and the state to restore is the state the
// current type keeps. A radio button's reference belongs to this click
// and is honored only while the button it names is still in the group
// this element has now.
function legacyCanceledActivationBehavior(
	input: HTMLInputElement,
): void {
	if (input.type === "checkbox") {
		input[kIndeterminate] = input[kPreviouslyIndeterminate]!;
		input[kChecked] = input[kPreviouslyChecked]!;
		return;
	}
	if (input.type !== "radio") {
		return;
	}
	const previous = input[kPreviousRadio]!;
	input[kPreviousRadio] = null;
	input[kChecked] = false;
	if (previous !== null && getRadioGroup(input).includes(previous)) {
		previous[kChecked] = true;
	}
}

function setCheckedness(
	input: HTMLInputElement,
	checked: boolean,
): void {
	input[kChecked] = checked;
	syncUAShadowTree(input);
	if (!checked || input.type !== "radio") {
		return;
	}
	for (const other of getRadioGroup(input)) {
		if (other !== input) {
			other[kChecked] = false;
			syncUAShadowTree(other);
		}
	}
}

function requireSelectable(
	input: HTMLInputElement,
): void {
	if (!SELECTABLE_INPUT_TYPES.has(input.type)) {
		throw domError(
			"InvalidStateError",
			`An input of type ${input.type} has no text selection`,
		);
	}
}

function getInputKind(
	input: HTMLInputElement,
): "textControl" | "toggle" {
	const type = input.type;
	return type === "checkbox" || type === "radio" ? "toggle" : "textControl";
}

// The text control tree has value and placeholder parts. The toggle tree has a
// single glyph part the painter fills from live `.checked`, because a
// radio's group exclusivity unchecks siblings with no hook to sync
// on.
function buildInputWidget(
	input: HTMLInputElement,
): void {
	const attached = getAttachedDocument(input)!;
	let root = input[kRoot]!;
	if (root === null) {
		root = buildUAShadowTree(input, attached, TEXT_CONTROL_UA_STYLES);
	} else {
		// A rebuild keeps the root and its observer registration and replaces
		// only what is under it, including the stylesheet.
		while (root.firstChild) {
			root.removeChild(root.firstChild);
		}
		attached[kLayout].invalidate();
		root.appendChild(createUAStyleElement(input, TEXT_CONTROL_UA_STYLES));
	}
	input[kRoot] = root;
	input[kKind] = getInputKind(input);

	if (input[kKind] === "textControl") {
		input[kValueText] = addPart(root, "value").firstChild as globalThis.Text;
		input[kPlaceholderText] = addPart(
			root,
			"placeholder",
		).firstChild as globalThis.Text;
	} else {
		input[kValueText] = null;
		input[kPlaceholderText] = null;
		input[kGlyphText] = addPart(root, "glyph").firstChild as globalThis.Text;
	}
	attached[kLayout].invalidate(input);
	input[kSyncUAShadowTree]!();
}

function getInputValueMode(type: string): "value" |
	"default" |
	"on" |
	"filename" {
	switch (type) {
		case "hidden":
		case "submit":
		case "image":
		case "reset":
		case "button":
			return "default";
		case "checkbox":
		case "radio":
			return "on";
		case "file":
			return "filename";
		default:
			return "value";
	}
}

const VALID_DATE = /^[0-9]{4,}-[0-9]{2}-[0-9]{2}$/;
const VALID_MONTH = /^[0-9]{4,}-[0-9]{2}$/;
const VALID_WEEK = /^[0-9]{4,}-W[0-9]{2}$/;
const VALID_TIME = /^[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?$/;
const VALID_DATETIME_LOCAL =
	/^[0-9]{4,}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?$/;
const VALID_FLOAT = /^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const VALID_SIMPLE_COLOR = /^#[0-9a-fA-F]{6}$/;

function parseFloatingPoint(value: string): number | null {
	if (!VALID_FLOAT.test(value)) {
		return null;
	}
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

// The states a number input's text passes through on the way to a
// number, such as "-", "4." and "1e-". Every state of the grammar
// either already accepts or accepts after one more digit, so the prefix
// test reuses the grammar instead of adding a second one that could
// drift.
function isFloatPrefix(value: string): boolean {
	return VALID_FLOAT.test(value) || VALID_FLOAT.test(value + "0");
}

// What toFixed needs to write a step-grid value without binary noise.
// Stepping by 0.1 must produce "0.3", never "0.30000000000000004". An
// exponent literal has no place count and returns zero.
function getDecimalPlaces(text: string | null | undefined): number {
	if (!text) {
		return 0;
	}
	const match = /^-?[0-9]*(?:\.([0-9]+))?$/.exec(text.trim());
	if (!match || match[1] === undefined) {
		return 0;
	}
	return match[1].length;
}

function stepInput(input: HTMLInputElement, steps: number): void {
	if (input.type !== "number" && input.type !== "range") {
		throw domError(
			"InvalidStateError",
			"This input type does not step",
		);
	}
	const stepAttribute = input.getAttribute("step")?.trim();
	if (stepAttribute !== undefined && /^any$/i.test(stepAttribute)) {
		throw domError(
			"InvalidStateError",
			'A step of "any" names no grid to step on',
		);
	}
	if (steps === 0) {
		return;
	}
	const stepped = getSteppedValue(input, steps);
	if (stepped !== null) {
		input.value = stepped;
	}
}

// The value `steps` grid points away, on the grid `step` spaces and
// `min` anchors (zero when there is no min), clamped to [min, max]. A
// value between grid points moves to the nearest point in the direction
// of travel. Returns null when there is nowhere to go, so the caller can
// leave the text control untouched. An out-of-range value steps to the nearest
// bound whichever way it was pushed, which is how a browser's up/down
// buttons pull a text control into range.
function getSteppedValue(
	input: HTMLInputElement,
	steps: number,
): string | null {
	const stepAttribute = input.getAttribute("step")?.trim();
	const step =
		stepAttribute === undefined || /^any$/i.test(stepAttribute)
			? 1
			: (parseFloatingPoint(stepAttribute) ?? 1);
	const spacing = step > 0 ? step : 1;
	const min = parseFloatingPoint(input.getAttribute("min")?.trim() ?? "");
	const max = parseFloatingPoint(input.getAttribute("max")?.trim() ?? "");
	const current = parseFloatingPoint(input[kUAValue]!) ?? 0;
	const base = min ?? 0;

	// The offset in grid units, rounded enough that a value the grid itself
	// produced counts as on the grid despite binary representation.
	const offset = Math.round(((current - base) / spacing) * 1e9) / 1e9;
	const k =
		steps > 0 ? Math.floor(offset) + steps : Math.ceil(offset) + steps;
	let next = base + k * spacing;
	if (max !== null && next > max) {
		// The last grid point inside the range, not max itself.
		const room = Math.round(((max - base) / spacing) * 1e9) / 1e9;
		next = base + Math.floor(room) * spacing;
	}
	if (min !== null && next < min) {
		next = min;
	}
	if (next === current) {
		return null;
	}
	const places = Math.max(
		getDecimalPlaces(stepAttribute),
		getDecimalPlaces(input.getAttribute("min")),
		getDecimalPlaces(input[kUAValue]!),
	);
	return String(Number(next.toFixed(Math.min(places, 20))));
}

// Each type names one sanitization algorithm, and every one is here. A
// value the type cannot hold becomes the empty string or the nearest
// value the type can hold.
function sanitizeInputValue(input: HTMLInputElement, value: string): string {
	const stripped = value.replace(/[\r\n]/g, "");
	switch (input.type) {
		case "text":
		case "search":
		case "tel":
		case "password":
			return stripped;
		case "url":
			return stripped.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
		case "email":
			if (input.hasAttribute("multiple")) {
				return stripped
					.split(",")
					.map((part) => part.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, ""))
					.join(",");
			}
			return stripped.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
		case "date":
			return VALID_DATE.test(value) ? value : "";
		case "month":
			return VALID_MONTH.test(value) ? value : "";
		case "week":
			return VALID_WEEK.test(value) ? value : "";
		case "time":
			return VALID_TIME.test(value) ? value : "";
		case "datetime-local":
			return VALID_DATETIME_LOCAL.test(value)
				? value.replace(" ", "T").replace(/(:[0-9]{2})\.?0*$/, "$1")
				: "";
		case "number":
			return parseFloatingPoint(value) === null ? "" : value;
		case "range":
			return String(clampRangeValue(input, value));
		case "color":
			return VALID_SIMPLE_COLOR.test(value)
				? toASCIILowercase(value)
				: "#000000";
		default:
			return value;
	}
}

function clampRangeValue(input: HTMLInputElement, value: string): number {
	const min = parseFloatingPoint(input.getAttribute("min") ?? "") ?? 0;
	const max = parseFloatingPoint(input.getAttribute("max") ?? "") ?? 100;
	const number = parseFloatingPoint(value);
	const middle = max < min ? min : min + (max - min) / 2;
	if (number === null) {
		return middle;
	}
	if (number < min) {
		return min;
	}
	if (max >= min && number > max) {
		return max;
	}
	return number;
}

/** The group is defined by the input's name, form and tree. */
function getRadioGroup(input: HTMLInputElement): HTMLInputElement[] {
	const name = input.getAttribute("name");
	if (name === null || name === "") {
		return [input];
	}
	const owner = getFormOwner(input);
	const root = getRoot(input);
	const group: HTMLInputElement[] = [];
	for (const node of descendants(root)) {
		if (!(node instanceof HTMLInputElement)) {
			continue;
		}
		if (node.type !== "radio") {
			continue;
		}
		if (node.getAttribute("name") !== name) {
			continue;
		}
		if (getFormOwner(node) !== owner) {
			continue;
		}
		group.push(node);
	}
	return group;
}

function getCheckedRadio(
	input: HTMLInputElement,
): HTMLInputElement | undefined {
	return getRadioGroup(input).find((radio) => radio.checked);
}

interface HTMLLabelElement
	extends Pick<
		globalThis.HTMLLabelElement,
		"htmlFor"
	> {}

class HTMLLabelElement extends HTMLElement {
	get form(): HTMLFormElement | null {
		const control = this.control;
		return control === null ? null : getFormOwner(control);
	}

	// The element the `for` attribute names, or the first labelable
	// descendant.
	get control(): HTMLElement | null {
		const id = this.getAttribute("for");
		if (id !== null) {
			if (id === "") {
				return null;
			}
			const root = getRoot(this);
			for (const node of descendants(root)) {
				if (node.nodeType !== ELEMENT_NODE) {
					continue;
				}
				const element = node as Element;
				if (element.getAttribute("id") !== id) {
					continue;
				}
				return isLabelable(element) ? (element as HTMLElement) : null;
			}
			return null;
		}
		for (const node of descendants(this)) {
			if (node.nodeType !== ELEMENT_NODE) {
				continue;
			}
			if (isLabelable(node as Element)) {
				return node as HTMLElement;
			}
		}
		return null;
	}
}

interface HTMLLegendElement
	extends Pick<
		globalThis.HTMLLegendElement,
		"align"
	> {}

class HTMLLegendElement extends HTMLElement {
	get form(): HTMLFormElement | null {
		const parent = this[kParent]!;
		if (parent === null || !(parent instanceof HTMLFieldSetElement)) {
			return null;
		}
		return getFormOwner(parent);
	}
}

interface HTMLLIElement
	extends Pick<
		globalThis.HTMLLIElement,
		"type" |
		"value"
	> {}

class HTMLLIElement extends HTMLElement {}

/** Never fetched, so it never has a sheet. */
export interface HTMLLinkElement
	extends Pick<
		globalThis.HTMLLinkElement,
		"blocking" |
		"charset" |
		"crossOrigin" |
		"disabled" |
		"href" |
		"hreflang" |
		"imageSizes" |
		"imageSrcset" |
		"integrity" |
		"media" |
		"referrerPolicy" |
		"rel" |
		"relList" |
		"rev" |
		"sizes" |
		"target" |
		"type"
	> {}

export interface HTMLLinkElement
	extends Pick<
		globalThis.HTMLLinkElement,
		"as" |
		"fetchPriority"
	> {}

export class HTMLLinkElement extends HTMLElement {
	get sheet(): null {
		return null;
	}
}

const kAreas = Symbol("areas");

interface HTMLMapElement
	extends Pick<
		globalThis.HTMLMapElement,
		"name"
	> {}

class HTMLMapElement extends HTMLElement {
	declare [kAreas]?: HTMLCollection | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kAreas] = null;
	}

	get areas(): HTMLCollection {
		let areas = this[kAreas]!;
		if (areas === null) {
			areas = new HTMLCollection(() => {
				const found: Element[] = [];
				for (const node of descendants(this)) {
					if (node instanceof HTMLAreaElement) {
						found.push(node);
					}
				}
				return found;
			}, this);
			this[kAreas] = areas;
		}
		return areas;
	}
}

/** Its scrolling is a rendering effect the tree does not implement. */
interface HTMLMarqueeElement
	extends Pick<
		globalThis.HTMLMarqueeElement,
		"behavior" |
		"bgColor" |
		"direction" |
		"height" |
		"scrollAmount" |
		"scrollDelay" |
		"trueSpeed" |
		"width"
	> {}

interface HTMLMarqueeElement
	extends Pick<
		globalThis.HTMLMarqueeElement,
		"hspace" |
		"vspace"
	> {}

class HTMLMarqueeElement extends HTMLElement {
	start(): void {}

	stop(): void {}
}

const NETWORK_EMPTY = 0;
const NETWORK_IDLE = 1;
const NETWORK_LOADING = 2;
const NETWORK_NO_SOURCE = 3;
const HAVE_NOTHING = 0;
const HAVE_METADATA = 1;
const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;
const HAVE_ENOUGH_DATA = 4;

const kCurrentTime = Symbol("currentTime");
const kVolume = Symbol("volume");
const kMuted = Symbol("muted");
const kPlaybackRate = Symbol("playbackRate");
const kDefaultPlaybackRate = Symbol("defaultPlaybackRate");
const kPreservesPitch = Symbol("preservesPitch");

// No resource is ever fetched, so the element stays in the state a media
// element is in before loading: no network activity, nothing loaded,
// paused, and a NaN duration. The members that return a resource's own
// objects (buffered ranges, tracks, error) are absent rather than
// returning an empty stand-in.
interface HTMLMediaElement
	extends Pick<
		globalThis.HTMLMediaElement,
		"autoplay" |
		"controls" |
		"crossOrigin" |
		"defaultMuted" |
		"loop" |
		"src"
	> {}

interface HTMLMediaElement
	extends Pick<
		globalThis.HTMLMediaElement,
		"preload"
	> {}

class HTMLMediaElement extends HTMLElement {
	static readonly NETWORK_EMPTY = NETWORK_EMPTY;
	static readonly NETWORK_IDLE = NETWORK_IDLE;
	static readonly NETWORK_LOADING = NETWORK_LOADING;
	static readonly NETWORK_NO_SOURCE = NETWORK_NO_SOURCE;
	static readonly HAVE_NOTHING = HAVE_NOTHING;
	static readonly HAVE_METADATA = HAVE_METADATA;
	static readonly HAVE_CURRENT_DATA = HAVE_CURRENT_DATA;
	static readonly HAVE_FUTURE_DATA = HAVE_FUTURE_DATA;
	static readonly HAVE_ENOUGH_DATA = HAVE_ENOUGH_DATA;

	declare [kVolume]?: number;
	declare [kMuted]?: boolean;
	declare [kPlaybackRate]?: number;
	declare [kDefaultPlaybackRate]?: number;
	declare [kPreservesPitch]?: boolean;
	declare [kCurrentTime]?: number;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kVolume] = 1;
		this[kMuted] = false;
		this[kPlaybackRate] = 1;
		this[kDefaultPlaybackRate] = 1;
		this[kPreservesPitch] = true;
		this[kCurrentTime] = 0;
	}

	get currentSrc(): string {
		return "";
	}

	get networkState(): number {
		return NETWORK_EMPTY;
	}

	get readyState(): number {
		return HAVE_NOTHING;
	}

	get seeking(): boolean {
		return false;
	}

	get duration(): number {
		return Number.NaN;
	}

	get paused(): boolean {
		return true;
	}

	get ended(): boolean {
		return false;
	}

	get currentTime(): number {
		return this[kCurrentTime]!;
	}

	set currentTime(value: number) {
		this[kCurrentTime] = toDouble(value);
	}

	get volume(): number {
		return this[kVolume]!;
	}

	set volume(value: number) {
		const volume = toDouble(value);
		if (volume < 0 || volume > 1) {
			throw indexSizeError("A volume is between zero and one");
		}
		this[kVolume] = volume;
	}

	get muted(): boolean {
		return this[kMuted]!;
	}

	set muted(value: boolean) {
		this[kMuted] = Boolean(value);
	}

	get playbackRate(): number {
		return this[kPlaybackRate]!;
	}

	set playbackRate(value: number) {
		this[kPlaybackRate] = toDouble(value);
	}

	get defaultPlaybackRate(): number {
		return this[kDefaultPlaybackRate]!;
	}

	set defaultPlaybackRate(value: number) {
		this[kDefaultPlaybackRate] = toDouble(value);
	}

	get preservesPitch(): boolean {
		return this[kPreservesPitch]!;
	}

	set preservesPitch(value: boolean) {
		this[kPreservesPitch] = Boolean(value);
	}

	load(): void {
		this[kCurrentTime] = 0;
	}

	canPlayType(type: string): string {
		if (arguments.length < 1) {
			throw new TypeError("canPlayType needs a type");
		}
		void type;
		return "";
	}

	pause(): void {}

	play(): Promise<void> {
		return Promise.reject(
			domError("NotSupportedError", "There is no media resource to play"),
		);
	}
}

Object.defineProperties(HTMLMediaElement.prototype, {
	NETWORK_EMPTY: {value: NETWORK_EMPTY, enumerable: true},
	NETWORK_IDLE: {value: NETWORK_IDLE, enumerable: true},
	NETWORK_LOADING: {value: NETWORK_LOADING, enumerable: true},
	NETWORK_NO_SOURCE: {value: NETWORK_NO_SOURCE, enumerable: true},
	HAVE_NOTHING: {value: HAVE_NOTHING, enumerable: true},
	HAVE_METADATA: {value: HAVE_METADATA, enumerable: true},
	HAVE_CURRENT_DATA: {value: HAVE_CURRENT_DATA, enumerable: true},
	HAVE_FUTURE_DATA: {value: HAVE_FUTURE_DATA, enumerable: true},
	HAVE_ENOUGH_DATA: {value: HAVE_ENOUGH_DATA, enumerable: true},
});

class HTMLAudioElement extends HTMLMediaElement {}

/**
 * Intrinsic dimensions are zero until a video is decoded, which never happens.
 */
interface HTMLVideoElement
	extends Pick<
		globalThis.HTMLVideoElement,
		"playsInline" |
		"poster"
	> {}

interface HTMLVideoElement
	extends Pick<
		globalThis.HTMLVideoElement,
		"height" |
		"width"
	> {}

class HTMLVideoElement extends HTMLMediaElement {
	get videoWidth(): number {
		return 0;
	}

	get videoHeight(): number {
		return 0;
	}
}

interface HTMLMenuElement
	extends Pick<
		globalThis.HTMLMenuElement,
		"compact"
	> {}

class HTMLMenuElement extends HTMLElement {}

interface HTMLMetaElement
	extends Pick<
		globalThis.HTMLMetaElement,
		"content" |
		"httpEquiv" |
		"media" |
		"name" |
		"scheme"
	> {}

class HTMLMetaElement extends HTMLElement {}

// A run of full blocks for the filled bar and a run of light shade for
// the groove behind it. Both are ordinary text in the shadow tree,
// clipped to the fraction CSS gives the bar.
const GAUGE_BAR_GLYPH = "█";
const GAUGE_GROOVE_GLYPH = "░";

// Long enough that no bar on this screen can exceed it.
function getGaugeGlyphs(host: Element, glyph: string): string {
	const view = (host.ownerDocument as {defaultView?: {innerWidth?: number}})
		.defaultView;
	const width = view?.innerWidth;
	return glyph.repeat(
		Math.max(40, typeof width === "number" && width > 0 ? width : 40),
	);
}

// A full-width track that clips, holding a bar whose width is the
// fraction filled and the groove that shows past it.
function buildGaugeRoot(
	host: Element,
	attached: AttachedDocument,
	styles: string,
): {bar: globalThis.HTMLElement; groove: globalThis.Text} {
	const document = getUADocument(host);
	const root = buildUAShadowTree(host, attached, styles);
	const track = addPart(root, "track");
	track.removeChild(track.firstChild!);
	const bar = document.createElement("span");
	bar.setAttribute("part", "bar");
	bar.appendChild(
		document.createTextNode(getGaugeGlyphs(host, GAUGE_BAR_GLYPH)),
	);
	track.appendChild(bar);
	const groove = document.createElement("span");
	groove.setAttribute("part", "groove");
	const grooveText = document.createTextNode(
		getGaugeGlyphs(host, GAUGE_GROOVE_GLYPH),
	);
	groove.appendChild(grooveText);
	track.appendChild(groove);
	return {bar, groove: grooveText};
}

function setGaugeFill(
	bar: globalThis.HTMLElement,
	fraction: number | null,
): void {
	const width =
		fraction === null ? "0%" : `${Math.max(0, Math.min(1, fraction)) * 100}%`;
	if (bar.style.width !== width) {
		bar.style.width = width;
	}
}

const kBar = Symbol("bar");

const METER_ATTRIBUTES = new Set([
	"value",
	"min",
	"max",
	"low",
	"high",
	"optimum",
]);

// Six numbers, each parsed relative to the ones around it. The element
// renders a closed shadow tree it owns: a run of block glyphs filled to
// where `value` sits between `min` and `max`, with a level attribute
// computed from the low/high/optimum ranges, which the UA sheet uses to
// color the bar.
class HTMLMeterElement extends HTMLElement {
	declare [kUpgraded]?: boolean;
	declare [kBar]?: globalThis.HTMLElement | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kUpgraded] = false;
		this[kBar] = null;
	}

	get min(): number {
		return parseFloatingPoint(this.getAttribute("min") ?? "") ?? 0;
	}

	set min(value: number) {
		this.setAttribute("min", String(toDouble(value)));
	}

	get max(): number {
		const max = parseFloatingPoint(this.getAttribute("max") ?? "") ?? 1;
		return Math.max(max, this.min);
	}

	set max(value: number) {
		this.setAttribute("max", String(toDouble(value)));
	}

	get value(): number {
		const value = parseFloatingPoint(this.getAttribute("value") ?? "") ?? 0;
		return Math.min(Math.max(value, this.min), this.max);
	}

	set value(value: number) {
		this.setAttribute("value", String(toDouble(value)));
	}

	get low(): number {
		const low = parseFloatingPoint(this.getAttribute("low") ?? "");
		if (low === null) {
			return this.min;
		}
		return Math.min(Math.max(low, this.min), this.max);
	}

	set low(value: number) {
		this.setAttribute("low", String(toDouble(value)));
	}

	get high(): number {
		const high = parseFloatingPoint(this.getAttribute("high") ?? "");
		if (high === null) {
			return this.max;
		}
		return Math.min(Math.max(high, this.low), this.max);
	}

	set high(value: number) {
		this.setAttribute("high", String(toDouble(value)));
	}

	get optimum(): number {
		const optimum = parseFloatingPoint(this.getAttribute("optimum") ?? "");
		if (optimum === null) {
			return (this.min + this.max) / 2;
		}
		return Math.min(Math.max(optimum, this.min), this.max);
	}

	set optimum(value: number) {
		this.setAttribute("optimum", String(toDouble(value)));
	}

	get labels(): NodeList {
		return getLabels(this);
	}

	[kEnsureUAShadowTree]?(): void {
		if (this[kUpgraded]) {
			this[kSyncUAShadowTree]!();
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		this[kUpgraded] = true;
		this[kBar] = buildGaugeRoot(this, attached, METER_UA_STYLES).bar;
		this[kSyncUAShadowTree]!();
	}

	[kSyncUAShadowTree]?(): void {
		if (!this[kUpgraded]) {
			return;
		}
		const bar = this[kBar]!;
		const min = this.min;
		const span = this.max - min;
		setGaugeFill(bar, span > 0 ? (this.value - min) / span : 0);
		const barLevel = getMeterLevel(this);
		if (bar.getAttribute("data-level") !== barLevel) {
			bar.setAttribute("data-level", barLevel);
		}
	}

	override [kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChangeSteps]!(localName, oldValue, value, namespace);
		if (namespace === null && METER_ATTRIBUTES.has(localName)) {
			this[kSyncUAShadowTree]!();
		}
	}
}

// Follows HTML's rendering rules. The optimum region is determined by
// where `optimum` sits relative to `low` and `high`. A value in that
// region is optimum, one region away is suboptimum, and two away is even
// less good.
function getMeterLevel(
	meter: HTMLMeterElement,
): string {
	const {low, high, optimum, value} = meter;
	if (optimum < low) {
		if (value < low) {
			return "optimum";
		}
		return value <= high ? "suboptimum" : "even-less-good";
	}
	if (optimum > high) {
		if (value > high) {
			return "optimum";
		}
		return value >= low ? "suboptimum" : "even-less-good";
	}
	return value >= low && value <= high ? "optimum" : "suboptimum";
}

interface HTMLModElement
	extends Pick<
		globalThis.HTMLModElement,
		"cite" |
		"dateTime"
	> {}

class HTMLModElement extends HTMLElement {}

// Nothing is ever fetched, so the object never gets a nested browsing
// context. Its document, window and SVG document are all null, which is
// what they are for an object that loaded nothing.
interface HTMLObjectElement
	extends Pick<
		globalThis.HTMLObjectElement,
		"align" |
		"archive" |
		"border" |
		"code" |
		"codeBase" |
		"codeType" |
		"data" |
		"declare" |
		"height" |
		"name" |
		"standby" |
		"type" |
		"useMap" |
		"width"
	> {}

interface HTMLObjectElement
	extends Pick<
		globalThis.HTMLObjectElement,
		"hspace" |
		"vspace"
	> {}

class HTMLObjectElement extends HTMLElement {
	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get contentDocument(): null {
		return null;
	}

	get contentWindow(): null {
		return null;
	}

	getSVGDocument(): null {
		return null;
	}
}

interface HTMLOListElement
	extends Pick<
		globalThis.HTMLOListElement,
		"compact" |
		"reversed" |
		"start" |
		"type"
	> {}

class HTMLOListElement extends HTMLElement {}

class HTMLOptGroupElement extends HTMLElement {
	// Installed from the element table and read by the select's own tree.
	declare disabled: boolean;
	declare label: string;
}

const kSelectedness = Symbol("an option's selectedness");
const kSelectednessValue = Symbol("selectedness value");
const kOptionDirty = Symbol("an option's dirtiness");

interface HTMLOptionElement
	extends Pick<
		globalThis.HTMLOptionElement,
		"defaultSelected"
	> {}

const kSelectedOptions = Symbol("selectedOptions");

class HTMLOptionElement extends HTMLElement {
	// Installed from the element table and read by the select's own tree.
	declare disabled: boolean;

	declare [kSelectednessValue]?: boolean;
	declare [kOptionDirty]?: boolean;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kSelectednessValue] = false;
		this[kOptionDirty] = false;
	}

	get form(): HTMLFormElement | null {
		const select = getSelect(this);
		return select === null ? null : getFormOwner(select);
	}

	get label(): string {
		const label = this.getAttribute("label");
		return label === null ? this.text : label;
	}

	set label(value: string) {
		this.setAttribute("label", String(value));
	}

	get value(): string {
		const value = this.getAttribute("value");
		return value === null ? this.text : value;
	}

	set value(value: string) {
		this.setAttribute("value", String(value));
	}

	get text(): string {
		return stripAndCollapseWhitespace(getDescendantText(this));
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}

	get index(): number {
		const select = getSelect(this);
		if (select === null) {
			return 0;
		}
		return getOptions(select).indexOf(this);
	}

	get selected(): boolean {
		const select = getSelect(this);
		if (select !== null) {
			askForAReset(select);
		}
		return this[kSelectedness]!;
	}

	set selected(value: boolean) {
		this[kOptionDirty] = true;
		this[kSelectedness] = Boolean(value);
		const select = getSelect(this);
		if (select === null) {
			return;
		}
		if (this[kSelectedness] && !select.hasAttribute("multiple")) {
			for (const option of getOptions(select)) {
				if (option !== this) {
					option[kSelectedness] = false;
				}
			}
		}
		askForAReset(select);
		syncUAShadowTree(select);
	}

	// Selectedness is not an attribute and not part of the tree. The one
	// live list that depends on it is the select's `selectedOptions`, which
	// is notified here.
	get [kSelectedness](): boolean {
		return this[kSelectednessValue]!;
	}

	set [kSelectedness](value: boolean) {
		if (this[kSelectednessValue] === value) {
			return;
		}
		this[kSelectednessValue] = value;
		const select = getSelect(this);
		const selected = select === null ? null : select[kSelectedOptions]!;
		if (selected !== null) {
			syncMethod.call(selected);
		}
	}

	override [kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChangeSteps]!(localName, oldValue, value, namespace);
		if (
			namespace === null && localName === "selected" && !this[kOptionDirty]!) {
			this[kSelectedness] = value !== null;
		}
		const select = getSelect(this);
		if (select !== null) {
			syncUAShadowTree(select);
		}
	}

	override [kCloningSteps]?(copy: Node): void {
		const clone = copy as HTMLOptionElement;
		clone[kSelectedness] = this[kSelectedness]!;
		clone[kOptionDirty] = this[kOptionDirty]!;
	}
}

function getSelect(option: Element): HTMLSelectElement | null {
	const parent = option[kParent]!;
	if (parent === null) {
		return null;
	}
	if (parent instanceof HTMLSelectElement) {
		return parent;
	}
	if (parent instanceof HTMLOptGroupElement) {
		const grandparent = parent[kParent]!;
		if (grandparent instanceof HTMLSelectElement) {
			return grandparent;
		}
	}
	return null;
}

const kSelect = Symbol("select");

class HTMLOptionsCollection extends HTMLCollection {
	declare [kSelect]?: HTMLSelectElement;

	constructor(select: HTMLSelectElement) {
		super(() => getOptions(select), select);
		this[kSelect] = select;
	}

	override get length(): number {
		return ensureList(this).length;
	}

	override set length(value: number) {
		const wanted = toUnsignedLong(value);
		const options = getOptions(this[kSelect]!);
		if (wanted > options.length) {
			if (wanted > 100000) {
				return;
			}
			for (let index = options.length; index < wanted; index++) {
				const option = createElementInternal(
					this[kSelect]![kDocument]!,
					"option",
					HTML_NAMESPACE,
				);
				appendNode(option, this[kSelect]!);
			}
			return;
		}
		for (let index = options.length - 1; index >= wanted; index--) {
			removeNode(options[index]);
		}
	}

	get selectedIndex(): number {
		return this[kSelect]!.selectedIndex;
	}

	set selectedIndex(value: number) {
		this[kSelect]!.selectedIndex = value;
	}

	add(element: Element, before?: Element | number | null): void {
		if (
			!(element instanceof HTMLOptionElement) &&
			!(element instanceof HTMLOptGroupElement)
		) {
			throw new TypeError("Only an option or an option group can be added");
		}
		if (isInclusiveAncestor(element, this[kSelect]!)) {
			throw hierarchyRequestError(
				"A select cannot be put inside its own option",
			);
		}
		let reference: Node | null = null;
		if (before !== undefined && before !== null) {
			if (typeof before === "number") {
				const options = getOptions(this[kSelect]!);
				const index = toLong(before);
				reference =
					index >= 0 && index < options.length ? options[index] : null;
			} else {
				if (!(before instanceof Element)) {
					throw new TypeError("That is not an element");
				}
				if (!getOptions(this[kSelect]!).includes(before as HTMLOptionElement)) {
					throw notFoundError("That option is not in this select");
				}
				reference = before;
			}
		}
		const parent =
			reference === null ? this[kSelect]! : (reference[kParent]! as Node);
		preInsert(element, parent, reference);
	}

	remove(index: number): void {
		const options = getOptions(this[kSelect]!);
		const at = toLong(index);
		if (at < 0 || at >= options.length) {
			return;
		}
		removeNode(options[at]);
	}
}

Object.defineProperty(HTMLOptionsCollection.prototype, Symbol.toStringTag, {
	value: "HTMLOptionsCollection",
	configurable: true,
});

const kDirty = Symbol("dirty");
const kStored = Symbol("stored");

interface HTMLOutputElement
	extends Pick<
		globalThis.HTMLOutputElement,
		"htmlFor" |
		"name"
	> {}

class HTMLOutputElement extends HTMLElement {
	declare [kDirty]?: boolean;
	declare [kStored]?: string;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kDirty] = false;
		this[kStored] = "";
	}

	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get type(): string {
		return "output";
	}

	get labels(): NodeList {
		return getLabels(this);
	}

	get defaultValue(): string {
		return this[kDirty]! ? this[kStored]! : getDescendantText(this);
	}

	set defaultValue(value: string) {
		if (this[kDirty]!) {
			this[kStored] = String(value);
			return;
		}
		setDescendantText(this, String(value));
	}

	get value(): string {
		return getDescendantText(this);
	}

	set value(value: string) {
		if (!this[kDirty]!) {
			this[kStored] = getDescendantText(this);
		}
		this[kDirty] = true;
		setDescendantText(this, String(value));
	}

	[kResetControl]?(): void {
		if (this[kDirty]!) {
			setDescendantText(this, this[kStored]!);
		}
		this[kDirty] = false;
	}
}

interface HTMLParagraphElement
	extends Pick<
		globalThis.HTMLParagraphElement,
		"align"
	> {}

class HTMLParagraphElement extends HTMLElement {}

interface HTMLParamElement
	extends Pick<
		globalThis.HTMLParamElement,
		"name" |
		"type" |
		"value" |
		"valueType"
	> {}

class HTMLParamElement extends HTMLElement {}

class HTMLPictureElement extends HTMLElement {}

interface HTMLPreElement
	extends Pick<
		globalThis.HTMLPreElement,
		"width"
	> {}

class HTMLPreElement extends HTMLElement {}

// Renders a closed shadow tree it owns: a run of block glyphs filled to
// `value`/`max`. A progress with no value attribute is indeterminate,
// which here is an empty bar over the full groove. There is no animation
// to show the difference the way a browser does.
class HTMLProgressElement extends HTMLElement {
	declare [kUpgraded]?: boolean;
	declare [kBar]?: globalThis.HTMLElement | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kUpgraded] = false;
		this[kBar] = null;
	}

	get value(): number {
		const value = parseFloatingPoint(this.getAttribute("value") ?? "");
		if (value === null || value < 0) {
			return 0;
		}
		return Math.min(value, this.max);
	}

	set value(value: number) {
		this.setAttribute("value", String(toDouble(value)));
	}

	get max(): number {
		const max = parseFloatingPoint(this.getAttribute("max") ?? "");
		return max === null || max <= 0 ? 1 : max;
	}

	set max(value: number) {
		this.setAttribute("max", String(toDouble(value)));
	}

	get position(): number {
		return this.hasAttribute("value") ? this.value / this.max : -1;
	}

	get labels(): NodeList {
		return getLabels(this);
	}

	[kEnsureUAShadowTree]?(): void {
		if (this[kUpgraded]) {
			this[kSyncUAShadowTree]!();
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		this[kUpgraded] = true;
		this[kBar] = buildGaugeRoot(this, attached, PROGRESS_UA_STYLES).bar;
		this[kSyncUAShadowTree]!();
	}

	[kSyncUAShadowTree]?(): void {
		if (!this[kUpgraded]) {
			return;
		}
		const position = this.position;
		setGaugeFill(this[kBar]!, position < 0 ? null : position);
	}

	override [kAttributeChangeSteps]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChangeSteps]!(localName, oldValue, value, namespace);
		if (namespace === null && (localName === "value" || localName === "max")) {
			this[kSyncUAShadowTree]!();
		}
	}
}

interface HTMLQuoteElement
	extends Pick<
		globalThis.HTMLQuoteElement,
		"cite"
	> {}

class HTMLQuoteElement extends HTMLElement {}

// The element is the one the spec defines and its text is the text it
// holds. Executing it is the step this DOM does not have.
class HTMLScriptElement extends HTMLElement {
	get text(): string {
		return getChildText(this);
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}

	/** Async is the one boolean whose IDL attribute a parser can force. */
	get async(): boolean {
		return this.hasAttribute("async");
	}

	set async(value: boolean) {
		this.toggleAttribute("async", Boolean(value));
	}

	static supports(type: string): boolean {
		const named = String(type);
		return named === "classic" || named === "module" || named === "importmap";
	}
}

interface HTMLScriptElement
	extends Pick<
		globalThis.HTMLScriptElement,
		"async" |
		"blocking" |
		"charset" |
		"crossOrigin" |
		"defer" |
		"event" |
		"fetchPriority" |
		"htmlFor" |
		"integrity" |
		"noModule" |
		"referrerPolicy" |
		"src" |
		"text" |
		"type"
	> {}
const kPicker = Symbol("picker");
const kOnMousedown = Symbol("onMousedown");
const kOnBlur = Symbol("onBlur");
const kPickerHighlight = Symbol("highlight");

// Selectedness lives on the options. The select's members read it, and
// every read first runs the selectedness setting algorithm, which keeps a
// single-selection select showing exactly one option. The element renders
// a closed shadow tree it owns: the selected option's label, the ▾
// indicator, and a picker popover of option rows. The tree is derived
// from the selectedness and the highlight below. The keyboard and mouse
// behavior is the control's own default action.
interface HTMLSelectElement
	extends Pick<
		globalThis.HTMLSelectElement,
		"disabled" |
		"multiple" |
		"name" |
		"required"
	> {}

interface HTMLSelectElement
	extends Pick<
		globalThis.HTMLSelectElement,
		"autocomplete" |
		"size"
	> {}

class HTMLSelectElement extends HTMLElement {
	declare [kOptions]?: HTMLOptionsCollection | null;
	declare [kSelectedOptions]?: HTMLCollection | null;

	declare [kUpgraded]?: boolean;
	declare [kValueText]?: globalThis.Text | null;
	declare [kPicker]?: globalThis.HTMLElement | null;
	// The highlighted option index while the picker is OPEN. Null means
	// closed.
	declare [kPickerHighlight]?: number | null;

	// OPEN: arrows move the highlight without committing, Enter/Space
	// commit, Escape dismisses. CLOSED: Enter/Space open the picker, and
	// arrows change the selection in place. This is the browser's
	// closed-select keyboard model.
	declare [kOnKeydown]?: (event: KeyboardEvent) => void;

	// A press opens a closed picker. With the picker open, a press on an
	// option row commits it (a disabled row does nothing), and a press on the
	// closed face dismisses. The row under the point is found from the rows'
	// document rects, not a renderer hit test.
	declare [kOnMousedown]?: (event: MouseEvent) => void;

	declare [kOnBlur]?: () => void;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kOptions] = null;
		this[kSelectedOptions] = null;
		this[kUpgraded] = false;
		this[kValueText] = null;
		this[kPicker] = null;
		this[kPickerHighlight] = null;
		this[kOnKeydown] = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) {
				return;
			}
			const key = event.key;
			const options = getOptionList(this);
			if (options.length === 0) {
				return;
			}
			const current = this.selectedIndex;

			if (this[kPickerHighlight] !== null) {
				const highlight = this[kPickerHighlight]!;
				if (key === "ArrowDown") {
					this[kPickerHighlight] = stepSelectHighlight(this, highlight, 1);
				} else if (key === "ArrowUp") {
					this[kPickerHighlight] = stepSelectHighlight(this, highlight, -1);
				} else if (key === "Home") {
					this[kPickerHighlight] = stepSelectHighlight(this, -1, 1);
				} else if (key === "End") {
					this[kPickerHighlight] = stepSelectHighlight(
						this,
						options.length,
						-1,
					);
				} else if (key === "Enter" || key === " ") {
					this[kPickerHighlight] = null;
					if (highlight !== current && !optionIsDisabled(options[highlight])) {
						commitSelectOption(this, highlight);
						return;
					}
					this[kSyncUAShadowTree]!(); // No change: just close.
					return;
				} else if (key === "Escape") {
					this[kPickerHighlight] = null;
				} else {
					return;
				}
				this[kSyncUAShadowTree]!();
				return;
			}

			// CLOSED: Space or Enter opens. Arrows change the value in place.
			if (key === "Enter" || key === " ") {
				openPicker(this);
				return;
			}
			let target = current;
			if (key === "ArrowDown" || key === "ArrowRight") {
				target = stepSelectHighlight(this, current, 1);
			} else if (key === "ArrowUp" || key === "ArrowLeft") {
				target = stepSelectHighlight(this, current, -1);
			} else if (key === "Home") {
				target = stepSelectHighlight(this, -1, 1);
			} else if (key === "End") {
				target = stepSelectHighlight(this, options.length, -1);
			} else {
				return;
			}
			if (target !== current && target >= 0) {
				commitSelectOption(this, target);
			}
		};
		this[kOnMousedown] = (event: MouseEvent): void => {
			if (event.defaultPrevented || event.button !== 0) {
				return;
			}
			const attached = getAttachedDocument(this)!;
			this.focus(); // A press focuses the control, as in a browser.
			if (this[kPickerHighlight] === null) {
				openPicker(this);
				return;
			}
			const {clientX: x, clientY: y} = event;
			const picker = this[kPicker]!;
			const row = (Array.from(
				picker.childNodes,
			) as globalThis.HTMLElement[]).find((node) => {
				const rect = attached[kLayout].getRect(node);
				return rect ? rectContains(rect, x, y) : false;
			});
			if (row) {
				const index = getOptionIndex(picker, row);
				// A disabled row does nothing. The picker stays open and
				// nothing commits.
				const option = getOptionList(this)[index];
				if (option && !optionIsDisabled(option)) {
					this[kPickerHighlight] = null;
					if (index !== this.selectedIndex) {
						commitSelectOption(this, index);
					} else {
						this[kSyncUAShadowTree]!(); // Re-press the selection: just close.
					}
				}
				return;
			}
			// Not on any row. A press inside the picker's own padding does
			// nothing. A press outside it (on the closed face) dismisses.
			const pickerRect = attached[kLayout].getRect(picker);
			if (!(pickerRect && rectContains(pickerRect, x, y))) {
				this[kPickerHighlight] = null;
				this[kSyncUAShadowTree]!();
			}
		};
		this[kOnBlur] = (): void => {
			if (this[kPickerHighlight] !== null) {
				this[kPickerHighlight] = null;
				this[kSyncUAShadowTree]!();
			}
		};
	}

	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get labels(): NodeList {
		return getLabels(this);
	}

	get type(): string {
		return this.hasAttribute("multiple") ? "select-multiple" : "select-one";
	}

	get options(): HTMLOptionsCollection {
		let options = this[kOptions]!;
		if (options === null) {
			options = new HTMLOptionsCollection(this);
			this[kOptions] = options;
		}
		askForAReset(this);
		return options;
	}

	get length(): number {
		return this.options.length;
	}

	set length(value: number) {
		this.options.length = value;
	}

	get selectedOptions(): HTMLCollection {
		let selected = this[kSelectedOptions]!;
		if (selected === null) {
			selected = new HTMLCollection(
				() => getOptions(this).filter((option) => option[kSelectedness]!),
				this,
			);
			this[kSelectedOptions] = selected;
		}
		askForAReset(this);
		return selected;
	}

	get selectedIndex(): number {
		askForAReset(this);
		return getOptions(this).findIndex((option) => option[kSelectedness]!);
	}

	set selectedIndex(value: number) {
		const index = toLong(value);
		const options = getOptions(this);
		for (let at = 0; at < options.length; at++) {
			options[at][kSelectedness] = false;
			options[at][kOptionDirty] = true;
		}
		if (index >= 0 && index < options.length) {
			options[index][kSelectedness] = true;
		}
		syncUAShadowTree(this);
	}

	get value(): string {
		askForAReset(this);
		for (const option of getOptions(this)) {
			if (option[kSelectedness]!) {
				return option.value;
			}
		}
		return "";
	}

	set value(value: string) {
		const wanted = String(value);
		const options = getOptions(this);
		let found = false;
		for (const option of options) {
			if (!found && option.value === wanted) {
				option[kSelectedness] = true;
				option[kOptionDirty] = true;
				found = true;
			} else {
				option[kSelectedness] = false;
			}
		}
		syncUAShadowTree(this);
	}

	get [kUAValueText](): globalThis.Text | null {
		return this[kValueText]!;
	}

	item(index: number): Element | null {
		return this.options.item(index);
	}

	namedItem(name: string): Element | null {
		return this.options.namedItem(name);
	}

	add(element: Element, before?: Element | number | null): void {
		this.options.add(element, before);
	}

	override remove(index?: number): void {
		if (arguments.length === 0) {
			if (this[kParent] !== null) {
				removeNode(this);
			}
			return;
		}
		this.options.remove(toLong(index));
	}

	// A select's selection record is always collapsed at the label's start, so
	// the caret placement path can treat a select like a text control. The
	// caret is the focus of the selection.
	[kUASelection]?(): {start: number; end: number; direction: string} {
		return {start: 0, end: 0, direction: "none"};
	}

	[kResetControl]?(): void {
		for (const option of getOptions(this)) {
			option[kSelectedness] = option.hasAttribute("selected");
			option[kOptionDirty] = false;
		}
		askForAReset(this);
		syncUAShadowTree(this);
	}

	[kEnsureUAShadowTree]?(): void {
		if (this[kUpgraded]) {
			this[kSyncUAShadowTree]!();
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		this[kUpgraded] = true;
		const document = getUADocument(this);
		// The tree: the selected option's label (part=value), the ▾ indicator
		// (part=indicator), and the picker popover (part=picker, one row per
		// option). Composition hides the light option list.
		const root = buildUAShadowTree(this, attached, SELECT_UA_STYLES);
		this[kValueText] = addPart(root, "value").firstChild as globalThis.Text;
		(addPart(root, "indicator").firstChild as globalThis.Text).data = " ▾";
		const picker = document.createElement("div");
		picker.setAttribute("part", "picker");
		root.appendChild(picker);
		this[kPicker] = picker;

		this.addEventListener("keydown", this[kOnKeydown]! as UAListener);
		this.addEventListener("mousedown", this[kOnMousedown]! as UAListener);
		// Losing focus closes the picker.
		this.addEventListener("blur", this[kOnBlur]!);
		// The displayed label and picker rows track the option list, so a
		// framework mutating the options must trigger a sync. Selection
		// changes reach the tree through the control's own setters.
		engineObservers.get(this[kDocument]!)?.observe(this, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});

		this[kSyncUAShadowTree]!();
	}

	// The dropdown is transient interaction state. Leaving the tree ends the
	// interaction, the same as losing focus does. Removal also causes a focus
	// loss, since focus cannot rest on an element off the tree.
	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		if (this[kPickerHighlight] !== null) {
			this[kPickerHighlight] = null;
			this[kSyncUAShadowTree]!();
		}
	}

	[kSyncUAShadowTree]?(): void {
		const picker = this[kPicker]!;
		if (!this[kUpgraded] || picker === null) {
			return;
		}
		const attached = getAttachedDocument(this)!;
		const options = getOptionList(this);
		const selectedIndex = this.selectedIndex;
		const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
		const label = selected ? selected.label : "";
		if (this[kValueText]!.data !== label) {
			this[kValueText]!.data = label;
			attached[kLayout].invalidate(this);
		}

		if (this[kPickerHighlight] === null) {
			if (picker.style.display !== "none") {
				picker.style.display = "none";
			}
			getTopLayer(this[kDocument]!).delete(picker as unknown as Element);
			return;
		}

		syncPickerRows(this, picker);

		// Anchor below the text control in DOCUMENT coordinates (the picker's
		// containing block is the ICB), matching the text control's width.
		const rect = attached[kLayout].getRect(this);
		if (rect) {
			const top = `${Math.round(rect.bottom)}px`;
			const left = `${Math.round(rect.left)}px`;
			const width = `${Math.max(4, Math.round(rect.width))}ch`;
			if (picker.style.top !== top) {
				picker.style.top = top;
			}
			if (picker.style.left !== left) {
				picker.style.left = left;
			}
			if (picker.style.width !== width) {
				picker.style.width = width;
			}
		}
		if (picker.style.display !== "block") {
			picker.style.display = "block";
		}
		// An open picker paints in the top layer, over following content. The
		// UA shadow tree owns the membership together with the display flip, as
		// one intent.
		getTopLayer(this[kDocument]!).add(picker as unknown as Element);
	}
}

// Same as `options` but without building a collection.
function getOptionList(select: HTMLSelectElement): HTMLOptionElement[] {
	askForAReset(select);
	return getOptions(select);
}

// A heading for each option group, and every option under the group it
// belongs to. A heading is not an option, so it has no index and cannot
// be picked.
function getPickerRows(
	select: HTMLSelectElement,
): PickerRow[] {
	askForAReset(select);
	const rows: PickerRow[] = [];
	let index = 0;
	const addOption = (option: HTMLOptionElement, grouped: boolean): void => {
		rows.push({
			part: "option",
			label: option.label,
			disabled: optionIsDisabled(option),
			grouped,
			highlighted: index === select[kPickerHighlight]!,
		});
		index++;
	};
	for (let node = select[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node instanceof HTMLOptionElement) {
			addOption(node, false);
		} else if (node instanceof HTMLOptGroupElement) {
			rows.push({
				part: "optgroup",
				label: node.label,
				disabled: node.disabled,
				grouped: false,
				highlighted: false,
			});
			for (
				let child = node[kFirstChild]!;
				child !== null;
				child = child[kNext]!
			) {
				if (child instanceof HTMLOptionElement) {
					addOption(child, true);
				}
			}
		}
	}
	return rows;
}

// Rows are updated in place rather than rebuilt. This root is observed,
// and a rebuild on every sync would produce a frame that schedules
// the next one.
function syncPickerRows(
	select: HTMLSelectElement,
	picker: globalThis.HTMLElement,
): void {
	const document = getUADocument(select);
	const rows = getPickerRows(select);
	while (picker.childNodes.length > rows.length) {
		picker.removeChild(picker.lastChild!);
	}
	while (picker.childNodes.length < rows.length) {
		picker.appendChild(document.createElement("div"));
	}
	rows.forEach((row, index) => {
		const node = picker.childNodes[index] as globalThis.HTMLElement;
		// Attribute writes are guarded because setAttribute queues a mutation
		// record even when the value is unchanged, and this root is observed.
		// An unconditional write is an infinite render loop.
		if (node.getAttribute("part") !== row.part) {
			node.setAttribute("part", row.part);
		}
		if (node.textContent !== row.label) {
			node.textContent = row.label;
		}
		setRowFlag(node, "data-disabled", row.disabled);
		setRowFlag(node, "data-grouped", row.grouped);
		setRowFlag(node, "data-highlighted", row.highlighted);
	});
}

function stepSelectHighlight(
	select: HTMLSelectElement,
	from: number,
	direction: 1 | -1,
): number {
	const options = getOptionList(select);
	for (
		let i = from + direction;
		i >= 0 && i < options.length;
		i += direction
	) {
		if (!optionIsDisabled(options[i])) {
			return i;
		}
	}
	return from;
}

function openPicker(
	select: HTMLSelectElement,
): void {
	const options = getOptionList(select);
	if (options.length === 0) {
		return;
	}
	let index = select.selectedIndex;
	if (index < 0) {
		index = options.findIndex((o) => !optionIsDisabled(o));
	}
	select[kPickerHighlight] = index;
	select[kSyncUAShadowTree]!();
}

function commitSelectOption(
	select: HTMLSelectElement,
	index: number,
): void {
	select[kPickerHighlight] = null;
	select.selectedIndex = index; // The setter reconciles (closes + label).
	dispatch(select, new Event("input", {bubbles: true, cancelable: false}));
	dispatch(select, new Event("change", {bubbles: true, cancelable: false}));
}

interface PickerRow {
	part: "option" | "optgroup";
	label: string;
	disabled: boolean;

	// Under a group heading, which indents it.
	grouped: boolean;
	highlighted: boolean;
}

// Disabled by its own attribute or by its group's. The HTML Standard
// reads both together.
function optionIsDisabled(option: HTMLOptionElement): boolean {
	if (option.disabled) {
		return true;
	}
	const parent = option[kParent]!;
	return parent instanceof HTMLOptGroupElement && parent.disabled;
}

function rectContains(rect: globalThis.DOMRect, x: number, y: number): boolean {
	return (
		x >= rect.x &&
		x < rect.x + rect.width &&
		y >= rect.y &&
		y < rect.y + rect.height
	);
}

function setRowFlag(
	row: globalThis.HTMLElement,
	name: string,
	on: boolean,
): void {
	if (on === row.hasAttribute(name)) {
		return;
	}
	if (on) {
		row.setAttribute(name, "");
	} else {
		row.removeAttribute(name);
	}
}

// Counts only the rows that are options, in tree order.
function getOptionIndex(
	picker: globalThis.HTMLElement,
	row: globalThis.HTMLElement,
): number {
	if (row.getAttribute("part") !== "option") {
		return -1;
	}
	let index = 0;
	for (const child of Array.from(picker.children)) {
		if (child === row) {
			return index;
		}
		if (child.getAttribute("part") === "option") {
			index++;
		}
	}
	return -1;
}

function getOptions(select: Element): HTMLOptionElement[] {
	const options: HTMLOptionElement[] = [];
	for (let node = select[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node instanceof HTMLOptionElement) {
			options.push(node);
		} else if (node instanceof HTMLOptGroupElement) {
			for (
				let child = node[kFirstChild]!;
				child !== null;
				child = child[kNext]!
			) {
				if (child instanceof HTMLOptionElement) {
					options.push(child);
				}
			}
		}
	}
	return options;
}

function getDisplaySize(select: HTMLSelectElement): number {
	const value = select.getAttribute("size");
	const parsed = value === null ? null : parseNonNegativeInteger(value);
	return parsed === null || parsed === 0 ? 1 : parsed;
}

// The selectedness setting algorithm. A select that shows one row and
// has nothing selected selects its first enabled option. A select with
// more than one option selected keeps only the last.
function askForAReset(select: HTMLSelectElement): void {
	const options = getOptions(select);
	const selected = options.filter((option) => option[kSelectedness]!);
	if (
		!select.hasAttribute("multiple") &&
		getDisplaySize(select) === 1 &&
		selected.length === 0
	) {
		const first = options.find((option) => !isActuallyDisabled(option));
		if (first !== undefined) {
			first[kSelectedness] = true;
		}
		return;
	}
	if (selected.length >= 2 && !select.hasAttribute("multiple")) {
		for (let index = 0; index < selected.length - 1; index++) {
			selected[index][kSelectedness] = false;
		}
	}
}

interface HTMLSourceElement
	extends Pick<
		globalThis.HTMLSourceElement,
		"media" |
		"sizes" |
		"src" |
		"srcset" |
		"type"
	> {}

interface HTMLSourceElement
	extends Pick<
		globalThis.HTMLSourceElement,
		"height" |
		"width"
	> {}

class HTMLSourceElement extends HTMLElement {}

class HTMLSpanElement extends HTMLElement {}

const kStyleElements = Symbol("how many style elements the tree holds");

/**
 * The sheet belongs to the engine's cascade, not to the tree. There is
 * none here, which is why `sheet` is null and `disabled` is false.
 */
export interface HTMLStyleElement
	extends Pick<
		globalThis.HTMLStyleElement,
		"blocking" |
		"media" |
		"type"
	> {}

export class HTMLStyleElement extends HTMLElement {
	/** Null outside a tree. */
	get sheet(): CSSStyleSheet | null {
		return styleElementSheet(this);
	}

	get disabled(): boolean {
		return false;
	}

	set disabled(_value: boolean) {
		void _value;
	}

	override [kInsertionSteps]?(): void {
		super[kInsertionSteps]!();
		this[kDocument]![kStyleElements] = this[kDocument]![kStyleElements]! + 1;
	}

	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		this[kDocument]![kStyleElements] = this[kDocument]![kStyleElements]! - 1;
	}
}

/**
 * A counter that changes whenever a style element joins or leaves a
 * document's trees. The cascade polls it to notice a sheet that appeared
 * since it last parsed, which is cheaper than walking the tree.
 */
export function styleElementCount(document: Document): number {
	return document[kStyleElements]!;
}

interface HTMLTableCaptionElement
	extends Pick<
		globalThis.HTMLTableCaptionElement,
		"align"
	> {}

class HTMLTableCaptionElement extends HTMLElement {}

interface HTMLTableCellElement
	extends Pick<
		globalThis.HTMLTableCellElement,
		"abbr" |
		"align" |
		"axis" |
		"bgColor" |
		"ch" |
		"chOff" |
		"headers" |
		"height" |
		"noWrap" |
		"vAlign" |
		"width"
	> {}

interface HTMLTableCellElement
	extends Pick<
		globalThis.HTMLTableCellElement,
		"colSpan" |
		"rowSpan" |
		"scope"
	> {}

class HTMLTableCellElement extends HTMLElement {
	get cellIndex(): number {
		const parent = this[kParent]!;
		if (!(parent instanceof HTMLTableRowElement)) {
			return -1;
		}
		return getRowCells(parent).indexOf(this);
	}
}

interface HTMLTableColElement
	extends Pick<
		globalThis.HTMLTableColElement,
		"width"
	> {}

interface HTMLTableColElement
	extends Pick<
		globalThis.HTMLTableColElement,
		"align" |
		"ch" |
		"chOff" |
		"span" |
		"vAlign"
	> {}

class HTMLTableColElement extends HTMLElement {}

const kTBodies = Symbol("tBodies");
const kRows = Symbol("rows");

interface HTMLTableElement
	extends Pick<
		globalThis.HTMLTableElement,
		"align" |
		"bgColor" |
		"border" |
		"cellPadding" |
		"cellSpacing" |
		"frame" |
		"rules" |
		"summary" |
		"width"
	> {}

class HTMLTableElement extends HTMLElement {
	declare [kTBodies]?: HTMLCollection | null;
	declare [kRows]?: HTMLCollection | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kTBodies] = null;
		this[kRows] = null;
	}

	get caption(): Element | null {
		return getFirstChildElement(this, "caption");
	}

	set caption(value: Element | null) {
		if (value !== null && !(value instanceof HTMLTableCaptionElement)) {
			throw new TypeError("That is not a caption");
		}
		this.deleteCaption();
		if (value !== null) {
			preInsert(value, this, this[kFirstChild]!);
		}
	}

	get tHead(): Element | null {
		return getFirstChildElement(this, "thead");
	}

	set tHead(value: Element | null) {
		if (
			value !== null &&
			!(value instanceof HTMLTableSectionElement && value.localName === "thead")
		) {
			throw new TypeError("That is not a table head");
		}
		this.deleteTHead();
		if (value === null) {
			return;
		}
		let before: Node | null = null;
		for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType !== ELEMENT_NODE) {
				continue;
			}
			const name = (node as Element)[kLocalName]!;
			if (name !== "caption" && name !== "colgroup") {
				before = node;
				break;
			}
		}
		preInsert(value, this, before);
	}

	get tFoot(): Element | null {
		return getFirstChildElement(this, "tfoot");
	}

	set tFoot(value: Element | null) {
		if (
			value !== null &&
			!(value instanceof HTMLTableSectionElement && value.localName === "tfoot")
		) {
			throw new TypeError("That is not a table foot");
		}
		this.deleteTFoot();
		if (value !== null) {
			preInsert(value, this, null);
		}
	}

	get tBodies(): HTMLCollection {
		let bodies = this[kTBodies]!;
		if (bodies === null) {
			bodies = new HTMLCollection(
				() => getChildElementsNamed(this, "tbody"),
				this,
				(node) => isHTMLElementNamed(node, "tbody"),
			);
			this[kTBodies] = bodies;
		}
		return bodies;
	}

	get rows(): HTMLCollection {
		let rows = this[kRows]!;
		if (rows === null) {
			rows = new HTMLCollection(() => getTableRows(this), this);
			this[kRows] = rows;
		}
		return rows;
	}

	createCaption(): Element {
		const existing = this.caption;
		if (existing !== null) {
			return existing;
		}
		const caption = createElementInternal(
			this[kDocument]!,
			"caption",
			HTML_NAMESPACE,
		);
		preInsert(caption, this, this[kFirstChild]!);
		return caption;
	}

	deleteCaption(): void {
		const existing = this.caption;
		if (existing !== null) {
			removeNode(existing);
		}
	}

	createTHead(): Element {
		const existing = this.tHead;
		if (existing !== null) {
			return existing;
		}
		const head = createElementInternal(
			this[kDocument]!,
			"thead",
			HTML_NAMESPACE,
		);
		this.tHead = head;
		return head;
	}

	deleteTHead(): void {
		const existing = this.tHead;
		if (existing !== null) {
			removeNode(existing);
		}
	}

	createTFoot(): Element {
		const existing = this.tFoot;
		if (existing !== null) {
			return existing;
		}
		const foot = createElementInternal(
			this[kDocument]!,
			"tfoot",
			HTML_NAMESPACE,
		);
		preInsert(foot, this, null);
		return foot;
	}

	deleteTFoot(): void {
		const existing = this.tFoot;
		if (existing !== null) {
			removeNode(existing);
		}
	}

	createTBody(): Element {
		const body = createElementInternal(
			this[kDocument]!,
			"tbody",
			HTML_NAMESPACE,
		);
		const bodies = getChildElementsNamed(this, "tbody");
		const last = bodies[bodies.length - 1];
		preInsert(body, this, last === undefined ? null : last[kNext]!);
		return body;
	}

	insertRow(index = -1): Element {
		const rows = getTableRows(this);
		const at = toLong(index);
		if (at < -1 || at > rows.length) {
			throw indexSizeError("There is no row at that index");
		}
		const row = createElementInternal(this[kDocument]!, "tr", HTML_NAMESPACE);
		if (
			rows.length === 0 && getChildElementsNamed(this, "tbody").length === 0
		) {
			const body = createElementInternal(
				this[kDocument]!,
				"tbody",
				HTML_NAMESPACE,
			);
			appendNode(row, body);
			preInsert(body, this, null);
			return row;
		}
		if (rows.length === 0) {
			const bodies = getChildElementsNamed(this, "tbody");
			appendNode(row, bodies[bodies.length - 1]);
			return row;
		}
		if (at === -1 || at === rows.length) {
			const last = rows[rows.length - 1];
			preInsert(row, last[kParent]! as Node, null);
			return row;
		}
		const reference = rows[at];
		preInsert(row, reference[kParent]! as Node, reference);
		return row;
	}

	deleteRow(index: number): void {
		const rows = getTableRows(this);
		let at = toLong(index);
		if (at === -1) {
			at = rows.length - 1;
		}
		if (at < 0 || at >= rows.length) {
			throw indexSizeError("There is no row at that index");
		}
		removeNode(rows[at]);
	}
}

function isHTMLElementNamed(node: Node, localName: string): boolean {
	return (
		node.nodeType === ELEMENT_NODE &&
		(node as Element)[kNamespace] === HTML_NAMESPACE &&
		(node as Element)[kLocalName] === localName
	);
}

function getChildElementsNamed(parent: Node, localName: string): Element[] {
	const found: Element[] = [];
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = node as Element;
		if (
			element[kNamespace] === HTML_NAMESPACE &&
			element[kLocalName] === localName
		) {
			found.push(element);
		}
	}
	return found;
}

// The head's rows, then the rows directly in the table and in its
// bodies, then the foot's rows.
function getTableRows(table: Element): Element[] {
	const head: Element[] = [];
	const middle: Element[] = [];
	const foot: Element[] = [];
	for (let node = table[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = node as Element;
		if (element[kNamespace] !== HTML_NAMESPACE) {
			continue;
		}
		switch (element[kLocalName]!) {
			case "thead":
				head.push(...getChildElementsNamed(element, "tr"));
				break;
			case "tfoot":
				foot.push(...getChildElementsNamed(element, "tr"));
				break;
			case "tbody":
				middle.push(...getChildElementsNamed(element, "tr"));
				break;
			case "tr":
				middle.push(element);
				break;
		}
	}
	return [...head, ...middle, ...foot];
}

const kCells = Symbol("cells");

interface HTMLTableRowElement
	extends Pick<
		globalThis.HTMLTableRowElement,
		"bgColor"
	> {}

interface HTMLTableRowElement
	extends Pick<
		globalThis.HTMLTableRowElement,
		"align" |
		"ch" |
		"chOff" |
		"vAlign"
	> {}

class HTMLTableRowElement extends HTMLElement {
	declare [kCells]?: HTMLCollection | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kCells] = null;
	}

	get rowIndex(): number {
		const owner = getTable(this);
		return owner === null ? -1 : getTableRows(owner).indexOf(this);
	}

	get sectionRowIndex(): number {
		const parent = this[kParent]!;
		if (parent === null || parent.nodeType !== ELEMENT_NODE) {
			return -1;
		}
		return getChildElementsNamed(parent, "tr").indexOf(this);
	}

	get cells(): HTMLCollection {
		let cells = this[kCells]!;
		if (cells === null) {
			cells = new HTMLCollection(
				() => getRowCells(this),
				this,
				(node) => node instanceof HTMLTableCellElement,
			);
			this[kCells] = cells;
		}
		return cells;
	}

	insertCell(index = -1): Element {
		const cells = getRowCells(this);
		const at = toLong(index);
		if (at < -1 || at > cells.length) {
			throw indexSizeError("There is no cell at that index");
		}
		const cell = createElementInternal(this[kDocument]!, "td", HTML_NAMESPACE);
		preInsert(cell, this, at === -1 || at === cells.length ? null : cells[at]);
		return cell;
	}

	deleteCell(index: number): void {
		const cells = getRowCells(this);
		let at = toLong(index);
		if (at === -1) {
			at = cells.length - 1;
		}
		if (at < 0 || at >= cells.length) {
			throw indexSizeError("There is no cell at that index");
		}
		removeNode(cells[at]);
	}
}

function getTable(
	row: HTMLTableRowElement,
): Element | null {
	const parent = row[kParent]!;
	if (parent === null || parent.nodeType !== ELEMENT_NODE) {
		return null;
	}
	if ((parent as Element)[kLocalName] === "table") {
		return parent as Element;
	}
	const grandparent = parent[kParent]!;
	if (grandparent === null || grandparent.nodeType !== ELEMENT_NODE) {
		return null;
	}
	return (grandparent as Element)[kLocalName] === "table"
		? (grandparent as Element)
		: null;
}

function getRowCells(row: Element): Element[] {
	const cells: Element[] = [];
	for (let node = row[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node instanceof HTMLTableCellElement) {
			cells.push(node);
		}
	}
	return cells;
}

interface HTMLTableSectionElement
	extends Pick<
		globalThis.HTMLTableSectionElement,
		"align" |
		"ch" |
		"chOff" |
		"vAlign"
	> {}

class HTMLTableSectionElement extends HTMLElement {
	declare [kRows]?: HTMLCollection | null;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kRows] = null;
	}

	get rows(): HTMLCollection {
		let rows = this[kRows]!;
		if (rows === null) {
			rows = new HTMLCollection(
				() => getChildElementsNamed(this, "tr"),
				this,
				(node) => isHTMLElementNamed(node, "tr"),
			);
			this[kRows] = rows;
		}
		return rows;
	}

	insertRow(index = -1): Element {
		const rows = getChildElementsNamed(this, "tr");
		const at = toLong(index);
		if (at < -1 || at > rows.length) {
			throw indexSizeError("There is no row at that index");
		}
		const row = createElementInternal(this[kDocument]!, "tr", HTML_NAMESPACE);
		preInsert(row, this, at === -1 || at === rows.length ? null : rows[at]);
		return row;
	}

	deleteRow(index: number): void {
		const rows = getChildElementsNamed(this, "tr");
		let at = toLong(index);
		if (at === -1) {
			at = rows.length - 1;
		}
		if (at < 0 || at >= rows.length) {
			throw indexSizeError("There is no row at that index");
		}
		removeNode(rows[at]);
	}
}

const kPlaceholderSpan = Symbol("placeholderSpan");
const kGoalColumn = Symbol("goalColumn");

// Renders a closed shadow tree it owns: a value part, laid out, wrapped
// and painted like any document text; a placeholder part; and a trailing
// line-break anchor. The tree is derived from the value, and the editing
// keys are the control's own default action.
interface HTMLTextAreaElement
	extends Pick<
		globalThis.HTMLTextAreaElement,
		"dirName" |
		"disabled" |
		"maxLength" |
		"minLength" |
		"name" |
		"placeholder" |
		"readOnly" |
		"required"
	> {}

interface HTMLTextAreaElement
	extends Pick<
		globalThis.HTMLTextAreaElement,
		"autocomplete" |
		"cols" |
		"rows" |
		"wrap"
	> {}

class HTMLTextAreaElement extends HTMLElement {
	declare [kValue]?: string;
	declare [kDirty]?: boolean;
	declare [kSelectionStart]?: number;
	declare [kSelectionEnd]?: number;
	declare [kSelectionDirection]?: string;

	declare [kUpgraded]?: boolean;
	declare [kValueText]?: globalThis.Text | null;
	declare [kPlaceholderText]?: globalThis.Text | null;
	declare [kPlaceholderSpan]?: globalThis.HTMLElement | null;
	declare [kGoalColumn]?: number | null;

	// A typed character arrives as insertText. A paste keeps its newlines.
	declare [kOnBeforeInput]?: (event: InputEvent) => void;

	// Enter inserts a newline. The vertical arrows and Home/End move by
	// VISUAL line (soft wraps count, as in a browser). Every other editing
	// key is the shared text control logic. This reads laid-out geometry, so it
	// flushes layout first.
	declare [kOnKeydown]?: (event: KeyboardEvent) => void;
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kValue] = "";
		this[kDirty] = false;
		this[kSelectionStart] = 0;
		this[kSelectionEnd] = 0;
		this[kSelectionDirection] = "none";
		this[kUpgraded] = false;
		this[kValueText] = null;
		this[kPlaceholderText] = null;
		this[kPlaceholderSpan] = null;
		this[kGoalColumn] = null;
		this[kOnBeforeInput] = (event: InputEvent): void => {
			if (event.defaultPrevented || event.data == null) {
				return;
			}
			if (event.inputType === "insertText") {
				event.preventDefault();
				applyTextControlEdit(this, printableTextControlEdit(this, event.data));
				return;
			}
			if (event.inputType !== "insertFromPaste") {
				return;
			}
			event.preventDefault();
			insertPaste(this, event.data);
		};
		this[kOnKeydown] = (event: KeyboardEvent): void => {
		// Editing is a default action. An author's keydown preventDefault
		// suppresses it, exactly as it suppresses a browser textarea's edit.
			if (event.defaultPrevented) {
				return;
			}
			if (!this[kUpgraded]) {
				return;
			}
			const attached = getAttachedDocument(this)!;
			const {key, shiftKey, ctrlKey} = event;
			// The goal column survives only an unbroken run of vertical moves.
			if (key !== "ArrowUp" && key !== "ArrowDown") {
				this[kGoalColumn] = null;
			}

			const value = this[kUAValue]!;
			const {start, end, direction} = getSelectionRecord(this)!;
			const backward = direction === "backward";
			const caret = backward ? start : end;
			const anchor = backward ? end : start;

			let result: TextControlEditResult | null;
			if (key === "Enter" || (ctrlKey && key === "j")) {
			// Insert a newline like any typed character, replacing the
			// selection. A terminal sends line feed for Ctrl+J, which is the
			// chord that reaches a text control whose Enter an application has
			// taken over.
				const next = value.slice(0, start) + "\n" + value.slice(end);
				const pos = start + 1;
				result = {value: next, start: pos, end: pos, direction: "none"};
			} else if (key === "ArrowUp" || key === "ArrowDown") {
				attached[kLayout].performLayout();
				const target = getVerticalTarget(
					this,
					caret,
					key === "ArrowDown" ? 1 : -1,
				);
				result = moveTextControlSelection(value, anchor, target, shiftKey);
			} else if (
				key === "Home" ||
				key === "End" ||
				(ctrlKey && (key === "a" || key === "e" || key === "k" || key === "u"))
			) {
				attached[kLayout].performLayout();
				const visual = getTextareaVisualLines(this, attached[kLayout]);
				const line = visual
					? visual.lines[getTextareaLine(visual.lines, caret)]
					: null;
				const lineStart = line?.startOffset ?? 0;
				const lineEnd = line?.endOffset ?? value.length;
				if (ctrlKey && key === "k") {
					result = createCollapsedEdit(
						value.slice(0, caret) + value.slice(lineEnd),
						caret,
					);
				} else if (ctrlKey && key === "u") {
					result = createCollapsedEdit(
						value.slice(0, lineStart) + value.slice(caret),
						lineStart,
					);
				} else {
					const toStart = key === "Home" || key === "a";
					result = moveTextControlSelection(
						value,
						anchor,
						toStart ? lineStart : lineEnd,
						shiftKey,
					);
				}
			} else {
				result = applySharedTextControlEdit(this, key, shiftKey, ctrlKey);
			}
			if (result) {
				applyTextControlEdit(this, result);
			}
		};
	}

	get form(): HTMLFormElement | null {
		return getFormOwner(this);
	}

	get labels(): NodeList {
		return getLabels(this);
	}

	get type(): string {
		return "textarea";
	}

	get defaultValue(): string {
		return getDescendantText(this);
	}

	set defaultValue(value: string) {
		setDescendantText(this, String(value));
	}

	get value(): string {
		return this[kUAValue]!;
	}

	set value(value: string) {
		const previous = this[kUAValue]!;
		this[kValue] = normalizeNewlines(value === null ? "" : String(value));
		this[kDirty] = true;
		if (previous !== this[kValue]!) {
			this[kSelectionStart] = this[kValue]!.length;
			this[kSelectionEnd] = this[kValue]!.length;
			this[kSelectionDirection] = "none";
		}
		syncUAShadowTree(this);
	}

	get textLength(): number {
		return this.value.length;
	}

	get selectionStart(): number {
		return this[kSelectionStart]!;
	}

	set selectionStart(value: number) {
		const start = toUnsignedLong(value);
		this.setSelectionRange(
			start,
			Math.max(start, this[kSelectionEnd]!),
			this[kSelectionDirection]!,
		);
	}

	get selectionEnd(): number {
		return this[kSelectionEnd]!;
	}

	set selectionEnd(value: number) {
		this.setSelectionRange(
			this[kSelectionStart]!,
			toUnsignedLong(value),
			this[kSelectionDirection]!,
		);
	}

	get selectionDirection(): string {
		return this[kSelectionDirection]!;
	}

	set selectionDirection(value: string) {
		this.setSelectionRange(
			this[kSelectionStart]!,
			this[kSelectionEnd]!,
			String(value),
		);
	}

	// The value the UA shadow tree renders and edits: the raw value once the
	// dirty flag is set, the child text until then.
	get [kUAValue](): string {
		return this[kDirty]!
			? this[kValue]!
			: normalizeNewlines(getDescendantText(this));
	}

	get [kUAValueText](): globalThis.Text | null {
		return this[kValueText]!;
	}

	select(): void {
		this.setSelectionRange(0, this.value.length, "none");
	}

	setSelectionRange(start: number, end: number, direction?: string): void {
		if (arguments.length < 2) {
			throw new TypeError("setSelectionRange needs a start and an end");
		}
		this[kSetUASelection]!(start, end, direction);
	}

	setRangeText(
		replacement: string,
		start?: number,
		end?: number,
		selectMode?: string,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("setRangeText needs a replacement");
		}
		const result = replaceTextRange(
			this.value,
			String(replacement),
			start === undefined ? this[kSelectionStart]! : toUnsignedLong(start),
			end === undefined ? this[kSelectionEnd]! : toUnsignedLong(end),
			selectMode === undefined ? "preserve" : String(selectMode),
			this[kSelectionStart]!,
			this[kSelectionEnd]!,
		);
		this[kValue] = result.value;
		this[kDirty] = true;
		this[kSelectionStart] = result.start;
		this[kSelectionEnd] = result.end;
		this[kSelectionDirection] = "none";
		syncUAShadowTree(this);
		scheduleTextSelectionChange(this);
	}

	// A user edit: sets the raw value and the dirty value flag, and leaves
	// the selection to the edit that made it.
	[kSetUAValue]?(value: string): void {
		this[kValue] = normalizeNewlines(value);
		this[kDirty] = true;
		syncUAShadowTree(this);
	}

	// A textarea's selection is always its own. See the input's version.
	[kUASelection]?(): {start: number; end: number; direction: string} {
		return {
			start: this[kSelectionStart]!,
			end: this[kSelectionEnd]!,
			direction: this[kSelectionDirection]!,
		};
	}

	[kSetUASelection]?(start: number, end: number, direction?: string): void {
		setTextSelection(
			this,
			toUnsignedLong(start),
			toUnsignedLong(end),
			direction,
			this[kUAValue]!.length,
			(selection) => {
				this[kSelectionStart] = selection[0];
				this[kSelectionEnd] = selection[1];
				this[kSelectionDirection] = selection[2];
			},
		);
	}

	override [kCloningSteps]?(copy: Node): void {
		const clone = copy as HTMLTextAreaElement;
		clone[kValue] = this[kValue]!;
		clone[kDirty] = this[kDirty]!;
	}

	[kResetControl]?(): void {
		this[kValue] = "";
		this[kDirty] = false;
		syncUAShadowTree(this);
	}

	[kUASelectionRange]?(): globalThis.Range | null {
		return getTextSelectionRange(this, this[kValueText]!);
	}

	[kEnsureUAShadowTree]?(): void {
		if (this[kUpgraded]) {
			this[kSyncUAShadowTree]!();
			return;
		}
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return;
		}
		this[kUpgraded] = true;
		const document = getUADocument(this);
		const root = buildUAShadowTree(this, attached, TEXTAREA_UA_STYLES);
		this[kValueText] = addPart(root, "value").firstChild as globalThis.Text;
		this[kPlaceholderSpan] = addPart(root, "placeholder");
		this[kPlaceholderText] =
			this[kPlaceholderSpan]!.firstChild as globalThis.Text;
		// The trailing <br> anchor, the same trick a browser's editor uses. It
		// makes the run's content always end in exactly one line break, so the
		// line count equals the LOGICAL line count. The breaker never emits a
		// line after a final newline, and without the anchor a value ending in
		// "\n" measures one row short, which puts the caret on the bottom
		// border.
		root.appendChild(document.createElement("br"));

		// Editing is the control's own default action, like a browser
		// textarea's. Its keydown listener does the edit.
		this.addEventListener("keydown", this[kOnKeydown]! as UAListener);
		this.addEventListener("beforeinput", this[kOnBeforeInput]! as UAListener);

		this[kSyncUAShadowTree]!();
	}

	// Placeholder visibility is real CSS (an inline display:none), not
	// painter logic, so the normal pipeline never sees a hidden placeholder.
	[kSyncUAShadowTree]?(): void {
		if (!this[kUpgraded]) {
			return;
		}
		const attached = getAttachedDocument(this)!;
		const value = this[kUAValue]!;
		const placeholder = this.getAttribute("placeholder") ?? "";
		let changed = false;
		if (this[kValueText]!.data !== value) {
			this[kValueText]!.data = value;
			changed = true;
		}
		if (this[kPlaceholderText]!.data !== placeholder) {
			this[kPlaceholderText]!.data = placeholder;
			changed = true;
		}
		const placeholderDisplay = value ? "none" : "";
		if (this[kPlaceholderSpan]!.style.display !== placeholderDisplay) {
			this[kPlaceholderSpan]!.style.display = placeholderDisplay;
			changed = true;
		}
		if (!changed) {
			return;
		}
		// The value text lays out through the normal pipeline. The observer
		// sees its characterData change too, but only on a microtask. An edit
		// that reads the fresh geometry back in the same tick (vertical motion,
		// Home/End) needs the engine invalidated synchronously now.
		attached[kLayout].invalidate(this);
	}
}

// One atomic edit.
function insertPaste(
	textControl: HTMLInputElement | HTMLTextAreaElement,
	text: string,
): void {
	if (!text) {
		return;
	}
	applyTextControlEdit(
		textControl,
		printableTextControlEdit(textControl, text),
	);
}

// Keeps the column (in cells) where the target line allows. Soft wraps
// count as lines, as in a browser. Moving up from the first line
// collapses to 0, and moving down from the last line collapses to the
// end.
function getVerticalTarget(
	textarea: HTMLTextAreaElement,
	caret: number,
	direction: 1 | -1,
): number {
	const visual = getTextareaVisualLines(
		textarea,
		getAttachedDocument(textarea)![kLayout],
	);
	if (!visual) {
		return caret;
	}
	const lineIndex = getTextareaLine(visual.lines, caret);
	const targetIndex = lineIndex + direction;
	if (targetIndex < 0) {
		return 0;
	}
	if (targetIndex >= visual.lines.length) {
		return visual.value.length;
	}
	const line = visual.lines[lineIndex];
	const lineText = visual.value.slice(line.startOffset, line.endOffset);
	const currentColumn = getStringWidth(
		lineText.slice(0, Math.max(0, caret - line.startOffset)),
	);
	// Consecutive vertical moves aim for the column the travel STARTED at,
	// even across shorter lines that clamp the caret. This is the browser's
	// goal column.
	const column = textarea[kGoalColumn] ?? currentColumn;
	textarea[kGoalColumn] = column;
	const target = visual.lines[targetIndex];
	const targetText = visual.value.slice(target.startOffset, target.endOffset);
	let cells = 0;
	for (let i = 0; i < targetText.length; i++) {
		const charCells = getStringWidth(targetText[i]);
		if (cells + charCells > column) {
			return target.startOffset + i;
		}
		cells += charCells;
	}
	return target.endOffset;
}

// A value renders as pre-wrap, so a visual line's characters are exactly
// that range of the value.
type TextareaVisualLine = {

	// The line's first character / caret slot.
	startOffset: number;

	// The caret slot AFTER the line's last character.
	endOffset: number;
};

function getTextareaLine(
	lines: Array<{startOffset: number; endOffset: number}>,
	caret: number,
): number {
	for (let i = 0; i < lines.length; i++) {
		// endOffset is a valid caret slot on this line. A caret exactly at a
		// soft-wrap boundary belongs to the NEXT line's start: both lines claim
		// the offset and the later one wins, matching browsers.
		if (caret <= lines[i].endOffset) {
			const next = lines[i + 1];
			if (next && next.startOffset <= caret) {
				continue;
			}
			return i;
		}
	}
	return lines.length - 1;
}

// A thin text control-specific view over the shared `lineFragments` primitive,
// including the empty and trailing-newline lines. Used only by the
// control's own Home/End and vertical-motion editing. Geometry consumers
// read `lineFragments` or a `Range` directly.
function getTextareaVisualLines(
	textControl: HTMLTextAreaElement,
	layout: Layout,
): {value: string; lines: TextareaVisualLine[]} | null {
	const valueText = getTextControlValueText(textControl);
	if (!valueText) {
		return null;
	}
	// The laid-out lines with their data ranges, including the empty lines
	// no fragment represents (an empty value, a trailing newline). This is
	// the same annotation range geometry uses, so the caret, a Range and
	// vertical navigation all agree on where an offset sits.
	const lines = layout.lineFragments(valueText);
	if (lines.length === 0) {
		return null;
	}
	return {value: valueText.data, lines};
}

// A raw value stores line breaks as single line feeds.
function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

interface HTMLTimeElement
	extends Pick<
		globalThis.HTMLTimeElement,
		"dateTime"
	> {}

class HTMLTimeElement extends HTMLElement {}

class HTMLTitleElement extends HTMLElement {
	get text(): string {
		return getChildText(this);
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}
}

// The text of the Text children only, not all descendants.
function getChildText(element: Element): string {
	let text = "";
	for (let node = element[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType === TEXT_NODE) {
			text += (node as Text).data;
		}
	}
	return text;
}

interface HTMLTrackElement
	extends Pick<
		globalThis.HTMLTrackElement,
		"default" |
		"label" |
		"src" |
		"srclang"
	> {}

interface HTMLTrackElement
	extends Pick<
		globalThis.HTMLTrackElement,
		"kind"
	> {}

class HTMLTrackElement extends HTMLElement {}

interface HTMLUListElement
	extends Pick<
		globalThis.HTMLUListElement,
		"compact" |
		"type"
	> {}

class HTMLUListElement extends HTMLElement {}

// `mode` is the state the popover was OPENED in, not the one its
// attribute names now. The attribute can change under a showing popover,
// and the popover belongs to the stack it entered. `previouslyFocused` is
// set only for the popover that opened a stack, so closing the stack
// restores focus once rather than once per popover.
interface PopoverState {
	visibility: "hidden" | "showing";
	mode: "auto" | null;
	trigger: Element | null;
	previouslyFocused: Element | null;
	hiding: boolean;
	toggleTask: {oldState: string; canceled: boolean} | null;
}

// HTML gives these slots to every HTML element. An element that was
// never a popover has no state to store, and the state it would have is
// the initial one.
const popoverStates = new WeakMap<Element, PopoverState>();

function getPopoverState(element: Element): PopoverState {
	let state = popoverStates.get(element);
	if (state === undefined) {
		state = {
			visibility: "hidden",
			mode: null,
			trigger: null,
			previouslyFocused: null,
			hiding: false,
			toggleTask: null,
		};
		popoverStates.set(element, state);
	}
	return state;
}

// Returns auto for the empty string and `auto`, manual for `manual` and
// every unknown value, and null when the attribute is absent.
//
// HTML's third state, Hint, is NOT implemented. A hint popover keeps a
// second stack that auto popovers close and that closes with the auto
// popover it hangs from, and every algorithm here would have to carry
// that second stack. So `popover=hint` takes the path the attribute
// defines for an unknown value, the Manual state, and reflects as
// "manual".
function getPopoverAttributeState(element: Element): "auto" | "manual" | null {
	if (element[kNamespace] !== HTML_NAMESPACE) {
		return null;
	}
	return getPopoverValueState(element.getAttribute("popover"));
}

function getPopoverValueState(value: string | null): "auto" | "manual" | null {
	if (value === null) {
		return null;
	}
	const keyword = toASCIILowercase(value);
	return keyword === "" || keyword === "auto" ? "auto" : "manual";
}

/** Whether `:popover-open` matches. */
function isShowingPopover(node: globalThis.Node): boolean {
	return (
		node instanceof HTMLElement &&
		popoverStates.get(node)?.visibility === "showing"
	);
}

// The auto popovers in the top layer, in the order they entered, which
// is the order they close in.
function getShowingAutoPopovers(document: Document): Element[] {
	const popovers: Element[] = [];
	for (const element of getTopLayer(document)) {
		const state = popoverStates.get(element);
		if (state?.mode === "auto" && state.visibility === "showing") {
			popovers.push(element);
		}
	}
	return popovers;
}

function getTopmostAutoPopover(
	document: globalThis.Document,
): globalThis.Element | null {
	const popovers = getShowingAutoPopovers(document as Document);
	return popovers.length === 0 ? null : popovers[popovers.length - 1];
}

// Showing a popover is not a mutation. The attribute and the tree are
// unchanged. So the rules that test `:popover-open`, and the frame that
// would paint what they hide or reveal, have to be notified from here.
function popoverStateChanged(element: Element): void {
	const attached = getAttachedDocument(element);
	if (attached === undefined) {
		return;
	}
	attached[kCascade].handleStateChange(element);
	attached[kScreen].invalidate();
	void render(attached[kTermDOM]);
}

// Returns true, false for a call that should silently do nothing, or the
// exception the check threw, which the caller rethrows only where the
// spec says to. HTML also rejects a popover whose fullscreen flag is
// set. Fullscreen belongs to the renderer, not the tree, and the
// fullscreen element paints over the whole screen either way, so that
// check is left to the environment if it ever wants one.
function checkPopoverValidity(
	element: Element,
	expectedToBeShowing: boolean,
	expectedDocument: Document | null,
): true | false | unknown {
	if (getPopoverAttributeState(element) === null) {
		return domError("NotSupportedError", "That element is not a popover");
	}
	const showing = getPopoverState(element).visibility === "showing";
	if (expectedToBeShowing !== showing) {
		return false;
	}
	if (!isConnectedNode(element)) {
		return domError("InvalidStateError", "That popover is not connected");
	}
	if (expectedDocument !== null && element[kDocument] !== expectedDocument) {
		return domError("InvalidStateError", "That popover changed documents");
	}
	if (isModalDialog(element)) {
		return domError(
			"InvalidStateError",
			"A dialog showing modally cannot also show as a popover",
		);
	}
	return true;
}

function isPopoverException(result: true | false | unknown): boolean {
	return result !== true && result !== false;
}

const kPopoverShowing = Symbol("a popover is opening");
const kPopoverHidingCount = Symbol("how many popovers are closing");

// An auto popover first closes every open auto popover it is not nested
// inside, either through the node tree or through the element that
// invoked it.
function showPopover(
	element: Element,
	throwExceptions: boolean,
	source: Element | null,
): void {
	const document = element[kDocument]!;
	// Showing a popover from inside another popover's show or hide is a
	// reentrancy the stack algorithms cannot unwind, so it is refused.
	if (document[kPopoverShowing] || document[kPopoverHidingCount] !== 0) {
		if (throwExceptions) {
			throw domError(
				"InvalidStateError",
				"A popover cannot be shown while another is opening or closing",
			);
		}
		return;
	}
	let validity = checkPopoverValidity(element, false, null);
	if (validity !== true) {
		if (throwExceptions && isPopoverException(validity)) {
			throw validity;
		}
		return;
	}
	const state = getPopoverState(element);
	document[kPopoverShowing] = true;
	const cleanup = (): void => {
		document[kPopoverShowing] = false;
	};
	const opening = new ToggleEvent("beforetoggle", {
		cancelable: true,
		oldState: "closed",
		newState: "open",
		source,
	});
	if (!dispatch(element, opening)) {
		cleanup();
		return;
	}
	// A beforetoggle listener can have disconnected the element or changed
	// its popover attribute, so the checks run again.
	validity = checkPopoverValidity(element, false, document);
	if (validity !== true) {
		cleanup();
		if (throwExceptions && isPopoverException(validity)) {
			throw validity;
		}
		return;
	}
	let shouldRestoreFocus = false;
	const originalType = getPopoverAttributeState(element);
	if (originalType === "auto") {
		const ancestor = getTopmostPopoverAncestor(element, source);
		hidePopoverStackUntil(document, ancestor, false, true);
		if (originalType !== getPopoverAttributeState(element)) {
			cleanup();
			if (throwExceptions) {
				throw domError(
					"InvalidStateError",
					"That popover changed state while the ones over it closed",
				);
			}
			return;
		}
		validity = checkPopoverValidity(element, false, document);
		if (validity !== true) {
			cleanup();
			if (throwExceptions && isPopoverException(validity)) {
				throw validity;
			}
			return;
		}
		// Focus returns to the page only for the popover that OPENED the stack,
		// so unwinding a stack returns it once.
		if (getTopmostAutoPopover(document) === null) {
			shouldRestoreFocus = true;
		}
		state.mode = "auto";
	}
	state.previouslyFocused = null;
	const originallyFocused = document[kActiveElement]!;
	getTopLayer(document).add(element);
	state.visibility = "showing";
	state.trigger = source;
	popoverFocusingSteps(element);
	if (shouldRestoreFocus && getPopoverAttributeState(element) !== null) {
		state.previouslyFocused = originallyFocused;
	}
	cleanup();
	queuePopoverToggleEventTask(element, "closed", "open", source);
	popoverStateChanged(element);
}

// An auto popover takes the popovers stacked above it with it.
function hidePopover(
	element: Element,
	focusPreviousElement: boolean,
	fireEvents: boolean,
	throwExceptions: boolean,
	source: Element | null,
): void {
	let validity = checkPopoverValidity(element, true, null);
	if (validity !== true) {
		if (throwExceptions && isPopoverException(validity)) {
			throw validity;
		}
		return;
	}
	const document = element[kDocument]!;
	const state = getPopoverState(element);
	const nestedHide = state.hiding;
	state.hiding = true;
	if (nestedHide) {
		fireEvents = false;
	}
	document[kPopoverHidingCount] = document[kPopoverHidingCount]! + 1;
	const cleanup = (): void => {
		if (!nestedHide) {
			state.hiding = false;
		}
		document[kPopoverHidingCount] = document[kPopoverHidingCount]! - 1;
	};
	if (state.mode === "auto") {
		hidePopoverStackUntil(document, element, focusPreviousElement, fireEvents);
		// Closing the popovers above this one can have disconnected it or
		// changed its attribute, so the checks run again.
		validity = checkPopoverValidity(element, true, null);
		if (validity !== true) {
			cleanup();
			if (throwExceptions && isPopoverException(validity)) {
				throw validity;
			}
			return;
		}
	}
	if (fireEvents) {
		dispatch(
			element,
			new ToggleEvent("beforetoggle", {
				oldState: "open",
				newState: "closed",
				source,
			}),
		);
		validity = checkPopoverValidity(element, true, null);
		if (validity !== true) {
			cleanup();
			if (throwExceptions && isPopoverException(validity)) {
				throw validity;
			}
			return;
		}
	}
	getTopLayer(document).delete(element);
	state.trigger = null;
	state.mode = null;
	state.visibility = "hidden";
	if (fireEvents) {
		queuePopoverToggleEventTask(element, "open", "closed", source);
	}
	const previouslyFocused = state.previouslyFocused;
	if (previouslyFocused !== null) {
		state.previouslyFocused = null;
		// Focus returns only if the popover still holds it. An author who moved
		// focus elsewhere while it was open keeps it there.
		const active = document[kActiveElement]!;
		if (
			focusPreviousElement &&
			active !== null &&
			(active === element ||
				element.contains(active as unknown as globalThis.Node))
		) {
			(previouslyFocused as HTMLElement).focus();
		}
	}
	cleanup();
	popoverStateChanged(element);
}

// A close request (Escape on the topmost auto popover) is a hide that
// restores focus and fires its events.
function closePopover(element: globalThis.Element): void {
	hidePopover(element as Element, true, true, false, null);
}

// Closes the auto popovers stacked above an endpoint, topmost first,
// leaving the endpoint and everything under it. A null endpoint closes
// the whole stack. The second pass catches popovers a beforetoggle
// listener showed while the stack was unwinding, which would otherwise
// remain above the endpoint.
function hidePopoverStackUntil(
	document: Document,
	endpoint: Element | null,
	focusPreviousElement: boolean,
	fireEvents: boolean,
): void {
	const popovers = getShowingAutoPopovers(document);
	const index = endpoint === null ? -1 : popovers.indexOf(endpoint);
	const lastHideIndex = index === -1 ? 0 : index + 1;
	const toHide = popovers.slice(lastHideIndex).reverse();
	const toRemain = popovers.slice(0, lastHideIndex);
	for (const popover of toHide) {
		hidePopover(popover, focusPreviousElement, fireEvents, false, null);
	}
	for (const popover of getShowingAutoPopovers(document).reverse()) {
		if (toRemain.includes(popover)) {
			continue;
		}
		hidePopover(popover, focusPreviousElement, false, false, null);
	}
}

// Run by both light dismiss and an opening popover. With no hint stack,
// this is just the auto stack's version.
function hidePopoversUntil(
	document: globalThis.Document,
	endpoint: globalThis.Element | null,
	focusPreviousElement: boolean,
	fireEvents: boolean,
): void {
	hidePopoverStackUntil(
		document as Document,
		endpoint as Element | null,
		focusPreviousElement,
		fireEvents,
	);
}

// The open auto popover a node belongs to, either by sitting inside it
// in the flat tree or by being invoked from inside it. Returns the LAST
// such popover in the stack, so everything above it is exactly what is
// unrelated to the node.
function getTopmostPopoverAncestor(
	node: Element,
	source: Element | null,
): Element | null {
	const popovers = getShowingAutoPopovers(node[kDocument]!);
	const getNodeIndex = getLastFlatAncestorIndex(popovers, node);
	const sourceIndex =
		source === null ? -1 : getLastFlatAncestorIndex(popovers, source);
	const index = Math.max(getNodeIndex, sourceIndex);
	return index === -1 ? null : popovers[index];
}

function getLastFlatAncestorIndex(popovers: Element[], node: Element): number {
	for (let i = popovers.length - 1; i >= 0; i--) {
		const popover = popovers[i];
		if (node !== popover && isFlatInclusiveAncestor(popover, node)) {
			return i;
		}
	}
	return -1;
}

function getNearestInclusiveOpenPopover(node: Node): Element | null {
	for (
		let current: Node | null = node;
		current !== null;
		current = flatParentElement<Node>(current)
	) {
		const state = popoverStates.get(current as Element);
		if (state?.mode === "auto" && state.visibility === "showing") {
			return current as Element;
		}
	}
	return null;
}

// The open auto popover that the node, or an element containing it,
// INVOKES. This is what stops a click on a popover's own button from
// light-dismissing the popover it opened.
function getNearestInclusiveTargetPopover(node: Node): Element | null {
	for (
		let current: Node | null = node;
		current !== null;
		current = flatParentElement<Node>(current)
	) {
		const target = getPopoverTargetElement(current);
		if (
			target !== null &&
			getPopoverAttributeState(target) === "auto" &&
			isShowingPopover(target)
		) {
			return target;
		}
	}
	return null;
}

// Zero for a popover not in the stack.
function getPopoverStackPosition(popover: Element | null): number {
	if (popover === null) {
		return 0;
	}
	const index = getShowingAutoPopovers(popover[kDocument]!).indexOf(popover);
	return index === -1 ? 0 : index + 1;
}

// The deeper of the popover the node is in and the popover the node
// invokes. Light dismiss closes everything stacked above it.
function getTopmostClickedPopover(
	node: globalThis.Node,
): globalThis.Element | null {
	const clicked = getNearestInclusiveOpenPopover(node as Node);
	const target = getNearestInclusiveTargetPopover(node as Node);
	return getPopoverStackPosition(clicked) > getPopoverStackPosition(target)
		? clicked
		: target;
}

// Unlike a dialog, a popover does not take focus from the page when it
// opens. Focus moves only if the content asks for it with autofocus.
function popoverFocusingSteps(element: Element): void {
	if (element instanceof HTMLDialogElement) {
		// A dialog shown as a popover focuses like a dialog, not like a popover.
		focusDialog(element);
		return;
	}
	if (element.hasAttribute("autofocus")) {
		(element as HTMLElement).focus();
		return;
	}
	for (const node of shadowIncludingInclusiveDescendants(element)) {
		if (node === element || node.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const descendant = node as Element;
		if (!descendant.hasAttribute("autofocus")) {
			continue;
		}
		if (!isFocusableArea(descendant)) {
			continue;
		}
		(descendant as HTMLElement).focus();
		return;
	}
}

// A popover shown and hidden within one turn reports only the final
// state. The pending task is dropped and its old state is carried into
// the replacement, so the author sees one toggle event describing the
// whole run rather than a pair that cancel out.
function queuePopoverToggleEventTask(
	element: Element,
	oldState: string,
	newState: string,
	source: Element | null,
): void {
	const state = getPopoverState(element);
	if (state.toggleTask !== null) {
		oldState = state.toggleTask.oldState;
		state.toggleTask.canceled = true;
	}
	const task = {oldState, canceled: false};
	state.toggleTask = task;
	queueMicrotask(() => {
		if (task.canceled) {
			return;
		}
		state.toggleTask = null;
		dispatch(element, new ToggleEvent("toggle", {oldState, newState, source}));
	});
}

// A popovertarget set to an ELEMENT rather than named by id. The
// attribute cannot hold an element, so the reference is stored
// separately. The getter returns it only while the element is in a tree
// the invoker composes into.
const explicitPopoverTargets = new WeakMap<Element, Element>();

// The explicitly set element if it is still reachable, otherwise the
// element the attribute names by id in the invoker's own tree.
function getPopoverTargetAttributeElement(node: Node): Element | null {
	if (node.nodeType !== ELEMENT_NODE) {
		return null;
	}
	const element = node as Element;
	const explicit = explicitPopoverTargets.get(element);
	if (explicit !== undefined) {
		// The reference is valid while the target is in the invoker's own tree
		// or in one that tree composes into. It goes stale rather than dangling
		// when the target is moved out from under it.
		for (let root: Node = getRoot(element); ;) {
			if (root.contains(explicit as unknown as globalThis.Node)) {
				return explicit;
			}
			if (!isShadowRoot(root)) {
				return null;
			}
			const host = (root as ShadowRoot)[kHost]!;
			if (host === null) {
				return null;
			}
			root = getRoot(host);
		}
	}
	const id = element.getAttribute("popovertarget");
	if (id === null) {
		return null;
	}
	const root = getRoot(element);
	if (root.nodeType !== DOCUMENT_NODE && !isShadowRoot(root)) {
		return null;
	}
	return (root as Document | ShadowRoot).getElementById(
		id,
	) as unknown as Element | null;
}

function setPopoverTargetAttributeElement(
	element: Element,
	value: Element | null,
): void {
	if (value === null || value === undefined) {
		explicitPopoverTargets.delete(element);
		element.removeAttribute("popovertarget");
		return;
	}
	explicitPopoverTargets.set(element, value);
	element.setAttribute("popovertarget", "");
}

// A BUTTON as the popover target attributes define it: the button
// element, and the input types that render as buttons.
function isPopoverInvokerButton(node: Node): boolean {
	if (node instanceof HTMLButtonElement) {
		return true;
	}
	if (!(node instanceof HTMLInputElement)) {
		return false;
	}
	const type = node.type;
	return (
		type === "submit" ||
		type === "reset" ||
		type === "button" ||
		type === "image"
	);
}

// A button that submits a form is not an invoker. Its activation is the
// submission, and the attribute on it does nothing.
function getPopoverTargetElement(node: Node): Element | null {
	if (!isPopoverInvokerButton(node)) {
		return null;
	}
	const element = node as Element;
	if (isActuallyDisabled(element)) {
		return null;
	}
	if (getFormOwner(element) !== null && isSubmitButton(element)) {
		return null;
	}
	const popover = getPopoverTargetAttributeElement(element);
	if (popover === null) {
		return null;
	}
	return getPopoverAttributeState(popover) === null ? null : popover;
}

// `popovertargetaction` names which half of the toggle to run. A button
// inside the popover it targets does nothing, because the click that
// reaches it belongs to the popover.
function popoverTargetActivationBehavior(node: Element, target: unknown): void {
	const popover = getPopoverTargetElement(node);
	if (popover === null) {
		return;
	}
	if (
		target instanceof Node &&
		isFlatInclusiveAncestor(popover, target) &&
		isFlatInclusiveAncestor(node, popover) &&
		popover !== node
	) {
		return;
	}
	const action = toASCIILowercase(
		node.getAttribute("popovertargetaction") ?? "toggle",
	);
	const showing = isShowingPopover(popover);
	if (action === "show" && showing) {
		return;
	}
	if (action === "hide" && !showing) {
		return;
	}
	if (showing) {
		hidePopover(popover, true, true, false, node);
		return;
	}
	if (checkPopoverValidity(popover, false, null) === true) {
		showPopover(popover, false, node);
	}
}

// The flat tree version of isShadowIncludingInclusiveAncestor.
function isFlatInclusiveAncestor(ancestor: Node, node: Node): boolean {
	for (
		let current: Node | null = node;
		current !== null;
		current = flatParentElement<Node>(current)
	) {
		if (current === ancestor) {
			return true;
		}
	}
	return false;
}

const HTML_INTERFACE_CLASSES: Record<string, typeof HTMLElement> = {
	HTMLAnchorElement,
	HTMLAreaElement,
	HTMLAudioElement,
	HTMLBRElement,
	HTMLBaseElement,
	HTMLBodyElement,
	HTMLButtonElement,
	HTMLCanvasElement,
	HTMLDListElement,
	HTMLDataElement,
	HTMLDataListElement,
	HTMLDetailsElement,
	HTMLDialogElement,
	HTMLDirectoryElement,
	HTMLDivElement,
	HTMLEmbedElement,
	HTMLFieldSetElement,
	HTMLFontElement,
	HTMLFormElement,
	HTMLFrameElement,
	HTMLFrameSetElement,
	HTMLHRElement,
	HTMLHeadElement,
	HTMLHeadingElement,
	HTMLHtmlElement,
	HTMLIFrameElement,
	HTMLImageElement,
	HTMLInputElement,
	HTMLLIElement,
	HTMLLabelElement,
	HTMLLegendElement,
	HTMLLinkElement,
	HTMLMapElement,
	HTMLMarqueeElement,
	HTMLMediaElement,
	HTMLMenuElement,
	HTMLMetaElement,
	HTMLMeterElement,
	HTMLModElement,
	HTMLOListElement,
	HTMLObjectElement,
	HTMLOptGroupElement,
	HTMLOptionElement,
	HTMLOutputElement,
	HTMLParagraphElement,
	HTMLParamElement,
	HTMLPictureElement,
	HTMLPreElement,
	HTMLProgressElement,
	HTMLQuoteElement,
	HTMLScriptElement,
	HTMLSelectElement,
	HTMLSourceElement,
	HTMLSpanElement,
	HTMLStyleElement,
	HTMLTableCaptionElement,
	HTMLTableCellElement,
	HTMLTableColElement,
	HTMLTableElement,
	HTMLTableRowElement,
	HTMLTableSectionElement,
	HTMLTextAreaElement,
	HTMLTimeElement,
	HTMLTitleElement,
	HTMLTrackElement,
	HTMLUListElement,
	HTMLVideoElement,
};

// Installs the members each interface reflects, the name it stringifies
// as, and the tags an element of it is created for.
for (const spec of HTML_INTERFACES) {
	const constructor = HTML_INTERFACE_CLASSES[spec.name];
	for (const reflection of spec.reflect ?? []) {
		installReflection(constructor.prototype, reflection);
	}
	Object.defineProperty(constructor.prototype, Symbol.toStringTag, {
		value: spec.name,
		configurable: true,
	});
	for (const tag of spec.tags) {
		builtinRegistry.define(HTML_NAMESPACE, tag, constructor);
	}
}

for (const tag of HTML_ELEMENT_TAGS) {
	builtinRegistry.define(HTML_NAMESPACE, tag, HTMLElement);
}

for (const tag of HTML_UNKNOWN_TAGS) {
	builtinRegistry.define(HTML_NAMESPACE, tag, HTMLUnknownElement);
}

for (const reflection of HTML_ELEMENT_REFLECTIONS) {
	installReflection(HTMLElement.prototype, reflection);
}

// The ARIA mixin: every aria-* content attribute as a nullable string on
// the element and on its internals.
for (const [property, attribute] of ARIA_STRING_REFLECTIONS) {
	installReflection(Element.prototype, {
		property,
		attribute,
		kind: "nullable-string",
	});
}

/**
 * HTML's light dismiss, the press half. Records the popover the pressed
 * point is inside of or invokes, so the release can tell a click from a
 * press that moved. The caller keeps the gesture state; this file keeps
 * the stack.
 */
export function lightDismissPress(
	target: globalThis.Element,
): globalThis.Element | null {
	return getTopmostClickedPopover(target);
}

/**
 * The release half. A release closes every auto popover the released
 * point is not inside of and did not open. A popover's invoker counts as
 * part of it, so the click that follows toggles rather than reopens what
 * this closed. Runs before the click, as in a browser, and no listener can
 * prevent it.
 */
export function lightDismissRelease(
	target: globalThis.Element,
	pressed: globalThis.Element | null,
): void {
	const dismissAncestor = getTopmostClickedPopover(target);
	if (dismissAncestor !== pressed) {
		return;
	}
	const document = (target as Element)[kDocument]!;
	if (getTopmostAutoPopover(document) !== null) {
		hidePopoversUntil(document, dismissAncestor, false, true);
	}
}

/**
 * A close request's default action. The modal dialog or auto popover that
 * most recently entered the top layer takes it: a popover closes, a dialog
 * is asked to close. A manual popover responds to neither Escape nor a
 * click outside, and neither does anything else in the layer. Returns
 * false when nothing takes it.
 */
export function handleCloseRequest(document: globalThis.Document): boolean {
	const popover = getTopmostAutoPopover(document);
	let target: globalThis.Element | null = null;
	for (const element of renderedTopLayer(document)) {
		if (isModalDialog(element) || element === popover) {
			target = element;
		}
	}
	if (target === null) {
		return false;
	}
	if (isShowingPopover(target)) {
		closePopover(target);
	} else {
		(target as HTMLDialogElement).requestClose();
	}
	return true;
}

// The Fullscreen API over the engine's alternate screen. The element
// stack, the spec steps and the two events are user-agent state and live
// here. The screen swap itself belongs to the engine and is bracketed
// through the frame so no frame straddles it.
const fullscreenStacks = new WeakMap<Document, Element[]>();

function getFullscreenStack(document: Document): Element[] {
	let stack = fullscreenStacks.get(document);
	if (stack === undefined) {
		stack = [];
		fullscreenStacks.set(document, stack);
	}
	return stack;
}

// The top of the stack is the element the viewport shows alone.
function getFullscreenElement(document: Document): Element | null {
	const stack = fullscreenStacks.get(document);
	return stack?.length ? stack[stack.length - 1] : null;
}

/** Abandon fullscreen without events. Used when the engine is tearing down. */
export function dropFullscreen(document: globalThis.Document): void {
	fullscreenStacks.delete(document as Document);
}

// ONE target, per the Fullscreen Standard: the element while it is still
// in the document, otherwise the document. Both events bubble, so a
// document listener sees them either way. Firing at both would deliver
// every event twice.
function fireFullscreenEvent(
	type: "fullscreenchange" | "fullscreenerror",
	element: Element,
	detail?: {error: Error},
): void {
	const target = element.isConnected ? element : element[kDocument]!;
	dispatchAsUserAgent(
		target,
		new CustomEvent(type, {
			bubbles: true,
			cancelable: false,
			...(detail ? {detail} : {}),
		}),
	);
}

// The alternate screen comes up holding whatever the terminal left in
// it, so entering clears it and homes the cursor. The cursor is hidden
// before the screen is touched, so it never blinks on the clear.
function enterFullscreen(element: Element): void {
	const stack = getFullscreenStack(element[kDocument]!);
	try {
		if (!element.isConnected) {
			const error = new Error("The element is not contained by a document.");
			error.name = "InvalidStateError";
			throw error;
		}
		stack.push(element);
		fireFullscreenEvent("fullscreenchange", element);
	} catch (error) {
		if (stack[stack.length - 1] === element) {
			stack.pop();
		}
		fireFullscreenEvent("fullscreenerror", element, {error: error as Error});
		throw error;
	}
}

function getDatasetAttributeName(property: string): string {
	let name = "data-";
	for (const character of property) {
		if (character === "-") {
			throw domError(
				"SyntaxError",
				`"${property}" is not a name a data-* attribute has`,
			);
		}
		name +=
			character >= "A" && character <= "Z"
				? `-${toASCIILowercase(character)}`
				: character;
	}
	return name;
}

function getDatasetPropertyName(attribute: string): string | null {
	if (!attribute.startsWith("data-")) {
		return null;
	}
	let property = "";
	for (let index = 5; index < attribute.length; index++) {
		const character = attribute[index];
		if (character === "-" && index + 1 < attribute.length) {
			const next = attribute[index + 1];
			if (next >= "a" && next <= "z") {
				property += toASCIIUppercase(next);
				index++;
				continue;
			}
		}
		if (character >= "A" && character <= "Z") {
			return null;
		}
		property += character;
	}
	return property;
}

const kDatasetElement = Symbol("the element a data map belongs to");
const kDatasetNames = Symbol("the names a data map has materialized");

// Every attribute is an own accessor of the map, created when the map is
// requested and synced on each request, so a read or write of a name
// the element has goes straight through to the attribute.
class DOMStringMap {
	[name: string]: string | undefined;

	[kDatasetElement]?: Element;
	[kDatasetNames]?: string[];

	constructor(element: Element) {
		this[kDatasetNames] = [];
		this[kDatasetElement] = element;
	}
}

function syncDataset(
	map: DOMStringMap,
): void {
	const element = map[kDatasetElement]!;
	const names: string[] = [];
	for (const attribute of element[kAttributeList]!) {
		if (attribute[kNamespace] !== null) {
			continue;
		}
		const property = getDatasetPropertyName(attribute[kLocalName]!);
		if (property === null) {
			continue;
		}
		names.push(property);
	}
	names.sort();
	for (const name of map[kDatasetNames]!) {
		if (!names.includes(name)) {
			delete (map as never)[name];
		}
	}
	for (const name of names) {
		if (map[kDatasetNames]!.includes(name)) {
			continue;
		}
		const attribute = getDatasetAttributeName(name);
		Object.defineProperty(map, name, {
			get(this: DOMStringMap): string {
				return map[kDatasetElement]!.getAttribute(attribute) as string;
			},
			set: wrapWithReactions(function (
				this: DOMStringMap,
				value: unknown,
			): void {
				this[kDatasetElement]!.setAttribute(attribute, String(value));
			}) as (value: unknown) => void,
			enumerable: true,
			configurable: true,
		});
	}
	map[kDatasetNames] = names;
}

Object.defineProperty(DOMStringMap.prototype, Symbol.toStringTag, {
	value: "DOMStringMap",
	configurable: true,
});

/** The elements a form can own. */
const FORM_ASSOCIATED_TAGS = new Set([
	"button",
	"fieldset",
	"img",
	"input",
	"object",
	"output",
	"select",
	"textarea",
]);

/** The form-associated elements a form lists in its `elements`. */
const LISTED_TAGS = new Set([
	"button",
	"fieldset",
	"input",
	"object",
	"output",
	"select",
	"textarea",
]);

const LABELABLE_TAGS = new Set([
	"button",
	"input",
	"meter",
	"output",
	"progress",
	"select",
	"textarea",
]);

const DISABLEABLE_TAGS = new Set([
	"button",
	"input",
	"select",
	"textarea",
	"optgroup",
	"option",
	"fieldset",
]);

function isHTMLTag(node: Node, tags: Set<string>): boolean {
	if (node.nodeType !== ELEMENT_NODE) {
		return false;
	}
	const element = node as Element;
	return (
		element[kNamespace] === HTML_NAMESPACE && tags.has(element[kLocalName]!)
	);
}

function isFormAssociated(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return true;
	}
	return isHTMLTag(element, FORM_ASSOCIATED_TAGS);
}

function isListed(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return true;
	}
	return isHTMLTag(element, LISTED_TAGS);
}

function isFormAssociatedCustom(element: Element): boolean {
	const definition = element[kDefinition]!;
	return (
		element[kCustomState] === "custom" &&
		definition !== null &&
		definition.formAssociated
	);
}

function isLabelable(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return true;
	}
	if (!isHTMLTag(element, LABELABLE_TAGS)) {
		return false;
	}
	return (
		element[kLocalName] !== "input" ||
		toASCIILowercase(element.getAttribute("type") ?? "") !== "hidden"
	);
}

const kFormDisabled = Symbol("disabled by a fieldset or its own attribute");

// Disabled by its own attribute, or by a fieldset above it whose first
// legend does not contain the control.
function isActuallyDisabled(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return element[kInternals]?.[kFormDisabled] === true;
	}
	if (!isHTMLTag(element, DISABLEABLE_TAGS)) {
		return false;
	}
	if (
		element[kLocalName] === "option" || element[kLocalName] === "optgroup"
	) {
		if (element.hasAttribute("disabled")) {
			return true;
		}
		const parent = element[kParent]!;
		return (
			element[kLocalName] === "option" &&
			parent !== null &&
			isHTMLElementNamed(parent, "optgroup") &&
			(parent as Element).hasAttribute("disabled")
		);
	}
	if (element.hasAttribute("disabled")) {
		return true;
	}
	if (element[kLocalName] === "fieldset") {
		return false;
	}
	return isDisabledByFieldSet(element);
}

function isDisabledByFieldSet(element: Element): boolean {
	for (
		let node: Node | null = element[kParent]!;
		node !== null;
		node = node[kParent]!
	) {
		if (!isHTMLElementNamed(node, "fieldset")) {
			continue;
		}
		const fieldset = node as Element;
		if (!fieldset.hasAttribute("disabled")) {
			continue;
		}
		const legend = getFirstChildElement(fieldset, "legend");
		if (legend !== null && isInclusiveAncestor(legend, element)) {
			continue;
		}
		return true;
	}
	return false;
}

// Computed from the tree each time rather than stored. A listed element
// with a form attribute is owned by the form with that id in its tree.
// Every other form-associated element is owned by its nearest form
// ancestor. Both results change only when the tree or the attribute
// changes, so reading them is equivalent to resetting the owner at every
// point the spec does.
function getFormOwner(element: Element): HTMLFormElement | null {
	if (!isFormAssociated(element)) {
		return null;
	}
	if (isListed(element) && element.hasAttribute("form")) {
		const id = element.getAttribute("form") as string;
		if (id === "") {
			return null;
		}
		const root = getRoot(element);
		if (root.nodeType !== DOCUMENT_NODE && !isShadowRoot(root)) {
			return null;
		}
		for (const node of descendants(root)) {
			if (node.nodeType !== ELEMENT_NODE) {
				continue;
			}
			const candidate = node as Element;
			if (candidate.getAttribute("id") !== id) {
				continue;
			}
			return candidate instanceof HTMLFormElement ? candidate : null;
		}
		return null;
	}
	for (
		let node: Node | null = element[kParent]!;
		node !== null;
		node = node[kParent]!
	) {
		if (node instanceof HTMLFormElement) {
			return node;
		}
	}
	return null;
}

const kFormOwner = Symbol("the form an internals last reported");

// The callback is the one place the owner has to be remembered, because
// the callback reports the change rather than the value.
function resetTheFormOwner(element: Element): void {
	if (!isFormAssociatedCustom(element)) {
		return;
	}
	const internals = element[kInternals]!;
	if (internals === null) {
		return;
	}
	const owner = getFormOwner(element);
	if (internals[kFormOwner] === owner) {
		return;
	}
	internals[kFormOwner] = owner;
	enqueueCallbackReaction(element, "formAssociatedCallback", [owner]);
}

function resetFormOwners(node: Node): void {
	for (const candidate of shadowIncludingInclusiveDescendants(node)) {
		if (candidate.nodeType !== ELEMENT_NODE) {
			continue;
		}
		resetTheFormOwner(candidate as Element);
		syncFormDisabled(candidate as Element);
	}
}

// The state comes from the element's own disabled attribute or from a
// fieldset above it with one. Both are read from the tree. The stored
// flag exists only so a change can be reported.
function syncFormDisabled(element: Element): void {
	if (!isFormAssociatedCustom(element)) {
		return;
	}
	const internals = element[kInternals]!;
	if (internals === null) {
		return;
	}
	const disabled =
		element.hasAttribute("disabled") || isDisabledByFieldSet(element);
	if (internals[kFormDisabled] === disabled) {
		return;
	}
	internals[kFormDisabled] = disabled;
	enqueueCallbackReaction(element, "formDisabledCallback", [disabled]);
}

interface ValidityFlags {
	valueMissing: boolean;
	typeMismatch: boolean;
	patternMismatch: boolean;
	tooLong: boolean;
	tooShort: boolean;
	rangeUnderflow: boolean;
	rangeOverflow: boolean;
	stepMismatch: boolean;
	badInput: boolean;
	customError: boolean;
}

const VALIDITY_FLAG_NAMES = [
	"valueMissing",
	"typeMismatch",
	"patternMismatch",
	"tooLong",
	"tooShort",
	"rangeUnderflow",
	"rangeOverflow",
	"stepMismatch",
	"badInput",
	"customError",
] as const;

function noValidityFlags(): ValidityFlags {
	return {
		valueMissing: false,
		typeMismatch: false,
		patternMismatch: false,
		tooLong: false,
		tooShort: false,
		rangeUnderflow: false,
		rangeOverflow: false,
		stepMismatch: false,
		badInput: false,
		customError: false,
	};
}

const kFlags = Symbol("flags");
const kValidityFlags = Symbol("validity flags");

class ValidityState {
	declare [kFlags]?: () => ValidityFlags;

	constructor(flags: () => ValidityFlags) {
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kFlags] = flags;
	}

	get valid(): boolean {
		const flags = this[kFlags]!();
		return !VALIDITY_FLAG_NAMES.some((name) => flags[name]);
	}

	get [kValidityFlags](): ValidityFlags {
		return this[kFlags]!();
	}
}

for (const name of VALIDITY_FLAG_NAMES) {
	Object.defineProperty(ValidityState.prototype, name, {
		get(this: ValidityState): boolean {
			return this[kValidityFlags]![name];
		},
		enumerable: true,
		configurable: true,
	});
}

Object.defineProperty(ValidityState.prototype, Symbol.toStringTag, {
	value: "ValidityState",
	configurable: true,
});

const kStates = Symbol("custom state set");

// The set belongs to the author. A selector engine that supports
// `:state()` reads it, and nothing else in this DOM does.
class CustomStateSet {
	declare [kStates]?: Set<string>;

	constructor() {
		this[kStates] = new Set<string>();
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
	}

	get size(): number {
		return this[kStates]!.size;
	}

	add(value: string): CustomStateSet {
		if (arguments.length < 1) {
			throw new TypeError("add needs a value");
		}
		this[kStates]!.add(String(value));
		return this;
	}

	delete(value: string): boolean {
		if (arguments.length < 1) {
			throw new TypeError("delete needs a value");
		}
		return this[kStates]!.delete(String(value));
	}

	has(value: string): boolean {
		if (arguments.length < 1) {
			throw new TypeError("has needs a value");
		}
		return this[kStates]!.has(String(value));
	}

	clear(): void {
		this[kStates]!.clear();
	}

	forEach(
		callback: (value: string, key: string, set: CustomStateSet) => void,
		thisArg?: unknown,
	): void {
		if (typeof callback !== "function") {
			throw new TypeError("That is not a callback");
		}
		for (const value of [...this[kStates]!]) {
			callback.call(thisArg, value, value, this);
		}
	}

	keys(): IterableIterator<string> {
		return this[kStates]!.values();
	}

	values(): IterableIterator<string> {
		return this[kStates]!.values();
	}

	entries(): IterableIterator<[string, string]> {
		return this[kStates]!.entries();
	}

	[Symbol.iterator](): IterableIterator<string> {
		return this[kStates]!.values();
	}
}

Object.defineProperty(CustomStateSet.prototype, Symbol.toStringTag, {
	value: "CustomStateSet",
	configurable: true,
});

const kValidity = Symbol("validity");
const kValidationMessage = Symbol("validation message");
const kSubmissionValue = Symbol("submission value");
const kElementInternalsTarget = Symbol("the element an internals belongs to");

// A custom element's handle on the parts of it the platform owns: its
// shadow root, its form owner, the value it submits, its validity and the
// accessibility properties it declares.
class ElementInternals {
	[kElementInternalsTarget]?: Element;
	[kFormOwner]?: HTMLFormElement | null;
	[kFormDisabled]?: boolean;
	[kSubmissionValue]?: unknown;
	[kValidityFlags]?: ValidityFlags;
	[kValidationMessage]?: string;
	[kStates]?: CustomStateSet | null;
	declare [kValidity]?: ValidityState;

	constructor(target: Element) {
		this[kFormOwner] = null;
		this[kFormDisabled] = false;
		this[kSubmissionValue] = null;
		this[kValidityFlags] = noValidityFlags();
		this[kValidationMessage] = "";
		this[kStates] = null;
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kElementInternalsTarget] = target;
		this[kValidity] = new ValidityState(() => this[kValidityFlags]!);
	}

	get shadowRoot(): ShadowRoot | null {
		const shadow = this[kElementInternalsTarget]![kShadowRoot]!;
		if (shadow === null || !shadow[kAvailableToInternals]!) {
			return null;
		}
		return shadow;
	}

	get form(): HTMLFormElement | null {
		requireFormAssociated(this);
		return getFormOwner(this[kElementInternalsTarget]!);
	}

	get labels(): NodeList {
		requireFormAssociated(this);
		return getLabels(this[kElementInternalsTarget]!);
	}

	get states(): CustomStateSet {
		let states = this[kStates]!;
		if (states === null) {
			states = constructInternal(() => new CustomStateSet());
			this[kStates] = states;
		}
		return states;
	}

	get willValidate(): boolean {
		requireFormAssociated(this);
		return willValidate(this[kElementInternalsTarget]!);
	}

	get validity(): ValidityState {
		requireFormAssociated(this);
		return this[kValidity]!;
	}

	get validationMessage(): string {
		requireFormAssociated(this);
		return this[kValidationMessage]!;
	}

	setFormValue(value: unknown, state?: unknown): void {
		if (arguments.length < 1) {
			throw new TypeError("setFormValue needs a value");
		}
		requireFormAssociated(this);
		this[kSubmissionValue] =
			value === null || value === undefined
				? null
				: typeof value === "object"
					? value
					: String(value);
		void state;
	}

	setValidity(
		flags?: Partial<ValidityFlags>,
		message?: string,
		anchor?: HTMLElement,
	): void {
		requireFormAssociated(this);
		const given = toDictionary<Partial<ValidityFlags>>(
			flags ?? {},
			"A ValidityStateFlags",
		);
		const next = noValidityFlags();
		let anyFailed = false;
		for (const name of VALIDITY_FLAG_NAMES) {
			next[name] = Boolean(given[name]);
			if (next[name]) {
				anyFailed = true;
			}
		}
		if (anyFailed && (message === undefined || String(message) === "")) {
			throw new TypeError("A failing constraint needs a message");
		}
		if (anchor !== undefined && anchor !== null) {
			if (
				!(anchor instanceof HTMLElement) ||
				!isShadowIncludingInclusiveAncestor(
					this[kElementInternalsTarget]!,
					anchor,
				)
			) {
				throw new TypeError("That anchor is not inside the element");
			}
		}
		this[kValidityFlags] = next;
		this[kValidationMessage] = anyFailed ? String(message ?? "") : "";
	}

	checkValidity(): boolean {
		requireFormAssociated(this);
		return checkValidity(this[kElementInternalsTarget]!);
	}

	// Reporting means a browser showing the validation message in its own
	// chrome, and a terminal has none to show it in.
	reportValidity(): boolean {
		requireFormAssociated(this);
		return checkValidity(this[kElementInternalsTarget]!);
	}
}

function requireFormAssociated(internals: ElementInternals): void {
	if (!isFormAssociatedCustom(internals[kElementInternalsTarget]!)) {
		throw domError(
			"NotSupportedError",
			"That element's definition is not form-associated",
		);
	}
}

Object.defineProperty(ElementInternals.prototype, Symbol.toStringTag, {
	value: "ElementInternals",
	configurable: true,
});

interface ElementInternals
	extends Pick<
		globalThis.ElementInternals,
		Extract<keyof globalThis.ElementInternals, ARIAReflection>
	> {}

for (const [property, attribute] of ARIA_STRING_REFLECTIONS) {
	Object.defineProperty(ElementInternals.prototype, property, {
		get(this: ElementInternals): string | null {
			return this[kElementInternalsTarget]!.getAttribute(attribute);
		},
		set(this: ElementInternals, value: unknown): void {
			if (value === null || value === undefined) {
				this[kElementInternalsTarget]!.removeAttribute(attribute);
			} else {
				this[kElementInternalsTarget]!.setAttribute(attribute, String(value));
			}
		},
		enumerable: true,
		configurable: true,
	});
}

// The target must be in this element's tree or in a tree above it.
function isReachableARIATarget(from: Element, target: Element): boolean {
	const fromRoot = getRoot(from);
	for (
		let root: Node | null = getRoot(target);
		root !== null;
		root = isShadowRoot(root)
			? getRoot((root as ShadowRoot)[kHost]! as Node)
			: null
	) {
		if (root === fromRoot) {
			return true;
		}
	}
	return false;
}

function getARIATargetsFromAttribute(
	element: Element,
	attribute: string,
): Element[] | null {
	const value = element.getAttribute(attribute);
	// No attribute and no elements passed means no reflected target at all,
	// which reads back as null rather than an empty list.
	if (value === null) {
		return null;
	}
	const root = getRoot(element);
	const found: Element[] = [];
	for (const id of splitOnASCIIWhitespace(value)) {
		for (const node of descendants(root)) {
			if (node.nodeType !== ELEMENT_NODE) {
				continue;
			}
			if ((node as Element).getAttribute("id") !== id) {
				continue;
			}
			found.push(node as Element);
			break;
		}
	}
	return found;
}

/** Explicitly set elements first. */
function getARIATargets(
	element: Element,
	property: string,
	attribute: string,
): Element[] | null {
	const explicit = element[kARIAElements]?.get(property);
	if (explicit === undefined) {
		return getARIATargetsFromAttribute(element, attribute);
	}
	return explicit.filter((target) => isReachableARIATarget(element, target));
}

function setARIATargets(
	element: Element,
	property: string,
	attribute: string,
	targets: Element[] | null,
): void {
	if (targets === null) {
		element[kARIAElements]?.delete(property);
		element.removeAttribute(attribute);
		return;
	}
	let explicit = element[kARIAElements]!;
	if (explicit === null) {
		explicit = new Map<string, Element[]>();
		element[kARIAElements] = explicit;
	}
	explicit.set(property, targets);
	element.setAttribute(attribute, "");
}

// A member returns the elements the caller last passed in, or if none
// were passed, the elements the attribute's identifiers name. An element
// that has moved out of reach is dropped from the result.
for (const [property, attribute, many] of ARIA_ELEMENT_REFLECTIONS) {
	const descriptor: PropertyDescriptor = {
		get(this: Element): Element | readonly Element[] | null {
			const targets = getARIATargets(this, property, attribute);
			if (targets === null) {
				return null;
			}
			if (many) {
				return Object.freeze(targets);
			}
			return targets.length === 0 ? null : targets[0];
		},
		set: wrapWithReactions(function (this: Element, value: unknown): void {
			if (value === null || value === undefined) {
				setARIATargets(this, property, attribute, null);
				return;
			}
			if (many) {
				const list: Element[] = [];
				for (const entry of value as Iterable<unknown>) {
					if (!(entry instanceof Element)) {
						throw new TypeError("That is not an element");
					}
					list.push(entry);
				}
				setARIATargets(this, property, attribute, list);
				return;
			}
			if (!(value instanceof Element)) {
				throw new TypeError("That is not an element");
			}
			setARIATargets(this, property, attribute, [value]);
		}) as (value: unknown) => void,
		enumerable: true,
		configurable: true,
	};
	Object.defineProperty(Element.prototype, property, descriptor);
	Object.defineProperty(ElementInternals.prototype, property, {
		get(this: ElementInternals): Element | readonly Element[] | null {
			const target = this[kElementInternalsTarget]!;
			const targets = getARIATargets(target, property, attribute);
			if (targets === null) {
				return null;
			}
			if (many) {
				return Object.freeze(targets);
			}
			return targets.length === 0 ? null : targets[0];
		},
		set(this: ElementInternals, value: unknown): void {
			(descriptor.set as (this: Element, value: unknown) => void).call(
				this[kElementInternalsTarget]!,
				value,
			);
		},
		enumerable: true,
		configurable: true,
	});
}

function attachElementInternals(element: HTMLElement): ElementInternals {
	if (element[kIsValue] !== null) {
		throw domError(
			"NotSupportedError",
			"A customized built-in element has no internals",
		);
	}
	const definition = element[kDefinition]!;
	if (definition === null) {
		throw domError("NotSupportedError", "That element is not a custom element");
	}
	if (definition.disableInternals) {
		throw domError(
			"NotSupportedError",
			"That element's definition disabled its internals",
		);
	}
	if (element[kInternals] !== null) {
		throw domError(
			"NotSupportedError",
			"That element's internals were already attached",
		);
	}
	const state = element[kCustomState]!;
	if (state !== "precustomized" && state !== "custom") {
		throw domError(
			"NotSupportedError",
			"That element is not yet a custom element",
		);
	}
	const internals = constructInternal(() => new ElementInternals(element));
	element[kInternals] = internals;
	return internals;
}

function getLabels(element: Element): NodeList {
	if (!isLabelable(element)) {
		return createStaticNodeList([]);
	}
	const labels: Node[] = [];
	const root = getRoot(element);
	for (const node of descendants(root)) {
		if (!(node instanceof HTMLLabelElement)) {
			continue;
		}
		if (node.control === element) {
			labels.push(node);
		}
	}
	return createStaticNodeList(labels);
}

function willValidate(element: Element): boolean {
	if (!isListed(element)) {
		return false;
	}
	if (isActuallyDisabled(element)) {
		return false;
	}
	if (element instanceof HTMLObjectElement) {
		return false;
	}
	if (element instanceof HTMLFieldSetElement) {
		return false;
	}
	if (element[kLocalName] === "output") {
		return false;
	}
	if (element.hasAttribute("readonly")) {
		return false;
	}
	for (let node: Node | null = element; node !== null; node = node[kParent]!) {
		if (isHTMLElementNamed(node, "datalist")) {
			return false;
		}
	}
	return true;
}

function checkValidity(element: Element): boolean {
	const internals = element[kInternals]!;
	const flags =
		internals === null ? noValidityFlags() : internals[kValidityFlags]!;
	if (!willValidate(element)) {
		return true;
	}
	if (!VALIDITY_FLAG_NAMES.some((name) => flags[name])) {
		return true;
	}
	dispatch(element, new Event("invalid", {cancelable: true}));
	return false;
}

/**
 * A ::before, ::after or ::marker box needs a node to hang style and
 * children off, and the engine's paint walk needs to reach it. The DOM
 * Standard has no such node, and an author must never find one. These
 * nodes live in a map keyed by pseudo-element name, reachable only through
 * the functions below, which only the engine's composition pass calls.
 * Nothing links them into the tree. Their parent stays null, so
 * childNodes, the tree walkers, the collections and the selector engine
 * cannot reach them, and no mutation record or slot assignment ever names
 * one. The node itself is an ordinary Element of the host's document, so
 * everything the engine already does with an element works on it
 * unchanged.
 */
export function pseudoElement<T>(
	host: globalThis.Element,
	name: string,
): T | null {
	const slots = (host as Element)[kPseudoElements]!;
	return slots === null || slots === undefined
		? null
		: ((slots.get(name) as T) ?? null);
}

export function pseudoElementCount(host: globalThis.Element): number {
	const slots = (host as Element)[kPseudoElements]!;
	return slots === null || slots === undefined ? 0 : slots.size;
}

/**
 * Null for every node except a pseudo-element node. This is how a
 * pseudo-element node is identified, and how the flat tree finds the
 * parent that a node with no parent renders inside.
 */
export function getPseudoHost<T>(node: globalThis.Node): T | null {
	return ((node as Element)[kPseudoHost]! as T) ?? null;
}

/** For example "::before". */
export function getPseudoName(node: globalThis.Node): string | null {
	return (node as Element)[kPseudoName]!;
}

/**
 * The node is an element named after the pseudo-element so a debugger's
 * dump reads plainly. It is never serialized.
 */
export function ensurePseudoElement<T>(
	target: globalThis.Element,
	name: string,
): T {
	const host = target as Element;
	let slots = host[kPseudoElements]!;
	if (slots === null) {
		slots = new Map<string, Element>();
		host[kPseudoElements] = slots;
	}
	let element = slots.get(name);
	if (element === undefined) {
		element = createElementInternal(host[kDocument]!, name, HTML_NAMESPACE);
		element[kPseudoHost] = host;
		element[kPseudoName] = name;
		slots.set(name, element);
	}
	return element as T;
}

export function dropPseudoElement(
	host: globalThis.Element,
	name: string,
): void {
	(host as Element)[kPseudoElements]?.delete(name);
}

// The flat tree: the tree the renderer draws, of which the DOM
// Standard's node tree is only one input. Four things separate it from
// the node tree, and all four are handled here rather than by callers:
//
// - a host's children are its shadow tree's, and only those;
// - a slot's children are the nodes assigned to it, and its own children
//   only as the fallback shown when nothing is assigned;
// - a pseudo-element node sits between an element and its children,
//   ::marker first, then ::before, with ::after after the last child;
// - a node the box tree DISSOLVES contributes its children in its own
//   place.
//
// Nothing is memoized. Every hop reads the same links the mutation
// algorithms maintain (the stored slot assignment, not the recomputed one
// an author's `assignedSlot` reports), so a walk never reads a tree that
// has changed.

// The stored assignment, including closed trees.
function getAssignedSlot(node: Node): HTMLSlotElement | null {
	const type = node.nodeType;
	return type === ELEMENT_NODE || type === TEXT_NODE
		? (node as Slottable)[kAssignedSlot]!
		: null;
}

/**
 * The element a node renders inside, which is also the element style
 * inheritance flows from. Three cases differ from parentElement: a
 * projected node's flat parent is its SLOT, a shadow root's child resolves
 * to the HOST, and a pseudo-element node's is the element it originates
 * from. Everything else is parentElement.
 */
export function flatParentElement<T>(target: globalThis.Node): T | null {
	const node = target as Node;
	const slot = getAssignedSlot(node);
	if (slot !== null) {
		return slot as unknown as T;
	}
	const parent = node[kParent]!;
	if (parent !== null) {
		if (parent.nodeType === ELEMENT_NODE) {
			return parent as unknown as T;
		}
		return isShadowRoot(parent)
			? ((parent as ShadowRoot)[kHost]! as unknown as T)
			: null;
	}
	return ((node as Element)[kPseudoHost]! as T) ?? null;
}

/**
 * Whether a node renders: it is in the document, or the flat tree above it
 * reaches the document. A pseudo-element node and a UA shadow tree's
 * contents are both outside the node tree `isConnected` checks, and both
 * render.
 */
export function flatIsConnected(target: globalThis.Node): boolean {
	let node: Node | null = target as Node;
	while (node !== null) {
		if (isConnectedNode(node)) {
			return true;
		}
		node = flatParentElement<Node>(node);
	}
	return false;
}

interface TreeLinks {
	parent(node: Node): Node | null;
	firstChild(node: Node): Node | null;
	lastChild(node: Node): Node | null;
	nextSibling(node: Node): Node | null;
	previousSibling(node: Node): Node | null;
}

const NODE_LINKS: TreeLinks = Object.freeze({
	parent: (node: Node) => node[kParent]!,
	firstChild: (node: Node) => node[kFirstChild]!,
	lastChild: (node: Node) => node[kLastChild]!,
	nextSibling: (node: Node) => node[kNext]!,
	previousSibling: (node: Node) => node[kPrevious]!,
});

// Shadow content in its slot's place, and pseudo-element nodes among
// the children they belong beside. Neither is a link a node stores, so
// each hop computes its result.
const FLAT_LINKS: TreeLinks = Object.freeze({
	parent: flatParentNode,
	firstChild: flatFirstChild,
	lastChild: flatLastChild,
	nextSibling: flatNextSibling,
	previousSibling: flatPreviousSibling,
});

const kLinks = Symbol("links");

// The flat-tree hops, with pseudo-element nodes among the
// children they belong beside.

function getPseudoSlot(element: Element, name: string): Element | null {
	const slots = element[kPseudoElements]!;
	return slots === null ? null : (slots.get(name) ?? null);
}

function flatFirstChild(node: Node): Node | null {
	if (node.nodeType !== ELEMENT_NODE) {
		return node[kFirstChild]!;
	}
	const element = node as Element;
	const slots = element[kPseudoElements]!;
	if (slots !== null) {
		// ::marker precedes ::before, and both precede the element's content.
		const marker = slots.get("::marker");
		if (marker !== undefined) {
			return marker;
		}
		const before = slots.get("::before");
		if (before !== undefined) {
			return before;
		}
	}
	const content = flatContentFirstChild(element);
	if (content !== null) {
		return content;
	}
	// A CHILDLESS element still renders its ::after. The sibling transition
	// only reaches ::after from a last child, and there is none here, so for
	// an empty element the pseudo-element IS the content.
	return slots === null ? null : (slots.get("::after") ?? null);
}

// Ignoring pseudo-elements: the shadow tree's children if the element
// hosts one, and ONLY those (an empty shadow tree means an empty element,
// because light children render only through slots); a slot's assigned
// nodes if it has any; otherwise its own children, which for a slot is
// the fallback content.
function flatContentFirstChild(element: Element): Node | null {
	const shadow = element[kShadowRoot]!;
	if (shadow !== null) {
		return shadow[kFirstChild]!;
	}
	if (element instanceof HTMLSlotElement) {
		const assigned = element[kAssignedNodes]!;
		if (assigned.length > 0) {
			return assigned[0];
		}
	}
	return element[kFirstChild]!;
}

function flatLastChild(node: Node): Node | null {
	if (node.nodeType !== ELEMENT_NODE) {
		return node[kLastChild]!;
	}
	const element = node as Element;
	const after = getPseudoSlot(element, "::after");
	return after !== null ? after : flatLastContent(element);
}

// The last child an element renders, or the ::before or ::marker it
// renders instead when it has no content of its own. Different from
// flatLastChild, which returns the ::after when there is one.
function flatLastContent(element: Element): Node | null {
	const child = flatContentLastChild(element);
	if (child !== null) {
		return child;
	}
	// An element with no content of its own still renders its ::before and
	// ::marker, so the last of its content is whichever of those it has.
	const slots = element[kPseudoElements]!;
	if (slots !== null) {
		const before = slots.get("::before");
		if (before !== undefined) {
			return before;
		}
		const marker = slots.get("::marker");
		if (marker !== undefined) {
			return marker;
		}
	}
	return null;
}

// The mirror of flatContentFirstChild. A host with an empty shadow
// tree renders nothing of its own, light children included.
function flatContentLastChild(element: Element): Node | null {
	const shadow = element[kShadowRoot]!;
	if (shadow !== null) {
		return shadow[kLastChild]!;
	}
	if (element instanceof HTMLSlotElement) {
		const assigned = element[kAssignedNodes]!;
		if (assigned.length > 0) {
			return assigned[assigned.length - 1];
		}
	}
	return element[kLastChild]!;
}

function flatNextSibling(node: Node): Node | null {
	const host = (node as Element)[kPseudoHost]!;
	if (host !== null && host !== undefined) {
		const name = (node as Element)[kPseudoName]!;
		if (name === "::marker") {
			const before = getPseudoSlot(host, "::before");
			if (before !== null) {
				return before;
			}
		}
		if (name !== "::after") {
			const content = flatContentFirstChild(host);
			return content !== null ? content : getPseudoSlot(host, "::after");
		}
		return null;
	}

	// A projected node's flat-tree siblings are its neighbours in the slot's
	// assigned-node list, NOT its light-tree siblings. The light nextSibling
	// may be assigned to a different slot, or to none.
	const slot = getAssignedSlot(node);
	if (slot !== null) {
		const assigned = slot[kAssignedNodes]!;
		const index = assigned.indexOf(node as Slottable);
		if (index < 0) {
			return null;
		}
		// The last projected node is followed by the slot's ::after, exactly as
		// the last of any other element's content is.
		return index < assigned.length - 1
			? assigned[index + 1]
			: getPseudoSlot(slot, "::after");
	}

	const next = node[kNext]!;
	if (next !== null) {
		return next;
	}

	// The last of an element's content is followed by its ::after. This
	// uses the COMPOSED parent, so climbing out of a shadow root reaches the
	// host's ::after. A shadowed element's ::after follows its shadow
	// content, which the node tree cannot express because it puts the shadow
	// root between them.
	const parent = flatParentNode(node);
	if (parent !== null && parent.nodeType === ELEMENT_NODE) {
		return getPseudoSlot(parent as Element, "::after");
	}
	return null;
}

function flatPreviousSibling(node: Node): Node | null {
	const host = (node as Element)[kPseudoHost]!;
	if (host !== null && host !== undefined) {
		const name = (node as Element)[kPseudoName]!;
		if (name === "::after") {
			return flatLastContent(host);
		}
		if (name === "::before") {
			return getPseudoSlot(host, "::marker");
		}
		return null;
	}

	const slot = getAssignedSlot(node);
	if (slot !== null) {
		const assigned = slot[kAssignedNodes]!;
		const index = assigned.indexOf(node as Slottable);
		if (index > 0) {
			return assigned[index - 1];
		}
		if (index < 0) {
			return null;
		}
		// The first projected node is preceded by the slot's own ::before, as
		// the first of any other element's content is.
		const before = getPseudoSlot(slot, "::before");
		return before !== null ? before : getPseudoSlot(slot, "::marker");
	}

	const previous = node[kPrevious]!;
	if (previous !== null) {
		return previous;
	}

	// Mirror of the ::after hop. Uses the composed parent, so walking
	// backwards out of a shadow root reaches the host's ::before and
	// ::marker.
	const parent = flatParentNode(node);
	if (parent !== null && parent.nodeType === ELEMENT_NODE) {
		const before = getPseudoSlot(parent as Element, "::before");
		if (before !== null) {
			return before;
		}
		return getPseudoSlot(parent as Element, "::marker");
	}
	return null;
}

function flatParentNode(node: Node): Node | null {
	const host = (node as Element)[kPseudoHost]!;
	if (host !== null && host !== undefined) {
		return host;
	}
	const slot = getAssignedSlot(node);
	if (slot !== null) {
		return slot;
	}
	const parent = node[kParent]!;
	if (parent !== null && isShadowRoot(parent)) {
		return (parent as ShadowRoot)[kHost]!;
	}
	return parent;
}

const kRectValues = Symbol("rectangle origin and size");

// A negative width or height puts left to the right of right, so the
// edges take the minimum and maximum rather than assuming an order.
class DOMRectReadOnly {
	[kRectValues]?: {x: number; y: number; width: number; height: number};

	constructor(x = 0, y = 0, width = 0, height = 0) {
		this[kRectValues] = {
			x: Number(x) || 0,
			y: Number(y) || 0,
			width: Number(width) || 0,
			height: Number(height) || 0,
		};
	}

	get x(): number {
		return this[kRectValues]!.x;
	}

	get y(): number {
		return this[kRectValues]!.y;
	}

	get width(): number {
		return this[kRectValues]!.width;
	}

	get height(): number {
		return this[kRectValues]!.height;
	}

	get top(): number {
		const {y, height} = this[kRectValues]!;
		return Math.min(y, y + height);
	}

	get right(): number {
		const {x, width} = this[kRectValues]!;
		return Math.max(x, x + width);
	}

	get bottom(): number {
		const {y, height} = this[kRectValues]!;
		return Math.max(y, y + height);
	}

	get left(): number {
		const {x, width} = this[kRectValues]!;
		return Math.min(x, x + width);
	}

	static fromRect(other: DOMRectInit = {}): DOMRectReadOnly {
		return new DOMRectReadOnly(other.x, other.y, other.width, other.height);
	}

	toJSON(): DOMRectInit & {
		top: number;
		right: number;
		bottom: number;
		left: number;
	} {
		return {
			x: this.x,
			y: this.y,
			width: this.width,
			height: this.height,
			top: this.top,
			right: this.right,
			bottom: this.bottom,
			left: this.left,
		};
	}
}

Object.defineProperty(DOMRectReadOnly.prototype, Symbol.toStringTag, {
	value: "DOMRectReadOnly",
	configurable: true,
});

export class DOMRect extends DOMRectReadOnly {
	override get x(): number {
		return this[kRectValues]!.x;
	}

	override set x(value: number) {
		this[kRectValues]!.x = Number(value) || 0;
	}

	override get y(): number {
		return this[kRectValues]!.y;
	}

	override set y(value: number) {
		this[kRectValues]!.y = Number(value) || 0;
	}

	override get width(): number {
		return this[kRectValues]!.width;
	}

	override set width(value: number) {
		this[kRectValues]!.width = Number(value) || 0;
	}

	override get height(): number {
		return this[kRectValues]!.height;
	}

	override set height(value: number) {
		this[kRectValues]!.height = Number(value) || 0;
	}

	static override fromRect(other: DOMRectInit = {}): DOMRect {
		return new DOMRect(other.x, other.y, other.width, other.height);
	}
}

Object.defineProperty(DOMRect.prototype, Symbol.toStringTag, {
	value: "DOMRect",
	configurable: true,
});

export class DOMRectList extends Array<
	globalThis.DOMRect
> implements globalThis.DOMRectList {
	item(index: number): globalThis.DOMRect | null {
		if (index < 0 || index >= this.length) {
			return null;
		}
		return this[index];
	}
}

Object.defineProperty(DOMRectList.prototype, Symbol.toStringTag, {
	value: "DOMRectList",
	configurable: true,
});

// The content box's size, plus the offset of its top-left corner INSIDE
// the border box. Deliberately not a rect. `top` and `left` are
// distances from the border edge, not positions in the document, and
// calling it a DOMRect would invite exactly the arithmetic (comparing it
// against a border box, intersecting it with the viewport) that its
// coordinates cannot support. ResizeObserver reports these four numbers
// as contentRect, which is where the confusion comes from.
interface ContentBox {
	width: number;
	height: number;
	top: number;
	left: number;
}

// Symbol-keyed rather than named. These are subclass hooks and shared
// state, and author code must never see them on an observer it holds.
const kTargets = Symbol("targets");
const kHomes = Symbol("homes");
const kMeasure = Symbol("measure");
const kObserverCallback = Symbol("observer callback");

// Keyed by document, not by a registry object, because the document is
// what an observer can reach from the target it was given. That is why
// `new ResizeObserver(callback)` needs only its callback.
const documentObservers = new WeakMap<object, Set<AnyObserver>>();

/**
 * Run a document's observers against the layout just computed for it. The
 * frame the renderer is finishing is what an IntersectionObserver measures
 * against and what a ResizeObserver reports the time of.
 */
export function flushObservers(
	document: globalThis.Document,
	layout: Layout,
	viewport: globalThis.DOMRect,
	frame: number,
): void {
	const observers = documentObservers.get(document);
	if (observers === undefined || observers.size === 0) {
		return;
	}
	// Iterate a copy. A callback may observe or disconnect, and mutating the
	// set mid-iteration would visit a new observer against a layout it has
	// not been measured for, or skip one that is still live.
	for (const observer of [...observers]) {
		checkObserver(observer, layout, viewport, frame);
	}
}

/** A torn-down document delivers nothing. */
export function disconnectObservers(document: globalThis.Document): void {
	documentObservers.get(document)?.clear();
	engineObservers.get(document as Document)?.disconnect();
}

// The part shared by both observer kinds: which elements are watched,
// what was last reported for each, and registration with the manager.
// Subclasses supply only how to measure one target (kMeasure) and how to
// build an entry from that measurement.
abstract class LayoutObserver<TState, TEntry, TOptions = void> {
	// One entry per target, as the DOM says. A second observe() of the same
	// target replaces the first's options.
	[kTargets]: Map<
		globalThis.Element,
		{options: TOptions | undefined; last: TState | null}
	>;

	// One entry per document the observer has a target in.
	[kHomes]: Set<object>;

	declare [kObserverCallback]: (entries: TEntry[], observer: this) => void;

	constructor() {
		this[kTargets] = new Map<
			globalThis.Element,
			{options: TOptions | undefined; last: TState | null}
		>();
		this[kHomes] = new Set<object>();
	}

	observe(target: globalThis.Element, options?: TOptions): void {
		// A fresh target has no last state, so its first measurement always
		// counts as a change. That fires the initial callback the DOM promises.
		this[kTargets].set(target, {
			options,
			last: this[kTargets].get(target)?.last ?? null,
		});
		const document = target.ownerDocument;
		if (document === null) {
			return;
		}
		getObservers(document).add(this as unknown as AnyObserver);
		this[kHomes].add(document);
	}

	unobserve(target: globalThis.Element): void {
		this[kTargets].delete(target);
		if (this[kTargets].size === 0) {
			this.disconnect();
		}
	}

	disconnect(): void {
		this[kTargets].clear();
		for (const document of this[kHomes]) {
			documentObservers.get(document)?.delete(this as unknown as AnyObserver);
		}
		this[kHomes].clear();
	}

	// Records are computed and delivered in the same pass (see the
	// manager's flush), so nothing is ever queued undelivered and this is
	// always empty. It exists because the DOM has it and code checks for it.
	takeRecords(): TEntry[] {
		return [];
	}

	abstract [kMeasure](
		target: globalThis.Element,
		last: TState | null,
		layout: Layout,
		viewport: globalThis.DOMRect,
		frame: number,
		options: TOptions | undefined,
	): {state: TState; entry: TEntry} | null;
}

function getObservers(document: globalThis.Document): Set<AnyObserver> {
	let observers = documentObservers.get(document);
	if (observers === undefined) {
		observers = new Set<AnyObserver>();
		documentObservers.set(document, observers);
	}
	return observers;
}

function checkObserver<TState, TEntry, TOptions = void>(
	observer: LayoutObserver<TState, TEntry, TOptions>,
	layout: Layout,
	viewport: globalThis.DOMRect,
	frame: number,
): void {
	const entries: TEntry[] = [];
	for (const [target, observation] of observer[kTargets]) {
		const result = observer[kMeasure](
			target,
			observation.last,
			layout,
			viewport,
			frame,
			observation.options,
		);
		if (!result) {
			continue;
		}
		observation.last = result.state;
		entries.push(result.entry);
	}
	if (entries.length > 0) {
		observer[kObserverCallback](entries, observer);
	}
}

type AnyObserver = LayoutObserver<unknown, unknown, unknown>;

interface ResizeObserverSize {
	inlineSize: number;
	blockSize: number;
}

interface ResizeObserverEntry {
	target: globalThis.Element;
	contentRect: globalThis.DOMRect;
	borderBoxSize: readonly ResizeObserverSize[];
	getContentBoxSize: readonly ResizeObserverSize[];
	devicePixelContentBoxSize: readonly ResizeObserverSize[];
}

type ResizeObserverCallback = (
	entries: ResizeObserverEntry[],
	observer: ResizeObserver,
) => void;

interface ResizeSize {
	width: number;
	height: number;
}

const RESIZE_BOXES = new Set([
	"border-box",
	"content-box",
	"device-pixel-content-box",
]);

interface ResizeObserverOptions {
	box?: string;
}

class ResizeObserver extends LayoutObserver<
	ResizeSize,
	ResizeObserverEntry,
	ResizeObserverOptions
> {
	constructor(callback: ResizeObserverCallback) {
		super();
		this[kObserverCallback] = callback;
	}

	// `box` names which box's size change is worth reporting. Every entry
	// still carries all of them, as the DOM says. An unrecognized value is
	// rejected by the enumeration, as WebIDL requires, rather than quietly
	// ignored.
	override observe(
		target: globalThis.Element,
		options?: ResizeObserverOptions,
	): void {
		const box = options?.box;
		if (box !== undefined && !RESIZE_BOXES.has(box)) {
			throw new TypeError(
				`Failed to execute 'observe' on 'ResizeObserver': The provided value '${box}' is not a valid enum value of type ResizeObserverBoxOptions.`,
			);
		}
		super.observe(target, options);
	}

	[kMeasure](
		target: globalThis.Element,
		last: ResizeSize | null,
		layout: Layout,
		_viewport: globalThis.DOMRect,
		_frame: number,
		options: ResizeObserverOptions | undefined,
	): {state: ResizeSize; entry: ResizeObserverEntry} | null {
		// An element with no box (display:none, or detached) has a size, and
		// that size is zero. Reporting it is how the DOM lets a component
		// notice it has been hidden. Skipping it left the last size it ever had
		// stuck.
		const content = getContentBox(target, layout) ?? {
			width: 0,
			height: 0,
			top: 0,
			left: 0,
		};

		const border = layout.getRect(target);
		// device-pixel-content-box is the content box. A cell is the device
		// pixel here, so the two can never differ.
		const watched =
			options?.box === "border-box"
				? {
					width: border?.width ?? content.width,
					height: border?.height ?? content.height,
				}
				: {width: content.width, height: content.height};

		if (
			last && last.width === watched.width && last.height === watched.height
		) {
			return null;
		}

		const box: ResizeObserverSize = {
			inlineSize: content.width,
			blockSize: content.height,
		};
		return {
			state: watched,
			entry: {
				target,
				// The origin is the content box's offset inside the border box
				// (the padding and border before it), not zero.
				contentRect: new DOMRect(
					content.left,
					content.top,
					content.width,
					content.height,
				),
				getContentBoxSize: [box],
				borderBoxSize: [
					{
						inlineSize: border?.width ?? content.width,
						blockSize: border?.height ?? content.height,
					},
				],
				// A cell is the device pixel here, so these coincide.
				devicePixelContentBoxSize: [box],
			},
		};
	}
}

// Returns null when the element generates no box at all (display:none
// or detached). The observer turns that into an all-zero rect.
function getContentBox(
	element: globalThis.Element,
	layout: Layout,
): ContentBox | null {
	const border = layout.getRect(element);
	const content = layout.contentRect(element);
	if (!border || !content) {
		return null;
	}
	// Origin relative to the border box: what precedes the content on each
	// axis.
	return {
		width: content.width,
		height: content.height,
		top: content.y - border.y,
		left: content.x - border.x,
	};
}

interface IntersectionObserverInit {
	root?: globalThis.Element | null;
	rootMargin?: string;
	threshold?: number | number[];
}

interface IntersectionObserverEntry {
	target: globalThis.Element;
	isIntersecting: boolean;
	getIntersectionRatio: number;
	boundingClientRect: globalThis.DOMRect;
	intersectionRect: globalThis.DOMRect;
	rootBounds: globalThis.DOMRect | null;
	time: number;
}

type IntersectionObserverCallback = (
	entries: IntersectionObserverEntry[],
	observer: IntersectionObserver,
) => void;

const kIntersectionRoot = Symbol("intersection root");

class IntersectionObserver extends LayoutObserver<
	number,
	IntersectionObserverEntry
> {
	readonly rootMargin: string;
	readonly thresholds: readonly number[];
	declare [kIntersectionRoot]?: globalThis.Element | null;

	constructor(
		callback: IntersectionObserverCallback,
		init: IntersectionObserverInit = {},
	) {
		super();
		this[kObserverCallback] = callback;
		this[kIntersectionRoot] = init.root ?? null;
		this.rootMargin = init.rootMargin ?? "0px";

		// A single number, an array, or the default of "any intersection at
		// all".
		const t = init.threshold ?? 0;
		this.thresholds = Object.freeze(
			(Array.isArray(t) ? [...t] : [t]).sort((a, b) => a - b),
		);
	}

	get root(): globalThis.Element | null {
		return this[kIntersectionRoot]!;
	}

	[kMeasure](
		target: globalThis.Element,
		last: number | null,
		layout: Layout,
		viewport: globalThis.DOMRect,
		frame: number,
	): {state: number; entry: IntersectionObserverEntry} | null {
		const box = layout.getRect(target);
		if (!box) {
			return null;
		}

		// The root is an explicit element's border box or the viewport. Either
		// way it is grown by rootMargin, which is the point of that option: it
		// lets a list start loading a row before it scrolls into view.
		const rootBox =
			this[kIntersectionRoot]!
				? layout.getRect(this[kIntersectionRoot]!)
				: viewport;
		if (!rootBox) {
			return null;
		}
		const rootBounds = applyRootMargin(rootBox, this.rootMargin);

		const {ratio, rect} = getIntersectionRatio(box, rootBounds);
		const index = getThresholdIndex(this, ratio);
		if (last === index) {
			return null;
		}

		return {
			state: index,
			entry: {
				target,
				isIntersecting: index > 0,
				getIntersectionRatio: ratio,
				boundingClientRect: box,
				intersectionRect:
					index > 0 ? rect : new DOMRect(0, 0, 0, 0),
				rootBounds,
				time: frame,
			},
		};
	}
}

// From 0 (disjoint) to 1 (contained).
function getIntersectionRatio(
	box: globalThis.DOMRect,
	clip: globalThis.DOMRect,
): {ratio: number; rect: globalThis.DOMRect} {
	const left = Math.max(box.left, clip.left);
	const top = Math.max(box.top, clip.top);
	const right = Math.min(box.left + box.width, clip.left + clip.width);
	const bottom = Math.min(box.top + box.height, clip.top + clip.height);

	const width = Math.max(0, right - left);
	const height = Math.max(0, bottom - top);
	const area = box.width * box.height;

	return {
		ratio: area > 0 ? (width * height) / area : width > 0 && height > 0 ? 1 : 0,
		rect: new DOMRect(left, top, width, height),
	};
}

// The root-margin rules: one to four lengths, in the order top, right,
// bottom, left. Lengths are cells whatever unit is written (a row
// vertically, a column horizontally), so `px` and `ch` mean the same
// thing here, as everywhere in the box model. Percentages are resolved
// against the root's own size, as the spec requires.
function applyRootMargin(
	rect: globalThis.DOMRect,
	margin: string,
): globalThis.DOMRect {
	const parts = margin.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return rect;
	}

	const resolve = (value: string, basis: number): number => {
		const match = /^(-?[\d.]+)(px|ch|%)?$/.exec(value);
		if (!match) {
			return 0;
		}
		const n = parseFloat(match[1]);
		if (!Number.isFinite(n)) {
			return 0;
		}
		return match[2] === "%" ? (n / 100) * basis : n;
	};

	const [t, r = t, b = t, l = r] = parts;
	const top = resolve(t, rect.height);
	const right = resolve(r, rect.width);
	const bottom = resolve(b, rect.height);
	const left = resolve(l, rect.width);

	return new DOMRect(
		rect.left - left,
		rect.top - top,
		Math.max(0, rect.width + left + right),
		Math.max(0, rect.height + top + bottom),
	);
}

// This is what the spec actually watches. An observation fires when
// this CHANGES, so a target scrolling through `[0, 0.5, 1]` reports at
// each step. Tracking only the boolean "is it intersecting" collapsed
// all of those into one callback and made threshold arrays decorative.
function getThresholdIndex(
	observer: IntersectionObserver,
	ratio: number,
): number {
	let index = 0;
	while (
		index < observer.thresholds.length && ratio >= observer.thresholds[index]
	) {
		// A zero threshold means "any overlap at all", so a ratio of exactly
		// zero has not reached it.
		if (observer.thresholds[index] === 0 && ratio === 0) {
			break;
		}
		index++;
	}
	return index;
}

let currentDocumentForConstruction: Document | null = null;
let ambientDocument: Document | null = null;

// A window here is not the global object, so there is no "current
// global object" to consult. A bare `new Text()` belongs to whichever
// document was last attached to a window, or to one created here if
// none has been.
function getCurrentDocument(): Document {
	if (currentDocumentForConstruction !== null) {
		return currentDocumentForConstruction;
	}
	if (ambientDocument === null) {
		const document = new Document();
		ambientDocument = document;
		fillHTMLDocument(document, "");
	}
	return ambientDocument;
}

function isHTMLDocument(document: Document): boolean {
	return document[kType] === "html";
}

const kImplementation = Symbol("implementation");
const kSelection = Symbol("the document's selection");
const kSelectionChangeScheduled = Symbol("has scheduled selectionchange event");
const kContentType = Symbol("content type");
const kEncoding = Symbol("encoding");
const kIdMap = Symbol("id map");

export class Document extends Node implements globalThis.Document {
	// Installed on the prototype, where the engine that implements them is.
	declare elementFromPoint: (
		x: number,
		y: number,
	) => globalThis.Element | null;

	declare elementsFromPoint: (x: number, y: number) => globalThis.Element[];

	[kDocumentURL]?: string;
	[kMode]?: "no-quirks" | "quirks" | "limited-quirks";
	[kType]?: "xml" | "html";
	[kContentType]?: string;
	[kEncoding]?: string;
	[kIdMap]?: Map<string, Element[]>;
	[kDocumentWideLists]?: Set<LiveCollection> | null;

	[kSelection]?: Selection | null;
	[kSelectionChangeScheduled]?: boolean;
	[kTemplateDocument]?: Document | null;
	[kActiveElement]?: Element | null;
	[kDefaultView]?: object | null;
	[kStyleElements]?: number;
	[kChildren]?: HTMLCollection | null;
	[kTopLayer]?: Set<Element>;
	// The reentrancy guards the popover algorithms keep on the document:
	// one popover opening at a time, and a count of the ones closing under
	// it.
	[kPopoverShowing]?: boolean;
	[kPopoverHidingCount]?: number;

	// What an attached document renders through, set by attachDocument. A
	// headless document has none and behaves as a document with no browsing
	// context.
	[kTermDOM]?: TermDOM;
	[kLayout]?: Layout;
	[kCascade]?: Cascade;
	[kExchange]?: Exchange;
	[kScreen]?: Screen;

	declare [kImplementation]?: DOMImplementation | null;

	constructor(...args: ConstructorParameters<typeof Node>) {
		super(...args);
		this[kConnected] = true;
		this[kDocumentURL] = "about:blank";
		this[kMode] = "no-quirks";
		this[kType] = "xml";
		this[kContentType] = "application/xml";
		this[kEncoding] = "UTF-8";
		this[kIdMap] = new Map<string, Element[]>();
		this[kSelection] = null;
		this[kSelectionChangeScheduled] = false;
		this[kTemplateDocument] = null;
		this[kActiveElement] = null;
		this[kDefaultView] = null;
		this[kStyleElements] = 0;
		this[kChildren] = null;
		this[kTopLayer] = new Set<Element>();
		this[kPopoverShowing] = false;
		this[kPopoverHidingCount] = 0;
		this[kImplementation] = null;
		this[kDocumentWideLists] = null;
	}

	override get nodeType(): number {
		return DOCUMENT_NODE;
	}

	override get nodeName(): string {
		return "#document";
	}

	get URL(): string {
		return this[kDocumentURL]!;
	}

	get documentURI(): string {
		return this[kDocumentURL]!;
	}

	get compatMode(): string {
		return this[kMode] === "quirks" ? "BackCompat" : "CSS1Compat";
	}

	get characterSet(): string {
		return this[kEncoding]!;
	}

	get charset(): string {
		return this[kEncoding]!;
	}

	get inputEncoding(): string {
		return this[kEncoding]!;
	}

	get contentType(): string {
		return this[kContentType]!;
	}

	get implementation(): globalThis.DOMImplementation {
		let implementation = this[kImplementation]!;
		if (implementation === null) {
			implementation = new DOMImplementation(this);
			this[kImplementation] = implementation;
		}
		return implementation as unknown as globalThis.DOMImplementation;
	}

	get doctype(): globalThis.DocumentType | null {
		for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType === DOCUMENT_TYPE_NODE) {
				return node as unknown as globalThis.DocumentType;
			}
		}
		return null;
	}

	// Null until a Window is built over the document. A headless document
	// behaves as the standards say a document with no browsing context
	// does. lib.dom intersects Window with typeof globalThis because
	// in a browser the window IS the global. Here it is not, so a caller who
	// reaches through this for a browser-only global finds nothing.
	get defaultView(): (globalThis.Window & typeof globalThis) | null {
		return this[kDefaultView]! as
			(globalThis.Window & typeof globalThis) |
			null;
	}

	// The body whenever nothing else has focus. An element that leaves the
	// tree loses focus, and focus returns to the body.
	get activeElement(): globalThis.Element | null {
		const active = this[kActiveElement]!;
		if (active === null || !active.isConnected) {
			this[kActiveElement] = null;
			return this.body;
		}
		// RETARGET to this scope, per HTML. Focus inside a shadow tree reads as
		// the host from the document. The shadow tree's own root returns the
		// real element through ShadowRoot.activeElement.
		let current: Node = active;
		for (;;) {
			const root = getRoot(current);
			if (root === (this as Node)) {
				return current as unknown as globalThis.Element;
			}
			if (root instanceof ShadowRoot && root.host !== null) {
				current = root.host as unknown as Node;
				continue;
			}
			this[kActiveElement] = null;
			return this.body;
		}
	}

	get fullscreenElement(): globalThis.Element | null {
		return getFullscreenElement(this);
	}

	get customElementRegistry(): CustomElementRegistry | null {
		return this[kRegistry]!;
	}

	// A document with no browsing context has no location, but lib.dom
	// types this non-null, so an unmounted document returns null under a
	// type that says otherwise.
	get location(): globalThis.Location {
		const view = this[kDefaultView]! as Window | null;
		return (view === null
			? null
			: view.location) as unknown as globalThis.Location;
	}

	// head, body and title come from the HTML Standard, not the DOM
	// Standard. They are here because a document with no way to name its
	// body cannot be used by any DOM test.
	get head(): globalThis.HTMLHeadElement {
		const root = this.documentElement as unknown as Element | null;
		if (root === null) {
			return null as unknown as globalThis.HTMLHeadElement;
		}
		for (let node = root[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				(node as Element)[kLocalName] === "head"
			) {
				return node as unknown as globalThis.HTMLHeadElement;
			}
		}
		return null as unknown as globalThis.HTMLHeadElement;
	}

	get body(): globalThis.HTMLElement {
		const root = this.documentElement as unknown as Element | null;
		if (root === null) {
			return null as unknown as globalThis.HTMLElement;
		}
		for (let node = root[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				((node as Element)[kLocalName] === "body" ||
					(node as Element)[kLocalName] === "frameset")
			) {
				return node as unknown as globalThis.HTMLElement;
			}
		}
		return null as unknown as globalThis.HTMLElement;
	}

	set body(value: globalThis.HTMLElement) {
		if (
			(value as unknown as Element | null) == null ||
			value.nodeType !== ELEMENT_NODE ||
			(value as unknown as Element)[kNamespace] !== HTML_NAMESPACE ||
			((value as unknown as Element)[kLocalName] !== "body" &&
				(value as unknown as Element)[kLocalName] !== "frameset")
		) {
			throw hierarchyRequestError("That element cannot be a document body");
		}
		const existing = this.body as unknown as Element | null;
		if (existing === (value as unknown as Element)) {
			return;
		}
		const root = this.documentElement as unknown as Element | null;
		if (root === null) {
			throw hierarchyRequestError("There is no document element");
		}
		if (existing !== null) {
			replaceChild(existing, value as unknown as Element, root);
		} else {
			appendNode(value as unknown as Element, root);
		}
	}

	get title(): string {
		const root = this.documentElement as unknown as Element | null;
		let element: Element | null = null;
		if (
			root !== null &&
			root[kNamespace] === SVG_NAMESPACE &&
			root[kLocalName] === "svg"
		) {
			for (const node of descendants(root)) {
				if (
					node.nodeType === ELEMENT_NODE &&
					(node as Element)[kNamespace] === SVG_NAMESPACE &&
					(node as Element)[kLocalName] === "title"
				) {
					element = node as Element;
					break;
				}
			}
		} else {
			for (const node of descendants(this)) {
				if (
					node.nodeType === ELEMENT_NODE &&
					(node as Element)[kNamespace] === HTML_NAMESPACE &&
					(node as Element)[kLocalName] === "title"
				) {
					element = node as Element;
					break;
				}
			}
		}
		if (element === null) {
			return "";
		}
		return stripAndCollapseWhitespace(getDescendantText(element));
	}

	set title(value: string) {
		const root = this.documentElement;
		if (root === null) {
			return;
		}
		let element: Element | null = null;
		for (const node of descendants(this)) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				(node as Element)[kLocalName] === "title"
			) {
				element = node as Element;
				break;
			}
		}
		if (element === null) {
			const head = this.head as unknown as Element | null;
			if (head === null) {
				return;
			}
			element = createElementInternal(this, "title", HTML_NAMESPACE);
			appendNode(element, head);
		}
		setDescendantText(element, String(value));
		// The terminal's window title is the document's, set in-band. This
		// happens only while the terminal is attached and taking input.
		const attached = getAttachedDocument(this);
		if (
			attached !== undefined &&
			isAttached(attached[kTermDOM]) &&
			attached[kExchange].interactive
		) {
			void attached[kExchange].setTitle(String(value));
		}
	}

	get documentElement(): globalThis.HTMLElement {
		for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType === ELEMENT_NODE) {
				return node as unknown as globalThis.HTMLElement;
			}
		}
		return null as unknown as globalThis.HTMLElement;
	}

	// The legacy HTML document surface. Most of it is implemented rather
	// than stubbed. The collections are live and filtered the way the spec
	// filters them, and the colour attributes reflect the body's, as
	// specified.

	get anchors(): HTMLCollectionOf<globalThis.HTMLAnchorElement> {
		return getDocumentCollection(this,
			(e) => e instanceof HTMLAnchorElement && e.hasAttribute("name"),
		) as unknown as HTMLCollectionOf<globalThis.HTMLAnchorElement>;
	}

	get forms(): HTMLCollectionOf<globalThis.HTMLFormElement> {
		return getDocumentCollection(
			this,
			(e) => e instanceof HTMLFormElement,
		) as unknown as HTMLCollectionOf<globalThis.HTMLFormElement>;
	}

	get images(): HTMLCollectionOf<globalThis.HTMLImageElement> {
		return getDocumentCollection(
			this,
			(e) => e instanceof HTMLImageElement,
		) as unknown as HTMLCollectionOf<globalThis.HTMLImageElement>;
	}

	get scripts(): HTMLCollectionOf<globalThis.HTMLScriptElement> {
		return getDocumentCollection(
			this,
			(e) => e instanceof HTMLScriptElement,
		) as unknown as HTMLCollectionOf<globalThis.HTMLScriptElement>;
	}

	get embeds(): HTMLCollectionOf<globalThis.HTMLEmbedElement> {
		return getDocumentCollection(
			this,
			(e) => e instanceof HTMLEmbedElement,
		) as unknown as HTMLCollectionOf<globalThis.HTMLEmbedElement>;
	}

	/** An alias of embeds, per spec. */
	get plugins(): HTMLCollectionOf<globalThis.HTMLEmbedElement> {
		return this.embeds;
	}

	get links(): HTMLCollectionOf<
		globalThis.HTMLAnchorElement | globalThis.HTMLAreaElement
	> {
		return getDocumentCollection(this,
			(e) =>
				(e instanceof HTMLAnchorElement || e instanceof HTMLAreaElement) &&
				e.hasAttribute("href"),
		) as unknown as HTMLCollectionOf<
			globalThis.HTMLAnchorElement | globalThis.HTMLAreaElement
		>;
	}

	/** Always empty. The applet element was removed from HTML. */
	get applets(): HTMLCollectionOf<globalThis.Element> {
		return getDocumentCollection(
			this,
			() => false,
		) as unknown as HTMLCollectionOf<
			globalThis.Element
		>;
	}

	// The presentational attributes of body, which these reflect by
	// definition. A document with no body reads them as the empty string and
	// drops writes, which is what reflecting nothing does.

	get bgColor(): string {
		return this.body?.getAttribute("bgcolor") ?? "";
	}

	set bgColor(value: string) {
		this.body?.setAttribute("bgcolor", value);
	}

	get fgColor(): string {
		return this.body?.getAttribute("text") ?? "";
	}

	set fgColor(value: string) {
		this.body?.setAttribute("text", value);
	}

	get alinkColor(): string {
		return this.body?.getAttribute("alink") ?? "";
	}

	set alinkColor(value: string) {
		this.body?.setAttribute("alink", value);
	}

	get linkColor(): string {
		return this.body?.getAttribute("link") ?? "";
	}

	set linkColor(value: string) {
		this.body?.setAttribute("link", value);
	}

	get vlinkColor(): string {
		return this.body?.getAttribute("vlink") ?? "";
	}

	set vlinkColor(value: string) {
		this.body?.setAttribute("vlink", value);
	}

	/** A terminal shows what it renders, immediately. */
	get hidden(): boolean {
		return false;
	}

	get visibilityState(): globalThis.DocumentVisibilityState {
		return "visible";
	}

	get fullscreen(): boolean {
		return this.fullscreenElement !== null;
	}

	get fullscreenEnabled(): boolean {
		return true;
	}

	get pictureInPictureEnabled(): boolean {
		return false;
	}

	/** SVG's root element, which an HTML document does not have. */
	get rootElement(): globalThis.SVGSVGElement | null {
		return null;
	}

	// The rest of lib.dom's Document. What a terminal document can
	// implement, it implements. The rest throws, so a caller reaching for an
	// API this engine lacks finds out at the call rather than from a
	// plausible-looking value.

	get dir(): string {
		return this.documentElement?.getAttribute("dir") ?? "";
	}

	set dir(value: string) {
		this.documentElement?.setAttribute("dir", value);
	}

	/** Nothing fetched this document, so nothing referred to it. */
	get referrer(): string {
		return "";
	}

	/** Not fetched over HTTP, so there is no origin. */
	get domain(): string {
		return "";
	}

	set domain(_value: string) {}

	/** A terminal has no cookie jar. */
	get cookie(): string {
		return "";
	}

	set cookie(_value: string) {}

	get lastModified(): string {
		return new Date(0).toUTCString();
	}

	get readyState(): globalThis.DocumentReadyState {
		return "complete";
	}

	/** Nothing here is editable through execCommand. */
	get designMode(): string {
		return "off";
	}

	set designMode(_value: string) {}

	/** Script does not run while this document is built. */
	get currentScript(): globalThis.HTMLOrSVGScriptElement | null {
		return null;
	}

	// CSSOM View §7. Outside quirks mode the root element always scrolls
	// the viewport. In quirks mode the body scrolls instead, unless the body
	// is itself potentially scrollable, in which case nothing does, because
	// the scrolling the caller means happens inside the body rather than to
	// it.
	get scrollingElement(): globalThis.Element | null {
		if (this[kMode] !== "quirks") {
			return this.documentElement;
		}
		const body = this.body as unknown as Element | null;
		if (body === null || isPotentiallyScrollable(body)) {
			return null;
		}
		return body as unknown as globalThis.Element;
	}

	get pictureInPictureElement(): globalThis.Element | null {
		return null;
	}

	get pointerLockElement(): globalThis.Element | null {
		return null;
	}

	get fonts(): globalThis.FontFaceSet {
		throw domError(
			"NotSupportedError",
			"The font loading API is not implemented",
		);
	}

	get timeline(): globalThis.DocumentTimeline {
		throw domError("NotSupportedError", "Web Animations is not implemented");
	}

	get fragmentDirective(): globalThis.FragmentDirective {
		throw domError(
			"NotSupportedError",
			"Fragment directives are not implemented",
		);
	}

	get styleSheets(): globalThis.StyleSheetList {
		return getStyleSheets(this);
	}

	get adoptedStyleSheets(): globalThis.CSSStyleSheet[] {
		return getAdoptedStyleSheets(this);
	}

	set adoptedStyleSheets(value: globalThis.CSSStyleSheet[]) {
		adoptStyleSheets(this, value);
	}

	/** Parses declarative shadow roots too. */
	static parseHTMLUnsafe(html: string): Document {
		return parseHTMLDocument(String(html), "about:blank", true, null);
	}

	/** The window always has the system focus. */
	hasFocus(): boolean {
		return true;
	}

	exitFullscreen(): Promise<void> {
		const attached = getAttachedDocument(this);
		if (attached === undefined) {
			return Promise.reject(
				new TypeError("The document is not attached"),
			);
		}
		const exiting = leaveFullscreen(this);
		if (exiting) {
			attached[kCascade].handleFocusChange(exiting);
			attached[kLayout].invalidate(exiting);
		}
		return frameSettled(this, attached);
	}

	// There is no document.open() here, so there is never a parse to flush.
	// An attached document finalizes when it closes: what it painted is
	// sealed into the terminal's scrollback, and a later mutation starts a
	// fresh document below the sealed block.
	close(): void {
		const attached = getAttachedDocument(this);
		if (attached !== undefined) {
			sealTermDOM(attached[kTermDOM]);
		}
	}

	getElementsByTagName<K extends keyof globalThis.HTMLElementTagNameMap>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.HTMLElementTagNameMap[K]>;
	getElementsByTagName<K extends keyof globalThis.SVGElementTagNameMap>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.SVGElementTagNameMap[K]>;
	getElementsByTagName<K extends keyof globalThis.MathMLElementTagNameMap>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.MathMLElementTagNameMap[K]>;
	getElementsByTagName<
		K extends keyof globalThis.HTMLElementDeprecatedTagNameMap,
	>(
		getQualifiedName: K,
	): HTMLCollectionOf<globalThis.HTMLElementDeprecatedTagNameMap[K]>;
	getElementsByTagName(
		getQualifiedName: string,
	): HTMLCollectionOf<globalThis.Element>;
	getElementsByTagName(
		getQualifiedName: string,
	): HTMLCollectionOf<globalThis.Element> {
		return createTagNameCollection(
			this,
			String(getQualifiedName),
		) as unknown as HTMLCollectionOf<globalThis.Element>;
	}

	getElementsByTagNameNS(
		namespaceURI: "http://www.w3.org/1999/xhtml",
		localName: string,
	): HTMLCollectionOf<globalThis.HTMLElement>;
	getElementsByTagNameNS(
		namespaceURI: "http://www.w3.org/2000/svg",
		localName: string,
	): HTMLCollectionOf<globalThis.SVGElement>;
	getElementsByTagNameNS(
		namespaceURI: "http://www.w3.org/1998/Math/MathML",
		localName: string,
	): HTMLCollectionOf<globalThis.MathMLElement>;
	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollectionOf<globalThis.Element>;
	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollectionOf<globalThis.Element> {
		return createTagNameNSCollection(
			this,
			namespace,
			String(localName),
		) as unknown as HTMLCollectionOf<globalThis.Element>;
	}

	getElementsByClassName(
		classNames: string,
	): HTMLCollectionOf<globalThis.Element> {
		return createClassNameCollection(
			this,
			String(classNames),
		) as unknown as HTMLCollectionOf<globalThis.Element>;
	}

	getElementsByName(
		elementName: string,
	): globalThis.NodeListOf<globalThis.HTMLElement> {
		const name = String(elementName);
		return new NodeList(
			() => {
				// Walks the tree instead of reading the all-elements
				// collection. A list built on another live list would see that
				// list's stale contents, because the two are resynchronized in
				// the order they were first read.
				const matches: Node[] = [];
				const visit = (node: Node): void => {
					for (
						let child = node[kFirstChild]!;
						child !== null;
						child = child[kNext]!
					) {
						if (child.nodeType !== ELEMENT_NODE) {
							continue;
						}
						const element = child as Element;
						if (
							element.namespaceURI === HTML_NAMESPACE &&
							element.getAttribute("name") === name
						) {
							matches.push(child);
						}
						visit(child);
					}
				};
				visit(this as unknown as Node);
				return matches;
			},
			true,
			this,
			null,
			"name",
		) as unknown as globalThis.NodeListOf<globalThis.HTMLElement>;
	}

	getElementById(elementId: string): globalThis.HTMLElement | null {
		const id = String(elementId);
		const entries = this[kIdMap]!.get(id);
		if (entries === undefined || entries.length === 0) {
			return null;
		}
		if (entries.length === 1) {
			return entries[0] as unknown as globalThis.HTMLElement;
		}
		let first = entries[0];
		for (let index = 1; index < entries.length; index++) {
			if (isPrecedingInTree(entries[index], first)) {
				first = entries[index];
			}
		}
		return first as unknown as globalThis.HTMLElement;
	}

	createElement<K extends keyof globalThis.HTMLElementTagNameMap>(
		tagName: K,
		options?: globalThis.ElementCreationOptions,
	): globalThis.HTMLElementTagNameMap[K];
	createElement<K extends keyof globalThis.HTMLElementDeprecatedTagNameMap>(
		tagName: K,
		options?: globalThis.ElementCreationOptions,
	): globalThis.HTMLElementDeprecatedTagNameMap[K];
	createElement(
		tagName: string,
		options?: globalThis.ElementCreationOptions,
	): globalThis.HTMLElement;
	createElement(
		localName: string,
		options?: {is?: string; customElementRegistry?: unknown} | string,
	): globalThis.HTMLElement {
		if (arguments.length < 1) {
			throw new TypeError("createElement needs a name");
		}
		let name = String(localName);
		validateElementLocalName(name);
		if (isHTMLDocument(this)) {
			name = toASCIILowercase(name);
		}
		const is = extractIs(options);
		const namespace =
			isHTMLDocument(this) || this[kContentType] === "application/xhtml+xml"
				? HTML_NAMESPACE
				: null;
		return createElementInternal(
			this,
			name,
			namespace,
			null,
			is,
			true,
			extractRegistry(options),
		) as unknown as globalThis.HTMLElement;
	}

	createElementNS(
		namespaceURI: "http://www.w3.org/1999/xhtml",
		getQualifiedName: string,
	): globalThis.HTMLElement;
	createElementNS(
		namespaceURI: "http://www.w3.org/2000/svg",
		getQualifiedName: string,
	): globalThis.SVGElement;
	createElementNS(
		namespaceURI: "http://www.w3.org/1998/Math/MathML",
		getQualifiedName: string,
	): globalThis.MathMLElement;
	createElementNS(
		namespaceURI: string | null,
		getQualifiedName: string,
		options?: globalThis.ElementCreationOptions,
	): globalThis.Element;
	createElementNS(
		namespace: string | null,
		getQualifiedName: string,
		options?: string | globalThis.ElementCreationOptions,
	): globalThis.Element;
	createElementNS(
		namespace: string | null,
		getQualifiedName: string,
		options?: {is?: string; customElementRegistry?: unknown} | string,
	): globalThis.Element {
		if (arguments.length < 2) {
			throw new TypeError("createElementNS needs a namespace and a name");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(getQualifiedName),
			false,
		);
		return createElementInternal(
			this,
			extracted.localName,
			extracted.namespace,
			extracted.prefix,
			extractIs(options),
			true,
			extractRegistry(options),
		) as unknown as globalThis.Element;
	}

	createDocumentFragment(): globalThis.DocumentFragment {
		const fragment = new DocumentFragment();
		fragment[kDocument] = this;
		return fragment as unknown as globalThis.DocumentFragment;
	}

	createTextNode(data: string): globalThis.Text {
		if (arguments.length < 1) {
			throw new TypeError("createTextNode needs data");
		}
		const text = new Text(String(data));
		text[kDocument] = this;
		return text as unknown as globalThis.Text;
	}

	createCDATASection(data: string): globalThis.CDATASection {
		if (isHTMLDocument(this)) {
			throw domError(
				"NotSupportedError",
				"An HTML document has no CDATA sections",
			);
		}
		const string = String(data);
		if (string.includes("]]>")) {
			throw domError(
				"InvalidCharacterError",
				"A CDATA section cannot contain ]]>",
			);
		}
		const section = new CDATASection(string);
		section[kDocument] = this;
		return section as unknown as globalThis.CDATASection;
	}

	createComment(data: string): globalThis.Comment {
		if (arguments.length < 1) {
			throw new TypeError("createComment needs data");
		}
		const comment = new Comment(String(data));
		comment[kDocument] = this;
		return comment as unknown as globalThis.Comment;
	}

	createProcessingInstruction(
		target: string,
		data: string,
	): globalThis.ProcessingInstruction {
		if (arguments.length < 2) {
			throw new TypeError(
				"createProcessingInstruction needs a target and data",
			);
		}
		const name = String(target);
		validateXMLName(name);
		const string = String(data);
		if (string.includes("?>")) {
			throw domError(
				"InvalidCharacterError",
				"A processing instruction cannot contain ?>",
			);
		}
		const instruction = new ProcessingInstruction(name, string);
		instruction[kDocument] = this;
		return instruction as unknown as globalThis.ProcessingInstruction;
	}

	importNode<T extends globalThis.Node>(node: T, deep = false): T {
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be imported");
		}
		if (isShadowRoot(node)) {
			throw domError("NotSupportedError", "A shadow root cannot be imported");
		}
		return cloneNode(
			node as unknown as Node,
			this,
			Boolean(deep),
		) as unknown as T;
	}

	adoptNode<T extends globalThis.Node>(node: T): T {
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be adopted");
		}
		if (isShadowRoot(node)) {
			throw hierarchyRequestError("A shadow root cannot be adopted");
		}
		adoptNode(node as unknown as Node, this);
		return node;
	}

	createAttribute(localName: string): globalThis.Attr {
		if (arguments.length < 1) {
			throw new TypeError("createAttribute needs a name");
		}
		let name = String(localName);
		validateAttributeLocalName(name);
		if (isHTMLDocument(this)) {
			name = toASCIILowercase(name);
		}
		const attribute = new Attr(null, null, name, "");
		attribute[kDocument] = this;
		return attribute as unknown as globalThis.Attr;
	}

	createAttributeNS(
		namespace: string | null,
		getQualifiedName: string,
	): globalThis.Attr {
		if (arguments.length < 2) {
			throw new TypeError("createAttributeNS needs a namespace and a name");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(getQualifiedName),
			true,
		);
		const attribute = new Attr(
			extracted.namespace,
			extracted.prefix,
			extracted.localName,
			"",
		);
		attribute[kDocument] = this;
		return attribute as unknown as globalThis.Attr;
	}

	// The event comes back with an empty type and its initialized flag
	// unset, so it cannot be dispatched until initEvent gives it a type.
	// lib.dom lists every name a browser supports, most of them for
	// interfaces no terminal has (RTCTrackEvent, WebGLContextEvent), and the
	// list below is that one. Which names work is up to the user agent: the
	// DOM Standard has createEvent throw NotSupportedError for a name the
	// user agent does not support, and this one supports eighteen.
	createEvent(eventInterface: "AnimationEvent"): globalThis.AnimationEvent;
	createEvent(eventInterface: "AnimationPlaybackEvent"): globalThis.AnimationPlaybackEvent;
	createEvent(eventInterface: "AudioProcessingEvent"): globalThis.AudioProcessingEvent;
	createEvent(eventInterface: "BeforeUnloadEvent"): globalThis.BeforeUnloadEvent;
	createEvent(eventInterface: "BlobEvent"): globalThis.BlobEvent;
	createEvent(eventInterface: "ClipboardEvent"): globalThis.ClipboardEvent;
	createEvent(eventInterface: "CloseEvent"): globalThis.CloseEvent;
	createEvent(eventInterface: "CompositionEvent"): globalThis.CompositionEvent;
	createEvent(eventInterface: "ContentVisibilityAutoStateChangeEvent"): globalThis.ContentVisibilityAutoStateChangeEvent;
	createEvent(eventInterface: "CookieChangeEvent"): globalThis.CookieChangeEvent;
	createEvent(eventInterface: "CustomEvent"): globalThis.CustomEvent;
	createEvent(eventInterface: "DeviceMotionEvent"): globalThis.DeviceMotionEvent;
	createEvent(eventInterface: "DeviceOrientationEvent"): globalThis.DeviceOrientationEvent;
	createEvent(eventInterface: "DragEvent"): globalThis.DragEvent;
	createEvent(eventInterface: "ErrorEvent"): globalThis.ErrorEvent;
	createEvent(eventInterface: "Event"): globalThis.Event;
	createEvent(eventInterface: "Events"): globalThis.Event;
	createEvent(eventInterface: "FocusEvent"): globalThis.FocusEvent;
	createEvent(eventInterface: "FontFaceSetLoadEvent"): globalThis.FontFaceSetLoadEvent;
	createEvent(eventInterface: "FormDataEvent"): globalThis.FormDataEvent;
	createEvent(eventInterface: "GamepadEvent"): globalThis.GamepadEvent;
	createEvent(eventInterface: "HashChangeEvent"): globalThis.HashChangeEvent;
	createEvent(eventInterface: "IDBVersionChangeEvent"): globalThis.IDBVersionChangeEvent;
	createEvent(eventInterface: "InputEvent"): globalThis.InputEvent;
	createEvent(eventInterface: "KeyboardEvent"): globalThis.KeyboardEvent;
	createEvent(eventInterface: "MIDIConnectionEvent"): globalThis.MIDIConnectionEvent;
	createEvent(eventInterface: "MIDIMessageEvent"): globalThis.MIDIMessageEvent;
	createEvent(eventInterface: "MediaEncryptedEvent"): globalThis.MediaEncryptedEvent;
	createEvent(eventInterface: "MediaKeyMessageEvent"): globalThis.MediaKeyMessageEvent;
	createEvent(eventInterface: "MediaQueryListEvent"): globalThis.MediaQueryListEvent;
	createEvent(eventInterface: "MediaStreamTrackEvent"): globalThis.MediaStreamTrackEvent;
	createEvent(eventInterface: "MessageEvent"): globalThis.MessageEvent;
	createEvent(eventInterface: "MouseEvent"): globalThis.MouseEvent;
	createEvent(eventInterface: "MouseEvents"): globalThis.MouseEvent;
	createEvent(eventInterface: "OfflineAudioCompletionEvent"): globalThis.OfflineAudioCompletionEvent;
	createEvent(eventInterface: "PageRevealEvent"): globalThis.PageRevealEvent;
	createEvent(eventInterface: "PageSwapEvent"): globalThis.PageSwapEvent;
	createEvent(eventInterface: "PageTransitionEvent"): globalThis.PageTransitionEvent;
	createEvent(eventInterface: "PaymentMethodChangeEvent"): globalThis.PaymentMethodChangeEvent;
	createEvent(eventInterface: "PaymentRequestUpdateEvent"): globalThis.PaymentRequestUpdateEvent;
	createEvent(eventInterface: "PictureInPictureEvent"): globalThis.PictureInPictureEvent;
	createEvent(eventInterface: "PointerEvent"): globalThis.PointerEvent;
	createEvent(eventInterface: "PopStateEvent"): globalThis.PopStateEvent;
	createEvent(eventInterface: "ProgressEvent"): globalThis.ProgressEvent;
	createEvent(eventInterface: "PromiseRejectionEvent"): globalThis.PromiseRejectionEvent;
	createEvent(eventInterface: "RTCDTMFToneChangeEvent"): globalThis.RTCDTMFToneChangeEvent;
	createEvent(eventInterface: "RTCDataChannelEvent"): globalThis.RTCDataChannelEvent;
	createEvent(eventInterface: "RTCErrorEvent"): globalThis.RTCErrorEvent;
	createEvent(eventInterface: "RTCPeerConnectionIceErrorEvent"): globalThis.RTCPeerConnectionIceErrorEvent;
	createEvent(eventInterface: "RTCPeerConnectionIceEvent"): globalThis.RTCPeerConnectionIceEvent;
	createEvent(eventInterface: "RTCTrackEvent"): globalThis.RTCTrackEvent;
	createEvent(eventInterface: "SecurityPolicyViolationEvent"): globalThis.SecurityPolicyViolationEvent;
	createEvent(eventInterface: "SpeechSynthesisErrorEvent"): globalThis.SpeechSynthesisErrorEvent;
	createEvent(eventInterface: "SpeechSynthesisEvent"): globalThis.SpeechSynthesisEvent;
	createEvent(eventInterface: "StorageEvent"): globalThis.StorageEvent;
	createEvent(eventInterface: "SubmitEvent"): globalThis.SubmitEvent;
	createEvent(eventInterface: "TextEvent"): globalThis.TextEvent;
	createEvent(eventInterface: "ToggleEvent"): globalThis.ToggleEvent;
	createEvent(eventInterface: "TouchEvent"): globalThis.TouchEvent;
	createEvent(eventInterface: "TrackEvent"): globalThis.TrackEvent;
	createEvent(eventInterface: "TransitionEvent"): globalThis.TransitionEvent;
	createEvent(eventInterface: "UIEvent"): globalThis.UIEvent;
	createEvent(eventInterface: "UIEvents"): globalThis.UIEvent;
	createEvent(eventInterface: "WebGLContextEvent"): globalThis.WebGLContextEvent;
	createEvent(eventInterface: "WheelEvent"): globalThis.WheelEvent;
	createEvent(eventInterface: string): globalThis.Event;
	createEvent(interfaceName: string): globalThis.Event {
		if (arguments.length < 1) {
			throw new TypeError("createEvent needs an interface name");
		}
		const name = toASCIILowercase(String(interfaceName));
		const factory = LEGACY_EVENT_INTERFACES.get(name);
		if (factory === undefined) {
			throw domError(
				"NotSupportedError",
				`No event interface is named "${interfaceName}"`,
			);
		}
		const event = constructInternal(factory);
		event[kState]!.initialized = false;
		return event as unknown as globalThis.Event;
	}

	createRange(): globalThis.Range {
		const range = new Range();
		setRangePoints(range, this, 0, this, 0);
		return range as unknown as globalThis.Range;
	}

	// The Selection API also exposes this on the Window, and returns null
	// for a document with no browsing context. There is no browsing context
	// here. The selection belongs to the document, a window's getSelection
	// calls this one, and a headless document still has a selection.
	getSelection(): globalThis.Selection | null {
		let selection = this[kSelection]!;
		if (selection === null) {
			selection = createSelection(this);
			this[kSelection] = selection;
		}
		return selection as unknown as globalThis.Selection;
	}

	createNodeIterator(
		root: globalThis.Node,
		whatToShow = 0xffffffff,
		filter: globalThis.NodeFilter | null = null,
	): globalThis.NodeIterator {
		if (!(root instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		const iterator = new NodeIterator(
			root as Node,
			toUnsignedLong(whatToShow),
			filter as NodeFilterInput,
		);
		// The spec keys the pre-removing steps off the root's node document,
		// which need not be the document the iterator was created from.
		registerNodeIterator(getRoot(root as Node), iterator);
		return iterator as unknown as globalThis.NodeIterator;
	}

	createTreeWalker(
		root: globalThis.Node,
		whatToShow = 0xffffffff,
		filter: globalThis.NodeFilter | null = null,
	): globalThis.TreeWalker {
		if (!(root instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		// The flat bit is private to the engine, and the default whatToShow is
		// every bit there is. Without this mask, `createTreeWalker(root)` would
		// walk the box tree's view of the document instead of the page's.
		return new TreeWalker(
			root as Node,
			toUnsignedLong(whatToShow) & ~SHOW_FLAT,
			filter as NodeFilterInput,
		) as unknown as globalThis.TreeWalker;
	}

	/** Specified to do nothing. */
	clear(): void {}

	captureEvents(): void {}

	releaseEvents(): void {}

	getAnimations(): globalThis.Animation[] {
		return [];
	}

	// XPath is not implemented. The selector engine is the only matcher
	// this engine has.

	evaluate(): never {
		throw domError("NotSupportedError", "XPath is not implemented");
	}

	createExpression(): never {
		throw domError("NotSupportedError", "XPath is not implemented");
	}

	createNSResolver(): never {
		throw domError("NotSupportedError", "XPath is not implemented");
	}

	// Markup arrives whole, so there is no open document to stream into.
	// The parser builds a tree from a string. document.write appends to a
	// stream that this engine never opens.

	open(): never {
		throw domError("InvalidStateError", "This document is not a stream");
	}

	write(): never {
		throw domError("InvalidStateError", "This document is not a stream");
	}

	writeln(): never {
		throw domError("InvalidStateError", "This document is not a stream");
	}

	// Editing commands. This engine has no editing host for them.

	execCommand(): never {
		throw domError("NotSupportedError", "execCommand is not implemented");
	}

	queryCommandEnabled(): never {
		throw domError("NotSupportedError", "execCommand is not implemented");
	}

	queryCommandIndeterm(): never {
		throw domError("NotSupportedError", "execCommand is not implemented");
	}

	queryCommandState(): never {
		throw domError("NotSupportedError", "execCommand is not implemented");
	}

	queryCommandSupported(): never {
		throw domError("NotSupportedError", "execCommand is not implemented");
	}

	queryCommandValue(): never {
		throw domError("NotSupportedError", "execCommand is not implemented");
	}

	// APIs that need a window manager, a network, or a compositor.

	caretPositionFromPoint(): never {
		throw domError(
			"NotSupportedError",
			"caretPositionFromPoint is not implemented",
		);
	}

	caretRangeFromPoint(): never {
		throw domError(
			"NotSupportedError",
			"caretRangeFromPoint is not implemented",
		);
	}

	exitPictureInPicture(): never {
		throw domError(
			"NotSupportedError",
			"Picture-in-picture is not implemented",
		);
	}

	exitPointerLock(): never {
		throw domError("NotSupportedError", "Pointer lock is not implemented");
	}

	hasStorageAccess(): never {
		throw domError(
			"NotSupportedError",
			"The storage access API is not implemented",
		);
	}

	requestStorageAccess(): never {
		throw domError(
			"NotSupportedError",
			"The storage access API is not implemented",
		);
	}

	startViewTransition(): never {
		throw domError("NotSupportedError", "View transitions are not implemented");
	}

	override [kCloneSingle]?(_document: Document): Node {
		const copy = new Document();
		copyDocumentState(this, copy);
		return copy;
	}
}
/* eslint-enable no-misleading-character-class */

function validateXMLName(name: string): void {
	if (!XML_NAME.test(name)) {
		throw domError("InvalidCharacterError", `"${name}" is not a valid name`);
	}
}

function validateElementLocalName(name: string): void {
	if (!VALID_ELEMENT_LOCAL_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid element name`,
		);
	}
}

// The next frame switches back to the main screen.
function leaveFullscreen(document: Document): Element | null {
	const stack = getFullscreenStack(document);
	if (stack.length === 0) {
		return null;
	}
	const exiting = stack.pop()!;
	fireFullscreenEvent("fullscreenchange", exiting);
	return exiting;
}

// CSSOM View's "potentially scrollable": the element has a box, and
// neither it nor its parent leaves overflow visible on both axes. A body
// that scrolls its own content is not what scrolls the viewport.
function isPotentiallyScrollable(body: Element): boolean {
	const view = body.ownerDocument?.defaultView as
		{
			getComputedStyle?(element: Element): {
				getPropertyValue(p: string): string;
			};
		} |
		null |
		undefined;
	if (view?.getComputedStyle === undefined) {
		return false;
	}
	// An absent computed value is the initial one, and overflow's initial
	// value is visible.
	const hidden = (value: string): boolean =>
		value !== "" && value !== "visible";
	const scrolls = (element: Element): boolean => {
		const style = view.getComputedStyle!(element);
		return (
			hidden(style.getPropertyValue("overflow-x")) ||
			hidden(style.getPropertyValue("overflow-y"))
		);
	};
	const parent = body[kParent];
	return (
		parent !== null &&
		parent !== undefined &&
		parent.nodeType === ELEMENT_NODE &&
		scrolls(parent as Element) &&
		scrolls(body)
	);
}

function getDocumentCollection(
	document: Document,
	match: (element: Element) => boolean,
): HTMLCollection {
	return new HTMLCollection(() => {
		const found: Element[] = [];
		for (const node of descendants(document)) {
			if (node.nodeType === ELEMENT_NODE && match(node as Element)) {
				found.push(node as Element);
			}
		}
		return found;
	}, document);
}

Object.defineProperty(Document.prototype, Symbol.toStringTag, {
	value: "Document",
	configurable: true,
});

/**
 * The event handler attributes installed on the prototype below, and the
 * ParentNode mixin from the tables.
 */
export interface Document
	extends Pick<
		globalThis.Document,
		Extract<keyof globalThis.Document, `on${string}`> |
		ParentNodeMixin |
		// DECLARED but never installed, and the difference matters.
		// document.all is specified to be a FALSY object, which JavaScript
		// cannot express; browsers give it an internal slot no script can
		// reach. The selector engine tests `"all" in context` and then reads
		// `context.all[id]`, so a property holding undefined would throw, while
		// an absent one takes the path that works.
		"all"
	> {

	get ownerDocument(): null;

	get textContent(): null;
}

/**
 * The last entry in the top layer is topmost, and only `showModal` ever
 * puts a dialog there.
 */
export function topmostModalDialog(
	document: globalThis.Document,
): HTMLDialogElement | null {
	let modal: HTMLDialogElement | null = null;
	for (const element of renderedTopLayer(document)) {
		if (isModalDialog(element)) {
			modal = element as HTMLDialogElement;
		}
	}
	return modal;
}

/**
 * Hit-test a document-relative point against fresh layout. Both
 * document.elementFromPoint (which converts its viewport-relative x/y into
 * this space) and the engine's mouse hit testing (whose points are already
 * document-relative) go through here, so a click always tests against
 * fresh layout whichever way it arrived.
 */
export function elementAtDocumentPoint(
	document: globalThis.Document,
	x: number,
	y: number,
): globalThis.Element | null {
	const attached = getAttachedDocument(document);
	if (attached === undefined) {
		return null;
	}
	flushLayout(document);
	let element = attached[kLayout].hitTest(
		document.documentElement,
		x,
		y,
		getTopLayer(document) as unknown as Set<globalThis.Element>,
		attached[kScreen].scrollTop,
	);
	// The DOM cannot hand out a pseudo-element, so a hit on the content it
	// generates is a hit on the element it originates from.
	for (
		let host = element && getPseudoHost<Element>(element);
		host;
		host = getPseudoHost<Element>(element!)
	) {
		element = host;
	}
	// RETARGET out of shadow trees, per spec. From outside a shadow tree
	// (and the document is always outside), the hit is the HOST, so a click
	// on an input's internal value span is a click on the input. Without
	// this, closest() and focus logic dead-end inside the UA fragment, whose
	// parts have no parentElement chain to climb.
	while (element) {
		const root = element.getRootNode();
		if (root.nodeType === 11 && (root as unknown as ShadowRoot).host) {
			element = (root as unknown as ShadowRoot).host as unknown as Element;
		} else {
			break;
		}
	}
	// A modal dialog makes the rest of the document inert. A point outside
	// it lands on its backdrop, and a backdrop hit counts as a hit on the
	// DIALOG. That is the target a browser reports for a click on the dim
	// area, and why nothing behind a modal can be clicked or focused while
	// it is open.
	const modal = topmostModalDialog(document);
	if (modal !== null && (element === null || !modal.contains(element))) {
		return modal;
	}
	return element;
}

// Hit testing. The point is viewport-relative, and the engine tests it.
// A headless document renders nothing, so nothing is under any point.
Object.defineProperties(Document.prototype, {
	elementFromPoint: {
		value(this: Document, x: number, y: number): globalThis.Element | null {
			const attached = getAttachedDocument(this);
			if (attached === undefined) {
				return null;
			}
			// Per CSSOM View, x/y are viewport-relative. Convert to the
			// document-relative space hit testing works in, the same conversion
			// getBoundingClientRect makes in the other direction.
			return elementAtDocumentPoint(this, x, y + attached[kScreen].scrollTop);
		},
		writable: true,
		configurable: true,
		enumerable: true,
	},
	// CSSOM View asks for the full stack. This approximates it as the hit
	// element and its flat-tree ancestors. Content that overlaps without
	// containing (an absolutely placed box over a sibling) reports only the
	// winner's chain. The divergence is declared here rather than hidden.
	elementsFromPoint: {
		value(this: Document, x: number, y: number): globalThis.Element[] {
			const stack: globalThis.Element[] = [];
			const attached = getAttachedDocument(this);
			let hit =
				attached === undefined
					? null
					: elementAtDocumentPoint(this, x, y + attached[kScreen].scrollTop);
			while (hit !== null) {
				stack.push(hit as globalThis.Element);
				hit = flatParentElement(hit);
			}
			return stack;
		},
		writable: true,
		configurable: true,
		enumerable: true,
	},
});

class XMLDocument extends Document {
	override [kCloneSingle]?(_document: Document): Node {
		const copy = new XMLDocument();
		copyDocumentState(this, copy);
		return copy;
	}
}

Object.defineProperty(XMLDocument.prototype, Symbol.toStringTag, {
	value: "XMLDocument",
	configurable: true,
});

function stripAndCollapseWhitespace(value: string): string {
	return value.replace(/[\t\n\f\r ]+/g, " ").replace(/^ | $/g, "");
}

function copyDocumentState(from: Document, to: Document): void {
	to[kType] = from[kType]!;
	to[kContentType] = from[kContentType]!;
	to[kEncoding] = from[kEncoding]!;
	to[kDocumentURL] = from[kDocumentURL]!;
	to[kMode] = from[kMode]!;
}

// The registry given, null if the caller asked for no registry,
// undefined if it did not ask.
function extractRegistry(
	options: {customElementRegistry?: unknown} | string | undefined,
): CustomElementRegistry | null | undefined {
	if (options === undefined || options === null) {
		return undefined;
	}
	if (typeof options !== "object") {
		return undefined;
	}
	if (!("customElementRegistry" in options)) {
		return undefined;
	}
	const value = options.customElementRegistry;
	if (value === null || value === undefined) {
		return null;
	}
	if (!(value instanceof CustomElementRegistry)) {
		throw new TypeError("That is not a custom element registry");
	}
	return value;
}

function extractIs(options: {is?: string} | string | undefined): string | null {
	if (options == null) {
		return null;
	}
	if (typeof options === "string") {
		return null;
	}
	const is = (options as {is?: unknown}).is;
	return is === undefined ? null : String(is);
}

function addToIdMap(document: Document, element: Element): void {
	const id = element.getAttribute("id");
	if (id !== null && id !== "") {
		addIdEntry(document, id, element);
	}
}

function removeFromIdMap(document: Document, element: Element): void {
	const id = element.getAttribute("id");
	if (id !== null && id !== "") {
		removeIdEntry(document, id, element);
	}
}

function addIdEntry(document: Document, id: string, element: Element): void {
	const entries = document[kIdMap]!.get(id);
	if (entries === undefined) {
		document[kIdMap]!.set(id, [element]);
	} else if (!entries.includes(element)) {
		entries.push(element);
	}
}

function removeIdEntry(document: Document, id: string, element: Element): void {
	const entries = document[kIdMap]!.get(id);
	if (entries === undefined) {
		return;
	}
	const index = entries.indexOf(element);
	if (index !== -1) {
		entries.splice(index, 1);
	}
	if (entries.length === 0) {
		document[kIdMap]!.delete(id);
	}
}

class DOMImplementation {
	declare [kDocument]?: Document;

	constructor(document: Document) {
		this[kDocument] = document;
	}

	createDocumentType(
		getQualifiedName: string,
		publicId: string,
		systemId: string,
	): DocumentType {
		if (arguments.length < 3) {
			throw new TypeError("createDocumentType needs three arguments");
		}
		const name = String(getQualifiedName);
		validateDoctypeName(name);
		const doctype = new DocumentType(name, String(publicId), String(systemId));
		doctype[kDocument] = this[kDocument]!;
		return doctype;
	}

	createDocument(
		namespace: string | null,
		getQualifiedName: string | null,
		doctype: globalThis.DocumentType | null = null,
	): XMLDocument {
		if (arguments.length < 2) {
			throw new TypeError("createDocument needs a namespace and a name");
		}
		const document = new XMLDocument();
		document[kType] = "xml";
		document[kContentType] = "application/xml";
		let element: Element | null = null;
		const name = getQualifiedName === null ? "" : String(getQualifiedName);
		if (name !== "") {
			element = document.createElementNS(
				namespace == null ? null : String(namespace),
				name,
			) as unknown as Element;
		}
		if (doctype != null) {
			appendNode(doctype as unknown as DocumentType, document);
		}
		if (element !== null) {
			appendNode(element, document);
		}
		const ns = namespace === "" || namespace == null ? null : String(namespace);
		if (ns === HTML_NAMESPACE) {
			document[kContentType] = "application/xhtml+xml";
		} else if (ns === SVG_NAMESPACE) {
			document[kContentType] = "image/svg+xml";
		}
		return document;
	}

	createHTMLDocument(title?: string): Document {
		return createHTMLDocument(
			title === undefined ? undefined : String(title),
			"about:blank",
			null,
		);
	}

	hasFeature(): boolean {
		return true;
	}
}

function validateDoctypeName(name: string): void {
	if (!VALID_DOCTYPE_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid doctype name`,
		);
	}
}

Object.defineProperty(DOMImplementation.prototype, Symbol.toStringTag, {
	value: "DOMImplementation",
	configurable: true,
});

// The one document of a realm that no parser builds. It carries the
// realm's registry, exactly as a parsed document does. The
// DOMImplementation method of the same name does not: a document an
// author builds through the DOM has no browsing context, and no registry
// until one claims it.
function createHTMLDocument(
	title?: string,
	url = "about:blank",
	registry: CustomElementRegistry | null = globalCustomElements,
): Document {
	const document = new Document();
	document[kRegistry] = registry;
	fillHTMLDocument(document, title);
	document[kDocumentURL] = url;
	return document;
}

function fillHTMLDocument(document: Document, title?: string): void {
	const previous = currentDocumentForConstruction;
	currentDocumentForConstruction = document;
	try {
		buildHTMLSkeleton(document, title);
	} finally {
		currentDocumentForConstruction = previous;
	}
}

function buildHTMLSkeleton(document: Document, title?: string): void {
	document[kType] = "html";
	document[kContentType] = "text/html";
	const doctype = new DocumentType("html", "", "");
	doctype[kDocument] = document;
	appendNode(doctype, document);
	const html = createElementInternal(document, "html", HTML_NAMESPACE);
	appendNode(html, document);
	const head = createElementInternal(document, "head", HTML_NAMESPACE);
	appendNode(head, html);
	if (title !== undefined) {
		const titleElement = createElementInternal(
			document,
			"title",
			HTML_NAMESPACE,
		);
		appendNode(titleElement, head);
		const text = new Text(title);
		text[kDocument] = document;
		appendNode(text, titleElement);
	}
	const body = createElementInternal(document, "body", HTML_NAMESPACE);
	appendNode(body, html);
}

type Insertable = Node | string;

function convertNodesIntoNode(nodes: Insertable[], document: Document): Node {
	if (nodes.length === 1 && nodes[0] instanceof Node) {
		return nodes[0];
	}
	const converted = nodes.map((node) => {
		if (node instanceof Node) {
			return node;
		}
		const text = new Text(String(node));
		text[kDocument] = document;
		return text as Node;
	});
	if (converted.length === 1) {
		return converted[0];
	}
	const fragment =
		document.createDocumentFragment() as unknown as DocumentFragment;
	for (const node of converted) {
		appendNode(node, fragment);
	}
	return fragment;
}

const parentNodeMembers = {
	children: {
		get(this: Node): HTMLCollection {
			const owner = this as unknown as Record<symbol, HTMLCollection | null>;
			let collection = owner[kChildren]!;
			if (collection == null) {
				collection = new HTMLCollection(
					() => getElementChildren(this),
					this,
					(node) => node.nodeType === ELEMENT_NODE,
				);
				ensureList(collection);
				owner[kChildren] = collection;
			}
			return collection;
		},
		configurable: true,
		enumerable: true,
	},
	firstElementChild: {
		get(this: Node): Element | null {
			for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
				if (node.nodeType === ELEMENT_NODE) {
					return node as Element;
				}
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
	lastElementChild: {
		get(this: Node): Element | null {
			for (let node = this[kLastChild]!;
				node !== null;
				node = node[kPrevious]!) {
				if (node.nodeType === ELEMENT_NODE) {
					return node as Element;
				}
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
	childElementCount: {
		get(this: Node): number {
			return countChildren(this, ELEMENT_NODE);
		},
		configurable: true,
		enumerable: true,
	},
	prepend: {
		value(this: Node, ...nodes: Insertable[]): void {
			const node = convertNodesIntoNode(nodes, this[kDocument]!);
			preInsert(node, this, this[kFirstChild]!);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	append: {
		value(this: Node, ...nodes: Insertable[]): void {
			const node = convertNodesIntoNode(nodes, this[kDocument]!);
			preInsert(node, this, null);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	moveBefore: {
		value(this: Node, node: Node, child: Node | null): void {
			if (arguments.length < 2) {
				throw new TypeError("moveBefore needs a node and a child");
			}
			if (!(node instanceof Node)) {
				throw new TypeError("That is not a node");
			}
			if (child !== null && child !== undefined && !(child instanceof Node)) {
				throw new TypeError("That is not a node");
			}
			let reference = child ?? null;
			if (reference === node) {
				reference = node[kNext]!;
			}
			moveNode(node, this, reference);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	replaceChildren: {
		value(this: Node, ...nodes: Insertable[]): void {
			const node = convertNodesIntoNode(nodes, this[kDocument]!);
			ensurePreInsertionValidity(node, this, null, true);
			replaceAll(node, this);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	querySelector: {
		value(this: Node, selectors: string): Element | null {
			if (arguments.length < 1) {
				throw new TypeError("querySelector needs a selector");
			}
			try {
				return selectFirst(this, String(selectors), {scope: this});
			} catch (error) {
				throw asSyntaxError(error);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	querySelectorAll: {
		value(this: Node, selectors: string): NodeList {
			if (arguments.length < 1) {
				throw new TypeError("querySelectorAll needs a selector");
			}
			try {
				return createStaticNodeList(
					selectAll(this, String(selectors), {scope: this}),
				);
			} catch (error) {
				throw asSyntaxError(error);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
};

const childNodeMembers = {
	before: {
		value(this: Node, ...nodes: Insertable[]): void {
			const parent = this[kParent]!;
			if (parent === null) {
				return;
			}
			let viable = this[kPrevious]!;
			while (viable !== null && nodes.includes(viable)) {
				viable = viable[kPrevious]!;
			}
			const node = convertNodesIntoNode(nodes, this[kDocument]!);
			if (viable === null) {
				preInsert(node, parent, parent[kFirstChild]!);
			} else {
				preInsert(node, parent, viable[kNext]!);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	after: {
		value(this: Node, ...nodes: Insertable[]): void {
			const parent = this[kParent]!;
			if (parent === null) {
				return;
			}
			let viable = this[kNext]!;
			while (viable !== null && nodes.includes(viable)) {
				viable = viable[kNext]!;
			}
			const node = convertNodesIntoNode(nodes, this[kDocument]!);
			preInsert(node, parent, viable);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	replaceWith: {
		value(this: Node, ...nodes: Insertable[]): void {
			const parent = this[kParent]!;
			if (parent === null) {
				return;
			}
			let viable = this[kNext]!;
			while (viable !== null && nodes.includes(viable)) {
				viable = viable[kNext]!;
			}
			const node = convertNodesIntoNode(nodes, this[kDocument]!);
			if (this[kParent] === parent) {
				replaceChild(this, node, parent);
			} else {
				preInsert(node, parent, viable);
			}
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	remove: {
		value(this: Node): void {
			if (this[kParent] === null) {
				return;
			}
			removeNode(this);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
};

const nonDocumentTypeChildNodeMembers = {
	previousElementSibling: {
		get(this: Node): Element | null {
			for (let node = this[kPrevious]!;
				node !== null;
				node = node[kPrevious]!) {
				if (node.nodeType === ELEMENT_NODE) {
					return node as Element;
				}
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
	nextElementSibling: {
		get(this: Node): Element | null {
			for (let node = this[kNext]!; node !== null; node = node[kNext]!) {
				if (node.nodeType === ELEMENT_NODE) {
					return node as Element;
				}
			}
			return null;
		},
		configurable: true,
		enumerable: true,
	},
};

for (const prototype of [
	Document.prototype,
	DocumentFragment.prototype,
	Element.prototype,
]) {
	Object.defineProperties(prototype, parentNodeMembers);
}
for (const prototype of [
	DocumentType.prototype,
	Element.prototype,
	CharacterData.prototype,
]) {
	Object.defineProperties(prototype, childNodeMembers);
}
for (const prototype of [Element.prototype, CharacterData.prototype]) {
	Object.defineProperties(prototype, nonDocumentTypeChildNodeMembers);
}

// Marked [Unscopable] in the IDL, so a `with` statement over a node does
// not shadow a variable named after one of them.
function markUnscopable(prototype: object, names: string[]): void {
	const existing = (prototype as Record<symbol, Record<string, true>>)[
		Symbol.unscopables
	];
	const unscopables: Record<string, true> =
		existing === undefined ? Object.create(null) : existing;
	for (const name of names) {
		unscopables[name] = true;
	}
	Object.defineProperty(prototype, Symbol.unscopables, {
		value: unscopables,
		configurable: true,
	});
}

const PARENT_NODE_UNSCOPABLES = ["append", "prepend", "replaceChildren"];
const CHILD_NODE_UNSCOPABLES = ["after", "before", "remove", "replaceWith"];

markUnscopable(Document.prototype, PARENT_NODE_UNSCOPABLES);
markUnscopable(DocumentFragment.prototype, PARENT_NODE_UNSCOPABLES);
markUnscopable(Element.prototype, [
	...PARENT_NODE_UNSCOPABLES,
	...CHILD_NODE_UNSCOPABLES,
	"slot",
]);
markUnscopable(CharacterData.prototype, CHILD_NODE_UNSCOPABLES);
markUnscopable(DocumentType.prototype, CHILD_NODE_UNSCOPABLES);

function getScrollTarget(
	xOrOptions?: number | globalThis.ScrollToOptions,
	y?: number,
): {left?: number; top?: number} {
	if (typeof xOrOptions === "object" && xOrOptions !== null) {
		return {left: xOrOptions.left, top: xOrOptions.top};
	}
	return {left: xOrOptions, top: y};
}

function scrollElementTo(
	this: Element,
	xOrOptions?: number | globalThis.ScrollToOptions,
	y?: number,
): void {
	const target = getScrollTarget(xOrOptions, y);
	if (target.left !== undefined) {
		this.scrollLeft = target.left;
	}
	if (target.top !== undefined) {
		this.scrollTop = target.top;
	}
}

function writeScrollOffset(
	element: globalThis.Element,
	axis: "left" | "top",
	value: number,
): void {
	let offsets = scrollOffsets.get(element);
	if (offsets === undefined) {
		offsets = {left: 0, top: 0};
		scrollOffsets.set(element, offsets);
	}
	offsets[axis] = value;
}

/** html and body scroll the document document scroll. */
function isDocumentScroller(element: Element): boolean {
	const document = element[kDocument];
	return (
		document != null &&
		(element === (document.documentElement as unknown) ||
			element === (document.body as unknown))
	);
}

const scrolledElements = new WeakMap<Document, Set<Element>>();

// A write on an attached document rounds to whole cells (everything
// paints on the cell grid, like the document document scroll), clamps into the
// range layout reports for the box, stores the value, and tells the
// engine what moved so the frame journal can price it. A box whose
// extent layout cannot report (a text control's value span, an opaque measured
// run) stores the write unclamped; the caret-reveal code owns those
// offsets and keeps them sane. On a headless document the write is
// stored and read back, and nothing moves.
function setScrollOffset(
	element: Element,
	axis: "left" | "top",
	value: number,
): void {
	const attached = getAttachedDocument(element);
	if (attached === undefined) {
		writeScrollOffset(element, axis, toDouble(value));
		return;
	}
	if (isDocumentScroller(element)) {
		if (axis === "top") {
			attached[kScreen].scrollTo(Number(value));
			void render(attached[kTermDOM]);
		}
		return;
	}
	const numeric = Number(value);
	let next = Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0;
	if (element.isConnected) {
		flushLayout(element);
		const room = attached[kLayout].scrollRange(element, axis);
		if (room !== null) {
			next = Math.min(next, room);
		}
	}
	const previous = scrollOffsets.get(element)?.[axis] ?? 0;
	if (previous === next) {
		return;
	}
	writeScrollOffset(element, axis, next);
	const document = element[kDocument]!;
	if (next !== 0) {
		let held = scrolledElements.get(document);
		if (held === undefined) {
			held = new Set();
			scrolledElements.set(document, held);
		}
		held.add(element);
	}
	// A vertical scroll is a run of rows the terminal may be able to shift for
	// us. A horizontal one is not, and dirties the frame like anything else.
	if (axis === "top") {
		recordScrollShift(attached, document, element, next - previous);
	} else {
		attached[kScreen].invalidate();
	}
	void render(attached[kTermDOM]);
}

/**
 * Pull every stored scroll offset back into its box's scrollable range
 * against fresh layout. A mutation that shrinks a box's content must not
 * leave the box scrolled past what remains. Offsets are written to the
 * store directly, because the accessor's own clamp would re-enter the
 * engine's flush. A change sets the dirty bit, drops any pending scroll shift,
 * and requests a repaint. A clamp is not a scroll shift: it moves offsets the
 * journal already priced, and can move several boxes at once.
 */
export function clampScrollOffsets(document: globalThis.Document): void {
	const attached = getAttachedDocument(document);
	const held = scrolledElements.get(document as Document);
	if (attached === undefined || held === undefined) {
		return;
	}
	let changed = false;
	for (const element of held) {
		const offsets = scrollOffsets.get(element) ?? {left: 0, top: 0};
		if (offsets.left === 0 && offsets.top === 0) {
			held.delete(element);
			continue;
		}
		if (!element.isConnected) {
			continue;
		}
		const extent = attached[kLayout].scrollExtentOf(element);
		const port = attached[kLayout].contentRect(element);
		if (!extent || !port) {
			continue;
		}
		// An unknowable horizontal extent leaves that axis unclamped.
		const maxLeft =
			extent.width === null
				? offsets.left
				: Math.max(0, extent.width - Math.round(port.width));
		const maxTop = Math.max(0, extent.height - Math.round(port.height));
		if (offsets.left <= maxLeft && offsets.top <= maxTop) {
			continue;
		}
		writeScrollOffset(element, "left", Math.min(offsets.left, maxLeft));
		writeScrollOffset(element, "top", Math.min(offsets.top, maxTop));
		changed = true;
	}
	if (changed) {
		scrollShifts.delete(document as Document);
		attached[kScreen].invalidate();
		void render(attached[kTermDOM]);
	}
}

// The one box whose vertical scroll this frame can express as a scroll shift,
// meaning rows the terminal may shift instead of repainting. Repeated
// scrolls on one box add up. A second box scrolling means no single shift
// describes the frame, so the record is dropped in favor of the screen's
// dirty bit.
const scrollShifts = new WeakMap<Document, {element: Element; delta: number}>();

function recordScrollShift(
	attached: AttachedDocument,
	document: Document,
	element: Element,
	delta: number,
): void {
	const shift = scrollShifts.get(document);
	if (shift === undefined) {
		scrollShifts.set(document, {element, delta});
	} else if (shift.element === element) {
		shift.delta += delta;
	} else {
		scrollShifts.delete(document);
		attached[kScreen].invalidate();
	}
}

/** Take the frame's scroll shift, if one survived until paint. */
export function takeScrollShift(
	document: globalThis.Document,
): {element: globalThis.Element; delta: number} | null {
	const shift = scrollShifts.get(document as Document);
	if (shift === undefined) {
		return null;
	}
	scrollShifts.delete(document as Document);
	return shift as unknown as {element: globalThis.Element; delta: number};
}

function insertAdjacent(
	element: Element,
	where: string,
	node: Node,
): Node | null {
	switch (toASCIILowercase(where)) {
		case "beforebegin": {
			const parent = element[kParent]!;
			if (parent === null) {
				return null;
			}
			preInsert(node, parent, element);
			return node;
		}
		case "afterbegin":
			preInsert(node, element, element[kFirstChild]!);
			return node;
		case "beforeend":
			preInsert(node, element, null);
			return node;
		case "afterend": {
			const parent = element[kParent]!;
			if (parent === null) {
				return null;
			}
			preInsert(node, parent, element[kNext]!);
			return node;
		}
		default:
			throw domError("SyntaxError", `"${where}" is not a position`);
	}
}

function cloneNode(
	node: Node,
	document: Document | undefined,
	deep: boolean,
): Node {
	const target = document ?? node[kDocument]!;
	const copy = node[kCloneSingle]!(target);
	if (copy.nodeType === DOCUMENT_NODE) {
		copy[kDocument] = copy as Document;
	}
	node[kCloningSteps]!(copy, target, deep);
	if (node.nodeType === ELEMENT_NODE) {
		const shadow = (node as Element)[kShadowRoot]!;
		if (shadow !== null && shadow[kClonable]!) {
			attachShadowRoot(
				copy as Element,
				shadow[kShadowMode]!,
				true,
				shadow[kSerializable]!,
				shadow[kDelegatesFocus]!,
				shadow[kSlotAssignment]!,
				shadow[kRegistry]!,
			);
			const copiedShadow = (copy as Element)[kShadowRoot]! as ShadowRoot;
			copiedShadow[kDeclarative] = shadow[kDeclarative]!;
			for (
				let child = shadow[kFirstChild]!;
				child !== null;
				child = child[kNext]!
			) {
				appendNode(
					cloneNode(child, copiedShadow[kDocument]!, true),
					copiedShadow,
				);
			}
		}
	}
	if (deep) {
		for (let child = node[kFirstChild]!;
			child !== null;
			child = child[kNext]!) {
			appendNode(cloneNode(child, copy[kDocument]!, true), copy);
		}
	}
	return copy;
}

function equalNodes(a: Node, b: Node): boolean {
	if (a.nodeType !== b.nodeType) {
		return false;
	}
	switch (a.nodeType) {
		case DOCUMENT_TYPE_NODE: {
			const one = a as DocumentType;
			const two = b as DocumentType;
			if (
				one[kName] !== two[kName] ||
				one[kPublicId] !== two[kPublicId] ||
				one[kSystemId] !== two[kSystemId]!
			) {
				return false;
			}
			break;
		}
		case ELEMENT_NODE: {
			const one = a as Element;
			const two = b as Element;
			if (
				one[kNamespace] !== two[kNamespace] ||
				one[kPrefix] !== two[kPrefix] ||
				one[kLocalName] !== two[kLocalName] ||
				one[kAttributeList]!.length !== two[kAttributeList]!.length
			) {
				return false;
			}
			for (const attribute of one[kAttributeList]!) {
				const other = getAttributeByNamespace(
					two,
					attribute[kNamespace]!,
					attribute[kLocalName]!,
				);
				if (other === null || other[kValue] !== attribute[kValue]!) {
					return false;
				}
			}
			break;
		}
		case ATTRIBUTE_NODE: {
			const one = a as Attr;
			const two = b as Attr;
			if (
				one[kNamespace] !== two[kNamespace] ||
				one[kLocalName] !== two[kLocalName] ||
				one[kValue] !== two[kValue]!
			) {
				return false;
			}
			break;
		}
		case PROCESSING_INSTRUCTION_NODE: {
			const one = a as ProcessingInstruction;
			const two = b as ProcessingInstruction;
			if (one[kTarget] !== two[kTarget] || one[kData] !== two[kData]!) {
				return false;
			}
			break;
		}
		case TEXT_NODE:
		case CDATA_SECTION_NODE:
		case COMMENT_NODE:
			if ((a as CharacterData)[kData] !== (b as CharacterData)[kData]!) {
				return false;
			}
			break;
		default:
			break;
	}
	let childA = a[kFirstChild]!;
	let childB = b[kFirstChild]!;
	while (childA !== null && childB !== null) {
		if (!equalNodes(childA, childB)) {
			return false;
		}
		childA = childA[kNext]!;
		childB = childB[kNext]!;
	}
	return childA === null && childB === null;
}

function locateNamespacePrefix(
	element: Element,
	namespace: string,
): string | null {
	if (element[kNamespace] === namespace && element[kPrefix] !== null) {
		return element[kPrefix]!;
	}
	for (const attribute of element[kAttributeList]!) {
		if (attribute[kPrefix] === "xmlns" && attribute[kValue] === namespace) {
			return attribute[kLocalName]!;
		}
	}
	const parent = element.parentElement;
	return parent === null
		? null
		: locateNamespacePrefix(parent as unknown as Element, namespace);
}

function locateNamespace(node: Node, prefix: string | null): string | null {
	switch (node.nodeType) {
		case ELEMENT_NODE: {
			// The two prefixes the XML specifications bind permanently.
			if (prefix === "xml") {
				return XML_NAMESPACE;
			}
			if (prefix === "xmlns") {
				return XMLNS_NAMESPACE;
			}
			const element = node as Element;
			if (element[kNamespace] !== null && element[kPrefix] === prefix) {
				return element[kNamespace]!;
			}
			for (const attribute of element[kAttributeList]!) {
				if (
					attribute[kNamespace] === XMLNS_NAMESPACE &&
					attribute[kPrefix] === "xmlns" &&
					attribute[kLocalName] === prefix
				) {
					return attribute[kValue] === "" ? null : attribute[kValue]!;
				}
				if (
					attribute[kNamespace] === XMLNS_NAMESPACE &&
					attribute[kPrefix] === null &&
					attribute[kLocalName] === "xmlns" &&
					prefix === null
				) {
					return attribute[kValue] === "" ? null : attribute[kValue]!;
				}
			}
			const parent = element.parentElement;
			return parent === null
				? null
				: locateNamespace(parent as unknown as Element, prefix);
		}
		case DOCUMENT_NODE: {
			const element = (node as Document).documentElement as unknown as Element |
				null;
			return element === null ? null : locateNamespace(element, prefix);
		}
		case DOCUMENT_TYPE_NODE:
		case DOCUMENT_FRAGMENT_NODE:
			return null;
		case ATTRIBUTE_NODE: {
			const owner = (node as Attr).ownerElement;
			return owner === null ? null : locateNamespace(owner, prefix);
		}
		default: {
			const parent = node.parentElement;
			return parent === null
				? null
				: locateNamespace(parent as unknown as Element, prefix);
		}
	}
}

const BEFORE = -1;
const EQUAL = 0;
const AFTER = 1;

function getNodeIndex(node: Node): number {
	let index = 0;
	for (
		let previous = node[kPrevious]!;
		previous !== null;
		previous = previous[kPrevious]!
	) {
		index++;
	}
	return index;
}

// Zero for a doctype, the data length for character data, and the
// child count for everything else.
function getNodeLength(node: Node): number {
	if (node.nodeType === DOCUMENT_TYPE_NODE) {
		return 0;
	}
	if (isCharacterData(node)) {
		return (node as CharacterData)[kData]!.length;
	}
	let length = 0;
	for (let child = node[kFirstChild]!; child !== null; child = child[kNext]!) {
		length++;
	}
	return length;
}

function getAncestorChain(node: Node): Node[] {
	const chain: Node[] = [];
	for (
		let current: Node | null = node;
		current !== null;
		current = current[kParent]!
	) {
		chain.push(current);
	}
	chain.reverse();
	return chain;
}

function isPrecedingSibling(node: Node, other: Node): boolean {
	for (let next = node[kNext]!; next !== null; next = next[kNext]!) {
		if (next === other) {
			return true;
		}
	}
	return false;
}

// Both nodes must have the same root.
function comparePoints(
	nodeA: Node,
	offsetA: number,
	nodeB: Node,
	offsetB: number,
): number {
	if (nodeA === nodeB) {
		if (offsetA === offsetB) {
			return EQUAL;
		}
		return offsetA < offsetB ? BEFORE : AFTER;
	}
	const chainA = getAncestorChain(nodeA);
	const chainB = getAncestorChain(nodeB);
	let depth = 0;
	while (
		depth < chainA.length &&
		depth < chainB.length &&
		chainA[depth] === chainB[depth]
	) {
		depth++;
	}
	// One node is an ancestor of the other. Compare the ancestor's offset
	// against the index of the child that contains the other node.
	if (depth === chainA.length) {
		return getNodeIndex(chainB[depth]) < offsetA ? AFTER : BEFORE;
	}
	if (depth === chainB.length) {
		return getNodeIndex(chainA[depth]) < offsetB ? BEFORE : AFTER;
	}
	return isPrecedingSibling(chainA[depth], chainB[depth]) ? BEFORE : AFTER;
}

function registerNodeIterator(treeRoot: Node, iterator: NodeIterator): void {
	let set = nodeIteratorsByRoot.get(treeRoot);
	if (set === undefined) {
		set = new Set();
		nodeIteratorsByRoot.set(treeRoot, set);
	}
	set.add(iterator);
}

// The mutation steps' fast path.
let liveRangesEver = 0;

const kStartNode = Symbol("range start node");

function rehomeLiveRange(range: Range, oldRoot: Node): void {
	const newRoot = getRoot(range[kStartNode]!);
	if (newRoot === oldRoot) {
		return;
	}
	liveRangesByRoot.get(oldRoot)?.delete(range);
	let set = liveRangesByRoot.get(newRoot);
	if (set === undefined) {
		set = new Set();
		liveRangesByRoot.set(newRoot, set);
	}
	set.add(range);
}

function forEachLiveRange(context: Node, steps: (range: Range) => void): void {
	if (liveRangesEver === 0) {
		return;
	}
	const set = liveRangesByRoot.get(getRoot(context));
	if (set === undefined) {
		return;
	}
	for (const range of set) {
		steps(range);
	}
}

const kStartOffset = Symbol("range start offset");
const kEndNode = Symbol("range end node");
const kEndOffset = Symbol("range end offset");

// A node inserted before a child shifts every boundary point in the
// parent that is past that child.
function liveRangeInsertSteps(parent: Node, child: Node, count: number): void {
	const index = getNodeIndex(child);
	forEachLiveRange(parent, (range) => {
		if (range[kStartNode] === parent && range[kStartOffset]! > index) {
			range[kStartOffset]! += count;
		}
		if (range[kEndNode] === parent && range[kEndOffset]! > index) {
			range[kEndOffset]! += count;
		}
	});
}

// A boundary point inside the removed node collapses to the node's own
// position. A point after it in the parent moves back by one.
function liveRangePreRemoveSteps(node: Node): void {
	const parent = node[kParent]! as Node;
	const index = getNodeIndex(node);
	forEachLiveRange(node, (range) => {
		if (isInclusiveAncestor(node, range[kStartNode]!)) {
			range[kStartNode] = parent;
			range[kStartOffset] = index;
		}
		if (isInclusiveAncestor(node, range[kEndNode]!)) {
			range[kEndNode] = parent;
			range[kEndOffset] = index;
		}
		if (range[kStartNode] === parent && range[kStartOffset]! > index) {
			range[kStartOffset]! -= 1;
		}
		if (range[kEndNode] === parent && range[kEndOffset]! > index) {
			range[kEndOffset]! -= 1;
		}
	});
}

// A point inside the replaced run collapses to its start. A point after
// the run moves by the difference in length.
function liveRangeReplaceDataSteps(
	node: CharacterData,
	offset: number,
	count: number,
	length: number,
): void {
	forEachLiveRange(node, (range) => {
		if (
			range[kStartNode] === node &&
			range[kStartOffset]! > offset &&
			range[kStartOffset]! <= offset + count
		) {
			range[kStartOffset] = offset;
		}
		if (
			range[kEndNode] === node &&
			range[kEndOffset]! > offset &&
			range[kEndOffset]! <= offset + count
		) {
			range[kEndOffset] = offset;
		}
		if (range[kStartNode] === node && range[kStartOffset]! > offset + count) {
			range[kStartOffset]! += length - count;
		}
		if (range[kEndNode] === node && range[kEndOffset]! > offset + count) {
			range[kEndOffset]! += length - count;
		}
	});
}

// A point past the split moves into the new node. A point that sat just
// after the node in its parent moves past the new node too.
function liveRangeSplitSteps(
	node: Text,
	newNode: Text,
	offset: number,
	parent: Node,
): void {
	const index = getNodeIndex(node);
	forEachLiveRange(node, (range) => {
		if (range[kStartNode] === node && range[kStartOffset]! > offset) {
			range[kStartNode] = newNode;
			range[kStartOffset]! -= offset;
		}
		if (range[kEndNode] === node && range[kEndOffset]! > offset) {
			range[kEndNode] = newNode;
			range[kEndOffset]! -= offset;
		}
		if (range[kStartNode] === parent && range[kStartOffset] === index + 1) {
			range[kStartOffset]! += 1;
		}
		if (range[kEndNode] === parent && range[kEndOffset] === index + 1) {
			range[kEndOffset]! += 1;
		}
	});
}

// Runs for each text node that normalize merges into the one before it.
// A point in the merged node, or one that referenced it in its parent,
// moves to where its data ended up.
function liveRangeNormalizeSteps(
	node: Text,
	currentNode: Text,
	length: number,
): void {
	const parent = currentNode[kParent]! as Node;
	const index = getNodeIndex(currentNode);
	forEachLiveRange(node, (range) => {
		if (range[kStartNode] === currentNode) {
			range[kStartNode] = node;
			range[kStartOffset]! += length;
		}
		if (range[kEndNode] === currentNode) {
			range[kEndNode] = node;
			range[kEndOffset]! += length;
		}
		if (range[kStartNode] === parent && range[kStartOffset] === index) {
			range[kStartNode] = node;
			range[kStartOffset] = length;
		}
		if (range[kEndNode] === parent && range[kEndOffset] === index) {
			range[kEndNode] = node;
			range[kEndOffset] = length;
		}
	});
}

class AbstractRange {
	[kStartNode]?: Node;
	[kStartOffset]?: number;
	[kEndNode]?: Node;
	[kEndOffset]?: number;

	constructor(
		startNode: Node,
		startOffset: number,
		endNode: Node,
		endOffset: number,
	) {
		if (new.target === AbstractRange) {
			throw new TypeError("AbstractRange cannot be constructed");
		}
		this[kStartNode] = startNode;
		this[kStartOffset] = startOffset;
		this[kEndNode] = endNode;
		this[kEndOffset] = endOffset;
	}

	get startContainer(): Node {
		return this[kStartNode]!;
	}

	get startOffset(): number {
		return this[kStartOffset]!;
	}

	get endContainer(): Node {
		return this[kEndNode]!;
	}

	get endOffset(): number {
		return this[kEndOffset]!;
	}

	get collapsed(): boolean {
		return (
			this[kStartNode] === this[kEndNode] &&
			this[kStartOffset] === this[kEndOffset]!
		);
	}
}

Object.defineProperty(AbstractRange.prototype, Symbol.toStringTag, {
	value: "AbstractRange",
	configurable: true,
});

interface StaticRangeInit {
	startContainer: Node;
	startOffset: number;
	endContainer: Node;
	endOffset: number;
}

class StaticRange extends AbstractRange implements globalThis.StaticRange {
	constructor(init: StaticRangeInit) {
		super(...getStaticRangePoints(init));
	}
}

function getStaticRangePoints(init: unknown): [Node, number, Node, number] {
	const dictionary = toDictionary<Partial<StaticRangeInit>>(
		init,
		"StaticRange",
	);
	const members = [
		"startContainer",
		"startOffset",
		"endContainer",
		"endOffset",
	] as const;
	for (const member of members) {
		if (dictionary[member] === undefined) {
			throw new TypeError(`StaticRange needs a ${member}`);
		}
	}
	const startContainer = dictionary.startContainer as Node;
	const endContainer = dictionary.endContainer as Node;
	for (const container of [startContainer, endContainer]) {
		if (!(container instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (
			container.nodeType === DOCUMENT_TYPE_NODE ||
			container.nodeType === ATTRIBUTE_NODE
		) {
			throw domError(
				"InvalidNodeTypeError",
				"A boundary point cannot be a doctype or an attribute",
			);
		}
	}
	return [
		startContainer,
		toUnsignedLong(dictionary.startOffset),
		endContainer,
		toUnsignedLong(dictionary.endOffset),
	];
}

Object.defineProperty(StaticRange.prototype, Symbol.toStringTag, {
	value: "StaticRange",
	configurable: true,
});

const START_TO_START = 0;
const START_TO_END = 1;
const END_TO_END = 2;
const END_TO_START = 3;

function rangeRoot(range: Range): Node {
	return getRoot(range[kStartNode]!);
}

function isContained(node: Node, range: Range): boolean {
	if (getRoot(node) !== rangeRoot(range)) {
		return false;
	}
	return (
		comparePoints(node, 0, range[kStartNode]!, range[kStartOffset]!) ===
		AFTER &&
		comparePoints(
			node,
			getNodeLength(node),
			range[kEndNode]!,
			range[kEndOffset]!,
		) === BEFORE
	);
}

function isPartiallyContained(node: Node, range: Range): boolean {
	const holdsStart = isInclusiveAncestor(node, range[kStartNode]!);
	const holdsEnd = isInclusiveAncestor(node, range[kEndNode]!);
	return holdsStart !== holdsEnd;
}

function getCommonAncestor(range: Range): Node {
	let container = range[kStartNode]!;
	while (!isInclusiveAncestor(container, range[kEndNode]!)) {
		container = container[kParent]! as Node;
	}
	return container;
}

function setRangePoints(
	range: Range,
	startNode: Node,
	startOffset: number,
	endNode: Node,
	endOffset: number,
): void {
	const oldRoot = getRoot(range[kStartNode]!);
	range[kStartNode] = startNode;
	range[kStartOffset] = startOffset;
	range[kEndNode] = endNode;
	range[kEndOffset] = endOffset;
	rehomeLiveRange(range, oldRoot);
	rangeBoundaryPointsChanged(range, "both");
}

/** Any node except a doctype. */
function assertBoundaryNode(node: unknown): asserts node is Node {
	if (!(node instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	if (node.nodeType === DOCUMENT_TYPE_NODE) {
		throw domError(
			"InvalidNodeTypeError",
			"A boundary point cannot be a doctype",
		);
	}
}

function setRangeBoundary(
	range: Range,
	node: Node,
	offset: number,
	isStart: boolean,
): void {
	assertBoundaryNode(node);
	const at = toUnsignedLong(offset);
	if (at > getNodeLength(node)) {
		throw indexSizeError("The offset is past the end of the node");
	}
	const oldRoot = getRoot(range[kStartNode]!);
	if (isStart) {
		if (
			rangeRoot(range) !== getRoot(node) ||
			comparePoints(node, at, range[kEndNode]!, range[kEndOffset]!) === AFTER
		) {
			range[kEndNode] = node;
			range[kEndOffset] = at;
		}
		range[kStartNode] = node;
		range[kStartOffset] = at;
	} else {
		if (
			rangeRoot(range) !== getRoot(node) ||
			comparePoints(node, at, range[kStartNode]!, range[kStartOffset]!) ===
			BEFORE
		) {
			range[kStartNode] = node;
			range[kStartOffset] = at;
		}
		range[kEndNode] = node;
		range[kEndOffset] = at;
	}
	rehomeLiveRange(range, oldRoot);
	rangeBoundaryPointsChanged(range, isStart ? "start" : "end");
}

function getBoundaryParent(node: unknown): Node {
	if (!(node instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	const parent = node[kParent]!;
	if (parent === null) {
		throw domError(
			"InvalidNodeTypeError",
			"That node has no parent to take a boundary point in",
		);
	}
	return parent;
}

function createFragment(document: Document): DocumentFragment {
	const fragment = new DocumentFragment();
	fragment[kDocument] = document;
	return fragment;
}

// The child the range starts inside, the children it contains whole,
// and the child it ends inside.
function getExtractionShape(range: Range): {
	commonAncestor: Node;
	firstPartiallyContained: Node | null;
	lastPartiallyContained: Node | null;
	containedChildren: Node[];
} {
	const commonAncestor = getCommonAncestor(range);
	const startNode = range[kStartNode]!;
	const endNode = range[kEndNode]!;
	let firstPartiallyContained: Node | null = null;
	if (!isInclusiveAncestor(startNode, endNode)) {
		for (
			let child = commonAncestor[kFirstChild]!;
			child !== null;
			child = child[kNext]!
		) {
			if (isPartiallyContained(child, range)) {
				firstPartiallyContained = child;
				break;
			}
		}
	}
	let lastPartiallyContained: Node | null = null;
	if (!isInclusiveAncestor(endNode, startNode)) {
		for (
			let child = commonAncestor[kLastChild]!;
			child !== null;
			child = child[kPrevious]!
		) {
			if (isPartiallyContained(child, range)) {
				lastPartiallyContained = child;
				break;
			}
		}
	}
	const containedChildren: Node[] = [];
	for (
		let child = commonAncestor[kFirstChild]!;
		child !== null;
		child = child[kNext]!
	) {
		if (!isContained(child, range)) {
			continue;
		}
		if (child.nodeType === DOCUMENT_TYPE_NODE) {
			throw hierarchyRequestError("A doctype cannot be taken out of a range");
		}
		containedChildren.push(child);
	}
	return {
		commonAncestor,
		firstPartiallyContained,
		lastPartiallyContained,
		containedChildren,
	};
}

function getPointAfterExtraction(range: Range): [Node, number] {
	const startNode = range[kStartNode]!;
	if (isInclusiveAncestor(startNode, range[kEndNode]!)) {
		return [startNode, range[kStartOffset]!];
	}
	let reference = startNode;
	while (
		reference[kParent] !== null &&
		!isInclusiveAncestor(reference[kParent]! as Node, range[kEndNode]!)
	) {
		reference = reference[kParent]! as Node;
	}
	return [reference[kParent]! as Node, getNodeIndex(reference) + 1];
}

function cloneCharacterDataSlice(
	node: CharacterData,
	offset: number,
	count: number,
): CharacterData {
	const clone = cloneNode(node, undefined, false) as CharacterData;
	clone[kData] = node[kData]!.slice(offset, offset + count);
	return clone;
}

const kRangeSelection = Symbol("the selection whose range this is");

class Range extends AbstractRange implements globalThis.Range {
	static readonly START_TO_START = START_TO_START;
	static readonly START_TO_END = START_TO_END;
	static readonly END_TO_END = END_TO_END;
	static readonly END_TO_START = END_TO_START;

	// Installed on the prototype, where the engine that measures them is.
	declare getBoundingClientRect: () => globalThis.DOMRect;
	declare getClientRects: () => globalThis.DOMRectList;
	[kRangeSelection]?: Selection | null;

	constructor() {
		const document = getCurrentDocument();
		super(document, 0, document, 0);
		this[kRangeSelection] = null;
		registerLiveRange(this);
	}

	get commonAncestorContainer(): Node {
		return getCommonAncestor(this);
	}

	setStart(node: Node, offset: number): void {
		if (arguments.length < 2) {
			throw new TypeError("setStart needs a node and an offset");
		}
		setRangeBoundary(this, node, offset, true);
	}

	setEnd(node: Node, offset: number): void {
		if (arguments.length < 2) {
			throw new TypeError("setEnd needs a node and an offset");
		}
		setRangeBoundary(this, node, offset, false);
	}

	setStartBefore(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setStartBefore needs a node");
		}
		const parent = getBoundaryParent(node);
		setRangeBoundary(this, parent, getNodeIndex(node), true);
	}

	setStartAfter(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setStartAfter needs a node");
		}
		const parent = getBoundaryParent(node);
		setRangeBoundary(this, parent, getNodeIndex(node) + 1, true);
	}

	setEndBefore(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setEndBefore needs a node");
		}
		const parent = getBoundaryParent(node);
		setRangeBoundary(this, parent, getNodeIndex(node), false);
	}

	setEndAfter(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setEndAfter needs a node");
		}
		const parent = getBoundaryParent(node);
		setRangeBoundary(this, parent, getNodeIndex(node) + 1, false);
	}

	collapse(toStart = false): void {
		if (toStart) {
			setRangePoints(
				this,
				this[kStartNode]!,
				this[kStartOffset]!,
				this[kStartNode]!,
				this[kStartOffset]!,
			);
		} else {
			setRangePoints(
				this,
				this[kEndNode]!,
				this[kEndOffset]!,
				this[kEndNode]!,
				this[kEndOffset]!,
			);
		}
	}

	selectNode(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("selectNode needs a node");
		}
		selectNodeWithin(this, node);
	}

	selectNodeContents(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("selectNodeContents needs a node");
		}
		assertBoundaryNode(node);
		setRangePoints(this, node, 0, node, getNodeLength(node));
	}

	compareBoundaryPoints(how: number, sourceRange: Range): number {
		if (arguments.length < 2) {
			throw new TypeError("compareBoundaryPoints needs a how and a range");
		}
		if (!(sourceRange instanceof Range)) {
			throw new TypeError("That is not a range");
		}
		const which = toUnsignedShort(how);
		if (
			which !== START_TO_START &&
			which !== START_TO_END &&
			which !== END_TO_END &&
			which !== END_TO_START
		) {
			throw domError(
				"NotSupportedError",
				"That is not one of the boundary point comparisons",
			);
		}
		if (rangeRoot(this) !== rangeRoot(sourceRange)) {
			throw domError(
				"WrongDocumentError",
				"The two ranges are in different trees",
			);
		}
		const thisAtStart = which === START_TO_START || which === END_TO_START;
		const sourceAtStart = which === START_TO_START || which === START_TO_END;
		return comparePoints(
			thisAtStart ? this[kStartNode]! : this[kEndNode]!,
			thisAtStart ? this[kStartOffset]! : this[kEndOffset]!,
			sourceAtStart ? sourceRange[kStartNode]! : sourceRange[kEndNode]!,
			sourceAtStart ? sourceRange[kStartOffset]! : sourceRange[kEndOffset]!,
		);
	}

	deleteContents(): void {
		if (this.collapsed) {
			return;
		}
		const startNode = this[kStartNode]!;
		const startOffset = this[kStartOffset]!;
		const endNode = this[kEndNode]!;
		const endOffset = this[kEndOffset]!;
		if (startNode === endNode && isCharacterData(startNode)) {
			replaceData(
				startNode as CharacterData,
				startOffset,
				endOffset - startOffset,
				"",
			);
			return;
		}
		const nodesToRemove: Node[] = [];
		for (const node of descendants(getCommonAncestor(this))) {
			if (!isContained(node, this)) {
				continue;
			}
			const parent = node[kParent]!;
			if (parent !== null && isContained(parent, this)) {
				continue;
			}
			nodesToRemove.push(node);
		}
		const [newNode, newOffset] = getPointAfterExtraction(this);
		setRangePoints(this, newNode, newOffset, newNode, newOffset);
		if (isCharacterData(startNode)) {
			const data = startNode as CharacterData;
			replaceData(data, startOffset, data[kData]!.length - startOffset, "");
		}
		for (const node of nodesToRemove) {
			removeNode(node);
		}
		if (isCharacterData(endNode)) {
			replaceData(endNode as CharacterData, 0, endOffset, "");
		}
	}

	extractContents(): DocumentFragment {
		return extractRange(this);
	}

	cloneContents(): DocumentFragment {
		return cloneRangeContents(this);
	}

	insertNode(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("insertNode needs a node");
		}
		insertIntoRange(this, node);
	}

	// The context is the start node's element (a text node's parent, or
	// the body when the start is the document), exactly the context
	// innerHTML would use for the same markup.
	createContextualFragment(markup: string): DocumentFragment {
		const start = this[kStartNode]!;
		let context: Element | null =
			start instanceof Element
				? start
				: start[kParent]! instanceof Element
					? (start[kParent]! as Element)
					: null;
		if (context === null) {
			const document =
				start instanceof Document
					? start
					: (start.ownerDocument as Document | null);
			context = (document?.body ?? document?.documentElement ?? null) as
			Element |
			null;
		}
		if (context === null) {
			throw domError("NotSupportedError", "The range has no context");
		}
		return parseHTMLFragment(String(markup ?? ""), context);
	}

	surroundContents(newParent: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("surroundContents needs a node");
		}
		if (!(newParent instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		for (const node of [this[kStartNode]!, this[kEndNode]!]) {
			let current: Node | null = node;
			while (current !== null) {
				if (isPartiallyContained(current, this) && !(current instanceof Text)) {
					throw domError(
						"InvalidStateError",
						"The range starts or ends inside a node it does not cover",
					);
				}
				current = current[kParent]!;
			}
		}
		const type = newParent.nodeType;
		if (
			type === DOCUMENT_NODE ||
			type === DOCUMENT_TYPE_NODE ||
			type === DOCUMENT_FRAGMENT_NODE
		) {
			throw domError(
				"InvalidNodeTypeError",
				"That node cannot be the parent of a range's contents",
			);
		}
		const fragment = extractRange(this);
		if (newParent[kFirstChild] !== null) {
			replaceAll(null, newParent);
		}
		insertIntoRange(this, newParent);
		appendNode(fragment, newParent);
		selectNodeWithin(this, newParent);
	}

	cloneRange(): Range {
		const range = new Range();
		setRangePoints(
			range,
			this[kStartNode]!,
			this[kStartOffset]!,
			this[kEndNode]!,
			this[kEndOffset]!,
		);
		return range;
	}

	detach(): void {
		// The spec makes this a no-op.
	}

	isPointInRange(node: Node, offset: number): boolean {
		if (arguments.length < 2) {
			throw new TypeError("isPointInRange needs a node and an offset");
		}
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (getRoot(node) !== rangeRoot(this)) {
			return false;
		}
		if (node.nodeType === DOCUMENT_TYPE_NODE) {
			throw domError(
				"InvalidNodeTypeError",
				"A boundary point cannot be a doctype",
			);
		}
		const at = toUnsignedLong(offset);
		if (at > getNodeLength(node)) {
			throw indexSizeError("The offset is past the end of the node");
		}
		return (
			comparePoints(node, at, this[kStartNode]!, this[kStartOffset]!) !==
			BEFORE &&
			comparePoints(node, at, this[kEndNode]!, this[kEndOffset]!) !== AFTER
		);
	}

	comparePoint(node: Node, offset: number): number {
		if (arguments.length < 2) {
			throw new TypeError("comparePoint needs a node and an offset");
		}
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (getRoot(node) !== rangeRoot(this)) {
			throw domError(
				"WrongDocumentError",
				"The point is in a different tree from the range",
			);
		}
		if (node.nodeType === DOCUMENT_TYPE_NODE) {
			throw domError(
				"InvalidNodeTypeError",
				"A boundary point cannot be a doctype",
			);
		}
		const at = toUnsignedLong(offset);
		if (at > getNodeLength(node)) {
			throw indexSizeError("The offset is past the end of the node");
		}
		if (
			comparePoints(node, at, this[kStartNode]!, this[kStartOffset]!) === BEFORE
		) {
			return -1;
		}
		if (comparePoints(node, at, this[kEndNode]!, this[kEndOffset]!) === AFTER) {
			return 1;
		}
		return 0;
	}

	intersectsNode(node: Node): boolean {
		if (arguments.length < 1) {
			throw new TypeError("intersectsNode needs a node");
		}
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (getRoot(node) !== rangeRoot(this)) {
			return false;
		}
		const parent = node[kParent]!;
		if (parent === null) {
			return true;
		}
		const offset = getNodeIndex(node);
		return (
			comparePoints(parent, offset, this[kEndNode]!, this[kEndOffset]!) ===
			BEFORE &&
			comparePoints(
				parent,
				offset + 1,
				this[kStartNode]!,
				this[kStartOffset]!,
			) === AFTER
		);
	}

	override toString(): string {
		const startNode = this[kStartNode]!;
		const endNode = this[kEndNode]!;
		if (startNode === endNode && startNode instanceof Text) {
			return startNode[kData]!.slice(this[kStartOffset]!, this[kEndOffset]!);
		}
		let string = "";
		if (startNode instanceof Text) {
			string += startNode[kData]!.slice(this[kStartOffset]!);
		}
		for (const node of descendants(getCommonAncestor(this))) {
			if (!(node instanceof Text)) {
				continue;
			}
			if (isContained(node, this)) {
				string += node[kData]!;
			}
		}
		if (endNode instanceof Text) {
			string += endNode[kData]!.slice(0, this[kEndOffset]!);
		}
		return string;
	}
}

function registerLiveRange(range: Range): void {
	const root = getRoot(range[kStartNode]!);
	let set = liveRangesByRoot.get(root);
	if (set === undefined) {
		set = new Set();
		liveRangesByRoot.set(root, set);
	}
	set.add(range);
	liveRangesEver++;
}

function selectNodeWithin(range: Range, node: Node): void {
	const parent = getBoundaryParent(node);
	const index = getNodeIndex(node);
	setRangePoints(range, parent, index, parent, index + 1);
}

function extractRange(range: Range): DocumentFragment {
	const fragment = createFragment(range[kStartNode]![kDocument]!);
	if (range.collapsed) {
		return fragment;
	}
	const startNode = range[kStartNode]!;
	const startOffset = range[kStartOffset]!;
	const endNode = range[kEndNode]!;
	const endOffset = range[kEndOffset]!;
	if (startNode === endNode && isCharacterData(startNode)) {
		const data = startNode as CharacterData;
		appendNode(
			cloneCharacterDataSlice(data, startOffset, endOffset - startOffset),
			fragment,
		);
		replaceData(data, startOffset, endOffset - startOffset, "");
		return fragment;
	}
	const shape = getExtractionShape(range);
	const [newNode, newOffset] = getPointAfterExtraction(range);
	setRangePoints(range, newNode, newOffset, newNode, newOffset);
	const first = shape.firstPartiallyContained;
	if (first !== null && isCharacterData(first)) {
		const data = startNode as CharacterData;
		const count = data[kData]!.length - startOffset;
		appendNode(cloneCharacterDataSlice(data, startOffset, count), fragment);
		replaceData(data, startOffset, count, "");
	} else if (first !== null) {
		const clone = cloneNode(first, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(
			subrange,
			startNode,
			startOffset,
			first,
			getNodeLength(first),
		);
		appendNode(extractRange(subrange), clone);
	}
	for (const child of shape.containedChildren) {
		appendNode(child, fragment);
	}
	const last = shape.lastPartiallyContained;
	if (last !== null && isCharacterData(last)) {
		const data = endNode as CharacterData;
		appendNode(cloneCharacterDataSlice(data, 0, endOffset), fragment);
		replaceData(data, 0, endOffset, "");
	} else if (last !== null) {
		const clone = cloneNode(last, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(subrange, last, 0, endNode, endOffset);
		appendNode(extractRange(subrange), clone);
	}
	return fragment;
}

function cloneRangeContents(range: Range): DocumentFragment {
	const fragment = createFragment(range[kStartNode]![kDocument]!);
	if (range.collapsed) {
		return fragment;
	}
	const startNode = range[kStartNode]!;
	const startOffset = range[kStartOffset]!;
	const endNode = range[kEndNode]!;
	const endOffset = range[kEndOffset]!;
	if (startNode === endNode && isCharacterData(startNode)) {
		const data = startNode as CharacterData;
		appendNode(
			cloneCharacterDataSlice(data, startOffset, endOffset - startOffset),
			fragment,
		);
		return fragment;
	}
	const shape = getExtractionShape(range);
	const first = shape.firstPartiallyContained;
	if (first !== null && isCharacterData(first)) {
		const data = startNode as CharacterData;
		const count = data[kData]!.length - startOffset;
		appendNode(cloneCharacterDataSlice(data, startOffset, count), fragment);
	} else if (first !== null) {
		const clone = cloneNode(first, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(
			subrange,
			startNode,
			startOffset,
			first,
			getNodeLength(first),
		);
		appendNode(cloneRangeContents(subrange), clone);
	}
	for (const child of shape.containedChildren) {
		appendNode(cloneNode(child, undefined, true), fragment);
	}
	const last = shape.lastPartiallyContained;
	if (last !== null && isCharacterData(last)) {
		const data = endNode as CharacterData;
		appendNode(cloneCharacterDataSlice(data, 0, endOffset), fragment);
	} else if (last !== null) {
		const clone = cloneNode(last, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(subrange, last, 0, endNode, endOffset);
		appendNode(cloneRangeContents(subrange), clone);
	}
	return fragment;
}

function insertIntoRange(range: Range, node: Node): void {
	if (!(node instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	const startNode = range[kStartNode]!;
	const type = startNode.nodeType;
	if (
		type === PROCESSING_INSTRUCTION_NODE ||
		type === COMMENT_NODE ||
		(startNode instanceof Text && startNode[kParent] === null) ||
		startNode === node
	) {
		throw hierarchyRequestError("That range cannot take an inserted node");
	}
	let referenceNode: Node | null = null;
	if (startNode instanceof Text) {
		referenceNode = startNode;
	} else {
		let child = startNode[kFirstChild]!;
		for (
			let index = 0;
			index < range[kStartOffset]! && child !== null;
			index++
		) {
			child = child[kNext]!;
		}
		referenceNode = child;
	}
	const parent =
		referenceNode === null ? startNode : (referenceNode[kParent]! as Node);
	ensurePreInsertionValidity(node, parent, referenceNode);
	if (startNode instanceof Text) {
		referenceNode = startNode.splitText(range[kStartOffset]!);
	}
	if (node === referenceNode) {
		referenceNode = node[kNext]!;
	}
	if (node[kParent] !== null) {
		removeNode(node);
	}
	let newOffset =
		referenceNode === null
			? getNodeLength(parent)
			: getNodeIndex(referenceNode);
	newOffset += node.nodeType === DOCUMENT_FRAGMENT_NODE
		? getNodeLength(node)
		: 1;
	preInsert(node, parent, referenceNode);
	if (range.collapsed) {
		range[kEndNode] = parent;
		range[kEndOffset] = newOffset;
		rangeBoundaryPointsChanged(range, "end");
	}
}

interface Range
	extends Pick<
		globalThis.Range,
		"START_TO_START" | "START_TO_END" | "END_TO_END" | "END_TO_START"
	> {}

for (const [name, value] of [
	["START_TO_START", START_TO_START],
	["START_TO_END", START_TO_END],
	["END_TO_END", END_TO_END],
	["END_TO_START", END_TO_START],
] as Array<[string, number]>) {
	Object.defineProperty(Range.prototype, name, {value, enumerable: true});
}

ceReactions(Range.prototype, [
	"deleteContents",
	"extractContents",
	"cloneContents",
	"insertNode",
	"surroundContents",
]);

Object.defineProperty(Range.prototype, Symbol.toStringTag, {
	value: "Range",
	configurable: true,
});

// The start container, or the element containing it when it is a text
// node. Whether to subtract the document scroll depends on the box the range is
// in, not on the range.
function rangeAnchor(range: Range): Element | null {
	const container = range.startContainer;
	return container.nodeType === ELEMENT_NODE
		? (container as unknown as Element)
		: ((container as unknown as Node).parentElement as Element | null);
}

// Range geometry reads the same layout the element members read, and
// converts the same way. The caret and selection painters read the
// layout's document-relative rects directly, as scrollIntoView does.
Object.defineProperties(Range.prototype, {
	getBoundingClientRect: {
		value(this: Range): globalThis.DOMRect {
			const attached = getAttachedDocument(this.startContainer);
			if (attached === undefined) {
				return new DOMRect(0, 0, 0, 0);
			}
			flushLayout(this.startContainer);
			return toViewportRect(
				attached,
				unionRect(attached[kLayout].getRangeRects(this)),
				rangeAnchor(this),
			);
		},
		writable: true,
		configurable: true,
	},
	getClientRects: {
		value(this: Range): globalThis.DOMRectList {
			const attached = getAttachedDocument(this.startContainer);
			if (attached === undefined) {
				return new DOMRectList();
			}
			flushLayout(this.startContainer);
			const anchor = rangeAnchor(this);
			return createRectList(
				attached[kLayout]
					.getRangeRects(this)
					.map((rect) => toViewportRect(attached, rect, anchor)),
			);
		},
		writable: true,
		configurable: true,
	},
});

// Every change the Range API makes to the boundary points fires a
// selectionchange event on the selection this range belongs to.
function rangeBoundaryPointsChanged(
	range: Range,
	which: "start" | "end" | "both",
): void {
	const selection = range[kRangeSelection]!;
	if (selection !== null) {
		selectionChanged(selection, which);
	}
}

/** At most one per task. */
function scheduleSelectionChange(document: Document): void {
	// A selection move is not a mutation and no record names the rows it
	// covers, so the repaint is requested here, before the coalescing guard
	// below. That guard drops the second move in a task but not its paint.
	const attached = getAttachedDocument(document);
	if (attached !== undefined) {
		attached[kScreen].invalidate();
		void render(attached[kTermDOM]);
	}
	if (document[kSelectionChangeScheduled]!) {
		return;
	}
	document[kSelectionChangeScheduled] = true;
	setTimeout(() => {
		document[kSelectionChangeScheduled] = false;
		document.dispatchEvent(new Event("selectionchange"));
	}, 0);
}

// A shadow root sits at its host, before the host's children, so a
// boundary point in a shadow tree can be ordered against one in the
// light tree.
function getComposedParent(node: Node): Node | null {
	const parent = node[kParent]!;
	if (parent !== null) {
		return parent;
	}
	return isShadowRoot(node) ? ((node as ShadowRoot)[kHost]! as Node) : null;
}

function getComposedChain(node: Node): Node[] {
	const chain: Node[] = [];
	for (
		let current: Node | null = node;
		current !== null;
		current = getComposedParent(current)
	) {
		chain.push(current);
	}
	chain.reverse();
	return chain;
}

/** A shadow root precedes its host's children. */
function getComposedIndex(node: Node): number {
	return node[kParent] === null && isShadowRoot(node) ? -1 : getNodeIndex(node);
}

// Treats a shadow tree as part of the tree its host is in.
function compareComposedPoints(
	nodeA: Node,
	offsetA: number,
	nodeB: Node,
	offsetB: number,
): number {
	if (nodeA === nodeB) {
		if (offsetA === offsetB) {
			return EQUAL;
		}
		return offsetA < offsetB ? BEFORE : AFTER;
	}
	const chainA = getComposedChain(nodeA);
	const chainB = getComposedChain(nodeB);
	let depth = 0;
	while (
		depth < chainA.length &&
		depth < chainB.length &&
		chainA[depth] === chainB[depth]
	) {
		depth++;
	}
	if (depth === chainA.length) {
		return getComposedIndex(chainB[depth]) < offsetA ? AFTER : BEFORE;
	}
	if (depth === chainB.length) {
		return getComposedIndex(chainA[depth]) < offsetB ? BEFORE : AFTER;
	}
	return getComposedIndex(chainA[depth]) < getComposedIndex(chainB[depth])
		? BEFORE
		: AFTER;
}

// A selection stores each boundary point as a collapsed live range.
function createLivePoint(node: Node, offset: number): Range {
	const point = new Range();
	setRangePoints(point, node, offset, node, offset);
	return point;
}

let selectionUnderConstruction: Document | null = null;

function createSelection(document: Document): Selection {
	selectionUnderConstruction = document;
	try {
		return new Selection();
	} finally {
		selectionUnderConstruction = null;
	}
}

const kRange = Symbol("range");
const kDirection = Symbol("direction");
const kStart = Symbol("start");
const kEnd = Symbol("end");

class Selection implements globalThis.Selection {
	declare [kDocument]?: Document;

	// The range the Range API sees, which lives in a single tree.
	declare [kRange]?: Range | null;

	// The composed boundary points, in tree order, each stored as a
	// collapsed live range so tree mutations move it. A selection that
	// crosses a shadow boundary keeps both of these while its range
	// collapses.
	declare [kStart]?: Range | null;
	declare [kEnd]?: Range | null;
	declare [kDirection]?: "forwards" | "backwards" | "directionless";

	constructor() {
		this[kRange] = null;
		this[kStart] = null;
		this[kEnd] = null;
		this[kDirection] = "directionless";
		if (selectionUnderConstruction === null) {
			throw new TypeError("Selection cannot be constructed");
		}
		this[kDocument] = selectionUnderConstruction;
	}

	get anchorNode(): Node | null {
		const anchor = getAnchorPoint(this);
		if (anchor === null || !isInDocument(this, anchor[0])) {
			return null;
		}
		return anchor[0];
	}

	get anchorOffset(): number {
		const anchor = getAnchorPoint(this);
		if (anchor === null || !isInDocument(this, anchor[0])) {
			return 0;
		}
		return anchor[1];
	}

	get focusNode(): Node | null {
		const focus = getFocusPoint(this);
		if (focus === null || !isInDocument(this, focus[0])) {
			return null;
		}
		return focus[0];
	}

	get focusOffset(): number {
		const focus = getFocusPoint(this);
		if (focus === null || !isInDocument(this, focus[0])) {
			return 0;
		}
		return focus[1];
	}

	get isCollapsed(): boolean {
		const range = this[kRange]!;
		return range === null || range.collapsed;
	}

	get rangeCount(): number {
		return getDocumentRange(this) === null ? 0 : 1;
	}

	get type(): string {
		const range = getDocumentRange(this);
		if (range === null) {
			return "None";
		}
		return range.collapsed ? "Caret" : "Range";
	}

	get direction(): string {
		if (this[kRange] === null) {
			return "none";
		}
		if (this[kDirection] === "forwards") {
			return "forward";
		}
		if (this[kDirection] === "backwards") {
			return "backward";
		}
		return "none";
	}

	getRangeAt(index: number): Range {
		if (arguments.length < 1) {
			throw new TypeError("getRangeAt needs an index");
		}
		const range = getDocumentRange(this);
		if (toUnsignedLong(index) !== 0 || range === null) {
			throw indexSizeError("The selection has no range at that index");
		}
		return range;
	}

	addRange(range: Range): void {
		if (arguments.length < 1) {
			throw new TypeError("addRange needs a range");
		}
		if (!(range instanceof Range)) {
			throw new TypeError("That is not a range");
		}
		if (!isInDocument(this, range[kStartNode]!)) {
			return;
		}
		if (this.rangeCount !== 0) {
			return;
		}
		associateSelectionRange(
			this,
			range,
			[range[kStartNode]!, range[kStartOffset]!],
			[range[kEndNode]!, range[kEndOffset]!],
			"forwards",
		);
	}

	removeRange(range: Range): void {
		if (arguments.length < 1) {
			throw new TypeError("removeRange needs a range");
		}
		if (!(range instanceof Range)) {
			throw new TypeError("That is not a range");
		}
		if (range !== this[kRange]!) {
			throw notFoundError("That range is not the selection's range");
		}
		this.removeAllRanges();
	}

	removeAllRanges(): void {
		const range = this[kRange]!;
		if (range === null) {
			return;
		}
		range[kRangeSelection] = null;
		this[kRange] = null;
		this[kStart] = null;
		this[kEnd] = null;
		this[kDirection] = "directionless";
		scheduleSelectionChange(this[kDocument]!);
	}

	empty(): void {
		this.removeAllRanges();
	}

	getComposedRanges(options?: {shadowRoots?: ShadowRoot[]}): StaticRange[] {
		const dictionary = toDictionary<{shadowRoots?: unknown}>(
			options,
			"getComposedRanges",
		);
		const roots: ShadowRoot[] = [];
		if (
			dictionary.shadowRoots !== undefined &&
			dictionary.shadowRoots !== null
		) {
			for (const root of dictionary.shadowRoots as Iterable<unknown>) {
				if (!(root instanceof ShadowRoot)) {
					throw new TypeError("That is not a shadow root");
				}
				roots.push(root);
			}
		}
		const start = this[kStart]!;
		const end = this[kEnd]!;
		if (start === null || end === null) {
			return [];
		}
		const rescope = (
			node: Node,
			offset: number,
			after: boolean,
		): [Node, number] => {
			let current = node;
			let at = offset;
			for (;;) {
				const root = getRoot(current);
				if (!isShadowRoot(root)) {
					break;
				}
				if (
					roots.some((given) => isShadowIncludingInclusiveAncestor(root, given))
				) {
					break;
				}
				const host = (root as ShadowRoot)[kHost]! as Element;
				at = getNodeIndex(host) + (after ? 1 : 0);
				const parent = host[kParent]!;
				if (parent === null) {
					break;
				}
				current = parent;
			}
			return [current, at];
		};
		const [startNode, startOffset] = rescope(
			start[kStartNode]!,
			start[kStartOffset]!,
			false,
		);
		const [
			endNode,
			endOffset,
		] = rescope(end[kEndNode]!, end[kEndOffset]!, true);
		return [
			new StaticRange({
				startContainer: startNode,
				startOffset,
				endContainer: endNode,
				endOffset,
			}),
		];
	}

	collapse(node: Node | null, offset = 0): void {
		if (arguments.length < 1) {
			throw new TypeError("collapse needs a node");
		}
		if (node === null || node === undefined) {
			this.removeAllRanges();
			return;
		}
		assertBoundaryNode(node);
		const at = toUnsignedLong(offset);
		if (at > getNodeLength(node)) {
			throw indexSizeError("The offset is past the end of the node");
		}
		if (!isShadowIncludingInclusiveAncestor(this[kDocument]!, node)) {
			return;
		}
		const point: [Node, number] = [node, at];
		associateSelectionRange(
			this,
			createRangeBetween(point, point),
			point,
			point,
			this[kDirection]!,
		);
	}

	setPosition(node: Node | null, offset = 0): void {
		if (arguments.length < 1) {
			throw new TypeError("setPosition needs a node");
		}
		this.collapse(node, offset);
	}

	collapseToStart(): void {
		const range = this[kRange]!;
		if (range === null) {
			throw domError("InvalidStateError", "The selection has no range");
		}
		const point: [Node, number] = [range[kStartNode]!, range[kStartOffset]!];
		associateSelectionRange(
			this,
			createRangeBetween(point, point),
			point,
			point,
			this[kDirection]!,
		);
	}

	collapseToEnd(): void {
		const range = this[kRange]!;
		if (range === null) {
			throw domError("InvalidStateError", "The selection has no range");
		}
		const point: [Node, number] = [range[kEndNode]!, range[kEndOffset]!];
		associateSelectionRange(
			this,
			createRangeBetween(point, point),
			point,
			point,
			this[kDirection]!,
		);
	}

	extend(node: Node, offset = 0): void {
		if (arguments.length < 1) {
			throw new TypeError("extend needs a node");
		}
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (!isShadowIncludingInclusiveAncestor(this[kDocument]!, node)) {
			return;
		}
		if (this[kRange] === null) {
			throw domError("InvalidStateError", "The selection has no range");
		}
		const anchor = getAnchorPoint(this) as [Node, number];
		const focus: [Node, number] = [node, toUnsignedLong(offset)];
		const anchorFirst =
			compareComposedPoints(anchor[0], anchor[1], focus[0], focus[1]) !== AFTER;
		const range = anchorFirst
			? createRangeBetween(anchor, focus)
			: createRangeBetween(focus, anchor);
		associateSelectionRange(
			this,
			range,
			anchor,
			focus,
			anchorFirst ? "forwards" : "backwards",
		);
	}

	setBaseAndExtent(
		anchorNode: Node,
		anchorOffset: number,
		focusNode: Node,
		focusOffset: number,
	): void {
		if (arguments.length < 4) {
			throw new TypeError("setBaseAndExtent needs two boundary points");
		}
		if (!(anchorNode instanceof Node) || !(focusNode instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		const anchorAt = toUnsignedLong(anchorOffset);
		const focusAt = toUnsignedLong(focusOffset);
		if (
			anchorAt > getNodeLength(anchorNode) || focusAt > getNodeLength(focusNode)
		) {
			throw indexSizeError("The offset is past the end of the node");
		}
		if (
			!isShadowIncludingInclusiveAncestor(this[kDocument]!, anchorNode) ||
			!isShadowIncludingInclusiveAncestor(this[kDocument]!, focusNode)
		) {
			return;
		}
		const anchor: [Node, number] = [anchorNode, anchorAt];
		const focus: [Node, number] = [focusNode, focusAt];
		const anchorFirst =
			compareComposedPoints(anchorNode, anchorAt, focusNode, focusAt) !== AFTER;
		const range = anchorFirst
			? createRangeBetween(anchor, focus)
			: createRangeBetween(focus, anchor);
		associateSelectionRange(
			this,
			range,
			anchor,
			focus,
			anchorFirst ? "forwards" : "backwards",
		);
	}

	selectAllChildren(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("selectAllChildren needs a node");
		}
		assertBoundaryNode(node);
		if (getRoot(node) !== this[kDocument]!) {
			return;
		}
		let childCount = 0;
		for (let child = node[kFirstChild]!;
			child !== null;
			child = child[kNext]!) {
			childCount++;
		}
		const anchor: [Node, number] = [node, 0];
		const focus: [Node, number] = [node, childCount];
		associateSelectionRange(
			this,
			createRangeBetween(anchor, focus),
			anchor,
			focus,
			"forwards",
		);
	}

	deleteFromDocument(): void {
		const range = getDocumentRange(this);
		if (range === null) {
			return;
		}
		range.deleteContents();
	}

	containsNode(node: Node, allowPartialContainment = false): boolean {
		if (arguments.length < 1) {
			throw new TypeError("containsNode needs a node");
		}
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		const range = this[kRange]!;
		if (range === null || getRoot(node) !== this[kDocument]!) {
			return false;
		}
		if (rangeRoot(range) !== this[kDocument]!) {
			return false;
		}
		const length = getNodeLength(node);
		if (allowPartialContainment) {
			return (
				comparePoints(
					range[kStartNode]!,
					range[kStartOffset]!,
					node,
					length,
				) !==
				AFTER &&
				comparePoints(range[kEndNode]!, range[kEndOffset]!, node, 0) !== BEFORE
			);
		}
		return (
			comparePoints(range[kStartNode]!, range[kStartOffset]!, node, 0) !==
			AFTER &&
			comparePoints(range[kEndNode]!, range[kEndOffset]!, node, length) !==
			BEFORE
		);
	}

	// Keyboard-style motion, in the one place a page can request it.
	// `alter` is "move" (collapse where the motion lands) or "extend" (move
	// the focus there and leave the anchor). A "move" over a range starts
	// from the edge it is heading toward, so a forward character move over a
	// selection collapses to its end without going further, as browsers do.
	// "left" and "right" mean "backward" and "forward"; a right-to-left
	// run's visual order is not followed.
	//
	// "character" and "word" are computed from the text. "line" and
	// "lineboundary" depend on laid-out lines rather than the string, so
	// they need a document attached to a terminal and do nothing without one.
	// A line's ends are its first and last text in tree order, which is its
	// visual order only for left-to-right text. "sentence", "paragraph" and
	// their boundaries are not implemented. Anything unrecognized does
	// nothing, as in a browser.
	modify(alter?: string, direction?: string, granularity?: string): void {
		const how = String(alter ?? "move").toLowerCase();
		const where = String(direction ?? "forward").toLowerCase();
		const unit = String(granularity ?? "character").toLowerCase();
		if (how !== "move" && how !== "extend") {
			return;
		}
		const forward = where === "forward" || where === "right";
		if (!forward && where !== "backward" && where !== "left") {
			return;
		}
		const range = getDocumentRange(this);
		if (range === null) {
			return;
		}
		const extending = how === "extend";
		const from =
			extending
				? (getFocusPoint(this) as [Node, number])
				: forward
					? ([range[kEndNode]!, range[kEndOffset]!] as [Node, number])
					: ([range[kStartNode]!, range[kStartOffset]!] as [Node, number]);
		// Collapsing a range by a character is the whole motion. The caret
		// lands on the edge the direction points at, not one character past it.
		const to =
			!extending && !range.collapsed && unit === "character"
				? from
				: getModifiedPoint(this, from, forward, unit);
		if (to === null) {
			return;
		}
		if (extending) {
			this.extend(to[0], to[1]);
			return;
		}
		this.setBaseAndExtent(to[0], to[1], to[0], to[1]);
	}

	toString(): string {
		const range = this[kRange]!;
		return range === null ? "" : range.toString();
	}
}

// Character and word motion are string operations, and a caret crosses
// from one text node into the next without noticing, so both work on the
// document's painted text as one string rather than one node at a time.
// Built per call. A selection moves at keystroke speed, and a cache of
// the document's text would need invalidating on every mutation.
interface SelectionText {
	text: string;
	parts: Array<{node: Text; start: number}>;
}

// Offsets into the flattened text.
interface SelectionLine {
	y: number;
	start: number;
	end: number;
}

function isPaintedText(
	node: Text,
	layout: Layout | null,
): boolean {
	if (node[kData]!.length === 0) {
		return false;
	}
	if (layout === null) {
		return true;
	}
	for (const fragment of layout.lineFragments(node)) {
		if (fragment.endOffset > fragment.startOffset) {
			return true;
		}
	}
	return false;
}

// The isSelectable filter checks each text node's parent rather than
// pruning the subtree, because user-select: none does not inherit. A
// `text` descendant inside a `none` ancestor is isSelectable again.
function getSelectionTextNodes(
	document: Document,
	attached: AttachedDocument | undefined,
): Text[] {
	const layout = attached === undefined ? null : attached[kLayout];
	const nodes: Text[] = [];
	const collect = (node: Node): void => {
		for (let child = node[kFirstChild]!;
			child !== null;
			child = child[kNext]!) {
			if (child.nodeType === TEXT_NODE) {
				if (
					isPaintedText(child as Text, layout) &&
					(attached === undefined || attached[kCascade].isSelectable(node))
				) {
					nodes.push(child as Text);
				}
			} else if (child.nodeType === ELEMENT_NODE) {
				const name = (child as Element).localName;
				if (name !== "script" && name !== "style" && name !== "template") {
					collect(child);
				}
			}
		}
	};
	const root = document.body ?? document.documentElement;
	if (root !== null) {
		collect(root as unknown as Node);
	}
	return nodes;
}

function flattenSelectionText(nodes: Text[]): SelectionText {
	let text = "";
	const parts: Array<{node: Text; start: number}> = [];
	for (const node of nodes) {
		parts.push({node, start: text.length});
		text += node[kData]!;
	}
	return {text, parts};
}

// Null for a point in unpainted content. An element boundary point sits
// before the child at its offset, so it maps to the first painted text
// at or after that child, or past the last child, to the end of the
// element's text.
function getSelectionIndex(
	run: SelectionText,
	node: Node,
	offset: number,
): number | null {
	if (node.nodeType === TEXT_NODE) {
		for (const part of run.parts) {
			if (part.node === node) {
				return part.start + Math.min(offset, part.node[kData]!.length);
			}
		}
		return null;
	}
	let child = node[kFirstChild]!;
	for (let i = 0; child !== null && i < offset; i++) {
		child = child[kNext]!;
	}
	if (child !== null) {
		for (const part of run.parts) {
			if (isInclusiveAncestor(child, part.node)) {
				return part.start;
			}
		}
	}
	let last: number | null = null;
	for (const part of run.parts) {
		if (isInclusiveAncestor(node, part.node)) {
			last = part.start + part.node[kData]!.length;
		}
	}
	return last;
}

// An offset on the seam between two nodes maps to the earlier node's
// end, which is the same position as the later node's start.
function getSelectionPoint(
	run: SelectionText,
	index: number,
): [Node, number] | null {
	const at = Math.max(0, Math.min(index, run.text.length));
	for (const part of run.parts) {
		if (at <= part.start + part.node[kData]!.length) {
			return [part.node, at - part.start];
		}
	}
	const last = run.parts[run.parts.length - 1];
	return last === undefined ? null : [last.node, last.node[kData]!.length];
}

// Two fragments on the same row are the same line no matter how many
// nodes they came from, so lines are keyed by row.
function getSelectionLines(
	run: SelectionText,
	layout: Layout,
): SelectionLine[] {
	const rows = new Map<number, SelectionLine>();
	for (const part of run.parts) {
		for (const fragment of layout.lineFragments(part.node)) {
			if (fragment.endOffset <= fragment.startOffset) {
				continue;
			}
			const y = Math.round(fragment.rect.y);
			const start = part.start + fragment.startOffset;
			const end = part.start + fragment.endOffset;
			const row = rows.get(y);
			if (row === undefined) {
				rows.set(y, {y, start, end});
			} else {
				row.start = Math.min(row.start, start);
				row.end = Math.max(row.end, end);
			}
		}
	}
	return [...rows.values()].sort((a, b) => a.y - b.y);
}

// A caret exactly at a soft wrap belongs to the next line's start. Both
// lines claim the offset and the later one wins, the same rule the
// textarea's vertical motion uses.
function getSelectionLine(lines: SelectionLine[], index: number): number {
	for (let i = 0; i < lines.length; i++) {
		if (index <= lines[i].end) {
			const next = lines[i + 1];
			if (next !== undefined && next.start <= index) {
				continue;
			}
			return i;
		}
	}
	return lines.length - 1;
}

function getCaretColumn(
	document: Document,
	layout: Layout,
	point: [Node, number],
): number | null {
	const range = document.createRange();
	range.setStart(point[0] as unknown as globalThis.Node, point[1]);
	range.setEnd(point[0] as unknown as globalThis.Node, point[1]);
	const rect = layout.getRangeRects(range)[0];
	return rect === undefined ? null : rect.x;
}

// Moving up from the first line or down from the last line goes to that
// line's end, as a browser's arrow key does. The column is a screen
// column and the target is a screen row, so the landing offset comes
// from the layout's hit test, the same result a click there would give.
function selectionLineMove(
	document: Document,
	run: SelectionText,
	layout: Layout,
	index: number,
	forward: boolean,
): [Node, number] | null {
	const lines = getSelectionLines(run, layout);
	if (lines.length === 0) {
		return null;
	}
	const at = getSelectionLine(lines, index);
	const target = at + (forward ? 1 : -1);
	if (target < 0) {
		return getSelectionPoint(run, lines[0].start);
	}
	if (target >= lines.length) {
		return getSelectionPoint(run, lines[lines.length - 1].end);
	}
	const here = getSelectionPoint(run, index);
	const column = here === null ? null : getCaretColumn(document, layout, here);
	const root = document.body ?? document.documentElement;
	const found =
		column === null || root === null
			? null
			: layout.caretPositionFromPoint(
				column,
				lines[target].y,
				root as unknown as globalThis.Node,
				true,
			);
	if (found === null) {
		return getSelectionPoint(run, lines[target].start);
	}
	return [found.node as unknown as Node, found.offset];
}

function getModifiedPoint(
	selection: Selection,
	from: [Node, number],
	forward: boolean,
	granularity: string,
): [Node, number] | null {
	const document = selection[kDocument]!;
	const attached = getAttachedDocument(document);
	const layout = attached === undefined ? null : attached[kLayout];
	if (layout === null) {
		if (granularity === "line" || granularity === "lineboundary") {
			return null;
		}
	} else {
		// Lines are read from the layout in the same turn, so whatever the page
		// just mutated has to be laid out first.
		layout.performLayout();
	}
	const run = flattenSelectionText(getSelectionTextNodes(document, attached));
	if (run.parts.length === 0) {
		return null;
	}
	const index = getSelectionIndex(run, from[0], from[1]);
	if (index === null) {
		return null;
	}
	if (granularity === "character") {
		return getSelectionPoint(
			run,
			forward
				? getNextGraphemeBoundary(run.text, index)
				: getPreviousGraphemeBoundary(run.text, index),
		);
	}
	if (granularity === "word") {
		return getSelectionPoint(
			run,
			forward
				? getWordEnd(run.text, index)
				: getWordStart(run.text, index),
		);
	}
	if (granularity === "documentboundary") {
		return getSelectionPoint(run, forward ? run.text.length : 0);
	}
	if (layout === null) {
		return null;
	}
	if (granularity === "lineboundary") {
		const lines = getSelectionLines(run, layout);
		if (lines.length === 0) {
			return null;
		}
		const line = lines[getSelectionLine(lines, index)];
		return getSelectionPoint(run, forward ? line.end : line.start);
	}
	if (granularity === "line") {
		return selectionLineMove(document, run, layout, index, forward);
	}
	return null;
}

function isInDocument(selection: Selection, node: Node): boolean {
	return getShadowIncludingRoot(node) === selection[kDocument]!;
}

// The selection has a range while its range is in the document,
// including a shadow tree of the document. A range that has left the
// document is not returned.
function getDocumentRange(selection: Selection): Range | null {
	const range = selection[kRange]!;
	if (range === null) {
		return null;
	}
	return isInDocument(selection, range[kStartNode]!) ? range : null;
}

function getAnchorPoint(selection: Selection): [Node, number] | null {
	const range = selection[kRange]!;
	if (range === null) {
		return null;
	}
	return selection[kDirection] === "forwards"
		? [range[kStartNode]!, range[kStartOffset]!]
		: [range[kEndNode]!, range[kEndOffset]!];
}

function getFocusPoint(selection: Selection): [Node, number] | null {
	const range = selection[kRange]!;
	if (range === null) {
		return null;
	}
	return selection[kDirection] === "forwards"
		? [range[kEndNode]!, range[kEndOffset]!]
		: [range[kStartNode]!, range[kStartOffset]!];
}

function createRangeBetween(start: [Node, number], end: [Node, number]): Range {
	const range = new Range();
	setRangeBoundary(range, start[0], start[1], true);
	setRangeBoundary(range, end[0], end[1], false);
	return range;
}

function associateSelectionRange(
	selection: Selection,
	range: Range,
	anchor: [Node, number],
	focus: [Node, number],
	direction: "forwards" | "backwards" | "directionless",
): void {
	const previous = selection[kRange]!;
	if (previous !== null) {
		previous[kRangeSelection] = null;
	}
	selection[kRange] = range;
	range[kRangeSelection] = selection;
	const anchorFirst =
		compareComposedPoints(anchor[0], anchor[1], focus[0], focus[1]) !== AFTER;
	const start = anchorFirst ? anchor : focus;
	const end = anchorFirst ? focus : anchor;
	selection[kStart] = createLivePoint(start[0], start[1]);
	selection[kEnd] = createLivePoint(end[0], end[1]);
	selection[kDirection] = direction;
	scheduleSelectionChange(selection[kDocument]!);
}

// The composed point that the change moved follows it. A range that
// leaves the document takes the selection with it.
function selectionChanged(
	selection: Selection,
	which: "start" | "end" | "both",
): void {
	const range = selection[kRange]!;
	if (range === null) {
		return;
	}
	if (!isInDocument(selection, range[kStartNode]!)) {
		selection.removeAllRanges();
		return;
	}
	const start = createLivePoint(range[kStartNode]!, range[kStartOffset]!);
	const end = createLivePoint(range[kEndNode]!, range[kEndOffset]!);
	if (
		which === "both" || selection[kStart] === null || selection[kEnd] === null
	) {
		selection[kStart] = start;
		selection[kEnd] = end;
	} else if (which === "start") {
		selection[kStart] = start;
		if (getComposedOrder(start, selection[kEnd]!) === AFTER) {
			selection[kEnd] = start;
		}
	} else {
		selection[kEnd] = end;
		if (getComposedOrder(end, selection[kStart]!) === BEFORE) {
			selection[kStart] = end;
		}
	}
	scheduleSelectionChange(selection[kDocument]!);
}

function getComposedOrder(point: Range, other: Range): number {
	return compareComposedPoints(
		point[kStartNode]!,
		point[kStartOffset]!,
		other[kStartNode]!,
		other[kStartOffset]!,
	);
}

ceReactions(Selection.prototype, ["deleteFromDocument"]);

Object.defineProperty(Selection.prototype, Symbol.toStringTag, {
	value: "Selection",
	configurable: true,
});

const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
const FILTER_SKIP = 3;

type NodeFilterInput =
	((node: Node) => number) |
	{acceptNode(node: Node): number} |
	null |
	undefined;

export const NodeFilter = {
	FILTER_ACCEPT,
	FILTER_REJECT,
	FILTER_SKIP,
	SHOW_ALL: 0xffffffff,
	SHOW_ELEMENT: 0x1,
	SHOW_ATTRIBUTE: 0x2,
	SHOW_TEXT: 0x4,
	SHOW_CDATA_SECTION: 0x8,
	SHOW_ENTITY_REFERENCE: 0x10,
	SHOW_ENTITY: 0x20,
	SHOW_PROCESSING_INSTRUCTION: 0x40,
	SHOW_COMMENT: 0x80,
	SHOW_DOCUMENT: 0x100,
	SHOW_DOCUMENT_TYPE: 0x200,
	SHOW_DOCUMENT_FRAGMENT: 0x400,
	SHOW_NOTATION: 0x800,
};

Object.freeze(NodeFilter);

/**
 * A private `whatToShow` bit that requests the FLAT tree rather than the
 * node tree: shadow content in its slot's place, and pseudo-element nodes
 * among the children they belong beside.
 *
 * It lives in `whatToShow` because that argument already says what a walk
 * is interested in, and because the bit is inert in the only test that
 * reads it: acceptance computes `1 << (nodeType - 1)`, and the highest
 * node type (NOTATION, 12) reaches 0x800, so no node type can produce this
 * bit. It is private because the flat tree is the box tree's view, not
 * something a page should be able to request. `Document.createTreeWalker`
 * masks it off, which also stops the SHOW_ALL default from making every
 * walk flat.
 */
export const SHOW_FLAT = 0x1000;

function filterNode(
	traverser: {
		whatToShow: number;
		filter: NodeFilterInput;
		active: {value: boolean};
	},
	node: Node,
): number {
	if (traverser.active.value) {
		throw domError("InvalidStateError", "The filter is already running");
	}
	if (((1 << (node.nodeType - 1)) & traverser.whatToShow) === 0) {
		return FILTER_SKIP;
	}
	const filter = traverser.filter;
	if (filter == null) {
		return FILTER_ACCEPT;
	}
	traverser.active.value = true;
	let result: unknown;
	try {
		result =
			typeof filter === "function"
				? filter(node)
				: (filter as {acceptNode(node: Node): number}).acceptNode(node);
	} finally {
		traverser.active.value = false;
	}
	return toUnsignedLong(result);
}

function precedingWithin(node: Node, root: Node): Node | null {
	if (node === root) {
		return null;
	}
	let previous = node[kPrevious]!;
	if (previous === null) {
		return node[kParent]!;
	}
	while (previous[kLastChild] !== null) {
		previous = previous[kLastChild]! as Node;
	}
	return previous;
}

const kReference = Symbol("reference");
const kWhatToShow = Symbol("whatToShow");
const kFilter = Symbol("filter");
const kPointerBefore = Symbol("pointerBefore");
const kActive = Symbol("active");

class NodeIterator {
	declare [kRoot]?: Node;
	declare [kReference]?: Node;
	declare [kPointerBefore]?: boolean;
	declare [kWhatToShow]?: number;
	declare [kFilter]?: NodeFilterInput;
	declare [kActive]?: {value: boolean};

	constructor(root: Node, whatToShow: number, filter: NodeFilterInput) {
		this[kPointerBefore] = true;
		this[kActive] = {value: false};
		this[kRoot] = root;
		this[kReference] = root;
		this[kWhatToShow] = whatToShow;
		this[kFilter] = filter ?? null;
	}

	get root(): Node {
		return this[kRoot]!;
	}

	get referenceNode(): Node {
		return this[kReference]!;
	}

	get pointerBeforeReferenceNode(): boolean {
		return this[kPointerBefore]!;
	}

	get whatToShow(): number {
		return this[kWhatToShow]!;
	}

	get filter(): NodeFilterInput {
		return this[kFilter]!;
	}

	nextNode(): Node | null {
		return traverseIterator(this, true);
	}

	previousNode(): Node | null {
		return traverseIterator(this, false);
	}

	detach(): void {
		// The spec makes this a no-op.
	}
}

function traverseIterator(
	iterator: NodeIterator,
	forward: boolean,
): Node | null {
	let node: Node | null = iterator[kReference]!;
	let before = iterator[kPointerBefore]!;
	const state = {
		whatToShow: iterator[kWhatToShow]!,
		filter: iterator[kFilter]!,
		active: iterator[kActive]!,
	};
	for (;;) {
		if (forward) {
			if (!before) {
				node = nextInTree(node as Node, iterator[kRoot]!);
				if (node === null) {
					return null;
				}
			} else {
				before = false;
			}
		} else {
			if (before) {
				node = precedingWithin(node as Node, iterator[kRoot]!);
				if (node === null) {
					return null;
				}
			} else {
				before = true;
			}
		}
		if (filterNode(state, node as Node) === FILTER_ACCEPT) {
			// A filter that removed the node it was filtering leaves the
			// reference where the pre-removing steps put it. A node outside the
			// root can never be the reference.
			if (isInclusiveAncestor(iterator[kRoot]!, node as Node)) {
				iterator[kReference] = node as Node;
				iterator[kPointerBefore] = before;
			}
			break;
		}
	}
	return node;
}

function preRemoveFromIterator(
	iterator: NodeIterator,
	toBeRemoved: Node,
): void {
	if (
		!isInclusiveAncestor(toBeRemoved, iterator[kReference]!) ||
		isInclusiveAncestor(toBeRemoved, iterator[kRoot]!)
	) {
		return;
	}
	if (iterator[kPointerBefore]!) {
		let next = nextInTree(toBeRemoved, iterator[kRoot]!);
		while (next !== null && isInclusiveAncestor(toBeRemoved, next)) {
			next = nextInTree(next, iterator[kRoot]!);
		}
		if (next !== null) {
			iterator[kReference] = next;
			return;
		}
		iterator[kPointerBefore] = false;
	}
	const previous = toBeRemoved[kPrevious]!;
	if (previous === null) {
		iterator[kReference] = toBeRemoved[kParent]! as Node;
		return;
	}
	let last: Node = previous;
	while (last[kLastChild] !== null) {
		last = last[kLastChild]! as Node;
	}
	iterator[kReference] = last;
}

Object.defineProperty(NodeIterator.prototype, Symbol.toStringTag, {
	value: "NodeIterator",
	configurable: true,
});

const kCurrent = Symbol("current");

export class TreeWalker implements globalThis.TreeWalker {
	declare [kRoot]?: Node;
	declare [kCurrent]?: Node;
	declare [kWhatToShow]?: number;
	declare [kFilter]?: NodeFilterInput;
	declare [kActive]?: {value: boolean};

	// Decided at construction and read on every hop.
	declare [kLinks]?: TreeLinks;

	constructor(root: Node, whatToShow: number, filter: NodeFilterInput) {
		this[kActive] = {value: false};
		this[kRoot] = root;
		this[kCurrent] = root;
		this[kWhatToShow] = whatToShow;
		this[kFilter] = filter ?? null;
		this[kLinks] = getTreeLinks(whatToShow);
	}

	get root(): globalThis.Node {
		return this[kRoot]! as unknown as globalThis.Node;
	}

	get whatToShow(): number {
		return this[kWhatToShow]!;
	}

	get filter(): globalThis.NodeFilter | null {
		return this[kFilter]! as globalThis.NodeFilter | null;
	}

	get currentNode(): globalThis.Node {
		return this[kCurrent]! as unknown as globalThis.Node;
	}

	set currentNode(node: globalThis.Node) {
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		this[kCurrent] = node as Node;
	}

	get [kState](): {
		whatToShow: number;
		filter: NodeFilterInput;
		active: {value: boolean};
	} {
		return {
			whatToShow: this[kWhatToShow]!,
			filter: this[kFilter]!,
			active: this[kActive]!,
		};
	}

	parentNode(): globalThis.Node | null {
		return walkParent(this) as unknown as globalThis.Node | null;
	}

	firstChild(): globalThis.Node | null {
		return walkChildren(this, true) as unknown as globalThis.Node | null;
	}

	lastChild(): globalThis.Node | null {
		return walkChildren(this, false) as unknown as globalThis.Node | null;
	}

	previousSibling(): globalThis.Node | null {
		return walkSiblings(this, false) as unknown as globalThis.Node | null;
	}

	nextSibling(): globalThis.Node | null {
		return walkSiblings(this, true) as unknown as globalThis.Node | null;
	}

	previousNode(): globalThis.Node | null {
		return walkPrevious(this) as unknown as globalThis.Node | null;
	}

	nextNode(): globalThis.Node | null {
		return walkNext(this) as unknown as globalThis.Node | null;
	}
}

// A walk's whatToShow never changes after construction, so the choice
// is made once, there, and every hop below is a text control read.
function getTreeLinks(whatToShow: number): TreeLinks {
	return (whatToShow & SHOW_FLAT) !== 0 ? FLAT_LINKS : NODE_LINKS;
}

// DOM Standard, "traverse children".
function walkChildren(walk: TreeWalker, first: boolean): Node | null {
	let node: Node | null =
		first
			? walk[kLinks]!.firstChild(walk[kCurrent]!)
			: walk[kLinks]!.lastChild(walk[kCurrent]!);
	while (node !== null) {
		const result = filterNode(walk[kState]!, node);
		if (result === FILTER_ACCEPT) {
			walk[kCurrent] = node;
			return node;
		}
		if (result === FILTER_SKIP) {
			const child =
				first ? walk[kLinks]!.firstChild(node) : walk[kLinks]!.lastChild(node);
			if (child !== null) {
				node = child;
				continue;
			}
		}
		for (;;) {
			const sibling =
				first
					? walk[kLinks]!.nextSibling(node)
					: walk[kLinks]!.previousSibling(node);
			if (sibling !== null) {
				node = sibling;
				break;
			}
			const parent: Node | null = walk[kLinks]!.parent(node);
			if (
				parent === null ||
				parent === walk[kRoot] ||
				parent === walk[kCurrent]!
			) {
				return null;
			}
			node = parent;
		}
	}
	return null;
}

// DOM Standard, "traverse siblings". A walk rooted at a node never
// visits that node's siblings. Returning one would escape the subtree
// the walk was scoped to, which is how an empty inline element once
// measured the width of the sibling after it.
function walkSiblings(walk: TreeWalker, next: boolean): Node | null {
	let node = walk[kCurrent]!;
	if (node === walk[kRoot]!) {
		return null;
	}
	for (;;) {
		let sibling =
			next
				? walk[kLinks]!.nextSibling(node)
				: walk[kLinks]!.previousSibling(node);
		while (sibling !== null) {
			node = sibling;
			const result = filterNode(walk[kState]!, node);
			if (result === FILTER_ACCEPT) {
				walk[kCurrent] = node;
				return node;
			}
			sibling =
				next ? walk[kLinks]!.firstChild(node) : walk[kLinks]!.lastChild(node);
			if (result === FILTER_REJECT || sibling === null) {
				sibling =
					next
						? walk[kLinks]!.nextSibling(node)
						: walk[kLinks]!.previousSibling(node);
			}
		}
		const parent = walk[kLinks]!.parent(node);
		if (parent === null || parent === walk[kRoot]!) {
			return null;
		}
		node = parent;
		if (filterNode(walk[kState]!, node) === FILTER_ACCEPT) {
			return null;
		}
	}
}

function walkParent(walk: TreeWalker): Node | null {
	let node: Node | null = walk[kCurrent]!;
	while (node !== null && node !== walk[kRoot]!) {
		node = walk[kLinks]!.parent(node);
		if (node !== null && filterNode(walk[kState]!, node) === FILTER_ACCEPT) {
			walk[kCurrent] = node;
			return node;
		}
	}
	return null;
}

// Down to the first child, else to the next sibling, else up until some level
// has one. The climb asks each level for its OWN next sibling, starting at the
// node itself. That lets a hop return the result for the level it is asked
// about: an element's ::after follows the last of its content, and the flat
// hops return it at that step.
function walkNext(walk: TreeWalker): Node | null {
	let node = walk[kCurrent]!;
	let result = FILTER_ACCEPT;
	for (;;) {
		while (result !== FILTER_REJECT) {
			const child = walk[kLinks]!.firstChild(node);
			if (child === null) {
				break;
			}
			node = child;
			result = filterNode(walk[kState]!, node);
			if (result === FILTER_ACCEPT) {
				walk[kCurrent] = node;
				return node;
			}
		}
		let sibling: Node | null = null;
		let temporary: Node | null = node;
		while (temporary !== null) {
			if (temporary === walk[kRoot]!) {
				return null;
			}
			sibling = walk[kLinks]!.nextSibling(temporary);
			if (sibling !== null) {
				break;
			}
			temporary = walk[kLinks]!.parent(temporary);
		}
		if (sibling === null) {
			return null;
		}
		node = sibling;
		result = filterNode(walk[kState]!, node);
		if (result === FILTER_ACCEPT) {
			walk[kCurrent] = node;
			return node;
		}
	}
}

function walkPrevious(walk: TreeWalker): Node | null {
	let node = walk[kCurrent]!;
	while (node !== walk[kRoot]!) {
		let sibling = walk[kLinks]!.previousSibling(node);
		while (sibling !== null) {
			node = sibling;
			let result = filterNode(walk[kState]!, node);
			for (;;) {
				if (result === FILTER_REJECT) {
					break;
				}
				const child = walk[kLinks]!.lastChild(node);
				if (child === null) {
					break;
				}
				node = child;
				result = filterNode(walk[kState]!, node);
			}
			if (result === FILTER_ACCEPT) {
				walk[kCurrent] = node;
				return node;
			}
			sibling = walk[kLinks]!.previousSibling(node);
		}
		const parent = walk[kLinks]!.parent(node);
		if (parent === null) {
			return null;
		}
		node = parent;
		if (filterNode(walk[kState]!, node) === FILTER_ACCEPT) {
			walk[kCurrent] = node;
			return node;
		}
	}
	return null;
}

Object.defineProperty(TreeWalker.prototype, Symbol.toStringTag, {
	value: "TreeWalker",
	configurable: true,
});

// Hover is not a mutation and no attribute records it. The engine
// writes it here as motion reports arrive, and the `:hover` resolver
// reads it. Absent means nothing is hovered, because the document has no
// motion reporting or the pointer left.
const hoveredElements = new WeakMap<Document, Element>();

/** Record what `:hover` should match. */
export function setHoveredElement(
	document: globalThis.Document,
	element: globalThis.Element | null,
): void {
	if (element === null) {
		hoveredElements.delete(document as Document);
	} else {
		hoveredElements.set(document as Document, element as Element);
	}
}

const focusVisibleDocuments = new WeakMap<Document, boolean>();

/**
 * A focus ring depends on how focus was moved: a key shows one, a click
 * does not. The input handler sets this, and the cascade repaints when it
 * changes. Returns whether it changed.
 */
export function setDocumentFocusVisible(
	document: globalThis.Document,
	active: boolean,
): boolean {
	const node = document as Document;
	if ((focusVisibleDocuments.get(node) ?? true) === active) {
		return false;
	}
	focusVisibleDocuments.set(node, active);
	return true;
}

/** Also true for a host above the focused element. */
function hasFocus(element: Element): boolean {
	const active = element[kDocument]![kActiveElement]!;
	if (active === null) {
		return false;
	}
	if (element === active) {
		return true;
	}
	for (
		let root = getRoot(active as unknown as Node);
		isShadowRoot(root);
		root = getRoot(root)
	) {
		const host = (root as ShadowRoot)[kHost]! as unknown as Element;
		if (host === element) {
			return true;
		}
		root = host as unknown as Node;
	}
	return false;
}

function getPartNames(element: Element): string[] {
	const value = element.getAttribute("part");
	return value === null ? [] : splitOnASCIIWhitespace(value);
}

/** Whether `:target` matches. */
function isTargetElement(element: Element): boolean {
	const document = element[kDocument]!;
	if (getRoot(element as unknown as Node) !== (document as unknown as Node)) {
		return false;
	}
	const url = document[kDocumentURL]!;
	const hash = url.indexOf("#");
	if (hash === -1) {
		return false;
	}
	const fragment = url.slice(hash + 1);
	if (fragment === "") {
		return false;
	}
	let decoded = fragment;
	try {
		decoded = decodeURIComponent(fragment);
	} catch (_err) {
		// A fragment that is not valid percent-encoding is used as-is.
	}
	const id = element.getAttribute("id");
	if (id === decoded || id === fragment) {
		return true;
	}
	// The `a` element's name attribute is the old way to write an anchor.
	return (
		element.namespaceURI === HTML_NAMESPACE &&
		element.localName === "a" &&
		element.getAttribute("name") === decoded
	);
}

function isPlaceholderShown(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	if (name !== "input" && name !== "textarea") {
		return false;
	}
	const placeholder = element.getAttribute("placeholder");
	if (
		placeholder === null || placeholder === "" || /[\r\n]/.test(placeholder)
	) {
		return false;
	}
	if (
		name === "input" && !PLACEHOLDER_INPUT_TYPES.has(getInputTypeValue(element))
	) {
		return false;
	}
	return (element as unknown as {value: string}).value === "";
}

const PLACEHOLDER_INPUT_TYPES = new Set([
	"email",
	"number",
	"password",
	"search",
	"tel",
	"text",
	"url",
]);

function getInputTypeValue(element: Element): string {
	return toASCIILowercase(element.getAttribute("type") ?? "text");
}

function isDefaultControl(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	if (name === "option") {
		return element.getAttribute("selected") !== null;
	}
	if (name === "input") {
		const type = getInputTypeValue(element);
		if (type === "checkbox" || type === "radio") {
			return element.getAttribute("checked") !== null;
		}
	}
	if (name !== "button" && name !== "input") {
		return false;
	}
	const type = name === "button"
		? toASCIILowercase(element.getAttribute("type") ?? "submit")
		: getInputTypeValue(element);
	if (type !== "submit" && type !== "image") {
		return false;
	}
	const form = (element as unknown as {form?: Element | null}).form ?? null;
	if (form === null) {
		return false;
	}
	// The default button is the first submit button in tree order.
	for (const candidate of form.querySelectorAll(
		"button, input",
	) as unknown as Iterable<Element>) {
		const local = candidate.localName;
		const kind = local === "button"
			? toASCIILowercase(candidate.getAttribute("type") ?? "submit")
			: getInputTypeValue(candidate);
		if (kind === "submit" || kind === "image") {
			return candidate === element;
		}
	}
	return false;
}

/** Whether `:open` matches. */
function isOpenElement(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	switch (element.localName) {
		case "details":
		case "dialog":
			return element.getAttribute("open") !== null;
		case "select":
			return (
				(element as unknown as {
					[kPickerHighlight]?: unknown;
				})[kPickerHighlight] !=
				null
			);
		default:
			return false;
	}
}

// State a selector cannot read from the node itself: state the user
// agent keeps, a flat-tree link the node tree lacks, or a fact about the
// element's document. A headless tree uses the same functions, and the
// states simply return false.
function getShadowHost(root: Node): Element | null {
	return isShadowRoot(root) ? (root as ShadowRoot)[kHost]! : null;
}

function getOpenAssignedSlot(element: Element): Element | null {
	return (element.assignedSlot as Element | null) ?? null;
}

function isHTMLNode(node: Node): boolean {
	return isHTMLDocument(node[kDocument]!);
}

function isInQuirksMode(node: Node): boolean {
	return node[kDocument]![kMode] === "quirks";
}

// True for the element and anything it contains in the FLAT tree, which
// slot projection reorders relative to the node tree.
function isHovered(element: Element): boolean {
	const document = element[kDocument]!;
	for (
		let node: Element | null = hoveredElements.get(document) ?? null;
		node !== null;
		node = flatParentElement<Element>(node)
	) {
		if (node === element) {
			return true;
		}
	}
	return false;
}

function isFocusVisible(element: Element): boolean {
	const document = element[kDocument]!;
	return (focusVisibleDocuments.get(document) ?? true) && hasFocus(element);
}

// The climb continues past every shadow host above the focused element,
// which is where the node tree's parent chain ends.
function hasFocusWithin(element: Element): boolean {
	let node: Element | null = element[kDocument]![kActiveElement]!;
	while (node !== null) {
		if (node === element) {
			return true;
		}
		const parent = node.parentElement as unknown as Element | null;
		if (parent !== null) {
			node = parent;
			continue;
		}
		const root = getRoot(node);
		node = isShadowRoot(root) ? (root as ShadowRoot)[kHost]! : null;
	}
	return false;
}

function isFullscreenElement(element: Element): boolean {
	const stack = fullscreenStacks.get(element[kDocument]!);
	return stack !== undefined && stack.includes(element);
}

function isDefinedElement(element: Element): boolean {
	return element[kCustomState] !== "undefined";
}

function hasCustomState(element: Element, name: string): boolean {
	const internals = element[kInternals] ?? null;
	const states = internals === null ? null : (internals[kStates] ?? null);
	return states !== null && states[kStates]!.has(name);
}

function isCheckedControl(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	if (element.localName === "option") {
		return (element as unknown as HTMLOptionElement).selected;
	}
	if (element.localName !== "input") {
		return false;
	}
	const type = getInputTypeValue(element);
	return (
		(type === "checkbox" || type === "radio") &&
		(element as unknown as HTMLInputElement).checked
	);
}

function isIndeterminateControl(element: Element): boolean {
	if (
		element.namespaceURI !== HTML_NAMESPACE ||
		element.localName !== "input"
	) {
		return false;
	}
	return (
		getInputTypeValue(element) === "checkbox" &&
		(element as unknown as HTMLInputElement).indeterminate
	);
}

/** A selector the matcher rejects becomes a SyntaxError, per the DOM. */
function asSyntaxError(error: unknown): unknown {
	return error instanceof SelectorError
		? domError("SyntaxError", error.message)
		: error;
}

interface ParseAttribute {
	name: string;
	value: string;
	namespace?: string;
	prefix?: string;
}

// A fragment parsed into an element uses that element's registry, and a
// document's own markup uses the document's. This holds whichever parse
// is running.
let parseRegistry: CustomElementRegistry | null | undefined = undefined;

// Every node the adapter creates belongs to the document it was made
// for, and every insertion runs the same algorithm appendChild runs, so a
// parsed tree and a scripted tree are the same tree.
// The return type is parse5's structural TreeAdapter, spelled by the object.
// eslint-disable-next-line @b9g/explicit-declaration-return-type
function createTreeAdapter(document: Document | null) {
	let target = document;
	const adapter = {
		createDocument(): Document {
			const created = new Document();
			created[kType] = "html";
			created[kContentType] = "text/html";
			if (target === null) {
				target = created;
			}
			return created;
		},
		createDocumentFragment(): DocumentFragment {
			return (target as Document)
				.createDocumentFragment() as unknown as DocumentFragment;
		},
		createElement(
			tagName: string,
			namespaceURI: string,
			attrs: ParseAttribute[],
		): Element {
			const element = createElementInternal(
				target as Document,
				tagName,
				namespaceURI,
				null,
				null,
				false,
				parseRegistry,
			);
			adapter.adoptAttributes(element, attrs);
			return element;
		},
		createCommentNode(data: string): Comment {
			return (target as Document).createComment(data) as unknown as Comment;
		},
		createTextNode(value: string): Text {
			return (target as Document).createTextNode(
				value,
			) as unknown as Text;
		},
		appendChild(parentNode: Node, newNode: Node): void {
			insertNode(newNode, parentNode, null, true);
		},
		insertBefore(parentNode: Node, newNode: Node, referenceNode: Node): void {
			insertNode(newNode, parentNode, referenceNode, true);
		},
		setTemplateContent(
			templateElement: Element,
			contentElement: DocumentFragment,
		): void {
			contentElement[kHost] = templateElement;
			(templateElement as HTMLTemplateElement)[kTemplateContent] =
				contentElement;
		},
		getTemplateContent(templateElement: Element): DocumentFragment {
			return (templateElement as HTMLTemplateElement).content;
		},
		setDocumentType(
			documentNode: Document,
			name: string,
			publicId: string,
			systemId: string,
		): void {
			const existing = documentNode.doctype as unknown as DocumentType | null;
			if (existing !== null) {
				existing[kName] = name;
				existing[kPublicId] = publicId;
				existing[kSystemId] = systemId;
				return;
			}
			const doctype = new DocumentType(name, publicId, systemId);
			doctype[kDocument] = documentNode;
			insertNode(doctype, documentNode, null, true);
		},
		setDocumentMode(
			documentNode: Document,
			mode: "no-quirks" | "quirks" | "limited-quirks",
		): void {
			documentNode[kMode] = mode;
		},
		getDocumentMode(documentNode: Document): string {
			return documentNode[kMode]!;
		},
		detachNode(node: Node): void {
			removeNode(node, true);
		},
		insertText(parentNode: Node, text: string): void {
			const last = parentNode[kLastChild]!;
			if (last !== null && last.nodeType === TEXT_NODE) {
				(last as CharacterData)[kData]! += text;
				return;
			}
			adapter.appendChild(
				parentNode,
				(target as Document).createTextNode(text) as unknown as Text,
			);
		},
		insertTextBefore(
			parentNode: Node,
			text: string,
			referenceNode: Node,
		): void {
			const previous = referenceNode[kPrevious]!;
			if (previous !== null && previous.nodeType === TEXT_NODE) {
				(previous as CharacterData)[kData]! += text;
				return;
			}
			adapter.insertBefore(
				parentNode,
				(target as Document).createTextNode(text) as unknown as Text,
				referenceNode,
			);
		},
		adoptAttributes(recipient: Element, attrs: ParseAttribute[]): void {
			for (const attribute of attrs) {
				const namespace = attribute.namespace ?? null;
				const prefix = attribute.prefix ?? null;
				const localName = attribute.name;
				if (getAttributeByNamespace(recipient, namespace, localName) !== null) {
					continue;
				}
				const created = new Attr(namespace, prefix, localName, attribute.value);
				created[kDocument] = recipient[kDocument]!;
				appendAttribute(recipient, created);
			}
		},
		getFirstChild(node: Node): Node | null {
			return node[kFirstChild]!;
		},
		getChildNodes(node: Node): Node[] {
			return getChildNodeArray(node);
		},
		getParentNode(node: Node): Node | null {
			return node[kParent]!;
		},
		getAttrList(element: Element): ParseAttribute[] {
			return element[kAttributeList]!.map((attribute) => ({
				name: attribute[kQualifiedName]!,
				value: attribute[kValue]!,
				namespace: attribute[kNamespace] ?? undefined,
				prefix: attribute[kPrefix] ?? undefined,
			}));
		},
		getTagName(element: Element): string {
			return element[kQualifiedName]!;
		},
		getNamespaceURI(element: Element): string {
			return element[kNamespace]! as string;
		},
		getTextNodeContent(textNode: CharacterData): string {
			return textNode[kData]!;
		},
		getCommentNodeContent(commentNode: CharacterData): string {
			return commentNode[kData]!;
		},
		getDocumentTypeNodeName(doctypeNode: DocumentType): string {
			return doctypeNode[kName]!;
		},
		getDocumentTypeNodePublicId(doctypeNode: DocumentType): string {
			return doctypeNode[kPublicId]!;
		},
		getDocumentTypeNodeSystemId(doctypeNode: DocumentType): string {
			return doctypeNode[kSystemId]!;
		},
		isTextNode(node: Node): boolean {
			return node.nodeType === TEXT_NODE;
		},
		isCommentNode(node: Node): boolean {
			return node.nodeType === COMMENT_NODE;
		},
		isDocumentTypeNode(node: Node): boolean {
			return node.nodeType === DOCUMENT_TYPE_NODE;
		},
		isElementNode(node: Node): boolean {
			return node.nodeType === ELEMENT_NODE;
		},
		setNodeSourceCodeLocation(): void {},
		getNodeSourceCodeLocation(): undefined {
			return undefined;
		},
		updateNodeSourceCodeLocation(): void {},
	};
	return adapter;
}

// A declarative shadow root that asks to be scoped has no registry until
// one claims it, and neither does anything the parser put inside it. A
// shadow tree further down keeps whatever registry it was given.
function dropRegistry(node: Node): void {
	node[kRegistry] = null;
	for (let child = node[kFirstChild]!; child !== null; child = child[kNext]!) {
		dropRegistry(child);
	}
}

// The HTML parser attaches a shadow root as soon as it sees a template
// whose shadowrootmode names a mode. parse5 has no such step, so the
// templates land as templates and this walk converts them afterwards. It
// goes depth-first over the given tree and then over each shadow tree it
// creates, which reaches a nested declarative root. A template whose
// parent cannot host a shadow tree, or already hosts one, stays a
// template, which is the parser's own error handling.
function attachDeclarativeShadowRoots(root: Node): void {
	for (const child of getChildNodeArray(root)) {
		if (child.nodeType !== ELEMENT_NODE) {
			continue;
		}
		const element = child as Element;
		if (
			element[kNamespace] === HTML_NAMESPACE &&
			element[kLocalName] === "template"
		) {
			if (!attachDeclarativeShadowRoot(element as HTMLTemplateElement)) {
				attachDeclarativeShadowRoots((element as HTMLTemplateElement).content);
			}
			continue;
		}
		attachDeclarativeShadowRoots(element);
	}
}

function attachDeclarativeShadowRoot(template: HTMLTemplateElement): boolean {
	const named = template.getAttribute("shadowrootmode");
	if (named === null) {
		return false;
	}
	const mode = toASCIILowercase(named);
	if (mode !== "open" && mode !== "closed") {
		return false;
	}
	const host = template[kParent]!;
	if (host === null || host.nodeType !== ELEMENT_NODE) {
		return false;
	}
	try {
		attachShadowRoot(
			host as Element,
			mode,
			template.hasAttribute("shadowrootclonable"),
			template.hasAttribute("shadowrootserializable"),
			template.hasAttribute("shadowrootdelegatesfocus"),
			"named",
			// A declarative shadow root that names a registry attribute is
			// scoped to a registry it has not been given yet, so it starts with
			// none.
			template.hasAttribute("shadowrootcustomelementregistry")
				? null
				: globalCustomElements,
		);
	} catch (_err) {
		return false;
	}
	const shadow = (host as Element)[kShadowRoot]! as ShadowRoot;
	shadow[kDeclarative] = true;
	const content = template[kTemplateContent]!;
	removeNode(template);
	if (content !== null) {
		for (const child of getChildNodeArray(content)) {
			if (shadow[kRegistry] === null) {
				dropRegistry(child);
			}
			insertNode(child, shadow, null, true);
		}
	}
	attachDeclarativeShadowRoots(shadow);
	return true;
}

// Builds the one document of this realm. It carries the realm's
// registry. Every document an author builds carries none until a
// registry claims it, exactly like a document with no browsing context.
function parseHTMLDocument(
	html: string,
	url = "about:blank",
	allowDeclarativeShadowRoots = true,
	registry: CustomElementRegistry | null = globalCustomElements,
): Document {
	const adapter = createTreeAdapter(null);
	const outerRegistry = parseRegistry;
	parseRegistry = registry;
	let document: Document;
	try {
		document = Parse5.parse(html, {
			treeAdapter: adapter as never,
		}) as unknown as Document;
	} finally {
		parseRegistry = outerRegistry;
	}
	document[kRegistry] = registry;
	document[kDocumentURL] = url;
	if (allowDeclarativeShadowRoots) {
		attachDeclarativeShadowRoots(document);
	}
	return document;
}

// A declarative shadow root becomes one only if the caller allowed it.
// innerHTML does not; setHTMLUnsafe and parseHTMLUnsafe do.
function parseHTMLFragment(
	markup: string,
	context: Element,
	allowDeclarativeShadowRoots = false,
): DocumentFragment {
	const document = context[kDocument]!;
	const adapter = createTreeAdapter(document);
	const outerRegistry = parseRegistry;
	parseRegistry = context[kRegistry]!;
	let parsed: DocumentFragment;
	try {
		parsed = Parse5.parseFragment(context as never, markup, {
			treeAdapter: adapter as never,
		}) as unknown as DocumentFragment;
	} finally {
		parseRegistry = outerRegistry;
	}
	const fragment =
		document.createDocumentFragment() as unknown as DocumentFragment;
	for (const child of getChildNodeArray(parsed)) {
		insertNode(child, fragment, null, true);
	}
	if (allowDeclarativeShadowRoots) {
		attachDeclarativeShadowRoots(fragment);
	}
	return fragment;
}

/** Becomes a parsererror document. */
class XMLWellFormednessError extends Error {}

// The namespace Firefox coined for the error document, which the spec's
// DOMParser algorithm adopted for the parsererror root.
const PARSERERROR_NAMESPACE =
	"http://www.mozilla.org/newlayout/xml/parsererror.xml";

// Characters the XML Char production excludes: most C0 controls, the
// two permanent non-characters, and a surrogate half without its
// partner.
const XML_FORBIDDEN_CHAR =
	/[\0-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/* eslint-disable no-misleading-character-class -- the XML Name production
   matches lone combining marks by definition */
const XML_NAME_TOKEN = new RegExp(
	`(?:[${NAME_START}]|[\uD800-\uDBFF][\uDC00-\uDFFF])` +
	`(?:[${NAME_REST}]|[\uD800-\uDBFF][\uDC00-\uDFFF])*`,
	"y",
);
/* eslint-enable no-misleading-character-class */

const PREDEFINED_ENTITIES = new Map([
	["amp", "&"],
	["lt", "<"],
	["gt", ">"],
	["apos", "'"],
	["quot", '"'],
]);

/** A Char: not a control or a surrogate. */
function isXMLChar(code: number): boolean {
	return (
		code === 0x9 ||
		code === 0xa ||
		code === 0xd ||
		(code >= 0x20 && code <= 0xd7ff) ||
		(code >= 0xe000 && code <= 0xfffd) ||
		(code >= 0x10000 && code <= 0x10ffff)
	);
}

// Chained to the enclosing scope. The root scope binds the two prefixes
// XML reserves.
interface XMLNamescope {
	parent: XMLNamescope | null;
	bindings: Map<string, string | null>;
}

function lookupXMLPrefix(
	scope: XMLNamescope,
	prefix: string,
): string | null | undefined {
	for (
		let current: XMLNamescope | null = scope;
		current !== null;
		current = current.parent
	) {
		const bound = current.bindings.get(prefix);
		if (bound !== undefined) {
			return bound;
		}
	}
	return undefined;
}

// A recursive-descent parser over the whole source string. It builds
// the tree with the same internal constructors the HTML tree adapter
// uses. It enforces well-formedness (one root, matching tags, bound
// prefixes, defined entities) and throws XMLWellFormednessError where
// the XML or Namespaces recommendations say a document is not
// well-formed. A DTD internal subset is skipped rather than processed, so
// an entity it declares is still reported as undefined, as a
// non-validating processor may do.
function parseXMLIntoDocument(source: string, document: Document): void {
	const input = source.replace(/\r\n?/g, "\n");
	let pos = 0;

	function fail(message: string): never {
		let line = 1;
		let lineStart = 0;
		for (let index = 0; index < pos && index < input.length; index++) {
			if (input.charCodeAt(index) === 0xa) {
				line++;
				lineStart = index + 1;
			}
		}
		const column = pos - lineStart + 1;
		throw new XMLWellFormednessError(
			`${message} (line ${line}, column ${column})`,
		);
	}

	const forbidden = XML_FORBIDDEN_CHAR.exec(input);
	if (forbidden !== null) {
		pos = forbidden.index;
		fail("The document contains a character XML forbids");
	}

	function eat(token: string): boolean {
		if (input.startsWith(token, pos)) {
			pos += token.length;
			return true;
		}
		return false;
	}

	function skipWhitespace(): boolean {
		const start = pos;
		while (pos < input.length) {
			const code = input.charCodeAt(pos);
			if (code !== 0x20 && code !== 0x9 && code !== 0xa) {
				break;
			}
			pos++;
		}
		return pos > start;
	}

	function scanName(): string {
		XML_NAME_TOKEN.lastIndex = pos;
		const match = XML_NAME_TOKEN.exec(input);
		if (match === null) {
			fail("Expected a name");
		}
		pos = XML_NAME_TOKEN.lastIndex;
		return match[0];
	}

	// pos points at the ampersand.
	function resolveReference(): string {
		pos++;
		if (eat("#x") || eat("#X")) {
			const start = pos;
			while (pos < input.length && /[0-9A-Fa-f]/.test(input[pos])) {
				pos++;
			}
			if (pos === start || !eat(";")) {
				fail("A malformed character reference");
			}
			const code = parseInt(input.slice(start, pos - 1), 16);
			if (!isXMLChar(code)) {
				fail("A character reference to a character XML forbids");
			}
			return String.fromCodePoint(code);
		}
		if (eat("#")) {
			const start = pos;
			while (pos < input.length && /[0-9]/.test(input[pos])) {
				pos++;
			}
			if (pos === start || !eat(";")) {
				fail("A malformed character reference");
			}
			const code = parseInt(input.slice(start, pos - 1), 10);
			if (!isXMLChar(code)) {
				fail("A character reference to a character XML forbids");
			}
			return String.fromCodePoint(code);
		}
		const name = scanName();
		if (!eat(";")) {
			fail("An entity reference is missing its semicolon");
		}
		const replacement = PREDEFINED_ENTITIES.get(name);
		if (replacement === undefined) {
			fail(`The entity "&${name};" is not defined`);
		}
		return replacement;
	}

	function parseAttributeValue(): string {
		const quote = input[pos];
		if (quote !== '"' && quote !== "'") {
			fail("An attribute value must be quoted");
		}
		pos++;
		let value = "";
		while (pos < input.length) {
			const char = input[pos];
			if (char === quote) {
				pos++;
				return value;
			}
			if (char === "<") {
				fail("An attribute value cannot contain <");
			}
			if (char === "&") {
				value += resolveReference();
				continue;
			}
			value += char === "\t" || char === "\n" ? " " : char;
			pos++;
		}
		fail("An attribute value is missing its closing quote");
	}

	// An element takes the default namespace. An unprefixed attribute takes
	// none.
	function resolveQualifiedName(
		getQualifiedName: string,
		scope: XMLNamescope,
		forAttribute: boolean,
	): {namespace: string | null; prefix: string | null; localName: string} {
		const colon = getQualifiedName.indexOf(":");
		if (colon === -1) {
			if (forAttribute) {
				return {namespace: null, prefix: null, localName: getQualifiedName};
			}
			return {
				namespace: lookupXMLPrefix(scope, "") ?? null,
				prefix: null,
				localName: getQualifiedName,
			};
		}
		const prefix = getQualifiedName.slice(0, colon);
		const localName = getQualifiedName.slice(colon + 1);
		if (prefix === "" || localName === "" || localName.includes(":")) {
			fail(`"${getQualifiedName}" is not a valid qualified name`);
		}
		if (prefix === "xmlns") {
			fail("The xmlns prefix is reserved for namespace declarations");
		}
		const namespace = lookupXMLPrefix(scope, prefix);
		if (namespace === undefined || namespace === null) {
			fail(`The prefix "${prefix}" is not bound to a namespace`);
		}
		return {namespace, prefix, localName};
	}

	function parseComment(parent: Node): void {
		const end = input.indexOf("--", pos);
		if (end === -1) {
			pos = input.length;
			fail("A comment is missing its closing -->");
		}
		const data = input.slice(pos, end);
		pos = end;
		if (!eat("-->")) {
			fail("A comment cannot contain --");
		}
		const comment = new Comment(data);
		comment[kDocument] = document;
		insertNode(comment, parent, null, true);
	}

	function parseProcessingInstruction(parent: Node): void {
		const target = scanName();
		if (target.toLowerCase() === "xml") {
			fail("An XML declaration is only allowed at the start of the document");
		}
		if (target.includes(":")) {
			fail("A processing instruction target cannot contain a colon");
		}
		let data = "";
		if (!eat("?>")) {
			if (!skipWhitespace()) {
				fail("A processing instruction needs space after its target");
			}
			const end = input.indexOf("?>", pos);
			if (end === -1) {
				pos = input.length;
				fail("A processing instruction is missing its closing ?>");
			}
			data = input.slice(pos, end);
			pos = end + 2;
		}
		const instruction = new ProcessingInstruction(target, data);
		instruction[kDocument] = document;
		insertNode(instruction, parent, null, true);
	}

	function parseDeclarationValue(name: string): string {
		skipWhitespace();
		if (!eat("=")) {
			fail(`The XML declaration's ${name} needs a value`);
		}
		skipWhitespace();
		return parseAttributeValue();
	}

	function parseXMLDeclaration(): void {
		if (!skipWhitespace()) {
			fail("The XML declaration needs space before its version");
		}
		if (!eat("version")) {
			fail("The XML declaration must open with a version");
		}
		const version = parseDeclarationValue("version");
		if (!/^1\.[0-9]+$/.test(version)) {
			fail(`"${version}" is not an XML version`);
		}
		let spaced = skipWhitespace();
		if (spaced && input.startsWith("encoding", pos)) {
			pos += "encoding".length;
			const encoding = parseDeclarationValue("encoding");
			if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(encoding)) {
				fail(`"${encoding}" is not an encoding name`);
			}
			spaced = skipWhitespace();
		}
		if (spaced && input.startsWith("standalone", pos)) {
			pos += "standalone".length;
			const standalone = parseDeclarationValue("standalone");
			if (standalone !== "yes" && standalone !== "no") {
				fail("The standalone declaration must be \"yes\" or \"no\"");
			}
			skipWhitespace();
		}
		if (!eat("?>")) {
			fail("The XML declaration is missing its closing ?>");
		}
	}

	// Respects quotes and comments inside the subset.
	function skipInternalSubset(): void {
		while (pos < input.length) {
			const char = input[pos];
			if (char === "]") {
				pos++;
				return;
			}
			if (eat("<!--")) {
				const end = input.indexOf("-->", pos);
				if (end === -1) {
					break;
				}
				pos = end + 3;
				continue;
			}
			if (eat("<?")) {
				const end = input.indexOf("?>", pos);
				if (end === -1) {
					break;
				}
				pos = end + 2;
				continue;
			}
			if (char === '"' || char === "'") {
				const end = input.indexOf(char, pos + 1);
				if (end === -1) {
					break;
				}
				pos = end + 1;
				continue;
			}
			pos++;
		}
		pos = input.length;
		fail("The doctype's internal subset is missing its closing ]");
	}

	// Quoted, and taken as-is with no reference expansion.
	function parseDoctypeLiteral(): string {
		const quote = input[pos];
		if (quote !== '"' && quote !== "'") {
			fail("A doctype literal must be quoted");
		}
		const end = input.indexOf(quote, pos + 1);
		if (end === -1) {
			fail("A doctype literal is missing its closing quote");
		}
		const value = input.slice(pos + 1, end);
		pos = end + 1;
		return value;
	}

	function parseDoctype(): void {
		if (!skipWhitespace()) {
			fail("The doctype needs space before its name");
		}
		const name = scanName();
		let publicId = "";
		let systemId = "";
		const spaced = skipWhitespace();
		if (spaced && eat("SYSTEM")) {
			if (!skipWhitespace()) {
				fail("SYSTEM needs space before its literal");
			}
			systemId = parseDoctypeLiteral();
			skipWhitespace();
		} else if (spaced && eat("PUBLIC")) {
			if (!skipWhitespace()) {
				fail("PUBLIC needs space before its literals");
			}
			publicId = parseDoctypeLiteral();
			if (!skipWhitespace()) {
				fail("PUBLIC needs space between its literals");
			}
			systemId = parseDoctypeLiteral();
			skipWhitespace();
		}
		if (eat("[")) {
			skipInternalSubset();
			skipWhitespace();
		}
		if (!eat(">")) {
			fail("The doctype is missing its closing >");
		}
		const doctype = new DocumentType(name, publicId, systemId);
		doctype[kDocument] = document;
		insertNode(doctype, document, null, true);
	}

	function parseCDATASection(parent: Node): void {
		const end = input.indexOf("]]>", pos);
		if (end === -1) {
			pos = input.length;
			fail("A CDATA section is missing its closing ]]>");
		}
		const section = new CDATASection(input.slice(pos, end));
		section[kDocument] = document;
		insertNode(section, parent, null, true);
		pos = end + 3;
	}

	function appendText(parent: Node, data: string): void {
		const last = parent[kLastChild]!;
		if (last !== null && last.nodeType === TEXT_NODE) {
			(last as CharacterData)[kData]! += data;
			return;
		}
		const text = document.createTextNode(data) as unknown as Text;
		insertNode(text, parent, null, true);
	}

	function parseElement(parent: Node, parentScope: XMLNamescope): void {
		const getQualifiedName = scanName();
		interface ParsedAttribute {
			getQualifiedName: string;
			value: string;
		}
		const attributes: ParsedAttribute[] = [];
		let selfClosing = false;
		for (;;) {
			const spaced = skipWhitespace();
			if (eat("/>")) {
				selfClosing = true;
				break;
			}
			if (eat(">")) {
				break;
			}
			if (pos >= input.length) {
				fail(`The <${getQualifiedName}> tag is missing its closing >`);
			}
			if (!spaced) {
				fail("Attributes must be separated by space");
			}
			const attributeName = scanName();
			skipWhitespace();
			if (!eat("=")) {
				fail(`The attribute "${attributeName}" is missing its value`);
			}
			skipWhitespace();
			const value = parseAttributeValue();
			for (const attribute of attributes) {
				if (attribute.getQualifiedName === attributeName) {
					fail(`The attribute "${attributeName}" is repeated`);
				}
			}
			attributes.push({getQualifiedName: attributeName, value});
		}
		let scope = parentScope;
		const bindings = new Map<string, string | null>();
		for (const attribute of attributes) {
			let boundPrefix: string | null = null;
			if (attribute.getQualifiedName === "xmlns") {
				boundPrefix = "";
			} else if (attribute.getQualifiedName.startsWith("xmlns:")) {
				boundPrefix = attribute.getQualifiedName.slice("xmlns:".length);
				if (boundPrefix === "" || boundPrefix.includes(":")) {
					fail(
						`"${attribute.getQualifiedName}" is not a namespace declaration`,
					);
				}
			} else {
				continue;
			}
			if (boundPrefix === "xmlns") {
				fail("The xmlns prefix cannot be declared");
			}
			if (boundPrefix === "xml" && attribute.value !== XML_NAMESPACE) {
				fail("The xml prefix is bound to the XML namespace and no other");
			}
			if (
				attribute.value === XMLNS_NAMESPACE ||
				(attribute.value === XML_NAMESPACE && boundPrefix !== "xml")
			) {
				fail("A reserved namespace cannot be bound to another name");
			}
			if (boundPrefix !== "" && attribute.value === "") {
				fail(`The prefix "${boundPrefix}" cannot be unbound`);
			}
			bindings.set(
				boundPrefix,
				attribute.value === "" ? null : attribute.value,
			);
		}
		if (bindings.size > 0) {
			scope = {parent: parentScope, bindings};
		}
		const resolved = resolveQualifiedName(getQualifiedName, scope, false);
		const element = createElementInternal(
			document,
			resolved.localName,
			resolved.namespace,
			resolved.prefix,
			null,
			false,
			null,
		);
		const seen = new Set<string>();
		for (const attribute of attributes) {
			let namespace: string | null = null;
			let prefix: string | null = null;
			let localName = attribute.getQualifiedName;
			if (attribute.getQualifiedName === "xmlns") {
				namespace = XMLNS_NAMESPACE;
			} else if (attribute.getQualifiedName.startsWith("xmlns:")) {
				namespace = XMLNS_NAMESPACE;
				prefix = "xmlns";
				localName = attribute.getQualifiedName.slice("xmlns:".length);
			} else {
				const extracted = resolveQualifiedName(
					attribute.getQualifiedName,
					scope,
					true,
				);
				namespace = extracted.namespace;
				prefix = extracted.prefix;
				localName = extracted.localName;
			}
			const key = `${namespace ?? ""}\0${localName}`;
			if (seen.has(key)) {
				fail(
					`The attribute "${localName}" appears twice in one namespace`,
				);
			}
			seen.add(key);
			const created = new Attr(namespace, prefix, localName, attribute.value);
			created[kDocument] = document;
			appendAttribute(element, created);
		}
		insertNode(element, parent, null, true);
		if (selfClosing) {
			return;
		}
		parseContent(element, scope);
		if (pos >= input.length) {
			fail(`The <${getQualifiedName}> element is never closed`);
		}
		const closing = scanName();
		if (closing !== getQualifiedName) {
			fail(`</${closing}> does not match the open <${getQualifiedName}>`);
		}
		skipWhitespace();
		if (!eat(">")) {
			fail(`The </${getQualifiedName}> tag is missing its closing >`);
		}
	}

	function parseContent(parent: Node, scope: XMLNamescope): void {
		while (pos < input.length) {
			if (eat("</")) {
				return;
			}
			if (eat("<!--")) {
				parseComment(parent);
				continue;
			}
			if (eat("<![CDATA[")) {
				parseCDATASection(parent);
				continue;
			}
			if (eat("<?")) {
				parseProcessingInstruction(parent);
				continue;
			}
			if (input.startsWith("<!", pos)) {
				fail("Markup declarations cannot appear in content");
			}
			if (eat("<")) {
				parseElement(parent, scope);
				continue;
			}
			let text = "";
			while (pos < input.length) {
				const char = input[pos];
				if (char === "<") {
					break;
				}
				if (char === "&") {
					text += resolveReference();
					continue;
				}
				if (char === "]" && input.startsWith("]]>", pos)) {
					fail("Text content cannot contain ]]>");
				}
				text += char;
				pos++;
			}
			appendText(parent, text);
		}
	}

	const rootScope: XMLNamescope = {
		parent: null,
		bindings: new Map([["xml", XML_NAMESPACE]]),
	};
	if (input.startsWith("<?xml", pos) && /[ \t\n?]/.test(input[5] ?? "")) {
		pos += "<?xml".length;
		parseXMLDeclaration();
	}
	let sawRoot = false;
	let sawDoctype = false;
	while (pos < input.length) {
		if (skipWhitespace()) {
			continue;
		}
		if (eat("<!--")) {
			parseComment(document);
			continue;
		}
		if (eat("<?")) {
			parseProcessingInstruction(document);
			continue;
		}
		if (eat("<!DOCTYPE")) {
			if (sawDoctype || sawRoot) {
				fail("A doctype must come once, before the root element");
			}
			sawDoctype = true;
			parseDoctype();
			continue;
		}
		if (input.startsWith("<!", pos) || input.startsWith("</", pos)) {
			fail("Unexpected markup outside the root element");
		}
		if (eat("<")) {
			if (sawRoot) {
				fail("A document holds one root element");
			}
			sawRoot = true;
			parseElement(document, rootScope);
			continue;
		}
		fail("Text is not allowed outside the root element");
	}
	if (!sawRoot) {
		fail("The document has no root element");
	}
}

export class DOMParser {
	parseFromString(string: string, type: string): Document {
		const contentType = String(type);
		if (contentType === "text/html") {
			return parseHTMLDocument(String(string), "about:blank", false, null);
		}
		if (
			contentType === "text/xml" ||
			contentType === "application/xml" ||
			contentType === "application/xhtml+xml" ||
			contentType === "image/svg+xml"
		) {
			return parseXMLDocument(String(string), contentType);
		}
		throw new TypeError(`"${type}" is not a supported content type`);
	}
}

// A well-formed document becomes the tree it describes. Anything else
// becomes the spec's error document, whose root is a parsererror element
// holding the failure.
function parseXMLDocument(source: string, contentType: string): Document {
	const document = new XMLDocument();
	document[kType] = "xml";
	document[kContentType] = contentType;
	document[kRegistry] = null;
	try {
		parseXMLIntoDocument(source, document);
	} catch (error) {
		if (!(error instanceof XMLWellFormednessError)) {
			throw error;
		}
		for (const child of getChildNodeArray(document)) {
			removeNode(child, true);
		}
		const parserError = createElementInternal(
			document,
			"parsererror",
			PARSERERROR_NAMESPACE,
		);
		const text = document.createTextNode(error.message) as unknown as Text;
		insertNode(text, parserError, null, true);
		insertNode(parserError, document, null, true);
	}
	return document;
}

Object.defineProperty(DOMParser.prototype, Symbol.toStringTag, {
	value: "DOMParser",
	configurable: true,
});

const VOID_ELEMENTS = new Set([
	"area",
	"base",
	"basefont",
	"bgsound",
	"br",
	"col",
	"embed",
	"frame",
	"hr",
	"img",
	"input",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

const NEWLINE_EATING_ELEMENTS = new Set(["pre", "textarea", "listing"]);

const RAW_TEXT_PARENTS = new Set([
	"style",
	"script",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"plaintext",
	"noscript",
]);

function escapeText(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/\u00a0/g, "&nbsp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/\u00a0/g, "&nbsp;")
		.replace(/"/g, "&quot;");
}

function getAttributeSerializedName(attribute: Attr): string {
	const namespace = attribute[kNamespace]!;
	if (namespace === null) {
		return attribute[kLocalName]!;
	}
	if (namespace === XML_NAMESPACE) {
		return `xml:${attribute[kLocalName]!}`;
	}
	if (namespace === XMLNS_NAMESPACE) {
		return attribute[kLocalName] === "xmlns"
			? "xmlns"
			: `xmlns:${attribute[kLocalName]!}`;
	}
	if (namespace === XLINK_NAMESPACE) {
		return `xlink:${attribute[kLocalName]!}`;
	}
	return attribute[kQualifiedName]!;
}

// A shadow root is written out as the template the parser reads back,
// but only where the caller asked for it. getHTML's options say whether
// a serializable root counts and name the closed roots to include.
// innerHTML asks for none, so shadow trees are invisible to it.
function serializeFragment(
	node: Node,
	serializableShadowRoots: boolean,
	shadowRoots: ShadowRoot[] = [],
): string {
	let children = node;
	if (
		node.nodeType === ELEMENT_NODE &&
		(node as Element)[kNamespace] === HTML_NAMESPACE &&
		(node as Element)[kLocalName] === "template"
	) {
		const content = (node as HTMLTemplateElement)[kTemplateContent]!;
		if (content !== null && content !== undefined) {
			children = content;
		}
	}
	let html = "";
	if (node.nodeType === ELEMENT_NODE) {
		const shadow = (node as Element)[kShadowRoot]!;
		if (
			shadow !== null &&
			((serializableShadowRoots && shadow[kSerializable]!) ||
				shadowRoots.includes(shadow))
		) {
			html += serializeShadowRoot(shadow, serializableShadowRoots, shadowRoots);
		}
	}
	for (
		let child = children[kFirstChild]!;
		child !== null;
		child = child[kNext]!
	) {
		html += serializeNode(child, serializableShadowRoots, shadowRoots);
	}
	return html;
}

function serializeShadowRoot(
	shadow: ShadowRoot,
	serializableShadowRoots: boolean,
	shadowRoots: ShadowRoot[],
): string {
	let html = `<template shadowrootmode="${shadow[kShadowMode]!}"`;
	if (shadow[kDelegatesFocus]!) {
		html += ' shadowrootdelegatesfocus=""';
	}
	if (shadow[kSerializable]!) {
		html += ' shadowrootserializable=""';
	}
	if (shadow[kClonable]!) {
		html += ' shadowrootclonable=""';
	}
	html += ">";
	html += serializeFragment(shadow, serializableShadowRoots, shadowRoots);
	html += "</template>";
	return html;
}

function serializeNode(
	node: Node,
	serializableShadowRoots: boolean,
	shadowRoots: ShadowRoot[],
): string {
	switch (node.nodeType) {
		case ELEMENT_NODE: {
			const element = node as Element;
			const namespace = element[kNamespace]!;
			const tagName =
				namespace === HTML_NAMESPACE ||
				namespace === MATHML_NAMESPACE ||
				namespace === SVG_NAMESPACE
					? element[kLocalName]!
					: element[kQualifiedName]!;
			let html = `<${tagName}`;
			for (const attribute of element[kAttributeList]!) {
				html += ` ${getAttributeSerializedName(attribute)}="${escapeAttribute(
					attribute[kValue]!,
				)}"`;
			}
			html += ">";
			if (namespace === HTML_NAMESPACE && VOID_ELEMENTS.has(tagName)) {
				return html;
			}
			// The parser drops a newline that opens a pre, textarea or listing,
			// so serializing one writes a second newline for the parser to eat,
			// and the first survives the round trip.
			if (
				namespace === HTML_NAMESPACE &&
				NEWLINE_EATING_ELEMENTS.has(tagName)
			) {
				const first = element[kFirstChild]!;
				if (
					first !== null &&
					first.nodeType === TEXT_NODE &&
					(first as CharacterData)[kData]!.startsWith("\n")
				) {
					html += "\n";
				}
			}
			html += serializeFragment(element, serializableShadowRoots, shadowRoots);
			html += `</${tagName}>`;
			return html;
		}
		case TEXT_NODE: {
			const parent = node[kParent]!;
			if (
				parent !== null &&
				parent.nodeType === ELEMENT_NODE &&
				(parent as Element)[kNamespace] === HTML_NAMESPACE &&
				RAW_TEXT_PARENTS.has((parent as Element)[kLocalName]!)
			) {
				return (node as CharacterData)[kData]!;
			}
			return escapeText((node as CharacterData)[kData]!);
		}
		case CDATA_SECTION_NODE:
			return `<![CDATA[${(node as CharacterData)[kData]!}]]>`;
		case COMMENT_NODE:
			return `<!--${(node as CharacterData)[kData]!}-->`;
		case PROCESSING_INSTRUCTION_NODE:
			return `<?${(node as ProcessingInstruction)[kTarget]!} ${
				(node as CharacterData)[kData]!
			}>`;
		case DOCUMENT_TYPE_NODE:
			return `<!DOCTYPE ${(node as DocumentType)[kName]!}>`;
		default: {
			let html = "";
			for (
				let child = node[kFirstChild]!;
				child !== null;
				child = child[kNext]!
			) {
				html += serializeNode(child, serializableShadowRoots, shadowRoots);
			}
			return html;
		}
	}
}

// The list comes from the [CEReactions] extended attribute on the
// interfaces this DOM has. Anything that can insert, remove, rename or
// restyle a node is here, and nothing else. A member missing from this
// list would run an author's callback in the middle of the mutation that
// caused it instead of after it.
ceReactions(Node.prototype, [
	"appendChild",
	"insertBefore",
	"removeChild",
	"replaceChild",
	"normalize",
	"cloneNode",
	"nodeValue",
	"textContent",
]);
ceReactions(Element.prototype, [
	"after",
	"append",
	"attachShadow",
	"before",
	"className",
	"id",
	"innerHTML",
	"insertAdjacentElement",
	"insertAdjacentHTML",
	"insertAdjacentText",
	"moveBefore",
	"outerHTML",
	"prepend",
	"remove",
	"removeAttribute",
	"removeAttributeNS",
	"removeAttributeNode",
	"replaceChildren",
	"replaceWith",
	"setAttribute",
	"setAttributeNS",
	"setAttributeNode",
	"setAttributeNodeNS",
	"setHTMLUnsafe",
	"slot",
	"toggleAttribute",
]);
ceReactions(ShadowRoot.prototype, ["innerHTML", "setHTMLUnsafe"]);
ceReactions(HTMLSlotElement.prototype, ["assign", "name"]);
ceReactions(DocumentFragment.prototype, [
	"append",
	"moveBefore",
	"prepend",
	"replaceChildren",
]);
ceReactions(Document.prototype, [
	"adoptNode",
	"append",
	"createElement",
	"createElementNS",
	"importNode",
	"moveBefore",
	"prepend",
	"replaceChildren",
	"title",
]);
ceReactions(CharacterData.prototype, [
	"after",
	"appendData",
	"before",
	"data",
	"deleteData",
	"insertData",
	"remove",
	"replaceData",
	"replaceWith",
]);
ceReactions(DocumentType.prototype, [
	"after",
	"before",
	"remove",
	"replaceWith",
]);
ceReactions(Attr.prototype, ["nodeValue", "textContent", "value"]);
ceReactions(NamedNodeMap.prototype, [
	"removeNamedItem",
	"removeNamedItemNS",
	"setNamedItem",
	"setNamedItemNS",
]);
ceReactions(DOMTokenList.prototype, [
	"add",
	"remove",
	"replace",
	"toggle",
	"value",
]);
ceReactions(CustomElementRegistry.prototype, [
	"define",
	"initialize",
	"upgrade",
]);

// Every reflecting member is already a boundary, because the table
// installs its setter as one.
ceReactions(HTMLElement.prototype, [
	"autocapitalize",
	"autocorrect",
	"contentEditable",
	"draggable",
	"hidden",
	"spellcheck",
	"tabIndex",
	"translate",
]);
ceReactions(HTMLAnchorElement.prototype, [
	"hash",
	"host",
	"hostname",
	"href",
	"password",
	"pathname",
	"port",
	"protocol",
	"search",
	"text",
	"username",
]);
ceReactions(HTMLAreaElement.prototype, [
	"hash",
	"host",
	"hostname",
	"href",
	"password",
	"pathname",
	"port",
	"protocol",
	"search",
	"username",
]);
ceReactions(HTMLBaseElement.prototype, ["href"]);
ceReactions(HTMLFormElement.prototype, ["requestSubmit", "reset", "submit"]);
ceReactions(HTMLInputElement.prototype, ["checked", "setRangeText", "value"]);
ceReactions(HTMLTextAreaElement.prototype, [
	"defaultValue",
	"setRangeText",
	"value",
]);
ceReactions(HTMLSelectElement.prototype, [
	"add",
	"length",
	"remove",
	"selectedIndex",
	"value",
]);
ceReactions(HTMLOptionsCollection.prototype, ["add", "length", "remove"]);
ceReactions(HTMLOptionElement.prototype, ["selected", "text"]);
ceReactions(HTMLOutputElement.prototype, ["defaultValue", "value"]);
ceReactions(HTMLTableElement.prototype, [
	"caption",
	"createCaption",
	"createTBody",
	"createTFoot",
	"createTHead",
	"deleteCaption",
	"deleteRow",
	"deleteTFoot",
	"deleteTHead",
	"insertRow",
	"tFoot",
	"tHead",
]);
ceReactions(HTMLTableSectionElement.prototype, ["deleteRow", "insertRow"]);
ceReactions(HTMLTableRowElement.prototype, ["deleteCell", "insertCell"]);
ceReactions(HTMLTitleElement.prototype, ["text"]);
ceReactions(HTMLScriptElement.prototype, ["async", "text"]);
ceReactions(HTMLDialogElement.prototype, [
	"close",
	"requestClose",
	"show",
	"showModal",
]);

// GlobalEventHandlers and DocumentAndElementEventHandlers are included
// by the three element interfaces (HTML, SVG, MathML) and by Document.
// WindowEventHandlers belongs to the window, which the engine builds, and
// `body` and `frameset` forward to it. Only the content-attribute half of
// the feature is missing: `onclick="..."` in markup is a function
// compiled from source, and this DOM never executes script.
for (const prototype of [
	HTMLElement.prototype,
	SVGElement.prototype,
	MathMLElement.prototype,
	Document.prototype,
]) {
	installEventHandlers(prototype, GLOBAL_EVENT_HANDLERS);
	installEventHandlers(prototype, DOCUMENT_AND_ELEMENT_EVENT_HANDLERS);
}

installEventHandlers(Document.prototype, DOCUMENT_EVENT_HANDLERS);

for (const constructor of [HTMLBodyElement, HTMLFrameSetElement]) {
	for (const name of FORWARDED_BODY_EVENT_HANDLERS) {
		installForwardedEventHandler(constructor.prototype, name);
	}
}

// State an attached document accepts only from its engine.
// Re-evaluators called when the viewport changes. The lists belong to
// this module. The resize path is the one place a terminal viewport
// changes, so the engine decides when to call them.
const mediaQueryEvaluators = new WeakMap<Document, Set<() => void>>();

/**
 * Re-evaluate every live media query list, firing "change" where one flipped.
 */
export function syncMediaQueries(document: globalThis.Document): void {
	const updaters = mediaQueryEvaluators.get(document as Document);
	if (updaters === undefined) {
		return;
	}
	for (const update of updaters) {
		update();
	}
}

/**
 * Once per document. A second engine would build every widget a second
 * time, and the two would disagree about what is on screen.
 */
export function attachDocument(
	document: globalThis.Document,
	termDOM: TermDOM,
	layout: Layout,
	styles: Cascade,
	exchange: Exchange,
	screen: Screen,
): void {
	const attached = document as Document;
	if (attached[kTermDOM] !== undefined) {
		throw new Error("This document already has its engine.");
	}
	attached[kTermDOM] = termDOM;
	attached[kLayout] = layout;
	attached[kCascade] = styles;
	attached[kExchange] = exchange;
	attached[kScreen] = screen;
	hoverListenerCounts.set(
		attached,
		watchHoverListeners(attached, () => render(termDOM)),
	);
	// The document owns the observer. Mutations fan out to the cascade, the
	// layout tree and the UA default actions here, and the engine is only
	// asked to render the frame that shows the result.
	const observer = new MutationObserver((mutations) => {
		handleMutationRecords(attached, mutations);
		void render(termDOM);
	});
	observer.observe(document.documentElement as unknown as Node, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeOldValue: true,
		characterData: true,
	});
	engineObservers.set(attached, observer);
}

const engineObservers = new WeakMap<Document, MutationObserver>();

// Everything except painting: the flat-tree memo, UA UA shadow tree upgrades,
// the cascade, the layout tree and the focus default actions, always in
// the same order, because mutations reach here both from the observer
// and from synchronous drains.
function handleMutationRecords(
	document: Document,
	mutations: MutationRecord[],
): void {
	const attached = getAttachedDocument(document);
	if (attached === undefined) {
		return;
	}
	// Any observed mutation can move a node in the flat tree. Drop the
	// memoized composition links before anything reads through them.
	attached[kLayout].invalidateFrame();
	// Attribute records whose value did not actually change are dropped
	// before any handler sees them. Frameworks (and this repo's own
	// examples) reassign className/style with identical values on every
	// update. Per spec each assignment fires a record, and a class record
	// rebuilds the whole layout tree from body. That is the difference
	// between a keystroke costing a counter re-measure and costing the
	// document. A->B->A inside one unpainted batch also nets out: the
	// intermediate value never rendered, so skipping is correct, and a
	// same-batch pair still processes via the B->A record.
	const relevant = mutations.filter((record) => {
		if (record.type !== "attributes" || !record.attributeName) {
			return true;
		}
		const target = record.target as Element;
		return record.oldValue !== target.getAttribute(record.attributeName);
	});
	if (relevant.length === 0) {
		return;
	}
	// Upgrade UA form controls the moment they connect, before layout reads
	// their shadow tree and before the painter walks it. That is how a
	// browser upgrades a custom element on connect, not lazily at first
	// paint. Every insert, whether observer-driven or drained from a
	// synchronous flush, passes through here.
	for (const record of relevant) {
		if (record.type !== "childList") {
			continue;
		}
		for (const added of record.addedNodes) {
			if (added.nodeType !== added.ELEMENT_NODE) {
				continue;
			}
			ensureUAShadowTrees(added);
		}
	}
	attached[kCascade].handleMutations(relevant);
	attached[kLayout].handleMutations(relevant);
	focusAutofocusedNodes(relevant);
	dropUnfocusableFocus(document, attached);
}

// An element with `autofocus` gets focused as soon as it connects, as a
// browser does at initial page load. This generalizes it to any
// insertion, so a dynamically created element (an edit input that only
// exists while editing) can autofocus itself. Scoped to newly added
// nodes, not later attribute changes, matching the spec's "insertion"
// trigger. If a batch inserts more than one autofocus element, the later
// one wins, the same ambiguity a real page with more than one already
// has.
function focusAutofocusedNodes(mutations: MutationRecord[]): void {
	for (const record of mutations) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== node.ELEMENT_NODE) {
				continue;
			}
			const element = node as Element;
			const candidate = (element as {autofocus?: boolean}).autofocus
				? element
				: element.querySelector("[autofocus]");
			(candidate as globalThis.HTMLElement | null)?.focus();
		}
	}
}

// A mutation that made the focused element unfocusable (an inert
// ancestor appearing above it, a move into an inert parent, display:none
// anywhere on its flat chain) unfocuses it, including blur events and
// restyle.
function dropUnfocusableFocus(
	document: Document,
	attached: AttachedDocument,
): void {
	let active = document.activeElement;
	while (active !== null) {
		const shadow = getShadowRoot<ShadowRoot>(active);
		const inner = shadow?.activeElement ?? null;
		if (inner === null) {
			break;
		}
		active = inner;
	}
	if (active === null || active === document.body) {
		return;
	}
	for (
		let node: globalThis.Element | null = active;
		node !== null;
		node = flatParentElement<globalThis.Element>(node)
	) {
		if (
			node.hasAttribute("inert") ||
			attached[kCascade]
				.declarationFor(node as Element)
				.getComputedValue("display") === "none"
		) {
			(active as globalThis.HTMLElement).blur();
			return;
		}
	}
}

/**
 * Deliver the document's pending mutation records to the engines without
 * laying out or painting. takeRecords() takes them from the observer
 * callback, so a caller that never paints must request the frame itself.
 */
export function applyMutations(document: globalThis.Document): boolean {
	const observer = engineObservers.get(document as Document);
	if (observer === undefined) {
		return false;
	}
	const records = observer.takeRecords();
	if (records.length === 0) {
		return false;
	}
	handleMutationRecords(document as Document, records);
	return true;
}

/**
 * Synchronously settle what a geometry read must see: pending mutations
 * delivered and layout brought up to date. A geometry read needs fresh
 * layout, not fresh pixels. Painting stays with the frame loop, but the
 * drain takes records from the observer callback that would have painted
 * them, so this requests the frame on the caller's behalf.
 */
export function flushLayout(node: globalThis.Node): boolean {
	const attached = getAttachedDocument(node);
	if (attached === undefined) {
		return false;
	}
	const shaped = node as {nodeType?: number; ownerDocument?: object | null};
	const document = (
		shaped.nodeType === DOCUMENT_NODE ? node : shaped.ownerDocument
	) as globalThis.Document;
	const had = applyMutations(document);
	if (had) {
		void render(attached[kTermDOM]);
	}
	attached[kLayout].performLayout();
	clampScrollOffsets(document);
	return had;
}

const hoverListenerCounts = new WeakMap<Document, () => number>();

export function hoverListenerCount(document: globalThis.Document): number {
	return hoverListenerCounts.get(document as Document)?.() ?? 0;
}

// A document that has been adopted. It renders, and knows what it
// renders through.
type AttachedDocument = Document & {
	[kTermDOM]: TermDOM;
	[kLayout]: Layout;
	[kCascade]: Cascade;
	[kExchange]: Exchange;
	[kScreen]: Screen;
};

function getAttachedDocument(
	node: globalThis.Node,
): AttachedDocument | undefined {
	const shaped = node as {nodeType?: number; ownerDocument?: Document | null};
	const document = (
		shaped.nodeType === DOCUMENT_NODE ? node : shaped.ownerDocument
	) as Document | null;
	return document !== null && document[kTermDOM] !== undefined
		? (document as AttachedDocument)
		: undefined;
}

/** OSC 52 carries text and only text. */
const CLIPBOARD_TEXT_TYPE = "text/plain";

function clipboardDenied(why: string): DOMException {
	return domError("NotAllowedError", why);
}

const kItemEntries = Symbol("entries");

// Blob is the platform's, which Node and Bun both provide as a global.
// OSC 52 carries one payload the terminal treats as text, so text/plain
// is the only type a write sends and the only type a read returns. An
// item may hold other types, and the clipboard skips them.
class ClipboardItem {
	declare [kItemEntries]?: Map<string, Promise<Blob>>;

	constructor(
		items: Record<string, string | Blob | Promise<string | Blob>>,
		_options?: unknown,
	) {
		if (items === null || typeof items !== "object") {
			throw new TypeError("A clipboard item takes a record of types");
		}
		const entries = new Map<string, Promise<Blob>>();
		for (const [type, value] of Object.entries(items)) {
			const mediaType = normalizeMediaType(type);
			entries.set(
				mediaType,
				Promise.resolve(value).then((held) =>
					held instanceof Blob
						? held
						: new Blob([String(held)], {type: mediaType}),
				),
			);
		}
		if (entries.size === 0) {
			throw new TypeError("A clipboard item carries at least one type");
		}
		this[kItemEntries] = entries;
	}

	get types(): readonly string[] {
		return Object.freeze(Array.from(this[kItemEntries]!.keys()));
	}

	static supports(type: string): boolean {
		return normalizeMediaType(type) === CLIPBOARD_TEXT_TYPE;
	}

	getType(type: string): Promise<Blob> {
		const held = this[kItemEntries]!.get(normalizeMediaType(type));
		if (held === undefined) {
			return Promise.reject(
				notFoundError(`That item carries no ${normalizeMediaType(type)}`),
			);
		}
		return held;
	}
}

function normalizeMediaType(type: unknown): string {
	return String(type).trim().toLowerCase();
}

Object.defineProperty(ClipboardItem.prototype, Symbol.toStringTag, {
	value: "ClipboardItem",
	configurable: true,
});

const kClipboardDocument = Symbol("the document whose clipboard this is");

// writeText() sends the text to the system clipboard over OSC 52, which
// travels in-band, including across SSH. Terminals without OSC 52 ignore
// it, and there is no way to detect that, so the promise resolves when
// the transport has the bytes. readText() queries the same way (OSC 52
// with `?` as the payload) and resolves with the reply. writeTokenList() and
// read() are the same two round trips over a ClipboardItem. This is an
// EventTarget because the interface says so; nothing fires events at it.
class Clipboard extends EventTarget {
	declare [kClipboardDocument]?: Document;

	constructor(document?: Document) {
		super();
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kClipboardDocument] = document as Document;
	}

	async writeText(text: string): Promise<void> {
		const terminal = reachClipboard(this[kClipboardDocument]!, "writes");
		return terminal.writeClipboard(String(text));
	}

	async readText(): Promise<string> {
		const terminal = reachClipboard(this[kClipboardDocument]!, "reads");
		const text = await terminal.queryClipboard();
		if (text === null) {
			// Silence means refusal. Most terminals gate clipboard reads on
			// their own configuration and reply with nothing when reads are
			// off.
			throw clipboardDenied("the terminal did not answer the clipboard query");
		}
		return text;
	}

	async write(items: Iterable<ClipboardItem>): Promise<void> {
		const terminal = reachClipboard(this[kClipboardDocument]!, "writes");
		let carrier: ClipboardItem | null = null;
		for (const item of items) {
			if (item.types.includes(CLIPBOARD_TEXT_TYPE)) {
				carrier = item;
				break;
			}
		}
		if (carrier === null) {
			throw clipboardDenied(
				`a clipboard write needs a ${CLIPBOARD_TEXT_TYPE} entry`,
			);
		}
		const text = await (await carrier.getType(CLIPBOARD_TEXT_TYPE)).text();
		return terminal.writeClipboard(text);
	}

	async read(): Promise<ClipboardItem[]> {
		const text = await this.readText();
		return [
			constructInternal(
				() => new ClipboardItem({[CLIPBOARD_TEXT_TYPE]: text}),
			),
		];
	}
}

// The clipboard is the user's to grant, so it is reachable only from a
// trusted activation-triggering event while it is being dispatched: a
// keystroke, a mouse press or release, a click, a paste. This is
// stricter than a browser on purpose. A browser's transient activation
// outlives the dispatch that granted it because its window is a span of
// time, so a handler there may await and still write the clipboard. Here
// the gate is the dispatch itself. A timer, a microtask, a resolved fetch
// and an event the application dispatched itself are all outside it.
// Every caller is async, so the throw reaches the page as the rejection
// the Clipboard API specifies.
function reachClipboard(document: Document, what: string): Exchange {
	const attached = getAttachedDocument(document);
	if (
		attached === undefined ||
		!isAttached(attached[kTermDOM]) ||
		!attached[kExchange].interactive
	) {
		throw clipboardDenied(
			"clipboard requires an attached interactive terminal",
		);
	}
	if (!isUserActive(document)) {
		throw clipboardDenied(`clipboard ${what} need a user gesture`);
	}
	return attached[kExchange];
}

Object.defineProperty(Clipboard.prototype, Symbol.toStringTag, {
	value: "Clipboard",
	configurable: true,
});

// The permission names the clipboard handles. The other names the
// Permissions API defines have nothing behind them in a terminal (no
// document scroll, microphone, location or notification surface), so they are
// denied rather than left at a prompt nobody could respond to.
const CLIPBOARD_PERMISSIONS = new Set(["clipboard-read", "clipboard-write"]);
const UNBACKED_PERMISSIONS = new Set([
	"accelerometer",
	"ambient-light-sensor",
	"background-sync",
	"bluetooth",
	"camera",
	"display-capture",
	"geolocation",
	"gyroscope",
	"idle-detection",
	"local-fonts",
	"magnetometer",
	"microphone",
	"midi",
	"notifications",
	"payment-handler",
	"periodic-background-sync",
	"persistent-storage",
	"push",
	"screen-wake-lock",
	"speaker-selection",
	"storage-access",
	"window-management",
	"xr-spatial-tracking",
]);

const kPermissionName = Symbol("name");
const kPermissionDocument = Symbol("the document this permission stands over");

// `state` is read when asked. For the clipboard it is granted while a
// gesture is being dispatched and prompt otherwise. Nothing fires
// `change`, because the gesture opens and closes inside one dispatch,
// and a listener would be told about a state that had already passed.
class PermissionStatus extends EventTarget {
	declare [kPermissionName]?: string;
	declare [kPermissionDocument]?: Document | null;

	constructor(name?: string, document?: Document) {
		super();
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kPermissionName] = String(name);
		this[kPermissionDocument] = document ?? null;
	}

	get name(): string {
		return this[kPermissionName]!;
	}

	get state(): string {
		const document = this[kPermissionDocument]!;
		if (
			document === null || !CLIPBOARD_PERMISSIONS.has(this[kPermissionName]!)
		) {
			return "denied";
		}
		const attached = getAttachedDocument(document);
		if (
			!attached ||
			!isAttached(attached[kTermDOM]) ||
			!attached[kExchange].interactive
		) {
			return "denied";
		}
		return isUserActive(document) ? "granted" : "prompt";
	}
}

// The one event handler attribute a permission status has.
installEventHandler(PermissionStatus.prototype, "onchange");

Object.defineProperty(PermissionStatus.prototype, Symbol.toStringTag, {
	value: "PermissionStatus",
	configurable: true,
});

// Exposes the gate above by permission name.
class Permissions extends EventTarget {
	declare [kPermissionDocument]?: Document;

	constructor(document?: Document) {
		super();
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kPermissionDocument] = document as Document;
	}

	query(descriptor: {name?: string}): Promise<PermissionStatus> {
		if (descriptor === null || typeof descriptor !== "object") {
			return Promise.reject(
				new TypeError("A permission query takes a descriptor"),
			);
		}
		const name = String(descriptor.name);
		if (!CLIPBOARD_PERMISSIONS.has(name) && !UNBACKED_PERMISSIONS.has(name)) {
			return Promise.reject(
				new TypeError(`"${name}" is not a permission name`),
			);
		}
		return Promise.resolve(
			constructInternal(
				() => new PermissionStatus(name, this[kPermissionDocument]!),
			),
		);
	}
}

Object.defineProperty(Permissions.prototype, Symbol.toStringTag, {
	value: "Permissions",
	configurable: true,
});

const kNavigator = Symbol("navigator");
const kWindowLocation = Symbol("the window's location");
const kLocationWindow = Symbol("the window a location belongs to");
const kStrings = Symbol("the strings a list holds");

// The only one here is Location.ancestorOrigins, which is empty because
// a terminal document is not in a frame.
class DOMStringList {
	[index: number]: string;
	declare [kStrings]?: readonly string[];

	constructor(strings: readonly string[]) {
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kStrings] = strings;
	}

	get length(): number {
		return this[kStrings]!.length;
	}

	item(index: number): string | null {
		const at = toUnsignedLong(index);
		return at < this[kStrings]!.length ? this[kStrings]![at]! : null;
	}

	contains(string: string): boolean {
		return this[kStrings]!.includes(String(string));
	}
}

Object.defineProperty(DOMStringList.prototype, Symbol.toStringTag, {
	value: "DOMStringList",
	configurable: true,
});

// Every reading member is live. It re-reads the document's URL instead
// of caching the value it was built with, because the document's URL is
// the source of truth and a copy would go stale. Every WRITING member
// navigates, and there is nowhere to navigate to (one document per
// window, no way to fetch another), so each throws rather than
// pretending it moved.
class Location {
	declare [kLocationWindow]?: Window;

	constructor(window: Window) {
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kLocationWindow] = window;
	}

	get href(): string {
		return this[kLocationWindow]!.document[kDocumentURL]!;
	}

	set href(_value: string) {
		throw noNavigation();
	}

	get origin(): string {
		return getLocationURL(this)?.origin ?? "null";
	}

	get protocol(): string {
		return getLocationURL(this)?.protocol ?? "";
	}

	set protocol(_value: string) {
		throw noNavigation();
	}

	get host(): string {
		return getLocationURL(this)?.host ?? "";
	}

	set host(_value: string) {
		throw noNavigation();
	}

	get hostname(): string {
		return getLocationURL(this)?.hostname ?? "";
	}

	set hostname(_value: string) {
		throw noNavigation();
	}

	get port(): string {
		return getLocationURL(this)?.port ?? "";
	}

	set port(_value: string) {
		throw noNavigation();
	}

	get pathname(): string {
		return getLocationURL(this)?.pathname ?? "";
	}

	set pathname(_value: string) {
		throw noNavigation();
	}

	get search(): string {
		return getLocationURL(this)?.search ?? "";
	}

	set search(_value: string) {
		throw noNavigation();
	}

	get hash(): string {
		return getLocationURL(this)?.hash ?? "";
	}

	set hash(_value: string) {
		throw noNavigation();
	}

	/** A terminal document is not in a frame, so it has no ancestors. */
	get ancestorOrigins(): DOMStringList {
		return constructInternal(() => new DOMStringList([]));
	}

	assign(_url: string | URL): void {
		throw noNavigation();
	}

	replace(_url: string | URL): void {
		throw noNavigation();
	}

	reload(): void {
		throw noNavigation();
	}

	toString(): string {
		return this.href;
	}
}

Object.defineProperty(Location.prototype, Symbol.toStringTag, {
	value: "Location",
	configurable: true,
});

// A caller can give a document any string as its URL, so this returns
// null when the URL Standard cannot parse it, and each member above falls
// back to what a browser returns for an opaque location.
function getLocationURL(location: Location): URL | null {
	return URL.parse(location.href);
}

function noNavigation(): DOMException {
	return domError(
		"NotSupportedError",
		"This DOM displays one document per window and cannot navigate",
	);
}

// The window a document is attached to: an EventTarget whose members are the
// browsing context's, implemented by the engine the document is attached to. A
// window exists only when attached (a headless document has none), so the
// members below may expect a mount, and degrade the way the document's own do
// without one: a viewport of no size, a document scroll at the origin, a query
// that matches nothing. Keyed by the handle requestAnimationFrame returned, so
// cancelAnimationFrame can cancel. The engine fires them once the frame
// containing their pending mutations has been written.
const frameCallbacks = new WeakMap<
	Document,
	{next: number; held: Map<number, FrameRequestCallback>}
>();

// Returns whether new callbacks arrived while these ran. A callback that
// schedules another frame must tick the engine's render loop again.
function holdFrameCallback(
	document: Document,
	callback: FrameRequestCallback,
): number {
	let state = frameCallbacks.get(document);
	if (state === undefined) {
		state = {next: 1, held: new Map()};
		frameCallbacks.set(document, state);
	}
	const handle = state.next++;
	state.held.set(handle, callback);
	return handle;
}

// A fullscreen transition resolves its promise here, once the render
// that carries the switch has been written.
function frameSettled(
	document: Document,
	attached: AttachedDocument,
): Promise<
	void> {
	return new Promise((resolve) => {
		holdFrameCallback(document, () => {
			resolve();
		});
		void render(attached[kTermDOM]);
	});
}

export function runFrameCallbacks(document: globalThis.Document): boolean {
	const state = frameCallbacks.get(document as Document);
	if (state === undefined || state.held.size === 0) {
		return false;
	}
	const callbacks = [...state.held.values()];
	state.held.clear();
	const now = performance.now();
	for (const callback of callbacks) {
		callback(now);
	}
	return state.held.size > 0;
}

export class Window extends EventTarget {
	readonly document: Document;
	declare [kNavigator]?: Navigator | undefined;
	declare [kWindowLocation]?: Location | undefined;
	constructor(document: Document) {
		super();
		this.document = document;
		// Attaching a document gives it a defaultView, and the attached
		// document is the one bare node constructors use.
		document[kDefaultView] = this;
		ambientDocument = document;
	}

	// One object per window, as the HTML Standard says. The document's
	// location is this same object, so a caller who holds on to it holds the
	// same one.
	get location(): Location {
		let location = this[kWindowLocation]!;
		if (location === undefined) {
			location = constructInternal(() => new Location(this));
			this[kWindowLocation] = location;
		}
		return location;
	}

	get customElements(): globalThis.CustomElementRegistry {
		return globalCustomElements as unknown as globalThis.CustomElementRegistry;
	}

	// The terminal is both the window and the screen, so the inner and
	// outer pairs report one size. Readonly like a browser's, and LIVE: a
	// SIGWINCH changes them. A value frozen at construction would report the
	// size the terminal had when the engine was built.
	get innerWidth(): number {
		const attached = getAttachedDocument(this.document);
		return attached === undefined ? 0 : attached[kScreen].cols;
	}

	get outerWidth(): number {
		return this.innerWidth;
	}

	get innerHeight(): number {
		const attached = getAttachedDocument(this.document);
		return attached === undefined ? 0 : attached[kScreen].rows;
	}

	get outerHeight(): number {
		return this.innerHeight;
	}

	// screenTop is readonly like a browser's, and LIVE. Cursor detection
	// moves the anchor after the window is built.
	get screenTop(): number {
		const attached = getAttachedDocument(this.document);
		return attached === undefined ? 0 : attached[kScreen].documentTop;
	}

	// Standard window scrolling, mapped onto the document scroll. scrollY is
	// how far the document scroll has moved down the document, and scrollBy
	// moves it. A terminal document never scrolls sideways, so the X pair reads
	// 0.
	get scrollY(): number {
		const attached = getAttachedDocument(this.document);
		return attached === undefined ? 0 : attached[kScreen].scrollTop;
	}

	get pageYOffset(): number {
		return this.scrollY;
	}

	get scrollX(): number {
		return 0;
	}

	get pageXOffset(): number {
		return this.scrollX;
	}

	// Built on first read and kept, so the clipboard a page holds on to
	// stays the same object.
	get navigator(): Navigator {
		let navigator = this[kNavigator]!;
		if (navigator === undefined) {
			const document = this.document;
			navigator = {
				userAgent: "TermDOM",
				language: "en-US",
				languages: Object.freeze(["en-US"]),
				platform: "",
				clipboard: constructInternal(() => new Clipboard(document)),
				permissions: constructInternal(() => new Permissions(document)),
				userActivation: {
					get hasBeenActive(): boolean {
						return everActivatedDocuments.has(document);
					},
					get isActive(): boolean {
						return isUserActive(document);
					},
				},
			} as unknown as Navigator;
			this[kNavigator] = navigator;
		}
		return navigator;
	}

	// scrollTo/scroll set the document scroll to an absolute position, the same
	// state scrollY reads and scrollBy moves relatively. documentElement and
	// body's scrollTop expose the same value, as in standard DOM
	// (window.scrollY === document.documentElement.scrollTop always). One
	// document scroll, four ways to read or move it.
	scrollTo(xOrOptions?: number | ScrollToOptions, y?: number): void {
		const attached = getAttachedDocument(this.document);
		if (attached === undefined) {
			return;
		}
		const top =
			typeof xOrOptions === "object" && xOrOptions !== null
				? (xOrOptions.top ?? attached[kScreen].scrollTop)
				: (y ?? 0);
		attached[kScreen].scrollTo(top);
		void render(attached[kTermDOM]);
	}

	scroll(xOrOptions?: number | ScrollToOptions, y?: number): void {
		this.scrollTo(xOrOptions, y);
	}

	scrollBy(xOrOptions?: number | ScrollToOptions, y?: number): void {
		const attached = getAttachedDocument(this.document);
		if (attached === undefined) {
			return;
		}
		const top =
			typeof xOrOptions === "object" && xOrOptions !== null
				? (xOrOptions.top ?? 0)
				: (y ?? 0);
		attached[kScreen].scrollTo(attached[kScreen].scrollTop + top);
		void render(attached[kTermDOM]);
	}

	// requestAnimationFrame is the only way to await a painted frame. It
	// schedules a render and fires the callback once that render completes,
	// so "await a frame" always means the frame carrying the pending
	// mutations has landed.
	requestAnimationFrame(callback: FrameRequestCallback): number {
		const attached = getAttachedDocument(this.document);
		if (attached === undefined) {
			return 0;
		}
		const handle = holdFrameCallback(this.document, callback);
		void render(attached[kTermDOM]);
		return handle;
	}

	cancelAnimationFrame(handle: number): void {
		frameCallbacks.get(this.document)?.held.delete(handle);
	}

	// The Selection API defines the window's getSelection as a call to the
	// document's.
	getSelection(): globalThis.Selection | null {
		return this.document.getSelection();
	}

	// The terminal is the one screen, and queries use the SAME evaluator
	// @media stylesheet rules use, so a script and a stylesheet can never
	// disagree about the viewport. The list is live: a resize (SIGWINCH is
	// this screen's window resize) re-evaluates and fires "change" when the
	// answer flips. That is the browser contract, and it is what makes
	// responsive terminal layouts a matchMedia listener instead of a custom
	// resize hook.
	matchMedia(query: string): MediaQueryList {
		const media = String(query);
		const attached = getAttachedDocument(this.document);
		const matches = (): boolean =>
			attached !== undefined &&
			attached[kCascade].mediaQueryMatches(media);
		const list = new EventTarget();
		// `matches` reads live. This holds the value the last "change" event
		// reported.
		let notified = matches();
		installEventHandler(list, "onchange");
		Object.defineProperties(list, {
			media: {get: () => media, enumerable: true, configurable: true},
			matches: {get: matches, enumerable: true, configurable: true},
			// The pre-2020 MediaQueryList API, which much deployed code still
			// calls: plain aliases for the EventTarget pair.
			addListener: {
				value: (callback: ((event: Event) => void) | null) => {
					if (callback) {
						list.addEventListener("change", callback);
					}
				},
				configurable: true,
			},
			removeListener: {
				value: (callback: ((event: Event) => void) | null) => {
					if (callback) {
						list.removeEventListener("change", callback);
					}
				},
				configurable: true,
			},
		});
		watchMediaQuery(this.document, () => {
			const now = matches();
			if (now === notified) {
				return;
			}
			notified = now;
			const event = new Event("change");
			Object.defineProperties(event, {
				matches: {value: now, enumerable: true},
				media: {value: media, enumerable: true},
			});
			dispatchAsUserAgent(list, event);
		});
		return list as unknown as MediaQueryList;
	}

	// Closes the terminal session the way closing a browser tab would.
	// beforeunload runs first, and a listener that cancels keeps the
	// session. A browser answers a canceled beforeunload with its own prompt.
	// A terminal has no UA chrome to prompt with, so cancellation stops the
	// teardown and leaves the app to ask "are you sure?" however it likes
	// and to call closeDialog() again once the user confirms. Every close asks
	// again; the event carries nothing from the last one.
	close(): void {
		const attached = getAttachedDocument(this.document);
		if (attached === undefined) {
			return;
		}
		const event = createBeforeUnloadEvent();
		dispatchAsUserAgent(this, event);
		if (event.defaultPrevented || event.returnValue !== "") {
			return;
		}
		closeTermDOM(attached[kTermDOM]);
	}
}

function createBeforeUnloadEvent(): BeforeUnloadEvent {
	return constructInternal(() => new BeforeUnloadEvent());
}

function watchMediaQuery(document: Document, update: () => void): void {
	let updaters = mediaQueryEvaluators.get(document);
	if (updaters === undefined) {
		updaters = new Set();
		mediaQueryEvaluators.set(document, updaters);
	}
	updaters.add(update);
}

// A window has both event handler mixins the HTML Standard gives it:
// GlobalEventHandlers, shared with elements and documents, and
// WindowEventHandlers, whose members exist as attributes whether or not
// this engine fires them.
installEventHandlers(Window.prototype, GLOBAL_EVENT_HANDLERS);
installEventHandlers(Window.prototype, WINDOW_EVENT_HANDLERS);

// RUNTIME: installed on prototypes at load.
type NodeConstants =
	"ELEMENT_NODE" |
	"ATTRIBUTE_NODE" |
	"TEXT_NODE" |
	"CDATA_SECTION_NODE" |
	"ENTITY_REFERENCE_NODE" |
	"ENTITY_NODE" |
	"PROCESSING_INSTRUCTION_NODE" |
	"COMMENT_NODE" |
	"DOCUMENT_NODE" |
	"DOCUMENT_TYPE_NODE" |
	"DOCUMENT_FRAGMENT_NODE" |
	"NOTATION_NODE" |
	"DOCUMENT_POSITION_DISCONNECTED" |
	"DOCUMENT_POSITION_PRECEDING" |
	"DOCUMENT_POSITION_FOLLOWING" |
	"DOCUMENT_POSITION_CONTAINS" |
	"DOCUMENT_POSITION_CONTAINED_BY" |
	"DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC";

// RUNTIME: installed from the tables.
type ChildNodeMixin =
	"after" |
	"before" |
	"remove" |
	"replaceWith" |
	"nextElementSibling" |
	"previousElementSibling";

// RUNTIME: installed from the tables.
type ParentNodeMixin =
	"childElementCount" |
	"children" |
	"firstElementChild" |
	"lastElementChild" |
	"append" |
	"prepend" |
	"querySelector" |
	"querySelectorAll" |
	"replaceChildren";

// RUNTIME: installed from the tables.
type ARIAReflection =
	"role" |
	`aria${string}`;

// RUNTIME: installed from the tables.
type SelectorSurface = "closest" | "matches" | "webkitMatchesSelector";

// RUNTIME: installed from the tables.
type FullscreenSurface = "onfullscreenchange" | "onfullscreenerror";

// The one place an interface joins the window. A class not listed here
// is not visible to script, whatever this module exports.
const platform = {
	AbstractRange,
	AnimationEvent,
	Attr,
	BeforeUnloadEvent,
	CDATASection,
	CharacterData,
	Clipboard,
	ClipboardEvent,
	ClipboardItem,
	Comment,
	CompositionEvent,
	CustomElementRegistry,
	CustomEvent,
	CustomStateSet,
	DOMImplementation,
	DOMParser,
	DOMRect,
	DOMRectList,
	DOMRectReadOnly,
	DOMStringList,
	DOMStringMap,
	DOMTokenList,
	DataTransfer,
	DataTransferItem,
	DataTransferItemList,
	Document,
	DocumentFragment,
	DocumentType,
	DragEvent,
	Element,
	ElementInternals,
	Event,
	EventTarget,
	FileList,
	FocusEvent,
	HTMLAnchorElement,
	HTMLAreaElement,
	HTMLAudioElement,
	HTMLBRElement,
	HTMLBaseElement,
	HTMLBodyElement,
	HTMLButtonElement,
	HTMLCanvasElement,
	HTMLCollection,
	HTMLDListElement,
	HTMLDataElement,
	HTMLDataListElement,
	HTMLDetailsElement,
	HTMLDialogElement,
	HTMLDirectoryElement,
	HTMLDivElement,
	HTMLElement,
	HTMLEmbedElement,
	HTMLFieldSetElement,
	HTMLFontElement,
	HTMLFormControlsCollection,
	HTMLFormElement,
	HTMLFrameElement,
	HTMLFrameSetElement,
	HTMLHRElement,
	HTMLHeadElement,
	HTMLHeadingElement,
	HTMLHtmlElement,
	HTMLIFrameElement,
	HTMLImageElement,
	HTMLInputElement,
	HTMLLIElement,
	HTMLLabelElement,
	HTMLLegendElement,
	HTMLLinkElement,
	HTMLMapElement,
	HTMLMarqueeElement,
	HTMLMediaElement,
	HTMLMenuElement,
	HTMLMetaElement,
	HTMLMeterElement,
	HTMLModElement,
	HTMLOListElement,
	HTMLObjectElement,
	HTMLOptGroupElement,
	HTMLOptionElement,
	HTMLOptionsCollection,
	HTMLOutputElement,
	HTMLParagraphElement,
	HTMLParamElement,
	HTMLPictureElement,
	HTMLPreElement,
	HTMLProgressElement,
	HTMLQuoteElement,
	HTMLScriptElement,
	HTMLSelectElement,
	HTMLSlotElement,
	HTMLSourceElement,
	HTMLSpanElement,
	HTMLStyleElement,
	HTMLTableCaptionElement,
	HTMLTableCellElement,
	HTMLTableColElement,
	HTMLTableElement,
	HTMLTableRowElement,
	HTMLTableSectionElement,
	HTMLTemplateElement,
	HTMLTextAreaElement,
	HTMLTimeElement,
	HTMLTitleElement,
	HTMLTrackElement,
	HTMLUListElement,
	HTMLUnknownElement,
	HTMLVideoElement,
	HashChangeEvent,
	InputEvent,
	IntersectionObserver,
	KeyboardEvent,
	Location,
	MathMLElement,
	MessageEvent,
	MouseEvent,
	MutationObserver,
	MutationRecord,
	NamedNodeMap,
	Node,
	NodeFilter,
	NodeIterator,
	NodeList,
	Permissions,
	PermissionStatus,
	PointerEvent,
	ProcessingInstruction,
	RadioNodeList,
	Range,
	ResizeObserver,
	SVGElement,
	Selection,
	ShadowRoot,
	StaticRange,
	StorageEvent,
	SubmitEvent,
	Text,
	TextEvent,
	ToggleEvent,
	TransitionEvent,
	TreeWalker,
	UIEvent,
	ValidityState,
	WheelEvent,
	Window,
	XMLDocument,
} as const;

// addEventListener/removeEventListener come from EventTarget, so the
// mixins' redeclarations are dropped.
type WindowEventHandlerAttributes = Omit<
	globalThis.GlobalEventHandlers & globalThis.WindowEventHandlers,
	"addEventListener" | "removeEventListener"
>;

/**
 * A terminal has one screen and no browsing context, so the window is a
 * plain object rather than a global. It exposes this file's interfaces,
 * the scrolling and sizing the display implements, and the handful of
 * APIs an author reaches for through `window`. The member types are the
 * host's, which is how a caller outside this file sees them.
 */
export interface Window extends WindowEventHandlerAttributes {
	// An overload with the host's event type, so a caller holding a Window
	// can dispatch a platform event as it would to any EventTarget.
	dispatchEvent(event: globalThis.Event): boolean;
	readonly window: Window;
	readonly self: Window;

	getComputedStyle(
		element: globalThis.Element,
		pseudoElement?: string | null,
	): globalThis.CSSStyleDeclaration;
	setTimeout: typeof globalThis.setTimeout;
	clearTimeout: typeof globalThis.clearTimeout;
	setInterval: typeof globalThis.setInterval;
	clearInterval: typeof globalThis.clearInterval;
	queueMicrotask: typeof globalThis.queueMicrotask;

	readonly NodeFilter: typeof globalThis.NodeFilter;

	EventTarget: typeof globalThis.EventTarget;
	Event: typeof globalThis.Event;
	CustomEvent: typeof globalThis.CustomEvent;
	UIEvent: typeof globalThis.UIEvent;
	MouseEvent: typeof globalThis.MouseEvent;
	PointerEvent: typeof globalThis.PointerEvent;
	WheelEvent: typeof globalThis.WheelEvent;
	KeyboardEvent: typeof globalThis.KeyboardEvent;
	FocusEvent: typeof globalThis.FocusEvent;
	InputEvent: typeof globalThis.InputEvent;
	ClipboardEvent: typeof ClipboardEvent;
	DataTransfer: typeof DataTransfer;
	DataTransferItem: typeof DataTransferItem;
	DataTransferItemList: typeof DataTransferItemList;
	FileList: typeof FileList;
	Clipboard: typeof Clipboard;
	ClipboardItem: typeof ClipboardItem;
	Permissions: typeof Permissions;
	PermissionStatus: typeof PermissionStatus;
	CompositionEvent: typeof globalThis.CompositionEvent;
	BeforeUnloadEvent: typeof globalThis.BeforeUnloadEvent;
	DOMException: typeof globalThis.DOMException;
	Node: typeof globalThis.Node;
	Element: typeof globalThis.Element;
	Attr: typeof globalThis.Attr;
	CharacterData: typeof globalThis.CharacterData;
	Text: typeof globalThis.Text;
	Comment: typeof globalThis.Comment;
	CDATASection: typeof globalThis.CDATASection;
	ProcessingInstruction: typeof globalThis.ProcessingInstruction;
	DocumentType: typeof globalThis.DocumentType;
	Document: typeof globalThis.Document;
	XMLDocument: typeof globalThis.XMLDocument;
	DocumentFragment: typeof globalThis.DocumentFragment;
	ShadowRoot: typeof globalThis.ShadowRoot;
	DOMImplementation: typeof globalThis.DOMImplementation;
	DOMParser: typeof globalThis.DOMParser;
	NodeList: typeof globalThis.NodeList;
	HTMLCollection: typeof globalThis.HTMLCollection;
	NamedNodeMap: typeof globalThis.NamedNodeMap;
	DOMTokenList: typeof globalThis.DOMTokenList;
	DOMStringMap: typeof globalThis.DOMStringMap;
	MutationObserver: typeof globalThis.MutationObserver;
	MutationRecord: typeof globalThis.MutationRecord;
	NodeIterator: typeof globalThis.NodeIterator;
	TreeWalker: typeof globalThis.TreeWalker;
	AbstractRange: typeof globalThis.AbstractRange;
	StaticRange: typeof globalThis.StaticRange;
	Range: typeof globalThis.Range;
	Selection: typeof globalThis.Selection;
	DOMRect: typeof globalThis.DOMRect;
	DOMRectReadOnly: typeof globalThis.DOMRectReadOnly;
	CustomElementRegistry: typeof globalThis.CustomElementRegistry;
	ElementInternals: typeof globalThis.ElementInternals;
	ValidityState: typeof globalThis.ValidityState;
	SVGElement: typeof globalThis.SVGElement;
	MathMLElement: typeof globalThis.MathMLElement;
	HTMLElement: typeof globalThis.HTMLElement;
	HTMLInputElement: typeof globalThis.HTMLInputElement;
	HTMLTextAreaElement: typeof globalThis.HTMLTextAreaElement;
	HTMLSelectElement: typeof globalThis.HTMLSelectElement;
	HTMLOptionElement: typeof globalThis.HTMLOptionElement;
	HTMLButtonElement: typeof globalThis.HTMLButtonElement;
	HTMLLabelElement: typeof globalThis.HTMLLabelElement;
	HTMLAnchorElement: typeof globalThis.HTMLAnchorElement;
	HTMLStyleElement: typeof globalThis.HTMLStyleElement;
	HTMLLinkElement: typeof globalThis.HTMLLinkElement;
	HTMLFormElement: typeof globalThis.HTMLFormElement;
	HTMLDetailsElement: typeof globalThis.HTMLDetailsElement;
	HTMLDialogElement: typeof globalThis.HTMLDialogElement;
	HTMLTemplateElement: typeof globalThis.HTMLTemplateElement;
	HTMLSlotElement: typeof globalThis.HTMLSlotElement;
	CSSStyleDeclaration: typeof globalThis.CSSStyleDeclaration;
	CSSStyleSheet: typeof globalThis.CSSStyleSheet;
	ResizeObserver: typeof globalThis.ResizeObserver;
	IntersectionObserver: typeof globalThis.IntersectionObserver;
}

// A window starts with its interfaces and the timers any script expects
// to find. The display fills in the rest (sizing, scrolling, animation
// frames, the clipboard) as it mounts the document.
function buildWindow(document: Document): Window {
	const window = new Window(document) as unknown as Record<string, unknown>;
	Object.assign(window, platform, {
		// The platform's DOMException, which is the one the DOM and the CSSOM
		// throw. A caller's `instanceof DOMException` has to match the class
		// the engine builds its errors from.
		DOMException: PlatformDOMException,
		setTimeout: globalThis.setTimeout.bind(globalThis),
		clearTimeout: globalThis.clearTimeout.bind(globalThis),
		setInterval: globalThis.setInterval.bind(globalThis),
		clearInterval: globalThis.clearInterval.bind(globalThis),
		queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
	});
	window.window = window;
	window.self = window;
	return window as unknown as Window;
}

/** Parse a document from markup and display it in a window of its own. */
export function createDocumentWindow(html: string, url?: string): Window {
	return buildWindow(parseHTMLDocument(html, url));
}

// CSS Selectors: the language, and the matcher a selector compiles to.
// css-tree parses the selector. It is checked against the pseudo-classes
// and pseudo-elements this engine knows and compiled into one closure per
// compound selector. The closures read the node's structure and the
// document state around it: which element the pointer is over, which has
// focus, what a shadow root's host is, whether a dialog is modal. A bug
// in a pseudo-class is a bug in one function rather than in generated
// source. bidi-js finds the first strong character for `:dir(auto)`.
// Matching runs right to left, from the subject compound outwards, which
// makes a long descendant selector cheap: the first compound that fails
// ends the walk.

// A selector naming anything else does not parse, which makes
// `:gibberish` invalid rather than merely unmatched.
const PSEUDO_CLASSES: ReadonlySet<string> = new Set([
	"active",
	"any-link",
	"autofill",
	"blank",
	"buffering",
	"checked",
	"closed",
	"current",
	"default",
	"defined",
	"dir",
	"disabled",
	"empty",
	"enabled",
	"first",
	"first-child",
	"first-of-type",
	"focus",
	"focus-visible",
	"focus-within",
	"fullscreen",
	"future",
	"has",
	"host",
	"host-context",
	"hover",
	"in-range",
	"indeterminate",
	"invalid",
	"is",
	"lang",
	"last-child",
	"last-of-type",
	"left",
	"link",
	"local-link",
	"modal",
	"muted",
	"not",
	"nth-child",
	"nth-col",
	"nth-last-child",
	"nth-last-col",
	"nth-last-of-type",
	"nth-of-type",
	"only-child",
	"only-of-type",
	"open",
	"optional",
	"out-of-range",
	"past",
	"paused",
	"picture-in-picture",
	"placeholder-shown",
	"playing",
	"popover-open",
	"read-only",
	"read-write",
	"required",
	"right",
	"root",
	"scope",
	"seeking",
	"stalled",
	"state",
	"target",
	"target-current",
	"target-within",
	"user-invalid",
	"user-valid",
	"valid",
	"visited",
	"volume-locked",
	"where",
	"window-inactive",
]);

const PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
	"after",
	"backdrop",
	"before",
	"checkmark",
	"column",
	"cue",
	"cue-region",
	"details-content",
	"file-selector-button",
	"first-letter",
	"first-line",
	"grammar-error",
	"highlight",
	"marker",
	"part",
	"picker",
	"picker-icon",
	"placeholder",
	"scroll-button",
	"scroll-marker",
	"scroll-marker-group",
	"selection",
	"slotted",
	"spelling-error",
	"target-text",
	"view-transition",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

// Written only in functional form: `::part(name)`, never a bare
// `::part`.
const FUNCTIONAL_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
	"highlight",
	"part",
	"picker",
	"scroll-button",
	"slotted",
	"view-transition-group",
	"view-transition-image-pair",
	"view-transition-new",
	"view-transition-old",
]);

/** May also be written with one colon, per CSS 2. */
export const LEGACY_PSEUDO_ELEMENTS: ReadonlySet<string> = new Set([
	"after",
	"before",
	"first-letter",
	"first-line",
]);

const ARGUMENTLESS_PSEUDO_CLASSES: ReadonlySet<string> = new Set([
	"active",
	"any-link",
	"autofill",
	"blank",
	"buffering",
	"checked",
	"closed",
	"current",
	"default",
	"defined",
	"disabled",
	"empty",
	"enabled",
	"first",
	"first-child",
	"first-of-type",
	"focus",
	"focus-visible",
	"focus-within",
	"fullscreen",
	"future",
	"hover",
	"in-range",
	"indeterminate",
	"invalid",
	"last-child",
	"last-of-type",
	"left",
	"link",
	"local-link",
	"modal",
	"muted",
	"only-child",
	"only-of-type",
	"open",
	"optional",
	"out-of-range",
	"past",
	"paused",
	"picture-in-picture",
	"placeholder-shown",
	"playing",
	"popover-open",
	"read-only",
	"read-write",
	"required",
	"right",
	"root",
	"scope",
	"seeking",
	"stalled",
	"target",
	"target-current",
	"target-within",
	"user-invalid",
	"user-valid",
	"valid",
	"visited",
	"volume-locked",
	"window-inactive",
]);

/** A selector AST node, as the CSS parser produces it. */
export interface SelectorNode {
	type: string;
	name?: string | {type: string; name: string};
	matcher?: string | null;
	value?: {type: string; value?: string; name?: string} | null;
	flags?: string | null;
	children?: {toArray(): SelectorNode[]} | SelectorNode[] | null;
	nth?: SelectorNode | null;
	selector?: SelectorNode | null;
	a?: string | null;
	b?: string | null;
}

export function getChildren(node: SelectorNode): SelectorNode[] {
	const children = node.children;
	if (!children) {
		return [];
	}
	return Array.isArray(children) ? children : children.toArray();
}

/**
 * The identifier the source escapes spell, ASCII-lowercased.
 * `::\000041fter` and `::AFTER` are both `::after`. An escape is part of
 * the spelling, not of the name.
 */
export function pseudoName(name: string): string {
	return CSSTree.ident.decode(name).toLowerCase();
}

/** The namespaces a selector's prefixes resolve against. */
export interface SelectorNamespaces {
	default: string | null;
	prefixes: Map<string, string>;
}

export const NO_NAMESPACES: SelectorNamespaces = {
	default: null,
	prefixes: new Map(),
};

/** A selector this engine rejects, thrown from compilation. */
export class SelectorError extends Error {}

function matchNothing(): boolean {
	return false;
}

interface MatchState {

	// The node `:scope` refers to, or null when the selector uses none.
	scope: Node | null;

	// The shadow root the selector was written inside, for `:host`.
	shadow: Node | null;

	// The node a relative selector inside `:has()` is anchored to.
	anchor: Node | null;
}

type Predicate = (element: Element, state: MatchState) => boolean;

type Combinator = " " | ">" | "+" | "~";

interface CompiledCompound {

	tests: Predicate[];

	// The element the compound really describes, when a pseudo-element
	// moves the subject. `slot::slotted(span)` selects the span and
	// describes the slot. `host::part(x)` selects the part and describes the
	// host. The combinator to the left steps from what this returns.
	origin: ((element: Element, state: MatchState) => Element | null) | null;

	originTests: Predicate[];

	// May match a featureless shadow host.
	host: boolean;
}

interface CompiledComplex {
	compounds: CompiledCompound[];

	// Joins compound `index` to compound `index + 1`.
	combinators: Combinator[];
}

/** A compiled selector list, ready to match against an element. */
export interface CompiledSelector {
	list: CompiledComplex[];
}

// CSS Syntax closes an unterminated string, function or block at end of
// file rather than rejecting it, so `[align="center"` and
// `::slotted(foo` are both selectors. css-tree needs them closed.
function closeAtEndOfInput(text: string): string {
	const open: string[] = [];
	let quote = "";
	let dangling = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === "\\") {
			// An escape with nothing left to escape stands for U+FFFD, so the
			// name it is part of is still a name and the selector is still a
			// selector.
			dangling = index === text.length - 1;
			index++;
			continue;
		}
		if (quote !== "") {
			if (char === quote) {
				quote = "";
			}
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(") {
			open.push(")");
		} else if (char === "[") {
			open.push("]");
		} else if (char === ")" || char === "]") {
			if (open[open.length - 1] === char) {
				open.pop();
			}
		}
	}
	if (open.length === 0 && quote === "" && !dangling) {
		return text;
	}
	return (
		text + (dangling ? "\uFFFD" : "") + quote + open.reverse().join("")
	);
}

// `div,` and a bare `,` both contain an empty selector. css-tree drops
// the empty one and parses the rest, but a selector list that cannot be
// parsed is not a selector list.
function hasEmptySelector(text: string): boolean {
	let depth = 0;
	let quote = "";
	let start = 0;
	const empty = (end: number): boolean => text.slice(start, end).trim() === "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote !== "") {
			if (char === "\\") {
				index++;
			} else if (char === quote) {
				quote = "";
			}
		} else if (char === "\\") {
			index++;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(" || char === "[") {
			depth++;
		} else if (char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			if (empty(index)) {
				return true;
			}
			start = index + 1;
		}
	}
	return empty(text.length);
}

// Checks shape only. A prefix means whatever the sheet declares, which
// is not this check's concern, and `&` is allowed where a rule encloses
// it.
const GRAMMAR_ONLY: CompileOptions = {
	namespaces: null,
	pseudoElements: true,
	nesting: true,
	// `@scope` lets a rule open with a combinator. Anywhere else such a
	// rule parses as a selector and then selects nothing, since there is no
	// root for it to be relative to.
	relative: true,
};

// Normalizes newlines and replaces every null and lone surrogate with
// U+FFFD (CSS Syntax 3).
function preprocess(text: string): string {
	if (!/[\0\r\f\uD800-\uDFFF]/.test(text)) {
		return text;
	}
	return text
		.replace(/\r\n?|\f/g, "\n")
		.replace(/\0/g, "\uFFFD")
		.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "\uFFFD")
		.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function parseSelectorAST(text: string): SelectorNode | null {
	const source = preprocess(String(text));
	if (source.trim() === "" || hasEmptySelector(source)) {
		return null;
	}
	let list: SelectorNode;
	try {
		list = CSSTree.parse(closeAtEndOfInput(source), {
			context: "selectorList",
			onParseError(error: Error) {
				throw error;
			},
		}) as unknown as SelectorNode;
	} catch (_err) {
		return null;
	}
	return list.type === "SelectorList" ? list : null;
}

/**
 * Returns null when the text does not parse, including when it uses a
 * pseudo this engine does not know, since an unknown pseudo makes the
 * whole selector invalid. Prefixes are checked for shape only. Whether
 * `svg|circle` names a declared namespace is for whoever knows the
 * declarations.
 */
export function parseSelectorList(text: string): SelectorNode | null {
	const list = parseSelectorAST(text);
	if (list === null) {
		return null;
	}
	try {
		compileSelector(text, GRAMMAR_ONLY);
	} catch (_err) {
		return null;
	}
	return list;
}

interface CompileOptions {

	// Null leaves the prefixes unresolved: the selector is checked for
	// shape and every prefix is accepted. A grammar check wants that; a
	// match does not.
	namespaces?: SelectorNamespaces | null;

	// The DOM's own query methods accept `a::before` and match nothing with
	// it. The cascade, which matches `::slotted()` and `::part()` for real,
	// sets this.
	pseudoElements?: boolean;

	// Allow the selector to open with a combinator, as `@scope` does.
	relative?: boolean;

	// `&` is allowed inside a style rule and nowhere else. It selects
	// nothing on its own; the rule it is nested in gives it something to
	// refer to.
	nesting?: boolean;
}

interface Compiling {
	namespaces: SelectorNamespaces | null;
	pseudoElements: boolean;
	nesting: boolean;
}

function compileList(
	list: SelectorNode,
	options: CompileOptions,
): CompiledSelector {
	const compiling: Compiling = {
		namespaces:
			options.namespaces === undefined ? NO_NAMESPACES : options.namespaces,
		pseudoElements: options.pseudoElements ?? false,
		nesting: options.nesting ?? false,
	};
	const compiled: CompiledComplex[] = [];
	for (const selector of getChildren(list)) {
		if (selector.type !== "Selector") {
			throw new SelectorError("a selector list holds selectors");
		}
		compiled.push(
			compileComplex(selector, compiling, options.relative ?? false),
		);
	}
	if (compiled.length === 0) {
		throw new SelectorError("a selector list selects something");
	}
	return {list: compiled};
}

function compileComplex(
	selector: SelectorNode,
	compiling: Compiling,
	relative: boolean,
): CompiledComplex {
	const parts = getChildren(selector);
	if (parts.length === 0) {
		throw new SelectorError("a selector selects something");
	}
	const compounds: CompiledCompound[] = [];
	const combinators: Combinator[] = [];
	let pending: SelectorNode[] = [];
	let started = false;
	for (const [index, part] of parts.entries()) {
		if (part.type !== "Combinator") {
			pending.push(part);
			continue;
		}
		const combinator = String(part.name ?? " ").trim() || " ";
		if (combinator !== " " && !"> + ~".includes(combinator)) {
			throw new SelectorError(`unknown combinator ${combinator}`);
		}
		if (index === 0) {
			// A relative selector opens with a combinator and is anchored to
			// whatever the caller says. Anywhere else that is a parse error.
			if (!relative || started) {
				throw new SelectorError("a selector may not open with a combinator");
			}
			compounds.push(ANCHOR_COMPOUND);
			combinators.push(combinator as Combinator);
			started = true;
			continue;
		}
		if (pending.length === 0) {
			throw new SelectorError("two combinators in a row");
		}
		compounds.push(compileCompound(pending, compiling));
		combinators.push(combinator as Combinator);
		pending = [];
		started = true;
	}
	if (pending.length === 0) {
		throw new SelectorError("a combinator joins two compounds");
	}
	compounds.push(compileCompound(pending, compiling));
	return {compounds, combinators};
}

// The compound a relative selector hangs from: the element `:has()` was
// asked about.
const ANCHOR_COMPOUND: CompiledCompound = {
	tests: [
		(element: Element, state: MatchState): boolean =>
			element === state.anchor,
	],
	origin: null,
	originTests: [],
	host: false,
};

function compileCompound(
	parts: SelectorNode[],
	compiling: Compiling,
): CompiledCompound {
	const compound: CompiledCompound = {
		tests: [],
		origin: null,
		originTests: [],
		host: false,
	};
	// A type selector is only a type selector when written first.
	for (const [index, part] of parts.entries()) {
		if (part.type === "TypeSelector" && index !== 0) {
			throw new SelectorError("a type selector opens its compound");
		}
	}
	for (const part of parts) {
		compileSimple(part, compound, compiling);
	}
	// CSS Namespaces 2: a default namespace applies to a compound that
	// names no type, so with an HTML default declared, `.card` selects no
	// SVG element. A featureless host is outside all of that.
	const declared = compiling.namespaces?.default ?? null;
	if (
		declared !== null &&
		!compound.host &&
		!parts.some((part) => part.type === "TypeSelector")
	) {
		compound.tests.push((element) => element.namespaceURI === declared);
	}
	return compound;
}

function compileSimple(
	part: SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	switch (part.type) {
		case "TypeSelector":
			compound.tests.push(compileType(String(part.name ?? ""), compiling));
			return;
		case "IdSelector": {
			const id = CSSTree.ident.decode(String(part.name ?? ""));
			if (id === "") {
				throw new SelectorError("an id selector names an id");
			}
			const folded = toASCIILowercase(id);
			compound.tests.push((element) => {
				const value = element.getAttribute("id");
				if (value === null) {
					return false;
				}
				return isInQuirksMode(element)
					? toASCIILowercase(value) === folded
					: value === id;
			});
			return;
		}
		case "ClassSelector": {
			const name = CSSTree.ident.decode(String(part.name ?? ""));
			if (name === "") {
				throw new SelectorError("a class selector names a class");
			}
			const folded = toASCIILowercase(name);
			compound.tests.push((element) => {
				const value = element.getAttribute("class");
				if (value === null) {
					return false;
				}
				const quirks = isInQuirksMode(element);
				for (const token of splitOnWhitespace(value)) {
					if (quirks ? toASCIILowercase(token) === folded : token === name) {
						return true;
					}
				}
				return false;
			});
			return;
		}
		case "AttributeSelector":
			compound.tests.push(compileAttribute(part, compiling));
			return;
		case "PseudoClassSelector":
			compilePseudoClass(part, compound, compiling);
			return;
		case "PseudoElementSelector":
			compilePseudoElement(part, compound, compiling);
			return;
		case "NestingSelector":
			if (!compiling.nesting) {
				throw new SelectorError("a nesting selector needs a rule around it");
			}
			compound.tests.push(matchNothing);
			return;
		default:
			throw new SelectorError(`unreadable selector part ${part.type}`);
	}
}

interface QualifiedName {

	// Null for no namespace, undefined for any.
	namespace: string | null | undefined;

	// Null for `*`.
	local: string | null;
}

function getQualifiedName(
	name: string,
	namespaces: SelectorNamespaces | null,
	attribute: boolean,
): QualifiedName {
	const bar = name.lastIndexOf("|");
	if (bar === -1) {
		const local = CSSTree.ident.decode(name);
		return {
			// An attribute with no prefix is in no namespace. An element with
			// no prefix is in the default namespace the sheet declared.
			namespace: attribute ? null : (namespaces?.default ?? undefined),
			local: local === "*" ? null : local,
		};
	}
	const prefix = name.slice(0, bar);
	const rest = name.slice(bar + 1);
	const local = rest === "*" ? null : CSSTree.ident.decode(rest);
	if (prefix === "*") {
		return {namespace: undefined, local};
	}
	if (prefix === "") {
		return {namespace: null, local};
	}
	if (namespaces === null) {
		return {namespace: undefined, local};
	}
	const uri = namespaces.prefixes.get(CSSTree.ident.decode(prefix));
	if (uri === undefined) {
		throw new SelectorError(`no namespace is declared for ${prefix}`);
	}
	return {namespace: uri, local};
}

// ASCII case-insensitive against an HTML element in an HTML document,
// case-sensitive everywhere else. That keeps `feGaussianBlur` isSelectable
// and lets `DIV` match a `div`.
function compileType(name: string, compiling: Compiling): Predicate {
	const {
		namespace,
		local,
	} = getQualifiedName(name, compiling.namespaces, false);
	const folded = local === null ? null : toASCIILowercase(local);
	return (element) => {
		if (element.nodeType !== ELEMENT_NODE) {
			return false;
		}
		if (namespace !== undefined && element.namespaceURI !== namespace) {
			return false;
		}
		if (local === null) {
			return true;
		}
		if (element.localName === local) {
			return true;
		}
		return (
			element.namespaceURI === HTML_NAMESPACE &&
			isHTMLNode(element) &&
			toASCIILowercase(element.localName) === folded
		);
	};
}

// Compared case-insensitively on an HTML element in an HTML document
// when the selector does not state its own case sensitivity.
const CASE_INSENSITIVE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"accept",
	"accept-charset",
	"align",
	"alink",
	"axis",
	"bgcolor",
	"charset",
	"checked",
	"clear",
	"codetype",
	"color",
	"compact",
	"declare",
	"defer",
	"dir",
	"direction",
	"disabled",
	"enctype",
	"face",
	"frame",
	"frameborder",
	"hreflang",
	"http-equiv",
	"lang",
	"language",
	"link",
	"media",
	"method",
	"multiple",
	"nohref",
	"noresize",
	"noshade",
	"nowrap",
	"readonly",
	"rel",
	"rev",
	"rules",
	"scope",
	"scrolling",
	"selected",
	"shape",
	"target",
	"text",
	"type",
	"valign",
	"valuetype",
	"vlink",
]);

const ATTRIBUTE_OPERATORS = new Set(["=", "~=", "|=", "^=", "$=", "*="]);

function compileAttribute(
	part: SelectorNode,
	compiling: Compiling,
): Predicate {
	const qualified = (part.name as {name?: string} | undefined)?.name;
	const {namespace, local} = getQualifiedName(
		String(qualified ?? ""),
		compiling.namespaces,
		true,
	);
	if (local === null) {
		throw new SelectorError("an attribute selector names an attribute");
	}
	const folded = toASCIILowercase(local);
	const flags = part.flags === null || part.flags === undefined
		? ""
		: toASCIILowercase(String(part.flags));
	if (flags !== "" && flags !== "i" && flags !== "s") {
		throw new SelectorError(`unknown attribute flag ${flags}`);
	}
	// Read the attribute the way HTML reads a name. An HTML element in an
	// HTML document lowercases its attribute names.
	const read = (element: Element): string | null => {
		const fold =
			element.namespaceURI === HTML_NAMESPACE && isHTMLNode(element);
		const attributes = element.attributes;
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			if (namespace !== undefined && attribute.namespaceURI !== namespace) {
				continue;
			}
			const name = attribute.localName;
			if (name === local || (fold && toASCIILowercase(name) === folded)) {
				return attribute.value;
			}
		}
		return null;
	};
	const operator = part.matcher ?? null;
	if (operator === null) {
		return (element) => read(element) !== null;
	}
	if (!ATTRIBUTE_OPERATORS.has(operator)) {
		throw new SelectorError(`unknown attribute operator ${operator}`);
	}
	const raw = part.value;
	let wanted: string;
	if (raw && raw.type === "String") {
		wanted = String(raw.value ?? "");
	} else if (raw && raw.type === "Identifier") {
		wanted = CSSTree.ident.decode(String(raw.name ?? ""));
	} else {
		throw new SelectorError("an attribute selector compares to one value");
	}
	const foldedWanted = toASCIILowercase(wanted);
	return (element) => {
		const value = read(element);
		if (value === null) {
			return false;
		}
		const insensitive =
			flags === "i" ||
			(flags === "" &&
				element.namespaceURI === HTML_NAMESPACE &&
				isHTMLNode(element) &&
				CASE_INSENSITIVE_ATTRIBUTES.has(folded));
		const subject = insensitive ? toASCIILowercase(value) : value;
		const target = insensitive ? foldedWanted : wanted;
		switch (operator) {
			case "=":
				return subject === target;
			case "~=":
				// A value with whitespace in it, or an empty value, is in no
				// list.
				if (target === "" || /[\t\n\f\r ]/.test(target)) {
					return false;
				}
				return splitOnWhitespace(subject).includes(target);
			case "|=":
				return subject === target || subject.startsWith(`${target}-`);
			case "^=":
				return target !== "" && subject.startsWith(target);
			case "$=":
				return target !== "" && subject.endsWith(target);
			default:
				return target !== "" && subject.includes(target);
		}
	};
}

function compilePseudoClass(
	part: SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	const name = pseudoName(String(part.name ?? ""));
	const args = getChildren(part);
	if (LEGACY_PSEUDO_ELEMENTS.has(name) && !PSEUDO_CLASSES.has(name)) {
		compilePseudoElement(part, compound, compiling);
		return;
	}
	if (!PSEUDO_CLASSES.has(name)) {
		throw new SelectorError(`unknown pseudo-class :${name}`);
	}
	if (ARGUMENTLESS_PSEUDO_CLASSES.has(name) && args.length !== 0) {
		throw new SelectorError(`:${name} takes no argument`);
	}
	if (
		!ARGUMENTLESS_PSEUDO_CLASSES.has(name) &&
		args.length === 0 &&
		name !== "host"
	) {
		throw new SelectorError(`:${name} takes an argument`);
	}
	switch (name) {
		case "is":
		case "where":
		case "matches": {
			const inner = compileForgiving(args, compiling);
			compound.tests.push((element, state) =>
				inner.some((complex) => matchComplex(complex, element, state, false)),
			);
			return;
		}
		case "not": {
			const inner = compileArgumentList(args, compiling, false);
			compound.tests.push(
				(element, state) =>
					!inner.some((complex) =>
						matchComplex(complex, element, state, false),
					),
			);
			return;
		}
		case "has": {
			const inner = compileArgumentList(args, compiling, true);
			compound.tests.push((element, state) => hasMatch(inner, element, state));
			return;
		}
		case "host":
		case "host-context": {
			compound.host = true;
			const inner =
				args.length === 0 ? null : compileArgumentList(args, compiling, false);
			const context = name === "host-context";
			compound.tests.push((element, state) => {
				const shadow = state.shadow;
				if (shadow === null || getShadowHost(shadow) !== element) {
					return false;
				}
				if (inner === null) {
					return true;
				}
				const outer = {...state, shadow: null};
				if (!context) {
					return inner.some((complex) =>
						matchComplex(complex, element, outer, false),
					);
				}
				for (
					let node: Element | null = element;
					node !== null;
					node = parentElement(node)
				) {
					if (
						inner.some((complex) => matchComplex(complex, node!, outer, false))
					) {
						return true;
					}
				}
				return false;
			});
			return;
		}
		case "scope":
			compound.tests.push((element, state) => element === state.scope);
			return;
		case "root":
			compound.tests.push((element) => {
				const parent = getParent(element);
				return parent !== null && parent.nodeType === DOCUMENT_NODE;
			});
			return;
		case "empty":
			compound.tests.push(isEmpty);
			return;
		case "first-child":
			compound.tests.push((element) => getPreviousElement(element) === null);
			return;
		case "last-child":
			compound.tests.push((element) => getNextElement(element) === null);
			return;
		case "only-child":
			compound.tests.push(
				(element) =>
					getPreviousElement(element) === null &&
					getNextElement(element) === null,
			);
			return;
		case "first-of-type":
			compound.tests.push((element) => getOfTypeIndex(element, false) === 1);
			return;
		case "last-of-type":
			compound.tests.push((element) => getOfTypeIndex(element, true) === 1);
			return;
		case "only-of-type":
			compound.tests.push(
				(element) =>
					getOfTypeIndex(element, false) === 1 &&
					getOfTypeIndex(element, true) === 1,
			);
			return;
		case "nth-child":
		case "nth-last-child":
		case "nth-of-type":
		case "nth-last-of-type":
			compound.tests.push(compileNth(name, args, compiling));
			return;
		case "lang":
			compound.tests.push(compileLang(args));
			return;
		case "dir":
			compound.tests.push(compileDir(args));
			return;
		case "state": {
			const wanted = getIdentifierArgument(args, "state");
			compound.tests.push((element) =>
				hasCustomState(element, wanted),
			);
			return;
		}
		case "link":
		case "any-link":
			compound.tests.push(isHyperlink);
			return;
		case "visited":
			// A terminal has never recorded a visited link, and answering would
			// leak history even if it had.
			compound.tests.push(matchNothing);
			return;
		case "target":
			compound.tests.push((element) => isTargetElement(element));
			return;
		case "hover":
			compound.tests.push((element) => isHovered(element));
			return;
		case "active":
			// Nothing here is ever between a press and a release. A terminal
			// reports the key or the click, not half of it.
			compound.tests.push(() => false);
			return;
		case "focus":
			compound.tests.push((element) => hasFocus(element));
			return;
		case "focus-visible":
			compound.tests.push((element) =>
				isFocusVisible(element),
			);
			return;
		case "focus-within":
			compound.tests.push((element) =>
				hasFocusWithin(element),
			);
			return;
		case "modal":
			compound.tests.push((element) => isModalDialog(element));
			return;
		case "popover-open":
			compound.tests.push((element) =>
				isShowingPopover(element),
			);
			return;
		case "fullscreen":
			compound.tests.push((element) =>
				isFullscreenElement(element),
			);
			return;
		case "defined":
			compound.tests.push((element) => isDefinedElement(element));
			return;
		case "open":
			compound.tests.push((element) => isOpenElement(element));
			return;
		case "closed":
			compound.tests.push(
				(element) => canOpen(element) && !isOpenElement(element),
			);
			return;
		case "checked":
			compound.tests.push((element) => isCheckedControl(element));
			return;
		case "indeterminate":
			compound.tests.push((element) =>
				isIndeterminateControl(element),
			);
			return;
		case "placeholder-shown":
			compound.tests.push((element) =>
				isPlaceholderShown(element),
			);
			return;
		case "default":
			compound.tests.push((element) =>
				isDefaultControl(element),
			);
			return;
		case "disabled":
			compound.tests.push(isDisabled);
			return;
		case "enabled":
			compound.tests.push(
				(element, state) => isDisableable(element) &&
					!isDisabled(element, state),
			);
			return;
		case "required":
			compound.tests.push(
				(element) =>
					isRequirable(element) && element.getAttribute("required") !== null,
			);
			return;
		case "optional":
			compound.tests.push(
				(element) =>
					isRequirable(element) && element.getAttribute("required") === null,
			);
			return;
		case "read-only":
			compound.tests.push((element, state) => !isMutable(element, state));
			return;
		case "read-write":
			compound.tests.push(isMutable);
			return;
		default:
			// Everything left names a state this user agent never enters: a
			// media element's buffering, a page box's side, a spatial
			// navigation target, autofill, and the constraint validation
			// family, which the conformance notes record as deliberately
			// absent.
			compound.tests.push(matchNothing);
	}
}

function getIdentifierArgument(args: SelectorNode[], name: string): string {
	const text = args
		.map((argument) =>
			argument.type === "Raw"
				? String((argument as {value?: string}).value ?? "")
				: argument.type === "Identifier"
					? String(argument.name ?? "")
					: " ",
		)
		.join("")
		.trim();
	if (!/^(?:[\w\u0080-\uFFFF-]|\\[^\n])+$/.test(text)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	// The escapes spell the name, and the name has to be an identifier. `1`
	// is a number however it is written.
	const identifier = CSSTree.ident.decode(text);
	if (!/^[a-zA-Z_\u0080-\uFFFF-][\w\u0080-\uFFFF-]*$/.test(identifier)) {
		throw new SelectorError(`:${name} takes one identifier`);
	}
	return identifier;
}

/** Drops the branches that do not parse. */
function compileForgiving(
	args: SelectorNode[],
	compiling: Compiling,
): CompiledComplex[] {
	const compiled: CompiledComplex[] = [];
	for (const argument of args) {
		const selectors =
			argument.type === "SelectorList" ? getChildren(argument) : [argument];
		for (const selector of selectors) {
			if (selector.type !== "Selector") {
				continue;
			}
			try {
				compiled.push(compileComplex(selector, compiling, false));
			} catch (_err) {
				// A forgiving selector list keeps the branches it can parse.
			}
		}
	}
	return compiled;
}

/** One bad branch invalidates the whole list. */
function compileArgumentList(
	args: SelectorNode[],
	compiling: Compiling,
	relative: boolean,
): CompiledComplex[] {
	const compiled: CompiledComplex[] = [];
	for (const argument of args) {
		const selectors =
			argument.type === "SelectorList" ? getChildren(argument) : [argument];
		for (const selector of selectors) {
			if (selector.type !== "Selector") {
				throw new SelectorError("a selector list holds selectors");
			}
			compiled.push(compileComplex(selector, compiling, relative));
		}
	}
	if (compiled.length === 0) {
		throw new SelectorError("a selector list selects something");
	}
	return compiled;
}

function compilePseudoElement(
	part: SelectorNode,
	compound: CompiledCompound,
	compiling: Compiling,
): void {
	const name = pseudoName(String(part.name ?? ""));
	if (!PSEUDO_ELEMENTS.has(name)) {
		throw new SelectorError(`unknown pseudo-element ::${name}`);
	}
	const args = getChildren(part);
	if (!FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		if (args.length !== 0) {
			throw new SelectorError(`::${name} takes no argument`);
		}
	} else if (args.length === 0) {
		throw new SelectorError(`::${name} takes an argument`);
	}
	if (name === "slotted") {
		const inner = compileArgumentList(args, compiling, false);
		if (!compiling.pseudoElements) {
			compound.tests.push(matchNothing);
			return;
		}
		// The slotted element is what the compound selects. Everything written
		// before `::slotted()` describes the slot it landed in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.origin = (element) => getOpenAssignedSlot(element);
		compound.tests.push(
			(element, state) =>
				getOpenAssignedSlot(element) !== null &&
				inner.some((complex) => matchComplex(complex, element, state, false)),
		);
		return;
	}
	if (name === "part") {
		const wanted = getIdentifierArgument(args, "part");
		if (!compiling.pseudoElements) {
			compound.tests.push(matchNothing);
			return;
		}
		// The part is what the compound selects. What is written before
		// `::part()` describes the host whose tree the part lives in.
		compound.originTests = compound.tests;
		compound.tests = [];
		compound.origin = (element) => getShadowHost(getRoot(element));
		compound.tests.push((element) => getPartNames(element).includes(wanted));
		return;
	}
	if (name === "picker") {
		const argument = getIdentifierArgument(args, "picker");
		if (argument !== "select") {
			throw new SelectorError("::picker names the select it belongs to");
		}
	} else if (FUNCTIONAL_PSEUDO_ELEMENTS.has(name)) {
		getIdentifierArgument(args, name);
	}
	// Every other pseudo-element names a box the tree has no node for, so a
	// query over the tree never selects one.
	compound.tests.push(matchNothing);
}

function compileNth(
	name: string,
	args: SelectorNode[],
	compiling: Compiling,
): Predicate {
	const nth = args.find((argument) => argument.type === "Nth");
	if (!nth) {
		throw new SelectorError(`:${name} takes an An+B`);
	}
	const step = readAnPlusB(nth.nth ?? null);
	const filter = nth.selector
		? compileArgumentList([nth.selector], compiling, false)
		: null;
	if (filter !== null && !name.endsWith("child")) {
		throw new SelectorError(`:${name} takes no "of" selector`);
	}
	const fromEnd = name === "nth-last-child" || name === "nth-last-of-type";
	const ofType = name === "nth-of-type" || name === "nth-last-of-type";
	return (element, state) => {
		if (element.nodeType !== ELEMENT_NODE) {
			return false;
		}
		const siblings = getElementSiblings(element);
		const counted = siblings.filter((sibling) => {
			if (ofType) {
				return (
					sibling.localName === element.localName &&
					sibling.namespaceURI === element.namespaceURI
				);
			}
			if (filter === null) {
				return true;
			}
			return filter.some((complex) =>
				matchComplex(complex, sibling, state, false),
			);
		});
		const ordered = fromEnd ? counted.reverse() : counted;
		const index = ordered.indexOf(element);
		return index !== -1 && matchesAnPlusB(step, index + 1);
	};
}

interface AnPlusB {
	a: number;
	b: number;
}

function readAnPlusB(node: SelectorNode | null): AnPlusB {
	if (node === null) {
		throw new SelectorError("An+B is a step and an offset");
	}
	if (node.type === "Identifier") {
		const keyword = toASCIILowercase(String(node.name ?? ""));
		if (keyword === "odd") {
			return {a: 2, b: 1};
		}
		if (keyword === "even") {
			return {a: 2, b: 0};
		}
		throw new SelectorError(`${keyword} is not an An+B`);
	}
	if (node.type !== "AnPlusB") {
		throw new SelectorError("An+B is a step and an offset");
	}
	const a = node.a === null || node.a === undefined ? 0 : readStep(node.a);
	const b = node.b === null || node.b === undefined ? 0 : Number(node.b);
	if (!Number.isFinite(a) || !Number.isFinite(b)) {
		throw new SelectorError("An+B counts in whole numbers");
	}
	return {a, b};
}

// `n`, `+n` and `-n` all mean a step of one.
function readStep(text: string): number {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "+") {
		return 1;
	}
	if (trimmed === "-") {
		return -1;
	}
	return Number(trimmed);
}

function matchesAnPlusB(step: AnPlusB, position: number): boolean {
	if (step.a === 0) {
		return position === step.b;
	}
	const times = (position - step.b) / step.a;
	return Number.isInteger(times) && times >= 0;
}

// What `:link` and `:any-link` match: an `a` or `area` with an href. A
// `link` element points somewhere too, but HTML leaves it out.
function isHyperlink(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	return (
		(name === "a" || name === "area") && element.getAttribute("href") !== null
	);
}

const DISABLEABLE = new Set([
	"button",
	"fieldset",
	"input",
	"optgroup",
	"option",
	"select",
	"textarea",
]);

function isDisableable(element: Element): boolean {
	return (
		element.namespaceURI === HTML_NAMESPACE &&
		DISABLEABLE.has(element.localName)
	);
}

// The selector matches what HTML calls actually disabled.
function isDisabled(element: Element, _state: MatchState): boolean {
	return isActuallyDisabled(element);
}

const UNREQUIRABLE_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"hidden",
	"image",
	"range",
	"reset",
	"submit",
]);

function isRequirable(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	if (name === "select" || name === "textarea") {
		return true;
	}
	if (name !== "input") {
		return false;
	}
	const type = toASCIILowercase(element.getAttribute("type") ?? "text");
	return !UNREQUIRABLE_INPUT_TYPES.has(type);
}

const IMMUTABLE_INPUT_TYPES = new Set([
	"button",
	"checkbox",
	"color",
	"file",
	"hidden",
	"image",
	"radio",
	"range",
	"reset",
	"submit",
]);

// `:read-write`: a text control the user can type into, or anything an
// editing host contains.
function isMutable(element: Element, state: MatchState): boolean {
	if (element.namespaceURI === HTML_NAMESPACE) {
		const name = element.localName;
		if (name === "input" || name === "textarea") {
			const type =
				name === "input"
					? toASCIILowercase(element.getAttribute("type") ?? "text")
					: "text";
			if (!IMMUTABLE_INPUT_TYPES.has(type)) {
				return (
					element.getAttribute("readonly") === null &&
					!isDisabled(element, state)
				);
			}
		}
	}
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const editable = node.getAttribute("contenteditable");
		if (editable === null) {
			continue;
		}
		const value = toASCIILowercase(editable);
		if (value === "" || value === "true" || value === "plaintext-only") {
			return true;
		}
		if (value === "false") {
			return false;
		}
	}
	return false;
}

// The elements `:open` and `:closed` apply to.
function canOpen(element: Element): boolean {
	if (element.namespaceURI !== HTML_NAMESPACE) {
		return false;
	}
	const name = element.localName;
	return (
		name === "details" ||
		name === "dialog" ||
		name === "select" ||
		name === "input"
	);
}

function isEmpty(element: Element): boolean {
	for (
		let child = getFirstChildNode(element);
		child !== null;
		child = getNextSibling(child)
	) {
		if (child.nodeType === ELEMENT_NODE) {
			return false;
		}
		if (
			(child.nodeType === TEXT_NODE ||
				child.nodeType === CDATA_SECTION_NODE) &&
				(child.nodeValue ?? "") !== ""
		) {
			return false;
		}
	}
	return true;
}

// RFC 4647 extended filtering: `:lang(en)` matches `en-GB`, and a `*`
// in a range matches any run of subtags.
function compileLang(args: SelectorNode[]): Predicate {
	const ranges: string[] = [];
	for (const argument of args) {
		if (argument.type === "Operator") {
			continue;
		}
		if (argument.type === "String") {
			ranges.push(String(argument.value ?? ""));
		} else if (argument.type === "Identifier") {
			ranges.push(CSSTree.ident.decode(String(argument.name ?? "")));
		} else if (argument.type === "Raw") {
			for (const piece of String(
				(argument as {value?: string}).value ?? "",
			).split(",")) {
				const text = piece.trim();
				if (text !== "") {
					ranges.push(CSSTree.ident.decode(text));
				}
			}
		} else {
			throw new SelectorError(":lang takes language ranges");
		}
	}
	if (ranges.length === 0) {
		throw new SelectorError(":lang takes language ranges");
	}
	const folded = ranges.map((range) => toASCIILowercase(range));
	return (element) => {
		const language = getElementLanguage(element);
		if (language === null) {
			return false;
		}
		const tag = toASCIILowercase(language);
		return folded.some((range) => rangeMatchesTag(range, tag));
	};
}

// The nearest declaration above the element.
function getElementLanguage(element: Element): string | null {
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const attributes = node.attributes;
		for (let index = 0; index < attributes.length; index++) {
			const attribute = attributes[index];
			if (
				attribute.localName === "lang" &&
				(attribute.namespaceURI === null ||
					attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace")
			) {
				return attribute.value;
			}
		}
	}
	return null;
}

function rangeMatchesTag(range: string, tag: string): boolean {
	const wanted = range.split("-");
	const have = tag.split("-");
	if (wanted[0] !== "*" && wanted[0] !== have[0]) {
		return false;
	}
	let index = 1;
	for (let part = 1; part < wanted.length; part++) {
		const subtag = wanted[part];
		if (subtag === "*") {
			continue;
		}
		while (index < have.length && have[index].length === 1) {
			index++;
		}
		while (index < have.length && have[index] !== subtag) {
			// A range's subtag may skip over a tag's subtag, but never over a
			// singleton, which starts a private or extension sequence.
			if (have[index].length === 1) {
				return false;
			}
			index++;
		}
		if (index >= have.length) {
			return false;
		}
		index++;
	}
	return true;
}

const bidi = bidiFactory();

// Elements whose text a `dir=auto` scan above them never reads.
const OPAQUE_TO_AUTO = new Set(["bdi", "script", "style", "textarea"]);

const AUTO_INPUT_TYPES = new Set([
	"email",
	"hidden",
	"password",
	"search",
	"submit",
	"text",
	"url",
]);

function compileDir(args: SelectorNode[]): Predicate {
	const wanted = toASCIILowercase(getIdentifierArgument(args, "dir"));
	return (element) =>
		element.nodeType === ELEMENT_NODE && getDirectionality(element) === wanted;
}

// Per HTML: the element's own `dir`, the first strong character under a
// `dir=auto`, or the inherited direction. The first-strong scan is the
// bidirectional algorithm's own paragraph rule, so a run of spaces,
// digits or punctuation before the first letter decides nothing, which
// is the point of `dir=auto`.
function getDirectionality(element: Element): "ltr" | "rtl" {
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		const stated = getDeclaredDirection(node);
		if (stated === "ltr" || stated === "rtl") {
			return stated;
		}
		if (stated === "auto") {
			return getAutoDirection(node);
		}
	}
	return "ltr";
}

// Includes `bdi`'s default.
function getDeclaredDirection(
	element: Element,
): "ltr" | "rtl" | "auto" | null {
	if (element.nodeType !== ELEMENT_NODE) {
		return null;
	}
	const html = element.namespaceURI === HTML_NAMESPACE;
	const value = toASCIILowercase(element.getAttribute("dir") ?? "");
	if (html && (value === "ltr" || value === "rtl" || value === "auto")) {
		return value;
	}
	// A bdi with no direction of its own is what `dir=auto` was invented
	// for. It isolates its content and reads the direction from it.
	return html && element.localName === "bdi" ? "auto" : null;
}

function getAutoDirection(element: Element): "ltr" | "rtl" {
	if (element.namespaceURI === HTML_NAMESPACE) {
		const name = element.localName;
		if (name === "input") {
			const type = toASCIILowercase(element.getAttribute("type") ?? "text");
			if (type === "tel") {
				return "ltr";
			}
			if (!AUTO_INPUT_TYPES.has(type)) {
				return "ltr";
			}
			return getFirstStrong(element.getAttribute("value") ?? "");
		}
		if (name === "textarea") {
			return getFirstStrong(getTextUnder(element, true));
		}
	}
	return getFirstStrong(getTextUnder(element, false));
}

function getTextUnder(element: Element, all: boolean): string {
	let text = "";
	for (
		let child = getFirstChildNode(element);
		child !== null;
		child = getNextSibling(child)
	) {
		if (child.nodeType === TEXT_NODE || child.nodeType === CDATA_SECTION_NODE) {
			text += child.nodeValue ?? "";
			continue;
		}
		const descendant = asElement(child);
		if (descendant === null || all) {
			continue;
		}
		// A descendant that states its own direction, and one that isolates its
		// content, both keep their text out of the scan above them.
		if (
			OPAQUE_TO_AUTO.has(descendant.localName) ||
			getDeclaredDirection(descendant) !== null
		) {
			continue;
		}
		text += getTextUnder(descendant, false);
	}
	return text;
}

function getFirstStrong(text: string): "ltr" | "rtl" {
	if (text === "") {
		return "ltr";
	}
	const {paragraphs} = bidi.getEmbeddingLevels(text);
	const paragraph = paragraphs[0];
	return paragraph && (paragraph.level & 1) === 1 ? "rtl" : "ltr";
}

// Matches right to left.
function matchComplex(
	complex: CompiledComplex,
	element: Element,
	state: MatchState,
	featureless: boolean,
): boolean {
	return matchFrom(
		complex,
		complex.compounds.length - 1,
		element,
		state,
		featureless,
	);
}

function matchFrom(
	complex: CompiledComplex,
	index: number,
	element: Element,
	state: MatchState,
	featureless: boolean,
): boolean {
	const compound = complex.compounds[index];
	if (featureless && !compound.host) {
		return false;
	}
	if (element.nodeType !== ELEMENT_NODE) {
		return false;
	}
	for (const test of compound.tests) {
		if (!test(element, state)) {
			return false;
		}
	}
	let subject = element;
	if (compound.origin !== null) {
		const origin = compound.origin(element, state);
		if (origin === null) {
			return false;
		}
		for (const test of compound.originTests) {
			if (!test(origin, state)) {
				return false;
			}
		}
		subject = origin;
	}
	if (index === 0) {
		return true;
	}
	const combinator = complex.combinators[index - 1];
	switch (combinator) {
		case ">": {
			const step = getParentStep(subject, state);
			return (
				step !== null &&
				matchFrom(complex, index - 1, step.element, state, step.featureless)
			);
		}
		case "+": {
			const sibling = getPreviousElement(subject);
			return (
				sibling !== null &&
				matchFrom(complex, index - 1, sibling, state, false)
			);
		}
		case "~": {
			for (
				let sibling = getPreviousElement(subject);
				sibling !== null;
				sibling = getPreviousElement(sibling)
			) {
				if (matchFrom(complex, index - 1, sibling, state, false)) {
					return true;
				}
			}
			return false;
		}
		default: {
			for (
				let step = getParentStep(subject, state);
				step !== null;
				step = getParentStep(step.element, state)
			) {
				if (
					matchFrom(complex, index - 1, step.element, state, step.featureless)
				) {
					return true;
				}
			}
			return false;
		}
	}
}

// In a shadow tree the step up ends at the featureless host.
function getParentStep(
	element: Element,
	state: MatchState,
): {element: Element; featureless: boolean} | null {
	const parent = getParent(element);
	if (parent === null) {
		return null;
	}
	const above = asElement(parent);
	if (above !== null) {
		return {element: above, featureless: false};
	}
	// A selector written in a shadow tree can reach the host above it, and
	// the host is featureless. Only `:host` and its two functional forms can
	// match it.
	if (state.shadow !== null && parent === state.shadow) {
		const host = getShadowHost(parent);
		return host === null ? null : {element: host, featureless: true};
	}
	return null;
}

// The search space is the anchor's subtree for a selector reaching
// down, and its following siblings' subtrees for one reaching across.
// That is why `li:has(~ li.x)` never counts the `li.x` it was asked
// about.
function hasMatch(
	inner: CompiledComplex[],
	element: Element,
	state: MatchState,
): boolean {
	// The anchor is what a leading combinator hangs from. `:scope` is not
	// changed: inside `:has()` it still refers to whatever the query scoped
	// to.
	const inside: MatchState = {...state, anchor: element};
	for (const complex of inner) {
		const selects = (node: Element): boolean =>
			matchComplex(complex, node, inside, false);
		const leading = complex.combinators[0] ?? " ";
		if (leading === "+" || leading === "~") {
			for (
				let sibling = getNextElement(element);
				sibling !== null;
				sibling = getNextElement(sibling)
			) {
				if (selects(sibling) || walkElements(sibling, selects)) {
					return true;
				}
			}
		} else if (walkElements(element, selects)) {
			return true;
		}
	}
	return false;
}

// The DOM types the links between nodes the way the platform does: a
// parent is a ParentNode and a sibling a ChildNode, mixins that describe
// what may stand in each position rather than what a node is. The
// matcher walks nodes, so it reads each link as the node on the other
// end, and these four readers are the only places it does that.

function getParent(node: Node): Node | null {
	return node.parentNode as Node | null;
}

function getFirstChildNode(node: Node): Node | null {
	return node.firstChild as Node | null;
}

function getPreviousSibling(node: Node): Node | null {
	return node.previousSibling as Node | null;
}

function getNextSibling(node: Node): Node | null {
	return node.nextSibling as Node | null;
}

function asElement(node: Node | null): Element | null {
	return node !== null && node.nodeType === ELEMENT_NODE
		? (node as Element)
		: null;
}

function parentElement(node: Node): Element | null {
	return asElement(getParent(node));
}

function getElementSiblings(element: Element): Element[] {
	const parent = getParent(element);
	return parent === null ? [element] : getElementChildren(parent);
}

function getPreviousElement(element: Element): Element | null {
	for (let node = getPreviousSibling(element);
		node !== null;
		node = getPreviousSibling(node)) {
		const found = asElement(node);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

function getNextElement(element: Element): Element | null {
	for (let node = getNextSibling(element);
		node !== null;
		node = getNextSibling(node)) {
		const found = asElement(node);
		if (found !== null) {
			return found;
		}
	}
	return null;
}

function getOfTypeIndex(element: Element, fromEnd: boolean): number {
	const siblings = getElementSiblings(element).filter(
		(sibling) =>
			sibling.localName === element.localName &&
			sibling.namespaceURI === element.namespaceURI,
	);
	const index = siblings.indexOf(element);
	if (index === -1) {
		return 0;
	}
	return fromEnd ? siblings.length - index : index + 1;
}

function splitOnWhitespace(text: string): string[] {
	return text.split(/[\t\n\f\r ]+/).filter((token) => token !== "");
}

// Keyed by text and the namespaces it was compiled against. A selector
// is compiled once and matched against everything.
const compiled = new Map<string, CompiledSelector | SelectorError>();

function getCacheKey(text: string, options: CompileOptions): string {
	const namespaces = options.namespaces;
	const map =
		namespaces == null
			? "-"
			: [...namespaces.prefixes]
				.map(([prefix, uri]) => `${prefix}=${uri}`)
				.sort()
				.join(" ");
	return `${namespaces?.default ?? ""} ${map} ${
		options.pseudoElements ? "p" : ""
	}${options.relative ? "r" : ""}${options.nesting ? "n" : ""} ${text}`;
}

/**
 * Throws a SelectorError for anything this engine rejects. The result is
 * cached, and so is the rejection.
 */
export function compileSelector(
	text: string,
	options: CompileOptions = {},
): CompiledSelector {
	const key = getCacheKey(text, options);
	let entry = compiled.get(key);
	if (entry === undefined) {
		try {
			const list = parseSelectorAST(text);
			if (list === null) {
				throw new SelectorError(`'${text}' is not a selector`);
			}
			entry = compileList(list, options);
		} catch (error) {
			entry =
				error instanceof SelectorError
					? error
					: new SelectorError(String((error as Error).message));
		}
		if (compiled.size > 1024) {
			compiled.clear();
		}
		compiled.set(key, entry);
	}
	if (entry instanceof SelectorError) {
		throw entry;
	}
	return entry;
}

interface MatchOptions {

	// The node `:scope` refers to.
	scope?: Node | null;

	// The shadow root the selector was written in, for `:host`.
	shadow?: Node | null;
}

interface QueryOptions extends CompileOptions, MatchOptions {}

function createMatchState(options: MatchOptions): MatchState {
	return {
		scope: options.scope ?? null,
		shadow: options.shadow ?? null,
		// A relative selector hangs from the scoping root, which is also what
		// `:scope` refers to. Inside `:has()` both become the anchor instead.
		anchor: options.scope ?? null,
	};
}

function matchesAny(
	selector: CompiledSelector,
	element: Element,
	state: MatchState,
): boolean {
	return selector.list.some((complex) =>
		matchComplex(complex, element, state, false),
	);
}

export function matchesCompiled(
	element: Element,
	selector: CompiledSelector,
	options: MatchOptions = {},
): boolean {
	return matchesAny(selector, element, createMatchState(options));
}

/** In tree order. */
export function selectAllCompiled(
	root: Node,
	selector: CompiledSelector,
	options: MatchOptions = {},
): Element[] {
	const state = createMatchState(options);
	const found: Element[] = [];
	walkElements(root, (element) => {
		if (matchesAny(selector, element, state)) {
			found.push(element);
		}
		return false;
	});
	return found;
}

function matchesSelector(
	element: Element,
	text: string,
	options: QueryOptions = {},
): boolean {
	return matchesCompiled(element, compileSelector(text, options), options);
}

function selectAll(
	root: Node,
	text: string,
	options: QueryOptions = {},
): Element[] {
	return selectAllCompiled(root, compileSelector(text, options), options);
}

function selectFirst(
	root: Node,
	text: string,
	options: QueryOptions = {},
): Element | null {
	const selector = compileSelector(text, options);
	const state = createMatchState(options);
	let first: Element | null = null;
	walkElements(root, (element) => {
		if (matchesAny(selector, element, state)) {
			first = element;
			return true;
		}
		return false;
	});
	return first;
}

function closestSelector(
	element: Element,
	text: string,
	options: QueryOptions = {},
): Element | null {
	const selector = compileSelector(text, options);
	const state = createMatchState(options);
	for (
		let node: Element | null = element;
		node !== null;
		node = parentElement(node)
	) {
		if (matchesAny(selector, node, state)) {
			return node;
		}
	}
	return null;
}

// The node after this one in tree order, stopping at a root: its first
// child, or else the next sibling of the nearest ancestor that has one.
// The walk follows the links a node already has rather than recursing,
// so a deep tree costs no stack and a wide one allocates nothing.
function walkElements(
	root: Node,
	visit: (element: Element) => boolean,
): boolean {
	for (
		let node = nextInTree(root, root);
		node !== null;
		node = nextInTree(node, root)
	) {
		const element = asElement(node);
		if (element !== null && visit(element)) {
			return true;
		}
	}
	return false;
}
