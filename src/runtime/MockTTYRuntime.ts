/**
 * MockTTYRuntime - Test-friendly TTY runtime implementation
 * 
 * Provides a controllable mock implementation of TTYRuntime for unit testing.
 * Captures all output, simulates input, and allows precise control over
 * terminal capabilities and behavior.
 * 
 * Features:
 * - Output capture for assertions
 * - Input simulation for testing interactions
 * - Controllable terminal capabilities
 * - Event simulation (resize, signals, etc.)
 * - No actual terminal I/O or process control
 */

import { CustomEvent } from '../dom.js';
import { TTYRuntime, type TTYDimensions, type TTYCapabilities, type TTYKeyEvent, type TTYMouseEvent, type CellStyleOptions } from '../core/TTYRuntime.js';

interface MockTTYRuntimeOptions {
  dimensions?: TTYDimensions;
  capabilities?: Partial<TTYCapabilities>;
}

export class MockTTYRuntime extends TTYRuntime {
  private _dimensions: TTYDimensions;
  private _capabilities: TTYCapabilities;
  private _outputBuffer: string[] = [];
  private _errorBuffer: string[] = [];
  private _rawMode = false;
  private _mouseTracking = false;
  private _cursorVisible = true;
  private _currentStyle: string[] = [];
  
  // Streams - create mock Web Streams
  private _stdin: ReadableStream<Uint8Array>;
  private _stdout: WritableStream<Uint8Array>;
  private _stderr: WritableStream<Uint8Array>;
  private _stdinController: ReadableStreamDefaultController<Uint8Array>;
  private _stdoutController: ReadableStreamDefaultController<string>;
  private _stdoutReadableStream: ReadableStream<string>;
  private _exitCode: number | null = null;

  constructor(options: MockTTYRuntimeOptions = {}) {
    super();
    
    this._dimensions = options.dimensions || { columns: 80, rows: 24 };
    this._capabilities = {
      isTTY: true,
      colorDepth: 24,
      hasColors: true,
      supportsUnicode: true,
      ...options.capabilities
    };

    // Create mock stdin stream
    let stdinController: ReadableStreamDefaultController<Uint8Array>;
    this._stdin = new ReadableStream({
      start(controller) {
        stdinController = controller;
      }
    });
    this._stdinController = stdinController!;

    // Create stdout readable stream for snapshotter
    let stdoutController: ReadableStreamDefaultController<string>;
    this._stdoutReadableStream = new ReadableStream({
      start(controller) {
        stdoutController = controller;
      }
    });
    this._stdoutController = stdoutController!;

    // Create mock stdout stream that feeds both buffer and readable stream
    this._stdout = new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        this._outputBuffer.push(text);
        // Also enqueue to readable stream for snapshotter
        this._stdoutController.enqueue(text);
        return Promise.resolve();
      }
    });

    // Create mock stderr stream
    this._stderr = new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        this._errorBuffer.push(text);
        return Promise.resolve();
      }
    });
  }

  // === I/O Streams ===
  get stdin(): ReadableStream<Uint8Array> {
    return this._stdin;
  }

  get stdout(): WritableStream<Uint8Array> {
    return this._stdout;
  }

  /**
   * Get readable stream for stdout (for TerminalSnapshotter)
   */
  getStdoutStream(): ReadableStream<string> {
    return this._stdoutReadableStream;
  }

  get stderr(): WritableStream<Uint8Array> {
    return this._stderr;
  }

  // === Process Control ===
  exit(code = 0): void {
    this._exitCode = code;
    // In mock, we don't actually exit - just record it
  }

  // === Terminal Capabilities ===
  getTerminalSize(): TTYDimensions {
    return { ...this._dimensions };
  }

  getCapabilities(): TTYCapabilities {
    return { ...this._capabilities };
  }

  // === Input Control ===
  setRawMode(enabled: boolean): void {
    this._rawMode = enabled;
  }

  enableMouseTracking(): void {
    this._mouseTracking = true;
  }

  disableMouseTracking(): void {
    this._mouseTracking = false;
  }

  // === Screen Control ===
  async cursorTo(x: number, y?: number): Promise<void> {
    if (y !== undefined) {
      await this.writeStdout(`\x1b[${y + 1};${x + 1}H`);
    } else {
      await this.writeStdout(`\x1b[${x + 1}G`);
    }
  }

  async clearLine(dir: -1 | 0 | 1 = 0): Promise<void> {
    let sequence: string;
    switch (dir) {
      case -1: sequence = '\x1b[1K'; break;
      case 1: sequence = '\x1b[0K'; break;
      default: sequence = '\x1b[2K'; break;
    }
    await this.writeStdout(sequence);
  }

  async clearScreen(): Promise<void> {
    await this.writeStdout('\x1b[2J\x1b[H');
  }

  async hideCursor(): Promise<void> {
    this._cursorVisible = false;
    await this.writeStdout('\x1b[?25l');
  }

  async showCursor(): Promise<void> {
    this._cursorVisible = true;
    await this.writeStdout('\x1b[?25h');
  }

  // === Text Styling ===
  setColor(fg?: string, bg?: string): void {
    if (fg) {
      this._recordStyle(`fg:${fg}`);
      // Write actual ANSI color code to output
      const fgCode = this._colorToAnsi(fg, false);
      if (fgCode) {
        this._outputBuffer.push(fgCode);
      }
    }
    if (bg) {
      this._recordStyle(`bg:${bg}`);
      // Write actual ANSI color code to output
      const bgCode = this._colorToAnsi(bg, true);
      if (bgCode) {
        this._outputBuffer.push(bgCode);
      }
    }
  }

  setBold(enabled: boolean): void {
    this._recordStyle(`bold:${enabled}`);
    if (enabled) {
      this._outputBuffer.push('\x1b[1m');
    }
  }

  setItalic(enabled: boolean): void {
    this._recordStyle(`italic:${enabled}`);
    if (enabled) {
      this._outputBuffer.push('\x1b[3m');
    }
  }

  setUnderline(enabled: boolean): void {
    this._recordStyle(`underline:${enabled}`);
    if (enabled) {
      this._outputBuffer.push('\x1b[4m');
    }
  }

  setDim(enabled: boolean): void {
    this._recordStyle(`dim:${enabled}`);
    if (enabled) {
      this._outputBuffer.push('\x1b[2m');
    }
  }

  setReverse(enabled: boolean): void {
    this._recordStyle(`reverse:${enabled}`);
    if (enabled) {
      this._outputBuffer.push('\x1b[7m');
    }
  }

  setStrikethrough(enabled: boolean): void {
    this._recordStyle(`strikethrough:${enabled}`);
    if (enabled) {
      this._outputBuffer.push('\x1b[9m');
    }
  }

  resetStyle(): void {
    this._currentStyle = [];
    this._recordStyle('reset');
    this._outputBuffer.push('\x1b[0m');
  }

  // === ANSI Generation ===
  generateCellStyle(options: CellStyleOptions): string {
    let sequence = '';

    // Reset all attributes first to ensure clean state
    sequence += '\x1b[0m';

    // Apply colors using mock color conversion
    if (options.fgColor) {
      const colorCode = this._colorToAnsi(options.fgColor, false);
      if (colorCode) sequence += colorCode;
    }
    if (options.bgColor) {
      const colorCode = this._colorToAnsi(options.bgColor, true);
      if (colorCode) sequence += colorCode;
    } else {
      // No background color - explicitly reset background to prevent bleeding
      sequence += '\x1b[49m';
    }

    // Apply text styling
    if (options.bold) sequence += '\x1b[1m';
    if (options.italic) sequence += '\x1b[3m';
    if (options.underline) sequence += '\x1b[4m';
    if (options.dim) sequence += '\x1b[2m';
    if (options.inverse) sequence += '\x1b[7m';
    if (options.strikethrough) sequence += '\x1b[9m';

    return sequence;
  }

  // === Text Utilities ===
  measureTextWidth(text: string): number {
    // Simple mock implementation - count visible characters
    const stripped = this.stripAnsiCodes(text);
    return stripped.length;
  }

  stripAnsiCodes(text: string): string {
    // Mock implementation - remove ANSI escape sequences
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  colorizeText(text: string, color: string): string {
    // Mock implementation - just wrap with markers
    return `[COLOR:${color}]${text}[/COLOR]`;
  }

  // === Error Handling ===
  onUnhandledRejection(handler: (reason: any, promise: Promise<any>) => void): void {
    // Mock implementation - store handler for testing
    (this as any)._unhandledRejectionHandler = handler;
  }

  onUncaughtException(handler: (error: Error) => void): void {
    // Mock implementation - store handler for testing
    (this as any)._uncaughtExceptionHandler = handler;
  }

  // === Testing Utilities ===

  /**
   * Close stdout stream (signals end of output)
   */
  closeStdout(): void {
    this._stdoutController.close();
  }

  /**
   * Get all output written to stdout (legacy method for existing tests)
   */
  getStdoutOutput(): string {
    return this._outputBuffer.join('');
  }

  /**
   * Get all output written to stderr
   */
  getStderrOutput(): string {
    return this._errorBuffer.join('');
  }

  /**
   * Get stdout output as array of chunks
   */
  getStdoutChunks(): string[] {
    return [...this._outputBuffer];
  }

  /**
   * Get stderr output as array of chunks
   */
  getStderrChunks(): string[] {
    return [...this._errorBuffer];
  }

  /**
   * Clear all captured output
   */
  clearOutput(): void {
    this._outputBuffer = [];
    this._errorBuffer = [];
    this._currentStyle = [];
  }

  /**
   * Get the exit code that was passed to exit(), or null if not called
   */
  getExitCode(): number | null {
    return this._exitCode;
  }

  /**
   * Check if raw mode is enabled
   */
  isRawMode(): boolean {
    return this._rawMode;
  }

  /**
   * Check if mouse tracking is enabled
   */
  isMouseTracking(): boolean {
    return this._mouseTracking;
  }

  /**
   * Check if cursor is visible
   */
  isCursorVisible(): boolean {
    return this._cursorVisible;
  }

  /**
   * Get current style state
   */
  getCurrentStyles(): string[] {
    return [...this._currentStyle];
  }

  /**
   * Simulate terminal resize
   */
  simulateResize(columns: number, rows: number): void {
    this._dimensions = { columns, rows };
    this.dispatchEvent(new CustomEvent('resize', { 
      detail: this.getTerminalSize() 
    }));
  }

  /**
   * Simulate key input
   */
  simulateKeypress(key: string, modifiers: Partial<Pick<TTYKeyEvent, 'ctrl' | 'alt' | 'shift' | 'meta'>> = {}): void {
    const keyEvent: TTYKeyEvent = {
      key,
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      sequence: key,
      ...modifiers
    };
    
    this.dispatchEvent(new CustomEvent('keypress', { detail: keyEvent }));
    
    // Also push to stdin stream
    const encoder = new TextEncoder();
    this._stdinController.enqueue(encoder.encode(key));
  }

  /**
   * Simulate mouse event
   */
  simulateMouseEvent(event: TTYMouseEvent): void {
    this.dispatchEvent(new CustomEvent('mouse', { detail: event }));
  }

  /**
   * Simulate process signals
   */
  simulateInterrupt(): void {
    this.dispatchEvent(new CustomEvent('interrupt'));
  }

  simulateTerminate(): void {
    this.dispatchEvent(new CustomEvent('terminate'));
  }

  simulateHangup(): void {
    this.dispatchEvent(new CustomEvent('hangup'));
  }

  /**
   * Simulate unhandled rejection
   */
  simulateUnhandledRejection(reason: any, promise: Promise<any>): void {
    const handler = (this as any)._unhandledRejectionHandler;
    if (handler) {
      handler(reason, promise);
    }
  }

  /**
   * Simulate uncaught exception
   */
  simulateUncaughtException(error: Error): void {
    const handler = (this as any)._uncaughtExceptionHandler;
    if (handler) {
      handler(error);
    }
  }

  /**
   * Update terminal capabilities for testing
   */
  setCapabilities(capabilities: Partial<TTYCapabilities>): void {
    this._capabilities = { ...this._capabilities, ...capabilities };
  }

  // === Private Implementation ===
  
  private _recordStyle(style: string): void {
    this._currentStyle.push(style);
  }

  /**
   * Convert color name to ANSI escape sequence
   */
  private _colorToAnsi(color: string, isBackground: boolean): string {
    const colors: Record<string, number> = {
      'black': 0, 'red': 1, 'green': 2, 'yellow': 3,
      'blue': 4, 'magenta': 5, 'cyan': 6, 'white': 7
    };

    const colorCode = colors[color.toLowerCase()];
    if (colorCode !== undefined) {
      const base = isBackground ? 40 : 30;
      return `\x1b[${base + colorCode}m`;
    }

    // Try to use Bun's color API if available
    try {
      const ansiColor = (Bun as any).color?.(color, 'ansi');
      if (ansiColor && isBackground) {
        // Convert foreground (38) to background (48)
        return ansiColor.replace('38;', '48;');
      } else {
        return ansiColor || '';
      }
    } catch {
      return '';
    }
  }
}