---
title: Layout
description: The box model, flexbox, grid and tables on a cell grid.
---

Sizes are in cells: `1ch` is one column, `1px` is one row. Lengths that land
between cells resolve to whole cells.

## Boxes

```ts
box.style.width = "24ch";
box.style.padding = "0 2ch";
box.style.border = "1px solid";
box.style.margin = "1px 0";
```

Borders are drawn with box-drawing characters (`solid` and `double`) and
take one cell per side.

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

Track lists take lengths, percentages, `fr`, `auto`, `min-content`,
`max-content`, `minmax()`, `fit-content()` and `repeat()` — including
`repeat(auto-fill, ...)` and `repeat(auto-fit, ...)`. Items are placed by line
number (negative numbers count from the end), by `span`, by named line, or by
named area; whatever is left over is auto-placed, sparsely or `dense`, along
`grid-auto-flow`. `justify-items`, `justify-self`, `align-items`,
`align-self`, `justify-content` and `align-content` all apply.

Flexible tracks tile the terminal exactly: `repeat(3, 1fr)` across 80 columns
is 27, 26 and 27 cells, meeting with no gap and no overlap.

## Tables

A `<table>` of `<tr>` and `<td>` elements lays out as a table: shared column
widths across rows, `colspan` and `rowspan`, `border-collapse`.

## Text

Text wraps at the box's width; `white-space`, `word-break`, and
`overflow-wrap` apply. Wide characters — CJK, emoji — take two cells.

## Positioning

`position: relative`, `absolute`, and `fixed`, with `z-index` and stacking
contexts. `overflow: hidden` clips to the box.

## Not implemented

Floats, `subgrid` and masonry. The [compatibility matrix](/compatibility/) has
the full list.
