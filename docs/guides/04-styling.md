---
title: Styling
description: How each CSS property maps to what a terminal can draw.
---

A terminal cell holds one character, a foreground color, a background
color, and a handful of attributes. Every CSS property either resolves
to one of those or has no effect. This guide is the mapping. The
[compatibility matrix](/compatibility/) lists every property with a
yes or a no; this is the why and the how.

## Units

`1px` and `1ch` are one cell. Which axis is meant comes from the
property: `width: 10px` is ten columns and `height: 10px` is ten rows.
`em`, `rem`, and `ex` scale from `font-size`, which is `1` by default,
so `1em` is one cell too. Percentages, `vw`, `vh`, and `calc()` work. A
length that lands between cells resolves to a whole cell.

`font-size` and `font-family` have no effect. A terminal draws one font
at one size.

## Colors

`color` and `background-color` take named colors, hex in three, four,
six, or eight digits, and `rgb()` and `hsl()` in both the comma form and
the modern space-separated form with `/ alpha`.

A cell has no alpha, so a translucent `background-color` is blended with
what the cell already shows, or with the terminal's own background where
nothing has been painted, and the cell gets the result. A color with
alpha `0` paints nothing. In a gradient, stops composite over the color
beneath them.

The system colors mean what they mean in a terminal:

| Color | Meaning |
| --- | --- |
| `Canvas` | The terminal's own background. A box with `background-color: Canvas` clears to it, which is how a dialog or popover covers what is behind it. |
| `CanvasText` | The terminal's own foreground. |
| `Highlight`, `HighlightText` | Inverse video. The pair is what `::selection` uses. |
| `SelectedItem`, `SelectedItemText` | Inverse video too. |
| `LinkText` | Blue, the color of `<a href>`. |
| `GrayText` | Gray. |

A `background-image` with a `linear-gradient()` paints each cell the
color the gradient has at that cell's center. `radial-gradient()` and
`url()` have no effect. `opacity`, `filter`, `box-shadow`, and
`mix-blend-mode` have no effect either.

### Color depth

Terminals differ in how many colors they can show. The `colorDepth`
option says which TermDOM draws with, in the bits `screen.colorDepth`
reports:

| `colorDepth` | Colors | How a CSS color is drawn |
| --- | --- | --- |
| `"auto"` (default) | What the terminal says | As one of the three below |
| `24` | Any color | Exactly |
| `8` | 256 | As the closest of the 256 |
| `4` | 16 basic colors | As the closest basic color |

`"rgb"`, `"256"` and `"ansi"` name the same three.

With `"auto"`, TermDOM asks the terminal when `attach()` runs. It uses
24 if the terminal says it has 24-bit color, or if it is tmux, which
converts 24-bit color for the terminal it runs in. Otherwise it uses 8,
which every terminal in use supports. It does not guess, because a
terminal without 24-bit color can show a 24-bit color as something
else, such as hidden text.

Some terminals have 24-bit color but do not say so, among them
Alacritty, Konsole and VS Code's terminal. Most of them set the
`COLORTERM` environment variable to `truecolor`. TermDOM does not read
the environment, but a program can, and pass what it finds:

```ts
const truecolor =
	process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
const term = new TermDOM({colorDepth: truecolor ? 24 : "auto"});
```

A page can style for each depth with media queries: `color-gamut`
matches `"rgb"`, `(color-index: 256)` matches `"256"`, and
`(color-index: 16)` matches `"ansi"`.

```css
.banner { background: navy; }

@media (color-gamut: srgb) {
	.banner { background: linear-gradient(to right, #1e3a8a, #9333ea); }
}

@media (color-index: 256) {
	.banner { background: #5f00af; }
}
```

## Text attributes

| Property | Terminal attribute |
| --- | --- |
| `font-weight` at 600 or more, `bold`, `bolder` | Bold |
| `font-weight` at 300 or less, `lighter` | Dim |
| `font-style: italic` | Italic |
| `text-decoration-line: underline` | Underline |
| `text-decoration-line: overline` | Overline, on a terminal that draws one |
| `text-decoration-line: line-through` | Strikethrough |
| `text-decoration-style: double` | Double underline, on a terminal that draws one; a single underline elsewhere |
| `text-transform` | `uppercase`, `lowercase`, and `capitalize` change the characters at paint time |

`text-decoration-color`, `text-decoration-thickness`, `letter-spacing`,
and `word-spacing` have no effect. A line takes `line-height` divided by
`font-size` rows, rounded down and at least one, so `1.5` is one row and
`2` is two.

Terminals differ in how they draw italic and dim, and some draw
neither. A design that must read the same everywhere uses color.

## Borders

`border` takes one cell per side and draws with box-drawing characters.
The style picks the glyph set:

| Style | Glyphs |
| --- | --- |
| `solid`, and `groove`, `ridge`, `inset`, `outset` | `─ │ ┌ ┐ └ ┘` |
| `double` | `═ ║ ╔ ╗ ╚ ╝` |
| `dashed` | `╌ ┆` |
| `dotted` | `┄ ┊` |
| `hidden`, `none` | Nothing |

The three shaded styles draw as `solid` because a terminal has one
weight of line. Any `border-radius` above zero rounds the corners to
`╭ ╮ ╰ ╯`. A width above `1px` is still one cell.

Borders that meet in a cell join. A rule that reaches a box's side ends
in `├` or `┤`, a column divider crossing it makes `┬` or `┴`, and two
crossing rules make `┼`. Table borders collapse this way by default,
and so do a `fieldset` and its `legend`.

`outline` draws in the ring a border would occupy when the box has a
border, recoloring it. A box without a border gets an overline along its
top row and an underline along its bottom, so the outline takes no
space. `outline-offset` has no effect.

`visibility: hidden` leaves the box's space and paints nothing in it.

## Generated content

`::before` and `::after` with a string `content` work; `counter()` in
`content` is not implemented. `::marker` styles a list item's bullet
and a `<summary>`'s arrow.
`list-style-type` draws `•`, `◦`, and `▪` for `disc`, `circle`, and
`square`, and the counting styles, `decimal`, `lower-roman`,
`upper-alpha`, and the rest, draw a number followed by a dot. An
`<ol start>` and an `<li value>` set the count as in a browser.

## Pseudo-classes and pseudo-elements

`:hover` matches the element under the mouse, and asking for it turns
on mouse motion reporting for as long as a rule needs it. `:focus`
and `:focus-visible` match the focused element. `:fullscreen`,
`:popover-open`, `:modal`, `:checked`, `:disabled`, `:placeholder-shown`,
`:dir()`, and the tree-structural pseudo-classes all match as in a
browser.

`::selection` styles selected text, and `::highlight()` styles the
ranges in `CSS.highlights`. `::placeholder` styles a text control's
placeholder. `::backdrop` styles what a modal dialog or popover covers.
A `<select>`'s picker and icon take `::picker(select)` and
`::picker-icon`, and a `<details>`' content takes `::details-content`.
A `<progress>` fills with its `accent-color`. `::part()` from a page
does not reach inside the built-in controls, as in a browser.

## Default looks

The user-agent stylesheet gives HTML elements their terminal looks.
Any of them can be overridden by an ordinary rule.

| Element | Default |
| --- | --- |
| `b`, `strong`, `th`, `legend` | Bold |
| `i`, `em`, `cite`, `dfn`, `var` | Italic |
| `u` | Underline |
| `s` | Strikethrough |
| `kbd` | Bold and underlined |
| `small` | Dim |
| `code` | A dark background |
| `a[href]` | `LinkText` and underlined; inverse when focused |
| `hr` | A horizontal rule, one row |
| `pre` | `white-space: pre` |
| `fieldset`, `textarea`, `dialog`, `[popover]` | A solid border with `0 1ch` padding |
| `td`, `th` | A solid border with `0 1ch` padding, collapsed with the table's |
| `button` | The label between `[` and `]` |
| `summary` | `▸` closed and `▾` open, as its `::marker`; `list-style: none` hides it |
| `progress`, `meter` | A `10ch` bar, filled to the value over a gray track; `meter` is green, yellow, or red by how good the value is, and `progress` is blue |
| `input`, `select` | Inline, `white-space: pre` |
| `input[type=checkbox]`, `input[type=radio]` | `3ch` wide, `[x]` or `(x)` |
| `dialog:modal`, `[popover]` | Centered by `position: fixed` and auto margins, on a `Canvas` background |
| `math` | Inline; `display="block"` centers it |

Headings have no default size or weight, because there is no size.
Style them:

```css
h1 { font-weight: bold; text-decoration: underline; }
h2 { font-weight: bold; }
```

A focused element that does not edit text shows a solid outline. A
focused text field or editing host shows the terminal cursor at its
caret instead.

## What terminals disagree on

Some attributes depend on the terminal, and the engine finds out which
by asking it rather than by its name:

- Overline is drawn only where the terminal confirms it. MathML uses it
  for the bar of a root when it can, and an underlined row above the
  radicand otherwise.
- A double underline is sent so that a terminal that does not know the
  style still draws a single one.
- Emoji sequences are measured by grapheme cluster when the terminal
  says it does the same, and by code point otherwise, so a flag or a
  skin-toned hand is the same width to both.
- Right-to-left text is reordered by the engine unless the terminal
  says it reorders itself.
