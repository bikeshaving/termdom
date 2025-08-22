/**
 * TOMKeyboardHandler - Handles keyboard input for TOM
 * 
 * Converts terminal keyboard events to DOM KeyboardEvents and manages
 * key parsing, focus handling, and element targeting.
 */

import { TOMDocument } from './TOMDocument.js';
import { TOMElement } from './TOMElement.js';
import { TerminalInterface } from './TerminalInterface.js';

export interface KeyboardState {
  focusedElement: TOMElement | null;
  inputMode: boolean;
}

export interface TOMKeyboardEvent {
  key: string;
  char?: string;
  sequence: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export class TOMKeyboardHandler {
  private document: TOMDocument;
  private terminal: TerminalInterface;
  private isEnabled = false;
  private keyboardState: KeyboardState = {
    focusedElement: null,
    inputMode: false
  };
  
  // Best practices configuration
  private enableDefaultExitHandlers = true;
  private customExitHandler?: () => void;

  constructor(document: TOMDocument, terminal: TerminalInterface) {
    this.document = document;
    this.terminal = terminal;
  }

  /**
   * Enable keyboard input handling
   */
  enable(): void {
    if (this.isEnabled) return;
    this.isEnabled = true;
    
    // Set raw mode if available
    if (this.terminal.setRawMode) {
      this.terminal.setRawMode(true);
    }
    
    // Resume input if needed
    if (this.terminal.resume) {
      this.terminal.resume();
    }
  }

  /**
   * Disable keyboard input handling
   */
  disable(): void {
    if (!this.isEnabled) return;
    this.isEnabled = false;
    
    // Disable raw mode if available
    if (this.terminal.setRawMode) {
      this.terminal.setRawMode(false);
    }
    
    // Pause input if needed
    if (this.terminal.pause) {
      this.terminal.pause();
    }
  }

  /**
   * Handle raw keyboard input from terminal
   */
  handleKeyboardInput(data: string): boolean {
    if (!this.isEnabled) return false;
    
    const keyEvent = this.parseKeyboardInput(data);
    if (!keyEvent) {
      return false;
    }
    
    // Handle system-level keyboard shortcuts BEFORE dispatching to elements
    if (this.handleSystemShortcuts(keyEvent)) {
      return true; // Consumed by system handler
    }
    
    const target = this.keyboardState.focusedElement || this.document.body;
    if (!target) return false;
    
    // Create DOM KeyboardEvent
    const domEvent = this.createKeyboardEvent('keydown', keyEvent);
    
    // Dispatch to target element
    target.dispatchEvent(domEvent);
    
    // Also dispatch keyup for completeness
    const keyupEvent = this.createKeyboardEvent('keyup', keyEvent);
    target.dispatchEvent(keyupEvent);
    
    return true;
  }

  /**
   * Handle system-level keyboard shortcuts
   * Returns true if the shortcut was consumed
   */
  private handleSystemShortcuts(keyEvent: TOMKeyboardEvent): boolean {
    // Handle viewport scrolling first (available even when exit handlers are disabled)
    if (this.handleViewportScrolling(keyEvent)) {
      return true;
    }
    
    if (!this.enableDefaultExitHandlers) {
      return false; // Skip default handlers if disabled
    }
    
    // Ctrl+C should always exit unless explicitly disabled
    if (keyEvent.key === 'c' && keyEvent.ctrl) {
      if (this.customExitHandler) {
        this.customExitHandler();
      } else {
        // Move cursor to bottom and show exit message
        const dimensions = this.terminal.getDimensions();
        this.terminal.write(`\x1b[${dimensions.rows};1H\n👋 Received Ctrl+C, gracefully exiting...\n`);
        this.document.destroy();
        process.exit(0);
      }
      return true;
    }
    
    // Ctrl+Z should suspend (but not in TOM apps by default)
    if (keyEvent.key === 'z' && keyEvent.ctrl) {
      console.log('\n⏸️  Ctrl+Z received, but suspension is disabled in TOM apps');
      return true; // Consume the event
    }
    
    // Ctrl+D should also exit gracefully in input contexts
    if (keyEvent.key === 'd' && keyEvent.ctrl) {
      if (this.customExitHandler) {
        this.customExitHandler();
      } else {
        // Move cursor to bottom and show exit message
        const dimensions = this.terminal.getDimensions();
        this.terminal.write(`\x1b[${dimensions.rows};1H\n👋 Received Ctrl+D (EOF), gracefully exiting...\n`);
        this.document.destroy();
        process.exit(0);
      }
      return true;
    }
    
    return false; // Not consumed
  }

  /**
   * Handle viewport scrolling keyboard shortcuts
   * Returns true if the shortcut was consumed
   */
  private handleViewportScrolling(keyEvent: TOMKeyboardEvent): boolean {
    if (!this.document.viewport) {
      return false; // No viewport to scroll
    }
    
    const scrollAmount = 1;
    const pageScrollAmount = Math.floor(this.document.viewport.getViewport().height * 0.8);
    
    switch (keyEvent.key) {
      case 'ArrowUp':
        return this.document.scroll(0, -scrollAmount);
      case 'ArrowDown':
        return this.document.scroll(0, scrollAmount);
      case 'ArrowLeft':
        return this.document.scroll(-scrollAmount, 0);
      case 'ArrowRight':
        return this.document.scroll(scrollAmount, 0);
      case 'PageUp':
        return this.document.scroll(0, -pageScrollAmount);
      case 'PageDown':
        return this.document.scroll(0, pageScrollAmount);
      case 'Home':
        if (keyEvent.ctrl) {
          // Ctrl+Home: scroll to top
          return this.document.scrollTo(0, 0);
        }
        break;
      case 'End':
        if (keyEvent.ctrl) {
          // Ctrl+End: scroll to bottom
          const doc = this.document.viewport.getDocument();
          const viewport = this.document.viewport.getViewport();
          return this.document.scrollTo(0, Math.max(0, doc.height - viewport.height));
        }
        break;
    }
    
    return false; // Not consumed
  }

  /**
   * Parse raw keyboard input into structured event
   */
  private parseKeyboardInput(input: string): TOMKeyboardEvent | null {
    const sequence = input;
    let key = '';
    let char = '';
    let ctrl = false;
    let shift = false;
    let alt = false;
    let meta = false;

    // Handle control characters
    if (input.length === 1 && input.charCodeAt(0) < 32) {
      const code = input.charCodeAt(0);
      
      if (code === 3) {
        key = 'c';
        ctrl = true;
      } else if (code === 27) { // ESC
        key = 'Escape';
      } else if (code === 13 || code === 10) { // CR/LF
        key = 'Enter';
      } else if (code === 127 || code === 8) { // DEL/BS
        key = 'Backspace';
      } else if (code === 9) { // TAB
        key = 'Tab';
      } else if (code >= 1 && code <= 26) {
        // Ctrl+A through Ctrl+Z
        key = String.fromCharCode(code + 96); // Convert to lowercase letter
        ctrl = true;
      } else {
        return null; // Unknown control character
      }
    }
    // Handle escape sequences
    else if (input.startsWith('\x1b[')) {
      // Arrow keys
      if (input === '\x1b[A') key = 'ArrowUp';
      else if (input === '\x1b[B') key = 'ArrowDown';
      else if (input === '\x1b[C') key = 'ArrowRight';
      else if (input === '\x1b[D') key = 'ArrowLeft';
      // Home/End
      else if (input === '\x1b[H' || input === '\x1b[1~') key = 'Home';
      else if (input === '\x1b[F' || input === '\x1b[4~') key = 'End';
      // Page Up/Down
      else if (input === '\x1b[5~') key = 'PageUp';
      else if (input === '\x1b[6~') key = 'PageDown';
      // Insert/Delete
      else if (input === '\x1b[2~') key = 'Insert';
      else if (input === '\x1b[3~') key = 'Delete';
      // Function keys
      else if (input === '\x1b[11~' || input === '\x1bOP') key = 'F1';
      else if (input === '\x1b[12~' || input === '\x1bOQ') key = 'F2';
      else if (input === '\x1b[13~' || input === '\x1bOR') key = 'F3';
      else if (input === '\x1b[14~' || input === '\x1bOS') key = 'F4';
      else if (input === '\x1b[15~') key = 'F5';
      else if (input === '\x1b[17~') key = 'F6';
      else if (input === '\x1b[18~') key = 'F7';
      else if (input === '\x1b[19~') key = 'F8';
      else if (input === '\x1b[20~') key = 'F9';
      else if (input === '\x1b[21~') key = 'F10';
      else if (input === '\x1b[23~') key = 'F11';
      else if (input === '\x1b[24~') key = 'F12';
      else {
        return null; // Unknown escape sequence
      }
    }
    // Handle Alt+ combinations
    else if (input.startsWith('\x1b') && input.length === 2) {
      key = input[1];
      char = input[1];
      alt = true;
    }
    // Handle printable characters
    else if (input.length === 1 && input.charCodeAt(0) >= 32) {
      key = input;
      char = input;
      
      // Detect shift for uppercase letters and shifted symbols
      if (input >= 'A' && input <= 'Z') {
        shift = true;
      } else if ('!@#$%^&*()_+{}|:"<>?'.includes(input)) {
        shift = true;
      }
    }
    // Handle multi-character sequences or UTF-8
    else if (input.length > 1) {
      // For now, treat as unknown
      return null;
    }
    else {
      return null; // Unknown input
    }

    return { key, char, sequence, ctrl, shift, alt, meta };
  }

  /**
   * Create a proper HappyDOM KeyboardEvent
   */
  private createKeyboardEvent(type: string, keyEvent: TOMKeyboardEvent) {
    return new this.document.window.KeyboardEvent(type, {
      key: keyEvent.key,
      code: this.getKeyCode(keyEvent.key),
      ctrlKey: keyEvent.ctrl,
      shiftKey: keyEvent.shift,
      altKey: keyEvent.alt,
      metaKey: keyEvent.meta,
      bubbles: true,
      cancelable: true,
      view: this.document.window
    });
  }

  /**
   * Map key names to key codes for better DOM compliance
   */
  private getKeyCode(key: string): string {
    // Map common keys to their DOM KeyboardEvent codes
    const codeMap: { [key: string]: string } = {
      'ArrowUp': 'ArrowUp',
      'ArrowDown': 'ArrowDown', 
      'ArrowLeft': 'ArrowLeft',
      'ArrowRight': 'ArrowRight',
      'Enter': 'Enter',
      'Escape': 'Escape',
      'Backspace': 'Backspace',
      'Tab': 'Tab',
      'Home': 'Home',
      'End': 'End',
      'PageUp': 'PageUp',
      'PageDown': 'PageDown',
      'Insert': 'Insert',
      'Delete': 'Delete',
      ' ': 'Space'
    };

    if (codeMap[key]) return codeMap[key];
    
    // For function keys
    if (key.startsWith('F') && key.length <= 3) {
      return key;
    }
    
    // For single character keys
    if (key.length === 1) {
      if (key >= 'a' && key <= 'z') {
        return 'Key' + key.toUpperCase();
      }
      if (key >= 'A' && key <= 'Z') {
        return 'Key' + key;
      }
      if (key >= '0' && key <= '9') {
        return 'Digit' + key;
      }
    }
    
    return key;
  }

  /**
   * Set the focused element for keyboard events
   */
  setFocusedElement(element: TOMElement | null): void {
    if (this.keyboardState.focusedElement !== element) {
      // Blur old element
      if (this.keyboardState.focusedElement) {
        const blurEvent = new this.document.window.FocusEvent('blur', {
          bubbles: false,
          relatedTarget: element
        });
        this.keyboardState.focusedElement.dispatchEvent(blurEvent);
      }
      
      // Focus new element
      if (element) {
        const focusEvent = new this.document.window.FocusEvent('focus', {
          bubbles: false,
          relatedTarget: this.keyboardState.focusedElement
        });
        element.dispatchEvent(focusEvent);
      }
      
      this.keyboardState.focusedElement = element;
    }
  }

  /**
   * Get currently focused element
   */
  getFocusedElement(): TOMElement | null {
    return this.keyboardState.focusedElement;
  }

  /**
   * Enable/disable input mode (for text input elements)
   */
  setInputMode(enabled: boolean): void {
    this.keyboardState.inputMode = enabled;
  }

  /**
   * Check if in input mode
   */
  isInputMode(): boolean {
    return this.keyboardState.inputMode;
  }

  /**
   * Get current keyboard state
   */
  getKeyboardState(): Readonly<KeyboardState> {
    return { ...this.keyboardState };
  }

  /**
   * Configure default exit handlers (Ctrl+C, Ctrl+D)
   * Best practice: Keep enabled for user experience
   */
  setDefaultExitHandlers(enabled: boolean): void {
    this.enableDefaultExitHandlers = enabled;
  }

  /**
   * Set a custom exit handler for Ctrl+C and Ctrl+D
   * Use this to save state or show confirmation before exiting
   */
  setCustomExitHandler(handler?: () => void): void {
    this.customExitHandler = handler;
  }

  /**
   * Get whether default exit handlers are enabled
   */
  getDefaultExitHandlersEnabled(): boolean {
    return this.enableDefaultExitHandlers;
  }
}