// CodeMirror: a real code editor on a contenteditable host
//
//   node examples/codemirror.ts
//
//   Type to edit        Enter    new line, indented
//   Arrows              move     Esc      quit
//
// CodeMirror edits the document through the DOM: it renders lines into a
// contenteditable element, listens for beforeinput and watches the tree
// with a MutationObserver, and reads the selection back through
// getSelection(). Nothing here is adapted for the terminal except the
// theme, which turns its pixel paddings into cells.
import {TermDOM} from "@b9g/termdom";
import {defaultKeymap, history, historyKeymap} from "@codemirror/commands";
import {javascript} from "@codemirror/lang-javascript";
import {defaultHighlightStyle, syntaxHighlighting} from "@codemirror/language";
import {EditorSelection, EditorState} from "@codemirror/state";
import {EditorView, keymap, lineNumbers} from "@codemirror/view";

const term = new TermDOM();
term.attach();
const {document, window} = term;

// CodeMirror reads these as globals.
for (const name of [
  "document",
  "window",
  "navigator",
  "Window",
  "Node",
  "Element",
  "Text",
  "Range",
  "Selection",
  "MutationObserver",
  "ResizeObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  Object.defineProperty(globalThis, name, {
    value: (window as unknown as Record<string, unknown>)[name],
    configurable: true,
    writable: true,
  });
}

document.head.innerHTML = `
  <style>
    h1 { color: cyan; }
    .status { color: #808080; height: 1em; }
    .hint { color: #808080; }
  </style>`;
document.body.innerHTML = `
  <h1>CodeMirror</h1>
  <div id="editor"></div>
  <p class="status"></p>
  <p class="hint">Esc quits.</p>`;

const theme = EditorView.theme(
  {
    "&": {backgroundColor: "#101418", color: "#d0d0d0"},
    ".cm-scroller": {lineHeight: "1"},
    ".cm-content": {padding: "0", caretColor: "white"},
    ".cm-line": {padding: "0 1ch"},
    ".cm-gutters": {
      backgroundColor: "#101418",
      color: "#606060",
      borderRight: "1px solid #303030",
      minWidth: "4ch",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 1ch 0 0",
      minWidth: "3ch",
    },
    ".cm-activeLine": {backgroundColor: "#1a2028"},
    ".cm-activeLineGutter": {backgroundColor: "#1a2028"},
  },
  {dark: true},
);

// CodeMirror's own line moves probe half a text height at a time, and a
// line here is one cell tall, so half of it rounds to nothing. These move
// by a whole line instead.
function moveLine(
  forward: boolean,
  extend: boolean,
): (view: EditorView) => boolean {
  return (view: EditorView): boolean => {
    const {selection} = view.state;
    const ranges = selection.ranges.map((range) => {
      const moved = view.moveVertically(range, forward, view.defaultLineHeight);
      return extend ? EditorSelection.range(range.anchor, moved.head) : moved;
    });
    view.dispatch({
      selection: EditorSelection.create(ranges, selection.mainIndex),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

const lineKeys = keymap.of([
  {key: "ArrowUp", run: moveLine(false, false), shift: moveLine(false, true)},
  {key: "ArrowDown", run: moveLine(true, false), shift: moveLine(true, true)},
]);

const status = document.querySelector(".status")!;
const view = new EditorView({
  state: EditorState.create({
    doc: [
      "function greet(name) {",
      "  const hour = new Date().getHours();",
      "  const part = hour < 12 ? \"morning\" : \"afternoon\";",
      "  return `Good ${part}, ${name}!`;",
      "}",
      "",
      "console.log(greet(\"world\"));",
      "",
    ].join("\n"),
    extensions: [
      lineNumbers(),
      history(),
      lineKeys,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      javascript(),
      syntaxHighlighting(defaultHighlightStyle),
      theme,
      EditorView.updateListener.of((update) => {
        const {head} = update.state.selection.main;
        const line = update.state.doc.lineAt(head);
        status.textContent =
          `Ln ${line.number}, Col ${head - line.from + 1}  ` +
          `${update.state.doc.lines} lines`;
      }),
    ],
  }),
  parent: document.getElementById("editor")!,
});
view.focus();
view.dispatch({selection: {anchor: 0}});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    window.close();
  }
});
