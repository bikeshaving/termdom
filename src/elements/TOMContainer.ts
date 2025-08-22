/**
 * TOMContainer - Container element with background and border support
 * 
 * Containers are the building blocks of TOM layouts. They can contain
 * other elements and provide backgrounds, borders, and layout behavior.
 */

import { TOMElement } from '../core/TOMElement.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';

/**
 * Container element - can hold other elements
 */
export class TOMContainer extends TOMElement {
  constructor() {
    super();
    
    // Set default container styles
    this.style = {
      display: 'block',
      ...this.style
    };
  }

  /**
   * Render the container background and borders
   */
  renderSelf(buffer: ScreenBuffer): void {
    const bounds = this.bounds;
    const style = this.style;

    // Skip rendering if no size
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    // Render background
    if (style.backgroundColor) {
      buffer.fill(bounds, ' ', {
        bgColor: style.backgroundColor
      });
    }

    // Render border (simple single-line border for now)
    if (this.hasBorder()) {
      this.renderBorder(buffer);
    }

    // Render children (they will render themselves)
    // This is handled by the renderer recursively
  }

  /**
   * Check if element has border
   */
  private hasBorder(): boolean {
    const border = this.style.border;
    
    if (typeof border === 'number') {
      return border > 0;
    }
    
    if (Array.isArray(border)) {
      return border.some(width => width > 0);
    }
    
    return false;
  }

  /**
   * Render border around the container
   */
  private renderBorder(buffer: ScreenBuffer): void {
    const bounds = this.bounds;
    const borderColor = this.style.borderColor;
    
    const borderStyle = {
      fgColor: borderColor || this.style.color,
      bgColor: this.style.backgroundColor
    };

    // Top border
    if (bounds.width > 0) {
      const topLine = '─'.repeat(bounds.width);
      buffer.put(bounds.x, bounds.y, topLine, borderStyle);
    }

    // Bottom border
    if (bounds.width > 0 && bounds.height > 1) {
      const bottomLine = '─'.repeat(bounds.width);
      buffer.put(bounds.x, bounds.y + bounds.height - 1, bottomLine, borderStyle);
    }

    // Left and right borders
    for (let y = bounds.y + 1; y < bounds.y + bounds.height - 1; y++) {
      // Left border
      buffer.put(bounds.x, y, '│', borderStyle);
      
      // Right border
      if (bounds.width > 1) {
        buffer.put(bounds.x + bounds.width - 1, y, '│', borderStyle);
      }
    }

    // Corners
    if (bounds.width > 1 && bounds.height > 1) {
      buffer.put(bounds.x, bounds.y, '┌', borderStyle); // Top-left
      buffer.put(bounds.x + bounds.width - 1, bounds.y, '┐', borderStyle); // Top-right
      buffer.put(bounds.x, bounds.y + bounds.height - 1, '└', borderStyle); // Bottom-left
      buffer.put(bounds.x + bounds.width - 1, bounds.y + bounds.height - 1, '┘', borderStyle); // Bottom-right
    }
  }

  /**
   * Override content area calculation to account for borders
   */
  protected getContentArea() {
    const bounds = this.bounds;
    const [padTop, padRight, padBottom, padLeft] = this.getPadding();
    
    // Account for border thickness
    const borderOffset = this.hasBorder() ? 1 : 0;
    
    return {
      x: bounds.x + padLeft + borderOffset,
      y: bounds.y + padTop + borderOffset,
      width: Math.max(0, bounds.width - padLeft - padRight - (borderOffset * 2)),
      height: Math.max(0, bounds.height - padTop - padBottom - (borderOffset * 2))
    };
  }
}