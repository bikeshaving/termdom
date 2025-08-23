/**
 * Style Inheritance for TTY
 *
 * Implements CSS-like style inheritance for TTY elements.
 * Unlike CSS, we have full control over which properties inherit.
 */

import { TTYElement } from './TTYElement.js';
import { TTYCSSStyleDeclaration } from '../css/TTYCSSStyleDeclaration.js';

/**
 * Properties that should inherit from parent to child
 */
const INHERITABLE_PROPERTIES: (keyof Record<string, string>)[] = [
  'color',
  'fontWeight',
  'fontStyle',
  'textAlign'
];

// TODO: default diplay should be block
// TODO: kebab-case
/**
 * Default values for style properties
 */
const DEFAULT_STYLES: Partial<Record<string, string>> = {
  display: 'flex',
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

// TODO: We should figure out if we can use or override HappyDOM’s getComputedStyle interface
/**
 * Compute the effective style for an element, including inheritance
 */
export function computeEffectiveStyle(element: TTYElement): Record<string, string> {
  const computedStyle: Record<string, string> = { ...DEFAULT_STYLES };

  // Start from the root and work down, applying inheritance
  const ancestors = getAncestors(element);

  // Apply inherited styles from ancestors
  for (const ancestor of ancestors) {
    if (ancestor instanceof TTYElement) {
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
function getAncestors(element: TTYElement): Element[] {
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
export function isInheritableProperty(property: keyof Record<string, string>): boolean {
  return INHERITABLE_PROPERTIES.includes(property);
}

/**
 * Get inherited value for a property from the parent chain
 */
export function getInheritedValue(element: TTYElement, property: keyof Record<string, string>): any {
  let current = element.parentElement;

  while (current) {
    if (current instanceof TTYElement) {
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
 * Mixin to add computed style support to TTYElement
 */
export function addComputedStyleSupport(ElementClass: typeof TTYElement) {
  // Add computed style getter
  Object.defineProperty(ElementClass.prototype, 'computedStyle', {
    get: function(this: TTYElement) {
      return computeEffectiveStyle(this);
    },
    configurable: true
  });

  // Override the style setter to trigger inheritance recalculation
  const originalStyleSetter = Object.getOwnPropertyDescriptor(ElementClass.prototype, 'style')?.set;

  if (originalStyleSetter) {
    Object.defineProperty(ElementClass.prototype, 'style', {
      get: function(this: TTYElement) {
        return this._tomStyle || {};
      },
      set: function(this: TTYElement, value: Record<string, string>) {
        originalStyleSetter.call(this, value);

        // Trigger re-computation for descendants that might inherit
        this.invalidateDescendantStyles();
      },
      configurable: true
    });
  }
}

/**
 * Extension methods for TTYElement style inheritance
 * These are implemented directly in TTYElement.ts
 */

// Add methods to TTYElement prototype
Object.assign(TTYElement.prototype, {
  /**
   * Invalidate computed styles for all descendants
   */
  invalidateDescendantStyles(this: TTYElement): void {
    for (const child of this.children) {
      if (child instanceof TTYElement) {
        child.markForRender();
        child.invalidateDescendantStyles();
      }
    }
  }
});

// Apply the computed style support
addComputedStyleSupport(TTYElement);
