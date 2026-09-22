/**
 * TeX rendered by KaTeX, the browser library, unmodified. KaTeX is asked
 * for its MathML output instead of its HTML output, and TermDOM lays the
 * MathML out on the cell grid: fractions stack over a bar, roots take an
 * overline, big operators carry their limits, fences stretch.
 *
 * The formulas walk every MathML Core element and the attributes that
 * change a rendering, one group at a time.
 *
 * Keys: up/down arrows or j/k scroll, space and b page, q quits.
 */
import {TermDOM} from "@b9g/termdom";
import katex from "katex";

interface Formula {
  name: string;
  tex: string;
}

interface Group {
  title: string;
  formulas: Formula[];
}

const GROUPS: Group[] = [
  {
    title: "Fractions and roots",
    formulas: [
      {
        name: "Quadratic formula",
        tex: String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`,
      },
      {
        name: "Continued fraction",
        tex: String.raw`\varphi = 1 + \cfrac{1}{1 + \cfrac{1}{1 + \cfrac{1}{1 + \cdots}}}`,
      },
      {
        name: "Nested and indexed roots",
        tex: String.raw`\sqrt{1 + \sqrt{2 + \sqrt{3}}} \ne \sqrt[3]{x^3 + y^3}`,
      },
      {
        name: "Partial derivatives",
        tex: String.raw`\frac{\partial f}{\partial x} + \frac{\partial^2 f}{\partial y^2} = \frac{\mathrm{d}}{\mathrm{d}t} g(t)`,
      },
      {
        name: "Binomial coefficient",
        tex: String.raw`\binom{n}{k} = \frac{n!}{k!\,(n-k)!}`,
      },
    ],
  },
  {
    title: "Big operators and limits",
    formulas: [
      {
        name: "Sum of squares",
        tex: String.raw`\sum_{k=1}^{n} k^2 = \frac{n(n+1)(2n+1)}{6}`,
      },
      {name: "Product", tex: String.raw`\prod_{i=1}^{n} i = n!`},
      {
        name: "Gaussian integral",
        tex: String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}`,
      },
      {
        name: "Contour and double integrals",
        tex: String.raw`\oint_C \vec{F} \cdot d\vec{r} = \iint_S (\nabla \times \vec{F}) \cdot d\vec{S}`,
      },
      {name: "Limit", tex: String.raw`\lim_{x \to 0} \frac{\sin x}{x} = 1`},
      {
        name: "Union and intersection",
        tex: String.raw`\bigcup_{i \in I} A_i \subseteq \bigcap_{j \in J} B_j`,
      },
      {
        name: "Fourier transform",
        tex: String.raw`\hat{f}(\xi) = \int_{-\infty}^{\infty} f(x)\, e^{-2\pi i x \xi}\, dx`,
      },
    ],
  },
  {
    title: "Scripts",
    formulas: [
      {name: "Euler's identity", tex: String.raw`e^{i\pi} + 1 = 0`},
      {
        name: "Nested scripts",
        tex: String.raw`e^{e^{x}} + x_{i_j} + a^{b}_{c}`,
      },
      {
        name: "Tensor indices",
        tex: String.raw`T^{ij}_{kl} = g^{im} g^{jn} T_{mnkl}`,
      },
      {
        name: "Prescripts",
        tex: String.raw`{}^{14}_{6}\mathrm{C} \to {}^{14}_{7}\mathrm{N} + e^- + \bar{\nu}_e`,
      },
      {
        name: "Binomial theorem",
        tex: String.raw`(x+y)^n = \sum_{k=0}^{n} \binom{n}{k} x^{n-k} y^k`,
      },
    ],
  },
  {
    title: "Fences, matrices and tables",
    formulas: [
      {
        name: "Rotation matrix",
        tex: String.raw`R(\theta) = \begin{bmatrix} \cos\theta & -\sin\theta \\ \sin\theta & \cos\theta \end{bmatrix}`,
      },
      {
        name: "Determinant",
        tex: String.raw`\det A = \begin{vmatrix} a & b \\ c & d \end{vmatrix} = ad - bc`,
      },
      {
        name: "Identity matrix",
        tex: String.raw`I_3 = \begin{pmatrix} 1 & 0 & 0 \\ 0 & 1 & 0 \\ 0 & 0 & 1 \end{pmatrix}`,
      },
      {
        name: "Piecewise function",
        tex:
          String.raw`|x| = \begin{cases} x & x \ge 0 \\ -x & x < 0 \end{cases}`,
      },
      {
        name: "Ruled array",
        tex: String.raw`\begin{array}{c|cc} n & 1 & 2 \\ \hline n^2 & 1 & 4 \\ n^3 & 1 & 8 \end{array}`,
      },
      {
        name: "Cauchy–Schwarz",
        tex: String.raw`\left| \sum_{i} a_i b_i \right|^2 \le \sum_{i} a_i^2 \sum_{i} b_i^2`,
      },
      {
        name: "Stretched fences",
        tex: String.raw`\left\{ \frac{a}{b} \right\} \left\lfloor \frac{c}{d} \right\rfloor \left\langle \frac{e}{f} \right\rangle`,
      },
    ],
  },
  {
    title: "Accents, arrows and braces",
    formulas: [
      {
        name: "Accents",
        tex: String.raw`\hat{f} + \bar{z} + \tilde{q} + \dot{x} + \ddot{y} + \vec{v} + \overline{AB} + \underline{w}`,
      },
      {
        name: "Overbrace and underbrace",
        tex: String.raw`\overbrace{a + b + c}^{n\text{ terms}} = \underbrace{d + e}_{m}`,
      },
      {
        name: "Labelled arrows",
        tex: String.raw`A \xrightarrow{f} B \xleftarrow{g} C \iff A \Longleftrightarrow C`,
      },
    ],
  },
  {
    title: "Alphabets, text and style",
    formulas: [
      {
        name: "Letterlike alphabets",
        tex: String.raw`\mathbb{N} \subset \mathbb{Z} \subset \mathbb{Q} \subset \mathbb{R} \subset \mathbb{C}, \quad \mathcal{L}, \mathfrak{g}, \mathscr{H}`,
      },
      {
        name: "Bold, roman and sans",
        tex: String.raw`\mathbf{v} = \mathrm{d}\mathbf{x} + \mathsf{A}\mathbf{u} + \mathit{t}`,
      },
      {
        name: "Text in math",
        tex: String.raw`\text{for all } x \in \mathbb{R}, \quad x^2 \ge 0 \text{ and } \operatorname{sinc}(x) = \frac{\sin x}{x}`,
      },
      {
        name: "Color",
        tex: String.raw`\color{#ff5f5f}{E} = \color{#87d7ff}{m} \color{#ffd787}{c^2}`,
      },
      {
        name: "Phantom and spacing",
        tex: String.raw`a\phantom{bbb}c \quad a\,b\;c\quad d\qquad e`,
      },
    ],
  },
  {
    title: "Relations and logic",
    formulas: [
      {
        name: "Set builder",
        tex: String.raw`S = \{\, x \in \mathbb{N} \mid x \equiv 1 \pmod 4 \,\}`,
      },
      {
        name: "Quantifiers",
        tex: String.raw`\forall \varepsilon > 0\; \exists \delta > 0 : |x - a| < \delta \implies |f(x) - f(a)| < \varepsilon`,
      },
      {
        name: "Inequalities",
        tex: String.raw`a \le b < c \ge d \ne e \approx f \equiv g \sim h \propto i`,
      },
    ],
  },
];

const term = new TermDOM();
term.attach();
const {document, window} = term;

document.head.innerHTML = `
  <style>
    body { padding: 0 2ch; }
    h1 { font-weight: bold; margin: 1em 0; }
    h2 { color: #ffaf00; font-weight: bold; margin: 1em 0 0; }
    section { margin-top: 1em; }
    .tex { color: #808080; }
    math { color: #d7d7af; }
    /* Variables are italic by default, as in print. Terminals draw
       italics unevenly, so this sets them apart by color instead. */
    mi { text-transform: none; color: #ffd787; }
    .help { color: #808080; margin-top: 1em; }
  </style>
`;

const title = document.createElement("h1");
title.textContent = "KaTeX → MathML → cells";
document.body.append(title);

for (const group of GROUPS) {
  const heading = document.createElement("h2");
  heading.textContent = group.title;
  document.body.append(heading);
  for (const {name, tex} of group.formulas) {
    const section = document.createElement("section");
    const caption = document.createElement("div");
    caption.textContent = name;
    const source = document.createElement("div");
    source.className = "tex";
    source.textContent = tex;
    const rendered = document.createElement("div");
    rendered.innerHTML = katex.renderToString(tex, {
      output: "mathml",
      displayMode: true,
      throwOnError: false,
    });
    section.append(caption, source, rendered);
    document.body.append(section);
  }
}

const help = document.createElement("div");
help.className = "help";
help.textContent = "↑/↓ or j/k scroll · space/b page · q quit";
document.body.append(help);

function page(): number {
  return Math.max(1, window.innerHeight - 1);
}

const bindings: Record<string, () => void> = {
  ArrowDown: () => window.scrollBy(0, 1),
  ArrowUp: () => window.scrollBy(0, -1),
  j: () => window.scrollBy(0, 1),
  k: () => window.scrollBy(0, -1),
  " ": () => window.scrollBy(0, page()),
  PageDown: () => window.scrollBy(0, page()),
  b: () => window.scrollBy(0, -page()),
  PageUp: () => window.scrollBy(0, -page()),
  q: () => window.close(),
};
document.addEventListener("keydown", (event: Event) => {
  bindings[(event as KeyboardEvent).key]?.();
});
