/**
 * The User Agent form widgets: <input>, <textarea>, and <select> as real
 * customized built-in elements, each owning its own internal shadow tree.
 *
 * A browser's form controls are UA custom elements -- upgraded in place, with
 * a closed shadow tree the page can't reach. jsdom already implements that
 * lifecycle; it just won't hand it to a built-in, because attachShadow and the
 * upgrade algorithm both refuse form controls without an author `is=` opt-in.
 * So defineUAWidgets registers a customized-built-in class per control and
 * upgrades each plain element through jsdom's own reactions machinery. The
 * result is the genuine article: connectedCallback builds the tree,
 * attributeChangedCallback reconciles it, the element keeps its identity and
 * its .value, and nothing leaks to author serialization.
 *
 * Everything a widget is -- its UA stylesheet, its shadow structure, its
 * reconcile, its geometry -- lives on its class here, so "how a textarea works"
 * is one class, not a trail through the renderer.
 */

import type {DOMWindow} from "jsdom";
import jsdomUtils from "jsdom/lib/jsdom/living/generated/utils.js";
import jsdomCustomElements from "jsdom/lib/jsdom/living/helpers/custom-elements.js";
import {compositionShadowRoot, createUAShadowRoot} from "./composition.js";
import {
	type LayoutEngine,
	isPointInRects,
	visualToDataOffsets,
} from "./layout.js";
import {type StyleManager, getBoxModel} from "./styles.js";
import {
	nextGraphemeBoundary,
	prevGraphemeBoundary,
	stringWidth,
} from "./runtime.js";

/**
 * The UA stylesheet of a textarea's internal shadow tree. Unlike the input,
 * the textarea's parts render through the NORMAL pipeline -- the value text
 * node lays out, wraps and paints like any document text -- so these rules are
 * all there is: the placeholder's ghost gray, faint when the host is blurred,
 * hidden by the reconcile (an inline display:none) whenever a value exists.
 */
const TEXTAREA_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; }
`;

/**
 * The UA stylesheet of an <input>'s internal shadow tree: the field design as
 * real, scoped CSS instead of painter constants. The placeholder is the gray
 * ghost label always; when the host is BLURRED the blank -- and the placeholder
 * riding it -- goes faint: SGR dim via font-weight, SGR underline via
 * text-decoration, the two classic codes that survive every terminal and every
 * intermediary. The focused field's solid underline is not here: it comes from
 * the input's own focus-aware UA default and INHERITS into every part, so
 * authors override it exactly where they always could.
 */
const FIELD_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="value"] { font-weight: lighter; text-decoration: underline; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; text-decoration: underline; }
	:host(:not(:focus)) [part="blank"] { font-weight: lighter; text-decoration: underline; }
`;

/**
 * The UA stylesheet of a select's internal shadow tree: the ▾ indicator is
 * faint -- affordance, not content. Everything else (the focused field's
 * underline included) inherits from the host's own defaults.
 */
const SELECT_UA_STYLES = `
	[part="indicator"] { font-weight: lighter; }
	[part="picker"] {
		display: none;
		position: absolute;
		background-color: Canvas;
		text-decoration: none;
		border-top-width: 1px; border-right-width: 1px;
		border-bottom-width: 1px; border-left-width: 1px;
		border-top-style: solid; border-right-style: solid;
		border-bottom-style: solid; border-left-style: solid;
	}
	[part="option"] { display: block; white-space: pre; }
	[part="option"][data-highlighted] { background-color: Highlight; color: HighlightText; }
	[part="option"][data-disabled] { font-weight: lighter; }
`;

/** One visual (soft-wrapped or hard-broken) line of a laid-out textarea. */
export type TextareaVisualLine = {
	x: number;
	y: number;
	text: string;
	/** Data offset of the line's first character / caret slot. */
	startOffset: number;
	/** Data offset of the caret slot AFTER the line's last character. */
	endOffset: number;
};

/**
 * The visual line index a caret offset sits on, given a textarea's visual
 * lines. Exported for the callers that already hold the lines (selection paint,
 * Home/End) and only need the index.
 */
export function textareaLineAt(
	lines: Array<{startOffset: number; endOffset: number}>,
	caret: number,
): number {
	for (let i = 0; i < lines.length; i++) {
		// endOffset is a valid caret slot on this line; a caret exactly at a
		// soft-wrap boundary belongs to the NEXT line's start (both lines claim
		// the offset; later line wins), matching browsers.
		if (caret <= lines[i].endOffset) {
			const next = lines[i + 1];
			if (next && next.startOffset <= caret) continue;
			return i;
		}
	}
	return lines.length - 1;
}

/** The value part's text node inside a field's UA shadow, or null if unbuilt. */
function fieldValueText(field: Element): Text | null {
	const span = compositionShadowRoot(field)?.querySelector('[part="value"]');
	return (span?.firstChild as Text) ?? null;
}

/**
 * The VISUAL lines of a textarea's laid-out value: the painted fragments (one
 * per soft-wrapped or hard-broken line), plus a virtual empty line for each
 * trailing newline past the last visual character (typing Enter at the end must
 * park the caret on the new, still-empty line, which owns no fragment). Offsets
 * are code units into .value; geometry is document cells. Null before the value
 * has ever laid out. A pure read of the laid-out shadow value -- the painter
 * uses it for the caret, the editing path for Home/End/vertical and hit tests.
 */
export function textareaVisualLines(
	field: HTMLTextAreaElement,
	layoutEngine: LayoutEngine,
): {value: string; lines: TextareaVisualLine[]} | null {
	const valueText = fieldValueText(field);
	if (!valueText) return null;
	const value = valueText.data;
	const rect = field.getBoundingClientRect();
	const boxModel = getBoxModel(field);
	const contentX =
		Math.round(rect.left) +
		(boxModel.borderLeftWidth || 0) +
		(boxModel.paddingLeft || 0);
	const contentY = Math.round(rect.top) + (boxModel.borderTopWidth || 0);

	if (!value) {
		return {
			value,
			lines: [
				{x: contentX, y: contentY, text: "", startOffset: 0, endOffset: 0},
			],
		};
	}

	const rectTexts = layoutEngine.getRectTexts(valueText);
	if (rectTexts.length === 0) return null;
	const visToData = visualToDataOffsets(value, rectTexts);

	const lines: TextareaVisualLine[] = [];
	// Blank lines between consecutive newlines own real, EMPTY layout fragments
	// -- no visual characters, so visToData can't place them. A cursor over the
	// value's own structure does: each line consumes its characters plus, when
	// the character at its end is a newline, that one hard separator (soft wraps
	// have no separator to consume).
	let visualBase = 0;
	let cursor = 0;
	for (const rectText of rectTexts) {
		const length = rectText.text.length;
		const startOffset = length > 0 ? visToData[visualBase] : cursor;
		const endOffset =
			length > 0 ? visToData[visualBase + length - 1] + 1 : startOffset;
		lines.push({
			x: Math.round(rectText.rect.x),
			y: Math.round(rectText.rect.y),
			text: rectText.text,
			startOffset,
			endOffset,
		});
		visualBase += length;
		cursor =
			endOffset < value.length && value[endOffset] === "\n"
				? endOffset + 1
				: endOffset;
	}

	// A value ending in a newline has exactly ONE line no fragment represents:
	// the empty last line the caret sits on after a final Enter. (Interior blank
	// lines all have fragments -- adding more virtual lines here is what once
	// drifted the caret a row per blank line.)
	if (value.endsWith("\n")) {
		const last = lines[lines.length - 1];
		lines.push({
			x: contentX,
			y: last.y + 1,
			text: "",
			startOffset: value.length,
			endOffset: value.length,
		});
	}
	return {value, lines};
}

/** Caret cell for a focused textarea, in document coordinates. */
export function textareaCaretCell(
	field: HTMLTextAreaElement,
	layoutEngine: LayoutEngine,
): {x: number; y: number} | null {
	const visual = textareaVisualLines(field, layoutEngine);
	if (!visual) return null;
	const caret =
		field.selectionDirection === "backward"
			? (field.selectionStart ?? visual.value.length)
			: (field.selectionEnd ?? visual.value.length);
	const lineIndex = textareaLineAt(visual.lines, caret);
	const line = visual.lines[lineIndex];
	const within = Math.max(
		0,
		Math.min(caret, line.endOffset) - line.startOffset,
	);
	return {x: line.x + stringWidth(line.text.slice(0, within)), y: line.y};
}

/** A field's value and selection after an editing key -- what to apply. */
export interface FieldEditResult {
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
export function fieldSelectionMove(
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

/**
 * The field-editing keys shared by <input> and <textarea>: select-all,
 * Backspace/Delete, the horizontal arrows (Shift extending the selection), and
 * printable insertion -- grapheme-aware, following the browser's anchor/focus
 * model. `key` is the DOM key value (`event.key`). Returns the new
 * value+selection, or null if the key is not one of these -- the field-specific
 * keys (Enter, vertical motion, Home/End) belong to the caller.
 */
export function applySharedFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	key: string,
	shiftKey: boolean,
	ctrlKey: boolean,
): FieldEditResult | null {
	const value = field.value;
	const start = field.selectionStart ?? value.length;
	const end = field.selectionEnd ?? value.length;
	const backward = field.selectionDirection === "backward";
	const caret = backward ? start : end;
	const anchor = backward ? end : start;
	const hasSelection = start !== end;

	if (ctrlKey && key === "a") {
		// Select all, the browser's Ctrl+A. (Never Cmd+A here: Cmd chords are
		// consumed by the terminal app and don't reach the PTY.)
		return {value, start: 0, end: value.length, direction: "forward"};
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
	// A printable character replaces the selection. Ctrl chords never insert --
	// their raw byte carried no printable character in the first place.
	if (key.length === 1 && key.charCodeAt(0) >= 32 && !ctrlKey) {
		return collapsedEdit(
			value.slice(0, start) + key + value.slice(end),
			start + 1,
		);
	}
	return null;
}

/** An edit result whose selection is a caret collapsed at `pos`. */
function collapsedEdit(value: string, pos: number): FieldEditResult {
	const clamped = Math.max(0, Math.min(pos, value.length));
	return {value, start: clamped, end: clamped, direction: "none"};
}

/**
 * Apply an edit result to a field's own value and selection, firing `input` on
 * a real value change (the value setter reconciles the widget's tree). Order
 * matters: assigning `.value` collapses the selection to the end (per spec), so
 * the caret is set after. A selection-only change goes straight to
 * setSelectionRange, which fires `select` -- both events the render loop hears.
 * Shared by the field widgets; the window comes off the field's own document.
 */
export function applyFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	result: FieldEditResult,
): void {
	const value = field.value;
	const start = field.selectionStart ?? value.length;
	const end = field.selectionEnd ?? value.length;
	if (result.value !== value) {
		field.value = result.value;
		field.setSelectionRange(result.start, result.end, result.direction);
		const Event = field.ownerDocument.defaultView!.Event;
		field.dispatchEvent(new Event("input", {bubbles: true, cancelable: false}));
	} else if (
		result.start !== start ||
		result.end !== end ||
		(result.start !== result.end &&
			result.direction !== field.selectionDirection)
	) {
		field.setSelectionRange(result.start, result.end, result.direction);
	}
}

/** Add a `part`-attributed span (holding one empty text node) to a UA root. */
function addPart(root: ShadowRoot, part: string): HTMLElement {
	const span = root.ownerDocument.createElement("span");
	span.setAttribute("part", part);
	span.appendChild(root.ownerDocument.createTextNode(""));
	root.appendChild(span);
	return span;
}

/** Upgrades plain form controls to their UA widget classes, in place. */
export interface UAWidgetController {
	/**
	 * Upgrade an element to its UA widget class if it has one and hasn't been
	 * upgraded yet. Idempotent and synchronous: connectedCallback has run (the
	 * shadow tree exists) by the time this returns.
	 */
	upgrade(element: Element): void;
}

interface UAWidgetDeps {
	window: DOMWindow;
	layoutEngine: LayoutEngine;
	styleManager: StyleManager;
	observer: {observe(target: Node, options: MutationObserverInit): void};
}

/**
 * Define the UA widget classes against a window and return the controller that
 * upgrades elements into them. Called once per document at setup; the deps are
 * captured in the classes' closure, so each widget reaches its collaborators
 * directly without a per-element handoff.
 */
export function defineUAWidgets(deps: UAWidgetDeps): UAWidgetController {
	const {window, layoutEngine, styleManager, observer} = deps;
	const document = window.document;

	class UATextarea extends window.HTMLTextAreaElement {
		static get observedAttributes(): string[] {
			return ["placeholder"];
		}

		#valueText!: Text;
		#placeholderText!: Text;
		#placeholderSpan!: HTMLElement;
		#goalColumn: number | null = null;

		/**
		 * Build the UA-internal shadow tree. The root IS observer-enrolled --
		 * enrolled BEFORE it is populated, so the population itself is the
		 * invalidation that swaps the composed tree in -- because the value text
		 * lays out through the normal pipeline and layout must hear about every
		 * change to it.
		 */
		connectedCallback(): void {
			if (this.#valueText) {
				this.#reconcile(); // Re-connect: tree already built.
				return;
			}
			const root = createUAShadowRoot(this);
			observer.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeOldValue: true,
				characterData: true,
			});
			styleManager.registerShadowRoot(root);

			const style = document.createElement("style");
			style.textContent = TEXTAREA_UA_STYLES;
			root.appendChild(style);
			this.#valueText = addPart(root, "value").firstChild as Text;
			this.#placeholderSpan = addPart(root, "placeholder");
			this.#placeholderText = this.#placeholderSpan.firstChild as Text;
			// The trailing <br> anchor, the same trick a browser's editor uses:
			// it makes the run's content always end in exactly one line break, so
			// the line count equals the LOGICAL line count -- the breaker never
			// emits a line after a final newline, and without the anchor a value
			// ending in "\n" measured one row short, parking the caret on the
			// bottom border.
			root.appendChild(document.createElement("br"));

			// Editing is the widget's own default action, the same as a browser
			// textarea's: its keydown listener does the edit. A listener, not a
			// method the renderer reaches in to call -- the custom-element surface
			// is the whole boundary.
			this.addEventListener("keydown", this.#onKeydown);

			this.#reconcile();
		}

		attributeChangedCallback(): void {
			if (this.#valueText) this.#reconcile();
		}

		/**
		 * Assigning `.value` -- from a framework, from setRangeText, from the
		 * editing default action -- must push the new value into the UA tree, the
		 * layout's only source for it. Intercepting the setter is what makes that
		 * automatic: no caller has to remember to reconcile, and the reconcile's
		 * characterData mutation is what schedules the frame (no observer hears a
		 * `.value` write otherwise). jsdom's own internal writes go through the
		 * impl, not this wrapper accessor, so they never reach here.
		 */
		override get value(): string {
			return super.value;
		}

		override set value(next: string) {
			super.value = next;
			if (this.#valueText) this.#reconcile();
		}

		/**
		 * Reconcile the UA tree with the element's own state -- the single
		 * source of truth. Placeholder visibility is real CSS (an inline
		 * display:none), not painter logic: the normal pipeline then simply
		 * never sees it.
		 */
		#reconcile(): void {
			const value = this.value;
			const placeholder = this.getAttribute("placeholder") ?? "";
			if (this.#valueText.data !== value) this.#valueText.data = value;
			if (this.#placeholderText.data !== placeholder) {
				this.#placeholderText.data = placeholder;
			}
			const placeholderDisplay = value ? "none" : "";
			if (this.#placeholderSpan.style.display !== placeholderDisplay) {
				this.#placeholderSpan.style.display = placeholderDisplay;
			}
			// The value text lays out through the normal pipeline. The observer
			// hears its characterData change too, but only on a microtask -- an
			// edit that reads the fresh geometry back the same tick (vertical
			// motion, Home/End) needs the engine dirtied synchronously now.
			layoutEngine.invalidate(this);
		}

		/**
		 * The textarea's editing default action. Enter inserts a newline, the
		 * vertical arrows and Home/End move by VISUAL line (soft wraps count, as
		 * in a browser), and every other editing key is the shared field logic.
		 * Reads back laid-out geometry, so it flushes layout first.
		 */
		#onKeydown = (event: KeyboardEvent): void => {
			// Editing is a default action: an author's keydown preventDefault
			// suppresses it, exactly as it suppresses a browser textarea's edit.
			if (event.defaultPrevented) return;
			const {key, shiftKey, ctrlKey} = event;
			// The goal column survives only an unbroken run of vertical moves.
			if (key !== "ArrowUp" && key !== "ArrowDown") this.#goalColumn = null;

			const value = this.value;
			const start = this.selectionStart ?? value.length;
			const end = this.selectionEnd ?? value.length;
			const backward = this.selectionDirection === "backward";
			const caret = backward ? start : end;
			const anchor = backward ? end : start;

			let result: FieldEditResult | null;
			if (key === "Enter") {
				// A newline, inserted like any typed character, replacing the
				// selection.
				const next = value.slice(0, start) + "\n" + value.slice(end);
				const pos = start + 1;
				result = {value: next, start: pos, end: pos, direction: "none"};
			} else if (key === "ArrowUp" || key === "ArrowDown") {
				layoutEngine.calculateLayout();
				const target = this.#verticalTarget(
					caret,
					key === "ArrowDown" ? 1 : -1,
				);
				result = fieldSelectionMove(value, anchor, target, shiftKey);
			} else if (key === "Home" || key === "End") {
				layoutEngine.calculateLayout();
				const visual = textareaVisualLines(this, layoutEngine);
				const line = visual
					? visual.lines[textareaLineAt(visual.lines, caret)]
					: null;
				const target =
					key === "Home"
						? (line?.startOffset ?? 0)
						: (line?.endOffset ?? value.length);
				result = fieldSelectionMove(value, anchor, target, shiftKey);
			} else {
				result = applySharedFieldEdit(this, key, shiftKey, ctrlKey);
			}
			if (result) applyFieldEdit(this, result);
		};

		/**
		 * The caret offset one visual line up or down from `caret`, keeping the
		 * column (in cells) where the target line allows -- soft wraps count as
		 * lines, exactly as in a browser. First line up collapses to 0, last
		 * line down to the end.
		 */
		#verticalTarget(caret: number, direction: 1 | -1): number {
			const visual = textareaVisualLines(this, layoutEngine);
			if (!visual) return caret;
			const lineIndex = textareaLineAt(visual.lines, caret);
			const targetIndex = lineIndex + direction;
			if (targetIndex < 0) return 0;
			if (targetIndex >= visual.lines.length) return visual.value.length;
			const line = visual.lines[lineIndex];
			const currentColumn = stringWidth(
				line.text.slice(0, Math.max(0, caret - line.startOffset)),
			);
			// Consecutive vertical moves aim for the column travel STARTED at,
			// even across shorter lines that clamp the caret -- the browser's
			// goal column.
			const column = this.#goalColumn ?? currentColumn;
			this.#goalColumn = column;
			const target = visual.lines[targetIndex];
			let cells = 0;
			for (let i = 0; i < target.text.length; i++) {
				const charCells = stringWidth(target.text[i]);
				if (cells + charCells > column) {
					return target.startOffset + i;
				}
				cells += charCells;
			}
			return target.endOffset;
		}
	}

	window.customElements.define("ua-textarea", UATextarea, {
		extends: "textarea",
	});

	class UAInput extends window.HTMLInputElement {
		static get observedAttributes(): string[] {
			return ["placeholder", "type"];
		}

		// "field" for a text-ish input, "toggle" for checkbox/radio; null until
		// built. The two are different trees, so a type flip rebuilds.
		#kind: "field" | "toggle" | null = null;
		#root: ShadowRoot | null = null;
		#valueText: Text | null = null;
		#placeholderText: Text | null = null;
		#blankText: Text | null = null;

		/** field for a text-ish input, toggle for checkbox/radio. */
		#kindFor(): "field" | "toggle" {
			return this.type === "checkbox" || this.type === "radio"
				? "toggle"
				: "field";
		}

		connectedCallback(): void {
			if (this.#root) {
				this.#reconcile(); // Re-connect: tree already built.
				return;
			}
			this.#build();
			// Editing is the widget's own default action, like a browser input's
			// -- a keydown listener, not a renderer hook.
			this.addEventListener("keydown", this.#onKeydown);
		}

		attributeChangedCallback(name: string): void {
			if (!this.#root) return;
			if (name === "type" && this.#kindFor() !== this.#kind) {
				this.#build(); // The type flipped between field and toggle.
			} else {
				this.#reconcile();
			}
		}

		override get value(): string {
			return super.value;
		}

		override set value(next: string) {
			super.value = next;
			if (this.#root) this.#reconcile();
		}

		/**
		 * Build (or rebuild, on a type flip) the UA-internal shadow tree. The
		 * field tree carries value / placeholder / blank parts; the toggle tree a
		 * single glyph part the painter fills from live `.checked` (a radio's
		 * group exclusivity unchecks siblings with no hook to reconcile on).
		 * Enrolled in the observer so a framework's value/placeholder change
		 * schedules a frame, exactly like the textarea's tree.
		 */
		#build(): void {
			const root = this.#root ?? createUAShadowRoot(this);
			while (root.firstChild) root.removeChild(root.firstChild);
			this.#root = root;
			this.#kind = this.#kindFor();
			observer.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeOldValue: true,
				characterData: true,
			});
			styleManager.registerShadowRoot(root);

			if (this.#kind === "field") {
				const style = document.createElement("style");
				style.textContent = FIELD_UA_STYLES;
				root.appendChild(style);
				this.#valueText = addPart(root, "value").firstChild as Text;
				this.#placeholderText = addPart(root, "placeholder").firstChild as Text;
				this.#blankText = addPart(root, "blank").firstChild as Text;
			} else {
				this.#valueText = null;
				addPart(root, "glyph"); // The painter fills it from live .checked.
			}
			this.#reconcile();
		}

		/**
		 * Reconcile the field tree with the input's own value/placeholder -- the
		 * rendered content model a width:auto input measures against. The blank
		 * part carries the caret's own cell past the last character; the
		 * painter's scroll-window and caret read the input's value and selection
		 * directly. A toggle has no text to reconcile; its glyph is the
		 * painter's.
		 */
		#reconcile(): void {
			if (this.#kind === "field" && this.#valueText) {
				const value = this.value;
				const placeholder = this.getAttribute("placeholder") ?? "";
				const autoWidth =
					window.getComputedStyle(this).getPropertyValue("width") === "auto";
				if (this.#valueText.data !== value) this.#valueText.data = value;
				if (this.#placeholderText!.data !== placeholder) {
					this.#placeholderText!.data = placeholder;
				}
				// An empty field must not collapse to zero cells: with no value
				// and no placeholder, the blank's single caret cell IS the field
				// -- one faint underlined cell marking an editable spot.
				const blank = !autoWidth ? "" : value || !placeholder ? " " : "";
				if (this.#blankText!.data !== blank) this.#blankText!.data = blank;
			}
			// A width:auto input sizes to its composed content; nothing else
			// invalidates the measure, and the observer would only hear it on a
			// microtask.
			layoutEngine.invalidate(this);
		}

		/**
		 * The input's editing default action: a checkbox/radio toggles on Space
		 * (never accepting typed text), Home/End go to the whole value's ends (an
		 * input has no visual lines), everything else is the shared field logic.
		 */
		#onKeydown = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) return;
			const {key, shiftKey, ctrlKey} = event;

			if (this.type === "checkbox" || this.type === "radio") {
				// A checkbox toggles; a radio only ever checks (Space on an
				// already-checked radio does nothing -- jsdom's checkedness setter
				// unchecks the rest of the same-name group). Fires `change` only,
				// never `input`, matching a browser's toggle.
				if (key === " " && !(this.type === "radio" && this.checked)) {
					this.checked = this.type === "checkbox" ? !this.checked : true;
					this.dispatchEvent(
						new window.Event("change", {bubbles: true, cancelable: false}),
					);
				}
				return;
			}

			const value = this.value;
			const start = this.selectionStart ?? value.length;
			const end = this.selectionEnd ?? value.length;
			const anchor = this.selectionDirection === "backward" ? end : start;

			let result: FieldEditResult | null;
			if (key === "Home") {
				result = fieldSelectionMove(value, anchor, 0, shiftKey);
			} else if (key === "End") {
				result = fieldSelectionMove(value, anchor, value.length, shiftKey);
			} else {
				result = applySharedFieldEdit(this, key, shiftKey, ctrlKey);
			}
			if (result) applyFieldEdit(this, result);
		};
	}

	window.customElements.define("ua-input", UAInput, {extends: "input"});

	class UASelect extends window.HTMLSelectElement {
		#root: ShadowRoot | null = null;
		#valueText: Text | null = null;
		#picker: HTMLElement | null = null;
		// The highlighted option index while the picker is OPEN; null = closed.
		#highlight: number | null = null;

		connectedCallback(): void {
			if (this.#root) {
				this.#reconcile(); // Re-connect: tree already built.
				return;
			}
			this.#build();
			this.addEventListener("keydown", this.#onKeydown);
			this.addEventListener("mousedown", this.#onMousedown);
			// Losing focus closes the picker, as everywhere.
			this.addEventListener("blur", this.#onBlur);
			// The displayed label and picker rows track the option list; a
			// framework mutating the options must re-reconcile. (Selection
			// changes go through the value/selectedIndex setters below.)
			observer.observe(this, {
				childList: true,
				subtree: true,
				attributes: true,
				characterData: true,
			});
		}

		override get value(): string {
			return super.value;
		}

		override set value(next: string) {
			super.value = next;
			if (this.#root) this.#reconcile();
		}

		override get selectedIndex(): number {
			return super.selectedIndex;
		}

		override set selectedIndex(next: number) {
			super.selectedIndex = next;
			if (this.#root) this.#reconcile();
		}

		/**
		 * Build the UA-internal shadow tree: the selected option's label
		 * (part=value), the ▾ indicator (part=indicator), and the picker popover
		 * (part=picker, holding one option row per option). Observer-enrolled
		 * before population like the textarea's -- its content renders through
		 * the normal pipeline, and composition hides the light option list.
		 */
		#build(): void {
			const root = createUAShadowRoot(this);
			this.#root = root;
			observer.observe(root, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeOldValue: true,
				characterData: true,
			});
			styleManager.registerShadowRoot(root);

			const style = document.createElement("style");
			style.textContent = SELECT_UA_STYLES;
			root.appendChild(style);
			this.#valueText = addPart(root, "value").firstChild as Text;
			(addPart(root, "indicator").firstChild as Text).data = " ▾"; // " ▾"

			const picker = document.createElement("div");
			picker.setAttribute("part", "picker");
			root.appendChild(picker);
			this.#picker = picker;

			this.#reconcile();
		}

		/** Reconcile the UA tree with the select's own selection/open state. */
		#reconcile(): void {
			const picker = this.#picker!;
			const selected =
				this.selectedIndex >= 0 ? this.options[this.selectedIndex] : null;
			const label = selected ? selected.label : "";
			if (this.#valueText!.data !== label) this.#valueText!.data = label;

			if (this.#highlight === null) {
				if (picker.style.display !== "none") picker.style.display = "none";
				return;
			}

			// Rebuild rows to match the option list; cheap at option-list scale.
			const options = Array.from(this.options);
			while (picker.childNodes.length > options.length) {
				picker.removeChild(picker.lastChild!);
			}
			while (picker.childNodes.length < options.length) {
				const row = document.createElement("div");
				row.setAttribute("part", "option");
				picker.appendChild(row);
			}
			options.forEach((option, index) => {
				const row = picker.childNodes[index] as HTMLElement;
				if (row.textContent !== option.label) row.textContent = option.label;
				// Attribute writes are guarded: setAttribute queues a mutation
				// record even when unchanged, and this root is observed -- an
				// unconditional write is an infinite render loop.
				if (option.disabled !== row.hasAttribute("data-disabled")) {
					if (option.disabled) row.setAttribute("data-disabled", "");
					else row.removeAttribute("data-disabled");
				}
				const highlighted = index === this.#highlight;
				if (highlighted !== row.hasAttribute("data-highlighted")) {
					if (highlighted) row.setAttribute("data-highlighted", "");
					else row.removeAttribute("data-highlighted");
				}
			});

			// Anchor below the field in DOCUMENT coordinates (the picker's
			// containing block is the ICB), matching the field's width.
			const rect = layoutEngine.getRect(this);
			if (rect) {
				const top = `${Math.round(rect.bottom)}px`;
				const left = `${Math.round(rect.left)}px`;
				const width = `${Math.max(4, Math.round(rect.width))}ch`;
				if (picker.style.top !== top) picker.style.top = top;
				if (picker.style.left !== left) picker.style.left = left;
				if (picker.style.width !== width) picker.style.width = width;
			}
			if (picker.style.display !== "block") picker.style.display = "block";
		}

		/** Step to the next enabled option in `direction`, or stay put. */
		#step(from: number, direction: 1 | -1): number {
			const options = this.options;
			for (
				let i = from + direction;
				i >= 0 && i < options.length;
				i += direction
			) {
				if (!options[i].disabled) return i;
			}
			return from;
		}

		/** Open the picker with the highlight on the current selection. */
		#openPicker(): void {
			const options = Array.from(this.options);
			if (options.length === 0) return;
			let index = this.selectedIndex;
			if (index < 0) index = options.findIndex((o) => !o.disabled);
			this.#highlight = index;
			this.#reconcile();
		}

		/** Commit `index` as the selection, close, and fire input then change. */
		#commit(index: number): void {
			this.#highlight = null;
			this.selectedIndex = index; // The setter reconciles (closes + label).
			this.dispatchEvent(
				new window.Event("input", {bubbles: true, cancelable: false}),
			);
			this.dispatchEvent(
				new window.Event("change", {bubbles: true, cancelable: false}),
			);
		}

		/**
		 * The select's editing default action. OPEN: arrows move the highlight
		 * without committing, Enter/Space commit, Escape dismisses. CLOSED:
		 * Enter/Space open the picker; arrows change the selection in place --
		 * the browser's closed-select keyboard model, no popup to degrade.
		 */
		#onKeydown = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) return;
			const key = event.key;
			const options = this.options;
			if (options.length === 0) return;
			const current = this.selectedIndex;

			if (this.#highlight !== null) {
				const highlight = this.#highlight;
				if (key === "ArrowDown") this.#highlight = this.#step(highlight, 1);
				else if (key === "ArrowUp") this.#highlight = this.#step(highlight, -1);
				else if (key === "Home") this.#highlight = this.#step(-1, 1);
				else if (key === "End") {
					this.#highlight = this.#step(options.length, -1);
				} else if (key === "Enter" || key === " ") {
					this.#highlight = null;
					if (highlight !== current && !options[highlight].disabled) {
						this.#commit(highlight);
						return;
					}
					this.#reconcile(); // No change: just close.
					return;
				} else if (key === "Escape") {
					this.#highlight = null;
				} else {
					return;
				}
				this.#reconcile();
				return;
			}

			// CLOSED: Space or Enter opens; arrows change the value in place.
			if (key === "Enter" || key === " ") {
				this.#openPicker();
				return;
			}
			let target = current;
			if (key === "ArrowDown" || key === "ArrowRight") {
				target = this.#step(current, 1);
			} else if (key === "ArrowUp" || key === "ArrowLeft") {
				target = this.#step(current, -1);
			} else if (key === "Home") {
				target = this.#step(-1, 1);
			} else if (key === "End") {
				target = this.#step(options.length, -1);
			} else {
				return;
			}
			if (target !== current && target >= 0) this.#commit(target);
		};

		/**
		 * The mouse default action: a press opens a closed picker, and with the
		 * picker open a press on an option row commits it (a disabled row is
		 * inert), a press on the closed face dismisses. The row under the point
		 * is found from the rows' own document rects -- no renderer hit-test.
		 */
		#onMousedown = (event: MouseEvent): void => {
			if (event.defaultPrevented || event.button !== 0) return;
			this.focus(); // A press focuses the control, as in a browser.
			if (this.#highlight === null) {
				this.#openPicker();
				return;
			}
			const {clientX: x, clientY: y} = event;
			const rows = Array.from(this.#picker!.childNodes) as HTMLElement[];
			const index = rows.findIndex((row) => {
				const r = layoutEngine.getRect(row);
				return r ? isPointInRects(x, y, r) : false;
			});
			if (index >= 0) {
				// A disabled row is inert: the sheet stays up, nothing commits.
				if (!this.options[index]?.disabled) {
					this.#highlight = null;
					if (index !== this.selectedIndex) this.#commit(index);
					else this.#reconcile(); // Re-press the selection: just close.
				}
				return;
			}
			// Off every row: a press inside the picker's own padding does
			// nothing; a press outside it (the closed face) dismisses.
			const pr = layoutEngine.getRect(this.#picker!);
			if (!(pr && isPointInRects(x, y, pr))) {
				this.#highlight = null;
				this.#reconcile();
			}
		};

		#onBlur = (): void => {
			if (this.#highlight !== null) {
				this.#highlight = null;
				this.#reconcile();
			}
		};
	}

	window.customElements.define("ua-select", UASelect, {extends: "select"});

	// The registry stores each definition once it is defined; fetch ours so the
	// upgrade can hand it straight to the reactions algorithm without a name
	// lookup (the built-in lookup only matches on an author `is=`, which a plain
	// control never has).
	const registryImpl = jsdomUtils.implForWrapper(
		(window as unknown as {_customElementRegistry: object})
			._customElementRegistry,
	) as {_customElementDefinitions: Array<{name: string}>};
	const definitions = new Map<string, unknown>();
	for (const localName of ["ua-textarea", "ua-input", "ua-select"]) {
		definitions.set(
			localName,
			registryImpl._customElementDefinitions.find((d) => d.name === localName),
		);
	}

	const UPGRADE_BY_TAG: Record<string, string | undefined> = {
		TEXTAREA: "ua-textarea",
		INPUT: "ua-input",
		SELECT: "ua-select",
	};

	function upgrade(element: Element): void {
		const name = UPGRADE_BY_TAG[element.tagName];
		if (!name) return;
		const definition = definitions.get(name);
		if (!definition) return;
		const impl = jsdomUtils.implForWrapper(element) as {_ceState: string};
		if (impl._ceState === "custom") return;
		// Flip to the pending-candidate state jsdom gives an `is=` element before
		// its upgrade; upgradeElement refuses anything already resolved. The
		// pre/post steps bracket a synchronous reactions flush, so the shadow
		// tree exists the moment this returns.
		impl._ceState = "undefined";
		jsdomCustomElements.ceReactionsPreSteps();
		try {
			jsdomCustomElements.upgradeElement(definition, impl);
		} finally {
			jsdomCustomElements.ceReactionsPostSteps();
		}
	}

	return {upgrade};
}
