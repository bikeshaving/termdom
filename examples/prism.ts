/**
 * Syntax highlighting by Prism, the browser library, unmodified. It arrives
 * through the imports a web page writes: the library, then a grammar pack.
 *
 * Prism turns source text into markup -- `<span class="token keyword">`,
 * `<span class="token string">`, one class per kind of token. The stylesheet
 * below is a Prism CSS theme (Tomorrow Night), whose rules match those
 * classes and nothing else. TermDOM lays the markup out under the theme and
 * paints the result as cells. A web highlighter and a web stylesheet, drawn
 * in a terminal.
 *
 * Keys: left/right arrows or 1-4 pick the language, q quits.
 */
/* eslint-disable termdom/import-order -- Prism's language packs register on
   the global its core import creates, so the core has to load before them,
   which the rule's side-effect-first order would undo. */
import {TermDOM} from "@b9g/termdom";
// Each pack registers its grammar on the Prism it is imported beside. CSS and
// JavaScript ship in Prism's core, so only the rest need a line here.
import Prism from "prismjs";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-python.js";
/* eslint-enable termdom/import-order */

interface Sample {
	id: string;
	label: string;
	code: string;
}

// Samples are inline: nothing is read from disk, so the example runs in the
// browser playground as well as a terminal. Lines stay under 64 columns so
// they fit an 80-column screen beside the gutter.
const SAMPLES: Sample[] = [
	{
		id: "typescript",
		label: "TypeScript",
		code: `// Types are erased before the program runs. Tokens are not.
interface Point {
  x: number;
  y: number;
}

const ORIGIN: Point = {x: 0, y: 0};

export function distance(a: Point, b: Point = ORIGIN): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

const points: Point[] = [{x: 3, y: 4}, ORIGIN];
for (const point of points) {
  console.log(\`distance: \${distance(point).toFixed(2)}\`);
}`,
	},
	{
		id: "css",
		label: "CSS",
		code: `/* A Prism theme is author CSS: token classes in, colours out. */
:root {
  --ink: #cccccc;
  --paper: #2d2d2d;
}

.token.keyword,
.token.builtin {
  color: #cc99cd;
  font-weight: bold;
}

pre[class*="language-"] {
  background-color: var(--paper);
  padding: 0 1ch;
}

@media (max-width: 80ch) {
  .gutter { display: none; }
}`,
	},
	{
		id: "json",
		label: "JSON",
		code: `{
  "name": "@b9g/termdom",
  "version": "0.1.4",
  "private": false,
  "keywords": ["dom", "css", "terminal"],
  "engines": {"node": ">=20"},
  "scripts": {
    "test": "bun test",
    "lint": "eslint ."
  },
  "devDependencies": {
    "prismjs": "^1.30.0",
    "typescript": "^5.9.2"
  }
}`,
	},
	{
		id: "python",
		label: "Python",
		code: `# One grammar per language, one class per kind of token.
from dataclasses import dataclass

SUITS = "♠♥♦♣"


@dataclass
class Card:
    rank: int
    suit: str

    def label(self) -> str:
        names = {1: "A", 11: "J", 12: "Q", 13: "K"}
        return f"{names.get(self.rank, self.rank)}{self.suit}"


deck = [Card(rank, suit) for rank in range(1, 14) for suit in SUITS]
print(len(deck), deck[0].label(), deck[-1].label())`,
	},
];

const term = new TermDOM();

term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	body { background-color: #2d2d2d; color: #cccccc; }
	.tabs { display: flex; flex-direction: row; gap: 1ch; padding: 0 1ch; }
	.tab { color: #808080; padding: 0 1ch; }
	.tab.current { color: #2d2d2d; background-color: #cc99cd; font-weight: bold; }
	.pane { display: flex; flex-direction: row; padding: 1px 1ch; overflow: hidden; }
	.gutter { color: #666666; padding-right: 1ch; text-align: right; width: 3ch; }
	.hint { color: #666666; padding: 0 1ch; }

	/* Under 72 columns the gutter costs the source the room it needs, and
	   @media answers again on every resize. */
	@media (max-width: 72ch) {
		.gutter { display: none; }
	}

	/* Prism's Tomorrow Night theme, rule for rule. The selectors are the
	   classes Prism writes; the terminal resolves the hex to its palette. */
	.token.comment,
	.token.block-comment,
	.token.prolog,
	.token.doctype,
	.token.cdata { color: #999999; }
	.token.punctuation { color: #cccccc; }
	.token.tag,
	.token.attr-name,
	.token.namespace,
	.token.deleted { color: #e2777a; }
	.token.function-name { color: #6196cc; }
	.token.boolean,
	.token.number,
	.token.function { color: #f08d49; }
	.token.property,
	.token.class-name,
	.token.constant,
	.token.symbol { color: #f8c555; }
	.token.selector,
	.token.important,
	.token.atrule,
	.token.keyword,
	.token.builtin { color: #cc99cd; }
	.token.string,
	.token.char,
	.token.attr-value,
	.token.regex,
	.token.variable { color: #7ec699; }
	.token.operator,
	.token.entity,
	.token.url { color: #67cdcc; }
	.token.important,
	.token.bold { font-weight: bold; }
	.token.italic { font-style: italic; }
	.token.inserted { color: #7ec699; }
`;
document.head.appendChild(style);

const tabs = document.createElement("div");
tabs.className = "tabs";
const buttons = SAMPLES.map((sample, index) => {
	const tab = document.createElement("span");
	tab.className = "tab";
	tab.textContent = `${index + 1} ${sample.label}`;
	tabs.appendChild(tab);
	return tab;
});

const pane = document.createElement("div");
pane.className = "pane";
const gutter = document.createElement("pre");
gutter.className = "gutter";
const code = document.createElement("pre");
pane.append(gutter, code);

const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = "←/→ or 1-4 language · q quit";

document.body.append(tabs, pane, hint);

let current = 0;

// `pre` keeps white-space: pre and the pane clips what runs past the right
// edge, so a source line holds one row and the gutter's numbers stay level
// with it at any width.
function show(index: number): void {
	current = (index + SAMPLES.length) % SAMPLES.length;
	const sample = SAMPLES[current];
	buttons.forEach((tab, i) => {
		tab.className = i === current ? "tab current" : "tab";
	});
	const lines = sample.code.split("\n");
	gutter.textContent = lines.map((_, i) => String(i + 1)).join("\n");
	code.innerHTML = Prism.highlight(
		sample.code,
		Prism.languages[sample.id],
		sample.id,
	);
}

show(0);

const bindings: Record<string, () => void> = {
	ArrowRight: () => show(current + 1),
	ArrowLeft: () => show(current - 1),
	q: () => term.window.close(),
};
document.addEventListener("keydown", (event: Event) => {
	const {key} = event as KeyboardEvent;
	const picked = Number(key);
	if (picked >= 1 && picked <= SAMPLES.length) {
		show(picked - 1);
		return;
	}
	bindings[key]?.();
});
