TermDOM renders HTML and CSS in the terminal. It draws a real DOM and
redraws when it changes, so you can write terminal apps with plain
JavaScript or any frontend framework.

![Klondike solitaire rendered by TermDOM](cast:solitaire)

Most terminal UI libraries have their own widgets: a Box, a List, a
Screen, each with its own API. TermDOM implements the DOM and CSSOM
instead. Make a div, style it, and append it to the body. There's no
render call; changes paint on their own.

![examples/hello-world.ts](example:hello-world)

## Styling

Stylesheets and inline styles go through the cascade and are drawn
with ANSI escape sequences: colors from the terminal's palette, and
bold, italic, underline, and strikethrough as terminal attributes.

![examples/styling.ts](example:styling)

## Layout

Flexbox, grid, tables, and the box model lay out on a grid of
character cells, where `1px` and `1ch` are both one cell. Text wraps
and reflows when the terminal resizes.

![examples/flexbox.ts](example:flexbox)

## Events

Input becomes DOM events: `keydown` at the focused element, `click`
on the element under the pointer, `paste` with the pasted text. Tab
moves focus, and `:focus` styles follow.

![examples/form.ts](example:form)

## Libraries & Frameworks

Browser libraries work unmodified, and most frontend frameworks work
with [a little setup](/guides/getting-started/#frameworks).

![examples/prism.ts](example:prism)

## Compatibility

TermDOM follows web standards except where they make no sense in a
terminal. The [compatibility table](/compatibility/) lists what's
implemented.

## Get started

```sh
npm install @b9g/termdom
```

Read the [getting started guide](/guides/getting-started/), poke at an example
on the [examples page](/examples/), or read the source on
[GitHub](https://github.com/bikeshaving/termdom).
