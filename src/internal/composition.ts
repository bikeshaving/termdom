/**
 * DOM Composition System for Terminal DOM
 *
 * This module provides unified handling of DOM composition including:
 * - Shadow DOM traversal and utilities
 * - Pseudo-element attachment and traversal
 * - Extended TreeWalker for composed tree navigation
 * - All symbols and utilities for DOM composition
 */

import type {DOMWindow} from "jsdom";
import {computedStyleOf} from "./styles.js";

// Symbols for storing pseudo-elements and shadow roots on nodes
export const SHADOW_ROOT_SYMBOL = Symbol.for("TermDOM.shadowRoot");

/**
 * The flat tree is DERIVED -- jsdom maintains only the raw tree plus slot
 * assignment. Upward links (flat parent, flat box parent) are memoized per
 * node behind one epoch, dropped by anything that can move a node: a
 * mutation batch, a style invalidation (display: contents changes the box
 * parent), or this module's own attachments.
 *
 * Only UPWARD links are safe to cache: a child-list change makes new nodes
 * (misses) and removes old ones (never asked again), but cannot change a
 * surviving node's parent without a record from an enrolled root or a call
 * through this module.
 */
interface CompositionLinks {
	epoch: number;
	parent: Element | null;
	hasParent: boolean;
	boxParent: Element | null;
	hasBoxParent: boolean;
}
const linkCache = new WeakMap<Node, CompositionLinks>();
let compositionEpoch = 0;
let structuralGeneration = 0;

/** Drop every memoized flat-tree link; cheap, and correctness's big hammer. */
export function invalidateComposition(): void {
	compositionEpoch++;
}

/**
 * An UNBOUNDED invalidation: a stylesheet reparse, a shadow attachment, a
 * pseudo-element change, the bidi reorder flip -- damage no per-element
 * tracking can bound. Bumps the memo epoch too. Bounded damage (mutation
 * records, per-element style invalidation) is tracked by the engine and
 * does not come through here.
 */
export function invalidateStructure(): void {
	structuralGeneration++;
	compositionEpoch++;
}

export function currentStructuralGeneration(): number {
	return structuralGeneration;
}

/**
 * The current invalidation epoch: bumped by everything that can change
 * what a frame looks like.
 */
export function currentCompositionEpoch(): number {
	return compositionEpoch;
}

/**
 * The FLAT-TREE parent element of a node: the element it renders inside,
 * which is also the element style inheritance flows from. Three cases
 * diverge from parentElement: a projected node's flat parent is its SLOT
 * (inherited properties reach slotted content through the shadow chrome it
 * lands in, per spec); a shadow root's direct child resolves to the HOST
 * (node.parentElement is null there -- a ShadowRoot is not an Element);
 * everything else is just parentElement.
 */
export function compositionParentElement(node: Node): Element | null {
	let links = linkCache.get(node);
	if (links && links.epoch === compositionEpoch && links.hasParent) {
		return links.parent;
	}
	const parent = uncachedCompositionParentElement(node);
	if (!links || links.epoch !== compositionEpoch) {
		links = {
			epoch: compositionEpoch,
			parent: null,
			hasParent: false,
			boxParent: null,
			hasBoxParent: false,
		};
		linkCache.set(node, links);
	}
	links.parent = parent;
	links.hasParent = true;
	return parent;
}

function uncachedCompositionParentElement(node: Node): Element | null {
	const slot = assignedSlotOf(node);
	if (slot) return slot;
	if (node.parentElement) return node.parentElement;
	const parent = node.parentNode;
	if (parent && parent.nodeType === 11 && (parent as ShadowRoot).host) {
		return (parent as ShadowRoot).host;
	}
	return null;
}

/**
 * The flat-tree BOX parent: like compositionParentElement, but skipping
 * `display: contents` elements (slots, chiefly), which inherit styles but
 * generate no box. Layout wants this one -- a projected node's box lives
 * under the slot's own box parent, and rooting an inline-run walk at the
 * slot would truncate the run at the slot's edge.
 */
export function compositionBoxParentElement(node: Node): Element | null {
	const links = linkCache.get(node);
	if (links && links.epoch === compositionEpoch && links.hasBoxParent) {
		return links.boxParent;
	}
	let parent = compositionParentElement(node);
	while (parent) {
		const window = parent.ownerDocument?.defaultView;
		if (
			!window ||
			computedStyleOf(parent).getPropertyValue("display") !== "contents"
		) {
			break;
		}
		parent = compositionParentElement(parent);
	}
	// compositionParentElement above ensured a current-epoch entry exists.
	const current = linkCache.get(node)!;
	current.boxParent = parent;
	current.hasBoxParent = true;
	return parent;
}
export const PSEUDO_ELEMENTS_SYMBOL = Symbol.for("TermDOM.pseudoElements");
export const PSEUDO_METADATA_SYMBOL = Symbol.for("TermDOM.pseudoMetadata");

/**
 * The shadow root an element renders, whichever mechanism attached it: the
 * symbol slot is the UA-INTERNAL tree (closed to DOM APIs, like a browser
 * input's internals -- element.shadowRoot never exposes it), native
 * attachShadow() is the AUTHOR tree. UA wins when both exist.
 */
export function compositionShadowRoot(element: Element): ShadowRoot | null {
	return (element as any)[SHADOW_ROOT_SYMBOL] || element.shadowRoot || null;
}

/**
 * The value part's text node inside a form control's UA shadow, or null before
 * the shadow is built. A composed-tree query -- the control's editable text
 * lives at its `[part="value"]`, reached through the closed UA shadow the way a
 * browser's own editing internals reach it. The renderer reads it to place the
 * caret; the editing path to hit-test a point.
 */
export function fieldValueText(field: Element): Text | null {
	const span = compositionShadowRoot(field)?.querySelector('[part="value"]');
	return (span?.firstChild as Text) ?? null;
}

/**
 * A collapsed Range at a focused control's caret, inside that value text. Its
 * geometry is then whatever the layout already placed the offset at (read via
 * `Range` / `getRangeRects`) -- no bespoke caret walk. Backward selections carry
 * the caret at the start, forward ones at the end, matching the DOM.
 */
export function fieldCaretRange(
	field: HTMLInputElement | HTMLTextAreaElement,
): Range | null {
	const valueText = fieldValueText(field);
	if (!valueText) return null;
	const caret =
		field.selectionDirection === "backward"
			? (field.selectionStart ?? valueText.data.length)
			: (field.selectionEnd ?? valueText.data.length);
	const range = field.ownerDocument.createRange();
	range.setStart(
		valueText,
		Math.max(0, Math.min(caret, valueText.data.length)),
	);
	range.collapse(true);
	return range;
}

/**
 * Connectivity through the COMPOSED tree: a UA-internal shadow root is a
 * DocumentFragment, so its children are never "connected" in the DOM
 * sense even while the host renders on screen -- isConnected alone would
 * gate every UA part out of the inline-run machinery. A node is
 * composition-connected when its own tree reaches the document, or its
 * root is a shadow root whose host does.
 */
export function compositionIsConnected(node: Node): boolean {
	if (node.isConnected) return true;
	const root = node.getRootNode();
	if (root.nodeType === 11 && (root as ShadowRoot).host) {
		return compositionIsConnected((root as ShadowRoot).host);
	}
	return false;
}

/**
 * The slot a node is assigned to, if any. Projection rides on jsdom's live
 * slot assignment (per spec: Element.assignedSlot / Text.assignedSlot),
 * not on any cached mapping of our own -- the walker stays stateless. Only
 * elements and text can be assigned; everything else navigates normally.
 */
function assignedSlotOf(node: Node): HTMLSlotElement | null {
	if (node.nodeType === node.ELEMENT_NODE || node.nodeType === node.TEXT_NODE) {
		return (node as Element | Text).assignedSlot ?? null;
	}
	return null;
}

/**
 * Extended TreeWalker implementation based on W3C spec with support for
 * pseudo-elements, shadow DOM, and slot content traversal
 */
export class ExpandedTreeWalker {
	// TypeScript declarations only
	declare readonly root: Node;
	currentNode: Node;
	#window!: DOMWindow;

	// Private fields (defined in constructor)
	constructor(window: DOMWindow, root: Node) {
		// Define readonly properties
		Object.defineProperty(this, "root", {
			value: root,
			writable: false,
			enumerable: true,
		});

		// Initialize properties
		this.currentNode = root;
		this.#window = window;
	}

	/**
	 * Move to the next node in document order, including extended content
	 */
	nextNode(): Node | null {
		let node = this.currentNode;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			// Try to get first child (including extended children)
			const firstChild = this.#getFirstChild(node);
			if (firstChild && this.#acceptNode(firstChild)) {
				this.currentNode = firstChild;
				return firstChild;
			}
			if (firstChild) {
				node = firstChild;
				continue;
			}

			// A walker rooted at a node never visits that node's siblings. If we are
			// back at the root with no children to descend into, the subtree is
			// exhausted -- returning the root's sibling here would escape it, which is
			// how an empty inline element ended up measuring its next sibling's width.
			if (node === this.root) {
				return null;
			}

			// Try to get next sibling (including extended siblings)
			const nextSibling = this.#getNextSibling(node);
			if (nextSibling && this.#acceptNode(nextSibling)) {
				this.currentNode = nextSibling;
				return nextSibling;
			}
			if (nextSibling) {
				node = nextSibling;
				continue;
			}

			// Walk up to parent and try their next sibling
			let parent = this.#getParent(node);
			while (parent && parent !== this.root) {
				// Before trying parent's next sibling, check if parent element has ::after
				if (parent.nodeType === parent.ELEMENT_NODE) {
					const afterElement = this.#getPseudoElement(
						parent as Element,
						"::after",
					);
					if (afterElement) {
						// Check if we're at the end of parent's extended content
						if (this.#isLastExtendedChild(node, parent as Element)) {
							if (this.#acceptNode(afterElement)) {
								this.currentNode = afterElement;
								return afterElement;
							}
							node = afterElement;
							continue;
						}
					}
				}

				const parentNextSibling = this.#getNextSibling(parent);
				if (parentNextSibling) {
					if (this.#acceptNode(parentNextSibling)) {
						this.currentNode = parentNextSibling;
						return parentNextSibling;
					}
					node = parentNextSibling;
					break;
				}
				parent = this.#getParent(parent);
			}

			// If we're back at root or beyond, we're done
			if (!parent || parent === this.root) {
				return null;
			}
		}
	}

	/**
	 * Move to the previous node in document order
	 */
	previousNode(): Node | null {
		let node = this.currentNode;

		if (node === this.root) {
			return null;
		}

		// eslint-disable-next-line no-constant-condition
		while (true) {
			// Try to get previous sibling
			const previousSibling = this.#getPreviousSibling(node);
			if (previousSibling) {
				// Get the last descendant of the previous sibling
				let lastDescendant = this.#getLastDescendant(previousSibling);
				if (this.#acceptNode(lastDescendant)) {
					this.currentNode = lastDescendant;
					return lastDescendant;
				}
				node = lastDescendant;
				continue;
			}

			// Move to parent
			const parent = this.#getParent(node);
			if (parent) {
				if (this.#acceptNode(parent)) {
					this.currentNode = parent;
					return parent;
				}
				// Don't continue beyond root
				if (parent === this.root) {
					return null;
				}
				node = parent;
				continue;
			}

			return null;
		}
	}

	/**
	 * Move to parent node
	 */
	parentNode(): Node | null {
		let node: Node | null = this.currentNode;

		while (node && node !== this.root) {
			const parent = this.#getParent(node);
			if (parent && this.#acceptNode(parent)) {
				this.currentNode = parent;
				return parent;
			}
			node = parent;
		}

		return null;
	}

	/**
	 * Move to first child
	 */
	firstChild(): Node | null {
		let child = this.#getFirstChild(this.currentNode);
		// Skip rejected nodes (comments, processing instructions) rather than
		// halting: a rejected first child must not hide the accepted siblings
		// behind it, which is FILTER_SKIP, the DOM TreeWalker default.
		while (child && !this.#acceptNode(child)) {
			child = this.#getNextSibling(child);
		}
		if (child) {
			this.currentNode = child;
			return child;
		}
		return null;
	}

	/**
	 * Move to last child
	 */
	lastChild(): Node | null {
		let child = this.#getLastChild(this.currentNode);
		while (child && !this.#acceptNode(child)) {
			child = this.#getPreviousSibling(child);
		}
		if (child) {
			this.currentNode = child;
			return child;
		}
		return null;
	}

	/**
	 * Move to next sibling. Per the TreeWalker spec's traverse-siblings
	 * algorithm, the root has no siblings within the walk: same guard as
	 * nextNode's, for the same reason -- returning the root's DOM sibling
	 * escapes the subtree the walker was scoped to. (Concretely: an
	 * inline-block flex item is its own inline-run head, and collecting its
	 * leaves ends with a nextSibling() skip -- without this guard that
	 * "skip" walked out of the item and swallowed the next flex item's text
	 * into its measurement.)
	 */
	nextSibling(): Node | null {
		if (this.currentNode === this.root) {
			return null;
		}
		let sibling = this.#getNextSibling(this.currentNode);
		while (sibling && !this.#acceptNode(sibling)) {
			sibling = this.#getNextSibling(sibling);
		}
		if (sibling) {
			this.currentNode = sibling;
			return sibling;
		}
		return null;
	}

	/**
	 * Move to previous sibling. Root-guarded like nextSibling, per spec.
	 */
	previousSibling(): Node | null {
		if (this.currentNode === this.root) {
			return null;
		}
		let sibling = this.#getPreviousSibling(this.currentNode);
		while (sibling && !this.#acceptNode(sibling)) {
			sibling = this.#getPreviousSibling(sibling);
		}
		if (sibling) {
			this.currentNode = sibling;
			return sibling;
		}
		return null;
	}

	// Flat-tree navigation: the raw hops below produce the composed tree
	// (pseudos, shadow roots, slot projection); this layer additionally
	// dissolves `display: contents` elements -- they participate in
	// composition and inheritance but generate no box, so traversal splices
	// their children into the parent's child sequence. This is how <slot>
	// disappears from layout (UA default `slot { display: contents }`, as in
	// browsers) while its projected content flows through.

	#isContents(node: Node): boolean {
		if (node.nodeType !== node.ELEMENT_NODE) return false;
		return (
			computedStyleOf(node as Element).getPropertyValue("display") ===
			"contents"
		);
	}

	/**
	 * The first box-tree node at `node`'s position in flat order: `node`
	 * itself unless it is a contents element, in which case its first
	 * flattened descendant (or null if it has none).
	 */
	#flatHead(node: Node): Node | null {
		if (!this.#isContents(node)) return node;
		for (
			let child = this.#rawFirstChild(node);
			child;
			child = this.#rawNextSibling(child)
		) {
			const head = this.#flatHead(child);
			if (head) return head;
		}
		return null;
	}

	/** Mirror of #flatHead: the last box-tree node at `node`'s position. */
	#flatTail(node: Node): Node | null {
		if (!this.#isContents(node)) return node;
		for (
			let child = this.#rawLastChild(node);
			child;
			child = this.#rawPreviousSibling(child)
		) {
			const tail = this.#flatTail(child);
			if (tail) return tail;
		}
		return null;
	}

	#getFirstChild(node: Node): Node | null {
		for (
			let child = this.#rawFirstChild(node);
			child;
			child = this.#rawNextSibling(child)
		) {
			const head = this.#flatHead(child);
			if (head) return head;
		}
		return null;
	}

	#getLastChild(node: Node): Node | null {
		for (
			let child = this.#rawLastChild(node);
			child;
			child = this.#rawPreviousSibling(child)
		) {
			const tail = this.#flatTail(child);
			if (tail) return tail;
		}
		return null;
	}

	#getNextSibling(node: Node): Node | null {
		let current: Node = node;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			for (
				let sibling = this.#rawNextSibling(current);
				sibling;
				sibling = this.#rawNextSibling(sibling)
			) {
				const head = this.#flatHead(sibling);
				if (head) return head;
			}
			// Out of raw siblings: if the raw parent is a contents element, its
			// siblings continue the flattened sequence.
			const parent = this.#rawParent(current);
			if (parent && this.#isContents(parent)) {
				current = parent;
				continue;
			}
			return null;
		}
	}

	#getPreviousSibling(node: Node): Node | null {
		let current: Node = node;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			for (
				let sibling = this.#rawPreviousSibling(current);
				sibling;
				sibling = this.#rawPreviousSibling(sibling)
			) {
				const tail = this.#flatTail(sibling);
				if (tail) return tail;
			}
			const parent = this.#rawParent(current);
			if (parent && this.#isContents(parent)) {
				current = parent;
				continue;
			}
			return null;
		}
	}

	#getParent(node: Node): Node | null {
		let parent = this.#rawParent(node);
		while (parent && this.#isContents(parent)) {
			parent = this.#rawParent(parent);
		}
		return parent;
	}

	// Extended DOM navigation methods that understand pseudo-elements, shadow DOM, and slots

	/**
	 * Get expanded first child including pseudo-elements and shadow content
	 */
	#rawFirstChild(node: Node): Node | null {
		if (node.nodeType !== node.ELEMENT_NODE) {
			return node.firstChild;
		}

		const element = node as Element;

		// Check for ::marker pseudo-element first (document order, only on elements with display: list-item)
		if (this.#hasListItemDisplay(element)) {
			const markerElement = this.#getPseudoElement(element, "::marker");
			if (markerElement) {
				return markerElement;
			}
		}

		const beforeElement = this.#getPseudoElement(element, "::before");
		if (beforeElement) {
			return beforeElement;
		}

		// A host's composed children are its shadow root's children, and ONLY
		// those -- an empty shadow root means an empty host, never a
		// fall-through to the light children (they render solely via slots).
		const shadowRoot = this.#getShadowRoot(element);
		if (shadowRoot) {
			return shadowRoot.firstChild;
		}

		// A slot's composed children are its assigned nodes; its own light
		// children are FALLBACK content, shown only when nothing is assigned
		// (the fall-through to node.firstChild below).
		if (element.nodeName === "SLOT") {
			const assigned = this.#getSlotContent(element as HTMLSlotElement);
			if (assigned.length > 0) {
				return assigned[0];
			}
		}

		// Regular first child
		if (node.firstChild) {
			return node.firstChild;
		}

		// A CHILDLESS element still renders its ::after -- the sibling
		// transition only reaches ::after from a last child, which doesn't
		// exist here, so for an empty element the pseudo IS the content
		// (an empty <button class="destroy"> with ::after content, say).
		return this.#getPseudoElement(element, "::after");
	}

	/**
	 * Get expanded last child including pseudo-elements and shadow content
	 */
	#rawLastChild(node: Node): Node | null {
		if (node.nodeType !== node.ELEMENT_NODE) {
			return node.lastChild;
		}

		const element = node as Element;

		// Check for ::after pseudo-element first (reverse document order)
		const afterNode = this.#getPseudoElement(element, "::after");
		if (afterNode) {
			return afterNode;
		}

		// Handle slot assigned content as virtual children (stateless approach)
		if (element.nodeName === "SLOT") {
			const slotContent = this.#getSlotContent(element as HTMLSlotElement);
			if (slotContent.length > 0) {
				return slotContent[slotContent.length - 1];
			}
		}

		// A shadow root REPLACES the host's light children in the composed
		// tree, so it must be consulted before node.lastChild -- checking the
		// light child first made last-child navigation disagree with
		// #rawFirstChild (which composes shadow-first) on any host that kept
		// light children around for slotting. And like #rawFirstChild, no
		// fall-through: an empty root means an empty host.
		const shadowRoot = this.#getShadowRoot(element);
		if (shadowRoot) {
			return shadowRoot.lastChild;
		}

		return node.lastChild;
	}

	/**
	 * Get next sibling including extended content transitions
	 */
	#rawNextSibling(node: Node): Node | null {
		// Handle pseudo-element to regular content transitions
		const pseudoMeta = this.#getPseudoMetadata(node);
		if (pseudoMeta) {
			const hostElement = pseudoMeta.hostElement;

			if (pseudoMeta.pseudoType === "::marker") {
				// ::marker -> ::before (if it exists)
				const beforeElement = this.#getPseudoElement(hostElement, "::before");
				if (beforeElement) {
					return beforeElement;
				}
				// ::marker -> first composed child (shadow content replaces light
				// children entirely; an empty root composes nothing)
				const shadowRoot = this.#getShadowRoot(hostElement);
				if (shadowRoot) {
					return shadowRoot.firstChild;
				}

				return hostElement.firstChild;
			}

			if (pseudoMeta.pseudoType === "::before") {
				// ::before -> first composed child (shadow-first, no light
				// fall-through)
				const shadowRoot = this.#getShadowRoot(hostElement);
				if (shadowRoot) {
					return shadowRoot.firstChild;
				}

				return hostElement.firstChild;
			}
		}

		// A projected node's composed siblings are its neighbors in the
		// slot's assigned-node list, NOT its light-tree siblings -- the light
		// nextSibling may be assigned to a different slot (or to none), and
		// following it walked the wrong subtree in light-tree order.
		const assignedSlot = assignedSlotOf(node);
		if (assignedSlot) {
			const assignedNodes = assignedSlot.assignedNodes();
			const currentIndex = assignedNodes.indexOf(node);
			if (currentIndex >= 0 && currentIndex < assignedNodes.length - 1) {
				return assignedNodes[currentIndex + 1];
			}
			return null; // End of slot content; nextNode climbs to the slot
		}

		// Regular sibling navigation
		const nextSibling = node.nextSibling;
		if (nextSibling) {
			return nextSibling;
		}

		// Handle transition from regular content to ::after pseudo element
		// This happens when we've reached the end of regular siblings
		const parent = this.#rawParent(node);
		if (parent && parent.nodeType === parent.ELEMENT_NODE) {
			const parentElement = parent as Element;
			const afterElement = this.#getPseudoElement(parentElement, "::after");
			if (afterElement) {
				// Only transition to ::after if this is truly the last content
				// Check if this node is the last non-pseudo child
				let lastChild = parent.lastChild;
				while (lastChild && this.#getPseudoMetadata(lastChild)) {
					// Skip over any pseudo elements to find the last real child
					lastChild = lastChild.previousSibling;
				}

				if (node === lastChild) {
					return afterElement;
				}
			}
		}

		return null;
	}

	/**
	 * Get previous sibling including extended content transitions
	 */
	#rawPreviousSibling(node: Node): Node | null {
		// Handle pseudo-element transitions
		const pseudoMeta = this.#getPseudoMetadata(node);
		if (pseudoMeta) {
			const hostElement = pseudoMeta.hostElement;

			if (pseudoMeta.pseudoType === "::after") {
				// ::after -> last composed child: the shadow root when one
				// exists (light children only render via slots), else the
				// last light child.
				const shadowRoot = this.#getShadowRoot(hostElement);
				if (shadowRoot) {
					return shadowRoot.lastChild;
				}

				return hostElement.lastChild;
			}

			if (pseudoMeta.pseudoType === "::before") {
				// ::before -> ::marker (if it exists on elements with display: list-item)
				if (this.#hasListItemDisplay(hostElement)) {
					const markerElement = this.#getPseudoElement(hostElement, "::marker");
					if (markerElement) {
						return markerElement;
					}
				}
				return null;
			}
		}

		// Projected nodes navigate backward through the assigned-node list,
		// mirroring #rawNextSibling.
		const assignedSlot = assignedSlotOf(node);
		if (assignedSlot) {
			const assignedNodes = assignedSlot.assignedNodes();
			const currentIndex = assignedNodes.indexOf(node);
			if (currentIndex > 0) {
				return assignedNodes[currentIndex - 1];
			}
			return null; // Start of slot content; previousNode climbs to the slot
		}

		// Regular sibling navigation
		const prevSibling = node.previousSibling;
		if (prevSibling) {
			return prevSibling;
		}

		// Handle transitions from regular content to pseudo-elements
		const parent = this.#rawParent(node);
		if (parent && parent.nodeType === parent.ELEMENT_NODE) {
			const parentElement = parent as Element;

			// Check if this was the first child and we need pseudo-elements
			if (node === parent.firstChild) {
				// Try ::before first
				const beforeElement = this.#getPseudoElement(parentElement, "::before");
				if (beforeElement) {
					return beforeElement;
				}
				// If no ::before, try ::marker (only on elements with display: list-item)
				if (this.#hasListItemDisplay(parentElement)) {
					const markerElement = this.#getPseudoElement(
						parentElement,
						"::marker",
					);
					if (markerElement) {
						return markerElement;
					}
				}
			}
		}

		return null;
	}

	/**
	 * Get parent including extended content relationships
	 */
	#rawParent(node: Node): Node | null {
		// Handle pseudo-element parent relationships
		const pseudoMeta = this.#getPseudoMetadata(node);
		if (pseudoMeta) {
			return pseudoMeta.hostElement;
		}

		// Handle shadow DOM parent relationships
		if (node.parentNode && node.parentNode.nodeType === 11) {
			// DOCUMENT_FRAGMENT_NODE
			// This is shadow content, find the host element
			const shadowRoot = node.parentNode as ShadowRoot;
			return (shadowRoot as any).host || shadowRoot.parentNode;
		}

		// A projected node's composed parent is its assigned SLOT, not the
		// shadow host it lives under in the light tree -- returning the host
		// made nextNode's climb continue from the host's own siblings,
		// abandoning whatever shadow content followed the slot.
		const assignedSlot = assignedSlotOf(node);
		if (assignedSlot) {
			return assignedSlot;
		}

		return node.parentNode;
	}

	/**
	 * Get the last descendant of a node (for previousNode traversal)
	 */
	#getLastDescendant(node: Node): Node {
		let current = node;
		let lastChild = this.#getLastChild(current);

		while (lastChild) {
			current = lastChild;
			lastChild = this.#getLastChild(current);
		}

		return current;
	}

	/**
	 * Accept node - always traverses elements and text nodes (including pseudo-elements)
	 */
	#acceptNode(node: Node): boolean {
		// Only elements and text (pseudo-element text included) generate boxes.
		// Every other node type a document can hold -- comments, processing
		// instructions, CDATA, doctype -- is SKIPPED by the traversal methods,
		// which advance past a rejected node rather than halting on it, so one
		// anywhere in the flow cannot hide the content around it.
		return (
			node.nodeType === node.ELEMENT_NODE || node.nodeType === node.TEXT_NODE
		);
	}

	// Utility methods for extended content access

	/**
	 * Resolve an element's shadow root for composition. Two mechanisms, by
	 * design: the symbol slot is the UA-INTERNAL tree (closed to DOM APIs,
	 * like a browser input's internals -- element.shadowRoot never exposes
	 * it), and native attachShadow() is the AUTHOR tree, the standard API
	 * real web components call. UA wins when both exist.
	 */
	#getShadowRoot(element: Element): ShadowRoot | null {
		return compositionShadowRoot(element);
	}

	/**
	 * Get pseudo-element using symbol key storage
	 */
	#getPseudoElement(
		element: Element,
		pseudoType: "::before" | "::after" | "::marker",
	): Node | null {
		const pseudos = (element as any)[PSEUDO_ELEMENTS_SYMBOL] as
			| Record<string, Node>
			| undefined;
		return pseudos?.[pseudoType] ?? null;
	}

	/**
	 * Get pseudo-element metadata
	 */
	#getPseudoMetadata(
		node: Node,
	): {pseudoType: string; hostElement: Element} | null {
		return (node as any)[PSEUDO_METADATA_SYMBOL] || null;
	}

	/**
	 * Check if an element has display: list-item
	 */
	#hasListItemDisplay(element: Element): boolean {
		const display = computedStyleOf(element).getPropertyValue("display");
		return display === "list-item";
	}

	/**
	 * A slot's assigned nodes (jsdom keeps the assignment live). Empty for a
	 * slot outside any shadow tree -- its fallback children render instead.
	 */
	#getSlotContent(slot: HTMLSlotElement): Node[] {
		return typeof slot.assignedNodes === "function" ? slot.assignedNodes() : [];
	}

	/**
	 * Check if a node is the last extended child of an element
	 * This considers shadow DOM, slots, and regular children (but NOT ::after)
	 */
	#isLastExtendedChild(node: Node, element: Element): boolean {
		// Get the last content child (excluding ::after pseudo-element)
		const lastContentChild = this.#getLastContentChild(element);
		if (!lastContentChild) {
			return false;
		}

		// If we're at the lastContentChild itself, we're at the end
		if (node === lastContentChild) {
			return true;
		}

		// If we're within the lastContentChild's subtree, we might be at the end
		return this.#isDescendantOf(node, lastContentChild);
	}

	/**
	 * Get the last content child of an element (excluding ::after)
	 * This includes shadow DOM and slots but not ::after pseudo-element
	 */
	#getLastContentChild(element: Element): Node | null {
		// Shadow content replaces light children in the composed tree, so a
		// host's last content child comes from the shadow root when one exists
		// -- even an empty one.
		const shadowRoot = this.#getShadowRoot(element);
		if (shadowRoot) {
			return shadowRoot.lastChild;
		}

		return element.lastChild;
	}

	/**
	 * Check if node is a descendant of ancestor
	 */
	#isDescendantOf(node: Node, ancestor: Node): boolean {
		let current: Node | null = this.#rawParent(node);
		while (current) {
			if (current === ancestor) {
				return true;
			}
			current = this.#rawParent(current);
		}
		return false;
	}
}

// Composition utilities for pseudo-elements and shadow DOM

/**
 * Attach a pseudo-element node to an element using the composition system
 */
export function attachPseudoElement(
	element: Element,
	pseudoNode: Text,
	pseudoType: string,
): void {
	invalidateStructure();
	// Store pseudo-elements on the element using a symbol as a Record
	if (!(element as any)[PSEUDO_ELEMENTS_SYMBOL]) {
		(element as any)[PSEUDO_ELEMENTS_SYMBOL] = {};
	}

	const pseudoRecord = (element as any)[PSEUDO_ELEMENTS_SYMBOL] as Record<
		string,
		Text
	>;
	pseudoRecord[pseudoType] = pseudoNode;

	// Store metadata on the pseudo-element node for ExpandedTreeWalker
	(pseudoNode as any)[PSEUDO_METADATA_SYMBOL] = {
		pseudoType,
		hostElement: element,
	};
}

/**
 * Remove a pseudo-element from an element
 */
export function removePseudoElement(
	element: Element,
	pseudoType: string,
): void {
	invalidateStructure();
	const pseudos = (element as any)[PSEUDO_ELEMENTS_SYMBOL] as
		| Record<string, Node>
		| undefined;
	if (pseudos && pseudos[pseudoType]) {
		delete pseudos[pseudoType];
	}
}

/**
 * Get all pseudo-elements attached to an element
 */
export function getAllPseudoElements(element: Element): Record<string, Node> {
	return (element as any)[PSEUDO_ELEMENTS_SYMBOL] || {};
}

/**
 * Shadow DOM Management utilities
 */

/**
 * Create a UA-INTERNAL shadow root on an element: a real DocumentFragment
 * (functional DOM -- appendChild, querySelector, live text nodes) tagged
 * with the host, stored in the symbol slot, and invisible to every DOM API
 * an author can reach: element.shadowRoot stays null, and attachShadow on
 * the same element keeps throwing exactly as the spec demands for form
 * controls. This is how a browser input's own internals work, and it is
 * the mechanism the widget painters hang their trees on.
 *
 * There is deliberately NO attachShadow polyfill: jsdom's native
 * attachShadow is the author path, including its NotSupportedError on
 * built-ins like <input> -- swallowing that throw would hide a spec
 * behavior authors are entitled to observe.
 */
export function createUAShadowRoot(host: Element): ShadowRoot {
	invalidateStructure();
	const document = host.ownerDocument;
	if (!document) {
		throw new Error("UA shadow root host must belong to a document");
	}
	const root = document.createDocumentFragment() as unknown as ShadowRoot;
	Object.defineProperties(root, {
		host: {value: host},
		mode: {value: "closed"},
		// Cascade-origin marker: rules from this root's stylesheets are UA
		// rules, which every author rule outranks regardless of specificity.
		uaInternal: {value: true},
	});
	setShadowRoot(host, root);
	return root;
}

// Tree walker and testing utilities

/**
 * Factory function to create an ExpandedTreeWalker
 */
export function createExpandedTreeWalker(
	window: DOMWindow,
	root: Node,
): ExpandedTreeWalker {
	return new ExpandedTreeWalker(window, root);
}

/**
 * Set shadow root on an element using symbol storage
 */
export function setShadowRoot(element: Element, shadowRoot: ShadowRoot): void {
	invalidateStructure();
	(element as any)[SHADOW_ROOT_SYMBOL] = shadowRoot;
}

/**
 * Get pseudo-element from an element
 */
export function getPseudoElement(
	element: Element,
	pseudoType: string,
): Node | null {
	const pseudos = (element as any)[PSEUDO_ELEMENTS_SYMBOL] as
		| Record<string, Node>
		| undefined;
	return pseudos?.[pseudoType] || null;
}

/**
 * Create a pseudo-element node (text node with content)
 */
export function createPseudoNode(
	hostElement: Element,
	pseudoType: string,
	content: string,
): Text {
	const doc = hostElement.ownerDocument;
	const textNode = doc.createTextNode(content);

	// Store metadata
	(textNode as any)[PSEUDO_METADATA_SYMBOL] = {
		pseudoType,
		hostElement,
	};

	return textNode;
}

/**
 * Check if a node is a pseudo-element
 */
export function isPseudoNode(node: Node): boolean {
	return !!(node as any)[PSEUDO_METADATA_SYMBOL];
}

/**
 * Get pseudo-element metadata
 */
export function getPseudoMetadata(
	node: Node,
): {pseudoType: string; hostElement: Element} | null {
	return (node as any)[PSEUDO_METADATA_SYMBOL] || null;
}
