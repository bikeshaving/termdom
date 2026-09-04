/** The file-tree demo, scripted for recording: browse, expand, collapse. */
import type {TermDOM} from "../../src/index.ts";

// A canned filesystem so the recording is reproducible anywhere.
const FS: Record<string, string[]> = {
	".": ["src/", "examples/", "tests/", "package.json", "README.md"],
	"./src": ["index.ts", "internal/"],
	"./src/internal": ["screen.ts", "solver.ts", "layout.ts", "termdom.ts"],
	"./examples": ["animated.ts", "form.ts", "ssh-server.ts", "tree.ts"],
	"./tests": ["keyboard.test.ts", "viewport.test.ts"],
};

export default {
	setup(termdom: TermDOM): void {
		const {document} = termdom;
		const style = document.createElement("style");
		style.textContent = `
			.header { color: cyan; font-weight: bold; }
			.row.selected { background: #264f78; font-weight: bold; }
			.marker { color: yellow; display: inline; }
			.name { display: inline; }
			.name.dir { color: cyan; font-weight: bold; }
			.hint { color: #666; }
		`;
		document.head.appendChild(style);

		const header = document.createElement("div");
		header.className = "header";
		header.textContent = " ~/projects/termdom";
		const tree = document.createElement("div");
		const hint = document.createElement("div");
		hint.className = "hint";
		hint.textContent = " j/k move · enter expand · vanilla DOM, ~200 lines";
		document.body.append(header, tree, hint);

		function makeRow(name: string, depth: number): HTMLElement {
			const row = document.createElement("div");
			row.className = "row";
			row.dataset.path = name;
			row.dataset.kind = name.endsWith("/") ? "dir" : "file";
			row.style.paddingLeft = `${1 + depth * 2}ch`;
			const marker = document.createElement("span");
			marker.className = "marker";
			marker.textContent = name.endsWith("/") ? "▸ " : "  ";
			const label = document.createElement("span");
			label.className = "name" + (name.endsWith("/") ? " dir" : "");
			label.textContent = name;
			row.append(marker, label);
			return row;
		}

		function fill(container: HTMLElement, dir: string, depth: number): void {
			for (const entry of FS[dir] ?? []) {
				container.appendChild(makeRow(entry, depth));
			}
		}

		fill(tree, ".", 0);

		const rows = (): HTMLElement[] =>
			Array.from(document.querySelectorAll<HTMLElement>(".row"));
		let selected = 0;
		const select = (index: number): void => {
			const all = rows();
			selected = Math.max(0, Math.min(index, all.length - 1));
			for (const [i, row] of all.entries()) {
				row.classList.toggle("selected", i === selected);
			}
		};
		select(0);

		document.addEventListener("keydown", (event: Event) => {
			const key = (event as KeyboardEvent).key;
			const current = rows()[selected];
			if (key === "j") {
				select(selected + 1);
			} else if (key === "k") {
				select(selected - 1);
			} else if (key === "Enter" && current?.dataset.kind === "dir") {
				if (current.dataset.open === "true") {
					current.nextElementSibling?.remove();
					current.dataset.open = "false";
					current.querySelector(".marker")!.textContent = "▸ ";
				} else {
					const children = document.createElement("div");
					const depth =
						Math.floor((parseInt(current.style.paddingLeft) - 1) / 2) + 1;
					const dir =
						current.dataset.path === "src/"
							? "./src"
							: "./" + current.dataset.path!.replace(/\/$/, "");
					fill(children, dir, depth);
					current.after(children);
					current.dataset.open = "true";
					current.querySelector(".marker")!.textContent = "▾ ";
				}
			}
		});
	},
	steps: [
		0.55,
		"j",
		0.33,
		"j",
		0.33,
		"k",
		0.44,
		"\r",
		0.66, // expanded examples/
		"j",
		0.33,
		"\r",
		0.77,
		"j",
		0.3,
		"j",
		0.3,
		"j",
		0.3,
		"j",
		0.3,
		"j",
		0.44,
		"\r",
		1.1,
	] as Array<number | string>,
};
