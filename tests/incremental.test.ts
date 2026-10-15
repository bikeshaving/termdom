/**
 * Whatever a page went through, what it shows must be what the same
 * page shows freshly rendered. Every cache layout, style and paint keep
 * across frames is a way for the first to drift from the second: a box
 * not laid out again, rows not repainted, a style or a measure read from
 * before a change. Each run applies seeded random changes to a page
 * built from the features those caches cover, and after every change
 * compares the screen and every element's rect with a fresh render of
 * the page's markup. Cells are 7 by 15 pixels, so lengths in pixels
 * fall on fractions of a cell.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

const COLS = 60;
const ROWS = 30;
const CELL = {width: 7, height: 15};

const HEAD = `<style>
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
</style>`;

const BODY = `<div id=root style="counter-reset: n">
	<p id=p0>Some text <span id=s0>span</span> and more words here</p>
	<div id=f class=row><div id=f0 class=box>one</div><div id=f1>two words</div><div id=f2 class=bg>three</div></div>
	<div id=g class=grid><div id=g0>cell a</div><div id=g1>cell b has longer text that may wrap</div></div>
	<ol id=l><li id=l0>first</li><li id=l1 class=n>second</li><li id=l2>third</li></ol>
	<table id=t><tr><td id=t0 class=box>x</td><td id=t1>y y</td></tr></table>
	<p id=p1>inline <span id=ib class=ib>block</span> tail of the line</p>
	<div id=c class=col><div id=c0>above</div><div id=c1 class=n>below</div></div>
</div>`;

const CLASSES = [
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
];

const STYLES: Array<[string, (pick: Random) => string]> = [
	["margin-left", (r) => `${r.int(25)}px`],
	["margin-top", (r) => `${r.int(40)}px`],
	["padding-top", (r) => `${r.int(30)}px`],
	["width", (r) => `${10 + r.int(90)}%`],
	["width", (r) => `${20 + r.int(300)}px`],
	["color", (r) => `rgb(${r.int(255)}, ${r.int(255)}, ${r.int(255)})`],
	["background-color", (r) => r.pick(["transparent", "rgb(90, 0, 0)"])],
	[
		"display",
		(r) => r.pick(["block", "none", "flex", "inline-block", "inline"]),
	],
	["order", (r) => String(r.int(3))],
	["flex-direction", (r) => r.pick(["row", "column", "row-reverse"])],
	["text-align", (r) => r.pick(["left", "center", "right"])],
	["position", (r) => r.pick(["static", "relative", "absolute"])],
	["top", (r) => `${r.int(30)}px`],
	["visibility", (r) => r.pick(["visible", "hidden"])],
	["border", (r) => r.pick(["none", "1px solid", "1px double"])],
	["z-index", (r) => String(r.int(3))],
	["outline", (r) => r.pick(["none", "1px solid"])],
];

const WORDS = ["alpha", "be", "gamma delta", "e", "zeta eta theta", "iota"];

class Random {
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

function mount(): {dom: TermDOM; terminal: MockProcess} {
	const terminal = new MockProcess({cols: COLS, rows: ROWS});
	const dom = new TermDOM({transport: terminal.transport, cellSize: CELL});
	return {dom, terminal};
}

// A change to a random element of the page, described for the report.
function change(document: any, random: Random): string {
	const root = document.getElementById("root");
	const elements = [...root.querySelectorAll("*")];
	const element: any = elements.length > 0 ? random.pick(elements) : root;
	const name = element.id || element.localName;
	switch (random.int(5)) {
		case 0: {
			const token = random.pick(CLASSES);
			element.classList.toggle(token);
			return `toggle .${token} on ${name}`;
		}
		case 1:
		case 2: {
			const [property, value] = random.pick(STYLES);
			const chosen = value(random);
			element.style.setProperty(property, chosen);
			return `${name}.style.${property} = ${chosen}`;
		}
		case 3: {
			const text = [...element.childNodes].find((node: any) =>
				node.nodeType === 3 && node.data.trim() !== "",
			);
			const words = random.pick(WORDS);
			if (text !== undefined) {
				(text as any).data = words;
				return `${name} text = ${words}`;
			}
			element.append(words);
			return `${name} append text ${words}`;
		}
		case 4: {
			const added = document.createElement(
				random.pick(["p", "span", "div", "li", "b"]),
			);
			added.id = `x${random.int(9999)}`;
			added.textContent = random.pick(WORDS);
			const parent: any = random.pick([root, ...elements]);
			const children = [...parent.childNodes];
			parent.insertBefore(added, children[random.int(children.length)] ?? null);
			return `insert ${added.localName}#${added.id} into ${parent.id || parent.localName}`;
		}
		default: {
			if (element === root) {
				return "nothing";
			}
			element.remove();
			return `remove ${name}`;
		}
	}
}

function rects(document: any): string[] {
	return [...document.querySelectorAll("*")].map((element: any) => {
		const r = element.getBoundingClientRect();
		return `${element.localName}#${element.id} ${r.x},${r.y} ${r.width}x${r.height}`;
	});
}

// A copy of the page's nodes, not its markup, which the parser would
// rearrange where the changes put an element it would not.
async function fresh(page: any): Promise<{screen: string; rects: string[]}> {
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

async function run(seed: number, steps: number): Promise<void> {
	const random = new Random(seed);
	const {dom, terminal} = mount();
	dom.document.head.innerHTML = HEAD;
	dom.document.body.innerHTML = BODY;
	await nextFrame(dom);
	const log: string[] = [];
	for (let step = 0; step < steps; step++) {
		log.push(change(dom.document, random));
		await nextFrame(dom);
		const expected = await fresh(dom.document);
		const where = `seed ${seed} after:\n  ${log.join("\n  ")}`;
		expect(`${where}\n${rects(dom.document).join("\n")}`)
			.toBe(`${where}\n${expected.rects.join("\n")}`);
		expect(`${where}\n${terminal.getScreenContents()}`)
			.toBe(`${where}\n${expected.screen}`);
	}
	dom.dispose();
}

for (let seed = 1; seed <= 24; seed++) {
	test(`seeded changes render as a fresh page does: seed ${seed}`, async () => {
		await run(seed, 12);
	});
}
