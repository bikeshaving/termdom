/**
 * LayoutEngine - Yoga layout integration for HTML-to-Terminal rendering
 *
 * Provides flexbox layout capabilities using Facebook's Yoga layout engine.
 * Maps CSS styles to Yoga properties and computes element positions/sizes.
 * Works with standard HTML elements enhanced with Symbol properties.
 */

import type { DOMContext } from '../core/DOMContext.js';
import type { DOMWindow } from 'jsdom';
import { ELEMENT_BOUNDS, ELEMENT_RECTS, ELEMENT_TEXT_RECTS, YOGA_NODE, type TextRect } from '../core/HTMLExtensions.js';
import { TextMeasurement } from './TextMeasurement.js';
import { GreedyTextBreaker, type InlineElement, type BreakResult } from '../text/index.js';
import Yoga from 'yoga-layout';
import type * as YogaTypes from 'yoga-layout';

/**
 * Layout Engine using Yoga for flexbox calculations
 */
export class LayoutEngine {
  private yoga: typeof Yoga;
  private textBreaker: GreedyTextBreaker;
  private window: DOMWindow;

  constructor(window: DOMWindow) {
    this.yoga = Yoga;
    this.textBreaker = new GreedyTextBreaker();
    this.window = window;
  }

  /**
   * Compute layout for an element tree using Yoga
   */
  computeLayout(root: Element, containerWidth: number, containerHeight: number): void {
    if (!(root instanceof this.window.HTMLElement)) {
      // Skip non-HTML elements (like Document, Text nodes)
      // Convert NodeList to array for iteration
      const children = Array.from(root.childNodes);
      for (const child of children) {
        if (child.nodeType === this.window.Node.ELEMENT_NODE) {
          this.computeLayout(child as Element, containerWidth, containerHeight);
        }
      }
      return;
    }

    // Now TypeScript knows root is HTMLElement
    const htmlRoot = root;

    // Create a viewport root node that represents the terminal bounds
    const viewportRoot = this.yoga.Node.create();
    viewportRoot.setWidth(containerWidth);
    viewportRoot.setHeight(containerHeight);
    viewportRoot.setOverflow(this.yoga.OVERFLOW_HIDDEN); // Clip children at viewport bounds
    viewportRoot.setDisplay(this.yoga.DISPLAY_FLEX);
    
    // Viewport root created with overflow:hidden for layout bounds

    // Ensure root has a Yoga node
    if (!htmlRoot[YOGA_NODE]) {
      this.setupYogaNode(htmlRoot);
    }

    // Build Yoga tree and compute layout
    this.buildYogaTree(htmlRoot);
    
    // Make document.documentElement a child of the viewport root
    const htmlRootYoga = htmlRoot[YOGA_NODE]!;
    
    // Remove from any existing parent first
    const existingParent = htmlRootYoga.getParent();
    if (existingParent) {
      console.log(`DEBUG: Removing htmlRoot from existing parent`);
      existingParent.removeChild(htmlRootYoga);
    }
    
    viewportRoot.insertChild(htmlRootYoga, 0);

    // Compute layout from the viewport root
    viewportRoot.calculateLayout(containerWidth, containerHeight);
    
    // Debug: Check what layout was calculated for document.documentElement
    const htmlLayout = htmlRootYoga.getComputedLayout();
    // Document element layout computed
    
    // Extract layout starting from document.documentElement (skip viewport root in DOM)
    this.extractLayout(htmlRoot, 0, 0);
    
    // Clean up the viewport root node
    viewportRoot.freeRecursive();
  }


  /**
   * Get padding from element style (CSS property parsing)
   */
  private getPadding(style: CSSStyleDeclaration): [number, number, number, number] {

    // Try individual padding properties first
    const paddingTop = parseInt(style.getPropertyValue('padding-top')) || 0;
    const paddingRight = parseInt(style.getPropertyValue('padding-right')) || 0;
    const paddingBottom = parseInt(style.getPropertyValue('padding-bottom')) || 0;
    const paddingLeft = parseInt(style.getPropertyValue('padding-left')) || 0;

    // If any individual properties are set, use them
    if (paddingTop || paddingRight || paddingBottom || paddingLeft) {
      return [paddingTop, paddingRight, paddingBottom, paddingLeft];
    }

    // Otherwise, parse shorthand padding property
    const padding = style.getPropertyValue('padding');
    if (!padding) {
      return [0, 0, 0, 0];
    }

    // Parse CSS padding shorthand (e.g., "10px" or "10px 5px")
    const values = padding.split(/\s+/).map(v => parseInt(v) || 0);

    switch (values.length) {
      case 1: return [values[0], values[0], values[0], values[0]];
      case 2: return [values[0], values[1], values[0], values[1]];
      case 3: return [values[0], values[1], values[2], values[1]];
      case 4: return [values[0], values[1], values[2], values[3]];
      default: return [0, 0, 0, 0];
    }
  }



  /**
   * Setup Yoga node for element
   */
  private setupYogaNode(element: Element): void {
    if (!element[YOGA_NODE]) {
      const yogaNode = this.yoga.Node.create();
      element[YOGA_NODE] = yogaNode;
      
      // Only set the critical CSS default that fixes the overflow issue
      yogaNode.setFlexShrink(1); // CSS default: 1 (Yoga default: 0) - allows shrinking
      // Note: Other defaults left as Yoga's defaults to avoid breaking existing layouts
    }

    // Always apply styles to Yoga node (styles may have changed)
    this.applyStylesToYoga(element);
  }

  /**
   * Build Yoga tree recursively, handling inline elements specially
   */
  private buildYogaTree(element: Element): void {
    this.setupYogaNode(element);

    // Get all children (elements + text nodes)
    const children = Array.from(element.childNodes);
    const elementChildren = children.filter(child =>
      child.nodeType === (this.window as any).Node.ELEMENT_NODE
    ) as HTMLElement[];
    const textNodes = children.filter(child =>
      child.nodeType === (this.window as any).Node.TEXT_NODE && child.textContent && child.textContent.trim()
    ) as Text[];

    // Clear existing children
    const yogaNode = element[YOGA_NODE]!;
    while (yogaNode.getChildCount() > 0) {
      yogaNode.removeChild(yogaNode.getChild(0));
    }

    // If this element has text content but no element children, it's a leaf node
    // Set up measurement function for intrinsic sizing
    if (textNodes.length > 0 && elementChildren.length === 0) {
      const measureFunc = TextMeasurement.createMeasureFunction(element);
      yogaNode.setMeasureFunc(measureFunc);
      return; // Leaf nodes don't have Yoga children
    }

    // Add element children to Yoga tree
    let yogaChildIndex = 0;
    for (const child of elementChildren) {
      const computedStyle = child.ownerDocument!.defaultView!.getComputedStyle(child);
      let display = computedStyle.getPropertyValue('display') || this.getDefaultDisplay(child.tagName);

      // Demote block/flex children inside inline-ish parents to inline-block
      // This ensures everything flows together in inline layout without modifying CSS
      const parentDisplay = element.ownerDocument!.defaultView!.getComputedStyle(element).getPropertyValue('display') || this.getDefaultDisplay(element.tagName);
      if ((parentDisplay === 'inline' || parentDisplay === 'inline-block') && (display === 'block' || display === 'flex')) {
        display = 'inline-block'; // Treat as inline-block for layout purposes
      }

      if (display === 'inline-block' || display === 'inline') {
        // Inline and inline-block elements do NOT get Yoga nodes
        // They are handled by parent's inline layout system via processInlineLayout
        // Note: inline layout happens after Yoga computation in extractLayout
      } else {
        // Block/flex elements use normal Yoga tree building
        this.buildYogaTree(child);
        yogaNode.insertChild(child[YOGA_NODE]!, yogaChildIndex++);
      }
    }
  }

  /**
   * Extract computed layout from Yoga
   */
  private extractLayout(element: Element, parentX: number, parentY: number): void {
    if (!element[YOGA_NODE]) return;

    // Get computed layout from Yoga
    const layout = element[YOGA_NODE]!.getComputedLayout();

    // Debug the conversion from Yoga layout to DOM bounds
    const finalX = parentX + layout.left;
    const finalY = parentY + layout.top;
    const tagName = (element as any).tagName || 'UNKNOWN';
    
    // Debug overflow only if it occurs
    if (finalX + layout.width > 105) { // Terminal width
      console.log(`❌ LAYOUT OVERFLOW [${tagName}]: right=${finalX + layout.width} exceeds terminal width 105`);
    }

    // Convert floating-point Yoga coordinates to integer terminal positions
    // Use Math.floor to ensure we never exceed container bounds
    const intX = Math.floor(finalX);
    const intY = Math.floor(finalY);
    const intWidth = Math.floor(layout.width);
    const intHeight = Math.floor(layout.height);
    
    // Rounding debug removed for cleaner output

    // Store computed bounds in Symbol property
    element[ELEMENT_BOUNDS] = new (this.window as any).DOMRect(
      intX,
      intY,
      intWidth,
      intHeight
    );

    // Extract layout for children using standard DOM traversal
    const children = Array.from(element.childNodes).filter(child =>
      child.nodeType === this.window.Node.ELEMENT_NODE
    ) as Element[];

    const bounds = element[ELEMENT_BOUNDS];
    if (!bounds) {
      throw new Error('Element bounds not set before layout processing');
    }

    // Handle inline layout for inline children
    this.processInlineLayout(element, children, bounds);

    // Process Text node children that need text wrapping
    this.processTextNodeLayout(element, bounds);

    // Process children that have Yoga nodes (block/flex/inline-block)
    for (const child of children) {
      if (child[YOGA_NODE]) {
        // Calculate inner content area by accounting for parent's padding
        // Child elements are positioned relative to parent's content area, not outer bounds
        const style = this.window.getComputedStyle(element);
        const paddingLeft = this.parseValue(style.getPropertyValue('padding-left'), 0);
        const paddingTop = this.parseValue(style.getPropertyValue('padding-top'), 0);
        
        const innerX = bounds.x + paddingLeft;
        const innerY = bounds.y + paddingTop;
        
        // Parent content area debug removed for cleaner output
        
        this.extractLayout(child, innerX, innerY);
      }
    }
  }

  /**
   * Process Text node children that need text wrapping within block elements
   */
  private processTextNodeLayout(element: Element, parentBounds: DOMRect): void {
    // Find direct Text node children
    const textNodes = Array.from(element.childNodes).filter(child =>
      child.nodeType === this.window.Node.TEXT_NODE
    ) as Text[];

    if (textNodes.length === 0) return;

    let currentY = parentBounds.y;

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      if (!text || !text.trim()) continue;

      // Use TextBreaker to break text into lines
      const breakResult = this.textBreaker.breakText(text, {
        maxWidth: parentBounds.width,
        breakWords: true
      });

      if (breakResult.lines.length > 0) {
        const textRects: TextRect[] = [];

        // Create TextRect for each line
        for (let i = 0; i < breakResult.lines.length; i++) {
          const line = breakResult.lines[i];
          
          // Create proper DOMRect using constructor
          const domRect = new this.window.DOMRect(parentBounds.x, currentY, line.width, 1);
          
          
          // Add text property to make it a TextRect
          const rect: TextRect = Object.assign(domRect, {
            text: line.text.trim()
          });

          textRects.push(rect);
          currentY += 1;
        }

        // Store text rectangles on the Text node
        (textNode as any)[ELEMENT_TEXT_RECTS] = textRects;
        
        // Also create a bounding rectangle
        if (textRects.length === 1) {
          (textNode as any)[ELEMENT_BOUNDS] = textRects[0];
        } else {
          const minY = Math.min(...textRects.map(r => r.y));
          const maxY = Math.max(...textRects.map(r => r.y + r.height));
          const maxWidth = Math.max(...textRects.map(r => r.width));
          
          (textNode as any)[ELEMENT_BOUNDS] = new this.window.DOMRect(
            parentBounds.x, 
            minY, 
            maxWidth, 
            maxY - minY
          );
        }
      }
    }
  }

  /**
   * Process inline layout for inline children with line-wrapping support
   * This handles pure inline elements that don't have Yoga nodes
   */
  private processInlineLayout(parent: Element, children: Element[], parentBounds: DOMRect): void {
    // Find ALL inline children that need layout
    const inlineChildren = children.filter(child => {
      const computedStyle = child.ownerDocument!.defaultView!.getComputedStyle(child);
      let display = computedStyle.getPropertyValue('display');
      let defaultDisplay = display || this.getDefaultDisplay(child.tagName);

      // Demote block/flex children inside inline-ish parents to inline-block
      const parentDisplay = parent.ownerDocument!.defaultView!.getComputedStyle(parent).getPropertyValue('display') || this.getDefaultDisplay(parent.tagName);
      if ((parentDisplay === 'inline' || parentDisplay === 'inline-block') && (defaultDisplay === 'block' || defaultDisplay === 'flex')) {
        defaultDisplay = 'inline-block';
      }

      // Include both inline and inline-block elements (both flow together in inline layout)
      return defaultDisplay === 'inline' || defaultDisplay === 'inline-block';
    });

    if (inlineChildren.length === 0) return;

    // Check if we need line wrapping at all
    const parentTextContent = this.getDirectTextContent(parent);
    let totalWidth = parentTextContent ? parentTextContent.length : 0;

    // Quick check: calculate total width needed
    for (const child of inlineChildren) {
      const computedStyle = child.ownerDocument!.defaultView!.getComputedStyle(child);
      const marginLeft = parseInt(computedStyle.getPropertyValue('margin-left')) || 0;
      const marginRight = parseInt(computedStyle.getPropertyValue('margin-right')) || 0;

      totalWidth += marginLeft;

      let display = computedStyle.getPropertyValue('display');
      let defaultDisplay = display || this.getDefaultDisplay(child.tagName);
      if (defaultDisplay === 'inline-block') {
        const size = this.measureInlineBlockElement(child);
        totalWidth += size.width;
      } else {
        const content = child.textContent || '';
        totalWidth += Math.max(this.getTextWidth(content), 1);
      }

      totalWidth += marginRight;
    }

    // If everything fits on one line, use simple layout
    if (totalWidth <= parentBounds.width) {
      this.processSimpleInlineLayout(parent, inlineChildren, parentBounds);
      return;
    }

    // Build the content for line breaking
    let currentPosition = 0;
    const inlineElements: InlineElement[] = [];

    // Account for parent's direct text content first
    if (parentTextContent) {
      currentPosition = parentTextContent.length;
    }

    // Convert child elements to InlineElement format for TextBreaker
    for (const child of inlineChildren) {
      const computedStyle = child.ownerDocument!.defaultView!.getComputedStyle(child);
      let display = computedStyle.getPropertyValue('display');
      let defaultDisplay = display || this.getDefaultDisplay(child.tagName);

      // Apply horizontal margins
      const marginLeft = parseInt(computedStyle.getPropertyValue('margin-left')) || 0;
      const marginRight = parseInt(computedStyle.getPropertyValue('margin-right')) || 0;

      // Add left margin space if needed
      if (marginLeft > 0) {
        currentPosition += marginLeft;
      }

      let width: number;
      let height: number;
      let breakable: boolean;

      if (defaultDisplay === 'inline-block') {
        // Inline-block: atomic units that cannot break
        const size = this.measureInlineBlockElement(child);
        width = size.width;
        height = size.height;
        breakable = false;
      } else {
        // Pure inline: can break across lines
        const content = child.textContent || '';
        width = Math.max(this.getTextWidth(content), 1);
        height = 1;
        breakable = true;
      }

      inlineElements.push({
        position: currentPosition,
        width,
        height,
        breakable,
        element: child
      });

      currentPosition += width + marginRight;
    }

    // Build the full text content (parent text + inline text)
    let fullText = parentTextContent || '';
    let textPosition = fullText.length;

    // Process elements in order to build the full text
    for (let i = 0; i < inlineElements.length; i++) {
      const inlineEl = inlineElements[i];
      const child = inlineEl.element as Element;
      const childText = child.textContent || '';

      // Pad with spaces to reach the element's position
      while (textPosition < inlineEl.position) {
        fullText += ' ';
        textPosition++;
      }

      // Update element position to match actual text position
      inlineEl.position = textPosition;

      // For inline elements, insert their text
      // For inline-block, insert placeholder spaces
      if (inlineEl.breakable) {
        fullText += childText;
        textPosition += childText.length;
      } else {
        // Use spaces as placeholders for inline-block width
        fullText += ' '.repeat(inlineEl.width);
        textPosition += inlineEl.width;
      }
    }

    // Use TextBreaker to compute line breaks
    const breakResult = this.textBreaker.breakText(fullText, {
      maxWidth: parentBounds.width,
      breakWords: true,
      inlineElements
    });

    // Apply the computed layout to elements
    this.applyLineBreaksToElements(inlineChildren, breakResult, parentBounds, inlineElements);
  }

  /**
   * Process simple inline layout when everything fits on one line
   */
  private processSimpleInlineLayout(parent: Element, children: Element[], parentBounds: DOMRect): void {
    let currentX = parentBounds.x;
    let currentY = parentBounds.y;

    // Account for parent's own text content before inline children
    const parentTextContent = this.getDirectTextContent(parent);
    if (parentTextContent) {
      currentX += parentTextContent.length;
    }

    for (const child of children) {
      const computedStyle = child.ownerDocument!.defaultView!.getComputedStyle(child);
      let display = computedStyle.getPropertyValue('display');
      let defaultDisplay = display || this.getDefaultDisplay(child.tagName);

      // Demote block/flex children inside inline-ish parents to inline-block
      const parentDisplay = parent.ownerDocument!.defaultView!.getComputedStyle(parent).getPropertyValue('display') || this.getDefaultDisplay(parent.tagName);
      if ((parentDisplay === 'inline' || parentDisplay === 'inline-block') && (defaultDisplay === 'block' || defaultDisplay === 'flex')) {
        defaultDisplay = 'inline-block';
      }

      // Apply horizontal margins
      const marginLeft = parseInt(computedStyle.getPropertyValue('margin-left')) || 0;
      const marginRight = parseInt(computedStyle.getPropertyValue('margin-right')) || 0;

      // Position element with left margin
      currentX += marginLeft;

      // Size element based on its display type
      let width: number;
      let height: number;

      if (defaultDisplay === 'inline-block') {
        // Inline-block elements use intrinsic sizing
        const size = this.measureInlineBlockElement(child);
        width = size.width;
        height = size.height;
      } else {
        // Pure inline elements use content-based sizing
        const content = child.textContent || '';
        width = Math.max(this.getTextWidth(content), 1);
        height = 1;
      }

      // Set the element's bounds
      const childBounds = new this.window.DOMRect(currentX, currentY, width, height);
      child[ELEMENT_BOUNDS] = childBounds;
      child[ELEMENT_RECTS] = [childBounds];

      // Advance x position for next inline element
      currentX += width + marginRight;

      // Recursively process any nested inline children
      const nestedChildren = Array.from(child.childNodes).filter(node =>
        node.nodeType === this.window.Node.ELEMENT_NODE
      ) as Element[];

      if (nestedChildren.length > 0) {
        const childBounds = child[ELEMENT_BOUNDS];
        if (!childBounds) {
          throw new Error('Child element bounds not set before processing nested inline children');
        }
        this.processInlineLayout(child, nestedChildren, childBounds);
      }
    }
  }

  /**
   * Apply line break results to inline elements with multi-rect support
   */
  private applyLineBreaksToElements(elements: Element[], breakResult: BreakResult, parentBounds: DOMRect, inlineElements: InlineElement[]): void {
    // Create a map of elements to their positions from the inlineElements array
    const elementPositions = new Map<Element, {
      startPos: number;
      endPos: number;
      width: number;
      isInlineBlock: boolean;
    }>();

    // Use the positions from inlineElements that we passed to TextBreaker
    for (const inlineEl of inlineElements) {
      const element = inlineEl.element as Element;
      elementPositions.set(element, {
        startPos: inlineEl.position,
        endPos: inlineEl.position + inlineEl.width,
        width: inlineEl.width,
        isInlineBlock: !inlineEl.breakable
      });
    }

    // Track multiple rectangles for elements that span multiple lines
    const elementRects = new Map<Element, DOMRect[]>();
    const elementTextRects = new Map<Element, TextRect[]>();

    // Position elements based on which lines they overlap with
    let currentY = parentBounds.y;

    for (let lineIndex = 0; lineIndex < breakResult.lines.length; lineIndex++) {
      const line = breakResult.lines[lineIndex];

      // Check which elements overlap with this line's text range
      for (const [element, elemPos] of elementPositions) {
        // Check if element overlaps with this line
        const overlapsLine = elemPos.startPos < line.endIndex && elemPos.endPos > line.startIndex;

        if (overlapsLine) {
          if (elemPos.isInlineBlock) {
            // Inline-block: atomic, position only once on the line where it starts
            if (!elementRects.has(element) && elemPos.startPos >= line.startIndex && elemPos.startPos < line.endIndex) {
              const lineX = parentBounds.x + (elemPos.startPos - line.startIndex);
              const rect = new this.window.DOMRect(lineX, currentY, elemPos.width, 1);
              elementRects.set(element, [rect]);
            }
          } else {
            // Inline element: can span multiple lines, create rect for each line fragment
            if (!elementRects.has(element)) {
              elementRects.set(element, []);
              elementTextRects.set(element, []);
            }

            // Calculate this line's fragment of the element
            const fragmentStartPos = Math.max(elemPos.startPos, line.startIndex);
            const fragmentEndPos = Math.min(elemPos.endPos, line.endIndex);

            if (fragmentStartPos < fragmentEndPos) {
              const lineX = parentBounds.x + (fragmentStartPos - line.startIndex);
              const fragmentWidth = fragmentEndPos - fragmentStartPos;
              const rect = new this.window.DOMRect(lineX, currentY, fragmentWidth, 1);

              // Extract the text content for this fragment
              const elementText = element.textContent || '';
              const fragmentText = elementText.slice(
                fragmentStartPos - elemPos.startPos, 
                fragmentEndPos - elemPos.startPos
              );

              // Create TextRect with both position and content
              const textRect: TextRect = Object.assign(Object.create(this.window.DOMRect.prototype), {
                x: rect.x,
                y: rect.y, 
                width: rect.width,
                height: rect.height,
                text: fragmentText
              });

              elementRects.get(element)!.push(rect);
              elementTextRects.get(element)!.push(textRect);
            }
          }
        }
      }

      // Move to next line
      currentY += 1;
    }

    // Apply computed rectangles to elements
    for (const [element, rects] of elementRects) {
      if (rects.length > 0) {
        // Set ELEMENT_RECTS to all rectangles
        element[ELEMENT_RECTS] = rects;
        
        // Set ELEMENT_TEXT_RECTS to text rectangles with content
        const textRects = elementTextRects.get(element);
        if (textRects) {
          element[ELEMENT_TEXT_RECTS] = textRects;
        }

        // Set ELEMENT_BOUNDS to bounding rectangle of all rects
        if (rects.length === 1) {
          element[ELEMENT_BOUNDS] = rects[0];
        } else {
          // Calculate bounding rectangle that encompasses all line fragments
          const minX = Math.min(...rects.map(r => r.x));
          const maxX = Math.max(...rects.map(r => r.x + r.width));
          const minY = Math.min(...rects.map(r => r.y));
          const maxY = Math.max(...rects.map(r => r.y + r.height));

          element[ELEMENT_BOUNDS] = new this.window.DOMRect(minX, minY, maxX - minX, maxY - minY);
        }

        // Recursively process nested inline children with proper bounds
        const nestedChildren = Array.from(element.childNodes).filter(node =>
          node.nodeType === this.window.Node.ELEMENT_NODE
        ) as Element[];

        if (nestedChildren.length > 0) {
          // For nested elements in multi-line inline parents, we need special handling
          this.processNestedInlineLayout(element, nestedChildren, rects, elementPositions);
        }
      }
    }

    // Ensure all elements have bounds set (fallback for elements not positioned)
    for (const element of elements) {
      if (!element[ELEMENT_BOUNDS]) {
        // Set a default position
        const defaultBounds = new this.window.DOMRect(parentBounds.x, parentBounds.y, 1, 1);
        element[ELEMENT_BOUNDS] = defaultBounds;
        element[ELEMENT_RECTS] = [defaultBounds];
      }
    }
  }

  /**
   * Process nested inline layout for elements whose parent spans multiple lines
   * This handles complex cases where nested inline elements need positioning within
   * the context of their parent's multiple rectangles
   */
  private processNestedInlineLayout(
    parent: Element,
    children: Element[],
    parentRects: DOMRect[],
    elementPositions: Map<Element, { startPos: number; endPos: number; width: number; isInlineBlock: boolean; }>
  ): void {
    // For now, use a simplified approach: position nested elements relative to the first parent rectangle
    // This handles most common cases while being predictable

    if (parentRects.length === 0) return;

    // Use the first rectangle as the base for nested layout
    const baseRect = parentRects[0];

    // Get parent's direct text content to offset nested elements properly
    const parentTextContent = this.getDirectTextContent(parent);
    let baseX = baseRect.x;

    // Account for parent's text content before inline children
    if (parentTextContent) {
      baseX += parentTextContent.length;
    }

    // Position nested inline children sequentially
    let currentX = baseX;
    const currentY = baseRect.y;

    for (const child of children) {
      const computedStyle = child.ownerDocument!.defaultView!.getComputedStyle(child);
      let display = computedStyle.getPropertyValue('display') || this.getDefaultDisplay(child.tagName);

      // Apply demoting logic
      const parentDisplay = parent.ownerDocument!.defaultView!.getComputedStyle(parent).getPropertyValue('display') || this.getDefaultDisplay(parent.tagName);
      if ((parentDisplay === 'inline' || parentDisplay === 'inline-block') && (display === 'block' || display === 'flex')) {
        display = 'inline-block';
      }

      // Apply horizontal margins
      const marginLeft = parseInt(computedStyle.getPropertyValue('margin-left')) || 0;
      const marginRight = parseInt(computedStyle.getPropertyValue('margin-right')) || 0;

      currentX += marginLeft;

      // Size and position the nested element
      let width: number;
      let height: number;

      if (display === 'inline-block') {
        const size = this.measureInlineBlockElement(child);
        width = size.width;
        height = size.height;
      } else {
        const content = child.textContent || '';
        width = Math.max(this.getTextWidth(content), 1);
        height = 1;
      }

      // Set bounds for the nested element
      const nestedChildBounds = new this.window.DOMRect(currentX, currentY, width, height);
      child[ELEMENT_BOUNDS] = nestedChildBounds;
      child[ELEMENT_RECTS] = [nestedChildBounds];

      currentX += width + marginRight;

      // Recursively handle further nesting
      const grandChildren = Array.from(child.childNodes).filter(node =>
        node.nodeType === this.window.Node.ELEMENT_NODE
      ) as Element[];

      if (grandChildren.length > 0) {
        const childBounds = child[ELEMENT_BOUNDS];
        if (!childBounds) {
          throw new Error('Child element bounds not set before processing grand children');
        }
        this.processInlineLayout(child, grandChildren, childBounds);
      }
    }
  }

  /**
   * Get direct text content of an element (only immediate text nodes, not nested elements)
   */
  private getDirectTextContent(element: Element): string {
    let directText = '';
    for (const child of element.childNodes) {
      if (child.nodeType === this.window.Node.TEXT_NODE) {
        directText += child.textContent || '';
      }
    }
    return directText;
  }

  /**
   * Get default display value for HTML tag
   */
  private getDefaultDisplay(tagName: string): string {
    switch (tagName.toLowerCase()) {
      case 'span':
      case 'a':
      case 'strong':
      case 'em':
      case 'b':
      case 'i':
      case 'code':
        return 'inline';
      case 'div':
      case 'p':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
      case 'button':
        return 'block';
      default:
        return 'block';
    }
  }

  /**
   * Map CSS styles to Yoga properties
   */
  private applyStylesToYoga(element: Element): void {
    if (!element[YOGA_NODE]) return;

    // Use computed style for proper CSS cascade
    const computedStyle = element.ownerDocument!.defaultView!.getComputedStyle(element);
    const style = computedStyle;
    const node = element[YOGA_NODE]!;

    // Display type
    const display = style.getPropertyValue('display');
    if (display === 'none') {
      node.setDisplay(this.yoga.DISPLAY_NONE);
      return;
    } else if (display === 'flex') {
      node.setDisplay(this.yoga.DISPLAY_FLEX);
    } else if (display === 'block') {
      // Block display is syntactic sugar for flex column + stretch
      node.setDisplay(this.yoga.DISPLAY_FLEX);
      node.setFlexDirection(this.yoga.FLEX_DIRECTION_COLUMN);
      node.setAlignItems(this.yoga.ALIGN_STRETCH);
    }
    // inline elements use measurement functions, no special display setting needed

    // Flex direction (not allowed for block display)
    const flexDirection = style.getPropertyValue('flex-direction');
    if (flexDirection && display !== 'block') {
      const flexDir = {
        'row': this.yoga.FLEX_DIRECTION_ROW,
        'column': this.yoga.FLEX_DIRECTION_COLUMN,
        'row-reverse': this.yoga.FLEX_DIRECTION_ROW_REVERSE,
        'column-reverse': this.yoga.FLEX_DIRECTION_COLUMN_REVERSE
      }[flexDirection];
      if (flexDir !== undefined) node.setFlexDirection(flexDir);
    }

    // Justify content
    const justifyContent = style.getPropertyValue('justify-content');
    if (justifyContent) {
      const justify = {
        'flex-start': this.yoga.JUSTIFY_FLEX_START,
        'center': this.yoga.JUSTIFY_CENTER,
        'flex-end': this.yoga.JUSTIFY_FLEX_END,
        'space-between': this.yoga.JUSTIFY_SPACE_BETWEEN,
        'space-around': this.yoga.JUSTIFY_SPACE_AROUND
      }[justifyContent];
      if (justify !== undefined) node.setJustifyContent(justify);
    }

    // Align items (not allowed for block display)
    const alignItems = style.getPropertyValue('align-items');
    if (alignItems && display !== 'block') {
      const align = {
        'stretch': this.yoga.ALIGN_STRETCH,
        'flex-start': this.yoga.ALIGN_FLEX_START,
        'center': this.yoga.ALIGN_CENTER,
        'flex-end': this.yoga.ALIGN_FLEX_END
      }[alignItems];
      if (align !== undefined) node.setAlignItems(align);
    }

    // Dimensions
    const widthStr = style.getPropertyValue('width');
    const heightStr = style.getPropertyValue('height');

    // Parse width - handle ch units
    let width = NaN;
    if (widthStr) {
      if (widthStr.endsWith('ch')) {
        width = parseFloat(widthStr); // "80ch" -> 80
      } else if (widthStr.endsWith('%')) {
        // For percentage, we'd need parent context, skip for now
      } else {
        width = parseInt(widthStr);
      }
      
      // Debug width parsing
      if (!isNaN(width)) {
        console.log(`DEBUG Yoga: Setting width on ${(element as any).tagName || 'UNKNOWN'}: widthStr="${widthStr}", width=${width}`);
      }
    }

    // Parse height - handle ch units
    let height = NaN;
    if (heightStr) {
      if (heightStr.endsWith('ch')) {
        height = parseFloat(heightStr);
      } else {
        height = parseInt(heightStr);
      }
    }
    const minWidth = parseInt(style.getPropertyValue('min-width'));
    const minHeight = parseInt(style.getPropertyValue('min-height'));
    const maxWidth = parseInt(style.getPropertyValue('max-width'));
    const maxHeight = parseInt(style.getPropertyValue('max-height'));

    if (!isNaN(width)) node.setWidth(width);
    if (!isNaN(height)) node.setHeight(height);
    if (!isNaN(minWidth)) node.setMinWidth(minWidth);
    if (!isNaN(minHeight)) node.setMinHeight(minHeight);
    if (!isNaN(maxWidth)) node.setMaxWidth(maxWidth);
    if (!isNaN(maxHeight)) node.setMaxHeight(maxHeight);


    // Flex properties (CSS defaults already set in setupYogaNode)
    const flexGrow = parseFloat(style.getPropertyValue('flex-grow'));
    const flexShrink = parseFloat(style.getPropertyValue('flex-shrink'));
    
    // Only override defaults if explicitly specified in CSS
    if (!isNaN(flexGrow)) node.setFlexGrow(flexGrow);
    if (!isNaN(flexShrink)) node.setFlexShrink(flexShrink);
    
    // TODO: Add flex-basis support for complete CSS compatibility

    // Position type (CSS default: static already set in setupYogaNode)
    const position = style.getPropertyValue('position');
    if (position === 'relative') {
      node.setPositionType(this.yoga.POSITION_TYPE_RELATIVE);
    } else if (position === 'absolute') {
      node.setPositionType(this.yoga.POSITION_TYPE_ABSOLUTE);
    } else if (position === 'static') {
      node.setPositionType(this.yoga.POSITION_TYPE_STATIC);
    }
    // If unspecified, keep the CSS default (static) set in setupYogaNode

    // Position offset values (top, right, bottom, left)
    if (position === 'relative' || position === 'absolute') {
      const top = parseInt(style.getPropertyValue('top'));
      const right = parseInt(style.getPropertyValue('right'));
      const bottom = parseInt(style.getPropertyValue('bottom'));
      const left = parseInt(style.getPropertyValue('left'));

      if (!isNaN(top)) node.setPosition(this.yoga.EDGE_TOP, top);
      if (!isNaN(right)) node.setPosition(this.yoga.EDGE_RIGHT, right);
      if (!isNaN(bottom)) node.setPosition(this.yoga.EDGE_BOTTOM, bottom);
      if (!isNaN(left)) node.setPosition(this.yoga.EDGE_LEFT, left);
    }

    // Padding
    const [top, right, bottom, left] = this.getPadding(style);
    if (top || right || bottom || left) {
      node.setPadding(this.yoga.EDGE_TOP, top);
      node.setPadding(this.yoga.EDGE_RIGHT, right);
      node.setPadding(this.yoga.EDGE_BOTTOM, bottom);
      node.setPadding(this.yoga.EDGE_LEFT, left);
    }

    // Margin
    const margin = this.getMargin(style);
    if (margin[0] || margin[1] || margin[2] || margin[3]) {
      node.setMargin(this.yoga.EDGE_TOP, margin[0]);
      node.setMargin(this.yoga.EDGE_RIGHT, margin[1]);
      node.setMargin(this.yoga.EDGE_BOTTOM, margin[2]);
      node.setMargin(this.yoga.EDGE_LEFT, margin[3]);
    }
  }

  /**
   * Measure inline element size based on text content only (no chrome)
   */
  private measureInlineElement(element: Element): { width: number; height: number } {
    const content = element.textContent || '';

    if (!content) {
      return { width: 0, height: 0 };
    }

    const computedStyle = element.ownerDocument!.defaultView!.getComputedStyle(element);
    const style = computedStyle;
    const wordWrap = style.getPropertyValue('word-wrap') || 'normal';
    const whiteSpace = style.getPropertyValue('white-space') || 'normal';

    // For inline elements, we size based on content without wrapping constraints
    // They shrink to fit their content
    if (wordWrap === 'nowrap' || whiteSpace === 'nowrap' || whiteSpace === 'pre') {
      return { width: this.getTextWidth(content), height: 1 };
    }

    // For normal wrapping, inline elements still size to their content
    // Wrapping happens at the container level during inline layout
    const lines = content.split('\n');
    const width = Math.max(...lines.map(line => this.getTextWidth(line)));
    return { width, height: lines.length };
  }

  /**
   * Measure text with width constraints using TextBreaker
   */
  private measureTextWithWrapping(text: string, maxWidth: number, inlineElements: InlineElement[] = []): { width: number; height: number } {
    if (!text && inlineElements.length === 0) {
      return { width: 0, height: 0 };
    }

    const result = this.textBreaker.breakText(text, {
      maxWidth,
      breakWords: true,
      inlineElements
    });

    return {
      width: result.maxLineWidth,
      height: result.totalHeight
    };
  }

  /**
   * Measure inline-block element size with full visual dimensions
   */
  private measureInlineBlockElement(element: Element): { width: number; height: number } {
    const computedStyle = element.ownerDocument!.defaultView!.getComputedStyle(element);
    const style = computedStyle;

    // 1. Check for explicit dimensions first (highest priority)
    const widthValue = parseInt(style.getPropertyValue('width'));
    const heightValue = parseInt(style.getPropertyValue('height'));
    let width = !isNaN(widthValue) ? widthValue : null;
    let height = !isNaN(heightValue) ? heightValue : null;

    // 2. If no explicit dimensions, calculate from content + chrome
    if (width === null || height === null) {
      const contentSize = this.measureInlineElement(element);
      const [padTop, padRight, padBottom, padLeft] = this.getPadding(style);
      const borderWidth = this.getBorderWidth(element);

      if (width === null) {
        width = contentSize.width + padLeft + padRight + borderWidth * 2;
      }
      if (height === null) {
        height = contentSize.height + padTop + padBottom + borderWidth * 2;
      }
    }

    // 3. Apply minimum constraints
    const minWidth = parseInt(style.getPropertyValue('min-width'));
    const minHeight = parseInt(style.getPropertyValue('min-height'));
    if (!isNaN(minWidth)) {
      width = Math.max(width, minWidth);
    }
    if (!isNaN(minHeight)) {
      height = Math.max(height, minHeight);
    }

    // 4. Apply maximum constraints
    const maxWidth = parseInt(style.getPropertyValue('max-width'));
    const maxHeight = parseInt(style.getPropertyValue('max-height'));
    if (!isNaN(maxWidth)) {
      width = Math.min(width, maxWidth);
    }
    if (!isNaN(maxHeight)) {
      height = Math.min(height, maxHeight);
    }

    return { width, height };
  }

  /**
   * Get border width from element style
   */
  private getBorderWidth(element: Element): number {
    const computedStyle = element.ownerDocument!.defaultView!.getComputedStyle(element);
    const style = computedStyle;
    const borderWidth = style.getPropertyValue('border-width');
    return parseInt(borderWidth) || 0;
  }

  /**
   * Get visual width of text using Bun's stringWidth
   */
  private getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }

  /**
   * Get margin from element style (CSS property parsing)
   */
  private getMargin(style: CSSStyleDeclaration): [number, number, number, number] {

    // Try individual margin properties first
    const marginTop = parseInt(style.getPropertyValue('margin-top')) || 0;
    const marginRight = parseInt(style.getPropertyValue('margin-right')) || 0;
    const marginBottom = parseInt(style.getPropertyValue('margin-bottom')) || 0;
    const marginLeft = parseInt(style.getPropertyValue('margin-left')) || 0;

    // If any individual properties are set, use them
    if (marginTop || marginRight || marginBottom || marginLeft) {
      return [marginTop, marginRight, marginBottom, marginLeft];
    }

    // Otherwise, parse shorthand margin property
    const margin = style.getPropertyValue('margin');
    if (!margin) {
      return [0, 0, 0, 0];
    }

    // Parse CSS margin shorthand (e.g., "10px" or "10px 5px")
    const values = margin.split(/\s+/).map(v => parseInt(v) || 0);

    switch (values.length) {
      case 1: return [values[0], values[0], values[0], values[0]];
      case 2: return [values[0], values[1], values[0], values[1]];
      case 3: return [values[0], values[1], values[2], values[1]];
      case 4: return [values[0], values[1], values[2], values[3]];
      default: return [0, 0, 0, 0];
    }
  }
}
