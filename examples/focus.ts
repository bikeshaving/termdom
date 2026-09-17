/**
 * Focus, control by control. Tab and Shift+Tab move it. A control that
 * edits text shows focus as the terminal cursor. Every other control
 * takes an outline, drawn as a line above and below it. The last row
 * names the focused element. q quits when focus is not in an input.
 */
import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document} = term;

document.body.innerHTML = `
  <style>
    body { padding: 0 2ch; }
    h1 { font-weight: bold; color: #5fafff; margin: 1em 0; }
    .row { display: flex; gap: 3ch; margin-bottom: 1em; }
    .note { color: #808080; }
  </style>
  <h1>Focus</h1>
  <div class="row">
    <input value="text field">
    <label><input type="checkbox"> check</label>
    <label><input type="radio" name="choice"> pick</label>
    <select><option>one</option><option>two</option></select>
  </div>
  <div class="row">
    <input type="submit" value="Go">
    <button>Save</button>
    <a href="#">a link</a>
    <details><summary>summary</summary>hidden</details>
  </div>
  <p class="note">focused: <span id="focused">none</span></p>
`;

const focused = document.getElementById("focused")!;
document.addEventListener("focusin", () => {
  const element = document.activeElement!;
  const type = element.getAttribute("type");
  focused.textContent =
    `<${element.localName}${type ? ` type=${type}` : ""}>`;
});

document.addEventListener("keydown", (event) => {
  const key = (event as KeyboardEvent).key;
  const target = event.target as HTMLElement;
  if (
    key === "q" && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA"
  ) {
    term.window.close();
  }
});
