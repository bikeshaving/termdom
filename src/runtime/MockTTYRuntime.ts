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

import { TTYRuntime, type TTYDimensions, type TTYCapabilities, type TTYKeyEvent, type TTYMouseEvent } from '../core/TTYRuntime.js';

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

    // Create mock stdout stream
    this._stdout = new WritableStream({
      write: (chunk) => {
        const text = new TextDecoder().decode(chunk);
        this._outputBuffer.push(text);
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
    }
    if (bg) {
      this._recordStyle(`bg:${bg}`);
    }
  }

  setBold(enabled: boolean): void {
    this._recordStyle(`bold:${enabled}`);
  }

  setItalic(enabled: boolean): void {
    this._recordStyle(`italic:${enabled}`);
  }

  setUnderline(enabled: boolean): void {
    this._recordStyle(`underline:${enabled}`);
  }

  setDim(enabled: boolean): void {
    this._recordStyle(`dim:${enabled}`);
  }

  setReverse(enabled: boolean): void {
    this._recordStyle(`reverse:${enabled}`);
  }

  setStrikethrough(enabled: boolean): void {
    this._recordStyle(`strikethrough:${enabled}`);
  }

  resetStyle(): void {
    this._currentStyle = [];
    this._recordStyle('reset');
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
   * Get all output written to stdout
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
}