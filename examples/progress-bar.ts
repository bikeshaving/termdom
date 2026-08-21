import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();

// The document is a real DOM document.
const {document} = term;
document.body.innerHTML = `
  <style>
    .card { border: 1px solid #5fafff; padding: 0 1ch; width: 36ch; }
    .title { color: #5fafff; font-weight: bold; }
    .done { color: green; }
    .rest { color: #444; }
    .pct { color: #888; }
  </style>
  <div class="card">
    <div class="title">Installing</div>
    <div>
      <span class="done" id="done"></span><span class="rest" id="rest"></span>
      <span class="pct" id="pct"></span>
    </div>
  </div>
`;

const done = document.getElementById("done") as HTMLElement;
const rest = document.getElementById("rest") as HTMLElement;
const pct = document.getElementById("pct") as HTMLElement;

// TermDOM observes mutations and re-renders automatically.
let n = 0;
setInterval(() => {
	n = (n + 1) % 101;
	const cells = Math.round(n / 4);
	done.textContent = "█".repeat(cells);
	rest.textContent = "░".repeat(25 - cells);
	pct.textContent = String(n).padStart(3) + "%";
}, 50);
