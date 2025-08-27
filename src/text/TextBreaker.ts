/**
 * TextBreaker - Direct text line breaking implementation
 * 
 * Simple greedy line breaking algorithm that:
 * 1. Fills each line as much as possible
 * 2. Breaks at word boundaries when possible
 * 3. Force breaks mid-word if necessary
 * 4. Handles inline elements as fixed-width content
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
}

/**
 * TextBreaker - Direct implementation of greedy text breaking
 */
export class TextBreaker {
  breakText(text: string, options: BreakOptions): BreakResult {
    const { maxWidth, breakWords = true, preserveWhitespace = false, inlineElements = [] } = options;
    
    if (!text && inlineElements.length === 0) {
      return {
        lines: [],
        totalHeight: 0,
        maxLineWidth: 0
      };
    }
    
    // Handle inline elements if present - use complex mixed content approach
    if (inlineElements.length > 0) {
      return this.breakTextWithInlineElements(text, options);
    }
    
    // For simple text without inline elements, use word-based approach
    const lines: LineBreak[] = [];
    const words = this.splitIntoWords(text);
    
    let currentLine = '';
    let currentLineWidth = 0;
    let currentLineStartIndex = 0;
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordWidth = this.getTextWidth(word.text);
      
      // Check if adding this word would exceed the line width
      if (currentLineWidth > 0 && currentLineWidth + wordWidth > maxWidth) {
        // Finish current line
        lines.push({
          text: currentLine,
          startIndex: currentLineStartIndex,
          endIndex: word.startIndex,
          width: currentLineWidth,
          inlineElements: []
        });
        
        // Start new line
        currentLine = '';
        currentLineWidth = 0;
        currentLineStartIndex = word.startIndex;
      }
      
      // Check if word is too long for any line
      if (wordWidth > maxWidth && breakWords && !/\s/.test(word.text)) {
        // Break the long word into pieces
        const pieces = this.breakLongWord(word.text, maxWidth);
        for (let j = 0; j < pieces.length; j++) {
          const piece = pieces[j];
          const pieceWidth = this.getTextWidth(piece);
          
          if (currentLineWidth + pieceWidth > maxWidth && currentLine) {
            // Finish current line first
            lines.push({
              text: currentLine,
              startIndex: currentLineStartIndex,
              endIndex: word.startIndex,
              width: currentLineWidth,
              inlineElements: []
            });
            
            currentLine = piece;
            currentLineWidth = pieceWidth;
            currentLineStartIndex = word.startIndex;
          } else {
            currentLine += piece;
            currentLineWidth += pieceWidth;
          }
        }
      } else {
        // Add word to current line (even if it exceeds width when breakWords is false)
        currentLine += word.text;
        currentLineWidth += wordWidth;
      }
    }
    
    // Add final line if there's remaining content
    if (currentLine) {
      lines.push({
        text: currentLine,
        startIndex: currentLineStartIndex,
        endIndex: text.length,
        width: currentLineWidth,
        inlineElements: []
      });
    }
    
    return {
      lines,
      totalHeight: lines.length,
      maxLineWidth: Math.max(...lines.map(line => line.width), 0)
    };
  }
  
  /**
   * Get visual width of text (handles Unicode, emojis, etc.)
   */
  private getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }
  
  /**
   * Check if character is breakable whitespace
   */
  private isBreakableSpace(char: string): boolean {
    return /\s/.test(char);
  }
  
  /**
   * Split text into words, preserving spaces
   */
  private splitIntoWords(text: string): Array<{text: string, startIndex: number}> {
    const words: Array<{text: string, startIndex: number}> = [];
    let currentWord = '';
    let wordStartIndex = 0;
    let inWord = false;
    
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const isSpace = /\s/.test(char);
      
      if (!inWord && !isSpace) {
        // Starting a new word
        inWord = true;
        wordStartIndex = i;
        currentWord = char;
      } else if (inWord && isSpace) {
        // Ending a word
        words.push({ text: currentWord, startIndex: wordStartIndex });
        inWord = false;
        currentWord = '';
        
        // Add the space as a separate "word"
        words.push({ text: char, startIndex: i });
      } else if (inWord) {
        // Continuing a word
        currentWord += char;
      } else {
        // Multiple spaces
        words.push({ text: char, startIndex: i });
      }
    }
    
    // Add final word if exists
    if (currentWord) {
      words.push({ text: currentWord, startIndex: wordStartIndex });
    }
    
    return words;
  }
  
  /**
   * Break a long word into pieces that fit the max width
   */
  private breakLongWord(word: string, maxWidth: number): string[] {
    const pieces: string[] = [];
    let remaining = word;
    
    while (remaining) {
      // Find the longest prefix that fits
      let cutPoint = remaining.length;
      while (cutPoint > 0 && this.getTextWidth(remaining.slice(0, cutPoint)) > maxWidth) {
        cutPoint--;
      }
      
      if (cutPoint === 0) {
        // Even a single character doesn't fit, force it
        cutPoint = 1;
      }
      
      pieces.push(remaining.slice(0, cutPoint));
      remaining = remaining.slice(cutPoint);
    }
    
    return pieces;
  }
  
  /**
   * Handle text breaking with inline elements (complex case)
   */
  private breakTextWithInlineElements(text: string, options: BreakOptions): BreakResult {
    const { maxWidth, breakWords = true, preserveWhitespace = false, inlineElements = [] } = options;
    
    // Create a mixed content array with text and inline elements
    const content = this.createMixedContent(text, inlineElements);
    
    const lines: LineBreak[] = [];
    let currentLineContent: MixedContentItem[] = [];
    let currentLineWidth = 0;
    let lineStartIndex = 0;
    
    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      const itemWidth = this.getItemWidth(item);
      
      // Check if adding this item would exceed line width
      if (currentLineWidth + itemWidth > maxWidth && currentLineContent.length > 0) {
        // Try to break at a better position
        const breakPoint = this.findBestBreakPoint(currentLineContent, maxWidth, breakWords);
        
        if (breakPoint !== null) {
          // Break at the found position
          const lineContent = currentLineContent.slice(0, breakPoint.itemIndex);
          const lineText = this.extractTextFromContent(lineContent, breakPoint.charIndex);
          
          lines.push(this.createLineBreak(lineText, lineStartIndex, lineContent));
          
          // Continue with remaining content + current item
          const remainingContent = this.getRemainingContent(currentLineContent, breakPoint);
          currentLineContent = [...remainingContent, item]; // Add the current item that caused the overflow
          
          currentLineWidth = this.calculateContentWidth(currentLineContent);
          lineStartIndex = breakPoint.textIndex;
          
          // Continue to next iteration - we've already processed the current item
          continue;
        } else {
          // No good break point found, force break
          lines.push(this.createLineBreak(
            this.extractTextFromContent(currentLineContent),
            lineStartIndex,
            currentLineContent
          ));
          
          currentLineContent = [];
          currentLineWidth = 0;
          lineStartIndex = item.type === 'text' ? item.startIndex : item.startIndex;
        }
      }
      
      // Add current item to line
      currentLineContent.push(item);
      currentLineWidth += itemWidth;
    }
    
    // Add final line if there's remaining content
    if (currentLineContent.length > 0) {
      lines.push(this.createLineBreak(
        this.extractTextFromContent(currentLineContent),
        lineStartIndex,
        currentLineContent
      ));
    }
    
    return {
      lines,
      totalHeight: lines.length,
      maxLineWidth: Math.max(...lines.map(line => line.width), 0)
    };
  }
  
  /**
   * Create mixed content array from text and inline elements
   */
  private createMixedContent(text: string, inlineElements: InlineElement[]): MixedContentItem[] {
    const content: MixedContentItem[] = [];
    let textIndex = 0;
    
    // Sort inline elements by position
    const sortedElements = [...inlineElements].sort((a, b) => a.position - b.position);
    
    for (const element of sortedElements) {
      // Add text before this element
      if (textIndex < element.position) {
        const textChunk = text.slice(textIndex, element.position);
        
        // Split text into characters for fine-grained control
        for (let i = 0; i < textChunk.length; i++) {
          content.push({
            type: 'text',
            char: textChunk[i],
            startIndex: textIndex + i,
            endIndex: textIndex + i + 1
          });
        }
      }
      
      // Add the inline element
      content.push({
        type: 'element',
        element,
        startIndex: element.position,
        endIndex: element.position
      });
      
      textIndex = element.position;
    }
    
    // Add remaining text
    if (textIndex < text.length) {
      const remainingText = text.slice(textIndex);
      for (let i = 0; i < remainingText.length; i++) {
        content.push({
          type: 'text',
          char: remainingText[i],
          startIndex: textIndex + i,
          endIndex: textIndex + i + 1
        });
      }
    }
    
    return content;
  }
  
  /**
   * Get width of a content item
   */
  private getItemWidth(item: MixedContentItem): number {
    if (item.type === 'text' && item.char) {
      return this.getTextWidth(item.char);
    } else if (item.type === 'element' && item.element) {
      return item.element.width;
    }
    return 0;
  }
  
  /**
   * Find the best break point in current line content
   */
  private findBestBreakPoint(content: MixedContentItem[], maxWidth: number, breakWords: boolean): BreakPoint | null {
    let bestBreakPoint: BreakPoint | null = null;
    let currentWidth = 0;
    
    for (let i = 0; i < content.length; i++) {
      const item = content[i];
      const itemWidth = this.getItemWidth(item);
      
      if (currentWidth + itemWidth > maxWidth) {
        break;
      }
      
      // Check if this is a good break point
      if (this.isGoodBreakPoint(content, i)) {
        bestBreakPoint = {
          itemIndex: i + 1,
          charIndex: item.type === 'text' ? item.endIndex : item.startIndex,
          textIndex: item.endIndex
        };
      }
      
      currentWidth += itemWidth;
    }
    
    // If no good break point found, try different strategies
    if (!bestBreakPoint && content.length > 0) {
      // First, try to find the last space that fits
      let lastSpaceIndex = -1;
      let fitWidth = 0;
      
      for (let i = 0; i < content.length; i++) {
        const item = content[i];
        const itemWidth = this.getItemWidth(item);
        
        if (fitWidth + itemWidth > maxWidth) {
          // We've exceeded the width
          if (lastSpaceIndex > 0) {
            // Use the last space we found
            const spaceItem = content[lastSpaceIndex];
            bestBreakPoint = {
              itemIndex: lastSpaceIndex + 1,
              charIndex: spaceItem.type === 'text' ? spaceItem.endIndex : spaceItem.startIndex,
              textIndex: spaceItem.endIndex
            };
          } else if (breakWords && i > 0) {
            // No space found, break at the last character that fits
            const item = content[i - 1];
            bestBreakPoint = {
              itemIndex: i,
              charIndex: item.type === 'text' ? item.endIndex : item.startIndex,
              textIndex: item.endIndex
            };
          }
          break;
        }
        
        // Track last space position
        if (item.type === 'text' && item.char && this.isBreakableSpace(item.char)) {
          lastSpaceIndex = i;
        }
        
        fitWidth += itemWidth;
      }
    }
    
    return bestBreakPoint;
  }
  
  /**
   * Check if a position is a good break point
   */
  private isGoodBreakPoint(content: MixedContentItem[], index: number): boolean {
    if (index >= content.length - 1) return true;
    
    const currentItem = content[index];
    const nextItem = content[index + 1];
    
    // Can always break after inline elements
    if (currentItem.type === 'element') {
      return true;
    }
    
    // For text, check if it's a word boundary (space followed by non-space)
    if (currentItem.type === 'text' && currentItem.char) {
      // Break after spaces
      if (this.isBreakableSpace(currentItem.char)) {
        return true;
      }
      
      // Also check if next item is an element (break before elements)
      if (nextItem?.type === 'element') {
        return true;
      }
    }
    
    return false;
  }
  
  /**
   * Extract text content from mixed content array
   */
  private extractTextFromContent(content: MixedContentItem[], maxCharIndex?: number): string {
    let text = '';
    
    for (const item of content) {
      if (item.type === 'text') {
        if (maxCharIndex === undefined || item.startIndex < maxCharIndex) {
          text += item.char;
        }
      }
    }
    
    return text;
  }
  
  /**
   * Get remaining content after a break point
   */
  private getRemainingContent(content: MixedContentItem[], breakPoint: BreakPoint): MixedContentItem[] {
    return content.slice(breakPoint.itemIndex);
  }
  
  /**
   * Calculate total width of content array
   */
  private calculateContentWidth(content: MixedContentItem[]): number {
    return content.reduce((width, item) => width + this.getItemWidth(item), 0);
  }
  
  /**
   * Create a LineBreak object from content
   */
  private createLineBreak(text: string, startIndex: number, content: MixedContentItem[]): LineBreak {
    const inlineElements = content
      .filter(item => item.type === 'element')
      .map(item => (item as MixedElementItem).element);
    
    return {
      text,
      startIndex,
      endIndex: startIndex + text.length,
      width: this.getTextWidth(text) + inlineElements.reduce((w, el) => w + el.width, 0),
      inlineElements
    };
  }
}

// Helper interfaces for mixed content processing
interface MixedContentItem {
  type: 'text' | 'element';
  startIndex: number;
  endIndex: number;
  char?: string; // For text items
  element?: InlineElement; // For element items
}

interface MixedElementItem extends MixedContentItem {
  type: 'element';
  element: InlineElement;
}

interface BreakPoint {
  itemIndex: number;
  charIndex: number;
  textIndex: number;
}