/**
 * Terminal Snapshotter for Testing - Using @xterm/headless for accurate terminal behavior
 *
 * This provides the most accurate terminal rendering by using the actual xterm.js
 * terminal emulator in headless mode, ensuring perfect compatibility with real terminals.
 */

import { Terminal } from '@xterm/headless';

export interface TerminalSnapshotterOptions {
  width?: number;
  height?: number;
}

export class TerminalSnapshotter {
  private terminal: Terminal;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private streamConsumptionPromise: Promise<void> | null = null;
  private width: number;
  private height: number;

  constructor(
    stream: ReadableStream<string>,
    options: TerminalSnapshotterOptions = {}
  ) {
    this.width = options.width ?? 80;
    this.height = options.height ?? 24;
    
    // Initialize xterm headless terminal
    this.terminal = new Terminal({
      cols: this.width,
      rows: this.height,
      allowProposedApi: true
    });

    // Start consuming the stream
    this.reader = stream.getReader();
    this.streamConsumptionPromise = this.consumeStreamInBackground();
  }

  /**
   * Consume stream in background
   */
  private async consumeStreamInBackground(): Promise<void> {
    if (!this.reader) return;

    try {
      while (this.reader) {
        const { done, value } = await this.reader.read();
        if (done) break;
        if (value) {
          this.terminal.write(value);
        }
      }
    } catch (error) {
      // Only throw if reader is still valid (not disposed)
      if (this.reader) {
        throw new Error(`TerminalSnapshotter stream error: ${error}`);
      }
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
    if (this.terminal) {
      this.terminal.dispose();
    }
  }

  /**
   * Get plain text snapshot of terminal buffer
   */
  async getSnapshot(): Promise<string> {
    // Wait for all streams to be consumed
    if (this.streamConsumptionPromise) {
      await this.streamConsumptionPromise;
    }
    
    const buffer = this.terminal.buffer.active;
    let result = '';
    
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line) {
        const lineText = line.translateToString(true).trimEnd();
        if (lineText || row === 0) { // Include first line even if empty
          result += lineText + '\n';
        }
      }
    }
    
    return result.trimEnd() + '\n';
  }

  /**
   * Get styled snapshot with ANSI escape sequences
   */
  async getStyledSnapshot(): Promise<string> {
    if (this.streamConsumptionPromise) {
      await this.streamConsumptionPromise;
    }
    
    const buffer = this.terminal.buffer.active;
    let result = '';
    
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (line) {
        // Get the line with styling information
        let lineText = '';
        let prevStyle = { fg: -1, bg: -1, bold: false, italic: false, underline: false };
        
        for (let col = 0; col < line.length; col++) {
          const cell = line.getCell(col);
          if (cell) {
            const char = cell.getChars();
            const fg = cell.getFgColor();
            const bg = cell.getBgColor();
            const bold = cell.isBold();
            const italic = cell.isItalic();
            const underline = cell.isUnderline();
            
            // Add ANSI codes for style changes
            if (fg !== prevStyle.fg || bg !== prevStyle.bg || 
                bold !== prevStyle.bold || italic !== prevStyle.italic || 
                underline !== prevStyle.underline) {
              
              lineText += '\x1b[0m'; // Reset
              
              if (fg !== -1) {
                if (fg < 256) {
                  lineText += `\x1b[38;5;${fg}m`;
                } else {
                  // RGB color
                  const r = (fg >> 16) & 0xff;
                  const g = (fg >> 8) & 0xff;
                  const b = fg & 0xff;
                  lineText += `\x1b[38;2;${r};${g};${b}m`;
                }
              }
              
              if (bg !== -1) {
                if (bg < 256) {
                  lineText += `\x1b[48;5;${bg}m`;
                } else {
                  // RGB color
                  const r = (bg >> 16) & 0xff;
                  const g = (bg >> 8) & 0xff;
                  const b = bg & 0xff;
                  lineText += `\x1b[48;2;${r};${g};${b}m`;
                }
              }
              
              if (bold) lineText += '\x1b[1m';
              if (italic) lineText += '\x1b[3m';
              if (underline) lineText += '\x1b[4m';
              
              prevStyle = { fg, bg, bold, italic, underline };
            }
            
            lineText += char || ' ';
          }
        }
        
        if (lineText.trim() || row === 0) {
          result += lineText.trimEnd() + '\x1b[0m\n';
        }
      }
    }
    
    return result;
  }
}