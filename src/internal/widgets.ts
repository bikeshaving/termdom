/**
 * The user-agent widgets: the closed shadow tree behind <input>, <textarea> and
 * <select>, and the editing that tree renders.
 *
 * A widget is an object beside its control rather than a subclass of it: the
 * control owns its state and tells its widget when that state moves. What a
 * widget is -- its stylesheet, its structure, its reconcile, its geometry --
 * lives on one class, so a control is one place to read.
 */

import {
	attachUAShadowRoot,
	attachUAWidget,
	setUASelection,
	shadowRootOf,
	uaSelectionOf,
	uaWidgetOf,
} from "./dom.js";

/**
 * The value part's text node inside a form control's user-agent shadow tree,
 * or null before the tree is built. The control's editable text lives at its
 * `[part="value"]`, reached through the closed tree the way a browser's own
 * editing internals reach it: the renderer reads it to place the caret, the
 * editing path to hit-test a point.
 */
export function fieldValueText(field: object): Text | null {
	const span = shadowRootOf<ShadowRoot>(field)?.querySelector('[part="value"]');
	return (span?.firstChild as Text) ?? null;
}

/**
 * A collapsed Range at a focused control's caret, inside that value text. Its
 * geometry is then whatever the layout already placed the offset at -- no
 * bespoke caret walk. Backward selections carry the caret at the start,
 * forward ones at the end, matching the DOM.
 */
export function fieldCaretRange(
	field: HTMLInputElement | HTMLTextAreaElement,
): Range | null {
	const valueText = fieldValueText(field);
	if (!valueText) return null;
	const selection = uaSelectionOf(field);
	const caret =
		selection.direction === "backward" ? selection.start : selection.end;
	const range = field.ownerDocument.createRange();
	range.setStart(
		valueText,
		Math.max(0, Math.min(caret, valueText.data.length)),
	);
	range.collapse(true);
	return range;
}
import type {EngineWindow} from "./termdom.js";
import {invalidateStructure} from "./termdom.js";
import {type LayoutEngine, isPointInRects} from "./layout.js";
import {type StyleManager} from "./styles.js";
import {
	nextGraphemeBoundary,
	prevGraphemeBoundary,
	stringWidth,
} from "./text.js";
import {
	FIELD_UA_STYLES,
	SELECT_UA_STYLES,
	TEXTAREA_UA_STYLES,
} from "./useragent.js";

/** One visual (soft-wrapped or hard-broken) line of a laid-out textarea. */
type TextareaVisualLine = {
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
			if (next && next.startOffset <= caret) continue;
			return i;
		}
	}
	return lines.length - 1;
}

/**
 * A textarea's laid-out visual lines with their data ranges -- a thin field
 * view over the shared `lineFragments` primitive (the empty and trailing-newline
 * lines included). Internal to the widget's own Home/End and vertical-motion
 * editing; geometry consumers read `lineFragments` or a `Range` directly.
 */
function textareaVisualLines(
	field: HTMLTextAreaElement,
	layoutEngine: LayoutEngine,
): {value: string; lines: TextareaVisualLine[]} | null {
	const valueText = fieldValueText(field);
	if (!valueText) return null;
	// The laid-out lines with their data ranges, including the empty lines no
	// fragment represents (an empty value, a trailing newline) -- the same
	// annotation range geometry reads, so the caret, a Range, and vertical
	// navigation all agree on where an offset sits.
	const lines = layoutEngine.lineFragments(valueText);
	if (lines.length === 0) return null;
	return {value: valueText.data, lines};
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

/**
 * The field-editing keys shared by <input> and <textarea>: select-all,
 * Backspace/Delete and the horizontal arrows (Shift extending the selection),
 * grapheme-aware, following the browser's anchor/focus model. `key` is the DOM
 * key value (`event.key`). Returns the new value+selection, or null if the key
 * is not one of these -- the field-specific keys (Enter, vertical motion,
 * Home/End) belong to the caller, and printable insertion is a keypress action.
 */
function applySharedFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	key: string,
	shiftKey: boolean,
	ctrlKey: boolean,
): FieldEditResult | null {
	const value = field.value;
	const {start, end, direction} = uaSelectionOf(field);
	const backward = direction === "backward";
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
	return null;
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
	const value = field.value;
	const {start, end} = uaSelectionOf(field);
	return collapsedEdit(
		value.slice(0, start) + text + value.slice(end),
		start + text.length,
	);
}

/** An edit result whose selection is a caret collapsed at `pos`. */
function collapsedEdit(value: string, pos: number): FieldEditResult {
	const clamped = Math.max(0, Math.min(pos, value.length));
	return {value, start: clamped, end: clamped, direction: "none"};
}

/**
 * Apply an edit result to a field's own value and selection, firing `input` on
 * a real value change (the value write reconciles the widget's tree) and
 * `select` on a selection the user moved -- both events the render loop hears.
 * Order matters: assigning `.value` collapses the selection to the end (per
 * spec), so the caret is set after. The window comes off the field's own
 * document.
 */
function applyFieldEdit(
	field: HTMLInputElement | HTMLTextAreaElement,
	result: FieldEditResult,
): void {
	const value = field.value;
	const {start, end, direction} = uaSelectionOf(field);
	const Event = field.ownerDocument.defaultView!.Event;
	if (result.value !== value) {
		field.value = result.value;
		setUASelection(field, result.start, result.end, result.direction);
		field.dispatchEvent(new Event("input", {bubbles: true, cancelable: false}));
	} else if (
		result.start !== start ||
		result.end !== end ||
		(result.start !== result.end && result.direction !== direction)
	) {
		setUASelection(field, result.start, result.end, result.direction);
		field.dispatchEvent(
			new Event("select", {bubbles: true, cancelable: false}),
		);
	}
}

/** Insert pasted `text` at the field's selection (one atomic edit). */
function insertPaste(
	field: HTMLInputElement | HTMLTextAreaElement,
	text: string,
): void {
	if (!text) return;
	const value = field.value;
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
function addPart(root: ShadowRoot, part: string): HTMLElement {
	const span = root.ownerDocument.createElement("span");
	span.setAttribute("part", part);
	span.appendChild(root.ownerDocument.createTextNode(""));
	root.appendChild(span);
	return span;
}

/** Puts the UA widget behind a form control, in place. */
export interface UAWidgetController {
	/**
	 * Give an element its UA widget if it has one and does not have it yet.
	 * Idempotent and synchronous: the shadow tree exists by the time this
	 * returns.
	 */
	upgrade(element: Element): void;
}

interface UAWidgetDeps {
	window: EngineWindow;
	layoutEngine: LayoutEngine;
	styleManager: StyleManager;
	observer: {observe(target: Node, options: MutationObserverInit): void};
}

/**
 * Define the UA widget classes against a window and return the controller that
 * puts them behind form controls. Called once per document at setup; the deps
 * are captured in the classes' closure, so each widget reaches its
 * collaborators directly without a per-element handoff.
 */
export function defineUAWidgets(deps: UAWidgetDeps): UAWidgetController {
	const {window, layoutEngine, styleManager, observer} = deps;
	const document = window.document;

	class UATextarea {
		#host: HTMLTextAreaElement;
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
		constructor(host: HTMLTextAreaElement) {
			this.#host = host;
			const root = attachUAShadowRoot<ShadowRoot>(host);
			invalidateStructure();
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
			// method the renderer reaches in to call -- the widget listens to its
			// control like anything else would.
			host.addEventListener("keydown", this.#onKeydown as EventListener);
			host.addEventListener(
				"beforeinput",
				this.#onBeforeInput as EventListener,
			);

			this.reconcile();
		}

		// A typed character arrives as an insertText; a paste keeps its newlines.
		#onBeforeInput = (event: InputEvent): void => {
			if (event.defaultPrevented || event.data == null) return;
			if (event.inputType === "insertText") {
				event.preventDefault();
				applyFieldEdit(this.#host, printableFieldEdit(this.#host, event.data));
				return;
			}
			if (event.inputType !== "insertFromPaste") return;
			event.preventDefault();
			insertPaste(this.#host, event.data);
		};

		/**
		 * Reconcile the UA tree with the element's own state -- the single
		 * source of truth. Placeholder visibility is real CSS (an inline
		 * display:none), not painter logic: the normal pipeline then simply
		 * never sees it.
		 */
		reconcile(): void {
			const host = this.#host;
			const value = host.value;
			const placeholder = host.getAttribute("placeholder") ?? "";
			let changed = false;
			if (this.#valueText.data !== value) {
				this.#valueText.data = value;
				changed = true;
			}
			if (this.#placeholderText.data !== placeholder) {
				this.#placeholderText.data = placeholder;
				changed = true;
			}
			const placeholderDisplay = value ? "none" : "";
			if (this.#placeholderSpan.style.display !== placeholderDisplay) {
				this.#placeholderSpan.style.display = placeholderDisplay;
				changed = true;
			}
			if (!changed) return;
			// The value text lays out through the normal pipeline. The observer
			// hears its characterData change too, but only on a microtask -- an
			// edit that reads the fresh geometry back the same tick (vertical
			// motion, Home/End) needs the engine dirtied synchronously now.
			layoutEngine.invalidate(host);
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
			const host = this.#host;
			const {key, shiftKey, ctrlKey} = event;
			// The goal column survives only an unbroken run of vertical moves.
			if (key !== "ArrowUp" && key !== "ArrowDown") this.#goalColumn = null;

			const value = host.value;
			const {start, end, direction} = uaSelectionOf(host);
			const backward = direction === "backward";
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
				const visual = textareaVisualLines(host, layoutEngine);
				const line = visual
					? visual.lines[textareaLineAt(visual.lines, caret)]
					: null;
				const target =
					key === "Home"
						? (line?.startOffset ?? 0)
						: (line?.endOffset ?? value.length);
				result = fieldSelectionMove(value, anchor, target, shiftKey);
			} else {
				result = applySharedFieldEdit(host, key, shiftKey, ctrlKey);
			}
			if (result) applyFieldEdit(host, result);
		};

		/**
		 * The caret offset one visual line up or down from `caret`, keeping the
		 * column (in cells) where the target line allows -- soft wraps count as
		 * lines, exactly as in a browser. First line up collapses to 0, last
		 * line down to the end.
		 */
		#verticalTarget(caret: number, direction: 1 | -1): number {
			const visual = textareaVisualLines(this.#host, layoutEngine);
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

	class UAInput {
		#host: HTMLInputElement;
		// "field" for a text-ish input, "toggle" for checkbox/radio; null until
		// built. The two are different trees, so a type flip rebuilds.
		#kind: "field" | "toggle" | null = null;
		#root: ShadowRoot | null = null;
		#valueText: Text | null = null;
		#placeholderText: Text | null = null;

		constructor(host: HTMLInputElement) {
			this.#host = host;
			this.#build();
			// Editing is the widget's own default action, like a browser input's
			// -- a keydown listener; typed characters and pastes arrive as
			// beforeinput, which is the default action of the keypress and of the
			// paste that produced them.
			host.addEventListener("keydown", this.#onKeydown as EventListener);
			host.addEventListener(
				"beforeinput",
				this.#onBeforeInput as EventListener,
			);
		}

		/** field for a text-ish input, toggle for checkbox/radio. */
		#kindFor(): "field" | "toggle" {
			const type = this.#host.type;
			return type === "checkbox" || type === "radio" ? "toggle" : "field";
		}

		/**
		 * A typed character arrives as an insertText; a paste as an
		 * insertFromPaste, whose line breaks a single-line input strips (HTML
		 * value sanitization). A toggle takes neither: it holds no text.
		 */
		#onBeforeInput = (event: InputEvent): void => {
			if (event.defaultPrevented || event.data == null) return;
			if (this.#kindFor() !== "field") return;
			if (event.inputType === "insertText") {
				event.preventDefault();
				applyFieldEdit(this.#host, printableFieldEdit(this.#host, event.data));
				return;
			}
			if (event.inputType !== "insertFromPaste") return;
			event.preventDefault();
			insertPaste(this.#host, event.data.replace(/[\r\n]+/g, ""));
		};

		/**
		 * Build (or rebuild, on a type flip) the UA-internal shadow tree. The
		 * field tree carries value / placeholder parts; the toggle tree a
		 * single glyph part the painter fills from live `.checked` (a radio's
		 * group exclusivity unchecks siblings with no hook to reconcile on).
		 * Enrolled in the observer so a framework's value/placeholder change
		 * schedules a frame, exactly like the textarea's tree.
		 */
		#build(): void {
			const host = this.#host;
			const root = this.#root ?? attachUAShadowRoot<ShadowRoot>(host);
			invalidateStructure();
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
			} else {
				this.#valueText = null;
				addPart(root, "glyph"); // The painter fills it from live .checked.
			}
			layoutEngine.invalidate(host);
			this.reconcile();
		}

		/**
		 * Reconcile the field tree with the input's own value/placeholder -- the
		 * rendered content model a width:auto input measures against. The value
		 * text paints through the normal walk; the placeholder shows only when the
		 * value is empty. A toggle has no text to reconcile; its glyph is the
		 * painter's.
		 */
		reconcile(): void {
			const host = this.#host;
			// A type flip is a different tree, not a different value.
			if (this.#kindFor() !== this.#kind) {
				this.#build();
				return;
			}
			if (this.#kind !== "field" || !this.#valueText) return;
			const value = host.value;
			const placeholder = host.getAttribute("placeholder") ?? "";
			// A password puts one bullet per code unit into the shadow, never
			// the real value -- so what lays out, paints, and can be selected is
			// only the mask; the value stays in .value alone. Offsets stay 1:1
			// with .value on the BMP, keeping caret and scroll window aligned.
			const shown = host.type === "password" ? "•".repeat(value.length) : value;
			let changed = false;
			if (this.#valueText.data !== shown) {
				this.#valueText.data = shown;
				changed = true;
			}
			if (this.#placeholderText!.data !== placeholder) {
				this.#placeholderText!.data = placeholder;
				changed = true;
			}
			// Exactly one occupies the slot: value when present, else placeholder.
			const valueDisplay = value ? "inline-block" : "none";
			const placeholderDisplay = value ? "none" : "inline-block";
			const valueSpan = this.#valueText.parentElement as HTMLElement;
			const placeholderSpan = this.#placeholderText!
				.parentElement as HTMLElement;
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
			if (changed) layoutEngine.invalidate(host);
		}

		/**
		 * The input's editing default action: a checkbox/radio activates on
		 * Space (never accepting typed text), Home/End go to the whole value's
		 * ends (an input has no visual lines), everything else is the shared
		 * field logic.
		 */
		#onKeydown = (event: KeyboardEvent): void => {
			if (event.defaultPrevented) return;
			const host = this.#host;
			const {key, shiftKey, ctrlKey} = event;

			if (host.type === "checkbox" || host.type === "radio") {
				// Space activates the control, and activation is what toggles it:
				// the pre-activation behavior flips the checkedness, the activation
				// behavior fires input then change, and a canceled click puts the
				// checkedness back.
				if (key === " ") host.click();
				return;
			}

			const value = host.value;
			const {start, end, direction} = uaSelectionOf(host);
			const anchor = direction === "backward" ? end : start;

			let result: FieldEditResult | null;
			if (key === "Home") {
				result = fieldSelectionMove(value, anchor, 0, shiftKey);
			} else if (key === "End") {
				result = fieldSelectionMove(value, anchor, value.length, shiftKey);
			} else {
				result = applySharedFieldEdit(host, key, shiftKey, ctrlKey);
			}
			if (result) applyFieldEdit(host, result);
		};
	}

	class UASelect {
		#host: HTMLSelectElement;
		#root: ShadowRoot | null = null;
		#valueText: Text | null = null;
		#picker: HTMLElement | null = null;
		// The highlighted option index while the picker is OPEN; null = closed.
		#highlight: number | null = null;

		constructor(host: HTMLSelectElement) {
			this.#host = host;
			this.#build();
			host.addEventListener("keydown", this.#onKeydown as EventListener);
			host.addEventListener("mousedown", this.#onMousedown as EventListener);
			// Losing focus closes the picker, as everywhere.
			host.addEventListener("blur", this.#onBlur);
			// The displayed label and picker rows track the option list; a
			// framework mutating the options must re-reconcile. (Selection
			// changes reach the widget through the control's own setters.)
			observer.observe(host, {
				childList: true,
				subtree: true,
				attributes: true,
				characterData: true,
			});
		}

		/**
		 * Build the UA-internal shadow tree: the selected option's label
		 * (part=value), the ▾ indicator (part=indicator), and the picker popover
		 * (part=picker, holding one option row per option). Observer-enrolled
		 * before population like the textarea's -- its content renders through
		 * the normal pipeline, and composition hides the light option list.
		 */
		#build(): void {
			const root = attachUAShadowRoot<ShadowRoot>(this.#host);
			invalidateStructure();
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
			(addPart(root, "indicator").firstChild as Text).data = " ▾";

			const picker = document.createElement("div");
			picker.setAttribute("part", "picker");
			root.appendChild(picker);
			this.#picker = picker;

			this.reconcile();
		}

		/** Reconcile the UA tree with the select's own selection/open state. */
		reconcile(): void {
			const host = this.#host;
			const picker = this.#picker;
			if (picker === null) return;
			const selected =
				host.selectedIndex >= 0 ? host.options[host.selectedIndex] : null;
			const label = selected ? selected.label : "";
			if (this.#valueText!.data !== label) {
				this.#valueText!.data = label;
				layoutEngine.invalidate(host);
			}

			if (this.#highlight === null) {
				if (picker.style.display !== "none") picker.style.display = "none";
				return;
			}

			// Rebuild rows to match the option list; cheap at option-list scale.
			const options = Array.from(host.options);
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
			const rect = layoutEngine.getRect(host);
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
			const options = this.#host.options;
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
			const options = Array.from(this.#host.options);
			if (options.length === 0) return;
			let index = this.#host.selectedIndex;
			if (index < 0) index = options.findIndex((o) => !o.disabled);
			this.#highlight = index;
			this.reconcile();
		}

		/** Commit `index` as the selection, close, and fire input then change. */
		#commit(index: number): void {
			const host = this.#host;
			this.#highlight = null;
			host.selectedIndex = index; // The setter reconciles (closes + label).
			host.dispatchEvent(
				new window.Event("input", {bubbles: true, cancelable: false}),
			);
			host.dispatchEvent(
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
			const host = this.#host;
			const key = event.key;
			const options = host.options;
			if (options.length === 0) return;
			const current = host.selectedIndex;

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
					this.reconcile(); // No change: just close.
					return;
				} else if (key === "Escape") {
					this.#highlight = null;
				} else {
					return;
				}
				this.reconcile();
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
			const host = this.#host;
			host.focus(); // A press focuses the control, as in a browser.
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
				if (!host.options[index]?.disabled) {
					this.#highlight = null;
					if (index !== host.selectedIndex) this.#commit(index);
					else this.reconcile(); // Re-press the selection: just close.
				}
				return;
			}
			// Off every row: a press inside the picker's own padding does
			// nothing; a press outside it (the closed face) dismisses.
			const pr = layoutEngine.getRect(this.#picker!);
			if (!(pr && isPointInRects(x, y, pr))) {
				this.#highlight = null;
				this.reconcile();
			}
		};

		#onBlur = (): void => {
			if (this.#highlight !== null) {
				this.#highlight = null;
				this.reconcile();
			}
		};
	}

	function upgrade(element: Element): void {
		const existing = uaWidgetOf(element);
		if (existing !== null) {
			// A control that left the tree and came back keeps its widget; only
			// the state it drifted from needs catching up.
			existing.reconcile();
			return;
		}
		switch (element.tagName) {
			case "TEXTAREA":
				attachUAWidget(element, new UATextarea(element as HTMLTextAreaElement));
				return;
			case "INPUT":
				attachUAWidget(element, new UAInput(element as HTMLInputElement));
				return;
			case "SELECT":
				attachUAWidget(element, new UASelect(element as HTMLSelectElement));
				return;
		}
	}

	return {upgrade};
}
