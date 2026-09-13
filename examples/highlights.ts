// Highlights: find-in-page over a log pane with the CSS Custom Highlight API
//
//   node examples/highlights.ts
//
//   Type to search        Enter    next hit
//   Ctrl-p / Up           previous hit
//   Esc / Ctrl-c          quit
//
// Every hit is a Range in the `search-hit` highlight; the one you are on is
// also in `search-current`, registered at a higher priority so its style
// folds over the other. Nothing in the log is wrapped in a span and nothing
// is re-laid out as you move: highlights live downstream of layout.
import {TermDOM} from "@b9g/termdom";

const LEVELS = ["INFO", "WARN", "ERROR", "DEBUG"];
const MESSAGES = [
  "connection established to replica 3",
  "cache miss for key session:4821",
  "request timed out after 30s",
  "retrying connection to replica 3",
  "flushed 2048 records to disk",
  "user alice signed in",
  "user bob signed out",
  "connection reset by peer",
  "slow query took 4.2s",
  "cache warmed with 512 entries",
];

const lines = Array.from({length: 40}, (_, i) => {
  const level = LEVELS[i % LEVELS.length];
  const message = MESSAGES[i % MESSAGES.length];
  const stamp = `12:0${Math.floor(i / 10)}:${String(i % 60).padStart(2, "0")}`;
  return `${stamp} ${level.padEnd(5)} ${message}`;
});

const term = new TermDOM();
term.attach();
const {document} = term;
const {CSS, Highlight, NodeFilter} = term.window;

document.head.innerHTML = `
  <style>
    h1 { color: cyan; }
    .prompt { display: flex; flex-direction: row; }
    .prompt .sigil { color: #5fafff; }
    input { flex-grow: 1; }
    .status { color: #808080; }
    .log { height: 14em; overflow-y: scroll; border: 1px solid #444444;
           padding: 0 1ch; }
    .log div { color: #b0b0b0; }

    /* The two highlights. The current hit is registered at the higher
       priority, so where they overlap its rules win -- and because it sets
       no color of its own, the other layer's still shows through. */
    ::highlight(search-hit) { background-color: #ffd166; color: #111111; }
    ::highlight(search-current) { background-color: #f77f00;
                                  text-decoration-line: underline; }
  </style>
`;

document.body.innerHTML = `
  <h1>Find in page</h1>
  <div class="prompt"><span class="sigil">/&nbsp;</span></div>
  <p class="status"></p>
  <div class="log">${lines.map((line) => `<div>${line}</div>`).join("")}</div>
  <p>Enter for the next hit, Ctrl-p for the previous, Esc to quit.</p>
`;

const input = document.createElement("input");
input.autofocus = true;
input.setAttribute("placeholder", "type to search…");
document.querySelector(".prompt")!.appendChild(input);
const status = document.querySelector(".status")!;
const log = document.querySelector(".log")!;

const hits = new Highlight();
const current = new Highlight();
// Higher, so it folds over the plain hits where they cover the same cells.
current.priority = 1;
CSS.highlights.set("search-hit", hits);
CSS.highlights.set("search-current", current);

let found: Range[] = [];
let at = 0;

function search(query: string): Range[] {
  const ranges: Range[] = [];
  if (!query) {
    return ranges;
  }
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node as Text).data.toLowerCase();
    for (
      let i = text.indexOf(needle);
      i !== -1;
      i = text.indexOf(needle, i + needle.length)
    ) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

function show(): void {
  // Registering the ranges is the whole update. No element is touched, so
  // the tree the log laid out is the tree it keeps.
  hits.clear();
  current.clear();
  for (const range of found) {
    hits.add(range);
  }
  const here = found[at];
  if (here) {
    current.add(here);
    (here.startContainer.parentElement as Element).scrollIntoView({
      block: "nearest",
    });
  }
  status.textContent = found.length
    ? `${at + 1}/${found.length} matches for "${input.value}"`
    : input.value ? `no matches for "${input.value}"` : "";
}

function move(delta: number): void {
  if (found.length === 0) {
    return;
  }
  at = (at + delta + found.length) % found.length;
  show();
}

input.addEventListener("input", () => {
  found = search(input.value);
  at = 0;
  show();
});

document.addEventListener("keydown", (event: Event) => {
  const e = event as KeyboardEvent;
  if (e.key === "Escape" || (e.ctrlKey && e.key === "c")) {
    term.window.close();
  } else if (e.key === "Enter" || e.key === "ArrowDown") {
    move(1);
  } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
    move(-1);
  } else {
    return;
  }
  e.preventDefault();
});
