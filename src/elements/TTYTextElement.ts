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
   * Text elements typically don't have TTY children
   */
  getTTYChildren(): TTYElement[] {
    return []; // Text elements are leaf nodes
  }
}