/**
 * Terminal Snapshotter for Testing
 *
 * Consumes ANSI streams and builds static screen representations
 * that can be saved as human-viewable .ansi snapshot files.
 */

export interface TerminalCell {
  char: string;
  fgColor?: string;
  bgColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface TerminalSnapshotterOptions {
  width?: number;
  height?: number;
}

export class TerminalSnapshotter {
  private screen: TerminalCell[][];
  private cursorX = 0;
  private cursorY = 0;
  private currentStyle: Partial<TerminalCell> = {};
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private currentReadPromise: Promise<{ done: boolean; value?: string }> | null = null;
  private streamConsumptionPromise: Promise<void> | null = null;
  private width: number;
  private height: number;

  constructor(
    stream: ReadableStream<string>,
    options: TerminalSnapshotterOptions = {}
  ) {
    this.width = options.width ?? 80;
    this.height = options.height ?? 24;
    this.screen = this.createEmptyScreen();

    // Start consuming the stream immediately
    this.reader = stream.getReader();
    this.streamConsumptionPromise = this.consumeStreamInBackground();
  }

  // Debug method to check cursor position
  getCursorPosition(): { x: number; y: number } {
    return { x: this.cursorX, y: this.cursorY };
  }

  /**
   * Consume stream in background
   */
  private async consumeStreamInBackground(): Promise<void> {
    if (!this.reader) return;

    try {
      while (this.reader) {
        // Store the current read operation
        this.currentReadPromise = this.reader.read().then(({ done, value }) => {
          if (!done && value) {
            this.processAnsiOutput(value);
          }
          return { done, value };
        });

        const { done } = await this.currentReadPromise;
        if (done) break;
      }
    } catch (error) {
      // Only throw if reader is still valid (not disposed)
      if (this.reader) {
        throw new Error(`TerminalSnapshotter stream error: ${error}`);
      }
    } finally {
      this.currentReadPromise = null;
    }
  }

  /**
   * Clean up stream resources
   */
  [Symbol.dispose](): void {
    if (this.reader) {
      this.reader.releaseLock();
      this.reader = null;
    }
  }

  /**
   * Create snapshotter from string input (for testing convenience)
   */
  static fromString(input: string, options: TerminalSnapshotterOptions = {}): TerminalSnapshotter {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(input);
        controller.close();
      }
    });
    return new TerminalSnapshotter(stream, options);
  }

  /**
   * Process ANSI output synchronously (for testing)
   */
  processAnsiOutputSync(output: string): void {
    this.processAnsiOutput(output);
  }

  /**
   * Process raw ANSI output and build screen grid (synchronous convenience method for testing)
   */
  processAnsiOutput(output: string): void {
    let i = 0;
    while (i < output.length) {
      if (output[i] === '\u001b' && output[i + 1] === '[') {
        // Found ANSI escape sequence - find the end
        const sequenceMatch = output.substring(i).match(/^\u001b\[([0-9;]*?)([a-zA-Z])/);
        if (sequenceMatch) {
          const params = sequenceMatch[1];
          const command = sequenceMatch[2];

          this.processAnsiCommand(params, command);
          i += sequenceMatch[0].length;
          continue;
        }

        // Unknown sequence, skip
        i += 2;
      } else {
        // Regular character
        this.putChar(output[i]);
        i++;
      }
    }
  }

  /**
   * Process individual ANSI command
   */
  private processAnsiCommand(params: string, command: string): void {
    const numbers = params.split(';').map(p => parseInt(p) || 0);

    switch (command) {
      case 'H': // Cursor position
      case 'f': // Same as H
        const row = numbers[0] || 1;
        const col = numbers[1] || 1;
        this.setCursor(col - 1, row - 1); // Convert to 0-based
        break;

      case 'A': // Cursor up
        this.cursorY = Math.max(0, this.cursorY - (numbers[0] || 1));
        break;

      case 'B': // Cursor down
        this.cursorY = Math.min(this.height - 1, this.cursorY + (numbers[0] || 1));
        break;

      case 'C': // Cursor forward
        this.cursorX = Math.min(this.width - 1, this.cursorX + (numbers[0] || 1));
        break;

      case 'D': // Cursor backward
        this.cursorX = Math.max(0, this.cursorX - (numbers[0] || 1));
        break;

      case 'J': // Clear screen
        if (numbers[0] === 2) {
          this.screen = this.createEmptyScreen();
          this.setCursor(0, 0);
        }
        break;

      case 'K': // Clear line
        // Clear from cursor to end of line
        for (let x = this.cursorX; x < this.width; x++) {
          this.screen[this.cursorY][x] = { char: ' ' };
        }
        break;

      case 'm': // SGR (color/style)
        this.processColorCode(params || '0');
        break;
    }
  }

  /**
   * Get snapshot as static ANSI output that can be viewed with `cat`
   * Waits for stream to be fully consumed before capturing screen state
   */
  async getSnapshot(): Promise<string> {
    // Wait for entire stream to be consumed
    if (this.streamConsumptionPromise) {
      await this.streamConsumptionPromise;
    }

    return this.generateSnapshot();
  }

  /**
   * Generate static ANSI output from current screen state (synchronous)
   */
  private generateSnapshot(): string {
    const lines: string[] = [];

    for (let y = 0; y < this.height; y++) {
      let line = '';
      let lastStyle = '';
      let hasContent = false;

      // Find last non-space character on line
      let lastContentIndex = -1;
      for (let x = 0; x < this.width; x++) {
        const cell = this.screen[y][x];
        if (cell.char !== ' ' || cell.fgColor || cell.bgColor || cell.bold || cell.italic || cell.underline) {
          lastContentIndex = x;
        }
      }

      // Only process up to last content
      for (let x = 0; x <= lastContentIndex; x++) {
        const cell = this.screen[y][x];

        if (cell.char !== ' ') hasContent = true;

        // Generate ANSI codes for style changes
        const styleCode = this.getCellAnsiStyle(cell);
        if (styleCode !== lastStyle) {
          // If we had styles and now have none, add reset
          if (lastStyle && !styleCode) {
            line += '\u001b[0m';
          }
          line += styleCode;
          lastStyle = styleCode;
        }

        line += cell.char;
      }

      // Reset styles at end of line if we had styles
      if (lastStyle) {
        line += '\u001b[0m';
      }

      // Add line if it has content or ANSI codes
      if (hasContent || line.includes('\u001b[')) {
        lines.push(line);
      } else {
        lines.push('');
      }
    }

    // Remove truly empty trailing lines
    while (lines.length > 0 && lines[lines.length - 1].length === 0) {
      lines.pop();
    }

    return lines.join('\n') + '\n';
  }

  private createEmptyScreen(): TerminalCell[][] {
    return Array(this.height).fill(null).map(() =>
      Array(this.width).fill(null).map(() => ({ char: ' ' }))
    );
  }

  private setCursor(x: number, y: number): void {
    this.cursorX = Math.max(0, Math.min(x, this.width - 1));
    this.cursorY = Math.max(0, Math.min(y, this.height - 1));
  }

  private putChar(char: string): void {
    if (char === '\n') {
      // Newline: move to start of next line
      this.cursorX = 0;
      this.cursorY++;
      return;
    }

    if (this.cursorY >= 0 && this.cursorY < this.height &&
        this.cursorX >= 0 && this.cursorX < this.width) {

      this.screen[this.cursorY][this.cursorX] = {
        char,
        ...this.currentStyle
      };

      this.cursorX++;
      if (this.cursorX >= this.width) {
        this.cursorX = 0;
        this.cursorY++;
      }
    }
  }

  private processColorCode(code: string): void {
    // Handle multiple SGR codes separated by semicolons (e.g., "1;31" for bold red)
    const codes = code.split(';').map(c => parseInt(c) || 0);

    let i = 0;
    while (i < codes.length) {
      const num = codes[i];

      switch (num) {
        case 0: // Reset all
          this.currentStyle = {};
          break;
        case 1: // Bold
          this.currentStyle.bold = true;
          break;
        case 3: // Italic
          this.currentStyle.italic = true;
          break;
        case 4: // Underline
          this.currentStyle.underline = true;
          break;

        // 8/16-color foreground
        case 30: this.currentStyle.fgColor = 'black'; break;
        case 31: this.currentStyle.fgColor = 'red'; break;
        case 32: this.currentStyle.fgColor = 'green'; break;
        case 33: this.currentStyle.fgColor = 'yellow'; break;
        case 34: this.currentStyle.fgColor = 'blue'; break;
        case 35: this.currentStyle.fgColor = 'magenta'; break;
        case 36: this.currentStyle.fgColor = 'cyan'; break;
        case 37: this.currentStyle.fgColor = 'white'; break;

        // 8/16-color background
        case 40: this.currentStyle.bgColor = 'black'; break;
        case 41: this.currentStyle.bgColor = 'red'; break;
        case 42: this.currentStyle.bgColor = 'green'; break;
        case 43: this.currentStyle.bgColor = 'yellow'; break;
        case 44: this.currentStyle.bgColor = 'blue'; break;
        case 45: this.currentStyle.bgColor = 'magenta'; break;
        case 46: this.currentStyle.bgColor = 'cyan'; break;
        case 47: this.currentStyle.bgColor = 'white'; break;

        // Extended color support
        case 38: // Foreground color
          if (i + 1 < codes.length) {
            const colorType = codes[i + 1];
            if (colorType === 2 && i + 4 < codes.length) {
              // 24-bit RGB: 38;2;R;G;B
              const r = codes[i + 2];
              const g = codes[i + 3];
              const b = codes[i + 4];
              this.currentStyle.fgColor = this.rgbToColorName(r, g, b);
              i += 4; // Skip the next 4 numbers (2, R, G, B)
            } else if (colorType === 5 && i + 2 < codes.length) {
              // 256-color: 38;5;N
              const colorIndex = codes[i + 2];
              this.currentStyle.fgColor = this.ansi256ToColorName(colorIndex);
              i += 2; // Skip the next 2 numbers (5, N)
            } else {
              i++; // Skip unknown format
            }
          }
          break;

        case 48: // Background color
          if (i + 1 < codes.length) {
            const colorType = codes[i + 1];
            if (colorType === 2 && i + 4 < codes.length) {
              // 24-bit RGB: 48;2;R;G;B
              const r = codes[i + 2];
              const g = codes[i + 3];
              const b = codes[i + 4];
              this.currentStyle.bgColor = this.rgbToColorName(r, g, b);
              i += 4; // Skip the next 4 numbers (2, R, G, B)
            } else if (colorType === 5 && i + 2 < codes.length) {
              // 256-color: 48;5;N
              const colorIndex = codes[i + 2];
              this.currentStyle.bgColor = this.ansi256ToColorName(colorIndex);
              i += 2; // Skip the next 2 numbers (5, N)
            } else {
              i++; // Skip unknown format
            }
          }
          break;
      }

      i++;
    }
  }

  private getCellAnsiStyle(cell: TerminalCell): string {
    let style = '';

    // Text styles
    if (cell.bold) style += '\u001b[1m';
    if (cell.italic) style += '\u001b[3m';
    if (cell.underline) style += '\u001b[4m';

    // Foreground colors
    if (cell.fgColor) {
      if (cell.fgColor.startsWith('#')) {
        // Hex color - convert to 24-bit ANSI
        const rgb = this.hexToRgb(cell.fgColor);
        if (rgb) {
          style += `\u001b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
        }
      } else {
        // Named color
        switch (cell.fgColor) {
          case 'black': style += '\u001b[30m'; break;
          case 'red': style += '\u001b[31m'; break;
          case 'green': style += '\u001b[32m'; break;
          case 'yellow': style += '\u001b[33m'; break;
          case 'blue': style += '\u001b[34m'; break;
          case 'magenta': style += '\u001b[35m'; break;
          case 'cyan': style += '\u001b[36m'; break;
          case 'white': style += '\u001b[37m'; break;
          case 'gray': style += '\u001b[90m'; break;
          // Bright colors
          case 'brightblack': style += '\u001b[90m'; break;
          case 'brightred': style += '\u001b[91m'; break;
          case 'brightgreen': style += '\u001b[92m'; break;
          case 'brightyellow': style += '\u001b[93m'; break;
          case 'brightblue': style += '\u001b[94m'; break;
          case 'brightmagenta': style += '\u001b[95m'; break;
          case 'brightcyan': style += '\u001b[96m'; break;
          case 'brightwhite': style += '\u001b[97m'; break;
        }
      }
    }

    // Background colors
    if (cell.bgColor) {
      if (cell.bgColor.startsWith('#')) {
        // Hex color - convert to 24-bit ANSI
        const rgb = this.hexToRgb(cell.bgColor);
        if (rgb) {
          style += `\u001b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
        }
      } else {
        // Named color
        switch (cell.bgColor) {
          case 'black': style += '\u001b[40m'; break;
          case 'red': style += '\u001b[41m'; break;
          case 'green': style += '\u001b[42m'; break;
          case 'yellow': style += '\u001b[43m'; break;
          case 'blue': style += '\u001b[44m'; break;
          case 'magenta': style += '\u001b[45m'; break;
          case 'cyan': style += '\u001b[46m'; break;
          case 'white': style += '\u001b[47m'; break;
          case 'gray': style += '\u001b[100m'; break;
          // Bright colors
          case 'brightblack': style += '\u001b[100m'; break;
          case 'brightred': style += '\u001b[101m'; break;
          case 'brightgreen': style += '\u001b[102m'; break;
          case 'brightyellow': style += '\u001b[103m'; break;
          case 'brightblue': style += '\u001b[104m'; break;
          case 'brightmagenta': style += '\u001b[105m'; break;
          case 'brightcyan': style += '\u001b[106m'; break;
          case 'brightwhite': style += '\u001b[107m'; break;
        }
      }
    }

    return style;
  }

  /**
   * Convert hex color to RGB values
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null;
  }

  /**
   * Convert RGB values to a color name or hex representation
   */
  private rgbToColorName(r: number, g: number, b: number): string {
    // Check for exact matches with standard colors first
    const colorMap: { [key: string]: string } = {
      '255,0,0': 'red',
      '0,255,0': 'green',
      '0,0,255': 'blue',
      '255,255,0': 'yellow',
      '255,0,255': 'magenta',
      '0,255,255': 'cyan',
      '255,255,255': 'white',
      '0,0,0': 'black',
      '128,128,128': 'gray',
      '0,128,0': 'green'  // CSS green is actually darker
    };

    const key = `${r},${g},${b}`;
    if (colorMap[key]) {
      return colorMap[key];
    }

    // For non-standard colors, return a hex representation
    const toHex = (n: number) => n.toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  /**
   * Convert 256-color ANSI index to color name
   */
  private ansi256ToColorName(index: number): string {
    // Standard 16 colors (0-15)
    if (index <= 15) {
      const standardColors = [
        'black', 'red', 'green', 'yellow',
        'blue', 'magenta', 'cyan', 'white',
        'brightblack', 'brightred', 'brightgreen', 'brightyellow',
        'brightblue', 'brightmagenta', 'brightcyan', 'brightwhite'
      ];
      return standardColors[index] || 'white';
    }

    // For 216-color cube (16-231) and grayscale (232-255),
    // we'll use a simplified approach and return hex values
    if (index >= 16 && index <= 231) {
      // 6x6x6 color cube
      const n = index - 16;
      const r = Math.floor(n / 36);
      const g = Math.floor((n % 36) / 6);
      const b = n % 6;

      const toRgb = (c: number) => c === 0 ? 0 : 55 + c * 40;
      return this.rgbToColorName(toRgb(r), toRgb(g), toRgb(b));
    }

    if (index >= 232 && index <= 255) {
      // Grayscale
      const gray = 8 + (index - 232) * 10;
      return this.rgbToColorName(gray, gray, gray);
    }

    return 'white'; // fallback
  }
}
