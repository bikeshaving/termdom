/**
 * Differential invalidation fuzzer with a delta-debugging shrinker.
 *
 * A document is built, mutated a step at a time with a frame between each,
 * then rendered again from the same final tree in one pass. The two frames
 * must agree; anything else is a cache a mutation failed to unsettle.
 *
 * The steps come from a seeded stream, so they cannot be dropped one at a
 * time -- removing one changes every step after it. So a run is first RECORDED
 * as concrete actions, each naming its target by a stable id rather than by
 * position, and the shrinking works on the recording: drop an action, delete
 * an element, unwrap it, drop a class, empty a text, keep what still differs.
 *
 * With no environment set, the seeds that have caught a bug before are replayed
 * as a regression net and any difference fails the test. `SCAN=600 WANT=20`
 * scans seeds 1..600 and stops after 20 failures; `SEEDS=133,149` replays a
 * chosen few. Either way the shrunk repros land in /tmp/tdfuzz/shrunk.txt.
 *
 * SCAN=600 WANT=20 npx libuild test fuzz -p node
 */
import {test} from "@b9g/libuild/test";
import {mkdirSync, writeFileSync} from "fs";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "../tests/test-utils.js";

/** Where a failing run's shrunk repros are written. */
const REPORT_DIR = "/tmp/tdfuzz";

const SHEET = `
	.hide { display: none; }
	.flex { display: flex; flex-direction: row; gap: 1ch; }
	.col { display: flex; flex-direction: column; }
	.contents { display: contents; }
	.inline { display: inline; }
	.iblock { display: inline-block; }
	.block { display: block; }
	.pad { padding-left: 1ch; }
	.pre { white-space: pre; }
	.wide { width: 8ch; }
	.mark::before { content: "* "; }
	.editing .view { display: none; }
	.on ~ .light { color: red; }
	.dim { color: #808080; }
`;

const CLASSES = [
	"hide", "flex", "col", "contents", "inline", "iblock", "block",
	"pad", "pre", "wide", "mark", "editing", "view", "on", "light", "dim",
];
const TAGS = ["div", "span", "p", "b", "em", "section", "li"];

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const pick = <T,>(next: () => number, items: T[]): T =>
	items[Math.floor(next() * items.length) % items.length];

type Action =
	| {kind: "class"; id: string; cls: string}
	| {kind: "style"; id: string; value: string}
	| {kind: "attr"; id: string; value: string}
	| {kind: "append"; id: string; tag: string; cls: string; text: string; made: string}
	| {kind: "prepend"; id: string; tag: string; text: string; made: string}
	| {kind: "remove"; id: string}
	| {kind: "move"; id: string; to: string}
	| {kind: "html"; id: string; value: string}
	| {kind: "text"; id: string; at: number; value: string};

function describe(action: Action): string {
	const {kind, ...rest} = action as any;
	return `${kind}(${Object.entries(rest)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(", ")})`;
}

function makeDom(): {dom: any; terminal: any} {
	const terminal = new MockProcess({cols: 60, rows: 60});
	const dom = new TermDOM({transport: terminal.transport});
	const style = dom.document.createElement("style");
	style.textContent = SHEET;
	dom.document.head.appendChild(style);
	return {dom, terminal};
}

function frameOf(terminal: any): string {
	return terminal
		.getPlainText()
		.split("\n")
		.map((line: string) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

const find = (document: any, id: string): any =>
	id === "body" ? document.body : document.querySelector(`[data-f="${id}"]`);

function tag(document: any): void {
	let counter = 0;
	for (const element of Array.from(document.body.querySelectorAll("*")) as any[]) {
		if (!element.hasAttribute("data-f")) {
			element.setAttribute("data-f", `e${counter++}`);
		}
	}
}

function apply(document: any, action: Action): void {
	const element = find(document, action.id);
	if (!element) return;
	switch (action.kind) {
		case "class":
			element.classList.toggle(action.cls);
			break;
		case "style":
			element.setAttribute("style", action.value);
			break;
		case "attr":
			element.setAttribute("data-x", action.value);
			break;
		case "append":
		case "prepend": {
			const child = document.createElement(action.tag);
			child.setAttribute("data-f", action.made);
			if (action.kind === "append" && action.cls) child.className = action.cls;
			if (action.text) child.textContent = action.text;
			if (action.kind === "append") element.appendChild(child);
			else if (element.firstChild) element.insertBefore(child, element.firstChild);
			else element.appendChild(child);
			break;
		}
		case "remove":
			element.remove();
			break;
		case "move": {
			const to = find(document, action.to);
			if (!to || to === element || element.contains(to)) return;
			to.appendChild(element);
			break;
		}
		case "html":
			element.innerHTML = action.value;
			break;
		case "text": {
			const texts: any[] = [];
			const walk = (node: any): void => {
				for (const child of Array.from(node.childNodes) as any[]) {
					if (child.nodeType === 3) texts.push(child);
					else walk(child);
				}
			};
			walk(element);
			if (texts[action.at]) texts[action.at].data = action.value;
			break;
		}
	}
}

async function differs(
	html: string,
	actions: Action[],
): Promise<{differs: boolean; incremental: string; fresh: string}> {
	const {dom, terminal} = makeDom();
	dom.document.body.innerHTML = html;
	tag(dom.document);
	await nextFrame(dom);
	for (const action of actions) {
		apply(dom.document, action);
		await nextFrame(dom);
	}
	const incremental = frameOf(terminal);

	const fresh = makeDom();
	for (const child of Array.from(dom.document.body.childNodes) as any[]) {
		fresh.dom.document.body.appendChild(
			fresh.dom.document.importNode(child, true),
		);
	}
	await nextFrame(fresh.dom);
	const once = frameOf(fresh.terminal);
	dom.dispose();
	fresh.dom.dispose();
	return {differs: incremental !== once, incremental, fresh: once};
}

function generate(next: () => number): string {
	let counter = 0;
	const node = (depth: number): string => {
		const roll = next();
		if (roll < 0.08) return `<${pick(next, TAGS)}></${pick(next, TAGS)}>`;
		if (roll < 0.12) return "   ";
		if (roll < 0.15) return "<!-- c -->";
		if (roll < 0.2) return `<${pick(next, TAGS)}> </${pick(next, TAGS)}>`;
		if (depth <= 0 || roll < 0.5) return `t${String(counter++).padStart(3, "0")}`;
		const tagName = pick(next, TAGS);
		const cls = next() < 0.5 ? pick(next, CLASSES) : "";
		const count = 1 + Math.floor(next() * 3);
		let inner = "";
		for (let i = 0; i < count; i++) inner += node(depth - 1);
		return `<${tagName}${cls ? ` class="${cls}"` : ""}>${inner}</${tagName}>`;
	};
	const count = 1 + Math.floor(next() * 4);
	let html = "";
	for (let i = 0; i < count; i++) html += node(3);
	return html;
}

async function record(seed: number): Promise<{html: string; actions: Action[]}> {
	const next = rng(seed);
	const html = generate(next);
	const {dom} = makeDom();
	dom.document.body.innerHTML = html;
	tag(dom.document);
	const tagged = dom.document.body.innerHTML;
	await nextFrame(dom);

	const actions: Action[] = [];
	let made = 0;
	const ids = (): string[] =>
		(Array.from(dom.document.body.querySelectorAll("*")) as any[]).map((e) =>
			e.getAttribute("data-f"),
		);

	const steps = 1 + Math.floor(next() * 6);
	for (let i = 0; i < steps; i++) {
		const all = ids();
		const kind = Math.floor(next() * 9);
		let action: Action | null = null;
		if (kind === 0 && all.length) {
			action = {kind: "class", id: pick(next, all), cls: pick(next, CLASSES)};
		} else if (kind === 1 && all.length) {
			action = {
				kind: "style",
				id: pick(next, all),
				value: pick(next, [
					"", "display: none", "display: block", "display: inline",
					"display: flex", "padding-left: 2ch", "width: 6ch",
					"color: blue", "white-space: pre",
				]),
			};
		} else if (kind === 2) {
			action = {
				kind: "append",
				id: pick(next, ["body", ...all]),
				tag: pick(next, TAGS),
				cls: next() < 0.5 ? pick(next, CLASSES) : "",
				text: next() < 0.5 ? `n${Math.floor(next() * 1000)}` : "",
				made: `m${made++}`,
			};
		} else if (kind === 3) {
			action = {
				kind: "prepend",
				id: pick(next, ["body", ...all]),
				tag: pick(next, TAGS),
				text: `i${Math.floor(next() * 1000)}`,
				made: `m${made++}`,
			};
		} else if (kind === 4 && all.length) {
			action = {kind: "remove", id: pick(next, all)};
		} else if (kind === 5 && all.length) {
			action = {kind: "move", id: pick(next, all), to: pick(next, ["body", ...all])};
		} else if (kind === 6 && all.length) {
			action = {
				kind: "html",
				id: pick(next, all),
				value: pick(next, ["", "   ", "<b>x</b>", "<div></div>", "<span>a</span><div>b</div>"]),
			};
		} else if (kind === 7 && all.length) {
			action = {
				kind: "text",
				id: pick(next, all),
				at: Math.floor(next() * 3),
				value: pick(next, ["", " ", "   ", "z", "zz zz"]),
			};
		} else if (all.length) {
			action = {kind: "attr", id: pick(next, all), value: String(Math.floor(next() * 9))};
		}
		if (!action) continue;
		actions.push(action);
		apply(dom.document, action);
		tag(dom.document);
		await nextFrame(dom);
	}
	dom.dispose();
	return {html: tagged, actions};
}

function reductions(html: string): string[] {
	const out: string[] = [];
	const {dom} = makeDom();
	dom.document.body.innerHTML = html;
	const elements = Array.from(dom.document.body.querySelectorAll("*")) as any[];

	for (const element of elements) {
		const parent = element.parentNode;
		const next = element.nextSibling;
		element.remove();
		out.push(dom.document.body.innerHTML);
		parent.insertBefore(element, next);

		if (element.childNodes.length > 0) {
			const kept = Array.from(element.childNodes) as any[];
			for (const child of kept) parent.insertBefore(child, element);
			element.remove();
			out.push(dom.document.body.innerHTML);
			for (const child of kept) element.appendChild(child);
			parent.insertBefore(element, next);
		}

		for (const cls of Array.from(element.classList) as string[]) {
			element.classList.remove(cls);
			out.push(dom.document.body.innerHTML);
			element.classList.add(cls);
		}
	}

	const texts: any[] = [];
	const walk = (node: any): void => {
		for (const child of Array.from(node.childNodes) as any[]) {
			if (child.nodeType === 3) texts.push(child);
			else walk(child);
		}
	};
	walk(dom.document.body);
	for (const text of texts) {
		const was = text.data;
		if (was === "") continue;
		text.data = "";
		out.push(dom.document.body.innerHTML);
		text.data = was;
	}
	dom.dispose();
	return out;
}

async function shrink(
	html: string,
	actions: Action[],
): Promise<{html: string; actions: Action[]}> {
	let bestHTML = html;
	let bestActions = actions;
	for (let pass = 0; pass < 6; pass++) {
		let reduced = false;
		for (let i = bestActions.length - 1; i >= 0; i--) {
			const candidate = bestActions.filter((_, index) => index !== i);
			if ((await differs(bestHTML, candidate)).differs) {
				bestActions = candidate;
				reduced = true;
			}
		}
		for (const candidate of reductions(bestHTML)) {
			if (candidate === bestHTML) continue;
			if ((await differs(candidate, bestActions)).differs) {
				bestHTML = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) break;
	}
	return {html: bestHTML, actions: bestActions};
}

/**
 * The seeds that have caught a real invalidation bug at some point. Replayed
 * by default so a regression shows up in `npm test` without a scan.
 */
const REGRESSION_SEEDS = [
	2, 27, 30, 82, 93, 113, 115, 117, 120, 133, 142, 149, 155, 168, 193, 195,
	205, 229, 232, 246, 252, 315, 400, 421, 451, 460, 471, 481, 524, 527, 586,
];

test(
	"shrink",
	async () => {
		const scan = Number(process.env.SCAN ?? 0);
		const seeds = scan
			? Array.from({length: scan}, (_, i) => i + 1)
			: process.env.SEEDS
				? process.env.SEEDS.split(",").map((s) => Number(s.trim()))
				: REGRESSION_SEEDS;
		const wanted = Number(process.env.WANT ?? seeds.length);
		const report: string[] = [];
		let found = 0;
		let checked = 0;
		for (const seed of seeds) {
			if (found >= wanted) break;
			checked++;
			const {html, actions} = await record(seed);
			if (!(await differs(html, actions)).differs) continue;
			found++;
			const small = await shrink(html, actions);
			const result = await differs(small.html, small.actions);
			report.push(
				`== seed ${seed}\nhtml: ${small.html}\n` +
					`actions:\n${small.actions.map((a) => `  ${describe(a)}`).join("\n")}\n` +
					`--- incremental\n${result.incremental}\n--- fresh\n${result.fresh}\n`,
			);
		}
		const summary = `${found} of ${checked} scanned\n\n${report.join("\n")}`;
		mkdirSync(REPORT_DIR, {recursive: true});
		writeFileSync(`${REPORT_DIR}/shrunk.txt`, summary);
		if (found > 0) throw new Error(summary);
	},
	900000,
);
