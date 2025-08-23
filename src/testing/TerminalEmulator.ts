/**
 * Terminal Emulator for Snapshot Testing
 * 
 * Processes ANSI escape sequences and builds a static screen representation
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

export class TerminalEmulator {
  private screen: TerminalCell[][];
  private cursorX = 0;
  private cursorY = 0;
  private currentStyle: Partial<TerminalCell> = {};
  
  constructor(
    private width: number = 80,
    private height: number = 24
  ) {
    this.screen = this.createEmptyScreen();
  }

  /**
   * Process raw ANSI output from MockTTYRuntime and build screen grid
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
   * Generate static ANSI output that can be viewed with `cat`
   */
  generateStaticAnsi(): string {
    const lines: string[] = [];
    
    for (let y = 0; y < this.height; y++) {
      let line = '';
      let lastStyle = '';
      let hasNonSpaceContent = false;
      
      for (let x = 0; x < this.width; x++) {
        const cell = this.screen[y][x];
        
        // Track if line has actual content (not just styled spaces)
        if (cell.char !== ' ' || cell.fgColor || cell.bgColor || cell.bold || cell.italic || cell.underline) {
          if (cell.char !== ' ') hasNonSpaceContent = true;
        }
        
        // Generate ANSI codes for style changes
        const styleCode = this.getCellAnsiStyle(cell);
        if (styleCode !== lastStyle) {
          line += styleCode;
          lastStyle = styleCode;
        }
        
        line += cell.char;
      }
      
      // Reset styles at end of line
      if (lastStyle) {
        line += '\u001b[0m';
      }
      
      // Keep lines with ANSI styling or actual content
      if (line.includes('\u001b[') || hasNonSpaceContent) {
        lines.push(line);
      } else {
        // Pure spaces, trim
        lines.push(line.trimEnd());
      }
    }
    
    // Remove truly empty trailing lines
    while (lines.length > 0 && lines[lines.length - 1].length === 0) {
      lines.pop();
    }
    
    return lines.join('\n');
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
    
    for (const num of codes) {
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
        case 30: this.currentStyle.fgColor = 'black'; break;
        case 31: this.currentStyle.fgColor = 'red'; break;
        case 32: this.currentStyle.fgColor = 'green'; break;
        case 33: this.currentStyle.fgColor = 'yellow'; break;
        case 34: this.currentStyle.fgColor = 'blue'; break;
        case 35: this.currentStyle.fgColor = 'magenta'; break;
        case 36: this.currentStyle.fgColor = 'cyan'; break;
        case 37: this.currentStyle.fgColor = 'white'; break;
        case 40: this.currentStyle.bgColor = 'black'; break;
        case 41: this.currentStyle.bgColor = 'red'; break;
        case 42: this.currentStyle.bgColor = 'green'; break;
        case 43: this.currentStyle.bgColor = 'yellow'; break;
        case 44: this.currentStyle.bgColor = 'blue'; break;
        case 45: this.currentStyle.bgColor = 'magenta'; break;
        case 46: this.currentStyle.bgColor = 'cyan'; break;
        case 47: this.currentStyle.bgColor = 'white'; break;
      }
    }
  }

  private getCellAnsiStyle(cell: TerminalCell): string {
    let style = '';
    
    // Text styles
    if (cell.bold) style += '\u001b[1m';
    if (cell.italic) style += '\u001b[3m';
    if (cell.underline) style += '\u001b[4m';
    
    // Foreground colors
    switch (cell.fgColor) {
      case 'black': style += '\u001b[30m'; break;
      case 'red': style += '\u001b[31m'; break;
      case 'green': style += '\u001b[32m'; break;
      case 'yellow': style += '\u001b[33m'; break;
      case 'blue': style += '\u001b[34m'; break;
      case 'magenta': style += '\u001b[35m'; break;
      case 'cyan': style += '\u001b[36m'; break;
      case 'white': style += '\u001b[37m'; break;
    }
    
    // Background colors
    switch (cell.bgColor) {
      case 'black': style += '\u001b[40m'; break;
      case 'red': style += '\u001b[41m'; break;
      case 'green': style += '\u001b[42m'; break;
      case 'yellow': style += '\u001b[43m'; break;
      case 'blue': style += '\u001b[44m'; break;
      case 'magenta': style += '\u001b[45m'; break;
      case 'cyan': style += '\u001b[46m'; break;
      case 'white': style += '\u001b[47m'; break;
    }
    
    return style;
  }
}