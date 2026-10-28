---
title: Styling
description: How each CSS property maps to what a terminal can draw.
---

A terminal cell holds a character, a foreground color, a background
color, and a few attributes. Every CSS property maps to one of those or
does nothing. The [compatibility matrix](/compatibility/) lists which
properties are supported.

## Units

By default, `1px` and `1ch` are one cell: `width: 10px` is ten columns,
`height: 10px` ten rows. `em`, `rem`, and `ex` scale from `font-size`,
which defaults to `1`. Percentages, `vw`, `vh`, and `calc()` work.
Lengths round to whole cells.

A terminal has one font at one size, so `font-size` and `font-family`
don't change how text looks. `font-size` still sets `em`, `ex`, and
how many rows a `line-height` takes.

## Colors

`color` and `background-color` accept named colors, hex with 3, 4, 6,
or 8 digits, and `rgb()` and `hsl()` in either syntax.

A translucent `background-color` is blended with what the cell already
shows, or with the terminal's background. Alpha `0` paints nothing.
Gradient stops blend over the color beneath them.

System colors:

| Color | Meaning |
| --- | --- |
| `Canvas` | The terminal's background. A dialog or popover uses it to cover what's behind it. |
| `CanvasText` | The terminal's foreground. |
| `Highlight`, `HighlightText` | Inverse video, used by `::selection`. |
| `SelectedItem`, `SelectedItemText` | Inverse video. |
| `LinkText` | Blue, the color of `<a href>`. |
| `GrayText` | Gray. |

`linear-gradient()` paints each cell with the color at its center.
Stop positions take any length; `ch` counts along the gradient, so
`3ch` down a column is three rows. `radial-gradient()`, `url()`,
`opacity`, `filter`, `box-shadow`, and `mix-blend-mode` do nothing.

### Color depth

The `colorDepth` option sets how many colors TermDOM uses. Its values
are the bit counts `screen.colorDepth` reports:

| `colorDepth` | Colors | A CSS color is drawn |
| --- | --- | --- |
| `"auto"` (default) | Whatever the terminal reports | As one of the below |
| `24` | Any | Exactly |
| `8` | 256 | As the nearest of the 256 |
| `4` | 16 | As the nearest basic color |

`"rgb"`, `"256"`, and `"ansi"` are the same three depths.

With `"auto"`, TermDOM asks the terminal on `attach()`. It uses 24 if
the terminal reports 24-bit color or runs tmux, which converts it.
Otherwise it uses 8. It doesn't guess higher, because some terminals
show unsupported 24-bit color as hidden text.

Alacritty, Konsole, and VS Code's terminal support 24-bit color without
reporting it, but set `COLORTERM`. TermDOM doesn't read the
environment, but you can:

```ts
const truecolor =
	process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
const term = new TermDOM({colorDepth: truecolor ? 24 : "auto"});
```

Media queries match each depth: `color-gamut` for `"rgb"`,
`(color-index: 256)` for `"256"`, and `(color-index: 16)` for `"ansi"`.

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
| `font-weight` 600 or more, `bold`, `bolder` | Bold |
| `font-weight` 300 or less, `lighter` | Dim |
| `font-style: italic` | Italic |
| `text-decoration-line: underline` | Underline |
| `text-decoration-line: overline` | Overline, where the terminal draws one |
| `text-decoration-line: line-through` | Strikethrough |
| `text-decoration-style: double` | Double underline where supported, otherwise single |
| `text-transform` | `uppercase`, `lowercase`, and `capitalize` |

`text-decoration-color`, `text-decoration-thickness`, `letter-spacing`,
and `word-spacing` do nothing.

A line takes `line-height / font-size` rows, rounded down, at least
one: `1.5` is one row, `2` is two.

Terminals draw italic and dim inconsistently, and some don't draw them
at all. Use color when it has to look the same everywhere.

## Borders

A border takes one cell per side. The style picks the characters:

| Style | Glyphs |
| --- | --- |
| `solid`, `groove`, `ridge`, `inset`, `outset` | `─ │ ┌ ┐ └ ┘` |
| `double` | `═ ║ ╔ ╗ ╚ ╝` |
| `dashed` | `╌ ┆` |
| `dotted` | `┄ ┊` |
| `hidden`, `none` | Nothing |

Any `border-radius` above zero gives `╭ ╮ ╰ ╯` corners. Widths above
`1px` still take one cell.

Borders that meet in a cell join:

- A rule that reaches a box's side ends in `├` or `┤`.
- A divider that meets a box's top or bottom makes `┬` or `┴`.
- Two crossing rules make `┼`.

Table borders and a `fieldset`'s `legend` join this way by default.

`outline` recolors a box's border. On a box with no border, it draws
as an overline on the top row and an underline on the bottom row, and
takes no space. `outline-offset` does nothing.

`visibility: hidden` keeps the space and paints nothing.

## Generated content

`::before` and `::after` take string `content`. `counter()` isn't
supported.

`::marker` styles list bullets and the `<summary>` arrow.
`list-style-type` draws `•` for `disc`, `◦` for `circle`, and `▪` for
`square`. Counting styles such as `decimal`, `lower-roman`, and
`upper-alpha` draw a number and a dot. `<ol start>` and `<li value>`
set the count.

## Pseudo-classes and pseudo-elements

`:hover` matches the element under the mouse. While a rule uses it,
TermDOM turns on mouse motion reporting. `:focus` and `:focus-visible`
match the focused element. Also supported:

- `:fullscreen`, `:popover-open`, and `:modal`
- `:checked`, `:disabled`, and `:placeholder-shown`
- `:dir()`
- the tree-structural pseudo-classes

`::selection` styles selected text, `::highlight()` styles ranges in
`CSS.highlights`, `::placeholder` styles placeholders, and `::backdrop`
styles what a modal dialog or popover covers.

The built-in controls take these pseudo-elements:

- `<select>`: `::picker(select)` and `::picker-icon`.
- `<details>`: `::details-content`.
- `<progress>` and `<meter>`: `::slider-track` and `::slider-fill`.
- `<input type="range">`: `::slider-track`, `::slider-fill`, and
  `::slider-thumb`.

A meter matches `:optimal-value`, `:low-value`, or `:high-value` by
its level.

These names come from a CSS draft and may change. The API guide lists
the stable WebKit and Firefox names. `::part()` doesn't reach inside
the built-in controls.

`CSS.highlights.set("hit", new Highlight(...ranges))` colors ranges
through `::highlight(hit)`, which can set `color`, `background-color`,
and `text-decoration-line`. Highlights don't change layout. Where they
overlap, the higher `priority` wins, and `::selection` paints over all
of them. See `examples/highlights.ts`.

## Default styles

The user-agent stylesheet sets these, and any rule can override them:

| Element | Default |
| --- | --- |
| `b`, `strong`, `th`, `legend` | Bold |
| `i`, `em`, `cite`, `dfn`, `var` | Italic |
| `u` | Underline |
| `s` | Strikethrough |
| `kbd` | Bold and underlined |
| `small` | Dim |
| `code` | A faint tinted background |
| `a[href]` | `LinkText`, underlined; inverse when focused |
| `hr` | A one-row horizontal rule |
| `blockquote` | A solid left border with `1ch` padding |
| `pre` | `white-space: pre` |
| `fieldset`, `textarea`, `dialog`, `[popover]` | A solid border with `0 1ch` padding |
| `td`, `th` | A solid border with `0 1ch` padding, collapsed into the table's |
| `table[border="0"]` `td`, `th` | No border, for layout tables. Nested tables follow their own `border` |
| `button` | The label between `[` and `]` |
| `summary` | A `▸` marker when closed, `▾` when open; `list-style: none` hides it |
| `progress`, `meter` | A `10ch` bar over a gray track. `progress` is blue; `meter` is green, yellow, or red by level |
| `input`, `select` | Inline, `white-space: pre` |
| `input[type=checkbox]`, `input[type=radio]` | `3ch` wide, drawn as `[x]` or `(x)` |
| `input[type=range]` | A `20ch` slider: a blue fill and a `●` thumb over a gray track |
| `dialog:modal`, `[popover]` | Centered, `position: fixed`, on a `Canvas` background |
| `math` | Inline; `display="block"` centers it |

Headings have no default style, since a terminal has one font size:

```css
h1 { font-weight: bold; text-decoration: underline; }
h2 { font-weight: bold; }
```

A focused element shows a solid outline, except a text field or
editing host, which shows the cursor at its caret.

## Where terminals differ

TermDOM asks the terminal what it supports rather than checking its
name:

- Overlines are drawn only when the terminal confirms it supports them.
  Otherwise a MathML root draws an underlined row above the radicand.
- Double underlines are sent in a form that falls back to a single
  underline.
- Emoji sequences are measured by grapheme cluster when the terminal
  does the same, and by code point otherwise, so flags and skin-toned
  emoji line up.
- Right-to-left text is reordered unless the terminal does it.
