/**
 * Pages and changes for tests/incremental.test.ts, kept apart so a
 * failing seed can be replayed and shrunk outside the test runner. A
 * change is chosen as an action naming its target by id, so the same
 * actions replay on a fresh page.
 */
import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

export const COLS = 60;
export const ROWS = 30;
// Cells 7 by 15 pixels put pixel lengths on fractions of a cell.
export const CELL = {width: 7, height: 15};

export interface Page {
	name: string;
	head: string;
	body: string;
	classes: string[];
	styles: Array<[string, (random: Random) => string]>;
	attributes: Array<[string, (random: Random) => string]>;
	// Rules a change can add to or take from the page's own sheet.
	rules: string[];
}

const LAYOUT: Page = {
	name: "layout",
	head: `<style id=sheet>
	.row { display: flex; gap: 1ch }
	.col { display: flex; flex-direction: column }
	.grid { display: grid; grid-template-columns: 1fr 2fr }
	.box { border: 1px solid; padding: 0 3px }
	.bg { background-color: rgb(20, 40, 60) }
	.b { font-weight: bold }
	.hide { display: none }
	.wide { width: 60% }
	.m { margin-left: 10px }
	.abs { position: absolute; top: 20px; right: 3px }
	.ib { display: inline-block; border: 1px solid }
	.center { text-align: center }
	.n { counter-increment: n }
	.n::before { content: counter(n) ". " }
</style>`,
	body: `<div id=root style="counter-reset: n">
	<p id=p0>Some text <span id=s0>span</span> and more words here</p>
	<div id=f class=row><div id=f0 class=box>one</div><div id=f1>two words</div><div id=f2 class=bg>three</div></div>
	<div id=g class=grid><div id=g0>cell a</div><div id=g1>cell b has longer text that may wrap</div></div>
	<ol id=l><li id=l0>first</li><li id=l1 class=n>second</li><li id=l2>third</li></ol>
	<table id=t><tr><td id=t0 class=box>x</td><td id=t1>y y</td></tr></table>
	<p id=p1>inline <span id=ib class=ib>block</span> tail of the line</p>
	<div id=c class=col><div id=c0>above</div><div id=c1 class=n>below</div></div>
</div>`,
	classes: [
		"row",
		"col",
		"grid",
		"box",
		"bg",
		"b",
		"hide",
		"wide",
		"m",
		"abs",
		"ib",
		"center",
		"n",
	],
	styles: [
		["margin-left", (r: Random): string => `${r.int(25)}px`],
		["margin-top", (r: Random): string => `${r.int(40)}px`],
		["padding-top", (r: Random): string => `${r.int(30)}px`],
		["width", (r: Random): string => `${10 + r.int(90)}%`],
		["width", (r: Random): string => `${20 + r.int(300)}px`],
		[
			"color",
			(r: Random): string => `rgb(${r.int(255)}, ${r.int(255)}, ${r.int(255)})`,
		],
		[
			"background-color",
			(r: Random): string => r.pick(["transparent", "rgb(90, 0, 0)"]),
		],
		[
			"display",
			(r: Random): string =>
				r.pick(["block", "none", "flex", "inline-block", "inline"]),
		],
		["order", (r: Random): string => String(r.int(3))],
		[
			"flex-direction",
			(r: Random): string => r.pick(["row", "column", "row-reverse"]),
		],
		["text-align", (r: Random): string => r.pick(["left", "center", "right"])],
		[
			"position",
			(r: Random): string => r.pick(["static", "relative", "absolute"]),
		],
		["top", (r: Random): string => `${r.int(30)}px`],
		["visibility", (r: Random): string => r.pick(["visible", "hidden"])],
		[
			"border",
			(r: Random): string => r.pick(["none", "1px solid", "1px double"]),
		],
		["z-index", (r: Random): string => String(r.int(3))],
		["outline", (r: Random): string => r.pick(["none", "1px solid"])],
	],
	attributes: [],
	rules: [],
};

const FLOW: Page = {
	name: "flow",
	head: `<style id=sheet>
	.scroll { overflow: auto; height: 60px }
	.clip { overflow: hidden; height: 30px }
	.contents { display: contents }
	.sticky { position: sticky; top: 0; background-color: rgb(0, 0, 90) }
	.fixed { position: fixed; bottom: 0; left: 0 }
	.ell { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100px }
	.grid3 { display: grid; grid-template-columns: repeat(3, 1fr) }
	.span2 { grid-column: span 2 }
	.before::before { content: "[" attr(data-x) "] " }
	.upper { text-transform: uppercase }
	.rtl { direction: rtl }
	.indent { text-indent: 2ch }
	.nowrap { white-space: nowrap }
	.pre { white-space: pre }
	.box { border: 1px solid }
</style>`,
	body: `<div id=root>
	<div id=s class=scroll><p id=s0 class=sticky>sticky head</p><p id=s1>one</p><p id=s2>two</p><p id=s3>three</p><p id=s4>four</p></div>
	<div id=e class=ell>a long line of text that the box cuts with an ellipsis</div>
	<div id=k class=contents><span id=k0>contents child</span><p id=k1>block in contents</p></div>
	<div id=gr class=grid3><div id=g0>a</div><div id=g1 class=span2>b</div><div id=g2>c</div><div id=g3 class=box>d</div></div>
	<p id=bf class=before data-x=1>before text</p>
	<input id=in value="field text">
	<textarea id=ta>area text</textarea>
	<div id=fx class=fixed>fixed bar</div>
	<pre id=pr>pre  formatted
   text</pre>
</div>`,
	classes: [
		"scroll",
		"clip",
		"contents",
		"sticky",
		"fixed",
		"ell",
		"grid3",
		"span2",
		"before",
		"upper",
		"rtl",
		"indent",
		"nowrap",
		"pre",
		"box",
	],
	styles: [
		["height", (r: Random): string => `${15 + r.int(90)}px`],
		["width", (r: Random): string => `${30 + r.int(70)}%`],
		["overflow", (r: Random): string => r.pick(["visible", "hidden", "auto"])],
		[
			"white-space",
			(r: Random): string => r.pick(["normal", "nowrap", "pre", "pre-wrap"]),
		],
		["direction", (r: Random): string => r.pick(["ltr", "rtl"])],
		["text-transform", (r: Random): string => r.pick(["none", "uppercase"])],
		[
			"grid-column",
			(r: Random): string => r.pick(["auto", "span 2", "1 / 3", "3"]),
		],
		[
			"display",
			(r: Random): string =>
				r.pick(["block", "contents", "none", "grid", "inline"]),
		],
		["margin-top", (r: Random): string => `${r.int(40)}px`],
		[
			"color",
			(r: Random): string => `rgb(${r.int(255)}, ${r.int(255)}, ${r.int(255)})`,
		],
		["position", (r: Random): string => r.pick(["static", "sticky", "fixed"])],
		["text-indent", (r: Random): string => `${r.int(5)}ch`],
	],
	attributes: [
		["data-x", (r: Random): string => String(r.int(99))],
		[
			"value",
			(r: Random): string =>
				r.pick(["", "new value", "a much longer field value"]),
		],
		["rows", (r: Random): string => String(1 + r.int(4))],
	],
	rules: [
		".rule-a { color: rgb(200, 0, 0) }",
		"p { margin: 1px 0 }",
		".before::before { content: \"<\" attr(data-x) \"> \" }",
	],
};

// What boxes that lay out their own content hold: a sticky box in an
// inline-block in a scroller, held against the scroller's bottom with no
// scrolling, content past an inline-block's own height, an inline-table,
// counters ::before steps, and cells with no table around them.
const CONTEXTS: Page = {
	name: "contexts",
	head: `<style id=sheet>
	.ib { display: inline-block }
	.scroll { overflow: auto; height: 60px }
	.stick { position: sticky; bottom: 0; background-color: rgb(0, 0, 90) }
	.rel { position: relative; top: 5px }
	.abs { position: absolute; right: 0 }
	.short { height: 15px }
	.it { display: inline-table }
	.row { display: table-row }
	.cell { display: table-cell }
	.n::before { counter-increment: n; content: counter(n) ". " }
	.box { border: 1px solid }
</style>`,
	body: `<div id=root style="counter-reset: n">
	<div id=s class=scroll><span id=ib class=ib><div id=b0>head text</div><div id=st class=stick>stuck foot</div><div id=b1>one</div><div id=b2>two</div><div id=b3>three</div><div id=b4>four</div><div id=b5>five</div></span></div>
	<p id=p0>before <span id=ib2 class=ib><div id=o class=short><div id=o0>first</div><div id=o1>second</div></div></span> after</p>
	<p id=p1>table <span id=it class=it><span id=r0 class=row><span id=c0 class=cell>a</span><span id=c1 class=cell>bb</span></span></span> tail</p>
	<div id=h0 class=n>heading</div><div id=h1 class=n>heading</div>
	<div id=cells><div id=d0 class=cell>x</div><div id=d1 class=cell>yy</div></div>
</div>`,
	classes: [
		"ib",
		"scroll",
		"stick",
		"rel",
		"abs",
		"short",
		"it",
		"row",
		"cell",
		"n",
		"box",
	],
	styles: [
		["height", (r: Random): string => `${15 + r.int(90)}px`],
		["width", (r: Random): string => `${20 + r.int(80)}%`],
		[
			"display",
			(r: Random): string =>
				r.pick([
					"block",
					"inline-block",
					"inline-table",
					"table-cell",
					"table-row",
					"none",
				]),
		],
		[
			"position",
			(r: Random): string =>
				r.pick(["static", "relative", "sticky", "absolute"]),
		],
		["bottom", (r: Random): string => `${r.int(30)}px`],
		["margin-top", (r: Random): string => `${r.int(40)}px`],
		["overflow", (r: Random): string => r.pick(["visible", "hidden", "auto"])],
	],
	attributes: [],
	rules: [
		".n::before { content: counter(n) \" \" }",
		".ib { border: 1px solid }",
	],
};

export const PAGES = [LAYOUT, FLOW, CONTEXTS];

export const WORDS = [
	"alpha",
	"be",
	"gamma delta",
	"e",
	"zeta eta theta",
	"iota",
];

export class Random {
	state: number;
	constructor(seed: number) {
		this.state = seed;
	}

	next(): number {
		this.state = (this.state + 0x6d2b79f5) | 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	int(max: number): number {
		return Math.floor(this.next() * (max + 1));
	}

	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.next() * items.length)];
	}
}

export type Action =
	{kind: "class"; id: string; token: string} |
	{kind: "style"; id: string; property: string; value: string} |
	{kind: "attribute"; id: string; name: string; value: string} |
	{kind: "text"; id: string; words: string} |
	{
		kind: "insert";
		parent: string;
		tag: string;
		id: string;
		words: string;
		before: number;
	} |
	{kind: "remove"; id: string} |
	{kind: "rule"; rule: string};

export function mount(): {dom: TermDOM; terminal: MockProcess} {
	const terminal = new MockProcess({cols: COLS, rows: ROWS});
	const dom = new TermDOM({transport: terminal.transport, cellSize: CELL});
	return {dom, terminal};
}

// Every element under the root gets an id, so an action can name it.
export function setUp(document: any, page: Page): void {
	document.head.innerHTML = page.head;
	document.body.innerHTML = page.body;
	let count = 0;
	for (const element of document.getElementById("root").querySelectorAll("*")) {
		if (!element.id) {
			element.id = `k${count++}`;
		}
	}
}

export function choose(
	document: any,
	page: Page,
	random: Random,
): Action | null {
	const root = document.getElementById("root");
	const elements = [...root.querySelectorAll("*")];
	const element: any = elements.length > 0 ? random.pick(elements) : root;
	switch (random.int(page.attributes.length > 0 ? 7 : 5)) {
		case 0:
			return {kind: "class", id: element.id, token: random.pick(page.classes)};
		case 1:
		case 2: {
			const [property, value] = random.pick(page.styles);
			return {kind: "style", id: element.id, property, value: value(random)};
		}
		case 3:
			return {kind: "text", id: element.id, words: random.pick(WORDS)};
		case 4: {
			const tag = random.pick(["p", "span", "div", "li", "b"]);
			const id = `x${random.int(9999)}`;
			const words = random.pick(WORDS);
			const parent: any = random.pick([root, ...elements]);
			const before = random.int(parent.childNodes.length);
			return {kind: "insert", parent: parent.id, tag, id, words, before};
		}
		case 5:
			return element === root ? null : {kind: "remove", id: element.id};
		case 6: {
			const [name, value] = random.pick(page.attributes);
			return {kind: "attribute", id: element.id, name, value: value(random)};
		}
		default:
			return page.rules.length > 0
				? {kind: "rule", rule: random.pick(page.rules)}
				: null;
	}
}

export function apply(document: any, action: Action): void {
	switch (action.kind) {
		case "class":
			document.getElementById(action.id)?.classList.toggle(action.token);
			return;
		case "style":
			document.getElementById(action.id)?.style
				.setProperty(action.property, action.value);
			return;
		case "attribute":
			document
				.getElementById(action.id)
				?.setAttribute(action.name, action.value);
			return;
		case "text": {
			const element = document.getElementById(action.id);
			if (!element) {
				return;
			}
			const text = [...element.childNodes].find((node: any) =>
				node.nodeType === 3 && node.data.trim() !== "",
			);
			if (text) {
				(text as any).data = action.words;
			} else {
				element.append(action.words);
			}
			return;
		}
		case "insert": {
			const parent = document.getElementById(action.parent);
			if (!parent || document.getElementById(action.id)) {
				return;
			}
			const added = document.createElement(action.tag);
			added.id = action.id;
			added.textContent = action.words;
			parent.insertBefore(added, parent.childNodes[action.before] ?? null);
			return;
		}
		case "remove":
			document.getElementById(action.id)?.remove();
			return;
		case "rule": {
			// A rule present is taken out, and one absent is added.
			const sheet = document.getElementById("sheet");
			const text: string = sheet.textContent;
			sheet.textContent = text.includes(action.rule)
				? text.replace(action.rule, "")
				: `${text}\n${action.rule}`;
			return;
		}
	}
}

export function record(
	page: Page,
	seed: number,
	steps: number,
): Promise<Action[]> {
	return (async () => {
		const random = new Random(seed);
		const {dom} = mount();
		setUp(dom.document, page);
		await nextFrame(dom);
		const actions: Action[] = [];
		for (let step = 0; step < steps; step++) {
			const action = choose(dom.document, page, random);
			if (action) {
				actions.push(action);
				apply(dom.document, action);
			}
		}
		dom.dispose();
		return actions;
	})();
}

export function rects(document: any): string[] {
	return [...document.querySelectorAll("*")].map((element: any) => {
		const r = element.getBoundingClientRect();
		return `${element.localName}#${element.id} ${r.x},${r.y} ${r.width}x${r.height}`;
	});
}

// A copy of the page's nodes, not its markup, which the parser would
// rearrange where the changes put an element it would not.
export async function fresh(
	page: any,
): Promise<{screen: string; rects: string[]}> {
	const {dom, terminal} = mount();
	dom.document.documentElement.replaceChildren(
		...[...page.documentElement.childNodes].map((node: any) =>
			dom.document.importNode(node, true),
		),
	);
	await nextFrame(dom);
	const result = {
		screen: terminal.getScreenContents(),
		rects: rects(dom.document),
	};
	dom.dispose();
	return result;
}

/**
 * Where the page, changed a frame at a time, first stops matching the
 * same page rendered fresh: the actions up to that point and what
 * differs, or null when it never does.
 */
export async function firstMismatch(
	page: Page,
	actions: Action[],
): Promise<string | null> {
	const {dom, terminal} = mount();
	setUp(dom.document, page);
	await nextFrame(dom);
	for (let index = 0; index < actions.length; index++) {
		apply(dom.document, actions[index]);
		await nextFrame(dom);
		const expected = await fresh(dom.document);
		const got = rects(dom.document);
		const screen = terminal.getScreenContents();
		const differences: string[] = [];
		for (let i = 0; i < Math.max(got.length, expected.rects.length); i++) {
			if (got[i] !== expected.rects[i]) {
				differences.push(`rect ${got[i]}, fresh ${expected.rects[i]}`);
			}
		}
		const rows = screen.split("\n");
		const freshRows = expected.screen.split("\n");
		for (let i = 0; i < rows.length; i++) {
			if (rows[i] !== freshRows[i]) {
				differences.push(
					`row ${i} ${JSON.stringify(rows[i])}, fresh ${
						JSON.stringify(freshRows[i])
					}`,
				);
			}
		}
		if (differences.length > 0) {
			dom.dispose();
			return `${page.name} after ${
				JSON.stringify(actions.slice(0, index + 1))
			}\n${differences.slice(0, 12).join("\n")}`;
		}
	}
	dom.dispose();
	return null;
}
