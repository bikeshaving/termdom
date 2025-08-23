/**
 * GreedyTextBreaker - Simple greedy line breaking algorithm
 * 
 * Uses a greedy approach similar to terminal-kit:
 * 1. Fill each line as much as possible
 * 2. Break at word boundaries when possible
 * 3. Force break mid-word if necessary
 * 4. Handle inline elements by treating them as fixed-width content
 */

import { TextBreaker, type BreakOptions, type BreakResult, type LineBreak, type InlineElement } from './TextBreaker.js';

export class GreedyTextBreaker extends TextBreaker {
  breakText(text: string, options: BreakOptions): BreakResult {
    const { maxWidth, breakWords = true, preserveWhitespace = false, inlineElements = [] } = options;
    
    if (!text && inlineElements.length === 0) {
      return {
        lines: [],
        totalHeight: 0,
        maxLineWidth: 0
      };
    }
    
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
          
          // Continue with remaining content
          currentLineContent = this.getRemainingContent(currentLineContent, breakPoint);
          currentLineWidth = this.calculateContentWidth(currentLineContent);
          lineStartIndex = breakPoint.textIndex;
          
          // Don't increment i, we need to process the current item again
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
      inlineElements,
      badness: 0 // Greedy algorithm doesn't optimize for badness
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

interface MixedTextItem extends MixedContentItem {
  type: 'text';
  char: string;
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