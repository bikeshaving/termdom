/**
 * LayoutEngine - Yoga layout integration for HTML-to-Terminal rendering
 * 
 * Provides flexbox layout capabilities using Facebook's Yoga layout engine.
 * Maps CSS styles to Yoga properties and computes element positions/sizes.
 * Works with standard HTML elements enhanced with Symbol properties.
 */

import { HTMLElement, DOMRect, Node } from 'happy-dom';
import { YOGA_BOUNDS, YOGA_NODE } from '../core/HTMLExtensions.js';
import { TextMeasurement } from './TextMeasurement.js';
import { GreedyTextBreaker, type InlineElement } from '../text/index.js';
import Yoga from 'yoga-layout';
import type * as YogaTypes from 'yoga-layout';

/**
 * Layout Engine using Yoga for flexbox calculations
 */
export class LayoutEngine {
  private yoga: typeof Yoga;
  private textBreaker: GreedyTextBreaker;

  constructor() {
    this.yoga = Yoga;
    this.textBreaker = new GreedyTextBreaker();
  }

  /**
   * Compute layout for an element tree using Yoga
   */
  computeLayout(root: Element, containerWidth: number, containerHeight: number): void {
    if (!(root instanceof HTMLElement)) {
      // Skip non-HTML elements (like Document, Text nodes)
      for (const child of root.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          this.computeLayout(child as HTMLElement, containerWidth, containerHeight);
        }
      }
      return;
    }

    // Ensure root has a Yoga node
    if (!root[YOGA_NODE]) {
      this.setupYogaNode(root);
    }

    // Build Yoga tree and compute layout
    this.buildYogaTree(root);
    root[YOGA_NODE]!.calculateLayout(containerWidth, containerHeight);
    this.extractLayout(root, 0, 0);
  }


  /**
   * Get padding from element style (CSS property parsing)
   */
  private getPadding(element: HTMLElement): [number, number, number, number] {
    const style = element.style;
    
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
  private setupYogaNode(element: HTMLElement): void {
    if (element[YOGA_NODE]) return;

    const yogaNode = this.yoga.Node.create();
    element[YOGA_NODE] = yogaNode;
    
    // Apply styles to Yoga node
    this.applyStylesToYoga(element);
  }

  /**
   * Build Yoga tree recursively, handling inline elements specially
   */
  private buildYogaTree(element: HTMLElement): void {
    this.setupYogaNode(element);
    
    // Get element children using standard DOM traversal
    const children = Array.from(element.childNodes).filter(child => 
      child.nodeType === Node.ELEMENT_NODE
    ) as HTMLElement[];
    
    // Clear existing children
    const yogaNode = element[YOGA_NODE]!;
    while (yogaNode.getChildCount() > 0) {
      yogaNode.removeChild(yogaNode.getChild(0));
    }
    
    // Add children to Yoga tree, but handle inline/inline-block elements specially
    let yogaChildIndex = 0;
    for (const child of children) {
      const display = child.style.getPropertyValue('display');
      if (display === 'inline' || display === 'inline-block') {
        // Inline/inline-block elements are handled by separate inline layout system
        // They participate in Yoga as flex children but size themselves
        this.setupYogaNode(child);
        
        // Set their size based on content + visual chrome before adding to Yoga tree
        const visualSize = this.measureInlineBlockElement(child);
        child[YOGA_NODE]!.setWidth(visualSize.width);
        child[YOGA_NODE]!.setHeight(visualSize.height);
        
        yogaNode.insertChild(child[YOGA_NODE]!, yogaChildIndex++);
      } else {
        // Flex elements use normal Yoga tree building
        this.buildYogaTree(child);
        yogaNode.insertChild(child[YOGA_NODE]!, yogaChildIndex++);
      }
    }
  }

  /**
   * Extract computed layout from Yoga
   */
  private extractLayout(element: HTMLElement, parentX: number, parentY: number): void {
    if (!element[YOGA_NODE]) return;

    // Get computed layout from Yoga
    const layout = element[YOGA_NODE]!.getComputedLayout();
    
    // Store computed bounds in Symbol property
    element[YOGA_BOUNDS] = new DOMRect(
      parentX + layout.left,
      parentY + layout.top,
      layout.width,
      layout.height
    );

    // Extract layout for children using standard DOM traversal
    const children = Array.from(element.childNodes).filter(child => 
      child.nodeType === Node.ELEMENT_NODE
    ) as HTMLElement[];
    
    const bounds = element[YOGA_BOUNDS];
    for (const child of children) {
      this.extractLayout(child, bounds.x, bounds.y);
    }
  }

  /**
   * Map CSS styles to Yoga properties
   */
  private applyStylesToYoga(element: HTMLElement): void {
    if (!element[YOGA_NODE]) return;

    const style = element.style;
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
    const width = parseInt(style.getPropertyValue('width'));
    const height = parseInt(style.getPropertyValue('height'));
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

    // Flex properties
    const flexGrow = parseFloat(style.getPropertyValue('flex-grow'));
    const flexShrink = parseFloat(style.getPropertyValue('flex-shrink'));
    if (!isNaN(flexGrow)) node.setFlexGrow(flexGrow);
    if (!isNaN(flexShrink)) node.setFlexShrink(flexShrink);

    // Padding
    const [top, right, bottom, left] = this.getPadding(element);
    if (top || right || bottom || left) {
      node.setPadding(this.yoga.EDGE_TOP, top);
      node.setPadding(this.yoga.EDGE_RIGHT, right);
      node.setPadding(this.yoga.EDGE_BOTTOM, bottom);
      node.setPadding(this.yoga.EDGE_LEFT, left);
    }

    // Margin
    const margin = this.getMargin(element);
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
  private measureInlineElement(element: HTMLElement): { width: number; height: number } {
    const content = element.textContent || '';
    
    if (!content) {
      return { width: 0, height: 0 };
    }

    const style = element.style;
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
  private measureInlineBlockElement(element: HTMLElement): { width: number; height: number } {
    const style = element.style;
    
    // 1. Check for explicit dimensions first (highest priority)
    const widthValue = parseInt(style.getPropertyValue('width'));
    const heightValue = parseInt(style.getPropertyValue('height'));
    let width = !isNaN(widthValue) ? widthValue : null;
    let height = !isNaN(heightValue) ? heightValue : null;
    
    // 2. If no explicit dimensions, calculate from content + chrome
    if (width === null || height === null) {
      const contentSize = this.measureInlineElement(element);
      const [padTop, padRight, padBottom, padLeft] = this.getPadding(element);
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
  private getBorderWidth(element: HTMLElement): number {
    const borderWidth = element.style.getPropertyValue('border-width');
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
  private getMargin(element: HTMLElement): [number, number, number, number] {
    const style = element.style;
    
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