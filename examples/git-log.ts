#!/usr/bin/env node
// A git commit browser, tig-style, as a plain web page: a scrollable list of
// commits, Enter expands one to show its message and diffstat inline (the same
// expand/collapse pattern as the file tree), the camera follows the selection.
//
//   node examples/git-log.ts [git-log-args...]
//
//   j/k or arrows   move       Enter / l   expand   h   collapse
//   g / G           top/bottom            q          quit
import {TermDOM} from "@b9g/termdom";
import {execFileSync} from "node:child_process";

function git(args: string[]): string {
	return execFileSync("git", args, {encoding: "utf8", maxBuffer: 1 << 26});
}

try {
	git(["rev-parse", "--is-inside-work-tree"]);
} catch (_err) {
	process.stderr.write("not a git repository\n");
	process.exit(1);
}

const extra = process.argv.slice(2);
const FIELD = "\x1f";
const commits = git([
	"log",
	`--pretty=format:%h${FIELD}%an${FIELD}%ar${FIELD}%s`,
	"-n",
	"300",
	...extra,
])
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		const [hash, author, date, subject] = line.split(FIELD);
		return {hash, author, date, subject};
	});

const term = new TermDOM();

term.attach();
const {document, window} = term;

const style = document.createElement("style");
style.textContent = `
	.header { color: cyan; font-weight: bold; }
	.hint { color: #666666; }
	.row { }
	.row.selected { background-color: #253040; }
	.hash { display: inline; color: #ffd700; }
	.subject { display: inline; }
	.meta { display: inline; color: #808080; }
	.details { color: #b0b0b0; margin-left: 2ch; }
	.details .msg { color: #d0d0d0; }
	.details .stat { color: #87afaf; }
`;
document.head.appendChild(style);

const header = document.createElement("div");
header.className = "header";
const listEl = document.createElement("div");
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent = " j/k move · enter details · h collapse · g/G ends · q quit";
document.body.append(header, listEl, hint);

function makeRow(c: (typeof commits)[number]): HTMLElement {
	const row = document.createElement("div");
	row.className = "row";
	row.dataset.hash = c.hash;
	const hash = document.createElement("span");
	hash.className = "hash";
	hash.textContent = c.hash + " ";
	const subject = document.createElement("span");
	subject.className = "subject";
	subject.textContent = c.subject;
	const meta = document.createElement("span");
	meta.className = "meta";
	meta.textContent = `  · ${c.author}, ${c.date}`;
	row.append(hash, subject, meta);
	return row;
}

for (const c of commits) {
	listEl.appendChild(makeRow(c));
}

// Built detail blocks ride along on their row, so re-expanding is free.
const detailsOf = new WeakMap<HTMLElement, HTMLElement>();

function expand(row: HTMLElement): void {
	if (row.dataset.open === "true") {
		return;
	}
	let details = detailsOf.get(row);
	if (!details) {
		details = document.createElement("div");
		details.className = "details";
		const raw = git([
			"show",
			"--stat",
			"--format=%b",
			"--color=never",
			row.dataset.hash!,
		]);
		for (const line of raw.split("\n")) {
			const div = document.createElement("div");
			div.className = /\|\s+\d+|files? changed/.test(line) ? "stat" : "msg";
			div.textContent = line || " ";
			details.appendChild(div);
		}
		detailsOf.set(row, details);
	}
	row.after(details);
	row.dataset.open = "true";
}

function collapse(row: HTMLElement): void {
	if (row.dataset.open !== "true") {
		return;
	}
	detailsOf.get(row)?.remove();
	row.dataset.open = "false";
}

function rows(): HTMLElement[] {
	return Array.from(listEl.querySelectorAll<HTMLElement>(".row"));
}

let selected = 0;

function select(index: number): void {
	const all = rows();
	selected = Math.max(0, Math.min(index, all.length - 1));
	all.forEach((row, i) => row.classList.toggle("selected", i === selected));
	header.textContent = ` ${commits.length} commits · ${selected + 1}`;
}

async function refresh(): Promise<void> {
	rows()[selected]?.scrollIntoView();
	if (selected === 0) {
		window.scrollBy(0, -document.body.scrollHeight);
	}
	await new Promise<void>((r) => window.requestAnimationFrame(() => r()));
}

document.addEventListener("keydown", (event: Event) => {
	const key = (event as KeyboardEvent).key;
	const current = rows()[selected];
	if (key === "q") {
		term.window.close();
	} else if (key === "j" || key === "ArrowDown") {
		select(selected + 1);
	} else if (key === "k" || key === "ArrowUp") {
		select(selected - 1);
	} else if (key === "g") {
		select(0);
	} else if (key === "G") {
		select(rows().length - 1);
	} else if (key === "Enter" || key === "l" || key === "ArrowRight") {
		if (current) {
			if (current.dataset.open === "true") {
				collapse(current);
			} else {
				expand(current);
			}
		}
	} else if (key === "h" || key === "ArrowLeft") {
		if (current) {
			collapse(current);
		}
	} else {
		return;
	}
	void refresh();
});

document.addEventListener("click", (event: Event) => {
	const row = (event.target as Element).closest(".row") as HTMLElement | null;
	if (!row) {
		return;
	}
	select(rows().indexOf(row));
	if (row.dataset.open === "true") {
		collapse(row);
	} else {
		expand(row);
	}
	void refresh();
});

select(0);
await refresh();

if (!process.stdout.isTTY) {
	term.window.close();
}
