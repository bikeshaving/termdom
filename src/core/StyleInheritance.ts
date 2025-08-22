/**
 * Style Inheritance for TOM
 * 
 * Implements CSS-like style inheritance for TOM elements.
 * Unlike CSS, we have full control over which properties inherit.
 */

import { TOMElement, TOMStyle } from './TOMElement.js';

/**
 * Properties that should inherit from parent to child
 */
const INHERITABLE_PROPERTIES: (keyof TOMStyle)[] = [
  'color',
  'fontWeight',
  'fontStyle',
  'textAlign'
];

/**
 * Default values for style properties
 */
const DEFAULT_STYLES: Partial<TOMStyle> = {
  display: 'block',
  position: 'relative',
  flexDirection: 'column',
  justifyContent: 'flex-start',
  alignItems: 'stretch',
  color: 'white',
  backgroundColor: undefined,
  fontWeight: 'normal',
  fontStyle: 'normal',
  textDecoration: 'none',
  textAlign: 'left',
  overflow: 'visible'
};

/**
 * Compute the effective style for an element, including inheritance
 */
export function computeEffectiveStyle(element: TOMElement): TOMStyle {
  const computedStyle: TOMStyle = { ...DEFAULT_STYLES };
  
  // Start from the root and work down, applying inheritance
  const ancestors = getAncestors(element);
  
  // Apply inherited styles from ancestors
  for (const ancestor of ancestors) {
    if (ancestor instanceof TOMElement) {
      const ancestorStyle = ancestor.style;
      
      for (const prop of INHERITABLE_PROPERTIES) {
        if (ancestorStyle[prop] !== undefined) {
          (computedStyle as any)[prop] = ancestorStyle[prop];
        }
      }
    }
  }
  
  // Apply element's own styles (overrides inherited values)
  Object.assign(computedStyle, element.style);
  
  return computedStyle;
}

/**
 * Get all ancestors of an element, from root to direct parent
 */
function getAncestors(element: TOMElement): Element[] {
  const ancestors: Element[] = [];
  let current = element.parentElement;
  
  while (current) {
    ancestors.unshift(current); // Add to beginning for root-to-parent order
    current = current.parentElement;
  }
  
  return ancestors;
}

/**
 * Check if a style property should inherit
 */
export function isInheritableProperty(property: keyof TOMStyle): boolean {
  return INHERITABLE_PROPERTIES.includes(property);
}

/**
 * Get inherited value for a property from the parent chain
 */
export function getInheritedValue(element: TOMElement, property: keyof TOMStyle): any {
  let current = element.parentElement;
  
  while (current) {
    if (current instanceof TOMElement) {
      const value = current.style[property];
      if (value !== undefined) {
        return value;
      }
    }
    current = current.parentElement;
  }
  
  // Return default value if no inherited value found
  return DEFAULT_STYLES[property];
}

/**
 * Mixin to add computed style support to TOMElement
 */
export function addComputedStyleSupport(ElementClass: typeof TOMElement) {
  // Add computed style getter
  Object.defineProperty(ElementClass.prototype, 'computedStyle', {
    get: function(this: TOMElement) {
      return computeEffectiveStyle(this);
    },
    configurable: true
  });
  
  // Override the style setter to trigger inheritance recalculation
  const originalStyleSetter = Object.getOwnPropertyDescriptor(ElementClass.prototype, 'style')?.set;
  
  if (originalStyleSetter) {
    Object.defineProperty(ElementClass.prototype, 'style', {
      get: function(this: TOMElement) {
        return this._tomStyle || {};
      },
      set: function(this: TOMElement, value: TOMStyle) {
        originalStyleSetter.call(this, value);
        
        // Trigger re-computation for descendants that might inherit
        this.invalidateDescendantStyles();
      },
      configurable: true
    });
  }
}

/**
 * Extension to TOMElement for style inheritance
 */
declare module './TOMElement.js' {
  interface TOMElement {
    computedStyle: TOMStyle;
    invalidateDescendantStyles(): void;
  }
}

// Add methods to TOMElement prototype
Object.assign(TOMElement.prototype, {
  /**
   * Invalidate computed styles for all descendants
   */
  invalidateDescendantStyles(this: TOMElement): void {
    for (const child of this.children) {
      if (child instanceof TOMElement) {
        child.markForRender();
        child.invalidateDescendantStyles();
      }
    }
  }
});

// Apply the computed style support
addComputedStyleSupport(TOMElement);