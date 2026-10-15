// CodeMirror: a real code editor on a contenteditable host
//
//   node examples/codemirror.ts [file]
//
//   Type to edit        Enter    new line, indented
//   Arrows              move     Esc      quit
//
// CodeMirror edits the document through the DOM: it renders lines into a
// contenteditable element, listens for beforeinput and watches the tree
// with a MutationObserver, and reads the selection back through
// getSelection(). The terminal reports how many pixels a cell measures,
// so CodeMirror's pixel sizes and its viewport culling work as they do in
// a browser. Nothing here is adapted for the terminal but the colors.
import {readFileSync} from "node:fs";

import {installGlobals, TermDOM} from "@b9g/termdom";

const term = new TermDOM({cellSize: "auto"});
term.attach();
const {document} = term;

// CodeMirror reads document, window, getSelection and the rest as globals,
// and reads navigator when it loads to choose between Cmd and Ctrl, so the
// globals go in before it is imported.
installGlobals(term);
const {defaultKeymap, history, historyKeymap} = await import(
  "@codemirror/commands",
);
const {javascript} = await import("@codemirror/lang-javascript");
const {defaultHighlightStyle, syntaxHighlighting} = await import(
  "@codemirror/language",
);
const {EditorState} = await import("@codemirror/state");
const {EditorView, keymap, lineNumbers} = await import("@codemirror/view");

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
    // The focused editor edits text, so it shows the terminal cursor, not
    // the dotted outline the base theme draws around the wrapper.
    "&.cm-focused": {outline: "none"},
    ".cm-content": {caretColor: "white"},
    ".cm-gutters": {
      backgroundColor: "#101418",
      color: "#606060",
      borderRight: "1px solid #303030",
    },
    ".cm-activeLine": {backgroundColor: "#1a2028"},
    ".cm-activeLineGutter": {backgroundColor: "#1a2028"},
  },
  {dark: true},
);

const sample = [
  "function greet(name) {",
  "  const hour = new Date().getHours();",
  "  const part = hour < 12 ? \"morning\" : \"afternoon\";",
  "  return `Good ${part}, ${name}!`;",
  "}",
  "",
  "console.log(greet(\"world\"));",
  "",
].join("\n");
const file = process.argv[2];
const doc = file ? readFileSync(file, "utf8") : sample;

const status = document.querySelector(".status")!;
const view = new EditorView({
  state: EditorState.create({
    doc,
    extensions: [
      EditorState.tabSize.of(2),
      lineNumbers(),
      history(),
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
    term.window.close();
  }
});
