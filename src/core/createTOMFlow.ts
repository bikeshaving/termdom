/**
 * createTOMFlow - Create a flow-based TOM instance for inline terminal rendering
 * 
 * Unlike the full-screen TOM, this renders elements inline with the terminal flow,
 * perfect for CLI tools, test runners, progress bars, etc.
 */

import { TOMDocument } from './TOMDocument.js';
import { TOMElement } from './TOMElement.js';

export interface TOMFlowOptions {
  /** Maximum width (defaults to terminal width) */
  width?: number;
  
  /** Whether to clear the rendered area on destroy */
  clearOnDestroy?: boolean;
  
  /** Output stream */
  output?: NodeJS.WriteStream;
}

export class TOMFlowDocument extends TOMDocument {
  private flowOptions: TOMFlowOptions;
  private renderedHeight: number = 0;
  
  constructor(options: TOMFlowOptions = {}) {
    // Initialize with minimal height since we'll grow as needed
    super({
      width: options.width || process.stdout.columns || 80,
      height: 1, // Start with 1, will grow
      output: options.output || process.stdout
    });
    
    this.flowOptions = options;
  }
  
  /**
   * Render in flow mode - appends to terminal output instead of taking over screen
   */
  render(): void {
    // First, calculate the actual height needed
    const neededHeight = this.calculateNeededHeight(this.body);
    
    // Adjust our height if needed
    if (neededHeight !== this.terminalHeight) {
      this.terminalHeight = neededHeight;
      // Recreate renderer with new dimensions
      this.setupRenderer();
    }
    
    // Save cursor position
    this.output.write('\x1b7');
    
    // If we've rendered before, move up to overwrite
    if (this.renderedHeight > 0) {
      this.output.write(`\x1b[${this.renderedHeight}A`);
    }
    
    // Render normally
    super.render();
    
    // Track how much we rendered
    this.renderedHeight = neededHeight;
    
    // Restore cursor position
    this.output.write('\x1b8');
    
    // Move cursor to after our content
    this.output.write(`\x1b[${neededHeight}B`);
  }
  
  /**
   * Calculate the height needed for the content
   */
  private calculateNeededHeight(element: Element): number {
    if (!(element instanceof TOMElement)) return 0;
    
    // For now, use the bounds after layout
    // In a real implementation, this would be more sophisticated
    const bounds = element.bounds;
    let maxHeight = bounds.height;
    
    // Check all children
    for (const child of element.children) {
      const childHeight = this.calculateNeededHeight(child);
      maxHeight = Math.max(maxHeight, childHeight);
    }
    
    return maxHeight;
  }
  
  /**
   * Clean up - optionally clear the rendered area
   */
  destroy(): void {
    if (this.flowOptions.clearOnDestroy && this.renderedHeight > 0) {
      // Move up and clear lines
      for (let i = 0; i < this.renderedHeight; i++) {
        this.output.write('\x1b[A\x1b[2K'); // Move up and clear line
      }
    }
    
    super.destroy();
  }
}

/**
 * Create a flow-based TOM instance
 */
export function createTOMFlow(options?: TOMFlowOptions): TOMFlowDocument {
  return new TOMFlowDocument(options);
}