/**
 * TTYMouseHandler - Handles mouse events through TTYRuntime
 */

import { TTYRuntime, type TTYMouseEvent } from './TTYRuntime.js';
// TODO: Fill this logic in.

export class TTYMouseHandler {
  constructor(private runtime: TTYRuntime) {}

  handleMouseEvent(event: TTYMouseEvent): void {
    // TODO: Implement mouse event handling
    console.log('TTYMouseHandler.handleMouseEvent:', event);
  }

  dispose(): void {
    // TODO: Implement cleanup
  }
}
