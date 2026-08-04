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
import {createUAShadowRoot} from "./composition.js";
import {type LayoutEngine, visualToDataOffsets} from "./layout.js";
import {type StyleManager, getBoxModel} from "./styles.js";
import {stringWidth} from "./runtime.js";

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

/** The UA custom-element interface a <textarea> presents once upgraded. */
export interface UATextareaElement extends HTMLTextAreaElement {
	/** Reconcile the UA tree with the element's own value/placeholder state. */
	uaReconcile(): void;
	/** The painted visual lines of the laid-out value; null before first layout. */
	uaVisualLines(): {value: string; lines: TextareaVisualLine[]} | null;
	/** Caret cell for the focused textarea, in document coordinates. */
	uaCaretCell(): {x: number; y: number} | null;
	/** Caret offset one visual line up (-1) or down (+1), keeping the column. */
	uaVerticalTarget(caret: number, direction: 1 | -1): number;
	/** Forget the goal column, so the next vertical move starts a fresh one. */
	uaClearGoalColumn(): void;
	/** The value part span, whose computed style the selection paint reads. */
	readonly uaValueSpan: HTMLElement;
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
		#valueSpan!: HTMLElement;
		#goalColumn: number | null = null;

		/**
		 * Build the UA-internal shadow tree. The root IS observer-enrolled --
		 * enrolled BEFORE it is populated, so the population itself is the
		 * invalidation that swaps the composed tree in -- because the value text
		 * lays out through the normal pipeline and layout must hear about every
		 * change to it.
		 */
		connectedCallback(): void {
			if (this.#valueText) return; // Re-connect: tree already built.
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
			this.#valueSpan = this.#addPart(root, "value");
			this.#valueText = this.#valueSpan.firstChild as Text;
			this.#placeholderSpan = this.#addPart(root, "placeholder");
			this.#placeholderText = this.#placeholderSpan.firstChild as Text;
			// The trailing <br> anchor, the same trick a browser's editor uses:
			// it makes the run's content always end in exactly one line break, so
			// the line count equals the LOGICAL line count -- the breaker never
			// emits a line after a final newline, and without the anchor a value
			// ending in "\n" measured one row short, parking the caret on the
			// bottom border.
			root.appendChild(document.createElement("br"));

			this.uaReconcile();
		}

		attributeChangedCallback(): void {
			if (this.#valueText) this.uaReconcile();
		}

		#addPart(root: ShadowRoot, part: string): HTMLElement {
			const span = document.createElement("span");
			span.setAttribute("part", part);
			span.appendChild(document.createTextNode(""));
			root.appendChild(span);
			return span;
		}

		get uaValueSpan(): HTMLElement {
			return this.#valueSpan;
		}

		/**
		 * Reconcile the UA tree with the element's own state -- the single
		 * source of truth. Placeholder visibility is real CSS (an inline
		 * display:none), not painter logic: the normal pipeline then simply
		 * never sees it.
		 */
		uaReconcile(): void {
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
		}

		/**
		 * The VISUAL lines of the laid-out value: the painted fragments (one per
		 * soft-wrapped or hard-broken line), plus a virtual empty line for each
		 * trailing newline past the last visual character (typing Enter at the
		 * end must park the caret on the new, still-empty line, which owns no
		 * fragment). Offsets are code units into .value; geometry is document
		 * cells. Null before the value has ever laid out.
		 */
		uaVisualLines(): {value: string; lines: TextareaVisualLine[]} | null {
			const valueText = this.#valueText;
			const value = valueText.data;
			const rect = this.getBoundingClientRect();
			const boxModel = getBoxModel(this);
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
			// Blank lines between consecutive newlines own real, EMPTY layout
			// fragments -- no visual characters, so visToData can't place them. A
			// cursor over the value's own structure does: each line consumes its
			// characters plus, when the character at its end is a newline, that
			// one hard separator (soft wraps have no separator to consume).
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
			// virtual lines here is what once drifted the caret a row per blank
			// line.)
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

		uaCaretCell(): {x: number; y: number} | null {
			const visual = this.uaVisualLines();
			if (!visual) return null;
			const caret =
				this.selectionDirection === "backward"
					? (this.selectionStart ?? visual.value.length)
					: (this.selectionEnd ?? visual.value.length);
			const lineIndex = textareaLineAt(visual.lines, caret);
			const line = visual.lines[lineIndex];
			const within = Math.max(
				0,
				Math.min(caret, line.endOffset) - line.startOffset,
			);
			return {x: line.x + stringWidth(line.text.slice(0, within)), y: line.y};
		}

		uaClearGoalColumn(): void {
			this.#goalColumn = null;
		}

		/**
		 * The caret offset one visual line up or down from `caret`, keeping the
		 * column (in cells) where the target line allows -- soft wraps count as
		 * lines, exactly as in a browser. First line up collapses to 0, last
		 * line down to the end.
		 */
		uaVerticalTarget(caret: number, direction: 1 | -1): number {
			const visual = this.uaVisualLines();
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

	// The registry stores each definition once it is defined; fetch ours so the
	// upgrade can hand it straight to the reactions algorithm without a name
	// lookup (the built-in lookup only matches on an author `is=`, which a plain
	// control never has).
	const registryImpl = jsdomUtils.implForWrapper(
		(window as unknown as {_customElementRegistry: object})
			._customElementRegistry,
	) as {_customElementDefinitions: Array<{name: string}>};
	const definitions = new Map<string, unknown>();
	for (const localName of ["ua-textarea"]) {
		definitions.set(
			localName,
			registryImpl._customElementDefinitions.find((d) => d.name === localName),
		);
	}

	const UPGRADE_BY_TAG: Record<string, string | undefined> = {
		TEXTAREA: "ua-textarea",
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
