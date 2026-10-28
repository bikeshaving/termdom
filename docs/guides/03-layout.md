---
title: Layout
description: The box model, flexbox, grid, tables, and MathML on a cell grid.
---

By default, `1px` and `1ch` are both one cell, a column or a row
depending on the property. The `cellSize` option changes how many CSS
pixels a cell is. Lengths round to whole cells.

## Boxes

```ts
box.style.width = "24ch";
box.style.padding = "0 2ch";
box.style.border = "1px solid";
box.style.margin = "1px 0";
```

Borders are drawn with box-drawing characters, one cell per side.
Borders that meet in a cell join: a rule that reaches a box's side
ends in `├` or `┤`, and a column divider that meets the top or bottom
makes `┬` or `┴`. The [styling guide](/guides/styling/#borders) lists
the glyphs for each border style.

## Flexbox

```ts
row.style.display = "flex";
row.style.gap = "2ch";
row.style.justifyContent = "space-between";
row.style.alignItems = "center";
```

`flex-grow`, `flex-shrink`, `flex-wrap`, `order`, and the alignment
properties work.

## Grid

```ts
page.style.display = "grid";
page.style.gridTemplateAreas = `"head head" "side main" "foot foot"`;
page.style.gridTemplateColumns = "18ch 1fr";
page.style.gridTemplateRows = "1px 1fr 1px";
page.style.gap = "0 1ch";

sidebar.style.gridArea = "side";
```

Track lists accept:

- lengths and percentages
- `fr`, `auto`, `min-content`, and `max-content`
- `minmax()`, `fit-content()`, and `repeat()`, including `auto-fill`
  and `auto-fit`

Items can be placed by line number (negative counts from the end),
`span`, named line, or named area. Other items are auto-placed by
`grid-auto-flow`, sparse or `dense`. The `justify-*` and `align-*`
properties apply.

Flexible tracks fill the space exactly: `repeat(3, 1fr)` across 80
columns gives 27, 26, and 27.

## Tables

`<table>`, `<tr>`, and `<td>` lay out as a table, with shared column
widths, `colspan`, `rowspan`, and `border-collapse`.

## Text

Text wraps at its box's width. `white-space`, `word-break`, and
`overflow-wrap` apply. CJK characters and emoji take two cells.

A line takes `floor(line-height / font-size)` rows, at least one, so
`line-height: 2` spaces lines two rows apart.

## Positioning

`position: relative`, `absolute`, `fixed`, and `sticky` work, with
`z-index` and stacking contexts.

A sticky box sticks within its nearest scrolling ancestor, or the
viewport, and never leaves its containing block.

`translate` and the translation part of `transform` move a box where
it's drawn and where it takes clicks, without moving anything around
it. Percentages are of the box's own size. Rotation, scale, and skew
are ignored.

`overflow: hidden` clips. `overflow: auto` and `scroll` clip and
scroll. `scrollTop`, `scrollTo()`, `scrollIntoView()`, and the wheel
scroll by whole rows.

## MathML

`<math>` is laid out on the cell grid following MathML Core.

- A fraction is the numerator over a `─` bar over the denominator.
- A root is a `⎷` with a bar over the radicand. An `<mroot>` index sits
  before the sign.
- Sums, products, and integrals span several rows, with limits above
  and below.
- Fences stretch to their contents.

Scripts, tables, accents, stretched arrows, `<mpadded>`, `<mphantom>`,
and `<mspace>` work.

Variables in `<mi>` are italic, from a `text-transform: math-auto`
rule. Terminals draw italics unevenly, so you may prefer a color:

```css
mi { text-transform: none; color: #ffd787; }
```

Math can be selected cell by cell.
[`examples/katex.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/katex.ts)
renders TeX through KaTeX's MathML output.

## Not implemented

Floats, `subgrid`, and masonry. The
[compatibility matrix](/compatibility/) has the full list.
