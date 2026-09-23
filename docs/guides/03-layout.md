---
title: Layout
description: The box model, flexbox, grid, tables, and MathML on a cell grid.
---

The cell is the unit basis: `1px` and `1ch` both mean one cell, and the
property supplies the axis. Lengths that land between cells resolve to whole
cells.

## Boxes

```ts
box.style.width = "24ch";
box.style.padding = "0 2ch";
box.style.border = "1px solid";
box.style.margin = "1px 0";
```

Borders draw with box-drawing characters and take one cell per side.
Borders that meet in a cell join: a rule that reaches a box's side ends
in `├` or `┤`, and a column divider crossing it makes `┬` or `┴`. The
[styling guide](/guides/styling/#borders) has the glyphs each border
style draws.

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

`position: relative`, `absolute`, `fixed`, and `sticky`, with `z-index` and
stacking contexts. A sticky box holds its `top`, `bottom`, `left`, or `right`
inset against the nearest scrolling box above it, or against the viewport,
and never leaves the box it flows in. `overflow: hidden` clips to the box.
`overflow: auto` and `scroll` clip too, and make the box scrollable:
`scrollTop`, `scrollTo`, `scrollIntoView`, and the mouse wheel move its
content by whole rows.

## MathML

A `<math>` element lays out as MathML Core says, on the cell grid.
Fractions stack the numerator over a bar of `─` over the denominator.
Roots draw a `⎷` foot, a stem, and a bar over the radicand, with the
index of an `<mroot>` as a superscript before the sign. Sums, products,
and integrals are drawn several rows tall with their limits above and
below, and fences stretch to the height of what they enclose. Scripts,
tables, accents, stretched arrows, and `<mpadded>`, `<mphantom>`, and
`<mspace>` all work.

Variables in `<mi>` are italic by the `text-transform: math-auto` rule
in the user-agent stylesheet, as in a browser. Terminals draw italics
unevenly, so an author rule can turn that off and use a color instead:

```css
mi { text-transform: none; color: #ffd787; }
```

Everything inside `<math>` can be selected and highlighted by cell.
[`examples/katex.ts`](https://github.com/bikeshaving/termdom/blob/main/examples/katex.ts)
renders TeX through KaTeX's MathML output and walks every element.

## Not implemented

Floats, `subgrid` and masonry. The [compatibility matrix](/compatibility/) has
the full list.

## Highlights

`CSS.highlights.set("hit", new Highlight(...ranges))` colors ranges through
`::highlight(hit)` rules for `color`, `background-color` and
`text-decoration-line`, without adding elements or moving a line break.
The higher `priority` wins where highlights overlap, and `::selection`
paints over all of them. See `examples/highlights.ts`.
