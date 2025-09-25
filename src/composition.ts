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
export const PSEUDO_ELEMENTS_SYMBOL = Symbol.for("TermDOM.pseudoElements");
export const PSEUDO_METADATA_SYMBOL = Symbol.for("TermDOM.pseudoMetadata");

// Extended NodeFilter constants
export const NodeFilterExtended = {
	SHOW_SHADOW_DOM: 0x80000000, // Bit 31
	SHOW_PSEUDO_ELEMENTS: 0x40000000, // Bit 30
	SHOW_SLOTS: 0x20000000, // Bit 29
} as const;

/**
 * Extended TreeWalker implementation based on W3C spec with support for
 * pseudo-elements, shadow DOM, and slot content traversal
 */
export class ExpandedTreeWalker {
	// TypeScript declarations only
	declare readonly root: Node;
	declare readonly whatToShow: number;
	declare readonly filter: NodeFilter | null;
	declare currentNode: Node;

	// Private fields (defined in constructor)
	#window!: DOMWindow;

	constructor(
		window: DOMWindow,
		root: Node,
		whatToShow: number,
		filter: NodeFilter | null = null,
	) {
		// Define readonly properties
		Object.defineProperty(this, "root", {
			value: root,
			writable: false,
			enumerable: true,
		});
		Object.defineProperty(this, "whatToShow", {
			value: whatToShow,
			writable: false,
			enumerable: true,
		});
		Object.defineProperty(this, "filter", {
			value: filter,
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
			if (firstChild) {
				if (
					this.#acceptNode(firstChild) === this.#window.NodeFilter.FILTER_ACCEPT
				) {
					this.currentNode = firstChild;
					return firstChild;
				}
				node = firstChild;
				continue;
			}

			// Try to get next sibling (including extended siblings)
			const nextSibling = this.#getNextSibling(node);
			if (nextSibling) {
				if (
					this.#acceptNode(nextSibling) ===
					this.#window.NodeFilter.FILTER_ACCEPT
				) {
					this.currentNode = nextSibling;
					return nextSibling;
				}
				node = nextSibling;
				continue;
			}

			// Walk up to parent and try their next sibling
			let parent = this.#getParent(node);
			while (parent && parent !== this.root) {
				// Before trying parent's next sibling, check if parent element has ::after
				if (
					parent.nodeType === parent.ELEMENT_NODE &&
					this.whatToShow & NodeFilterExtended.SHOW_PSEUDO_ELEMENTS
				) {
					const afterElement = this.#getPseudoElement(
						parent as Element,
						"::after",
					);
					if (afterElement) {
						// Check if we're at the end of parent's extended content
						if (this.#isLastExtendedChild(node, parent as Element)) {
							if (
								this.#acceptNode(afterElement) ===
								this.#window.NodeFilter.FILTER_ACCEPT
							) {
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
					if (
						this.#acceptNode(parentNextSibling) ===
						this.#window.NodeFilter.FILTER_ACCEPT
					) {
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
				if (
					this.#acceptNode(lastDescendant) ===
					this.#window.NodeFilter.FILTER_ACCEPT
				) {
					this.currentNode = lastDescendant;
					return lastDescendant;
				}
				node = lastDescendant;
				continue;
			}

			// Move to parent
			const parent = this.#getParent(node);
			if (parent) {
				if (
					this.#acceptNode(parent) === this.#window.NodeFilter.FILTER_ACCEPT
				) {
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
			if (
				parent &&
				this.#acceptNode(parent) === this.#window.NodeFilter.FILTER_ACCEPT
			) {
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
		if (
			firstChild &&
			this.#acceptNode(firstChild) === this.#window.NodeFilter.FILTER_ACCEPT
		) {
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
		if (
			lastChild &&
			this.#acceptNode(lastChild) === this.#window.NodeFilter.FILTER_ACCEPT
		) {
			this.currentNode = lastChild;
			return lastChild;
		}
		return null;
	}

	/**
	 * Move to next sibling
	 */
	nextSibling(): Node | null {
		const nextSibling = this.#getNextSibling(this.currentNode);
		if (
			nextSibling &&
			this.#acceptNode(nextSibling) === this.#window.NodeFilter.FILTER_ACCEPT
		) {
			this.currentNode = nextSibling;
			return nextSibling;
		}
		return null;
	}

	/**
	 * Move to previous sibling
	 */
	previousSibling(): Node | null {
		const previousSibling = this.#getPreviousSibling(this.currentNode);
		if (
			previousSibling &&
			this.#acceptNode(previousSibling) ===
				this.#window.NodeFilter.FILTER_ACCEPT
		) {
			this.currentNode = previousSibling;
			return previousSibling;
		}
		return null;
	}

	// Extended DOM navigation methods that understand pseudo-elements, shadow DOM, and slots

	/**
	 * Get expanded first child including pseudo-elements and shadow content
	 */
	#getFirstChild(node: Node): Node | null {
		if (node.nodeType !== node.ELEMENT_NODE) {
			return node.firstChild;
		}

		const element = node as Element;

		// Check for ::marker pseudo-element first (document order, only on elements with display: list-item)
		if (this.whatToShow & NodeFilterExtended.SHOW_PSEUDO_ELEMENTS) {
			if (this.#hasListItemDisplay(element)) {
				const markerElement = this.#getPseudoElement(element, "::marker");
				if (markerElement) {
					return markerElement;
				}
			}
		}

		// Check for ::before pseudo-element (after ::marker)
		if (this.whatToShow & NodeFilterExtended.SHOW_PSEUDO_ELEMENTS) {
			const beforeElement = this.#getPseudoElement(element, "::before");
			if (beforeElement) {
				return beforeElement;
			}
		}

		// Check for shadow DOM content
		if (this.whatToShow & NodeFilterExtended.SHOW_SHADOW_DOM) {
			const shadowRoot = this.#getShadowRoot(element);
			if (shadowRoot && shadowRoot.firstChild) {
				return shadowRoot.firstChild;
			}
		}

		// Handle slot assigned content as virtual children (stateless approach)
		if (
			element.nodeName === "SLOT" &&
			this.whatToShow & NodeFilterExtended.SHOW_SLOTS
		) {
			const slotContent = this.#getSlotContent(element as HTMLSlotElement);
			if (slotContent.length > 0) {
				return slotContent[0];
			}
		}

		// Regular first child
		return node.firstChild;
	}

	/**
	 * Get expanded last child including pseudo-elements and shadow content
	 */
	#getLastChild(node: Node): Node | null {
		if (node.nodeType !== node.ELEMENT_NODE) {
			return node.lastChild;
		}

		const element = node as Element;

		// Check for ::after pseudo-element first (reverse document order)
		if (this.whatToShow & NodeFilterExtended.SHOW_PSEUDO_ELEMENTS) {
			const afterElement = this.#getPseudoElement(element, "::after");
			if (afterElement) {
				return afterElement;
			}
		}

		// Handle slot assigned content as virtual children (stateless approach)
		if (
			element.nodeName === "SLOT" &&
			this.whatToShow & NodeFilterExtended.SHOW_SLOTS
		) {
			const slotContent = this.#getSlotContent(element as HTMLSlotElement);
			if (slotContent.length > 0) {
				return slotContent[slotContent.length - 1];
			}
		}

		// Regular last child
		let lastChild = node.lastChild;
		if (lastChild) {
			return lastChild;
		}

		// Check for shadow DOM content
		if (this.whatToShow & NodeFilterExtended.SHOW_SHADOW_DOM) {
			const shadowRoot = this.#getShadowRoot(element);
			if (shadowRoot && shadowRoot.lastChild) {
				return shadowRoot.lastChild;
			}
		}

		return null;
	}

	/**
	 * Get next sibling including extended content transitions
	 */
	#getNextSibling(node: Node): Node | null {
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
				// ::marker -> first regular child or shadow content (if no ::before)
				if (this.whatToShow & NodeFilterExtended.SHOW_SHADOW_DOM) {
					const shadowRoot = this.#getShadowRoot(hostElement);
					if (shadowRoot && shadowRoot.firstChild) {
						return shadowRoot.firstChild;
					}
				}
				return hostElement.firstChild;
			}

			if (pseudoMeta.pseudoType === "::before") {
				// ::before -> first regular child or shadow content
				if (this.whatToShow & NodeFilterExtended.SHOW_SHADOW_DOM) {
					const shadowRoot = this.#getShadowRoot(hostElement);
					if (shadowRoot && shadowRoot.firstChild) {
						return shadowRoot.firstChild;
					}
				}

				return hostElement.firstChild;
			}
		}

		// Handle virtual next sibling for slotted elements (stateless approach)
		if (
			node.nodeType === node.ELEMENT_NODE &&
			(node as Element).hasAttribute &&
			(node as Element).hasAttribute("slot")
		) {
			const parent = node.parentNode;
			if (parent && parent.nodeType === parent.ELEMENT_NODE) {
				const shadowRoot = this.#getShadowRoot(parent as Element);
				if (shadowRoot) {
					const slotName = (node as Element).getAttribute("slot") || "";
					const slot = this.#findSlotInShadowRoot(shadowRoot, slotName);
					if (slot && slot.assignedNodes) {
						const assignedNodes = slot.assignedNodes();
						const currentIndex = assignedNodes.indexOf(node);
						if (currentIndex >= 0 && currentIndex < assignedNodes.length - 1) {
							return assignedNodes[currentIndex + 1];
						}
						return null; // End of slot content
					}
				}
			}
		}

		// Regular sibling navigation
		const nextSibling = node.nextSibling;
		if (nextSibling) {
			return nextSibling;
		}

		// Handle transition from regular content to ::after pseudo element
		// This happens when we've reached the end of regular siblings
		const parent = this.#getParent(node);
		if (parent && parent.nodeType === parent.ELEMENT_NODE) {
			const parentElement = parent as Element;

			// Check if this node is the last regular child and we need ::after
			if (this.whatToShow & NodeFilterExtended.SHOW_PSEUDO_ELEMENTS) {
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
		}

		return null;
	}

	/**
	 * Get previous sibling including extended content transitions
	 */
	#getPreviousSibling(node: Node): Node | null {
		// Handle pseudo-element transitions
		const pseudoMeta = this.#getPseudoMetadata(node);
		if (pseudoMeta) {
			const hostElement = pseudoMeta.hostElement;

			if (pseudoMeta.pseudoType === "::after") {
				// ::after -> last regular child or shadow content
				if (hostElement.lastChild) {
					return hostElement.lastChild;
				}

				if (this.whatToShow & NodeFilterExtended.SHOW_SHADOW_DOM) {
					const shadowRoot = this.#getShadowRoot(hostElement);
					if (shadowRoot && shadowRoot.lastChild) {
						return shadowRoot.lastChild;
					}
				}

				return null;
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

		// Regular sibling navigation
		const prevSibling = node.previousSibling;
		if (prevSibling) {
			return prevSibling;
		}

		// Handle transitions from regular content to pseudo-elements
		const parent = this.#getParent(node);
		if (parent && parent.nodeType === parent.ELEMENT_NODE) {
			const parentElement = parent as Element;

			// Check if this was the first child and we need pseudo-elements
			if (
				node === parent.firstChild &&
				this.whatToShow & NodeFilterExtended.SHOW_PSEUDO_ELEMENTS
			) {
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
	#getParent(node: Node): Node | null {
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

		// Handle virtual parent for slotted elements (stateless approach)
		if (
			node.nodeType === node.ELEMENT_NODE &&
			(node as Element).hasAttribute &&
			(node as Element).hasAttribute("slot")
		) {
			const parent = node.parentNode;
			if (parent && parent.nodeType === parent.ELEMENT_NODE) {
				const shadowRoot = this.#getShadowRoot(parent as Element);
				if (shadowRoot) {
					const slotName = (node as Element).getAttribute("slot") || "";
					// Find matching slot in shadow DOM
					const slot = this.#findSlotInShadowRoot(shadowRoot, slotName);
					if (slot) {
						return slot;
					}
				}
			}
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
	 * Apply node filter and whatToShow mask
	 */
	#acceptNode(node: Node): number {
		// Apply whatToShow filter (excluding extended flags)
		const standardWhatToShow =
			this.whatToShow &
			~(
				NodeFilterExtended.SHOW_SHADOW_DOM |
				NodeFilterExtended.SHOW_PSEUDO_ELEMENTS |
				NodeFilterExtended.SHOW_SLOTS
			);
		const nodeTypeMask = 1 << (node.nodeType - 1);

		if (!(standardWhatToShow & nodeTypeMask)) {
			return this.#window.NodeFilter.FILTER_SKIP;
		}

		// Apply custom filter if present
		if (this.filter) {
			if (typeof this.filter === "function") {
				return this.filter(node);
			} else {
				return this.filter.acceptNode(node);
			}
		}

		return this.#window.NodeFilter.FILTER_ACCEPT;
	}

	// Utility methods for extended content access

	/**
	 * Get shadow root using symbol key
	 */
	#getShadowRoot(element: Element): ShadowRoot | null {
		return (element as any)[SHADOW_ROOT_SYMBOL] || null;
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
		return pseudos?.[pseudoType] || null;
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
	 * Get slot content
	 */
	#getSlotContent(slot: HTMLSlotElement): Node[] {
		if (typeof slot.assignedNodes === "function") {
			return slot.assignedNodes();
		} else {
			const children: Node[] = [];
			let child = slot.firstChild;
			while (child) {
				children.push(child);
				child = child.nextSibling;
			}
			return children;
		}
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
		// Check regular last child first
		if (element.lastChild) {
			return element.lastChild;
		}

		// Check for shadow DOM content (but not ::after)
		if (this.whatToShow & NodeFilterExtended.SHOW_SHADOW_DOM) {
			const shadowRoot = this.#getShadowRoot(element);
			if (shadowRoot && shadowRoot.lastChild) {
				return shadowRoot.lastChild;
			}
		}

		return null;
	}

	/**
	 * Check if node is a descendant of ancestor
	 */
	#isDescendantOf(node: Node, ancestor: Node): boolean {
		let current: Node | null = node.parentNode;
		while (current) {
			if (current === ancestor) {
				return true;
			}
			current = this.#getParent(current);
		}
		return false;
	}

	/**
	 * Find a slot with given name in a shadow root
	 */
	#findSlotInShadowRoot(
		shadowRoot: ShadowRoot,
		slotName: string,
	): HTMLSlotElement | null {
		// Simple traversal to find slot - could be optimized
		const traverse = (node: Node): HTMLSlotElement | null => {
			if (node.nodeType === node.ELEMENT_NODE && node.nodeName === "SLOT") {
				const slot = node as HTMLSlotElement;
				if ((slot.name || "") === slotName) {
					return slot;
				}
			}

			for (let child = node.firstChild; child; child = child.nextSibling) {
				const result = traverse(child);
				if (result) return result;
			}

			return null;
		};

		return traverse(shadowRoot);
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

		// Cache the shadow root using symbol key
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

	// Initialize as a DocumentFragment
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
	whatToShow: number,
	filter: NodeFilter | null = null,
): ExpandedTreeWalker {
	return new ExpandedTreeWalker(window, root, whatToShow, filter);
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
