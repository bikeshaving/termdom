# Terminal DOM Layout System Architecture

## Overview

The Terminal DOM (TermDOM) layout system uses Facebook's Yoga flexbox engine
exclusively for all layout calculations. This document describes the unified
approach where block elements, inline elements, and inline-block elements
participate in a combined layout system, with a specialized inline layout
engine for runs of inline content.

## Core Design Principles

1. **Yoga-First**: All layout goes through Yoga.
2. **Anonymous Boxes for Inline Runs**: Consecutive inline content is wrapped in pseudo Yoga nodes.
3. **Consistent Flexbox**: Block elements are always `flex-direction: column`.
4. **Single-Pass Layout**: Efficient calculation of the entire DOM tree.
5. **Terminal Grid**: All measurements in character cells (1ch = 1 cell).
6. **Yoga APIs**: Must use `useWebDefaults()`, `setPointScaleFactor(1)` for terminal fidelity.

## Unified Layout Model

### Block Elements

* Flex container with `flex-direction: column`.
* Children of blocks must have appropriate flexing:
  * `flex-grow`, `flex-shrink`, `align-self` set to defaults.
* Margins, padding, width, height, and positioning map directly to Yoga APIs.

```typescript
function createBlockNode(element: Element) {
  const node = createYogaNode(element);
  node.setDisplay(yoga.DISPLAY_FLEX);
  node.setFlexDirection(yoga.FLEX_DIRECTION_COLUMN);
  node.setAlignItems(yoga.ALIGN_STRETCH);
  node.setJustifyContent(yoga.JUSTIFY_FLEX_START);
  return node;
}

function setChildFlex(childNode: YogaNode) {
  childNode.setFlexGrow(0);
  childNode.setFlexShrink(1);
  childNode.setAlignSelf(yoga.ALIGN_AUTO);
}
```

* Examples: `div`, `p`, `section`, `article`, `header`, `footer`.

### Inline Elements

**In Normal Flow (Non-Flex Containers):**
* Inline content (text nodes and inline elements) is grouped into **anonymous blocks** (pseudo Yoga nodes) with `flex-direction: row`.
* The **first inline element/text** gets a pseudo Yoga node representing the entire inline run.
* Each inline node gets a **measure function** for width/height calculations.

**In Flex Containers:**
* **CRITICAL**: Inline elements become **flex items** regardless of their display type.
* Each inline element gets its own individual Yoga node (no anonymous box grouping).
* **Text runs** (contiguous adjacent text nodes) are wrapped in **anonymous flex items**.
* **Separated text runs** get separate anonymous flex items.
* This follows CSS flexbox spec: "each contiguous run of text directly contained inside a flex container is wrapped in an anonymous flex item".

### Inline-Block Elements

* Receive their own Yoga node with intrinsic sizing.
* Atomic: cannot break across lines.
* Examples: `button`, `input`, replaced elements.

### Flex Elements

* Use Yoga nodes with web defaults
* **Children behavior depends on parent type:**
  * In flex containers: all children become flex items (individual Yoga nodes)
  * In normal flow: anonymous box algorithm applies

### Display None Elements

* Yoga node with `display: none`.
* Maintains tree structure but skipped in layout.

## Layout Algorithm (Updated)

The layout algorithm has **two distinct modes** depending on the parent container type:

### 1. Flex Container Processing

```typescript
function processFlexChildren(parent: Element, children: Node[]) {
  const flexItems = groupFlexItems(children);
  
  for (const item of flexItems) {
    if (item.type === 'element') {
      // Each element gets its own Yoga node (even inline elements)
      const childYogaNode = buildYogaTree(item.element);
      parentYogaNode.insertChild(childYogaNode);
    } else if (item.type === 'text-run') {
      // Text runs get anonymous flex items with measure functions
      const anonymousBox = createAnonymousBoxForTextRun(item.textNodes);
      parentYogaNode.insertChild(anonymousBox);
    }
  }
}

function groupFlexItems(children: Node[]): FlexItem[] {
  const items: FlexItem[] = [];
  let currentTextRun: Text[] = [];
  
  for (const child of children) {
    if (child.nodeType === ELEMENT_NODE) {
      // Flush any pending text run
      if (currentTextRun.length > 0) {
        items.push({ type: 'text-run', textNodes: [...currentTextRun] });
        currentTextRun = [];
      }
      
      // Add element if not display:none
      if (getComputedStyle(child).display !== 'none') {
        items.push({ type: 'element', element: child as Element });
      }
    } else if (child.nodeType === TEXT_NODE && child.textContent?.trim()) {
      // Add to current text run (adjacent text nodes combine)
      currentTextRun.push(child as Text);
    }
  }
  
  // Flush final text run
  if (currentTextRun.length > 0) {
    items.push({ type: 'text-run', textNodes: currentTextRun });
  }
  
  return items;
}
```

### 2. Standard Anonymous Box Algorithm (Non-Flex Containers)

```typescript
function createAnonymousBoxes(parent: Element) {
  const children = Array.from(parent.childNodes);
  const groups: Node[][] = [];
  let currentInlineGroup: Node[] = [];

  for (const child of children) {
    if (isBlockElement(child)) {
      if (currentInlineGroup.length > 0) {
        groups.push(currentInlineGroup);
        currentInlineGroup = [];
      }
      groups.push([child]);
    } else {
      currentInlineGroup.push(child);
    }
  }

  if (currentInlineGroup.length > 0) {
    groups.push(currentInlineGroup);
  }

  for (const group of groups) {
    if (group.length === 1 && isBlockElement(group[0])) {
      createBlockNode(group[0]);
    } else {
      const anonBlock = createAnonymousBlock();
      anonBlock.setFlexDirection(yoga.FLEX_DIRECTION_ROW);
      for (const item of group) {
        const node = createYogaNode(item);
        node.setMeasureFunc(createTextMeasureFunc(item));
        anonBlock.insertChild(node);
      }
      parent[YOGA_NODE].insertChild(anonBlock);
    }
  }
}
```

### Algorithm Selection

```typescript
function processChildren(parent: Element, parentYogaNode: YogaNode) {
  const parentDisplay = getComputedStyle(parent).display;
  
  if (parentDisplay === 'flex') {
    processFlexChildren(parent, parent.childNodes);
  } else {
    createAnonymousBoxes(parent);
  }
}
```

## Text Measurement Architecture

### Core Principle: Recursive Measurement for Inline Content

**Every leaf node in the layout tree gets a measure function**. This includes:
- Anonymous text runs (contiguous text nodes)
- Individual elements with only text content
- Inline elements that become layout leaves

### Measure Function Assignment Rules

```typescript
// Rule 1: Anonymous boxes always get measure functions
function createAnonymousBox(textRun: Node[]) {
  const yogaNode = yoga.Node.create();
  yogaNode.setMeasureFunc(createRecursiveMeasureFunction(textRun));
  return yogaNode;
}

// Rule 2: Elements get measure functions if they are text leaves
function buildYogaTree(element: Element) {
  if (isTextLeafNode(element)) {
    // Element contains only text content - make it measurable
    yogaNode.setMeasureFunc(createElementMeasureFunction(element));
  } else {
    // Element has child elements - process children
    processChildren(element, yogaNode);
  }
}

function isTextLeafNode(element: Element): boolean {
  const children = Array.from(element.childNodes);
  
  // No children = not a text leaf
  if (children.length === 0) return false;
  
  // Has element children = not a text leaf (unless inline→block promotion)
  const hasElementChildren = children.some(child => 
    child.nodeType === ELEMENT_NODE && 
    getComputedStyle(child).display !== 'none'
  );
  
  const hasTextContent = children.some(child => 
    child.nodeType === TEXT_NODE && child.textContent?.trim()
  );
  
  // Text leaf if: has text AND no element children
  return hasTextContent && !hasElementChildren;
}
```

### Recursive Measurement Algorithm

For complex inline content like `<span>Hello <strong>bold</strong> world</span>`, the measure function recursively walks the tree:

```typescript
function createRecursiveMeasureFunction(rootNodes: Node[]) {
  return (width: number, widthMode: YogaMode, height: number, heightMode: YogaMode) => {
    const inlineRun = new InlineRunBuilder();
    
    for (const node of rootNodes) {
      inlineRun.addContent(measureNodeRecursively(node, width));
    }
    
    return inlineRun.calculateDimensions(width, widthMode);
  };
}

function measureNodeRecursively(node: Node, maxWidth: number): InlineContent {
  if (node.nodeType === TEXT_NODE) {
    return measureTextNode(node, getInheritedStyle(node.parentElement));
  } else if (node.nodeType === ELEMENT_NODE) {
    const element = node as Element;
    const elementStyle = getComputedStyle(element);
    
    if (isInlineElement(element)) {
      // Recursively measure inline children
      const childContent: InlineContent[] = [];
      for (const child of element.childNodes) {
        childContent.push(measureNodeRecursively(child, maxWidth));
      }
      return combineInlineContent(childContent, elementStyle);
    } else {
      // Block elements shouldn't appear in inline runs (CSS error case)
      throw new Error(`Block element ${element.tagName} in inline context`);
    }
  }
}
```

### Text Layout Preservation

The recursive measurement preserves the DOM tree structure while calculating flattened layout:

```typescript
interface InlineContent {
  text: string;           // Flattened text for line breaking
  width: number;          // Calculated width
  styles: CSSStyle[];     // Style runs for rendering
  elements: Element[];    // Source elements for event handling
}

// Example: <span>Hello <strong>bold</strong> world</span>
// Results in:
// {
//   text: "Hello bold world",
//   width: 15,
//   styles: [
//     {start: 0, end: 6, color: "white"},      // "Hello "
//     {start: 6, end: 10, color: "white", bold: true}, // "bold"
//     {start: 10, end: 15, color: "white"}     // " world"
//   ],
//   elements: [span, strong]
// }
```

### Line Breaking Across Element Boundaries

Line breaking must respect element boundaries for proper styling:

```typescript
function breakInlineContent(content: InlineContent, maxWidth: number): LineBreak[] {
  const breaker = linebreak(content.text);
  const lines: LineBreak[] = [];
  
  for (const bk of breaker) {
    const lineText = content.text.slice(lastBreak, bk.position);
    
    // Map character positions back to style runs and elements
    const lineStyles = mapPositionsToStyles(lastBreak, bk.position, content.styles);
    const lineElements = mapPositionsToElements(lastBreak, bk.position, content.elements);
    
    lines.push({
      text: lineText,
      width: measureStyledText(lineText, lineStyles),
      styles: lineStyles,
      elements: lineElements
    });
  }
  
  return lines;
}
```

## Layout Process

1. **DOM Mutation**: Detect changes via MutationObserver.
2. **Yoga Tree Update**: Rebuild anonymous boxes and block nodes.
3. **Layout Calculation**: `rootNode.calculateLayout(terminalWidth, terminalHeight)`.
4. **Bounds Storage**: Recursively extract computed layouts.

Refer to https://www.yogalayout.dev/docs/advanced/incremental-layout for how to do incremental layout.

## Edge Cases

### 1. Empty Elements
```html
<span></span>  <!-- No text content, no children -->
```
- **Behavior**: Not a text leaf node, becomes empty container
- **Result**: Collapses to zero dimensions unless `min-width`/`min-height`

### 2. Inline→Block Promotion
```html
<span>
  <div>Block content</div>  <!-- Block child promotes span -->
</span>
```
- **CSS Rule**: Inline elements with block children are promoted to block
- **Implementation**: Check child display types in `isTextLeafNode()`
- **Result**: Span becomes block container, not text leaf

### 3. Deeply Nested Inline Content
```html
<span>Text <em>nested <strong>deep</strong> content</em> more</span>
```
- **Challenge**: Recursive measurement depth
- **Solution**: Recursive tree walking preserves styling context
- **Performance**: Consider memoization for repeated measurements

### 4. Mixed Content Scenarios
```html
<div>
  Text content
  <span>inline element</span>
  More text
  <div>Block element</div>
  Final text
</div>
```
- **Grouping**: Creates separate anonymous boxes around block elements
- **Text runs**: "Text content inline element More text" → anonymous box
- **Block break**: `<div>Block element</div>` → individual Yoga node  
- **Final run**: "Final text" → separate anonymous box

### 5. Line Breaking Edge Cases
```html
<span>Very long text that needs <strong>to break across</strong> multiple lines</span>
```
- **Challenge**: Line breaks can occur within styled runs
- **Solution**: Character position mapping back to elements
- **Requirement**: Preserve styling across line boundaries

### 6. Empty Inline Elements in Runs
```html
<div>Text <span></span> more text</div>
```
- **Behavior**: Empty spans contribute no content but may affect styling/events
- **Implementation**: Include in recursive measurement but contribute zero width
- **Preservation**: Maintain element references for event handling

### 7. Whitespace Handling
```html
<span>Word1 <em>   Word2   </em> Word3</span>
```
- **CSS Rules**: Whitespace collapsing depends on `white-space` property
- **Implementation**: Apply whitespace rules during recursive measurement
- **Context**: Each element may have different `white-space` values

### 8. Replaced Elements in Inline Context
```html
<span>Text <img width="10" height="5"> more text</span>
```
- **Challenge**: Non-text content with intrinsic dimensions
- **Solution**: Measure replaced elements separately, compose with text
- **Line breaking**: Treat as atomic unit (doesn't break across lines)

## Why This Architecture?

* Consistency: Everything goes through Yoga.
* Correctness: Matches browser behavior with anonymous boxes.
* Performance: Single-pass layout.
* Flexibility: Easy to extend.

## Future Enhancements

1. Text shaping (graphemes)
2. Sophisticated inline layout
3. Explicit line boxes
4. Vertical text support
5. Ruby annotations

---

**Yoga APIs Required:** `useWebDefaults()`, `setPointScaleFactor(1)` for terminal fidelity and correct scaling.
