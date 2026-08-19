/**
 * A marked box is rebuilt in full: every fact a fresh build derives for it --
 * box kind, run membership, whether it dissolves, the used values solved at
 * build time -- is re-derived from the styles that stand, by the same code the
 * fresh build runs. So a frame reached by mutation is the frame a fresh parse
 * of the same tree renders, and each case below asserts exactly that.
 */
import {test, expect} from "@b9g/libuild/test";
import {TermDOM} from "../src/internal/termdom.js";
import {MockProcess, nextFrame} from "./test-utils.js";

const SHEET = `
	.hide { display: none; }
	.flex { display: flex; flex-direction: row; gap: 1ch; }
	.contents { display: contents; }
	.iblock { display: inline-block; }
	.pre { white-space: pre; }
	.mark::before { content: "* "; }
	.abs { position: absolute; top: 2px; left: 3ch; }
`;

function makeDOM(): {dom: TermDOM; terminal: MockProcess} {
	const terminal = new MockProcess({cols: 60, rows: 20});
	const dom = new TermDOM({transport: terminal.transport});
	const style = dom.document.createElement("style");
	style.textContent = SHEET;
	dom.document.head.appendChild(style);
	return {dom, terminal};
}

function frameOf(terminal: MockProcess): string {
	return terminal
		.getPlainText()
		.split("\n")
		.map((line: string) => line.replace(/\s+$/, ""))
		.join("\n")
		.replace(/\n+$/, "");
}

/**
 * Render `html`, run each step with a frame between, and render the tree it
 * ends at once from scratch. The two frames are the assertion: a step that
 * leaves a derived fact behind shows up as a difference here.
 */
async function incrementalVersusFresh(
	html: string,
	steps: Array<(document: Document) => void>,
): Promise<{incremental: string; fresh: string}> {
	const {dom, terminal} = makeDOM();
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	for (const step of steps) {
		step(dom.document as unknown as Document);
		await nextFrame(dom);
	}
	const incremental = frameOf(terminal);

	const second = makeDOM();
	for (const child of Array.from(dom.document.body.childNodes)) {
		second.dom.document.body.appendChild(
			second.dom.document.importNode(child, true),
		);
	}
	await nextFrame(second.dom);
	const fresh = frameOf(second.terminal);
	dom.dispose();
	second.dom.dispose();
	return {incremental, fresh};
}

test("an element made fixed by a style write solves its auto margins", async () => {
	const {dom, terminal} = makeDOM();
	const {document} = dom;
	document.body.innerHTML =
		"<div id=\"e\" style=\"width: 10ch; height: 3px; " +
		"margin: auto; background: #444\">pinned</div>";
	await nextFrame(dom);
	const element = document.getElementById("e")!;
	element.style.position = "fixed";
	element.style.top = "0";
	element.style.bottom = "0";
	await nextFrame(dom);
	const incremental = element.getBoundingClientRect().top;
	const frame = frameOf(terminal);

	const fresh = makeDOM();
	fresh.dom.document.body.appendChild(
		fresh.dom.document.importNode(document.body.firstChild!, true),
	);
	await nextFrame(fresh.dom);
	const freshTop = fresh.dom.document
		.getElementById("e")!
		.getBoundingClientRect().top;

	expect(incremental).toBe(freshTop);
	expect(incremental).toBeGreaterThan(0);
	expect(frame).toBe(frameOf(fresh.terminal));
	dom.dispose();
	fresh.dom.dispose();
});

test("an element made fixed by the popover attribute solves its auto margins", async () => {
	const {dom, terminal} = makeDOM();
	const {document} = dom;
	document.body.innerHTML = "<div id=\"e\">note</div>";
	await nextFrame(dom);
	const element = document.getElementById("e")!;
	element.setAttribute("popover", "manual");
	element.showPopover();
	await nextFrame(dom);
	const incremental = element.getBoundingClientRect().top;
	const frame = frameOf(terminal);

	const fresh = makeDOM();
	fresh.dom.document.body.appendChild(
		fresh.dom.document.importNode(document.body.firstChild!, true),
	);
	const freshElement = fresh.dom.document.getElementById("e")!;
	freshElement.showPopover();
	await nextFrame(fresh.dom);

	expect(incremental).toBe(freshElement.getBoundingClientRect().top);
	expect(incremental).toBeGreaterThan(0);
	expect(frame).toBe(frameOf(fresh.terminal));
	dom.dispose();
	fresh.dom.dispose();
});

test("a flex item that stops holding a block measures as a run again", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<div class=\"flex\"><em id=\"e\"><section>t000</section></em></div>",
		[
			(document) => {
				document.getElementById("e")!.innerHTML = "<b>x</b>";
			},
		],
	);
	expect(incremental).toBe(fresh);
	expect(incremental).toContain("x");
});

test("a div inside an inline made display:contents keeps its subtree", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<b><div id=\"e\"><section>t003</section></div></b>",
		[
			(document) => {
				(document.getElementById("e") as HTMLElement).style.display =
					"contents";
			},
		],
	);
	expect(incremental).toBe(fresh);
	expect(incremental).toContain("t003");
});

// Two frames, and they must stay two: the restaging a step implies is not
// order-independent, and collapsing both mutations into one frame renders the
// tree correctly while the sequence does not.
test("dissolving a box and then preserving white space agree frame by frame", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<em><li id=\"a\"><section><p id=\"b\"> </p>   </section>t000</li></em>",
		[
			(document) => {
				document.getElementById("a")!.classList.add("contents");
			},
			(document) => {
				document.getElementById("b")!.classList.add("pre");
			},
		],
	);
	expect(incremental).toBe(fresh);
});

test("a marker moved into another inline is enumerated where it lands", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<em><em id=\"a\"><b id=\"b\"></b></em>t002<em id=\"c\" class=\"mark\">t003</em></em>",
		[
			(document) => {
				document.getElementById("a")!.classList.add("flex");
			},
			(document) => {
				document
					.getElementById("b")!
					.appendChild(document.getElementById("c")!);
			},
		],
	);
	expect(incremental).toBe(fresh);
});

test("an inline moved into a block inside an inline-block lays out", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<span id=\"a\">a</span><span class=\"iblock\"><div id=\"b\">b</div></span>",
		[
			(document) => {
				document
					.getElementById("b")!
					.appendChild(document.getElementById("a")!);
			},
		],
	);
	expect(incremental).toBe(fresh);
	expect(incremental).toContain("b");
});

// Not a case the fuzzing campaign found: a box that leaves the flow from
// INSIDE a run. Its container's enumeration is what names it, and the one path
// that builds a box is what hoists it to its containing block.
test("a run member that leaves the flow is hoisted, not dropped", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<div>a<em id=\"e\">mid</em>b</div>",
		[
			(document) => {
				document.getElementById("e")!.className = "abs";
			},
		],
	);
	expect(incremental).toBe(fresh);
	expect(incremental).toContain("mid");
});

test("an inline-block that gains a block lays its content out under its own root", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<div><span id=\"e\" class=\"iblock\">head</span>tail</div>",
		[
			(document) => {
				const block = document.createElement("div");
				block.textContent = "inner";
				document.getElementById("e")!.appendChild(block);
			},
		],
	);
	expect(incremental).toBe(fresh);
	expect(incremental).toContain("inner");
});

test("an inline that gains a block is broken around it", async () => {
	const {incremental, fresh} = await incrementalVersusFresh(
		"<div><span id=\"e\">head</span></div>",
		[
			(document) => {
				const block = document.createElement("div");
				block.textContent = "mid";
				document.getElementById("e")!.appendChild(block);
			},
		],
	);
	expect(incremental).toBe(fresh);
	expect(incremental).toContain("mid");
});
