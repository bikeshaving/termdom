/**
 * Counters as css-lists-3 §4.4 counts them: an element inherits the
 * counters of its parent and of its previous sibling, at the values the
 * element before it in tree order left them, then applies its own
 * counter-reset, counter-increment and counter-set. The expected text is
 * what a browser shows for the same page.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.ts";

async function render(
	css: string,
	html: string,
	change?: (document: any) => void,
): Promise<string[]> {
	const terminal = new MockProcess({cols: 30, rows: 12});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.head.innerHTML = `<style>${css}</style>`;
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	if (change) {
		change(dom.document);
		await nextFrame(dom);
	}
	const lines = terminal.getScreenContents()
		.split("\n")
		.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
		.filter((line) => line !== "");
	dom.dispose();
	return lines;
}

const NUMBERED =
	"body { counter-reset: n } .n { counter-increment: n } " +
	".n::before { content: counter(n) \". \" }";

test("siblings count on from one another", async () => {
	expect(
		await render(
			NUMBERED,
			"<div class=n>a</div><div class=n>b</div><div class=n>c</div>",
		),
	).toEqual(["1. a", "2. b", "3. c"]);
});

test("a counter takes its value from the element just before", async () => {
	expect(
		await render(
			NUMBERED,
			"<div><div class=n>a</div><div class=n>b</div></div>" +
				"<div class=n>c</div>",
		),
	).toEqual(["1. a", "2. b", "3. c"]);
});

test("a reset reaches the siblings after it", async () => {
	expect(
		await render(
			NUMBERED + " .r { counter-reset: n 10 }",
			"<div class=n>a</div><div class=r>b</div><div class=n>c</div>",
		),
	).toEqual(["1. a", "b", "11. c"]);
});

test("a counter made inside a sibling stays inside it", async () => {
	expect(
		await render(
			".r { counter-reset: m 5 } .m::before { content: counter(m) \" \" }",
			"<div><div class=r>a</div></div><div class=m>b</div>",
		),
	).toEqual(["a", "0 b"]);
});

test("counter-set sets the value the next step counts from", async () => {
	expect(
		await render(
			NUMBERED + " .s { counter-set: n 7 }",
			"<div class=n>a</div><div class=s>b</div><div class=n>c</div>",
		),
	).toEqual(["1. a", "b", "8. c"]);
});

test("a box not shown does not count", async () => {
	expect(
		await render(
			NUMBERED,
			"<div class=n>a</div><div class=n style=\"display: none\">b</div>" +
				"<div class=n>c</div>",
		),
	).toEqual(["1. a", "2. c"]);
});

test("a counter declared later renumbers what follows it", async () => {
	expect(
		await render(
			NUMBERED,
			"<div class=n>a</div><div id=b>b</div><div class=n>c</div>",
			(document) => document.getElementById("b").classList.add("n"),
		),
	).toEqual(["1. a", "2. b", "3. c"]);
});

test("a box shown again counts again", async () => {
	expect(
		await render(
			NUMBERED,
			"<div class=n>a</div><div id=b class=n style=\"display: none\">b</div>" +
				"<div class=n>c</div>",
			(document) => document.getElementById("b").style.display = "block",
		),
	).toEqual(["1. a", "2. b", "3. c"]);
});

test("a parent hidden and shown again counts its children again", async () => {
	expect(
		await render(
			NUMBERED,
			"<div class=n>a</div><div id=p style=\"display: none\">" +
				"<div class=n>b</div></div><div class=n>c</div>",
			(document) => document.getElementById("p").style.display = "block",
		),
	).toEqual(["1. a", "2. b", "3. c"]);
});

test("a list item's value sets the list-item counter", async () => {
	expect(
		await render(
			"li::marker { content: counter(list-item) \") \" } " +
				"ol { list-style-position: inside; padding: 0 }",
			"<ol start=4><li>a</li><li value=9>b</li><li>c</li></ol>",
		),
	).toEqual(["4) a", "9) b", "10) c"]);
});
