import {parseFragment, parse as parse5Parse} from "parse5";
import NWSAPI from "nwsapi";
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
	WINDOW_EVENT_HANDLERS,
	type ReflectSpec,
} from "./htmltables.js";
import {
	nextGraphemeBoundary,
	prevGraphemeBoundary,
	stringWidth,
} from "./text.js";
import {
	DETAILS_UA_STYLES,
	FIELD_UA_STYLES,
	METER_UA_STYLES,
	PROGRESS_UA_STYLES,
	SELECT_UA_STYLES,
	TEXTAREA_UA_STYLES,
} from "./useragent.js";
import type {LayoutEngine} from "./layout.js";

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

/* ------------------------------------------------------ user-agent widgets */

/**
 * The engine collaborators a user-agent widget renders through.
 *
 * A control's rendered content model is not its children -- an input has none
 * -- but a shadow tree the user agent owns, built from the control's own value,
 * placeholder and selection. That tree lays out, cascades and paints like any
 * other, so the control needs the same collaborators the document does. They
 * are installed on a document once, at setup, and reached from there.
 */
interface UAEngine {
	layout: {
		invalidate(node?: object): void;
		calculateLayout(): void;
		getRect(element: object): UARect | null;
		lineFragments(text: object): UALineFragment[];
		getRangeRects(range: object): UARect[];
		caretPositionFromPoint(
			x: number,
			y: number,
			root: object,
			clampToNearestLine?: boolean,
		): {node: UAText; offset: number} | null;
	};
	styles: {
		registerShadowRoot(root: object): void;
		/** The used user-select answer selection movement filters through. */
		isSelectable(element: object): boolean;
	};
	/**
	 * Note that a state no attribute records moved -- a popover shown or
	 * hidden. Nothing about it is a mutation, so the rules that test it and
	 * the frame that paints what they reveal have nothing else to hear it
	 * from.
	 */
	stateChanged(element: object): void;
	observer: {observe(target: object, options: object): void};
	/** Note the unbounded change attaching a shadow tree is. */
	invalidateStructure(): void;
}

/**
 * A control's shadow tree as the engine above reads it.
 *
 * The classes in this file are the implementation of these interfaces, but most
 * of their members arrive from the element tables at setup rather than from a
 * class body, so the tree a control builds is named here by the platform
 * interfaces every consumer of it already speaks.
 */
type UARoot = globalThis.ShadowRoot;
type UAElement = globalThis.HTMLElement;
type UAText = globalThis.Text;
type UARange = globalThis.Range;
type UARect = globalThis.DOMRect;
type UADocument = globalThis.Document;

/**
 * One laid-out line of a text node: where it sits, and the range of the
 * node's raw data it renders. A line is a property of the layout and not of
 * the string, so this is the only thing that can answer "what line is this
 * offset on" -- for a textarea's vertical motion and for the document
 * selection's alike.
 */
interface UALineFragment {
	rect: UARect;
	startOffset: number;
	endOffset: number;
}

/**
 * What the user agent may do that a page may not. The capability is the
 * return value of the one handshake that makes an engine a document's user
 * agent: it is never exported on its own, no element reaches it, and a
 * second install on the same document refuses -- so holding the toolkit IS
 * being the UA. Page code, including code that deep-imports this module,
 * has no way in.
 */
export interface UAToolkit {
	/** Open a closed shadow root: the composition privilege. */
	shadowRootOf<T>(element: object): T | null;
	/**
	 * A text control's selection record, past the type gate the author
	 * meets -- selectionStart is null on a number input per spec, and the
	 * UA still has a caret to draw. Null for a control with no selection.
	 */
	selectionOf(
		control: object,
	): {start: number; end: number; direction: string} | null;
	/** The text node a control's editable value renders through. */
	valueTextOf(control: object): UAText | null;
	/** Whether a control edits text -- the caret-and-chords family. */
	isTextField(element: {tagName: string; type?: string}): boolean;
	/** Move a text control's selection, past the type gate the author meets. */
	setSelection(
		control: object,
		start: number,
		end: number,
		direction?: string,
	): void;
	/** Build a control's UA widget if it has one and does not have it yet. */
	upgradeWidget(element: object): void;
	/** Build the UA widgets in a subtree, the root element included. */
	upgradeWidgetsIn(root: object): void;
	/** The granted document's top layer, by reference. */
	topLayer: Set<Element>;
	/**
	 * The top layer's members that are on screen, in the order they joined.
	 * A member off the flat tree is passed over rather than dropped: it is
	 * the tree's business whether it comes back, not the reader's.
	 */
	renderedTopLayer(): Element[];
	isModalDialog(node: object): boolean;
	isShowingPopover(node: object): boolean;
	topmostAutoPopover(): Element | null;
	topmostClickedPopover(node: object): Element | null;
	closePopover(element: object): void;
	hidePopoversUntil(
		endpoint: object | null,
		focusPreviousElement: boolean,
		fireEvents: boolean,
	): void;
	/** The composed-tree walk: the parent through slots and shadow roots. */
	flatParentElement<T>(node: object): T | null;
	/** Connected through the composed tree, closed roots included. */
	flatIsConnected(node: object): boolean;
	/** A control's selection as a Range, measured like any document range. */
	selectionRangeOf(control: object): UARange | null;
	pseudoElement<T>(host: object, name: string): T | null;
	pseudoElementCount(host: object): number;
	pseudoHostOf<T>(node: object): T | null;
	pseudoNameOf(node: object): string | null;
	ensurePseudoElement<T>(target: object, name: string): T;
	clearPseudoElement(host: object, name: string): void;
	isUAShadowRoot(node: object): boolean;
	/** How many style elements the granted document holds. */
	styleElementCount(): number;
	/**
	 * Dispatch as the user agent: isTrusted true, default actions armed.
	 * The one dispatch door script never gets.
	 */
	dispatchAsUserAgent(target: object, event: object): boolean;
	/** Empty and mode-lock a clipboard transfer as its dispatch ends. */
	lockDataTransfer(transfer: object): void;
	createBeforeUnloadEvent(): BeforeUnloadEvent;
}

const kUAEngine = Symbol("the engine a document's UA widgets render through");

/**
 * Give a document the collaborators its controls' shadow trees render
 * through, and take the UA's capabilities in exchange. Once per document.
 */
export function installUAEngine(document: object, engine: UAEngine): UAToolkit {
	const doc = document as Record<symbol, UAEngine | undefined>;
	if (doc[kUAEngine] !== undefined) {
		throw new Error("This document already has its user agent.");
	}
	doc[kUAEngine] = engine;
	return buildUAToolkit(document);
}

/**
 * The headless door to the capabilities: the cascade and the layout claim
 * here when they are built for a document no terminal will ever render --
 * tests, WPT runs, author-created documents. Claims close the moment an
 * engine installs: page code only ever runs after that, so on a rendered
 * document this always refuses, and the toolkit stays the UA's.
 */
export function claimUAToolkit(document: object): UAToolkit {
	const doc = document as Record<symbol, UAEngine | undefined>;
	if (doc[kUAEngine] !== undefined) {
		throw new Error("This document's user agent holds its own toolkit.");
	}
	return buildUAToolkit(document);
}

/** One toolkit per document: every door hands out the same object. */
const uaToolkits = new WeakMap<object, UAToolkit>();

function buildUAToolkit(document: object): UAToolkit {
	const existing = uaToolkits.get(document);
	if (existing !== undefined) {
		return existing;
	}
	const toolkit = makeUAToolkit(document);
	uaToolkits.set(document, toolkit);
	return toolkit;
}

function makeUAToolkit(document: object): UAToolkit {
	// Each capability answers only for the document it was granted for, so
	// a toolkit taken by installing on a throwaway document opens nothing.
	const owns = (target: object): boolean => {
		const node = target as Node & {host?: Node};
		if (node === (document as unknown as Node)) {
			return true;
		}
		const anchor =
			node.ownerDocument ??
			node.host?.ownerDocument ??
			(node as unknown as {document?: object}).document;
		return anchor === (document as unknown as Document);
	};
	return {
		shadowRootOf<T>(element: object): T | null {
			return owns(element) ? shadowRootOf<T>(element) : null;
		},
		selectionOf(control: object) {
			if (!owns(control)) {
				return null;
			}
			const record = (
				control as {[kUASelection]?: () => ReturnType<typeof uaSelectionOf>}
			)[kUASelection]!;
			return record ? record.call(control) : null;
		},
		valueTextOf(control: object): UAText | null {
			return owns(control) ? fieldValueText(control) : null;
		},
		isTextField,
		setSelection(control, start, end, direction?: string): void {
			if (owns(control)) {
				setUASelection(control, start, end, direction);
			}
		},
		upgradeWidget(element: object): void {
			if (owns(element)) {
				upgradeUAWidget(element);
			}
		},
		upgradeWidgetsIn(root: object): void {
			if (owns(root)) {
				upgradeUAWidgetsIn(root as Element);
			}
		},
		topLayer: topLayerOf(document),
		renderedTopLayer(): Element[] {
			const rendered: Element[] = [];
			for (const element of topLayerOf(document)) {
				// COMPOSITION-connected: a UA part (the select's picker) lives
				// in a fragment and is never DOM-connected while very much on
				// screen.
				if (flatIsConnected(element)) {
					rendered.push(element);
				}
			}
			return rendered;
		},
		isModalDialog(node: object): boolean {
			return owns(node) && isModalDialog(node);
		},
		isShowingPopover(node: object): boolean {
			return owns(node) && isShowingPopover(node);
		},
		topmostAutoPopover(): Element | null {
			return topmostAutoPopover(document);
		},
		topmostClickedPopover(node: object): Element | null {
			return owns(node) ? topmostClickedPopover(node) : null;
		},
		closePopover(element: object): void {
			if (owns(element)) {
				closePopover(element);
			}
		},
		hidePopoversUntil(
			endpoint: object | null,
			focusPreviousElement: boolean,
			fireEvents: boolean,
		): void {
			hidePopoversUntil(document, endpoint, focusPreviousElement, fireEvents);
		},
		flatParentElement<T>(node: object): T | null {
			return owns(node) ? flatParentElement<T>(node) : null;
		},
		flatIsConnected(node: object): boolean {
			return owns(node) && flatIsConnected(node);
		},
		selectionRangeOf(control: object): UARange | null {
			return owns(control) ? selectionRangeOf(control) : null;
		},
		pseudoElement<T>(host: object, name: string): T | null {
			return owns(host) ? pseudoElement<T>(host, name) : null;
		},
		pseudoElementCount(host: object): number {
			return owns(host) ? pseudoElementCount(host) : 0;
		},
		pseudoHostOf<T>(node: object): T | null {
			return owns(node) ? pseudoHostOf<T>(node) : null;
		},
		pseudoNameOf(node: object): string | null {
			return owns(node) ? pseudoNameOf(node) : null;
		},
		ensurePseudoElement<T>(target: object, name: string): T {
			if (!owns(target)) {
				throw new Error("Not this toolkit's document.");
			}
			return ensurePseudoElement<T>(target, name);
		},
		clearPseudoElement(host: object, name: string): void {
			if (owns(host)) {
				clearPseudoElement(host, name);
			}
		},
		isUAShadowRoot(node: object): boolean {
			return owns(node) && isUAShadowRoot(node);
		},
		styleElementCount(): number {
			return styleElementCount(document as Document);
		},
		dispatchAsUserAgent(target: object, event: object): boolean {
			if (!owns(target)) {
				throw new Error("Not this toolkit's document.");
			}
			return dispatchAsUserAgent(target as EventTarget, event as Event);
		},
		lockDataTransfer(transfer: object): void {
			lockDataTransfer(transfer as DataTransfer);
		},
		createBeforeUnloadEvent,
	};
}

const kUAUpgrade = Symbol("build a control's UA widget");

/**
 * Build a control's user-agent widget if it has one and does not have it yet.
 * Idempotent and synchronous: the shadow tree exists by the time this returns,
 * and a control that left the tree and came back only catches up the state it
 * drifted from.
 */
function upgradeUAWidget(element: object): void {
	(element as Record<symbol, (() => void) | undefined>)[kUAUpgrade]?.();
}

// The built-in tags that upgrade to a UA widget on connect.
const UPGRADEABLE_CONTROLS = new Set([
	"DETAILS",
	"INPUT",
	"METER",
	"PROGRESS",
	"SELECT",
	"TEXTAREA",
]);

/**
 * Upgrade every control in a newly connected subtree, the element itself
 * included. A walk over the subtree's own child links rather than a selector
 * query: every insertion pays this, and a document of ordinary markup must pay
 * as little as a tag comparison per element.
 */
function upgradeUAWidgetsIn(root: Element): void {
	const stack: Element[] = [root];
	while (stack.length > 0) {
		const element = stack.pop()!;
		if (UPGRADEABLE_CONTROLS.has(element.tagName)) {
			upgradeUAWidget(element);
		}
		for (let node = element[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType === ELEMENT_NODE) {
				stack.push(node as Element);
			}
		}
	}
}

/** A listener as this file's own dispatch takes one. */
type UAListener = (event: Event) => void;
const kUASelection = Symbol("a control's selection, whatever its type");

/** A text control's selection, read past the type gate the author meets. */
function uaSelectionOf(control: object): {
	start: number;
	end: number;
	direction: string;
} {
	return (control as {[kUASelection](): ReturnType<typeof uaSelectionOf>})[
		kUASelection
	]();
}

const kSetUASelection = Symbol("move a control's selection, whatever its type");

/** Move a text control's selection, past the type gate the author meets. */
function setUASelection(
	control: object,
	start: number,
	end: number,
	direction?: string,
): void {
	(
		control as {
			[kSetUASelection](start: number, end: number, direction?: string): void;
		}
	)[kSetUASelection]!(start, end, direction);
}

const kUAReconcile = Symbol("bring a control's UA tree back into step");

/** Tell a control that its own state moved, so its UA tree follows. */
function widgetChanged(element: object): void {
	(element as Record<symbol, (() => void) | undefined>)[kUAReconcile]?.();
}

/* ------------------------------------------- the text controls' UA editing */

/**
 * Whether an element edits text: a textarea, or an input of a type that
 * renders a value the caret can sit in. checkbox and radio render a toggle
 * instead, and hidden renders nothing at all -- a press on one is a press on
 * no field.
 *
 * The one spelling of the question: the paint, the caret scroll and the
 * press-to-park default action all have to agree on which elements are fields.
 */
function isTextField(element: {
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
 * The value part's text node inside a form control's user-agent shadow tree,
 * or null before the tree is built. The control's editable text lives at its
 * `[part="value"]`, reached through the closed tree the way a browser's own
 * editing internals reach it: the renderer reads it to place the caret, the
 * editing path to hit-test a point.
 */
function fieldValueText(field: object): UAText | null {
	return (
		(field as Record<symbol, UAText | null | undefined>)[kUAValueText] ?? null
	);
}

const kUASelectionRange = Symbol("what an element's own selection covers");

/**
 * What an element's own selection covers, as a Range the caller can measure --
 * or null for an element with no selection of its own, or none to show. The
 * element answers; only it knows what it renders through.
 *
 * A form control's selection is invisible to getSelection() per spec, so this
 * is the only way to measure it. It is the same shape a document selection
 * hands out, so both reach geometry down one path.
 *
 * The range is the document's own, valid until the next selection read.
 */
function selectionRangeOf(element: object): UARange | null {
	return (
		(element as Record<symbol, (() => UARange | null) | undefined>)[
			kUASelectionRange
		]?.() ?? null
	);
}

/**
 * The Range a text control's selection covers within the value text of the
 * tree it renders, or null when the selection is collapsed -- there is nothing
 * to highlight. Offsets are clamped into the text, so a selection recorded
 * against a longer value still measures.
 */
function textSelectionRange(
	control: HTMLInputElement | HTMLTextAreaElement,
	valueText: UAText | null,
): UARange | null {
	if (!valueText) {
		return null;
	}
	const {start, end} = uaSelectionOf(control);
	const length = valueText.data.length;
	const from = Math.max(0, Math.min(start, length));
	const to = Math.max(0, Math.min(end, length));
	if (to <= from) {
		return null;
	}
	const document = uaDocumentOf(control);
	let range = selectionRanges.get(document);
	if (range === undefined) {
		range = document.createRange();
		selectionRanges.set(document, range);
	}
	range.setStart(valueText, from);
	range.setEnd(valueText, to);
	return range;
}

/** The range a document answers control-selection queries with. @see caretRanges */
const selectionRanges = new WeakMap<UADocument, UARange>();

/** A node's own document, as the tree-building code below reads it. */
function uaDocumentOf(node: object): UADocument {
	return (node as Node).ownerDocument as unknown as UADocument;
}

/** A field's value and selection after an editing key -- what to apply. */
interface FieldEditResult {
	value: string;
	start: number;
	end: number;
	direction: "forward" | "backward" | "none";
}

/**
 * The selection after a caret move to `target`: Shift extends from the fixed
 * anchor (the browser's anchor/focus model), a plain move collapses there.
 * Value is carried through unchanged -- a move never edits text.
 */
function fieldSelectionMove(
	value: string,
	anchor: number,
	target: number,
	shiftKey: boolean,
): FieldEditResult {
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

/**
 * The field-editing keys shared by <input> and <textarea>: Backspace/Delete
 * and the horizontal arrows (Shift extending the selection), grapheme-aware,
 * following the browser's anchor/focus model. `key` is the DOM key value
 * (`event.key`). Returns the new value+selection, or null if the key is not one
 * of these -- the field-specific keys (Enter, vertical motion, Home/End) belong
 * to the caller, and printable insertion is a keypress action.
 */
function applySharedFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	key: string,
	shiftKey: boolean,
	ctrlKey: boolean,
): FieldEditResult | null {
	const value = field[kUAValue]!;
	const {start, end, direction} = uaSelectionOf(field);
	const backward = direction === "backward";
	const caret = backward ? start : end;
	const anchor = backward ? end : start;
	const hasSelection = start !== end;

	// The chords a terminal user's hands expect, from readline: a caret motion
	// or a deletion, never a browser shortcut. The ones a line bounds --
	// Ctrl+A, Ctrl+E, Ctrl+K, Ctrl+U -- belong to the control, which knows where
	// its lines end; these are the rest.
	if (ctrlKey && key === "b") {
		return fieldSelectionMove(
			value,
			anchor,
			hasSelection ? start : prevGraphemeBoundary(value, caret),
			false,
		);
	}
	if (ctrlKey && key === "f") {
		return fieldSelectionMove(
			value,
			anchor,
			hasSelection ? end : nextGraphemeBoundary(value, caret),
			false,
		);
	}
	if (ctrlKey && key === "d") {
		if (hasSelection) {
			return collapsedEdit(value.slice(0, start) + value.slice(end), start);
		}
		if (caret < value.length) {
			const to = nextGraphemeBoundary(value, caret);
			return collapsedEdit(value.slice(0, caret) + value.slice(to), caret);
		}
		return {value, start, end, direction: "none"};
	}
	if (ctrlKey && key === "w") {
		if (hasSelection) {
			return collapsedEdit(value.slice(0, start) + value.slice(end), start);
		}
		const from = wordStartBefore(value, caret);
		return collapsedEdit(value.slice(0, from) + value.slice(caret), from);
	}
	if (key === "Backspace") {
		if (hasSelection) {
			return collapsedEdit(value.slice(0, start) + value.slice(end), start);
		}
		if (caret > 0) {
			const from = prevGraphemeBoundary(value, caret);
			return collapsedEdit(value.slice(0, from) + value.slice(caret), from);
		}
		return {value, start, end, direction: "none"};
	}
	if (key === "Delete") {
		if (hasSelection) {
			return collapsedEdit(value.slice(0, start) + value.slice(end), start);
		}
		if (caret < value.length) {
			const to = nextGraphemeBoundary(value, caret);
			return collapsedEdit(value.slice(0, caret) + value.slice(to), caret);
		}
		return {value, start, end, direction: "none"};
	}
	if (key === "ArrowLeft") {
		if (shiftKey) {
			return fieldSelectionMove(
				value,
				anchor,
				prevGraphemeBoundary(value, caret),
				true,
			);
		}
		// A plain arrow with a selection collapses to its matching edge, not one
		// past it -- the browser behavior.
		const target = hasSelection ? start : prevGraphemeBoundary(value, caret);
		return fieldSelectionMove(value, anchor, target, false);
	}
	if (key === "ArrowRight") {
		if (shiftKey) {
			return fieldSelectionMove(
				value,
				anchor,
				nextGraphemeBoundary(value, caret),
				true,
			);
		}
		const target = hasSelection ? end : nextGraphemeBoundary(value, caret);
		return fieldSelectionMove(value, anchor, target, false);
	}
	return null;
}

/**
 * Insert typed or pasted text at an input's selection.
 *
 * A number input's text can be any prefix of a valid floating-point number
 * and nothing else: an insertion that would take it outside the grammar is
 * refused whole, the way a browser's number field refuses a second decimal
 * point. Deletions are never gated, so text a deletion strands outside the
 * grammar can always be cleared.
 */
function insertFieldText(field: HTMLInputElement, text: string): void {
	if (!text) {
		return;
	}
	const value = field[kUAValue]!;
	const {start, end} = uaSelectionOf(field);
	const next = value.slice(0, start) + text + value.slice(end);
	if (field.type === "number" && !isFloatPrefix(next)) {
		return;
	}
	applyFieldEdit(field, collapsedEdit(next, start + text.length));
}

/**
 * A typed character replacing the field's selection.
 *
 * Reached from `beforeinput`, which is where a browser reaches it: the
 * insertion is the keypress default action, so it runs after keypress has been
 * delivered rather than during keydown, and the field's `input` follows both.
 */
function printableFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	text: string,
): FieldEditResult {
	const value = field[kUAValue]!;
	const {start, end} = uaSelectionOf(field);
	return collapsedEdit(
		value.slice(0, start) + text + value.slice(end),
		start + text.length,
	);
}

/**
 * The offset a word-wise backward deletion stops at: the whitespace before the
 * caret is consumed with the word, so a chord at the end of "one two " lands
 * where "two" began.
 */
function wordStartBefore(value: string, caret: number): number {
	let at = caret;
	while (at > 0 && /\s/.test(value[at - 1])) {
		at--;
	}
	while (at > 0 && !/\s/.test(value[at - 1])) {
		at--;
	}
	return at;
}

/** The mirror of wordStartBefore: where a word-wise forward move lands. */
function wordEndAfter(value: string, caret: number): number {
	let at = caret;
	while (at < value.length && /\s/.test(value[at])) {
		at++;
	}
	while (at < value.length && !/\s/.test(value[at])) {
		at++;
	}
	return at;
}

/** An edit result whose selection is a caret collapsed at `pos`. */
function collapsedEdit(value: string, pos: number): FieldEditResult {
	const clamped = Math.max(0, Math.min(pos, value.length));
	return {value, start: clamped, end: clamped, direction: "none"};
}

const kSetUAValue = Symbol("write a text control's value, as a user edit does");

/**
 * Apply an edit result to a field's own value and selection, firing `input` on
 * a real value change (the value write reconciles the control's tree) and
 * `select` on a selection the user moved -- both events the render loop hears.
 *
 * The write lands on the control's value itself, never on the `value` IDL
 * attribute over it -- a user edit in a browser changes the value without the
 * setter running, which is how a page can tell what the user typed from what
 * it assigned. (A framework that tracks user input replaces the accessor on
 * the element and compares what it reads back; going through the setter would
 * make every keystroke look like the page's own write.)
 */
function applyFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	result: FieldEditResult,
): void {
	const value = field[kUAValue]!;
	const {start, end, direction} = uaSelectionOf(field);
	if (result.value !== value) {
		field[kSetUAValue]!(result.value);
		field[kSetUASelection]!(result.start, result.end, result.direction);
		dispatch(field, new Event("input", {bubbles: true, cancelable: false}));
	} else if (
		result.start !== start ||
		result.end !== end ||
		(result.start !== result.end && result.direction !== direction)
	) {
		field[kSetUASelection]!(result.start, result.end, result.direction);
		dispatch(field, new Event("select", {bubbles: true, cancelable: false}));
	}
}

/** Insert pasted `text` at the field's selection (one atomic edit). */
function insertPaste(
	field: HTMLInputElement | HTMLTextAreaElement,
	text: string,
): void {
	if (!text) {
		return;
	}
	const value = field[kUAValue]!;
	const {start, end} = uaSelectionOf(field);
	applyFieldEdit(
		field,
		collapsedEdit(
			value.slice(0, start) + text + value.slice(end),
			start + text.length,
		),
	);
}

/** Add a `part`-attributed span (holding one empty text node) to a UA root. */
function addPart(root: UARoot, part: string): UAElement {
	const document = uaDocumentOf(root);
	const span = document.createElement("span");
	span.setAttribute("part", part);
	span.appendChild(document.createTextNode(""));
	root.appendChild(span);
	return span;
}

/**
 * Give a control the closed shadow tree it renders through, enrolled in the
 * document's mutation observer and its cascade.
 *
 * The root is enrolled BEFORE it is populated, so the population itself is the
 * invalidation that swaps the composed tree in -- the parts lay out through the
 * normal pipeline, and layout must hear about every change to them.
 */
function buildUARoot(host: Element, engine: UAEngine, styles: string): UARoot {
	const root = attachUAShadowRoot<UARoot>(host);
	engine.invalidateStructure();
	engine.observer.observe(root, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeOldValue: true,
		characterData: true,
	});
	// The sheet is in the root BEFORE the cascade hears about it, so the
	// registration's incremental parse sees it: registered-then-populated
	// left the cascade to notice the sheet by count drift, which ordered a
	// full rebuild of every sheet per widget.
	root.appendChild(uaStyleElement(host, styles));
	engine.styles.registerShadowRoot(root);
	return root;
}

/** The `<style>` element carrying a widget's UA stylesheet. */
function uaStyleElement(host: Element, styles: string): UAElement {
	const style = uaDocumentOf(host).createElement("style");
	style.textContent = styles;
	return style;
}

/**
 * The engine a document's controls render through, if it has been installed.
 * A document has no ownerDocument, so it stands for itself: the selection
 * asks about a whole document where a control asks about a node.
 */
function uaEngineOf(node: object): UAEngine | undefined {
	const document = ((node as Node).ownerDocument ?? node) as unknown as Record<
		symbol,
		UAEngine
	> | null;
	return document?.[kUAEngine];
}

/**
 * Apply the text selection API's clamping and direction rules, and tell the
 * control that its selection moved.
 *
 * The event is queued rather than fired: a run of writes inside one turn
 * reports once, at the selection they settled on.
 */
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
		named === "forward" || named === "backward" || named === "none" ?
			named :
			"none";
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

/** The setRangeText algorithm over a raw value. */
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

/* ------------------------------------------------------------------ errors */

/**
 * The DOMException the platform supplies, so a caller's `instanceof
 * DOMException` and `error.code` are the platform's own.
 */
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

/* -------------------------------------------------------------- validation */

/**
 * The DOM Standard's name productions.
 *
 * A valid element local name either starts with an ASCII alpha and then holds
 * anything but the characters that would end a tag name, or starts with a
 * colon, underscore or non-ASCII character and continues in the narrower set.
 * An attribute local name and a namespace prefix are the looser rules, and a
 * doctype name is the loosest of all -- it may even be empty.
 */
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
// The combining-mark ranges are the production's own, and are meant to match
// a combining mark on its own rather than as part of a grapheme.

/* eslint-disable no-misleading-character-class -- the XML Name production
   matches lone combining marks by definition */
const XML_NAME = new RegExp(
	`^(?:[${NAME_START}]|[\uD800-\uDBFF][\uDC00-\uDFFF])` +
	`(?:[${NAME_REST}]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$`,
);
/* eslint-enable no-misleading-character-class */

/** Throw unless the string matches the XML Name production. */
function validateXMLName(name: string): void {
	if (!XML_NAME.test(name)) {
		throw domError("InvalidCharacterError", `"${name}" is not a valid name`);
	}
}

function isValidLocalName(name: string, forAttribute: boolean): boolean {
	return forAttribute ?
			VALID_ATTRIBUTE_LOCAL_NAME.test(name) :
			VALID_ELEMENT_LOCAL_NAME.test(name);
}

/** Throw unless the string is a valid element local name. */
function validateElementLocalName(name: string): void {
	if (!VALID_ELEMENT_LOCAL_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid element name`,
		);
	}
}

/** Throw unless the string is a valid attribute local name. */
function validateAttributeLocalName(name: string): void {
	if (!VALID_ATTRIBUTE_LOCAL_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid attribute name`,
		);
	}
}

/** Throw unless the string is a valid doctype name. */
function validateDoctypeName(name: string): void {
	if (!VALID_DOCTYPE_NAME.test(name)) {
		throw domError(
			"InvalidCharacterError",
			`"${name}" is not a valid doctype name`,
		);
	}
}

/**
 * Split a qualified name against a namespace, throwing the errors the spec's
 * name and namespace constraints call for.
 */
function validateAndExtract(
	namespace: string | null,
	qualifiedName: string,
	forAttribute: boolean,
): {namespace: string | null; prefix: string | null; localName: string} {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	let prefix: string | null = null;
	let localName = qualifiedName;
	const colon = qualifiedName.indexOf(":");
	if (colon !== -1) {
		prefix = qualifiedName.slice(0, colon);
		localName = qualifiedName.slice(colon + 1);
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
		(qualifiedName === "xmlns" || prefix === "xmlns") &&
		ns !== XMLNS_NAMESPACE
	) {
		throw domError(
			"NamespaceError",
			"The xmlns name needs the XMLNS namespace",
		);
	}
	if (
		ns === XMLNS_NAMESPACE &&
		qualifiedName !== "xmlns" &&
		prefix !== "xmlns"
	) {
		throw domError(
			"NamespaceError",
			"The XMLNS namespace needs the xmlns name",
		);
	}
	return {namespace: ns, prefix, localName};
}

/* ------------------------------------------------------------------ events */

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

/**
 * One struct of an event's path.
 *
 * The shadow members -- the shadow-adjusted target and the two closed-tree
 * flags -- are what composedPath() reads to decide how much of a path a
 * listener may see. Retargeting and the assigned-slot walk fill them in as the
 * path is built, which is where the algorithm reads them.
 */
interface PathItem {
	invocationTarget: EventTarget;
	invocationTargetInShadowTree: boolean;
	shadowAdjustedTarget: EventTarget | null;
	relatedTarget: EventTarget | null;
	rootOfClosedTree: boolean;
	slotInClosedTree: boolean;
}

/**
 * An event's dispatch-time state: the spec's internal slots and flags.
 *
 * They live in one object behind a module symbol because dispatch is a module
 * function that reads and writes them across every target in a path, which no
 * one class body can reach.
 */
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
	/**
	 * Whether the event this belongs to is a platform event rather than one of
	 * this DOM's, whose flags a listener sets on the platform half: dispatch
	 * reads them back off the event after every listener it calls.
	 */
	foreign: boolean;
}

/**
 * The types a trusted event falls back to when nothing listened for its own.
 *
 * An animation or transition event whose modern type found no listener at a
 * target is offered again there under the prefixed name.
 */
const LEGACY_EVENT_TYPES = new Map([
	["animationend", "webkitAnimationEnd"],
	["animationiteration", "webkitAnimationIteration"],
	["animationstart", "webkitAnimationStart"],
	["transitionend", "webkitTransitionEnd"],
]);

/** A dictionary argument, per Web IDL: absent, null, or an object. */
function toDictionary<T extends object>(value: unknown, what: string): T {
	if (value === undefined || value === null) {
		return {} as T;
	}
	if (typeof value !== "object" && typeof value !== "function") {
		throw new TypeError(`${what} must be an object`);
	}
	return value as T;
}

/**
 * The platform's event class, which the events here extend.
 *
 * An event constructed here is an instance of the global one, and an event
 * constructed from the global one dispatches through this DOM: application
 * code that reaches for the bare `Event` or `CustomEvent` global is holding
 * an object both sides accept.
 */
const HostEvent = globalThis.Event as unknown as {
	new (type: string, eventInitDict?: EventInit): HostEventInstance;
	prototype: HostEventInstance;
};

/**
 * The platform event surface this DOM's events inherit.
 *
 * The four members a dispatch owns are dropped: they are typed against the
 * platform's own event target, and the event targets here are this DOM's.
 */
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

const kDispatchState = Symbol("event dispatch state");

/**
 * isTrusted is one accessor shared by every event, installed as an own
 * property of each: the interface declares it unforgeable, so it is not on
 * the prototype and cannot be redefined away.
 */
function isTrustedGetter(this: Event): boolean {
	return this[kDispatchState]!.trusted;
}

const isTrustedProperty: PropertyDescriptor = {
	get: isTrustedGetter,
	enumerable: true,
	configurable: false,
};

/**
 * The base this DOM's events extend.
 *
 * Its prototype chain reaches the platform's Event, so an event here is an
 * instance of the global one and platform code accepts it -- but the platform
 * constructor never runs on it. Some platforms install isTrusted as an
 * unforgeable own property that always reads false, which an event this DOM
 * dispatches as the user agent must be able to answer true, so the accessor
 * an event carries has to be this DOM's. Every member the platform's base
 * would have provided is provided below.
 */
const EventBase = function EventBase(): void {} as unknown as {
	new (): HostEventInstance;
	prototype: HostEventInstance;
};

EventBase.prototype = Object.create(HostEvent.prototype) as HostEventInstance;

const kBubbles = Symbol("bubbles");
const kCancelable = Symbol("cancelable");
const kComposed = Symbol("composed");
const kTimeStamp = Symbol("timeStamp");
const kState = Symbol("state");
const kIsMouseEvent = Symbol("is a mouse event");
const kType = Symbol("document type");

/** An event, and the flags a listener sets on it while it is dispatched. */
export class Event extends EventBase {
	declare [kType]?: string;
	declare [kBubbles]?: boolean;
	declare [kCancelable]?: boolean;
	declare [kComposed]?: boolean;
	declare [kTimeStamp]?: number;
	declare [kState]?: DispatchState;

	static readonly NONE = NONE;
	static readonly CAPTURING_PHASE = CAPTURING_PHASE;
	static readonly AT_TARGET = AT_TARGET;
	static readonly BUBBLING_PHASE = BUBBLING_PHASE;

	constructor(type: string, eventInitDict: EventInit = {}) {
		if (arguments.length < 1) {
			throw new TypeError("Event constructor needs a type");
		}
		// The dictionary is converted once, here: a member that is an accessor
		// is read the one time the conversion reads it.
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

	get [kDispatchState](): DispatchState {
		return this[kState]!;
	}

	/**
	 * Whether this is a MouseEvent, which is what makes a "click" the event
	 * that runs activation behavior. MouseEvent overrides it.
	 */
	get [kIsMouseEvent](): boolean {
		return false;
	}

	override get type(): string {
		return this[kType]!;
	}

	// The members a dispatch owns -- the path and the flags a listener sets --
	// are read off the state this DOM keeps, and the platform base is told of
	// the flags as well, so an event handed back to platform code answers the
	// same way through either half of its interface.

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

	composedPath(): EventTarget[] {
		return composedPath(this[kState]!);
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

/** Swap the type a dispatch invokes listeners under, for the legacy pass. */
function setEventType(
	event: Event,
	type: string,
): void {
	event[kType] = type;
}

Object.defineProperties(Event.prototype, {
	NONE: {value: NONE, enumerable: true},
	CAPTURING_PHASE: {value: CAPTURING_PHASE, enumerable: true},
	AT_TARGET: {value: AT_TARGET, enumerable: true},
	BUBBLING_PHASE: {value: BUBBLING_PHASE, enumerable: true},
	[Symbol.toStringTag]: {value: "Event", configurable: true},
});

/** An event is canceled only where it is cancelable and nothing is passive. */
function setCanceledFlag(event: Event): void {
	const state = event[kDispatchState]!;
	if (event.cancelable && !state.inPassiveListener) {
		state.canceled = true;
		// A platform event keeps its canceled flag on the platform half, which
		// is where whoever handed it over will read it back.
		if (state.foreign) {
			HostEvent.prototype.preventDefault.call(event);
		}
	}
}

/**
 * The path as the target that is running sees it.
 *
 * A listener sees every struct it is allowed to: the walk out from the
 * current target stops crossing into a closed tree it did not start inside,
 * counting the closed roots and slots it passes.
 */
function composedPath(state: DispatchState): EventTarget[] {
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

/**
 * An event carrying a detail.
 *
 * CustomEvent inherits Event, and this DOM's Event is the one that carries
 * the dispatch state, so this extends that rather than the platform's
 * CustomEvent: an instance is an Event here and a platform Event, though not
 * a platform CustomEvent.
 */
export class CustomEvent<T = unknown> extends Event {
	declare [kDetail]?: T | null;

	constructor(type: string, eventInitDict: CustomEventInit<T> = {}) {
		super(type, eventInitDict);
		const init = toDictionary<CustomEventInit<T>>(
			eventInitDict,
			"An event init",
		);
		this[kDetail] = init.detail ?? null;
	}

	get detail(): T | null {
		return this[kDetail]!;
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
		if (this[kDispatchState]!.dispatch) {
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

/**
 * The event fired before a document is unloaded, which a listener cancels to
 * keep it.
 *
 * The interface declares no constructor: every instance is one the engine
 * fired or an empty shell createEvent built, so an author's `new` throws as
 * it does in a browser.
 *
 * Cancellation has two spellings, both of which the teardown honors:
 * preventDefault(), and a returnValue set to anything but the empty string.
 */
export class BeforeUnloadEvent extends Event {
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

	/**
	 * The legacy message a browser would have shown, which shadows Event's
	 * boolean returnValue with a DOMString. Its type is `any` because a
	 * narrower one is not assignable over the boolean it shadows -- the same
	 * resolution the platform's own type definitions reach.
	 */
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

/** Build one of this file's own objects, whose constructor an author cannot. */
function constructInternal<T>(build: () => T): T {
	const previous = internalConstruction;
	internalConstruction = true;
	try {
		return build();
	} finally {
		internalConstruction = previous;
	}
}

/** A beforeunload event, which only a teardown about to happen fires. */
function createBeforeUnloadEvent(): BeforeUnloadEvent {
	return constructInternal(() => new BeforeUnloadEvent());
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

/**
 * A message from another context. Nothing in a terminal posts one yet, but
 * the interface is a constructor authors call and createEvent names, so it
 * is here whole: data, origin, lastEventId, and the source and ports that
 * stay empty until there is a second context to fill them.
 */
export class MessageEvent<T = unknown> extends Event {
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
		if (this[kDispatchState]!.dispatch) {
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

/** The event of a document's fragment identifier changing. */
export class HashChangeEvent extends Event {
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

/**
 * The event of a storage area changing. There is no storage area in a
 * terminal to change, but the interface is a constructor authors call and
 * createEvent names, so it is here whole.
 */
export class StorageEvent extends Event {
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
		if (this[kDispatchState]!.dispatch) {
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

/* ------------------------------------------------------------- UI events */

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

/** A WebIDL long: the number truncated and wrapped into 32 signed bits. */
function toLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return 0;
	}
	return Math.trunc(number) | 0;
}

/** A WebIDL double: any finite number, and a throw for the rest. */
function toDouble(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		throw new TypeError("That value is not a finite double");
	}
	return number;
}

/** A WebIDL short: the long, wrapped into 16 signed bits. */
function toShort(value: unknown): number {
	return (toLong(value) << 16) >> 16;
}

/** An EventTarget? argument, per Web IDL: null, or an event target. */
function toEventTarget(value: unknown): EventTarget | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!(value instanceof EventTarget)) {
		throw new TypeError("That is not an event target");
	}
	return value;
}

/** The modifiers an event's init dictionary sets, as a set of key names. */
function initModifiers(init: EventModifierInit): Set<string> {
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

/**
 * An event of a user interface.
 *
 * `view` is the Window the event came through, and there is no Window in this
 * DOM: it is null, and an init that names one is a type error rather than a
 * value quietly dropped.
 */
export class UIEvent extends Event {
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
		view = null,
		detail = 0,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initUIEvent needs a type");
		}
		if (this[kDispatchState]!.dispatch) {
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

const kDefaultView = Symbol("the window this document is displayed in");
/**
 * An event of a pointing device.
 *
 * A click that is one of these is what dispatch runs an activation behavior
 * for, which is what `[kIsMouseEvent]` answers.
 */
export class MouseEvent extends UIEvent {
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
		this[kModifiers] = initModifiers(init);
		this[kDispatchState]!.relatedTarget = toEventTarget(init.relatedTarget);
	}

	override get [kIsMouseEvent](): boolean {
		return true;
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

	/** The alias pair CSSOM View gives clientX/clientY. */
	get x(): number {
		return this[kClientX]!;
	}

	get y(): number {
		return this[kClientY]!;
	}

	/**
	 * Client plus the document scroll. Read live rather than captured at
	 * creation: dispatch is synchronous here, so a listener's read sees
	 * the scroll the event was made under, which is the captured value.
	 */
	get pageX(): number {
		return this[kClientX]! + (this[kEventView]?.scrollX ?? 0);
	}

	get pageY(): number {
		return this[kClientY]! + (this[kEventView]?.scrollY ?? 0);
	}

	/**
	 * Client relative to the target's box. The border edge stands in for
	 * the spec's padding edge: a terminal border is one cell, and the
	 * layout's rect is the border box -- a one-cell divergence declared
	 * here rather than hidden.
	 */
	get offsetX(): number {
		const rect = this[kTargetRect]!;
		return rect === null ? this[kClientX]! : this[kClientX]! - rect.left;
	}

	get offsetY(): number {
		const rect = this[kTargetRect]!;
		return rect === null ? this[kClientY]! : this[kClientY]! - rect.top;
	}

	/**
	 * Pre-standard, and no spec defines them. Browsers report the offset from
	 * the nearest positioned ancestor, which for a target that is not itself
	 * positioned is what offsetX/offsetY already say, so they answer here
	 * rather than being absent.
	 */
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

	/** The window the event's target renders in, if it is in one. */
	get [kEventView](): {scrollX: number; scrollY: number} | null {
		const target = this[kDispatchState]!.target as Node | null;
		if (target === null || target.ownerDocument === null) {
			return null;
		}
		const view = target.ownerDocument[kDefaultView]!;
		return (view ?? null) as {scrollX: number; scrollY: number} | null;
	}

	/** The target's viewport-space rect, when an engine can answer. */
	get [kTargetRect](): {left: number; top: number} | null {
		const target = this[kDispatchState]!.target as Element | null;
		if (
			target === null ||
			typeof (target as {getBoundingClientRect?: unknown})
				.getBoundingClientRect !== "function"
		) {
			return null;
		}
		return target.getBoundingClientRect();
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
		return this[kDispatchState]!.relatedTarget;
	}

	override get which(): number {
		return this[kButton]! + 1;
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
		view = null,
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
		relatedTarget: EventTarget | null = null,
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initMouseEvent needs a type");
		}
		if (this[kDispatchState]!.dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, detail);
		this[kScreenX] = toLong(screenX);
		this[kScreenY] = toLong(screenY);
		this[kClientX] = toLong(clientX);
		this[kClientY] = toLong(clientY);
		this[kModifiers] = initModifiers({ctrlKey, altKey, shiftKey, metaKey});
		this[kButton] = toShort(button);
		this[kDispatchState]!.relatedTarget = toEventTarget(relatedTarget);
	}
}

Object.defineProperty(MouseEvent.prototype, Symbol.toStringTag, {
	value: "MouseEvent",
	configurable: true,
});

/** An event of the focus moving, which names the target on the other side. */
export class FocusEvent extends UIEvent {
	constructor(type: string, eventInitDict: FocusEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<FocusEventInit>(eventInitDict, "An event init");
		this[kDispatchState]!.relatedTarget = toEventTarget(init.relatedTarget);
	}

	get relatedTarget(): EventTarget | null {
		return this[kDispatchState]!.relatedTarget;
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

/** An event of a key, named by the character it types and the key it is. */
export class KeyboardEvent extends UIEvent {
	declare [kKey]?: string;
	declare [kCode]?: string;
	declare [kLocation]?: number;
	declare [kRepeat]?: boolean;
	declare [kIsComposing]?: boolean;
	declare [kCharCode]?: number;
	declare [kKeyCode]?: number;
	declare [kModifiers]?: Set<string>;

	static readonly DOM_KEY_LOCATION_STANDARD = DOM_KEY_LOCATION_STANDARD;
	static readonly DOM_KEY_LOCATION_LEFT = DOM_KEY_LOCATION_LEFT;
	static readonly DOM_KEY_LOCATION_RIGHT = DOM_KEY_LOCATION_RIGHT;
	static readonly DOM_KEY_LOCATION_NUMPAD = DOM_KEY_LOCATION_NUMPAD;

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
		this[kModifiers] = initModifiers(init);
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
		view = null,
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
		if (this[kDispatchState]!.dispatch) {
			return;
		}
		this.initUIEvent(type, bubbles, cancelable, view, 0);
		this[kKey] = String(key);
		this[kLocation] = toUnsignedLong(location);
		this[kModifiers] = initModifiers({ctrlKey, altKey, shiftKey, metaKey});
	}
}

/** The key-location constants, installed on the prototype. */
export interface KeyboardEvent
	extends Pick<
		globalThis.KeyboardEvent,
		| "DOM_KEY_LOCATION_STANDARD" |
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

/** An event of text being composed by an input method. */
export class CompositionEvent extends UIEvent {
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
		view = null,
		data = "",
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initCompositionEvent needs a type");
		}
		if (this[kDispatchState]!.dispatch) {
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

/**
 * The legacy text-input event of DOM Level 3, which UI Events keeps for the
 * documents that still listen for it. The interface declares no
 * constructor; createEvent("TextEvent") is the one door.
 */
export class TextEvent extends UIEvent {
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
		view = null,
		data = "",
	): void {
		if (arguments.length < 1) {
			throw new TypeError("initTextEvent needs a type");
		}
		if (this[kDispatchState]!.dispatch) {
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

/** An event of an editing host's text changing, and how it changed. */
export class InputEvent extends UIEvent {
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

// A transfer here carries text under format names and nothing else. There is
// no drag and drop in a terminal and no file to hand over, so `dropEffect`,
// `effectAllowed`, `setDragImage()` and `files` are present, answer what the
// interface says they answer, and do nothing.

/**
 * A transfer format name, normalized.
 *
 * The two shorthands the platform keeps are folded into the media types they
 * stand for, and what is left is lowercased with the surrounding whitespace
 * dropped, so `"TEXT/Plain "` and `"text"` name one entry.
 */
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

/** The brand an interface with no constructor is built through internally. */
const kInternalConstruction = Symbol("internal construction");

/** A list of files, empty here because nothing in a terminal produces one. */
export class FileList {
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
export class DataTransferItem {
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

/** The entries of a transfer, as a list that indexes and mutates them. */
export class DataTransferItemList {
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

/** Bring a list's indexed properties back in line with the entries behind it. */
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

const kTransferEntries = Symbol("entries");
const kTransferItems = Symbol("items");
const kTransferFiles = Symbol("files");
const kTransferMode = Symbol("mode");
const kDropEffect = Symbol("dropEffect");
const kEffectAllowed = Symbol("effectAllowed");

/** The payload a clipboard event carries: text under format names. */
export class DataTransfer {
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
 * Put a transfer into the read-only mode a `paste` hands its listeners: the
 * text is theirs to read, and the clipboard is not theirs to rewrite through
 * the event.
 */
function lockDataTransfer(transfer: DataTransfer): void {
	transfer[kTransferMode] = "readonly";
}

/**
 * Empty a transfer when the dispatch it belonged to ends: a clipboard
 * event's payload is the listener's to read while the event runs and
 * nothing afterward, which is what a browser hands back.
 *
 * This is conformance and not a boundary. An app holding a stale transfer
 * has lost nothing it could not ask for again through
 * `navigator.clipboard`, and it wrote the listener the payload arrived in.
 */
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

/** An event of a clipboard gesture, carrying the payload it moves. */
export class ClipboardEvent extends Event {
	declare [kClipboardData]?: DataTransfer | null;

	constructor(type: string, eventInitDict: ClipboardEventInit = {}) {
		super(type, eventInitDict);
		const init = toDictionary<ClipboardEventInit>(
			eventInitDict,
			"An event init",
		);
		this[kClipboardData] =
			init.clipboardData === undefined || init.clipboardData === null ?
				null :
				init.clipboardData;
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

/** An event of a CSS transition changing phase (css-transitions-1 §6). */
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

/**
 * An event of a CSS animation changing phase (css-animations-1 §4). The
 * engine runs no @keyframes animations yet; the interface exists because the
 * platform names it, and script can construct and dispatch one.
 */
export class AnimationEvent extends Event {
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

/** An event of a wheel turning over a target. */
export class WheelEvent extends MouseEvent {
	declare [kDeltaX]?: number;
	declare [kDeltaY]?: number;
	declare [kDeltaZ]?: number;
	declare [kDeltaMode]?: number;

	static readonly DOM_DELTA_PIXEL = DOM_DELTA_PIXEL;
	static readonly DOM_DELTA_LINE = DOM_DELTA_LINE;
	static readonly DOM_DELTA_PAGE = DOM_DELTA_PAGE;

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

/**
 * An event of a pointer, which is the interface a synthetic click is built
 * through: `element.click()` fires one of these, and it is a mouse event, so
 * dispatch runs the activation behavior it reaches.
 */
export class PointerEvent extends MouseEvent {
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

	/**
	 * The tilt and altitude/azimuth pairs describe the same angle two ways: an
	 * init that gives one has the other computed from it, and an init that
	 * gives neither leaves a pen upright.
	 */
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

/** A drag-and-drop event, carrying the data transfer of its drag session. */
export class DragEvent extends MouseEvent {
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

/** The tilt angles a pen's altitude and azimuth describe, in degrees. */
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

/** The altitude and azimuth a pen's tilt angles describe, in radians. */
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

/**
 * The legacy event interface table createEvent builds from, each name a
 * factory for the uninitialized shell the spec has createEvent answer with.
 *
 * The names the table maps to sensor and touch interfaces --
 * DeviceMotionEvent, DeviceOrientationEvent and TouchEvent -- are absent
 * from it: they name hardware a terminal does not have, so createEvent
 * throws for them rather than answering with an event of the wrong
 * interface.
 */
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

/** What an AbortSignal has to be for a listener to hang off it. */
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

/** The event types whose listeners mean a document observes pointer hover. */
const HOVER_EVENT_TYPES = new Set([
	"mousemove",
	"mouseover",
	"mouseout",
	"mouseenter",
	"mouseleave",
]);

/**
 * How many hover-observing listeners a document's targets hold, and who to
 * tell when the count moves. The engine watches this to decide whether the
 * terminal should report pointer motion at all: motion reporting floods
 * stdin, so it stays off until something can actually see the events.
 */
interface HoverListenerTally {
	count: number;
	onChange: (() => void) | null;
}

const hoverListenerTallies = new WeakMap<Document, HoverListenerTally>();

function hoverTallyOf(document: Document): HoverListenerTally {
	let tally = hoverListenerTallies.get(document);
	if (tally === undefined) {
		tally = {count: 0, onChange: null};
		hoverListenerTallies.set(document, tally);
	}
	return tally;
}

/**
 * The tally a hover listener on this target counts into, or null when the
 * type is not a hover type or the target belongs to no document.
 */
function hoverTallyFor(
	target: EventTarget,
	type: string,
): HoverListenerTally | null {
	if (!HOVER_EVENT_TYPES.has(type)) {
		return null;
	}
	if (target instanceof Node) {
		return hoverTallyOf(target[kDocument]!);
	}
	// A window is an EventTarget with a document; anything else counts
	// nowhere.
	const document = (target as {document?: unknown}).document;
	return document instanceof Document ? hoverTallyOf(document) : null;
}

/**
 * True while the UA's own machinery registers listeners: nwsapi installs
 * document mouseover/mouseout trackers for its builtin `:hover`, and those
 * are nobody observing hover.
 */
let hoverTallySuspended = false;

function tallyHoverListener(target: EventTarget, listener: Listener): void {
	if (hoverTallySuspended) {
		return;
	}
	const tally = hoverTallyFor(target, listener.type);
	if (tally !== null) {
		listener.hoverTally = tally;
		tally.count++;
		tally.onChange?.();
	}
}

/**
 * Watch a document's hover-listener count: `onChange` fires whenever it
 * moves, and the returned reader answers the current count. One watcher per
 * document -- the engine that displays it.
 */
function watchHoverListeners(
	document: Document,
	onChange: () => void,
): () => number {
	const tally = hoverTallyOf(document);
	tally.onChange = onChange;
	return () => tally.count;
}

interface Listener {
	type: string;
	callback: EventListenerOrEventListenerObject;
	capture: boolean;
	once: boolean;
	passive: boolean;
	removed: boolean;
	/** The hover tally this listener counts into, where it counts at all. */
	hoverTally?: HoverListenerTally;
}

/** The AbortSignal the platform supplies, which a listener's signal must be. */
const PlatformAbortSignal = (
	globalThis as unknown as {AbortSignal?: new () => ListenerSignal}
).AbortSignal;

interface FlatOptions {
	capture: boolean;
	once: boolean;
	/** Null until the type and target decide, which is what the spec defers. */
	passive: boolean | null;
	signal: ListenerSignal | null;
}

function flattenMore(
	options: boolean | AddEventListenerOptions | undefined,
): FlatOptions {
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

/** A listener callback, per Web IDL: null, or an object that may be called. */
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

const kDocument = Symbol("node document");

/**
 * The scroll-blocking types, which are passive by default at the roots a page
 * scrolls through, so that a listener there cannot cancel a scroll it was
 * only meant to watch.
 */
function defaultPassiveValue(type: string, target: EventTarget): boolean {
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

const kHandlers = Symbol("handlers");
const kListeners = Symbol("event listener list");
const kGetTheParent = Symbol("get the parent");

/** An event target: a listener list, and the parent a dispatch walks to. */
export class EventTarget {
	constructor() {
		this[kListeners] = [];
		this[kHandlers] = null;
	}

	declare [kListeners]?: Listener[];
	/** Null until this target is given an event handler, which most never are. */
	declare [kHandlers]?: Map<string, EventHandlerRecord> | null;

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
			flat.passive === null ? defaultPassiveValue(name, this) : flat.passive;
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
		tallyHoverListener(this, listener);
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

	/**
	 * The target a dispatch reaches next. A bare event target is the end of a
	 * path; a node hands back its parent.
	 */
	[kGetTheParent]?(_event: Event): EventTarget | null {
		return null;
	}
}

/**
 * The event handler map, for the handler IDL attributes. Created only when
 * a handler is being set: reading a handler off a target that has none
 * allocates nothing.
 */
function eventHandlerMap(
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

/** Take a listener out of a list, marking it so a live dispatch skips it. */
function removeListener(listeners: Listener[], listener: Listener): void {
	listener.removed = true;
	const index = listeners.indexOf(listener);
	if (index !== -1) {
		listeners.splice(index, 1);
		if (listener.hoverTally !== undefined) {
			listener.hoverTally.count--;
			listener.hoverTally.onChange?.();
		}
	}
}

/* -------------------------------------------- event handler IDL attributes */

/**
 * What an event handler attribute holds: a callback, or an object that is not
 * one.
 *
 * Web IDL's EventHandler is a callback type with LegacyTreatNonObjectAsNull,
 * so anything that is not an object is stored as null, and an object that
 * turns out not to be callable is stored and throws when the event arrives.
 */
type EventHandlerValue = ((event: Event) => unknown) | object;

/**
 * An event handler: the value the attribute holds, and the listener standing
 * in for it in its target's listener list.
 *
 * The listener is registered at the first non-null assignment and stays
 * registered across every later one, which is what fixes a handler's place
 * among the listeners added around it: reassigning `onclick` changes what
 * runs, never when it runs. A null assignment removes the listener, so a
 * later assignment takes a new place at the end of the list.
 */
interface EventHandlerRecord {
	value: EventHandlerValue | null;
	listener: Listener | null;
}

/** The value an event handler attribute holds, or null where it holds none. */
function eventHandlerValue(
	target: EventTarget,
	type: string,
): EventHandlerValue | null {
	const handlers = eventHandlerMap(target, false);
	if (handlers === null) {
		return null;
	}
	return handlers.get(type)?.value ?? null;
}

/**
 * Set an event handler attribute: activate the handler on a value, deactivate
 * it on null.
 */
function setEventHandler(
	target: EventTarget,
	type: string,
	value: unknown,
): void {
	const handler =
		typeof value === "function" ||
		(typeof value === "object" && value !== null) ?
				(value as EventHandlerValue) :
			null;
	const handlers = eventHandlerMap(target, handler !== null);
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

/**
 * Put the handler's listener in the target's listener list, at the end, where
 * it stays for as long as the handler is non-null.
 *
 * The list is written directly, as the spec's "add an event listener" is: a
 * handler is not an addEventListener call, and does not go through one.
 */
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
	tallyHoverListener(target, listener);
	return listener;
}

/**
 * An ErrorEvent, which a window's error handler is called with as five
 * arguments rather than one.
 *
 * This DOM defines no ErrorEvent interface -- nothing here reports an error as
 * an event -- so the test is the shape the interface has, which is what an
 * ErrorEvent dispatched from outside carries.
 */
function isErrorEvent(event: Event): boolean {
	return (
		"message" in event &&
		"filename" in event &&
		"lineno" in event &&
		"colno" in event &&
		"error" in event
	);
}

/**
 * The event handler processing algorithm: call the handler's current value
 * with the event, and read the answer it hands back as a cancellation.
 *
 * A handler that throws reports its exception rather than letting it out into
 * the dispatch that called it.
 */
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
	// A window's error handler takes an ErrorEvent apart into arguments and
	// answers a cancellation with true, the inverse of every other handler. A
	// document's or an element's error handler is an ordinary one.
	const errorHandling =
		type === "error" && !(target instanceof Node) && isErrorEvent(event);
	let result: unknown;
	try {
		const called = callback as (...args: unknown[]) => unknown;
		result = errorHandling ?
				called.call(
					target,
					(event as unknown as {message: unknown}).message,
					(event as unknown as {filename: unknown}).filename,
					(event as unknown as {lineno: unknown}).lineno,
					(event as unknown as {colno: unknown}).colno,
					(event as unknown as {error: unknown}).error,
				) :
				called.call(target, event);
	} catch (error) {
		reportError(error);
		return;
	}
	if (errorHandling ? result === true : result === false) {
		setCanceledFlag(event);
	}
}

/**
 * The event handler names whose event type is not the name minus `on`: the
 * prefixed animation handlers listen for the mixed-case legacy types
 * (HTML's event handler table).
 */
const PREFIXED_HANDLER_TYPES = new Map([
	["onwebkitanimationend", "webkitAnimationEnd"],
	["onwebkitanimationiteration", "webkitAnimationIteration"],
	["onwebkitanimationstart", "webkitAnimationStart"],
	["onwebkittransitionend", "webkitTransitionEnd"],
]);

/**
 * Install one event handler IDL attribute on an interface's prototype.
 *
 * On the prototype, once per interface: the accessor pair is the interface's,
 * and what an instance holds is the handler map it only grows when something
 * actually sets a handler on it.
 */
function installEventHandler(prototype: object, name: string): void {
	const type = PREFIXED_HANDLER_TYPES.get(name) ?? name.slice(2);
	Object.defineProperty(prototype, name, {
		get(this: EventTarget): EventHandlerValue | null {
			return eventHandlerValue(this, type);
		},
		set(this: EventTarget, value: unknown): void {
			setEventHandler(this, type, value);
		},
		enumerable: true,
		configurable: true,
	});
}

/**
 * Install every event handler IDL attribute in a table on an interface's
 * prototype.
 */
function installEventHandlers(
	prototype: object,
	names: readonly string[],
): void {
	for (const name of names) {
		installEventHandler(prototype, name);
	}
}

/**
 * Install an event handler attribute that belongs to the element's window
 * rather than to the element -- the set a `body` and a `frameset` forward.
 *
 * An element whose document has no window has no event handler target at all,
 * and the algorithm's answer for that is to drop the write and read back null.
 */
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

/**
 * Retarget an object against another: walk out of the shadow trees the other
 * object cannot see into.
 */
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
		// Shadow-including ancestry, so a tree the other object reaches through
		// a host of its own is a tree it can see into: a related target inside
		// a nested shadow tree stays itself for a listener in the tree above it.
		if (
			against instanceof Node &&
			isShadowIncludingInclusiveAncestor(root, against)
		) {
			return current;
		}
		current = (root as DocumentFragment)[kHost]!;
	}
}

/** Whether a root is a shadow root: a fragment a host holds. */
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

/**
 * Give a platform event the state a dispatch runs on, and the accessors that
 * read it.
 *
 * A platform event carries the platform's prototype getters for the members a
 * dispatch owns, and those know nothing of a tree; an own property shadows
 * one, so a listener reads this dispatch's answer for the target it is at.
 * The properties stay on the event afterwards, reading a state the dispatch
 * has cleared: the event keeps the target it was dispatched at, its current
 * target is null again and its path is empty.
 */
function adoptForeignEvent(event: Event): void {
	if (Object.prototype.hasOwnProperty.call(event, kDispatchState)) {
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
	Object.defineProperty(event, kDispatchState, {value: state});
	defineDispatchAccessor(event, "target", () => state.target);
	defineDispatchAccessor(event, "srcElement", () => state.target);
	defineDispatchAccessor(event, "currentTarget", () => state.currentTarget);
	defineDispatchAccessor(event, "eventPhase", () => state.eventPhase);
	Object.defineProperty(event, "composedPath", {
		value: () => composedPath(state),
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

/**
 * Read back the flags a listener set on a platform event.
 *
 * A platform event's stopPropagation and preventDefault run on the platform
 * half, where they are visible only as cancelBubble and defaultPrevented.
 * stopImmediatePropagation is not visible apart from stopPropagation there,
 * so it stops the dispatch at the targets past this one, and the listeners
 * remaining at this one still run.
 */
function syncForeignFlags(event: Event, state: DispatchState): void {
	if (event.defaultPrevented) {
		setCanceledFlag(event);
	}
	if ((event as {cancelBubble?: boolean}).cancelBubble) {
		state.stopPropagation = true;
	}
}

/**
 * Dispatch an event handed in from outside this module, and say whose it is.
 *
 * This is the one place an event's provenance is decided. Script reaches it
 * through dispatchEvent(), whose events are never trusted; the engine reaches
 * it through dispatchAsUserAgent(), whose events always are. Everything the
 * module fires itself goes through dispatch() below, which is the spec's
 * "fire an event" and therefore trusted as well.
 */
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
	const state = event[kDispatchState]!;
	if (state.dispatch || !state.initialized) {
		throw domError(
			"InvalidStateError",
			"That event is already being dispatched",
		);
	}
	return dispatch(target, event, trusted);
}

/**
 * Dispatch an event as the user agent: the event is trusted.
 *
 * The engine calls this where decoded terminal input, a viewport change or a
 * focus move becomes a DOM event -- everything a user or the terminal itself
 * caused, as opposed to what an application constructs and dispatches.
 */
function dispatchAsUserAgent(
	target: EventTarget,
	event: Event,
): boolean {
	return dispatchFromOutside(target, event, true);
}

/**
 * Dispatch an event at a target.
 *
 * The path is built once, from the target outward, and then walked twice: in
 * from the far end for the capture phase and out again for the bubble phase.
 * A struct that carries a shadow-adjusted target is a target of this dispatch
 * and is walked in both directions whether or not the event bubbles.
 *
 * The spec threads a legacy target override flag through here for HTML's load
 * event, which retargets to a Window; there is no Window in this DOM.
 *
 * Firing an event is the user agent's act, so an event dispatched here is
 * trusted unless the caller says otherwise -- click() says otherwise, since
 * HTML fires a synthetic, untrusted pointer event there.
 */
function dispatch(
	target: EventTarget,
	event: Event,
	trusted = true,
): boolean {
	const state = event[kDispatchState]!;
	state.trusted = trusted;
	state.dispatch = true;
	let activationTarget: EventTarget | null = null;
	let relatedTarget = retarget(state.relatedTarget, target);
	let clearTargets = false;
	if (target !== relatedTarget || target === state.relatedTarget) {
		let eventTarget = target;
		const isActivationEvent = event[kIsMouseEvent] && event.type === "click";
		appendToPath(state, eventTarget, eventTarget, relatedTarget, false);
		// A slottable that is assigned reaches its slot next, and the slot's
		// tree may be closed to the tree the event started in: the struct for
		// the slot carries that, so composedPath can count the boundary.
		let slottable: Node | null = isAssigned(eventTarget) ?
				(eventTarget as Node) :
			null;
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
			invoke(event, index, true);
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
			invoke(event, index, false);
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

/** Whether a target is a node sitting inside a shadow tree. */
function isShadowRootTarget(target: EventTarget | null): boolean {
	return target instanceof Node && isShadowRoot(getRoot(target));
}

/**
 * Whether a click on this target runs an activation behavior. A target that
 * has one is what dispatch walks the path to find, and what it runs the
 * behavior on once the path is walked.
 */
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

/**
 * What an uncanceled click does to its target.
 *
 * A hyperlink's activation behavior is following it, which this engine never
 * does: an anchor and an area are activation targets that do nothing.
 */
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

/**
 * A summary is the one element whose activation behavior depends on where it
 * sits: HTML gives it no interface of its own, and only the first summary of
 * a details opens and closes that details.
 */
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
		firstChildElement(parent, "summary") === target
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
	const form = formOwner(button);
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
		// A control outside a document reports nothing: the checkedness the
		// legacy-pre-activation behavior already flipped stands, and the
		// events that would announce it are not fired.
		if (!input.isConnected) {
			return;
		}
		dispatch(input, new Event("input", {bubbles: true, composed: true}));
		dispatch(input, new Event("change", {bubbles: true}));
		return;
	}
	const form = formOwner(input);
	if (form !== null) {
		if (type === "submit" || type === "image") {
			submitForm(form, input, false);
		} else if (type === "reset") {
			form.reset();
		}
	}
	popoverTargetActivationBehavior(input, event.target);
}

/**
 * A click on a label is a click on its control, unless the click already
 * came from inside that control.
 */
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

/**
 * Run one struct of the path.
 *
 * The event's target is the nearest target at or before this struct, so a
 * listener on an ancestor sees the node the event was dispatched at.
 */
function invoke(event: Event, index: number, capturing: boolean): void {
	const state = event[kDispatchState]!;
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

/**
 * Call the listeners of one target, and report whether any of them was
 * listening for this type at all -- a target that heard nothing is where a
 * trusted event is offered again under its legacy type.
 */
function innerInvoke(
	event: Event,
	listeners: Listener[],
	capturing: boolean,
): boolean {
	const state = event[kDispatchState]!;
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

/**
 * Call a listener: a function with the current target as its this, or an
 * object whose handleEvent is looked up at the moment of the call.
 */
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

/* ------------------------------------------------------------- live tables */

const kSync = Symbol("resynchronize own properties");
const kShapeSync = Symbol("resynchronize after a change to a tree's shape");
const kAttributeSync = Symbol("resynchronize after an attribute change");

interface Materializable {
	[kSync]?(): void;
	[kShapeSync]?(
		point: Node,
		changed: readonly Node[] | null,
		added: boolean,
	): void;
	[kAttributeSync]?(element: Element, localName: string): void;
}

/**
 * Where a live collection is registered to hear the changes that can move it.
 *
 * A collection's indexed and named properties are own properties rather than
 * proxy traps, and those are observable without reading the collection:
 * Object.getOwnPropertyNames answers with them, and an assignment to an index
 * is a no-op only where the index is defined. A collection that has ever been
 * read is therefore told of a change, and answers it however cheaply it can.
 * One that lists what a node contains registers on that node, under
 * kLiveLists, and hears the changes under it; one whose members can be
 * anywhere in a document -- a form's controls, which the form attribute
 * associates across a tree -- registers on the document, under kWideLists,
 * and hears the changes in it.
 */
const kLiveLists = Symbol("live collections this node is the root of");

const kWideLists = Symbol("live collections over a whole document");

function registerMaterialized(collection: Materializable, owner: Node): void {
	const held = owner[kLiveLists]!;
	if (held === null) {
		owner[kLiveLists] = new Set([collection]);
	} else {
		held.add(collection);
	}
}

function registerWide(collection: Materializable, document: Document): void {
	const held = document[kWideLists]!;
	if (held === null) {
		document[kWideLists] = new Set([collection]);
	} else {
		held.add(collection);
	}
}

const kParent = Symbol("parent");

/**
 * Record a change to a tree's shape at `point`, and resynchronize what it
 * moved.
 *
 * A change to the shape of a tree can move any collection over that tree, so
 * each one that has materialized own properties is told of the change here,
 * and answers it however cheaply it can. A collection lists the
 * descendants of one node, and is held by that node, so walking the change's
 * inclusive ancestors reaches exactly the collections whose node contains it:
 * the rest hold what they held, and their own properties are already exact.
 * This is what keeps the document's collections out of the trees a document
 * composes but does not contain -- a subtree being built before it is
 * inserted, a shadow tree, the node a pseudo-element renders from -- and what
 * keeps a tree that has been discarded from costing anything at all.
 *
 * `changed` is the nodes `point` gained (`added`) or lost, and is empty where
 * the change moved no node at all; null says only that something moved, and
 * every collection reached recomputes. A collection that is given the nodes
 * asks what they hold rather than walking the tree again, so a change costs
 * what it moved rather than what it sits in.
 *
 * A collection over a whole document is reached through the document the
 * change's point belongs to, since a tree being built outside the document
 * can hold the members of one.
 */
function shapeChanged(
	point: Node,
	changed: readonly Node[] | null,
	added: boolean,
): void {
	for (let node: Node | null = point; node !== null; node = node[kParent]!) {
		const held = node[kLiveLists]!;
		if (held === null) {
			continue;
		}
		for (const collection of held) {
			shapeSyncMethod.call(collection, point, changed, added);
		}
	}
	const wide = point[kDocument]![kWideLists]!;
	if (wide !== null) {
		for (const collection of wide) {
			shapeSyncMethod.call(collection, point, changed, added);
		}
	}
}

const kClassList = Symbol("classList");
const kAttributesMap = Symbol("attributes");
const kTokenLists = Symbol("reflected token lists");

/**
 * Resynchronize the collections an attribute change can have moved.
 *
 * An attribute is an input to three kinds of collection: the element's own
 * attribute map, the token lists over its attributes, and the collections
 * registered over the trees it sits in, which are asked about the one element
 * that changed rather than walked. A collection of children, of rows, of
 * cells -- anything an attribute is no input to -- answers that it holds what
 * it held.
 */
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
	for (let node: Node | null = element; node !== null; node = node[kParent]!) {
		const held = node[kLiveLists]!;
		if (held === null) {
			continue;
		}
		for (const collection of held) {
			collection[kAttributeSync]!(element, localName);
		}
	}
	const wide = element[kDocument]![kWideLists]!;
	if (wide !== null) {
		for (const collection of wide) {
			collection[kAttributeSync]!(element, localName);
		}
	}
}

/* -------------------------------------------------------------------- node */

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
const kFirstChild = Symbol("first child");
const kLastChild = Symbol("last child");
const kPrevious = Symbol("previous sibling");
const kNext = Symbol("next sibling");
const kChildNodes = Symbol("childNodes");
const kRegisteredObservers = Symbol("registered observer list");
const kRegistry = Symbol("custom element registry");
const kAttributeList = Symbol("attribute list");
const kDocumentURL = Symbol("document URL");

export class Node extends EventTarget {
	[kRegistry]?: CustomElementRegistry | null;
	[kParent]?: Node | null;
	[kFirstChild]?: Node | null;
	[kLastChild]?: Node | null;
	[kPrevious]?: Node | null;
	[kNext]?: Node | null;
	[kDocument]?: Document;
	[kChildNodes]?: NodeList | null;
	[kLiveLists]?: Set<Materializable> | null;
	[kSerial]?: number;
	[kRegisteredObservers]?: RegisteredObserver[] | null;

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

	constructor() {
		super();
		this[kRegistry] = null;
		this[kParent] = null;
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
		// A Document is its own node document; every other node is given one by
		// the algorithm that creates it.
		this[kDocument] = this as unknown as Document;
	}

	/**
	 * The target a dispatch reaches next: a node's parent. A slottable that is
	 * assigned overrides this to reach its slot, which is where the composed
	 * tree continues.
	 */
	override [kGetTheParent]?(_event: Event): EventTarget | null {
		return this[kParent]!;
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
		return shadowIncludingRoot(this).nodeType === DOCUMENT_NODE;
	}

	get ownerDocument(): Document | null {
		return this.nodeType === DOCUMENT_NODE ?
			null :
				(this[kDocument]! as Document);
	}

	getRootNode(options?: {composed?: boolean}): Node {
		const init = toDictionary<{composed?: boolean}>(
			options ?? {},
			"A GetRootNodeOptions",
		);
		return init.composed ? shadowIncludingRoot(this) : getRoot(this);
	}

	get parentNode(): Node | null {
		return this[kParent]!;
	}

	get parentElement(): Element | null {
		const parent = this[kParent]!;
		return parent !== null && parent.nodeType === ELEMENT_NODE ?
				(parent as Element) :
			null;
	}

	hasChildNodes(): boolean {
		return this[kFirstChild] !== null;
	}

	get childNodes(): NodeList {
		let list = this[kChildNodes]!;
		if (list === null) {
			list = createChildNodeList(this);
			this[kChildNodes] = list;
		}
		return list;
	}

	get firstChild(): Node | null {
		return this[kFirstChild]!;
	}

	get lastChild(): Node | null {
		return this[kLastChild]!;
	}

	get previousSibling(): Node | null {
		return this[kPrevious]!;
	}

	get nextSibling(): Node | null {
		return this[kNext]!;
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

	cloneNode(deep = false): Node {
		if (isShadowRoot(this)) {
			throw domError("NotSupportedError", "A shadow root cannot be cloned");
		}
		return cloneNode(this, undefined, Boolean(deep));
	}

	isEqualNode(otherNode: Node | null): boolean {
		return otherNode != null && equalNodes(this, otherNode);
	}

	isSameNode(otherNode: Node | null): boolean {
		return this === otherNode;
	}

	compareDocumentPosition(other: Node): number {
		if (this === other) {
			return 0;
		}
		let node1: Node | null = other;
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
				node1 === null || node2 === null ?
					this[kSerial]! < other[kSerial]! :
					getRoot(node2)[kSerial]! < getRoot(node1)[kSerial]!;
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
		return precedesInTree(node1, node2) ?
			DOCUMENT_POSITION_PRECEDING :
			DOCUMENT_POSITION_FOLLOWING;
	}

	contains(other: Node | null): boolean {
		return other != null && isInclusiveAncestor(this, other);
	}

	lookupPrefix(namespace: string | null): string | null {
		if (namespace == null || namespace === "") {
			return null;
		}
		switch (this.nodeType) {
			case ELEMENT_NODE:
				return locateNamespacePrefix(this as unknown as Element, namespace);
			case DOCUMENT_NODE: {
				const element = (this as unknown as Document).documentElement;
				return element === null ?
					null :
						locateNamespacePrefix(element, namespace);
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
				return parent === null ?
					null :
						locateNamespacePrefix(parent, namespace);
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

	insertBefore(node: Node, child: Node | null): Node {
		if (arguments.length < 2) {
			throw new TypeError("insertBefore needs a node and a child");
		}
		return preInsert(node, this, child);
	}

	appendChild(node: Node): Node {
		if (arguments.length < 1) {
			throw new TypeError("appendChild needs a node");
		}
		return preInsert(node, this, null);
	}

	replaceChild(node: Node, child: Node): Node {
		if (arguments.length < 2) {
			throw new TypeError("replaceChild needs a node and a child");
		}
		return replaceChild(child, node, this);
	}

	removeChild(child: Node): Node {
		if (arguments.length < 1) {
			throw new TypeError("removeChild needs a child");
		}
		return preRemove(child, this);
	}

	/* The spec's per-node steps. Subclasses override; the algorithms call. */

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

/* --------------------------------------------------------- tree primitives */

function getRoot(node: Node): Node {
	let current = node;
	while (current[kParent] !== null) {
		current = current[kParent]! as Node;
	}
	return current;
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

/**
 * A host-including inclusive ancestor: the ancestor chain, stepping from a
 * fragment to its host where one exists.
 */
function isHostIncludingInclusiveAncestor(ancestor: Node, node: Node): boolean {
	if (isInclusiveAncestor(ancestor, node)) {
		return true;
	}
	const root = getRoot(node);
	if (root.nodeType === DOCUMENT_FRAGMENT_NODE) {
		const host = (root as DocumentFragment)[kHost]!;
		if (host != null) {
			return isHostIncludingInclusiveAncestor(ancestor, host);
		}
	}
	return false;
}

/**
 * A node's shadow-including root: the root, stepping from a shadow root to its
 * host and on up, so a node inside a shadow tree in a document roots at that
 * document.
 */
function shadowIncludingRoot(node: Node): Node {
	const root = getRoot(node);
	return isShadowRoot(root) ?
			shadowIncludingRoot((root as ShadowRoot)[kHost]! as Element) :
		root;
}

/** Whether ancestor is node, an ancestor of node, or a host above it. */
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

const kShadowRoot = Symbol("shadow root");

/**
 * Every shadow-including inclusive descendant, in shadow-including tree order:
 * a node, then its shadow root's tree, then its children's.
 */
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

/** The next node in tree order, stopping once the walk leaves the root. */
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

/** Every inclusive descendant of a node, in tree order. */
function* inclusiveDescendants(node: Node): Generator<Node> {
	let current: Node | null = node;
	while (current !== null) {
		yield current;
		current = nextInTree(current, node);
	}
}

/** Every descendant of a node, in tree order. */
function* descendants(node: Node): Generator<Node> {
	let current: Node | null = node[kFirstChild]!;
	while (current !== null) {
		yield current;
		current = nextInTree(current, node);
	}
}

/** Every descendant element of a node, in tree order, into an array. */
function descendantElements(root: Node, into: Element[]): Element[] {
	let current: Node | null = root[kFirstChild]!;
	while (current !== null) {
		if (current.nodeType === ELEMENT_NODE) {
			into.push(current as Element);
		}
		current = nextInTree(current, root);
	}
	return into;
}

/** Whether node1 precedes node2 in tree order; both share a root. */
function precedesInTree(node1: Node, node2: Node): boolean {
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

/* --------------------------------------------------- mutation: pre-insert */

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

/** Ensure pre-insertion validity of node into parent before child. */
function ensurePreInsertionValidity(
	node: Node,
	parent: Node,
	child: Node | null,
	replacingAll = false,
): void {
	const parentType = parent.nodeType;
	if (
		parentType !== DOCUMENT_NODE &&
		parentType !== DOCUMENT_FRAGMENT_NODE &&
		parentType !== ELEMENT_NODE
	) {
		throw hierarchyRequestError("That parent cannot have children");
	}
	if (isHostIncludingInclusiveAncestor(node, parent)) {
		throw hierarchyRequestError("A node cannot be inserted into itself");
	}
	if (child !== null && child[kParent] !== parent) {
		throw notFoundError("The reference child is not a child of that parent");
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
/**
 * Move node into newParent before child.
 *
 * The tree ends up where remove-then-insert would leave it, but as one
 * primitive: no removing or insertion steps run, no disconnected or
 * connected callbacks fire, and everything the node carries -- its shadow
 * trees, its part of the selection, focus, live ranges and iterators --
 * rides along. A custom element hears connectedMoveCallback instead, or
 * the disconnected/connected pair where it declares no move callback.
 */
function moveNode(node: Node, newParent: Node, child: Node | null): void {
	if (shadowIncludingRoot(newParent) !== shadowIncludingRoot(node)) {
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
	const assignedSlot = isSlottable(node) ?
			(node as Slottable)[kAssignedSlot]! :
		null;
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
		newParent.nodeType === ELEMENT_NODE ?
				(newParent as Element)[kShadowRoot]! :
			null;
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
	shapeChanged(oldParent, [node], false);
	shapeChanged(newParent, [node], true);
	queueTreeMutationRecord(
		oldParent,
		[],
		[node],
		oldPreviousSibling,
		oldNextSibling,
	);
	queueTreeMutationRecord(newParent, [node], [], newPreviousSibling, child);
}

/** Insert node into parent before child. */
function insertNode(
	node: Node,
	parent: Node,
	child: Node | null,
	suppressObservers: boolean,
): void {
	const nodes =
		node.nodeType === DOCUMENT_FRAGMENT_NODE ? childNodeArray(node) : [node];
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
	const newRoot = getRoot(parent);
	for (const inserted of nodes) {
		// The inserted node was its own tree's root; whatever was registered
		// under it belongs to the tree it is joining.
		const carriedRanges = liveRangesByRoot.get(inserted);
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
		const carriedIterators = nodeIteratorsByRoot.get(inserted);
		if (carriedIterators !== undefined && inserted !== newRoot) {
			nodeIteratorsByRoot.delete(inserted);
			for (const iterator of carriedIterators) {
				registerNodeIterator(newRoot, iterator);
			}
		}
		adoptNode(inserted, document);
		linkChild(inserted, parent, child);
		const shadow =
			parent.nodeType === ELEMENT_NODE ?
					(parent as Element)[kShadowRoot]! :
				null;
		if (shadow !== null) {
			if (shadow[kSlotAssignment] === "named") {
				if (isSlottable(inserted)) {
					assignASlot(inserted as Slottable);
				}
			} else {
				// A manual assignment names nodes rather than finding them, and
				// only a node the host still has counts: the host's child list
				// changing is what makes an assignment appear or disappear.
				assignSlottablesForTree(shadow);
			}
		}
		if (
			isShadowRoot(getRoot(parent)) &&
			parent instanceof HTMLSlotElement &&
			parent[kAssignedNodes]!.length === 0
		) {
			signalASlotChange(parent);
		}
		// A slot assigns the host's children, which this insertion left alone
		// unless it brought slots of its own into the tree: those are the only
		// assignments in the root that the insertion can have changed.
		if (hasInclusiveDescendantSlot(inserted)) {
			assignSlottablesForTree(getRoot(inserted));
		}
		for (const descendant of shadowIncludingInclusiveDescendants(inserted)) {
			descendant[kInsertionSteps]!();
			if (!descendant.isConnected) {
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
	shapeChanged(parent, nodes, true);
	if (!suppressObservers) {
		queueTreeMutationRecord(parent, nodes, [], previousSibling, child);
	}
}

/** Splice a node into a parent's child list. */
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

function childNodeArray(parent: Node): Node[] {
	const nodes: Node[] = [];
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		nodes.push(node);
	}
	return nodes;
}

/** Append, with the observers of the append suppressed. */
function appendNode(node: Node, parent: Node): Node {
	return preInsert(node, parent, null);
}

/* -------------------------------------------------- mutation: replace/remove */

function replaceChild(child: Node, node: Node, parent: Node): Node {
	if (!(node instanceof Node) || !(child instanceof Node)) {
		throw new TypeError("That is not a node");
	}
	const parentType = parent.nodeType;
	if (
		parentType !== DOCUMENT_NODE &&
		parentType !== DOCUMENT_FRAGMENT_NODE &&
		parentType !== ELEMENT_NODE
	) {
		throw hierarchyRequestError("That parent cannot have children");
	}
	if (isHostIncludingInclusiveAncestor(node, parent)) {
		throw hierarchyRequestError("A node cannot be inserted into itself");
	}
	if (child[kParent] !== parent) {
		throw notFoundError("The replaced child is not a child of that parent");
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
	// Adopting takes the replacement out of the tree it is in now, which is a
	// removal of its own and is reported as one. It happens before the
	// replaced child leaves, so that removal's siblings are the ones an
	// observer saw before any of this began.
	adoptNode(node, parent[kDocument]!);
	if (child[kParent] !== null) {
		removedNodes.push(child);
		removeNode(child, true);
	}
	const nodes =
		node.nodeType === DOCUMENT_FRAGMENT_NODE ? childNodeArray(node) : [node];
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

/** Replace all of a parent's children with a node, or with nothing. */
function replaceAll(node: Node | null, parent: Node): void {
	const removedNodes = childNodeArray(parent);
	const addedNodes =
		node === null ?
				[] :
			node.nodeType === DOCUMENT_FRAGMENT_NODE ?
					childNodeArray(node) :
					[node];
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
/** Remove a node from its parent. */
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
			// The removal makes `node` a root; an iterator rooted inside the
			// leaving subtree belongs to that new tree.
			if (isInclusiveAncestor(node, iterator[kRoot]!)) {
				iterators.delete(iterator);
				registerNodeIterator(node, iterator);
			}
		}
	}
	const oldPreviousSibling = node[kPrevious]!;
	const oldNextSibling = node[kNext]!;
	unlinkChild(node);
	const assignedSlot = isSlottable(node) ?
			(node as Slottable)[kAssignedSlot]! :
		null;
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
	// The focus fixup a removal runs: focus does not survive leaving the
	// tree, and no blur fires for an element that is already gone -- the
	// state resets, silently, so the next focus() is a fresh one.
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
	const parentWasConnected = parent.isConnected;
	for (const descendant of shadowIncludingInclusiveDescendants(node)) {
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
	shapeChanged(parent, [node], false);
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

/* --------------------------------------------------------- mutation: adopt */

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

/* ----------------------------------------------------- mutation observers */

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

/**
 * An observe() dictionary once observe() has defaulted it.
 *
 * attributes, characterData and their old-value members stay tri-state:
 * a member that was never given is not the same as one given as false, and
 * both the defaulting rules and the record filter read the difference.
 */
interface ObserverOptions {
	childList: boolean;
	attributes: boolean | undefined;
	characterData: boolean | undefined;
	subtree: boolean;
	attributeOldValue: boolean | undefined;
	characterDataOldValue: boolean | undefined;
	attributeFilter: string[] | undefined;
}

/**
 * One entry of a node's registered observer list.
 *
 * An entry with a source is transient: it was copied onto a node as that node
 * was removed from a tree an observer was watching with subtree, so mutations
 * inside the removed subtree still reach that observer until it is next
 * notified.
 */
interface RegisteredObserver {
	observer: MutationObserver;
	options: ObserverOptions;
	source: RegisteredObserver | null;
}

/**
 * How many registered observers exist, transient ones included.
 *
 * While it is zero the three queueing call sites return before walking any
 * ancestors, so a tree nobody observes pays nothing for the machinery.
 */
let registeredObserverCount = 0;

/** The agent's "mutation observer microtask queued" flag. */
let mutationObserverMicrotaskQueued = false;

/** The agent's pending mutation observers. */
const pendingMutationObservers = new Set<MutationObserver>();

/**
 * The nodes carrying transient registered observers, held until the observers
 * that would report on them have been notified. They turn over every
 * checkpoint.
 */
const transientNodes: Node[] = [];

function queueMutationObserverMicrotask(): void {
	if (mutationObserverMicrotaskQueued) {
		return;
	}
	mutationObserverMicrotaskQueued = true;
	queueMicrotask(notifyMutationObservers);
}

/**
 * Deliver every pending observer's records.
 *
 * This runs as a microtask, so a script sees the records of everything it did
 * before it yields, in one callback per observer.
 */
function notifyMutationObservers(): void {
	mutationObserverMicrotaskQueued = false;
	const notifySet = [...pendingMutationObservers];
	pendingMutationObservers.clear();
	const signalSet = signalSlots.splice(0, signalSlots.length);
	for (const observer of notifySet) {
		notifyObserver(observer);
	}
	// What is left carries transient registrations of observers this checkpoint
	// had nothing to deliver to. Those last until their observer is next
	// notified: a node whose observer is already queued again waits here for
	// that, and the rest go back to their observer's own node list.
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
				observeNode(registered.observer, node);
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

function registeredObserverList(node: Node): RegisteredObserver[] {
	let list = node[kRegisteredObservers]!;
	if (list === null) {
		list = [];
		node[kRegisteredObservers] = list;
	}
	return list;
}

/**
 * Copy every subtree registration above a node onto the node itself, as it
 * leaves the tree.
 *
 * One transient entry per source is enough: two entries with the same source
 * would report the same mutation to the same observer, which the record queue
 * collapses anyway.
 */
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
	const list = registeredObserverList(node);
	for (const existing of list) {
		if (existing.source === source) {
			return;
		}
	}
	list.push({observer: source.observer, options: source.options, source});
	registeredObserverCount++;
	// The ancestor walk adds every source of one node in a row, so the node is
	// already last here whenever it carries more than one transient entry.
	if (transientNodes[transientNodes.length - 1] !== node) {
		transientNodes.push(node);
	}
	queueMutationObserverMicrotask();
}

/** Drop the transient entries of a node's list that a predicate names. */
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

/** A record of one mutation, as an observer's callback receives it. */
export class MutationRecord {
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

	get type(): string {
		return this[kType]!;
	}

	get target(): Node {
		return this[kTarget]!;
	}

	get addedNodes(): NodeList {
		return this[kAddedNodes]!;
	}

	get removedNodes(): NodeList {
		return this[kRemovedNodes]!;
	}

	get previousSibling(): Node | null {
		return this[kPreviousSibling]!;
	}

	get nextSibling(): Node | null {
		return this[kNextSibling]!;
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

/**
 * An observe() options argument, defaulted and checked.
 *
 * Giving an old value or a filter is a way of asking for the mutations it
 * describes, so it turns its own kind of observation on; asking for an old
 * value of something explicitly not observed is a contradiction and throws.
 */
function normalizeObserverOptions(
	options: MutationObserverInit,
): ObserverOptions {
	const init = toDictionary<MutationObserverInit>(options, "Observe options");
	const attributeFilter =
		init.attributeFilter === undefined ?
			undefined :
				toStringSequence(init.attributeFilter);
	const attributeOldValue =
		init.attributeOldValue === undefined ?
			undefined :
				Boolean(init.attributeOldValue);
	const characterDataOldValue =
		init.characterDataOldValue === undefined ?
			undefined :
				Boolean(init.characterDataOldValue);
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

/** A sequence<DOMString> argument, per Web IDL: anything iterable. */
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
const kNodes = Symbol("nodes");
const kRecords = Symbol("records");

/** An observer of a tree: what it watches, and the records it has to deliver. */
export class MutationObserver {
	declare [kCallback]?: MutationCallback;
	/** The targets observe() named, and the nodes whose transient
	 * registrations outlived a checkpoint. Held strongly: each node's
	 * registered observer list holds this observer right back, and a cycle
	 * collects together once both sides are unreachable. */
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
		const list = registeredObserverList(target);
		for (const registered of list) {
			if (registered.observer !== this || registered.source !== null) {
				continue;
			}
			for (const node of [...liveNodes(this), ...transientNodes]) {
				removeTransientObservers(node, (entry) => entry.source === registered);
			}
			registered.options = normalized;
			return;
		}
		list.push({observer: this, options: normalized, source: null});
		registeredObserverCount++;
		observeNode(this, target);
	}

	disconnect(): void {
		for (const node of [...liveNodes(this), ...transientNodes]) {
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

/** The nodes whose registered observer list names this one. */
function liveNodes(
	observer: MutationObserver,
): Node[] {
	return [...observer[kNodes]!];
}

function observeNode(
	observer: MutationObserver,
	node: Node,
): void {
	observer[kNodes]!.add(node);
}

function enqueueRecord(
	observer: MutationObserver,
	record: MutationRecord,
): void {
	observer[kRecords]!.push(record);
}

function notifyObserver(
	observer: MutationObserver,
): void {
	const records = observer[kRecords]!;
	observer[kRecords] = [];
	for (const node of liveNodes(observer)) {
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

/* --------------------------------------------------------- mutation record */

/**
 * Queue a record with every observer that asked for this kind of mutation.
 *
 * The walk is up the ancestor chain from the mutated node: a registration on
 * the node itself always matches, and one further up matches only if it was
 * made with subtree. An observer that matches more than once still gets one
 * record, carrying an old value if any of its matching registrations asked
 * for one.
 */
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
		enqueueRecord(
			observer,
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

/** Queue a record for a change to a node's children. */
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

/* ------------------------------------------------------- live collections */

const kMembersMoved = Symbol("members moved");

const kLive = Symbol("live");
const kOwner = Symbol("owner");
const kChildMember = Symbol("childMember");
const kExact = Symbol("exact");
const kItems = Symbol("items");
const kRegistered = Symbol("registered at");
const kWide = Symbol("over a whole document");
const kWatched = Symbol("watched attribute");
const kDefined = Symbol("defined");
const kNames = Symbol("names");

/** The watch of a list whose members any attribute can move. */
const anyAttribute = Symbol("any attribute");

/**
 * The list behind a live NodeList or HTMLCollection.
 *
 * The list is computed once and stands until a change says otherwise: a
 * collection registers where the changes that can move it are announced, and
 * drops or mends what it holds when one arrives. Indexed access is an own
 * accessor property rather than a proxy trap, and those accessors compute the
 * list where it is not standing, so the collection is as live as reading it
 * can tell. The own properties themselves -- which indices and names are
 * defined -- are what a change resynchronizes, since those can be observed
 * without a read.
 */
abstract class LiveList implements Materializable {
	declare [kItems]?: Node[];
	declare [kDefined]?: number;
	declare [kRegistered]?: Node | null;
	declare [kExact]?: boolean;
	declare [kLive]?: boolean;
	declare [kOwner]?: Node | null;
	declare [kChildMember]?: ((node: Node) => boolean) | null;
	declare [kWide]?: boolean;
	declare [kWatched]?: string | symbol | null;

	/**
	 * @param childMember - which of the owner's children the list holds, where
	 * it draws from the children and from nothing deeper. A list that says so
	 * is untouched by a change anywhere else in the owner's tree, and the
	 * children a change carries are the members it carries.
	 * @param watched - the attribute the list reads, `anyAttribute` where it
	 * reads whatever an element carries, null where it reads none.
	 * @param wide - whether the list holds members from anywhere in a
	 * document, rather than from what its owner contains.
	 */
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
		this[kWide] = wide;
	}

	/**
	 * Told when the members moved, for a collection keeping a cache over them.
	 * The list itself cannot say: a splice moves members within the one array
	 * the collection holds.
	 */
	[kMembersMoved]?(): void {}

	abstract compute(): Node[];

	/** Extra own properties this collection exposes, by name. */
	namedProperties(_items: Node[]): Map<string, Node> | null {
		return null;
	}

	/**
	 * The members the nodes a parent gained or lost carry, in tree order,
	 * where the collection can answer from those nodes alone and can say that
	 * its named properties are unmoved; null where it cannot, and the list has
	 * to be computed again to find out.
	 */
	shapeMembers(changed: readonly Node[]): Node[] | null {
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

	declare [kNames]?: string[];

	[kSync]?(): void {
		if (this[kRegistered] === null) {
			return;
		}
		if (this[kWide]!) {
			drop(this);
			return;
		}
		recompute(this);
	}

	/**
	 * Bring the collection back in step with a change to a tree's shape.
	 *
	 * A collection over one node's children holds what it held when the change
	 * was to some other node's, and a collection that can say what the changed
	 * nodes carry holds what it held when they carry none of its members:
	 * either way the list stands, and a read has nothing to do.
	 *
	 * Members the change carried are spliced in or out where the collection
	 * can place them, which costs what moved rather than what the tree holds.
	 * Everything else computes the list again, except a list over a whole
	 * document, which drops what it holds and computes on its next read: a
	 * document has more changes it must hear than it has reads of one of
	 * these.
	 */
	[kShapeSync]?(
		point: Node,
		changed: readonly Node[] | null,
		added: boolean,
	): void {
		if (this[kRegistered] === null) {
			return;
		}
		if (this[kWide]!) {
			drop(this);
			return;
		}
		if (this[kExact]!) {
			if (this[kChildMember] !== null && point !== this[kOwner]!) {
				return;
			}
			if (changed !== null) {
				const members = this.shapeMembers(changed);
				if (members !== null && splice(this, point, changed, members, added)) {
					return;
				}
			}
		}
		recompute(this);
	}

	/**
	 * Bring the collection back in step with an attribute that changed.
	 *
	 * An attribute is an input to what a collection holds where the collection
	 * reads it -- a class it collects, a name it answers to -- and a list that
	 * reads none of the element's attributes holds what it held.
	 */
	[kAttributeSync]?(_element: Element, localName: string): void {
		const watched = this[kWatched]!;
		if (watched === localName || watched === anyAttribute) {
			this[kSync]!();
		}
	}
}

/**
 * Drop the list a collection holds, for one that computes on its next read.
 *
 * The own properties stand where they are: an index reads through to the list
 * the read computes, and the count of them is settled by that read.
 */
function drop(list: LiveList): void {
	if (!list[kExact]!) {
		return;
	}
	list[kExact] = false;
	list[kMembersMoved]!();
}

function recompute(
	list: LiveList,
): void {
	list[kItems] = list.compute();
	list[kExact] = true;
	list[kMembersMoved]!();
	materialize(list);
}

/**
 * Move members into or out of the list where their place in it follows
 * from the change alone. Answers whether it did.
 *
 * Members arriving sit where the sibling they were placed before sits,
 * since nothing but them comes between the two; placed last of their
 * parent's children they sit past every member the list holds, as long as
 * the last of those is under that parent. Anywhere else asks the tree
 * where they go. Members leaving take their place with them, and they sit
 * together, so the first of them finds the run.
 */
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
			// A member at a time: what a change carries has no bound, and a
			// spread is an argument list.
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

/**
 * The list as it was last computed, where that is still the list the tree
 * holds; null where the tree has moved on from it.
 */
function computed(
	list: LiveList,
): Node[] | null {
	return list[kExact]! ? list[kItems]! : null;
}

/** Define an index for every member the collection has, and no more. */
function defineIndices(
	list: LiveList,
	length: number,
): void {
	const indexed = list as unknown as Record<number | string, unknown>;
	for (let index = list[kDefined]!; index < length; index++) {
		const at = index;
		Object.defineProperty(indexed, at, {
			// The recompute is reached through the captured method, not
			// through the prototype: a caller may replace the prototype,
			// and an indexed property is meant to survive that.
			get(): unknown {
				return ensure(list)[at] ?? undefined;
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

function materialize(
	list: LiveList,
): void {
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

/** The list's members, recomputed if what it is over has moved on. */
function ensure(list: LiveList): Node[] {
	if (!list[kLive]!) {
		if (!list[kExact]!) {
			recompute(list);
		}
		return list[kItems]!;
	}
	const owner = list[kOwner]!;
	if (owner === null) {
		// A list with nowhere to register is told of nothing, so it holds
		// what it computes for this read alone.
		recompute(list);
		return list[kItems]!;
	}
	if (list[kWide]!) {
		// The document a list is over is the one its owner belongs to, and
		// adopting the owner hands the list to another document.
		const document = owner[kDocument]!;
		const registered = list[kRegistered]! as Document | null;
		if (registered !== document) {
			if (registered !== null) {
				registered[kWideLists]?.delete(list);
			}
			list[kRegistered] = document;
			registerWide(list, document);
		}
	} else if (list[kRegistered] === null) {
		list[kRegistered] = owner;
		registerMaterialized(list, owner);
	}
	if (!list[kExact]!) {
		recompute(list);
	}
	return list[kItems]!;
}

const syncMethod = (
	LiveList.prototype as unknown as Record<symbol, () => void>
)[kSync]!;
const shapeSyncMethod = (
	LiveList.prototype as unknown as Record<
		symbol,
		(point: Node, changed: readonly Node[] | null, added: boolean) => void
	>
)[kShapeSync]!;

const kCompute = Symbol("compute");

export class NodeList extends LiveList {
	declare forEach: (
		callback: (node: Node, index: number, list: NodeList) => void,
		thisArg?: unknown,
	) => void;

	declare keys: () => ArrayIterator<number>;
	declare values: () => ArrayIterator<Node>;
	declare entries: () => ArrayIterator<[number, Node]>;
	declare [Symbol.iterator]: () => ArrayIterator<Node>;

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

	override compute(): Node[] {
		return this[kCompute]!();
	}

	get length(): number {
		return ensure(this).length;
	}

	item(index: number): Node | null {
		const items = ensure(this);
		const at = toUnsignedLong(index);
		return at < items.length ? items[at] : null;
	}
}

Object.defineProperty(NodeList.prototype, Symbol.toStringTag, {
	value: "NodeList",
	configurable: true,
});

export class HTMLCollection extends LiveList {
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

	override compute(): Node[] {
		return this[kCompute]!();
	}

	override shapeMembers(changed: readonly Node[]): Node[] | null {
		const members = super.shapeMembers(changed);
		if (members === null || areNameless(members)) {
			return members;
		}
		return null;
	}

	/**
	 * A collection answers to the id and the name of what it holds, so a
	 * change to either moves its named properties. No collection here draws a
	 * member from an id or a name, so the members stand and the names are made
	 * again from them; an element the collection cannot hold is left alone.
	 */
	override [kAttributeSync]?(element: Element, localName: string): void {
		if (localName !== "id" && localName !== "name") {
			super[kAttributeSync]!(element, localName);
			return;
		}
		if (this[kChildMember] !== null && element[kParent] !== this[kOwner]!) {
			return;
		}
		if (this[kWide]!) {
			drop(this);
		} else if (this[kExact]!) {
			materialize(this);
		}
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

	get length(): number {
		return ensure(this).length;
	}

	item(index: number): Element | null {
		const items = ensure(this);
		const at = toUnsignedLong(index);
		return at < items.length ? (items[at] as Element) : null;
	}

	namedItem(name: string): Element | null {
		if (name === "") {
			return null;
		}
		const key = String(name);
		for (const item of ensure(this)) {
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
}

Object.defineProperty(HTMLCollection.prototype, Symbol.toStringTag, {
	value: "HTMLCollection",
	configurable: true,
});

function toUnsignedLong(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) {
		return 0;
	}
	const truncated = Math.trunc(number);
	return ((truncated % 4294967296) + 4294967296) % 4294967296;
}

/** A WebIDL unsigned short: the unsigned long, wrapped into 16 bits. */
function toUnsignedShort(value: unknown): number {
	return toUnsignedLong(value) % 65536;
}

function createChildNodeList(node: Node): NodeList {
	const list = new NodeList(
		() => childNodeArray(node),
		true,
		node,
		() => true,
	);
	ensure(list);
	return list;
}

function createStaticNodeList(nodes: Node[]): NodeList {
	const list = new NodeList(() => nodes, false);
	ensure(list);
	return list;
}

const kCollectionCaches = Symbol("collection caches");

/** A collection cache keyed by kind and name, so identity is stable. */
function collectionCache(node: Node): Map<string, HTMLCollection> {
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

function elementChildren(parent: Node): Element[] {
	const elements: Element[] = [];
	for (let node = parent[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType === ELEMENT_NODE) {
			elements.push(node as Element);
		}
	}
	return elements;
}

const kLocalName = Symbol("local name");

/**
 * Whether none of these nodes is a named property of a collection holding it.
 *
 * A name belongs to the first member carrying it in tree order, which is a
 * question the whole list answers, so a collection splices members in and out
 * only where no name is at stake.
 */
function areNameless(members: readonly Node[]): boolean {
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

/**
 * The elements of a tree that pass a test, cached on the tree they walk.
 *
 * The test answers for one element, so an attribute change asks about the one
 * element that changed rather than walking the tree again: a collection that
 * element neither joined nor left holds what it held before.
 */
class MatchingCollection extends HTMLCollection {
	declare [kRoot]?: Node;
	declare [kMatches]?: (element: Element) => boolean;
	declare [kMembers]?: Set<Node> | null;

	/**
	 * @param watched - the attribute the test reads, if it reads one.
	 */
	constructor(
		root: Node,
		watched: string | null,
		matches: (element: Element) => boolean,
	) {
		super(
			() => {
				const found: Element[] = [];
				for (const element of descendantElements(root, [])) {
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

	/** The members moved, so what was cached over them describes none of them. */
	override [kMembersMoved]?(): void {
		this[kMembers] = null;
	}

	/**
	 * The members a changed subtree carries, found by asking the test about the
	 * subtree rather than about the tree it moved in or out of.
	 */
	override shapeMembers(changed: readonly Node[]): Node[] | null {
		const members: Node[] = [];
		for (const node of changed) {
			const elements =
				node.nodeType === ELEMENT_NODE ?
						descendantElements(node, [node as Element]) :
						descendantElements(node, []);
			for (const element of elements) {
				if (this[kMatches]!(element)) {
					members.push(element);
				}
			}
		}
		return areNameless(members) ? members : null;
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

const kNamespace = Symbol("namespace");
const kPrefix = Symbol("prefix");

function elementsByTagName(root: Node, qualifiedName: string): HTMLCollection {
	const cache = collectionCache(root);
	const key = `tag:${qualifiedName}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		const lowered = asciiLowercase(qualifiedName);
		collection = new MatchingCollection(root, null, (element) => {
			if (qualifiedName === "*") {
				return true;
			}
			const name =
				element[kPrefix] === null ?
					element[kLocalName]! :
					`${element[kPrefix]!}:${element[kLocalName]!}`;
			return element[kNamespace] === HTML_NAMESPACE ?
				name === lowered :
				name === qualifiedName;
		});
		// The indices a collection defines are observable without reading it,
		// so a collection materializes them as it is made.
		ensure(collection);
		cache.set(key, collection);
	}
	return collection;
}

function elementsByTagNameNS(
	root: Node,
	namespace: string | null,
	localName: string,
): HTMLCollection {
	const ns = namespace === "" || namespace == null ? null : String(namespace);
	const cache = collectionCache(root);
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
		// The indices a collection defines are observable without reading it,
		// so a collection materializes them as it is made.
		ensure(collection);
		cache.set(key, collection);
	}
	return collection;
}

const kClassTokens = Symbol("the parsed class attribute");

/**
 * The tokens of an element's class attribute.
 *
 * The parse is kept on the element and thrown away by the class attribute's
 * change steps, so a walk that asks every element for its classes pays for
 * the attributes that changed rather than for the ones it passes.
 */
function classTokens(element: Element): ReadonlySet<string> {
	let tokens = element[kClassTokens]!;
	if (tokens === null) {
		const value = element.getAttribute("class");
		tokens = new Set(value === null ? [] : splitOnASCIIWhitespace(value));
		element[kClassTokens] = tokens;
	}
	return tokens;
}

const kMode = Symbol("document mode");

function elementsByClassName(root: Node, classNames: string): HTMLCollection {
	const cache = collectionCache(root);
	const key = `class:${classNames}`;
	let collection = cache.get(key);
	if (collection === undefined) {
		const classes = splitOnASCIIWhitespace(classNames);
		const quirks =
			root[kDocument]![kMode] === "quirks" ?
					classes.map((name) => asciiLowercase(name)) :
				classes;
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
				tokens = new Set(splitOnASCIIWhitespace(asciiLowercase(value)));
			} else {
				tokens = classTokens(element);
			}
			for (const name of isQuirks ? quirks : classes) {
				if (!tokens.has(name)) {
					return false;
				}
			}
			return true;
		});
		// The indices a collection defines are observable without reading it,
		// so a collection materializes them as it is made.
		ensure(collection);
		cache.set(key, collection);
	}
	return collection;
}

/* ------------------------------------------------------------ token lists */

const ASCII_WHITESPACE = /[\t\n\f\r ]+/;

function splitOnASCIIWhitespace(value: string): string[] {
	const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	if (trimmed === "") {
		return [];
	}
	return trimmed.split(ASCII_WHITESPACE);
}

function asciiLowercase(value: string): string {
	return value.replace(/[A-Z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) + 32),
	);
}

function asciiUppercase(value: string): string {
	return value.replace(/[a-z]/g, (character) =>
		String.fromCharCode(character.charCodeAt(0) - 32),
	);
}

const kElement = Symbol("element");
const kAttribute = Symbol("attribute");
const kSupported = Symbol("supported");
const kTokens = Symbol("tokens");

export class DOMTokenList extends LiveList {
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

	/** An attribute's tokens are no part of the shape of a tree. */
	override shapeMembers(): Node[] {
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

	get [kTokens](): string[] {
		return ensure(this) as unknown as string[];
	}

	get length(): number {
		return this[kTokens]!.length;
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
		write(this, current);
	}

	remove(...tokens: string[]): void {
		validateTokens(tokens);
		const current = this[kTokens]!.filter(
			(each) => !tokens.some((token) => String(token) === each),
		);
		write(this, current);
	}

	toggle(token: string, force?: boolean): boolean {
		validateTokens([token]);
		const name = String(token);
		const current = this[kTokens]!.slice();
		const index = current.indexOf(name);
		if (index !== -1) {
			if (force === undefined || force === false) {
				current.splice(index, 1);
				write(this, current);
				return false;
			}
			return true;
		}
		if (force === undefined || force === true) {
			current.push(name);
			write(this, current);
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
		// The ordered set replacement: the first of either token becomes the
		// replacement, and every other instance of either is dropped.
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
		write(this, replaced);
		return true;
	}

	supports(token: string): boolean {
		if (this[kSupported] === null) {
			throw new TypeError(`${this[kAttribute]!} has no supported tokens`);
		}
		return this[kSupported]!.has(asciiLowercase(String(token)));
	}

	get value(): string {
		return this[kElement]!.getAttribute(this[kAttribute]!) ?? "";
	}

	set value(value: string) {
		this[kElement]!.setAttribute(this[kAttribute]!, String(value));
	}

	override toString(): string {
		return this.value;
	}
}

function write(
	list: DOMTokenList,
	tokens: string[],
): void {
	if (list[kElement]!.getAttributeNode(list[kAttribute]!) === null) {
		if (tokens.length === 0) {
			return;
		}
	}
	list[kElement]!.setAttribute(list[kAttribute]!, tokens.join(" "));
}

Object.defineProperty(DOMTokenList.prototype, Symbol.toStringTag, {
	value: "DOMTokenList",
	configurable: true,
});

/** The tokens by position, materialised as own properties by the live list. */
export interface DOMTokenList {
	[index: number]: string;
}

/**
 * The Array iteration functions, on the collections WebIDL says get them.
 *
 * An interface with an indexed property getter and a length takes
 * %Array.prototype%'s own functions -- the same function objects, not
 * lookalikes -- so a caller comparing them finds them equal, and iteration
 * reads length and index on each step, which keeps it live.
 */
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

/* --------------------------------------------------------- character data */

export class CharacterData extends Node {
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

	override get textContent(): string | null {
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

/** The ChildNode mixin, installed from the tables. */
export interface CharacterData
	extends Pick<globalThis.CharacterData, ChildNodeMixin> {}

Object.defineProperty(CharacterData.prototype, Symbol.toStringTag, {
	value: "CharacterData",
	configurable: true,
});

/** A nullable DOMString: null and undefined are both the empty string. */
function nullableString(value: string | null | undefined): string {
	return value == null ? "" : String(value);
}

/** The spec's "replace data" algorithm. */
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

/** Queue a record for a change to a node's data. */
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

export class Text extends CharacterData {
	[kAssignedSlot]?: HTMLSlotElement | null;
	[kManualSlot]?: HTMLSlotElement | null;

	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kAssignedSlot] = null;
		this[kManualSlot] = null;
		this[kDocument] = currentDocument();
	}

	/** A slottable that is assigned reaches its slot before its parent. */
	override [kGetTheParent]?(_event: Event): EventTarget | null {
		return this[kAssignedSlot] ?? this[kParent]!;
	}

	get assignedSlot(): HTMLSlotElement | null {
		return findASlot(this, true);
	}

	override get nodeType(): number {
		return TEXT_NODE;
	}

	override get nodeName(): string {
		return "#text";
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

export class CDATASection extends Text {
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

export class Comment extends CharacterData {
	constructor(data = "") {
		super(data === null ? "null" : String(data));
		this[kDocument] = currentDocument();
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

export class ProcessingInstruction extends CharacterData {
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

Object.defineProperty(ProcessingInstruction.prototype, Symbol.toStringTag, {
	value: "ProcessingInstruction",
	configurable: true,
});

/* ------------------------------------------------------------- doctype etc */

const kName = Symbol("doctype name");
const kPublicId = Symbol("public id");
const kSystemId = Symbol("system id");

export class DocumentType extends Node {
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

Object.defineProperty(DocumentType.prototype, Symbol.toStringTag, {
	value: "DocumentType",
	configurable: true,
});

export class DocumentFragment extends Node {
	[kHost]?: Element | null;

	constructor() {
		super();
		this[kHost] = null;
		this[kDocument] = currentDocument();
	}

	override get nodeType(): number {
		return DOCUMENT_FRAGMENT_NODE;
	}

	override get nodeName(): string {
		return "#document-fragment";
	}

	override get textContent(): string | null {
		return descendantText(this);
	}

	override set textContent(value: string | null) {
		setDescendantText(this, value);
	}

	getElementById(elementId: string): Element | null {
		const id = String(elementId);
		if (id === "") {
			return null;
		}
		for (const node of descendants(this)) {
			if (node.nodeType === ELEMENT_NODE) {
				if ((node as Element).getAttribute("id") === id) {
					return node as Element;
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

/** The ParentNode mixin, installed from the tables. */
export interface DocumentFragment
	extends Pick<globalThis.DocumentFragment, ParentNodeMixin> {}

Object.defineProperty(DocumentFragment.prototype, Symbol.toStringTag, {
	value: "DocumentFragment",
	configurable: true,
});

function descendantText(node: Node): string {
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

/* ------------------------------------------------------------------- attrs */

const kValue = Symbol("attribute value");
const kOwnerElement = Symbol("owner element");
const kQualifiedName = Symbol("qualified name");

export class Attr extends Node {
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

	get [kQualifiedName](): string {
		return this[kPrefix] === null ?
			this[kLocalName]! :
			`${this[kPrefix]!}:${this[kLocalName]!}`;
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

	override get textContent(): string | null {
		return this[kValue]!;
	}

	override set textContent(value: string | null) {
		setExistingAttributeValue(this, nullableString(value));
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

/** An attribute always has a node document, so this narrows Node's. */
export interface Attr {
	get ownerDocument(): Document;
}

/** Set an existing attribute's value, running the attribute change steps. */
function setExistingAttributeValue(attribute: Attr, value: string): void {
	const element = attribute[kOwnerElement]!;
	if (element === null) {
		attribute[kValue] = value;
		return;
	}
	changeAttribute(attribute, value);
}

/**
 * The attribute change steps run AFTER the change lands, as the DOM Standard
 * orders them: an element's own steps read the element, and what they must read
 * is the tree the rest of the world will see.
 */
type AttributeChangeListener = (element: Element, localName: string) => void;
const attributeChangeListeners: AttributeChangeListener[] = [];

function notifyAttributeChange(element: Element, localName: string): void {
	for (const listener of attributeChangeListeners) {
		listener(element, localName);
	}
}

const shadowAttachedListeners: Array<(root: ShadowRoot) => void> = [];

/**
 * What a style engine must hear from the tree, realm-wide and synchronous:
 * the callbacks fire at the change algorithms themselves, so a read that
 * follows a write sees a world the observer has already seen. Attribute
 * changes arrive from any writer -- setAttribute, classList, className,
 * toggleAttribute, the parser -- and shadow roots the moment they attach,
 * declarative ones included.
 */
interface TreeObserver {
	attributeChanged(element: Element, localName: string): void;
	shadowAttached(root: ShadowRoot): void;
}

/** Register the realm's style engine on the tree's change algorithms. */
export function observeTree(observer: TreeObserver): void {
	attributeChangeListeners.push((element, localName) =>
		observer.attributeChanged(element, localName),
	);
	shadowAttachedListeners.push((root) => observer.shadowAttached(root));
}

const kAttributeChanged = Symbol("attribute change steps");

function changeAttribute(attribute: Attr, value: string): void {
	const element = attribute[kOwnerElement]! as Element;
	const oldValue = attribute[kValue]!;
	queueAttributeMutationRecord(element, attribute, oldValue);
	attribute[kValue] = value;
	element[kAttributeChanged]!(
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
	element[kAttributeChanged]!(
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
	element[kAttributeChanged]!(
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
	element[kAttributeChanged]!(
		newAttribute[kLocalName]!,
		oldAttribute[kValue]!,
		newAttribute[kValue]!,
		newAttribute[kNamespace]!,
	);
	syncAttributeCollections(element, newAttribute[kLocalName]!);
	notifyAttributeChange(element, newAttribute[kLocalName]!);
}

/** Queue a record for a change to an element's attribute. */
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
	qualifiedName: string,
): Attr | null {
	let name = qualifiedName;
	if (
		element[kNamespace] === HTML_NAMESPACE &&
		isHTMLDocument(element[kDocument]!)
	) {
		name = asciiLowercase(name);
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

export class NamedNodeMap extends LiveList {
	declare [Symbol.iterator]: () => ArrayIterator<Attr>;

	declare [kElement]?: Element;

	constructor(element: Element) {
		super(true, element);
		this[kElement] = element;
	}

	/** An element's attributes are no part of the shape of a tree. */
	override shapeMembers(): Node[] {
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
			if (html && asciiLowercase(name) !== name) {
				continue;
			}
			if (!named.has(name)) {
				named.set(name, attribute);
			}
		}
		return named;
	}

	get length(): number {
		return ensure(this).length;
	}

	item(index: number): Attr | null {
		const items = ensure(this);
		const at = toUnsignedLong(index);
		return at < items.length ? (items[at] as Attr) : null;
	}

	getNamedItem(qualifiedName: string): Attr | null {
		return getAttributeByName(this[kElement]!, String(qualifiedName));
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

	removeNamedItem(qualifiedName: string): Attr {
		const attribute = getAttributeByName(
			this[kElement]!,
			String(qualifiedName),
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

/** The attributes by position, materialised as own properties. */
export interface NamedNodeMap {
	[index: number]: Attr;
}

installArrayIteration(NodeList.prototype, true);
installArrayIteration(DOMTokenList.prototype, true);
installArrayIteration(HTMLCollection.prototype, false);
installArrayIteration(NamedNodeMap.prototype, false);

/* ---------------------------------------------------------------- elements */

type CustomElementState =
	"uncustomized" |
	"undefined" |
	"failed" |
	"custom" |
	"precustomized";

const kByName = Symbol("byName");

/**
 * The interface an element name is built through.
 *
 * A name the DOM Standard gives behavior of its own -- slot, and the template
 * whose content fragment the parser fills -- is created through the class that
 * carries that behavior; every other name lands on one of the four namespace
 * interfaces. An author's definitions live in a CustomElementRegistry, which
 * is a separate table with a separate lifetime.
 */
class ElementRegistry {
	constructor() {
		this[kByName] = new Map<string, new () => Element>();
	}

	declare [kByName]?: Map<string, new () => Element>;

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

/**
 * Whether the tree is building an element itself.
 *
 * The HTML element constructor is an author-facing algorithm: it asks which
 * custom element definition `new.target` names and throws when there is none.
 * The tree's own creation path needs the same classes with none of that, and
 * this flag is how the constructor tells the two apart.
 */
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
const kClickInProgress = Symbol("click in progress");
const kInternals = Symbol("element internals");

/** The two argument forms CSSOM View gives each scroll method. */
type ScrollMethod = (
	xOrOptions?: number | globalThis.ScrollToOptions,
	y?: number,
) => void;

export class Element extends Node {
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

	// Installed on the prototype, where the mount that answers them is.
	declare getBoundingClientRect: () => globalThis.DOMRect;
	declare getClientRects: () => globalThis.DOMRectList;
	declare scrollLeft: number;
	declare scrollTop: number;
	declare scroll: ScrollMethod;
	declare scrollTo: ScrollMethod;
	declare scrollBy: ScrollMethod;

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
		this[kDocument] = currentDocument();
	}

	/** A slottable that is assigned reaches its slot before its parent. */
	override [kGetTheParent]?(_event: Event): EventTarget | null {
		return this[kAssignedSlot] ?? this[kParent]!;
	}

	override get nodeType(): number {
		return ELEMENT_NODE;
	}

	override get nodeName(): string {
		return this.tagName;
	}

	get [kQualifiedName](): string {
		return this[kPrefix] === null ?
			this[kLocalName]! :
			`${this[kPrefix]!}:${this[kLocalName]!}`;
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
			isHTMLDocument(this[kDocument]!) ?
				asciiUppercase(qualified) :
			qualified;
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
			ensure(list);
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

	attachShadow(init: ShadowRootInit): ShadowRoot {
		const options = toDictionary<ShadowRootInit>(init, "A ShadowRootInit");
		const mode = String(options.mode);
		if (mode !== "open" && mode !== "closed") {
			throw new TypeError(`${mode} is not a shadow root mode`);
		}
		const slotAssignment =
			options.slotAssignment === undefined ?
				"named" :
					String(options.slotAssignment);
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
		mountOf(this)?.shadowAttached(this, root);
		return root;
	}

	/**
	 * Show the element by itself, over the whole viewport. A headless
	 * document has no viewport to fill: the spec's no-browsing-context
	 * document rejects.
	 */
	requestFullscreen(options?: globalThis.FullscreenOptions): Promise<void> {
		const engine = mountOf(this);
		if (engine === undefined) {
			return Promise.reject(
				new TypeError("The element's document is not displayed"),
			);
		}
		return engine.requestFullscreen(this, options);
	}

	get shadowRoot(): ShadowRoot | null {
		const shadow = this[kShadowRoot]!;
		if (shadow === null || shadow[kShadowMode] !== "open") {
			return null;
		}
		return shadow;
	}

	get attributes(): NamedNodeMap {
		let map = this[kAttributesMap]!;
		if (map === null) {
			map = new NamedNodeMap(this);
			ensure(map);
			this[kAttributesMap] = map;
		}
		return map;
	}

	hasAttributes(): boolean {
		return this[kAttributeList]!.length > 0;
	}

	getAttributeNames(): string[] {
		return this[kAttributeList]!.map((attribute) => attribute[kQualifiedName]!);
	}

	getAttribute(qualifiedName: string): string | null {
		const attribute = getAttributeByName(this, String(qualifiedName));
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

	setAttribute(qualifiedName: string, value: string): void {
		if (arguments.length < 2) {
			throw new TypeError("setAttribute needs a name and a value");
		}
		let name = String(qualifiedName);
		validateAttributeLocalName(name);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
		) {
			name = asciiLowercase(name);
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
		qualifiedName: string,
		value: string,
	): void {
		if (arguments.length < 3) {
			throw new TypeError("setAttributeNS needs a namespace, name and value");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(qualifiedName),
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

	removeAttribute(qualifiedName: string): void {
		const attribute = getAttributeByName(this, String(qualifiedName));
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

	toggleAttribute(qualifiedName: string, force?: boolean): boolean {
		let name = String(qualifiedName);
		validateAttributeLocalName(name);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
		) {
			name = asciiLowercase(name);
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

	hasAttribute(qualifiedName: string): boolean {
		let name = String(qualifiedName);
		if (
			this[kNamespace] === HTML_NAMESPACE &&
			isHTMLDocument(this[kDocument]!)
		) {
			name = asciiLowercase(name);
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

	getAttributeNode(qualifiedName: string): Attr | null {
		return getAttributeByName(this, String(qualifiedName));
	}

	getAttributeNodeNS(namespace: string | null, localName: string): Attr | null {
		return getAttributeByNamespace(this, namespace, String(localName));
	}

	setAttributeNode(attr: Attr): Attr | null {
		if (!(attr instanceof Attr)) {
			throw new TypeError("That is not an Attr");
		}
		return setAttributeNode(this, attr);
	}

	setAttributeNodeNS(attr: Attr): Attr | null {
		if (!(attr instanceof Attr)) {
			throw new TypeError("That is not an Attr");
		}
		return setAttributeNode(this, attr);
	}

	removeAttributeNode(attr: Attr): Attr {
		if (!(attr instanceof Attr)) {
			throw new TypeError("That is not an Attr");
		}
		if (!this[kAttributeList]!.includes(attr)) {
			throw notFoundError("That attribute is not on this element");
		}
		removeAttributeNode(this, attr);
		return attr;
	}

	getElementsByTagName(qualifiedName: string): HTMLCollection {
		return elementsByTagName(this, String(qualifiedName));
	}

	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollection {
		return elementsByTagNameNS(this, namespace, String(localName));
	}

	getElementsByClassName(classNames: string): HTMLCollection {
		return elementsByClassName(this, String(classNames));
	}

	override get textContent(): string | null {
		return descendantText(this);
	}

	override set textContent(value: string | null) {
		setDescendantText(this, value);
	}

	/**
	 * The markup inside the element.
	 *
	 * A template's markup is its content fragment's: the parser never put its
	 * children in the tree, and neither does a write.
	 */
	get innerHTML(): string {
		return serializeFragment(markupHost(this), false);
	}

	set innerHTML(value: string) {
		const fragment = parseFragmentHTML(String(value ?? ""), this);
		replaceAll(fragment, markupHost(this));
	}

	getHTML(options?: {
		serializableShadowRoots?: boolean;
		shadowRoots?: ShadowRoot[];
	}): string {
		const init = toDictionary<{
			serializableShadowRoots?: boolean;
			shadowRoots?: ShadowRoot[];
		}>(options ?? {}, "A GetHTMLOptions");
		return serializeFragment(
			markupHost(this),
			Boolean(init.serializableShadowRoots),
			init.shadowRoots ?? [],
		);
	}

	setHTMLUnsafe(html: string): void {
		const fragment = parseFragmentHTML(String(html ?? ""), this, true);
		replaceAll(fragment, markupHost(this));
	}

	get outerHTML(): string {
		return serializeOuterHTML(this);
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
			parent.nodeType === DOCUMENT_FRAGMENT_NODE ?
					createElementInternal(this[kDocument]!, "body", HTML_NAMESPACE) :
					(parent as Element);
		const fragment = parseFragmentHTML(String(value ?? ""), context);
		replaceChild(this, fragment, parent);
	}

	insertAdjacentElement(where: string, element: Element): Element | null {
		return insertAdjacent(this, String(where), element) as Element | null;
	}

	insertAdjacentText(where: string, data: string): void {
		const text = new Text(String(data));
		text[kDocument] = this[kDocument]!;
		insertAdjacent(this, String(where), text);
	}

	insertAdjacentHTML(position: string, text: string): void {
		const where = asciiLowercase(String(position));
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
					parent.nodeType === ELEMENT_NODE ?
						parent :
							createElementInternal(this[kDocument]!, "body", HTML_NAMESPACE);
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
		const fragment = parseFragmentHTML(String(text), element);
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

	override [kInsertionSteps]?(): void {
		const root = getRoot(this);
		if (root.nodeType === DOCUMENT_NODE) {
			addToIdMap(root as Document, this);
		}
		// The steps run once for every element of an inserted tree, so this
		// element is the only one to claim here.
		if (this[kRegistry] === null && root[kRegistry] !== null) {
			this[kRegistry] = root[kRegistry]!;
			tryToUpgrade(this);
		}
		refreshFormOwner(this);
		refreshFormDisabled(this);
		// A form that joins a tree becomes the owner of everything already in
		// it that names the form, and a fieldset brings its disabling with it.
		if (
			this instanceof HTMLFormElement ||
			this instanceof HTMLFieldSetElement
		) {
			refreshFormOwnersUnder(root);
		}
	}

	override [kRemovingSteps]?(oldParent: Node): void {
		const root = getRoot(oldParent);
		if (root.nodeType === DOCUMENT_NODE) {
			removeFromIdMap(root as Document, this);
		}
		refreshFormOwnersUnder(this);
		if (
			this instanceof HTMLFormElement ||
			this instanceof HTMLFieldSetElement
		) {
			refreshFormOwnersUnder(root);
		}
	}

	[kAttributeChanged]?(
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
			refreshFormOwnersUnder(getRoot(this));
		}
		if (namespace === null && localName === "disabled") {
			refreshFormDisabled(this);
			if (this instanceof HTMLFieldSetElement) {
				for (const node of descendants(this)) {
					if (node.nodeType === ELEMENT_NODE) {
						refreshFormDisabled(node as Element);
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
		widgetChanged(this);
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

	/**
	 * The Typed OM, which this engine does not implement: every computed value
	 * it holds is a string, and handing back a CSSStyleValue would mean parsing
	 * one into a type nothing else here speaks.
	 */
	computedStyleMap(): never {
		throw domError(
			"NotSupportedError",
			"Typed OM is not implemented; use getComputedStyle",
		);
	}

	/**
	 * The Web Animations API, which needs a timeline this engine has none of:
	 * frames come from terminal input and layout invalidation, not from a
	 * clock that a running animation could be sampled against.
	 */
	animate(): never {
		throw domError(
			"NotSupportedError",
			"Web Animations is not implemented",
		);
	}

	/** Nothing animates, so nothing is animating. */
	getAnimations(): globalThis.Animation[] {
		return [];
	}

	/** A terminal has no zoom, and 1 is what no zoom is. */
	get currentCSSZoom(): number {
		return 1;
	}

	/** Nothing captures a pointer, so nothing has one captured. */
	hasPointerCapture(_pointerId: number): boolean {
		return false;
	}

	/**
	 * Pointer capture and pointer lock both need a pointer that keeps sending
	 * after it leaves a box. A terminal reports the cell the mouse is over and
	 * stops at the edge of the screen, so there is nothing to capture and
	 * nowhere to lock it to.
	 */
	setPointerCapture(_pointerId: number): never {
		throw domError("NotSupportedError", "Pointer capture is not implemented");
	}

	releasePointerCapture(_pointerId: number): never {
		throw domError("NotSupportedError", "Pointer capture is not implemented");
	}

	requestPointerLock(): never {
		throw domError("NotSupportedError", "Pointer lock is not implemented");
	}
}

/**
 * What the tables and the mount give an element, which installing says nothing
 * about: the mixins, the reflected members, and the geometry a mount answers.
 * Taken through Pick so a declaration cannot drift from the member it stands
 * for -- except the two written out, which a Pick would make properties, and a
 * subclass declares each as a method with a signature of its own.
 */
export interface Element
	extends Pick<
		globalThis.Element,
		// `remove` and `scrollIntoView` are written out below rather than
		// Picked: a Pick yields a property, and a subclass declares each of
		// them as a method, which may not override one.
		| Exclude<ChildNodeMixin, "remove"> |
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
}

Object.defineProperty(Element.prototype, Symbol.toStringTag, {
	value: "Element",
	configurable: true,
});

Object.defineProperties(Element.prototype, {
	matches: {
		value(this: Element, selectors: string): boolean {
			return selectorEngine(this[kDocument]!).match(
				String(selectors),
				this as never,
			);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	webkitMatchesSelector: {
		value(this: Element, selectors: string): boolean {
			return selectorEngine(this[kDocument]!).match(
				String(selectors),
				this as never,
			);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	closest: {
		value(this: Element, selectors: string): Element | null {
			const engine = selectorEngine(this[kDocument]!);
			const selector = String(selectors);
			// A bad selector throws before any ancestor is examined.
			engine.match(selector, this as never);
			let node: Node | null = this;
			while (node !== null && node.nodeType === ELEMENT_NODE) {
				if (engine.match(selector, node as never)) {
					return node as Element;
				}
				node = node[kParent]!;
			}
			return null;
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	// How far a box is scrolled from its content's origin. A mounted
	// document answers from the engine, which holds the offsets it clamped
	// against laid-out content. The storage below is what a headless
	// document answers with: writes land and read back, and nothing moves.
	scrollLeft: {
		get(this: Element): number {
			const engine = mountOf(this);
			return engine ?
				engine.scrollOffset(this).left :
					(scrollOffsets.get(this)?.left ?? 0);
		},
		set(this: Element, value: number) {
			const engine = mountOf(this);
			if (engine === undefined) {
				writeScrollOffset(this, "left", toDouble(value));
				return;
			}
			engine.scrollOffsetTo(this, "left", value);
		},
		configurable: true,
		enumerable: true,
	},
	scrollTop: {
		get(this: Element): number {
			const engine = mountOf(this);
			return engine ?
				engine.scrollOffset(this).top :
					(scrollOffsets.get(this)?.top ?? 0);
		},
		set(this: Element, value: number) {
			const engine = mountOf(this);
			if (engine === undefined) {
				writeScrollOffset(this, "top", toDouble(value));
				return;
			}
			engine.scrollOffsetTo(this, "top", value);
		},
		configurable: true,
		enumerable: true,
	},
	// scrollTo/scroll/scrollBy, in both their forms; assignment through the
	// accessors above is what rounds, clamps and repaints. html and body's
	// own scrollTop accessors map to the terminal's camera, so scrolling
	// them scrolls the document, as everywhere else.
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
			const target = scrollTargetOf(xOrOptions, y);
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

// The geometry surface: the APIs are the DOM's, what they measure is the
// engine's. Writable so a test can stub a measurement, as on the platform.
Object.defineProperties(Element.prototype, {
	getBoundingClientRect: {
		value(this: Element): globalThis.DOMRect {
			return (
				mountOf(this)?.boundingClientRect(this) ??
				new DOMRect(0, 0, 0, 0)
			);
		},
		writable: true,
		configurable: true,
	},
	getClientRects: {
		value(this: Element): globalThis.DOMRectList {
			return mountOf(this)?.clientRects(this) ?? new DOMRectList();
		},
		writable: true,
		configurable: true,
	},
});

/**
 * The element the focus state names. document.activeElement retargets to
 * the host chain, so a focus move inside a shadow tree is invisible
 * through it; the raw state is at the bottom of each root's own
 * activeElement chain.
 */
function innermostActive(document: Document): Element | null {
	let current = document.activeElement;
	while (current !== null) {
		const inner = current[kShadowRoot]?.activeElement ?? null;
		if (inner === null) {
			break;
		}
		current = inner;
	}
	return current;
}

const alreadyConstructed = Symbol("already constructed");

export class HTMLElement extends Element {
	// Installed on the prototype, where the mount that measures them is.
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
		// The checks come before the object. A constructor that names no
		// definition throws without anything having been allocated, and an
		// upgrade never allocates at all: it hands back the element already in
		// the tree, so super() runs only on the branch that builds one.
		const target = new.target as unknown as CustomElementConstructor;
		if (target === (HTMLElement as unknown as CustomElementConstructor)) {
			throw new TypeError("Illegal constructor");
		}
		const definition = definitionForConstructor(target);
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
			// A prototype that is not an object is the interface's own, which is
			// what allocating from this constructor would have given the element.
			const named = (target as unknown as {prototype: unknown}).prototype;
			const prototype =
				named !== null && typeof named === "object" ?
						(named as object) :
					HTMLElement.prototype;
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
		this[kRegistry] = definitionRegistry(definition);
	}

	/**
	 * Whether the element's text is to be translated.
	 *
	 * The attribute is inherited: an element that does not name a mode takes
	 * its parent's, and the root of a tree that names none is translated.
	 */
	get translate(): boolean {
		const value = this.getAttribute("translate");
		if (value !== null) {
			const mode = asciiLowercase(value);
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

	/**
	 * Whether the element can be dragged. An element that names neither state
	 * falls back to the two elements HTML drags by default.
	 */
	get draggable(): boolean {
		const value = this.getAttribute("draggable");
		if (value !== null) {
			const state = asciiLowercase(value);
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

	/** Whether the element's text is spell-checked, inherited like translate. */
	get spellcheck(): boolean {
		const value = this.getAttribute("spellcheck");
		if (value !== null) {
			const state = asciiLowercase(value);
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

	/** The element's own autocapitalization hint, named by its keyword. */
	get autocapitalize(): string {
		const value = this.getAttribute("autocapitalize");
		if (value === null) {
			return "";
		}
		const state = asciiLowercase(value);
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

	/** Whether typed text is autocorrected; every value but "off" is on. */
	get autocorrect(): boolean {
		const value = this.getAttribute("autocorrect");
		return value === null || asciiLowercase(value) !== "off";
	}

	set autocorrect(value: boolean) {
		this.setAttribute("autocorrect", value ? "on" : "off");
	}

	/** Hidden reflects as `any`: a string for the third state, else a boolean. */
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

	get hidden(): boolean | string {
		const value = this.getAttribute("hidden");
		if (value === null) {
			return false;
		}
		return asciiLowercase(value) === "until-found" ? "until-found" : true;
	}

	set hidden(value: boolean | string) {
		if (typeof value === "string" && asciiLowercase(value) === "until-found") {
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
		const state = asciiLowercase(value);
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
		const state = asciiLowercase(String(value));
		if (state === "inherit") {
			this.removeAttribute("contenteditable");
			return;
		}
		if (state !== "true" && state !== "false" && state !== "plaintext-only") {
			throw domError("SyntaxError", `"${value}" is not an editability`);
		}
		this.setAttribute("contenteditable", state);
	}

	/** Whether the element is editable: its own state, or the nearest one above. */
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

	/**
	 * The element's place in the tabbing order.
	 *
	 * The default is the one the attribute's definition names: zero for the
	 * elements that are in the order without saying so, and minus one for the
	 * rest.
	 */
	get tabIndex(): number {
		const value = this.getAttribute("tabindex");
		const parsed = value === null ? null : parseInteger(value);
		if (parsed !== null && parsed >= -2147483648 && parsed <= 2147483647) {
			return parsed;
		}
		return defaultTabIndex(this);
	}

	set tabIndex(value: number) {
		this.setAttribute("tabindex", String(toLong(value)));
	}

	/** The data-* attributes, as a map keyed by the names they carry. */
	get dataset(): DOMStringMap {
		let map = this[kDataset]!;
		if (map === null) {
			map = new DOMStringMap(this);
			this[kDataset] = map;
		}
		syncDataset(map);
		return map;
	}

	/**
	 * Fire a click at the element as though a pointer had.
	 *
	 * The event is a pointer event and untrusted, so a listener can tell it
	 * from a real one, and dispatch runs whatever activation behavior it
	 * reaches. A disabled form control is not clicked at all.
	 */
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

	/** The internals of a custom element, which only its definition may take. */
	attachInternals(): ElementInternals {
		return attachElementInternals(this);
	}

	/**
	 * Make the element the document's focused area.
	 *
	 * The focus STATE moves here. The focus/blur/focusin/focusout events
	 * are the mount's to fire, because their order interleaves with
	 * whatever else a move of focus does -- a repaint, a caret reveal --
	 * and this DOM has no window to fire them at. A headless document moves
	 * the state and stops.
	 */
	focus(): void {
		const document = this[kDocument]!;
		const previous = innermostActive(document);
		// Shadow-including connectedness: a node whose tree root is a shadow
		// root is focusable when its host chain reaches the document -- the
		// node-tree root test refused every element in a shadow tree.
		if (isFocusableArea(this) && this.isConnected) {
			document[kActiveElement] = this;
		}
		if (previous !== this && innermostActive(document) === this) {
			mountOf(this)?.focusMoved(previous, this);
		}
	}

	/** Give up focus, which returns it to the document's body. */
	blur(): void {
		const document = this[kDocument]!;
		const wasFocused = innermostActive(document) === this;
		if (document[kActiveElement] === this) {
			document[kActiveElement] = null;
		}
		if (wasFocused) {
			mountOf(this)?.blurred(this);
		}
	}

	/**
	 * Show the element as a popover: it joins the top layer, over everything
	 * the document paints, and the UA sheet stops hiding it.
	 */
	showPopover(options?: {source?: Element | null}): void {
		const init =
			options === undefined ?
					{} :
					toDictionary<{source?: Element | null}>(options, "Show options");
		showPopover(this, true, init.source ?? null);
	}

	/** Hide a showing popover, which leaves the top layer as it goes. */
	hidePopover(): void {
		hidePopover(this, true, true, true, null);
	}

	/**
	 * Show a hidden popover or hide a showing one, and answer with whether it
	 * is showing afterwards. A force of true only ever shows and one of false
	 * only ever hides, so a caller that knows the state it wants says it.
	 */
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
			// Neither half runs, and the state still has to be a legal one:
			// toggling something that is not a popover throws either way.
			const validity = popoverValidity(this, showing, null);
			if (isPopoverException(validity)) {
				throw validity;
			}
		}
		return isShowingPopover(this);
	}

	/**
	 * A popover whose attribute changes state stops being the popover it was
	 * showing as, so it closes -- silently, since the author who changed the
	 * attribute is not asking to be told about the popover it used to be.
	 */
	override [kAttributeChanged]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChanged]!(localName, oldValue, value, namespace);
		if (namespace !== null || localName !== "popover") {
			return;
		}
		if (popoverValueState(oldValue) === popoverValueState(value)) {
			return;
		}
		if (!isShowingPopover(this)) {
			return;
		}
		hidePopover(this, true, true, false, null);
	}

	/**
	 * A popover taken out of the document is no longer showing: the top layer
	 * holds nothing off the tree, and there is no page left for it to be over.
	 */
	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		if (!isShowingPopover(this)) {
			return;
		}
		const state = popoverStateOf(this);
		topLayerOf(this[kDocument]!).delete(this);
		state.visibility = "hidden";
		state.mode = null;
		state.trigger = null;
		state.previouslyFocused = null;
		popoverStateChanged(this);
	}
}

/**
 * Whether an element can be the document's focused area.
 *
 * A tabindex attribute makes any element focusable whatever its value says --
 * a negative one only takes the element out of sequential navigation, not out
 * of focus() -- and the elements that are focusable without one say so through
 * their default tabindex. A disabled control is focusable by neither route.
 */
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
	return defaultTabIndex(element) >= 0;
}

Object.defineProperty(HTMLElement.prototype, Symbol.toStringTag, {
	value: "HTMLElement",
	configurable: true,
});

Object.defineProperties(HTMLElement.prototype, {
	offsetWidth: {
		get(this: HTMLElement): number {
			return mountOf(this)?.offsetSize(this).width ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetHeight: {
		get(this: HTMLElement): number {
			return mountOf(this)?.offsetSize(this).height ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetTop: {
		get(this: HTMLElement): number {
			return mountOf(this)?.offsetPosition(this).top ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetLeft: {
		get(this: HTMLElement): number {
			return mountOf(this)?.offsetPosition(this).left ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	offsetParent: {
		get(this: HTMLElement): Element | null {
			return (mountOf(this)?.offsetParent(this) ?? null) as
				Element |
				null;
		},
		configurable: true,
		enumerable: true,
	},
	clientWidth: {
		get(this: HTMLElement): number {
			return mountOf(this)?.clientSize(this).width ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	clientHeight: {
		get(this: HTMLElement): number {
			return mountOf(this)?.clientSize(this).height ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	clientLeft: {
		get(this: HTMLElement): number {
			return mountOf(this)?.clientEdge(this).left ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	clientTop: {
		get(this: HTMLElement): number {
			return mountOf(this)?.clientEdge(this).top ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	scrollWidth: {
		get(this: HTMLElement): number {
			return mountOf(this)?.scrollSize(this).width ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	scrollHeight: {
		get(this: HTMLElement): number {
			return mountOf(this)?.scrollSize(this).height ?? 0;
		},
		configurable: true,
		enumerable: true,
	},
	// checkVisibility, on the definition the focus walk already uses: a
	// rendered element -- nothing on its flat chain display:none, and it
	// produced boxes -- with the visibility check the options ask for.
	// Nothing a headless document holds is rendered.
	/*
	 * Reveal the element: every scroll box between it and the document
	 * scrolls it into view, and so does the screen. A headless document
	 * shows nothing, so there is nothing to reveal into. The options are not
	 * read: all moves are the minimal ones, block "nearest".
	 */
	scrollIntoView: {
		value(this: HTMLElement): void {
			mountOf(this)?.scrollIntoView(this);
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	checkVisibility: {
		value(
			this: HTMLElement,
			options?: globalThis.CheckVisibilityOptions,
		): boolean {
			return mountOf(this)?.checkVisibility(this, options) ?? false;
		},
		writable: true,
		configurable: true,
		enumerable: true,
	},
});

/**
 * Whether the element sits in an inert subtree: itself or any ancestor up
 * the host chain carries the `inert` attribute. Inert takes an element out
 * of every focusable area, so focus() refuses it and the focus walk skips
 * it, wherever in a shadow tree it stands.
 */
function isInertTree(element: Element): boolean {
	for (
		let node: Element | null = element;
		node !== null;

	) {
		if (node.hasAttribute("inert")) {
			return true;
		}
		const parent: Element | null = node.parentElement;
		if (parent !== null) {
			node = parent;
			continue;
		}
		const root = getRoot(node);
		node = isShadowRoot(root) ?
				((root as ShadowRoot)[kHost]! as Element) :
			null;
	}
	return false;
}

/**
 * The tabindex an element has when it does not say: zero for the elements
 * that are in the sequential focus navigation order without an attribute, and
 * minus one for every other element.
 */
function defaultTabIndex(element: Element): number {
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
				firstChildElement(parent, "summary") === element ?
				0 :
					-1;
		}
		default:
			return -1;
	}
}

/** The first child element of a parent with a given HTML local name. */
function firstChildElement(parent: Node, localName: string): Element | null {
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

export class HTMLUnknownElement extends HTMLElement {}

Object.defineProperty(HTMLUnknownElement.prototype, Symbol.toStringTag, {
	value: "HTMLUnknownElement",
	configurable: true,
});

export class SVGElement extends Element {}

Object.defineProperty(SVGElement.prototype, Symbol.toStringTag, {
	value: "SVGElement",
	configurable: true,
});

export class MathMLElement extends Element {}

Object.defineProperty(MathMLElement.prototype, Symbol.toStringTag, {
	value: "MathMLElement",
	configurable: true,
});

/** The node an element's markup reads from and writes to. */
function markupHost(element: Element): Node {
	return element instanceof HTMLTemplateElement ? element.content : element;
}

/** Set an attribute value, creating the attribute where there is none. */
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

/** The interface a name and a namespace are built through. */
function elementInterface(
	namespace: string | null,
	localName: string,
): new () => Element {
	const builtin = builtinRegistry.lookup(namespace, localName);
	if (builtin !== null) {
		return builtin;
	}
	if (namespace === HTML_NAMESPACE) {
		return isValidCustomElementName(localName) ?
			HTMLElement :
			HTMLUnknownElement;
	}
	if (namespace === SVG_NAMESPACE) {
		return SVGElement;
	}
	if (namespace === MATHML_NAMESPACE) {
		return MathMLElement;
	}
	return Element;
}

/** Build an element of an interface without running an author's constructor. */
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

/**
 * The spec's "create an element" algorithm.
 *
 * With the synchronous flag set -- createElement and its kin -- an author's
 * constructor runs here and its result is checked to be a bare element of the
 * right name. Without it -- the parser -- the element is created undefined and
 * an upgrade reaction is enqueued, so the parser never re-enters script.
 */
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
				elementInterface(namespace, localName),
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
				elementInterface(namespace, localName),
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
		elementInterface(namespace, localName),
		localName,
		namespace,
		prefix,
		is,
	);
	element[kRegistry] = inRegistry;
	element[kCustomState] =
		namespace === HTML_NAMESPACE &&
		(isValidCustomElementName(localName) || is !== null) ?
			"undefined" :
			"uncustomized";
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

/**
 * A valid custom element name: a local name the parser will read as a tag,
 * beginning with a lower-case letter, carrying a hyphen and no upper-case
 * letter, and not one of the hyphenated names SVG and MathML already own.
 */
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

/* --------------------------------------------------- custom element reactions */

/** The marker an entry in a construction stack becomes once super() ran. */

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

/**
 * The custom element reactions stack.
 *
 * Author code must see a lifecycle callback after the mutation that caused it
 * has finished, never in the middle of one: a queue is pushed when an API the
 * IDL marks [CEReactions] is entered and drained when it returns, so a script
 * that appends a subtree gets one connectedCallback per element, in tree
 * order, after the whole subtree is in place.
 */
const reactionsStack: Element[][] = [];

/**
 * Where a reaction goes when nothing on the stack claims it -- a mutation the
 * tree makes on its own behalf. The queue drains on a microtask, and the flag
 * keeps a reaction enqueued by that drain from starting a second one.
 */
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

function elementReactionQueue(element: Element): Reaction[] {
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
	elementReactionQueue(element).push({callback, args});
	enqueueOnAppropriateElementQueue(element);
}

function enqueueUpgradeReaction(
	element: Element,
	definition: CustomElementDefinition,
): void {
	elementReactionQueue(element).push({upgrade: definition});
	enqueueOnAppropriateElementQueue(element);
}

/** Run every reaction every element in a queue has waiting. */
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

/** The steps [CEReactions] adds around an operation. */
function withReactions<T>(steps: () => T): T {
	reactionsStack.push([]);
	try {
		return steps();
	} finally {
		invokeReactions(reactionsStack.pop() as Element[]);
	}
}

/**
 * Wrap the members the IDL marks [CEReactions] so that each is a reactions
 * boundary. A getter is never one -- the extended attribute cannot appear on a
 * readonly attribute -- so only values and setters are wrapped.
 */
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

/* ---------------------------------------------------- custom element registry */

/**
 * Whether a value has a [[Construct]] internal method.
 *
 * The construction runs against a proxy of the value whose own trap answers,
 * so nothing on the value is read: a proxy is constructible exactly when its
 * target is, and the trap returns before the object it would build needs a
 * prototype. Constructing with the value as the new target would read its
 * `prototype`, which the caller can see and the algorithm reads later, once.
 */
function isConstructor(value: unknown): boolean {
	if (typeof value !== "function") {
		return false;
	}
	try {
		Reflect.construct(
			// Probing whether a registered constructor is constructible has no
			// other spelling.
			// eslint-disable-next-line no-restricted-globals
			new Proxy(value as new () => unknown, {construct: () => ({})}),
			[],
		);
		return true;
	} catch (_err) {
		return false;
	}
}

/** Convert a value to sequence<DOMString>, as the IDL binding would. */
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

/** Every registry this realm has, in the order they were built. */
const registries: CustomElementRegistry[] = [];

const kDefinitions = Symbol("definitions");
const kDefinitionIsRunning = Symbol("definitionIsRunning");
const kWhenDefined = Symbol("whenDefined");
const kScoped = Symbol("scoped");
const kIsScopedRegistry = Symbol("whether an author built this registry");

export class CustomElementRegistry {
	/**
	 * Whether this registry is one an author built. The registry a realm hands
	 * every document is not scoped, and is the only one a document may hold.
	 */
	declare [kScoped]?: boolean;
	declare [kDefinitions]?: CustomElementDefinition[];
	declare [kDefinitionIsRunning]?: boolean;

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

	declare [kWhenDefined]?: Map<string, {
		promise: Promise<CustomElementConstructor>;
		resolve: (value: CustomElementConstructor) => void;
	}>;

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
		const document = currentDocument();
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

	/**
	 * Claim a subtree that has no registry yet.
	 *
	 * The registry a realm hands its documents cannot claim a document: a
	 * document holds that registry from the moment it exists, and there is
	 * nothing for the call to do.
	 */
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

	get [kIsScopedRegistry](): boolean {
		return this[kScoped]!;
	}
}

function definitionFor(
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

function lookUp(
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

/**
 * The definition a constructor names.
 *
 * A constructor can be defined in more than one registry, and the one a
 * `super()` call means is the one whose upgrade is in flight; with none in
 * flight the realm's own registry answers first, and a scoped registry only
 * where it is the sole one that knows the constructor.
 */
function definitionForConstructor(
	constructor: CustomElementConstructor,
): CustomElementDefinition | null {
	for (const registry of registries) {
		const definition = definitionFor(registry, constructor);
		if (definition !== null && definition.constructionStack.length > 0) {
			return definition;
		}
	}
	const global = definitionFor(globalCustomElements, constructor);
	if (global !== null) {
		return global;
	}
	for (const registry of registries) {
		const definition = definitionFor(registry, constructor);
		if (definition !== null) {
			return definition;
		}
	}
	return null;
}

/**
 * The registry every document in this realm shares.
 *
 * The spec hangs one off each Window; there is no Window here, and a document
 * reaches this one through the algorithms below rather than through a global,
 * so the tree stays standalone.
 */
const customElements = constructInternal(
	() => new CustomElementRegistry(),
);

const globalCustomElements = customElements;

/**
 * The registry a node's definitions come from.
 *
 * Every node carries one: an element takes its document's when it is created
 * and the tree's when it is inserted into one, a shadow root takes its host's
 * unless the caller named another, and a node created for a registry that has
 * not been given one yet carries null, which means no definition matches it
 * until a registry claims it.
 */
function lookUpCustomElementDefinition(
	registry: CustomElementRegistry | null,
	namespace: string | null,
	localName: string,
	is: string | null,
): CustomElementDefinition | null {
	if (registry === null) {
		return null;
	}
	return lookUp(registry, namespace, localName, is);
}

/**
 * Give a subtree a registry, stopping at nodes that already have one.
 *
 * The walk is over the node tree: a shadow tree hanging off an element in it
 * keeps whatever registry it was given, which is the point of scoping one.
 */
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

/** Construct a definition's constructor, as the spec's Construct(C) does. */
function constructCustomElement(definition: CustomElementDefinition): Element {
	return Reflect.construct(
		definition.constructor,
		[],
		definition.constructor,
	) as Element;
}

/**
 * The upgrade algorithm.
 *
 * The element is already in the tree; what changes is its prototype, its
 * state, and the callbacks it owes. The reactions for the attributes it
 * already carries and for being connected are enqueued before the constructor
 * runs, so an author's constructor sees them arrive afterwards.
 */
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
		// A constructor that threw leaves the element failed, with the callbacks
		// it had not run yet dropped. The definition stays: the element is that
		// definition's, and failed is a state of it rather than the absence of
		// one. The exception is reported by whoever runs the reaction.
		definition.constructionStack.pop();
		element[kCustomState] = "failed";
		element[kReactionQueue] = null;
		throw error;
	}
	definition.constructionStack.pop();
	element[kCustomState] = "custom";
	// A form-associated element learns its owner and its disabling as it
	// becomes one, which is the first moment it has an internals to be told.
	if (definition.formAssociated) {
		refreshFormOwner(element);
		refreshFormDisabled(element);
	}
}

/** The registry a definition was defined in. */
function definitionRegistry(
	definition: CustomElementDefinition,
): CustomElementRegistry | null {
	return definition.registry;
}

/**
 * The definition an upgrade candidate would become.
 *
 * A template's content belongs to a document with no browsing context, and a
 * document with no browsing context looks nothing up: an element sitting in
 * one never upgrades, however it got there.
 */
function upgradeDefinitionFor(
	element: Element,
): CustomElementDefinition | null {
	const root = getRoot(element);
	if (
		root.nodeType === DOCUMENT_FRAGMENT_NODE &&
		(root as DocumentFragment)[kHost]! instanceof HTMLTemplateElement
	) {
		return null;
	}
	return lookUpCustomElementDefinition(
		element[kRegistry]!,
		element[kNamespace]!,
		element[kLocalName]!,
		element[kIsValue]!,
	);
}

function tryToUpgrade(element: Element): void {
	const definition = upgradeDefinitionFor(element);
	if (definition !== null) {
		enqueueUpgradeReaction(element, definition);
	}
}

/* --------------------------------------------------------------- shadow trees */

/** The element names a shadow root may be attached to. */
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

/**
 * A user-agent shadow tree's slotting rule: which of the host's children
 * the given slot shows. Named slots sort children by their `slot`
 * attribute, which author content does not carry and the UA must not
 * write onto the author's nodes; a UA tree that sorts children by what
 * they are -- details sends its first summary to one slot and everything
 * else to the other -- carries this function instead. findSlottables
 * consults it on every assignment pass, so it always answers from the
 * current child list and needs no upkeep when children change.
 */
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
const kUAInternal = Symbol("user-agent shadow root");
const kAvailableToInternals = Symbol("available to element internals");

/**
 * A shadow root: the root of a tree a host element carries beside its
 * children.
 *
 * It is a document fragment with a host, which is what makes every algorithm
 * that already steps from a fragment to its host -- pre-insertion validity,
 * retargeting, the composed path -- work across it without a second concept.
 */
export class ShadowRoot extends DocumentFragment {
	[kShadowMode]?: "open" | "closed";
	[kUAInternal]?: boolean;
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
		this[kUAInternal] = false;
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

	/**
	 * The document's active element, retargeted into this tree: the
	 * shadow-including ancestor of the focus that is one of THIS root's
	 * descendants, or null when the focus is elsewhere entirely.
	 */
	get activeElement(): Element | null {
		const document = this.ownerDocument as Document | null;
		// The RAW focus, not the document's retargeted answer -- that one
		// already collapsed shadow content to its host.
		let current: Node | null = ((document ? document[kActiveElement]! : null) ??
			null) as Node | null;
		while (current !== null) {
			const root = current.getRootNode() as Node;
			if (root === (this as unknown as Node)) {
				return current as Element;
			}
			current =
				root instanceof ShadowRoot ?
						((root.host ?? null) as Node | null) :
					null;
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
		const fragment = parseFragmentHTML(
			String(value ?? ""),
			this[kHost]! as Element,
			false,
		);
		replaceAll(fragment, this);
	}

	getHTML(options?: {
		serializableShadowRoots?: boolean;
		shadowRoots?: ShadowRoot[];
	}): string {
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
		const fragment = parseFragmentHTML(
			String(html ?? ""),
			this[kHost]! as Element,
			true,
		);
		replaceAll(fragment, this);
	}

	/**
	 * A dispatch leaves a shadow tree through the host, unless the event was
	 * dispatched inside this very tree and is not composed.
	 */
	override [kGetTheParent]?(event: Event): EventTarget | null {
		const path = event[kDispatchState]!.path;
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

	/**
	 * The DocumentOrShadowRoot surface, SCOPED to this root: each answers for
	 * what is inside it, and nothing in this engine ever puts these inside a
	 * shadow root -- fullscreen, pointer lock and picture-in-picture are the
	 * document's, and hit testing is answered against the document because
	 * that is where the boxes were painted from.
	 */
	get fullscreenElement(): Element | null {
		return null;
	}

	get pointerLockElement(): Element | null {
		return null;
	}

	get pictureInPictureElement(): Element | null {
		return null;
	}

	elementFromPoint(_x: number, _y: number): Element | null {
		return null;
	}

	elementsFromPoint(_x: number, _y: number): Element[] {
		return [];
	}

	/** Nothing animates, so nothing is animating. */
	getAnimations(): globalThis.Animation[] {
		return [];
	}

	override [kCloneSingle]?(_document: Document): Node {
		throw domError("NotSupportedError", "A shadow root cannot be cloned");
	}
}

/** The ParentNode mixin and onslotchange, installed below. */
export interface ShadowRoot
	extends Pick<globalThis.ShadowRoot, ParentNodeMixin | "onslotchange"> {}

installEventHandler(ShadowRoot.prototype, "onslotchange");

Object.defineProperty(ShadowRoot.prototype, Symbol.toStringTag, {
	value: "ShadowRoot",
	configurable: true,
});

/** The spec's "attach a shadow root" algorithm. */
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
		for (const child of childNodeArray(existing)) {
			removeNode(child);
		}
		existing[kDeclarative] = false;
		return;
	}
	const shadow = constructInternal(() => new ShadowRoot());
	shadow[kDocument] = element[kDocument]!;
	shadow[kHost] = element;
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
	for (const listener of shadowAttachedListeners) {
		listener(shadow);
	}
}

/**
 * Give a form control the closed shadow tree its widget renders in.
 *
 * The tree is the same ShadowRoot an author's attachShadow builds -- slot
 * assignment, retargeting, `isConnected`, the selector engine's tree scoping
 * all work across it -- attached past the check that stops an author from
 * hosting a tree on an `<input>`. It is closed and unmarked as a declarative
 * or clonable root, so `element.shadowRoot` stays null, `attachShadow` on the
 * same element still throws the NotSupportedError the specification demands,
 * `cloneNode` copies nothing, and serialization never names it: the tree is
 * reachable only through {@link shadowRootOf} and the control that built it.
 */
function attachUAShadowRoot<T>(target: object): T {
	const host = target as Element;
	const shadow = constructInternal(() => new ShadowRoot());
	shadow[kDocument] = host[kDocument]!;
	shadow[kHost] = host;
	shadow[kShadowMode] = "closed";
	shadow[kUAInternal] = true;
	shadow[kRegistry] = globalCustomElements;
	host[kShadowRoot] = shadow;
	return shadow as T;
}

/**
 * Whether a node is a user-agent shadow root. The cascade asks: a rule from a
 * stylesheet of such a tree is a UA rule, which every author rule outranks
 * whatever its specificity.
 */
function isUAShadowRoot(node: object): boolean {
	return node instanceof ShadowRoot && node[kUAInternal]!;
}

/**
 * The shadow tree an element renders, closed ones included: a control's
 * user-agent tree, or the tree an author attached. The engine composes through
 * this; `Element.shadowRoot` is the author-facing view, which shows an open
 * tree and nothing else.
 */
export function shadowRootOf<T>(element: object): T | null {
	return ((element as Element)[kShadowRoot]! as T) ?? null;
}

/* ---------------------------------------------------------------------- slots */

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

/** A slottable's name: an element's slot attribute, and "" for text. */
function slottableName(slottable: Slottable): string {
	return slottable.nodeType === ELEMENT_NODE ?
			(slottable as Element)[kSlottableName]! :
		"";
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

/** The spec's "find a slot" algorithm. */
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
	const name = slottableName(slottable);
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

/** The spec's "find slottables" algorithm. */
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

/** The spec's "find flattened slottables" algorithm. */
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

/** The spec's "assign slottables" algorithm. */
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

/** The spec's "assign slottables for a tree" algorithm. */
function assignSlottablesForTree(root: Node): void {
	for (const node of inclusiveDescendants(root)) {
		if (node instanceof HTMLSlotElement) {
			assignSlottables(node);
		}
	}
}

/** The spec's "assign a slot" algorithm. */
function assignASlot(slottable: Slottable): void {
	const slot = findASlot(slottable);
	if (slot !== null) {
		assignSlottables(slot);
	}
}

/**
 * The slots whose assignment changed since the last microtask checkpoint.
 *
 * slotchange is signalled here rather than fired here: the spec fires it from
 * the same microtask that delivers mutation records, and after them, so a
 * script that observes both sees the records first.
 */
const signalSlots: HTMLSlotElement[] = [];

function signalASlotChange(slot: HTMLSlotElement): void {
	if (!signalSlots.includes(slot)) {
		signalSlots.push(slot);
	}
	queueMutationObserverMicrotask();
}

/** The attribute change steps that keep a slottable's name current. */
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

/** The attribute change steps that keep a slot's name current. */
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

/**
 * A slot: the place in a shadow tree where a host's children are rendered.
 *
 * Assignment is recomputed rather than incrementally patched, because every
 * input to it -- the host's children, their slot attributes, the slot names in
 * the tree -- can change from any of a dozen mutation entry points, and one
 * recomputation per changed tree is both the spec's shape and the only one
 * that cannot drift.
 */
export class HTMLSlotElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kSlotName] = "";
		this[kAssignedNodes] = [];
		this[kManualAssignment] = [];
	}

	[kSlotName]?: string;
	[kAssignedNodes]?: Slottable[];
	[kManualAssignment]?: Slottable[];

	get name(): string {
		return this.getAttribute("name") ?? "";
	}

	set name(value: string) {
		this.setAttribute("name", String(value));
	}

	assignedNodes(options?: {flatten?: boolean}): Node[] {
		const init = toDictionary<{flatten?: boolean}>(
			options ?? {},
			"An AssignedNodesOptions",
		);
		if (!init.flatten) {
			return [...this[kAssignedNodes]!];
		}
		return findFlattenedSlottables(this);
	}

	assignedElements(options?: {flatten?: boolean}): Element[] {
		return this.assignedNodes(options).filter(
			(node) => node.nodeType === ELEMENT_NODE,
		) as Element[];
	}

	/**
	 * The assignment is recomputed over every tree a slot in it lost or gained
	 * a node: the spec's own step covers this slot's tree, and a node taken
	 * from a slot in another shadow tree leaves that tree's assignment stale
	 * until its slots are recomputed too.
	 */
	assign(...nodes: Slottable[]): void {
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
			const slottable = node as Slottable;
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

Object.defineProperty(HTMLSlotElement.prototype, Symbol.toStringTag, {
	value: "HTMLSlotElement",
	configurable: true,
});

builtinRegistry.define(HTML_NAMESPACE, "slot", HTMLSlotElement);

const kTemplateContent = Symbol("template content");

/**
 * A template: an element whose children are parsed into a fragment beside it
 * rather than into the tree.
 *
 * The fragment is the shape a shadow tree is written in -- a declarative
 * shadow root is a template, and every test that builds one builds it from a
 * template's content -- so the element that owns that fragment belongs beside
 * the slot rather than a phase later. Its host is the template, which is what
 * stops a template from being appended into its own contents.
 */
const kTemplateDocument = Symbol("templateDocument");

/**
 * The appropriate template contents owner: an inert document of its own,
 * one per document, holding every template's content fragment -- which is
 * why a template's content answers a different ownerDocument than its
 * element. A contents owner owns its own templates' contents itself.
 */
function templateContentsOwnerOf(document: Document): Document {
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

export class HTMLTemplateElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kTemplateContent] = null;
	}

	[kTemplateContent]?: DocumentFragment | null;

	get content(): DocumentFragment {
		let content = this[kTemplateContent]!;
		if (content === null) {
			content = new DocumentFragment();
			content[kDocument] = templateContentsOwnerOf(this[kDocument]!);
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
		const mode = asciiLowercase(value);
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

Object.defineProperty(HTMLTemplateElement.prototype, Symbol.toStringTag, {
	value: "HTMLTemplateElement",
	configurable: true,
});

builtinRegistry.define(HTML_NAMESPACE, "template", HTMLTemplateElement);

/* ---------------------------------------------------- HTML element classes */

/** Parse a URL against a base, answering null where it is not one. */
function parseURL(value: string, base: string): string | null {
	try {
		return new URL(value, base).href;
	} catch (_err) {
		return null;
	}
}

/**
 * A document's base URL: the href of the first base element that has one,
 * resolved against the document's own URL, and the document's URL where there
 * is no such element or its href does not parse.
 */
function documentBaseURL(document: Document): string {
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

/** The rules for parsing integers, which stop at the first non-digit. */
function parseInteger(value: string): number | null {
	const match = /^[\t\n\f\r ]*([+-]?[0-9]+)/.exec(value);
	if (match === null) {
		return null;
	}
	const number = Number(match[1]);
	return Number.isSafeInteger(number) ? number : null;
}

/** The rules for parsing non-negative integers: a sign is not one. */
function parseNonNegativeInteger(value: string): number | null {
	const match = /^[\t\n\f\r ]*([0-9]+)/.exec(value);
	if (match === null) {
		return null;
	}
	const number = Number(match[1]);
	return Number.isSafeInteger(number) ? number : null;
}

/** The token lists an element hands back for its reflecting attributes. */
function reflectedTokenList(
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
		ensure(list);
		lists.set(property, list);
	}
	return list;
}

/**
 * Install one reflecting IDL attribute on an interface's prototype.
 *
 * Every setter writes through setAttribute, which is where the attribute
 * change steps, the mutation records and the custom element reactions already
 * are, so a reflected write is indistinguishable from the attribute write it
 * stands for.
 */
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
				return parseURL(trimmed, documentBaseURL(this[kDocument]!)) ?? trimmed;
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
				// An attribute whose empty string is one of its own keywords
				// answers with the state that keyword names.
				if (value === "" && spec.empty !== undefined) {
					return spec.empty;
				}
				const lowered = asciiLowercase(value);
				for (const candidate of keywords) {
					if (asciiLowercase(candidate) === lowered) {
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
				return reflectedTokenList(this, spec.property, attribute, supported);
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

/**
 * The interfaces the HTML Standard defines for the elements this DOM hosts.
 *
 * Each is declared here and filled in from the table: the reflecting members
 * come from `HTML_INTERFACES`, and the members that are not reflections are
 * written in the class body. A class with an empty body reflects and does
 * nothing else, which is all its interface is.
 */
export class HTMLAnchorElement extends HTMLElement {
	get text(): string {
		return descendantText(this);
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}
}
/** One part of a hyperlink's URL, read from it and written back through it. */
function hyperlinkPart(
	read: (url: URL) => string,
	write: (url: URL, value: string) => void,
	absent: string,
): PropertyDescriptor {
	return {
		get(this: Element): string {
			const url = hyperlinkURL(this);
			return url === null ? absent : read(url);
		},
		set(this: Element, value: string): void {
			writeHyperlink(this, (url) => write(url, String(value)));
		},
		enumerable: true,
		configurable: true,
	};
}
/**
 * The members a hyperlink carries: its URL, and the parts of that URL.
 *
 * A link's activation behavior is to follow it, and this DOM does not
 * navigate: the behavior is here so that dispatch counts a link as an
 * activation target, and following it is the one step that does not happen.
 */
const hyperlinkMembers: PropertyDescriptorMap = {
	href: {
		get(this: Element): string {
			const value = this.getAttribute("href");
			if (value === null) {
				return "";
			}
			const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
			return parseURL(trimmed, documentBaseURL(this[kDocument]!)) ?? trimmed;
		},
		set(this: Element, value: string): void {
			this.setAttribute("href", String(value));
		},
		enumerable: true,
		configurable: true,
	},
	origin: {
		get(this: Element): string {
			const url = hyperlinkURL(this);
			return url === null ? "" : url.origin;
		},
		enumerable: true,
		configurable: true,
	},
	protocol: hyperlinkPart(
		(url) => url.protocol,
		(url, value) => {
			url.protocol = value;
		},
		":",
	),
	username: hyperlinkPart(
		(url) => url.username,
		(url, value) => {
			url.username = value;
		},
		"",
	),
	password: hyperlinkPart(
		(url) => url.password,
		(url, value) => {
			url.password = value;
		},
		"",
	),
	host: hyperlinkPart(
		(url) => url.host,
		(url, value) => {
			url.host = value;
		},
		"",
	),
	hostname: hyperlinkPart(
		(url) => url.hostname,
		(url, value) => {
			url.hostname = value;
		},
		"",
	),
	port: hyperlinkPart(
		(url) => url.port,
		(url, value) => {
			url.port = value;
		},
		"",
	),
	pathname: hyperlinkPart(
		(url) => url.pathname,
		(url, value) => {
			url.pathname = value;
		},
		"",
	),
	search: hyperlinkPart(
		(url) => (url.search === "?" ? "" : url.search),
		(url, value) => {
			url.search = value;
		},
		"",
	),
	hash: hyperlinkPart(
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
			return parseURL(trimmed, documentBaseURL(this[kDocument]!)) ?? trimmed;
		},
		writable: true,
		enumerable: true,
		configurable: true,
	},
};
/** The URL a hyperlink's href names, or null where it names none. */
function hyperlinkURL(element: Element): URL | null {
	const value = element.getAttribute("href");
	if (value === null) {
		return null;
	}
	const trimmed = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
	try {
		return new URL(trimmed, documentBaseURL(element[kDocument]!));
	} catch (_err) {
		return null;
	}
}
/** Change one part of a hyperlink's URL and write the whole of it back. */
function writeHyperlink(element: Element, change: (url: URL) => void): void {
	const url = hyperlinkURL(element);
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

export class HTMLAreaElement extends HTMLElement {}
Object.defineProperties(HTMLAreaElement.prototype, hyperlinkMembers);

/**
 * The element a document's relative URLs are resolved against.
 *
 * Its own href is the odd one out: it resolves against the document's URL
 * rather than against the base, because it is the base.
 */
export class HTMLBaseElement extends HTMLElement {
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

export class HTMLBodyElement extends HTMLElement {}

export class HTMLBRElement extends HTMLElement {}

/** A button, whose activation submits or resets the form it belongs to. */
export class HTMLButtonElement extends HTMLElement {
	/** Installed from the element table, and read by the algorithms below. */
	declare type: string;

	get form(): HTMLFormElement | null {
		return formOwner(this);
	}

	get labels(): NodeList {
		return labelsOf(this);
	}

	/**
	 * The popover this button invokes, which the attribute names by id or an
	 * author hands over as an element.
	 */
	get popoverTargetElement(): Element | null {
		return popoverTargetAttributeElement(this);
	}

	set popoverTargetElement(value: Element | null) {
		setPopoverTargetAttributeElement(this, value);
	}
}

/**
 * A canvas.
 *
 * The element exists with the dimensions it reflects; a rendering context is
 * a bitmap, and there is none, so getContext answers null exactly as it does
 * for a context type an implementation does not support.
 */
export class HTMLCanvasElement extends HTMLElement {
	getContext(contextId: string): null {
		if (arguments.length < 1) {
			throw new TypeError("getContext needs a context id");
		}
		void contextId;
		return null;
	}
}

export class HTMLDataElement extends HTMLElement {}

const kOptions = Symbol("options");

/** A list of suggestions, whose options an input reaches through it. */
export class HTMLDataListElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kOptions] = null;
	}

	declare [kOptions]?: HTMLCollection | null;

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

const kEngine = Symbol("engine");
/**
 * A disclosure, whose open attribute is its whole state.
 *
 * The toggle event is queued rather than fired where the attribute changes,
 * so a run of changes inside one turn reports the state it settled on.
 *
 * It renders a closed shadow tree it owns, as the form controls do: a slot
 * the first summary child projects through, and a content container
 * (part=details-content) whose slot takes every other child -- text nodes
 * included, which no light-tree selector could reach. Hiding a closed
 * details' body is then one display flip on that container.
 */
export class HTMLDetailsElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kToggleQueued] = false;
		this[kStateAtQueue] = "closed";
		this[kEngine] = null;
		this[kContent] = null;
	}

	declare [kToggleQueued]?: boolean;
	declare [kStateAtQueue]?: string;

	declare [kEngine]?: UAEngine | null;
	declare [kContent]?: UAElement | null;

	[kUAUpgrade]?(): void {
		if (this[kEngine] !== null) {
			this[kUAReconcile]!();
			return;
		}
		const engine = uaEngineOf(this);
		if (engine === undefined) {
			return;
		}
		this[kEngine] = engine;
		const document = uaDocumentOf(this);
		const root = buildUARoot(this, engine, DETAILS_UA_STYLES);
		const shadow = root as unknown as ShadowRoot;
		const summarySlot = document.createElement("slot");
		const content = document.createElement("div");
		content.setAttribute("part", "details-content");
		content.appendChild(document.createElement("slot"));
		// The distribution must be in place before the slots enter the tree:
		// inserting each one runs the assignment pass that fills it.
		shadow[kSlotAssignment] = "manual";
		shadow[kUASlotting] = (slot) =>
			detailsSlottables(this, slot === summarySlot);
		root.appendChild(summarySlot);
		root.appendChild(content);
		this[kContent] = content;
		this[kUAReconcile]!();
	}

	/** Show or hide the content container from the `open` attribute. */
	[kUAReconcile]?(): void {
		const content = this[kContent]!;
		if (content === null) {
			return;
		}
		const display = this.hasAttribute("open") ? "block" : "none";
		if (content.style.display !== display) {
			content.style.display = display;
		}
	}

	override [kAttributeChanged]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChanged]!(localName, oldValue, value, namespace);
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

/**
 * The light children a details' UA slots project: the first summary element
 * child to the summary slot, every other slottable child to the content
 * slot. Recomputed from the child list on each assignment pass, which the
 * tree mutation algorithms run on every insertion and removal.
 */
function detailsSlottables(
	host: HTMLDetailsElement,
	toSummary: boolean,
): Slottable[] {
	const summary = firstChildElement(host, "summary");
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
/** The event a details or a popover fires when it opens or closes. */
export class ToggleEvent extends Event {
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

	/** The element whose activation opened or closed the popover, if any. */
	get source(): Element | null {
		return this[kSource]!;
	}
}
Object.defineProperty(ToggleEvent.prototype, Symbol.toStringTag, {
	value: "ToggleEvent",
	configurable: true,
});

const kPreviouslyFocused = Symbol("previouslyFocused");
/**
 * A dialog.
 *
 * Showing one modally puts it in the document's top layer, above every
 * stacking context and outside the flow it was written in, and makes the rest
 * of the document unreachable until it closes; showing one with `show()`
 * leaves it exactly where it is, an ordinary box that happens to be visible.
 */
export class HTMLDialogElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kReturnValue] = "";
		this[kPreviouslyFocused] = null;
	}

	declare [kReturnValue]?: string;
	// Where focus was when the dialog took it, so closing can give it back.
	declare [kPreviouslyFocused]?: Element | null;

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
		// The top layer is the modality: everything else -- `:modal`, the
		// backdrop, the hit-testing that stops clicks reaching the page --
		// reads membership rather than a flag of its own.
		topLayerOf(this[kDocument]!).add(this);
		this.setAttribute("open", "");
		focusDialog(this);
	}

	/**
	 * A modal dialog taken out of the document leaves the top layer with it:
	 * nothing off the tree can render above it, and a detached dialog is no
	 * longer modal.
	 */
	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		topLayerOf(this[kDocument]!).delete(this);
	}

	close(returnValue?: string): void {
		close(this, returnValue, false);
	}

	requestClose(returnValue?: string): void {
		if (!this.hasAttribute("open")) {
			return;
		}
		const canceled = !dispatch(this, new Event("cancel", {cancelable: true}));
		if (canceled) {
			return;
		}
		close(this, returnValue, false);
	}
}

/**
 * The dialog focusing steps, as the popover focusing steps reach them: a
 * dialog shown as a popover focuses like a dialog, not like a popover.
 */
function dialogFocusingSteps(
	dialog: HTMLDialogElement,
): void {
	focusDialog(dialog);
}

/**
 * HTML's dialog focusing steps: focus goes to the descendant asking for it
 * with `autofocus`, else to the first one that can take focus, else to the
 * dialog itself -- which is focusable for exactly as long as it is the
 * modal one, so a dialog of plain text still takes keys off the page.
 */
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

function close(
	dialog: HTMLDialogElement,
	returnValue: string | undefined,
	_fromRequest: boolean,
): void {
	if (!dialog.hasAttribute("open")) {
		return;
	}
	const document = dialog[kDocument]!;
	const wasModal = isModalDialog(dialog);
	dialog.removeAttribute("open");
	topLayerOf(document).delete(dialog);
	// The page gets its focus back where the dialog took it from -- when the
	// dialog holds focus, or held the whole page inert as the modal one.
	const previous = dialog[kPreviouslyFocused]!;
	dialog[kPreviouslyFocused] = null;
	const active = document[kActiveElement]!;
	const heldFocus =
		active !== null && isShadowIncludingInclusiveAncestor(dialog, active);
	if (previous !== null && (wasModal || heldFocus)) {
		(previous as HTMLElement).focus();
	}
	// focus() refuses a target that left the tree or stopped being
	// focusable; focus still in the closed dialog falls back to the body.
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
 * A document's TOP LAYER: the elements that render above every stacking
 * context of the document, in the order they entered it. Membership is what
 * `showModal` grants and `close` revokes, and what the renderer paints last.
 */
function topLayerOf(document: object): Set<Element> {
	return (document as Document)[kTopLayer]!;
}
/**
 * Whether an element is showing modally -- the state `:modal` matches. A
 * dialog is modal exactly while it is in its document's top layer: `show()`
 * never puts one there and `close()` takes it out, so there is no second
 * flag to keep in step with the first.
 */
function isModalDialog(node: object): boolean {
	return (
		node instanceof HTMLDialogElement &&
		topLayerOf(node[kDocument]!).has(node as Element)
	);
}
/** Whether a node's root is a document, which is what connected means. */
function isConnectedNode(node: Node): boolean {
	return shadowIncludingRoot(node).nodeType === DOCUMENT_NODE;
}

export class HTMLDirectoryElement extends HTMLElement {}

export class HTMLDivElement extends HTMLElement {}

export class HTMLDListElement extends HTMLElement {}

/** An embedded resource, which never loads, so it has no SVG document. */
export class HTMLEmbedElement extends HTMLElement {
	getSVGDocument(): null {
		return null;
	}
}

const kElements = Symbol("elements");

/** A group of controls, and the group's own disabling. */
export class HTMLFieldSetElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kElements] = null;
	}

	declare [kElements]?: HTMLCollection | null;

	get form(): HTMLFormElement | null {
		return formOwner(this);
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

export class HTMLFontElement extends HTMLElement {}

const kFiringReset = Symbol("firingReset");

/**
 * A form, and the controls it owns.
 *
 * Submission navigates, and this DOM does not navigate: `submit()` runs the
 * steps up to the navigation and stops, `requestSubmit()` fires the submit
 * event those steps fire first, and `reset()` fires its event and restores
 * every control it owns to its default.
 */
export class HTMLFormElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kElements] = null;
		this[kFiringReset] = false;
	}

	declare [kElements]?: HTMLFormControlsCollection | null;
	declare [kFiringReset]?: boolean;

	get elements(): HTMLFormControlsCollection {
		let elements = this[kElements]!;
		if (elements === null) {
			elements = new HTMLFormControlsCollection(
				() => listedControls(this),
				this,
			);
			this[kElements] = elements;
		}
		return elements;
	}

	get length(): number {
		return this.elements.length;
	}

	submit(): void {
		submitForm(this, null, true);
	}

	requestSubmit(submitter: Element | null = null): void {
		if (submitter !== null && submitter !== undefined) {
			if (!(submitter instanceof Element) || !isSubmitButton(submitter)) {
				throw new TypeError("That element is not a submit button");
			}
			if (formOwner(submitter) !== this) {
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
		for (const control of listedControls(this)) {
			resetControl(control);
		}
	}
}
/** The listed controls a form owns, in tree order. */
function listedControls(form: HTMLFormElement): Element[] {
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
		if (formOwner(element) !== form) {
			continue;
		}
		if (element instanceof HTMLInputElement && element.type === "image") {
			continue;
		}
		controls.push(element);
	}
	return controls;
}
/** Whether an element is a button that submits its form. */
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
/**
 * Submit a form.
 *
 * Everything up to the navigation runs: the submit event fires unless the
 * caller was `submit()`, which the specification defines as skipping it. The
 * navigation itself is the one step this DOM does not have.
 */
function submitForm(
	form: HTMLFormElement,
	submitter: Element | null,
	skipEvent: boolean,
): void {
	// A form that cannot navigate does not submit, and a form outside a
	// document cannot: submission ends in a navigation, and there is nothing
	// there to navigate. The submit event does not fire either.
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
/** Put a control back to the value its attributes name. */
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
/** The event a form fires before it is submitted, naming the button. */
export class SubmitEvent extends Event {
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

/**
 * The controls of a form, which answers a name with every control that has
 * it: one element, or a list of the radio buttons that share it.
 */
export class HTMLFormControlsCollection extends HTMLCollection {
	declare [kOwner]?: Node | null;

	constructor(compute: () => Element[], owner: Node | null = null) {
		// The form attribute associates a control with a form anywhere in the
		// tree, and what a control is depends on what it carries, so the list
		// is over the whole document and any attribute is an input to it.
		super(compute, owner, null, anyAttribute, true);
		this[kOwner] = owner;
	}

	override namedItem(name: string): Element | null {
		const key = String(name);
		if (key === "") {
			return null;
		}
		const matches = matching(this, key);
		if (matches.length === 0) {
			return null;
		}
		if (matches.length === 1) {
			return matches[0] as Element;
		}
		// The list is what the interface answers with for a shared name; the
		// declared type is the collection's, which has no way to say so.
		return new RadioNodeList(
			() => matching(this, key),
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
				list.length === 1 ?
					list[0] :
						(new RadioNodeList(
							() => matching(this, key),
							this[kOwner]!,
						) as unknown as Node),
			);
		}
		return named;
	}
}

function matching(
	collection: HTMLFormControlsCollection,
	key: string,
): Node[] {
	const matches: Node[] = [];
	for (const item of ensure(collection)) {
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
Object.defineProperty(
	HTMLFormControlsCollection.prototype,
	Symbol.toStringTag,
	{value: "HTMLFormControlsCollection", configurable: true},
);
/** The radio buttons that share a name, and the value the checked one has. */
export class RadioNodeList extends NodeList {
	constructor(compute: () => Node[], owner: Node | null = null) {
		super(compute, true, owner, null, anyAttribute, true);
	}

	get value(): string {
		for (const node of ensure(this)) {
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
		for (const node of ensure(this)) {
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

/** A frame, which names no browsing context here either. */
export class HTMLFrameElement extends HTMLElement {
	get contentDocument(): null {
		return null;
	}

	get contentWindow(): null {
		return null;
	}
}

export class HTMLFrameSetElement extends HTMLElement {}

export class HTMLHeadElement extends HTMLElement {}

export class HTMLHeadingElement extends HTMLElement {}

export class HTMLHRElement extends HTMLElement {}

export class HTMLHtmlElement extends HTMLElement {}

const kContentDocument = Symbol("contentDocument");
const kContentWindow = Symbol("contentWindow");
const kFrameDocumentRun = Symbol("frameDocumentRun");

/** What an iframe's window exposes: the document's side of the frame. */
interface FrameWindowLike {
	document: Document;
	customElements: CustomElementRegistry;
	frameElement: HTMLIFrameElement;
	HTMLElement: typeof HTMLElement;
}

/**
 * A nested document without a browsing context around it. On insertion the
 * iframe gets a content document -- its srcdoc parsed, or about:blank --
 * with a registry of its own, and fires load; removal discards it, as
 * removal discards a browsing context. The src attribute stays inert: this
 * engine performs no fetches, so a src iframe holds about:blank, the same
 * document a browser shows before any navigation. There is no second
 * realm: the frame's constructors are this realm's own.
 */
export class HTMLIFrameElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kContentDocument] = null;
		this[kContentWindow] = null;
		this[kFrameDocumentRun] = {};
	}

	declare [kContentDocument]?: Document | null;
	declare [kContentWindow]?: FrameWindowLike | null;
	// The stretch of connectedness the current content document belongs to. A
	// removal, and each insertion, starts another one, so the load task fires
	// only for the insertion that scheduled it.
	declare [kFrameDocumentRun]?: object;

	override [kInsertionSteps]?(): void {
		super[kInsertionSteps]!();
		if (!this.isConnected) {
			return;
		}
		// The document itself is built lazily on first access: building it
		// here would re-enter the parser while a parse that contains this
		// iframe is still running. The load fires from a task, after the
		// insertion has finished and its listeners are attached.
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

/**
 * An image.
 *
 * Nothing is fetched here, so the image data is never available: the natural
 * dimensions are zero, the current source is empty, and decoding rejects.
 * The width and height an author reads are the attributes, which is what the
 * specification answers with for an image that is not being rendered.
 */
export class HTMLImageElement extends HTMLElement {
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

	decode(): Promise<void> {
		return Promise.reject(
			domError("EncodingError", "There is no image data to decode"),
		);
	}
}

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

/**
 * A form control whose kind its type attribute names.
 *
 * The value model is the specification's: an attribute holds the default, a
 * separate value holds what was written, and a dirty flag says which of the
 * two the control answers with. Checkedness works the same way beside it.
 *
 * What it RENDERS is a closed shadow tree it owns: a value part and a
 * placeholder part for a text-ish input, a single glyph part for a checkbox or
 * a radio. The tree is derived -- the value above is the only state -- and the
 * editing keys are the control's own default action, a keydown listener like a
 * browser's editing internals.
 */
export class HTMLInputElement extends HTMLElement {
	/** Installed from the element table, and read by the algorithms below. */
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
		this[kEngine] = null;
		this[kKind] = null;
		this[kRoot] = null;
		this[kValueText] = null;
		this[kPlaceholderText] = null;
		this[kGlyphText] = null;
		this[kOnBeforeInput] = (event: InputEvent): void => {
			if (event.defaultPrevented || event.data == null) {
				return;
			}
			if (kindFor(this) !== "field") {
				return;
			}
			if (event.inputType === "insertText") {
				event.preventDefault();
				insertFieldText(this, event.data);
				return;
			}
			if (event.inputType !== "insertFromPaste") {
				return;
			}
			event.preventDefault();
			insertFieldText(this, event.data.replace(/[\r\n]+/g, ""));
		};
		this[kOnKeydown] = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) {
				return;
			}
			const {key, shiftKey, ctrlKey} = event;

			if (this.type === "checkbox" || this.type === "radio") {
			// Either key activates the control, and activation is what toggles it:
			// the pre-activation behavior flips the checkedness, the activation
			// behavior fires input then change, and a canceled click puts the
			// checkedness back.
			//
			// Enter toggles here where a browser leaves it dead. In a browser
			// Enter on a checkbox submits the form the control belongs to, and
			// does nothing at all outside one; a terminal has no implicit
			// submission to inherit, so the key would simply be inert on a focused
			// control. It toggles, for the same reason the readline chords edit.
				if (key === " " || key === "Enter") {
					this.click();
				}
				return;
			}

			// ArrowUp and ArrowDown step a number input, standing in for
			// the up/down buttons a browser draws on one -- a terminal has
			// none, and every hand is already on the keyboard. Stepping is
			// a user edit, so it fires input and then change, as pressing
			// those buttons does.
			if (
				this.type === "number" &&
				(key === "ArrowUp" || key === "ArrowDown")
			) {
				const stepped = steppedValue(this, key === "ArrowUp" ? 1 : -1);
				if (stepped !== null) {
					applyFieldEdit(this, collapsedEdit(stepped, stepped.length));
					dispatch(this, new Event("change", {bubbles: true}));
				}
				return;
			}

			const value = this[kUAValue]!;
			const {start, end, direction} = uaSelectionOf(this);
			const anchor = direction === "backward" ? end : start;
			const caret = direction === "backward" ? start : end;

			let result: FieldEditResult | null;
			if (key === "Home" || (ctrlKey && key === "a")) {
				result = fieldSelectionMove(value, anchor, 0, shiftKey);
			} else if (key === "End" || (ctrlKey && key === "e")) {
				result = fieldSelectionMove(value, anchor, value.length, shiftKey);
			} else if (ctrlKey && key === "k") {
				result = collapsedEdit(value.slice(0, caret), caret);
			} else if (ctrlKey && key === "u") {
				result = collapsedEdit(value.slice(caret), 0);
			} else {
				result = applySharedFieldEdit(this, key, shiftKey, ctrlKey);
			}
			if (result) {
				applyFieldEdit(this, result);
			}
		};
	}

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

	// The rendered tree and what it was built for. "field" for a text-ish
	// input, "toggle" for checkbox/radio; null until built. The two are
	// different trees, so a type flip rebuilds.
	declare [kEngine]?: UAEngine | null;
	declare [kKind]?: "field" | "toggle" | null;
	declare [kRoot]?: UARoot | null;
	declare [kValueText]?: UAText | null;
	declare [kPlaceholderText]?: UAText | null;
	declare [kGlyphText]?: UAText | null;

	get form(): HTMLFormElement | null {
		return formOwner(this);
	}

	get labels(): NodeList {
		return this.type === "hidden" ? createStaticNodeList([]) : labelsOf(this);
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
		switch (inputValueMode(this.type)) {
			case "value":
				// A number input mid-edit holds text on its way to being a
				// number -- "4.", "4e-" -- which the control keeps and renders;
				// the IDL attribute reports the empty string until the text
				// arrives at a number, as a browser's does.
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
		switch (inputValueMode(this.type)) {
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
		widgetChanged(this);
	}

	/**
	 * The value as the number it parses to: NaN when it does not, and only
	 * the numeric types answer. Assigning NaN empties the field; assigning
	 * a non-finite number is the TypeError the spec makes it.
	 */
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

	/**
	 * The spec's step methods: move along the step grid without events, the
	 * programmatic siblings of the arrow keys. A step of "any" names no grid
	 * to move on, which is the InvalidStateError the spec makes it.
	 */
	stepUp(n = 1): void {
		stepInputBy(this, Math.trunc(Number(n)));
	}

	stepDown(n = 1): void {
		stepInputBy(this, -Math.trunc(Number(n)));
	}

	/**
	 * The control's value itself, which is what the widget below renders and
	 * edits through. The IDL attribute above it answers with an attribute for
	 * the types that have no value of their own; those types render no field,
	 * so their value here is the empty string a caret would sit in.
	 */
	get [kUAValue](): string {
		return inputValueMode(this.type) === "value" ? this[kValue]! : "";
	}

	/**
	 * Set the value from a user edit: the value changes and the dirty value
	 * flag is set, and nothing else -- the selection is the edit's to place,
	 * where the IDL setter would collapse it to the end. A control with no
	 * value of its own (a file input's filename list) has nothing a keystroke
	 * can write, as in a browser, where its UI accepts no typing at all.
	 */
	[kSetUAValue]?(value: string): void {
		if (inputValueMode(this.type) !== "value") {
			return;
		}
		// A user edit passes through the states a number passes through on
		// its way to being one -- "4.", "4e-" -- which full sanitization
		// would empty on every keystroke. The edit keeps its text (the
		// insertion filter has already limited the characters); the value
		// getter is what reports the empty string until the text is a
		// number. Programmatic writes keep the full sanitization.
		this[kValue] = this.type === "number" ?
				value.replace(/[\r\n]/g, "") :
				sanitizeInputValue(this, value);
		this[kDirtyValue] = true;
		widgetChanged(this);
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

	/**
	 * The selection every input carries, whatever its type says.
	 *
	 * The selection APIs answer for the five types the HTML Standard lists,
	 * and throw for the rest -- but the caret in an email or a number field is
	 * real, and the widget behind the control edits through it. This is that
	 * door: the same algorithm, without the type gate an author meets.
	 */
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
		widgetChanged(this);
		scheduleTextSelectionChange(this);
	}

	override [kAttributeChanged]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChanged]!(localName, oldValue, value, namespace);
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
		widgetChanged(this);
	}

	/**
	 * The popover this input invokes when it is one of the types that render
	 * as a button, which the attribute names by id or an author hands over as
	 * an element.
	 */
	get popoverTargetElement(): Element | null {
		return popoverTargetAttributeElement(this);
	}

	set popoverTargetElement(value: Element | null) {
		setPopoverTargetAttributeElement(this, value);
	}

	/* --------------------------------------------------- the rendered tree */

	get [kUAValueText](): UAText | null {
		return this[kValueText]!;
	}

	[kUASelectionRange]?(): UARange | null {
		return textSelectionRange(this, this[kValueText]!);
	}

	[kUAUpgrade]?(): void {
		if (this[kEngine] !== null) {
			// A control that left the tree and came back keeps its tree; only the
			// state it drifted from needs catching up.
			this[kUAReconcile]!();
			return;
		}
		const engine = uaEngineOf(this);
		if (engine === undefined) {
			return;
		}
		this[kEngine] = engine;
		build(this);
		// Editing is the control's own default action, like a browser input's --
		// a keydown listener; typed characters and pastes arrive as beforeinput,
		// which is the default action of the keypress and of the paste that
		// produced them.
		this.addEventListener("keydown", this[kOnKeydown]! as UAListener);
		this.addEventListener("beforeinput", this[kOnBeforeInput]! as UAListener);
	}

	/**
	 * A typed character arrives as an insertText; a paste as an
	 * insertFromPaste, whose line breaks a single-line input strips (HTML
	 * value sanitization). A toggle takes neither: it holds no text.
	 */
	declare [kOnBeforeInput]?: (event: InputEvent) => void;

	/**
	 * Bring the field tree back into step with the input's own
	 * value/placeholder -- the rendered content model a width:auto input
	 * measures against. The value text paints through the normal walk; the
	 * placeholder shows only when the value is empty. A toggle's glyph says
	 * whether it is checked, which is state like any other: it is written here,
	 * where the state moves, so the frame that shows it is scheduled by the
	 * same mutation every other change is.
	 */
	[kUAReconcile]?(): void {
		if (this[kEngine] === null) {
			return;
		}
		// A type flip is a different tree, not a different value.
		if (kindFor(this) !== this[kKind]!) {
			build(this);
			return;
		}
		if (this[kKind] !== "field") {
			if (this[kGlyphText]!) {
				const mark =
					this.type === "checkbox" ?
						this.checked ?
							"[x]" :
							"[ ]" :
						this.checked ?
							"(x)" :
							"( )";
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
		// A password puts one bullet per code unit into the shadow, never the
		// real value -- so what lays out, paints, and can be selected is only the
		// mask; the value stays in .value alone. Offsets stay 1:1 with .value on
		// the BMP, keeping caret and scroll window aligned.
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
		// Exactly one occupies the slot: value when present, else placeholder.
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
		// A width:auto input sizes to its composed content; nothing else
		// invalidates the measure, and the observer would only hear it on a
		// microtask.
		if (changed) {
			this[kEngine]!.layout.invalidate(this);
		}
	}

	/**
	 * The input's editing default action: a checkbox/radio activates on Space
	 * or Enter (never accepting typed text), Home/End go to the whole value's
	 * ends (an input has no visual lines), everything else is the shared field
	 * logic.
	 */
	declare [kOnKeydown]?: (event: KeyboardEvent) => void;
}

/**
 * A checkbox and a radio button change before the click is dispatched, so
 * a listener sees the new state, and change back if the click is canceled.
 */
function legacyPreActivationBehavior(
	input: HTMLInputElement,
): void {
	// The reference the canceled half puts back is this click's, so a run
	// that takes none leaves none behind.
	input[kPreviousRadio] = null;
	if (input.type === "checkbox") {
		input[kPreviouslyChecked] = input[kChecked]!;
		input[kPreviouslyIndeterminate] = input[kIndeterminate]!;
		input[kIndeterminate] = false;
		input[kDirtyChecked] = true;
		setCheckedness(input, !input[kChecked]!);
	} else if (input.type === "radio") {
		input[kPreviousRadio] = checkedRadioIn(input) ?? null;
		input[kDirtyChecked] = true;
		setCheckedness(input, true);
	}
}

/**
 * Put back what the pre-activation behavior changed.
 *
 * The type is read again here rather than remembered: a listener may have
 * changed it during the click, and the state to restore is the state the
 * type it has now keeps. A radio button's reference is this click's and is
 * honored only while the button it names is still in the group this
 * element has now.
 */
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
	if (previous !== null && radioGroupOf(input).includes(previous)) {
		previous[kChecked] = true;
	}
}

/** Set checkedness, unchecking the rest of a radio button's group. */
function setCheckedness(
	input: HTMLInputElement,
	checked: boolean,
): void {
	input[kChecked] = checked;
	widgetChanged(input);
	if (!checked || input.type !== "radio") {
		return;
	}
	for (const other of radioGroupOf(input)) {
		if (other !== input) {
			other[kChecked] = false;
			widgetChanged(other);
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

/** field for a text-ish input, toggle for checkbox/radio. */
function kindFor(
	input: HTMLInputElement,
): "field" | "toggle" {
	const type = input.type;
	return type === "checkbox" || type === "radio" ? "toggle" : "field";
}

/**
 * Build (or rebuild, on a type flip) the UA-internal shadow tree. The
 * field tree carries value / placeholder parts; the toggle tree a single
 * glyph part the painter fills from live `.checked` (a radio's group
 * exclusivity unchecks siblings with no hook to reconcile on).
 */
function build(
	input: HTMLInputElement,
): void {
	const engine = input[kEngine]!;
	let root = input[kRoot]!;
	if (root === null) {
		root = buildUARoot(input, engine, FIELD_UA_STYLES);
	} else {
		// A rebuild keeps the root -- and its enrollment -- and replaces only
		// what hangs under it, the stylesheet included.
		while (root.firstChild) {
			root.removeChild(root.firstChild);
		}
		engine.invalidateStructure();
		root.appendChild(uaStyleElement(input, FIELD_UA_STYLES));
	}
	input[kRoot] = root;
	input[kKind] = kindFor(input);

	if (input[kKind] === "field") {
		input[kValueText] = addPart(root, "value").firstChild as UAText;
		input[kPlaceholderText] = addPart(
			root,
			"placeholder",
		).firstChild as UAText;
	} else {
		input[kValueText] = null;
		input[kPlaceholderText] = null;
		input[kGlyphText] = addPart(root, "glyph").firstChild as UAText;
	}
	engine.layout.invalidate(input);
	input[kUAReconcile]!();
}
/** How an input's type reads and writes its value. */
function inputValueMode(type: string): "value" | "default" | "on" | "filename" {
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
/** The types whose value a caller can select a range of. */
const SELECTABLE_INPUT_TYPES = new Set([
	"text",
	"search",
	"url",
	"tel",
	"password",
]);
const VALID_DATE = /^[0-9]{4,}-[0-9]{2}-[0-9]{2}$/;
const VALID_MONTH = /^[0-9]{4,}-[0-9]{2}$/;
const VALID_WEEK = /^[0-9]{4,}-W[0-9]{2}$/;
const VALID_TIME = /^[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?$/;
const VALID_DATETIME_LOCAL =
	/^[0-9]{4,}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?$/;
const VALID_FLOAT = /^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const VALID_SIMPLE_COLOR = /^#[0-9a-fA-F]{6}$/;
/** A floating-point number as the value space of the numeric types reads it. */
function parseFloatingPoint(value: string): number | null {
	if (!VALID_FLOAT.test(value)) {
		return null;
	}
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * Whether `value` is a prefix of a valid floating-point number: the states a
 * number input's text passes through on the way to one -- "-", "4.", "1e-"
 * among them. Every state of the grammar either accepts already or accepts
 * after one more digit, so the prefix test is the grammar itself, twice,
 * rather than a second grammar that could drift from it.
 */
function isFloatPrefix(value: string): boolean {
	return VALID_FLOAT.test(value) || VALID_FLOAT.test(value + "0");
}

/**
 * The decimal places a float literal spells, which is what toFixed needs to
 * write a step-grid value without binary dust: stepping 0.1 at a time must
 * produce "0.3", never "0.30000000000000004". An exponent literal names no
 * place count and answers zero.
 */
function decimalPlacesOf(text: string | null | undefined): number {
	if (!text) {
		return 0;
	}
	const match = /^-?[0-9]*(?:\.([0-9]+))?$/.exec(text.trim());
	if (!match || match[1] === undefined) {
		return 0;
	}
	return match[1].length;
}

/** stepUp/stepDown: validate, step, and assign without firing events. */
function stepInputBy(input: HTMLInputElement, steps: number): void {
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
	const stepped = steppedValue(input, steps);
	if (stepped !== null) {
		input.value = stepped;
	}
}

/**
 * The value a number input steps to: `steps` grid points away, on the grid
 * `step` spaces and `min` anchors (zero anchors it when there is no min),
 * clamped to [min, max]. A value between grid points moves to the nearest
 * point in the direction of travel. Null when there is nowhere to go, so a
 * caller can leave the field untouched. An out-of-range value steps to the
 * nearest bound whichever way it was pushed, which is how a browser's
 * up/down buttons pull a field into range.
 */
function steppedValue(input: HTMLInputElement, steps: number): string | null {
	const stepAttribute = input.getAttribute("step")?.trim();
	const step =
		stepAttribute === undefined || /^any$/i.test(stepAttribute) ?
			1 :
				(parseFloatingPoint(stepAttribute) ?? 1);
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
		decimalPlacesOf(stepAttribute),
		decimalPlacesOf(input.getAttribute("min")),
		decimalPlacesOf(input[kUAValue]!),
	);
	return String(Number(next.toFixed(Math.min(places, 20))));
}
/**
 * The value an input stores for what was written to it.
 *
 * Each type names one sanitization algorithm, and every one of them is here:
 * a value that the type cannot hold becomes the empty string, or the nearest
 * value the type can hold.
 */
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
			return VALID_DATETIME_LOCAL.test(value) ?
					value.replace(" ", "T").replace(/(:[0-9]{2})\.?0*$/, "$1") :
				"";
		case "number":
			return parseFloatingPoint(value) === null ? "" : value;
		case "range":
			return String(clampRangeValue(input, value));
		case "color":
			return VALID_SIMPLE_COLOR.test(value) ? asciiLowercase(value) : "#000000";
		default:
			return value;
	}
}
/** A range's value: the number it names, pulled inside the range it allows. */
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
/** The radio buttons an input shares a group with: its name, form and tree. */
function radioGroupOf(input: HTMLInputElement): HTMLInputElement[] {
	const name = input.getAttribute("name");
	if (name === null || name === "") {
		return [input];
	}
	const owner = formOwner(input);
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
		if (formOwner(node) !== owner) {
			continue;
		}
		group.push(node);
	}
	return group;
}
/** The radio button of a group that is checked, if one is. */
function checkedRadioIn(input: HTMLInputElement): HTMLInputElement | undefined {
	return radioGroupOf(input).find((radio) => radio.checked);
}

/** A label, and the control its click reaches. */
export class HTMLLabelElement extends HTMLElement {
	get form(): HTMLFormElement | null {
		const control = this.control;
		return control === null ? null : formOwner(control);
	}

	/**
	 * The control this label labels: the one its `for` attribute names, or the
	 * first labelable element among its descendants.
	 */
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

/** The caption of a fieldset, which names the form the fieldset belongs to. */
export class HTMLLegendElement extends HTMLElement {
	get form(): HTMLFormElement | null {
		const parent = this[kParent]!;
		if (parent === null || !(parent instanceof HTMLFieldSetElement)) {
			return null;
		}
		return formOwner(parent);
	}
}

export class HTMLLIElement extends HTMLElement {}

/** A link to a resource, which is never fetched, so it never has a sheet. */
export class HTMLLinkElement extends HTMLElement {
	get sheet(): null {
		return null;
	}
}

const kAreas = Symbol("areas");

/** An image map, and the areas inside it. */
export class HTMLMapElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kAreas] = null;
	}

	declare [kAreas]?: HTMLCollection | null;

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

/** A marquee, whose scrolling is a rendering the tree does not do. */
export class HTMLMarqueeElement extends HTMLElement {
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
/**
 * A media element.
 *
 * No resource is ever fetched, so the element stays in the state a media
 * element is in before one is: no network activity, nothing loaded, paused,
 * and a duration that is not a number. The members that answer with a
 * resource's own objects -- its buffered ranges, its tracks, its error --
 * are absent rather than answering with an empty stand-in.
 */
export class HTMLMediaElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kVolume] = 1;
		this[kMuted] = false;
		this[kPlaybackRate] = 1;
		this[kDefaultPlaybackRate] = 1;
		this[kPreservesPitch] = true;
		this[kCurrentTime] = 0;
	}

	declare [kVolume]?: number;
	declare [kMuted]?: boolean;
	declare [kPlaybackRate]?: number;
	declare [kDefaultPlaybackRate]?: number;
	declare [kPreservesPitch]?: boolean;
	declare [kCurrentTime]?: number;

	static readonly NETWORK_EMPTY = NETWORK_EMPTY;
	static readonly NETWORK_IDLE = NETWORK_IDLE;
	static readonly NETWORK_LOADING = NETWORK_LOADING;
	static readonly NETWORK_NO_SOURCE = NETWORK_NO_SOURCE;
	static readonly HAVE_NOTHING = HAVE_NOTHING;
	static readonly HAVE_METADATA = HAVE_METADATA;
	static readonly HAVE_CURRENT_DATA = HAVE_CURRENT_DATA;
	static readonly HAVE_FUTURE_DATA = HAVE_FUTURE_DATA;
	static readonly HAVE_ENOUGH_DATA = HAVE_ENOUGH_DATA;

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
export class HTMLAudioElement extends HTMLMediaElement {}
/** A video, whose intrinsic dimensions are zero until one is decoded. */
export class HTMLVideoElement extends HTMLMediaElement {
	get videoWidth(): number {
		return 0;
	}

	get videoHeight(): number {
		return 0;
	}
}

export class HTMLMenuElement extends HTMLElement {}

export class HTMLMetaElement extends HTMLElement {}

/* ------------------------------------------------------------ the gauges */

/**
 * The glyphs a gauge is drawn in: a run of full blocks for the filled bar, a
 * run of light shade for the groove behind it. Both are ordinary text in the
 * shadow tree, clipped to the fraction CSS gives the bar.
 */
const GAUGE_BAR_GLYPH = "█";

const GAUGE_GROOVE_GLYPH = "░";

/**
 * The glyph run a gauge's parts are drawn from, long enough that no bar on
 * this screen can outrun it.
 */
function gaugeRun(host: Element, glyph: string): string {
	const view = (host.ownerDocument as {defaultView?: {innerWidth?: number}})
		?.defaultView;
	const width = view?.innerWidth;
	return glyph.repeat(
		Math.max(40, typeof width === "number" && width > 0 ? width : 40),
	);
}

/**
 * Build a gauge's closed shadow tree: a full-width track that clips, holding a
 * bar whose width is the fraction filled and the groove that shows past it.
 */
function buildGaugeRoot(
	host: Element,
	engine: UAEngine,
	styles: string,
): {bar: UAElement; groove: UAText} {
	const document = uaDocumentOf(host);
	const root = buildUARoot(host, engine, styles);
	const track = addPart(root, "track");
	track.removeChild(track.firstChild!);
	const bar = document.createElement("span");
	bar.setAttribute("part", "bar");
	bar.appendChild(document.createTextNode(gaugeRun(host, GAUGE_BAR_GLYPH)));
	track.appendChild(bar);
	const groove = document.createElement("span");
	groove.setAttribute("part", "groove");
	const grooveText = document.createTextNode(
		gaugeRun(host, GAUGE_GROOVE_GLYPH),
	);
	groove.appendChild(grooveText);
	track.appendChild(groove);
	return {bar, groove: grooveText};
}

/** Set a gauge bar's filled fraction, writing the width only on a change. */
function setGaugeFill(bar: UAElement, fraction: number | null): void {
	const width =
		fraction === null ? "0%" : `${Math.max(0, Math.min(1, fraction)) * 100}%`;
	if (bar.style.width !== width) {
		bar.style.width = width;
	}
}

const kBar = Symbol("bar");

/**
 * A gauge, whose six numbers are each read inside the ones around them.
 *
 * It renders a closed shadow tree it owns: a run of block glyphs filled to
 * where `value` sits between `min` and `max`, carrying the level that reading
 * against the low/high/optimum ranges produces -- which is what the UA sheet
 * colors the bar from.
 */
export class HTMLMeterElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kEngine] = null;
		this[kBar] = null;
	}

	declare [kEngine]?: UAEngine | null;
	declare [kBar]?: UAElement | null;

	[kUAUpgrade]?(): void {
		if (this[kEngine] !== null) {
			this[kUAReconcile]!();
			return;
		}
		const engine = uaEngineOf(this);
		if (engine === undefined) {
			return;
		}
		this[kEngine] = engine;
		this[kBar] = buildGaugeRoot(this, engine, METER_UA_STYLES).bar;
		this[kUAReconcile]!();
	}

	[kUAReconcile]?(): void {
		if (this[kEngine] === null) {
			return;
		}
		const bar = this[kBar]!;
		const min = this.min;
		const span = this.max - min;
		setGaugeFill(bar, span > 0 ? (this.value - min) / span : 0);
		const barLevel = level(this);
		if (bar.getAttribute("data-level") !== barLevel) {
			bar.setAttribute("data-level", barLevel);
		}
	}

	override [kAttributeChanged]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChanged]!(localName, oldValue, value, namespace);
		if (namespace === null && METER_ATTRIBUTES.has(localName)) {
			this[kUAReconcile]!();
		}
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
		return labelsOf(this);
	}
}

/**
 * Which of the three readings the value falls in, by the rendering rules
 * HTML gives: the optimum region is measured from where `optimum` sits
 * relative to `low` and `high`, and a value in it is optimum, one region
 * away suboptimum, two away even less good.
 */
function level(
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
/** The attributes a meter's own rendering is read from. */
const METER_ATTRIBUTES = new Set([
	"value",
	"min",
	"max",
	"low",
	"high",
	"optimum",
]);

export class HTMLModElement extends HTMLElement {}

/**
 * An embedded resource.
 *
 * Nothing is ever fetched here, so the object never gets a nested browsing
 * context: its document, its window and its SVG document are all null, which
 * is what they are for an object that loaded nothing.
 */
export class HTMLObjectElement extends HTMLElement {
	get form(): HTMLFormElement | null {
		return formOwner(this);
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

export class HTMLOListElement extends HTMLElement {}

export class HTMLOptGroupElement extends HTMLElement {
	/** Installed from the element table, and read by the select's own tree. */
	declare disabled: boolean;
	declare label: string;
}

const kSelectedness = Symbol("an option's selectedness");
const kSelectednessValue = Symbol("selectedness value");
const kOptionDirty = Symbol("an option's dirtiness");
/** One choice of a select, whose selectedness is its own state. */
export class HTMLOptionElement extends HTMLElement {
	/** Installed from the element table, and read by the select's own tree. */
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kSelectednessValue] = false;
		this[kOptionDirty] = false;
	}

	declare disabled: boolean;

	declare [kSelectednessValue]?: boolean;
	[kOptionDirty]?: boolean;

	/**
	 * An option's selectedness, which is no attribute and no part of a tree:
	 * the one live list drawing on it is the select's `selectedOptions`, and
	 * it is told here.
	 */
	get [kSelectedness](): boolean {
		return this[kSelectednessValue]!;
	}

	set [kSelectedness](value: boolean) {
		if (this[kSelectednessValue] === value) {
			return;
		}
		this[kSelectednessValue] = value;
		const select = selectOf(this);
		const selected = select === null ? null : select[kSelectedOptions]!;
		if (selected !== null) {
			syncMethod.call(selected);
		}
	}

	get form(): HTMLFormElement | null {
		const select = selectOf(this);
		return select === null ? null : formOwner(select);
	}

	/** The label an option shows: its attribute, or the text it holds. */
	get label(): string {
		const label = this.getAttribute("label");
		return label === null ? this.text : label;
	}

	set label(value: string) {
		this.setAttribute("label", String(value));
	}

	/** The value an option submits: its attribute, or the text it holds. */
	get value(): string {
		const value = this.getAttribute("value");
		return value === null ? this.text : value;
	}

	set value(value: string) {
		this.setAttribute("value", String(value));
	}

	get text(): string {
		return stripAndCollapseWhitespace(descendantText(this));
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}

	get index(): number {
		const select = selectOf(this);
		if (select === null) {
			return 0;
		}
		return optionsOf(select).indexOf(this);
	}

	get selected(): boolean {
		const select = selectOf(this);
		if (select !== null) {
			askForAReset(select);
		}
		return this[kSelectedness]!;
	}

	set selected(value: boolean) {
		this[kOptionDirty] = true;
		this[kSelectedness] = Boolean(value);
		const select = selectOf(this);
		if (select === null) {
			return;
		}
		if (this[kSelectedness] && !select.hasAttribute("multiple")) {
			for (const option of optionsOf(select)) {
				if (option !== this) {
					option[kSelectedness] = false;
				}
			}
		}
		askForAReset(select);
		widgetChanged(select);
	}

	override [kAttributeChanged]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChanged]!(localName, oldValue, value, namespace);
		if (
			namespace === null && localName === "selected" && !this[kOptionDirty]!) {
			this[kSelectedness] = value !== null;
		}
		const select = selectOf(this);
		if (select !== null) {
			widgetChanged(select);
		}
	}

	override [kCloningSteps]?(copy: Node): void {
		const clone = copy as HTMLOptionElement;
		clone[kSelectedness] = this[kSelectedness]!;
		clone[kOptionDirty] = this[kOptionDirty]!;
	}
}
/** The select an option belongs to, directly or through its group. */
function selectOf(option: Element): HTMLSelectElement | null {
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

/** The options of a select, which can be added to and taken from by index. */
export class HTMLOptionsCollection extends HTMLCollection {
	declare [kSelect]?: HTMLSelectElement;

	constructor(select: HTMLSelectElement) {
		super(() => optionsOf(select), select);
		this[kSelect] = select;
	}

	override get length(): number {
		return ensure(this).length;
	}

	override set length(value: number) {
		const wanted = toUnsignedLong(value);
		const options = optionsOf(this[kSelect]!);
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
				const options = optionsOf(this[kSelect]!);
				const index = toLong(before);
				reference =
					index >= 0 && index < options.length ? options[index] : null;
			} else {
				if (!(before instanceof Element)) {
					throw new TypeError("That is not an element");
				}
				if (!optionsOf(this[kSelect]!).includes(before as HTMLOptionElement)) {
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
		const options = optionsOf(this[kSelect]!);
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

/** The result of a calculation, whose value resets to its child text. */
export class HTMLOutputElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kDirty] = false;
		this[kStored] = "";
	}

	declare [kDirty]?: boolean;
	declare [kStored]?: string;

	get form(): HTMLFormElement | null {
		return formOwner(this);
	}

	get type(): string {
		return "output";
	}

	get labels(): NodeList {
		return labelsOf(this);
	}

	get defaultValue(): string {
		return this[kDirty]! ? this[kStored]! : descendantText(this);
	}

	set defaultValue(value: string) {
		if (this[kDirty]!) {
			this[kStored] = String(value);
			return;
		}
		setDescendantText(this, String(value));
	}

	get value(): string {
		return descendantText(this);
	}

	set value(value: string) {
		if (!this[kDirty]!) {
			this[kStored] = descendantText(this);
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

export class HTMLParagraphElement extends HTMLElement {}

export class HTMLParamElement extends HTMLElement {}

export class HTMLPictureElement extends HTMLElement {}

export class HTMLPreElement extends HTMLElement {}

/**
 * A progress bar, whose value is read against the maximum it names.
 *
 * It renders a closed shadow tree it owns: a run of block glyphs filled to
 * `value`/`max`. A progress with no value attribute is indeterminate, which
 * here is an empty bar over the full groove -- there is no animation to make
 * the difference the way a browser does.
 */
export class HTMLProgressElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kEngine] = null;
		this[kBar] = null;
	}

	declare [kEngine]?: UAEngine | null;
	declare [kBar]?: UAElement | null;

	[kUAUpgrade]?(): void {
		if (this[kEngine] !== null) {
			this[kUAReconcile]!();
			return;
		}
		const engine = uaEngineOf(this);
		if (engine === undefined) {
			return;
		}
		this[kEngine] = engine;
		this[kBar] = buildGaugeRoot(this, engine, PROGRESS_UA_STYLES).bar;
		this[kUAReconcile]!();
	}

	[kUAReconcile]?(): void {
		if (this[kEngine] === null) {
			return;
		}
		const position = this.position;
		setGaugeFill(this[kBar]!, position < 0 ? null : position);
	}

	override [kAttributeChanged]?(
		localName: string,
		oldValue: string | null,
		value: string | null,
		namespace: string | null,
	): void {
		super[kAttributeChanged]!(localName, oldValue, value, namespace);
		if (namespace === null && (localName === "value" || localName === "max")) {
			this[kUAReconcile]!();
		}
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
		return labelsOf(this);
	}
}

export class HTMLQuoteElement extends HTMLElement {}

/**
 * A script, which never runs.
 *
 * The element is the one the specification defines and its text is the text
 * it holds; executing it is the step this DOM does not have.
 */
export class HTMLScriptElement extends HTMLElement {
	static supports(type: string): boolean {
		const named = String(type);
		return named === "classic" || named === "module" || named === "importmap";
	}

	get text(): string {
		return childText(this);
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
}

const kSelectedOptions = Symbol("selectedOptions");
const kPicker = Symbol("picker");
const kOnMousedown = Symbol("onMousedown");
const kOnBlur = Symbol("onBlur");
const kHighlight = Symbol("highlight");

/**
 * A control that picks among its options.
 *
 * Selectedness lives on the options; the select's own members read it, and
 * every read first runs the selectedness setting algorithm, which is what
 * keeps a single-selection select showing exactly one option.
 *
 * It renders a closed shadow tree it owns: the selected option's label, the ▾
 * indicator, and a picker popover of option rows. The tree is derived from the
 * selectedness above and the highlight below; the keyboard and mouse behavior
 * is the control's own default action.
 */
export class HTMLSelectElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kOptions] = null;
		this[kSelectedOptions] = null;
		this[kEngine] = null;
		this[kValueText] = null;
		this[kPicker] = null;
		this[kHighlight] = null;
		this[kOnKeydown] = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) {
				return;
			}
			const key = event.key;
			const options = optionList(this);
			if (options.length === 0) {
				return;
			}
			const current = this.selectedIndex;

			if (this[kHighlight] !== null) {
				const highlight = this[kHighlight]!;
				if (key === "ArrowDown") {
					this[kHighlight] = step(this, highlight, 1);
				} else if (key === "ArrowUp") {
					this[kHighlight] = step(this, highlight, -1);
				} else if (key === "Home") {
					this[kHighlight] = step(this, -1, 1);
				} else if (key === "End") {
					this[kHighlight] = step(this, options.length, -1);
				} else if (key === "Enter" || key === " ") {
					this[kHighlight] = null;
					if (highlight !== current && !optionIsDisabled(options[highlight])) {
						commit(this, highlight);
						return;
					}
					this[kUAReconcile]!(); // No change: just close.
					return;
				} else if (key === "Escape") {
					this[kHighlight] = null;
				} else {
					return;
				}
				this[kUAReconcile]!();
				return;
			}

			// CLOSED: Space or Enter opens; arrows change the value in place.
			if (key === "Enter" || key === " ") {
				openPicker(this);
				return;
			}
			let target = current;
			if (key === "ArrowDown" || key === "ArrowRight") {
				target = step(this, current, 1);
			} else if (key === "ArrowUp" || key === "ArrowLeft") {
				target = step(this, current, -1);
			} else if (key === "Home") {
				target = step(this, -1, 1);
			} else if (key === "End") {
				target = step(this, options.length, -1);
			} else {
				return;
			}
			if (target !== current && target >= 0) {
				commit(this, target);
			}
		};
		this[kOnMousedown] = (event: MouseEvent): void => {
			if (event.defaultPrevented || event.button !== 0) {
				return;
			}
			const engine = this[kEngine]!;
			this.focus(); // A press focuses the control, as in a browser.
			if (this[kHighlight] === null) {
				openPicker(this);
				return;
			}
			const {clientX: x, clientY: y} = event;
			const picker = this[kPicker]!;
			const row = (Array.from(
				picker.childNodes,
			) as UAElement[]).find((node) => {
				const rect = engine.layout.getRect(node);
				return rect ? rectContains(rect, x, y) : false;
			});
			if (row) {
				const index = optionIndexOfRow(picker, row);
				// A disabled row is inert: the sheet stays up, nothing commits.
				const option = optionList(this)[index];
				if (option && !optionIsDisabled(option)) {
					this[kHighlight] = null;
					if (index !== this.selectedIndex) {
						commit(this, index);
					} else {
						this[kUAReconcile]!();
					} // Re-press the selection: just close.
				}
				return;
			}
			// Off every row: a press inside the picker's own padding does nothing; a
			// press outside it (the closed face) dismisses.
			const pickerRect = engine.layout.getRect(picker);
			if (!(pickerRect && rectContains(pickerRect, x, y))) {
				this[kHighlight] = null;
				this[kUAReconcile]!();
			}
		};
		this[kOnBlur] = (): void => {
			if (this[kHighlight] !== null) {
				this[kHighlight] = null;
				this[kUAReconcile]!();
			}
		};
	}

	declare [kOptions]?: HTMLOptionsCollection | null;
	declare [kSelectedOptions]?: HTMLCollection | null;

	declare [kEngine]?: UAEngine | null;
	declare [kValueText]?: UAText | null;
	declare [kPicker]?: UAElement | null;
	// The highlighted option index while the picker is OPEN; null = closed.
	declare [kHighlight]?: number | null;

	/**
	 * A select's selection record is degenerate -- always collapsed at the
	 * label's start -- so the cursor-parking path reads a select the way it
	 * reads a field: the caret is the focus of the selection.
	 */
	[kUASelection]?(): {start: number; end: number; direction: string} {
		return {start: 0, end: 0, direction: "none"};
	}

	get [kUAValueText](): UAText | null {
		return this[kValueText]!;
	}

	get form(): HTMLFormElement | null {
		return formOwner(this);
	}

	get labels(): NodeList {
		return labelsOf(this);
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

	get selectedOptions(): HTMLCollection {
		let selected = this[kSelectedOptions]!;
		if (selected === null) {
			selected = new HTMLCollection(
				() => optionsOf(this).filter((option) => option[kSelectedness]!),
				this,
			);
			this[kSelectedOptions] = selected;
		}
		askForAReset(this);
		return selected;
	}

	get selectedIndex(): number {
		askForAReset(this);
		return optionsOf(this).findIndex((option) => option[kSelectedness]!);
	}

	set selectedIndex(value: number) {
		const index = toLong(value);
		const options = optionsOf(this);
		for (let at = 0; at < options.length; at++) {
			options[at][kSelectedness] = false;
			options[at][kOptionDirty] = true;
		}
		if (index >= 0 && index < options.length) {
			options[index][kSelectedness] = true;
		}
		widgetChanged(this);
	}

	get value(): string {
		askForAReset(this);
		for (const option of optionsOf(this)) {
			if (option[kSelectedness]!) {
				return option.value;
			}
		}
		return "";
	}

	set value(value: string) {
		const wanted = String(value);
		const options = optionsOf(this);
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
		widgetChanged(this);
	}

	[kResetControl]?(): void {
		for (const option of optionsOf(this)) {
			option[kSelectedness] = option.hasAttribute("selected");
			option[kOptionDirty] = false;
		}
		askForAReset(this);
		widgetChanged(this);
	}

	[kUAUpgrade]?(): void {
		if (this[kEngine] !== null) {
			this[kUAReconcile]!();
			return;
		}
		const engine = uaEngineOf(this);
		if (engine === undefined) {
			return;
		}
		this[kEngine] = engine;
		const document = uaDocumentOf(this);
		// The tree: the selected option's label (part=value), the ▾ indicator
		// (part=indicator), and the picker popover (part=picker, holding one row
		// per option). Composition hides the light option list.
		const root = buildUARoot(this, engine, SELECT_UA_STYLES);
		this[kValueText] = addPart(root, "value").firstChild as UAText;
		(addPart(root, "indicator").firstChild as UAText).data = " ▾";
		const picker = document.createElement("div");
		picker.setAttribute("part", "picker");
		root.appendChild(picker);
		this[kPicker] = picker;

		this.addEventListener("keydown", this[kOnKeydown]! as UAListener);
		this.addEventListener("mousedown", this[kOnMousedown]! as UAListener);
		// Losing focus closes the picker, as everywhere.
		this.addEventListener("blur", this[kOnBlur]!);
		// The displayed label and picker rows track the option list; a framework
		// mutating the options must re-reconcile. (Selection changes reach the
		// tree through the control's own setters.)
		engine.observer.observe(this, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});

		this[kUAReconcile]!();
	}

	/**
	 * A select taken out of the document takes its picker with it. The
	 * dropdown is transient interaction state, and leaving the tree ends
	 * the interaction as surely as losing focus does -- which removal also
	 * causes, since focus cannot rest on an element off the tree.
	 */
	override [kRemovingSteps]?(oldParent: Node): void {
		super[kRemovingSteps]!(oldParent);
		if (this[kHighlight] !== null) {
			this[kHighlight] = null;
			this[kUAReconcile]!();
		}
	}

	/** Bring the UA tree back into step with the selection and open state. */
	[kUAReconcile]?(): void {
		const engine = this[kEngine]!;
		const picker = this[kPicker]!;
		if (engine === null || picker === null) {
			return;
		}
		const options = optionList(this);
		const selectedIndex = this.selectedIndex;
		const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
		const label = selected ? selected.label : "";
		if (this[kValueText]!.data !== label) {
			this[kValueText]!.data = label;
			engine.layout.invalidate(this);
		}

		if (this[kHighlight] === null) {
			if (picker.style.display !== "none") {
				picker.style.display = "none";
			}
			topLayerOf(this[kDocument]!).delete(picker as unknown as Element);
			return;
		}

		reconcileRows(this, picker);

		// Anchor below the field in DOCUMENT coordinates (the picker's containing
		// block is the ICB), matching the field's width.
		const rect = engine.layout.getRect(this);
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
		// widget owns the membership with the display flip, as one intent.
		topLayerOf(this[kDocument]!).add(picker as unknown as Element);
	}

	/**
	 * The select's editing default action. OPEN: arrows move the highlight
	 * without committing, Enter/Space commit, Escape dismisses. CLOSED:
	 * Enter/Space open the picker; arrows change the selection in place -- the
	 * browser's closed-select keyboard model, no popup to degrade.
	 */
	declare [kOnKeydown]?: (event: KeyboardEvent) => void;

	/**
	 * The mouse default action: a press opens a closed picker, and with the
	 * picker open a press on an option row commits it (a disabled row is inert),
	 * a press on the closed face dismisses. The row under the point is found
	 * from the rows' own document rects -- no renderer hit-test.
	 */
	declare [kOnMousedown]?: (event: MouseEvent) => void;

	declare [kOnBlur]?: () => void;
}

/* --------------------------------------------------- the rendered tree */

/** The options the tree renders: `options`, without building a collection. */
function optionList(
	select: HTMLSelectElement,
): HTMLOptionElement[] {
	askForAReset(select);
	return optionsOf(select);
}

/**
 * The rows the picker shows, in tree order: a heading for each option
 * group, and every option under the group it belongs to. A heading is not
 * an option, so it takes no index and cannot be picked.
 */
function pickerRows(
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
			highlighted: index === select[kHighlight]!,
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

/**
 * Bring the picker's rows into step with the option list; cheap at
 * option-list scale. Rows are updated in place rather than rebuilt: this
 * root is observed, and a rebuild every reconcile is a frame that schedules
 * the next one.
 */
function reconcileRows(
	select: HTMLSelectElement,
	picker: UAElement,
): void {
	const document = uaDocumentOf(select);
	const rows = pickerRows(select);
	while (picker.childNodes.length > rows.length) {
		picker.removeChild(picker.lastChild!);
	}
	while (picker.childNodes.length < rows.length) {
		picker.appendChild(document.createElement("div"));
	}
	rows.forEach((row, index) => {
		const node = picker.childNodes[index] as UAElement;
		// Attribute writes are guarded: setAttribute queues a mutation record
		// even when unchanged, and this root is observed -- an unconditional
		// write is an infinite render loop.
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

/** Step to the next enabled option in `direction`, or stay put. */
function step(
	select: HTMLSelectElement,
	from: number,
	direction: 1 | -1,
): number {
	const options = optionList(select);
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

/** Open the picker with the highlight on the current selection. */
function openPicker(
	select: HTMLSelectElement,
): void {
	const options = optionList(select);
	if (options.length === 0) {
		return;
	}
	let index = select.selectedIndex;
	if (index < 0) {
		index = options.findIndex((o) => !optionIsDisabled(o));
	}
	select[kHighlight] = index;
	select[kUAReconcile]!();
}

/** Commit `index` as the selection, close, and fire input then change. */
function commit(
	select: HTMLSelectElement,
	index: number,
): void {
	select[kHighlight] = null;
	select.selectedIndex = index; // The setter reconciles (closes + label).
	dispatch(select, new Event("input", {bubbles: true, cancelable: false}));
	dispatch(select, new Event("change", {bubbles: true, cancelable: false}));
}
/** One row of a select's picker: an option, or a group's heading. */
interface PickerRow {
	part: "option" | "optgroup";
	label: string;
	disabled: boolean;
	/** Whether the row sits under a group heading, which indents it. */
	grouped: boolean;
	highlighted: boolean;
}
/**
 * Whether an option is disabled: its own attribute, or the group it belongs
 * to carrying one -- the two the HTML Standard reads together.
 */
function optionIsDisabled(option: HTMLOptionElement): boolean {
	if (option.disabled) {
		return true;
	}
	const parent = option[kParent]!;
	return parent instanceof HTMLOptGroupElement && parent.disabled;
}
/** Whether a document-space point falls inside a rect. */
function rectContains(rect: UARect, x: number, y: number): boolean {
	return (
		x >= rect.x &&
		x < rect.x + rect.width &&
		y >= rect.y &&
		y < rect.y + rect.height
	);
}
/** Set or clear a picker row's state attribute, writing only on a change. */
function setRowFlag(row: UAElement, name: string, on: boolean): void {
	if (on === row.hasAttribute(name)) {
		return;
	}
	if (on) {
		row.setAttribute(name, "");
	} else {
		row.removeAttribute(name);
	}
}
/**
 * The index into a select's option list that a picker row stands for: the rows
 * that are options, counted in tree order.
 */
function optionIndexOfRow(picker: UAElement, row: UAElement): number {
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
/** The options of a select: its option children, and its groups' children. */
function optionsOf(select: Element): HTMLOptionElement[] {
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
/** The number of rows a select shows, which its size attribute names. */
function displaySize(select: HTMLSelectElement): number {
	const value = select.getAttribute("size");
	const parsed = value === null ? null : parseNonNegativeInteger(value);
	return parsed === null || parsed === 0 ? 1 : parsed;
}
/**
 * The selectedness setting algorithm: a select that shows one row and has
 * nothing selected selects its first enabled option, and a select with more
 * than one selected keeps only the last.
 */
function askForAReset(select: HTMLSelectElement): void {
	const options = optionsOf(select);
	const selected = options.filter((option) => option[kSelectedness]!);
	if (
		!select.hasAttribute("multiple") &&
		displaySize(select) === 1 &&
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

export class HTMLSourceElement extends HTMLElement {}

export class HTMLSpanElement extends HTMLElement {}

const kStyleElements = Symbol("how many style elements the tree holds");

/**
 * A style sheet written into the document.
 *
 * The sheet itself belongs to the engine's cascade, not to the tree: there is
 * none here, which is what makes `sheet` null and `disabled` false.
 */
export class HTMLStyleElement extends HTMLElement {
	/**
	 * A document with no cascade behind it parses no CSS, and so holds no
	 * sheet. A window's cascade replaces this accessor with one that answers
	 * the element's real CSSStyleSheet (see styles.ts's CSSOM installation),
	 * which is what an author reaches through `styleEl.sheet`.
	 */
	get sheet(): CSSStyleSheet | null {
		return null;
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
 * How many style elements a document's trees hold, as a number that changes
 * whenever one joins or leaves. A cascade polls this to notice a sheet that
 * appeared since it last parsed, which is cheaper than walking for one.
 */
function styleElementCount(document: Document): number {
	return document[kStyleElements]!;
}
export class HTMLTableCaptionElement extends HTMLElement {}

/** One cell of a row, which knows where in the row it sits. */
export class HTMLTableCellElement extends HTMLElement {
	get cellIndex(): number {
		const parent = this[kParent]!;
		if (!(parent instanceof HTMLTableRowElement)) {
			return -1;
		}
		return rowCells(parent).indexOf(this);
	}
}

export class HTMLTableColElement extends HTMLElement {}

const kTBodies = Symbol("tBodies");
const kRows = Symbol("rows");

/** A table, and the rows and sections a caller reaches and builds. */
export class HTMLTableElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kTBodies] = null;
		this[kRows] = null;
	}

	declare [kTBodies]?: HTMLCollection | null;
	declare [kRows]?: HTMLCollection | null;

	get caption(): Element | null {
		return firstChildElement(this, "caption");
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

	get tHead(): Element | null {
		return firstChildElement(this, "thead");
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

	get tFoot(): Element | null {
		return firstChildElement(this, "tfoot");
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

	get tBodies(): HTMLCollection {
		let bodies = this[kTBodies]!;
		if (bodies === null) {
			bodies = new HTMLCollection(
				() => childElementsNamed(this, "tbody"),
				this,
				(node) => isHTMLElementNamed(node, "tbody"),
			);
			this[kTBodies] = bodies;
		}
		return bodies;
	}

	createTBody(): Element {
		const body = createElementInternal(
			this[kDocument]!,
			"tbody",
			HTML_NAMESPACE,
		);
		const bodies = childElementsNamed(this, "tbody");
		const last = bodies[bodies.length - 1];
		preInsert(body, this, last === undefined ? null : last[kNext]!);
		return body;
	}

	get rows(): HTMLCollection {
		let rows = this[kRows]!;
		if (rows === null) {
			rows = new HTMLCollection(() => tableRows(this), this);
			this[kRows] = rows;
		}
		return rows;
	}

	insertRow(index = -1): Element {
		const rows = tableRows(this);
		const at = toLong(index);
		if (at < -1 || at > rows.length) {
			throw indexSizeError("There is no row at that index");
		}
		const row = createElementInternal(this[kDocument]!, "tr", HTML_NAMESPACE);
		if (rows.length === 0 && childElementsNamed(this, "tbody").length === 0) {
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
			const bodies = childElementsNamed(this, "tbody");
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
		const rows = tableRows(this);
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
/** Whether a node is an HTML element with a given local name. */
function isHTMLElementNamed(node: Node, localName: string): boolean {
	return (
		node.nodeType === ELEMENT_NODE &&
		(node as Element)[kNamespace] === HTML_NAMESPACE &&
		(node as Element)[kLocalName] === localName
	);
}
/** The child elements of a parent with a given HTML local name, in order. */
function childElementsNamed(parent: Node, localName: string): Element[] {
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
/**
 * A table's rows: the head's, then the ones the table holds itself and its
 * bodies hold, then the foot's.
 */
function tableRows(table: Element): Element[] {
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
				head.push(...childElementsNamed(element, "tr"));
				break;
			case "tfoot":
				foot.push(...childElementsNamed(element, "tr"));
				break;
			case "tbody":
				middle.push(...childElementsNamed(element, "tr"));
				break;
			case "tr":
				middle.push(element);
				break;
		}
	}
	return [...head, ...middle, ...foot];
}

const kCells = Symbol("cells");

/** One row of a table, and the cells it holds. */
export class HTMLTableRowElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kCells] = null;
	}

	declare [kCells]?: HTMLCollection | null;

	get rowIndex(): number {
		const owner = table(this);
		return owner === null ? -1 : tableRows(owner).indexOf(this);
	}

	get sectionRowIndex(): number {
		const parent = this[kParent]!;
		if (parent === null || parent.nodeType !== ELEMENT_NODE) {
			return -1;
		}
		return childElementsNamed(parent, "tr").indexOf(this);
	}

	get cells(): HTMLCollection {
		let cells = this[kCells]!;
		if (cells === null) {
			cells = new HTMLCollection(
				() => rowCells(this),
				this,
				(node) => node instanceof HTMLTableCellElement,
			);
			this[kCells] = cells;
		}
		return cells;
	}

	insertCell(index = -1): Element {
		const cells = rowCells(this);
		const at = toLong(index);
		if (at < -1 || at > cells.length) {
			throw indexSizeError("There is no cell at that index");
		}
		const cell = createElementInternal(this[kDocument]!, "td", HTML_NAMESPACE);
		preInsert(cell, this, at === -1 || at === cells.length ? null : cells[at]);
		return cell;
	}

	deleteCell(index: number): void {
		const cells = rowCells(this);
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

function table(
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
	return (grandparent as Element)[kLocalName] === "table" ?
			(grandparent as Element) :
		null;
}
/** The cells of a row: its td and th children, in order. */
function rowCells(row: Element): Element[] {
	const cells: Element[] = [];
	for (let node = row[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node instanceof HTMLTableCellElement) {
			cells.push(node);
		}
	}
	return cells;
}

/** A head, body or foot of a table, and the rows it holds. */
export class HTMLTableSectionElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kRows] = null;
	}

	declare [kRows]?: HTMLCollection | null;

	get rows(): HTMLCollection {
		let rows = this[kRows]!;
		if (rows === null) {
			rows = new HTMLCollection(
				() => childElementsNamed(this, "tr"),
				this,
				(node) => isHTMLElementNamed(node, "tr"),
			);
			this[kRows] = rows;
		}
		return rows;
	}

	insertRow(index = -1): Element {
		const rows = childElementsNamed(this, "tr");
		const at = toLong(index);
		if (at < -1 || at > rows.length) {
			throw indexSizeError("There is no row at that index");
		}
		const row = createElementInternal(this[kDocument]!, "tr", HTML_NAMESPACE);
		preInsert(row, this, at === -1 || at === rows.length ? null : rows[at]);
		return row;
	}

	deleteRow(index: number): void {
		const rows = childElementsNamed(this, "tr");
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

/**
 * A multi-line control, whose default value is its child text.
 *
 * It renders a closed shadow tree it owns: a value part -- laid out, wrapped
 * and painted like any document text -- a placeholder part, and a trailing
 * line-break anchor. The tree is derived from the value above, and the editing
 * keys are the control's own default action.
 */
export class HTMLTextAreaElement extends HTMLElement {
	constructor(...args: ConstructorParameters<typeof HTMLElement>) {
		super(...args);
		this[kValue] = "";
		this[kDirty] = false;
		this[kSelectionStart] = 0;
		this[kSelectionEnd] = 0;
		this[kSelectionDirection] = "none";
		this[kEngine] = null;
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
				applyFieldEdit(this, printableFieldEdit(this, event.data));
				return;
			}
			if (event.inputType !== "insertFromPaste") {
				return;
			}
			event.preventDefault();
			insertPaste(this, event.data);
		};
		this[kOnKeydown] = (event: KeyboardEvent): void => {
		// Editing is a default action: an author's keydown preventDefault
		// suppresses it, exactly as it suppresses a browser textarea's edit.
			if (event.defaultPrevented) {
				return;
			}
			const engine = this[kEngine]!;
			if (engine === null) {
				return;
			}
			const {key, shiftKey, ctrlKey} = event;
			// The goal column survives only an unbroken run of vertical moves.
			if (key !== "ArrowUp" && key !== "ArrowDown") {
				this[kGoalColumn] = null;
			}

			const value = this[kUAValue]!;
			const {start, end, direction} = uaSelectionOf(this);
			const backward = direction === "backward";
			const caret = backward ? start : end;
			const anchor = backward ? end : start;

			let result: FieldEditResult | null;
			if (key === "Enter" || (ctrlKey && key === "j")) {
			// A newline, inserted like any typed character, replacing the
			// selection. A terminal sends line feed for Ctrl+J, which is the chord
			// that reaches a field whose Enter an application has taken.
				const next = value.slice(0, start) + "\n" + value.slice(end);
				const pos = start + 1;
				result = {value: next, start: pos, end: pos, direction: "none"};
			} else if (key === "ArrowUp" || key === "ArrowDown") {
				engine.layout.calculateLayout();
				const target = verticalTarget(
					this,
					caret,
					key === "ArrowDown" ? 1 : -1,
				);
				result = fieldSelectionMove(value, anchor, target, shiftKey);
			} else if (
				key === "Home" ||
				key === "End" ||
				(ctrlKey && (key === "a" || key === "e" || key === "k" || key === "u"))
			) {
				engine.layout.calculateLayout();
				const visual = textareaVisualLines(this, engine.layout);
				const line = visual ?
					visual.lines[textareaLineAt(visual.lines, caret)] :
					null;
				const lineStart = line?.startOffset ?? 0;
				const lineEnd = line?.endOffset ?? value.length;
				if (ctrlKey && key === "k") {
					result = collapsedEdit(
						value.slice(0, caret) + value.slice(lineEnd),
						caret,
					);
				} else if (ctrlKey && key === "u") {
					result = collapsedEdit(
						value.slice(0, lineStart) + value.slice(caret),
						lineStart,
					);
				} else {
					const toStart = key === "Home" || key === "a";
					result = fieldSelectionMove(
						value,
						anchor,
						toStart ? lineStart : lineEnd,
						shiftKey,
					);
				}
			} else {
				result = applySharedFieldEdit(this, key, shiftKey, ctrlKey);
			}
			if (result) {
				applyFieldEdit(this, result);
			}
		};
	}

	declare [kValue]?: string;
	declare [kDirty]?: boolean;
	declare [kSelectionStart]?: number;
	declare [kSelectionEnd]?: number;
	declare [kSelectionDirection]?: string;

	declare [kEngine]?: UAEngine | null;
	declare [kValueText]?: UAText | null;
	declare [kPlaceholderText]?: UAText | null;
	declare [kPlaceholderSpan]?: UAElement | null;
	declare [kGoalColumn]?: number | null;

	get form(): HTMLFormElement | null {
		return formOwner(this);
	}

	get labels(): NodeList {
		return labelsOf(this);
	}

	get type(): string {
		return "textarea";
	}

	get defaultValue(): string {
		return descendantText(this);
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
		widgetChanged(this);
	}

	/**
	 * The control's value itself, which is what the widget below renders and
	 * edits through: the raw value once the dirty flag is set, the child text
	 * until then. @see HTMLInputElement's own door.
	 */
	get [kUAValue](): string {
		return this[kDirty]! ?
			this[kValue]! :
				normalizeNewlines(descendantText(this));
	}

	/**
	 * Set the value from a user edit: the raw value changes and the dirty
	 * value flag is set, leaving the selection to the edit that made it.
	 */
	[kSetUAValue]?(value: string): void {
		this[kValue] = normalizeNewlines(value);
		this[kDirty] = true;
		widgetChanged(this);
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

	select(): void {
		this.setSelectionRange(0, this.value.length, "none");
	}

	setSelectionRange(start: number, end: number, direction?: string): void {
		if (arguments.length < 2) {
			throw new TypeError("setSelectionRange needs a start and an end");
		}
		this[kSetUASelection]!(start, end, direction);
	}

	/** A textarea's selection is always its own; see the input's door. */
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
		widgetChanged(this);
		scheduleTextSelectionChange(this);
	}

	override [kCloningSteps]?(copy: Node): void {
		const clone = copy as HTMLTextAreaElement;
		clone[kValue] = this[kValue]!;
		clone[kDirty] = this[kDirty]!;
	}

	[kResetControl]?(): void {
		this[kValue] = "";
		this[kDirty] = false;
		widgetChanged(this);
	}

	/* --------------------------------------------------- the rendered tree */

	get [kUAValueText](): UAText | null {
		return this[kValueText]!;
	}

	[kUASelectionRange]?(): UARange | null {
		return textSelectionRange(this, this[kValueText]!);
	}

	[kUAUpgrade]?(): void {
		if (this[kEngine] !== null) {
			this[kUAReconcile]!();
			return;
		}
		const engine = uaEngineOf(this);
		if (engine === undefined) {
			return;
		}
		this[kEngine] = engine;
		const document = uaDocumentOf(this);
		const root = buildUARoot(this, engine, TEXTAREA_UA_STYLES);
		this[kValueText] = addPart(root, "value").firstChild as UAText;
		this[kPlaceholderSpan] = addPart(root, "placeholder");
		this[kPlaceholderText] = this[kPlaceholderSpan]!.firstChild as UAText;
		// The trailing <br> anchor, the same trick a browser's editor uses: it
		// makes the run's content always end in exactly one line break, so the
		// line count equals the LOGICAL line count -- the breaker never emits a
		// line after a final newline, and without the anchor a value ending in
		// "\n" measures one row short, parking the caret on the bottom border.
		root.appendChild(document.createElement("br"));

		// Editing is the control's own default action, the same as a browser
		// textarea's: its keydown listener does the edit.
		this.addEventListener("keydown", this[kOnKeydown]! as UAListener);
		this.addEventListener("beforeinput", this[kOnBeforeInput]! as UAListener);

		this[kUAReconcile]!();
	}

	// A typed character arrives as an insertText; a paste keeps its newlines.
	declare [kOnBeforeInput]?: (event: InputEvent) => void;

	/**
	 * Bring the UA tree back into step with the element's own state -- the
	 * single source of truth. Placeholder visibility is real CSS (an inline
	 * display:none), not painter logic: the normal pipeline then simply never
	 * sees it.
	 */
	[kUAReconcile]?(): void {
		const engine = this[kEngine]!;
		if (engine === null) {
			return;
		}
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
		// hears its characterData change too, but only on a microtask -- an edit
		// that reads the fresh geometry back the same tick (vertical motion,
		// Home/End) needs the engine dirtied synchronously now.
		engine.layout.invalidate(this);
	}

	/**
	 * The textarea's editing default action. Enter inserts a newline, the
	 * vertical arrows and Home/End move by VISUAL line (soft wraps count, as in
	 * a browser), and every other editing key is the shared field logic. Reads
	 * back laid-out geometry, so it flushes layout first.
	 */
	declare [kOnKeydown]?: (event: KeyboardEvent) => void;
}

/**
 * The caret offset one visual line up or down from `caret`, keeping the
 * column (in cells) where the target line allows -- soft wraps count as
 * lines, exactly as in a browser. First line up collapses to 0, last line
 * down to the end.
 */
function verticalTarget(
	textarea: HTMLTextAreaElement,
	caret: number,
	direction: 1 | -1,
): number {
	const visual = textareaVisualLines(textarea, textarea[kEngine]!.layout);
	if (!visual) {
		return caret;
	}
	const lineIndex = textareaLineAt(visual.lines, caret);
	const targetIndex = lineIndex + direction;
	if (targetIndex < 0) {
		return 0;
	}
	if (targetIndex >= visual.lines.length) {
		return visual.value.length;
	}
	const line = visual.lines[lineIndex];
	const lineText = visual.value.slice(line.startOffset, line.endOffset);
	const currentColumn = stringWidth(
		lineText.slice(0, Math.max(0, caret - line.startOffset)),
	);
	// Consecutive vertical moves aim for the column travel STARTED at, even
	// across shorter lines that clamp the caret -- the browser's goal column.
	const column = textarea[kGoalColumn] ?? currentColumn;
	textarea[kGoalColumn] = column;
	const target = visual.lines[targetIndex];
	const targetText = visual.value.slice(target.startOffset, target.endOffset);
	let cells = 0;
	for (let i = 0; i < targetText.length; i++) {
		const charCells = stringWidth(targetText[i]);
		if (cells + charCells > column) {
			return target.startOffset + i;
		}
		cells += charCells;
	}
	return target.endOffset;
}
/**
 * One visual (soft-wrapped or hard-broken) line of a laid-out textarea: the
 * range of the value it covers. A value renders as pre-wrap, so the line's
 * characters are that range of the value verbatim.
 */
type TextareaVisualLine = {
	/** Data offset of the line's first character / caret slot. */
	startOffset: number;
	/** Data offset of the caret slot AFTER the line's last character. */
	endOffset: number;
};
/**
 * The visual line index a caret offset sits on, given a textarea's visual
 * lines.
 */
function textareaLineAt(
	lines: Array<{startOffset: number; endOffset: number}>,
	caret: number,
): number {
	for (let i = 0; i < lines.length; i++) {
		// endOffset is a valid caret slot on this line; a caret exactly at a
		// soft-wrap boundary belongs to the NEXT line's start (both lines claim
		// the offset; later line wins), matching browsers.
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
/**
 * A textarea's laid-out visual lines with their data ranges -- a thin field
 * view over the shared `lineFragments` primitive (the empty and trailing-newline
 * lines included). Internal to the control's own Home/End and vertical-motion
 * editing; geometry consumers read `lineFragments` or a `Range` directly.
 */
function textareaVisualLines(
	field: HTMLTextAreaElement,
	layout: UAEngine["layout"],
): {value: string; lines: TextareaVisualLine[]} | null {
	const valueText = fieldValueText(field);
	if (!valueText) {
		return null;
	}
	// The laid-out lines with their data ranges, including the empty lines no
	// fragment represents (an empty value, a trailing newline) -- the same
	// annotation range geometry reads, so the caret, a Range, and vertical
	// navigation all agree on where an offset sits.
	const lines = layout.lineFragments(valueText);
	if (lines.length === 0) {
		return null;
	}
	return {value: valueText.data, lines};
}
/** A raw value holds line breaks as single line feeds. */
function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

export class HTMLTimeElement extends HTMLElement {}

/** The document's title, which is the text this element holds. */
export class HTMLTitleElement extends HTMLElement {
	get text(): string {
		return childText(this);
	}

	set text(value: string) {
		setDescendantText(this, String(value));
	}
}
/** The text of an element's Text children, which is not its descendants'. */
function childText(element: Element): string {
	let text = "";
	for (let node = element[kFirstChild]!; node !== null; node = node[kNext]!) {
		if (node.nodeType === TEXT_NODE) {
			text += (node as Text).data;
		}
	}
	return text;
}

export class HTMLTrackElement extends HTMLElement {}

export class HTMLUListElement extends HTMLElement {}

/* ------------------------------------------------------------- popovers */

/**
 * A popover's state, which no attribute records.
 *
 * `mode` is the state the popover was OPENED in rather than the one its
 * attribute names now: the attribute can change under a showing popover, and
 * the stack it belongs to is the one it entered. `previouslyFocused` is set
 * only for the popover that opened a stack, so closing the stack gives focus
 * back once rather than once per popover.
 */
interface PopoverState {
	visibility: "hidden" | "showing";
	mode: "auto" | null;
	trigger: Element | null;
	previouslyFocused: Element | null;
	hiding: boolean;
	toggleTask: {oldState: string; canceled: boolean} | null;
}

/**
 * The popover state of the elements that have one. HTML gives the slots to
 * every HTML element; an element that was never a popover has no state to
 * hold, and the state it would hold is the initial one.
 */
const popoverStates = new WeakMap<Element, PopoverState>();

function popoverStateOf(element: Element): PopoverState {
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

/**
 * The state an element's popover attribute is in: auto for the empty string
 * and `auto`, manual for `manual` and for every value the attribute does not
 * know, and null -- not a popover -- when the attribute is absent.
 *
 * HTML's third state, Hint, is NOT implemented: a hint popover keeps a second
 * stack that auto popovers close and that closes with the auto popover it
 * hangs from, and every algorithm here would carry that second stack through
 * it. `popover=hint` therefore takes the route the attribute defines for a
 * value it does not know, the Manual state, and reflects as "manual".
 */
function popoverAttributeState(element: Element): "auto" | "manual" | null {
	if (element[kNamespace] !== HTML_NAMESPACE) {
		return null;
	}
	return popoverValueState(element.getAttribute("popover"));
}

/** The state a popover attribute VALUE is in, for comparing two of them. */
function popoverValueState(value: string | null): "auto" | "manual" | null {
	if (value === null) {
		return null;
	}
	const keyword = asciiLowercase(value);
	return keyword === "" || keyword === "auto" ? "auto" : "manual";
}

/** Whether an element is a popover in the showing state -- `:popover-open`. */
function isShowingPopover(node: object): boolean {
	return (
		node instanceof HTMLElement &&
		popoverStates.get(node)?.visibility === "showing"
	);
}

/**
 * A document's showing auto popover list: the auto popovers in its top layer,
 * in the order they entered it, which is the order they close in.
 */
function showingAutoPopovers(document: Document): Element[] {
	const popovers: Element[] = [];
	for (const element of topLayerOf(document)) {
		const state = popoverStates.get(element);
		if (state?.mode === "auto" && state.visibility === "showing") {
			popovers.push(element);
		}
	}
	return popovers;
}

/** The auto popover on top of a document's stack, or null while none is up. */
function topmostAutoPopover(document: object): Element | null {
	const popovers = showingAutoPopovers(document as Document);
	return popovers.length === 0 ? null : popovers[popovers.length - 1];
}

/**
 * Tell the environment that a popover's state moved. Nothing about showing
 * one is a mutation -- the attribute stands, the tree stands -- so the rules
 * that test `:popover-open`, and the frame that would paint what they hide or
 * reveal, have nothing else to hear it from.
 */
function popoverStateChanged(element: Element): void {
	uaEngineOf(element)?.stateChanged(element);
}

/**
 * Check popover validity, as the callers below hold the result: true, false
 * for a call that is simply not to happen, or the exception the check threw,
 * which a caller rethrows only where the specification says it does.
 *
 * HTML also refuses a popover whose fullscreen flag is set. Fullscreen is the
 * renderer's, not the tree's -- this file knows nothing of it -- and the
 * element that is fullscreen paints over the whole screen either way, so the
 * check is the environment's if it ever wants one.
 */
function popoverValidity(
	element: Element,
	expectedToBeShowing: boolean,
	expectedDocument: Document | null,
): true | false | unknown {
	if (popoverAttributeState(element) === null) {
		return domError("NotSupportedError", "That element is not a popover");
	}
	const showing = popoverStateOf(element).visibility === "showing";
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

/** Whether a validity result is the exception a throwing caller rethrows. */
function isPopoverException(result: true | false | unknown): boolean {
	return result !== true && result !== false;
}

const kPopoverShowing = Symbol("a popover is opening");
const kPopoverHidingCount = Symbol("how many popovers are closing");

/**
 * HTML's show popover: the popover joins the top layer, and an auto one first
 * closes every open auto popover it is not nested inside -- through the node
 * tree or through the element that invoked it.
 */
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
	let validity = popoverValidity(element, false, null);
	if (validity !== true) {
		if (throwExceptions && isPopoverException(validity)) {
			throw validity;
		}
		return;
	}
	const state = popoverStateOf(element);
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
	// its popover attribute, so what was checked above is checked again.
	validity = popoverValidity(element, false, document);
	if (validity !== true) {
		cleanup();
		if (throwExceptions && isPopoverException(validity)) {
			throw validity;
		}
		return;
	}
	let shouldRestoreFocus = false;
	const originalType = popoverAttributeState(element);
	if (originalType === "auto") {
		const ancestor = topmostPopoverAncestor(element, source);
		hidePopoverStackUntil(document, ancestor, false, true);
		if (originalType !== popoverAttributeState(element)) {
			cleanup();
			if (throwExceptions) {
				throw domError(
					"InvalidStateError",
					"That popover changed state while the ones over it closed",
				);
			}
			return;
		}
		validity = popoverValidity(element, false, document);
		if (validity !== true) {
			cleanup();
			if (throwExceptions && isPopoverException(validity)) {
				throw validity;
			}
			return;
		}
		// Focus goes back to the page only for the popover that OPENED the
		// stack, so unwinding one returns it once.
		if (topmostAutoPopover(document) === null) {
			shouldRestoreFocus = true;
		}
		state.mode = "auto";
	}
	state.previouslyFocused = null;
	const originallyFocused = document[kActiveElement]!;
	topLayerOf(document).add(element);
	state.visibility = "showing";
	state.trigger = source;
	popoverFocusingSteps(element);
	if (shouldRestoreFocus && popoverAttributeState(element) !== null) {
		state.previouslyFocused = originallyFocused;
	}
	cleanup();
	queuePopoverToggleEventTask(element, "closed", "open", source);
	popoverStateChanged(element);
}

/**
 * HTML's hide popover: the popover leaves the top layer, and an auto one
 * takes the popovers stacked above it with it.
 */
function hidePopover(
	element: Element,
	focusPreviousElement: boolean,
	fireEvents: boolean,
	throwExceptions: boolean,
	source: Element | null,
): void {
	let validity = popoverValidity(element, true, null);
	if (validity !== true) {
		if (throwExceptions && isPopoverException(validity)) {
			throw validity;
		}
		return;
	}
	const document = element[kDocument]!;
	const state = popoverStateOf(element);
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
		// changed its attribute, so validity is asked again.
		validity = popoverValidity(element, true, null);
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
		validity = popoverValidity(element, true, null);
		if (validity !== true) {
			cleanup();
			if (throwExceptions && isPopoverException(validity)) {
				throw validity;
			}
			return;
		}
	}
	topLayerOf(document).delete(element);
	state.trigger = null;
	state.mode = null;
	state.visibility = "hidden";
	if (fireEvents) {
		queuePopoverToggleEventTask(element, "open", "closed", source);
	}
	const previouslyFocused = state.previouslyFocused;
	if (previouslyFocused !== null) {
		state.previouslyFocused = null;
		// Focus goes back only if the popover still holds it: an author who
		// moved focus elsewhere while it was up keeps it there.
		const active = document[kActiveElement]!;
		if (
			focusPreviousElement &&
			active !== null &&
			(active === element || element.contains(active))
		) {
			(previouslyFocused as HTMLElement).focus();
		}
	}
	cleanup();
	popoverStateChanged(element);
}

/**
 * Close a popover the way a close request does -- Escape on the topmost auto
 * popover -- which is a hide that gives focus back and fires its events.
 */
function closePopover(element: object): void {
	hidePopover(element as Element, true, true, false, null);
}

/**
 * HTML's hide popover stack until: close the auto popovers stacked above an
 * endpoint, topmost first, leaving the endpoint and everything under it. A
 * null endpoint closes the whole stack.
 *
 * The second pass catches the popovers a beforetoggle listener showed while
 * the stack was unwinding, which would otherwise be left over the endpoint.
 */
function hidePopoverStackUntil(
	document: Document,
	endpoint: Element | null,
	focusPreviousElement: boolean,
	fireEvents: boolean,
): void {
	const popovers = showingAutoPopovers(document);
	const index = endpoint === null ? -1 : popovers.indexOf(endpoint);
	const lastHideIndex = index === -1 ? 0 : index + 1;
	const toHide = popovers.slice(lastHideIndex).reverse();
	const toRemain = popovers.slice(0, lastHideIndex);
	for (const popover of toHide) {
		hidePopover(popover, focusPreviousElement, fireEvents, false, null);
	}
	for (const popover of showingAutoPopovers(document).reverse()) {
		if (toRemain.includes(popover)) {
			continue;
		}
		hidePopover(popover, focusPreviousElement, false, false, null);
	}
}

/**
 * HTML's hide popovers until, which is the stack unwind light dismiss and an
 * opening popover both run. With no hint stack, it is the auto stack's.
 */
function hidePopoversUntil(
	document: object,
	endpoint: object | null,
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

/**
 * HTML's topmost popover ancestor: the open auto popover a node hangs from,
 * either by sitting inside it in the flat tree or by being invoked from
 * inside it. The ancestor is the LAST such popover in the stack, so what
 * closes above it is exactly what is unrelated to the node.
 */
function topmostPopoverAncestor(
	node: Element,
	source: Element | null,
): Element | null {
	const popovers = showingAutoPopovers(node[kDocument]!);
	const nodeIndex = lastFlatAncestorIndex(popovers, node);
	const sourceIndex =
		source === null ? -1 : lastFlatAncestorIndex(popovers, source);
	const index = Math.max(nodeIndex, sourceIndex);
	return index === -1 ? null : popovers[index];
}

/** The index of the last popover in a stack a node sits inside of. */
function lastFlatAncestorIndex(popovers: Element[], node: Element): number {
	for (let i = popovers.length - 1; i >= 0; i--) {
		if (isFlatTreeDescendant(node, popovers[i])) {
			return i;
		}
	}
	return -1;
}

/** Whether a node renders inside an element, shadow trees crossed. */
function isFlatTreeDescendant(node: Node, ancestor: Element): boolean {
	for (
		let current = flatParentElement<Node>(node);
		current !== null;
		current = flatParentElement<Node>(current)
	) {
		if (current === ancestor) {
			return true;
		}
	}
	return false;
}

/** HTML's nearest inclusive open popover: the auto popover a node is in. */
function nearestInclusiveOpenPopover(node: Node): Element | null {
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

/**
 * HTML's nearest inclusive target popover: the open auto popover the node, or
 * an element it sits in, INVOKES. It is what keeps a click on a popover's own
 * button from light-dismissing the popover it opened.
 */
function nearestInclusiveTargetPopover(node: Node): Element | null {
	for (
		let current: Node | null = node;
		current !== null;
		current = flatParentElement<Node>(current)
	) {
		const target = popoverTargetElementOf(current);
		if (
			target !== null &&
			popoverAttributeState(target) === "auto" &&
			isShowingPopover(target)
		) {
			return target;
		}
	}
	return null;
}

/** Where a popover sits in its document's stack; zero for one not in it. */
function popoverStackPosition(popover: Element | null): number {
	if (popover === null) {
		return 0;
	}
	const index = showingAutoPopovers(popover[kDocument]!).indexOf(popover);
	return index === -1 ? 0 : index + 1;
}

/**
 * HTML's topmost clicked popover: the popover a click at a node belongs to,
 * which is the deeper of the popover the node is in and the popover the node
 * invokes. Light dismiss closes everything stacked above it.
 */
function topmostClickedPopover(node: object): Element | null {
	const clicked = nearestInclusiveOpenPopover(node as Node);
	const target = nearestInclusiveTargetPopover(node as Node);
	return popoverStackPosition(clicked) > popoverStackPosition(target) ?
		clicked :
		target;
}

/**
 * HTML's popover focusing steps. Unlike a dialog, a popover does not take
 * focus off the page by opening: focus moves only where the content asks for
 * it with autofocus.
 */
function popoverFocusingSteps(element: Element): void {
	if (element instanceof HTMLDialogElement) {
		dialogFocusingSteps(element);
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

/**
 * HTML's queue a popover toggle event task. A popover shown and hidden inside
 * one turn reports the state it settled on: the pending task is dropped and
 * its old state carried into the one that replaces it, so an author sees one
 * toggle describing the whole run rather than a pair that cancel out.
 */
function queuePopoverToggleEventTask(
	element: Element,
	oldState: string,
	newState: string,
	source: Element | null,
): void {
	const state = popoverStateOf(element);
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

/**
 * The elements a popovertarget was set to as an ELEMENT rather than named by
 * id. The attribute cannot hold one, so the reference is held beside it, and
 * the getter answers with it only while the element it names is in a tree the
 * invoker composes into.
 */
const explicitPopoverTargets = new WeakMap<Element, Element>();

/**
 * HTML's get the popovertarget-associated element: the explicitly set element
 * if it is still reachable, otherwise the element the attribute names by id
 * in the invoker's own tree.
 */
function popoverTargetAttributeElement(node: Node): Element | null {
	if (node.nodeType !== ELEMENT_NODE) {
		return null;
	}
	const element = node as Element;
	const explicit = explicitPopoverTargets.get(element);
	if (explicit !== undefined) {
		// The reference stands while the target is in the invoker's own tree
		// or in one that tree composes into; it goes stale, rather than
		// dangling, when the target is moved out from under it.
		for (let root: Node = getRoot(element); ;) {
			if (root.contains(explicit)) {
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
	return (root as Document | ShadowRoot).getElementById(id);
}

/** Set the element a popovertarget names, per HTML's element reflection. */
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

/**
 * Whether a node is a BUTTON as the popover target attributes mean it: the
 * button element, and the input types that render as buttons.
 */
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

/**
 * HTML's get the popover target element: the popover a node invokes. A button
 * that submits a form is not an invoker -- its activation is the submission,
 * and the attribute on it does nothing.
 */
function popoverTargetElementOf(node: Node): Element | null {
	if (!isPopoverInvokerButton(node)) {
		return null;
	}
	const element = node as Element;
	if (isActuallyDisabled(element)) {
		return null;
	}
	if (formOwner(element) !== null && isSubmitButton(element)) {
		return null;
	}
	const popover = popoverTargetAttributeElement(element);
	if (popover === null) {
		return null;
	}
	return popoverAttributeState(popover) === null ? null : popover;
}

/**
 * HTML's popover target attribute activation behavior: what a button with
 * popovertarget does when it is activated. `popovertargetaction` names which
 * half of the toggle to run, and a button inside the popover it targets does
 * nothing -- the click that reaches it is the popover's own.
 */
function popoverTargetActivationBehavior(node: Element, target: unknown): void {
	const popover = popoverTargetElementOf(node);
	if (popover === null) {
		return;
	}
	if (
		target instanceof Node &&
		isShadowIncludingInclusiveDescendant(target, popover) &&
		isShadowIncludingInclusiveDescendant(popover, node) &&
		popover !== node
	) {
		return;
	}
	const action = asciiLowercase(
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
	if (popoverValidity(popover, false, null) === true) {
		showPopover(popover, false, node);
	}
}

/** Whether a node is the element itself or renders anywhere beneath it. */
function isShadowIncludingInclusiveDescendant(
	node: Node,
	ancestor: Node,
): boolean {
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
/** The class each entry of the element table names. */
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

/**
 * Fill in the interfaces from the table: the members each reflects, the name
 * it stringifies as, and the tags an element of it is created for.
 */
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

/**
 * The ARIA mixin: every aria-* content attribute as a nullable string on the
 * element and on its internals.
 */
for (const [property, attribute] of ARIA_STRING_REFLECTIONS) {
	installReflection(Element.prototype, {
		property,
		attribute,
		kind: "nullable-string",
	});
}

/* ------------------------------------------------------------- data-* map */

/** The data-* attribute a property name of the map stands for. */
function datasetAttributeName(property: string): string {
	let name = "data-";
	for (const character of property) {
		if (character === "-") {
			throw domError(
				"SyntaxError",
				`"${property}" is not a name a data-* attribute has`,
			);
		}
		name +=
			character >= "A" && character <= "Z" ?
				`-${asciiLowercase(character)}` :
				character;
	}
	return name;
}

/** The property name a data-* attribute is reached under, or null. */
function datasetPropertyName(attribute: string): string | null {
	if (!attribute.startsWith("data-")) {
		return null;
	}
	let property = "";
	for (let index = 5; index < attribute.length; index++) {
		const character = attribute[index];
		if (character === "-" && index + 1 < attribute.length) {
			const next = attribute[index + 1];
			if (next >= "a" && next <= "z") {
				property += asciiUppercase(next);
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

/**
 * The data-* attributes of an element, keyed by the names they carry.
 *
 * Every attribute is an own accessor of the map, materialized when the map is
 * asked for and refreshed on each ask, so a read or a write of a name the
 * element carries goes straight through to the attribute.
 */
export class DOMStringMap {
	[kDatasetElement]?: Element;
	[kDatasetNames]?: string[];

	constructor(element: Element) {
		this[kDatasetNames] = [];
		this[kDatasetElement] = element;
	}
}

/** Bring the map's own properties into line with the element's attributes. */
function syncDataset(
	map: DOMStringMap,
): void {
	const element = map[kDatasetElement]!;
	const names: string[] = [];
	for (const attribute of element[kAttributeList]!) {
		if (attribute[kNamespace] !== null) {
			continue;
		}
		const property = datasetPropertyName(attribute[kLocalName]!);
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
		const attribute = datasetAttributeName(name);
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

/* ------------------------------------------------------------ form owners */

/** The elements a form can own, each of which reflects a form attribute. */
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

/** The form-associated elements a form lists in its `elements` collection. */
const LISTED_TAGS = new Set([
	"button",
	"fieldset",
	"input",
	"object",
	"output",
	"select",
	"textarea",
]);

/** The elements a label can label. */
const LABELABLE_TAGS = new Set([
	"button",
	"input",
	"meter",
	"output",
	"progress",
	"select",
	"textarea",
]);

/** The form controls that can be disabled by their own attribute. */
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

/** Whether an element is one a form owns: a built-in one, or a custom one. */
function isFormAssociated(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return true;
	}
	return isHTMLTag(element, FORM_ASSOCIATED_TAGS);
}

/** Whether an element is listed: it appears in its form's element list. */
function isListed(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return true;
	}
	return isHTMLTag(element, LISTED_TAGS);
}

/** Whether an element is a form-associated custom element. */
function isFormAssociatedCustom(element: Element): boolean {
	const definition = element[kDefinition]!;
	return (
		element[kCustomState] === "custom" &&
		definition !== null &&
		definition.formAssociated
	);
}

/** Whether a label can label the element. */
function isLabelable(element: Element): boolean {
	if (isFormAssociatedCustom(element)) {
		return true;
	}
	if (!isHTMLTag(element, LABELABLE_TAGS)) {
		return false;
	}
	return (
		element[kLocalName] !== "input" ||
		asciiLowercase(element.getAttribute("type") ?? "") !== "hidden"
	);
}

const kFormDisabled = Symbol("disabled by a fieldset or its own attribute");

/**
 * Whether a form control is disabled: by its own attribute, or by a fieldset
 * above it whose first legend does not contain the control.
 */
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
			isHTMLTag(parent, new Set(["optgroup"])) &&
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

/** Whether a disabled fieldset above an element disables it. */
function isDisabledByFieldSet(element: Element): boolean {
	for (
		let node: Node | null = element[kParent]!;
		node !== null;
		node = node[kParent]!
	) {
		if (!isHTMLTag(node, new Set(["fieldset"]))) {
			continue;
		}
		const fieldset = node as Element;
		if (!fieldset.hasAttribute("disabled")) {
			continue;
		}
		const legend = firstChildElement(fieldset, "legend");
		if (legend !== null && isInclusiveAncestor(legend, element)) {
			continue;
		}
		return true;
	}
	return false;
}

/**
 * The form that owns an element.
 *
 * The owner is computed from the tree each time rather than stored: a listed
 * element with a form attribute is owned by the form of that id in its tree,
 * and every other form-associated element is owned by its nearest form
 * ancestor. Both answers change only when the tree or the attribute does, so
 * reading them is the same as resetting the owner at every point the
 * specification does.
 */
function formOwner(element: Element): HTMLFormElement | null {
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

/**
 * Tell a form-associated custom element that its owner changed.
 *
 * The callback is the one place the owner has to be remembered, because it is
 * the change that is reported rather than the value.
 */
function refreshFormOwner(element: Element): void {
	if (!isFormAssociatedCustom(element)) {
		return;
	}
	const internals = element[kInternals]!;
	if (internals === null) {
		return;
	}
	const owner = formOwner(element);
	if (internals[kFormOwner] === owner) {
		return;
	}
	internals[kFormOwner] = owner;
	enqueueCallbackReaction(element, "formAssociatedCallback", [owner]);
}

/** Tell every form-associated custom element under a node about its owner. */
function refreshFormOwnersUnder(node: Node): void {
	for (const candidate of shadowIncludingInclusiveDescendants(node)) {
		if (candidate.nodeType !== ELEMENT_NODE) {
			continue;
		}
		refreshFormOwner(candidate as Element);
		refreshFormDisabled(candidate as Element);
	}
}

/**
 * Tell a form-associated custom element that it was disabled or enabled.
 *
 * The state is its own disabled attribute, or a fieldset above it that has
 * one; both are read from the tree, and the flag beside them is what makes a
 * change reportable rather than a value.
 */
function refreshFormDisabled(element: Element): void {
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

/* -------------------------------------------------------- element internals */

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

/** The ten constraints a control can fail, and whether it fails none. */
export class ValidityState {
	declare [kFlags]?: () => ValidityFlags;

	constructor(flags: () => ValidityFlags) {
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kFlags] = flags;
	}

	get [kValidityFlags](): ValidityFlags {
		return this[kFlags]!();
	}

	get valid(): boolean {
		const flags = this[kFlags]!();
		return !VALIDITY_FLAG_NAMES.some((name) => flags[name]);
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

/**
 * The states a custom element declares about itself.
 *
 * The set is the author's; a selector engine that knows `:state()` reads it,
 * and nothing else in this DOM does.
 */
export class CustomStateSet {
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
const kValidationAnchor = Symbol("validation anchor");
const kSubmissionValue = Symbol("submission value");
const kElementInternalsTarget = Symbol("the element an internals belongs to");

/**
 * A custom element's own handle on the parts of it the platform owns: its
 * shadow root, its form owner, the value it submits, its validity and the
 * accessibility properties it declares.
 */
export class ElementInternals {
	[kElementInternalsTarget]?: Element;
	[kFormOwner]?: HTMLFormElement | null;
	[kFormDisabled]?: boolean;
	[kSubmissionValue]?: unknown;
	[kValidityFlags]?: ValidityFlags;
	[kValidationMessage]?: string;
	[kValidationAnchor]?: HTMLElement | null;
	[kStates]?: CustomStateSet | null;
	declare [kValidity]?: ValidityState;

	constructor(target: Element) {
		this[kFormOwner] = null;
		this[kFormDisabled] = false;
		this[kSubmissionValue] = null;
		this[kValidityFlags] = noValidityFlags();
		this[kValidationMessage] = "";
		this[kValidationAnchor] = null;
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
		return formOwner(this[kElementInternalsTarget]!);
	}

	get labels(): NodeList {
		requireFormAssociated(this);
		return labelsOf(this[kElementInternalsTarget]!);
	}

	get states(): CustomStateSet {
		let states = this[kStates]!;
		if (states === null) {
			states = constructInternal(() => new CustomStateSet());
			this[kStates] = states;
		}
		return states;
	}

	setFormValue(value: unknown, state?: unknown): void {
		if (arguments.length < 1) {
			throw new TypeError("setFormValue needs a value");
		}
		requireFormAssociated(this);
		this[kSubmissionValue] =
			value === null || value === undefined ?
				null :
				typeof value === "object" ?
					value :
						String(value);
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
		this[kValidationAnchor] = anchor ?? null;
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

	checkValidity(): boolean {
		requireFormAssociated(this);
		return checkValidity(this[kElementInternalsTarget]!);
	}

	reportValidity(): boolean {
		requireFormAssociated(this);
		return checkValidity(this[kElementInternalsTarget]!);
	}
}

function requireFormAssociated(
	internals: ElementInternals,
): void {
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

/**
 * Whether an element a caller named is one this element may point at: it has
 * to sit in this element's tree, or in a tree above it.
 */
function isReachableARIATarget(from: Element, target: Element): boolean {
	const fromRoot = getRoot(from);
	for (
		let root: Node | null = getRoot(target);
		root !== null;
		root = isShadowRoot(root) ?
				getRoot((root as ShadowRoot)[kHost]! as Node) :
			null
	) {
		if (root === fromRoot) {
			return true;
		}
	}
	return false;
}

/** The elements an attribute's identifiers name, in the element's own tree. */
function ariaTargetsFromAttribute(
	element: Element,
	attribute: string,
): Element[] | null {
	const value = element.getAttribute(attribute);
	// No attribute and no elements handed over is no reflected target at all,
	// which reads back as null rather than as an empty list.
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

/** The elements a reflecting member answers with, explicit ones first. */
function ariaTargets(
	element: Element,
	property: string,
	attribute: string,
): Element[] | null {
	const explicit = element[kARIAElements]?.get(property);
	if (explicit === undefined) {
		return ariaTargetsFromAttribute(element, attribute);
	}
	return explicit.filter((target) => isReachableARIATarget(element, target));
}

/** Remember the elements a caller named, and mark the attribute as set. */
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

/**
 * The ARIA mixin's element references.
 *
 * A member answers with the elements a caller last handed it, or with the
 * ones the attribute's identifiers name where none were handed over; an
 * element that has drifted out of reach drops out of the answer.
 */
for (const [property, attribute, many] of ARIA_ELEMENT_REFLECTIONS) {
	const descriptor: PropertyDescriptor = {
		get(this: Element): Element | readonly Element[] | null {
			const targets = ariaTargets(this, property, attribute);
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
			const targets = ariaTargets(target, property, attribute);
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

/** The internals of an element, which only a custom element's own class takes. */
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

/** The labels whose control an element is. */
function labelsOf(element: Element): NodeList {
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

/** Whether an element is a candidate for constraint validation. */
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
		if (isHTMLTag(node, new Set(["datalist"]))) {
			return false;
		}
	}
	return true;
}

/** Whether an element satisfies its constraints, reporting an invalid event. */
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

/* ------------------------------------------------- user-agent pseudo-elements */

/**
 * The pseudo-element slots an element carries.
 *
 * A ::before, ::after or ::marker box needs a node to hang style and children
 * off, and the engine's paint walk needs to reach it; the DOM Standard has
 * no such node, and an author must never find one. These live in a map keyed
 * by the pseudo-element's name, reachable only through the functions
 * below, which the engine's composition pass is the sole caller of. Nothing
 * links them into the tree: their parent stays null, so childNodes, the tree
 * walkers, the collections and the selector engine cannot reach them, and no
 * mutation record or slot assignment ever names one.
 *
 * The element a slot holds is an ordinary Element of the host's document, so
 * everything the engine already does with an element -- computed style, a box,
 * text children -- works on it unchanged.
 */
function pseudoElement<T>(host: object, name: string): T | null {
	const slots = (host as Element)[kPseudoElements]!;
	return slots === null || slots === undefined ?
		null :
			((slots.get(name) as T) ?? null);
}

/** How many pseudo-element nodes an element carries. */
export function pseudoElementCount(host: object): number {
	const slots = (host as Element)[kPseudoElements]!;
	return slots === null || slots === undefined ? 0 : slots.size;
}

/**
 * The element a pseudo-element slot belongs to, and the name it fills. Null for
 * every other node: this is what tells a pseudo-element node apart, and where
 * the flat tree finds the parent a node with no parent renders inside.
 */
function pseudoHostOf<T>(node: object): T | null {
	return ((node as Element)[kPseudoHost]! as T) ?? null;
}

/** The pseudo-element name a slot node fills, such as "::before". */
function pseudoNameOf(node: object): string | null {
	return (node as Element)[kPseudoName]!;
}

/**
 * Give an element its pseudo-element node for a name, building one the first
 * time it is asked for. The node is an element named after the pseudo-element
 * so a debugger's dump reads plainly; it is never serialized.
 */
function ensurePseudoElement<T>(target: object, name: string): T {
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

/** Drop an element's pseudo-element node for a name. */
function clearPseudoElement(host: object, name: string): void {
	(host as Element)[kPseudoElements]?.delete(name);
}

/* -------------------------------------------------------------- flat tree */

/**
 * The flat tree: the tree a renderer draws, which the DOM Standard's node tree
 * is only one input to. Four things separate it from the node tree, and all
 * four are answered here rather than by any caller:
 *
 * - a host's children are its shadow tree's, and only those;
 * - a slot's children are the nodes assigned to it, and its own children only
 *   as the fallback shown when nothing is;
 * - a pseudo-element slot's node stands between an element and its children,
 *   ::marker first, then ::before, with ::after after the last of them;
 * - a node the box tree DISSOLVES contributes its children in its own place.
 *
 * Nothing is memoized. Every hop reads the same links the mutation algorithms
 * maintain -- the stored slot assignment, not the recomputed one an author's
 * `assignedSlot` reports -- so a walk cannot answer from a tree that has moved.
 */

/** The slot a node is assigned to: the stored assignment, closed trees too. */
function assignedSlotOf(node: Node): HTMLSlotElement | null {
	const type = node.nodeType;
	return type === ELEMENT_NODE || type === TEXT_NODE ?
			(node as Slottable)[kAssignedSlot]! :
		null;
}

/**
 * The FLAT-TREE parent element of a node: the element it renders inside, which
 * is also the element style inheritance flows from. Three cases diverge from
 * parentElement -- a projected node's flat parent is its SLOT, a shadow root's
 * child resolves to the HOST, and a pseudo-element node's is the element it
 * originates from -- and everything else is parentElement.
 */
export function flatParentElement<T>(target: object): T | null {
	const node = target as Node;
	const slot = assignedSlotOf(node);
	if (slot !== null) {
		return slot as unknown as T;
	}
	const parent = node[kParent]!;
	if (parent !== null) {
		if (parent.nodeType === ELEMENT_NODE) {
			return parent as unknown as T;
		}
		return isShadowRoot(parent) ?
				((parent as ShadowRoot)[kHost]! as unknown as T) :
			null;
	}
	return ((node as Element)[kPseudoHost]! as T) ?? null;
}

/**
 * Whether a node renders: it is in the document, or the flat tree above it
 * reaches one. A pseudo-element node and a UA shadow tree's contents are both
 * outside the node tree that answers `isConnected` and both render.
 */
export function flatIsConnected(target: object): boolean {
	let node: Node | null = target as Node;
	while (node !== null) {
		if (isConnectedNode(node)) {
			return true;
		}
		node = flatParentElement<Node>(node);
	}
	return false;
}

/* ------------------------------------------------------------ tree walking */

/**
 * The tree a walk runs over. Every hop below asks this and takes the node
 * tree's links or the flat tree's accordingly -- the flat tree being shadow
 * content in its slot's place, and pseudo-element slots among the children
 * they belong beside, neither of which is a link a node carries.
 */
function isFlat(walk: TreeWalker): boolean {
	return (walk[kWhatToShow]! & SHOW_FLAT) !== 0;
}

function hopParent(walk: TreeWalker, node: Node): Node | null {
	return isFlat(walk) ? composedParentNode(node) : node[kParent]!;
}

function hopFirstChild(walk: TreeWalker, node: Node): Node | null {
	return isFlat(walk) ? composedFirstChild(node) : node[kFirstChild]!;
}

function hopLastChild(walk: TreeWalker, node: Node): Node | null {
	return isFlat(walk) ? composedLastChild(node) : node[kLastChild]!;
}

function hopNextSibling(walk: TreeWalker, node: Node): Node | null {
	return isFlat(walk) ? composedNextSibling(node) : node[kNext]!;
}

function hopPreviousSibling(walk: TreeWalker, node: Node): Node | null {
	return isFlat(walk) ? composedPreviousSibling(node) : node[kPrevious]!;
}

/** DOM Standard, "traverse children". */
function walkChildren(walk: TreeWalker, first: boolean): Node | null {
	let node: Node | null =
		first ?
				hopFirstChild(walk, walk[kCurrent]!) :
				hopLastChild(walk, walk[kCurrent]!);
	while (node !== null) {
		const result = filterNode(walk[kState]!, node);
		if (result === FILTER_ACCEPT) {
			walk[kCurrent] = node;
			return node;
		}
		if (result === FILTER_SKIP) {
			const child =
				first ? hopFirstChild(walk, node) : hopLastChild(walk, node);
			if (child !== null) {
				node = child;
				continue;
			}
		}
		for (;;) {
			const sibling =
				first ?
						hopNextSibling(walk, node) :
						hopPreviousSibling(walk, node);
			if (sibling !== null) {
				node = sibling;
				break;
			}
			const parent: Node | null = hopParent(walk, node);
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

/**
 * DOM Standard, "traverse siblings". A walk rooted at a node never visits that
 * node's siblings: returning one escapes the subtree the walk was scoped to,
 * which is how an empty inline element came to measure the width of the
 * sibling after it.
 */
function walkSiblings(walk: TreeWalker, next: boolean): Node | null {
	let node = walk[kCurrent]!;
	if (node === walk[kRoot]!) {
		return null;
	}
	for (;;) {
		let sibling =
			next ? hopNextSibling(walk, node) : hopPreviousSibling(walk, node);
		while (sibling !== null) {
			node = sibling;
			const result = filterNode(walk[kState]!, node);
			if (result === FILTER_ACCEPT) {
				walk[kCurrent] = node;
				return node;
			}
			sibling =
				next ? hopFirstChild(walk, node) : hopLastChild(walk, node);
			if (result === FILTER_REJECT || sibling === null) {
				sibling =
					next ?
							hopNextSibling(walk, node) :
							hopPreviousSibling(walk, node);
			}
		}
		const parent = hopParent(walk, node);
		if (parent === null || parent === walk[kRoot]!) {
			return null;
		}
		node = parent;
		if (filterNode(walk[kState]!, node) === FILTER_ACCEPT) {
			return null;
		}
	}
}

/** DOM Standard, TreeWalker's `parentNode()`. */
function walkParent(walk: TreeWalker): Node | null {
	let node: Node | null = walk[kCurrent]!;
	while (node !== null && node !== walk[kRoot]!) {
		node = hopParent(walk, node);
		if (node !== null && filterNode(walk[kState]!, node) === FILTER_ACCEPT) {
			walk[kCurrent] = node;
			return node;
		}
	}
	return null;
}

/**
 * DOM Standard, TreeWalker's `nextNode()`: down to the first child, else on to
 * the next sibling, else up until some level has one. The climb asks each level
 * for its OWN next sibling, starting at the node itself, which is what lets a
 * hop answer for the level it is asked about -- an element's ::after follows
 * the last of its content, and the flat hops hand it back at that step.
 */
function walkNext(walk: TreeWalker): Node | null {
	let node = walk[kCurrent]!;
	let result = FILTER_ACCEPT;
	for (;;) {
		while (result !== FILTER_REJECT) {
			const child = hopFirstChild(walk, node);
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
			sibling = hopNextSibling(walk, temporary);
			if (sibling !== null) {
				break;
			}
			temporary = hopParent(walk, temporary);
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

/** DOM Standard, TreeWalker's `previousNode()`. */
function walkPrevious(walk: TreeWalker): Node | null {
	let node = walk[kCurrent]!;
	while (node !== walk[kRoot]!) {
		let sibling = hopPreviousSibling(walk, node);
		while (sibling !== null) {
			node = sibling;
			let result = filterNode(walk[kState]!, node);
			for (;;) {
				if (result === FILTER_REJECT) {
					break;
				}
				const child = hopLastChild(walk, node);
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
			sibling = hopPreviousSibling(walk, node);
		}
		const parent = hopParent(walk, node);
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

/**
 * A TreeWalker's surface, in whatever node type the caller works in. The
 * toolkit hands nodes across as `object`, so a consumer that has its own Node
 * type gets the walk back through this rather than through the class.
 */
export interface Walker<N> {
	readonly root: N;
	currentNode: N;
	nextNode(): N | null;
	previousNode(): N | null;
	parentNode(): N | null;
	firstChild(): N | null;
	lastChild(): N | null;
	nextSibling(): N | null;
	previousSibling(): N | null;
}

/* The dissolving layer: composed hops with the caller's dissolved elements
   spliced away, so their children join the parent's child sequence. This is
   how a <slot> disappears from a box tree while its projected content flows
   through. */
function pseudoSlot(element: Element, name: string): Element | null {
	const slots = element[kPseudoElements]!;
	return slots === null ? null : (slots.get(name) ?? null);
}

/* The composed hops: the flat tree before any dissolving. */

function composedFirstChild(node: Node): Node | null {
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
	const composed = composedContentFirstChild(element);
	if (composed !== null) {
		return composed;
	}
	// A CHILDLESS element still renders its ::after: the sibling transition
	// only reaches ::after from a last child, which there is none of here, so
	// for an empty element the pseudo-element IS the content.
	return slots === null ? null : (slots.get("::after") ?? null);
}

/**
 * An element's composed content, pseudo-elements aside: its shadow tree's
 * children when it hosts one -- and ONLY those, an empty tree meaning an empty
 * element, since light children render solely through slots -- a slot's
 * assigned nodes when it has any, and its own children otherwise (which for a
 * slot is the fallback content).
 */
function composedContentFirstChild(element: Element): Node | null {
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

function composedLastChild(node: Node): Node | null {
	if (node.nodeType !== ELEMENT_NODE) {
		return node[kLastChild]!;
	}
	const element = node as Element;
	const after = pseudoSlot(element, "::after");
	return after !== null ? after : composedLastContent(element);
}

/**
 * Mirror of composedContentFirstChild: an element's composed content from the
 * end, pseudo-elements aside -- its shadow tree's last child when it hosts
 * one, a slot's last assigned node when it has any, and its own last child
 * otherwise. This is what a ::after follows, which is why it is separate from
 * composedLastChild, whose answer IS the ::after when there is one.
 */
function composedLastContent(element: Element): Node | null {
	const child = lastRenderedChild(element);
	if (child !== null) {
		return child;
	}
	// An element with no content of its own still renders its ::before and its
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

/**
 * Mirror of composedContentFirstChild: the last child an element renders --
 * its shadow tree's, a slot's last assigned node, or its own. A host with an
 * empty shadow tree renders nothing of its own, light children included.
 */
function lastRenderedChild(element: Element): Node | null {
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

function composedNextSibling(node: Node): Node | null {
	const host = (node as Element)[kPseudoHost]!;
	if (host !== null && host !== undefined) {
		const name = (node as Element)[kPseudoName]!;
		if (name === "::marker") {
			const before = pseudoSlot(host, "::before");
			if (before !== null) {
				return before;
			}
		}
		if (name !== "::after") {
			const content = composedContentFirstChild(host);
			return content !== null ? content : pseudoSlot(host, "::after");
		}
		return null;
	}

	// A projected node's composed siblings are its neighbours in the slot's
	// assigned-node list, NOT its light-tree siblings: the light nextSibling
	// may be assigned to a different slot, or to none.
	const slot = assignedSlotOf(node);
	if (slot !== null) {
		const assigned = slot[kAssignedNodes]!;
		const index = assigned.indexOf(node as Slottable);
		if (index < 0) {
			return null;
		}
		// The last projected node is followed by the slot's ::after, exactly as
		// the last of any other element's content is.
		return index < assigned.length - 1 ?
			assigned[index + 1] :
				pseudoSlot(slot, "::after");
	}

	const next = node[kNext]!;
	if (next !== null) {
		return next;
	}

	// The last of an element's content is followed by its ::after -- the
	// COMPOSED parent's, so that climbing out of a shadow root reaches the
	// host's. A shadowed element's ::after follows its shadow content, and
	// the node tree cannot say so: it puts the shadow root between them.
	const parent = composedParentNode(node);
	if (parent !== null && parent.nodeType === ELEMENT_NODE) {
		return pseudoSlot(parent as Element, "::after");
	}
	return null;
}

function composedPreviousSibling(node: Node): Node | null {
	const host = (node as Element)[kPseudoHost]!;
	if (host !== null && host !== undefined) {
		const name = (node as Element)[kPseudoName]!;
		if (name === "::after") {
			return composedLastContent(host);
		}
		if (name === "::before") {
			return pseudoSlot(host, "::marker");
		}
		return null;
	}

	const slot = assignedSlotOf(node);
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
		const before = pseudoSlot(slot, "::before");
		return before !== null ? before : pseudoSlot(slot, "::marker");
	}

	const previous = node[kPrevious]!;
	if (previous !== null) {
		return previous;
	}

	// Mirror of the ::after hop: the composed parent, so walking backwards out
	// of a shadow root reaches the host's ::before and ::marker.
	const parent = composedParentNode(node);
	if (parent !== null && parent.nodeType === ELEMENT_NODE) {
		const before = pseudoSlot(parent as Element, "::before");
		if (before !== null) {
			return before;
		}
		return pseudoSlot(parent as Element, "::marker");
	}
	return null;
}

function composedParentNode(node: Node): Node | null {
	const host = (node as Element)[kPseudoHost]!;
	if (host !== null && host !== undefined) {
		return host;
	}
	const slot = assignedSlotOf(node);
	if (slot !== null) {
		return slot;
	}
	const parent = node[kParent]!;
	if (parent !== null && isShadowRoot(parent)) {
		return (parent as ShadowRoot)[kHost]!;
	}
	return parent;
}

/* --------------------------------------------------------------- geometry */

const kRectValues = Symbol("rectangle origin and size");

/**
 * A rectangle, as Geometry Interfaces defines it: an origin and a size, with
 * the four edges derived. A negative width or height puts left right of right,
 * so the edges take the minimum and the maximum rather than assuming an order.
 */
export class DOMRectReadOnly {
	[kRectValues]?: {x: number; y: number; width: number; height: number};

	constructor(x = 0, y = 0, width = 0, height = 0) {
		this[kRectValues] = {
			x: Number(x) || 0,
			y: Number(y) || 0,
			width: Number(width) || 0,
			height: Number(height) || 0,
		};
	}

	static fromRect(other: DOMRectInit = {}): DOMRectReadOnly {
		return new DOMRectReadOnly(other.x, other.y, other.width, other.height);
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

/** A rectangle whose origin and size can be written. */
export class DOMRect extends DOMRectReadOnly {
	static override fromRect(other: DOMRectInit = {}): DOMRect {
		return new DOMRect(other.x, other.y, other.width, other.height);
	}

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

/**
 * An element's content box: its size, plus the offset of its top-left corner
 * INSIDE the border box -- the padding and border that precede it.
 *
 * Deliberately not a rect. `top`/`left` are a distance from the border edge,
 * not a position in the document, and calling it a DOMRect would invite
 * exactly the arithmetic (comparing it against a border box, intersecting it
 * with the viewport) that its coordinates cannot support. ResizeObserver
 * reports these four numbers as contentRect, which is where the confusion
 * comes from in the first place.
 */
interface ContentBox {
	width: number;
	height: number;
	top: number;
	left: number;
}

/**
 * ResizeObserver's contentRect: an element's content box, or null when it
 * generates no box at all (display:none or detached) -- reported as "nothing",
 * which the observer turns into an all-zero rect.
 */
function contentBoxOf(
	element: globalThis.Element,
	layoutEngine: LayoutEngine,
): ContentBox | null {
	const border = layoutEngine.getRect(element);
	const content = layoutEngine.contentRect(element);
	if (!border || !content) {
		return null;
	}
	// Origin relative to the border box: what precedes the content on each axis.
	return {
		width: content.width,
		height: content.height,
		top: content.y - border.y,
		left: content.x - border.x,
	};
}

// Symbol-keyed rather than named: these are subclass hooks and shared state,
// and author code must never see any of them on an observer it holds.
const kTargets = Symbol("targets");
const kHomes = Symbol("homes");
const kMeasure = Symbol("measure");
const kDeliver = Symbol("deliver");
const kObserverCallback = Symbol("observer callback");

/**
 * The observers a document has to run: the ones holding at least one of its
 * elements. A document, not a registry object, is what an observer can reach
 * from the target it was handed, which is why `new ResizeObserver(callback)`
 * needs nothing but its callback.
 */
const documentObservers = new WeakMap<object, Set<AnyObserver>>();

function observersOf(document: object): Set<AnyObserver> {
	let observers = documentObservers.get(document);
	if (observers === undefined) {
		observers = new Set<AnyObserver>();
		documentObservers.set(document, observers);
	}
	return observers;
}

/**
 * Run a document's observers against the layout just computed for it. The
 * frame the renderer is finishing is what an IntersectionObserver measures
 * against and what a ResizeObserver reports the time of.
 */
export function flushObservers(
	document: object,
	layoutEngine: LayoutEngine,
	viewport: globalThis.DOMRect,
	frame: number,
): void {
	const observers = documentObservers.get(document);
	if (observers === undefined || observers.size === 0) {
		return;
	}
	// A copy: a callback may observe or disconnect, and mutating the set
	// mid-iteration would visit the new observer against a layout it has not
	// been measured for, or skip one that is still live.
	for (const observer of [...observers]) {
		checkObserver(observer, layoutEngine, viewport, frame);
	}
}

/** Drop a document's observers, so a torn-down document delivers nothing. */
export function disconnectObservers(document: object): void {
	documentObservers.get(document)?.clear();
}

/**
 * The half of an observer that is identical between the two: which elements are
 * watched, what was last reported for each, and registration with the manager.
 *
 * Subclasses supply only how to measure one target (kMeasure) and how to build
 * an entry from that measurement, which is the whole of what differs.
 */
abstract class LayoutObserver<TState, TEntry, TOptions = void> {
	/**
	 * Observed targets, each mapped to how it was asked to be observed and to
	 * what was last reported for it. One entry per target, as the DOM says: a
	 * second observe() of the same target replaces the first's options.
	 */
	[kTargets]?: Map<
		globalThis.Element,
		{options: TOptions | undefined; last: TState | null}
	>;

	/** The documents running this observer, one per document it has a target in. */
	[kHomes]?: Set<Set<AnyObserver>>;

	constructor() {
		this[kTargets] = new Map<
			globalThis.Element,
			{options: TOptions | undefined; last: TState | null}
		>();
		this[kHomes] = new Set<Set<AnyObserver>>();
	}

	observe(target: globalThis.Element, options?: TOptions): void {
		// A fresh target has no last state, so its first measurement always counts
		// as a change -- which is what fires the initial callback the DOM promises.
		this[kTargets]!.set(target, {
			options,
			last: this[kTargets]!.get(target)?.last ?? null,
		});
		const document = target.ownerDocument;
		if (document === null) {
			return;
		}
		const observers = observersOf(document);
		observers.add(this as unknown as AnyObserver);
		this[kHomes]!.add(observers);
	}

	unobserve(target: globalThis.Element): void {
		this[kTargets]!.delete(target);
		if (this[kTargets]!.size === 0) {
			this.disconnect();
		}
	}

	disconnect(): void {
		this[kTargets]!.clear();
		for (const observers of this[kHomes]!) {
			observers.delete(this as unknown as AnyObserver);
		}
		this[kHomes]!.clear();
	}

	/**
	 * Records are computed and delivered in the same pass (see the manager's
	 * flush), so nothing is ever queued undelivered and this is always empty.
	 * Present because the DOM has it and code checks for it.
	 */
	takeRecords(): TEntry[] {
		return [];
	}

	/** Measure one target: its new state, and the entry to report, or null. */
	abstract [kMeasure]?(
		target: globalThis.Element,
		last: TState | null,
		layoutEngine: LayoutEngine,
		viewport: globalThis.DOMRect,
		frame: number,
		options: TOptions | undefined,
	): {state: TState; entry: TEntry} | null;

	abstract [kDeliver]?(entries: TEntry[]): void;
}

function checkObserver<TState, TEntry, TOptions = void>(
	observer: LayoutObserver<TState, TEntry, TOptions>,
	layoutEngine: LayoutEngine,
	viewport: globalThis.DOMRect,
	frame: number,
): void {
	const entries: TEntry[] = [];
	for (const [target, observation] of observer[kTargets]!) {
		const result = observer[kMeasure]!(
			target,
			observation.last,
			layoutEngine,
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
		observer[kDeliver]!(entries);
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
	contentBoxSize: readonly ResizeObserverSize[];
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

/** The boxes an observation can watch, as the DOM enumerates them. */
const RESIZE_BOXES = new Set([
	"border-box",
	"content-box",
	"device-pixel-content-box",
]);

interface ResizeObserverOptions {
	box?: string;
}

export class ResizeObserver extends LayoutObserver<
	ResizeSize,
	ResizeObserverEntry,
	ResizeObserverOptions
> {
	declare [kObserverCallback]?: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		super();
		this[kObserverCallback] = callback;
	}

	/**
	 * `box` names which box's size change is worth reporting; every entry still
	 * carries all of them, as the DOM says. An unrecognized value is not a box
	 * this DOM quietly ignores -- the enumeration rejects it, as WebIDL does.
	 */
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

	[kMeasure]?(
		target: globalThis.Element,
		last: ResizeSize | null,
		layoutEngine: LayoutEngine,
		_viewport: globalThis.DOMRect,
		_frame: number,
		options: ResizeObserverOptions | undefined,
	): {state: ResizeSize; entry: ResizeObserverEntry} | null {
		// An element with no box -- display:none, or detached -- has a size, and
		// that size is zero. Reporting it is how the DOM lets a component notice
		// it has been hidden; skipping it stranded the last size it ever had.
		const content = contentBoxOf(target, layoutEngine) ?? {
			width: 0,
			height: 0,
			top: 0,
			left: 0,
		};

		const border = layoutEngine.getRect(target);
		// device-pixel-content-box is the content box: a cell is the device
		// pixel here, so the two can never diverge.
		const watched =
			options?.box === "border-box" ?
					{
						width: border?.width ?? content.width,
						height: border?.height ?? content.height,
					} :
					{width: content.width, height: content.height};

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
				// Origin is the content box's offset inside the border box -- the
				// padding and border that precede it -- not zero.
				contentRect: new DOMRect(
					content.left,
					content.top,
					content.width,
					content.height,
				),
				contentBoxSize: [box],
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

	[kDeliver]?(entries: ResizeObserverEntry[]): void {
		this[kObserverCallback]!(entries, this);
	}
}

interface IntersectionObserverInit {
	root?: globalThis.Element | null;
	rootMargin?: string;
	threshold?: number | number[];
}

interface IntersectionObserverEntry {
	target: globalThis.Element;
	isIntersecting: boolean;
	intersectionRatio: number;
	boundingClientRect: globalThis.DOMRect;
	intersectionRect: globalThis.DOMRect;
	rootBounds: globalThis.DOMRect | null;
	time: number;
}

type IntersectionObserverCallback = (
	entries: IntersectionObserverEntry[],
	observer: IntersectionObserver,
) => void;

/** Fraction of `box` that lies within `clip`, from 0 (disjoint) to 1 (contained). */
function intersectionRatio(
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

/**
 * Grow (or shrink) a rect by a CSS margin shorthand, per the root-margin rules:
 * one to four lengths, in the order top, right, bottom, left.
 *
 * Lengths are cells, whichever unit is written: a row vertically, a column
 * horizontally. `px` and `ch` therefore mean the same thing here, which is the
 * same equivalence the rest of termdom's box model makes. Percentages are
 * resolved against the root's own size, as the spec requires.
 */
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

const kIntersectionRoot = Symbol("intersection root");

export class IntersectionObserver extends LayoutObserver<
	number,
	IntersectionObserverEntry
> {
	declare [kObserverCallback]?: IntersectionObserverCallback;
	declare [kIntersectionRoot]?: globalThis.Element | null;

	readonly rootMargin: string;
	readonly thresholds: readonly number[];

	constructor(
		callback: IntersectionObserverCallback,
		init: IntersectionObserverInit = {},
	) {
		super();
		this[kObserverCallback] = callback;
		this[kIntersectionRoot] = init.root ?? null;
		this.rootMargin = init.rootMargin ?? "0px";

		// A single number, an array, or the default of "any intersection at all".
		const t = init.threshold ?? 0;
		this.thresholds = Object.freeze(
			(Array.isArray(t) ? [...t] : [t]).sort((a, b) => a - b),
		);
	}

	get root(): globalThis.Element | null {
		return this[kIntersectionRoot]!;
	}

	[kMeasure]?(
		target: globalThis.Element,
		last: number | null,
		layoutEngine: LayoutEngine,
		viewport: globalThis.DOMRect,
		frame: number,
	): {state: number; entry: IntersectionObserverEntry} | null {
		const box = layoutEngine.getRect(target);
		if (!box) {
			return null;
		}

		// The root: an explicit element's border box, or the viewport. Either way
		// grown by rootMargin, which is the whole point of that option -- it is
		// what lets a list start loading a row before it scrolls into view.
		const rootBox =
			this[kIntersectionRoot]! ?
					layoutEngine.getRect(this[kIntersectionRoot]!) :
				viewport;
		if (!rootBox) {
			return null;
		}
		const rootBounds = applyRootMargin(rootBox, this.rootMargin);

		const {ratio, rect} = intersectionRatio(box, rootBounds);
		const index = thresholdIndex(this, ratio);
		if (last === index) {
			return null;
		}

		return {
			state: index,
			entry: {
				target,
				isIntersecting: index > 0,
				intersectionRatio: ratio,
				boundingClientRect: box,
				intersectionRect:
					index > 0 ? rect : new DOMRect(0, 0, 0, 0),
				rootBounds,
				time: frame,
			},
		};
	}

	[kDeliver]?(entries: IntersectionObserverEntry[]): void {
		this[kObserverCallback]!(entries, this);
	}
}

/**
 * How many thresholds the ratio has reached, which is what the spec actually
 * watches: an observation fires when this CHANGES, so a target scrolling
 * through `[0, 0.5, 1]` reports at each step. Tracking only the boolean
 * "is it intersecting" collapsed all of those into one callback and made
 * threshold arrays decorative.
 */
function thresholdIndex(observer: IntersectionObserver, ratio: number): number {
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

/* --------------------------------------------------------------- document */

let currentDocumentForConstruction: Document | null = null;
let ambientDocument: Document | null = null;

/**
 * The document a constructor with no document of its own belongs to.
 *
 * With no window there is no "current global object", so a bare `new Text()`
 * belongs to whichever document was last made ambient, or to one made here.
 */
function currentDocument(): Document {
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
const kNwsapi = Symbol("selector engine");

export class Document extends Node {
	// Installed on the prototype, where the mount that answers them is.
	declare elementFromPoint: (x: number, y: number) => Element | null;
	declare elementsFromPoint: (x: number, y: number) => Element[];

	constructor(...args: ConstructorParameters<typeof Node>) {
		super(...args);
		this[kDocumentURL] = "about:blank";
		this[kMode] = "no-quirks";
		this[kType] = "xml";
		this[kContentType] = "application/xml";
		this[kEncoding] = "UTF-8";
		this[kIdMap] = new Map<string, Element[]>();
		this[kSelection] = null;
		this[kSelectionChangeScheduled] = false;
		this[kNwsapi] = null;
		this[kTemplateDocument] = null;
		this[kActiveElement] = null;
		this[kDefaultView] = null;
		this[kStyleElements] = 0;
		this[kChildren] = null;
		this[kTopLayer] = new Set<Element>();
		this[kPopoverShowing] = false;
		this[kPopoverHidingCount] = 0;
		this[kImplementation] = null;
		this[kWideLists] = null;
	}

	[kDocumentURL]?: string;
	[kMode]?: "no-quirks" | "quirks" | "limited-quirks";
	[kType]?: "xml" | "html";
	[kContentType]?: string;
	[kEncoding]?: string;
	[kIdMap]?: Map<string, Element[]>;
	[kWideLists]?: Set<Materializable> | null;

	[kSelection]?: Selection | null;
	[kSelectionChangeScheduled]?: boolean;
	[kNwsapi]?: ReturnType<typeof NWSAPI> | null;
	[kTemplateDocument]?: Document | null;
	[kActiveElement]?: Element | null;
	[kDefaultView]?: object | null;
	[kStyleElements]?: number;
	[kChildren]?: HTMLCollection | null;
	[kTopLayer]?: Set<Element>;
	// The reentrancy guards the popover algorithms hold on the document: one
	// popover opening at a time, and a count of the ones closing under it.
	[kPopoverShowing]?: boolean;
	[kPopoverHidingCount]?: number;

	/** Parse a document, declarative shadow roots included. */
	static parseHTMLUnsafe(html: string): Document {
		return parseHTMLUnsafe(String(html));
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

	get implementation(): DOMImplementation {
		let implementation = this[kImplementation]!;
		if (implementation === null) {
			implementation = new DOMImplementation(this);
			this[kImplementation] = implementation;
		}
		return implementation;
	}

	declare [kImplementation]?: DOMImplementation | null;

	get doctype(): DocumentType | null {
		for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType === DOCUMENT_TYPE_NODE) {
				return node as DocumentType;
			}
		}
		return null;
	}

	/**
	 * The window this document is displayed in, which is null until an
	 * environment mounts the document in one. A document with no browsing
	 * context has none, and nothing in this DOM creates one.
	 */
	get defaultView(): object | null {
		return this[kDefaultView]!;
	}

	/**
	 * The element focus is on, which is the body whenever nothing else holds
	 * it. An element that leaves the tree takes focus with it and hands it
	 * back to the body.
	 */
	get activeElement(): Element | null {
		const active = this[kActiveElement]!;
		if (active === null || !active.isConnected) {
			this[kActiveElement] = null;
			return this.body;
		}
		// RETARGET to this scope, per HTML: focus inside a shadow tree reads
		// as the host from the document; the tree's own root answers with
		// the real element through ShadowRoot.activeElement.
		let current: Node = active;
		for (;;) {
			const root = getRoot(current);
			if (root === (this as Node)) {
				return current as Element;
			}
			if (root instanceof ShadowRoot && root.host !== null) {
				current = root.host as unknown as Node;
				continue;
			}
			this[kActiveElement] = null;
			return this.body;
		}
	}

	/** Whether the document's window has the system focus, which it always has. */
	hasFocus(): boolean {
		return true;
	}

	/** The element filling the viewport, or null when none is. */
	get fullscreenElement(): Element | null {
		return (mountOf(this)?.fullscreenElement(this) ?? null) as Element | null;
	}

	/** Return the fullscreen element to the flow it came from. */
	exitFullscreen(): Promise<void> {
		const engine = mountOf(this);
		if (engine === undefined) {
			return Promise.reject(
				new TypeError("The document is not displayed"),
			);
		}
		return engine.exitFullscreen(this);
	}

	/**
	 * Close the document, which flushes an open parse.
	 *
	 * There is no document.open() here, so there is never a parse to flush.
	 * A displayed document finalizes as it closes: what it painted is sealed
	 * into the terminal's scrollback, and a later mutation starts a fresh
	 * document below the sealed block.
	 */
	close(): void {
		mountOf(this)?.documentClosed();
	}

	get customElementRegistry(): CustomElementRegistry | null {
		return this[kRegistry]!;
	}

	get location(): null {
		return null;
	}

	/**
	 * head, body and title come from the HTML Standard, not the DOM Standard.
	 * They are here because a document with no way to name its body is not a
	 * document any DOM test can be written against; each follows the HTML
	 * Standard's own definition.
	 */
	get head(): Element | null {
		const root = this.documentElement;
		if (root === null) {
			return null;
		}
		for (let node = root[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				(node as Element)[kLocalName] === "head"
			) {
				return node as Element;
			}
		}
		return null;
	}

	get body(): Element | null {
		const root = this.documentElement;
		if (root === null) {
			return null;
		}
		for (let node = root[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (
				node.nodeType === ELEMENT_NODE &&
				(node as Element)[kNamespace] === HTML_NAMESPACE &&
				((node as Element)[kLocalName] === "body" ||
					(node as Element)[kLocalName] === "frameset")
			) {
				return node as Element;
			}
		}
		return null;
	}

	set body(value: Element | null) {
		if (
			value == null ||
			value.nodeType !== ELEMENT_NODE ||
			value[kNamespace] !== HTML_NAMESPACE ||
			(value[kLocalName] !== "body" && value[kLocalName] !== "frameset")
		) {
			throw hierarchyRequestError("That element cannot be a document body");
		}
		const existing = this.body;
		if (existing === value) {
			return;
		}
		const root = this.documentElement;
		if (root === null) {
			throw hierarchyRequestError("There is no document element");
		}
		if (existing !== null) {
			replaceChild(existing, value, root);
		} else {
			appendNode(value, root);
		}
	}

	get title(): string {
		const root = this.documentElement;
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
		return stripAndCollapseWhitespace(descendantText(element));
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
			const head = this.head;
			if (head === null) {
				return;
			}
			element = createElementInternal(this, "title", HTML_NAMESPACE);
			appendNode(element, head);
		}
		setDescendantText(element, String(value));
		// A terminal's window title is the document's, set in-band.
		mountOf(this)?.titleChanged(String(value));
	}

	get documentElement(): Element | null {
		for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
			if (node.nodeType === ELEMENT_NODE) {
				return node as Element;
			}
		}
		return null;
	}

	getElementsByTagName(qualifiedName: string): HTMLCollection {
		return elementsByTagName(this, String(qualifiedName));
	}

	getElementsByTagNameNS(
		namespace: string | null,
		localName: string,
	): HTMLCollection {
		return elementsByTagNameNS(this, namespace, String(localName));
	}

	getElementsByClassName(classNames: string): HTMLCollection {
		return elementsByClassName(this, String(classNames));
	}

	getElementsByName(elementName: string): NodeList {
		const name = String(elementName);
		return new NodeList(
			() => {
				const matches: Node[] = [];
				for (const element of this.getElementsByTagName("*")) {
					if (
						element.namespaceURI === HTML_NAMESPACE &&
						element.getAttribute("name") === name
					) {
						matches.push(element);
					}
				}
				return matches;
			},
			true,
			this,
			null,
			"name",
		);
	}

	getElementById(elementId: string): Element | null {
		const id = String(elementId);
		const entries = this[kIdMap]!.get(id);
		if (entries === undefined || entries.length === 0) {
			return null;
		}
		if (entries.length === 1) {
			return entries[0];
		}
		let first = entries[0];
		for (let index = 1; index < entries.length; index++) {
			if (precedesInTree(entries[index], first)) {
				first = entries[index];
			}
		}
		return first;
	}

	createElement(
		localName: string,
		options?: {is?: string; customElementRegistry?: unknown} | string,
	): Element {
		if (arguments.length < 1) {
			throw new TypeError("createElement needs a name");
		}
		let name = String(localName);
		validateElementLocalName(name);
		if (isHTMLDocument(this)) {
			name = asciiLowercase(name);
		}
		const is = extractIs(options);
		const namespace =
			isHTMLDocument(this) || this[kContentType] === "application/xhtml+xml" ?
				HTML_NAMESPACE :
				null;
		return createElementInternal(
			this,
			name,
			namespace,
			null,
			is,
			true,
			extractRegistry(options),
		);
	}

	createElementNS(
		namespace: string | null,
		qualifiedName: string,
		options?: {is?: string; customElementRegistry?: unknown} | string,
	): Element {
		if (arguments.length < 2) {
			throw new TypeError("createElementNS needs a namespace and a name");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(qualifiedName),
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
		);
	}

	createDocumentFragment(): DocumentFragment {
		const fragment = new DocumentFragment();
		fragment[kDocument] = this;
		return fragment;
	}

	createTextNode(data: string): Text {
		if (arguments.length < 1) {
			throw new TypeError("createTextNode needs data");
		}
		const text = new Text(String(data));
		text[kDocument] = this;
		return text;
	}

	createCDATASection(data: string): CDATASection {
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
		return section;
	}

	createComment(data: string): Comment {
		if (arguments.length < 1) {
			throw new TypeError("createComment needs data");
		}
		const comment = new Comment(String(data));
		comment[kDocument] = this;
		return comment;
	}

	createProcessingInstruction(
		target: string,
		data: string,
	): ProcessingInstruction {
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
		return instruction;
	}

	importNode(node: Node, deep = false): Node {
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be imported");
		}
		if (isShadowRoot(node)) {
			throw domError("NotSupportedError", "A shadow root cannot be imported");
		}
		return cloneNode(node, this, Boolean(deep));
	}

	adoptNode(node: Node): Node {
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		if (node.nodeType === DOCUMENT_NODE) {
			throw domError("NotSupportedError", "A document cannot be adopted");
		}
		if (isShadowRoot(node)) {
			throw hierarchyRequestError("A shadow root cannot be adopted");
		}
		adoptNode(node, this);
		return node;
	}

	createAttribute(localName: string): Attr {
		if (arguments.length < 1) {
			throw new TypeError("createAttribute needs a name");
		}
		let name = String(localName);
		validateAttributeLocalName(name);
		if (isHTMLDocument(this)) {
			name = asciiLowercase(name);
		}
		const attribute = new Attr(null, null, name, "");
		attribute[kDocument] = this;
		return attribute;
	}

	createAttributeNS(namespace: string | null, qualifiedName: string): Attr {
		if (arguments.length < 2) {
			throw new TypeError("createAttributeNS needs a namespace and a name");
		}
		const extracted = validateAndExtract(
			namespace == null ? null : String(namespace),
			String(qualifiedName),
			true,
		);
		const attribute = new Attr(
			extracted.namespace,
			extracted.prefix,
			extracted.localName,
			"",
		);
		attribute[kDocument] = this;
		return attribute;
	}

	/**
	 * Build an uninitialized event of a legacy interface name.
	 *
	 * The event comes back with an empty type and its initialized flag unset,
	 * so it cannot be dispatched until initEvent gives it one.
	 */
	createEvent(interfaceName: string): Event {
		if (arguments.length < 1) {
			throw new TypeError("createEvent needs an interface name");
		}
		const name = asciiLowercase(String(interfaceName));
		const factory = LEGACY_EVENT_INTERFACES.get(name);
		if (factory === undefined) {
			throw domError(
				"NotSupportedError",
				`No event interface is named "${interfaceName}"`,
			);
		}
		const event = constructInternal(factory);
		event[kDispatchState]!.initialized = false;
		return event;
	}

	createRange(): Range {
		const range = new Range();
		setRangePoints(range, this, 0, this, 0);
		return range;
	}

	/**
	 * The selection over this document.
	 *
	 * The Selection API hangs this off the Window as well, and returns null for
	 * a document with no browsing context. There is no Window here and no
	 * browsing context to have: a document is the top of this DOM, so the
	 * selection is the document's and this is the only door to it.
	 */
	getSelection(): Selection {
		let selection = this[kSelection]!;
		if (selection === null) {
			selection = createSelection(this);
			this[kSelection] = selection;
		}
		return selection;
	}

	createNodeIterator(
		root: Node,
		whatToShow = 0xffffffff,
		filter: NodeFilterInput = null,
	): NodeIterator {
		if (!(root instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		const iterator = new NodeIterator(root, toUnsignedLong(whatToShow), filter);
		// The spec keys the pre-removing steps off the root's node document,
		// which need not be the document the iterator was created from.
		registerNodeIterator(getRoot(root), iterator);
		return iterator;
	}

	createTreeWalker(
		root: Node,
		whatToShow = 0xffffffff,
		filter: NodeFilterInput = null,
	): TreeWalker {
		if (!(root instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		// The flat bit is private to the engine, and the default whatToShow is
		// every bit there is: without this mask, `createTreeWalker(root)` would
		// walk the box tree's view of the document instead of the page's.
		return new TreeWalker(
			root,
			toUnsignedLong(whatToShow) & ~SHOW_FLAT,
			filter,
		);
	}

	override [kCloneSingle]?(_document: Document): Node {
		const copy = new Document();
		copyDocumentState(this, copy);
		return copy;
	}

	/*
	 * The legacy HTML document surface. Most of it is answerable rather than
	 * stubbed: the collections are live and filtered the way the spec filters
	 * them, and the colour attributes reflect the body's, which is what they
	 * are defined to do.
	 */

	get anchors(): HTMLCollection {
		return documentCollection(this,
			(e) => e instanceof HTMLAnchorElement && e.hasAttribute("name"),
		);
	}

	get forms(): HTMLCollection {
		return documentCollection(this, (e) => e instanceof HTMLFormElement);
	}

	get images(): HTMLCollection {
		return documentCollection(this, (e) => e instanceof HTMLImageElement);
	}

	get scripts(): HTMLCollection {
		return documentCollection(this, (e) => e instanceof HTMLScriptElement);
	}

	get embeds(): HTMLCollection {
		return documentCollection(this, (e) => e instanceof HTMLEmbedElement);
	}

	/** An alias of embeds, per the spec. */
	get plugins(): HTMLCollection {
		return this.embeds;
	}

	/** `a` and `area` elements that have an href. */
	get links(): HTMLCollection {
		return documentCollection(this,
			(e) =>
				(e instanceof HTMLAnchorElement || e instanceof HTMLAreaElement) &&
				e.hasAttribute("href"),
		);
	}

	/** Always empty: the applet element was removed from HTML. */
	get applets(): HTMLCollection {
		return documentCollection(this, () => false);
	}

	/*
	 * The presentational attributes of body, which these are defined to
	 * reflect. A document with no body reads them as the empty string and
	 * drops writes, which is what reflecting nothing does.
	 */

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

	/** Specified to do nothing at all. */
	clear(): void {}

	captureEvents(): void {}

	releaseEvents(): void {}

	/** A terminal shows what it renders, and shows it now. */
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

	/** SVG's root, which an HTML document has none of. */
	get rootElement(): globalThis.SVGSVGElement | null {
		return null;
	}

	/** Nothing animates, so nothing is animating. */
	getAnimations(): globalThis.Animation[] {
		return [];
	}

	/*
	 * XPath, which this engine does not implement: the selector engine is
	 * what it matches with, and an XPath expression is a language it does
	 * not speak.
	 */

	evaluate(): never {
		throw domError("NotSupportedError", "XPath is not implemented");
	}

	createExpression(): never {
		throw domError("NotSupportedError", "XPath is not implemented");
	}

	createNSResolver(): never {
		throw domError("NotSupportedError", "XPath is not implemented");
	}

	/*
	 * The rest of lib.dom's Document. What a terminal document can answer, it
	 * answers; the rest throws, so a caller reaching for an API this engine
	 * does not have finds out at the call rather than from a value that looks
	 * plausible.
	 */

	get dir(): string {
		return this.documentElement?.getAttribute("dir") ?? "";
	}

	set dir(value: string) {
		this.documentElement?.setAttribute("dir", value);
	}

	/** No network fetched this, so nothing referred to it. */
	get referrer(): string {
		return "";
	}

	/** Not fetched over HTTP, so there is no origin to name. */
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

	/**
	 * The element that scrolls the viewport (CSSOM View §7). Outside quirks
	 * mode that is the root element, always. In quirks mode the body scrolls
	 * instead -- unless the body is itself potentially scrollable, in which
	 * case nothing does, because the scrolling the caller means is happening
	 * inside the body rather than to it.
	 */
	get scrollingElement(): Element | null {
		if (this[kMode] !== "quirks") {
			return this.documentElement;
		}
		const body = this.body;
		if (body === null || isPotentiallyScrollable(body)) {
			return null;
		}
		return body;
	}

	get pictureInPictureElement(): Element | null {
		return null;
	}

	get pointerLockElement(): Element | null {
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

	/*
	 * The cascade holds a document's sheets and this module cannot reach it,
	 * so these throw rather than answer an empty list a caller would believe.
	 */

	get styleSheets(): globalThis.StyleSheetList {
		throw domError(
			"NotSupportedError",
			"Read the sheets through the style manager",
		);
	}

	get adoptedStyleSheets(): globalThis.CSSStyleSheet[] {
		throw domError(
			"NotSupportedError",
			"Read the sheets through the style manager",
		);
	}

	set adoptedStyleSheets(_value: globalThis.CSSStyleSheet[]) {
		throw domError(
			"NotSupportedError",
			"Read the sheets through the style manager",
		);
	}

	/*
	 * Markup arrives whole, so there is no open document to stream into. The
	 * parser builds a tree from a string; document.write appends to a stream
	 * that this engine never opens.
	 */

	open(): never {
		throw domError("InvalidStateError", "This document is not a stream");
	}

	write(): never {
		throw domError("InvalidStateError", "This document is not a stream");
	}

	writeln(): never {
		throw domError("InvalidStateError", "This document is not a stream");
	}

	/* Editing commands, which this engine has no editing host for. */

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

	/* Surfaces that need a window manager, a network, or a compositor. */

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
}

/**
 * CSSOM View's "potentially scrollable": the element has a box, and neither
 * it nor its parent leaves overflow visible on both axes. A body that scrolls
 * its own content is not the thing that scrolls the viewport.
 */
function isPotentiallyScrollable(body: Element): boolean {
	const view = body.ownerDocument?.defaultView as
		| {
			getComputedStyle?(element: Element): {
				getPropertyValue(p: string): string;
			};
		} |
		null |
		undefined;
	if (view?.getComputedStyle === undefined) {
		return false;
	}
	// An absent computed value is the initial one, and overflow's is visible.
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

/** A live collection of the document's descendants that `match` accepts. */
function documentCollection(
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
		Extract<keyof globalThis.Document, `on${string}`> | ParentNodeMixin
	> {}

// Hit testing: the point is the viewport's, the answer the engine's. A
// headless document renders nothing, so nothing is under any point.
Object.defineProperties(Document.prototype, {
	elementFromPoint: {
		value(this: Document, x: number, y: number): Element | null {
			return (mountOf(this)?.elementFromPoint(this, x, y) ??
				null) as Element | null;
		},
		writable: true,
		configurable: true,
		enumerable: true,
	},
	elementsFromPoint: {
		value(this: Document, x: number, y: number): Element[] {
			return (mountOf(this)?.elementsFromPoint(this, x, y) ??
				[]) as Element[];
		},
		writable: true,
		configurable: true,
		enumerable: true,
	},
});

export class XMLDocument extends Document {
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

/**
 * The registry an element creation option names: the one given, null where
 * the caller asked for no registry, and undefined where it did not ask.
 */
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

/* ------------------------------------------------------------------ id map */

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

/* ------------------------------------------------------------ implementation */

export class DOMImplementation {
	declare [kDocument]?: Document;

	constructor(document: Document) {
		this[kDocument] = document;
	}

	createDocumentType(
		qualifiedName: string,
		publicId: string,
		systemId: string,
	): DocumentType {
		if (arguments.length < 3) {
			throw new TypeError("createDocumentType needs three arguments");
		}
		const name = String(qualifiedName);
		validateDoctypeName(name);
		const doctype = new DocumentType(name, String(publicId), String(systemId));
		doctype[kDocument] = this[kDocument]!;
		return doctype;
	}

	createDocument(
		namespace: string | null,
		qualifiedName: string | null,
		doctype: DocumentType | null = null,
	): XMLDocument {
		if (arguments.length < 2) {
			throw new TypeError("createDocument needs a namespace and a name");
		}
		const document = new XMLDocument();
		document[kType] = "xml";
		document[kContentType] = "application/xml";
		let element: Element | null = null;
		const name = qualifiedName === null ? "" : String(qualifiedName);
		if (name !== "") {
			element = document.createElementNS(
				namespace == null ? null : String(namespace),
				name,
			);
		}
		if (doctype != null) {
			appendNode(doctype, document);
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

Object.defineProperty(DOMImplementation.prototype, Symbol.toStringTag, {
	value: "DOMImplementation",
	configurable: true,
});

/**
 * Build a document, which is the one document of a realm that has no parser
 * to build one: it carries the realm's registry, exactly as a parsed document
 * does. The DOMImplementation method of the same name does not -- a document
 * an author builds through the DOM has no browsing context, and no registry
 * until one claims it.
 */
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

/* ----------------------------------------------------------------- mixins */

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
	const fragment = document.createDocumentFragment();
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
					() => elementChildren(this),
					this,
					(node) => node.nodeType === ELEMENT_NODE,
				);
				ensure(collection);
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
			let count = 0;
			for (let node = this[kFirstChild]!; node !== null; node = node[kNext]!) {
				if (node.nodeType === ELEMENT_NODE) {
					count++;
				}
			}
			return count;
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
			return selectorEngine(this[kDocument]!).first(
				String(selectors),
				this as never,
			) as Element | null;
		},
		configurable: true,
		enumerable: true,
		writable: true,
	},
	querySelectorAll: {
		value(this: Node, selectors: string): NodeList {
			const found = selectorEngine(this[kDocument]!).select(
				String(selectors),
				this as never,
			) as unknown as Node[];
			return createStaticNodeList(found.slice());
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

/**
 * The mixin members the IDL marks [Unscopable], so a `with` statement over a
 * node does not shadow a variable named after one of them.
 */
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

function scrollTargetOf(
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
	const target = scrollTargetOf(xOrOptions, y);
	if (target.left !== undefined) {
		this.scrollLeft = target.left;
	}
	if (target.top !== undefined) {
		this.scrollTop = target.top;
	}
}

/** The scroll offsets of the boxes that have been scrolled at all. */
const scrollOffsets = new WeakMap<object, {left: number; top: number}>();

function writeScrollOffset(
	element: object,
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

/** The spec's "insert adjacent" algorithm, shared by element and text. */
function insertAdjacent(
	element: Element,
	where: string,
	node: Node,
): Node | null {
	switch (asciiLowercase(where)) {
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

/* ------------------------------------------------------ clone and equality */

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

/* ------------------------------------------------------------- namespaces */

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
	return parent === null ? null : locateNamespacePrefix(parent, namespace);
}

function locateNamespace(node: Node, prefix: string | null): string | null {
	switch (node.nodeType) {
		case ELEMENT_NODE: {
			// The two prefixes the XML specifications bind for good.
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
			return parent === null ? null : locateNamespace(parent, prefix);
		}
		case DOCUMENT_NODE: {
			const element = (node as Document).documentElement;
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
			return parent === null ? null : locateNamespace(parent, prefix);
		}
	}
}

/* ----------------------------------------------------------------- ranges */

/** A boundary point's position relative to another boundary point. */
const BEFORE = -1;
const EQUAL = 0;
const AFTER = 1;

/** A node's index: the number of siblings that precede it. */
function nodeIndex(node: Node): number {
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

/**
 * A node's length: zero for a doctype, the length of the data for character
 * data, and the number of children for everything else.
 */
function nodeLength(node: Node): number {
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

/** The chain from a node's root down to the node itself. */
function ancestorChain(node: Node): Node[] {
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

/** Whether a node precedes one of its siblings. */
function precedesSibling(node: Node, other: Node): boolean {
	for (let next = node[kNext]!; next !== null; next = next[kNext]!) {
		if (next === other) {
			return true;
		}
	}
	return false;
}

/**
 * The position of the boundary point (nodeA, offsetA) relative to (nodeB,
 * offsetB): before, equal or after. The two nodes have the same root.
 */
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
	const chainA = ancestorChain(nodeA);
	const chainB = ancestorChain(nodeB);
	let depth = 0;
	while (
		depth < chainA.length &&
		depth < chainB.length &&
		chainA[depth] === chainB[depth]
	) {
		depth++;
	}
	// One node is an ancestor of the other: the ancestor's offset is compared
	// against the index of the child it holds the other node under.
	if (depth === chainA.length) {
		return nodeIndex(chainB[depth]) < offsetA ? AFTER : BEFORE;
	}
	if (depth === chainB.length) {
		return nodeIndex(chainA[depth]) < offsetB ? BEFORE : AFTER;
	}
	return precedesSibling(chainA[depth], chainB[depth]) ? BEFORE : AFTER;
}

/**
 * Every live range, keyed by the root of the tree its boundary points live
 * in. Both boundaries always share one root: the boundary setters collapse
 * the other point on a root change, as the spec says.
 *
 * The root is held weakly, so an unreachable tree takes its ranges with it;
 * the ranges are held strongly, which keeps collection unobservable where a
 * WeakRef would expose it. A range changes trees only through the boundary
 * setters and through its tree being inserted somewhere, and both of those
 * re-home it.
 */
const liveRangesByRoot = new WeakMap<Node, Set<Range>>();

/**
 * Every NodeIterator, keyed by the root of the tree its own root lives in,
 * held the same way as the ranges above and re-homed by the same moves.
 */
const nodeIteratorsByRoot = new WeakMap<Node, Set<NodeIterator>>();

function registerNodeIterator(treeRoot: Node, iterator: NodeIterator): void {
	let set = nodeIteratorsByRoot.get(treeRoot);
	if (set === undefined) {
		set = new Set();
		nodeIteratorsByRoot.set(treeRoot, set);
	}
	set.add(iterator);
}
/** How many ranges have ever been registered; the mutation steps' fast path. */
let liveRangesEver = 0;

const kStartNode = Symbol("range start node");

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

/** Move a range's registration after its boundary points changed trees. */
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

/** Run steps over every live range in the tree holding `context`. */
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

/**
 * The boundary point steps the insert algorithm runs: a node inserted before a
 * child pushes along every boundary point in the parent past that child.
 */
function liveRangeInsertSteps(parent: Node, child: Node, count: number): void {
	const index = nodeIndex(child);
	forEachLiveRange(parent, (range) => {
		if (range[kStartNode] === parent && range[kStartOffset]! > index) {
			range[kStartOffset]! += count;
		}
		if (range[kEndNode] === parent && range[kEndOffset]! > index) {
			range[kEndOffset]! += count;
		}
	});
}

/**
 * The live range pre-remove steps: a boundary point inside the node being
 * removed collapses onto the node's own position, and one after it in the
 * parent moves back by one.
 */
function liveRangePreRemoveSteps(node: Node): void {
	const parent = node[kParent]! as Node;
	const index = nodeIndex(node);
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

/**
 * The boundary point steps the replace data algorithm runs: a point inside the
 * replaced run collapses to its start, and one after the run moves by the
 * difference in length.
 */
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

/**
 * The boundary point steps the split algorithm runs: a point past the split
 * moves into the new node, and one that sat just after the node in its parent
 * moves past the new node as well.
 */
function liveRangeSplitSteps(
	node: Text,
	newNode: Text,
	offset: number,
	parent: Node,
): void {
	const index = nodeIndex(node);
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

/**
 * The boundary point steps normalize runs for each text node it folds into the
 * one before it: a point in the folded node, or one that named it in its
 * parent, moves to where its data landed.
 */
function liveRangeNormalizeSteps(
	node: Text,
	currentNode: Text,
	length: number,
): void {
	const parent = currentNode[kParent]! as Node;
	const index = nodeIndex(currentNode);
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

export class AbstractRange {
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

/** The boundary points a StaticRange is constructed from. */
function staticRangePoints(init: unknown): [Node, number, Node, number] {
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

export class StaticRange extends AbstractRange {
	constructor(init: StaticRangeInit) {
		super(...staticRangePoints(init));
	}
}

Object.defineProperty(StaticRange.prototype, Symbol.toStringTag, {
	value: "StaticRange",
	configurable: true,
});

const START_TO_START = 0;
const START_TO_END = 1;
const END_TO_END = 2;
const END_TO_START = 3;

/** A live range's root: the root of its start node. */
function rangeRoot(range: Range): Node {
	return getRoot(range[kStartNode]!);
}

/** Whether a node is contained in a live range. */
function isContained(node: Node, range: Range): boolean {
	if (getRoot(node) !== rangeRoot(range)) {
		return false;
	}
	return (
		comparePoints(node, 0, range[kStartNode]!, range[kStartOffset]!) ===
		AFTER &&
		comparePoints(
			node,
			nodeLength(node),
			range[kEndNode]!,
			range[kEndOffset]!,
		) === BEFORE
	);
}

/** Whether a node is partially contained in a live range. */
function isPartiallyContained(node: Node, range: Range): boolean {
	const holdsStart = isInclusiveAncestor(node, range[kStartNode]!);
	const holdsEnd = isInclusiveAncestor(node, range[kEndNode]!);
	return holdsStart !== holdsEnd;
}

/** The node, furthest from the root, that holds both boundary points. */
function commonAncestorOf(range: Range): Node {
	let container = range[kStartNode]!;
	while (!isInclusiveAncestor(container, range[kEndNode]!)) {
		container = container[kParent]! as Node;
	}
	return container;
}

/** A range's boundary points, as the Range API sets them. */
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

/** A boundary point's node: any node but a doctype. */
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

/** The spec's "set the start" and "set the end" of a range. */
function setRangeBoundary(
	range: Range,
	node: Node,
	offset: number,
	isStart: boolean,
): void {
	assertBoundaryNode(node);
	const at = toUnsignedLong(offset);
	if (at > nodeLength(node)) {
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

/** The parent a boundary point is set relative to, for the -Before/-After set. */
function boundaryParent(node: unknown): Node {
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

/** Select a node within a range. */
function selectNodeWithin(range: Range, node: Node): void {
	const parent = boundaryParent(node);
	const index = nodeIndex(node);
	setRangePoints(range, parent, index, parent, index + 1);
}

/** A document fragment of a document, which the extraction algorithms fill. */
function createFragment(document: Document): DocumentFragment {
	const fragment = new DocumentFragment();
	fragment[kDocument] = document;
	return fragment;
}

/** The children of a range's common ancestor the extraction algorithms move. */
interface ExtractionShape {
	commonAncestor: Node;
	firstPartiallyContained: Node | null;
	lastPartiallyContained: Node | null;
	containedChildren: Node[];
}

/**
 * The children of the common ancestor a range covers: the one it starts inside
 * of, the ones it holds whole, and the one it ends inside of.
 */
function extractionShape(range: Range): ExtractionShape {
	const commonAncestor = commonAncestorOf(range);
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

/** Where a range collapses to once its contents leave the tree. */
function pointAfterExtraction(range: Range): [Node, number] {
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
	return [reference[kParent]! as Node, nodeIndex(reference) + 1];
}

/** A shallow clone of character data, carrying part of the original's data. */
function characterDataSlice(
	node: CharacterData,
	offset: number,
	count: number,
): CharacterData {
	const clone = cloneNode(node, undefined, false) as CharacterData;
	clone[kData] = node[kData]!.slice(offset, offset + count);
	return clone;
}

/** The spec's "extract" of a live range. */
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
			characterDataSlice(data, startOffset, endOffset - startOffset),
			fragment,
		);
		replaceData(data, startOffset, endOffset - startOffset, "");
		return fragment;
	}
	const shape = extractionShape(range);
	const [newNode, newOffset] = pointAfterExtraction(range);
	setRangePoints(range, newNode, newOffset, newNode, newOffset);
	const first = shape.firstPartiallyContained;
	if (first !== null && isCharacterData(first)) {
		const data = startNode as CharacterData;
		const count = data[kData]!.length - startOffset;
		appendNode(characterDataSlice(data, startOffset, count), fragment);
		replaceData(data, startOffset, count, "");
	} else if (first !== null) {
		const clone = cloneNode(first, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(subrange, startNode, startOffset, first, nodeLength(first));
		appendNode(extractRange(subrange), clone);
	}
	for (const child of shape.containedChildren) {
		appendNode(child, fragment);
	}
	const last = shape.lastPartiallyContained;
	if (last !== null && isCharacterData(last)) {
		const data = endNode as CharacterData;
		appendNode(characterDataSlice(data, 0, endOffset), fragment);
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

/** The spec's "clone the contents" of a live range. */
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
			characterDataSlice(data, startOffset, endOffset - startOffset),
			fragment,
		);
		return fragment;
	}
	const shape = extractionShape(range);
	const first = shape.firstPartiallyContained;
	if (first !== null && isCharacterData(first)) {
		const data = startNode as CharacterData;
		const count = data[kData]!.length - startOffset;
		appendNode(characterDataSlice(data, startOffset, count), fragment);
	} else if (first !== null) {
		const clone = cloneNode(first, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(subrange, startNode, startOffset, first, nodeLength(first));
		appendNode(cloneRangeContents(subrange), clone);
	}
	for (const child of shape.containedChildren) {
		appendNode(cloneNode(child, undefined, true), fragment);
	}
	const last = shape.lastPartiallyContained;
	if (last !== null && isCharacterData(last)) {
		const data = endNode as CharacterData;
		appendNode(characterDataSlice(data, 0, endOffset), fragment);
	} else if (last !== null) {
		const clone = cloneNode(last, undefined, false);
		appendNode(clone, fragment);
		const subrange = new Range();
		setRangePoints(subrange, last, 0, endNode, endOffset);
		appendNode(cloneRangeContents(subrange), clone);
	}
	return fragment;
}

/** The spec's "insert" of a node into a live range. */
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
		referenceNode === null ? nodeLength(parent) : nodeIndex(referenceNode);
	newOffset += node.nodeType === DOCUMENT_FRAGMENT_NODE ? nodeLength(node) : 1;
	preInsert(node, parent, referenceNode);
	if (range.collapsed) {
		range[kEndNode] = parent;
		range[kEndOffset] = newOffset;
		rangeBoundaryPointsChanged(range, "end");
	}
}

const kRangeSelection = Symbol("the selection whose range this is");

export class Range extends AbstractRange {
	[kRangeSelection]?: Selection | null;

	// Installed on the prototype, where the mount that measures them is.
	declare getBoundingClientRect: () => globalThis.DOMRect;
	declare getClientRects: () => globalThis.DOMRectList;

	static readonly START_TO_START = START_TO_START;
	static readonly START_TO_END = START_TO_END;
	static readonly END_TO_END = END_TO_END;
	static readonly END_TO_START = END_TO_START;

	constructor() {
		const document = currentDocument();
		super(document, 0, document, 0);
		this[kRangeSelection] = null;
		registerLiveRange(this);
	}

	get commonAncestorContainer(): Node {
		return commonAncestorOf(this);
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
		const parent = boundaryParent(node);
		setRangeBoundary(this, parent, nodeIndex(node), true);
	}

	setStartAfter(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setStartAfter needs a node");
		}
		const parent = boundaryParent(node);
		setRangeBoundary(this, parent, nodeIndex(node) + 1, true);
	}

	setEndBefore(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setEndBefore needs a node");
		}
		const parent = boundaryParent(node);
		setRangeBoundary(this, parent, nodeIndex(node), false);
	}

	setEndAfter(node: Node): void {
		if (arguments.length < 1) {
			throw new TypeError("setEndAfter needs a node");
		}
		const parent = boundaryParent(node);
		setRangeBoundary(this, parent, nodeIndex(node) + 1, false);
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
		setRangePoints(this, node, 0, node, nodeLength(node));
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
		for (const node of descendants(commonAncestorOf(this))) {
			if (!isContained(node, this)) {
				continue;
			}
			const parent = node[kParent]!;
			if (parent !== null && isContained(parent, this)) {
				continue;
			}
			nodesToRemove.push(node);
		}
		const [newNode, newOffset] = pointAfterExtraction(this);
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

	/**
	 * Parse markup in the range's context: the start node's element (a text
	 * node's parent; the body when the start is the document), exactly the
	 * context innerHTML would give the same markup.
	 */
	createContextualFragment(markup: string): DocumentFragment {
		const start = this[kStartNode]!;
		let context: Element | null =
			start instanceof Element ?
				start :
				start[kParent]! instanceof Element ?
						(start[kParent]! as Element) :
					null;
		if (context === null) {
			const document =
				start instanceof Document ?
					start :
						(start.ownerDocument as Document | null);
			context = (document?.body ?? document?.documentElement ?? null) as
			| Element |
			null;
		}
		if (context === null) {
			throw domError("NotSupportedError", "The range has no context");
		}
		return parseFragmentHTML(String(markup ?? ""), context);
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
		// The method's functionality was removed; it is kept for compatibility.
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
		if (at > nodeLength(node)) {
			throw indexSizeError("The offset is past the end of the node");
		}
		if (
			comparePoints(node, at, this[kStartNode]!, this[kStartOffset]!) ===
			BEFORE ||
			comparePoints(node, at, this[kEndNode]!, this[kEndOffset]!) === AFTER
		) {
			return false;
		}
		return true;
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
		if (at > nodeLength(node)) {
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
		const offset = nodeIndex(node);
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
		for (const node of descendants(commonAncestorOf(this))) {
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

/** The comparison constants, installed on the prototype. */
export interface Range
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

Object.defineProperties(Range.prototype, {
	getBoundingClientRect: {
		value(this: Range): globalThis.DOMRect {
			return (
				mountOf(this.startContainer)?.rangeBoundingClientRect(this) ??
				new DOMRect(0, 0, 0, 0)
			);
		},
		writable: true,
		configurable: true,
	},
	getClientRects: {
		value(this: Range): globalThis.DOMRectList {
			return (
				mountOf(this.startContainer)?.rangeClientRects(this) ??
				new DOMRectList()
			);
		},
		writable: true,
		configurable: true,
	},
});

/* -------------------------------------------------------------- selection */

/**
 * The selection whose range this is takes a selectionchange event from every
 * change the Range API makes to that range's boundary points.
 */
function rangeBoundaryPointsChanged(
	range: Range,
	which: "start" | "end" | "both",
): void {
	const selection = range[kRangeSelection]!;
	if (selection !== null) {
		selectionChanged(selection, which);
	}
}

/** Schedule a selectionchange event at a document, at most one per task. */
function scheduleSelectionChange(document: Document): void {
	// A selection move is not a mutation and no record names the rows it
	// covers, so the engine hears it here -- before the coalescing guard
	// below, which drops the second move of a task but not its repaint.
	mountOf(document)?.selectionMoved();
	if (document[kSelectionChangeScheduled]!) {
		return;
	}
	document[kSelectionChangeScheduled] = true;
	setTimeout(() => {
		document[kSelectionChangeScheduled] = false;
		document.dispatchEvent(new Event("selectionchange"));
	}, 0);
}

/**
 * A node's composed parent: its parent, or the host of the shadow root it is.
 * A shadow root sits at its host, before the host's children, so that a
 * boundary point in a shadow tree orders against one in the light tree.
 */
function composedParent(node: Node): Node | null {
	const parent = node[kParent]!;
	if (parent !== null) {
		return parent;
	}
	return isShadowRoot(node) ? ((node as ShadowRoot)[kHost]! as Node) : null;
}

/** The chain from a node's composed root down to the node itself. */
function composedChain(node: Node): Node[] {
	const chain: Node[] = [];
	for (
		let current: Node | null = node;
		current !== null;
		current = composedParent(current)
	) {
		chain.push(current);
	}
	chain.reverse();
	return chain;
}

/** A node's composed index, where a shadow root precedes its host's children. */
function composedIndex(node: Node): number {
	return node[kParent] === null && isShadowRoot(node) ? -1 : nodeIndex(node);
}

/**
 * The position of one boundary point relative to another, counting a shadow
 * tree as part of the tree its host is in.
 */
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
	const chainA = composedChain(nodeA);
	const chainB = composedChain(nodeB);
	let depth = 0;
	while (
		depth < chainA.length &&
		depth < chainB.length &&
		chainA[depth] === chainB[depth]
	) {
		depth++;
	}
	if (depth === chainA.length) {
		return composedIndex(chainB[depth]) < offsetA ? AFTER : BEFORE;
	}
	if (depth === chainB.length) {
		return composedIndex(chainA[depth]) < offsetB ? BEFORE : AFTER;
	}
	return composedIndex(chainA[depth]) < composedIndex(chainB[depth]) ?
		BEFORE :
		AFTER;
}

/** A collapsed live range, which is how a selection holds a boundary point. */
function livePoint(node: Node, offset: number): Range {
	const point = new Range();
	setRangePoints(point, node, offset, node, offset);
	return point;
}

/** The document a selection is being created for, which only a document does. */
let selectionUnderConstruction: Document | null = null;

/** The selection of a document, which is the only way one is made. */
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

export class Selection {
	declare [kDocument]?: Document;
	/** The range the Range API sees, which lives in a single tree. */
	declare [kRange]?: Range | null;
	/**
	 * The composed boundary points, in tree order and each held as a collapsed
	 * live range so that a tree mutation moves it. A selection that crosses a
	 * shadow boundary keeps both of these while its range collapses.
	 */
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
		const anchor = anchorPoint(this);
		if (anchor === null || !inDocument(this, anchor[0])) {
			return null;
		}
		return anchor[0];
	}

	get anchorOffset(): number {
		const anchor = anchorPoint(this);
		if (anchor === null || !inDocument(this, anchor[0])) {
			return 0;
		}
		return anchor[1];
	}

	get focusNode(): Node | null {
		const focus = focusPoint(this);
		if (focus === null || !inDocument(this, focus[0])) {
			return null;
		}
		return focus[0];
	}

	get focusOffset(): number {
		const focus = focusPoint(this);
		if (focus === null || !inDocument(this, focus[0])) {
			return 0;
		}
		return focus[1];
	}

	get isCollapsed(): boolean {
		const range = this[kRange]!;
		return range === null || range.collapsed;
	}

	get rangeCount(): number {
		return documentRange(this) === null ? 0 : 1;
	}

	get type(): string {
		const range = documentRange(this);
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
		const range = documentRange(this);
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
		if (!inDocument(this, range[kStartNode]!)) {
			return;
		}
		if (this.rangeCount !== 0) {
			return;
		}
		associate(
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
				at = nodeIndex(host) + (after ? 1 : 0);
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
		if (at > nodeLength(node)) {
			throw indexSizeError("The offset is past the end of the node");
		}
		if (!isShadowIncludingInclusiveAncestor(this[kDocument]!, node)) {
			return;
		}
		const point: [Node, number] = [node, at];
		associate(
			this,
			rangeFor(this, point, point),
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
		associate(
			this,
			rangeFor(this, point, point),
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
		associate(
			this,
			rangeFor(this, point, point),
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
		const anchor = anchorPoint(this) as [Node, number];
		const focus: [Node, number] = [node, toUnsignedLong(offset)];
		const anchorFirst =
			compareComposedPoints(anchor[0], anchor[1], focus[0], focus[1]) !== AFTER;
		const range = anchorFirst ?
				rangeFor(this, anchor, focus) :
				rangeFor(this, focus, anchor);
		associate(
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
		if (anchorAt > nodeLength(anchorNode) || focusAt > nodeLength(focusNode)) {
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
		const range = anchorFirst ?
				rangeFor(this, anchor, focus) :
				rangeFor(this, focus, anchor);
		associate(
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
		associate(this, rangeFor(this, anchor, focus), anchor, focus, "forwards");
	}

	deleteFromDocument(): void {
		const range = documentRange(this);
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
		const length = nodeLength(node);
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

	/**
	 * Move the caret, or drag the focus, by a unit of text -- the motion a
	 * keyboard makes, in the one place a page can ask for it.
	 *
	 * `alter` is "move" (collapse where the motion lands) or "extend" (take
	 * the focus there and leave the anchor). A "move" over a range starts
	 * from the edge it is heading for, so a forward character move over a
	 * selection collapses to its end without going further -- what browsers
	 * do. "left" and "right" mean "backward" and "forward": a right-to-left
	 * run's visual order is not followed.
	 *
	 * "character" and "word" are answerable from the text. "line" and
	 * "lineboundary" are laid-out lines rather than a property of the string,
	 * so they need a document mounted in a terminal and do nothing without
	 * one; a line's ends are its first and last text in tree order, which is
	 * its visual order only where the text runs left to right. "sentence",
	 * "paragraph" and their boundaries are not implemented. Anything
	 * unrecognized does nothing, as in a browser.
	 */
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
		const range = documentRange(this);
		if (range === null) {
			return;
		}
		const extending = how === "extend";
		const from =
			extending ?
					(focusPoint(this) as [Node, number]) :
				forward ?
						([range[kEndNode]!, range[kEndOffset]!] as [Node, number]) :
						([range[kStartNode]!, range[kStartOffset]!] as [Node, number]);
		// Collapsing a range by a character is the whole motion: the caret
		// lands on the edge the direction points at, not one character past it.
		const to =
			!extending && !range.collapsed && unit === "character" ?
				from :
					modifiedPoint(this, from, forward, unit);
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

/**
 * The text a document paints, as one string with the text node each stretch
 * of it came from. Character and word motion are string questions, and a
 * caret crosses from one text node into the next without noticing, so both
 * are asked of this rather than of a node at a time.
 *
 * Built per call: a selection moves at the speed of a keystroke, and a cache
 * of the document's text would have every mutation to invalidate it.
 */
interface SelectionText {
	text: string;
	parts: Array<{node: Text; start: number}>;
}

/** One laid-out line, as offsets into the flattened text. */
interface SelectionLine {
	y: number;
	start: number;
	end: number;
}

/** Whether a text node puts anything on the screen. */
function paintsText(
	node: Text,
	layout: UAEngine["layout"] | null,
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

/**
 * The painted, selectable text nodes of a document, in tree order. The
 * selectable filter asks per text node's parent rather than pruning the
 * subtree, because user-select: none does not inherit -- a `text`
 * descendant inside a `none` ancestor selects again.
 */
function selectionTextNodes(
	document: Document,
	engine: UAEngine | undefined,
): Text[] {
	const layout = engine?.layout ?? null;
	const nodes: Text[] = [];
	const collect = (node: Node): void => {
		for (let child = node[kFirstChild]!;
			child !== null;
			child = child[kNext]!) {
			if (child.nodeType === TEXT_NODE) {
				if (
					paintsText(child as Text, layout) &&
					(engine === undefined || engine.styles.isSelectable(node))
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

/**
 * Where a boundary point sits in the flattened text, or null for a point in
 * nothing painted. An element boundary point sits before the child at its
 * offset, so it lands on the first painted text at or after that child --
 * and past the last child, at the end of the element's own text.
 */
function selectionIndexOf(
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

/**
 * The boundary point an offset into the flattened text names. An offset on
 * the seam between two nodes belongs to the earlier one's end, which is the
 * same position as the later one's start.
 */
function selectionPointAt(
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

/**
 * The document's laid-out lines, as stretches of the flattened text. Two
 * fragments on the same row are the same line however many nodes they came
 * from, so a row is keyed by where it sits.
 */
function selectionLines(
	run: SelectionText,
	layout: UAEngine["layout"],
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

/**
 * The line an offset sits on. A caret exactly at a soft wrap belongs to the
 * next line's start -- both lines claim the offset, and the later one wins,
 * the same rule the textarea's vertical motion follows.
 */
function selectionLineAt(lines: SelectionLine[], index: number): number {
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

/** The column a caret paints at, asked of the layout. */
function caretColumnOf(
	document: Document,
	layout: UAEngine["layout"],
	point: [Node, number],
): number | null {
	const range = document.createRange();
	range.setStart(point[0], point[1]);
	range.setEnd(point[0], point[1]);
	const rect = layout.getRangeRects(range)[0];
	return rect === undefined ? null : rect.x;
}

/**
 * The point one laid-out line up or down, keeping the column the caret is at
 * now. Past the first or last line the motion spends itself on that line's
 * own end, as a browser's arrow key does.
 *
 * The column is a screen column and the target is a screen row, so the
 * landing offset is the layout's own hit test -- the same answer a click
 * there would give.
 */
function selectionLineMove(
	document: Document,
	run: SelectionText,
	layout: UAEngine["layout"],
	index: number,
	forward: boolean,
): [Node, number] | null {
	const lines = selectionLines(run, layout);
	if (lines.length === 0) {
		return null;
	}
	const at = selectionLineAt(lines, index);
	const target = at + (forward ? 1 : -1);
	if (target < 0) {
		return selectionPointAt(run, lines[0].start);
	}
	if (target >= lines.length) {
		return selectionPointAt(run, lines[lines.length - 1].end);
	}
	const here = selectionPointAt(run, index);
	const column = here === null ? null : caretColumnOf(document, layout, here);
	const root = document.body ?? document.documentElement;
	const found =
		column === null || root === null ?
			null :
				layout.caretPositionFromPoint(
					column,
					lines[target].y,
					root as unknown as object,
					true,
				);
	if (found === null) {
		return selectionPointAt(run, lines[target].start);
	}
	return [found.node as unknown as Node, found.offset];
}

/** The point the motion lands on, or null where there is nothing to do. */
function modifiedPoint(
	selection: Selection,
	from: [Node, number],
	forward: boolean,
	granularity: string,
): [Node, number] | null {
	const document = selection[kDocument]!;
	const engine = uaEngineOf(document);
	const layout = engine?.layout ?? null;
	if (layout === null) {
		if (granularity === "line" || granularity === "lineboundary") {
			return null;
		}
	} else {
		// Lines are read back off the layout in the same turn, so whatever the
		// page just mutated has to be laid out before they are asked for.
		layout.calculateLayout();
	}
	const run = flattenSelectionText(selectionTextNodes(document, engine));
	if (run.parts.length === 0) {
		return null;
	}
	const index = selectionIndexOf(run, from[0], from[1]);
	if (index === null) {
		return null;
	}
	if (granularity === "character") {
		return selectionPointAt(
			run,
			forward ?
					nextGraphemeBoundary(run.text, index) :
					prevGraphemeBoundary(run.text, index),
		);
	}
	if (granularity === "word") {
		return selectionPointAt(
			run,
			forward ?
					wordEndAfter(run.text, index) :
					wordStartBefore(run.text, index),
		);
	}
	if (granularity === "documentboundary") {
		return selectionPointAt(run, forward ? run.text.length : 0);
	}
	if (layout === null) {
		return null;
	}
	if (granularity === "lineboundary") {
		const lines = selectionLines(run, layout);
		if (lines.length === 0) {
			return null;
		}
		const line = lines[selectionLineAt(lines, index)];
		return selectionPointAt(run, forward ? line.end : line.start);
	}
	if (granularity === "line") {
		return selectionLineMove(document, run, layout, index, forward);
	}
	return null;
}

/** Whether a node is in the selection's document, shadow trees included. */
function inDocument(
	selection: Selection,
	node: Node,
): boolean {
	return shadowIncludingRoot(node) === selection[kDocument]!;
}

/**
 * The range the Range API is allowed to see: the selection has one while
 * its range is in the document, a shadow tree of the document included. A
 * range that has left the document is not one the selection answers with.
 */
function documentRange(
	selection: Selection,
): Range | null {
	const range = selection[kRange]!;
	if (range === null) {
		return null;
	}
	return inDocument(selection, range[kStartNode]!) ? range : null;
}

function anchorPoint(
	selection: Selection,
): [Node, number] | null {
	const range = selection[kRange]!;
	if (range === null) {
		return null;
	}
	return selection[kDirection] === "forwards" ?
			[range[kStartNode]!, range[kStartOffset]!] :
			[range[kEndNode]!, range[kEndOffset]!];
}

function focusPoint(
	selection: Selection,
): [Node, number] | null {
	const range = selection[kRange]!;
	if (range === null) {
		return null;
	}
	return selection[kDirection] === "forwards" ?
			[range[kEndNode]!, range[kEndOffset]!] :
			[range[kStartNode]!, range[kStartOffset]!];
}

/** The range the Range API builds from an ordered pair of points. */
function rangeFor(
	selection: Selection,
	start: [Node, number],
	end: [Node, number],
): Range {
	const range = new Range();
	setRangeBoundary(range, start[0], start[1], true);
	setRangeBoundary(range, end[0], end[1], false);
	return range;
}

/** Take a range, and the composed points it was built from, as the own. */
function associate(
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
	selection[kStart] = livePoint(start[0], start[1]);
	selection[kEnd] = livePoint(end[0], end[1]);
	selection[kDirection] = direction;
	scheduleSelectionChange(selection[kDocument]!);
}

/**
 * The steps a change to the selection's range through the Range API takes:
 * the composed point the change moved follows it, and a range that leaves
 * the document takes the selection with it.
 */
function selectionChanged(
	selection: Selection,
	which: "start" | "end" | "both",
): void {
	const range = selection[kRange]!;
	if (range === null) {
		return;
	}
	if (!inDocument(selection, range[kStartNode]!)) {
		selection.removeAllRanges();
		return;
	}
	const start = livePoint(range[kStartNode]!, range[kStartOffset]!);
	const end = livePoint(range[kEndNode]!, range[kEndOffset]!);
	if (
		which === "both" || selection[kStart] === null || selection[kEnd] === null
	) {
		selection[kStart] = start;
		selection[kEnd] = end;
	} else if (which === "start") {
		selection[kStart] = start;
		if (composedOrder(selection, start, selection[kEnd]!) === AFTER) {
			selection[kEnd] = start;
		}
	} else {
		selection[kEnd] = end;
		if (composedOrder(selection, end, selection[kStart]!) === BEFORE) {
			selection[kStart] = end;
		}
	}
	scheduleSelectionChange(selection[kDocument]!);
}

function composedOrder(
	selection: Selection,
	point: Range,
	other: Range,
): number {
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

/* -------------------------------------------------------------- traversal */

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
 * A private `whatToShow` bit asking for the FLAT tree rather than the node
 * tree: shadow content in its slot's place, and pseudo-element slots among the
 * children they belong beside.
 *
 * It rides in `whatToShow` because that is already the argument saying what a
 * walk is interested in, and because the bit is inert in the only test that
 * reads it: acceptance asks `1 << (nodeType - 1)`, and the highest node type
 * there is (NOTATION, 12) reaches 0x800, so nothing below can ever produce
 * this one. It is private because the flat tree is the box tree's view, not a
 * thing a page should be able to ask for -- `Document.createTreeWalker` masks
 * it off, which also stops the SHOW_ALL default from turning every walk flat.
 */
export const SHOW_FLAT = 0x1000;

/** Run a traverser's filter over a node. */
function filterNode(
	traverser: {
		root: Node;
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
			typeof filter === "function" ?
					filter(node) :
					(filter as {acceptNode(node: Node): number}).acceptNode(node);
	} finally {
		traverser.active.value = false;
	}
	return toUnsignedLong(result);
}

/** The next node in tree order after a node, inside a root. */
function followingWithin(node: Node, root: Node): Node | null {
	return nextInTree(node, root);
}

/** The node preceding a node in tree order, inside a root. */
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

export class NodeIterator {
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
		return traverse(this, true);
	}

	previousNode(): Node | null {
		return traverse(this, false);
	}

	detach(): void {
		// The spec keeps this as a no-op.
	}
}

function traverse(
	iterator: NodeIterator,
	forward: boolean,
): Node | null {
	let node: Node | null = iterator[kReference]!;
	let before = iterator[kPointerBefore]!;
	const state = {
		root: iterator[kRoot]!,
		whatToShow: iterator[kWhatToShow]!,
		filter: iterator[kFilter]!,
		active: iterator[kActive]!,
	};
	for (;;) {
		if (forward) {
			if (!before) {
				node = followingWithin(node as Node, iterator[kRoot]!);
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
			// A filter that removed the very node it was filtering leaves
			// the reference where the pre-removing steps put it: a node
			// outside the root can never be the reference.
			if (isInclusiveAncestor(iterator[kRoot]!, node as Node)) {
				iterator[kReference] = node as Node;
				iterator[kPointerBefore] = before;
			}
			break;
		}
	}
	return node;
}

/** The spec's NodeIterator pre-removing steps. */
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
		let next = followingWithin(toBeRemoved, iterator[kRoot]!);
		while (next !== null && isInclusiveAncestor(toBeRemoved, next)) {
			next = followingWithin(next, iterator[kRoot]!);
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

export class TreeWalker {
	declare [kRoot]?: Node;
	declare [kCurrent]?: Node;
	declare [kWhatToShow]?: number;
	declare [kFilter]?: NodeFilterInput;
	declare [kActive]?: {value: boolean};

	constructor(root: Node, whatToShow: number, filter: NodeFilterInput) {
		this[kActive] = {value: false};
		this[kRoot] = root;
		this[kCurrent] = root;
		this[kWhatToShow] = whatToShow;
		this[kFilter] = filter ?? null;
	}

	get root(): Node {
		return this[kRoot]!;
	}

	get whatToShow(): number {
		return this[kWhatToShow]!;
	}

	get filter(): NodeFilterInput {
		return this[kFilter]!;
	}

	get currentNode(): Node {
		return this[kCurrent]!;
	}

	set currentNode(node: Node) {
		if (!(node instanceof Node)) {
			throw new TypeError("That is not a node");
		}
		this[kCurrent] = node;
	}

	get [kState](): {
		root: Node;
		whatToShow: number;
		filter: NodeFilterInput;
		active: {value: boolean};
	} {
		return {
			root: this[kRoot]!,
			whatToShow: this[kWhatToShow]!,
			filter: this[kFilter]!,
			active: this[kActive]!,
		};
	}

	parentNode(): Node | null {
		return walkParent(this);
	}

	firstChild(): Node | null {
		return walkChildren(this, true);
	}

	lastChild(): Node | null {
		return walkChildren(this, false);
	}

	previousSibling(): Node | null {
		return walkSiblings(this, false);
	}

	nextSibling(): Node | null {
		return walkSiblings(this, true);
	}

	previousNode(): Node | null {
		return walkPrevious(this);
	}

	nextNode(): Node | null {
		return walkNext(this);
	}
}

Object.defineProperty(TreeWalker.prototype, Symbol.toStringTag, {
	value: "TreeWalker",
	configurable: true,
});

/* --------------------------------------------------------------- selectors */

/**
 * The element under the pointer, per document. Hover is not a mutation and
 * no attribute records it: the engine writes it here as motion reports
 * arrive, and the `:hover` resolver below reads it. Absent means nothing is
 * hovered -- a document without motion reporting, or a pointer that left.
 */
const hoveredElements = new WeakMap<Document, Element>();

/** Record the element the pointer is over, which `:hover` matches from. */
function setHoveredElement(
	document: Document,
	element: Element | null,
): void {
	if (element === null) {
		hoveredElements.delete(document);
	} else {
		hoveredElements.set(document, element);
	}
}

interface SelectorEngine {
	match(selector: string, element: never): boolean;
	first(selector: string, context: never): unknown;
	select(selector: string, context: never): unknown[];
	configure(options: Record<string, boolean>): void;
}

/** The selector engine a document queries through, built on first use. */
function selectorEngine(document: Document): SelectorEngine {
	let engine = document[kNwsapi]!;
	if (engine === null) {
		// nwsapi's factory registers document mouseover/mouseout listeners
		// for its own builtin :hover, which the rewrites below bypass; they
		// must not read as the document observing hover.
		hoverTallySuspended = true;
		try {
			engine = NWSAPI({
				document: document as never,
				DOMException: PlatformDOMException as never,
			});
		} finally {
			hoverTallySuspended = false;
		}
		engine.configure({
			LOGERRORS: false,
			IDS_DUPES: true,
			MIXEDCASE: true,
		});
		// `:modal` is a state no attribute records, so the engine cannot
		// derive it from the tree: it asks the document's top layer, through
		// the resolver object the compiled matchers already close over.
		engine.Snapshot.isModal = isModalDialog;
		engine.registerSelector(
			":modal",
			/^:modal(.*)/i,
			(match: string[], source: string) => ({
				match,
				source: `if(s.isModal(e)){${source}}`,
				status: true,
				modvar: null,
			}),
		);
		// `:popover-open` is the same kind of state: a popover's showing lives
		// in the top layer and in nothing the tree records, so the engine asks
		// rather than derives.
		engine.Snapshot.isPopoverOpen = isShowingPopover;
		engine.registerSelector(
			":popover-open",
			/^:popover-open(.*)/i,
			(match: string[], source: string) => ({
				match,
				source: `if(s.isPopoverOpen(e)){${source}}`,
				status: true,
				modvar: null,
			}),
		);
		// `:focus` per HTML, not per light tree: the focused element
		// matches wherever it is, and so does every shadow host on the
		// chain above it -- which the engine's document.activeElement
		// cannot see, since retargeting stops at the first host.
		engine.Snapshot.hasFocusState = (element: Element): boolean => {
			const active = document[kActiveElement]!;
			if (active === null) {
				return false;
			}
			if (element === active) {
				return true;
			}
			for (
				let root = getRoot(active);
				isShadowRoot(root);
				root = getRoot(root as unknown as Node)
			) {
				const host = (root as ShadowRoot)[kHost]! as Element;
				if (host === element) {
					return true;
				}
				root = host as unknown as Node;
			}
			return false;
		};
		engine.registerSelector(
			":-termdom-focus",
			/^:-termdom-focus(?![\w-])(.*)/i,
			(match: string[], source: string) => ({
				match,
				source: `if(s.hasFocusState(e)){${source}}`,
				status: true,
				modvar: null,
			}),
		);
		// `:focus-within` climbs the same chain and keeps going: every
		// ancestor and every host above the focused element matches.
		engine.Snapshot.hasFocusWithinState = (element: Element): boolean => {
			const active = document[kActiveElement]!;
			for (
				let node: Element | null = active;
				node !== null;

			) {
				if (node === element) {
					return true;
				}
				const parent: Element | null = node.parentElement;
				if (parent !== null) {
					node = parent;
					continue;
				}
				const root = getRoot(node);
				node = isShadowRoot(root) ?
						((root as ShadowRoot)[kHost]! as Element) :
					null;
			}
			return false;
		};
		engine.registerSelector(
			":-termdom-focus-within",
			/^:-termdom-focus-within(?![\w-])(.*)/i,
			(match: string[], source: string) => ({
				match,
				source: `if(s.hasFocusWithinState(e)){${source}}`,
				status: true,
				modvar: null,
			}),
		);
		// `:hover` matches the element under the pointer and its flat-tree
		// ancestors, per css-selectors-4's "an element that is designated" --
		// which slot projection and shadow hosts reorder past what the light
		// tree records, so the climb is the flat parent's.
		engine.Snapshot.hasHoverState = (element: Element): boolean => {
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
		};
		engine.registerSelector(
			":-termdom-hover",
			/^:-termdom-hover(?![\w-])(.*)/i,
			(match: string[], source: string) => ({
				match,
				source: `if(s.hasHoverState(e)){${source}}`,
				status: true,
				modvar: null,
			}),
		);
		// The engine's own compiled `:focus` family predates shadow trees:
		// its focus test wants a focusable-looking shape at
		// document.activeElement, and its `:focus-within` cannot reach an
		// ancestor at all. Its `:hover` predates hover state existing here at
		// all. The names above resolve through the raw states instead, and
		// every selector is spelled onto them on the way in -- the four entry
		// points below are the only doors.
		const STATE_REWRITES: Array<[RegExp, string]> = [
			[/:focus-within(?![\w-])/gi, ":-termdom-focus-within"],
			[/:focus-visible(?![\w-])/gi, ":-termdom-focus"],
			[/:focus(?![\w-])/gi, ":-termdom-focus"],
			[/:hover(?![\w-])/gi, ":-termdom-hover"],
		];
		const rewriteState = (selector: string): string => {
			if (!/:focus|:hover/i.test(selector)) {
				return selector;
			}
			let rewritten = selector;
			for (const [pattern, name] of STATE_REWRITES) {
				rewritten = rewritten.replace(pattern, name);
			}
			return rewritten;
		};
		const rawMatch = engine.match.bind(engine);
		const rawFirst = engine.first.bind(engine);
		const rawSelect = engine.select.bind(engine);
		const withClosest = engine as unknown as {
			closest(selector: string, ...rest: unknown[]): unknown;
		};
		const rawClosest = withClosest.closest.bind(engine);
		engine.match = (selector: string, element: unknown, ...rest: unknown[]) =>
			rawMatch(rewriteState(selector), element, ...rest);
		engine.first = (selector: string, ...rest: unknown[]) =>
			rawFirst(rewriteState(selector), ...rest);
		engine.select = (selector: string, ...rest: unknown[]) =>
			rawSelect(rewriteState(selector), ...rest);
		withClosest.closest = (selector: string, ...rest: unknown[]) =>
			rawClosest(rewriteState(selector), ...rest);
		if (document.documentElement !== null) {
			document[kNwsapi] = engine;
		}
	}
	return engine as unknown as SelectorEngine;
}

/* ----------------------------------------------------------------- parsing */

interface ParseAttribute {
	name: string;
	value: string;
	namespace?: string;
	prefix?: string;
}

/**
 * The registry the parser gives what it builds.
 *
 * A fragment parsed into an element belongs to that element's registry, and a
 * document's own markup to the document's; the variable holds whichever parse
 * is running.
 */
let parseRegistry: CustomElementRegistry | null | undefined = undefined;

/**
 * The tree adapter parse5 builds through.
 *
 * Every node it creates belongs to the document the adapter was made for, and
 * every insertion runs the same algorithm a script's appendChild runs, so a
 * parsed tree and a scripted tree are the same tree.
 */
// The return type is parse5's structural TreeAdapter, spelled by the object.
// eslint-disable-next-line @b9g/explicit-declaration-return-type
function treeAdapterFor(document: Document | null) {
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
			return (target as Document).createDocumentFragment();
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
			return (target as Document).createComment(data);
		},
		createTextNode(value: string): Text {
			return (target as Document).createTextNode(value);
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
			const existing = documentNode.doctype;
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
				(target as Document).createTextNode(text),
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
				(target as Document).createTextNode(text),
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
			return childNodeArray(node);
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

/**
 * Take a subtree out of whatever registry the parse gave it.
 *
 * A declarative shadow root that asks to be scoped has no registry until one
 * claims it, and neither does anything the parser wrote inside it. A shadow
 * tree further down keeps whatever it was given.
 */
function clearRegistry(node: Node): void {
	node[kRegistry] = null;
	for (let child = node[kFirstChild]!; child !== null; child = child[kNext]!) {
		clearRegistry(child);
	}
}

/**
 * Turn the templates a declarative shadow root was parsed as into shadow
 * trees.
 *
 * The HTML parser attaches a shadow root the moment it sees a template whose
 * shadowrootmode names a mode; parse5 has no such step, so the templates land
 * as templates and this walk converts them afterwards. The walk is depth-first
 * over the tree it is given and then over each shadow tree it creates, which
 * reaches a nested declarative root inside one. A template whose parent cannot
 * host a shadow tree, or whose parent already hosts one, stays a template --
 * the parser's own error handling.
 */
function attachDeclarativeShadowRoots(root: Node): void {
	for (const child of childNodeArray(root)) {
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

/** Turn one template into its host's shadow root, if it names a mode. */
function attachDeclarativeShadowRoot(template: HTMLTemplateElement): boolean {
	const named = template.getAttribute("shadowrootmode");
	if (named === null) {
		return false;
	}
	const mode = asciiLowercase(named);
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
			// scoped to one it has not been given yet, so it starts with none.
			template.hasAttribute("shadowrootcustomelementregistry") ?
				null :
				globalCustomElements,
		);
	} catch (_err) {
		return false;
	}
	const shadow = (host as Element)[kShadowRoot]! as ShadowRoot;
	shadow[kDeclarative] = true;
	const content = template[kTemplateContent]!;
	removeNode(template);
	if (content !== null) {
		for (const child of childNodeArray(content)) {
			if (shadow[kRegistry] === null) {
				clearRegistry(child);
			}
			insertNode(child, shadow, null, true);
		}
	}
	attachDeclarativeShadowRoots(shadow);
	return true;
}

/**
 * Parse a document, which is the one document of this realm: it carries the
 * realm's registry, and every document an author builds carries none until a
 * registry claims it, exactly as a document with no browsing context does.
 */
export function parseHTMLDocument(
	html: string,
	url = "about:blank",
	allowDeclarativeShadowRoots = true,
	registry: CustomElementRegistry | null = globalCustomElements,
): Document {
	const adapter = treeAdapterFor(null);
	const outerRegistry = parseRegistry;
	parseRegistry = registry;
	let document: Document;
	try {
		document = parse5Parse(html, {
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

/**
 * The HTML fragment parsing algorithm, with a context element.
 *
 * A declarative shadow root only becomes one where the caller allowed it:
 * innerHTML does not, and setHTMLUnsafe and parseHTMLUnsafe do.
 */
function parseFragmentHTML(
	markup: string,
	context: Element,
	allowDeclarativeShadowRoots = false,
): DocumentFragment {
	const document = context[kDocument]!;
	const adapter = treeAdapterFor(document);
	const outerRegistry = parseRegistry;
	parseRegistry = context[kRegistry]!;
	let parsed: DocumentFragment;
	try {
		parsed = parseFragment(context as never, markup, {
			treeAdapter: adapter as never,
		}) as unknown as DocumentFragment;
	} finally {
		parseRegistry = outerRegistry;
	}
	const fragment = document.createDocumentFragment();
	for (const child of childNodeArray(parsed)) {
		insertNode(child, fragment, null, true);
	}
	if (allowDeclarativeShadowRoots) {
		attachDeclarativeShadowRoots(fragment);
	}
	return fragment;
}

/** Parse a whole document, declarative shadow roots and all. */
function parseHTMLUnsafe(html: string): Document {
	return parseHTMLDocument(String(html), "about:blank", true, null);
}

/* ------------------------------------------------------------- XML parsing */

/** A well-formedness violation, which becomes a parsererror document. */
class XMLWellFormednessError extends Error {}

/**
 * The namespace Firefox coined for the error document, which the spec's
 * DOMParser algorithm adopted for the parsererror root.
 */
const PARSERERROR_NAMESPACE =
	"http://www.mozilla.org/newlayout/xml/parsererror.xml";

// Characters the XML Char production excludes: most C0 controls, the two
// permanent non-characters, and a surrogate half without its partner.
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

/** A character reference must name a Char, not a control or a surrogate. */
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

/**
 * The namespace bindings in scope at one element, chained to the bindings
 * above it. The root scope binds the two prefixes XML reserves.
 */
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

/**
 * A recursive-descent XML parser over the whole source string, building the
 * tree with the internal constructors the HTML tree adapter uses.
 *
 * It enforces well-formedness -- one root, matching tags, bound prefixes,
 * defined entities -- and throws XMLWellFormednessError where the XML or
 * Namespaces recommendations call a document not well-formed. A DTD internal
 * subset is skipped rather than processed, so an entity it declares is still
 * reported as undefined, as a non-validating processor may.
 */
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

	/** Resolve the reference at pos, which points at the ampersand. */
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

	/**
	 * Split a qualified name against the bindings in scope. An element takes
	 * the default namespace; an unprefixed attribute takes none.
	 */
	function resolveQualifiedName(
		qualifiedName: string,
		scope: XMLNamescope,
		forAttribute: boolean,
	): {namespace: string | null; prefix: string | null; localName: string} {
		const colon = qualifiedName.indexOf(":");
		if (colon === -1) {
			if (forAttribute) {
				return {namespace: null, prefix: null, localName: qualifiedName};
			}
			return {
				namespace: lookupXMLPrefix(scope, "") ?? null,
				prefix: null,
				localName: qualifiedName,
			};
		}
		const prefix = qualifiedName.slice(0, colon);
		const localName = qualifiedName.slice(colon + 1);
		if (prefix === "" || localName === "" || localName.includes(":")) {
			fail(`"${qualifiedName}" is not a valid qualified name`);
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

	/** Skip a pseudo-attribute of the XML declaration, returning its value. */
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

	/** Skip the bracketed internal subset, honoring its quotes and comments. */
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

	/** A doctype literal: quoted, and taken as-is with no references. */
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
		const text = document.createTextNode(data);
		insertNode(text, parent, null, true);
	}

	function parseElement(parent: Node, parentScope: XMLNamescope): void {
		const qualifiedName = scanName();
		interface ParsedAttribute {
			qualifiedName: string;
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
				fail(`The <${qualifiedName}> tag is missing its closing >`);
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
				if (attribute.qualifiedName === attributeName) {
					fail(`The attribute "${attributeName}" is repeated`);
				}
			}
			attributes.push({qualifiedName: attributeName, value});
		}
		let scope = parentScope;
		const bindings = new Map<string, string | null>();
		for (const attribute of attributes) {
			let boundPrefix: string | null = null;
			if (attribute.qualifiedName === "xmlns") {
				boundPrefix = "";
			} else if (attribute.qualifiedName.startsWith("xmlns:")) {
				boundPrefix = attribute.qualifiedName.slice("xmlns:".length);
				if (boundPrefix === "" || boundPrefix.includes(":")) {
					fail(`"${attribute.qualifiedName}" is not a namespace declaration`);
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
		const resolved = resolveQualifiedName(qualifiedName, scope, false);
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
			let localName = attribute.qualifiedName;
			if (attribute.qualifiedName === "xmlns") {
				namespace = XMLNS_NAMESPACE;
			} else if (attribute.qualifiedName.startsWith("xmlns:")) {
				namespace = XMLNS_NAMESPACE;
				prefix = "xmlns";
				localName = attribute.qualifiedName.slice("xmlns:".length);
			} else {
				const extracted = resolveQualifiedName(
					attribute.qualifiedName,
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
			fail(`The <${qualifiedName}> element is never closed`);
		}
		const closing = scanName();
		if (closing !== qualifiedName) {
			fail(`</${closing}> does not match the open <${qualifiedName}>`);
		}
		skipWhitespace();
		if (!eat(">")) {
			fail(`The </${qualifiedName}> tag is missing its closing >`);
		}
	}

	/** Parse element content until an end tag or the end of input. */
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

/**
 * The DOMParser XML path: a well-formed document becomes the tree it
 * describes, and anything else becomes the spec's error document, whose root
 * is a parsererror element holding the failure.
 */
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
		for (const child of childNodeArray(document)) {
			removeNode(child, true);
		}
		const parserError = createElementInternal(
			document,
			"parsererror",
			PARSERERROR_NAMESPACE,
		);
		const text = document.createTextNode(error.message);
		insertNode(text, parserError, null, true);
		insertNode(parserError, document, null, true);
	}
	return document;
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

Object.defineProperty(DOMParser.prototype, Symbol.toStringTag, {
	value: "DOMParser",
	configurable: true,
});

/* ----------------------------------------------------------- serialization */

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

/** The elements whose parser drops a newline that opens their content. */
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

function attributeSerializedName(attribute: Attr): string {
	const namespace = attribute[kNamespace]!;
	if (namespace === null) {
		return attribute[kLocalName]!;
	}
	if (namespace === XML_NAMESPACE) {
		return `xml:${attribute[kLocalName]!}`;
	}
	if (namespace === XMLNS_NAMESPACE) {
		return attribute[kLocalName] === "xmlns" ?
			"xmlns" :
			`xmlns:${attribute[kLocalName]!}`;
	}
	if (namespace === XLINK_NAMESPACE) {
		return `xlink:${attribute[kLocalName]!}`;
	}
	return attribute[kQualifiedName]!;
}

/**
 * The HTML fragment serialization algorithm, over a node's children.
 *
 * A shadow root is written out as the template the parser reads back, but only
 * where the caller asked for it: getHTML's options say whether a serializable
 * root counts and name the closed roots to include. innerHTML asks for none,
 * so a shadow tree stays invisible to it.
 */
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

function serializeOuterHTML(element: Element): string {
	return serializeNode(element, false, []);
}

/** The template a declarative shadow root serializes as. */
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
				namespace === SVG_NAMESPACE ?
					element[kLocalName]! :
					element[kQualifiedName]!;
			let html = `<${tagName}`;
			for (const attribute of element[kAttributeList]!) {
				html += ` ${attributeSerializedName(attribute)}="${escapeAttribute(
					attribute[kValue]!,
				)}"`;
			}
			html += ">";
			if (namespace === HTML_NAMESPACE && VOID_ELEMENTS.has(tagName)) {
				return html;
			}
			// The parser drops a newline that opens a pre, textarea or listing,
			// so serializing one writes a second newline for the parser to eat
			// and the first to survive the round trip.
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

/* --------------------------------------------------- custom element boundaries */

/**
 * Every member the IDL marks [CEReactions], wrapped once the prototypes are
 * complete.
 *
 * The list is the extended attribute's, read off the interfaces this DOM has:
 * anything that can insert, remove, rename or restyle a node is here, and
 * nothing else is. A member missing from this list would run an author's
 * callback in the middle of the mutation that caused it instead of after it.
 */
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

/**
 * The [CEReactions] members of the HTML element interfaces that are not
 * reflections. Every reflecting member is already a boundary, because the
 * table installs its setter as one.
 */
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

/**
 * The event handler IDL attributes, on the interfaces that include each mixin.
 *
 * GlobalEventHandlers and DocumentAndElementEventHandlers are included by the
 * three element interfaces HTML, SVG and MathML define and by Document; the
 * WindowEventHandlers set belongs to the window, which the engine builds, and
 * is forwarded from `body` and `frameset` to it.
 *
 * Only the content-attribute half of the feature is missing: `onclick="..."`
 * in markup is a function compiled from source, and this DOM never executes
 * script.
 */
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

/* -------------------------------------------------------------- mounting */

/**
 * The engine's answers for the APIs a document alone cannot give --
 * geometry so far; the rest of the installed surface migrates here. A
 * mounting engine installs one per document, and a node reaches it
 * through its ownerDocument, one hop. A headless document has none: it is
 * the spec's no-browsing-context document, and the members consulting a
 * mount degrade to that -- zero rects, empty lists, null parents.
 */
export interface Mount {
	boundingClientRect(element: object): globalThis.DOMRect;
	clientRects(element: object): globalThis.DOMRectList;
	rangeBoundingClientRect(range: object): globalThis.DOMRect;
	rangeClientRects(range: object): globalThis.DOMRectList;
	/** The border-box size offsetWidth/offsetHeight report, rounded. */
	offsetSize(element: object): {width: number; height: number};
	/** The offsetParent-relative position offsetTop/offsetLeft report. */
	offsetPosition(element: object): {top: number; left: number};
	offsetParent(element: object): object | null;
	clientSize(element: object): {width: number; height: number};
	clientEdge(element: object): {left: number; top: number};
	scrollSize(element: object): {width: number; height: number};
	/** How far a box is scrolled from its content's origin, in cells. */
	scrollOffset(element: object): {left: number; top: number};
	/**
	 * Round the write to whole cells, clamp it into the scrollable range,
	 * store it and schedule the repaint that shows it.
	 */
	scrollOffsetTo(
		element: object,
		axis: "left" | "top",
		value: number,
	): void;
	elementFromPoint(document: object, x: number, y: number): object | null;
	elementsFromPoint(document: object, x: number, y: number): object[];
	/** Whether the element is rendered, on the options' definition. */
	checkVisibility(element: object, options?: object): boolean;
	/**
	 * The focus state has moved to the element from the previous focus.
	 * Fire the events the move fires and repaint for the :focus rules it
	 * brings in.
	 */
	focusMoved(previous: object | null, element: object): void;
	/** The element has given up the focus state. */
	blurred(element: object): void;
	/** The document's selection has moved, so the highlight has too. */
	selectionMoved(): void;
	/** Reveal the element in every scroll port between it and the screen. */
	scrollIntoView(element: object): void;
	/** An author attached a shadow root to the host. */
	shadowAttached(host: object, root: object): void;
	/**
	 * The terminal's size in cells, which is the window's size and the
	 * screen's both, and the height the root elements report as their
	 * client height.
	 */
	viewportSize(): {width: number; height: number};
	/** The screen row the document's first row is anchored to. */
	screenTop(): number;
	/** How far the document camera has moved, in cells. */
	documentScrollOffset(): {left: number; top: number};
	/** Move the document camera to an offset and repaint. */
	scrollDocumentTo(top: number): void;
	/** Move the document camera by a delta and repaint. */
	scrollDocumentBy(top: number): void;
	/** Schedule a frame, and fire the callback once it has been painted. */
	requestFrame(callback: (time: number) => void): number;
	/** Drop a frame callback that has not fired. */
	cancelFrame(handle: number): void;
	/** Whether a media query matches, on the evaluator @media rules use. */
	mediaMatches(query: string): boolean;
	/** Re-ask a live media query list whenever the viewport moves. */
	watchMedia(update: () => void): void;
	/** The window was closed, and the beforeunload gate let it through. */
	closeRequested(): void;
	/** The document's title changed, which is the terminal's title. */
	titleChanged(title: string): void;
	/** The document was closed: seal what it painted into the scrollback. */
	documentClosed(): void;
	/** The terminal the clipboard moves text over, when one is attached. */
	clipboardTerminal(): ClipboardTerminal | null;
	/** Whether an activation-triggering event is being dispatched right now. */
	userActive(): boolean;
	/** Whether the user has ever acted on this document. */
	everActivated(): boolean;
	requestFullscreen(element: object, options?: object): Promise<void>;
	exitFullscreen(document: object): Promise<void>;
	fullscreenElement(document: object): object | null;
	/**
	 * The document's hover-listener count moved. The handle's reader
	 * answers the new count; the engine decides whether motion reporting
	 * is worth its cost on the wire.
	 */
	hoverListenersChanged(): void;
}

/**
 * The state feeds a mounted document accepts only from its engine: what the
 * handle writes, no one else can.
 */
export interface MountHandle {
	/** The element the pointer is over, which `:hover` matches from. */
	hoveredElement(element: object | null): void;
	/** How many hover-sensitive listeners the document holds now. */
	hoverListenerCount(): number;
}

const kMount = Symbol("mount");

/** Mount a document on its engine. Once per document. */
export function mount(document: object, engine: Mount): MountHandle {
	const doc = document as Record<symbol, Mount | undefined>;
	if (doc[kMount] !== undefined) {
		throw new Error("This document already has its engine.");
	}
	doc[kMount] = engine;
	const mounted = document as Document;
	const readCount = watchHoverListeners(mounted, () =>
		engine.hoverListenersChanged(),
	);
	return {
		hoveredElement(element: object | null): void {
			setHoveredElement(mounted, element as Element | null);
		},
		hoverListenerCount: readCount,
	};
}

/** The mount of a node's document, or undefined when it is headless. */
export function mountOf(node: object): Mount | undefined {
	const shaped = node as {nodeType?: number; ownerDocument?: object | null};
	const document =
		shaped.nodeType === DOCUMENT_NODE ? node : shaped.ownerDocument;
	return (document as Record<symbol, Mount | undefined> | null)?.[kMount];
}

/* ------------------------------------------------- clipboard and permissions */

/** The two clipboard round trips a terminal session answers. */
interface ClipboardTerminal {
	writeClipboard(text: string): Promise<void>;
	queryClipboard(): Promise<string | null>;
}

/** The payload OSC 52 carries, which is text and only text. */
const CLIPBOARD_TEXT_TYPE = "text/plain";

/** Refuse a clipboard request the user has not asked for. */
function clipboardDenied(why: string): Promise<never> {
	return Promise.reject(domError("NotAllowedError", why));
}

/** A media type, lowercased with the surrounding whitespace dropped. */
function normalizeMediaType(type: unknown): string {
	return String(type).trim().toLowerCase();
}

const kItemEntries = Symbol("entries");

/**
 * A payload the clipboard moves, held under the media types it reads as.
 *
 * Blob is the platform's, which Node and Bun both have as a global. OSC 52
 * carries one payload a terminal treats as text, so text/plain is the only
 * type a write sends and the only type a read answers with; an item may hold
 * others, and the clipboard passes over them.
 */
export class ClipboardItem {
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
					held instanceof Blob ?
						held :
							new Blob([String(held)], {type: mediaType}),
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

	getType(type: string): Promise<Blob> {
		const held = this[kItemEntries]!.get(normalizeMediaType(type));
		if (held === undefined) {
			return Promise.reject(
				notFoundError(`That item carries no ${normalizeMediaType(type)}`),
			);
		}
		return held;
	}

	static supports(type: string): boolean {
		return normalizeMediaType(type) === CLIPBOARD_TEXT_TYPE;
	}
}

Object.defineProperty(ClipboardItem.prototype, Symbol.toStringTag, {
	value: "ClipboardItem",
	configurable: true,
});

/** The terminal to move bytes over, or the refusal standing in its way. */
type Reached =
	{terminal: ClipboardTerminal; refusal: null} |
	{terminal: null; refusal: Promise<never>};

/**
 * The terminal a document's clipboard reaches, or why it may not.
 *
 * The clipboard is the user's to grant, so it is reachable only from a
 * trusted activation-triggering event while it is being dispatched -- a
 * keystroke, a mouse press or release, a click, a paste. This is stricter
 * than a browser on purpose: a browser's transient activation outlives the
 * dispatch that granted it, because its window is a span of time, so a
 * handler there may await and still write the clipboard. Here the gate is the
 * dispatch itself, and the clipboard is reachable only synchronously within
 * it. A timer, a microtask, a resolved fetch and an event an application
 * dispatched itself are all outside.
 */
function reachClipboard(document: Document, what: string): Reached {
	const mount = mountOf(document);
	const terminal = mount?.clipboardTerminal() ?? null;
	if (terminal === null) {
		return {
			terminal: null,
			refusal: clipboardDenied(
				"clipboard requires an attached interactive terminal",
			),
		};
	}
	if (!mount!.userActive()) {
		return {
			terminal: null,
			refusal: clipboardDenied(`clipboard ${what} need a user gesture`),
		};
	}
	return {terminal, refusal: null};
}

const kClipboardDocument = Symbol("the document whose clipboard this is");

/**
 * The clipboard, as navigator.clipboard.
 *
 * writeText() carries the text to the system clipboard over OSC 52, which
 * travels in-band -- across SSH too. Terminals without OSC 52 ignore it;
 * there is no way to know, so the promise resolves when the transport has the
 * bytes. readText() asks for the clipboard the same way (OSC 52 with `?` for
 * the payload) and resolves with what comes back. write() and read() are the
 * same two round trips over a ClipboardItem.
 *
 * It is an EventTarget because the interface says so; the user agent fires
 * nothing at it.
 */
export class Clipboard extends EventTarget {
	declare [kClipboardDocument]?: Document;

	constructor(document?: Document) {
		super();
		if (!internalConstruction) {
			throw new TypeError("Illegal constructor");
		}
		this[kClipboardDocument] = document as Document;
	}

	writeText(text: string): Promise<void> {
		const reached = reachClipboard(this[kClipboardDocument]!, "writes");
		if (reached.refusal !== null) {
			return reached.refusal;
		}
		return reached.terminal.writeClipboard(String(text));
	}

	async readText(): Promise<string> {
		const reached = reachClipboard(this[kClipboardDocument]!, "reads");
		if (reached.refusal !== null) {
			return reached.refusal;
		}
		const text = await reached.terminal.queryClipboard();
		if (text === null) {
			// Silence is a refusal: most terminals gate clipboard reads on
			// their own configuration and answer nothing when they are off.
			return clipboardDenied("the terminal did not answer the clipboard query");
		}
		return text;
	}

	async write(items: Iterable<ClipboardItem>): Promise<void> {
		const reached = reachClipboard(this[kClipboardDocument]!, "writes");
		if (reached.refusal !== null) {
			return reached.refusal;
		}
		let carrier: ClipboardItem | null = null;
		for (const item of items) {
			if (item.types.includes(CLIPBOARD_TEXT_TYPE)) {
				carrier = item;
				break;
			}
		}
		if (carrier === null) {
			return clipboardDenied(
				`a clipboard write needs a ${CLIPBOARD_TEXT_TYPE} entry`,
			);
		}
		const text = await (await carrier.getType(CLIPBOARD_TEXT_TYPE)).text();
		return reached.terminal.writeClipboard(text);
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

Object.defineProperty(Clipboard.prototype, Symbol.toStringTag, {
	value: "Clipboard",
	configurable: true,
});

// The permission names the clipboard here answers for, and the ones the
// Permissions API defines that a terminal has nothing behind: no camera, no
// microphone, no location, no notification surface, so the answer is denied
// rather than a prompt nobody could ever answer.
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

/**
 * The standing of one permission.
 *
 * `state` is read at the moment it is asked, and for the clipboard that
 * answer is granted while a gesture is being dispatched and prompt outside
 * one. Nothing fires `change`: the gesture opens and closes inside a single
 * dispatch, and a listener would be told about a state that had already
 * passed.
 */
export class PermissionStatus extends EventTarget {
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
		const mount = mountOf(document);
		if (!mount || mount.clipboardTerminal() === null) {
			return "denied";
		}
		return mount.userActive() ? "granted" : "prompt";
	}
}

// The one event handler attribute a permission status carries. An event
// handler attribute IS a listener, per spec: routing it through
// add/removeEventListener keeps dispatch order and dedup like any other.
const kOnChange = Symbol("onchange");
Object.defineProperty(PermissionStatus.prototype, "onchange", {
	get(this: PermissionStatus): unknown {
		return (this as unknown as Record<symbol, unknown>)[kOnChange] ?? null;
	},
	set(this: PermissionStatus, value: unknown): void {
		const held = this as unknown as Record<symbol, unknown>;
		type Listener = Parameters<PermissionStatus["addEventListener"]>[1];
		const previous = held[kOnChange]! as Listener | undefined;
		if (previous) {
			this.removeEventListener("change", previous);
		}
		const next = typeof value === "function" ? (value as Listener) : null;
		held[kOnChange] = next;
		if (next) {
			this.addEventListener("change", next);
		}
	},
	enumerable: true,
	configurable: true,
});

Object.defineProperty(PermissionStatus.prototype, Symbol.toStringTag, {
	value: "PermissionStatus",
	configurable: true,
});

/** navigator.permissions: what the gate above answers, asked by name. */
export class Permissions extends EventTarget {
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

/* ---------------------------------------------------------------- window */

const kNavigator = Symbol("navigator");

/**
 * The window a document is displayed in: an EventTarget whose members are
 * the browsing context's, answered by the engine the document is mounted on.
 *
 * A window exists mounted -- a headless document has none -- so the members
 * below may expect a mount, and degrade the way the document's own do when
 * one is absent: a viewport of no size, a camera at the origin, a query that
 * matches nothing.
 */
export class Window extends EventTarget {
	readonly document: Document;
	declare [kNavigator]?: Navigator | undefined;
	constructor(document: Document) {
		super();
		this.document = document;
		// Displaying a document is what gives it a defaultView, and the
		// displayed document is the one bare node constructors belong to.
		document[kDefaultView] = this;
		ambientDocument = document;
	}

	// The realm has one registry: definitions are per-realm because the
	// classes are, and a window names the registry the realm holds.
	get customElements(): CustomElementRegistry {
		return customElements;
	}

	// The terminal is the window and the screen both, so the inner and outer
	// pairs are one size. Readonly like a browser's, and LIVE: a SIGWINCH
	// moves them, and a value frozen at construction would have reported the
	// size the terminal had when the engine was built.
	get innerWidth(): number {
		return mountOf(this.document)?.viewportSize().width ?? 0;
	}

	get outerWidth(): number {
		return this.innerWidth;
	}

	get innerHeight(): number {
		return mountOf(this.document)?.viewportSize().height ?? 0;
	}

	get outerHeight(): number {
		return this.innerHeight;
	}

	// screenTop: readonly like browsers, and LIVE -- cursor detection moves
	// the anchor after the window is built.
	get screenTop(): number {
		return mountOf(this.document)?.screenTop() ?? 0;
	}

	// Standard window scrolling, mapped onto the camera: scrollY is how far
	// the camera has moved down the document, scrollBy moves it. A terminal
	// document never scrolls sideways, so the X pair reads 0.
	get scrollY(): number {
		return mountOf(this.document)?.documentScrollOffset().top ?? 0;
	}

	get pageYOffset(): number {
		return this.scrollY;
	}

	get scrollX(): number {
		return mountOf(this.document)?.documentScrollOffset().left ?? 0;
	}

	get pageXOffset(): number {
		return this.scrollX;
	}

	// scrollTo/scroll set the camera to an absolute position -- the state
	// scrollY reads and scrollBy moves relatively. documentElement/body's
	// scrollTop is that value again, standard DOM (window.scrollY ===
	// document.documentElement.scrollTop always): one camera, four ways to
	// read or move it.
	scrollTo(xOrOptions?: number | ScrollToOptions, y?: number): void {
		const mount = mountOf(this.document);
		const top =
			typeof xOrOptions === "object" && xOrOptions !== null ?
					(xOrOptions.top ?? mount?.documentScrollOffset().top ?? 0) :
					(y ?? 0);
		mount?.scrollDocumentTo(top);
	}

	scroll(xOrOptions?: number | ScrollToOptions, y?: number): void {
		this.scrollTo(xOrOptions, y);
	}

	scrollBy(xOrOptions?: number | ScrollToOptions, y?: number): void {
		const top =
			typeof xOrOptions === "object" && xOrOptions !== null ?
					(xOrOptions.top ?? 0) :
					(y ?? 0);
		mountOf(this.document)?.scrollDocumentBy(top);
	}

	// requestAnimationFrame is the only way to await a painted frame: it
	// schedules a render and fires the callback once that render completes,
	// so "await a frame" always means the frame carrying the pending
	// mutations has landed.
	requestAnimationFrame(callback: FrameRequestCallback): number {
		return mountOf(this.document)?.requestFrame(callback) ?? 0;
	}

	cancelAnimationFrame(handle: number): void {
		mountOf(this.document)?.cancelFrame(handle);
	}

	/**
	 * The user agent, as a page asks about it: what it calls itself, what
	 * languages it reads, and -- once an engine stands behind the document --
	 * the clipboard, the permissions over it, and whether the user is active.
	 *
	 * Built on first read and kept, so the clipboard a page holds on to is
	 * the clipboard it keeps holding.
	 */
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
						return mountOf(document)?.everActivated() ?? false;
					},
					get isActive(): boolean {
						return mountOf(document)?.userActive() ?? false;
					},
				},
			} as unknown as Navigator;
			this[kNavigator] = navigator;
		}
		return navigator;
	}

	/**
	 * The Selection API defines the window's getSelection as a call to the
	 * document's, and this is that call.
	 */
	getSelection(): Selection | null {
		return this.document.getSelection();
	}

	/**
	 * matchMedia: the terminal is the one screen, and queries answer through
	 * the SAME evaluator @media stylesheet rules use, so a script and a
	 * stylesheet can never disagree about the viewport.
	 *
	 * The list is live: a resize (SIGWINCH is this screen's window resize)
	 * re-asks and fires "change" when the answer flips -- the browser
	 * contract, which is what makes responsive terminal layouts a matchMedia
	 * listener instead of a bespoke resize hook.
	 */
	matchMedia(query: string): MediaQueryList {
		const media = String(query);
		const mount = mountOf(this.document);
		const matches = (): boolean => mount?.mediaMatches(media) ?? false;
		const list = new EventTarget();
		// `matches` reads live; this holds the value the last "change" event
		// reported.
		let notified = matches();
		let onchange: ((event: Event) => void) | null = null;
		Object.defineProperties(list, {
			media: {get: () => media, enumerable: true, configurable: true},
			matches: {get: matches, enumerable: true, configurable: true},
			onchange: {
				get: () => onchange,
				set: (value: ((event: Event) => void) | null) => {
					// An event-handler attribute IS a listener, per spec:
					// route it through add/removeEventListener so dispatch
					// order and dedup behave like any other handler.
					if (onchange) {
						list.removeEventListener("change", onchange);
					}
					onchange = typeof value === "function" ? value : null;
					if (onchange) {
						list.addEventListener("change", onchange);
					}
				},
				enumerable: true,
				configurable: true,
			},
			// The pre-2020 MediaQueryList API, still what much deployed code
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
		mount?.watchMedia(() => {
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

	/**
	 * Close the window, which closes the terminal session as it would close
	 * a browser tab.
	 *
	 * beforeunload is the door out, and a listener that cancels keeps the
	 * session. A browser answers a canceled beforeunload with a prompt of its
	 * own; a terminal has no UA chrome to prompt with, so cancellation stops
	 * the teardown, leaving the app to ask "are you sure?" however it likes
	 * and to close again once the user says yes. Every close asks: the event
	 * carries nothing from the last one.
	 */
	close(): void {
		const mount = mountOf(this.document);
		if (mount === undefined) {
			return;
		}
		const event = createBeforeUnloadEvent();
		dispatchAsUserAgent(this, event);
		if (event.defaultPrevented || event.returnValue !== "") {
			return;
		}
		mount.closeRequested();
	}
}

// A window carries both event handler mixins the HTML Standard gives it:
// GlobalEventHandlers, which it shares with elements and documents, and
// WindowEventHandlers, whose members exist as attributes whether or not this
// engine has anything that fires them.
installEventHandlers(Window.prototype, GLOBAL_EVENT_HANDLERS);
installEventHandlers(Window.prototype, WINDOW_EVENT_HANDLERS);

/**
 * ---- The platform's shape, held by the compiler --------------------------
 *
 * For each class above, the members lib.dom declares that the class type
 * does not, asserted EQUAL to a ledger. A member appearing on neither
 * side is conformance; a member missing from the ledger is drift the
 * build refuses; a ledger entry the type grew into is staleness the
 * build refuses just the same.
 *
 * The bins the ledger's comments sort by:
 * - RUNTIME: real on instances -- the tables in htmltables.ts and the
 *   engine install them -- but invisible to the class type. Type debt,
 *   not missing behavior.
 * - GAP: not implemented at all. Work candidates.
 * - NEVER: deliberately absent on a terminal.
 *
 * Key coverage only, by design: whole-interface assignability is
 * transitively global (one interface drags the entire co-recursive type
 * graph, including lib.dom's own inaccuracies), so signatures graduate
 * member by member instead.
 */

/** The platform keys an internal type has not declared. */
type MissingFrom<Platform, Internal> = Exclude<keyof Platform, keyof Internal>;

/** Exact equality of two key unions, either direction's drift refused. */
type Equal<A, B> =
	[A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** RUNTIME: the Node interface constants, installed on prototypes at load. */
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

/** RUNTIME: the ChildNode mixin, installed from the tables. */
type ChildNodeMixin =
	| "after" |
	"before" |
	"remove" |
	"replaceWith" |
	"nextElementSibling" |
	"previousElementSibling";

/** RUNTIME: the ParentNode mixin, installed from the tables. */
type ParentNodeMixin =
	| "childElementCount" |
	"children" |
	"firstElementChild" |
	"lastElementChild" |
	"append" |
	"prepend" |
	"querySelector" |
	"querySelectorAll" |
	"replaceChildren";

/** RUNTIME: the ARIA reflection surface, installed from the tables. */
type ARIAReflection =
	| "role" |
	`aria${string}`;

/** RUNTIME: selector engine entries, installed from the tables. */
type SelectorSurface = "closest" | "matches" | "webkitMatchesSelector";

/** RUNTIME: the fullscreen event handlers, installed from the tables. */
type FullscreenSurface = "onfullscreenchange" | "onfullscreenerror";

/**
 * The interfaces a window names, under the names WebIDL gives them. This
 * enumeration is the one place an interface joins the window: a class that
 * is not listed here is not visible to script, whatever this module exports.
 */
export const platform = {
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

/**
 * The on* attributes a window carries. addEventListener/removeEventListener
 * come from EventTarget, so the mixins' redeclarations are dropped.
 */
type WindowEventHandlerAttributes = Omit<
	globalThis.GlobalEventHandlers & globalThis.WindowEventHandlers,
	"addEventListener" | "removeEventListener"
>;

/**
 * The window a TermDOM document is displayed in.
 *
 * A terminal has one screen and no browsing context, so this is a plain
 * object rather than a global: this file's interfaces, the scrolling and
 * sizing a display answers, and the handful of APIs an author reaches for
 * through `window`. The member types are the host's, which is what a caller
 * outside this file holds them as.
 */
export interface EngineWindow
	extends globalThis.EventTarget,
	WindowEventHandlerAttributes {
	readonly document: globalThis.Document;
	readonly window: EngineWindow;
	readonly self: EngineWindow;
	readonly navigator: globalThis.Navigator;

	readonly innerWidth: number;
	readonly innerHeight: number;
	readonly outerWidth: number;
	readonly outerHeight: number;
	readonly screenTop: number;
	readonly scrollX: number;
	readonly scrollY: number;
	readonly pageXOffset: number;
	readonly pageYOffset: number;
	scroll(options?: globalThis.ScrollToOptions): void;
	scroll(x: number, y: number): void;
	scrollTo(options?: globalThis.ScrollToOptions): void;
	scrollTo(x: number, y: number): void;
	scrollBy(options?: globalThis.ScrollToOptions): void;
	scrollBy(x: number, y: number): void;

	getComputedStyle(
		element: globalThis.Element,
		pseudoElement?: string | null,
	): globalThis.CSSStyleDeclaration;
	getSelection(): globalThis.Selection | null;
	matchMedia(query: string): globalThis.MediaQueryList;
	requestAnimationFrame(callback: globalThis.FrameRequestCallback): number;
	cancelAnimationFrame(handle: number): void;
	setTimeout: typeof globalThis.setTimeout;
	clearTimeout: typeof globalThis.clearTimeout;
	setInterval: typeof globalThis.setInterval;
	clearInterval: typeof globalThis.clearInterval;
	queueMicrotask: typeof globalThis.queueMicrotask;
	close(): void;

	readonly customElements: globalThis.CustomElementRegistry;
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

/**
 * Build the window a document is displayed in.
 *
 * What a window is born with is its interfaces and the timers any script
 * expects to find; a display fills in the rest -- sizing, scrolling,
 * animation frames, the clipboard -- as it mounts the document.
 */
function buildWindow(document: Document): EngineWindow {
	const window = new Window(document) as unknown as Record<string, unknown>;
	Object.assign(window, platform, {
		// The platform's, which is the one the DOM and the CSSOM throw: a
		// caller's `instanceof DOMException` has to name the same class the
		// engine builds its errors out of.
		DOMException: PlatformDOMException,
		setTimeout: globalThis.setTimeout.bind(globalThis),
		clearTimeout: globalThis.clearTimeout.bind(globalThis),
		setInterval: globalThis.setInterval.bind(globalThis),
		clearInterval: globalThis.clearInterval.bind(globalThis),
		queueMicrotask: globalThis.queueMicrotask.bind(globalThis),
	});
	window.window = window;
	window.self = window;
	return window as unknown as EngineWindow;
}

/** A document parsed from markup, displayed in a window of its own. */
export function createDocumentWindow(html: string, url?: string): EngineWindow {
	return buildWindow(parseHTMLDocument(html, url));
}

// -- key-complete today, held that way. The value assignment is the
// enforcement: an entry whose Equal resolves never refuses a true.
const _checked: [
	Equal<MissingFrom<globalThis.EventTarget, EventTarget>, never>,
	Equal<MissingFrom<globalThis.Event, Event>, never>,
	Equal<MissingFrom<globalThis.CustomEvent, CustomEvent>, never>,
	Equal<MissingFrom<globalThis.StaticRange, StaticRange>, never>,
	Equal<MissingFrom<globalThis.Selection, Selection>, never>,
	Equal<MissingFrom<globalThis.MutationObserver, MutationObserver>, never>,
	Equal<MissingFrom<globalThis.DOMTokenList, DOMTokenList>, never>,
	Equal<MissingFrom<globalThis.NamedNodeMap, NamedNodeMap>, never>,

	// -- constants only -----------------------------------------------------
	// NEVER: document.all is a falsy object, which no JavaScript value can
	// be. The selector engine reads it to detect quirks, so answering with a
	// truthy collection would be worse than not answering.
	Equal<MissingFrom<globalThis.Document, Document>, "all">,
	Equal<MissingFrom<globalThis.Node, Node>, never>,
	Equal<MissingFrom<globalThis.Attr, Attr>, never>,
	Equal<MissingFrom<globalThis.KeyboardEvent, KeyboardEvent>, never>,

	// -- small curated ledgers ----------------------------------------------
	Equal<MissingFrom<globalThis.Range, Range>, never>,
	Equal<MissingFrom<globalThis.MouseEvent, MouseEvent>, never>,
	Equal<MissingFrom<globalThis.CharacterData, CharacterData>, never>,
	Equal<MissingFrom<globalThis.Text, Text>, never>,
	Equal<MissingFrom<globalThis.Comment, Comment>, never>,
	Equal<MissingFrom<globalThis.DocumentFragment, DocumentFragment>, never>,
	Equal<
		MissingFrom<globalThis.ShadowRoot, ShadowRoot>,
		// GAP: the cascade holds a root's sheets, and neither is reachable
		// from here.
		"adoptedStyleSheets" | "styleSheets"
	>,
	// The ARIA surface comes out first: it is a template literal pattern,
	// which no finite union of key names can contain, so the ledger sets it
	// aside and holds the residue.
	Equal<
		Exclude<MissingFrom<globalThis.Element, Element>, ARIAReflection>,
		never
	>,
] = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
];
