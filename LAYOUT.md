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

* Inline content (text nodes and inline elements) is grouped into **anonymous blocks** (pseudo Yoga nodes) with `flex-direction: row`.
* The **first inline element/text** gets a pseudo Yoga node representing the entire inline run.
* Each inline node gets a **measure function** for width/height calculations.

### Inline-Block Elements

* Receive their own Yoga node with intrinsic sizing.
* Atomic: cannot break across lines.
* Examples: `button`, `input`, replaced elements.

### Flex Elements

* Use Yoga nodes with web defaults

### Display None Elements

* Yoga node with `display: none`.
* Maintains tree structure but skipped in layout.

## Anonymous Box Algorithm

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
