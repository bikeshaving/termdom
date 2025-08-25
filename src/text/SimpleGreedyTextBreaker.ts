/**
 * SimpleGreedyTextBreaker - Simplified greedy line breaking algorithm
 * 
 * Uses a word-based approach for cleaner implementation:
 * 1. Split text into words
 * 2. Fill lines word by word
 * 3. Handle inline elements as unbreakable blocks
 * 4. Force break long words if necessary
 */

import { TextBreaker, type BreakOptions, type BreakResult, type LineBreak, type InlineElement } from './TextBreaker.js';

export class SimpleGreedyTextBreaker extends TextBreaker {
  breakText(text: string, options: BreakOptions): BreakResult {
    const { maxWidth, breakWords = true, preserveWhitespace = false, inlineElements = [] } = options;
    
    if (!text && inlineElements.length === 0) {
      return {
        lines: [],
        totalHeight: 0,
        maxLineWidth: 0
      };
    }
    
    // Debug log for the flexDirection issue
    if (text.includes('flexDirection')) {
      console.log('DEBUG TextBreaker: Input text contains flexDirection');
      console.log('  maxWidth:', maxWidth);
    }
    
    // For now, ignore inline elements and focus on text breaking
    // This can be enhanced later
    const lines: LineBreak[] = [];
    
    // Split text into words, preserving spaces
    const words = this.splitIntoWords(text);
    
    if (text.includes('flexDirection')) {
      console.log('DEBUG TextBreaker: All words around flexDirection:');
      words.forEach((word, i) => {
        if (i >= Math.max(0, words.findIndex(w => w.text.includes('flexDirection')) - 2) &&
            i <= words.findIndex(w => w.text.includes('flexDirection')) + 2) {
          console.log(`  Word ${i}: "${word.text}" at index ${word.startIndex}`);
        }
      });
    }
    
    let currentLine = '';
    let currentLineWidth = 0;
    let currentLineStartIndex = 0;
    
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordWidth = this.getTextWidth(word.text);
      
      // Debug log for flexDirection issue
      if (text.includes('flexDirection') && word.text.includes('flex')) {
        console.log(`DEBUG: Processing word "${word.text}" at index ${word.startIndex}`);
        console.log(`  currentLine: "${currentLine}"`);
        console.log(`  currentLineWidth: ${currentLineWidth}, wordWidth: ${wordWidth}, maxWidth: ${maxWidth}`);
        console.log(`  would exceed: ${currentLineWidth > 0 && currentLineWidth + wordWidth > maxWidth}`);
      }
      
      // Check if adding this word would exceed the line width
      if (currentLineWidth > 0 && currentLineWidth + wordWidth > maxWidth) {
        // Debug log for line breaking
        if (text.includes('flexDirection') && word.text.includes('flex')) {
          console.log(`DEBUG: Breaking line before "${word.text}"`);
          console.log(`  finishing line: "${currentLine}"`);
          console.log(`  new line will start with: "${word.text}"`);
        }
        
        // Finish current line
        lines.push({
          text: currentLine,
          startIndex: currentLineStartIndex,
          endIndex: word.startIndex,
          width: currentLineWidth,
          inlineElements: [],
          badness: 0
        });
        
        // Start new line
        currentLine = '';
        currentLineWidth = 0;
        currentLineStartIndex = word.startIndex;
      }
      
      // Handle words that are too long for a single line
      if (wordWidth > maxWidth && breakWords) {
        // If we have content on the current line, flush it first
        if (currentLine) {
          lines.push({
            text: currentLine,
            startIndex: currentLineStartIndex,
            endIndex: word.startIndex,
            width: currentLineWidth,
            inlineElements: [],
            badness: 0
          });
          currentLine = '';
          currentLineWidth = 0;
          currentLineStartIndex = word.startIndex;
        }
        
        // Break the long word
        const brokenWords = this.breakLongWord(word.text, maxWidth);
        for (let j = 0; j < brokenWords.length; j++) {
          const piece = brokenWords[j];
          const pieceWidth = this.getTextWidth(piece);
          
          if (j < brokenWords.length - 1) {
            // Not the last piece, make it a full line
            lines.push({
              text: piece,
              startIndex: currentLineStartIndex,
              endIndex: currentLineStartIndex + piece.length,
              width: pieceWidth,
              inlineElements: [],
              badness: 0
            });
            currentLineStartIndex += piece.length;
          } else {
            // Last piece, continue building the line
            currentLine = piece;
            currentLineWidth = pieceWidth;
          }
        }
      } else {
        // Add word to current line
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
        inlineElements: [],
        badness: 0
      });
    }
    
    return {
      lines,
      totalHeight: lines.length,
      maxLineWidth: Math.max(...lines.map(line => line.width), 0)
    };
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
}