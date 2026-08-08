---
title: Layout
description: The box model, flexbox, and tables on a cell grid.
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

CSS Grid and floats. The [compatibility matrix](/compatibility/) has the full list.
