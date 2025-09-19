import type { DOMWindow } from "jsdom";
import { setShadowRoot, getShadowRoot } from "./expanded-tree-walker.js";

/**
 * Extract JSDOM's internal ShadowRoot constructor from a window instance
 * This avoids requiring internal JSDOM modules directly
 */
function extractShadowRootConstructor(window: DOMWindow): any {
  // Create a temporary custom element to trigger ShadowRoot creation
  const tempElement = window.document.createElement("div");

  try {
    // Try to attach a shadow root to get access to the constructor
    const shadowRoot = tempElement.attachShadow({ mode: "open" });

    // Extract the constructor from the created shadow root
    return shadowRoot.constructor;
  } catch (e) {
    // If attachShadow fails, we need to extract from JSDOM's internal structure
    // Look for ShadowRoot in the window's constructor registry
    const ctorRegistry =
      (window as any)[Symbol.for("jsdom-ctor-registry")] ||
      (window as any).constructor?.ctorRegistry ||
      (window as any)._ctorRegistry;

    if (ctorRegistry && ctorRegistry.ShadowRoot) {
      return ctorRegistry.ShadowRoot;
    }

    // Fallback: try to find it through DocumentFragment prototype chain
    const docFragment = window.document.createDocumentFragment();
    const proto = Object.getPrototypeOf(docFragment);

    // Look for ShadowRoot in the prototype chain or constructor registry
    if (
      proto &&
      proto.constructor &&
      proto.constructor.name === "DocumentFragment"
    ) {
      // Try to find ShadowRoot through the global object
      return (window as any).ShadowRoot || null;
    }

    return null;
  }
}

/**
 * Create a ShadowRoot using the extracted constructor
 */
function createShadowRoot(
  window: DOMWindow,
  host: Element,
  options: ShadowRootInit,
): ShadowRoot {
  const ShadowRootConstructor = extractShadowRootConstructor(window);

  if (!ShadowRootConstructor) {
    throw new Error("Could not extract ShadowRoot constructor from JSDOM");
  }

  // For JSDOM, we need to create the ShadowRoot through the proper API
  // since direct constructor calls don't work properly
  try {
    // Try the standard approach first
    return host.attachShadow(options);
  } catch (e) {
    // If that fails, create a mock ShadowRoot with the required properties
    const shadowRoot = window.document.createDocumentFragment() as any;

    // Set up ShadowRoot-specific properties
    Object.defineProperties(shadowRoot, {
      mode: {
        value: options.mode,
        writable: false,
        configurable: false,
      },
      host: {
        value: host,
        writable: false,
        configurable: false,
      },
      nodeType: {
        value: 11, // DOCUMENT_FRAGMENT_NODE
        writable: false,
        configurable: false,
      },
      nodeName: {
        value: "#document-fragment",
        writable: false,
        configurable: false,
      },
    });

    // Set the prototype to match ShadowRoot
    if (ShadowRootConstructor.prototype) {
      Object.setPrototypeOf(shadowRoot, ShadowRootConstructor.prototype);
    }

    return shadowRoot as ShadowRoot;
  }
}

/**
 * Shadow DOM Manager - handles all shadow DOM operations for TermDOM
 *
 * This module provides:
 * - Shadow root creation and caching
 * - Slot content projection
 * - Merged DOM tree generation for rendering
 * - Built-in element shadow DOM support (bypassing JSDOM restrictions)
 */
export class ShadowDOMManager {
  private window: DOMWindow;
  private originalAttachShadow: typeof Element.prototype.attachShadow;
  private mergedTreeCache = new WeakMap<Element, DocumentFragment>();
  private cloneToOriginalMap = new WeakMap<Node, Node>();

  constructor(window: DOMWindow) {
    this.window = window;
    this.originalAttachShadow = window.Element.prototype.attachShadow;
    this.setupShadowDOMSupport();
  }

  /**
   * Setup shadow DOM support by monkey-patching attachShadow to:
   * 1. Cache shadow roots using symbol keys
   * 2. Bypass JSDOM restrictions for built-in elements
   */
  private setupShadowDOMSupport(): void {
    const originalAttachShadow = this.originalAttachShadow;
    const window = this.window;

    // Monkey-patch attachShadow to cache shadow roots and bypass restrictions
    this.window.Element.prototype.attachShadow = function (
      this: Element,
      options: ShadowRootInit,
    ): ShadowRoot {
      let shadowRoot: ShadowRoot;

      try {
        // Call original method first (works for custom elements)
        shadowRoot = originalAttachShadow.call(this, options);
      } catch (e) {
        // JSDOM doesn't support attachShadow on built-in elements
        // Create a proper ShadowRoot using the extracted constructor
        shadowRoot = createShadowRoot(window, this, options);
      }

      // Cache the shadow root using symbol key
      setShadowRoot(this, shadowRoot);

      return shadowRoot;
    };
  }

  /**
   * Get shadow root for an element (works with both open and closed shadows)
   */
  getShadowRoot(element: Element): ShadowRoot | null {
    return getShadowRoot(element);
  }

  /**
   * Check if an element has a shadow root
   */
  hasShadowRoot(element: Element): boolean {
    return getShadowRoot(element) !== null;
  }

  /**
   * Get or create merged DOM tree for an element with shadow DOM
   * This creates a flattened tree with slot content projected
   */
  getMergedTree(element: Element): DocumentFragment | null {
    // Check cache first
    let mergedTree = this.mergedTreeCache.get(element);
    if (mergedTree) {
      return mergedTree;
    }

    // Check if element has shadow DOM and create merged tree on-demand
    const shadowRoot = this.getShadowRoot(element);
    if (shadowRoot) {
      mergedTree = this.createMergedDOMTree(shadowRoot, element);
      this.mergedTreeCache.set(element, mergedTree);
      return mergedTree;
    }

    return null;
  }

  /**
   * Get the original node that a cloned node maps to
   */
  getOriginalNode(node: Node): Node | null {
    return this.cloneToOriginalMap.get(node) || null;
  }

  /**
   * Create a merged DOM tree by cloning shadow DOM and replacing slots with light DOM content
   */
  private createMergedDOMTree(
    shadowRoot: ShadowRoot,
    lightDOMElement: Element,
  ): DocumentFragment {
    const mergedTree = this.window.document.createDocumentFragment();

    // Clone all shadow DOM children
    for (const childNode of shadowRoot.childNodes) {
      const clonedNode = this.cloneShadowNode(childNode, lightDOMElement);
      if (clonedNode) {
        mergedTree.appendChild(clonedNode);
      }
    }

    return mergedTree;
  }

  /**
   * Clone a shadow DOM node, replacing slots with cloned light DOM content
   */
  private cloneShadowNode(node: Node, lightDOMElement: Element): Node | null {
    if (node.nodeType === node.ELEMENT_NODE) {
      const element = node as Element;

      // Handle slot elements - replace with projected content
      if (element.nodeName === "SLOT") {
        return this.cloneSlotContent(
          element as HTMLSlotElement,
          lightDOMElement,
        );
      }

      // Regular element - clone and process children
      const clone = element.cloneNode(false) as Element;
      this.cloneToOriginalMap.set(clone, element);

      // Recursively clone children
      for (const child of element.childNodes) {
        const clonedChild = this.cloneShadowNode(child, lightDOMElement);
        if (clonedChild) {
          clone.appendChild(clonedChild);
        }
      }

      return clone;
    } else {
      // Text nodes, comments, etc. - clone directly
      const clone = node.cloneNode(true);
      this.cloneToOriginalMap.set(clone, node);
      return clone;
    }
  }

  /**
   * Clone slot content by projecting light DOM content into the slot
   */
  private cloneSlotContent(
    slot: HTMLSlotElement,
    lightDOMElement: Element,
  ): DocumentFragment {
    const fragment = this.window.document.createDocumentFragment();
    const slotName = slot.getAttribute("name");

    if (slotName) {
      // Named slot - find elements with matching slot attribute
      const assignedElements = Array.from(lightDOMElement.children).filter(
        (child) => child.getAttribute("slot") === slotName,
      );

      for (const element of assignedElements) {
        const clone = element.cloneNode(true);
        this.cloneToOriginalMap.set(clone, element);
        fragment.appendChild(clone);
      }
    } else {
      // Default slot - include elements without slot attribute
      const defaultElements = Array.from(lightDOMElement.childNodes).filter(
        (child) => {
          if (child.nodeType === child.ELEMENT_NODE) {
            return !(child as Element).hasAttribute("slot");
          }
          return true; // Include text nodes, comments, etc.
        },
      );

      for (const node of defaultElements) {
        const clone = node.cloneNode(true);
        this.cloneToOriginalMap.set(clone, node);
        fragment.appendChild(clone);
      }
    }

    // If no content was assigned to slot, use slot's fallback content
    if (fragment.childNodes.length === 0) {
      for (const child of slot.childNodes) {
        const clone = child.cloneNode(true);
        this.cloneToOriginalMap.set(clone, child);
        fragment.appendChild(clone);
      }
    }

    return fragment;
  }

  /**
   * Resolve slot assignments for light DOM content projection
   * Returns a map of slot names to assigned light DOM elements
   */
  resolveSlotAssignments(
    shadowRoot: ShadowRoot,
    lightDOMElement: Element,
  ): Map<string, Element[]> {
    const assignments = new Map<string, Element[]>();

    // Find all slots in shadow DOM
    const slots = shadowRoot.querySelectorAll("slot");

    for (const slot of slots) {
      const slotName = slot.getAttribute("name") || "";
      const assignedElements: Element[] = [];

      if (slotName) {
        // Named slot
        for (const child of lightDOMElement.children) {
          if (child.getAttribute("slot") === slotName) {
            assignedElements.push(child);
          }
        }
      } else {
        // Default slot
        for (const child of lightDOMElement.children) {
          if (!child.hasAttribute("slot")) {
            assignedElements.push(child);
          }
        }
      }

      assignments.set(slotName, assignedElements);
    }

    return assignments;
  }

  /**
   * Find the first anonymous (default) slot in a shadow root
   */
  findAnonymousSlot(shadowRoot: ShadowRoot): Element | null {
    return shadowRoot.querySelector("slot:not([name])");
  }

  /**
   * Clear all cached merged trees (useful for testing or when DOM changes)
   */
  clearCache(): void {
    // WeakMaps don't have clear() method, create new instances
    this.mergedTreeCache = new WeakMap<Element, DocumentFragment>();
    this.cloneToOriginalMap = new WeakMap<Node, Node>();
  }

  /**
   * Cleanup - restore original attachShadow method
   */
  destroy(): void {
    if (this.originalAttachShadow) {
      this.window.Element.prototype.attachShadow = this.originalAttachShadow;
    }
    this.clearCache();
  }
}
