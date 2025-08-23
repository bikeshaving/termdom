/**
 * TTYContainerElement - Container element with background and border support
 * 
 * Containers are the building blocks of TTY layouts. They can contain
 * other elements and provide backgrounds, borders, and layout behavior.
 * 
 * Follows SVG naming convention: TTYContainerElement for <container> elements
 */

import { TTYElement } from '../core/TTYElement.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';

/**
 * Container element - can hold other elements
 */
export class TTYContainerElement extends TTYElement {
  constructor() {
    super();
    
    // Set default container styles using proper CSSOM
    this.style.setProperty('display', 'block');
    this.style.setProperty('box-sizing', 'border-box');
  }

  /**
   * Render container with background and border
   */
  render(screenBuffer: ScreenBuffer): void {
    const bounds = this.bounds;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;

    // Get computed styles
    const backgroundColor = this.style.getPropertyValue('background-color');
    const color = this.style.getPropertyValue('color');

    // Fill background
    if (backgroundColor && backgroundColor !== 'transparent') {
      screenBuffer.fill(bounds, ' ', {
        fgColor: color || 'white',
        bgColor: backgroundColor
      });
    }

    // Render border if specified
    const borderStyle = this.style.getPropertyValue('border-style');
    const borderWidth = this.style.getPropertyValue('border-width');
    const borderColor = this.style.getPropertyValue('border-color');
    
    if (borderStyle && borderStyle !== 'none' && borderWidth && parseInt(borderWidth) > 0) {
      this._renderBorder(screenBuffer, bounds, {
        style: borderStyle,
        width: parseInt(borderWidth),
        color: borderColor || color || 'white'
      });
    }

    // Render children
    for (const child of this.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const childElement = child as TTYElement;
        if (childElement.render) {
          childElement.render(screenBuffer);
        }
      }
    }
  }

  /**
   * Render border around container
   */
  private _renderBorder(screenBuffer: ScreenBuffer, bounds: any, border: any): void {
    const { x, y, width, height } = bounds;
    const { color } = border;

    // Simple single-line border for now
    const style = { color, backgroundColor: 'transparent' };

    // Top border
    screenBuffer.drawText(x, y, '┌' + '─'.repeat(width - 2) + '┐', style);
    
    // Side borders
    for (let row = 1; row < height - 1; row++) {
      screenBuffer.drawText(x, y + row, '│', style);
      screenBuffer.drawText(x + width - 1, y + row, '│', style);
    }
    
    // Bottom border
    screenBuffer.drawText(x, y + height - 1, '└' + '─'.repeat(width - 2) + '┘', style);
  }

  /**
   * Get padding values for layout calculations
   */
  override getPadding(): [number, number, number, number] {
    const paddingTop = parseInt(this.style.getPropertyValue('padding-top') || '0') || 0;
    const paddingRight = parseInt(this.style.getPropertyValue('padding-right') || '0') || 0;
    const paddingBottom = parseInt(this.style.getPropertyValue('padding-bottom') || '0') || 0;
    const paddingLeft = parseInt(this.style.getPropertyValue('padding-left') || '0') || 0;
    
    return [paddingTop, paddingRight, paddingBottom, paddingLeft];
  }
}

// Export with old name for compatibility during transition
export { TTYContainerElement as TTYContainer };