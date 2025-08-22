/**
 * TOMDebugPanel - In-app debug display
 * 
 * Shows debug messages in a panel without corrupting the terminal
 */

import { TOMElement } from '../core/TOMElement.js';
import { DebugPanel } from '../utils/debug.js';

export class TOMDebugPanel extends TOMElement {
  private debugPanel: DebugPanel;
  
  constructor() {
    super('debug-panel', null as any);
    this.debugPanel = new DebugPanel();
    
    // Default styling for debug panel
    this.style.position = 'absolute';
    this.style.bottom = 0;
    this.style.right = 0;
    this.style.width = 40;
    this.style.height = 12;
    this.style.backgroundColor = 'black';
    this.style.color = 'green';
    this.style.border = 'single';
    this.style.borderColor = 'green';
    this.style.padding = [1, 1, 1, 1];
    this.style.zIndex = 9999;
    this.style.overflow = 'hidden';
  }
  
  /**
   * Log a debug message
   */
  log(...args: any[]) {
    this.debugPanel.log(...args);
    // Trigger re-render
    if (this.ownerDocument) {
      (this.ownerDocument as any).render();
    }
  }
  
  /**
   * Clear all messages
   */
  clear() {
    this.debugPanel.clear();
    if (this.ownerDocument) {
      (this.ownerDocument as any).render();
    }
  }
  
  /**
   * Render debug messages
   */
  tomRender(): void {
    if (!this.screenBuffer) return;
    
    // Clear the buffer
    this.screenBuffer.fill({
      char: ' ',
      attr: this.screenBuffer.DEFAULT_ATTR
    });
    
    // Draw border if enabled
    if (this.computedStyle.border && this.computedStyle.border !== 'none') {
      this.screenBuffer.drawBorder({
        x: 0,
        y: 0,
        width: this.bounds.width,
        height: this.bounds.height,
        style: this.computedStyle.border,
        attr: {
          color: this.computedStyle.borderColor || 'white',
          bgColor: this.computedStyle.backgroundColor || 'black'
        }
      });
    }
    
    // Get messages
    const messages = this.debugPanel.getMessages();
    const contentX = this.computedStyle.border ? 1 : 0;
    const contentY = this.computedStyle.border ? 1 : 0;
    const contentWidth = this.bounds.width - (this.computedStyle.border ? 2 : 0);
    const contentHeight = this.bounds.height - (this.computedStyle.border ? 2 : 0);
    
    // Title
    this.screenBuffer.put({
      x: contentX,
      y: contentY,
      text: '=== DEBUG LOG ===',
      attr: {
        color: 'yellow',
        bgColor: this.computedStyle.backgroundColor || 'black',
        bold: true
      }
    });
    
    // Messages
    messages.forEach((msg, i) => {
      if (i + 2 < contentHeight) {
        // Truncate if too long
        const truncated = msg.length > contentWidth ? 
          msg.substring(0, contentWidth - 3) + '...' : msg;
          
        this.screenBuffer.put({
          x: contentX,
          y: contentY + i + 2,
          text: truncated,
          attr: {
            color: this.computedStyle.color || 'green',
            bgColor: this.computedStyle.backgroundColor || 'black'
          }
        });
      }
    });
  }
}