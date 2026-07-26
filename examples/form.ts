#!/usr/bin/env bun
// A form, written like a web page: <input> elements, focus(), "input" events,
// and a live preview that re-renders as you type. Everything interactive here
// is the DOM's own machinery -- Tab/Shift+Tab move focus, arrows and
// Home/End/Backspace edit, and typing lands in whichever input is focused.
//
//   bun examples/form.ts
//
//   Tab/Shift+Tab  next/previous field    Enter  submit    Ctrl+C  quit
import {TermDOM} from "../src/internal/termdom.js";

const termdom = new TermDOM();
const {document} = termdom;

const style = document.createElement("style");
style.textContent = `
  .form { padding: 1ch 2ch; }
  .title { color: cyan; font-weight: bold; }
  .field { display: flex; flex-direction: row; padding: 1 0 0 0; }
  .label { color: white; width: 8ch; padding: 1 0 0 0; }
  input { background: #1d3557; color: white; width: 28ch; }
  input:focus { background: #264f78; }
  .preview { color: #888; padding: 1 0 0 0; }
  .done { color: green; font-weight: bold; padding: 1 0 0 0; }
  .hint { color: #666; padding: 1 0 0 0; }
`;
document.head.appendChild(style);

const form = document.createElement("div");
form.className = "form";
form.innerHTML = `
  <div class="title">New profile</div>
  <div class="field"><div class="label">Name</div><input id="name" type="text"></div>
  <div class="field"><div class="label">Email</div><input id="email" type="text"></div>
  <div class="field"><div class="label">Handle</div><input id="handle" type="text"></div>
  <div class="preview" id="preview"></div>
  <div class="done" id="done"></div>
  <div class="hint">tab next field · enter submit · ctrl+c quit</div>
`;
document.body.appendChild(form);

const fields = ["name", "email", "handle"].map(
	(id) => document.getElementById(id) as HTMLInputElement,
);
const preview = document.getElementById("preview")!;
const done = document.getElementById("done")!;

function updatePreview(): void {
	const [name, email, handle] = fields.map((f) => f.value);
	preview.textContent =
		name || email || handle
			? `» ${name || "?"} <${email || "?"}> @${handle || "?"}`
			: "» start typing to build a profile";
	done.textContent = "";
}

// The standard event: fires on every edit, in any field.
for (const field of fields) {
	field.addEventListener("input", updatePreview);
}

document.addEventListener("keydown", (event: Event) => {
	if ((event as KeyboardEvent).key !== "Enter") return;
	const [name, email, handle] = fields.map((f) => f.value.trim());
	if (!name && !email && !handle) return;
	done.textContent = `✓ saved: ${name || "anonymous"} <${email || "n/a"}> @${handle || "n/a"}`;
	void termdom.render();
});

updatePreview();
fields[0].focus();
await termdom.render();
