/**
 * BunTTYRuntime - Bun-optimized TTY runtime implementation
 * 
 * Leverages Bun's special APIs and Node.js compatibility to provide
 * high-performance terminal I/O with modern Web Streams interface.
 * 
 * Features:
 * - Bun.color() for optimized color output
 * - Bun.stringWidth() for accurate text measurement  
 * - Bun.escapeANSI() for ANSI code stripping
 * - Node.js tty module compatibility
 * - Web Streams conversion from Node streams
 * - Signal handling (SIGWINCH, SIGTERM, SIGINT)
 * - Modern promise-based async APIs
 */

import { Readable, Writable } from 'node:stream';
import * as tty from 'tty';
import { CustomEvent } from '../dom.js';
import { TTYRuntime, type TTYDimensions, type TTYCapabilities, type TTYKeyEvent, type TTYMouseEvent, type CellStyleOptions } from '../core/TTYRuntime.js';

export class BunTTYRuntime extends TTYRuntime {
  private _stdin: ReadableStream<Uint8Array>;
  private _stdout: WritableStream<Uint8Array>;  
  private _stderr: WritableStream<Uint8Array>;
  private _rawMode = false;
  private _mouseTracking = false;
  private _keyBuffer = '';

  constructor() {
    super();
    
    // Convert Node streams to Web Streams using Bun's compatibility
    this._stdin = Readable.toWeb(process.stdin as any) as unknown as ReadableStream<Uint8Array>;
    this._stdout = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    this._stderr = Writable.toWeb(process.stderr) as WritableStream<Uint8Array>;

    this._setupSignalHandling();
    this._setupInputHandling();
    this._setupErrorHandling();
  }

  // === I/O Streams ===
  
  // Override to avoid stream locking issues
  override async writeStdout(text: string): Promise<void> {
    process.stdout.write(text);
  }
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
    // Clean up before exit
    this.disableMouseTracking();
    this.showCursor();
    this.setRawMode(false);
    process.exit(code);
  }

  // === Terminal Capabilities ===
  getTerminalSize(): TTYDimensions {
    return {
      columns: process.stdout.columns || 80,
      rows: process.stdout.rows || 24
    };
  }

  getCapabilities(): TTYCapabilities {
    const stdout = process.stdout as tty.WriteStream;
    return {
      isTTY: stdout.isTTY || false,
      colorDepth: stdout.getColorDepth ? stdout.getColorDepth() : 4,
      hasColors: stdout.hasColors ? stdout.hasColors() : false,
      supportsUnicode: process.env.LANG?.includes('UTF-8') || false
    };
  }

  // === Input Control ===
  setRawMode(enabled: boolean): void {
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(enabled);
      this._rawMode = enabled;
    }
  }

  enableMouseTracking(): void {
    if (!this._mouseTracking) {
      // Enable mouse tracking with SGR extended mode
      this._writeAnsi('\x1b[?1000h'); // Basic mouse reporting
      this._writeAnsi('\x1b[?1002h'); // Mouse drag tracking
      this._writeAnsi('\x1b[?1006h'); // SGR extended mode
      this._mouseTracking = true;
    }
  }

  disableMouseTracking(): void {
    if (this._mouseTracking) {
      this._writeAnsi('\x1b[?1000l'); // Disable basic mouse reporting
      this._writeAnsi('\x1b[?1002l'); // Disable mouse drag tracking  
      this._writeAnsi('\x1b[?1006l'); // Disable SGR extended mode
      this._mouseTracking = false;
    }
  }

  // === Screen Control ===
  async cursorTo(x: number, y?: number): Promise<void> {
    if (y !== undefined) {
      await this._writeAnsiAsync(`\x1b[${y + 1};${x + 1}H`);
    } else {
      await this._writeAnsiAsync(`\x1b[${x + 1}G`);
    }
  }

  async clearLine(dir: -1 | 0 | 1 = 0): Promise<void> {
    let sequence: string;
    switch (dir) {
      case -1: sequence = '\x1b[1K'; break; // Clear from cursor to beginning
      case 1: sequence = '\x1b[0K'; break;  // Clear from cursor to end
      default: sequence = '\x1b[2K'; break; // Clear entire line
    }
    await this._writeAnsiAsync(sequence);
  }

  async clearScreen(): Promise<void> {
    await this._writeAnsiAsync('\x1b[2J\x1b[H');
  }

  async hideCursor(): Promise<void> {
    await this._writeAnsiAsync('\x1b[?25l');
  }

  async showCursor(): Promise<void> {
    await this._writeAnsiAsync('\x1b[?25h');
  }

  // === Text Styling ===
  setColor(fg?: string, bg?: string): void {
    if (fg) {
      this._writeAnsi(this._getColorCode(fg, false));
    }
    if (bg) {
      this._writeAnsi(this._getColorCode(bg, true));
    }
  }

  setBold(enabled: boolean): void {
    this._writeAnsi(enabled ? '\x1b[1m' : '\x1b[22m');
  }

  setItalic(enabled: boolean): void {
    this._writeAnsi(enabled ? '\x1b[3m' : '\x1b[23m');
  }

  setUnderline(enabled: boolean): void {
    this._writeAnsi(enabled ? '\x1b[4m' : '\x1b[24m');
  }

  setDim(enabled: boolean): void {
    this._writeAnsi(enabled ? '\x1b[2m' : '\x1b[22m');
  }

  setReverse(enabled: boolean): void {
    this._writeAnsi(enabled ? '\x1b[7m' : '\x1b[27m');
  }

  setStrikethrough(enabled: boolean): void {
    this._writeAnsi(enabled ? '\x1b[9m' : '\x1b[29m');
  }

  resetStyle(): void {
    this._writeAnsi('\x1b[0m');
  }

  // === ANSI Generation (moved from ScreenBuffer) ===
  generateCellStyle(options: CellStyleOptions): string {
    let sequence = '';

    // Reset all attributes first to ensure clean state
    sequence += '\x1b[0m';

    // Apply colors
    if (options.fgColor) {
      const colorCode = this._getColorCode(options.fgColor, false);
      if (colorCode) sequence += colorCode;
    }
    if (options.bgColor) {
      const colorCode = this._getColorCode(options.bgColor, true);
      if (colorCode) sequence += colorCode;
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

  // === Text Utilities (Bun-optimized) ===
  measureTextWidth(text: string): number {
    // Use Bun's optimized string width calculation
    if (typeof Bun !== 'undefined' && Bun.stringWidth) {
      return Bun.stringWidth(text);
    }
    
    // Fallback: strip ANSI and count visible characters
    const stripped = this.stripAnsiCodes(text);
    return stripped.length; // Simplified - doesn't handle multi-width chars
  }

  stripAnsiCodes(text: string): string {
    // Use Bun's optimized ANSI escape function if available
    if (typeof Bun !== 'undefined' && 'stripANSI' in Bun) {
      return (Bun as any).stripANSI(text);
    }
    
    // Fallback: regex-based stripping
    return text.replace(/\x1b\[[0-9;]*m/g, '');
  }

  colorizeText(text: string, color: string): string {
    // Use Bun's optimized color function
    if (typeof Bun !== 'undefined' && 'color' in Bun) {
      return (Bun as any).color(text, color);
    }
    
    // Fallback: manual ANSI codes
    const colorCode = this._getColorCode(color, false);
    const resetCode = '\x1b[39m'; // Reset foreground
    return colorCode + text + resetCode;
  }

  // === Error Handling ===
  onUnhandledRejection(handler: (reason: any, promise: Promise<any>) => void): void {
    process.on('unhandledRejection', handler);
  }

  onUncaughtException(handler: (error: Error) => void): void {
    process.on('uncaughtException', handler);
  }

  // === Private Implementation ===
  
  private _setupSignalHandling(): void {
    // Terminal resize
    process.on('SIGWINCH', () => {
      const dimensions = this.getTerminalSize();
      this.dispatchEvent(new CustomEvent('resize', { detail: dimensions }));
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      this.dispatchEvent(new CustomEvent('terminate'));
    });

    // Interrupt (Ctrl+C)
    process.on('SIGINT', () => {
      this.dispatchEvent(new CustomEvent('interrupt'));
    });

    // Terminal hangup
    process.on('SIGHUP', () => {
      this.dispatchEvent(new CustomEvent('hangup'));
    });
  }

  private _setupInputHandling(): void {
    // Handle raw input data
    process.stdin.on('data', (data: Buffer) => {
      const input = data.toString();
      
      if (this._mouseTracking) {
        const mouseEvent = this._parseMouseInput(input);
        if (mouseEvent) {
          this.dispatchEvent(new CustomEvent('mouse', { detail: mouseEvent }));
          return;
        }
      }

      const keyEvent = this._parseKeyInput(input);
      if (keyEvent) {
        this.dispatchEvent(new CustomEvent('keypress', { detail: keyEvent }));
      }
    });
  }

  private _setupErrorHandling(): void {
    // Default error handlers that can be overridden
    this.onUnhandledRejection((reason) => {
      console.error('Unhandled promise rejection:', reason);
    });

    this.onUncaughtException((error) => {
      console.error('Uncaught exception:', error);
      this.exit(1);
    });
  }

  private async _writeAnsiAsync(sequence: string): Promise<void> {
    await this.writeStdout(sequence);
  }

  private _writeAnsi(sequence: string): void {
    // Synchronous version for styling methods
    process.stdout.write(sequence);
  }

  private _getColorCode(color: string, background: boolean): string {
    const prefix = background ? '\x1b[4' : '\x1b[3';
    
    // Named colors
    const namedColors: Record<string, string> = {
      black: '0', red: '1', green: '2', yellow: '3',
      blue: '4', magenta: '5', cyan: '6', white: '7',
      gray: '8', grey: '8'
    };
    
    if (namedColors[color]) {
      return `${prefix}${namedColors[color]}m`;
    }
    
    // Hex colors (#RGB or #RRGGBB)
    if (color.startsWith('#')) {
      const rgb = this._parseHexColor(color);
      if (rgb) {
        const { r, g, b } = rgb;
        return `\x1b[${background ? '48' : '38'};2;${r};${g};${b}m`;
      }
    }
    
    // RGB function
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
      const [, r, g, b] = rgbMatch;
      return `\x1b[${background ? '48' : '38'};2;${r};${g};${b}m`;
    }
    
    // Fallback to default
    return `${prefix}9m`;
  }

  private _parseHexColor(hex: string): { r: number; g: number; b: number } | null {
    // Remove # prefix
    hex = hex.slice(1);
    
    if (hex.length === 3) {
      // #RGB -> #RRGGBB
      hex = hex.split('').map(c => c + c).join('');
    }
    
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { r, g, b };
    }
    
    return null;
  }

  private _parseKeyInput(input: string): TTYKeyEvent | null {
    // Basic key parsing - can be extended for more complex sequences
    let key = input;
    let ctrl = false;
    let alt = false;
    let shift = false;
    let meta = false;

    // Handle escape sequences
    if (input.startsWith('\x1b')) {
      if (input === '\x1b') {
        key = 'escape';
      } else if (input.startsWith('\x1b[')) {
        // Arrow keys and function keys
        switch (input) {
          case '\x1b[A': key = 'up'; break;
          case '\x1b[B': key = 'down'; break;
          case '\x1b[C': key = 'right'; break;
          case '\x1b[D': key = 'left'; break;
          case '\x1b[H': key = 'home'; break;
          case '\x1b[F': key = 'end'; break;
          default: key = input;
        }
      } else if (input.length === 2) {
        // Alt + key
        alt = true;
        key = input[1];
      }
    } else {
      // Control characters
      const code = input.charCodeAt(0);
      if (code < 32 && code !== 10 && code !== 13) {
        ctrl = true;
        key = String.fromCharCode(code + 96); // Convert to letter
      }
      
      // Special keys
      if (input === '\r') key = 'enter';
      else if (input === '\n') key = 'enter';
      else if (input === '\t') key = 'tab';
      else if (input === '\x7f') key = 'backspace';
    }

    return {
      key,
      ctrl,
      alt, 
      shift,
      meta,
      sequence: input
    };
  }

  private _parseMouseInput(input: string): TTYMouseEvent | null {
    // Parse SGR extended mouse format: \x1b[<button;x;y;M/m
    const sgrMatch = input.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      const [, buttonStr, xStr, yStr, action] = sgrMatch;
      const button = parseInt(buttonStr);
      const x = parseInt(xStr) - 1; // Convert to 0-based
      const y = parseInt(yStr) - 1; // Convert to 0-based
      
      let buttonName: 'left' | 'right' | 'middle' | 'wheel';
      let actionName: 'press' | 'release' | 'drag' | 'move' | 'scroll';
      
      // Parse button and action
      if (button & 64) {
        buttonName = 'wheel';
        actionName = 'scroll';
      } else {
        switch (button & 3) {
          case 0: buttonName = 'left'; break;
          case 1: buttonName = 'middle'; break;
          case 2: buttonName = 'right'; break;
          default: buttonName = 'left'; break;
        }
        actionName = action === 'M' ? 'press' : 'release';
      }
      
      return {
        x,
        y,
        button: buttonName,
        action: actionName,
        ctrl: !!(button & 16),
        alt: !!(button & 8),
        shift: !!(button & 4)
      };
    }
    
    return null;
  }
}