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

## Text Measurement

* Text nodes get measure functions using `Bun.stringWidth()`.
* Greedy line breaking is used by default.
* Wrapping occurs on whitespace or using UAX-14 Unicode line-breaking rules.

```typescript
function createTextMeasureFunc(element: Node): MeasureFunc {
  return (width, widthMode, height, heightMode) => {
    const text = element.textContent || '';
    const textWidth = getTextWidth(text);

    if (widthMode === MeasureMode.Exactly) {
      const lines = textWidth <= width ? 1 : Math.ceil(textWidth / width);
      return { width, height: lines };
    } else if (widthMode === MeasureMode.AtMost) {
      const actualWidth = Math.min(textWidth, width);
      const lines = textWidth <= width ? 1 : Math.ceil(textWidth / width);
      return { width: actualWidth, height: lines };
    } else {
      return { width: textWidth, height: 1 };
    }
  };
}
```

We should investigate using https://github.com/foliojs/linebreak as a dependency.

## Layout Process

1. **DOM Mutation**: Detect changes via MutationObserver.
2. **Yoga Tree Update**: Rebuild anonymous boxes and block nodes.
3. **Layout Calculation**: `rootNode.calculateLayout(terminalWidth, terminalHeight)`.
4. **Bounds Storage**: Recursively extract computed layouts.

Refer to https://www.yogalayout.dev/docs/advanced/incremental-layout for how to do incremental layout.

## Edge Cases

* **Empty elements**: height collapses unless `min-height`.
* **Pure text**: wrapped in anonymous inline block.
* **Mixed content**: inline groups split around block elements.
* **Nested inline**: single anonymous block contains all inline nodes.
* **br elements**: forced line breaks.

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
