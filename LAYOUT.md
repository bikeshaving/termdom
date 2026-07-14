# Terminal DOM Layout System Architecture

## Overview

The Terminal DOM (TermDOM) layout system runs all layout through a pure-JS
flexbox engine in `src/flex.ts`, written from the CSS Flexible Box Layout spec
(css-flexbox-1) and computing directly on an integer grid of character cells.
There is no native or WebAssembly dependency.

This document covers two things: how the DOM is mapped onto a layout tree
(`src/layout.ts`), and what the engine underneath does and does not support
(`src/flex.ts`).

> **History.** termdom previously used Facebook's Yoga (`yoga-layout`), a
> WASM/native module that computes in floats which then had to be forced back onto
> a cell grid. `src/flex.ts` replaced it. The engine implements only what a
> terminal needs — see [Deliberately unsupported](#deliberately-unsupported).

## Core design principles

1. **One engine.** All layout goes through `src/flex.ts`.
2. **Anonymous boxes for inline runs.** Consecutive inline content is wrapped in
   pseudo layout nodes.
3. **Consistent flexbox.** Block elements are always `flex-direction: column`.
4. **Terminal grid.** All measurements are in character cells (`1ch` = 1 cell).
   No box is ever reported at a fractional size.
5. **Web defaults.** The engine is configured with `setUseWebDefaults(true)`,
   which is what makes it behave like CSS rather than like Yoga's own defaults.

### Web defaults are load-bearing

`Config.setUseWebDefaults(true)` flips three defaults to their CSS values:

| Property         | Engine default | Web/CSS default |
| ---------------- | -------------- | --------------- |
| `flex-direction` | `column`       | `row`           |
| `align-content`  | `flex-start`   | `stretch`       |
| `flex-shrink`    | `0`            | `1`             |

Without it every layout in termdom is subtly wrong. `LayoutEngine` sets it once on
the shared `Config`, and every node is created from that config.

### The integer grid

The engine rounds **edges**, not sizes. A box's width is derived as
`round(right) - round(left)` in absolute coordinates, rather than by rounding the
width directly. That is what makes adjacent boxes tile exactly when a flexible
size lands on a fraction:

```
three items with flex: 1 across 80 columns
  widths  27, 26, 27   (sum exactly 80)
  lefts    0, 27, 53   (no gap, no overlap)
```

Rounding each width independently would give `27 + 27 + 27 = 81` and a column of
overlap. Measured text leaves are the one exception: they round their trailing
edge **up**, so a text run is never handed less room than it measured and forced
to re-wrap.

## Unified layout model

### Block elements

- Flex container with `flex-direction: column`.
- Margin, padding, width, height, and positioning map directly onto engine setters.
- Examples: `div`, `p`, `section`, `article`, `header`, `footer`.

```typescript
function createBlockNode(element: Element) {
  const node = Node.createWithConfig(config);
  node.setDisplay(Flex.DISPLAY_FLEX);
  node.setFlexDirection(Flex.FLEX_DIRECTION_COLUMN);
  node.setAlignItems(Flex.ALIGN_STRETCH);
  node.setJustifyContent(Flex.JUSTIFY_FLEX_START);
  return node;
}
```

### Inline elements

**In normal flow (non-flex containers):**

- Inline content (text nodes and inline elements) is grouped into **anonymous
  blocks** with `flex-direction: row`.
- The first node of a contiguous inline run — the *run head* — owns the pseudo node
  representing the whole run and carries the measure function.

**In flex containers:**

- Inline elements become flex items regardless of their display type.
- Each inline element gets its own layout node; no anonymous box grouping.
- Contiguous text runs are wrapped in anonymous flex items, per the flexbox spec:
  "each contiguous run of text directly contained inside a flex container is
  wrapped in an anonymous flex item".

### Inline-block elements

Their own node, intrinsically sized, atomic — cannot break across lines.
Examples: `button`, `input`, replaced elements.

### `display: none`

Node stays in the tree, skipped by layout.

## Text measurement

Every leaf in the layout tree gets a measure function: anonymous text runs,
elements containing only text, and inline elements that become layout leaves. The
measure function line-breaks the run against the width the engine offers and
reports a cell size.

### Measure functions have side effects

`#measureInlineRun` writes its result into `breakResultMap`, which the **renderer**
later reads to draw the text. The *last* measure call for a node therefore decides
what gets rendered.

This is why **there is no measure cache**. A cache would let a stale call be the
last one, so the renderer could draw text broken for a width the box no longer
has. Full recomputation keeps the final measure call the layout-pass one, at the
box's final size. It costs performance, and that is a deliberate trade.

Dropping the cache also exposed a latent bug Yoga had been hiding: `LayoutEngine`
left DOM-removed nodes attached to the layout tree, and Yoga's measure cache
silently skipped them. Without a cache they get measured and crash, so
`calculateLayout()` now prunes disconnected nodes before laying out.

### Measure modes

The engine offers a box a size with one of three modes, and confusing them is the
single richest source of layout bugs in this codebase:

| Mode        | Meaning                                              |
| ----------- | ---------------------------------------------------- |
| `EXACTLY`   | Definite size. Use it.                               |
| `AT_MOST`   | **Upper bound only.** The box is being shrink-wrapped. |
| `UNDEFINED` | Indefinite. Size to content.                         |

**`AT_MOST` is not a definite size.** Items grow into, stretch to, and clamp
against a size only when it is `EXACTLY`. Treating an `AT_MOST` bound as definite
has produced four separate bugs here — items reporting the whole container as
their content size, `flex: 1` children growing to fill a terminal they should have
shrink-wrapped inside, and a `max-width` collapsing a box to zero because the cap
was mistaken for "size yourself to content, up to this".

## Layout process

1. **DOM mutation** — detected via `MutationObserver`.
2. **Tree update** — rebuild anonymous boxes and block nodes; prune nodes whose DOM
   node is gone.
3. **Layout** — `rootNode.calculateLayout(terminalWidth, terminalHeight)`.
4. **Bounds storage** — recursively extract computed layouts.

## Supported

Covered by `tests/flex.test.ts`, whose expectations are hand-computed from
css-flexbox-1.

- `flex-direction`: `row`, `row-reverse`, `column`, `column-reverse`
- `flex-grow`, `flex-shrink`, `flex-basis` — including `auto`, which falls back to
  the main size property and then to content
- `flex-wrap`: `nowrap`, `wrap`, `wrap-reverse`
- `justify-content`: `flex-start`, `center`, `flex-end`, `space-between`,
  `space-around`, `space-evenly`
- `align-items` / `align-self`: `flex-start`, `center`, `flex-end`, `stretch`,
  `baseline`
- `align-content`: `flex-start`, `center`, `flex-end`, `stretch`, `space-between`,
  `space-around`, `space-evenly`
- `min-width` / `max-width` / `min-height` / `max-height`, including their
  interaction with grow and shrink — the freeze/clamp/redistribute loop of §9.7,
  which freezes clamped items by the **sign of the total violation** and measures
  free space against unfrozen items' **flex base** sizes, not the sizes they were
  last handed
- `margin`, `padding`, `border` widths. Percentages resolve against the containing
  block's **width** on every edge, including top and bottom, as CSS requires
- `margin: auto` — absorbs free space on the main axis, ahead of `justify-content`,
  and centres on the cross axis
- `position: relative` (offsets the box, leaves siblings alone) and
  `position: absolute` (out of flow, positioned against its containing block)
- `display: none`

### Box sizing

Sizes are **border-box**: an explicit `width` includes padding and border. A box
with `width: 50` and `padding: 5` occupies 50 cells, 40 of them content.

### Baseline alignment on a cell grid

A terminal has no font metrics, so a text run's baseline is defined as **the top of
its first row**. `align-items: baseline` therefore aligns items' first text rows. A
box with no text of its own inherits the baseline of its first in-flow child
(css-flexbox-1 §8.5); one with no in-flow children synthesizes a baseline at its
content edge.

This is **not** equivalent to `flex-start`. Whenever items carry different leading
border, padding, or margin, their first rows sit at different offsets from their
own edges, and baseline alignment is precisely what compensates.

In a **column** container the cross axis is horizontal, so there is no block axis to
align along, and `baseline` degenerates to `flex-start`. That is intentional.

## Deliberately unsupported

Omitted because they are meaningless on a character grid, or because termdom does
not need them and the engine is easier to reason about without them. **None of
these have setters**, so a stylesheet asking for one is ignored rather than
silently mislaid.

| Feature                              | Why                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **RTL / `direction`**                | The engine has no writing-direction concept; everything is LTR. Terminal cell coordinates run left-to-right and the renderer assumes it. |
| **`aspect-ratio`**                   | Cells are not square, so a numeric ratio has no consistent meaning in cells.                                                             |
| **`gap` / `row-gap` / `column-gap`** | Not implemented. Use margins.                                                                                                           |
| **Sub-cell scaling**                 | `pointScaleFactor` exists for API compatibility, but only `1` is meaningful. A cell is indivisible.                                      |

## Undefined behaviour

Where the engine makes a choice CSS does not pin down, or the terminal forces one.
Worth reading before filing a bug.

### `min-width: auto` is not implemented

This is the largest deviation from the spec. CSS gives flex items an *automatic
minimum size*: `min-width`/`min-height` default to `auto`, which floors an item at
its min-content size, so items refuse to shrink below their content and overflow
instead.

Here they default to `0`. Two items whose content is 40 cells wide, in a 40-cell
row, compress to 20 each rather than overflowing at 40 each:

```
                       engine   CSS
two 40-wide contents
in a 40-wide row       20, 20   40, 40 (overflowing)
```

This is why overflowing text compresses instead of forcing its container wider. It
is a real difference from a browser, and it is deliberate: a terminal has nowhere
to overflow *to*.

### Others

- **Overflow.** A box whose content exceeds it is neither clipped nor scrolled by
  the layout engine; it reports its size and the renderer draws what fits. There is
  no `overflow` property.
- **Percentage against an indefinite containing block.** Treated as undefined — the
  item falls back to content sizing — rather than as zero.
- **Cyclic percentage sizing.** A percentage-sized child of a content-sized parent
  is not iterated to a fixed point; it resolves against the parent's eventual size
  in a single pass.

## Edge cases

**Empty elements.** `<span></span>` has no text and no children: not a text leaf,
so it becomes an empty container and collapses to zero unless given a `min-width`
or `min-height`.

**Inline → block promotion.** An inline element containing a block child is
promoted to a block container rather than treated as a text leaf.

**Mixed content.** In

```html
<div>
  Text content
  <span>inline element</span>
  More text
  <div>Block element</div>
  Final text
</div>
```

the two text runs become separate anonymous boxes, split by the block child, which
gets its own node.

**Whitespace.** Collapsing follows the `white-space` property, applied during
measurement. Each element in a run may have its own value.

## Testing

Two suites cover layout, and they are **not** interchangeable.

- **`tests/__snapshots__/ansi/*.ansi`** — end-to-end ANSI snapshots. They prove the
  engine reproduces what termdom's own documents happen to exercise. They prove
  nothing about flexbox in general: every engine bug listed in this document passed
  all 45 of them.
- **`tests/flex.test.ts`** — spec tests driven directly against the engine, with
  expected cell values **hand-computed from css-flexbox-1** and the derivation in a
  comment beside each.

Expectations in `flex.test.ts` must never be generated by running the
implementation. A test that reads its answer off the code under test only proves
the code agrees with itself, and enshrines its bugs as the contract.

When you fix a layout bug, add a case with its derivation. If a snapshot changes,
that is a rendering change and a human needs to look at it.

## Future enhancements

1. `min-width: auto` (automatic minimum size of flex items)
2. `gap`
3. Text shaping (graphemes)
4. Explicit line boxes
