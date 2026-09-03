/**
 * A small shell over the filesystem: ls, cat, less, cd and pwd, in a
 * transcript that scrolls like a terminal's. Under Node the filesystem is
 * the real one, from wherever the shell was started; in the playground it
 * is the repository's own files, so `ls examples` lists these programs and
 * `cat examples/shell.ts` prints this one.
 *
 * Keys: type a command and press Enter; in less, j/k, space, b, g, G and q.
 */
import {readdirSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

import {TermDOM} from "@b9g/termdom";

const term = new TermDOM();
term.attach();
const {document, window} = term;

document.head.innerHTML = `
	<style>
		body { padding: 0 1ch; }
		.line { white-space: pre-wrap; }
		.prompt { color: #5fafff; font-weight: bold; }
		.dir { color: #5fafff; font-weight: bold; }
		.error { color: #f85149; }
		.muted { color: #808080; }
		.entry { display: flex; }
		.entry input { flex-grow: 1; border: none; padding: 0; }
		.pager { position: fixed; inset: 0; background: #0d1117; overflow: hidden; }
		.pager .text { white-space: pre; }
		.pager .status { position: fixed; bottom: 0; left: 0; right: 0; background: #ffd700; color: black; padding: 0 1ch; }
	</style>
`;

let cwd = process.cwd();

const transcript = document.createElement("div");
const entry = document.createElement("div");
entry.className = "entry";
const promptLabel = document.createElement("span");
promptLabel.className = "prompt";
const input = document.createElement("input");
input.autofocus = true;
entry.append(promptLabel, input);
document.body.append(transcript, entry);

function print(text: string, className = "line"): void {
	for (const line of text.split("\n")) {
		const element = document.createElement("div");
		element.className = className;
		element.textContent = line;
		transcript.append(element);
	}
}

function shortCwd(): string {
	return cwd;
}

function showPrompt(): void {
	promptLabel.textContent = `${shortCwd()} $ `;
	input.value = "";
	input.scrollIntoView({block: "end"});
	input.focus();
}

function target(argument: string | undefined): string {
	return resolve(cwd, argument ?? ".");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ls(argument: string | undefined): void {
	const path = target(argument);
	let entries;
	try {
		entries = readdirSync(path, {withFileTypes: true});
	} catch (error) {
		print(`ls: ${errorMessage(error)}`, "line error");
		return;
	}
	const names = entries
		.filter((each) => !each.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (names.length === 0) {
		return;
	}
	const width = Math.max(...names.map((each) => each.name.length)) + 3;
	const columns = Math.max(1, Math.floor((window.innerWidth - 2) / width));
	for (let i = 0; i < names.length; i += columns) {
		const row = document.createElement("div");
		row.className = "line";
		for (const each of names.slice(i, i + columns)) {
			const cell = document.createElement("span");
			cell.textContent = (each.name + (each.isDirectory() ? "/" : "")).padEnd(
				width,
			);
			if (each.isDirectory()) {
				cell.className = "dir";
			}
			row.append(cell);
		}
		transcript.append(row);
	}
}

function cat(argument: string | undefined): void {
	if (argument === undefined) {
		print("cat: which file?", "line error");
		return;
	}
	try {
		print(readFileSync(target(argument), "utf8").replace(/\n$/, ""));
	} catch (error) {
		print(`cat: ${errorMessage(error)}`, "line error");
	}
}

function cd(argument: string | undefined): void {
	const path = target(argument);
	try {
		readdirSync(path);
	} catch (error) {
		print(`cd: ${errorMessage(error)}`, "line error");
		return;
	}
	cwd = path;
}

// A pager over the whole screen, as less takes the screen: the file's lines
// in a fixed box, and a status line at the bottom. Keys move by line or by
// page; q returns to the shell with the transcript as it was.
function less(argument: string | undefined): void {
	if (argument === undefined) {
		print("less: which file?", "line error");
		return;
	}
	let text: string;
	try {
		text = readFileSync(target(argument), "utf8");
	} catch (error) {
		print(`less: ${errorMessage(error)}`, "line error");
		return;
	}
	const lines = text.replace(/\n$/, "").split("\n");
	const pager = document.createElement("div");
	pager.className = "pager";
	const body = document.createElement("div");
	body.className = "text";
	const status = document.createElement("div");
	status.className = "status";
	pager.append(body, status);
	document.body.append(pager);
	let top = 0;
	const page = (): number => Math.max(1, window.innerHeight - 1);
	const show = (): void => {
		const last = Math.max(0, lines.length - page());
		top = Math.max(0, Math.min(top, last));
		body.textContent = lines.slice(top, top + page()).join("\n");
		const percent =
			lines.length <= page()
				? 100
				: Math.round(((top + page()) / lines.length) * 100);
		status.textContent = `${argument} · lines ${top + 1}-${Math.min(lines.length, top + page())} of ${lines.length} · ${percent}% · q quits`;
	};
	const moves: Record<string, () => void> = {
		j: () => top++,
		ArrowDown: () => top++,
		k: () => top--,
		ArrowUp: () => top--,
		" ": () => (top += page()),
		f: () => (top += page()),
		PageDown: () => (top += page()),
		b: () => (top -= page()),
		PageUp: () => (top -= page()),
		g: () => (top = 0),
		G: () => (top = lines.length),
	};
	const onkeydown = (event: Event): void => {
		const key = (event as KeyboardEvent).key;
		event.preventDefault();
		event.stopPropagation();
		if (key === "q" || key === "Escape") {
			document.removeEventListener("keydown", onkeydown, true);
			window.removeEventListener("resize", show);
			pager.remove();
			showPrompt();
			return;
		}
		moves[key]?.();
		show();
	};
	document.addEventListener("keydown", onkeydown, true);
	window.addEventListener("resize", show);
	input.blur();
	show();
}

const commands: Record<string, (argument: string | undefined) => void> = {
	ls,
	cat,
	less,
	cd,
	pwd: () => print(cwd),
	clear: () => {
		transcript.textContent = "";
	},
	help: () =>
		print(
			"ls [dir]   cat file   less file   cd [dir]   pwd   clear   help   exit",
		),
	exit: () => window.close(),
};

function run(line: string): void {
	const [name, ...rest] = line.trim().split(/\s+/);
	if (name === "") {
		return;
	}
	const command = commands[name];
	if (command === undefined) {
		print(`${name}: command not found`, "line error");
		return;
	}
	command(rest.join(" ") || undefined);
}

input.addEventListener("keydown", (event) => {
	if ((event as KeyboardEvent).key !== "Enter") {
		return;
	}
	event.preventDefault();
	const line = input.value;
	const echo = document.createElement("div");
	echo.className = "line";
	const label = document.createElement("span");
	label.className = "prompt";
	label.textContent = promptLabel.textContent;
	echo.append(label, document.createTextNode(line));
	transcript.append(echo);
	run(line);
	if (document.querySelector(".pager") === null) {
		showPrompt();
	}
});

print("termdom shell · ls, cat, less, cd, pwd · help lists them", "line muted");
showPrompt();
