/**
 * LayoutEngine - Yoga layout integration for TOM
 * 
 * Provides flexbox layout capabilities using Facebook's Yoga layout engine.
 * Maps TOM styles to Yoga properties and computes element positions/sizes.
 */

import { TTYElement } from '../core/TTYElement.js';
import { TextMeasurement } from './TextMeasurement.js';
import { GreedyTextBreaker, type InlineElement } from '../text/index.js';
import Yoga from 'yoga-layout';

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
    if (!(root instanceof TTYElement)) {
      // For non-TTY elements, just process children using standard DOM traversal
      for (const child of root.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          this.computeLayout(child as TTYElement, containerWidth, containerHeight);
        } else if (child.nodeType === Node.TEXT_NODE) {
          // Text nodes handled by parent element rendering
          continue;
        } else {
          // Unknown node type - skip
          console.warn(`Unknown node type: ${child.nodeType}, skipping layout`);
        }
      }
      return;
    }

    // Ensure root has a Yoga node
    if (!root.yogaNode) {
      this.setupYogaNode(root);
    }

    // Build Yoga tree and compute layout
    this.buildYogaTree(root);
    root.yogaNode.calculateLayout(containerWidth, containerHeight);
    this.extractLayout(root, 0, 0);
  }

  /**
   * Simple layout algorithm (temporary until Yoga integration)
   */
  private simpleLayout(element: TTYElement, x: number, y: number, width: number, height: number): void {
    // Set element bounds
    element.bounds = { x, y, width, height };

    // Get element children using standard DOM traversal
    const children = Array.from(element.childNodes).filter(child => 
      child.nodeType === Node.ELEMENT_NODE
    ) as TTYElement[];
    if (children.length === 0) return;

    const style = element.style;
    
    // Handle inline elements (participate in text flow)
    if (style.display === 'inline') {
      // Inline elements participate in text flow
      // Their sizing and positioning will be determined by Yoga measurement functions
      // For now, set basic bounds - TODO: implement proper inline layout with Yoga measurement
      element.bounds = { x, y, width, height };
      
      // Inline elements don't use flexbox for children - children flow as text
      // TODO: Implement measurement function for text flow
      return;
    }
    
    // Get content area (accounting for padding/margins)
    const [padTop, padRight, padBottom, padLeft] = this.getPadding(element);
    const contentArea = {
      x: x + padLeft,
      y: y + padTop,
      width: Math.max(0, width - padLeft - padRight),
      height: Math.max(0, height - padTop - padBottom)
    };
    
    // Everything else is flexbox in TOM - no block layout
    this.flexLayout(contentArea, children, style);
  }

  /**
   * Get padding from element style
   */
  private getPadding(element: TTYElement): [number, number, number, number] {
    const padding = element.style.padding;
    
    if (typeof padding === 'number') {
      return [padding, padding, padding, padding];
    }
    
    if (Array.isArray(padding)) {
      return padding;
    }
    
    return [0, 0, 0, 0];
  }

  /**
   * Flexbox layout - the only layout method in TOM
   */
  private flexLayout(contentArea: any, children: TTYElement[], style: any): void {
    if (children.length === 0) return;
    
    // Default to column if not specified (like CSS flexbox)
    const flexDirection = style.flexDirection || 'column';
    const isRow = flexDirection === 'row' || flexDirection === 'row-reverse';
    const isReverse = flexDirection.includes('reverse');
    
    // Calculate available space
    const availableSpace = isRow ? contentArea.width : contentArea.height;
    
    // Calculate minimum space needed
    let totalMinSize = 0;
    for (const child of children) {
      const minSize = isRow ? (child.style.minWidth || 0) : (child.style.minHeight || 0);
      totalMinSize += minSize;
    }
    
    // If minimum sizes exceed available space, we'll need scrolling (future feature)
    const hasEnoughSpace = totalMinSize <= availableSpace;
    
    // Distribute space respecting minimum sizes
    let remainingSpace = availableSpace - totalMinSize;
    const flexibleChildren = children.filter(child => {
      const minSize = isRow ? child.style.minWidth : child.style.minHeight;
      const fixedSize = isRow ? child.style.width : child.style.height;
      return !fixedSize && (!minSize || minSize < availableSpace / children.length);
    });
    
    const extraSpacePerChild = flexibleChildren.length > 0 
      ? Math.floor(remainingSpace / flexibleChildren.length)
      : 0;
    
    let offset = 0;
    const childrenToLayout = isReverse ? [...children].reverse() : children;
    
    for (const child of childrenToLayout) {
      if (isRow) {
        // Calculate width respecting minimum
        const minWidth = child.style.minWidth || 0;
        const fixedWidth = typeof child.style.width === 'number' ? child.style.width : null;
        const isFlexible = flexibleChildren.includes(child);
        const childWidth = fixedWidth || Math.max(minWidth, isFlexible ? minWidth + extraSpacePerChild : minWidth);
        const childHeight = contentArea.height;
        
        this.simpleLayout(
          child,
          contentArea.x + offset,
          contentArea.y,
          Math.min(childWidth, contentArea.width - offset), // Don't exceed container
          childHeight
        );
        offset += childWidth;
      } else {
        // Calculate height respecting minimum
        const minHeight = child.style.minHeight || 0;
        const fixedHeight = typeof child.style.height === 'number' ? child.style.height : null;
        const isFlexible = flexibleChildren.includes(child);
        const childHeight = fixedHeight || Math.max(minHeight, isFlexible ? minHeight + extraSpacePerChild : minHeight);
        const childWidth = contentArea.width;
        
        this.simpleLayout(
          child,
          contentArea.x,
          contentArea.y + offset,
          childWidth,
          Math.min(childHeight, contentArea.height - offset) // Don't exceed container
        );
        offset += childHeight;
      }
    }
  }


  /**
   * Setup Yoga node for element
   */
  private setupYogaNode(element: TTYElement): void {
    if (element.yogaNode) return;

    const yogaNode = this.yoga.Node.create();
    element.initializeYogaNode(yogaNode);
    
    // Inline elements integrate with Yoga as flex children but size themselves based on text content
    // They don't use measurement functions - sizing happens in the inline layout algorithm
    
    // Apply styles to Yoga node
    this.applyStylesToYoga(element);
  }

  /**
   * Build Yoga tree recursively, handling inline elements specially
   */
  private buildYogaTree(element: TTYElement): void {
    this.setupYogaNode(element);
    
    // Get element children using standard DOM traversal
    const children = Array.from(element.childNodes).filter(child => 
      child.nodeType === Node.ELEMENT_NODE
    ) as TTYElement[];
    
    // Clear existing children
    while (element.yogaNode.getChildCount() > 0) {
      element.yogaNode.removeChild(element.yogaNode.getChild(0));
    }
    
    // Add children to Yoga tree, but handle inline/inline-block elements specially
    let yogaChildIndex = 0;
    for (const child of children) {
      if (child.style.display === 'inline' || child.style.display === 'inline-block') {
        // Inline/inline-block elements are handled by separate inline layout system
        // They participate in Yoga as flex children but size themselves
        this.setupYogaNode(child);
        
        // Set their size based on content + visual chrome before adding to Yoga tree
        const visualSize = this.measureInlineBlockElement(child);
        child.yogaNode.setWidth(visualSize.width);
        child.yogaNode.setHeight(visualSize.height);
        
        element.yogaNode.insertChild(child.yogaNode, yogaChildIndex++);
      } else {
        // Flex elements use normal Yoga tree building
        this.buildYogaTree(child);
        element.yogaNode.insertChild(child.yogaNode, yogaChildIndex++);
      }
    }
  }

  /**
   * Extract computed layout from Yoga
   */
  private extractLayout(element: TTYElement, parentX: number, parentY: number): void {
    if (!element.yogaNode) return;

    // Get computed layout from Yoga
    const layout = element.yogaNode.getComputedLayout();
    
    element.bounds = {
      x: parentX + layout.left,
      y: parentY + layout.top,
      width: layout.width,
      height: layout.height
    };

    // Extract layout for children using standard DOM traversal
    const children = Array.from(element.childNodes).filter(child => 
      child.nodeType === Node.ELEMENT_NODE
    ) as TTYElement[];
    for (const child of children) {
      this.extractLayout(child, element.bounds.x, element.bounds.y);
    }
  }

  /**
   * Map TOM styles to Yoga properties
   */
  private applyStylesToYoga(element: TTYElement): void {
    if (!element.yogaNode) return;

    const style = element.style;
    const node = element.yogaNode;

    // Display type
    if (style.display === 'none') {
      node.setDisplay(this.yoga.DISPLAY_NONE);
      return;
    } else if (style.display === 'flex') {
      node.setDisplay(this.yoga.DISPLAY_FLEX);
    } else if (style.display === 'block') {
      // Block display is syntactic sugar for flex column + stretch
      node.setDisplay(this.yoga.DISPLAY_FLEX);
      node.setFlexDirection(this.yoga.FLEX_DIRECTION_COLUMN);
      node.setAlignItems(this.yoga.ALIGN_STRETCH);
    }
    // inline elements use measurement functions, no special display setting needed

    // Flex direction (not allowed for block display)
    if (style.flexDirection && style.display !== 'block') {
      const flexDir = {
        'row': this.yoga.FLEX_DIRECTION_ROW,
        'column': this.yoga.FLEX_DIRECTION_COLUMN,
        'row-reverse': this.yoga.FLEX_DIRECTION_ROW_REVERSE,
        'column-reverse': this.yoga.FLEX_DIRECTION_COLUMN_REVERSE
      }[style.flexDirection];
      if (flexDir !== undefined) node.setFlexDirection(flexDir);
    }

    // Justify content
    if (style.justifyContent) {
      const justify = {
        'flex-start': this.yoga.JUSTIFY_FLEX_START,
        'center': this.yoga.JUSTIFY_CENTER,
        'flex-end': this.yoga.JUSTIFY_FLEX_END,
        'space-between': this.yoga.JUSTIFY_SPACE_BETWEEN,
        'space-around': this.yoga.JUSTIFY_SPACE_AROUND
      }[style.justifyContent];
      if (justify !== undefined) node.setJustifyContent(justify);
    }

    // Align items (not allowed for block display)
    if (style.alignItems && style.display !== 'block') {
      const align = {
        'stretch': this.yoga.ALIGN_STRETCH,
        'flex-start': this.yoga.ALIGN_FLEX_START,
        'center': this.yoga.ALIGN_CENTER,
        'flex-end': this.yoga.ALIGN_FLEX_END
      }[style.alignItems];
      if (align !== undefined) node.setAlignItems(align);
    }

    // Dimensions
    if (typeof style.width === 'number') node.setWidth(style.width);
    if (typeof style.height === 'number') node.setHeight(style.height);
    if (typeof style.minWidth === 'number') node.setMinWidth(style.minWidth);
    if (typeof style.minHeight === 'number') node.setMinHeight(style.minHeight);
    if (typeof style.maxWidth === 'number') node.setMaxWidth(style.maxWidth);
    if (typeof style.maxHeight === 'number') node.setMaxHeight(style.maxHeight);

    // Flex properties
    if (typeof style.flexGrow === 'number') node.setFlexGrow(style.flexGrow);
    if (typeof style.flexShrink === 'number') node.setFlexShrink(style.flexShrink);

    // Padding
    if (style.padding) {
      const [top, right, bottom, left] = this.getPadding(element);
      node.setPadding(this.yoga.EDGE_TOP, top);
      node.setPadding(this.yoga.EDGE_RIGHT, right);
      node.setPadding(this.yoga.EDGE_BOTTOM, bottom);
      node.setPadding(this.yoga.EDGE_LEFT, left);
    }

    // Margin
    if (style.margin) {
      const margin = this.getMargin(element);
      node.setMargin(this.yoga.EDGE_TOP, margin[0]);
      node.setMargin(this.yoga.EDGE_RIGHT, margin[1]);
      node.setMargin(this.yoga.EDGE_BOTTOM, margin[2]);
      node.setMargin(this.yoga.EDGE_LEFT, margin[3]);
    }
  }

  /**
   * Measure inline element size based on text content only (no chrome)
   */
  private measureInlineElement(element: TTYElement): { width: number; height: number } {
    const content = element.textContent || '';
    
    if (!content) {
      return { width: 0, height: 0 };
    }

    const style = element.style;
    const wordWrap = style.wordWrap || 'normal';
    const whiteSpace = style.whiteSpace || 'normal';
    
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
  private measureInlineBlockElement(element: TTYElement): { width: number; height: number } {
    const style = element.style;
    
    // 1. Check for explicit dimensions first (highest priority)
    let width = typeof style.width === 'number' ? style.width : null;
    let height = typeof style.height === 'number' ? style.height : null;
    
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
    if (typeof style.minWidth === 'number') {
      width = Math.max(width, style.minWidth);
    }
    if (typeof style.minHeight === 'number') {
      height = Math.max(height, style.minHeight);
    }
    
    // 4. Apply maximum constraints
    if (typeof style.maxWidth === 'number') {
      width = Math.min(width, style.maxWidth);
    }
    if (typeof style.maxHeight === 'number') {
      height = Math.min(height, style.maxHeight);
    }
    
    return { width, height };
  }
  
  /**
   * Get border width from element style
   */
  private getBorderWidth(element: TTYElement): number {
    const border = element.style.border;
    
    if (typeof border === 'number') {
      return border;
    }
    
    if (Array.isArray(border)) {
      // Assume uniform border for now - could be enhanced to handle [top, right, bottom, left]
      return border[0] || 0;
    }
    
    return 0;
  }
  
  /**
   * Get visual width of text using Bun's stringWidth
   */
  private getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }

  /**
   * Get margin from element style
   */
  private getMargin(element: TTYElement): [number, number, number, number] {
    const margin = element.style.margin;
    
    if (typeof margin === 'number') {
      return [margin, margin, margin, margin];
    }
    
    if (Array.isArray(margin)) {
      return margin;
    }
    
    return [0, 0, 0, 0];
  }
}