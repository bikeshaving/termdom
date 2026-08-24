/**
 * The input layer's policy half: which element a decoded stroke or click
 * belongs to. What the bytes mean is wire's; constructing the DOM events and
 * dispatching them belongs to the engine, because that half is the render loop.
 */

import type {UAToolkit} from "./dom.js";
import type {LayoutEngine} from "./layout.js";
import {computedStyleOf} from "./cascade.js";

// What Tab traverses and what a mousedown focuses -- one definition of
// "focusable" for both.
//
// `a[href]` is in the list because an anchor WITH an href is focusable and
// sequentially reachable per HTML, and an anchor without one is not -- the
// attribute qualifier draws that line for free. Leaving links out made
// navigation link-shaped UI (TodoMVC's All/Active/Completed filters) reachable
// only by mouse.
export const FOCUSABLE_SELECTOR =
	'a[href], input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

/** What a slot looks like from a module that must not import DOM classes. */
interface SlotLike extends Element {
	assignedNodes(): Node[];
}

interface ShadowRootLike {
	children: ArrayLike<Element> & Iterable<Element>;
	delegatesFocus?: boolean;
}

/**
 * One entry in a focus navigation scope: a single element, or a scope
 * owner standing for its whole expanded scope. The owner's tabindex
 * positions the entry among its siblings; the expansion is already in
 * its own scope's order.
 */
interface ScopeEntry {
	tabindex: number;
	sequence: number;
	elements: SequentialEntry[];
}

/**
 * One stop in the sequential order. `barrier` names the nearest scope
 * owner with a negative tabindex above it, if any: such a stop cannot be
 * tabbed into from outside, but focus scripted inside the owner's scope
 * still navigates among stops sharing the barrier and exits past it.
 */
export interface SequentialEntry {
	element: Element;
	barrier: Element | null;
}

function tabindexOf(element: Element): number {
	const parsed = parseInt(element.getAttribute("tabindex") || "0", 10);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Every sequential focus stop under a root, barred ones included, in
 * scoped tab order.
 */
export function sequentialFocusEntries(
	root: Document | Element,
	layoutEngine: LayoutEngine,
	toolkit: UAToolkit,
): SequentialEntry[] {
	const isRendered = (element: Element): boolean => {
		// Browsers keep unrendered elements out of tab order: a hidden
		// edit-row checkbox must not swallow a Tab press invisibly. An
		// element is rendered when nothing on its flat-tree chain is
		// display:none and it produced boxes.
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = toolkit.flatParentElement<Element>(ancestor)
		) {
			if (computedStyleOf(ancestor).computedValueOf("display") === "none") {
				return false;
			}
		}
		try {
			return layoutEngine.getRects(element).length > 0;
		} catch (_err) {
			return false;
		}
	};
	const isInert = (element: Element): boolean => {
		for (
			let ancestor: Element | null = element;
			ancestor;
			ancestor = toolkit.flatParentElement<Element>(ancestor)
		) {
			if (ancestor.hasAttribute("inert")) {
				return true;
			}
		}
		return false;
	};
	const isFocusable = (element: Element): boolean =>
		element.matches(FOCUSABLE_SELECTOR) &&
		tabindexOf(element) >= 0 &&
		!isInert(element) &&
		isRendered(element);

	const buildScope = (
		contents: Iterable<Node>,
		barrier: Element | null,
	): SequentialEntry[] => {
		const entries: ScopeEntry[] = [];
		let sequence = 0;
		const push = (tabindex: number, elements: SequentialEntry[]): void => {
			if (elements.length > 0) {
				entries.push({tabindex, sequence: sequence++, elements});
			}
		};
		const visit = (node: Node): void => {
			if (node.nodeType !== 1) {
				return;
			}
			const element = node as Element;
			const ownerTabindex = tabindexOf(element);
			const shadow = toolkit.shadowRootOf(element) as
				| ShadowRootLike |
				null;
			if (shadow !== null) {
				// A negative tabindex on the owner bars the whole expansion
				// from outside entry; inside it, order still holds.
				const innerBarrier =
					ownerTabindex < 0 ? (barrier ?? element) : barrier;
				// The host's light children surface through the shadow's
				// slots or nowhere; they are not this scope's to walk.
				const inner = buildScope(shadow.children, innerBarrier);
				let expansion = inner;
				if (shadow.delegatesFocus !== true && isFocusable(element)) {
					expansion = [{element, barrier}, ...inner];
				}
				push(ownerTabindex, expansion);
				return;
			}
			if (element.localName === "slot") {
				const innerBarrier =
					ownerTabindex < 0 ? (barrier ?? element) : barrier;
				const assigned = (element as SlotLike).assignedNodes();
				const slotContents =
					assigned.length > 0 ? assigned : element.childNodes;
				const inner = buildScope(
					slotContents as Iterable<Node>,
					innerBarrier,
				);
				const expansion = isFocusable(element) ?
						[{element, barrier}, ...inner] :
					inner;
				push(ownerTabindex, expansion);
				return;
			}
			if (isFocusable(element)) {
				push(ownerTabindex, [{element, barrier}]);
			}
			for (const child of element.children) {
				visit(child);
			}
		};
		for (const node of contents) {
			visit(node);
		}
		entries.sort((a, b) => {
			const aTab = a.tabindex > 0 ? a.tabindex : Infinity;
			const bTab = b.tabindex > 0 ? b.tabindex : Infinity;
			if (aTab !== bTab) {
				return aTab - bTab;
			}
			return a.sequence - b.sequence;
		});
		return entries.flatMap((entry) => entry.elements);
	};

	const roots =
		root.nodeType === 9 ?
				((root as Document).documentElement ?
						[(root as Document).documentElement as Element] :
						[]) :
				Array.from((root as Element).children);
	return buildScope(roots, null);
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
export function focusAutofocusedNodes(mutations: MutationRecord[]): void {
	for (const record of mutations) {
		for (const node of record.addedNodes) {
			if (node.nodeType !== node.ELEMENT_NODE) {
				continue;
			}
			const element = node as Element;
			const candidate = (element as any).autofocus ?
				element :
					element.querySelector("[autofocus]");
			(candidate as HTMLElement | null)?.focus();
		}
	}
}

/** Input types that are buttons rather than fields. */
const BUTTON_INPUT_TYPES = new Set(["button", "image", "reset", "submit"]);

/**
 * Does a keypress on this element activate it, the way a click would?
 *
 * Buttons do, on Enter and on Space. Links do, on Enter only -- Space scrolls
 * the page in a browser rather than following the link, and the difference is
 * observable enough to be worth keeping.
 */
export function keyboardActivation(
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
	// A summary activates on both keys, and activation is what opens the
	// disclosure; whether this summary is its details' summary is the
	// activation behavior's own question.
	if (tag === "SUMMARY") {
		return {enter: true, space: true};
	}
	return null;
}
