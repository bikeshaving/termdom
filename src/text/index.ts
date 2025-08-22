/**
 * Text processing module for TOM
 * 
 * Provides text breaking algorithms for line wrapping and layout.
 */

export { TextBreaker, type BreakOptions, type BreakResult, type LineBreak, type InlineElement } from './TextBreaker.js';
export { GreedyTextBreaker } from './GreedyTextBreaker.js';