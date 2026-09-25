/**
 * innerText is the text as it renders: white space processed, a line
 * break for each <br> and block, two around a paragraph, and nothing
 * from content that does not render.
 */
import {expect, test} from "@b9g/libuild/test";

import {TermDOM} from "../src/index.ts";
import {MockProcess, nextFrame} from "./test-utils.js";

async function page(html: string, cols = 40): Promise<TermDOM> {
	const terminal = new MockProcess({cols, rows: 10});
	const dom = new TermDOM({transport: terminal.transport});
	dom.document.body.innerHTML = html;
	await nextFrame(dom);
	return dom;
}

test("innerText collapses white space and breaks at a br", async () => {
	const dom = await page("<div>\n  Prefix: <span>x</span><br>\n  Next</div>");
	expect(dom.document.body.innerText).toBe("Prefix: x\nNext");
	dom.dispose();
});

test("a br inside an inline element is a line break", async () => {
	const dom = await page("<div>a<span>Edit<br>able</span>b</div>");
	expect(dom.document.body.innerText).toBe("aEdit\nableb");
	dom.dispose();
});

test("blocks take one line break and paragraphs two", async () => {
	const dom = await page("<p>one</p><p>two</p><div>three</div>four");
	expect(dom.document.body.innerText).toBe("one\n\ntwo\n\nthree\nfour");
	dom.dispose();
});

test("a soft wrap is not a line break", async () => {
	const dom = await page("<div>hello there world</div>", 12);
	expect(dom.document.body.innerText).toBe("hello there world");
	dom.dispose();
});

test("preformatted text keeps its newlines", async () => {
	const dom = await page("<pre>first\n\nsecond</pre>");
	expect(dom.document.body.innerText).toBe("first\n\nsecond");
	dom.dispose();
});

test("hidden content is left out and text-transform applies", async () => {
	const dom = await page(
		"<div style=\"text-transform: uppercase\">shout</div>" +
		"<div style=\"display: none\">gone</div>" +
		"<div style=\"visibility: hidden\">hid<span style=\"visibility: visible\">shown</span></div>",
	);
	expect(dom.document.body.innerText).toBe("SHOUT\nshown");
	dom.dispose();
});

test("table cells are separated by tabs and rows by newlines", async () => {
	const dom = await page(
		"<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
	);
	expect(dom.document.body.innerText).toBe("a\tb\nc\td");
	dom.dispose();
});

test("an element that does not render gives its textContent", async () => {
	const dom = await page("<div style=\"display: none\">a<p>b</p></div>");
	expect((dom.document.body.firstChild as HTMLElement).innerText).toBe("ab");
	const detached = dom.document.createElement("div");
	detached.innerHTML = "<p>x</p>  y";
	expect(detached.innerText).toBe("x  y");
	dom.dispose();
});
