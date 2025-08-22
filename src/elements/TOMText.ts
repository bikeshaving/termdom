/**
 * TOMText - Text element with formatting and alignment support
 * 
 * Handles text rendering with proper Unicode support, wrapping,
 * alignment, and terminal styling.
 */

import { TOMElement } from '../core/TOMElement.js';
import { ScreenBuffer } from '../rendering/ScreenBuffer.js';

/**
 * Text element for displaying styled text content
 */
export class TOMText extends TOMElement {
  constructor() {
    super();
    
    // Set default text styles
    this.style = {
      display: 'inline',
      minHeight: 1, // Text needs at least 1 cell to display
      ...this.style
    };
  }

  /**
   * Render text content with styling and alignment
   */
  renderSelf(buffer: ScreenBuffer): void {
    const bounds = this.bounds;
    const content = this.textContent || '';
    
    // Skip rendering if no content or size
    if (!content || bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    // Render background if specified
    if (this.style.backgroundColor) {
      buffer.fill(bounds, ' ', {
        bgColor: this.style.backgroundColor
      });
    }

    const contentArea = this.getContentArea();
    const textStyle = this.getTextStyle();
    const lines = this.prepareLines(content, contentArea.width);

    // Calculate vertical alignment
    const verticalOffset = this.calculateVerticalOffset(lines.length, contentArea.height);

    // Render each line
    for (let i = 0; i < Math.min(lines.length, contentArea.height); i++) {
      const line = lines[i];
      const y = contentArea.y + verticalOffset + i;
      
      if (line.length === 0 || y >= contentArea.y + contentArea.height) continue;

      // Apply text alignment
      const alignedLine = this.alignText(line, contentArea.width);
      const x = contentArea.x + alignedLine.offset;
      
      // Render the line
      buffer.put(x, y, alignedLine.text, textStyle);
    }
  }

  /**
   * Calculate vertical offset for alignment
   */
  private calculateVerticalOffset(lineCount: number, containerHeight: number): number {
    const availableSpace = containerHeight - lineCount;
    
    // For now, just center vertically if there's extra space
    return Math.max(0, Math.floor(availableSpace / 2));
  }

  /**
   * Prepare text lines with wrapping if needed
   */
  private prepareLines(content: string, maxWidth: number): string[] {
    const lines = content.split('\n');
    const wrappedLines: string[] = [];

    for (const line of lines) {
      if (this.shouldWrapText() && this.getTextWidth(line) > maxWidth) {
        wrappedLines.push(...this.wrapLine(line, maxWidth));
      } else {
        wrappedLines.push(line);
      }
    }

    return wrappedLines;
  }

  /**
   * Check if text should wrap
   */
  private shouldWrapText(): boolean {
    const overflow = this.style.overflow || this.style.overflowX;
    const whiteSpace = this.style.whiteSpace || 'normal';
    
    // Don't wrap if white-space prevents it
    if (whiteSpace === 'nowrap' || whiteSpace === 'pre') {
      return false;
    }
    
    // Don't wrap if overflow is set to hidden or scroll
    return overflow !== 'hidden' && overflow !== 'scroll';
  }

  /**
   * Wrap a single line to fit within maxWidth
   */
  private wrapLine(line: string, maxWidth: number): string[] {
    if (maxWidth <= 0) return [''];
    
    const words = line.split(' ');
    const wrappedLines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine + (currentLine ? ' ' : '') + word;
      
      if (this.getTextWidth(testLine) <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          wrappedLines.push(currentLine);
          currentLine = word;
        } else {
          // Word is longer than maxWidth, break it
          wrappedLines.push(...this.breakLongWord(word, maxWidth));
        }
      }
    }

    if (currentLine) {
      wrappedLines.push(currentLine);
    }

    return wrappedLines.length > 0 ? wrappedLines : [''];
  }

  /**
   * Break a word that's longer than maxWidth
   */
  private breakLongWord(word: string, maxWidth: number): string[] {
    const chars = [...word]; // Handle Unicode properly
    const lines: string[] = [];
    let currentLine = '';

    for (const char of chars) {
      if (this.getTextWidth(currentLine + char) <= maxWidth) {
        currentLine += char;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = char;
      }
    }

    if (currentLine) lines.push(currentLine);
    return lines;
  }

  /**
   * Get visual width of text using Bun's stringWidth
   */
  private getTextWidth(text: string): number {
    // Use Bun's stringWidth for accurate Unicode width calculation
    return Bun.stringWidth(text);
  }

  /**
   * Apply text alignment and return aligned text with offset
   */
  private alignText(text: string, containerWidth: number): { text: string; offset: number } {
    const textWidth = this.getTextWidth(text);
    const alignment = this.style.textAlign || 'left';
    
    // Truncate if text is too long
    if (textWidth > containerWidth) {
      const truncated = this.truncateText(text, containerWidth);
      return { text: truncated, offset: 0 };
    }

    let offset = 0;
    
    switch (alignment) {
      case 'center':
        offset = Math.floor((containerWidth - textWidth) / 2);
        break;
      case 'right':
        offset = containerWidth - textWidth;
        break;
      case 'left':
      default:
        offset = 0;
        break;
    }

    return { text, offset: Math.max(0, offset) };
  }

  /**
   * Truncate text to fit within maxWidth
   */
  private truncateText(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return '';
    if (maxWidth === 1) return '…';

    const chars = [...text];
    let result = '';
    let width = 0;

    for (const char of chars) {
      const charWidth = this.getTextWidth(char);
      
      if (width + charWidth + 1 > maxWidth) { // +1 for ellipsis
        result += '…';
        break;
      }
      
      result += char;
      width += charWidth;
    }

    return result;
  }

  /**
   * Calculate preferred size based on content
   */
  getPreferredSize(): { width: number; height: number } {
    const content = this.textContent || '';
    
    if (!content) {
      return { width: 0, height: 0 };
    }

    const lines = content.split('\n');
    const width = Math.max(...lines.map(line => this.getTextWidth(line)));
    const height = lines.length;

    return { width, height };
  }
}