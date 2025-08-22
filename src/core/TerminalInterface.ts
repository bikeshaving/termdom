/**
 * TerminalInterface - Abstraction over terminal I/O for testing and real usage
 * 
 * Provides a consistent interface that works with:
 * - Real terminals (process.stdout/stdin)
 * - Bun's file abstractions  
 * - Mock terminals for testing
 */

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

export interface TerminalCapabilities {
  isTTY: boolean;
  hasColors: boolean;
  supportsUnicode: boolean;
}

export interface TerminalInterface {
  // Dimensions
  getDimensions(): TerminalDimensions;
  
  // Capabilities
  getCapabilities(): TerminalCapabilities;
  
  // Output
  write(data: string | Buffer): boolean;
  
  // Input (for interactive mode)
  setRawMode?(enabled: boolean): void;
  on?(event: string, listener: (...args: any[]) => void): void;
  once?(event: string, listener: (...args: any[]) => void): void;
  
  // Cleanup
  pause?(): void;
  resume?(): void;
}

/**
 * Real terminal implementation using process.stdout/stdin
 */
export class ProcessTerminal implements TerminalInterface {
  constructor(
    private stdout: NodeJS.WriteStream = process.stdout,
    private stdin: NodeJS.ReadStream = process.stdin
  ) {}
  
  getDimensions(): TerminalDimensions {
    return {
      columns: this.stdout.columns || 80,
      rows: this.stdout.rows || 24
    };
  }
  
  getCapabilities(): TerminalCapabilities {
    return {
      isTTY: this.stdout.isTTY || false,
      hasColors: this.stdout.hasColors ? this.stdout.hasColors() : false,
      supportsUnicode: process.env.LANG?.includes('UTF-8') || false
    };
  }
  
  write(data: string | Buffer): boolean {
    return this.stdout.write(data);
  }
  
  setRawMode(enabled: boolean): void {
    if (this.stdin.setRawMode) {
      this.stdin.setRawMode(enabled);
    }
  }
  
  on(event: string, listener: (...args: any[]) => void): void {
    this.stdin.on(event, listener);
  }
  
  once(event: string, listener: (...args: any[]) => void): void {
    this.stdin.once(event, listener);
  }
  
  pause(): void {
    this.stdin.pause();
  }
  
  resume(): void {
    this.stdin.resume();
  }
}

/**
 * Mock terminal for testing
 */
export class MockTerminal implements TerminalInterface {
  private outputBuffer: string[] = [];
  private inputQueue: string[] = [];
  private inputIndex = 0;
  private listeners = new Map<string, Function[]>();
  
  constructor(
    private dimensions: TerminalDimensions = { columns: 80, rows: 24 },
    private capabilities: TerminalCapabilities = { isTTY: true, hasColors: true, supportsUnicode: true }
  ) {}
  
  getDimensions(): TerminalDimensions {
    return { ...this.dimensions };
  }
  
  getCapabilities(): TerminalCapabilities {
    return { ...this.capabilities };
  }
  
  write(data: string | Buffer): boolean {
    const str = typeof data === 'string' ? data : data.toString();
    this.outputBuffer.push(str);
    return true;
  }
  
  // Testing helpers
  getOutput(): string {
    return this.outputBuffer.join('');
  }
  
  getOutputBuffer(): string[] {
    return [...this.outputBuffer];
  }
  
  clearOutput(): void {
    this.outputBuffer = [];
  }
  
  setDimensions(columns: number, rows: number): void {
    this.dimensions = { columns, rows };
    this.emit('resize');
  }
  
  // Input simulation
  simulateInput(data: string): void {
    this.emit('data', Buffer.from(data));
  }
  
  simulateKeypress(key: string, ctrl = false, alt = false, shift = false): void {
    let sequence = key;
    
    // Handle special keys
    if (key === 'up') sequence = '\x1b[A';
    else if (key === 'down') sequence = '\x1b[B';
    else if (key === 'right') sequence = '\x1b[C';
    else if (key === 'left') sequence = '\x1b[D';
    else if (key === 'enter') sequence = '\r';
    else if (key === 'escape') sequence = '\x1b';
    else if (key === 'backspace') sequence = '\x7f';
    else if (key === 'tab') sequence = '\t';
    else if (ctrl && key.length === 1) {
      sequence = String.fromCharCode(key.charCodeAt(0) - 96); // Ctrl+A = \x01
    }
    
    this.simulateInput(sequence);
  }
  
  // Event system
  on(event: string, listener: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }
  
  once(event: string, listener: (...args: any[]) => void): void {
    const onceWrapper = (...args: any[]) => {
      listener(...args);
      this.off(event, onceWrapper);
    };
    this.on(event, onceWrapper);
  }
  
  private off(event: string, listener: Function): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      const index = eventListeners.indexOf(listener);
      if (index > -1) {
        eventListeners.splice(index, 1);
      }
    }
  }
  
  private emit(event: string, ...args: any[]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      for (const listener of eventListeners) {
        listener(...args);
      }
    }
  }
  
  // Method to trigger events from tests
  triggerResize(): void {
    this.emit('resize');
  }
  
  // Stub methods for compatibility
  setRawMode(enabled: boolean): void {
    // Mock implementation - just track state
  }
  
  pause(): void {
    // Mock implementation
  }
  
  resume(): void {
    // Mock implementation
  }
}

/**
 * Bun file-based terminal (if we want to explore this)
 */
export class BunTerminal implements TerminalInterface {
  constructor(
    private dimensions: TerminalDimensions = { columns: 80, rows: 24 }
  ) {}
  
  getDimensions(): TerminalDimensions {
    return { ...this.dimensions };
  }
  
  getCapabilities(): TerminalCapabilities {
    return {
      isTTY: false, // Bun files aren't TTY
      hasColors: true, // Assume color support
      supportsUnicode: true
    };
  }
  
  write(data: string | Buffer): boolean {
    // Write to Bun.stdout if available
    if (Bun.stdout && Bun.stdout.write) {
      Bun.stdout.write(data);
      return true;
    }
    
    // Fallback to console
    const str = typeof data === 'string' ? data : data.toString();
    console.write(str);
    return true;
  }
}

/**
 * Factory function to create appropriate terminal interface
 */
export function createTerminalInterface(mock?: MockTerminal): TerminalInterface {
  if (mock) {
    return mock;
  }
  
  // Prefer process terminal for now since it has the features we need
  return new ProcessTerminal();
}