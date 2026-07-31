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

// Symbols for storing pseudo-elements and shadow roots on nodes
export const SHADOW_ROOT_SYMBOL = Symbol.for("TermDOM.shadowRoot");

/**
 * The parent ELEMENT of a node for composition purposes: layout, style
 * inheritance, and inline-run resolution all want "the element this node
 * renders inside", which for a shadow root's direct child is the HOST --
 * node.parentElement is null there (a ShadowRoot is not an Element), which
 * used to crash the inline-run machinery the moment native attachShadow
 * content hit layout.
 */
export function compositionParentElement(node: Node): Element | null {
	if (node.parentElement) return node.parentElement;
	const parent = node.parentNode;
	if (parent && parent.nodeType === 11 && (parent as ShadowRoot).host) {
		return (parent as ShadowRoot).host;
	}
	return null;
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
		// Simplified for now - focus on nextNode correctness
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
		const firstChild = this.#getFirstChild(this.currentNode);
		if (firstChild && this.#acceptNode(firstChild)) {
			this.currentNode = firstChild;
			return firstChild;
		}
		return null;
	}

	/**
	 * Move to last child
	 */
	lastChild(): Node | null {
		const lastChild = this.#getLastChild(this.currentNode);
		if (lastChild && this.#acceptNode(lastChild)) {
			this.currentNode = lastChild;
			return lastChild;
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
		const nextSibling = this.#getNextSibling(this.currentNode);
		if (nextSibling && this.#acceptNode(nextSibling)) {
			this.currentNode = nextSibling;
			return nextSibling;
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
		const previousSibling = this.#getPreviousSibling(this.currentNode);
		if (previousSibling && this.#acceptNode(previousSibling)) {
			this.currentNode = previousSibling;
			return previousSibling;
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
			this.#window
				.getComputedStyle(node as Element)
				.getPropertyValue("display") === "contents"
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
		return node.firstChild;
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
		// Accept element nodes and text nodes (including pseudo-element text nodes)
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
		const display = this.#window
			.getComputedStyle(element)
			.getPropertyValue("display");
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
 * Clear all pseudo-elements from an element
 */
export function clearPseudoElements(element: Element): void {
	delete (element as any)[PSEUDO_ELEMENTS_SYMBOL];
}

/**
 * Shadow DOM Management utilities
 */

/**
 * Check if an element has a shadow root
 */
export function hasShadowRoot(element: Element): boolean {
	return getShadowRoot(element) !== null;
}

/**
 * Initialize shadow DOM support for a window (enables attachShadow polyfill)
 */
export function initializeShadowDOM(window: DOMWindow): void {
	// Polyfill attachShadow for JSDOM environments
	const originalAttachShadow = window.Element.prototype.attachShadow;

	window.Element.prototype.attachShadow = function (
		this: Element,
		options: ShadowRootInit,
	): ShadowRoot {
		let shadowRoot: ShadowRoot;

		try {
			// Call original method first (works for custom elements)
			shadowRoot = originalAttachShadow.call(this, options);
		} catch (e) {
			// JSDOM doesn't support attachShadow on built-in elements
			// Create a proper ShadowRoot manually
			shadowRoot = createShadowRoot(window, this, options);
		}

		setShadowRoot(this, shadowRoot);
		return shadowRoot;
	};
}

/**
 * Create a shadow root manually (for JSDOM compatibility)
 */
function createShadowRoot(
	window: DOMWindow,
	host: Element,
	options: ShadowRootInit,
): ShadowRoot {
	// Create a proper ShadowRoot using JSDOM's internal constructor
	const ShadowRootConstructor = window.ShadowRoot;
	const shadowRoot = Object.create(ShadowRootConstructor.prototype);

	// Initialize ShadowRoot properties
	Object.defineProperties(shadowRoot, {
		mode: {value: options.mode, writable: false},
		host: {value: host, writable: false},
		delegatesFocus: {value: !!options.delegatesFocus, writable: false},
	});

	Object.setPrototypeOf(shadowRoot, ShadowRootConstructor.prototype);

	return shadowRoot;
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
	(element as any)[SHADOW_ROOT_SYMBOL] = shadowRoot;
}

/**
 * Get shadow root from an element
 */
export function getShadowRoot(element: Element): ShadowRoot | null {
	return (element as any)[SHADOW_ROOT_SYMBOL] || null;
}

/**
 * Set pseudo-element on an element using symbol storage
 */
export function setPseudoElement(
	element: Element,
	pseudoType: string,
	node: Node,
): void {
	const pseudos = (element as any)[PSEUDO_ELEMENTS_SYMBOL] || {};
	pseudos[pseudoType] = node;
	(element as any)[PSEUDO_ELEMENTS_SYMBOL] = pseudos;

	// Set metadata on the pseudo-element
	(node as any)[PSEUDO_METADATA_SYMBOL] = {
		pseudoType,
		hostElement: element,
	};
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
