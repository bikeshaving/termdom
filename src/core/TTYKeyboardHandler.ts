/**
 * TTYKeyboardHandler - Handles keyboard events through TTYRuntime
 */

import { TTYRuntime, type TTYKeyEvent } from './TTYRuntime.js';

export class TTYKeyboardHandler {
  constructor(private runtime: TTYRuntime) {}

  handleKeyEvent(event: TTYKeyEvent): void {
    // TODO: Implement keyboard event handling
    console.log('TTYKeyboardHandler.handleKeyEvent:', event);
  }

  dispose(): void {
    // TODO: Implement cleanup
  }
}