# Markdown in the Terminal

A single document that exercises the whole element set, rendered from real
Markdown through the **marked** library into a real DOM.

## Inline formatting

Text can be **bold**, *italic*, ***both***, `inline code`, ~~struck through~~,
and a [labelled link](https://example.com). Links are underlined by the user
agent; Tab through the document to see a focus ring land on each one.

### Third-level heading
#### Fourth-level heading
##### Fifth-level heading
###### Sixth-level heading

## Lists

An unordered list, with nesting:

- First item
- Second item
  - A nested item
  - Another, with `code`
- Third item

An ordered list:

1. Parse the Markdown
2. Build the DOM
3. Render to cells

A task list (GitHub-flavoured, rendered as real checkboxes):

- [x] Write the parser adapter
- [x] Style the headings
- [ ] Add a fixed status line

## Blockquote

> The best way to predict the future is to invent it.
>
> Terminals are just very wide, very short web pages.

## Code block

```js
function greet(name) {
  return `Hello, ${name}!`;
}
console.log(greet("world"));
```

Syntax highlighting comes from Prism, another unmodified web library, across
languages:

```json
{
  "name": "termdom",
  "renders": ["markdown", "code"],
  "highlighted": true
}
```

## Table

| Element     | Display    | Notes                       |
| ----------- | ---------- | --------------------------- |
| `h1`–`h6`   | block      | themed bold, coloured       |
| `blockquote`| block      | left rule via `border-left` |
| `pre`       | block      | dark background, monospace  |
| `table`     | table      | ruled by the UA stylesheet  |

## Horizontal rule

Above the rule.

---

Below the rule.

## Wrapping

This final paragraph is deliberately long so that it wraps across several
terminal columns, demonstrating that inline text reflows to the viewport width
just as it would in a browser, breaking on word boundaries rather than spilling
off the right edge of the screen.
