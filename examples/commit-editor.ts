// A commit-message composer: one <select>, one <input>, one <textarea> --
// all three form widgets, each rendering through its UA-internal shadow
// tree. Nothing here is a special mode: the select's label and ▾, the
// input's placeholder and faint blank, and the textarea's soft-wrapped
// multiline value are all real DOM styled by real (UA and author) CSS.
//
// The textarea is the star: newlines are hard breaks, long lines soft-wrap
// at the field edge (white-space: pre-wrap), the box grows with the text,
// and Up/Down walk VISUAL lines with the browser's goal-column memory.
// The <input> stays single-line by spec -- assigning it a value with a
// newline strips it, which is exactly why <textarea> exists.
//
//   node examples/commit-editor.ts
//
//   Tab/Shift+Tab  move between fields
//   ↑/↓            change type (in select) / move by line (in textarea)
//   Enter          newline (in textarea)
//   Ctrl+C         quit

import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
  .editor { padding: 1 2ch; }
  .title { color: cyan; font-weight: bold; }
  .row { display: flex; flex-direction: row; gap: 1ch; padding: 1 0 0 0; }
  .label { color: #888; width: 9ch; }
  input#subject { width: 50ch; }
  textarea#body { width: 62ch; }
  textarea#body::placeholder { color: #556; }
  .counter { color: #666; }
  .counter.over { color: red; font-weight: bold; }
  .status { color: #888; padding: 1 0 0 0; }
  .hint { color: #666; padding: 1 0 0 0; }
`;
document.head.appendChild(style);

const editor = document.createElement("div");
editor.className = "editor";
editor.innerHTML = `
  <div class="title">Compose commit</div>
  <div class="row"><div class="label">Type</div><select id="type"><option value="feat">feat</option><option value="fix">fix</option><option value="docs">docs</option><option value="refactor">refactor</option><option value="test">test</option><option value="chore">chore</option></select><div class="counter" id="counter"></div></div>
  <div class="row"><div class="label">Subject</div><input id="subject" placeholder="imperative, ≤50 chars, no period"></div>
  <div class="row"><div class="label">Body</div><textarea id="body" rows="5" cols="60" placeholder="What and why -- wrapped for you at the field edge; blank line between paragraphs."></textarea></div>
  <div class="status" id="status"></div>
  <div class="hint">tab moves · ↑/↓ changes type / walks lines · ctrl+c quits</div>
`;
document.body.appendChild(editor);

const type = document.getElementById("type") as HTMLSelectElement;
const subject = document.getElementById("subject") as HTMLInputElement;
const body = document.getElementById("body") as HTMLTextAreaElement;
const counter = document.getElementById("counter")!;
const status = document.getElementById("status")!;

function update(): void {
	const headline = `${type.value}: ${subject.value}`;
	const over = headline.length > 50;
	counter.textContent = `${headline.length}/50`;
	counter.className = over ? "counter over" : "counter";
	const bodyLines = body.value ? body.value.split("\n").length : 0;
	status.textContent = subject.value	  ?
		`→ ${headline}${bodyLines ? `  (+${bodyLines} body line${bodyLines === 1 ? "" : "s"})` : ""}`	  :
		"";
}

type.addEventListener("change", update);
subject.addEventListener("input", update);
body.addEventListener("input", update);
update();

subject.focus();
