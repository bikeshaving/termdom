import type { CSSStyleDeclaration } from '../dom.js';

/**
 * Helper function to set multiple CSS properties at once
 * Converts camelCase to kebab-case for CSS property names
 */
export function setStyles(element: { style: CSSStyleDeclaration }, styles: Record<string, any>): void {
  for (const [property, value] of Object.entries(styles)) {
    // Convert camelCase to kebab-case
    const cssProperty = property.replace(/([A-Z])/g, '-$1').toLowerCase();
    element.style.setProperty(cssProperty, String(value));
  }
}

/**
 * Helper to apply TTY-specific styles that may use number values
 * Handles unit conversion for padding, margin, etc.
 */
export function applyTTYStyles(element: { style: CSSStyleDeclaration }, styles: Record<string, any>): void {
  for (const [property, value] of Object.entries(styles)) {
    const cssProperty = property.replace(/([A-Z])/g, '-$1').toLowerCase();
    
    // Handle numeric values that need units
    let cssValue: string;
    if (typeof value === 'number' && ['padding', 'margin', 'border', 'width', 'height'].includes(property)) {
      cssValue = `${value}ch`; // Use character units for terminal
    } else if (Array.isArray(value)) {
      // Handle array values for padding/margin
      cssValue = value.map(v => `${v}ch`).join(' ');
    } else {
      cssValue = String(value);
    }
    
    element.style.setProperty(cssProperty, cssValue);
  }
}