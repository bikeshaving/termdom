/**
 * TOMButton - Interactive button element
 * 
 * Provides clickable button with hover/focus/press states,
 * keyboard navigation support, and customizable styling.
 */

import { TOMContainer } from './TOMContainer.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';

export interface ButtonState {
  normal: boolean;
  hover: boolean;
  focused: boolean;
  pressed: boolean;
  disabled: boolean;
}

/**
 * Interactive button element
 */
export class TOMButton extends TOMContainer {
  private _pressed = false;
  private _hover = false;
  private _focused = false;
  private _disabled = false;

  constructor() {
    super();
    
    // Buttons are focusable by default
    this.tomSetFocusable(true);
    
    // Set default button styles
    this.style = {
      display: 'inline-block',
      backgroundColor: '#333',
      color: 'white',
      padding: [1, 2, 1, 2], // top, right, bottom, left
      border: 1,
      borderColor: '#666',
      textAlign: 'center',
      minHeight: 3, // Minimum 3 cells: border + content + border
      ...this.style
    };

    this.setupEventHandlers();
  }

  /**
   * Get current button state
   */
  get state(): ButtonState {
    const tomFocused = this.tomIsFocused();
    return {
      normal: !this._hover && !tomFocused && !this._pressed && !this._disabled,
      hover: this._hover && !this._disabled,
      focused: tomFocused && !this._disabled,
      pressed: this._pressed && !this._disabled,
      disabled: this._disabled
    };
  }

  /**
   * Set disabled state
   */
  set disabled(value: boolean) {
    this._disabled = value;
    this.markForRender();
  }

  get disabled(): boolean {
    return this._disabled;
  }

  /**
   * Set up event handlers for button interactions
   */
  private setupEventHandlers(): void {
    // Mouse events
    this.addEventListener('mousedown', (e) => {
      if (!this._disabled) {
        this._pressed = true;
        this.markForRender();
        e.preventDefault();
      }
    });

    this.addEventListener('mouseup', (e) => {
      if (!this._disabled && this._pressed) {
        this._pressed = false;
        this.markForRender();
        
        // Dispatch click event
        this.dispatchEvent(new CustomEvent('click', { 
          bubbles: true,
          detail: { originalEvent: e }
        }));
      }
    });

    this.addEventListener('mouseenter', () => {
      if (!this._disabled) {
        this._hover = true;
        this.markForRender();
      }
    });

    this.addEventListener('mouseleave', () => {
      if (!this._disabled) {
        this._hover = false;
        this._pressed = false; // Cancel press if mouse leaves
        this.markForRender();
      }
    });

    // Keyboard events
    this.addEventListener('keydown', (e) => {
      if (!this._disabled && (e.key === 'Enter' || e.key === ' ')) {
        this._pressed = true;
        this.markForRender();
        e.preventDefault();
      }
    });

    this.addEventListener('keyup', (e) => {
      if (!this._disabled && this._pressed && (e.key === 'Enter' || e.key === ' ')) {
        this._pressed = false;
        this.markForRender();
        
        // Dispatch click event
        this.dispatchEvent(new CustomEvent('click', { 
          bubbles: true,
          detail: { originalEvent: e }
        }));
        e.preventDefault();
      }
    });

    // Focus events
    this.addEventListener('focus', () => {
      if (!this._disabled) {
        this._focused = true;
        this.markForRender();
      }
    });

    this.addEventListener('blur', () => {
      if (!this._disabled) {
        this._focused = false;
        this._pressed = false; // Cancel press on blur
        this.markForRender();
      }
    });
  }

  /**
   * Render button with state-based styling
   */
  renderSelf(buffer: ScreenBuffer): void {
    const bounds = this.bounds;
    
    // Skip rendering if no size
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    // Get state-based style
    const stateStyle = this.getStateStyle();
    
    // Temporarily apply state style for rendering
    const originalStyle = this.style;
    this.style = { ...originalStyle, ...stateStyle };
    
    // Render as container (background, border)
    super.renderSelf(buffer);
    
    // Render button content (text)
    this.renderContent(buffer);
    
    // Restore original style
    this.style = originalStyle;
  }

  /**
   * Get style modifications based on current state
   */
  private getStateStyle(): Partial<typeof this.style> {
    const state = this.state;
    const baseStyle = this.style;
    
    if (state.disabled) {
      return {
        backgroundColor: this.darkenColor(baseStyle.backgroundColor || '#333'),
        color: '#666',
        borderColor: '#444'
      };
    }
    
    if (state.pressed) {
      return {
        backgroundColor: this.darkenColor(baseStyle.backgroundColor || '#333'),
        borderColor: this.lightenColor(baseStyle.borderColor || '#666')
      };
    }
    
    if (state.focused) {
      return {
        borderColor: '#00ff00', // Bright green focus indicator
        backgroundColor: this.lightenColor(baseStyle.backgroundColor || '#333')
      };
    }
    
    if (state.hover) {
      return {
        backgroundColor: this.lightenColor(baseStyle.backgroundColor || '#333')
      };
    }
    
    return {};
  }

  /**
   * Render button text content
   */
  private renderContent(buffer: ScreenBuffer): void {
    const contentArea = this.getContentArea();
    const content = this.textContent || '';
    
    if (!content || contentArea.width <= 0 || contentArea.height <= 0) {
      return;
    }

    // Center the text vertically and horizontally
    const lines = content.split('\n');
    const textStyle = this.getTextStyle();
    
    const startY = contentArea.y + Math.floor((contentArea.height - lines.length) / 2);
    
    for (let i = 0; i < Math.min(lines.length, contentArea.height); i++) {
      const line = lines[i];
      const y = startY + i;
      
      if (y >= contentArea.y && y < contentArea.y + contentArea.height) {
        // Center horizontally
        const textWidth = this.getTextWidth(line);
        const x = contentArea.x + Math.floor((contentArea.width - textWidth) / 2);
        
        buffer.put(x, y, line, textStyle);
      }
    }
  }

  /**
   * Get visual width of text
   */
  private getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }

  /**
   * Lighten a color (simple implementation)
   */
  private lightenColor(color: string | undefined): string {
    if (!color) return '#555';
    
    // Simple color lightening for common colors
    const lightMap: Record<string, string> = {
      '#000': '#333',
      '#333': '#555',
      '#666': '#888',
      '#999': '#bbb',
      'black': '#333',
      'gray': '#aaa',
      'blue': '#66f',
      'red': '#f66',
      'green': '#6f6'
    };
    
    return lightMap[color] || color;
  }

  /**
   * Darken a color (simple implementation)
   */
  private darkenColor(color: string | undefined): string {
    if (!color) return '#111';
    
    // Simple color darkening for common colors
    const darkMap: Record<string, string> = {
      '#333': '#111',
      '#555': '#222',
      '#666': '#333',
      '#888': '#444',
      '#aaa': '#666',
      'white': '#ccc',
      'gray': '#333',
      'blue': '#006',
      'red': '#600',
      'green': '#060'
    };
    
    return darkMap[color] || color;
  }

  /**
   * Programmatically click the button
   */
  click(): void {
    if (!this._disabled) {
      this.dispatchEvent(new CustomEvent('click', { bubbles: true }));
    }
  }

  /**
   * Set focus to this button
   */
  focus(): void {
    if (!this._disabled) {
      this.dispatchEvent(new FocusEvent('focus'));
    }
  }
}