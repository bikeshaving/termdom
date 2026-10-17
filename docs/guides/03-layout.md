---
title: Layout
description: The box model, flexbox, grid, tables, and MathML on a cell grid.
---

By default, `1px` and `1ch` are both one cell. The property decides
whether that cell is a column or a row. The `cellSize` option sets how
many CSS pixels make up one cell. The engine rounds any length that
falls between cells to a whole number of cells.

## Boxes

```ts
box.style.width = "24ch";
box.style.padding = "0 2ch";
box.style.border = "1px solid";
box.style.margin = "1px 0";
```

The engine draws borders with box-drawing characters. Each side of a
border takes one cell. When two borders meet in a cell, the engine
joins them. A horizontal rule that reaches a box's side ends in `├` or
`┤`. A column divider that meets the top or bottom border makes `┬` or
`┴`. The [styling guide](/guides/styling/#borders) lists the glyphs
that each border style draws.

## Flexbox

```ts
row.style.display = "flex";
row.style.gap = "2ch";
row.style.justifyContent = "space-between";
row.style.alignItems = "center";
```

`flex-grow`, `flex-shrink`, `flex-wrap`, `order`, and the alignment
properties all work.

## Grid

```ts
page.style.display = "grid";
page.style.gridTemplateAreas = `"head head" "side main" "foot foot"`;
page.style.gridTemplateColumns = "18ch 1fr";
page.style.gridTemplateRows = "1px 1fr 1px";
page.style.gap = "0 1ch";

sidebar.style.gridArea = "side";
```

Track lists accept these values:

- lengths and percentages
- `fr`, `auto`, `min-content`, and `max-content`
- `minmax()`, `fit-content()`, and `repeat()`, including
  `repeat(auto-fill, ...)` and `repeat(auto-fit, ...)`

You can place an item by line number, by `span`, by named line, or by
named area. Negative line numbers count from the end. The engine
auto-places every item you do not place yourself. It follows
`grid-auto-flow`, and packs items either sparsely or `dense`.

`justify-items`, `justify-self`, `align-items`, `align-self`,
`justify-content`, and `align-content` all apply.

Flexible tracks fill the terminal exactly. For example,
`repeat(3, 1fr)` across 80 columns gives tracks of 27, 26, and 27
cells. The tracks meet with no gap and no overlap.

## Tables

A `<table>` of `<tr>` and `<td>` elements lays out as a table. Rows
share column widths, and `colspan`, `rowspan`, and `border-collapse`
work.

## Text

Text wraps at the width of its box. `white-space`, `word-break`, and
`overflow-wrap` apply. Wide characters, such as CJK characters and
emoji, take two cells.

A line takes `floor(line-height / font-size)` rows, with a minimum of
one row. So `line-height: 2` places lines two rows apart.

## Positioning

`position: relative`, `absolute`, `fixed`, and `sticky` all work, along
with `z-index` and stacking contexts.

A sticky box keeps its `top`, `bottom`, `left`, or `right` inset
against the nearest scrolling ancestor. If it has no scrolling
ancestor, it uses the viewport. A sticky box never leaves the box that
contains it in normal flow.

The `translate` property, and the translation in a `transform`
(`translate()`, `translateX()`, `translateY()`, `translate3d()`, and
the offsets in `matrix()`), draw a box away from where layout put it,
as in a browser. The box takes clicks where it is drawn, and nothing
around it moves. A percentage is a share of the box's own size. A
rotation, scale, or skew has no effect, so the box is drawn as it is.

`overflow: hidden` clips content to the box. `overflow: auto` and
`overflow: scroll` also clip, and they make the box scrollable.
`scrollTop`, `scrollTo`, `scrollIntoView`, and the mouse wheel scroll
the content by whole rows.

## MathML

The engine lays out a `<math>` element on the cell grid, following
MathML Core.

- A fraction stacks the numerator over a bar of `─` over the
  denominator.
- A root draws a `⎷` foot, a stem, and a bar over the radicand. The
  index of an `<mroot>` sits as a superscript before the sign.
- Sums, products, and integrals are several rows tall, with their
  limits above and below.
- Fences stretch to the height of their contents.

Scripts, tables, accents, stretched arrows, `<mpadded>`, `<mphantom>`,
and `<mspace>` all work.

The user-agent stylesheet makes variables in `<mi>` italic with a
`text-transform: math-auto` rule, as browsers do. Terminals draw
italics unevenly. An author rule can turn the italics off and use a
color instead:

```css
mi { text-transform: none; color: #ffd787; }
```

A user can select and highlight everything inside `<math>`, cell by
cell.
[`examples/katex.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/katex.ts)
renders TeX through KaTeX's MathML output and walks every element.

## Not implemented

Floats, `subgrid`, and masonry are not implemented. The
[compatibility matrix](/compatibility/) has the full list.
