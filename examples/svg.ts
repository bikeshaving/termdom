import {TermDOM} from "@b9g/termdom";

const term = new TermDOM({csp: "img-src data:"});
term.attach();

const svg = (body: string, viewBox = "0 0 100 100") =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`,
  );

const landscape = svg(
  `
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b1464"/>
      <stop offset="0.6" stop-color="#c2255c"/>
      <stop offset="1" stop-color="#ff8c42"/>
    </linearGradient>
    <radialGradient id="sun">
      <stop offset="0" stop-color="#fff3b0"/>
      <stop offset="0.6" stop-color="#ffd75f"/>
      <stop offset="1" stop-color="#ff8c42" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="200" height="100" fill="url(#sky)"/>
  <circle cx="100" cy="70" r="34" fill="url(#sun)"/>
  <path d="M0 100 L0 72 L35 45 L60 66 L95 30 L140 70 L165 52 L200 78 L200 100 Z" fill="#141034"/>
  <path d="M95 30 L107 41 L99 44 L92 40 L86 44 Z" fill="#f4f1ff"/>
`,
  "0 0 200 100",
);

const flower = svg(
  `
  <style>.petal { fill: #e64980; fill-opacity: 0.75; stroke: #a61e4d; }</style>
  <defs><ellipse id="petal" class="petal" cx="50" cy="24" rx="11" ry="22"/></defs>
  <use href="#petal"/>
  <use href="#petal" transform="rotate(60 50 50)"/>
  <use href="#petal" transform="rotate(120 50 50)"/>
  <use href="#petal" transform="rotate(180 50 50)"/>
  <use href="#petal" transform="rotate(240 50 50)"/>
  <use href="#petal" transform="rotate(300 50 50)"/>
  <circle cx="50" cy="50" r="11" fill="#ffd43b" stroke="#e67700" stroke-width="2"/>
`,
);

const star = svg(
  `
  <polygon points="50,5 61,38 96,38 68,59 79,93 50,72 21,93 32,59 4,38 39,38"
    fill="#ffd43b" stroke="#f08c00" stroke-width="4" stroke-linejoin="round"/>
`,
);

const heart = svg(
  `
  <defs>
    <clipPath id="half"><rect x="0" y="0" width="50" height="100"/></clipPath>
  </defs>
  <path id="h" d="M50 88 C10 58 4 34 20 20 C34 9 47 18 50 30 C53 18 66 9 80 20 C96 34 90 58 50 88 Z" fill="#fa5252"/>
  <path d="M50 88 C10 58 4 34 20 20 C34 9 47 18 50 30 C53 18 66 9 80 20 C96 34 90 58 50 88 Z"
    fill="#c92a2a" clip-path="url(#half)"/>
`,
);

const rings = svg(
  `
  <g fill="none" stroke-width="7">
    <circle cx="30" cy="40" r="20" stroke="#4dabf7"/>
    <circle cx="70" cy="40" r="20" stroke="#69db7c"/>
    <circle cx="50" cy="62" r="20" stroke="#ffa94d" stroke-dasharray="10 6"/>
  </g>
  <line x1="8" y1="92" x2="92" y2="92" stroke="#868e96" stroke-width="3" stroke-linecap="round"/>
`,
);

term.document.body.innerHTML = `
  <style>
    body { margin: 0; padding: 1px 2ch; color: #888; }
    h2 { color: #5fafff; font-weight: bold; }
    .wide { display: block; width: 76ch; height: 19px; }
    .row { display: flex; flex-direction: row; gap: 2ch; padding-top: 1px; }
    .row img { width: 17ch; height: 8px; }
    .bars { display: block; width: 76ch; height: 6px; color: #4dabf7; }
    .bars .peak { fill: #ffa94d; }
  </style>
  <h2>SVG in &lt;img&gt;</h2>
  <div>gradients and paths</div>
  <img class="wide" src="${landscape}">
  <div class="row">
    <img src="${flower}">
    <img src="${star}">
    <img src="${heart}">
    <img src="${rings}">
  </div>
  <div>&lt;use&gt; and transforms · polygon and stroke · clip-path · dashes</div>
  <div>&lt;svg&gt; in the page, styled by the page and redrawn as it changes</div>
  <svg class="bars" viewBox="0 0 76 12" preserveAspectRatio="none">${
    Array.from({length: 19}, (_, i) => `<rect x="${i * 4}" width="3" fill="currentColor"/>`).join("")
  }</svg>
`;

const bars = [...term.document.querySelectorAll(".bars rect")];
let tick = 0;
setInterval(() => {
  tick++;
  let peak = bars[0];
  let most = 0;
  bars.forEach((bar, i) => {
    const height = 1 + Math.round(5 * (1 + Math.sin(tick / 4 + i / 2)));
    bar.setAttribute("y", String(12 - height));
    bar.setAttribute("height", String(height));
    bar.classList.remove("peak");
    if (height > most) {
      most = height;
      peak = bar;
    }
  });
  peak.classList.add("peak");
}, 200);
