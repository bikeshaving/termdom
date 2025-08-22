/**
 * LayoutEngine - Yoga layout integration for TOM
 * 
 * Provides flexbox layout capabilities using Facebook's Yoga layout engine.
 * Maps TOM styles to Yoga properties and computes element positions/sizes.
 */

import { TOMElement } from '../core/TOMElement.js';
import { TextMeasurement } from './TextMeasurement.js';
import Yoga from 'yoga-layout';

/**
 * Layout Engine using Yoga for flexbox calculations
 */
export class LayoutEngine {
  private yoga: typeof Yoga;

  constructor() {
    this.yoga = Yoga;
  }

  /**
   * Compute layout for an element tree using Yoga
   */
  computeLayout(root: Element, containerWidth: number, containerHeight: number): void {
    if (!(root instanceof TOMElement)) {
      // For non-TOM elements, just process children
      for (const child of root.children) {
        this.computeLayout(child, containerWidth, containerHeight);
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
  private simpleLayout(element: TOMElement, x: number, y: number, width: number, height: number): void {
    // Set element bounds
    element.bounds = { x, y, width, height };

    const children = element.getTOMChildren();
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
  private getPadding(element: TOMElement): [number, number, number, number] {
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
  private flexLayout(contentArea: any, children: TOMElement[], style: any): void {
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
  private setupYogaNode(element: TOMElement): void {
    if (element.yogaNode) return;

    const yogaNode = this.yoga.Node.create();
    element.initializeYogaNode(yogaNode);
    
    // Set measurement function for inline elements
    if (element.style.display === 'inline') {
      element.yogaNode.setMeasureFunc(TextMeasurement.createMeasureFunction(element));
    }
    
    // Apply styles to Yoga node
    this.applyStylesToYoga(element);
  }

  /**
   * Build Yoga tree recursively
   */
  private buildYogaTree(element: TOMElement): void {
    this.setupYogaNode(element);
    
    const children = element.getTOMChildren();
    
    // Clear existing children
    while (element.yogaNode.getChildCount() > 0) {
      element.yogaNode.removeChild(element.yogaNode.getChild(0));
    }
    
    // Add children to Yoga tree
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      this.buildYogaTree(child);
      element.yogaNode.insertChild(child.yogaNode, i);
    }
  }

  /**
   * Extract computed layout from Yoga
   */
  private extractLayout(element: TOMElement, parentX: number, parentY: number): void {
    if (!element.yogaNode) return;

    // Get computed layout from Yoga
    const layout = element.yogaNode.getComputedLayout();
    
    element.bounds = {
      x: parentX + layout.left,
      y: parentY + layout.top,
      width: layout.width,
      height: layout.height
    };

    // Extract layout for children
    const children = element.getTOMChildren();
    for (const child of children) {
      this.extractLayout(child, element.bounds.x, element.bounds.y);
    }
  }

  /**
   * Map TOM styles to Yoga properties
   */
  private applyStylesToYoga(element: TOMElement): void {
    if (!element.yogaNode) return;

    const style = element.style;
    const node = element.yogaNode;

    // Display type
    if (style.display === 'none') {
      node.setDisplay(this.yoga.DISPLAY_NONE);
      return;
    } else if (style.display === 'flex') {
      node.setDisplay(this.yoga.DISPLAY_FLEX);
    }
    // inline elements use measurement functions, no special display setting needed

    // Flex direction
    if (style.flexDirection) {
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

    // Align items
    if (style.alignItems) {
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
   * Get margin from element style
   */
  private getMargin(element: TOMElement): [number, number, number, number] {
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