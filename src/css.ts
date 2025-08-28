/**
 * Terminal CSS System
 * 
 * This module provides CSS property resolution and classification specifically designed for terminal UIs.
 * 
 * WHY WE DON'T SUPPORT STYLESHEETS/SELECTORS:
 * 1. JSDOM's cascade implementation is fundamentally broken:
 *    - No CSS specificity calculation (uses source order only)  
 *    - No proper !important handling
 *    - Incomplete inheritance support
 * 2. Terminal UIs are typically built programmatically with inline styles
 * 3. Avoiding cascade complexity makes the system more predictable and debuggable
 * 
 * WHY WE DON'T USE getComputedStyle():
 * 1. Real browsers resolve units to pixels ("10ch" → "80px") - we want semantic units
 * 2. JSDOM's getComputedStyle() has broken cascade resolution (see above)
 * 3. We need predictable behavior across environments
 * 
 * WHAT THIS MODULE PROVIDES:
 * - Property classification (layout vs visual vs unsupported)
 * - Inline style resolution with proper inheritance
 * - CSS keyword handling (inherit, initial, unset) 
 * - Preservation of semantic units (ch, em, %, etc.)
 * - Terminal-appropriate default values per element type
 */

// ============================================================================
// PROPERTY CLASSIFICATION
// ============================================================================

/**
 * Layout properties that affect element positioning, sizing, or text flow.
 * These properties CANNOT use CSS keywords (inherit, initial, unset) to keep
 * layout invalidation simple and predictable.
 * 
 * When these properties change, only the specific element needs re-layout.
 */
export const LAYOUT_PROPERTIES = new Set([
  // Box dimensions
  'width',
  'height', 
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  
  // Spacing
  'margin',
  'margin-top',
  'margin-right', 
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom', 
  'padding-left',
  
  // Borders (affect terminal cell layout through box-drawing characters)
  'border',
  'border-width',
  'border-style',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width', 
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  
  // Display and positioning
  'display',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'overflow',
  'overflow-x',
  'overflow-y',
  
  // Flexbox layout
  'flex-direction',
  'flex-wrap', 
  'justify-content',
  'align-items',
  'align-content',
  'flex',
  'flex-grow',
  'flex-shrink', 
  'flex-basis',
  'align-self',
  'order',
  
  // Text layout properties that affect positioning/wrapping
  'text-align',
  'white-space',
]);

/**
 * Visual properties that affect appearance but not layout.
 * These properties CAN use CSS keywords and inherit normally.
 * 
 * When these properties change, only the rendering of the specific element
 * needs to be updated (no layout recalculation needed).
 */
export const VISUAL_PROPERTIES = new Set([
  // Text and background colors
  'color',
  'background-color',
  'background', // shorthand
  
  // Border colors (border width/style affect layout, but color is purely visual)
  'border-color',
  'border-top-color',
  'border-right-color', 
  'border-bottom-color',
  'border-left-color',
]);

/**
 * All supported CSS properties in Terminal DOM.
 * Any property not in this set is ignored entirely.
 */
export const SUPPORTED_PROPERTIES = new Set([
  ...LAYOUT_PROPERTIES,
  ...VISUAL_PROPERTIES,
]);

// ============================================================================
// INHERITANCE CLASSIFICATION  
// ============================================================================

/**
 * CSS properties that inherit from parent by default
 * Based on CSS spec: https://www.w3.org/TR/CSS21/propidx.html
 */
const INHERITED_PROPERTIES = new Set([
  'color',
  'font-family',
  'font-size', 
  'font-style',
  'font-variant',
  'font-weight',
  'line-height',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-transform',
  'white-space',
  'word-spacing',
  'letter-spacing',
  'visibility',
  'cursor',
  'quotes',
  'list-style',
  'list-style-image',
  'list-style-position', 
  'list-style-type',
]);

// ============================================================================
// DEFAULT VALUES
// ============================================================================

/**
 * CSS specification defaults for properties
 * These apply when no other value is found
 */
const CSS_SPEC_DEFAULTS: Record<string, string> = {
  'display': 'inline',
  'margin': '0',
  'margin-top': '0',
  'margin-right': '0', 
  'margin-bottom': '0',
  'margin-left': '0',
  'padding': '0',
  'padding-top': '0',
  'padding-right': '0',
  'padding-bottom': '0', 
  'padding-left': '0',
  'border-width': '0',
  'background-color': 'transparent',
  'color': '#000000',
  'font-size': '1rem',
  'font-weight': 'normal',
  'font-style': 'normal',
  'text-decoration': 'none',
  'white-space': 'normal',
  'overflow': 'visible',
  'position': 'static',
  'width': 'auto',
  'height': 'auto',
};

/**
 * Terminal-specific defaults per element type
 * These override CSS spec defaults to be appropriate for terminal UIs
 */
const TERMINAL_ELEMENT_DEFAULTS: Record<string, Record<string, string>> = {
  // All elements get zero margins/padding for space efficiency
  '*': {
    'margin': '0',
    'padding': '0',
  },
  
  // Metadata elements - never rendered in terminal
  'head': { 'display': 'none' },
  'style': { 'display': 'none' },
  'script': { 'display': 'none' },
  'meta': { 'display': 'none' },
  'title': { 'display': 'none' },
  'link': { 'display': 'none' },
  
  // Block elements  
  'html': { 'display': 'block' },
  'body': { 'display': 'block' },
  'div': { 'display': 'block' },
  'section': { 'display': 'block' },
  'article': { 'display': 'block' },
  'aside': { 'display': 'block' },
  'header': { 'display': 'block' },
  'footer': { 'display': 'block' },
  'main': { 'display': 'block' },
  'nav': { 'display': 'block' },
  'h1': { 'display': 'block' },
  'h2': { 'display': 'block' },
  'h3': { 'display': 'block' },
  'h4': { 'display': 'block' },
  'h5': { 'display': 'block' },
  'h6': { 'display': 'block' },
  'p': { 'display': 'block' },
  'blockquote': { 'display': 'block' },
  'pre': { 'display': 'block', 'white-space': 'pre' },
  'ul': { 'display': 'block', 'padding-left': '2ch' },
  'ol': { 'display': 'block', 'padding-left': '2ch' },
  'li': { 'display': 'block' },
  'dl': { 'display': 'block' },
  'dt': { 'display': 'block' },
  'dd': { 'display': 'block' },
  'form': { 'display': 'block' },
  'fieldset': { 'display': 'block' },
  'figure': { 'display': 'block' },
  'figcaption': { 'display': 'block' },
  'hr': { 'display': 'block', 'border-top': '1px solid' },
  
  // Inline elements
  'span': { 'display': 'inline' },
  'a': { 'display': 'inline' },
  'em': { 'display': 'inline', 'font-style': 'italic' },
  'strong': { 'display': 'inline', 'font-weight': 'bold' },
  'code': { 'display': 'inline', 'background-color': 'rgba(0, 0, 0, 0.1)' },
  'kbd': { 'display': 'inline' },
  'samp': { 'display': 'inline' },
  'var': { 'display': 'inline', 'font-style': 'italic' },
  'b': { 'display': 'inline', 'font-weight': 'bold' },
  'i': { 'display': 'inline', 'font-style': 'italic' },
  'u': { 'display': 'inline', 'text-decoration': 'underline' },
  's': { 'display': 'inline', 'text-decoration': 'line-through' },
  'sub': { 'display': 'inline' },
  'sup': { 'display': 'inline' },
  'small': { 'display': 'inline' },
  'abbr': { 'display': 'inline' },
  'cite': { 'display': 'inline', 'font-style': 'italic' },
  'dfn': { 'display': 'inline', 'font-style': 'italic' },
  'mark': { 'display': 'inline' },
  'time': { 'display': 'inline' },
  'q': { 'display': 'inline' },
  'label': { 'display': 'inline' },
  'br': { 'display': 'inline' },
  
  // Terminal UI controls
  'button': { 
    'display': 'inline-block', 
    'border': '1px solid',
    'padding': '0 1ch',
    'cursor': 'pointer'
  },
  'input': { 
    'display': 'inline-block',
    'border': '1px solid',
    'padding': '0 1ch'
  },
  'textarea': { 
    'display': 'inline-block',
    'border': '1px solid',  
    'padding': '0 1ch'
  },
  'select': {
    'display': 'inline-block',
    'border': '1px solid',
    'padding': '0 1ch'
  },
  
  // Tables
  'table': { 'display': 'table', 'border-collapse': 'collapse' },
  'thead': { 'display': 'table-header-group' },
  'tbody': { 'display': 'table-row-group' },
  'tfoot': { 'display': 'table-footer-group' },
  'tr': { 'display': 'table-row' },
  'td': { 
    'display': 'table-cell',
    'border': '1px solid',
    'padding': '0 1ch'
  },
  'th': { 
    'display': 'table-cell', 
    'border': '1px solid',
    'padding': '0 1ch',
    'font-weight': 'bold'
  },
};

// ============================================================================
// PUBLIC API - PROPERTY CLASSIFICATION
// ============================================================================

/**
 * Check if a CSS property affects layout calculations.
 */
export function isLayoutProperty(property: string): boolean {
  return LAYOUT_PROPERTIES.has(property);
}

/**
 * Check if a CSS property is purely visual (affects rendering only).
 */
export function isVisualProperty(property: string): boolean {
  return VISUAL_PROPERTIES.has(property);
}

/**
 * Check if a CSS property is supported in Terminal DOM.
 */
export function isSupportedProperty(property: string): boolean {
  return SUPPORTED_PROPERTIES.has(property);
}

/**
 * Check if a CSS property inherits by default according to CSS spec.
 */
export function isInheritedProperty(property: string): boolean {
  return INHERITED_PROPERTIES.has(property);
}

// ============================================================================
// PUBLIC API - STYLE RESOLUTION
// ============================================================================

/**
 * Get the resolved value for a CSS property on an element.
 * 
 * For layout properties: throws on CSS keywords to keep invalidation simple
 * For visual properties: handles keywords normally with inheritance
 * 
 * Resolution order:
 * 1. Inline style value (if not a keyword)
 * 2. Handle CSS keywords (inherit, initial, unset) - or throw for layout props
 * 3. Apply automatic inheritance for inherited properties
 * 4. Fall back to element-specific defaults
 * 5. Fall back to CSS spec defaults
 * 
 * @param element - The DOM element
 * @param property - The CSS property name (kebab-case, e.g. 'margin-left')
 * @returns The resolved value with original units preserved (e.g. '10ch', '50%')
 */
export function getResolvedStyle(element: Element, property: string): string {
  const htmlElement = element as HTMLElement;
  const inlineValue = htmlElement.style.getPropertyValue(property);
  
  // Check for CSS keywords
  const isKeyword = ['inherit', 'initial', 'unset'].includes(inlineValue);
  
  // For layout properties, resolve keywords to defaults (keeps invalidation simple)
  if (isLayoutProperty(property) && isKeyword) {
    // Always resolve to initial value for layout properties
    return getInitialValue(element, property);
  }
  
  // Handle CSS keywords normally for visual properties
  if (isKeyword) {
    if (inlineValue === 'inherit') {
      return htmlElement.parentElement 
        ? getResolvedStyle(htmlElement.parentElement, property)
        : getInitialValue(element, property);
    }
    
    if (inlineValue === 'initial') {
      return getInitialValue(element, property);
    }
    
    if (inlineValue === 'unset') {
      if (INHERITED_PROPERTIES.has(property)) {
        // Act like 'inherit'
        return htmlElement.parentElement 
          ? getResolvedStyle(htmlElement.parentElement, property)
          : getInitialValue(element, property);
      } else {
        // Act like 'initial' 
        return getInitialValue(element, property);
      }
    }
  }
  
  // If we have a concrete value, use it
  if (inlineValue) {
    return inlineValue;
  }
  
  // Apply automatic inheritance for inherited properties
  if (INHERITED_PROPERTIES.has(property) && htmlElement.parentElement) {
    return getResolvedStyle(htmlElement.parentElement, property);
  }
  
  // Fall back to defaults
  return getInitialValue(element, property);
}

/**
 * Get the initial/default value for a property on an element.
 * 
 * @param element - The DOM element  
 * @param property - The CSS property name
 * @returns The initial value for this element type and property
 */
function getInitialValue(element: Element, property: string): string {
  const tagName = element.tagName.toLowerCase();
  
  // Check element-specific defaults first
  const elementDefaults = TERMINAL_ELEMENT_DEFAULTS[tagName];
  if (elementDefaults && elementDefaults[property]) {
    return elementDefaults[property];
  }
  
  // Check universal defaults (*) 
  const universalDefaults = TERMINAL_ELEMENT_DEFAULTS['*'];
  if (universalDefaults && universalDefaults[property]) {
    return universalDefaults[property];
  }
  
  // Fall back to CSS spec default
  return CSS_SPEC_DEFAULTS[property] || '';
}

/**
 * Get all the terminal-specific element defaults (for testing/debugging).
 */
export function getTerminalElementDefaults(): Record<string, Record<string, string>> {
  return TERMINAL_ELEMENT_DEFAULTS;
}

// ============================================================================
// EXAMPLES OF UNSUPPORTED PROPERTIES (for documentation)
// ============================================================================

/**
 * Examples of UNSUPPORTED properties (ignored entirely):
 * 
 * Font properties (terminal uses fixed-width font):
 * - font-family, font-size, font-weight, font-style, line-height
 * 
 * Text decoration (not relevant for terminal):
 * - text-decoration, text-shadow, text-indent, text-transform
 * 
 * Advanced visual effects (not possible in terminal):
 * - box-shadow, border-radius, opacity, filter
 * 
 * Animations and transitions (not supported):
 * - animation, transition, transform
 * 
 * Mouse interaction (limited in terminal):
 * - cursor, pointer-events
 * 
 * Grid layout (use flexbox instead):
 * - grid-*, place-*, gap
 * 
 * Float layout (use flexbox instead):
 * - float, clear
 * 
 * Advanced positioning:
 * - z-index, clip, clip-path
 * 
 * Print/media queries:
 * - page-break-*, orphans, widows
 * 
 * Table layout (limited support):
 * - table-layout, border-collapse, border-spacing, caption-side
 * 
 * Lists (basic support via text content):
 * - list-style, list-style-type, list-style-position, list-style-image
 * 
 * And hundreds more CSS properties that don't apply to terminal rendering...
 */