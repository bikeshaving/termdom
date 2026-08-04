import {type EventEmitter} from "events";
import {type DOMWindow, JSDOM} from "jsdom";
import {LayoutEngine, isPointInRects} from "./layout.js";
import {type ColorDepth, Renderer} from "./ansi.js";
import {
	StyleManager,
	resolveBorderStyles,
	cssColorToNumber,
	getBoxModel,
} from "./styles.js";
import {stringWidth} from "./runtime.js";
import {
	ObserverManager,
	type ObserverHost,
	ResizeObserver as TermResizeObserver,
	IntersectionObserver as TermIntersectionObserver,
} from "./observers.js";
import {setupInspectMethods} from "./inspector.js";
import {
	compositionIsConnected,
	compositionParentElement,
	createExpandedTreeWalker,
	createUAShadowRoot,
	getPseudoMetadata,
} from "./composition.js";

// How long to wait for a resize drag to settle before redrawing. Long enough to
// coalesce the burst of SIGWINCHes a drag fires, short enough to feel immediate.
const RESIZE_DEBOUNCE_MS = 40;

/**
 * A clip in EDGE coordinates, not origin+size, and deliberately not a DOMRect:
 * an axis that nothing clips is unbounded, and the only honest spelling of
 * that is -Infinity to +Infinity. A DOMRect would have to store it as
 * `x: -Infinity, width: Infinity`, whose `right` is then `NaN` -- which every
 * intersection downstream would silently propagate.
 */
type ClipRect = {left: number; top: number; right: number; bottom: number};

/**
 * Whether a computed style asks for an underline.
 *
 * `text-decoration` is a shorthand whose value lives in the longhands, so an
 * author writing `text-decoration-line: underline` leaves the shorthand
 * computing to "none" -- and reading only the shorthand meant the longhand did
 * nothing at all. Read the longhand first, since it is where the value is, and
 * fall back to the shorthand for the styles that set it that way.
 */
function hasUnderline(style: CSSStyleDeclaration): boolean {
	const line = style.getPropertyValue("text-decoration-line");
	if (line) return line.includes("underline");
	return style.getPropertyValue("text-decoration").includes("underline");
}

/**
 * The clip an overflow:hidden (or overflow-x/-y:hidden) element imposes on its
 * own children, intersected with whatever clip was already active from an
 * ancestor. overflow:auto/scroll/visible impose no clip on that axis -- there
 * are no scrollable containers, only the document camera, so "auto/scroll"
 * degrades to "visible" rather than clipping content nobody can scroll to see.
 * An axis that isn't hidden stays unbounded (+-Infinity), not just "this
 * element's own edge", so overflow-x:hidden;overflow-y:visible only bounds
 * columns, matching CSS's independent per-axis overflow.
 */
function overflowClipRect(
	rect: {left: number; top: number; width: number; height: number} | null,
	overflowX: string,
	overflowY: string,
	parent: ClipRect | null,
): ClipRect | null {
	if (!rect) return parent;
	const hiddenX = overflowX === "hidden";
	const hiddenY = overflowY === "hidden";
	if (!hiddenX && !hiddenY) return parent;

	const left = hiddenX ? rect.left : -Infinity;
	const right = hiddenX ? rect.left + rect.width : Infinity;
	const top = hiddenY ? rect.top : -Infinity;
	const bottom = hiddenY ? rect.top + rect.height : Infinity;

	if (!parent) return {left, top, right, bottom};
	return {
		left: Math.max(parent.left, left),
		top: Math.max(parent.top, top),
		right: Math.min(parent.right, right),
		bottom: Math.min(parent.bottom, bottom),
	};
}

// DOM `code` values for the named/special keys the tokenizer already resolves
// unambiguously. This is what `code` is FOR -- unlike `key`, it identifies the
// physical key, not the character it produced.
const NAMED_KEY_CODES: Record<string, string> = {
	Enter: "Enter",
	Tab: "Tab",
	Backspace: "Backspace",
	Escape: "Escape",
	ArrowUp: "ArrowUp",
	ArrowDown: "ArrowDown",
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	Home: "Home",
	End: "End",
	Insert: "Insert",
	Delete: "Delete",
	PageUp: "PageUp",
	PageDown: "PageDown",
	F1: "F1",
	F2: "F2",
	F3: "F3",
	F4: "F4",
	F5: "F5",
	F6: "F6",
	F7: "F7",
	F8: "F8",
	F9: "F9",
	F10: "F10",
	F11: "F11",
	F12: "F12",
	" ": "Space",
};

/**
 * The DOM `code` for a resolved key name -- physical key identity, independent
 * of modifiers. Exact for named/special keys (the escape sequence uniquely
 * identifies the physical key) and for letters/digits under the near-universal
 * assumption of a US QWERTY layout. Not exact for punctuation: a terminal only
 * ever tells us the character a key combination *produced* ("!" from Shift+1
 * on US layout, but a different physical key entirely on others), never which
 * physical key+modifiers produced it -- there is no protocol-level signal for
 * that, unlike the modifier bits `ctrlKey`/`altKey`/`shiftKey` decode from.
 * Falls back to the previous (also approximate) `Key<X>` guess for those.
 */
function domCodeFor(keyName: string): string {
	const named = NAMED_KEY_CODES[keyName];
	if (named) return named;
	if (keyName.length === 1) {
		const upper = keyName.toUpperCase();
		if (upper >= "A" && upper <= "Z") return `Key${upper}`;
		if (keyName >= "0" && keyName <= "9") return `Digit${keyName}`;
	}
	return `Key${keyName.toUpperCase()}`;
}

/**
 * The UA stylesheet of a text field's internal shadow tree: the field
 * design as real, scoped CSS instead of painter constants. The placeholder
 * is the gray ghost label always; when the host is BLURRED the blank --
 * and the placeholder riding it -- goes faint: SGR dim via font-weight,
 * SGR underline via text-decoration, the two classic codes that survive
 * every terminal and every intermediary. The focused field's solid
 * underline is not here: it comes from the input's own focus-aware UA
 * default and INHERITS into every part, so authors override it exactly
 * where they always could.
 */
const FIELD_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="value"] { font-weight: lighter; text-decoration: underline; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; text-decoration: underline; }
	:host(:not(:focus)) [part="blank"] { font-weight: lighter; text-decoration: underline; }
`;

/**
 * The UA stylesheet of a textarea's internal shadow tree. Unlike the
 * input, the textarea's parts render through the NORMAL pipeline -- the
 * value text node lays out, wraps and paints like any document text -- so
 * these rules are all there is: the placeholder's ghost gray, faint when
 * the host is blurred, hidden by the sync controller (an inline
 * display:none) whenever a value exists.
 */
const TEXTAREA_UA_STYLES = `
	[part="placeholder"] { color: #808080; }
	:host(:not(:focus)) [part="placeholder"] { font-weight: lighter; }
`;

/**
 * The UA stylesheet of a select's internal shadow tree: the ▾ indicator
 * is faint -- affordance, not content. Everything else (the focused
 * field's underline included) inherits from the host's own defaults.
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

/**
 * The terminal has exactly three font weights, and CSS names all three:
 * light maps to SGR faint (dim), normal to nothing, bold to SGR bold.
 * Numeric values follow the CSS scale (100-300 light, 600+ bold). The
 * relative keywords resolve absolutely rather than against the parent's
 * weight -- an approximation, documented rather than hidden: "bolder" from
 * a bold parent cannot get bolder on a terminal anyway.
 */
function resolveFontWeight(weight: string): {bold: boolean; dim: boolean} {
	if (weight === "bold" || weight === "bolder") {
		return {bold: true, dim: false};
	}
	if (weight === "lighter") {
		return {bold: false, dim: true};
	}
	const numeric = parseInt(weight, 10);
	if (Number.isFinite(numeric)) {
		if (numeric >= 600) return {bold: true, dim: false};
		if (numeric <= 300) return {bold: false, dim: true};
	}
	return {bold: false, dim: false};
}

/**
 * Highlight / HighlightText -- the system-color pair whose combined
 * meaning on a terminal is "swap the cell's colors", SGR inverse.
 */
function isSystemHighlightColor(value: string): boolean {
	return /^highlight(?:text)?$/i.test(value.trim());
}

/**
 * A computed style reduced to terminal cell attributes -- one mapping,
 * shared by text nodes and the input painter's shadow parts.
 */
function cellStyleFromComputed(
	computedStyle: CSSStyleDeclaration,
): import("./ansi.js").CellStyle {
	const color = computedStyle.getPropertyValue("color");
	const bgColor = computedStyle.getPropertyValue("background-color");
	const {bold, dim} = resolveFontWeight(
		computedStyle.getPropertyValue("font-weight"),
	);
	// The Highlight/HighlightText system-color pair is CSS's spelling of
	// "swap the cell's colors": it translates to SGR inverse, the
	// terminal-native highlight with no color assumptions -- the same
	// translation ::selection's resolver makes. Either name alone (the
	// other overridden by an author color) can't mean "swap", so the
	// system side simply resolves to nothing.
	const isHighlightPair =
		isSystemHighlightColor(bgColor) && isSystemHighlightColor(color);
	return {
		fg:
			color && color !== "initial" && !isSystemHighlightColor(color)
				? cssColorToNumber(color)
				: undefined,
		bg:
			bgColor &&
			bgColor !== "initial" &&
			bgColor !== "transparent" &&
			!/^canvas$/i.test(bgColor.trim()) &&
			!isSystemHighlightColor(bgColor)
				? cssColorToNumber(bgColor)
				: undefined,
		inverse: isHighlightPair || undefined,
		bold,
		dim,
		italic: computedStyle.getPropertyValue("font-style") === "italic",
		underline: hasUnderline(computedStyle),
		underlineStyle:
			computedStyle.getPropertyValue("text-decoration-style") === "double"
				? ("double" as const)
				: undefined,
	};
}

/**
 * The style a selection highlight paints with, over `base`. Everything
 * comes from ::selection rules -- there is no built-in fallback. The UA
 * document sheet declares the Highlight/HighlightText system-color
 * pair, which is CSS's spelling of "swap the cell's colors" and
 * translates to SGR 7 (inverse), the terminal-native highlight with no
 * color assumptions; author colors replace the system keywords through
 * the ordinary cascade. An element no ::selection rule reaches paints
 * no highlight at all -- the UA rule is load-bearing.
 */
function selectionStyleFor(
	window: DOMWindow,
	element: Element,
	base: import("./ansi.js").CellStyle,
): import("./ansi.js").CellStyle {
	const declaration = window.getComputedStyle(element, "::selection");
	const fg = declaration.getPropertyValue("color");
	const bg = declaration.getPropertyValue("background-color");
	if (!fg && !bg) {
		return base;
	}
	const fgAuthored = Boolean(fg) && !isSystemHighlightColor(fg);
	const bgAuthored = Boolean(bg) && !isSystemHighlightColor(bg);
	if (!fgAuthored && !bgAuthored) {
		return {...base, inverse: true};
	}
	return {
		...base,
		fg: fgAuthored ? cssColorToNumber(fg) : base.fg,
		bg: bgAuthored ? cssColorToNumber(bg) : base.bg,
	};
}

/**
 * Whether a box takes part in positioned layout -- the predicate both the
 * containing-block chain and stacking-context collection are built on.
 */
function isPositioned(window: DOMWindow, element: Element): boolean {
	const position = window
		.getComputedStyle(element)
		.getPropertyValue("position");
	return Boolean(position) && position !== "static";
}

/** z-index only means anything on a positioned box; "auto" stays distinct
 * from 0 -- auto paints in the same layer but does NOT form a context. */
function zIndexValueOf(window: DOMWindow, element: Element): number | "auto" {
	const zIndex = window.getComputedStyle(element).getPropertyValue("z-index");
	if (!zIndex || zIndex === "auto") return "auto";
	const value = parseInt(zIndex, 10);
	return Number.isFinite(value) ? value : "auto";
}

/**
 * Map each painted (visual) character of a text node back to its code-unit
 * offset in node.data. The painted fragments are the node's text after
 * whitespace collapsing and line breaking, so they differ from the raw data
 * only in whitespace: a run of data whitespace becomes one visual space, or
 * nothing at a line break. Non-whitespace code units match one-for-one --
 * including surrogate halves, which is what keeps the returned offsets valid
 * as Range offsets (Ranges address code units, not glyphs).
 *
 * Selection needs this bridge in both directions: a mouse hit lands on a
 * visual cell and must become a Range offset into the data; painting walks
 * the visual fragments and must know which of them a data-offset Range
 * covers.
 */
function visualToDataOffsets(
	data: string,
	fragments: Array<{text: string}>,
): number[] {
	const map: number[] = [];
	let d = 0;
	for (const fragment of fragments) {
		// Code UNITS on both sides, not code points: surrogate halves of
		// non-whitespace text are identical in data and fragment, so they
		// align half-to-half, and the map stays indexable by the same
		// positions String.prototype.slice uses.
		for (let i = 0; i < fragment.text.length; i++) {
			if (!/\s/.test(fragment.text[i])) {
				// A visual char never comes from data whitespace -- skip any
				// collapsed run to the next real char.
				while (d < data.length && /\s/.test(data[d])) d++;
				map.push(Math.min(d, Math.max(0, data.length - 1)));
				d++;
			} else {
				// One visual space stands for the whole whitespace run.
				map.push(Math.min(d, Math.max(0, data.length - 1)));
				while (d < data.length && /\s/.test(data[d])) d++;
			}
		}
	}
	return map;
}

/**
 * Reconcile a textarea's UA tree with the element's own state -- the
 * single source of truth. Placeholder visibility is real CSS (an inline
 * display:none), not painter logic: the normal pipeline then simply
 * never sees it.
 */
function syncTextareaShadowTree(
	element: HTMLTextAreaElement,
	parts: {spans: Record<string, HTMLElement>; texts: Record<string, Text>},
): void {
	const value = element.value;
	const placeholder = element.getAttribute("placeholder") ?? "";
	if (parts.texts.value.data !== value) {
		parts.texts.value.data = value;
	}
	if (parts.texts.placeholder.data !== placeholder) {
		parts.texts.placeholder.data = placeholder;
	}
	const placeholderDisplay = value ? "none" : "";
	if (parts.spans.placeholder.style.display !== placeholderDisplay) {
		parts.spans.placeholder.style.display = placeholderDisplay;
	}
}

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
 * The VISUAL lines of a textarea's laid-out value: the painted
 * fragments (one per soft-wrapped or hard-broken line), plus a virtual
 * empty line for each trailing newline past the last visual character
 * (typing Enter at the end must park the caret on the new, still-empty
 * line, which owns no fragment). Offsets are code units into .value;
 * geometry is document cells. Null before the value has ever laid out.
 *
 * The caller passes the widget's shadow parts rather than having them
 * looked up here: every call site already has them, or needs them for
 * something else in the same breath.
 */
function textareaVisualLines(
	element: HTMLTextAreaElement,
	parts: {texts: Record<string, Text>},
	layoutEngine: LayoutEngine,
): {value: string; lines: TextareaVisualLine[]} | null {
	const valueText = parts.texts.value;
	const value = valueText.data;
	const rect = element.getBoundingClientRect();
	const boxModel = getBoxModel(element);
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
	if (rectTexts.length === 0) {
		return null;
	}
	const visToData = visualToDataOffsets(value, rectTexts);

	const lines: TextareaVisualLine[] = [];
	// Blank lines between consecutive newlines own real, EMPTY layout
	// fragments -- no visual characters, so visToData can't place them.
	// A cursor over the value's own structure does: each line consumes
	// its characters plus, when the character at its end is a newline,
	// that one hard separator (soft wraps have no separator to consume).
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

	// A value ending in a newline has exactly ONE line no fragment
	// represents: the empty last line the caret sits on after a final
	// Enter. (Interior blank lines all have fragments -- adding more
	// virtual lines here is what once drifted the caret a row per
	// blank line.)
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

/** The visual line index a caret offset sits on, given textareaVisualLines. */
function textareaLineAt(
	lines: Array<{startOffset: number; endOffset: number}>,
	caret: number,
): number {
	for (let i = 0; i < lines.length; i++) {
		// endOffset is a valid caret slot on this line; a caret exactly at
		// a soft-wrap boundary belongs to the NEXT line's start (both
		// lines claim the offset; later line wins), matching browsers.
		if (caret <= lines[i].endOffset) {
			const next = lines[i + 1];
			if (next && next.startOffset <= caret) continue;
			return i;
		}
	}
	return lines.length - 1;
}

/** Caret cell for a focused textarea, from the laid-out value. */
function textareaCaretCell(
	element: HTMLTextAreaElement,
	parts: {texts: Record<string, Text>},
	layoutEngine: LayoutEngine,
): {x: number; y: number} | null {
	const visual = textareaVisualLines(element, parts, layoutEngine);
	if (!visual) return null;
	const caret =
		element.selectionDirection === "backward"
			? (element.selectionStart ?? visual.value.length)
			: (element.selectionEnd ?? visual.value.length);
	const lineIndex = textareaLineAt(visual.lines, caret);
	const line = visual.lines[lineIndex];
	const within = Math.max(
		0,
		Math.min(caret, line.endOffset) - line.startOffset,
	);
	return {x: line.x + stringWidth(line.text.slice(0, within)), y: line.y};
}

/**
 * Apply CSS `text-transform` at paint time, not layout time. Every character
 * occupies the same cell width regardless of case in a terminal, so unlike a
 * browser's proportional font this can never change line wrapping -- there's
 * no need to re-measure, just transform the already-shaped text right before
 * it's drawn.
 */
function applyTextTransform(text: string, transform: string): string {
	switch (transform) {
		case "uppercase":
			return text.toUpperCase();
		case "lowercase":
			return text.toLowerCase();
		case "capitalize":
			return text.replace(
				/\p{L}[\p{L}\p{M}]*/gu,
				(word) => (word[0]?.toUpperCase() ?? "") + word.slice(1),
			);
		default:
			return text;
	}
}

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

// TODO: Can we use web streams (ReadableStream) or at least track what events we're using?
export interface TTYReadStream extends EventEmitter {
	isTTY: boolean;
	setRawMode?(mode: boolean): this;
	resume(): this;
	pause(): this;
	setEncoding?(encoding?: string): this;
}

export interface ProcessLike extends EventEmitter {
	stdin?: TTYReadStream;
	stdout: TTYWriteStream;
	exit(code?: number): never;
	env: Record<string, string | undefined>;
}

export interface TermDOMOptions {
	process?: ProcessLike;
	width?: number;
	height?: number;
	colorDepth?: ColorDepth;
	/** Disable automatic cursor position detection. Useful for testing. */
	detectCursor?: boolean;
}

// Frames keep the terminal cursor hidden, and dispose() shows it again -- but
// an app that calls process.exit() without disposing would strand the user's
// shell with no cursor. One process-level exit hook restores it for any live
// interactive instance that skipped dispose. Registered lazily, only for
// instances driving the real process (never for test mocks).
const undisposedInteractive = new Set<ProcessLike>();
let exitHookInstalled = false;

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
//
// `a[href]` is in the list because an anchor WITH an href is focusable and
// sequentially reachable per HTML, and an anchor without one is not -- the
// attribute qualifier draws that line for free. Leaving links out made
// navigation link-shaped UI (TodoMVC's All/Active/Completed filters) reachable
// only by mouse.
const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Get all focusable elements in tab order
 */
function getFocusableElements(
	document: Document,
	window: DOMWindow,
	layoutEngine: LayoutEngine,
): Element[] {
	const elements = Array.from(
		document.querySelectorAll(FOCUSABLE_SELECTOR),
	).filter((element) => {
		// Browsers keep unrendered elements out of tab order: a hidden
		// edit-row checkbox must not swallow a Tab press invisibly. An
		// element is rendered when nothing on its flat-tree chain is
		// display:none and it produced boxes.
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = compositionParentElement(ancestor)
		) {
			if (
				window.getComputedStyle(ancestor).getPropertyValue("display") === "none"
			) {
				return false;
			}
		}
		try {
			return layoutEngine.getRects(element).length > 0;
		} catch {
			return false;
		}
	});
	return elements.sort((a, b) => {
		const aTab = parseInt(a.getAttribute("tabindex") || "0", 10);
		const bTab = parseInt(b.getAttribute("tabindex") || "0", 10);
		if (aTab !== bTab) {
			if (aTab > 0 && bTab > 0) return aTab - bTab;
			if (aTab > 0) return -1;
			if (bTab > 0) return 1;
		}
		return 0;
	});
}

/**
 * The `autofocus` default action: an element with the attribute set gets
 * focused as soon as it's connected, the same as a browser does at initial
 * page load -- generalized here to any insertion, which is what lets a
 * dynamically-created element (e.g. an edit input that only exists while
 * editing) still autofocus itself. Scoped to newly added nodes only, not
 * later attribute changes, matching the spec's "insertion" trigger. If a
 * batch inserts more than one autofocus element, the later mutation wins
 * (processed in order, each call simply moves focus again) -- same
 * ambiguity a real page with more than one autofocus element already has.
 */
function focusAutofocusedNodes(mutations: MutationRecord[]): void {
	for (const record of mutations) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== node.ELEMENT_NODE) continue;
			const element = node as Element;
			const candidate = (element as any).autofocus
				? element
				: element.querySelector?.("[autofocus]");
			(candidate as HTMLElement | null)?.focus?.();
		}
	}
}

/** Input types that are buttons rather than fields. */
const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset", "image"]);

/**
 * Does a keypress on this element activate it, the way a click would?
 *
 * Buttons do, on Enter and on Space. Links do, on Enter only -- Space scrolls
 * the page in a browser rather than following the link, and the difference is
 * observable enough to be worth keeping.
 */
function keyboardActivation(
	element: Element,
): {enter: boolean; space: boolean} | null {
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
	return null;
}

function installCursorRestoreOnExit(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.on("exit", () => {
		for (const proc of undisposedInteractive) {
			try {
				// Mouse capture off (a no-op if it was never on), cursor back on.
				proc.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?25h");
			} catch {
				// The stream may already be gone; the shell will survive.
			}
		}
	});
}

// Symbol-keyed handles for the internals the test suite must reach (the layout
// engine, input injection, anchor state). These are deliberately not #private so
// a test can import the key and read them -- but they are off the public API:
// index.ts does not re-export these symbols, so a consumer cannot name them.
const kLayoutEngine = Symbol("layoutEngine");
const kObserver = Symbol("observer");
const kHitTest = Symbol("hitTest");
export {kLayoutEngine, kObserver};

/**
 * The Fullscreen API over the terminal's alternate screen. Lives here
 * rather than in its own module because it needs TermDOM's process and
 * stream types, and because the alt-screen switch has to serialize with
 * rendering -- the two are one concern, not two.
 */
export class FullscreenManager {
	#process: ProcessLike;
	#stdin: TTYReadStream;
	#stdout: TTYWriteStream;

	#fullscreenStack: Element[] = [];
	#isInFullscreenMode: boolean = false;
	#originalTtyMode: boolean = false;

	constructor(process: ProcessLike) {
		this.#process = process;
		this.#stdout = process.stdout;
		this.#stdin = process.stdin!;

		// Setup cleanup handlers
		this.#setupCleanupHandlers();
	}

	/**
	 * Request fullscreen mode for an element
	 */
	async requestFullscreen(
		element: Element,
		_options?: globalThis.FullscreenOptions,
	): Promise<void> {
		if (!element.isConnected) {
			const error = new Error("The element is not contained by a document.");
			error.name = "InvalidStateError";
			throw error;
		}

		try {
			// Add to fullscreen stack
			this.#fullscreenStack.push(element);

			// Enter fullscreen mode if this is the first element
			if (!this.#isInFullscreenMode) {
				await this.#enterFullscreenMode();
			}

			// Fire fullscreenchange event
			this.#fireFullscreenChangeEvent(element);
		} catch (error) {
			// Remove from stack on error
			this.#fullscreenStack.pop();

			// Fire fullscreenerror event
			this.#fireFullscreenErrorEvent(element, error as Error);
			throw error;
		}
	}

	/**
	 * Exit fullscreen mode
	 */
	async exitFullscreen(): Promise<void> {
		if (this.#fullscreenStack.length === 0) {
			return; // Already not in fullscreen
		}

		// Remove the topmost element
		const exitingElement = this.#fullscreenStack.pop()!;

		// If no more elements in stack, exit fullscreen mode
		if (this.#fullscreenStack.length === 0) {
			await this.#exitFullscreenMode();
		}

		// Fire fullscreenchange event
		this.#fireFullscreenChangeEvent(exitingElement);
	}

	/**
	 * Get the current fullscreen element
	 */
	get fullscreenElement(): Element | null {
		return this.#fullscreenStack.length > 0
			? this.#fullscreenStack[this.#fullscreenStack.length - 1]
			: null;
	}

	/**
	 * Check if currently in fullscreen mode
	 */
	get isFullscreen(): boolean {
		return this.#isInFullscreenMode;
	}

	async #enterFullscreenMode(): Promise<void> {
		// Save original TTY mode
		if (this.#stdin && this.#stdin.setRawMode) {
			this.#originalTtyMode = (this.#stdin as any).isRaw || false;
		}

		// Enter alternate screen buffer
		this.#stdout.write("\x1b[?1049h");

		// Clear screen and hide cursor
		this.#stdout.write("\x1b[2J\x1b[H\x1b[?25l");

		// Enable raw mode for input handling
		if (this.#stdin && this.#stdin.setRawMode) {
			this.#stdin.setRawMode(true);
		}
		if (this.#stdin) {
			this.#stdin.resume();
		}

		this.#isInFullscreenMode = true;
	}

	async #exitFullscreenMode(): Promise<void> {
		// Restore cursor and exit alternate screen buffer
		this.#stdout.write("\x1b[?25h\x1b[?1049l");

		// Restore original TTY mode
		if (this.#stdin && this.#stdin.setRawMode) {
			this.#stdin.setRawMode(this.#originalTtyMode);
		}

		this.#isInFullscreenMode = false;
	}

	#fireFullscreenChangeEvent(element: Element): void {
		const window = this.#getWindow(element);
		if (!window) return;

		const event = new window.CustomEvent("fullscreenchange", {
			bubbles: true,
			cancelable: false,
		});

		// Per spec: fired on the element, and it BUBBLES -- document listeners
		// hear it through the bubble; dispatching on the document as well
		// delivered every transition twice.
		element.dispatchEvent(event);
	}

	#fireFullscreenErrorEvent(element: Element, error: Error): void {
		const window = this.#getWindow(element);
		if (!window) return;

		const event = new window.CustomEvent("fullscreenerror", {
			bubbles: true,
			cancelable: false,
			detail: {error},
		});

		// Fire on both element and document
		element.dispatchEvent(event);
		element.ownerDocument?.dispatchEvent(event);
	}

	#getWindow(element?: Element): any {
		// Get window from the element's document, or from the stack
		const targetElement = element || this.#fullscreenStack[0];
		return targetElement?.ownerDocument?.defaultView;
	}

	#setupCleanupHandlers(): void {
		const cleanup = () => {
			if (this.#isInFullscreenMode) {
				// Force exit fullscreen mode on process exit
				this.#stdout.write("\x1b[?25h\x1b[?1049l");

				// Restore TTY mode
				if (this.#stdin && this.#stdin.setRawMode) {
					this.#stdin.setRawMode(this.#originalTtyMode);
				}
			}
		};

		this.#process.on("exit", cleanup);
		this.#process.on("SIGINT", cleanup);
		this.#process.on("SIGTERM", cleanup);
		this.#process.on("SIGHUP", cleanup);
	}

	dispose(): void {
		if (this.#isInFullscreenMode) {
			this.#stdout.write("\x1b[?25h\x1b[?1049l");
			if (this.#stdin && this.#stdin.setRawMode) {
				this.#stdin.setRawMode(this.#originalTtyMode);
			}
		}

		this.#fullscreenStack = [];
		this.#isInFullscreenMode = false;
	}
}

/**
 * Everything the jsdom patches below need from the TermDOM that installed
 * them -- the whole seam, in one place, instead of a closure over the
 * instance.
 *
 * Getters and callbacks, never values. The patches are installed once and
 * then live for as long as the document does: prototype methods, property
 * getters and event plumbing that run long after the constructor returned.
 * Most of what they reach for does not exist yet when they are installed --
 * the renderer, the style manager, the layout engine and the mutation
 * observer are all assigned later in the same constructor -- and the rest
 * (the camera, the anchor, the frame counter) moves while the program runs.
 * A captured value would freeze `undefined` for half of these and a stale
 * number for the other half.
 */
interface DOMPatchHost {
	readonly width: number;
	readonly height: number;
	readonly layoutEngine: LayoutEngine;
	readonly observer: MutationObserver;
	readonly styleManager: StyleManager;
	readonly fullscreenManager: FullscreenManager;
	readonly renderer: Renderer;
	/** The command-start anchor; cursor detection moves it after setup. */
	readonly screenTop: number;
	/** The document camera, shared by scrollY/pageYOffset/scrollTop. */
	scrollTop: number;
	/** Set while a screen switch holds frames back. */
	screenSwitching: boolean;
	readonly renderInFlight: Promise<void> | null;
	readonly attached: boolean;
	readonly renderCount: number;
	/** rAF callbacks by handle; a completed frame drains them. */
	readonly frameCallbacks: Map<number, FrameRequestCallback>;
	/** One per live MediaQueryList, re-run on resize. */
	readonly mediaQueryUpdaters: Set<() => void>;
	allocateFrameHandle(): number;
	mediaQueryMatches(query: string): boolean;
	render(): Promise<void>;
	flushPendingMutations(): void;
	scrollCamera(rows: number): void;
	updateMouseReporting(): void;
	elementAtDocumentPoint(x: number, y: number): Element | null;
	/** Flush the live region into scrollback and seal the document. */
	sealToScrollback(): void;
}

/**
 * Give the jsdom window the parts of the browser a terminal actually has: a
 * viewport with a size, one scrolling camera, a frame clock tied to the
 * render loop, media queries answered by the real style evaluator, and a
 * document.close() that seals output into the scrollback.
 */
function installWindowExtensions(window: DOMWindow, host: DOMPatchHost): void {
	const document = window.document;
	Object.defineProperty(window, "innerWidth", {
		value: host.width,
		writable: false,
		configurable: true,
	});
	Object.defineProperty(window, "innerHeight", {
		value: host.height,
		writable: false,
		configurable: true,
	});
	Object.defineProperty(window, "outerWidth", {
		value: host.width,
		writable: false,
		configurable: true,
	});
	Object.defineProperty(window, "outerHeight", {
		value: host.height,
		writable: false,
		configurable: true,
	});

	// screenTop: readonly like browsers, and LIVE -- cursor detection moves
	// the anchor after this runs. A frozen value here silently shadowed the
	// real one, with only constructor line order deciding which won.
	Object.defineProperty(window, "screenTop", {
		get: () => host.screenTop,
		configurable: true,
		enumerable: true,
	});

	// Standard window scrolling, mapped onto the camera: scrollY is how far the
	// camera has moved down the document, scrollBy moves it.
	Object.defineProperty(window, "scrollY", {
		get: () => host.scrollTop,
		configurable: true,
		enumerable: true,
	});
	Object.defineProperty(window, "pageYOffset", {
		get: () => host.scrollTop,
		configurable: true,
		enumerable: true,
	});
	window.scrollBy = ((
		xOrOptions?: number | ScrollToOptions,
		y?: number,
	): void => {
		const dy =
			typeof xOrOptions === "object" && xOrOptions !== null
				? (xOrOptions.top ?? 0)
				: (y ?? 0);
		host.scrollCamera(dy);
	}) as typeof window.scrollBy;

	// scrollTo/scroll set the camera to an absolute position -- the same
	// state scrollY reads and scrollBy moves relatively. document.
	// documentElement/body.scrollTop are the same value again, standard DOM
	// (window.scrollY === document.documentElement.scrollTop always): one
	// camera, four ways to read or move it, matching the "unified scrolling
	// model" the viewport tests already name it after.
	const scrollToCamera = (
		xOrOptions?: number | ScrollToOptions,
		y?: number,
	): void => {
		const targetY =
			typeof xOrOptions === "object" && xOrOptions !== null
				? (xOrOptions.top ?? host.scrollTop)
				: (y ?? 0);
		host.scrollTop = Math.max(0, targetY);
		void host.render();
	};
	window.scrollTo = scrollToCamera as typeof window.scrollTo;
	window.scroll = scrollToCamera as typeof window.scroll;

	for (const root of [document.documentElement, document.body]) {
		Object.defineProperty(root, "scrollTop", {
			get: () => host.scrollTop,
			set: (value: number) => {
				host.scrollTop = Math.max(0, value);
				void host.render();
			},
			configurable: true,
			enumerable: true,
		});
	}

	// requestAnimationFrame is the only way to await a painted frame -- render()
	// is private. jsdom's pretendToBeVisual rAF is a bare timer, decoupled from
	// our (async) paint, so a callback could fire before the frame is written.
	// Route it through the render loop: schedule a render and fire the callback
	// once it completes, so "await a frame" always means the frame that includes
	// your pending mutations has landed.
	window.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
		const id = host.allocateFrameHandle();
		host.frameCallbacks.set(id, cb);
		void host.render();
		return id;
	}) as typeof window.requestAnimationFrame;
	window.cancelAnimationFrame = ((handle: number): void => {
		host.frameCallbacks.delete(handle);
	}) as typeof window.cancelAnimationFrame;

	// matchMedia: the terminal is the one screen, and queries answer
	// through the SAME evaluator @media stylesheet rules use, so a
	// script and a stylesheet can never disagree about the viewport.
	// The list is live: a resize (SIGWINCH is this screen's window
	// resize) re-evaluates and fires "change" when the answer flips --
	// the browser contract, which is what makes responsive terminal
	// layouts a matchMedia listener instead of a bespoke resize hook.
	window.matchMedia = ((query: string): MediaQueryList => {
		const media = String(query);
		const mql = new (window as any).EventTarget();
		let matches = host.mediaQueryMatches(media);
		let onchange: ((ev: Event) => void) | null = null;
		Object.defineProperties(mql, {
			media: {get: () => media, enumerable: true, configurable: true},
			matches: {get: () => matches, enumerable: true, configurable: true},
			onchange: {
				get: () => onchange,
				set: (value: ((ev: Event) => void) | null) => {
					// An event-handler attribute IS a listener, per spec:
					// route it through add/removeEventListener so dispatch
					// order and dedup behave like any other handler.
					if (onchange) mql.removeEventListener("change", onchange);
					onchange = typeof value === "function" ? value : null;
					if (onchange) mql.addEventListener("change", onchange);
				},
				enumerable: true,
				configurable: true,
			},
			// The pre-2020 MediaQueryList API, still what much deployed
			// code calls: plain aliases for the EventTarget pair.
			addListener: {
				value: (cb: ((ev: Event) => void) | null) => {
					if (cb) mql.addEventListener("change", cb);
				},
				configurable: true,
			},
			removeListener: {
				value: (cb: ((ev: Event) => void) | null) => {
					if (cb) mql.removeEventListener("change", cb);
				},
				configurable: true,
			},
		});
		host.mediaQueryUpdaters.add(() => {
			const now = host.mediaQueryMatches(media);
			if (now === matches) return;
			matches = now;
			const event = new window.Event("change");
			Object.defineProperties(event, {
				matches: {value: now, enumerable: true},
				media: {value: media, enumerable: true},
			});
			mql.dispatchEvent(event);
		});
		return mql as MediaQueryList;
	}) as typeof window.matchMedia;

	// document.close() finalizes the document: flush the live region into the
	// terminal's scrollback and seal it -- the SSR res.end() of the terminal.
	// A later DOM mutation starts a fresh document below the sealed block. This
	// is the "print rich output and stop" seam: write(), then close().
	const nativeDocumentClose = document.close.bind(document);
	document.close = () => {
		nativeDocumentClose();
		// dispose() tears down via jsdom's window.close(), which calls
		// document.close() -- but it has already set attached=false, so we skip
		// the seal there. A real seal is a close() from a live, painted session.
		if (host.attached && host.renderCount > 0) {
			host.sealToScrollback();
		}
	};

	// Implement standard DOM scrollHeight properties
	Object.defineProperty(document.body, "scrollHeight", {
		get() {
			return host.layoutEngine.getContentHeight();
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(document.documentElement, "scrollHeight", {
		get() {
			return host.layoutEngine.getContentHeight();
		},
		configurable: true,
		enumerable: true,
	});

	// clientHeight is the viewport height (terminal height)
	Object.defineProperty(document.body, "clientHeight", {
		get() {
			return host.height;
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(document.documentElement, "clientHeight", {
		get() {
			return host.height;
		},
		configurable: true,
		enumerable: true,
	});
}

/**
 * Patch the DOM constructors themselves: geometry (getBoundingClientRect and
 * the offset/client/scroll measurement family), focus, scrollIntoView,
 * shadow-root enrollment and the Fullscreen API. These are prototype methods,
 * so they apply to every element the document will ever have -- and they are
 * installed before the layout engine, the style manager, the renderer and the
 * observer exist, which is why the host hands those out through getters.
 */
function installConstructorExtensions(
	window: DOMWindow,
	host: DOMPatchHost,
): void {
	const {Element, Document} = window;
	const document = window.document;

	// getRect()/getRects() (the layout engine's own primitives) are
	// document-relative -- the coordinate space rendering already works in,
	// since the renderer applies the camera offset once at paint time, not
	// per element. But getBoundingClientRect/getClientRects are a *public*
	// API, and CSSOM View defines them relative to the viewport: rect.top
	// for a scrolled-past element should be negative, not the same
	// ever-growing document row regardless of scroll. #toViewportRect is the
	// one place that conversion happens, so both wrappers apply it
	// identically. Internal callers that need the pre-conversion,
	// document-relative rect (scrollIntoView, hit-testing) read
	// getRect()/getRects() directly instead of going through these -- see
	// their definitions.
	const toViewportRect = (rect: DOMRect): DOMRect =>
		host.layoutEngine.createDOMRect(
			rect.x,
			rect.y - host.scrollTop,
			rect.width,
			rect.height,
		);

	Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
		if (!this.isConnected) {
			return host.layoutEngine.createDOMRect(0, 0, 0, 0);
		}

		host.flushPendingMutations();

		const rect = host.layoutEngine.getRect(this);
		return toViewportRect(rect || host.layoutEngine.createDOMRect());
	};

	Element.prototype.getClientRects = function (): DOMRectList {
		if (!this.isConnected) {
			return host.layoutEngine.createDOMRectList();
		}

		host.flushPendingMutations();

		const rects = host.layoutEngine.getRects(this).map(toViewportRect);
		return host.layoutEngine.createDOMRectList(rects);
	};

	// offsetWidth/offsetHeight/offsetTop/offsetLeft/offsetParent/clientWidth/
	// clientHeight/scrollWidth/scrollHeight -- the most commonly reached-for
	// measurement APIs, and previously entirely unimplemented (always
	// 0/null via jsdom's defaults). Every one of them is derived from
	// layoutRectOf, the single place that decides "is this element
	// connected, has layout settled, what is its border-box rect" -- so
	// offsetWidth and clientWidth can never quietly disagree about which
	// rect they mean, and a future change to that decision (e.g. how
	// isConnected or render-flushing is handled) only has one place to make.
	//
	// layoutRectOf returns the same rect getBoundingClientRect uses,
	// unrounded (each getter below rounds for its own purpose -- offsetTop
	// rounds the *difference* of two rects, not each rect independently, so
	// rounding here first would double-round and drift by a cell).
	const layoutRectOf = (element: Element): DOMRect | null => {
		if (!element.isConnected) return null;
		host.flushPendingMutations();
		return host.layoutEngine.getRect(element);
	};

	// offsetParent walks the live DOM tree, not layout -- a separate concern
	// from layoutRectOf, reused by offsetParent itself and by offsetTop/Left
	// to find what they're relative to.
	const offsetParentOf = (element: Element): HTMLElement | null => {
		for (
			let ancestor = element.parentElement;
			ancestor;
			ancestor = ancestor.parentElement
		) {
			const position = window
				.getComputedStyle(ancestor)
				.getPropertyValue("position");
			if (position && position !== "static") {
				return ancestor as HTMLElement;
			}
		}
		return document.body === element ? null : document.body;
	};

	// The content+padding box (border-box rect minus border widths), which
	// both clientWidth/Height and scrollWidth/Height report -- see
	// their definition below for why scroll* is an alias of client* rather
	// than the element's true unclamped content size.
	const contentBoxOf = (
		element: Element,
	): {width: number; height: number} | null => {
		const rect = layoutRectOf(element);
		if (!rect) return null;
		const box = getBoxModel(element);
		return {
			width: rect.width - box.borderLeftWidth - box.borderRightWidth,
			height: rect.height - box.borderTopWidth - box.borderBottomWidth,
		};
	};

	Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", {
		get(this: Element) {
			return Math.round(layoutRectOf(this)?.width ?? 0);
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", {
		get(this: Element) {
			return Math.round(layoutRectOf(this)?.height ?? 0);
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(window.HTMLElement.prototype, "offsetParent", {
		get(this: Element) {
			return this.isConnected ? offsetParentOf(this) : null;
		},
		configurable: true,
		enumerable: true,
	});

	// offsetTop/Left are relative to offsetParent's own border-box origin
	// (not its padding edge, which the spec technically uses): a
	// simplification that only differs when offsetParent itself has a
	// border, and is off by exactly that border's width when it does.
	Object.defineProperty(window.HTMLElement.prototype, "offsetTop", {
		get(this: Element) {
			const rect = layoutRectOf(this);
			if (!rect) return 0;
			const parent = offsetParentOf(this);
			const parentRect = parent ? layoutRectOf(parent) : null;
			return Math.round(rect.top - (parentRect?.top ?? 0));
		},
		configurable: true,
		enumerable: true,
	});

	Object.defineProperty(window.HTMLElement.prototype, "offsetLeft", {
		get(this: Element) {
			const rect = layoutRectOf(this);
			if (!rect) return 0;
			const parent = offsetParentOf(this);
			const parentRect = parent ? layoutRectOf(parent) : null;
			return Math.round(rect.left - (parentRect?.left ?? 0));
		},
		configurable: true,
		enumerable: true,
	});

	// clientWidth/clientHeight/scrollWidth/scrollHeight, generalized from the
	// html/body-only instance properties defined above (which still win: an
	// own-property shadows a prototype getter, so document.body's viewport-
	// height special case is untouched).
	//
	// scroll* is set equal to client* here rather than the element's true
	// unclamped content size, matching the same limitation the paint-extent
	// culling above already documents for the same reason: nothing in the
	// layout engine measures a subtree's natural size separately from
	// whatever box it was actually constrained into. That makes scroll* exact
	// for the common case (auto-sized boxes, no overflow) and an honest
	// under-report for a box with both an explicit size *and* overflowing
	// normal-flow content -- the one case a real browser's scrollWidth/Height
	// would exceed clientWidth/Height.
	for (const prop of ["clientWidth", "scrollWidth"] as const) {
		Object.defineProperty(window.HTMLElement.prototype, prop, {
			get(this: Element) {
				return Math.round(contentBoxOf(this)?.width ?? 0);
			},
			configurable: true,
			enumerable: true,
		});
	}

	for (const prop of ["clientHeight", "scrollHeight"] as const) {
		Object.defineProperty(window.HTMLElement.prototype, prop, {
			get(this: Element) {
				return Math.round(contentBoxOf(this)?.height ?? 0);
			},
			configurable: true,
			enumerable: true,
		});
	}

	// The document-rooted MutationObserver never sees inside a shadow
	// root -- per spec, shadow trees are separate observation scopes. Each
	// author-attached root gets enrolled in the same observer, so shadow
	// mutations invalidate styles/layout and repaint like light ones.
	const originalAttachShadow = Element.prototype.attachShadow;
	Element.prototype.attachShadow = function (
		this: Element,
		init: ShadowRootInit,
	): ShadowRoot {
		const root = originalAttachShadow.call(this, init);
		host.observer.observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeOldValue: true,
			characterData: true,
		});
		// The root's <style> elements join the cascade, scoped to this
		// tree; the refresh rides on the STYLE mutation records the
		// observer enrollment above will deliver.
		host.styleManager.registerShadowRoot(root);
		// attachShadow is not a DOM mutation -- no observer record will
		// ever fire for it -- but on a CONNECTED host the composed tree
		// just changed wholesale: light children stop rendering the moment
		// the root exists, even while it is still empty. Rebuild the
		// host's composed subtree and repaint.
		if (this.isConnected) {
			host.layoutEngine.invalidate(this);
			void host.render();
		}
		return root;
	};

	Element.prototype.requestFullscreen = function (
		this: Element,
		options?: FullscreenOptions,
	): Promise<void> {
		return (async () => {
			// No frame may straddle the screen switch: an in-flight render
			// finishing its stdout write AFTER the switch paints one
			// screen's geometry onto the other (the demo's animation made
			// this a near-certainty on exit). Hold new frames, drain the
			// running one, then switch.
			host.screenSwitching = true;
			try {
				await host.renderInFlight;
				await host.fullscreenManager.requestFullscreen(this, options);
				// The element's UA styles changed (it now fills the
				// viewport) and neither a mutation nor a focus move fired.
				host.styleManager.handleFocusChange(this);
				host.layoutEngine.invalidate(this);
				// The screen under the renderer changed wholesale (the
				// alternate screen starts cleared): drop the diff model or
				// the first fullscreen frame patches against the main
				// screen's content.
				host.renderer.clearPreviousBuffer();
				host.updateMouseReporting();
			} finally {
				host.screenSwitching = false;
			}
			void host.render();
		})();
	};

	Document.prototype.exitFullscreen = function (this: Document): Promise<void> {
		return (async () => {
			const element = host.fullscreenManager.fullscreenElement;
			host.screenSwitching = true;
			try {
				await host.renderInFlight;
				await host.fullscreenManager.exitFullscreen();
				if (element) {
					host.styleManager.handleFocusChange(element);
					host.layoutEngine.invalidate(element);
				}
				// Same wholesale swap in reverse: the terminal restored the
				// main screen, but the diff model still describes the last
				// ALTERNATE-screen frame -- patching against it garbles the
				// restored document.
				host.renderer.clearPreviousBuffer();
				host.updateMouseReporting();
			} finally {
				host.screenSwitching = false;
			}
			void host.render();
		})();
	};

	Object.defineProperty(Document.prototype, "fullscreenElement", {
		get: function (this: Document) {
			// Style computation consults this during construction, before
			// the manager field is assigned.
			return host.fullscreenManager?.fullscreenElement ?? null;
		},
		configurable: true,
	});

	Document.prototype.elementFromPoint = function (
		x: number,
		y: number,
	): Element | null {
		// Per CSSOM View, x/y are viewport-relative -- convert to the
		// document-relative space hit-testing works in, the same conversion
		// getBoundingClientRect's toViewportRect makes in the other direction.
		return host.elementAtDocumentPoint(x, y + host.scrollTop);
	};

	// Override focus/blur to dispatch proper events
	const HTMLElement = window.HTMLElement;
	const originalFocus = HTMLElement.prototype.focus;
	const originalBlur = HTMLElement.prototype.blur;

	HTMLElement.prototype.focus = function (this: HTMLElement) {
		const prev = document.activeElement;
		originalFocus.call(this);
		if (prev !== this) {
			// :focus rules match live, but computed styles are cached and
			// focus is not a mutation -- both moved elements must drop
			// their caches, and the repaint must happen even when no
			// listener mutates anything.
			host.styleManager.handleFocusChange(prev, this);
			void host.render();
			if (prev && prev !== document.body) {
				prev.dispatchEvent(
					new window.FocusEvent("blur", {
						relatedTarget: this,
						bubbles: false,
					}),
				);
				prev.dispatchEvent(
					new window.FocusEvent("focusout", {
						relatedTarget: this,
						bubbles: true,
					}),
				);
			}
			this.dispatchEvent(
				new window.FocusEvent("focus", {
					relatedTarget: prev,
					bubbles: false,
				}),
			);
			this.dispatchEvent(
				new window.FocusEvent("focusin", {
					relatedTarget: prev,
					bubbles: true,
				}),
			);
		}
	};

	HTMLElement.prototype.blur = function (this: HTMLElement) {
		const wasFocused = document.activeElement === this;
		originalBlur.call(this);
		if (wasFocused) {
			host.styleManager.handleFocusChange(this);
			void host.render();
			this.dispatchEvent(
				new window.FocusEvent("blur", {
					relatedTarget: null,
					bubbles: false,
				}),
			);
			this.dispatchEvent(
				new window.FocusEvent("focusout", {
					relatedTarget: null,
					bubbles: true,
				}),
			);
		}
	};

	// Override scrollIntoView to adjust scroll offset
	HTMLElement.prototype.scrollIntoView = function (
		this: HTMLElement,
		_arg?: boolean | ScrollIntoViewOptions,
	) {
		if (!this.isConnected) return;
		host.flushPendingMutations();

		// Document-relative, not getBoundingClientRect's viewport-relative --
		// this compares directly against documentScrollTop below, so it needs
		// the same coordinate space getRect() already provides.
		const rect = host.layoutEngine.getRect(this);
		if (!rect) return;

		// The camera shows [documentScrollTop, documentScrollTop + region).
		// Move it the minimal amount that brings the element into it -- the
		// standard block: "nearest" behavior.
		const regionHeight = Math.min(host.height, document.body.scrollHeight);
		const top = host.scrollTop;
		if (rect.top < top) {
			host.scrollCamera(rect.top - top);
		} else if (rect.bottom > top + regionHeight) {
			host.scrollCamera(rect.bottom - (top + regionHeight));
		}
	};
}

/** The measurement surface the observers read each frame. See ObserverHost. */
function createObserverHost(
	window: DOMWindow,
	host: DOMPatchHost,
): ObserverHost {
	return {
		// getRect builds a fresh DOMRect per call, so this one can be handed
		// straight to author code with nothing to alias.
		getBorderBox: (element) => host.layoutEngine.getRect(element),
		getContentBox: (element) => {
			// An element that generates no box has no content box either --
			// not a zero-sized one at its old padding offsets. Reported as
			// "nothing", which the observer turns into an all-zero rect.
			if (
				window.getComputedStyle(element).getPropertyValue("display") === "none"
			) {
				return null;
			}
			const rect = host.layoutEngine.getRect(element);
			if (!rect) return null;
			const box = getBoxModel(element);
			const width = Math.max(
				0,
				rect.width -
					(box.paddingLeft || 0) -
					(box.paddingRight || 0) -
					(box.borderLeftWidth || 0) -
					(box.borderRightWidth || 0),
			);
			const height = Math.max(
				0,
				rect.height -
					(box.paddingTop || 0) -
					(box.paddingBottom || 0) -
					(box.borderTopWidth || 0) -
					(box.borderBottomWidth || 0),
			);
			// Origin relative to the border box: what precedes the content on
			// each axis. ResizeObserver reports this as contentRect's top/left.
			return {
				width,
				height,
				top: (box.borderTopWidth || 0) + (box.paddingTop || 0),
				left: (box.borderLeftWidth || 0) + (box.paddingLeft || 0),
			};
		},
		getViewportRect: () =>
			// The visible window over the document, in the document coordinate
			// space getRect() uses: it begins at the current scroll offset and is
			// one terminal high.
			host.layoutEngine.createDOMRect(
				0,
				host.scrollTop,
				host.width,
				host.height,
			),
		createRect: (x, y, width, height) =>
			host.layoutEngine.createDOMRect(x, y, width, height),
		now: () => host.renderCount,
	};
}

/** The parts of an input's UA shadow tree the painter reads back. */
type ShadowParts = {
	kind: "field" | "toggle" | "textarea" | "select";
	spans: Record<string, HTMLElement>;
	texts: Record<string, Text>;
};

/**
 * Everything the painter needs from the TermDOM it belongs to. Getters and
 * callbacks, never values -- the camera (documentScrollTop) moves during a
 * frame, the top layer and the outside-marker set are live objects the render
 * loop mutates (renderedOutsideMarkers is replaced wholesale each frame), and
 * the shadow-part builders mutate the DOM and must run against the current
 * tree. A captured snapshot of any of these would paint against a stale world.
 */
interface PaintHost {
	readonly layoutEngine: LayoutEngine;
	readonly styleManager: StyleManager;
	/** The document camera; moves within a frame. */
	readonly documentScrollTop: number;
	/** Live: the render loop adds and removes members. */
	readonly topLayer: Set<Element>;
	/** Live: the render loop replaces this set at the start of every frame. */
	readonly renderedOutsideMarkers: WeakSet<Element>;
	readonly inputScrollOffsets: WeakMap<Element, number>;
	ensureInputShadowParts(element: HTMLInputElement): ShadowParts;
	ensureTextareaShadowParts(element: HTMLTextAreaElement): ShadowParts;
	ensureSelectShadowParts(element: HTMLSelectElement): ShadowParts;
	syncInputShadowTree(
		element: HTMLInputElement,
		parts: {spans: Record<string, HTMLElement>; texts: Record<string, Text>},
	): void;
	syncSelectShadowTree(
		element: HTMLSelectElement,
		parts: {spans: Record<string, HTMLElement>; texts: Record<string, Text>},
	): void;
}

/**
 * The paint tree-walk, lifted out of TermDOM: it turns the laid-out document
 * into cells in a DrawingContext and reads nothing of the terminal session
 * (the frame loop, the cursor, the anchor) -- those stay in TermDOM and drive
 * it. Its dependencies on the session are the explicit PaintHost above.
 */
class Painter {
	#window: DOMWindow;
	#document: Document;
	#host: PaintHost;

	constructor(window: DOMWindow, host: PaintHost) {
		this.#window = window;
		this.#document = window.document;
		this.#host = host;
	}

	#renderElement(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
		afterOwnBox?: () => void,
	): void {
		// Viewport culling. The buffer only keeps document rows in
		// [-viewportOffset, -viewportOffset + rows); a subtree whose paint extent
		// lies wholly outside that band would be walked -- styles computed, text
		// shaped, borders drawn -- and then discarded cell by cell. Skip it here
		// and the paint costs what is on screen, not what is in the document.
		const bandTop = -ctx.viewportOffset;
		if (
			this.#host.layoutEngine.isSubtreeOutsideBand(
				element,
				bandTop,
				bandTop + ctx.rows,
			)
		) {
			return;
		}

		// display:none generates NO box and no descendant boxes -- final, per
		// CSS. Stray run state under a hidden subtree (an editing todo's
		// hidden .view) could otherwise ghost-paint at whatever coordinates
		// it last held.
		if (
			this.#window.getComputedStyle(element).getPropertyValue("display") ===
			"none"
		) {
			return;
		}

		const rect = this.#host.layoutEngine.getRect(element);

		const color = this.#window
			.getComputedStyle(element)
			.getPropertyValue("color");
		const backgroundColor = this.#window
			.getComputedStyle(element)
			.getPropertyValue("background-color");
		const {bold, dim} = resolveFontWeight(
			this.#window.getComputedStyle(element).getPropertyValue("font-weight"),
		);
		const italic =
			this.#window.getComputedStyle(element).getPropertyValue("font-style") ===
			"italic";
		const underline = hasUnderline(this.#window.getComputedStyle(element));
		const underlineStyle =
			this.#window
				.getComputedStyle(element)
				.getPropertyValue("text-decoration-style") === "double"
				? ("double" as const)
				: undefined;
		// visibility:hidden reserves the box (layout is untouched) but paints
		// nothing of it -- unlike display:none, which removes the box entirely. A
		// descendant that sets visibility:visible still paints, since visibility
		// inherits and each element resolves its own computed value here.
		const visible =
			this.#window.getComputedStyle(element).getPropertyValue("visibility") !==
			"hidden";

		// background-color: Canvas -- the CSS system color for the document
		// background -- clears the box to the terminal's DEFAULT background:
		// opaque in every theme without asserting any color, the same
		// system-color translation ::selection's Highlight pair uses. The UA
		// picker sheet relies on it; authors can too. The Highlight/
		// HighlightText pair fills the box with SGR inverse instead -- the
		// browser's blue dropdown row, in the terminal's own colors (the UA
		// select sheet's highlighted option rides this).
		const isCanvasBg =
			Boolean(backgroundColor) && /^canvas$/i.test(backgroundColor.trim());
		const isHighlightBox =
			Boolean(backgroundColor) &&
			isSystemHighlightColor(backgroundColor) &&
			Boolean(color) &&
			isSystemHighlightColor(color);
		const style = {
			fg:
				color && color !== "initial" && !isSystemHighlightColor(color)
					? cssColorToNumber(color)
					: undefined,
			bg:
				backgroundColor &&
				!isCanvasBg &&
				backgroundColor !== "initial" &&
				backgroundColor !== "transparent" &&
				!isSystemHighlightColor(backgroundColor)
					? cssColorToNumber(backgroundColor)
					: undefined,
			bold,
			dim,
			italic,
			underline,
			underlineStyle,
		};

		if (rect && visible && (style.bg != null || isCanvasBg || isHighlightBox)) {
			ctx.fillRect(
				rect.left,
				rect.top,
				rect.width,
				rect.height,
				isCanvasBg ? "default" : isHighlightBox ? "inverse" : style.bg,
			);
		}

		// Handle borders
		if (rect && visible) {
			const borderStyles = resolveBorderStyles(element);
			if (borderStyles.hasAnyBorder) {
				// Border color per CSS: border-color, whose initial value is
				// currentColor -- the element's own color -- and, with nothing
				// authored anywhere, the terminal's DEFAULT foreground. Never a
				// hardcoded white: no theme-safe color exists, and forcing one
				// breaks light terminals.
				const borderColor = this.#window
					.getComputedStyle(element)
					.getPropertyValue("border-top-color");
				const borderCellStyle = {
					fg:
						borderColor &&
						borderColor !== "currentcolor" &&
						borderColor !== "currentColor"
							? cssColorToNumber(borderColor)
							: style.fg,
					bg: style.bg, // Inherit element's background color
				};
				ctx.drawBorder(
					Math.round(rect.left),
					Math.round(rect.top),
					Math.round(rect.width),
					Math.round(rect.height),
					borderStyles,
					borderCellStyle,
				);
			}
		}

		// Handle list-style-position: outside markers
		if (visible) this.#renderOutsideMarker(element, ctx);

		// A textarea's content IS its UA shadow tree, painted by the normal
		// child walk below; what the widget owns here is just tree upkeep (a
		// safety-net sync for framework .value assignments -- no observer
		// record fires for those) and parking the real terminal caret at the
		// multiline position.
		if (element.tagName === "TEXTAREA" && rect) {
			const textarea = element as HTMLTextAreaElement;
			const parts = this.#host.ensureTextareaShadowParts(textarea);
			syncTextareaShadowTree(textarea, parts);
			if (visible && textarea === this.#document.activeElement) {
				const caretCell = textareaCaretCell(
					textarea,
					parts,
					this.#host.layoutEngine,
				);
				if (caretCell) {
					ctx.setCaret(caretCell.x, caretCell.y);
				}
			}
		}

		// A select's content is its UA shadow tree (label + indicator),
		// painted by the normal child walk; upkeep and caret parking are all
		// that belongs here.
		if (element.tagName === "SELECT" && rect) {
			const select = element as HTMLSelectElement;
			const parts = this.#host.ensureSelectShadowParts(select);
			this.#host.syncSelectShadowTree(select, parts);
			if (visible && select === this.#document.activeElement) {
				const boxModel = getBoxModel(select);
				ctx.setCaret(
					Math.round(rect.left) +
						(boxModel.borderLeftWidth || 0) +
						(boxModel.paddingLeft || 0),
					Math.round(rect.top) +
						(boxModel.borderTopWidth || 0) +
						(boxModel.paddingTop || 0),
				);
			}
		}

		// Render input elements (void elements with no children)
		if (
			element.tagName === "INPUT" &&
			rect &&
			(element as HTMLInputElement).type !== "hidden"
		) {
			if (visible) {
				this.#renderInputElement(element as HTMLInputElement, rect, ctx);
			}
			return; // Input elements have no children to render
		}

		// Note: JSDOM automatically calls connectedCallback() when elements are added to DOM
		// No manual lifecycle management needed

		// The stacking-context painter slots its negative-z layer here: after
		// this element's own background and border, before any of its in-flow
		// content -- the CSS position for negative z-index.
		if (afterOwnBox) afterOwnBox();

		// The IN-FLOW walk: children paint in tree order, and POSITIONED
		// children don't paint here at all -- per CSS they are hoisted to
		// their nearest stacking context and painted in its layer order (see
		// #renderStackingContext). The old per-sibling z sort could never
		// let a deep overlay escape its parent's siblings; hoisting is what
		// makes a modal or dropdown paint over unrelated subtrees.
		const children: Node[] = [];

		// Fast path: for a plain vertically-stacked container (no position:
		// relative/absolute child, no flex-direction other than column -- see
		// visibleChildrenInBand's own doc comment for exactly what that rules
		// out), the layout tree already knows which children are in band
		// without visiting the rest to rule them out. Without it, a long list
		// scrolled to any depth costs O(total children) per frame -- worse
		// the longer the list gets, though only ~O(screen) of it can ever be
		// visible -- because the walker below has no choice but to step
		// through every sibling to find out which ones are off-band.
		const fastChildren = this.#host.layoutEngine.visibleChildrenInBand(
			element,
			bandTop,
			bandTop + ctx.rows,
		);
		if (fastChildren) {
			for (const childNode of fastChildren) {
				children.push(childNode);
			}
		} else {
			// Use ExpandedTreeWalker to render all children including pseudo-elements and shadow DOM
			const walker = createExpandedTreeWalker(this.#window, element);
			for (
				let childNode = walker.firstChild();
				childNode;
				childNode = walker.nextSibling()
			) {
				// Cull before any style read: an off-band child costs one map
				// lookup instead of a computed-style resolution, which is what keeps a
				// wide container of mostly off-screen children O(screen).
				if (
					childNode.nodeType === childNode.ELEMENT_NODE &&
					this.#host.layoutEngine.isSubtreeOutsideBand(
						childNode as Element,
						bandTop,
						bandTop + ctx.rows,
					)
				) {
					continue;
				}
				if (
					childNode.nodeType === childNode.ELEMENT_NODE &&
					isPositioned(this.#window, childNode as Element) &&
					this.#host.layoutEngine.positionedElements.has(childNode as Element)
				) {
					// Hoisted to its stacking context. Registry membership is
					// the gate: a positioned INLINE run member owns no box of
					// its own -- no layer would ever paint it, so it stays with
					// its run (offsets on run members are an unsupported edge).
					continue;
				}
				children.push(childNode);
			}
		}

		// overflow:hidden clips *descendants* to this element's own box -- never
		// the element's own border/background painted above, which is why this is
		// scoped to just the children, not the whole function.
		const overflow = this.#window
			.getComputedStyle(element)
			.getPropertyValue("overflow");
		const overflowX =
			this.#window.getComputedStyle(element).getPropertyValue("overflow-x") ||
			overflow;
		const overflowY =
			this.#window.getComputedStyle(element).getPropertyValue("overflow-y") ||
			overflow;
		const previousClip = ctx.clipRect;
		ctx.clipRect = overflowClipRect(rect, overflowX, overflowY, previousClip);

		try {
			for (const childNode of children) {
				if (childNode.nodeType === childNode.ELEMENT_NODE) {
					const childElement = childNode as Element;
					if (childElement instanceof (this.#window as any).HTMLElement) {
						this.#renderElement(childElement, ctx);
					}
				} else if (childNode.nodeType === childNode.TEXT_NODE) {
					const textNode = childNode as Text;
					this.#renderText(textNode, ctx);
				}
			}
		} finally {
			ctx.clipRect = previousClip;
		}

		// The textarea's selection paints OVER the value text the child walk
		// just laid down: the field's own bounded selection, shown while
		// focused, styled by its ::selection rules like any document text.
		if (element.tagName === "TEXTAREA" && rect && visible) {
			this.#renderTextareaSelection(element as HTMLTextAreaElement, ctx);
		}
	}

	#renderTextareaSelection(
		element: HTMLTextAreaElement,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		if (element !== this.#document.activeElement) return;
		const selStart = element.selectionStart ?? 0;
		const selEnd = element.selectionEnd ?? 0;
		if (selEnd <= selStart) return;
		const parts = this.#host.ensureTextareaShadowParts(element);
		const visual = textareaVisualLines(element, parts, this.#host.layoutEngine);
		if (!visual) return;
		const style = selectionStyleFor(
			this.#window,
			element,
			cellStyleFromComputed(this.#window.getComputedStyle(parts.spans.value)),
		);
		for (const line of visual.lines) {
			const from = Math.max(selStart, line.startOffset);
			const to = Math.min(selEnd, line.endOffset);
			if (to <= from) continue;
			const pre = line.text.slice(0, from - line.startOffset);
			const slice = line.text.slice(
				from - line.startOffset,
				to - line.startOffset,
			);
			if (!slice) continue;
			ctx.setText(line.x + stringWidth(pre), line.y, slice, style);
		}
	}

	/**
	 * The paint height of the document: body's scroll height, extended to
	 * cover top-layer boxes -- hoisted under the root, they contribute
	 * nothing to body's own height, and a picker opening at the bottom
	 * edge must still get rows to paint into.
	 */
	documentPaintHeight(): number {
		let height = this.#document.body.scrollHeight;
		for (const element of this.#host.topLayer) {
			if (!compositionIsConnected(element)) continue;
			const rect = this.#host.layoutEngine.getRect(element);
			if (rect) height = Math.max(height, Math.ceil(rect.bottom));
		}
		return height;
	}

	/** The whole document: the root stacking context, then the top layer. */
	renderDocument(ctx: import("./ansi.js").DrawingContext): void {
		const layers = this.collectStackingLayers();
		this.#renderStackingContext(this.#document.body, ctx, layers);
		for (const element of this.#host.topLayer) {
			// COMPOSITION-connected: a UA part (the select's picker) lives in
			// a fragment and is never DOM-connected while very much on screen.
			if (!compositionIsConnected(element)) {
				this.#host.topLayer.delete(element);
				continue;
			}
			const previousClip = ctx.clipRect;
			ctx.clipRect = null;
			try {
				this.#renderStackingContext(element, ctx, layers);
			} finally {
				ctx.clipRect = previousClip;
			}
		}
	}

	/**
	 * The clip a deferred positioned box paints under: the context root's
	 * clip, intersected with every overflow-clipping box along the CSS
	 * containing-block chain (its positioned ancestors up to the context
	 * root) -- and nothing else: intervening non-positioned overflow
	 * ancestors don't clip a box they don't contain.
	 */
	#positionedClipFor(
		element: Element,
		contextRoot: Element,
		contextClip: import("./ansi.js").DrawingContext["clipRect"],
	): import("./ansi.js").DrawingContext["clipRect"] {
		let clip = contextClip;
		for (
			let ancestor = compositionParentElement(element);
			ancestor && ancestor !== contextRoot;
			ancestor = compositionParentElement(ancestor)
		) {
			if (!isPositioned(this.#window, ancestor)) continue;
			const style = this.#window.getComputedStyle(ancestor);
			const overflow = style.getPropertyValue("overflow");
			const overflowX = style.getPropertyValue("overflow-x") || overflow;
			const overflowY = style.getPropertyValue("overflow-y") || overflow;
			if (overflowX === "hidden" || overflowY === "hidden") {
				const rect = this.#host.layoutEngine.getRect(ancestor);
				if (rect) {
					clip = overflowClipRect(rect, overflowX, overflowY, clip);
				}
			}
		}
		return clip;
	}

	/**
	 * Whether an element establishes a stacking context: the paint-atomic
	 * unit of CSS layering. Terminal-relevant predicate: positioned with a
	 * non-auto z-index. (The root context belongs to <body>, the paint
	 * root.) opacity/transform/filter have no terminal meaning here.
	 */
	formsStackingContext(element: Element): boolean {
		if (element === this.#document.body) return true;
		if (
			this.#window.getComputedStyle(element).getPropertyValue("isolation") ===
			"isolate"
		) {
			return true;
		}
		return (
			isPositioned(this.#window, element) &&
			zIndexValueOf(this.#window, element) !== "auto"
		);
	}

	/**
	 * Group every connected positioned element under its nearest
	 * stacking-context ancestor, bucketed into the CSS paint layers:
	 * negative-z contexts, the z:auto/0 layer, positive-z contexts. Walks
	 * only the positioned registry -- O(positioned x depth) per frame,
	 * never O(document).
	 */
	collectStackingLayers(): Map<
		Element,
		{neg: Element[]; zero: Element[]; pos: Element[]}
	> {
		const layers = new Map<
			Element,
			{neg: Element[]; zero: Element[]; pos: Element[]}
		>();
		for (const element of this.#host.layoutEngine.positionedElements) {
			if (!element.isConnected || element === this.#document.body) continue;
			if (this.#host.topLayer.has(element)) continue; // painted above everything
			if (!isPositioned(this.#window, element)) continue; // stale registry entry
			let root: Element = this.#document.body;
			for (
				let ancestor = compositionParentElement(element);
				ancestor;
				ancestor = compositionParentElement(ancestor)
			) {
				if (this.formsStackingContext(ancestor)) {
					root = ancestor;
					break;
				}
			}
			let bucket = layers.get(root);
			if (!bucket) {
				bucket = {neg: [], zero: [], pos: []};
				layers.set(root, bucket);
			}
			const z = zIndexValueOf(this.#window, element);
			if (z === "auto" || z === 0) bucket.zero.push(element);
			else if (z < 0) bucket.neg.push(element);
			else bucket.pos.push(element);
		}
		const treeOrder = (a: Element, b: Element) =>
			a.compareDocumentPosition(b) & 4 ? -1 : 1; // 4: b follows a
		for (const bucket of layers.values()) {
			const byZ = (a: Element, b: Element) => {
				const za = zIndexValueOf(this.#window, a) as number;
				const zb = zIndexValueOf(this.#window, b) as number;
				return za !== zb ? za - zb : treeOrder(a, b);
			};
			bucket.neg.sort(byZ);
			bucket.zero.sort(treeOrder);
			bucket.pos.sort(byZ);
		}
		return layers;
	}

	/**
	 * Paint a stacking context in the CSS layer order: the root's own box,
	 * negative-z child contexts, in-flow content (the #renderElement walk,
	 * which skips positioned descendants), the positioned z:auto/0 layer,
	 * then positive-z contexts. A z:auto member doesn't isolate: it paints
	 * as an in-flow subtree here while its own positioned descendants sit
	 * in THIS context's buckets. Deferred layers paint under the context
	 * root's clip -- a positioned box escapes overflow ancestors between
	 * itself and its context, the common CSS escape (per-containing-block
	 * clipping is layer-2 work).
	 */
	#renderStackingContext(
		root: Element,
		ctx: import("./ansi.js").DrawingContext,
		layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
	): void {
		const bucket = layers.get(root);
		if (!bucket) {
			this.#renderElement(root, ctx);
			return;
		}
		const contextClip = ctx.clipRect;
		const paintMember = (element: Element) => {
			const previousClip = ctx.clipRect;
			const previousOffset = ctx.viewportOffset;
			// Clips apply along the CONTAINING BLOCK chain only: an overflow
			// ancestor that isn't a positioned ancestor doesn't clip a
			// deferred box, but its own containing blocks' overflow does.
			ctx.clipRect = this.#positionedClipFor(element, root, contextClip);
			// position:fixed anchors to the VIEWPORT: cancel the camera by
			// undoing the scroll offset for the whole subtree.
			if (
				this.#window.getComputedStyle(element).getPropertyValue("position") ===
				"fixed"
			) {
				ctx.viewportOffset = previousOffset + this.#host.documentScrollTop;
			}
			try {
				if (this.formsStackingContext(element)) {
					this.#renderStackingContext(element, ctx, layers);
				} else {
					this.#renderElement(element, ctx);
				}
			} finally {
				ctx.clipRect = previousClip;
				ctx.viewportOffset = previousOffset;
			}
		};
		this.#renderElement(root, ctx, () => {
			for (const element of bucket.neg) paintMember(element);
		});
		for (const element of bucket.zero) paintMember(element);
		for (const element of bucket.pos) paintMember(element);
	}

	/**
	 * Render outside positioned markers for list items
	 */
	#renderOutsideMarker(
		element: Element,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const computedStyle = this.#window.getComputedStyle(element);
		const display = computedStyle.getPropertyValue("display");

		// Only handle list items
		if (display !== "list-item") {
			return;
		}

		const listStylePosition =
			computedStyle.getPropertyValue("list-style-position") || "outside";

		// Only handle outside positioning
		if (listStylePosition !== "outside") {
			return;
		}

		// Prevent duplicate rendering in the same frame
		if (this.#host.renderedOutsideMarkers.has(element)) {
			return;
		}
		this.#host.renderedOutsideMarkers.add(element);

		// Get marker content from StyleManager
		const markerContent = this.#host.styleManager.getMarkerContent(element);
		if (!markerContent) {
			return;
		}

		const rect = this.#host.layoutEngine.getRect(element);
		if (!rect) {
			return;
		}

		// Cells, not code units: a marker like "日本 " is 3 characters but 5 cells
		// wide, and right-aligning it by its length would paint it over the item's
		// own text.
		const markerWidth = stringWidth(markerContent);

		// Get marker styles
		const markerStyle = this.#window.getComputedStyle(element, "::marker");
		// ::marker inherits color from its originating element, so fall back to the
		// list item's own color rather than rendering the marker unstyled.
		const markerColor =
			markerStyle.getPropertyValue("color") ||
			computedStyle.getPropertyValue("color");
		const {bold: markerBold, dim: markerDim} = resolveFontWeight(
			markerStyle.getPropertyValue("font-weight"),
		);
		const markerItalic =
			markerStyle.getPropertyValue("font-style") === "italic";
		const markerUnderline = hasUnderline(markerStyle);

		const markerTextStyle = {
			fg:
				markerColor && markerColor !== "initial"
					? cssColorToNumber(markerColor)
					: undefined,
			bold: markerBold,
			dim: markerDim,
			italic: markerItalic,
			underline: markerUnderline,
		};

		// Position marker just before the list item's content area (outside positioning)
		const markerX = Math.max(0, Math.round(rect.left) - markerWidth);
		const markerY = Math.round(rect.top);

		// Render the marker (clipped to available space, never mutate the DOM)
		ctx.setText(markerX, markerY, markerContent, markerTextStyle);
	}

	/**
	 * Build (or rebuild, when the type flips between text-ish and toggle)
	 * an input's UA-internal shadow tree: real DOM in the symbol slot,
	 * closed to authors -- element.shadowRoot stays null and attachShadow
	 * still throws, exactly as for a browser input's own internals. The
	 * field tree carries a real <style> scoped to its root; parts are
	 * addressed by the standard `part` attribute, which is what gives
	 * ::placeholder a real element to resolve onto.
	 */
	#renderInputElement(
		element: HTMLInputElement,
		rect: DOMRect,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const boxModel = getBoxModel(element);
		const contentX =
			Math.round(rect.left) +
			(boxModel.borderLeftWidth || 0) +
			(boxModel.paddingLeft || 0);
		const contentY =
			Math.round(rect.top) +
			(boxModel.borderTopWidth || 0) +
			(boxModel.paddingTop || 0);
		const contentWidth =
			Math.round(rect.width) -
			(boxModel.borderLeftWidth || 0) -
			(boxModel.borderRightWidth || 0) -
			(boxModel.paddingLeft || 0) -
			(boxModel.paddingRight || 0);

		const parts = this.#host.ensureInputShadowParts(element);

		if (parts.kind === "toggle") {
			const mark =
				element.type === "checkbox"
					? element.checked
						? "[x]"
						: "[ ]"
					: element.checked
						? "(x)"
						: "( )";
			// The glyph is real DOM; its style (the focus underline included,
			// inherited from the input's own focus-aware default) reads back
			// off the tree.
			if (parts.texts.glyph.data !== mark) {
				parts.texts.glyph.data = mark;
			}
			ctx.setText(
				contentX,
				contentY,
				mark,
				cellStyleFromComputed(this.#window.getComputedStyle(parts.spans.glyph)),
			);
			if (element === this.#document.activeElement) {
				ctx.setCaret(contentX, contentY);
			}
			return;
		}

		const value = element.value || "";
		const placeholder = element.getAttribute("placeholder") || "";
		const isFocused = element === this.#document.activeElement;

		this.#host.syncInputShadowTree(element, parts);

		// Region styles come off the tree: the value inherits the input's
		// own text style (solid underline when focused), the placeholder and
		// the blank carry the UA field sheet -- gray ghost label, faint
		// blank when blurred -- plus whatever the author adds.
		const textStyle = cellStyleFromComputed(
			this.#window.getComputedStyle(
				value ? parts.spans.value : parts.spans.placeholder,
			),
		);
		const blankStyle = cellStyleFromComputed(
			this.#window.getComputedStyle(parts.spans.blank),
		);

		// Shown focused or not, as in a browser -- the caret just sits at
		// the field start, over the dimmed text.
		const displayText = value || placeholder;

		// Everything below measures in CELLS, not characters. CJK text is two
		// cells per glyph, so character arithmetic put the caret mid-text (IME
		// composition then anchored on top of already-typed glyphs) and padEnd
		// by character count pushed the value's background straight through the
		// input's right border.
		let scrollOffset = this.#host.inputScrollOffsets.get(element) ?? 0;
		// The caret is the input's own selection (selectionStart/End), so a
		// framework assigning .value can never strand it: per spec, setting
		// value collapses the selection to the end. The caret sits at the
		// selection's FOCUS -- the moving end, per selectionDirection -- which
		// is the end that must stay scrolled into view while extending.
		const selStart = element.selectionStart ?? value.length;
		const selEnd = element.selectionEnd ?? value.length;
		const cursor =
			element.selectionDirection === "backward" ? selStart : selEnd;

		if (isFocused) {
			// Keep the caret's CELL offset inside the box.
			if (cursor < scrollOffset) {
				scrollOffset = cursor;
			}
			while (
				scrollOffset < cursor &&
				stringWidth(displayText.slice(scrollOffset, cursor)) >= contentWidth
			) {
				scrollOffset++;
			}
			// And scroll BACK when there's slack: after deleting at the end of
			// an overflowed value, the window would otherwise stay put and show
			// a shrinking tail with the earlier text still hidden off the left
			// edge. Pull the window left while everything from one character
			// earlier through the end still fits strictly inside the field
			// (strictly: the caret needs its cell when it sits at the end),
			// exactly what a browser's field does on backspace.
			while (
				scrollOffset > 0 &&
				stringWidth(displayText.slice(scrollOffset - 1)) < contentWidth
			) {
				scrollOffset--;
			}
			this.#host.inputScrollOffsets.set(element, scrollOffset);
		}

		// Take characters from the scroll offset until the next one would no
		// longer fit, then pad with spaces to exactly the content width in cells.
		let visibleText = "";
		let usedCells = 0;
		for (const char of displayText.slice(scrollOffset)) {
			const charCells = stringWidth(char);
			if (usedCells + charCells > contentWidth) break;
			visibleText += char;
			usedCells += charCells;
		}
		const visibleChars = visibleText.length;
		visibleText += " ".repeat(Math.max(0, contentWidth - usedCells));

		// The content region paints with its part's style, and the cells the
		// content spares are the BLANK part -- which the UA sheet renders as
		// the faint underlined blank when blurred, and which inherits the
		// solid focus underline like everything else when focused.
		if (displayText) {
			ctx.setText(
				contentX,
				contentY,
				visibleText.slice(0, visibleChars),
				textStyle,
			);
			ctx.setText(
				contentX + usedCells,
				contentY,
				visibleText.slice(visibleChars),
				blankStyle,
			);
		} else {
			ctx.setText(contentX, contentY, visibleText, blankStyle);
		}

		// A selection paints as inverse video over its visible slice --
		// terminal-native highlight, no color assumptions. (Placeholder text
		// can never be selected: it only shows for an empty value, whose
		// selection is necessarily collapsed.)
		if (isFocused && selEnd > selStart) {
			const visStart = Math.max(selStart, scrollOffset);
			const visEnd = Math.min(selEnd, scrollOffset + visibleChars);
			if (visEnd > visStart) {
				ctx.setText(
					contentX + stringWidth(displayText.slice(scrollOffset, visStart)),
					contentY,
					displayText.slice(visStart, visEnd),
					selectionStyleFor(this.#window, element, textStyle),
				);
			}
		}

		// The caret of a focused input is the REAL terminal cursor, parked there
		// by the frame -- not an inverse-video imitation. IME composition, screen
		// readers and the terminal's own cursor style all anchor to the real one.
		if (isFocused) {
			const cursorX =
				contentX + stringWidth(displayText.slice(scrollOffset, cursor));
			if (cursorX >= contentX && cursorX < contentX + contentWidth) {
				ctx.setCaret(cursorX, contentY);
			}
		}
	}

	/**
	 * Render a text node with proper styling from its parent element or pseudo-element
	 */
	#renderText(textNode: Text, ctx: import("./ansi.js").DrawingContext): void {
		const textContent = textNode.data;
		if (!textContent) return;

		// Check if this is a pseudo-element node
		const pseudoMetadata = getPseudoMetadata(textNode);

		// For pseudo elements, we don't have a parentElement, but we have
		// hostElement. Everything else styles from the FLAT-tree parent:
		// slotted bare text draws its inherited styles through the slot's
		// shadow chain, not from the host it came from.
		const parentElement = pseudoMetadata
			? pseudoMetadata.hostElement
			: compositionParentElement(textNode);
		if (!parentElement) return;

		let computedStyle: CSSStyleDeclaration;

		if (pseudoMetadata) {
			// For pseudo-elements, get the computed style with the pseudo-element selector
			computedStyle = this.#window.getComputedStyle(
				pseudoMetadata.hostElement,
				pseudoMetadata.pseudoType,
			);
		} else {
			// For regular text nodes, use the parent element's style
			computedStyle = this.#window.getComputedStyle(parentElement);
		}

		// visibility inherits, so the parent's own resolved value already accounts
		// for a closer ancestor overriding back to visible.
		if (computedStyle.getPropertyValue("visibility") === "hidden") return;

		const textTransform = computedStyle.getPropertyValue("text-transform");
		const textStyle = cellStyleFromComputed(computedStyle);

		const rectTexts = this.#host.layoutEngine.getRectTexts(textNode);
		if (rectTexts.length > 0) {
			for (const rectText of rectTexts) {
				if (rectText.text.length > 0) {
					ctx.setText(
						Math.round(rectText.rect.x),
						Math.round(rectText.rect.y),
						applyTextTransform(rectText.text, textTransform),
						textStyle,
					);
				}
			}
			this.#renderTextSelection(
				textNode,
				rectTexts,
				textStyle,
				textTransform,
				ctx,
			);
		}
	}

	/**
	 * Overlay the document selection on a text node's painted fragments as
	 * inverse video -- the terminal-native highlight, no color assumptions.
	 * The Range holds code-unit offsets into node.data; visualToDataOffsets
	 * bridges each painted character back to its data offset, and contiguous
	 * selected runs repaint inverse. Ranges whose boundary containers are
	 * elements rather than text nodes still highlight any text node they
	 * fully contain (the intersectsNode walk); a boundary that lands INSIDE
	 * this node only resolves to a precise offset when the container is the
	 * node itself -- the only shape our own drag selection produces.
	 */
	#renderTextSelection(
		textNode: Text,
		rectTexts: Array<import("./layout.js").RectText>,
		textStyle: import("./ansi.js").CellStyle,
		textTransform: string,
		ctx: import("./ansi.js").DrawingContext,
	): void {
		const selection = this.#window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			return;
		}
		const range = selection.getRangeAt(0);
		if (!range.intersectsNode(textNode)) return;

		const from = range.startContainer === textNode ? range.startOffset : 0;
		const to =
			range.endContainer === textNode ? range.endOffset : textNode.data.length;
		if (to <= from) return;

		const selectionParent =
			getPseudoMetadata(textNode)?.hostElement ??
			compositionParentElement(textNode);
		if (!selectionParent) return;
		const selectionStyle = selectionStyleFor(
			this.#window,
			selectionParent,
			textStyle,
		);
		if (selectionStyle === textStyle) return; // no ::selection rule reaches here

		const visToData = visualToDataOffsets(textNode.data, rectTexts);
		let visualBase = 0;
		for (const rectText of rectTexts) {
			// Contiguous run of selected visual chars within this fragment.
			let runStart = -1;
			for (let i = 0; i <= rectText.text.length; i++) {
				const dataOffset =
					i < rectText.text.length ? visToData[visualBase + i] : -1;
				const selected =
					dataOffset >= 0 && dataOffset >= from && dataOffset < to;
				if (selected && runStart === -1) {
					runStart = i;
				} else if (!selected && runStart !== -1) {
					// Case transforms never change cell width, so slicing the
					// untransformed text and transforming the slice paints the
					// same cells the base pass did.
					ctx.setText(
						Math.round(rectText.rect.x) +
							stringWidth(rectText.text.slice(0, runStart)),
						Math.round(rectText.rect.y),
						applyTextTransform(rectText.text.slice(runStart, i), textTransform),
						selectionStyle,
					);
					runStart = -1;
				}
			}
			visualBase += rectText.text.length;
		}
	}
}

export class TermDOM {
	readonly document: Document;
	readonly window: DOMWindow;

	#renderer: Renderer;
	[kLayoutEngine]: LayoutEngine;
	// TODO: Should we expose the JSDOM instance?
	#jsdom: JSDOM;
	[kObserver]: MutationObserver;
	#fullscreenManager: FullscreenManager;
	#observerManager: ObserverManager;
	#styleManager: StyleManager;
	#painter: Painter;
	/** Outside list markers already painted this frame; reset each frame. */
	#renderedOutsideMarkers = new WeakSet<Element>();
	// The command-start anchor: the row the document starts on. The document
	// CAMERA (scrollY/pageYOffset/scrollTop) is a separate value owned by
	// installWindowExtensions. #anchorScrollTop is always -#screenTop once set,
	// and survives only for fullscreen hit-testing, whose formula predates the
	// camera and is algebraically equivalent.
	#screenTop = 0;
	#anchorScrollTop = 0;

	// Guard against re-entrant rendering. A render() call arriving while one is in
	// flight sets renderQueued rather than being dropped, so a trailing frame runs.
	#isRendering = false;
	// Callbacks registered via window.requestAnimationFrame, fired once the frame
	// that includes their pending mutations has actually been written. Keyed
	// by the handle requestAnimationFrame returned, so cancelAnimationFrame
	// can actually cancel.
	#frameCallbacks = new Map<number, FrameRequestCallback>();
	#nextRafId = 1;
	// One updater per live MediaQueryList: re-evaluates its query and fires
	// "change" if the answer flipped. Run by #handleResize -- SIGWINCH is
	// this screen's window resize.
	#mediaQueryUpdaters = new Set<() => void>();
	// document.close() sealed the current document into scrollback; the next
	// mutation starts a fresh document below it.
	#sealed = false;
	#renderQueued = false;
	#screenSwitching = false;
	#renderInFlight: Promise<void> | null = null;

	// Monotonic frame counter, used to timestamp observer entries.
	#renderCount = 0;

	// Input element state tracking. Only the horizontal scroll of an
	// overflowed field lives here -- pure presentation, invisible to the DOM.
	// The caret does NOT: it is the input's own selectionStart/End/Direction,
	// the standard API.
	#inputScrollOffsets = new WeakMap<Element, number>();
	// The UA-internal shadow trees behind input widgets, by host: the tree
	// IS the field's content model (value text, placeholder, blank / toggle
	// glyph), and the painter reads its computed styles instead of
	// hardcoding the design. This map just caches the part references.
	// The column (in cells) a run of consecutive ArrowUp/ArrowDown presses
	// aims for -- browsers remember where vertical travel STARTED, so
	// passing through a short line and continuing returns to the original
	// column. Cleared by any other editing action.
	#textareaGoalColumn = new WeakMap<Element, number>();
	/**
	 * The TOP LAYER: elements painted above every stacking context, in
	 * insertion order, unclipped -- the foundation dialog/popover/::picker
	 * share. Members are excluded from normal stacking collection.
	 */
	#topLayer = new Set<Element>();
	#inputShadowParts = new WeakMap<
		Element,
		{
			kind: "field" | "toggle" | "textarea" | "select";
			spans: Record<string, HTMLElement>;
			texts: Record<string, Text>;
		}
	>();

	// Track whether command start was explicitly detected (even if at row 1)
	#hasDetectedCommandStart: boolean = false;

	// Unified stdin handling
	#cursorDetectionHandler: ((data: string) => void) | null = null;

	/**
	 * Outstanding DECRQM queries, keyed by the mode as it appears in the reply
	 * ("8", "?2027"). Two negotiations run concurrently at startup and their
	 * answers can arrive in either order, so they are matched by mode number
	 * rather than by whoever asked last.
	 */
	#modeProbeHandlers = new Map<string, (value: number) => void>();
	#modeProbeTimers = new Set<ReturnType<typeof setTimeout>>();
	/** The BDSM state the terminal reported before we touched it, for dispose. */
	#priorBidiMode: number | null = null;
	/** Whether the terminal agreed to grapheme-cluster widths (mode 2027). */
	#graphemeClustersNegotiated = false;

	// Handles and timers that must be torn down in dispose(), or they keep the
	// process alive after the app is done -- which, across a test suite, piles up
	// into a hang.
	#sigintHandler: (() => void) | null = null;
	#sigwinchHandler: (() => void) | null = null;
	#stdinDataHandler: ((chunk: string | Buffer) => void) | null = null;
	#cursorDetectionTimer: ReturnType<typeof setTimeout> | null = null;
	#resizeTimer: ReturnType<typeof setTimeout> | null = null;
	// True from the first SIGWINCH of a resize until the re-anchored redraw. While
	// set, render() bails: the terminal has rewrapped the screen and our anchor is
	// momentarily stale, so an auto-render (an animation tick) painting now lands
	// at the wrong rows and scrolls a stray copy into the scrollback. Only the
	// final redraw that handleResize issues is allowed through.
	#resizeInProgress = false;
	// Whether we have taken hold of the terminal: raw mode, signal handlers,
	// the stdin listener and the cursor query. Construction never touches the
	// process -- attach() does, lazily on the first render or explicitly.
	#attached = false;
	// Bumped on every SIGWINCH. The re-anchor waits on an async cursor query;
	// if another resize lands while it is in flight, the stale response must not
	// trigger a redraw at coordinates that no longer mean anything.
	#resizeEpoch = 0;

	// Promise that resolves when cursor detection completes (or times out)
	#cursorDetectionPromise: Promise<void> | null = null;

	#width: number;
	#height: number;
	/** Which document row sits at the top of the camera. */
	#documentScrollTop = 0;

	// Whether the terminal is currently reporting mouse events to us. See
	// updateMouseReporting for when capture is on.
	#mouseReportingEnabled = false;
	// Scroll chaining yielded the mouse back to the terminal: the camera hit
	// the document top and the user kept scrolling up, so the wheel now
	// belongs to the terminal's own scrollback. Cleared by the next keystroke
	// -- terminals snap to the live screen on input, which is exactly the
	// moment the wheel should become ours again -- or, failing that, by
	// #SCROLL_CHAIN_TIMEOUT_MS of silence (see #scrollChainTimer).
	#mouseCaptureYielded = false;
	// Self-heals a yield that a keystroke never reclaims: while yielded, wheel
	// activity produces literally no signal (that's the entire mechanism --
	// the terminal is handling it, not us), so there's no way to reset this on
	// continued scrolling the way a real debounce would. It's a flat window
	// from the moment of yielding, not "N ms since the last wheel tick" --
	// which is exactly why this can't be too short: a real wheel/trackpad
	// doesn't tick perfectly continuously, and any gap between ticks longer
	// than this window re-enables capture mid-scroll, which the very next
	// tick immediately re-yields -- a disable/enable toggle on every gap for
	// as long as the user keeps scrolling, not just a one-time early
	// re-enable. Tried 1000ms live; it was short enough to hit that toggle
	// and felt like lag. 3000ms tested flawless.
	static readonly #SCROLL_CHAIN_TIMEOUT_MS = 3000;
	#scrollChainTimer: ReturnType<typeof setTimeout> | null = null;
	// Where the last mousedown landed, so a mouseup on the same element
	// becomes a click. (Browsers dispatch click at the nearest common
	// ancestor; the same-element case is the one that matters on a cell grid.)
	#mouseDownTarget: Element | null = null;
	// Where a left-button drag started selecting text, as a caret position --
	// the selection's anchor. The focus end follows the drag; both feed
	// Selection.setBaseAndExtent, which handles backward drags itself.
	#selectionDragAnchor: {node: Text; offset: number} | null = null;
	// The field whose caret the NEXT frame must reveal -- set by edits,
	// consumed inside #renderInteractive after its layout flush. Last
	// edit before the frame wins.
	#pendingCaretReveal:
		| HTMLInputElement
		| HTMLTextAreaElement
		| HTMLSelectElement
		| null = null;
	// A drag that started inside a text field extends the FIELD's own
	// selection (selectionStart/End, bounded to the field) rather than the
	// document selection -- the browser's exact split. The anchor is a
	// value offset; the focus end follows the pointer, clamped into the
	// field.
	#fieldDragAnchor: {
		element: HTMLInputElement | HTMLTextAreaElement;
		offset: number;
	} | null = null;
	// The target and time of the last completed click, to detect a second one
	// close enough behind it to be a dblclick -- browsers' own double-click
	// interval varies by OS/user setting; 500ms is the common default.
	static readonly #DBLCLICK_INTERVAL_MS = 500;
	#lastClickTarget: Element | null = null;
	#lastClickTime = 0;
	#process: ProcessLike;

	#detectCursorEnabled: boolean;

	// A stdout that is not a terminal -- a pipe, a file, a CI log -- has no
	// viewport, no cursor, no scrollback and no resize. It cannot interpret cursor
	// movement either, so the interactive frame would write CUP and DECSC sequences
	// straight into the file.
	#interactive: boolean;

	constructor(options: TermDOMOptions = {}) {
		this.#process = options.process || process;
		this.#interactive = this.#process.stdout.isTTY !== false;
		this.#detectCursorEnabled =
			(options.detectCursor ?? this.#process === process) && this.#interactive;

		this.#width = options.width || this.#process.stdout.columns || 80;
		this.#height = options.height || this.#process.stdout.rows || 24;

		this.#jsdom = new JSDOM(
			"<!DOCTYPE html><html><head></head><body></body></html>",
			{pretendToBeVisual: true},
		);

		this.window = this.#jsdom.window;
		this.document = this.#jsdom.window.document;

		// Setup DOM inspector
		setupInspectMethods(this.window);

		// One bag of getters and callbacks, shared by everything that patches
		// the window below. Built here, before the fields it exposes exist:
		// nothing reads through it until a patched API is actually called.
		const host = this.#createDOMPatchHost();
		this.#painter = new Painter(this.window, this.#createPaintHost());

		installConstructorExtensions(this.window, host);
		this.#renderer = new Renderer(
			this.#height,
			this.#width,
			options.colorDepth || detectColorDepth(this.#process),
		);

		// Setup style management FIRST to override getComputedStyle before LayoutEngine uses it
		this.#styleManager = new StyleManager(this.window);

		// Create layout engine after StyleManager overrides getComputedStyle
		this[kLayoutEngine] = new LayoutEngine(this.#jsdom.window);
		this.#styleManager.setLayoutEngine(this[kLayoutEngine]);
		this[kLayoutEngine].resize(this.#width, this.#height);
		this.#fullscreenManager = new FullscreenManager(this.#process);
		this.#observerManager = new ObserverManager(
			createObserverHost(this.window, host),
		);

		installWindowExtensions(this.window, host);
		this.#installObservers();

		// Initialize scrolling management after window setup

		this[kObserver] = this.#setupMutationObserver();

		// Initial processing of all elements is handled by StyleManager's constructor
	}

	/**
	 * The seam between this instance and the jsdom patches installed over its
	 * window: see DOMPatchHost for why every member is a getter or a callback
	 * rather than a value.
	 */
	#createPaintHost(): PaintHost {
		const termDOM = this;
		return {
			get layoutEngine() {
				return termDOM[kLayoutEngine];
			},
			get styleManager() {
				return termDOM.#styleManager;
			},
			get documentScrollTop() {
				return termDOM.#documentScrollTop;
			},
			get topLayer() {
				return termDOM.#topLayer;
			},
			get renderedOutsideMarkers() {
				return termDOM.#renderedOutsideMarkers;
			},
			get inputScrollOffsets() {
				return termDOM.#inputScrollOffsets;
			},
			ensureInputShadowParts: (element) =>
				termDOM.#ensureInputShadowParts(element),
			ensureTextareaShadowParts: (element) =>
				termDOM.#ensureTextareaShadowParts(element),
			ensureSelectShadowParts: (element) =>
				termDOM.#ensureSelectShadowParts(element),
			syncInputShadowTree: (element, parts) =>
				termDOM.#syncInputShadowTree(element, parts),
			syncSelectShadowTree: (element, parts) =>
				termDOM.#syncSelectShadowTree(element, parts),
		};
	}

	#createDOMPatchHost(): DOMPatchHost {
		const termDOM = this;
		return {
			get width() {
				return termDOM.#width;
			},
			get height() {
				return termDOM.#height;
			},
			get layoutEngine() {
				return termDOM[kLayoutEngine];
			},
			get observer() {
				return termDOM[kObserver];
			},
			get styleManager() {
				return termDOM.#styleManager;
			},
			get fullscreenManager() {
				return termDOM.#fullscreenManager;
			},
			get renderer() {
				return termDOM.#renderer;
			},
			get screenTop() {
				return termDOM.#screenTop;
			},
			get scrollTop() {
				return termDOM.#documentScrollTop;
			},
			set scrollTop(value: number) {
				termDOM.#documentScrollTop = value;
			},
			get screenSwitching() {
				return termDOM.#screenSwitching;
			},
			set screenSwitching(value: boolean) {
				termDOM.#screenSwitching = value;
			},
			get renderInFlight() {
				return termDOM.#renderInFlight;
			},
			get attached() {
				return termDOM.#attached;
			},
			get renderCount() {
				return termDOM.#renderCount;
			},
			get frameCallbacks() {
				return termDOM.#frameCallbacks;
			},
			get mediaQueryUpdaters() {
				return termDOM.#mediaQueryUpdaters;
			},
			allocateFrameHandle: () => termDOM.#nextRafId++,
			mediaQueryMatches: (query) =>
				termDOM.#styleManager.mediaQueryMatches(query),
			render: () => termDOM.#render(),
			flushPendingMutations: () => {
				termDOM.#processPendingMutationsAndRender();
			},
			scrollCamera: (rows) => termDOM.#scrollCamera(rows),
			updateMouseReporting: () => termDOM.#updateMouseReporting(),
			elementAtDocumentPoint: (x, y) =>
				termDOM.#findElementAtDocumentPoint(x, y),
			sealToScrollback: () => {
				termDOM.#flushDocument();
				termDOM.#sealed = true;
			},
		};
	}

	/**
	 * Apply a batch of mutation records to everything that isn't painting:
	 * pseudo-elements/caches, the layout tree, and the autofocus default
	 * action. In the same order everywhere it's called, since mutations reach
	 * this from two different places -- the observer's own async callback
	 * below, and #processPendingMutationsAndRender/#renderStatic/
	 * #renderInteractive's synchronous `takeRecords()` drain (a geometry read
	 * or a scheduled render needs fresh layout NOW, not whenever the next
	 * microtask checkpoint happens to land) -- and whichever one runs first
	 * empties the queue for the other.
	 */
	#handlePendingMutations(mutations: MutationRecord[]): void {
		// Attribute records whose value did not actually change are dropped
		// before any handler sees them. Frameworks (and this repo's own
		// examples) re-assign className/style with identical values on every
		// update; per spec each assignment fires a record, and a class
		// record rebuilds the whole layout tree from body -- the difference
		// between a keystroke costing a counter re-measure and costing the
		// document. A->B->A inside one unpainted batch also nets out: the
		// intermediate value never rendered, so skipping is correct, and a
		// same-batch pair still processes via the B->A record.
		const relevant = mutations.filter((record) => {
			if (record.type !== "attributes" || !record.attributeName) return true;
			const target = record.target as Element;
			return record.oldValue !== target.getAttribute(record.attributeName);
		});
		if (relevant.length === 0) return;
		this.#styleManager.handleMutations(relevant);
		this[kLayoutEngine].handleMutations(relevant);
		focusAutofocusedNodes(relevant);
	}

	#setupMutationObserver(): MutationObserver {
		const observer = new this.window.MutationObserver((mutations) => {
			this.#handlePendingMutations(mutations);
			this.#render();
		});

		observer.observe(this.document.documentElement, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeOldValue: true,
			characterData: true,
		});

		return observer;
	}

	/**
	 * Take hold of the terminal: raw mode, signal handlers, the stdin listener,
	 * the cursor-position query, and the exit hook that restores the cursor.
	 *
	 * Construction is inert -- a constructor has no business writing escape
	 * sequences to stdout or flipping stdin into raw mode. Attachment happens
	 * here, invoked lazily by the first render (so the zero-config path still
	 * just works) or explicitly by callers that want to control the moment the
	 * terminal changes hands. Idempotent; dispose() reverses it.
	 */
	attach(): void {
		if (this.#attached) return;
		this.#attached = true;

		this.#setupProcessHandlers();
		this.#updateMouseReporting();
		this.#initializeCursorDetection();
		void this.#negotiateBidi();
		void this.#negotiateGraphemeClusters();

		// See installCursorRestoreOnExit: if this instance dies without
		// dispose(), the exit hook hands the user their cursor back.
		if (this.#interactive && this.#process === process) {
			undisposedInteractive.add(this.#process);
			installCursorRestoreOnExit();
		}
	}

	/**
	 * The mouse is captured exactly when the document owns the camera: document
	 * mode and fullscreen, where wheel-to-scroll is the default action, the same
	 * as a browser. Flow mode leaves the mouse native -- there the terminal owns
	 * scrolling (that is the mode's point), and capture would take the user's
	 * scrollback and selection in exchange for nothing.
	 *
	 * Idempotent; call it whenever attachment, viewport mode, or fullscreen
	 * changes.
	 */
	#updateMouseReporting(): void {
		const wanted =
			this.#attached &&
			this.#interactive &&
			Boolean(this.#process.stdin?.isTTY) &&
			!this.#mouseCaptureYielded;
		if (wanted === this.#mouseReportingEnabled) return;
		this.#mouseReportingEnabled = wanted;
		// 1002: button presses, releases, wheel, and drag motion (no move flood
		// while nothing is pressed). 1006: SGR encoding, the only one that is
		// unambiguous past column 223.
		this.#process.stdout.write(
			wanted ? "\x1b[?1002h\x1b[?1006h" : "\x1b[?1006l\x1b[?1002l",
		);
	}

	/**
	 * End a scroll-chaining yield, from whichever of the two triggers reaches
	 * it first -- a keystroke (the common case) or the fallback timer (see
	 * #scrollChainTimer). Both need the same cleanup, so this is the one place
	 * that does it: clear the pending timer (the other trigger firing later
	 * would be a harmless no-op via #updateMouseReporting's own idempotence,
	 * but there is no reason to let it) and restore mouse capture.
	 */
	#reclaimMouseCapture(): void {
		if (this.#scrollChainTimer !== null) {
			clearTimeout(this.#scrollChainTimer);
			this.#scrollChainTimer = null;
		}
		this.#mouseCaptureYielded = false;
		this.#updateMouseReporting();
	}

	// TODO: This should be put in an event translator abstraction
	#setupProcessHandlers(): void {
		this.#sigintHandler = () => {
			this.dispose();
			this.#process.exit(0);
		};
		this.#process.on("SIGINT", this.#sigintHandler);

		this.#sigwinchHandler = () => this.#scheduleResize();
		this.#process.on("SIGWINCH", this.#sigwinchHandler);

		if (this.#process.stdin?.isTTY) {
			const stdin = this.#process.stdin;
			if (!stdin) return;

			// Configure terminal for proper input handling (once)
			stdin.setRawMode?.(true);
			stdin.resume();
			stdin.setEncoding?.("utf8");

			// Single unified handler for all stdin data
			this.#stdinDataHandler = (chunk: string | Buffer) => {
				// Ensure we have both string and buffer representations
				const data = Buffer.isBuffer(chunk)
					? chunk
					: Buffer.from(chunk, "utf8");
				const dataStr = data.toString("utf8");

				// Route 1: Cursor position responses (highest priority). Fast typing
				// can land in the same chunk as the report -- "jjj\x1b[12;1Rjjj" --
				// so hand the report to the waiting query and let the rest continue
				// through the normal routes as keystrokes.
				// Route 0: the terminal's answer about BDSM (DECRPM). Same
				// splicing as the cursor report below -- it is a reply, never a
				// keystroke, and it can share a chunk with real typing.
				const modeReport = dataStr.match(/\x1b\[(\??)(\d+);(\d+)\$y/);
				if (modeReport) {
					const mode = (modeReport[1] ? "?" : "") + modeReport[2];
					const waiting = this.#modeProbeHandlers.get(mode);
					if (waiting) {
						this.#modeProbeHandlers.delete(mode);
						waiting(parseInt(modeReport[3], 10));
						const rest =
							dataStr.slice(0, modeReport.index) +
							dataStr.slice((modeReport.index ?? 0) + modeReport[0].length);
						if (rest.length === 0) return;
						if (this.#stdinDataHandler) this.#stdinDataHandler(rest);
						return;
					}
				}

				const report = dataStr.match(/\x1b\[\d+;\d+R/);
				if (this.#cursorDetectionHandler && report) {
					this.#cursorDetectionHandler(report[0]);
					const rest =
						dataStr.slice(0, report.index) +
						dataStr.slice((report.index ?? 0) + report[0].length);
					if (rest.length === 0) return;
					if (this.#stdinDataHandler) {
						this.#stdinDataHandler(rest);
					}
					return;
				}

				// Route 2: Ctrl-C handling (high priority) - check raw bytes
				if (data.length > 0 && data[0] === 0x03) {
					this.dispose();
					return this.#process.exit(0);
				}

				// Route 3: SGR mouse reports. Peeled off token by token so a report
				// glued to fast keystrokes ("jj\x1b[<65;4;7Mjj") eats neither side,
				// and BEFORE the fullscreen filter below -- fullscreen is a
				// mouse-capturing mode, so its reports must not be dropped with the
				// keyboard events.
				let keyInput = "";
				for (const token of this.#tokenizeInput(dataStr)) {
					const mouse = token.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
					if (mouse) {
						this.#handleMouseReport(
							parseInt(mouse[1]),
							parseInt(mouse[2]),
							parseInt(mouse[3]),
							mouse[4] === "m",
						);
					} else {
						keyInput += token;
					}
				}
				if (keyInput.length === 0) return;

				// A keystroke means the user is back at the live screen (terminals
				// snap to the bottom on input): reclaim the mouse if scroll
				// chaining yielded it.
				if (this.#mouseCaptureYielded) {
					this.#reclaimMouseCapture();
				}

				// Route 4: General keyboard events -- ONE pipeline, fullscreen
				// included. A separate fullscreen listener would drift from this
				// one: the tokenization for batched input, the SGR-mouse-report
				// filtering (a report misreads as literal keyboard text without
				// it) and the modifier decoding all live here.
				// #dispatchGlobalKeyboardEvent handles Escape exiting
				// fullscreen (see below).
				this.#dispatchGlobalKeyboardEvent(Buffer.from(keyInput));
			};
			stdin.on("data", this.#stdinDataHandler);
		}
	}

	async #render(): Promise<void> {
		this.attach();

		// A resize is settling: suppress every render until handleResize issues the
		// single re-anchored redraw. See resizeInProgress.
		if (this.#resizeInProgress) {
			return;
		}

		// A screen switch (fullscreen enter/exit) is in progress: no frame
		// may straddle it -- a frame computed for one screen landing on the
		// other paints the wrong geometry onto the wrong buffer.
		if (this.#screenSwitching) {
			return;
		}

		// A render in flight: coalesce, don't drop. Dropping an auto-render (a
		// mutation observer firing mid-frame) leaves the diff renderer's
		// previous-buffer out of step with the screen, which shows up as rows drawn
		// at the wrong place. Instead mark one pending and hand back the running
		// loop's promise: it will fold this caller's changes into a trailing frame,
		// so awaiting render() always means "what I changed is painted".
		if (this.#isRendering) {
			this.#renderQueued = true;
			return this.#renderInFlight ?? Promise.resolve();
		}

		this.#isRendering = true;
		this.#renderInFlight = (async () => {
			try {
				do {
					this.#renderQueued = false;
					await this.#renderOnce();
				} while (this.#renderQueued);
				// The frame(s) are written; wake anything awaiting requestAnimationFrame.
				this.#drainFrameCallbacks();
			} finally {
				this.#isRendering = false;
				this.#renderInFlight = null;
			}
		})();
		return this.#renderInFlight;
	}

	#drainFrameCallbacks(): void {
		if (this.#frameCallbacks.size === 0) return;
		const callbacks = [...this.#frameCallbacks.values()];
		this.#frameCallbacks.clear();
		const now = performance.now();
		for (const cb of callbacks) cb(now);
	}

	async #renderOnce(): Promise<void> {
		if (!this.#interactive) {
			await this.#renderStatic();
			return;
		}

		await this.#renderInteractive();
	}

	// TODO: many of the following methods do not belong on the TermDOM class
	#ensureInputShadowParts(element: HTMLInputElement): {
		kind: "field" | "toggle" | "textarea" | "select";
		spans: Record<string, HTMLElement>;
		texts: Record<string, Text>;
	} {
		const kind =
			element.type === "checkbox" || element.type === "radio"
				? ("toggle" as const)
				: ("field" as const);
		const cached = this.#inputShadowParts.get(element);
		if (cached && cached.kind === kind) {
			return cached;
		}

		const document = this.document;
		const root = createUAShadowRoot(element);
		while (root.firstChild) {
			root.removeChild(root.firstChild);
		}
		const spans: Record<string, HTMLElement> = {};
		const texts: Record<string, Text> = {};
		const addPart = (part: string) => {
			const span = document.createElement("span");
			span.setAttribute("part", part);
			const text = document.createTextNode("");
			span.appendChild(text);
			root.appendChild(span);
			spans[part] = span;
			texts[part] = text;
		};
		if (kind === "field") {
			const style = document.createElement("style");
			style.textContent = FIELD_UA_STYLES;
			root.appendChild(style);
			addPart("value");
			addPart("placeholder");
			addPart("blank");
		} else {
			addPart("glyph");
		}

		// Scope the UA rules to this root. The root is deliberately NOT
		// observer-enrolled: the painter syncs the tree from the input's own
		// state right before reading it, so a mutation record could only
		// ever schedule a redundant frame. The MEASURE, though, must hear
		// about the tree once -- a width:auto input sizes to its composed
		// content, and nothing else will ever invalidate it.
		this.#styleManager.registerShadowRoot(root);
		this[kLayoutEngine].invalidate(element);
		void this.#render();
		const parts = {kind, spans, texts};
		this.#inputShadowParts.set(element, parts);
		return parts;
	}

	/**
	 * Build a textarea's UA-internal shadow tree. Unlike the input's, this
	 * root IS observer-enrolled -- enrolled BEFORE it is populated, so the
	 * population itself is the invalidation that swaps the composed tree in
	 * -- because the value text lays out through the normal pipeline and
	 * layout must hear about every change to it. The sync controller runs
	 * at edit time (and as a paint-time safety net for framework .value
	 * assignments), never in a loop: it only ever writes when the input's
	 * state and the tree disagree.
	 */
	#ensureTextareaShadowParts(element: HTMLTextAreaElement): {
		kind: "field" | "toggle" | "textarea" | "select";
		spans: Record<string, HTMLElement>;
		texts: Record<string, Text>;
	} {
		const cached = this.#inputShadowParts.get(element);
		if (cached && cached.kind === "textarea") {
			return cached;
		}

		const document = this.document;
		const root = createUAShadowRoot(element);
		this[kObserver].observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeOldValue: true,
			characterData: true,
		});
		this.#styleManager.registerShadowRoot(root);

		const spans: Record<string, HTMLElement> = {};
		const texts: Record<string, Text> = {};
		const style = document.createElement("style");
		style.textContent = TEXTAREA_UA_STYLES;
		root.appendChild(style);
		for (const part of ["value", "placeholder"]) {
			const span = document.createElement("span");
			span.setAttribute("part", part);
			const text = document.createTextNode("");
			span.appendChild(text);
			root.appendChild(span);
			spans[part] = span;
			texts[part] = text;
		}
		// The trailing <br> anchor, the same trick a browser's editor uses:
		// it makes the run's content always end in exactly one line break,
		// so the line count equals the LOGICAL line count -- the breaker
		// never emits a line after a final newline, and without the anchor a
		// value ending in "\n" measured one row short, parking the caret on
		// the bottom border.
		root.appendChild(document.createElement("br"));

		const parts = {kind: "textarea" as const, spans, texts};
		this.#inputShadowParts.set(element, parts);
		syncTextareaShadowTree(element, parts);
		return parts;
	}

	/**
	 * Build a select's UA-internal shadow tree: the selected option's label
	 * (part=value) and the ▾ indicator (part=indicator), observer-enrolled
	 * before population like the textarea's -- its content renders through
	 * the normal pipeline, and composition hides the option list entirely.
	 */
	#ensureSelectShadowParts(element: HTMLSelectElement): {
		kind: "field" | "toggle" | "textarea" | "select";
		spans: Record<string, HTMLElement>;
		texts: Record<string, Text>;
	} {
		const cached = this.#inputShadowParts.get(element);
		if (cached && cached.kind === "select") {
			return cached;
		}

		const document = this.document;
		const root = createUAShadowRoot(element);
		this[kObserver].observe(root, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeOldValue: true,
			characterData: true,
		});
		this.#styleManager.registerShadowRoot(root);

		const spans: Record<string, HTMLElement> = {};
		const texts: Record<string, Text> = {};
		const style = document.createElement("style");
		style.textContent = SELECT_UA_STYLES;
		root.appendChild(style);
		for (const part of ["value", "indicator"]) {
			const span = document.createElement("span");
			span.setAttribute("part", part);
			const text = document.createTextNode("");
			span.appendChild(text);
			root.appendChild(span);
			spans[part] = span;
			texts[part] = text;
		}
		texts.indicator.data = " \u25be"; // " ▾"

		// The picker: the spec-shaped ::picker(select) popover as a real UA
		// part -- an absolutely positioned box the open state reveals, whose
		// geometry the sync controller anchors to the field in document
		// coordinates (its containing block is the ICB; a measure-function
		// select can't serve as one).
		const picker = document.createElement("div");
		picker.setAttribute("part", "picker");
		root.appendChild(picker);
		spans.picker = picker;

		const parts = {kind: "select" as const, spans, texts};
		this.#inputShadowParts.set(element, parts);
		this.#syncSelectShadowTree(element, parts);
		return parts;
	}

	/** Highlighted option index of each OPEN picker; absence = closed. */
	#openPickers = new WeakMap<HTMLSelectElement, number>();

	/** Reconcile the select's UA tree with its own selection state. */
	#syncSelectShadowTree(
		element: HTMLSelectElement,
		parts: {spans: Record<string, HTMLElement>; texts: Record<string, Text>},
	): void {
		const selected =
			element.selectedIndex >= 0
				? element.options[element.selectedIndex]
				: null;
		const label = selected ? selected.label : "";
		if (parts.texts.value.data !== label) {
			parts.texts.value.data = label;
		}

		// Losing focus closes the picker, as everywhere.
		if (
			this.#openPickers.has(element) &&
			this.document.activeElement !== element
		) {
			this.#openPickers.delete(element);
		}

		const picker = parts.spans.picker;
		const highlight = this.#openPickers.get(element);
		const open = highlight !== undefined;
		if (!open) {
			if (picker.style.display !== "none") {
				picker.style.display = "none";
				this.#topLayer.delete(picker);
			}
			return;
		}

		// Rebuild rows to match the option list; cheap at option-list scale.
		const options = Array.from(element.options);
		while (picker.childNodes.length > options.length) {
			picker.removeChild(picker.lastChild!);
		}
		while (picker.childNodes.length < options.length) {
			const row = this.document.createElement("div");
			row.setAttribute("part", "option");
			picker.appendChild(row);
		}
		options.forEach((option, index) => {
			const row = picker.childNodes[index] as HTMLElement;
			if (row.textContent !== option.label) row.textContent = option.label;
			// Attribute writes are guarded: setAttribute queues a mutation
			// record even when the value is unchanged, and this sync runs at
			// paint time on an OBSERVED root -- unconditional writes are an
			// infinite render loop.
			if (option.disabled !== row.hasAttribute("data-disabled")) {
				if (option.disabled) row.setAttribute("data-disabled", "");
				else row.removeAttribute("data-disabled");
			}
			const highlighted = index === highlight;
			if (highlighted !== row.hasAttribute("data-highlighted")) {
				if (highlighted) row.setAttribute("data-highlighted", "");
				else row.removeAttribute("data-highlighted");
			}
		});

		// Anchor below the field in DOCUMENT coordinates (the picker's
		// containing block is the ICB), matching the field's width.
		const rect = this[kLayoutEngine].getRect(element);
		if (rect) {
			const top = `${Math.round(rect.bottom)}px`;
			const left = `${Math.round(rect.left)}px`;
			const width = `${Math.max(4, Math.round(rect.width))}ch`;
			if (picker.style.top !== top) picker.style.top = top;
			if (picker.style.left !== left) picker.style.left = left;
			if (picker.style.width !== width) picker.style.width = width;
		}
		if (picker.style.display !== "block") picker.style.display = "block";
		this.#topLayer.add(picker);
	}

	/**
	 * Arrow keys move a closed select's selection in place, skipping
	 * disabled options, firing input and change -- the browser's own
	 * closed-select keyboard model, with no popup to degrade.
	 */
	#handleSelectAction(
		element: HTMLSelectElement,
		keyName: string,
		key: string,
	): void {
		const options = Array.from(element.options);
		if (options.length === 0) return;

		const enabled = (index: number) => !options[index].disabled;
		const current = element.selectedIndex;
		let target = current;

		const step = (from: number, direction: 1 | -1): number => {
			for (
				let i = from + direction;
				i >= 0 && i < options.length;
				i += direction
			) {
				if (enabled(i)) return i;
			}
			return from;
		};

		// OPEN picker: arrows move the highlight without committing; Enter or
		// Space commits; Escape dismisses without change -- the browser's
		// picker model.
		const highlight = this.#openPickers.get(element);
		if (highlight !== undefined) {
			if (keyName === "ArrowDown") {
				this.#openPickers.set(element, step(highlight, 1));
			} else if (keyName === "ArrowUp") {
				this.#openPickers.set(element, step(highlight, -1));
			} else if (keyName === "Home") {
				this.#openPickers.set(element, step(-1, 1));
			} else if (keyName === "End") {
				this.#openPickers.set(element, step(options.length, -1));
			} else if (keyName === "Enter" || key === " ") {
				this.#openPickers.delete(element);
				if (highlight !== current && enabled(highlight)) {
					this.#commitSelect(element, highlight);
					return;
				}
			} else if (keyName === "Escape") {
				this.#openPickers.delete(element);
			} else {
				return;
			}
			this.#syncSelectShadowTree(
				element,
				this.#ensureSelectShadowParts(element),
			);
			this.#render();
			return;
		}

		// CLOSED: Space or Enter opens the picker at the current selection;
		// arrows keep changing the value in place (the macOS closed-select
		// model, unchanged).
		if (keyName === "Enter" || key === " ") {
			this.#openSelectPicker(element);
			return;
		}
		if (keyName === "ArrowDown" || keyName === "ArrowRight") {
			target = step(current, 1);
		} else if (keyName === "ArrowUp" || keyName === "ArrowLeft") {
			target = step(current, -1);
		} else if (keyName === "Home") {
			target = step(-1, 1);
		} else if (keyName === "End") {
			target = step(options.length, -1);
		} else {
			return;
		}

		if (target !== current && target >= 0) {
			this.#commitSelect(element, target);
		}
	}

	/**
	 * Open a select's picker with the highlight on the current selection
	 * (or the first enabled option when nothing is selected) -- shared by
	 * the keyboard's Enter/Space and the mouse's press-to-open.
	 */
	#openSelectPicker(element: HTMLSelectElement): void {
		const options = Array.from(element.options);
		if (options.length === 0) return;
		let index = element.selectedIndex;
		if (index < 0) {
			index = options.findIndex((option) => !option.disabled);
		}
		this.#openPickers.set(element, index);
		this.#syncSelectShadowTree(element, this.#ensureSelectShadowParts(element));
		this.#render();
	}

	#commitSelect(element: HTMLSelectElement, index: number): void {
		element.selectedIndex = index;
		this.#syncSelectShadowTree(element, this.#ensureSelectShadowParts(element));
		element.dispatchEvent(
			new this.window.Event("input", {bubbles: true, cancelable: false}),
		);
		element.dispatchEvent(
			new this.window.Event("change", {bubbles: true, cancelable: false}),
		);
		this.#queueCaretReveal(element);
		this.#render();
	}

	/**
	 * The value offset under a document-space point in a text field --
	 * cell-width aware, clamped to the nearest offset so a drag that
	 * leaves the field still resolves (the browser's capture model:
	 * a selection begun in a field is the field's until release).
	 */
	#fieldOffsetAtPoint(
		element: HTMLInputElement | HTMLTextAreaElement,
		x: number,
		y: number,
	): number | null {
		if (element.tagName === "TEXTAREA") {
			const textarea = element as HTMLTextAreaElement;
			const visual = textareaVisualLines(
				textarea,
				this.#ensureTextareaShadowParts(textarea),
				this[kLayoutEngine],
			);
			if (!visual || visual.lines.length === 0) return null;
			// The pressed row's line; above the first clamps to it, below
			// the last to that.
			let line = visual.lines[0];
			for (const candidate of visual.lines) {
				if (candidate.y > y) break;
				line = candidate;
			}
			const rel = x - line.x;
			if (rel <= 0) return line.startOffset;
			let cells = 0;
			let offset = 0;
			for (const char of line.text) {
				if (cells >= rel) break;
				cells += stringWidth(char);
				offset += char.length;
			}
			return Math.min(line.startOffset + offset, line.endOffset);
		}

		const input = element as HTMLInputElement;
		const rect = this[kLayoutEngine].getRect(input);
		if (!rect) return null;
		const boxModel = getBoxModel(input);
		const contentX =
			Math.round(rect.left) +
			(boxModel.borderLeftWidth || 0) +
			(boxModel.paddingLeft || 0);
		const value = input.value || "";
		const scrollOffset = this.#inputScrollOffsets.get(input) ?? 0;
		const rel = x - contentX;
		if (rel <= 0) return Math.min(scrollOffset, value.length);
		let cells = 0;
		let offset = scrollOffset;
		for (const char of value.slice(scrollOffset)) {
			if (cells >= rel) break;
			cells += stringWidth(char);
			offset += char.length;
		}
		return Math.min(offset, value.length);
	}

	/**
	 * Queue a caret reveal for the next frame. Edits used to reveal
	 * IMMEDIATELY, which cost a full synchronous layout flush per
	 * keystroke before the frame's own flush -- half the typing latency.
	 * The reveal now rides the frame the edit already scheduled: one
	 * camera decision against the layout that frame flushes anyway,
	 * however many keystrokes coalesced into it.
	 */
	#queueCaretReveal(
		element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	): void {
		this.#pendingCaretReveal = element;
	}

	/**
	 * Keep the editing caret inside the camera, the way a browser keeps the
	 * caret of a focused control visible on every EDIT (typing, Enter,
	 * caret travel) -- and only on edits: wheel-scrolling away from a
	 * focused field stays allowed, so the render loop runs this only when
	 * an edit queued it (see #queueCaretReveal). The caret row comes from
	 * fresh layout; single-row widgets reduce to their own row.
	 */
	#scrollCaretIntoView(
		element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	): void {
		this.#processPendingMutationsAndRender();
		const rect = this[kLayoutEngine].getRect(element);
		if (!rect) return;
		let caretY = Math.round(rect.top);
		if (element.tagName === "TEXTAREA") {
			const textarea = element as HTMLTextAreaElement;
			const cell = textareaCaretCell(
				textarea,
				this.#ensureTextareaShadowParts(textarea),
				this[kLayoutEngine],
			);
			if (!cell) return;
			caretY = cell.y;
		}
		// The row span to reveal: the caret's row -- widened to the field's
		// own edge when the caret sits on the first or last content row, so
		// resting at a boundary shows the border instead of a cropped box.
		const boxModel = getBoxModel(element);
		let revealTop = caretY;
		let revealBottom = caretY + 1;
		if (caretY <= Math.round(rect.top) + (boxModel.borderTopWidth || 0)) {
			revealTop = Math.round(rect.top);
		}
		if (
			caretY >=
			Math.round(rect.bottom) - (boxModel.borderBottomWidth || 0) - 1
		) {
			revealBottom = Math.round(rect.bottom);
		}
		const regionHeight = Math.min(
			this.#height,
			this.document.body.scrollHeight,
		);
		const top = this.#documentScrollTop;
		if (revealTop < top) {
			this.#scrollCamera(revealTop - top);
		} else if (revealBottom > top + regionHeight) {
			this.#scrollCamera(revealBottom - (top + regionHeight));
		}
	}

	/**
	 * The caret offset one visual line up or down from `caret`, keeping the
	 * column (in cells) where the target line allows -- soft wraps count as
	 * lines, exactly as in a browser. First line up collapses to 0, last
	 * line down to the end.
	 */
	#textareaVerticalTarget(
		element: HTMLTextAreaElement,
		caret: number,
		direction: 1 | -1,
	): number {
		const visual = textareaVisualLines(
			element,
			this.#ensureTextareaShadowParts(element),
			this[kLayoutEngine],
		);
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
		const column = this.#textareaGoalColumn.get(element) ?? currentColumn;
		this.#textareaGoalColumn.set(element, column);
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

	/**
	 * Sync an input's UA tree from its own state -- the single source of
	 * truth; the tree is its rendered content model. A width:auto input
	 * sizes to this content (field-sizing: content, effectively), so
	 * content changes must re-measure -- the UA root is unobserved, nothing
	 * else will -- and the blank part carries one space as the caret's cell
	 * past the last character. Called at paint (safety net) AND at edit
	 * commit, BEFORE layout flushes: painting one frame at the stale width
	 * shifted the scroll-window and dropped the lead character for a frame.
	 */
	#syncInputShadowTree(
		element: HTMLInputElement,
		parts: {spans: Record<string, HTMLElement>; texts: Record<string, Text>},
	): void {
		const value = element.value || "";
		const placeholder = element.getAttribute("placeholder") || "";
		const autoWidth =
			this.window.getComputedStyle(element).getPropertyValue("width") ===
			"auto";
		let contentChanged = false;
		if (parts.texts.value.data !== value) {
			parts.texts.value.data = value;
			contentChanged = true;
		}
		if (parts.texts.placeholder.data !== placeholder) {
			parts.texts.placeholder.data = placeholder;
			contentChanged = true;
		}
		// An empty field must not collapse to zero cells: with no value and
		// no placeholder to give it width, the blank's single caret cell IS
		// the field -- one faint underlined cell marking an editable spot.
		const blank = !autoWidth ? "" : value || !placeholder ? " " : "";
		if (parts.texts.blank.data !== blank) {
			parts.texts.blank.data = blank;
			contentChanged = true;
		}
		if (autoWidth && contentChanged) {
			this[kLayoutEngine].invalidate(element);
			void this.#render();
		}
	}

	/**
	 * Render an input element: sync its UA shadow tree from the input's own
	 * state, then paint the tree's parts with their computed styles. What
	 * remains here is exactly the widget's editor mechanics -- the
	 * scroll-window over an overflowing value and parking the REAL terminal
	 * cursor -- the same split a browser makes between its input's shadow
	 * content and its editor internals.
	 */
	#processPendingMutationsAndRender(): boolean {
		// A geometry read (getBoundingClientRect, elementFromPoint) needs fresh
		// *layout*, not fresh pixels. A full render() here would make every
		// rect read with pending mutations paint a frame -- an app calling
		// scrollIntoView on each keystroke pays two paints per key, and the
		// rect could still be stale unless the render were awaited. Flushing
		// mutations and laying out synchronously gives an exact rect; painting
		// stays with the caller's own render. The dirty-skip makes this free when
		// nothing changed.
		const pendingMutations = this[kObserver].takeRecords();
		const hadMutations = pendingMutations.length > 0;
		if (hadMutations) {
			this.#handlePendingMutations(pendingMutations);
		}
		this[kLayoutEngine].calculateLayout();
		return hadMutations;
	}

	/**
	 * Coalesce a burst of resize events into a single redraw.
	 *
	 * Dragging a terminal's edge fires a SIGWINCH for every width it passes
	 * through -- dozens in one drag. Redrawing on each leaves a little reflowed
	 * crud in the scrollback every time (see handleResize), so the crud grows with
	 * the length of the drag rather than the fact that it happened. Waiting for the
	 * drag to settle turns the whole gesture into one redraw, and one lot of crud.
	 */
	#scheduleResize(): void {
		// Suppress renders from the very first SIGWINCH, before the debounce
		// settles, so a drag's worth of animation ticks cannot paint at the stale
		// anchor while the terminal is rewrapping under us.
		this.#resizeInProgress = true;
		this.#resizeEpoch++;
		if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
		this.#resizeTimer = setTimeout(() => {
			this.#resizeTimer = null;
			this.#handleResize();
		}, RESIZE_DEBOUNCE_MS);
	}

	#handleResize(): void {
		const newWidth = this.#process.stdout.columns || 80;
		const newHeight = this.#process.stdout.rows || 24;

		this.#width = newWidth;
		this.#height = newHeight;

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

		// The viewport changed, so every @media answer may have: re-parse
		// the stylesheets against the new size (they were parsed against
		// the old one and would stay stale), then let each live
		// MediaQueryList re-evaluate and fire "change" if it flipped.
		this.#styleManager.refreshStylesheets();
		for (const update of this.#mediaQueryUpdaters) update();

		this.#renderer.resize(newHeight, newWidth);
		this[kLayoutEngine].resize(newWidth, newHeight);

		// Re-anchor and redraw. The terminal has already rewrapped everything on
		// screen -- including our old frame -- and how far our content moved depends
		// on text above us that we do not own. But two facts make its new position
		// exactly recoverable:
		//
		//   1. The cursor is parked on our content's bottom row after every frame,
		//      and it rides its line through the rewrap (renderFrame parks it).
		//   2. Every row we paint is a hard line, so the old frame's rewrapped
		//      height is computable from the previous frame's own line lengths.
		//
		// So: ask the terminal where the cursor is (DSR), subtract the rewrapped
		// height, and that is our frame's new top row -- ground truth, immune to
		// whatever the shell prompt above did. Anything that ballooned past the
		// screen top is in the scrollback, beyond rewriting; the redraw's erase
		// covers everything from the recovered top down, so the visible screen
		// carries exactly one copy.
		//
		// resizeInProgress has suppressed every animation tick since the first
		// SIGWINCH, so nothing paints at a stale anchor while the query is in
		// flight. If the terminal does not answer, fall back to the computed
		// vertical re-anchor (exact for height changes, approximate for width).
		this[kLayoutEngine].calculateLayout();
		const contentHeight = this.document.body.scrollHeight;
		const wrappedRowsAbove =
			this.#renderer.wrappedRowsAboveCursorPark(newWidth);
		const epoch = this.#resizeEpoch;

		const redraw = (startRow: number) => {
			// The recovered row is where the frame STOOD; whether the frame
			// still FITS below it at the new height is reserveRows' problem,
			// which solves it the only permissible way -- scrolling earlier
			// output up into the scrollback, never painting over it. (An
			// earlier fix clamped startRow upward here instead, which planted
			// the frame on top of the shell prompt above it.)
			this.#screenTop = startRow;
			this.#anchorScrollTop = -this.#screenTop;
			this.#renderer.resetScreen(startRow);

			// Everything suppressed since the first SIGWINCH may paint again. The
			// frame is placed by the screen reset, not by cursor detection.
			this.#resizeInProgress = false;
			const wasDetected = this.#hasDetectedCommandStart;
			this.#hasDetectedCommandStart = false;
			this.#render().then(() => {
				this.#hasDetectedCommandStart = wasDetected;
			});
		};

		const computedReanchor = () => {
			const previousStart = this.#screenTop;
			const scrolledUp = Math.max(0, previousStart + contentHeight - newHeight);
			return Math.max(0, previousStart - scrolledUp);
		};

		// The anchor is trustworthy exactly while the frame still FITS below it.
		// When it does, no room-making scroll happens and the redraw is precise,
		// so the prompt above is left alone. When it does not, the terminal
		// scrolled the frame by an amount a same-cursor DSR cannot report, and
		// making room on top of that mis-anchor is what strands a copy of our
		// own rows -- an intermittent race we cannot win. There, clear the whole
		// screen and start at the top: the erase covers every row the old frame
		// could hold, so no fragment survives. It costs the output above us,
		// which is the trade for a screen that is always legible.
		const place = (startRow: number) => {
			if (startRow + contentHeight <= newHeight) {
				redraw(startRow);
			} else {
				this.#renderer.clearScreen();
				redraw(0);
			}
		};

		if (
			this.#detectCursorEnabled &&
			this.#process.stdin?.isTTY &&
			wrappedRowsAbove !== null
		) {
			this.#queryCursorRow()
				.then((cursorRow) => {
					// A newer resize superseded this one; its handler will redraw.
					if (epoch !== this.#resizeEpoch) return;
					place(Math.max(0, cursorRow - wrappedRowsAbove));
				})
				.catch(() => {
					if (epoch !== this.#resizeEpoch) return;
					place(computedReanchor());
				});
		} else {
			place(computedReanchor());
		}
	}

	/**
	 * Run the observers against the layout just produced.
	 *
	 * Called after every render, once isRendering is clear -- a callback that
	 * mutates the DOM schedules the next frame through the mutation observer, so
	 * there is no re-entrancy to guard against here.
	 */
	#afterRender(): void {
		this.#renderCount++;
		this.#observerManager.flush();
	}

	/** Install the observer constructors on the window, bound to this instance. */
	#installObservers(): void {
		const manager = this.#observerManager;
		const window = this.window as unknown as {
			ResizeObserver: unknown;
			IntersectionObserver: unknown;
		};

		window.ResizeObserver = class extends TermResizeObserver {
			constructor(
				callback: ConstructorParameters<typeof TermResizeObserver>[0],
			) {
				super(callback, manager);
			}
		};

		window.IntersectionObserver = class extends TermIntersectionObserver {
			constructor(
				callback: ConstructorParameters<typeof TermIntersectionObserver>[0],
				init?: ConstructorParameters<typeof TermIntersectionObserver>[2],
			) {
				super(callback, manager, init);
			}
		};
	}

	/**
	 * Focus the next or previous focusable element
	 */
	#moveFocus(reverse: boolean): void {
		const focusable = getFocusableElements(
			this.document,
			this.window,
			this[kLayoutEngine],
		);
		if (focusable.length === 0) return;

		const current = this.document.activeElement;
		const currentIndex = focusable.indexOf(current as Element);
		let nextIndex: number;

		if (reverse) {
			nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
		} else {
			nextIndex = currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1;
		}

		(focusable[nextIndex] as HTMLElement).focus();

		// Focus is not a DOM mutation, so no observer will schedule a frame -- but
		// :focus styling and the caret (the real terminal cursor, parked in the
		// focused field) both need one to move.
		void this.#render();
	}

	/**
	 * Handle input element default actions (character insertion, deletion, navigation)
	 */
	/**
	 * Flip a checkbox's checked state and fire `change`, matching a browser's
	 * Space-key default action for a focused checkbox -- never `input`, which
	 * checkboxes don't fire. Click doesn't need this: jsdom's own click
	 * activation behavior already toggles `.checked` and fires `change` (and
	 * already honors preventDefault on the click), so handling it here too
	 * would double-toggle.
	 */
	#toggleCheckbox(element: HTMLInputElement): void {
		element.checked = !element.checked;
		element.dispatchEvent(
			new this.window.Event("change", {bubbles: true, cancelable: false}),
		);
		this.#render();
	}

	#handleInputAction(
		element: HTMLInputElement | HTMLTextAreaElement,
		keyName: string,
		key: string,
		shiftKey: boolean,
		ctrlKey: boolean,
	): void {
		const isTextarea = element.tagName === "TEXTAREA";
		if (keyName !== "ArrowUp" && keyName !== "ArrowDown") {
			this.#textareaGoalColumn.delete(element);
		}
		if (element.type === "checkbox" || element.type === "radio") {
			const toggle = element as HTMLInputElement;
			// Only Space activates these -- real browsers don't accept typed
			// text into them at all, so every other key here is a no-op. A
			// checkbox toggles; a radio only ever checks (Space on an
			// already-checked radio does nothing, per the browser default --
			// jsdom's checkedness setter handles unchecking the rest of the
			// same-name group).
			if (key === " ") {
				if (toggle.type === "checkbox") {
					this.#toggleCheckbox(toggle);
				} else if (!toggle.checked) {
					toggle.checked = true;
					element.dispatchEvent(
						new this.window.Event("change", {
							bubbles: true,
							cancelable: false,
						}),
					);
					this.#render();
				}
			}
			return;
		}

		// The caret IS the input's collapsed selection -- selectionStart/End/
		// Direction, the standard API, not a private shadow of it. That makes
		// the caret visible to setSelectionRange()/select() callers, and it
		// means a framework assigning .value can't strand it: per spec (and in
		// jsdom, verified) setting value collapses the selection to the end.
		// Direction carries which end of a selection is the moving focus, so
		// Shift+Left after Shift+Right shrinks the selection instead of
		// flipping it -- exactly the browser's anchor/focus model.
		const value = element.value;
		const start = element.selectionStart ?? value.length;
		const end = element.selectionEnd ?? value.length;
		const backward = element.selectionDirection === "backward";
		const caret = backward ? start : end;
		const anchor = backward ? end : start;
		const hasSelection = start !== end;

		let newValue = value;
		let newStart = start;
		let newEnd = end;
		let newDirection: "forward" | "backward" | "none" = "none";

		// Collapse the selection to a caret at `pos`.
		const collapse = (pos: number) => {
			newStart = newEnd = Math.max(0, Math.min(pos, newValue.length));
		};
		// Move the selection's focus (anchor stays), Shift+arrow style.
		const extend = (focus: number) => {
			const clamped = Math.max(0, Math.min(focus, value.length));
			newStart = Math.min(anchor, clamped);
			newEnd = Math.max(anchor, clamped);
			newDirection = clamped < anchor ? "backward" : "forward";
		};

		if (ctrlKey && keyName === "a") {
			// Select all, the browser's Ctrl+A. (Never Cmd+A here: Cmd chords
			// are consumed by the terminal app and don't reach the PTY.)
			extend(0);
			newStart = 0;
			newEnd = value.length;
			newDirection = "forward";
		} else if (keyName === "Backspace") {
			if (hasSelection) {
				newValue = value.slice(0, start) + value.slice(end);
				collapse(start);
			} else if (caret > 0) {
				newValue = value.slice(0, caret - 1) + value.slice(caret);
				collapse(caret - 1);
			}
		} else if (keyName === "Delete") {
			if (hasSelection) {
				newValue = value.slice(0, start) + value.slice(end);
				collapse(start);
			} else if (caret < value.length) {
				newValue = value.slice(0, caret) + value.slice(caret + 1);
				collapse(caret);
			}
		} else if (keyName === "ArrowLeft") {
			if (shiftKey) {
				extend(caret - 1);
			} else if (hasSelection) {
				// A plain arrow collapses to the selection's matching edge,
				// not one past it -- the browser behavior.
				collapse(start);
			} else {
				collapse(caret - 1);
			}
		} else if (keyName === "ArrowRight") {
			if (shiftKey) {
				extend(caret + 1);
			} else if (hasSelection) {
				collapse(end);
			} else {
				collapse(caret + 1);
			}
		} else if (isTextarea && keyName === "Enter") {
			// Enter is a newline in a textarea -- inserted like any typed
			// character, replacing the selection.
			newValue = value.slice(0, start) + "\n" + value.slice(end);
			collapse(start + 1);
		} else if (
			isTextarea &&
			(keyName === "ArrowUp" || keyName === "ArrowDown")
		) {
			// Vertical movement is by VISUAL line -- soft wraps count, as in
			// a browser -- computed from the value's laid-out fragments.
			this.#processPendingMutationsAndRender();
			const target = this.#textareaVerticalTarget(
				element as HTMLTextAreaElement,
				caret,
				keyName === "ArrowDown" ? 1 : -1,
			);
			if (shiftKey) {
				extend(target);
			} else {
				collapse(target);
			}
		} else if (keyName === "Home") {
			// In a textarea, Home goes to the start of the caret's visual
			// line; in an input, of the whole value.
			let target = 0;
			if (isTextarea) {
				this.#processPendingMutationsAndRender();
				const textarea = element as HTMLTextAreaElement;
				const visual = textareaVisualLines(
					textarea,
					this.#ensureTextareaShadowParts(textarea),
					this[kLayoutEngine],
				);
				if (visual) {
					target =
						visual.lines[textareaLineAt(visual.lines, caret)].startOffset;
				}
			}
			if (shiftKey) {
				extend(target);
			} else {
				collapse(target);
			}
		} else if (keyName === "End") {
			let target = value.length;
			if (isTextarea) {
				this.#processPendingMutationsAndRender();
				const textarea = element as HTMLTextAreaElement;
				const visual = textareaVisualLines(
					textarea,
					this.#ensureTextareaShadowParts(textarea),
					this[kLayoutEngine],
				);
				if (visual) {
					target = visual.lines[textareaLineAt(visual.lines, caret)].endOffset;
				}
			}
			if (shiftKey) {
				extend(target);
			} else {
				collapse(target);
			}
		} else if (key.length === 1 && key.charCodeAt(0) >= 32) {
			// Printable character: replaces the selection, as in a browser.
			newValue = value.slice(0, start) + key + value.slice(end);
			collapse(start + 1);
		} else {
			return; // Not an input action
		}

		if (newValue !== value) {
			// Order matters: assigning .value collapses the selection to the
			// end (per spec), so the new caret must be set after.
			element.value = newValue;
			element.setSelectionRange(newStart, newEnd, newDirection);
			if (isTextarea) {
				// Push the new value into the UA tree now -- the mutation
				// records from this sync are what invalidate layout, since no
				// observer hears a .value assignment.
				syncTextareaShadowTree(
					element as HTMLTextAreaElement,
					this.#ensureTextareaShadowParts(element as HTMLTextAreaElement),
				);
			} else {
				// Same for the input: a width:auto field must measure at the
				// NEW width before this frame paints, or the scroll-window
				// momentarily shoves the lead character off the field.
				this.#syncInputShadowTree(
					element as HTMLInputElement,
					this.#ensureInputShadowParts(element as HTMLInputElement),
				);
			}

			// Dispatch input event
			element.dispatchEvent(
				new this.window.Event("input", {bubbles: true, cancelable: false}),
			);

			this.#queueCaretReveal(element);
			// Trigger re-render since .value changes don't trigger MutationObserver
			this.#render();
		} else if (
			newStart !== start ||
			newEnd !== end ||
			(newStart !== newEnd && newDirection !== element.selectionDirection)
		) {
			// jsdom fires the `select` event itself for a real range change.
			element.setSelectionRange(newStart, newEnd, newDirection);
			this.#queueCaretReveal(element);
			this.#render();
		}
	}

	/**
	 * Split raw terminal input into key tokens: CSI sequences (ESC [ ... final
	 * byte), SS3 sequences (ESC O x), and single characters.
	 *
	 * Fast input arrives batched -- a held arrow key delivers
	 * "\x1b[B\x1b[B\x1b[B" in one chunk, and a terminal report can land glued to
	 * ordinary keystrokes. Anything that treats a chunk as one key swallows
	 * everything after the first token: a held arrow repeated once per chunk
	 * instead of once per press, and a stray cursor report ate every key packed
	 * behind it.
	 */
	*#tokenizeInput(input: string): Generator<string> {
		let i = 0;
		while (i < input.length) {
			if (input[i] === "\x1b" && i + 1 < input.length) {
				if (input[i + 1] === "[") {
					// CSI: parameter/intermediate bytes end at a final byte 0x40-0x7e.
					let end = i + 2;
					while (
						end < input.length &&
						!(input.charCodeAt(end) >= 0x40 && input.charCodeAt(end) <= 0x7e)
					) {
						end++;
					}
					yield input.slice(i, Math.min(end + 1, input.length));
					i = end + 1;
					continue;
				}
				if (input[i + 1] === "O" && i + 2 < input.length) {
					yield input.slice(i, i + 3);
					i += 3;
					continue;
				}
			}
			yield input[i];
			i++;
		}
	}

	/**
	 * Where a screen cell lands in the document, given who owns the camera.
	 * Returns null for cells above our region (a shell prompt is not part of
	 * the document).
	 */
	#screenToDocumentPoint(
		x: number,
		row: number,
	): {x: number; y: number} | null {
		if (this.#fullscreenManager.isFullscreen) {
			return {x, y: row + this.#anchorScrollTop};
		}
		const y = row - this.#screenTop + this.#documentScrollTop;
		return y < 0 ? null : {x, y};
	}

	/**
	 * Hit-test a document-relative point (flushing pending layout first). The
	 * one place both document.elementFromPoint (which converts its public,
	 * viewport-relative x/y into this space) and mouse hit-testing (whose
	 * points are already document-relative, from #screenToDocumentPoint) go
	 * through, so a click always tests against fresh layout regardless of
	 * entry point.
	 */
	#findElementAtDocumentPoint(x: number, y: number): Element | null {
		this.#processPendingMutationsAndRender();
		let element = this[kHitTest](this.document.documentElement, x, y);
		// RETARGET out of shadow trees, per spec: from outside a shadow tree
		// (and the document is always outside), the hit is the HOST -- a
		// click on an input's internal value span is a click on the input.
		// Without this, closest()/focus logic dead-ends inside the UA
		// fragment, whose parts have no parentElement chain to climb.
		while (element) {
			const root = element.getRootNode();
			if (root.nodeType === 11 && (root as ShadowRoot).host) {
				element = (root as ShadowRoot).host;
			} else {
				break;
			}
		}
		return element;
	}

	/**
	 * Hit-testing mirrors the stacking-context paint order, topmost first:
	 * positive-z contexts (descending), the positioned z:auto/0 layer
	 * (reverse tree order), in-flow content, then negative-z contexts.
	 * Because positioned elements are probed at their CONTEXT rather than
	 * through their parents, an absolute box hanging outside its parent's
	 * rect is clickable -- the old top-down walk required every ancestor to
	 * contain the point and could never reach it.
	 */
	[kHitTest](root: Element, x: number, y: number): Element | null {
		const layers = this.#painter.collectStackingLayers();
		// Paint roots at <body>; a probe from documentElement must too, or
		// the body-level buckets would never be consulted.
		const paintRoot =
			root === this.document.documentElement ? this.document.body : root;
		const topLayer = [...this.#topLayer].reverse();
		for (const element of topLayer) {
			if (!compositionIsConnected(element)) continue;
			const hit = this.#hitTestContext(element, x, y, layers);
			if (hit) return hit;
		}
		return this.#hitTestContext(paintRoot, x, y, layers);
	}

	#hitTestContext(
		root: Element,
		x: number,
		y: number,
		layers: Map<Element, {neg: Element[]; zero: Element[]; pos: Element[]}>,
	): Element | null {
		const bucket = layers.get(root) ?? null;
		const probeMember = (element: Element): Element | null => {
			// A fixed box's layout lives in viewport space; convert the
			// document-space probe point for its whole subtree.
			const probeY =
				this.window.getComputedStyle(element).getPropertyValue("position") ===
				"fixed"
					? y - this.#documentScrollTop
					: y;
			return this.#painter.formsStackingContext(element)
				? this.#hitTestContext(element, x, probeY, layers)
				: this.#hitTestInFlow(element, x, probeY);
		};
		if (bucket) {
			for (let i = bucket.pos.length - 1; i >= 0; i--) {
				const hit = probeMember(bucket.pos[i]);
				if (hit) return hit;
			}
			for (let i = bucket.zero.length - 1; i >= 0; i--) {
				const hit = probeMember(bucket.zero[i]);
				if (hit) return hit;
			}
		}
		const inFlow = this.#hitTestInFlow(root, x, y);
		if (inFlow) return inFlow;
		if (bucket) {
			for (let i = bucket.neg.length - 1; i >= 0; i--) {
				const hit = probeMember(bucket.neg[i]);
				if (hit) return hit;
			}
		}
		return null;
	}

	/**
	 * In-flow descent: the element must contain the point; children are
	 * probed in REVERSE tree order (last-painted wins), positioned children
	 * skipped -- their context probes them.
	 */
	#hitTestInFlow(element: Element, x: number, y: number): Element | null {
		if (element.nodeType !== 1) return null;
		if (
			this.window.getComputedStyle(element).getPropertyValue("display") ===
			"none"
		) {
			return null;
		}
		try {
			const rects = this[kLayoutEngine].getRects(element);
			if (!isPointInRects(x, y, rects)) return null;
		} catch {
			return null;
		}
		const children: Element[] = [];
		const walker = createExpandedTreeWalker(this.window, element);
		for (let child = walker.firstChild(); child; child = walker.nextSibling()) {
			if (child.nodeType !== 1) continue;
			if (isPositioned(this.window, child as Element)) continue;
			children.push(child as Element);
		}
		for (let i = children.length - 1; i >= 0; i--) {
			const hit = this.#hitTestInFlow(children[i], x, y);
			if (hit) return hit;
		}
		return element;
	}

	/**
	 * Resolve a document-relative point to a caret position -- (text node,
	 * code-unit offset into node.data) -- the way a browser's
	 * caretPositionFromPoint does. Hit-tests the element, then scans its text
	 * nodes' painted fragments for the one on the point's row; the x offset
	 * becomes a visual character index (cell-width aware), and
	 * visualToDataOffsets bridges that back to a Range-valid data offset.
	 * Landing past a fragment's last character on its row means "after the
	 * last character", so a drag can select through end-of-line. Returns null
	 * over rows with no text (and over inputs, whose value is not document
	 * text -- their selection is the input's own selectionStart/End world).
	 */
	#documentPointToTextPosition(
		x: number,
		y: number,
	): {node: Text; offset: number} | null {
		const element = this.#findElementAtDocumentPoint(x, y);
		if (
			!element ||
			element instanceof (this.window as any).HTMLInputElement ||
			element instanceof (this.window as any).HTMLTextAreaElement
		) {
			return null;
		}

		let best: {node: Text; offset: number; distance: number} | null = null;
		const visit = (node: Node): void => {
			for (const child of Array.from(node.childNodes)) {
				if (child.nodeType === child.TEXT_NODE) {
					const textNode = child as Text;
					const fragments = this[kLayoutEngine].getRectTexts(textNode);
					if (fragments.length === 0) continue;
					const visToData = visualToDataOffsets(textNode.data, fragments);
					let visualBase = 0;
					for (const fragment of fragments) {
						const rect = fragment.rect;
						if (y >= rect.y && y < rect.y + Math.max(1, rect.height)) {
							// Walk cells to the visual index under (or past) x.
							let cellX = rect.x;
							let index = 0;
							while (index < fragment.text.length && cellX < x) {
								const w = stringWidth(fragment.text[index]);
								if (cellX + w > x) break;
								cellX += w;
								index++;
							}
							const distance =
								x < rect.x
									? rect.x - x
									: x >= cellX && index === fragment.text.length
										? x - cellX
										: 0;
							if (!best || distance < best.distance) {
								const visual = visualBase + index;
								const offset =
									visual < visToData.length
										? visToData[visual]
										: textNode.data.length;
								best = {node: textNode, offset, distance};
							}
						}
						visualBase += fragment.text.length;
					}
				} else if (child.nodeType === child.ELEMENT_NODE) {
					visit(child);
				}
			}
		};
		visit(element);
		return best
			? {node: (best as any).node, offset: (best as any).offset}
			: null;
	}

	/**
	 * A mouse report from the terminal (SGR encoding: `CSI < code ; col ; row M/m`).
	 * These only arrive while capture is on -- see updateMouseReporting.
	 *
	 * Reports become the DOM's own mouse events, dispatched at the element
	 * under the cell (document.elementFromPoint is layout-true), with the
	 * browser's default actions: wheel scrolls the camera, mousedown moves
	 * focus, mouseup on the mousedown target is a click.
	 */
	#handleMouseReport(
		code: number,
		col: number,
		row: number,
		isRelease: boolean,
	): void {
		const shiftKey = (code & 4) !== 0;
		const altKey = (code & 8) !== 0;
		const ctrlKey = (code & 16) !== 0;
		const isMotion = (code & 32) !== 0;
		const base = code & ~(4 | 8 | 16 | 32);

		const point = this.#screenToDocumentPoint(col - 1, row - 1);
		const x = point?.x ?? col - 1;
		const y = point?.y ?? 0;
		// Already document-relative -- go straight to the shared hit-test rather
		// than through the public elementFromPoint, which expects viewport-
		// relative input and would convert it right back.
		const target =
			(point && this.#findElementAtDocumentPoint(x, y)) || this.document.body;

		// Wheel: 64 = up, 65 = down. One notch is three rows, the browser's
		// line-mode convention, and DOM_DELTA_LINE is literally true here.
		if (base === 64 || base === 65) {
			const deltaY = base === 64 ? -3 : 3;
			const notCanceled = target.dispatchEvent(
				new this.window.WheelEvent("wheel", {
					deltaY,
					deltaMode: 1, // DOM_DELTA_LINE
					clientX: x,
					clientY: y,
					shiftKey,
					altKey,
					ctrlKey,
					bubbles: true,
					cancelable: true,
				}),
			);
			if (notCanceled) {
				if (
					deltaY < 0 &&
					this.#documentScrollTop === 0 &&
					!this.#fullscreenManager.isFullscreen
				) {
					// Scroll chaining, the browser default: the camera is at the
					// document top, so the scroll escapes to the parent scroller --
					// here, the terminal's own scrollback. Yield the mouse so the
					// next wheel tick scrolls the shell history natively; the next
					// keystroke reclaims it, and #SCROLL_CHAIN_TIMEOUT_MS of silence
					// reclaims it too, in case the user scrolls back down without
					// ever pressing a key -- wheel activity while yielded produces no
					// signal we could otherwise catch that on. An app opts out the
					// same way it would in a browser: preventDefault on the wheel
					// event.
					this.#mouseCaptureYielded = true;
					this.#updateMouseReporting();
					if (this.#scrollChainTimer !== null) {
						clearTimeout(this.#scrollChainTimer);
					}
					this.#scrollChainTimer = setTimeout(() => {
						this.#scrollChainTimer = null;
						this.#reclaimMouseCapture();
					}, TermDOM.#SCROLL_CHAIN_TIMEOUT_MS);
				} else {
					this.#scrollCamera(deltaY);
				}
			}
			return;
		}

		// Buttons: 0/1/2 = left/middle/right. 3 is "no button" in the legacy
		// encoding; SGR names the button even on release, so 3 carries nothing.
		if (base > 2) return;
		const eventInit = {
			button: base === 1 ? 1 : base === 2 ? 2 : 0,
			buttons: isRelease ? 0 : base === 1 ? 4 : base === 2 ? 2 : 1,
			clientX: x,
			clientY: y,
			shiftKey,
			altKey,
			ctrlKey,
			bubbles: true,
			cancelable: true,
		};

		if (isMotion) {
			target.dispatchEvent(new this.window.MouseEvent("mousemove", eventInit));
			// A field drag extends the field's own selection to the offset
			// under the pointer -- clamped into the field, whichever element
			// the pointer is over now (the field holds the capture).
			if (this.#fieldDragAnchor && point) {
				const {element: fieldElement, offset: anchor} = this.#fieldDragAnchor;
				const focus = this.#fieldOffsetAtPoint(fieldElement, x, y);
				if (focus !== null && focus !== undefined) {
					fieldElement.setSelectionRange(
						Math.min(anchor, focus),
						Math.max(anchor, focus),
						focus < anchor ? "backward" : "forward",
					);
					this.#render();
				}
				return;
			}
			// Dragging with the anchor set extends the document selection to
			// the caret position under the pointer. setBaseAndExtent handles a
			// backward drag itself; over a textless stretch the focus simply
			// stays where it last was.
			if (this.#selectionDragAnchor && this.#mouseDownTarget && point) {
				const focus = this.#documentPointToTextPosition(x, y);
				if (focus) {
					const anchor = this.#selectionDragAnchor;
					this.window
						.getSelection()
						?.setBaseAndExtent(
							anchor.node,
							anchor.offset,
							focus.node,
							focus.offset,
						);
					this.#render();
				}
			}
			return;
		}

		if (!isRelease) {
			this.#mouseDownTarget = target;
			this.#fieldDragAnchor = null;
			const notCanceled = target.dispatchEvent(
				new this.window.MouseEvent("mousedown", eventInit),
			);
			// Default action: mousedown moves focus, exactly as in a browser --
			// to the nearest focusable ancestor, or away from the active element
			// when the click lands on nothing focusable.
			if (notCanceled) {
				const focusable = (target as Element).closest?.(FOCUSABLE_SELECTOR);
				const active = this.document.activeElement;
				if (focusable && focusable !== active) {
					(focusable as HTMLElement).focus();
					void this.#render();
				} else if (!focusable && active && active !== this.document.body) {
					(active as HTMLElement).blur();
					void this.#render();
				}

				// Default action: pressing a select opens its picker, exactly
				// like a browser's dropdown on mousedown. With the picker OPEN,
				// a press on an option row commits it (a disabled row is inert,
				// the sheet stays up), and a press back on the closed face
				// dismisses without changing the value. preventDefault on
				// mousedown suppresses all of it, as in a browser.
				const select =
					base === 0 &&
					point &&
					target instanceof (this.window as any).HTMLSelectElement
						? (target as HTMLSelectElement)
						: null;
				if (select) {
					const highlight = this.#openPickers.get(select);
					if (highlight === undefined) {
						this.#openSelectPicker(select);
					} else {
						// The un-retargeted hit tells the option rows (UA shadow
						// parts under the picker) apart from the closed face.
						const raw = this[kHitTest](this.document.documentElement, x, y);
						const part = raw?.getAttribute("part");
						if (part === "option") {
							const parts = this.#ensureSelectShadowParts(select);
							const index = Array.from(parts.spans.picker.children)
								.filter((row) => row.getAttribute("part") === "option")
								.indexOf(raw as Element);
							const options = Array.from(select.options);
							if (index < 0 || !options[index]?.disabled) {
								this.#openPickers.delete(select);
								if (index >= 0 && index !== select.selectedIndex) {
									this.#commitSelect(select, index);
								} else {
									this.#syncSelectShadowTree(select, parts);
									this.#render();
								}
							}
						} else if (part !== "picker") {
							this.#openPickers.delete(select);
							this.#syncSelectShadowTree(
								select,
								this.#ensureSelectShadowParts(select),
							);
							this.#render();
						}
					}
				}

				// Default action: a press in a text field parks the caret at
				// the pressed character and anchors a FIELD drag there -- the
				// field's own bounded selectionStart/End world, never the
				// document selection: the same split a browser makes.
				const field =
					base === 0 &&
					point &&
					(target instanceof (this.window as any).HTMLTextAreaElement ||
						(target instanceof (this.window as any).HTMLInputElement &&
							(target as HTMLInputElement).type !== "checkbox" &&
							(target as HTMLInputElement).type !== "radio"))
						? (target as HTMLInputElement | HTMLTextAreaElement)
						: null;
				if (field) {
					const offset = this.#fieldOffsetAtPoint(field, x, y);
					if (offset !== null) {
						field.setSelectionRange(offset, offset);
						this.#fieldDragAnchor = {element: field, offset};
						// The DOCUMENT selection still clears on entry -- a page
						// selection doesn't stay highlighted behind a field click
						// in a browser either. The two worlds just never merge:
						// getSelection() cannot see inside the field, per spec.
						const docSelection = this.window.getSelection();
						if (docSelection && !docSelection.isCollapsed) {
							docSelection.removeAllRanges();
						}
						this.#render();
					}
				}

				// Default action: mousedown collapses the document selection at
				// the pressed caret position and anchors a possible drag there,
				// as in a browser. Left button only -- and preventDefault on
				// mousedown suppresses it, which is exactly how apps that want
				// the drag events for themselves opt out.
				const selection = this.window.getSelection();
				if (base === 0 && selection && !this.#fieldDragAnchor) {
					const anchor = point ? this.#documentPointToTextPosition(x, y) : null;
					const hadSelection = !selection.isCollapsed;
					this.#selectionDragAnchor = anchor;
					if (anchor) {
						selection.setBaseAndExtent(
							anchor.node,
							anchor.offset,
							anchor.node,
							anchor.offset,
						);
					} else if (selection.rangeCount > 0) {
						selection.removeAllRanges();
					}
					if (hadSelection) {
						this.#render();
					}
				}
			}
			return;
		}

		target.dispatchEvent(new this.window.MouseEvent("mouseup", eventInit));
		// Releasing a selection drag offers the selected text to the system
		// clipboard via OSC 52 -- select-to-copy, the terminal's own
		// convention (a Cmd/Ctrl+C chord never reaches the PTY). Terminals
		// without OSC 52 support ignore the sequence entirely.
		let selectedByDrag = false;
		if (this.#fieldDragAnchor) {
			// A field drag ends the same way: the field's selected text goes
			// to the system clipboard, select-to-copy.
			const {element: fieldElement} = this.#fieldDragAnchor;
			this.#fieldDragAnchor = null;
			const from = fieldElement.selectionStart ?? 0;
			const to = fieldElement.selectionEnd ?? 0;
			if (to > from) {
				const text = fieldElement.value.slice(from, to);
				this.#process.stdout.write(
					`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`,
				);
			}
		}
		if (this.#selectionDragAnchor) {
			this.#selectionDragAnchor = null;
			const text = this.window.getSelection()?.toString() ?? "";
			if (text.length > 0) {
				selectedByDrag = true;
				this.#process.stdout.write(
					`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`,
				);
			}
		}
		// A drag that selected text is not a click: browsers suppress
		// activation after a selecting gesture, and without this a drag
		// released over a <label> would activate it -- toggling its checkbox,
		// which in a framework app re-renders the very nodes the fresh
		// selection points into, destroying it on the spot.
		if (selectedByDrag) {
			this.#mouseDownTarget = null;
			return;
		}
		if (this.#mouseDownTarget === target) {
			target.dispatchEvent(
				new this.window.MouseEvent("click", {...eventInit, buttons: 0}),
			);
			// A checkbox/radio's .checked already flipped -- jsdom's own click
			// activation behavior handles that directly, and forwards it from a
			// <label for> or wrapping label the same way (honoring
			// preventDefault in both cases) -- but that's a property change,
			// invisible to the MutationObserver that would otherwise repaint it,
			// same as .value on a text input. Focus also needs an explicit push
			// here for the label case: a real browser's "focusing steps" move
			// focus to the label's associated control, which jsdom's dispatch
			// alone does not simulate (the direct-click case is already
			// focused via mousedown's own default action above, so this is a
			// harmless no-op there).
			const isCheckable = (el: unknown): el is HTMLInputElement =>
				el instanceof (this.window as any).HTMLInputElement &&
				((el as HTMLInputElement).type === "checkbox" ||
					(el as HTMLInputElement).type === "radio");
			const control = isCheckable(target)
				? target
				: target instanceof (this.window as any).HTMLLabelElement &&
					  isCheckable((target as any).control)
					? ((target as any).control as HTMLInputElement)
					: null;
			if (control) {
				control.focus();
				this.#render();
			}

			// A second click on the same target within the double-click interval
			// is also a dblclick -- in addition to, not instead of, its own click
			// (a browser fires both). Reset after firing so a third quick click
			// starts a fresh pair rather than double-firing again immediately.
			const now = performance.now();
			if (
				this.#lastClickTarget === target &&
				now - this.#lastClickTime <= TermDOM.#DBLCLICK_INTERVAL_MS
			) {
				target.dispatchEvent(
					new this.window.MouseEvent("dblclick", {...eventInit, buttons: 0}),
				);
				this.#lastClickTarget = null;
				this.#lastClickTime = 0;
			} else {
				this.#lastClickTarget = target as Element;
				this.#lastClickTime = now;
			}
		}
		this.#mouseDownTarget = null;
	}

	#dispatchGlobalKeyboardEvent(chunk: Buffer): void {
		const key = chunk.toString("utf8");

		// Tokenize multi-key chunks and dispatch each token on its own.
		const tokens = Array.from(this.#tokenizeInput(key));
		if (tokens.length > 1) {
			for (const token of tokens) {
				this.#dispatchGlobalKeyboardEvent(Buffer.from(token));
			}
			return;
		}

		// A cursor position report is the terminal answering a query, not the
		// user pressing keys. With no query outstanding (a late or duplicate
		// answer), it is not a keystroke -- drop it rather than dispatching a
		// nonsense key event.
		if (/^\x1b\[\d+;\d+R$/.test(key)) {
			return;
		}

		// Find the focused element. document.activeElement defaults to body when
		// nothing is focused, so it can't be used with `||` to detect "nothing
		// focused". In fullscreen, a browser moves focus to the fullscreen
		// element as part of entering it -- but jsdom's own focus() only takes
		// elements that are already focusable (tabindex, form controls, etc.),
		// so an arbitrary fullscreen container is otherwise unreachable here.
		// Fall back to it (before document.body) so keydown still lands on it,
		// the same as the dedicated fullscreen dispatch this replaced -- but
		// still prefer an explicitly focused descendant (e.g. an input inside
		// the fullscreen element), which the old dispatch ignored.
		const active = this.document.activeElement;
		let targetElement =
			active && active !== this.document.body
				? active
				: this.#fullscreenManager.fullscreenElement || this.document.body;

		// Map common key codes (reuse logic from fullscreen manager)
		let keyName = key;
		let keyCode = 0;
		let charCode = key.charCodeAt(0);

		// Handle special keys
		// Detect modifier keys
		let shiftKey = false;
		let ctrlKey = false;
		let altKey = false;
		let metaKey = false;

		// Ctrl+<letter> arrives as a single raw ASCII control byte (Ctrl+A=0x01
		// ... Ctrl+Z=0x1A) -- there is no escape sequence, and no way to combine
		// it with Shift (the terminal only ever sends the one byte). Tab(0x09)
		// and Enter(0x0A/0x0D) are excluded even though they fall in this range:
		// a raw terminal genuinely cannot distinguish the physical Enter/Tab keys
		// from Ctrl+M/Ctrl+I, they are the identical byte, so the named key wins
		// -- matching every other terminal app. Ctrl+C(0x03) never reaches here:
		// it is intercepted earlier, unconditionally, for SIGINT.
		const modifiedArrow = key.match(/^\x1b\[1;(\d+)([ABCDHF])$/);
		if (
			charCode >= 1 &&
			charCode <= 26 &&
			charCode !== 9 &&
			charCode !== 10 &&
			charCode !== 13
		) {
			keyName = String.fromCharCode(charCode + 96); // 0x01 -> 'a' ... 0x1A -> 'z'
			keyCode = charCode + 64; // 'A'..'Z', the DOM keyCode for the letter itself
			ctrlKey = true;
		} else if (modifiedArrow) {
			// xterm's extended CSI encoding for a modified cursor key: CSI 1 ;
			// <mod> <letter>, e.g. Alt+Up = \x1b[1;3A, Shift+Home = \x1b[1;2H.
			// The tokenizer already yields this whole sequence as one token
			// unchanged -- it scans for the CSI final byte regardless of what
			// parameters precede it -- so this is pure decoding, no parsing
			// changes needed. mod-1 is a bitmask: 1=Shift, 2=Alt, 4=Ctrl,
			// 8=Meta (metaKey included for spec-completeness; nothing on macOS
			// actually sends it, since Cmd+key never reaches the PTY at all).
			const modifierBits = parseInt(modifiedArrow[1], 10) - 1;
			shiftKey = (modifierBits & 1) !== 0;
			altKey = (modifierBits & 2) !== 0;
			ctrlKey = (modifierBits & 4) !== 0;
			metaKey = (modifierBits & 8) !== 0;
			const cursorKeyByLetter: Record<string, [string, number]> = {
				A: ["ArrowUp", 38],
				B: ["ArrowDown", 40],
				C: ["ArrowRight", 39],
				D: ["ArrowLeft", 37],
				H: ["Home", 36],
				F: ["End", 35],
			};
			[keyName, keyCode] = cursorKeyByLetter[modifiedArrow[2]];
			charCode = 0;
		} else {
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
				case "\x1b[Z":
					// Shift+Tab
					keyName = "Tab";
					keyCode = 9;
					charCode = 9;
					shiftKey = true;
					break;
				case "\x7f":
					keyName = "Backspace";
					keyCode = 8;
					charCode = 8;
					break;
				case "\x1b":
					// A lone Escape -- not the start of a CSI/SS3 sequence, since the
					// tokenizer already peels those off as their own multi-char tokens.
					keyName = "Escape";
					keyCode = 27;
					charCode = 0;
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
				case "\x1b[H":
				case "\x1b[1~":
					keyName = "Home";
					keyCode = 36;
					charCode = 0;
					break;
				case "\x1b[F":
				case "\x1b[4~":
					keyName = "End";
					keyCode = 35;
					charCode = 0;
					break;
				case "\x1b[2~":
					keyName = "Insert";
					keyCode = 45;
					charCode = 0;
					break;
				case "\x1b[3~":
					keyName = "Delete";
					keyCode = 46;
					charCode = 0;
					break;
				case "\x1b[5~":
					keyName = "PageUp";
					keyCode = 33;
					charCode = 0;
					break;
				case "\x1b[6~":
					keyName = "PageDown";
					keyCode = 34;
					charCode = 0;
					break;
				// F1-F4: SS3 encoding, the modern xterm default. F5-F12: CSI-tilde --
				// note the historical gap (no ~16), a quirk of the original xterm
				// numbering every terminal descended from it still follows.
				case "\x1bOP":
					keyName = "F1";
					keyCode = 112;
					charCode = 0;
					break;
				case "\x1bOQ":
					keyName = "F2";
					keyCode = 113;
					charCode = 0;
					break;
				case "\x1bOR":
					keyName = "F3";
					keyCode = 114;
					charCode = 0;
					break;
				case "\x1bOS":
					keyName = "F4";
					keyCode = 115;
					charCode = 0;
					break;
				case "\x1b[15~":
					keyName = "F5";
					keyCode = 116;
					charCode = 0;
					break;
				case "\x1b[17~":
					keyName = "F6";
					keyCode = 117;
					charCode = 0;
					break;
				case "\x1b[18~":
					keyName = "F7";
					keyCode = 118;
					charCode = 0;
					break;
				case "\x1b[19~":
					keyName = "F8";
					keyCode = 119;
					charCode = 0;
					break;
				case "\x1b[20~":
					keyName = "F9";
					keyCode = 120;
					charCode = 0;
					break;
				case "\x1b[21~":
					keyName = "F10";
					keyCode = 121;
					charCode = 0;
					break;
				case "\x1b[23~":
					keyName = "F11";
					keyCode = 122;
					charCode = 0;
					break;
				case "\x1b[24~":
					keyName = "F12";
					keyCode = 123;
					charCode = 0;
					break;
				default:
					// For regular characters, keyCode is often the uppercase charCode
					if (key.length === 1) {
						keyCode = key.toUpperCase().charCodeAt(0);
					}
			}
		}

		// Escape exits fullscreen unconditionally -- not dispatched to the DOM at
		// all, the same as a real browser: fullscreen exit is a user-agent
		// guarantee an app can't trap the user past with preventDefault.
		if (keyName === "Escape" && this.#fullscreenManager.isFullscreen) {
			this.#fullscreenManager.exitFullscreen().catch(() => {});
			return;
		}

		// Create and dispatch keydown event
		const keydownEvent = new this.window.KeyboardEvent("keydown", {
			key: keyName,
			code: domCodeFor(keyName),
			keyCode: keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey,
			shiftKey,
			altKey,
			metaKey,
			bubbles: true,
			cancelable: true,
		});

		const notCanceled = targetElement.dispatchEvent(keydownEvent);

		// Handle default actions if keydown wasn't canceled
		if (notCanceled) {
			// Tab navigation
			if (keyName === "Tab") {
				this.#moveFocus(shiftKey);
			}

			// Editable widget default actions
			if (
				(targetElement instanceof (this.window as any).HTMLInputElement &&
					(targetElement as HTMLInputElement).type !== "submit" &&
					(targetElement as HTMLInputElement).type !== "button") ||
				targetElement instanceof (this.window as any).HTMLTextAreaElement
			) {
				this.#handleInputAction(
					targetElement as HTMLInputElement | HTMLTextAreaElement,
					keyName,
					key,
					shiftKey,
					ctrlKey,
				);
			} else if (keyboardActivation(targetElement as Element)) {
				// A focused button activates on Enter and on Space, and a link on
				// Enter, per HTML's activation behavior. Without this, both took
				// focus and painted :focus while doing nothing -- advertising an
				// affordance they did not have. `input[type=submit|button]`,
				// excluded from the editing branch above, had no handler at all.
				const activation = keyboardActivation(targetElement as Element)!;
				if (
					(keyName === "Enter" && activation.enter) ||
					(key === " " && activation.space)
				) {
					// click() rather than a synthesized event: it runs the element's
					// full activation behavior, so a submit button submits its form
					// and a link follows its href, exactly as a mouse click would.
					(targetElement as HTMLElement).click();
					this.#render();
				}
			} else if (
				targetElement instanceof (this.window as any).HTMLSelectElement
			) {
				this.#handleSelectAction(
					targetElement as HTMLSelectElement,
					keyName,
					key,
				);
			}
		}

		// If keydown wasn't canceled and it's a printable character, dispatch keypress
		if (notCanceled && key.length === 1 && charCode >= 32 && charCode < 127) {
			const keypressEvent = new this.window.KeyboardEvent("keypress", {
				key: key,
				code: domCodeFor(key),
				keyCode: charCode,
				charCode: charCode,
				which: charCode,
				ctrlKey,
				shiftKey,
				altKey,
				metaKey,
				bubbles: true,
				cancelable: true,
			});
			targetElement.dispatchEvent(keypressEvent);
		}

		// Always dispatch keyup
		const keyupEvent = new this.window.KeyboardEvent("keyup", {
			key: keyName,
			code: domCodeFor(keyName),
			keyCode: keyCode,
			charCode: 0,
			which: keyCode,
			ctrlKey,
			shiftKey,
			altKey,
			metaKey,
			bubbles: true,
			cancelable: true,
		});
		targetElement.dispatchEvent(keyupEvent);
	}

	/**
	 * Render the whole document once, as plain lines, for a non-terminal stdout.
	 *
	 * There is no fold here, so there is nothing to commit, freeze or repair: the
	 * document is simply printed. Every hard problem in this file is a consequence
	 * of having a viewport, and a pipe does not have one.
	 */
	async #renderStatic(): Promise<void> {
		const pending = this[kObserver].takeRecords();
		if (pending.length > 0) {
			this.#handlePendingMutations(pending);
		}

		this.#renderedOutsideMarkers = new WeakSet<Element>();
		this[kLayoutEngine].calculateLayout();

		const output = this.#renderer.renderStatic(
			this.document.body.scrollHeight,
			(ctx) => {
				this.#painter.renderDocument(ctx);
			},
		);

		if (output) await this.#write(output);
		this.#afterRender();
	}

	/**
	 * Scroll the command start upward when the content outgrows the room below it.
	 *
	 * A TermDOM app behaves like an ordinary command: its output begins wherever
	 * the cursor was and flows down, and when it runs past the bottom of the
	 * terminal the earlier rows scroll off into the terminal's own scrollback.
	 * Emitting the newlines to make that happen is what keeps the output *in* the
	 * scrollback -- searchable, selectable, copy-pasteable -- rather than trapped
	 * in an alternate screen buffer.
	 *
	 * Without this, content past the bottom of the terminal is never drawn at
	 * all.
	 */
	/**
	 * Print the whole document to stdout, once, on the way out.
	 *
	 * Document mode never commits anything: it paints a window of the document into
	 * a region it owns and repaints it in place. That is what buys the mutability --
	 * nothing is frozen, because nothing was printed. But it means that at the
	 * moment we exit, the terminal has only ever *seen* the last frame.
	 *
	 * So we settle up. Erase the region we were painting -- our own viewport rows,
	 * with ED0; this is not the flicker sin, which is ED3 against the scrollback --
	 * and then print the document in full. It scrolls into the scrollback exactly as
	 * an ordinary command's output does, and the terminal ends up holding the whole
	 * thing: searchable, selectable, and still there tomorrow.
	 *
	 * The axis was never "do you get scrollback". It is *when you commit*: flow
	 * writes uneditable stdout as it goes, and document waits until the end.
	 *
	 * The cost of waiting is that a crash takes the output with it -- flow's partial
	 * output survives, because it was already printed.
	 */
	#flushDocument(): void {
		if (!this.#interactive) return;

		const contentHeight = this.document.body.scrollHeight;
		if (contentHeight === 0) return;

		const top = this.#screenTop;

		// Back to the top of our region, and erase from there down. Only rows we
		// painted ourselves; the scrollback above is untouched.
		this.#process.stdout.write(`\x1b[${top + 1};1H\x1b[J`);

		const output = this.#renderer.renderStatic(
			contentHeight,
			(ctx) => {
				this.#painter.renderDocument(ctx);
			},
			"\r\n",
		);

		if (output) this.#process.stdout.write(output);
	}

	/** Write to stdout and wait for it to be flushed. */
	#write(output: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.#process.stdout.write(output, "utf8", (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	/**
	 * Render a window of the document into a region we own.
	 *
	 * Document mode still starts at the command height: it does not seize the whole
	 * terminal, and it does not paint over what was on screen before us. If it needs
	 * more rows than are left below the command start, it *scrolls* the earlier
	 * content away into the scrollback, where it survives and the user can still
	 * reach it.
	 *
	 * Nothing of ours is committed. The document stays a single mutable thing
	 * that we repaint a window of: content that scrolls out of view is never
	 * frozen output, and reflow anywhere is free.
	 */
	async #renderInteractive(): Promise<void> {
		// The previous document was sealed to scrollback by close(). Start a fresh
		// one below it: re-anchor to where the cursor now sits and reset the diff so
		// nothing composites over the frozen block.
		if (this.#sealed) {
			this.#sealed = false;
			this.#documentScrollTop = 0;
			this.#renderer.clearPreviousBuffer();
			if (this.#process.stdin?.isTTY) await this.#detectCommandStart();
		}

		// Our region starts at the command-start row, which cursor detection resolves
		// asynchronously. Render before it lands and the first frame anchors at row 0
		// while every diff after detection anchors one row lower -- the labels stay,
		// the values slide down a row. Wait for the anchor to settle first, exactly
		// as the flow path does.
		if (this.#cursorDetectionPromise) {
			await this.#cursorDetectionPromise;
		}

		const pending = this[kObserver].takeRecords();
		if (pending.length > 0) {
			this.#handlePendingMutations(pending);
		}

		this.#renderedOutsideMarkers = new WeakSet<Element>();
		this[kLayoutEngine].calculateLayout();

		// The caret reveal an edit queued runs here, against the layout this
		// frame just flushed -- one camera decision per frame, however many
		// keystrokes coalesced into it. Skipped if focus has already moved
		// on: revealing a field the user left would yank the camera back.
		if (this.#pendingCaretReveal) {
			const reveal = this.#pendingCaretReveal;
			this.#pendingCaretReveal = null;
			if (reveal === this.document.activeElement) {
				this.#scrollCaretIntoView(reveal);
			}
		}

		// Fullscreen owns the WHOLE alternate screen from row zero: the
		// main screen's command anchor means nothing there, and reserveRows'
		// index-scrolls would scroll the alternate screen itself. The
		// document's scroll position survives untouched underneath -- the
		// fixed, Canvas-backed fullscreen element covers it regardless.
		const isFullscreen = this.#fullscreenManager.isFullscreen;
		const contentHeight = isFullscreen
			? this.#height
			: this.#painter.documentPaintHeight();
		const regionHeight = Math.min(contentHeight, this.#height);

		// Take the room we need by pushing earlier output up, never over it.
		const top = isFullscreen ? 0 : this.#reserveRows(regionHeight);

		if (!isFullscreen) {
			// The camera cannot run off the end of the document.
			const maxScroll = Math.max(0, contentHeight - regionHeight);
			this.#documentScrollTop = Math.min(this.#documentScrollTop, maxScroll);
		}

		const ansi = this.#renderer.renderFrame(
			-this.#documentScrollTop,
			(ctx) => {
				this.#painter.renderDocument(ctx);
			},
			top,
			top + regionHeight,
		);

		if (ansi) await this.#write(ansi);
		this.#afterRender();
	}

	/** Move the camera over the document. */
	#scrollCamera(rows: number): void {
		this.#documentScrollTop = Math.max(0, this.#documentScrollTop + rows);
		// A camera move is invisible to the MutationObserver; schedule the frame
		// it needs, the same way a DOM mutation would.
		void this.#render();
	}

	/**
	 * Make room for `rows` rows below the command start, *without painting over
	 * anything that was already on screen*.
	 *
	 * If there is not enough room between the command start and the bottom of the
	 * terminal, we scroll the terminal -- pushing the rows above into the
	 * scrollback, where they are preserved and the user can still reach them.
	 * Overwriting them in place would destroy the output of whatever ran before
	 * us; scrolling them away is what an ordinary command does when it prints.
	 *
	 * This positions the cursor at the bottom row (CUP) and sends IND (ESC D,
	 * Index -- "move down a line, scrolling if already at the bottom margin")
	 * `push` times. Two things this is deliberately NOT:
	 *
	 * - Not "print bare newlines at the bottom margin". Verified directly (a
	 *   real terminal via tmux, and the xterm-headless mock the test suite
	 *   runs against) that a bare LF only triggers a scroll when the cursor
	 *   reaches the bottom row through ordinary sequential output --
	 *   teleporting there with an absolute CUP first and then sending LF
	 *   leaves the screen completely unchanged in both.
	 * - Not CSI n S (Scroll Up), which scrolls the visible screen correctly in
	 *   both but -- verified directly -- does not add the scrolled-off rows to
	 *   xterm-headless's own scrollback history the way real terminal
	 *   scrolling does, which would make the "scrolled away, not destroyed"
	 *   half of this behavior untestable. IND scrolls identically but goes
	 *   through the same internal path as natural overflow, so it does.
	 *
	 * Returns the screen row our region now starts at.
	 */
	#reserveRows(rows: number): number {
		const top = this.#screenTop;
		const overflow = top + rows - this.#height;

		if (overflow <= 0) return top;

		const push = Math.min(overflow, top);
		if (push > 0) {
			this.#process.stdout.write(
				`\x1b[${this.#height};1H` + "\x1bD".repeat(push),
			);
			// Do NOT shift the renderer's previous buffer. Its rows are relative to
			// the region top, and the top moves up by exactly the amount the screen
			// scrolled -- the two cancel, so buffer coordinates are unchanged.
			// Shifting it desynced the diff by `push` rows: the model compared
			// against the wrong screen rows, skipped cells it wrongly believed
			// unchanged, and composited the old frame under the new one whenever a
			// document-mode region grew past the space below the shell prompt.
			this.#screenTop = top - push;
			// A pending post-resize screen reset IS screen-absolute, though, and
			// must ride the scroll (see shiftScreenReset).
			this.#renderer.shiftScreenReset(push);
		}

		return this.#screenTop;
	}

	/**
	 * Initialize cursor position detection for TTY environments
	 * This runs asynchronously during construction to set up proper viewport positioning
	 */
	#initializeCursorDetection(): void {
		this.#cursorDetectionPromise = null;
		// Only detect cursor position in TTY environments when enabled
		if (this.#detectCursorEnabled && this.#process.stdin?.isTTY) {
			// Set up cursor detection promise that render() will wait for
			this.#cursorDetectionPromise = Promise.race([
				this.#detectCommandStart().then(() => {}),
				// Fallback: if cursor detection takes too long, proceed without it
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
				.catch(() => {
					// If cursor detection fails, continue without it
					this.#hasDetectedCommandStart = false;
				})
				.finally(() => {
					// Clear the promise so subsequent renders don't wait
					this.#cursorDetectionPromise = null;
				});
		} else {
			// In non-TTY environments, don't set up cursor detection at all
			this.#cursorDetectionPromise = null;
		}
	}

	/**
	 * Settle who reorders bidirectional text, us or the terminal.
	 *
	 * ECMA-48 mode 8 (BDSM) has two sides: *implicit*, where the terminal runs
	 * the bidi algorithm over what it receives, and *explicit*, where the
	 * application decides the order and the terminal paints cells as given. We
	 * need explicit, and not by preference: this renderer addresses cells
	 * directly and diffs frames, so it hands the terminal single cells at
	 * absolute positions. A terminal reordering each of those against a line it
	 * was never given whole would scramble the frame. So we ask for explicit and
	 * then ask what we got (DECRQM), rather than assuming either.
	 *
	 * The answer is a DECRPM value: 0 means the terminal does not recognise the
	 * mode at all -- no bidi, cells land as written, which is the same contract
	 * explicit gives us. 2 or 4 confirm explicit. 1 or 3 mean it intends to
	 * reorder anyway, and 3 (permanently set) means our request was refused; in
	 * that case we stop reordering and emit logical order, because the terminal
	 * doing it once beats both of us doing it.
	 *
	 * Silence is the common case -- most terminals answer nothing at all -- and
	 * is treated as "no bidi", which is what silence has always meant here.
	 */
	/**
	 * Set a terminal mode and ask what it actually is now (DECRQM), resolving
	 * with the reported value -- or null if the terminal says nothing, which is
	 * the common case, since most implement no such mode and answer only the
	 * queries they know.
	 *
	 * The reply values are DECRPM's: 0 not recognised, 1 set, 2 reset, 3
	 * permanently set, 4 permanently reset. 0 and silence mean the same thing to
	 * every caller here -- the terminal has no opinion, so ours stands.
	 */
	#probeMode(mode: string, request: string): Promise<number | null> {
		return new Promise<number | null>((resolve) => {
			// The same second the cursor probe allows: a cold start or a slow SSH
			// link can outlast a tighter window, and answering late is answering.
			// Timers are tracked so dispose() can clear them -- a live one keeps
			// the event loop open, which across a test suite is fatal.
			const timer = setTimeout(() => {
				this.#modeProbeTimers.delete(timer);
				this.#modeProbeHandlers.delete(mode);
				resolve(null);
			}, 1000);
			this.#modeProbeTimers.add(timer);
			this.#modeProbeHandlers.set(mode, (value: number) => {
				clearTimeout(timer);
				this.#modeProbeTimers.delete(timer);
				resolve(value);
			});
			this.#process.stdout.write(request);
		});
	}

	async #negotiateBidi(): Promise<void> {
		if (!this.#interactive || !this.#process.stdin?.isTTY) return;

		// Explicit mode, then "what is mode 8 now?" in one write.
		const answer = await this.#probeMode("8", "\x1b[8l\x1b[8$p");

		if (answer === null || answer === 0) return; // No bidi: cells as written.
		this.#priorBidiMode = answer;

		// 1 = still set, 3 = permanently set. Either way it reorders regardless of
		// what we asked, so hand it text in the order it expects.
		if (answer === 1 || answer === 3) {
			this[kLayoutEngine].setTerminalReordersText(true);
		}
	}

	/**
	 * Ask the terminal to measure text in grapheme CLUSTERS rather than by code
	 * point (DEC private mode 2027, the terminal-unicode-core specification).
	 *
	 * The default a terminal implements is POSIX wcwidth, which is per code
	 * point and predates emoji: it cannot express that a ZWJ family sequence or
	 * an emoji with a variation selector is one indivisible unit, so it advances
	 * the cursor once per code point in them. We measure by cluster -- that is
	 * what stringWidth does -- so on such a terminal every cluster of more than
	 * one code point is a standing disagreement about where the next cell is.
	 *
	 * Mode 2027 is the fix the terminal community landed on, and it is asked for
	 * the same way as bidi: set it, then query it. A terminal that does not know
	 * the mode answers 0 or says nothing, and we simply carry on -- our
	 * measurements do not change, because they were already cluster-based; what
	 * changes is only whether the terminal agrees with them.
	 */
	async #negotiateGraphemeClusters(): Promise<void> {
		if (!this.#interactive || !this.#process.stdin?.isTTY) return;

		const answer = await this.#probeMode("?2027", "\x1b[?2027h\x1b[?2027$p");
		// 1 = set (it agrees now), 3 = permanently set (it always did).
		this.#graphemeClustersNegotiated = answer === 1 || answer === 3;
	}

	/**
	 * Detect current cursor position and set window.screenTop
	 * Sends \x1b[6n and waits for response \x1b[row;colR
	 */
	#detectCommandStart(): Promise<number> {
		this.attach();
		return new Promise<number>((resolve, reject) => {
			if (!this.#process.stdin?.isTTY) {
				reject(new Error("Cannot detect cursor position: stdin is not a TTY"));
				return;
			}

			let responseBuffer = "";

			const finish = () => {
				this.#cursorDetectionHandler = null;
				if (this.#cursorDetectionTimer !== null) {
					clearTimeout(this.#cursorDetectionTimer);
					this.#cursorDetectionTimer = null;
				}
			};

			// Set up cursor detection handler for unified stdin
			this.#cursorDetectionHandler = (dataStr: string) => {
				responseBuffer += dataStr;

				// Look for cursor position response pattern: \x1b[row;colR
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					finish();

					const row = parseInt(match[1], 10);
					// Set window.screenTop (convert 1-based terminal row to 0-based)
					const screenTop = row - 1;
					this.#screenTop = screenTop;

					// Set scrollTop to command start position (browser behavior)
					// For command start, we want content to shift up to terminal top
					this.#anchorScrollTop = -this.#screenTop;

					this.#hasDetectedCommandStart = true;
					resolve(row);
				}
			};

			// Send cursor position query with proper flushing
			this.#process.stdout.write("\x1b[6n");

			// Force flush the output buffer (critical for cursor queries)
			if (typeof (this.#process.stdout as any)._flush === "function") {
				(this.#process.stdout as any)._flush();
			}

			// Timeout after 1000ms (reasonable balance for reliability). The timer is
			// held so it can be cleared the moment a response arrives -- otherwise it
			// keeps the event loop alive for a further second after we are done.
			this.#cursorDetectionTimer = setTimeout(() => {
				this.#cursorDetectionTimer = null;
				if (this.#cursorDetectionHandler) {
					this.#cursorDetectionHandler = null;
					reject(new Error("Timeout waiting for cursor position response"));
				}
			}, 1000);
		});
	}

	/**
	 * Ask the terminal where the cursor is (DSR) and resolve with its 0-based row.
	 *
	 * Used by the resize re-anchor: the cursor is parked on our content's bottom
	 * row after every frame, so after a rewrap its position names where the frame
	 * actually ended up. Rejects on timeout so the caller can fall back to a
	 * computed anchor.
	 */
	#queryCursorRow(): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			if (!this.#process.stdin?.isTTY) {
				reject(new Error("stdin is not a TTY"));
				return;
			}

			// Queries can overlap: a drag fires resizes faster than the terminal
			// answers, and each handleResize issues its own query. The handler and
			// timer live in shared instance slots (so stdin routing and dispose can
			// see them), so every cleanup must check identity before clearing --
			// otherwise a superseded query's cleanup kills its successor's handler
			// and timeout, and that resize never redraws at all.
			let responseBuffer = "";
			let localTimer: ReturnType<typeof setTimeout> | null = null;

			const handler = (dataStr: string) => {
				responseBuffer += dataStr;
				const match = responseBuffer.match(/\x1b\[(\d+);(\d+)R/);
				if (match) {
					if (this.#cursorDetectionHandler === handler) {
						this.#cursorDetectionHandler = null;
					}
					if (localTimer !== null) {
						clearTimeout(localTimer);
						if (this.#cursorDetectionTimer === localTimer) {
							this.#cursorDetectionTimer = null;
						}
						localTimer = null;
					}
					resolve(parseInt(match[1], 10) - 1);
				}
			};

			// Replacing a stale handler is fine: its own timeout still fires and
			// rejects it, and the caller's epoch check discards the stale result.
			this.#cursorDetectionHandler = handler;

			this.#process.stdout.write("\x1b[6n");
			if (typeof (this.#process.stdout as any)._flush === "function") {
				(this.#process.stdout as any)._flush();
			}

			// Short timeout: the redraw should feel immediate, and a terminal that
			// does not answer promptly falls back to the computed re-anchor.
			localTimer = setTimeout(() => {
				if (this.#cursorDetectionHandler === handler) {
					this.#cursorDetectionHandler = null;
				}
				if (this.#cursorDetectionTimer === localTimer) {
					this.#cursorDetectionTimer = null;
				}
				localTimer = null;
				reject(new Error("Timeout waiting for cursor position response"));
			}, 200);
			this.#cursorDetectionTimer = localTimer;
		});
	}

	/** Explicit resource management: `using dom = new TermDOM()` tears down on scope exit. */
	[Symbol.dispose](): void {
		this.dispose();
	}

	dispose(): void {
		undisposedInteractive.delete(this.#process);
		this.#attached = false;

		// Document mode has been painting a window in place, so nothing it showed
		// has reached the terminal's scrollback. Pay it all out now.
		this.#flushDocument();

		// Frames keep the terminal cursor hidden (it is parked for resize
		// bookkeeping, not UI); hand it back visible on the way out. The mouse
		// goes back to the terminal the same way.
		if (this.#mouseReportingEnabled) {
			this.#process.stdout.write("\x1b[?1006l\x1b[?1002l");
			this.#mouseReportingEnabled = false;
		}
		if (this.#interactive) {
			this.#process.stdout.write("\x1b[?25h");
		}
		// We asked for explicit bidi on the way in; give the terminal back the
		// mode it reported, so the next command inherits its own settings rather
		// than ours. Only when it was SET -- reset is where we left it anyway.
		if (this.#priorBidiMode === 1) {
			this.#process.stdout.write("\x1b[8h");
			this.#priorBidiMode = null;
		}
		// Mode 2027 likewise: we turned it on, so turn it off. A terminal that
		// never had it does not see this, having answered nothing.
		if (this.#graphemeClustersNegotiated) {
			this.#process.stdout.write("\x1b[?2027l");
			this.#graphemeClustersNegotiated = false;
		}

		// Tear down everything that holds the event loop open. Without this a
		// disposed TermDOM keeps the process alive -- via the process signal
		// listeners, the stdin data listener, and the cursor-detection timer -- and
		// across a whole test suite those accumulate until nothing can exit.
		for (const timer of this.#modeProbeTimers) clearTimeout(timer);
		this.#modeProbeTimers.clear();
		this.#modeProbeHandlers.clear();
		if (this.#cursorDetectionTimer !== null) {
			clearTimeout(this.#cursorDetectionTimer);
			this.#cursorDetectionTimer = null;
		}
		if (this.#resizeTimer !== null) {
			clearTimeout(this.#resizeTimer);
			this.#resizeTimer = null;
		}
		if (this.#scrollChainTimer !== null) {
			clearTimeout(this.#scrollChainTimer);
			this.#scrollChainTimer = null;
		}
		this.#cursorDetectionHandler = null;

		if (this.#sigintHandler) {
			(this.#process as unknown as EventEmitter).removeListener?.(
				"SIGINT",
				this.#sigintHandler,
			);
			this.#sigintHandler = null;
		}
		if (this.#sigwinchHandler) {
			(this.#process as unknown as EventEmitter).removeListener?.(
				"SIGWINCH",
				this.#sigwinchHandler,
			);
			this.#sigwinchHandler = null;
		}

		if (this.#process.stdin?.isTTY) {
			const stdin = this.#process.stdin as TTYReadStream;
			if (this.#stdinDataHandler) {
				stdin.removeListener?.("data", this.#stdinDataHandler);
				this.#stdinDataHandler = null;
			}
			stdin.setRawMode?.(false);
			stdin.pause();
		}

		// Shadow DOM cleanup is automatic with symbol-based storage

		this[kObserver].disconnect();
		this.#styleManager.dispose();
		this[kLayoutEngine].dispose();
		this.#fullscreenManager.dispose();
		this.#observerManager.dispose();
		this.#jsdom.window.close();
	}
}
