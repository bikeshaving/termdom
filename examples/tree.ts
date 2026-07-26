#!/usr/bin/env bun
// An interactive file tree, NERDTree-style, written as a plain web page:
// createElement, classList, dataset, addEventListener, scrollIntoView. The
// only terminal-specific line is setViewportMode("document") -- the tree is a
// document the user moves a camera over, not a transcript.
//
//   bun examples/tree.ts [dir]
//
//   j/k or arrows  move    Enter/l  expand or open    h  collapse or parent
//   g/G            top/bottom       .  toggle dotfiles    q  quit
import {TermDOM} from "../src/internal/termdom.js";
import {readdirSync} from "node:fs";
import {join, resolve} from "node:path";

const root = resolve(process.argv[2] ?? ".");
const termdom = new TermDOM();
const {document, window} = termdom;
termdom.setViewportMode("document");

const style = document.createElement("style");
style.textContent = `
  .header { color: cyan; font-weight: bold; }
  .hint { color: #666; }
  .row { }
  .row.selected { background: #264f78; font-weight: bold; }
  .marker { color: yellow; display: inline; }
  .name { display: inline; }
  .name.dir { color: cyan; font-weight: bold; }
  .name.link { color: magenta; }
  .name.dotted { color: #888; }
  .name.denied { color: red; }
  .count { color: #666; display: inline; }
`;
document.head.appendChild(style);

const header = document.createElement("div");
header.className = "header";
header.textContent = ` ${root}`;
const tree = document.createElement("div");
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = " j/k move · enter open · h up · . dotfiles · q quit";
document.body.append(header, tree, hint);

let showDotfiles = false;

interface Listing {
	name: string;
	path: string;
	isDir: boolean;
	isLink: boolean;
}

function list(dir: string): Listing[] {
	const entries = readdirSync(dir, {withFileTypes: true})
		.filter((e) => showDotfiles || !e.name.startsWith("."))
		.map((e) => ({
			name: e.name,
			path: join(dir, e.name),
			isDir: e.isDirectory(),
			isLink: e.isSymbolicLink(),
		}));
	// Directories first, each group alphabetical.
	return entries.sort(
		(a, b) =>
			Number(b.isDir) - Number(a.isDir) ||
			a.name.localeCompare(b.name, undefined, {sensitivity: "base"}),
	);
}

function makeRow(entry: Listing, depth: number): HTMLElement {
	const row = document.createElement("div");
	row.className = "row";
	row.dataset.path = entry.path;
	row.dataset.kind = entry.isDir ? "dir" : "file";
	row.style.paddingLeft = `${1 + depth * 2}ch`;

	const marker = document.createElement("span");
	marker.className = "marker";
	// Non-breaking spaces: a whitespace-only inline span would collapse away.
	marker.textContent = entry.isDir ? "▸ " : "\u00a0\u00a0";

	const name = document.createElement("span");
	name.className = "name";
	if (entry.isDir) name.classList.add("dir");
	if (entry.isLink) name.classList.add("link");
	if (entry.name.startsWith(".")) name.classList.add("dotted");
	name.textContent = entry.isDir ? `${entry.name}/` : entry.name;

	row.append(marker, name);
	return row;
}

// Each directory row is followed by a sibling container that holds its
// children while expanded. Collapse detaches the container; the built subtree
// rides along on the element for free when it is re-attached.
const childrenOf = new WeakMap<HTMLElement, HTMLElement>();

function fill(container: HTMLElement, dir: string, depth: number): void {
	for (const entry of list(dir)) {
		container.appendChild(makeRow(entry, depth));
	}
}

function expand(row: HTMLElement): void {
	if (row.dataset.kind !== "dir" || row.dataset.open === "true") return;
	let children = childrenOf.get(row);
	if (!children) {
		children = document.createElement("div");
		try {
			fill(children, row.dataset.path!, depthOf(row) + 1);
		} catch {
			row.querySelector(".name")!.classList.add("denied");
			return;
		}
		childrenOf.set(row, children);
	}
	row.after(children);
	row.dataset.open = "true";
	row.querySelector(".marker")!.textContent = "▾ ";
	updateCount();
}

function collapse(row: HTMLElement): void {
	if (row.dataset.open !== "true") return;
	childrenOf.get(row)?.remove();
	row.dataset.open = "false";
	row.querySelector(".marker")!.textContent = "▸ ";
	updateCount();
}

function depthOf(row: HTMLElement): number {
	// Reconstruct depth from the indent so rows carry no extra bookkeeping.
	return Math.floor((parseInt(row.style.paddingLeft) - 1) / 2);
}

function rows(): HTMLElement[] {
	// querySelectorAll returns document order, which is exactly visual order.
	return Array.from(document.querySelectorAll<HTMLElement>(".row"));
}

let selected = 0;

function select(index: number): void {
	const all = rows();
	selected = Math.max(0, Math.min(index, all.length - 1));
	for (const [i, row] of all.entries()) {
		row.classList.toggle("selected", i === selected);
	}
	updateCount();
}

function updateCount(): void {
	header.textContent = ` ${root} · ${rows().length} entries`;
}

function parentOf(row: HTMLElement): HTMLElement | undefined {
	const depth = depthOf(row);
	const all = rows();
	for (let i = all.indexOf(row) - 1; i >= 0; i--) {
		if (depthOf(all[i]) < depth) return all[i];
	}
	return undefined;
}

async function refresh(): Promise<void> {
	// getBoundingClientRect flushes pending mutations itself, so the camera can
	// be placed before the single paint -- one render per keystroke.
	rows()[selected]?.scrollIntoView();
	// At the first row, pull the camera the rest of the way up so the header
	// shows too -- scrollIntoView alone stops one row short of it.
	if (selected === 0) window.scrollBy(0, -document.body.scrollHeight);
	await termdom.render();
}

function rebuild(): void {
	tree.textContent = "";
	fill(tree, root, 0);
	select(Math.min(selected, rows().length - 1));
}

document.addEventListener("keydown", (event: Event) => {
	const key = (event as KeyboardEvent).key;
	const current = rows()[selected];
	if (key === "q") {
		termdom.dispose();
		process.exit(0);
	} else if (key === "j" || key === "ArrowDown") {
		select(selected + 1);
	} else if (key === "k" || key === "ArrowUp") {
		select(selected - 1);
	} else if (key === "g") {
		select(0);
	} else if (key === "G") {
		select(rows().length - 1);
	} else if (key === "Enter" || key === "l" || key === "ArrowRight") {
		if (current?.dataset.kind === "dir") {
			if (current.dataset.open === "true") collapse(current);
			else expand(current);
		}
	} else if (key === "h" || key === "ArrowLeft") {
		if (current?.dataset.open === "true") {
			collapse(current);
		} else if (current) {
			const parent = parentOf(current);
			if (parent) select(rows().indexOf(parent));
		}
	} else if (key === ".") {
		showDotfiles = !showDotfiles;
		rebuild();
	} else {
		return;
	}
	void refresh();
});

rebuild();
await refresh();
