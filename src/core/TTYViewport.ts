/**
 * TTYViewport - Manages viewport and scrolling
 */

import { TTYRuntime } from './TTYRuntime.js';

export interface ViewportOptions {
  scrollable?: boolean;
  width?: number;
  height?: number;
}

// TODO: this class is not useful enough to keep right now, consider deleting.
export class TTYViewport {
  constructor(
    private runtime: TTYRuntime,
    private options: ViewportOptions = {}
  ) {}

  scrollTo(x: number, y: number): void {
    // TODO: Implement scrolling
    console.log('TTYViewport.scrollTo:', x, y);
  }

  scrollBy(deltaX: number, deltaY: number): void {
    // TODO: Implement relative scrolling
    console.log('TTYViewport.scrollBy:', deltaX, deltaY);
  }

  dispose(): void {
    // TODO: Implement cleanup
  }
}
