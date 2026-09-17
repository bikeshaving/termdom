import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

// The document is a real DOM document.
const {document} = term;
document.body.innerHTML = `
  <style>
    .card { border: 1px solid #5fafff; padding: 0 1ch; width: 36ch; }
    .title { color: #5fafff; font-weight: bold; }
    progress { width: 25ch; }
    progress::part(bar) { color: green; }
    progress::part(groove) { color: #444; }
    .pct { color: #888; }
  </style>
  <div class="card">
    <div class="title">Installing</div>
    <div>
      <progress id="bar" max="100" value="0"></progress>
      <span class="pct" id="pct"></span>
    </div>
  </div>
`;

const bar = document.getElementById("bar") as HTMLProgressElement;
const pct = document.getElementById("pct") as HTMLElement;

// TermDOM observes mutations and re-renders automatically.
let n = 0;
setInterval(() => {
  n = (n + 1) % 101;
  bar.value = n;
  pct.textContent = String(n).padStart(3) + "%";
}, 50);
