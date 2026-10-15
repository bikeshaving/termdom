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

import {
	firstMismatch,
	fresh,
	mount,
	PAGES,
	record,
	rects,
} from "./fuzz-pages.ts";
import {nextFrame} from "./test-utils.ts";

const [LAYOUT, FLOW] = PAGES;

for (const page of PAGES) {
	for (let seed = 1; seed <= 24; seed++) {
		test(`seeded changes to the ${page.name} page render as a fresh page does: seed ${seed}`, async () => {
			expect(await firstMismatch(page, await record(page, seed, 12))).toBe(
				null,
			);
		});
	}
}

// Seeds that once found a bug, run as long as they did then: a grid cell
// rounded again from rounded values (1012, 1066, 1093), restyles inside
// an inline-block repainting rows counted from its own top (1020, 1193,
// 1200, 1260), an inline-block's width its measure did not hear of
// (1481), a positioned row group zeroed by its table when stray content
// joined it (1140), a positioned row's absolute cell (1941), and an
// absolute row placed from rounded offsets (2029).
for (const seed of [
	1012,
	1020,
	1066,
	1093,
	1140,
	1193,
	1200,
	1260,
	1481,
	1941,
	2029,
]) {
	test(`seeded changes to the layout page render as a fresh page does: seed ${seed}`, async () => {
		expect(await firstMismatch(LAYOUT, await record(LAYOUT, seed, 25))).toBe(
			null,
		);
	});
}

// The same for the flow page: an input's shown value its attributes set
// (3006), a class restyling a form control's shadow children (3003), a
// sticky box asked for its shift in the middle of a solve (3130), and a
// sticky shift moving rows its rect did not (3134, 3262).
for (const seed of [3003, 3006, 3130, 3134, 3262]) {
	test(`seeded changes to the flow page render as a fresh page does: seed ${seed}`, async () => {
		expect(await firstMismatch(FLOW, await record(FLOW, seed, 25))).toBe(null);
	});
}

// Each change, applied a frame apart, against the page drawn fresh after
// each one.
async function replay(
	html: string,
	changes: Array<(document: any) => void>,
): Promise<void> {
	const {dom, terminal} = mount();
	dom.document.head.innerHTML = LAYOUT.head;
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	for (const [index, apply] of changes.entries()) {
		apply(dom.document);
		await nextFrame(dom);
		const expected = await fresh(dom.document);
		expect(`after change ${index}\n${rects(dom.document).join("\n")}`)
			.toBe(`after change ${index}\n${expected.rects.join("\n")}`);
		expect(`after change ${index}\n${terminal.getScreenContents()}`)
			.toBe(`after change ${index}\n${expected.screen}`);
	}
	dom.dispose();
}

test("a cell taken out of flow leaves its table", async () => {
	await replay(
		"<table id=t><tr><td id=a class=box>x</td><td>y y</td></tr></table>",
		[(document) => document.getElementById("a").style.position = "absolute"],
	);
});

test("a positioned row group keeps its positioned cells laid out", async () => {
	await replay(
		"<table id=t><tbody id=g><tr><td id=a>x</td><td id=b>y y</td></tr>" +
			"</tbody></table>",
		[
			(document) => document.getElementById("b").classList.add("abs"),
			(document) => document.getElementById("g").classList.add("abs"),
			(document) => document.getElementById("t").append("stray"),
		],
	);
});

test("an inline-block grows with a child made wider", async () => {
	await replay(
		"<div id=f class=row><div id=a class=box>one</div><div>two</div></div>",
		[
			(document) => document.getElementById("f").classList.add("ib"),
			(document) => document.getElementById("a").style.width = "87px",
		],
	);
});

test("an inline-block lays out a block put inside its inline content", async () => {
	await replay("<div class=col><div id=c>above</div></div>", [
		(document) => {
			const span = document.createElement("span");
			span.id = "s";
			span.textContent = "gamma delta";
			document.getElementById("c").prepend(span);
		},
		(document) => document.getElementById("c").classList.add("ib"),
		(document) => {
			const p = document.createElement("p");
			p.textContent = "e";
			document.getElementById("s").append(p);
		},
	]);
});

test("a flex item made an inline-block takes the width it is given", async () => {
	await replay("<div class=row><div>one</div><div id=a>two words</div></div>", [
		(document) => document.getElementById("a").classList.add("ib"),
		(document) => document.getElementById("a").style.width = "23%",
	]);
});

test("an untouched textarea shows the text children it is given", async () => {
	await replay("<textarea id=a>area text</textarea>", [
		(document) => document.getElementById("a").firstChild.data = "alpha",
		(document) => document.getElementById("a").append(" beta"),
		(document) => {
			const span = document.createElement("span");
			span.textContent = "not its text";
			document.getElementById("a").prepend(span);
		},
	]);
});

test("a row made a containing block lays out its positioned cell", async () => {
	await replay("<table><tr id=r><td>x</td><td id=b>y y</td></tr></table>", [
		(document) => document.getElementById("b").classList.add("abs"),
		(document) => document.getElementById("r").style.position = "relative",
	]);
});

test("a block in an inline that dissolves leaves no box behind", async () => {
	await replay("<div><span>inline<p id=p>block</p></span></div>", [
		(document) => document.getElementById("p").style.display = "contents",
	]);
});
