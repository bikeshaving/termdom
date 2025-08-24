/**
 * TTYEventTranslator - Translates raw terminal events to DOM events
 * 
 * Bridges the gap between raw terminal input (TTYKeyEvent, TTYMouseEvent) 
 * and standard DOM events (KeyboardEvent, MouseEvent, FocusEvent).
 * 
 * Uses our Yoga-powered DOM APIs for hit testing and event targeting:
 * - document.elementFromPoint() for mouse hit testing
 * - element.contains() and element.closest() for event delegation
 * 
 * Features:
 * - Proper event bubbling and capturing
 * - Focus management for interactive elements
 * - Mouse tracking with enter/leave events
 * - Keyboard navigation and shortcuts
 * - Terminal resize handling
 */

import { Document, Element, HTMLElement, Event, MouseEvent, KeyboardEvent, FocusEvent, WheelEvent } from '../dom.js';
import { TTYRuntime } from '../core/TTYRuntime.js';
import type { TTYDimensions, TTYKeyEvent, TTYMouseEvent } from '../core/TTYRuntime.js';

export interface TTYEventTranslatorOptions {
  enableMouseTracking?: boolean;
  enableKeyboardNavigation?: boolean;
  focusableSelectors?: string[];
}

export class TTYEventTranslator {
  private runtime: TTYRuntime;
  private document: Document;
  private options: Required<TTYEventTranslatorOptions>;
  private currentFocusedElement: Element | null = null;
  private lastMouseElement: Element | null = null;
  private isActive = false;

  constructor(runtime: TTYRuntime, document: Document, options: TTYEventTranslatorOptions = {}) {
    this.runtime = runtime;
    this.document = document;
    this.options = {
      enableMouseTracking: true,
      enableKeyboardNavigation: true,
      focusableSelectors: ['button', 'input', 'textarea', 'select', 'a[href]', '[tabindex]'],
      ...options
    };

    this.setupEventListeners();
  }

  /**
   * Start event translation
   */
  start(): void {
    if (this.isActive) return;
    
    this.isActive = true;
    
    if (this.options.enableMouseTracking) {
      this.runtime.enableMouseTracking();
    }
    
    this.runtime.setRawMode(true);
    
    // Set initial focus to body
    this.setFocus(this.document.body);
  }

  /**
   * Stop event translation and cleanup
   */
  stop(): void {
    if (!this.isActive) return;
    
    this.isActive = false;
    this.runtime.disableMouseTracking();
    this.runtime.setRawMode(false);
    
    if (this.currentFocusedElement) {
      this.dispatchFocusEvent('blur', this.currentFocusedElement);
      this.currentFocusedElement = null;
    }
  }

  /**
   * Setup event listeners on TTYRuntime
   */
  private setupEventListeners(): void {
    // Handle keyboard events
    this.runtime.addEventListener('keypress', (event) => {
      if (!this.isActive) return;
      this.handleKeyboardEvent((event as any).detail);
    });

    // Handle mouse events  
    this.runtime.addEventListener('mouse', (event) => {
      if (!this.isActive || !this.options.enableMouseTracking) return;
      this.handleMouseEvent((event as any).detail);
    });

    // Handle terminal resize
    this.runtime.addEventListener('resize', (event) => {
      if (!this.isActive) return;
      this.handleResizeEvent((event as any).detail);
    });
  }

  /**
   * Handle raw keyboard events and translate to DOM events
   */
  private handleKeyboardEvent(keyEvent: TTYKeyEvent): void {
    // Handle special navigation keys first
    if (this.options.enableKeyboardNavigation) {
      if (this.handleNavigationKey(keyEvent)) {
        return; // Navigation key was handled, don't dispatch keyboard event
      }
    }

    // Create DOM KeyboardEvent
    const domKeyEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: keyEvent.key,
      code: this.mapKeyToCode(keyEvent.key),
      ctrlKey: keyEvent.ctrl,
      altKey: keyEvent.alt,
      shiftKey: keyEvent.shift,
      metaKey: keyEvent.meta
    });

    // Dispatch to focused element or document
    const target = this.currentFocusedElement || this.document.body;
    target.dispatchEvent(domKeyEvent);

    // Also dispatch keypress and keyup for character keys
    if (!domKeyEvent.defaultPrevented && this.isCharacterKey(keyEvent.key)) {
      const keypressEvent = new KeyboardEvent('keypress', {
        bubbles: true,
        cancelable: true,
        key: keyEvent.key,
        code: this.mapKeyToCode(keyEvent.key),
        ctrlKey: keyEvent.ctrl,
        altKey: keyEvent.alt,
        shiftKey: keyEvent.shift,
        metaKey: keyEvent.meta
      });
      target.dispatchEvent(keypressEvent);
    }
  }

  /**
   * Handle navigation keys (Tab, Arrow keys, etc.)
   */
  private handleNavigationKey(keyEvent: TTYKeyEvent): boolean {
    switch (keyEvent.key) {
      case 'Tab':
        if (keyEvent.shift) {
          this.focusPrevious();
        } else {
          this.focusNext();
        }
        return true;

      case 'up':
      case 'down':
      case 'left': 
      case 'right':
        // Let applications handle arrow keys for now
        // Could add spatial navigation later
        return false;

      case 'enter':
      case ' ': // Space
        // Activate focused element (click simulation)
        if (this.currentFocusedElement) {
          this.simulateClick(this.currentFocusedElement);
          return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Handle raw mouse events and translate to DOM events
   */
  private handleMouseEvent(mouseEvent: TTYMouseEvent): void {
    // Use our DOM API to find element at mouse coordinates
    const targetElement = this.document.elementFromPoint(mouseEvent.x, mouseEvent.y);
    
    if (!targetElement) {
      return; // No element at coordinates
    }

    // Handle mouse enter/leave tracking
    if (targetElement !== this.lastMouseElement) {
      if (this.lastMouseElement) {
        this.dispatchMouseEvent('mouseleave', this.lastMouseElement, mouseEvent);
      }
      this.dispatchMouseEvent('mouseenter', targetElement, mouseEvent);
      this.lastMouseElement = targetElement;
    }

    // Always dispatch mousemove
    this.dispatchMouseEvent('mousemove', targetElement, mouseEvent);

    // Handle click events
    switch (mouseEvent.action) {
      case 'press':
        this.dispatchMouseEvent('mousedown', targetElement, mouseEvent);
        // Set focus to clicked element if it's focusable
        if (this.isFocusable(targetElement)) {
          this.setFocus(targetElement);
        }
        break;

      case 'release':
        this.dispatchMouseEvent('mouseup', targetElement, mouseEvent);
        // Dispatch click if released on same element as pressed
        // (This is simplified - real browsers track press/release pairs)
        this.dispatchMouseEvent('click', targetElement, mouseEvent);
        break;

      case 'scroll':
        this.dispatchWheelEvent(targetElement, mouseEvent);
        break;
    }
  }

  /**
   * Handle terminal resize events
   */
  private handleResizeEvent(dimensions: TTYDimensions): void {
    // Create and dispatch resize event on window/document
    const resizeEvent = new Event('resize', {
      bubbles: false,
      cancelable: false
    });

    // Add dimension data
    (resizeEvent as any).detail = dimensions;
    
    this.document.dispatchEvent(resizeEvent);
  }

  /**
   * Dispatch DOM MouseEvent
   */
  private dispatchMouseEvent(type: string, target: Element, mouseEvent: TTYMouseEvent): void {
    // Create proper MouseEvent
    const domMouseEvent = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: mouseEvent.x,
      clientY: mouseEvent.y,
      screenX: mouseEvent.x,
      screenY: mouseEvent.y,
      button: this.mapMouseButton(mouseEvent.button),
      buttons: this.getMouseButtons(mouseEvent),
      ctrlKey: mouseEvent.ctrl,
      altKey: mouseEvent.alt,
      shiftKey: mouseEvent.shift
    });

    target.dispatchEvent(domMouseEvent);
  }

  /**
   * Dispatch DOM WheelEvent for scroll
   */
  private dispatchWheelEvent(target: Element, mouseEvent: TTYMouseEvent): void {
    // Create proper WheelEvent
    const wheelEvent = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: mouseEvent.button === 'wheel' ? (mouseEvent.action === 'scroll' ? 1 : -1) : 0
    });

    target.dispatchEvent(wheelEvent);
  }

  /**
   * Dispatch focus/blur events
   */
  private dispatchFocusEvent(type: 'focus' | 'blur', target: Element): void {
    // Create proper FocusEvent
    const focusEvent = new FocusEvent(type, {
      bubbles: false, // Focus events don't bubble
      cancelable: false,
      relatedTarget: type === 'focus' ? this.currentFocusedElement : null
    });

    target.dispatchEvent(focusEvent);
  }

  /**
   * Set focus to an element
   */
  private setFocus(element: Element): void {
    if (element === this.currentFocusedElement) {
      return; // Already focused
    }

    // Blur current element
    if (this.currentFocusedElement) {
      this.dispatchFocusEvent('blur', this.currentFocusedElement);
    }

    // Focus new element
    this.currentFocusedElement = element;
    this.dispatchFocusEvent('focus', element);
  }

  /**
   * Focus next focusable element (Tab navigation)
   */
  private focusNext(): void {
    const focusable = this.getFocusableElements();
    const currentIndex = focusable.indexOf(this.currentFocusedElement as HTMLElement);
    const nextIndex = (currentIndex + 1) % focusable.length;
    
    if (focusable[nextIndex]) {
      this.setFocus(focusable[nextIndex]);
    }
  }

  /**
   * Focus previous focusable element (Shift+Tab navigation)  
   */
  private focusPrevious(): void {
    const focusable = this.getFocusableElements();
    const currentIndex = focusable.indexOf(this.currentFocusedElement as HTMLElement);
    const prevIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
    
    if (focusable[prevIndex]) {
      this.setFocus(focusable[prevIndex]);
    }
  }

  /**
   * Get all focusable elements in document order
   */
  private getFocusableElements(): HTMLElement[] {
    const selector = this.options.focusableSelectors.join(', ');
    const elements = Array.from(this.document.querySelectorAll(selector)) as HTMLElement[];
    
    // Filter out disabled and hidden elements
    return elements.filter(el => {
      return !el.hasAttribute('disabled') && 
             !el.hasAttribute('hidden') &&
             el.style.display !== 'none';
    });
  }

  /**
   * Check if element is focusable
   */
  private isFocusable(element: Element): boolean {
    const focusable = this.getFocusableElements();
    return focusable.includes(element as HTMLElement);
  }

  /**
   * Simulate click event for keyboard activation
   */
  private simulateClick(element: Element): void {
    // Create and dispatch synthetic mouse events
    const mouseEvent = {
      x: 0, y: 0, // Use element center or 0,0 for keyboard simulation
      button: 'left' as const,
      action: 'press' as const,
      ctrl: false, alt: false, shift: false
    };

    this.dispatchMouseEvent('mousedown', element, mouseEvent);
    this.dispatchMouseEvent('mouseup', element, { ...mouseEvent, action: 'release' });
    this.dispatchMouseEvent('click', element, mouseEvent);
  }

  // === Helper Methods ===

  private mapKeyToCode(key: string): string {
    // Map terminal key names to KeyboardEvent.code values
    const keyMap: Record<string, string> = {
      'up': 'ArrowUp',
      'down': 'ArrowDown', 
      'left': 'ArrowLeft',
      'right': 'ArrowRight',
      'enter': 'Enter',
      'tab': 'Tab',
      'escape': 'Escape',
      'backspace': 'Backspace',
      'home': 'Home',
      'end': 'End',
      ' ': 'Space'
    };

    return keyMap[key] || key;
  }

  private isCharacterKey(key: string): boolean {
    // Check if this is a printable character key
    return key.length === 1 && key >= ' ' && key <= '~';
  }

  private mapMouseButton(button: string): number {
    // Map TTYMouseEvent button to MouseEvent.button
    switch (button) {
      case 'left': return 0;
      case 'middle': return 1; 
      case 'right': return 2;
      default: return 0;
    }
  }

  private getMouseButtons(mouseEvent: TTYMouseEvent): number {
    // Map to MouseEvent.buttons bitmask
    switch (mouseEvent.button) {
      case 'left': return 1;
      case 'right': return 2;
      case 'middle': return 4;
      default: return 0;
    }
  }
}