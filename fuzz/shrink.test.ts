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
 * scans 600 seeds from `FROM` (1 by default) and stops after 20 failures;
 * `SEEDS=133,149` replays a chosen few. Either way the shrunk repros land in
 * /tmp/tdfuzz/shrunk.txt, and the seed under way in /tmp/tdfuzz/seed.txt, which
 * is where to read off a seed that crashed the engine rather than diverging.
 *
 * SCAN=600 WANT=20 npx libuild test fuzz -p node
 */
import {mkdirSync, writeFileSync} from "fs";

import {test} from "@b9g/libuild/test";

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
	.box { border: 1px solid; }
	.round { border-radius: 1ch; }
	.center { display: flex; justify-content: center; align-items: center; }
	.rtl { direction: rtl; }
	.ltr { direction: ltr; }
	.mis { margin-inline-start: 2ch; }
	.mls { margin-left: 2ch; }
	.pie { padding-inline-end: 2ch; }
	.prewrap { white-space: pre-wrap; }
	.nowrap { white-space: nowrap; }
	.preline { white-space: pre-line; }
`;

/**
 * The rules past `.dim` name classes and elements the default vocabulary never
 * emits, so a default seed renders the same with them in the sheet as without
 * and the regression net keeps meaning what it meant.
 */

/** `SHAPES=1` widens the vocabulary; without it the seed stream is unchanged. */
const SHAPES = process.env.SHAPES === "1";

const BASE_CLASSES = [
	"hide",
	"flex",
	"col",
	"contents",
	"inline",
	"iblock",
	"block",
	"pad",
	"pre",
	"wide",
	"mark",
	"editing",
	"view",
	"on",
	"light",
	"dim",
];
const BASE_TAGS = ["div", "span", "p", "b", "em", "section", "li"];

/** Shapes that carry a box, a writing direction, or a whitespace rule. */
const SHAPE_CLASSES = [
	"box",
	"round",
	"center",
	"rtl",
	"ltr",
	"mis",
	"mls",
	"pie",
	"prewrap",
	"nowrap",
	"preline",
];
const SHAPE_TAGS = ["dialog"];

const CLASSES = SHAPES ? [...BASE_CLASSES, ...SHAPE_CLASSES] : BASE_CLASSES;
const TAGS = SHAPES ? [...BASE_TAGS, ...SHAPE_TAGS] : BASE_TAGS;

/**
 * Fragments a single roll drops in whole, for shapes the recursive generator
 * reaches only by accident. The first two are consecutive whitespace-only
 * inline elements under `white-space: pre`, the next two a bordered auto-width
 * block with block children centered as a flex item; both are holes a shipped
 * bug came through. The rest are corners, logical against physical offsets
 * under a direction, bidi and width-uncertain runs inside a border, the
 * whitespace values over an inline boundary, and the two top-layer states.
 */
const CLUSTERS = [
	"<span class=\"pre\"><b> </b><em> </em>x</span>",
	"<span class=\"pre\"><b> </b><b> </b><b> </b>y</span>",
	"<div class=\"center\"><div class=\"box\"><div>aa</div><div>bbbb</div></div></div>",
	"<div class=\"center\"><div class=\"box round\"><div>aa</div><div>bbbb</div></div></div>",
	"<div class=\"box round\" style=\"width: 8ch\">ab</div>",
	"<div class=\"box\" style=\"border-bottom-right-radius: 2ch; width: 7ch\">abc</div>",
	"<div class=\"rtl box\"><span class=\"mis\">ab</span><span class=\"mls\">cd</span></div>",
	"<div dir=\"rtl\" class=\"box pie\">الإصدار يعمل</div>",
	"<div class=\"box\">اب <b>cd</b> ef</div>",
	"<div class=\"box\">🙂🙂 <span>x</span></div>",
	"<div class=\"box\" style=\"width: 6ch\">ｗｉｄｅ ab</div>",
	"<span class=\"nowrap\">aa bb cc</span><span class=\"prewrap\">dd  ee</span>",
	`<span class="preline">a
 b</span><span class="pre">c  d</span>`,
	"<dialog open><p>hi</p></dialog>",
	"<div popover>pop</div>",
	"<div class=\"box ltr\"><div class=\"rtl\">ab<b>cd</b>ef</div></div>",
];

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(next: () => number, items: T[]): T =>
	items[Math.floor(next() * items.length) % items.length];

type Action =
	{kind: "class"; id: string; cls: string} |
	{kind: "style"; id: string; value: string} |
	{kind: "attr"; id: string; value: string} |
	{
		kind: "append";
		id: string;
		tag: string;
		cls: string;
		text: string;
		made: string;
	} |
	{kind: "prepend"; id: string; tag: string; text: string; made: string} |
	{kind: "remove"; id: string} |
	{kind: "move"; id: string; to: string} |
	{kind: "html"; id: string; value: string} |
	{kind: "text"; id: string; at: number; value: string} |
	{kind: "dir"; id: string; value: string} |
	{kind: "open"; id: string} |
	{kind: "pop"; id: string; value: string} |
	{kind: "flash"; id: string; mode: "modal" | "dialog" | "popover"};

function describe(action: Action): string {
	const {kind, ...rest} = action as any;
	return `${kind}(${Object.entries(rest)
		.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
		.join(", ")})`;
}

function makeDOM(): {dom: any; terminal: any} {
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

/**
 * Give every untagged element an id no element in the document already has.
 *
 * Tagging runs again after each action, and the elements an action added are
 * the untagged ones. Counting from zero every time would hand a new element
 * the id an old one is still wearing, and `find` would then answer with
 * whichever came first in the document -- so a recorded repro would name
 * elements it never touched.
 */
function tag(document: any): void {
	const elements = Array.from(document.body.querySelectorAll("*")) as any[];
	let counter = 0;
	for (const element of elements) {
		const existing = element.getAttribute("data-f");
		const index = existing === null ? -1 : Number(existing.slice(1));
		if (Number.isInteger(index) && index >= counter) {
			counter = index + 1;
		}
	}
	for (const element of elements) {
		if (!element.hasAttribute("data-f")) {
			element.setAttribute("data-f", `e${counter++}`);
		}
	}
}

/**
 * Run one action against the live document. Asynchronous for `flash`, which
 * shows a dialog or a popover, gives it a frame of its own, and closes it: the
 * top layer leaves no mark on the serialized tree, so what it can leave behind
 * is a frame the close failed to repair.
 */
async function apply(dom: any, action: Action): Promise<void> {
	const document = dom.document;
	const element = find(document, action.id);
	if (!element) {
		return;
	}
	switch (action.kind) {
		case "dir":
			if (action.value) {
				element.setAttribute("dir", action.value);
			} else {
				element.removeAttribute("dir");
			}
			return;
		case "open":
			if (element.tagName !== "DIALOG") {
				return;
			}
			element.toggleAttribute("open");
			return;
		case "pop":
			if (action.value) {
				element.setAttribute("popover", action.value);
			} else {
				element.removeAttribute("popover");
			}
			return;
		case "flash": {
			// Showing what is already shown is a spec'd throw, not a finding, and
			// the state that decides it is not always reachable from the markup.
			if (action.mode === "popover") {
				if (!element.hasAttribute("popover")) {
					return;
				}
				try {
					element.showPopover();
				} catch (_err) {
					return;
				}
				await nextFrame(dom);
				try {
					element.hidePopover();
				} catch (_err) {
					/* an auto popover may already have been dismissed */
				}
				return;
			}
			if (element.tagName !== "DIALOG" || element.hasAttribute("open")) {
				return;
			}
			try {
				if (action.mode === "modal") {
					element.showModal();
				} else {
					element.show();
				}
			} catch (_err) {
				return;
			}
			await nextFrame(dom);
			element.close();
			return;
		}
	}
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
			if (action.kind === "append" && action.cls) {
				child.className = action.cls;
			}
			if (action.text) {
				child.textContent = action.text;
			}
			if (action.kind === "append") {
				element.appendChild(child);
			} else if (element.firstChild) {
				element.insertBefore(child, element.firstChild);
			} else {
				element.appendChild(child);
			}
			break;
		}
		case "remove":
			element.remove();
			break;
		case "move": {
			const to = find(document, action.to);
			if (!to || to === element || element.contains(to)) {
				return;
			}
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
					if (child.nodeType === 3) {
						texts.push(child);
					} else {
						walk(child);
					}
				}
			};
			walk(element);
			if (texts[action.at]) {
				texts[action.at].data = action.value;
			}
			break;
		}
	}
}

async function differs(
	html: string,
	actions: Action[],
): Promise<{differs: boolean; incremental: string; fresh: string}> {
	const {dom, terminal} = makeDOM();
	dom.document.body.innerHTML = html;
	tag(dom.document);
	await nextFrame(dom);
	for (const action of actions) {
		await apply(dom, action);
		await nextFrame(dom);
	}
	const incremental = frameOf(terminal);

	const fresh = makeDOM();
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
		if (roll < 0.08) {
			return `<${pick(next, TAGS)}></${pick(next, TAGS)}>`;
		}
		if (roll < 0.12) {
			return "   ";
		}
		if (roll < 0.15) {
			return "<!-- c -->";
		}
		if (roll < 0.2) {
			return `<${pick(next, TAGS)}> </${pick(next, TAGS)}>`;
		}
		if (SHAPES && roll < 0.32) {
			return pick(next, CLUSTERS);
		}
		if (depth <= 0 || roll < 0.5) {
			return `t${String(counter++).padStart(3, "0")}`;
		}
		const tagName = pick(next, TAGS);
		const cls = next() < 0.5 ? pick(next, CLASSES) : "";
		const count = 1 + Math.floor(next() * 3);
		let inner = "";
		for (let i = 0; i < count; i++) {
			inner += node(depth - 1);
		}
		return `<${tagName}${cls ? ` class="${cls}"` : ""}>${inner}</${tagName}>`;
	};
	const count = 1 + Math.floor(next() * 4);
	let html = "";
	for (let i = 0; i < count; i++) {
		html += node(3);
	}
	return html;
}

async function record(
	seed: number,
): Promise<{html: string; actions: Action[]}> {
	const next = rng(seed);
	const html = generate(next);
	const {dom} = makeDOM();
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
		const kind = Math.floor(next() * (SHAPES ? 13 : 9));
		let action: Action | null = null;
		if (kind >= 9 && all.length) {
			if (kind === 9) {
				action = {
					kind: "dir",
					id: pick(next, all),
					value: pick(next, ["", "ltr", "rtl", "auto"]),
				};
			} else if (kind === 10) {
				action = {kind: "open", id: pick(next, all)};
			} else if (kind === 11) {
				action = {
					kind: "pop",
					id: pick(next, all),
					value: pick(next, ["", "auto", "manual"]),
				};
			} else {
				action = {
					kind: "flash",
					id: pick(next, all),
					mode: pick(next, ["modal", "dialog", "popover"] as const),
				};
			}
			actions.push(action);
			await apply(dom, action);
			tag(dom.document);
			await nextFrame(dom);
			continue;
		}
		if (kind === 0 && all.length) {
			action = {kind: "class", id: pick(next, all), cls: pick(next, CLASSES)};
		} else if (kind === 1 && all.length) {
			action = {
				kind: "style",
				id: pick(next, all),
				value: pick(next, [
					"",
					"display: none",
					"display: block",
					"display: inline",
					"display: flex",
					"padding-left: 2ch",
					"width: 6ch",
					"color: blue",
					"white-space: pre",
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
			action = {
				kind: "move",
				id: pick(next, all),
				to: pick(next, ["body", ...all]),
			};
		} else if (kind === 6 && all.length) {
			action = {
				kind: "html",
				id: pick(next, all),
				value: pick(next, [
					"",
					"   ",
					"<b>x</b>",
					"<div></div>",
					"<span>a</span><div>b</div>",
				]),
			};
		} else if (kind === 7 && all.length) {
			action = {
				kind: "text",
				id: pick(next, all),
				at: Math.floor(next() * 3),
				value: pick(next, ["", " ", "   ", "z", "zz zz"]),
			};
		} else if (all.length) {
			action = {
				kind: "attr",
				id: pick(next, all),
				value: String(Math.floor(next() * 9)),
			};
		}
		if (!action) {
			continue;
		}
		actions.push(action);
		await apply(dom, action);
		tag(dom.document);
		await nextFrame(dom);
	}
	dom.dispose();
	return {html: tagged, actions};
}

function reductions(html: string): string[] {
	const out: string[] = [];
	const {dom} = makeDOM();
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
			for (const child of kept) {
				parent.insertBefore(child, element);
			}
			element.remove();
			out.push(dom.document.body.innerHTML);
			for (const child of kept) {
				element.appendChild(child);
			}
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
			if (child.nodeType === 3) {
				texts.push(child);
			} else {
				walk(child);
			}
		}
	};
	walk(dom.document.body);
	for (const text of texts) {
		const was = text.data;
		if (was === "") {
			continue;
		}
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
			if (candidate === bestHTML) {
				continue;
			}
			if ((await differs(candidate, bestActions)).differs) {
				bestHTML = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) {
			break;
		}
	}
	return {html: bestHTML, actions: bestActions};
}

/**
 * The seeds that have caught a real invalidation bug at some point. Replayed
 * by default so a regression shows up in `npm test` without a scan.
 */
const REGRESSION_SEEDS = [
	2,
	27,
	30,
	82,
	93,
	113,
	115,
	117,
	120,
	133,
	142,
	149,
	155,
	168,
	193,
	195,
	205,
	229,
	232,
	246,
	252,
	315,
	400,
	421,
	451,
	460,
	471,
	481,
	524,
	527,
	586,
];

test("shrink", async () => {
	const scan = Number(process.env.SCAN ?? 0);
	const from = Number(process.env.FROM ?? 1);
	const seeds = scan
		? Array.from({length: scan}, (_, i) => from + i)
		: process.env.SEEDS
			? process.env.SEEDS.split(",").map((s) => Number(s.trim()))
			: REGRESSION_SEEDS;
	const wanted = Number(process.env.WANT ?? seeds.length);
	const report: string[] = [];
	let found = 0;
	let checked = 0;
	mkdirSync(REPORT_DIR, {recursive: true});
	mkdirSync(REPORT_DIR, {recursive: true});
	for (const seed of seeds) {
		if (found >= wanted) {
			break;
		}
		checked++;
		// A seed that crashes the engine takes the scan down with it and never
		// reaches the report, so the seed under way is left on disk first.
		writeFileSync(`${REPORT_DIR}/seed.txt`, String(seed));
		// A seed that crashes the engine takes the scan down with it and never
		// reaches the report, so the seed under way is left on disk first.
		writeFileSync(`${REPORT_DIR}/seed.txt`, String(seed));
		const {html, actions} = await record(seed);
		if (!(await differs(html, actions)).differs) {
			continue;
		}
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
	writeFileSync(`${REPORT_DIR}/shrunk.txt`, summary);
	if (found > 0) {
		throw new Error(summary);
	}
}, 900000);
