---
title: Introducing TermDOM
description: Build terminal apps with HTML, CSS, and DOM
date: 2026-09-22
publish: false
---

TermDOM is a JavaScript library that renders HTML and CSS to the terminal.
You give it a document, it draws the document as text, and it redraws when
the document changes. Everything else is the web platform you already know:
`document.createElement`, `querySelector`, `addEventListener`, `<style>`
elements, flexbox, forms, focus, scrolling, selection.

![Klondike solitaire rendered by TermDOM](cast:solitaire)

```sh
npm install @b9g/termdom
```

```ts
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

const {document} = term;
document.body.innerHTML = `
  <style>
    .card { border: 1px solid #5fafff; padding: 0 1ch; width: 36ch; }
    .title { color: #5fafff; font-weight: bold; }
    progress { width: 25ch; }
    progress::part(bar) { color: green; }
    progress::part(groove) { color: #444; }
  </style>
  <div class="card">
    <div class="title">Installing</div>
    <div><progress id="bar" max="100" value="0"></progress></div>
  </div>
`;

let n = 0;
setInterval(() => {
  n = (n + 1) % 101;
  document.getElementById("bar").value = n;
}, 50);
```

That is the whole program. There is no render loop to call and no
component model to learn. The document is a real DOM document, and TermDOM
watches it for mutations the way a browser does.

## Why

Terminal user interfaces are having a moment. Coding agents, package
managers, and deploy tools all run in the terminal now, and people expect
them to look and feel like software rather than like log output.

The libraries for building these interfaces each invent their own layout
system, their own styling props, and their own widget set. If you have
spent years learning CSS, none of that carries over. And the libraries
that do borrow from the web usually borrow one framework's component
model, so your React terminal app cannot use a Vue library, and neither
can use a plain DOM one.

The web platform already solved this. HTML describes structure, CSS
describes presentation, and the DOM lets any framework drive both. The
terminal is a grid of cells rather than a grid of pixels, but that is a
difference of units, not of kind.

## How it works

TermDOM implements the browser's rendering pipeline against a grid of
character cells. A cell is the unit for CSS lengths: `1px` and `1ch` both
mean one cell. On each frame the engine
recomputes style and layout for whatever changed, paints the result into a
cell buffer, diffs it against the previous frame, and writes the
difference to stdout as escape sequences. Keyboard, mouse, and paste
input arrive on stdin and are dispatched as DOM events.

The DOM and CSSOM implementations run against the Web Platform Tests. At
the time of writing they pass about 100,000 DOM subtests and about 3,000
CSSOM subtests, and the numbers are checked in as
[docs](https://github.com/bikeshaving/termdom/tree/main/docs).

The guiding rule is that when the browser has an answer, TermDOM gives
the same answer. Where the terminal has no way to do what the browser
does, TermDOM asks the terminal what it supports and does the closest
thing it can. It never guesses from environment variables or the name of
the terminal.

## What you get

- **Stylesheets.** CSS from `<style>` elements and `style` attributes
  cascades and inherits as in the browser, translated to ANSI color and
  text decoration. Modern color syntax, gradients, and `::part` all work.
- **Layout.** The box model, flexbox, grid, and tables, computed in whole
  cells, with margins, borders, and padding. `position: absolute`,
  `fixed`, and `sticky` do what they do on the web.
- **Text.** CJK, emoji, and combining characters take their correct
  widths. Hebrew and Arabic render in visual order with contextual shaping.
- **Forms.** `<input>`, `<textarea>`, `<select>`, checkboxes, radios, and
  `<progress>` have terminal-native looks that you can restyle with CSS.
  Tab order, `:focus`, and `FormData` work.
- **Events.** Keyboard, mouse, focus, scroll, and paste events fire on
  elements, the document, and the window. Links with `href` are clickable.
- **Editing.** `contenteditable` hosts, the `Selection` and `Range`
  APIs, `beforeinput`, and `MutationObserver` are all there. This is what
  lets a browser editor run unmodified.
- **Web Components.** `customElements.define()`, shadow roots, `<slot>`,
  and `:host`. The built-in controls are themselves shadow trees.
- **MathML.** Fractions stack over a bar, roots take an overline, big
  operators carry their limits, and fences stretch, all drawn with box
  characters.
- **Scrolling and fullscreen.** Tall documents scroll. Elements with
  `overflow: auto` scroll on their own. `requestFullscreen()` switches
  to the alternate screen and restores your shell on exit.

## The examples

The best argument for the approach is what runs without changes.

[TodoMVC](https://github.com/bikeshaving/termdom/blob/main/examples/todomvc.ts)
is the official vanilla JavaScript implementation with its component
code untouched. Only the stylesheet was swapped.

[CodeMirror](https://github.com/bikeshaving/termdom/blob/main/examples/codemirror.ts)
is the real thing: the editor that runs in browsers, rendering lines
into a `contenteditable` element, listening for `beforeinput`, watching
the tree with a `MutationObserver`, and reading the selection back with
`getSelection()`. The only adaptation is a theme that turns pixel
paddings into cells. Syntax highlighting, line numbers, undo history, and
the default keymap all just work.

[KaTeX](https://github.com/bikeshaving/termdom/blob/main/examples/katex.ts)
is asked for its MathML output, and TermDOM lays it out on the grid.

[React, Vue, Svelte, and Crank](https://github.com/bikeshaving/termdom/tree/main/examples)
each render a greeting and a keypress counter through their stock DOM
renderer. No terminal-specific reconciler is involved.

There is also a
[Hacker News reader](https://github.com/bikeshaving/termdom/blob/main/examples/hacker-news.ts),
a
[streaming chat client](https://github.com/bikeshaving/termdom/blob/main/examples/chat.ts),
a
[fuzzy file finder](https://github.com/bikeshaving/termdom/blob/main/examples/fuzzy-finder.ts),
an
[SSH server](https://github.com/bikeshaving/termdom/blob/main/examples/ssh.ts)
that gives every session its own document, and the solitaire game at the
top of this post. Most of them also run in the browser at
[termdom.org/examples](/examples/), from the same source files.

## Where it runs

TermDOM runs on Node, Bun, and Deno. It has no native dependencies, so a
terminal app can be compiled into a single binary with `bun build
--compile`. It works in tmux and over SSH.

## What is next

Scrollbars for scrolling elements, clickable links through OSC 8, and
images are the next things on the list. The engine is at version 0.1.8,
which means the API is still settling, but the parts of it that are the
web platform are as stable as the web platform.

TermDOM is MIT licensed. The code is at
[github.com/bikeshaving/termdom](https://github.com/bikeshaving/termdom).
