#!/usr/bin/env node
// A fuzzy finder, fzf-style, written as a plain web page: a real <input> filters
// a list as you type, the arrows move a selection, Enter prints the pick and
// quits. The list is either the lines of a file you pass, or a recursive listing
// of the current directory.
//
//   node examples/fuzzy-finder.ts [file-with-lines]
//
//   type            filter          Up/Down, Ctrl-n/p   move selection
//   Enter           print & quit    Esc / Ctrl-c        cancel
import {TermDOM} from "@b9g/termdom";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

// ---- data source -------------------------------------------------------------
function walk(
	dir: string,
	prefix: string,
	out: string[],
	budget: number,
): void {
	if (out.length >= budget) {
		return;
	}
	let entries;
	try {
		entries = readdirSync(dir, {withFileTypes: true});
	} catch (_err) {
		return;
	}
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules") {
			continue;
		}
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			walk(join(dir, entry.name), rel, out, budget);
		} else {
			out.push(rel);
		}
		if (out.length >= budget) {
			return;
		}
	}
}

const arg = process.argv[2];
const items: string[] = [];
if (arg) {
	for (const line of readFileSync(arg, "utf8").split("\n")) {
		if (line.trim()) {
			items.push(line);
		}
	}
} else {
	walk(process.cwd(), "", items, 5000);
}

// ---- fuzzy match: subsequence with a light score (earlier, tighter = better) -
function score(item: string, query: string): number | null {
	if (!query) {
		return 0;
	}
	const hay = item.toLowerCase();
	const needle = query.toLowerCase();
	let i = 0;
	let first = -1;
	let last = -1;
	for (let j = 0; j < hay.length && i < needle.length; j++) {
		if (hay[j] === needle[i]) {
			if (first < 0) {
				first = j;
			}
			last = j;
			i++;
		}
	}
	if (i < needle.length) {
		return null;
	}
	// Prefer matches that start early and span few characters.
	return first + (last - first);
}

// ---- DOM ---------------------------------------------------------------------
const term = new TermDOM();
term.attach();
const {document} = term;

const style = document.createElement("style");
style.textContent = `
	.prompt { display: flex; flex-direction: row; }
	.prompt .sigil { color: #5fafff; }
	input { flex-grow: 1; }
	.status { color: #808080; }
	.results { margin-top: 1px; }
	.row { }
	.row.selected { background-color: #303030; }
	.row .mark { display: inline; color: #ff8700; }
	.row .text { display: inline; }
	.row.selected .text { font-weight: bold; }
`;
document.head.appendChild(style);

const prompt = document.createElement("div");
prompt.className = "prompt";
const sigil = document.createElement("span");
sigil.className = "sigil";
sigil.textContent = "\u203a\u00a0";
const input = document.createElement("input");
input.autofocus = true;
input.setAttribute("placeholder", "type to filter…");
prompt.append(sigil, input);

const status = document.createElement("div");
status.className = "status";

const results = document.createElement("div");
results.className = "results";

document.body.append(prompt, status, results);

let matches: string[] = [];
let selected = 0;

function rows(): HTMLElement[] {
	return Array.from(results.querySelectorAll<HTMLElement>(".row"));
}

function render(): void {
	const query = input.value;
	matches = query ?
			items
				.map((item) => ({item, s: score(item, query)}))
				.filter((m): m is {item: string; s: number} => m.s !== null)
				.sort((a, b) => a.s - b.s || a.item.length - b.item.length)
				.slice(0, 500)
				.map((m) => m.item) :
			items.slice(0, 500); // no query: original order

	selected = Math.max(0, Math.min(selected, matches.length - 1));
	results.textContent = "";
	for (const [i, item] of matches.entries()) {
		const row = document.createElement("div");
		row.className = "row";
		if (i === selected) {
			row.classList.add("selected");
		}
		const mark = document.createElement("span");
		mark.className = "mark";
		mark.textContent = i === selected ? "\u203a\u00a0" : "\u00a0\u00a0";
		const text = document.createElement("span");
		text.className = "text";
		text.textContent = item;
		row.append(mark, text);
		results.appendChild(row);
	}
	status.textContent = ` ${matches.length}/${items.length}`;
}

function setSelected(row: HTMLElement | undefined, on: boolean): void {
	if (!row) {
		return;
	}
	row.classList.toggle("selected", on);
	row.querySelector<HTMLElement>(".mark")!.textContent = on ?
		"\u203a\u00a0" :
		"\u00a0\u00a0";
}

function move(delta: number): void {
	if (matches.length === 0) {
		return;
	}
	const next = Math.max(0, Math.min(selected + delta, matches.length - 1));
	if (next === selected) {
		return;
	}
	// Only the two rows that changed: an arrow key is two rows of work, not
	// a walk over the whole list.
	const all = rows();
	setSelected(all[selected], false);
	setSelected(all[next], true);
	selected = next;
	all[selected]?.scrollIntoView();
}

async function finish(pick: string | null): Promise<void> {
	// dispose() resolves once the final flush has reached the terminal, so
	// the picked line prints below the paid-out UI, not into it.
	await term.dispose();
	if (pick !== null) {
		process.stdout.write(pick + "\n");
	}
	process.exit(pick === null ? 1 : 0);
}

// Filtering is the input's own `input` event -- the same event a web page hears.
input.addEventListener("input", () => {
	selected = 0;
	render();
});

// Navigation and commit live at the document level, so they work while the
// input keeps focus and its own editing keys (text, Backspace, Left/Right).
document.addEventListener("keydown", (event: Event) => {
	const e = event as KeyboardEvent;
	const ctrl = e.ctrlKey;
	if (e.key === "Escape" || (ctrl && e.key === "c")) {
		void finish(null);
	} else if (e.key === "Enter") {
		void finish(matches[selected] ?? null);
	} else if (e.key === "ArrowDown" || (ctrl && e.key === "n")) {
		move(1);
	} else if (e.key === "ArrowUp" || (ctrl && e.key === "p")) {
		move(-1);
	} else {
		return;
	}
	e.preventDefault();
});

render();

// Piped or redirected (no terminal): just print the current list and exit, so
// the example is inspectable without a TTY.
if (!process.stdout.isTTY) {
	term.window.close();
}
