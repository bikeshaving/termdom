/**
 * TeX rendered by KaTeX, the browser library, unmodified. KaTeX is asked
 * for its MathML output instead of its HTML output, and TermDOM lays the
 * MathML out on the cell grid: fractions stack over a bar, roots take an
 * overline, big operators carry their limits, fences stretch.
 *
 * Keys: up/down arrows or j/k scroll, q quits.
 */
import {TermDOM} from "@b9g/termdom";
import katex from "katex";

interface Formula {
  name: string;
  tex: string;
}

const FORMULAS: Formula[] = [
  {
    name: "Quadratic formula",
    tex: String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
  },
  {name: "Euler's identity", tex: String.raw`e^{i\pi} + 1 = 0`},
  {
    name: "Sum of squares",
    tex: String.raw`\sum_{k=1}^{n} k^2 = \frac{n(n+1)(2n+1)}{6}`,
  },
  {
    name: "Gaussian integral",
    tex: String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}`,
  },
  {
    name: "Binomial theorem",
    tex: String.raw`(x+y)^n = \sum_{k=0}^{n} \binom{n}{k} x^{n-k} y^k`,
  },
  {
    name: "Rotation matrix",
    tex: String.raw`R(\theta) = \begin{bmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{bmatrix}`,
  },
  {
    name: "Cauchy–Schwarz",
    tex: String.raw`\left| \sum_{i} a_i b_i \right|^2 \le \sum_{i} a_i^2 \sum_{i} b_i^2`,
  },
  {
    name: "Fourier transform",
    tex: String.raw`\hat{f}(\xi) = \int_{-\infty}^{\infty} f(x)\, e^{-2\pi i x \xi}\, dx`,
  },
  {
    name: "Continued fraction",
    tex: String.raw`\varphi = 1 + \cfrac{1}{1 + \cfrac{1}{1 + \cfrac{1}{1 + \cdots}}}`,
  },
];

const term = new TermDOM();
term.attach();
const {document} = term;

document.head.innerHTML = `
  <style>
    body { padding: 0 2ch; }
    h1 { font-weight: bold; margin: 1em 0; }
    section { margin-bottom: 1em; }
    .tex { color: #808080; }
    math { color: #d7d7af; }
    /* Variables are italic by default, as in print. Terminals draw
       italics unevenly, so this sets them apart by color instead. */
    mi { text-transform: none; color: #87d7ff; }
    .help { color: #808080; margin-top: 1em; }
  </style>
`;

const title = document.createElement("h1");
title.textContent = "KaTeX → MathML → cells";
document.body.append(title);

for (const {name, tex} of FORMULAS) {
  const section = document.createElement("section");
  const heading = document.createElement("div");
  heading.textContent = name;
  const source = document.createElement("div");
  source.className = "tex";
  source.textContent = tex;
  const rendered = document.createElement("div");
  rendered.innerHTML = katex.renderToString(tex, {
    output: "mathml",
    displayMode: true,
    throwOnError: false,
  });
  section.append(heading, source, rendered);
  document.body.append(section);
}

const help = document.createElement("div");
help.className = "help";
help.textContent = "↑/↓ or j/k scroll · q quit";
document.body.append(help);

const bindings: Record<string, () => void> = {
  ArrowDown: () => term.window.scrollBy(0, 1),
  ArrowUp: () => term.window.scrollBy(0, -1),
  j: () => term.window.scrollBy(0, 1),
  k: () => term.window.scrollBy(0, -1),
  q: () => term.window.close(),
};
document.addEventListener("keydown", (event: Event) => {
  bindings[(event as KeyboardEvent).key]?.();
});
