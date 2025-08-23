/**
 * Text Measurement - Yoga measurement functions for inline text elements
 * 
 * Implements text wrapping and measurement for elements with display: 'inline'
 * using Yoga's measurement API for proper text flow.
 */

import { TTYElement } from '../core/TTYElement.js';

export interface TextMeasureResult {
  width: number;
  height: number;
}

/**
 * Text measurement utilities for Yoga measurement functions
 */
export class TextMeasurement {
  /**
   * Measure text content for a given width constraint
   * This is the core measurement function called by Yoga
   */
  static measureText(
    element: TTYElement,
    width: number,
    widthMode: 'exactly' | 'at-most' | 'undefined',
    height: number,
    heightMode: 'exactly' | 'at-most' | 'undefined'
  ): TextMeasureResult {
    const content = element.textContent || '';
    if (!content) {
      return { width: 0, height: 0 };
    }

    const style = element.style;
    const wordWrap = style.wordWrap || 'normal';
    const whiteSpace = style.whiteSpace || 'normal';
    
    // Handle no-wrap cases
    if (wordWrap === 'nowrap' || whiteSpace === 'nowrap' || whiteSpace === 'pre') {
      const textWidth = this.getTextWidth(content);
      return { width: textWidth, height: 1 };
    }
    
    // For undefined width, measure natural text width
    if (widthMode === 'undefined') {
      const lines = content.split('\n');
      const maxWidth = Math.max(...lines.map(line => this.getTextWidth(line)));
      return { width: maxWidth, height: lines.length };
    }
    
    // Wrap text to fit within width constraint
    const wrappedLines = this.wrapText(content, width, style);
    const actualWidth = Math.max(...wrappedLines.map(line => this.getTextWidth(line)));
    
    return {
      width: Math.min(actualWidth, width),
      height: wrappedLines.length
    };
  }

  /**
   * Wrap text to fit within maxWidth
   */
  private static wrapText(content: string, maxWidth: number, style: any): string[] {
    if (maxWidth <= 0) return [''];
    
    const lines = content.split('\n');
    const wrappedLines: string[] = [];
    
    for (const line of lines) {
      if (this.getTextWidth(line) <= maxWidth) {
        wrappedLines.push(line);
      } else {
        wrappedLines.push(...this.wrapLine(line, maxWidth, style));
      }
    }
    
    return wrappedLines.length > 0 ? wrappedLines : [''];
  }

  /**
   * Wrap a single line to fit within maxWidth
   */
  private static wrapLine(line: string, maxWidth: number, style: any): string[] {
    const wordWrap = style.wordWrap || 'normal';
    
    if (wordWrap === 'break-word') {
      return this.wrapLineBreakWord(line, maxWidth);
    }
    
    // Default word wrapping (break at word boundaries)
    return this.wrapLineNormal(line, maxWidth);
  }

  /**
   * Normal word wrapping - break at word boundaries
   */
  private static wrapLineNormal(line: string, maxWidth: number): string[] {
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
   * Break-word wrapping - break anywhere if needed
   */
  private static wrapLineBreakWord(line: string, maxWidth: number): string[] {
    const chars = [...line]; // Handle Unicode properly
    const wrappedLines: string[] = [];
    let currentLine = '';

    for (const char of chars) {
      if (this.getTextWidth(currentLine + char) <= maxWidth) {
        currentLine += char;
      } else {
        if (currentLine) wrappedLines.push(currentLine);
        currentLine = char;
      }
    }

    if (currentLine) wrappedLines.push(currentLine);
    return wrappedLines.length > 0 ? wrappedLines : [''];
  }

  /**
   * Break a word that's longer than maxWidth
   */
  private static breakLongWord(word: string, maxWidth: number): string[] {
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
    return lines.length > 0 ? lines : [''];
  }

  /**
   * Get visual width of text using Bun's stringWidth
   */
  private static getTextWidth(text: string): number {
    return Bun.stringWidth(text);
  }

  /**
   * Create a Yoga measurement function for an element
   */
  static createMeasureFunction(element: TTYElement) {
    return (
      width: number,
      widthMode: 'exactly' | 'at-most' | 'undefined',
      height: number,
      heightMode: 'exactly' | 'at-most' | 'undefined'
    ): { width: number; height: number } => {
      return this.measureText(element, width, widthMode, height, heightMode);
    };
  }
}