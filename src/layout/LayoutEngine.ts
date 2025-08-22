/**
 * LayoutEngine - Yoga layout integration for TOM
 * 
 * Provides flexbox layout capabilities using Facebook's Yoga layout engine.
 * Maps TOM styles to Yoga properties and computes element positions/sizes.
 */

import { TOMElement } from '../core/TOMElement.js';

/**
 * Layout Engine using Yoga for flexbox calculations
 */
export class LayoutEngine {
  constructor() {
    // TODO: Initialize Yoga when we add the integration
  }

  /**
   * Compute layout for an element tree
   */
  computeLayout(root: Element, containerWidth: number, containerHeight: number): void {
    if (!(root instanceof TOMElement)) {
      // For non-TOM elements, just process children
      for (const child of root.children) {
        this.computeLayout(child, containerWidth, containerHeight);
      }
      return;
    }

    // Simple layout for now - will be replaced with Yoga
    this.simpleLayout(root, 0, 0, containerWidth, containerHeight);
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
    
    // Get content area (accounting for padding/margins)
    const [padTop, padRight, padBottom, padLeft] = this.getPadding(element);
    const contentArea = {
      x: x + padLeft,
      y: y + padTop,
      width: Math.max(0, width - padLeft - padRight),
      height: Math.max(0, height - padTop - padBottom)
    };
    
    // Everything is flexbox in TOM - no block layout
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
   * TODO: Initialize Yoga layout engine
   */
  private initializeYoga(): void {
    // Will implement when we add Yoga integration
  }

  /**
   * TODO: Map TOM styles to Yoga properties
   */
  private applyStylesToYoga(element: TOMElement): void {
    // Will implement with Yoga integration
  }

  /**
   * TODO: Extract computed layout from Yoga
   */
  private extractComputedLayout(element: TOMElement): void {
    // Will implement with Yoga integration
  }
}