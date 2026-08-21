TermDOM is a JavaScript/TypeScript library that renders HTML and CSS to the
terminal. It draws actual DOM nodes to terminal output and redraws the screen
when nodes are mutated, so TUIs and interactive CLIs can be written with
vanilla JavaScript or any frontend web framework or library.

![Klondike solitaire rendered by TermDOM](cast:solitaire)

Typical terminal UI libraries ask you to learn its widgets: a Box, a List, a
Screen, and the arbritrary APIs that go with them. By contrast, TermDOM
implements a real, spec-compliant DOM and CSSOM API. Make a div, style it, put
it in the body. Just like the browser there is no render call, and changes
paint on the next frame.

![examples/hello-world.ts](playground:hello-world)

## Styling

TermDOM runs your stylesheets and inline styles through a real cascade and
writes the computed styles to the screen as ANSI escape sequences. It resolves
colors against the terminal’s palette and draws text decorations as terminal
attributes: bold, italic, underline, strikethrough.

![examples/bar-chart.ts](playground:bar-chart)

## Layout

TermDOM lays out boxes with the browser’s algorithms — flexbox, grid, tables,
the box model — against a grid of character cells. The cell is the unit basis
for CSS lengths: `1px` and `1ch` both mean one cell. Text wraps at the edge of
its box and reflows when the terminal resizes.

![examples/flexbox.ts](playground:flexbox)

## Events

TermDOM decodes stdin’s escape sequences into DOM events and dispatches them
at real targets: `keydown` at the focused element, `click` on the element
under the pointer, `paste` with the pasted text. Tab moves focus, and `:focus`
styles follow it.

![examples/form.ts](playground:form)

## Libraries & Frameworks

The payoff of implementing a real DOM is that you can use browser libraries in
the terminal without modification. TermDOM also works with most frontend
frameworks with [a little bit of setup](/guides/getting-started/#frameworks).

![examples/prism.ts](playground:prism)

## Compatibility

TermDOM tries to follow web specifications as closely as possible, diverging
only when concepts wouldn’t make sense in the terminal. You can track which
browser features are implemented via the [compatibility
table](/compatibility/).

## Get started

```sh
npm install @b9g/termdom
```

Read the [getting started guide](/guides/getting-started/), poke at an example
in the [playground](/playground/), or read the source on
[GitHub](https://github.com/bikeshaving/termdom).
