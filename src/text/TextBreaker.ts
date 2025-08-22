/**
 * TextBreaker - Abstract interface for line breaking algorithms
 * 
 * Provides a pluggable architecture for different text breaking strategies,
 * from simple greedy wrapping to sophisticated algorithms like Knuth-Plass.
 */

export interface BreakOptions {
  /** Maximum width for each line */
  maxWidth: number;
  
  /** Whether to break words if they exceed line width */
  breakWords?: boolean;
  
  /** Preserve whitespace and don't collapse spaces */
  preserveWhitespace?: boolean;
  
  /** Handle inline elements (for mixed text + element content) */
  inlineElements?: InlineElement[];
}

export interface InlineElement {
  /** Position in the text where this element appears */
  position: number;
  
  /** Width the element occupies */
  width: number;
  
  /** Height the element occupies */
  height: number;
  
  /** Whether the element can be broken across lines */
  breakable: boolean;
  
  /** The actual element reference for positioning */
  element: any;
}

export interface BreakResult {
  /** Array of line content */
  lines: LineBreak[];
  
  /** Total height required for all lines */
  totalHeight: number;
  
  /** Maximum width used by any line */
  maxLineWidth: number;
}

export interface LineBreak {
  /** Text content of the line */
  text: string;
  
  /** Start position in original text */
  startIndex: number;
  
  /** End position in original text */
  endIndex: number;
  
  /** Visual width of the line */
  width: number;
  
  /** Inline elements that appear on this line */
  inlineElements: InlineElement[];
  
  /** Quality score for this break (lower = better, for optimization algorithms) */
  badness?: number;
}

/**
 * Abstract base class for text breaking algorithms
 */
export abstract class TextBreaker {
  /**
   * Break text into lines according to the algorithm's strategy
   */
  abstract breakText(text: string, options: BreakOptions): BreakResult;
  
  /**
   * Get visual width of text (handles Unicode, emojis, etc.)
   */
  protected getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }
  
  /**
   * Check if character is breakable whitespace
   */
  protected isBreakableSpace(char: string): boolean {
    return /\s/.test(char);
  }
  
  /**
   * Check if character should not appear at start of line
   */
  protected isForbiddenAtLineStart(char: string): boolean {
    // Common punctuation that shouldn't start a line
    return '!?:;,.)]}»'.includes(char);
  }
  
  /**
   * Check if character should not appear at end of line  
   */
  protected isForbiddenAtLineEnd(char: string): boolean {
    // Opening punctuation that shouldn't end a line
    return '([{«'.includes(char);
  }
  
  /**
   * Find word boundaries in text
   */
  protected findWordBoundaries(text: string): number[] {
    const boundaries: number[] = [0];
    
    for (let i = 1; i < text.length; i++) {
      if (this.isBreakableSpace(text[i-1]) && !this.isBreakableSpace(text[i])) {
        boundaries.push(i);
      }
    }
    
    boundaries.push(text.length);
    return boundaries;
  }
  
  /**
   * Calculate badness score for a line break (for optimization algorithms)
   */
  protected calculateBadness(lineWidth: number, maxWidth: number, isLastLine: boolean = false): number {
    if (lineWidth > maxWidth) {
      // Overfull lines are heavily penalized
      return 10000 + (lineWidth - maxWidth) * 100;
    }
    
    if (isLastLine) {
      // Last lines can be short without penalty
      return 0;
    }
    
    // Penalize lines that are too short (creates ragged right edge)
    const ratio = lineWidth / maxWidth;
    if (ratio < 0.6) {
      return Math.pow((0.6 - ratio) * 100, 2);
    }
    
    return 0;
  }
}