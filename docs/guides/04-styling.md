---
title: Styling
description: How each CSS property maps to what a terminal can draw.
---

A terminal cell holds one character, a foreground color, a background
color, and a handful of attributes. Every CSS property either resolves
to one of those or has no effect. This guide explains the mapping. The
[compatibility matrix](/compatibility/) lists which properties are
supported.

## Units

By default, `1px` and `1ch` are each one cell. The property decides the
axis: `width: 10px` is ten columns, and `height: 10px` is ten rows.
`em`, `rem`, and `ex` scale from `font-size`, which is `1` by default,
so `1em` is also one cell. Percentages, `vw`, `vh`, and `calc()` work.
A length that falls between cells resolves to a whole cell.

A terminal draws one font at one size, so `font-size` and `font-family`
do not change how text looks. `font-size` still sets what `em` and `ex`
measure, and how many rows a `line-height` takes.

## Colors

`color` and `background-color` accept:

- named colors
- hex colors with three, four, six, or eight digits
- `rgb()` and `hsl()`, in both the comma form and the modern
  space-separated form with `/ alpha`

A cell has no alpha. TermDOM blends a translucent `background-color`
with what the cell already shows and gives the cell the result. Where
nothing has been painted, it blends with the terminal's own background.
A color with alpha `0` paints nothing. In a gradient, each stop
composites over the color beneath it.

In a terminal, the system colors mean the following:

| Color | Meaning |
| --- | --- |
| `Canvas` | The terminal's own background. A box with `background-color: Canvas` clears to it. This is how a dialog or popover covers what is behind it. |
| `CanvasText` | The terminal's own foreground. |
| `Highlight`, `HighlightText` | Inverse video. `::selection` uses this pair. |
| `SelectedItem`, `SelectedItemText` | Also inverse video. |
| `LinkText` | Blue, the color of `<a href>`. |
| `GrayText` | Gray. |

A `background-image` with a `linear-gradient()` paints each cell with
the gradient's color at that cell's center. A stop's position can be any
length, and TermDOM measures it like every other length. `ch` counts
along the gradient's direction, so `3ch` down a column is three rows.
`radial-gradient()` and `url()` have no effect. Neither do `opacity`,
`filter`, `box-shadow`, and `mix-blend-mode`.

### Color depth

Terminals differ in how many colors they can show. The `colorDepth`
option sets how many colors TermDOM draws with. Its values are bit
counts, the same numbers `screen.colorDepth` reports:

| `colorDepth` | Colors | How a CSS color is drawn |
| --- | --- | --- |
| `"auto"` (default) | What the terminal reports | As one of the three below |
| `24` | Any color | Exactly |
| `8` | 256 | As the closest of the 256 |
| `4` | 16 basic colors | As the closest basic color |

The strings `"rgb"`, `"256"`, and `"ansi"` name the same three depths.

With `"auto"`, TermDOM asks the terminal when `attach()` runs. It uses
24 if the terminal reports 24-bit color. It also uses 24 inside tmux,
because tmux converts 24-bit color for the terminal it runs in.
Otherwise it uses 8, which every terminal in use supports. TermDOM does
not guess, because a terminal without 24-bit color can show a 24-bit
color as something else, such as hidden text.

Some terminals have 24-bit color but do not report it. Alacritty,
Konsole, and VS Code's terminal are among them. Most of these terminals
set the `COLORTERM` environment variable to `truecolor`. TermDOM does
not read the environment, but a program can read it and pass the
result:

```ts
const truecolor =
	process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit";
const term = new TermDOM({colorDepth: truecolor ? 24 : "auto"});
```

A page can style for each depth with media queries:

- `color-gamut` matches `"rgb"`.
- `(color-index: 256)` matches `"256"`.
- `(color-index: 16)` matches `"ansi"`.

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
| `text-decoration-style: double`, or `text-decoration: underline double` | Double underline on a terminal that draws one, and a single underline on other terminals |
| `text-transform` | `uppercase`, `lowercase`, and `capitalize` change the characters when the engine paints them |

`text-decoration-color`, `text-decoration-thickness`, `letter-spacing`,
and `word-spacing` have no effect.

A line takes `line-height` divided by `font-size` rows. The engine
rounds the result down, with a minimum of one row. So `1.5` is one row
and `2` is two rows.

Terminals differ in how they draw italic and dim, and some draw
neither. If a design must look the same on every terminal, use color
instead.

## Borders

`border` takes one cell per side and draws with box-drawing characters.
The border style picks the set of characters:

| Style | Glyphs |
| --- | --- |
| `solid`, and `groove`, `ridge`, `inset`, `outset` | `─ │ ┌ ┐ └ ┘` |
| `double` | `═ ║ ╔ ╗ ╚ ╝` |
| `dashed` | `╌ ┆` |
| `dotted` | `┄ ┊` |
| `hidden`, `none` | Nothing |

The shaded styles (`groove`, `ridge`, `inset`, and `outset`) draw as
`solid`, because a terminal has only one line weight. Any
`border-radius` above zero rounds the corners to `╭ ╮ ╰ ╯`. A border
width above `1px` still takes one cell.

Borders that meet in a cell join:

- A rule that reaches a box's side ends in `├` or `┤`.
- A column divider that meets a box's top or bottom makes `┬` or `┴`.
- Two crossing rules make `┼`.

Table borders collapse this way by default. So do a `fieldset` and its
`legend`.

When a box has a border, `outline` recolors the cells of that border.
When a box has no border, the outline draws as an overline along the
box's top row and an underline along its bottom row, so it takes no
space. `outline-offset` has no effect.

`visibility: hidden` keeps the box's space but paints nothing in it.

## Generated content

`::before` and `::after` work with a string `content`. TermDOM does not
implement `counter()` in `content`.

`::marker` styles the bullet of a list item and the arrow of a
`<summary>`. `list-style-type` draws `•` for `disc`, `◦` for `circle`,
and `▪` for `square`. The counting styles, such as `decimal`,
`lower-roman`, and `upper-alpha`, draw a number followed by a dot. The
`start` attribute on `<ol>` and the `value` attribute on `<li>` set the
count, as they do in a browser.

## Pseudo-classes and pseudo-elements

`:hover` matches the element under the mouse. While any style rule uses
`:hover`, the engine turns on mouse motion reporting in the terminal.
`:focus` and `:focus-visible` match the focused element. These
pseudo-classes all match the same way they do in a browser:

- `:fullscreen`, `:popover-open`, and `:modal`
- `:checked`, `:disabled`, and `:placeholder-shown`
- `:dir()`
- the tree-structural pseudo-classes

`::selection` styles selected text, and `::highlight()` styles the
ranges in `CSS.highlights`. `::placeholder` styles the placeholder of a
text control. `::backdrop` styles the area that a modal dialog or
popover covers.

The built-in controls take these pseudo-elements:

- `<select>`: `::picker(select)` for the picker and `::picker-icon` for
  the icon.
- `<details>`: `::details-content` for the content.
- `<progress>` and `<meter>`: `::slider-track` and `::slider-fill`.
- `<input type="range">`: `::slider-track`, `::slider-fill`, and
  `::slider-thumb`.

A meter matches `:optimal-value`, `:low-value`, or `:high-value`
depending on its level.

These names come from a CSS draft and may still change. The API guide
lists the WebKit and Firefox names, which will not change. As in a
browser, `::part()` does not reach inside the built-in controls.

`CSS.highlights.set("hit", new Highlight(...ranges))` colors ranges
through `::highlight(hit)` rules. These rules can set `color`,
`background-color`, and `text-decoration-line`. Highlights do not add
elements or move a line break. Where highlights overlap, the one with
the higher `priority` wins, and `::selection` paints over all of them.
See `examples/highlights.ts`.

## Default looks

The user-agent stylesheet gives HTML elements their default look in the
terminal. An ordinary rule can override any of these defaults.

| Element | Default |
| --- | --- |
| `b`, `strong`, `th`, `legend` | Bold |
| `i`, `em`, `cite`, `dfn`, `var` | Italic |
| `u` | Underline |
| `s` | Strikethrough |
| `kbd` | Bold and underlined |
| `small` | Dim |
| `code` | A faint tint behind the text, blended with the background |
| `a[href]` | `LinkText` and underlined; inverse when focused |
| `hr` | A horizontal rule, one row tall |
| `blockquote` | A solid left border, with `1ch` of padding |
| `pre` | `white-space: pre` |
| `fieldset`, `textarea`, `dialog`, `[popover]` | A solid border with `0 1ch` padding |
| `td`, `th` | A solid border with `0 1ch` padding, collapsed with the table's border |
| `button` | The label between `[` and `]` |
| `summary` | A `::marker` of `▸` when closed and `▾` when open; `list-style: none` hides it |
| `progress`, `meter` | A `10ch` bar, filled to the value over a gray track. `progress` is blue. `meter` is green, yellow, or red depending on how good the value is |
| `input`, `select` | Inline, with `white-space: pre` |
| `input[type=checkbox]`, `input[type=radio]` | `3ch` wide, drawn as `[x]` or `(x)` |
| `input[type=range]` | A `20ch` slider over a gray track: a blue fill, then a `●` thumb at the value |
| `dialog:modal`, `[popover]` | Centered with `position: fixed` and auto margins, on a `Canvas` background |
| `math` | Inline; `display="block"` centers it |

Headings have no default style, because a terminal has only one font
size. Style them yourself:

```css
h1 { font-weight: bold; text-decoration: underline; }
h2 { font-weight: bold; }
```

A focused element that does not edit text shows a solid outline. A
focused text field or editing host shows the terminal cursor at its
caret instead.

## What terminals disagree on

Some attributes depend on the terminal. The engine finds out what the
terminal supports by asking it, not by checking its name:

- The engine draws an overline only when the terminal confirms that it
  supports one. MathML uses an overline for the bar of a root when it
  can. Otherwise it draws an underlined row above the radicand.
- The engine sends a double underline in a form that still draws as a
  single underline on a terminal that does not know the double style.
- The engine measures emoji sequences by grapheme cluster when the
  terminal says it does the same, and by code point otherwise. This way
  the engine and the terminal agree on the width of a flag or a
  skin-toned hand.
- The engine reorders right-to-left text, unless the terminal says it
  reorders that text itself.
