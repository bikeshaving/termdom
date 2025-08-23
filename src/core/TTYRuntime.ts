/**
 * TTYRuntime - Abstract runtime interface for TTY Object Model
 *
 * Provides a clean abstraction over terminal I/O, process signals, and terminal control.
 * Isolates all ANSI escape sequences and platform-specific concerns from the DOM layer.
 *
 * Implementations handle:
 * - Converting platform streams to Web Streams
 * - Signal handling (SIGWINCH, SIGTERM, SIGINT, etc.)
 * - Process events (unhandledRejection, uncaughtException)
 * - Terminal control (cursor, colors, clearing) via ANSI sequences
 * - Capabilities detection (dimensions, colors, TTY status)
 */

export interface TTYDimensions {
  columns: number;
  rows: number;
}

export interface TTYCapabilities {
  isTTY: boolean;
  colorDepth: number;
  hasColors: boolean;
  supportsUnicode: boolean;
}

// TODO: Use KeyboardEvent
export interface TTYKeyEvent {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  sequence: string;
}

// TODO: Should use MouseEvent, not whatever this is.
export interface TTYMouseEvent {
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle' | 'wheel';
  action: 'press' | 'release' | 'drag' | 'move' | 'scroll';
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface CellStyleOptions {
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

/**
 * Abstract base class for TTY runtime implementations.
 * Extends EventTarget to provide standard DOM-like event handling.
 *
 * Events emitted:
 * - 'keypress': TTYKeyEvent - Raw keypress from terminal
 * - 'mouse': TTYMouseEvent - Mouse events (when tracking enabled)
 * - 'resize': TTYDimensions - Terminal window resize
 * - 'interrupt': void - SIGINT (Ctrl+C)
 * - 'terminate': void - SIGTERM
 * - 'hangup': void - SIGHUP (terminal disconnect)
 */
export abstract class TTYRuntime extends EventTarget {
  // === I/O Streams (Web Streams) ===
  abstract readonly stdin: ReadableStream<Uint8Array>;
  abstract readonly stdout: WritableStream<Uint8Array>;
  abstract readonly stderr: WritableStream<Uint8Array>;

  // === Process Control ===
  abstract exit(code?: number): void;

  // === Terminal Capabilities ===
  abstract getTerminalSize(): TTYDimensions;
  abstract getCapabilities(): TTYCapabilities;

  // === Input Control ===
  abstract setRawMode(enabled: boolean): void;
  abstract enableMouseTracking(): void;
  abstract disableMouseTracking(): void;

  // === Screen Control (async - matches Node TTY API) ===
  abstract cursorTo(x: number, y?: number): Promise<void>;
  abstract clearLine(dir?: -1 | 0 | 1): Promise<void>;
  abstract clearScreen(): Promise<void>;
  abstract hideCursor(): Promise<void>;
  abstract showCursor(): Promise<void>;

  // === Text Styling (sync - just escape sequences) ===
  abstract setColor(fg?: string, bg?: string): void;
  abstract setBold(enabled: boolean): void;
  abstract setItalic(enabled: boolean): void;
  abstract setUnderline(enabled: boolean): void;
  abstract setDim(enabled: boolean): void;
  abstract setReverse(enabled: boolean): void;
  abstract setStrikethrough(enabled: boolean): void;
  abstract resetStyle(): void;

  // === ANSI Generation (for ScreenBuffer) ===
  abstract generateCellStyle(options: CellStyleOptions): string;

	// TODO: WE SHOULD USE BUN NAMES and APIS
  // === Text Utilities ===
	// TODO: rename to stringWidth
  abstract measureTextWidth(text: string): number;
	// TODO: rename to stripANSI
  abstract stripAnsiCodes(text: string): string;
	// TODO: rename to colorize or even color?
  abstract colorizeText(text: string, color: string): string;

  // === Error Handling ===
  abstract onUnhandledRejection(handler: (reason: any, promise: Promise<any>) => void): void;
  abstract onUncaughtException(handler: (error: Error) => void): void;

  // === Utility Methods ===

  /**
   * Write text to stdout with automatic encoding
   */
  async writeStdout(text: string): Promise<void> {
    const writer = this.stdout.getWriter();
    try {
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(text));
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Write text to stderr with automatic encoding
   */
  async writeStderr(text: string): Promise<void> {
    const writer = this.stderr.getWriter();
    try {
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(text));
    } finally {
      writer.releaseLock();
    }
  }

  /**
   * Convenience method to set foreground color
   */
  setForegroundColor(color: string): void {
    this.setColor(color, undefined);
  }

  /**
   * Convenience method to set background color
   */
  setBackgroundColor(color: string): void {
    this.setColor(undefined, color);
  }

  /**
   * Check if terminal supports true color (24-bit RGB)
   */
  supportsTrueColor(): boolean {
    const caps = this.getCapabilities();
    return caps.colorDepth >= 24;
  }

  /**
   * Check if terminal supports 256 colors
   */
  supports256Colors(): boolean {
    const caps = this.getCapabilities();
    return caps.colorDepth >= 8;
  }

  /**
   * Get current terminal dimensions as CSS-style object
   */
  getViewportSize(): { width: number; height: number } {
    const { columns, rows } = this.getTerminalSize();
    return { width: columns, height: rows };
  }
}

// Let’s use import over require, and figure out the async defaults perhaps
/**
 * Runtime detection utility
 * Auto-detects the appropriate TTYRuntime implementation for the current environment
 */
export function detectTTYRuntime(): TTYRuntime {
  // Primary target: Bun
  if (typeof Bun !== 'undefined' && typeof process !== 'undefined') {
    // Dynamically import to avoid bundling issues
    const { BunTTYRuntime } = require('../runtime/BunTTYRuntime.js');
    return new BunTTYRuntime();
  }

  // Future: Node.js fallback
  // if (typeof process !== 'undefined' && process.versions?.node) {
  //   const { NodeTTYRuntime } = require('../runtime/NodeTTYRuntime.js');
  //   return new NodeTTYRuntime();
  // }

  // Future: Deno fallback
  // if (typeof Deno !== 'undefined') {
  //   const { DenoTTYRuntime } = require('../runtime/DenoTTYRuntime.js');
  //   return new DenoTTYRuntime();
  // }

  throw new Error(
    'No compatible TTY runtime detected. ' +
    'TTY Object Model currently requires Bun environment.'
  );
}
