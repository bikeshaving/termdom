/**
 * Terminal Snapshotter for Testing - Using @xterm/headless for accurate terminal behavior
 *
 * This provides the most accurate terminal rendering by using the actual xterm.js
 * terminal emulator in headless mode, ensuring perfect compatibility with real terminals.
 */

import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';

export interface TerminalSnapshotterOptions {
  width?: number;
  height?: number;
}

export class TerminalSnapshotter {
  private terminal: Terminal;
  private serializeAddon: SerializeAddon;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private streamConsumptionPromise: Promise<void> | null = null;
  private width: number;
  private height: number;
  
  /**
   * Create a snapshotter from ANSI strings
   */
  static fromAnsi(ansiStrings: string[], options: TerminalSnapshotterOptions = {}): TerminalSnapshotter {
    const stream = new ReadableStream<string>({
      start(controller) {
        for (const ansi of ansiStrings) {
          controller.enqueue(ansi);
        }
        controller.close();
      }
    });
    return new TerminalSnapshotter(stream, options);
  }

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
    
    // Add serialize addon for getting terminal content
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);

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
          // terminal.write uses callback API
          await new Promise<void>((resolve) => {
            this.terminal.write(value, resolve);
          });
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
    
    // Use serialize addon to get the content
    const serialized = this.serializeAddon.serialize({
      excludeAltBuffer: true,
      excludeModes: true,
      onlySelection: false
    });
    
    // Parse ANSI to get plain text
    // Remove all ANSI escape sequences (including cursor movements and other controls)
    const plainText = serialized
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') // Remove CSI sequences
      .replace(/\x1b[PX^_].*?\x1b\\/g, '')   // Remove DCS/SOS/PM/APC sequences
      .replace(/\x1b\][^\x07]*\x07/g, '')    // Remove OSC sequences
      .replace(/\x1b[>=\[?]?[0-9;]*[A-Za-z]/g, '') // Remove other escape sequences
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, ''); // Remove control characters except \t and \n
    
    // Handle empty result
    if (!plainText.trim()) {
      return '\n';
    }
    
    // Split into lines and preserve spacing
    const lines = plainText.split('\n');
    
    // Find last non-empty line
    let lastNonEmpty = lines.length - 1;
    while (lastNonEmpty > 0 && lines[lastNonEmpty].trim() === '') {
      lastNonEmpty--;
    }
    
    // Return up to last non-empty line
    return lines.slice(0, lastNonEmpty + 1).join('\n') + '\n';
  }

  /**
   * Get styled snapshot with ANSI escape sequences
   */
  async getStyledSnapshot(): Promise<string> {
    if (this.streamConsumptionPromise) {
      await this.streamConsumptionPromise;
    }
    
    // Use serialize addon to get the content with styles
    return this.serializeAddon.serialize({
      excludeAltBuffer: true,
      excludeModes: true,
      onlySelection: false
    });
  }
}