/**
 * TTYTextElement - TTY text element implementation
 * 
 * Concrete implementation of TTYElement for text display
 */

import { TTYElement } from '../core/TTYElement.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';

/**
 * TTY element specifically for text content
 */
export class TTYTextElement extends TTYElement {
  
  constructor() {
    super();
  }

  /**
   * Render this text element to the screen buffer
   */
  renderSelf(buffer: ScreenBuffer): void {
    if (this.bounds && this.textContent) {
      const { x, y } = this.bounds;
      
      // Render text content with styling
      buffer.put(x, y, this.textContent, {
        fgColor: this.style.color,
        bgColor: this.style.backgroundColor,
        bold: this.style.fontWeight === 'bold',
        italic: this.style.fontStyle === 'italic',
        underline: this.style.textDecoration === 'underline'
      });
    }
  }

  /**
   * Text elements typically don't have TTY children
   */
  getTTYChildren(): TTYElement[] {
    return []; // Text elements are leaf nodes
  }
}